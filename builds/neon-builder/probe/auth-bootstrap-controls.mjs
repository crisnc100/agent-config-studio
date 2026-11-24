import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { agyAfterCall, agyTokenLeft } from '../../../tools/ask-model.mjs';

const PLAY = 'play.googleapis.com';
const CLOUD = 'daily-cloudcode-pa.googleapis.com';
const OAUTH = 'oauth2.googleapis.com';
const ROUTES = {
  [CLOUD]: ['/v1internal:loadCodeAssist', '/v1internal:fetchAvailableModels',
    '/v1internal:retrieveUserQuota', '/v1internal:listExperiments'],
  [OAUTH]: ['/token'],
  [PLAY]: ['/log'],
};
const SEEDS = ['installation_id', 'jetski_state.pbtxt', 'cache/default_project_id.txt', 'cache/onboarding.json',
  'settings.json'].map((file) => path.join('.gemini', 'antigravity-cli', file));

function allowedUpstream({ hostname, servername, port, method, path: rpc, rejectUnauthorized }) {
  return Object.hasOwn(ROUTES, hostname) && ROUTES[hostname].includes(rpc) &&
    servername === hostname && port === 443 && method === 'POST' && rejectUnauthorized === true;
}

function replaceOne(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('production helper changed shape');
  return source.replace(before, () => after);
}

async function loadHelper(directory) {
  const helper = new URL('../../../tools/agy-builder.mjs', import.meta.url);
  const replacements = [
    ["from './agy-builder-source.mjs';", `from '${new URL('./agy-builder-source.mjs', helper).href}';`],
    ['const AGY_VERSION =', `const BOOTSTRAP_ROUTES = ${JSON.stringify(ROUTES)};\nconst AGY_VERSION =`],
    ['const route = Object.hasOwn(GOOGLE_ROUTES[origin], req.url);',
      'const route = Object.hasOwn(GOOGLE_ROUTES[origin], req.url) && BOOTSTRAP_ROUTES[origin]?.includes(req.url);'],
    ['privateHome }, bin, home) {\n  const pinned', 'privateHome }, bin, home, brokerOptions) {\n  const pinned'],
    ['const broker = await agyGoogleBroker(ca);', 'const broker = await agyGoogleBroker(ca, brokerOptions);'],
  ];
  const file = path.join(directory, 'auth-bootstrap-helper.mjs');
  fs.writeFileSync(file, replacements.reduce((source, [before, after]) => replaceOne(source, before, after),
    fs.readFileSync(helper, 'utf8')), { flag: 'wx', mode: 0o600 });
  return import(pathToFileURL(file).href);
}

function findExecutable() {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute)) {
    try {
      const file = fs.realpathSync.native(path.join(directory, 'agy'));
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  throw new Error('agy executable unavailable on trusted PATH');
}

function privateInputs(layout, home) {
  const loginSuffix = path.join('Library', 'Keychains', 'login.keychain-db');
  const login = fs.realpathSync.native(path.join(home, loginSuffix));
  const alias = path.join(layout.privateHome, loginSuffix);
  const aliasMatches = fs.realpathSync.native(alias) === login;
  const seeds = SEEDS.map((file) => {
    const input = path.join(layout.privateHome, file);
    const stat = fs.lstatSync(input, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 ||
        fs.realpathSync.native(input) !== input) throw new Error('unsafe private seed');
    return crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex');
  });
  return { login, alias, aliasMatches, seeds };
}

const KEYRING_PREFIXES = {
  invalidStoredToken: 'saved token invalid:',
  failedTokenRemoval: 'failed to remove token:',
  failedUserInfo: 'failed to fetch user info:',
  failedOAuthParams: 'failed to get oauth params:',
  failedStoredTokenLookup: 'failed to load stored token:',
  keychainLoaded: 'loaded token,',
  cancelledKeyring: 'context cancelled,',
  missingWifEmailClaim: 'no email claim stored for wif credential',
  keyringTimedOut: 'timed out after ',
  keyringValidationNetworkError: 'token validation failed due to network error',
  incompleteGcpOnboarding: 'incomplete gcp onboarding',
};
const STORAGE_MESSAGES = {
  tokenStorageInitializationError: 'failed to initialize token storage:',
  keyringMarkerHomeError: 'failed to get user home directory for keyring marker:',
  keyringMarkerStatError: 'failed to stat keyring timeout marker ',
  keyringMarkerCleanupError: 'failed to remove stale keyring timeout marker ',
  keyringMarkerWriteError: 'failed to write keyring marker:',
  keyringMarkerRenameError: 'failed to rename keyring marker file:',
  keyringMarkerDirectoryError: 'failed to create keyring marker directory:',
  keyringMarkerTempCreateError: 'failed to create temporary keyring marker file:',
  keyringMarkerTempCloseError: 'failed to close temporary keyring marker file:',
  keyringMarkerPermissionsError: 'failed to set permissions on temporary keyring marker file:',
  recentTimeoutFileFallback: 'using file-based token storage because a keyring timeout was recorded',
  requestedFileFallback: 'using file-based token storage because the caller requested it',
};

function authFlags(log, output) {
  const entries = Array.from(log.matchAll(/keyringAuth:([^\r\n]*)/gi), ([, message]) => message.trimStart().toLowerCase());
  const prefixes = Object.values(KEYRING_PREFIXES);
  const storage = log.toLowerCase();
  return {
    anyKeyringPrefix: entries.length > 0,
    unknownKeyringPrefix: entries.some((message) => !prefixes.some((prefix) => message.startsWith(prefix))),
    ...Object.fromEntries(Object.entries(KEYRING_PREFIXES).map(([name, prefix]) =>
      [name, entries.some((message) => message.startsWith(prefix))])),
    ...Object.fromEntries(Object.entries(STORAGE_MESSAGES).map(([name, message]) => [name, storage.includes(message)])),
    detectedFileFallback: /using file-based token storage because [^\r\n]{1,180} detected/i.test(log),
    fileFallbackMentioned: storage.includes('file-based token storage'),
    failedOnboardingLoad: storage.includes('failed to load onboarding status:'),
    keychainAuthenticated: /authenticated via keyring/i.test(log),
    signInNeeded: /Please sign in to view available models/i.test(output),
    nativeSettingsWriteDenied: /failed to write validated settings[^\n]*operation not permitted/i.test(log),
  };
}

function listedLogin(output, login) {
  return output.split('\n').some((line) => {
    const candidate = /^\s*"([^"]+)"\s*$/.exec(line)?.[1];
    if (!candidate || !path.isAbsolute(candidate)) return false;
    try { return fs.realpathSync.native(candidate) === login; } catch { return false; }
  });
}

function securityResult(result, login, listsPaths) {
  const diagnostic = result.stderr ?? '';
  const errorClass = result.error?.code === 'ETIMEDOUT' ? 'timeout' :
    result.error ? 'spawn-error' : result.signal ? 'signal' : result.status === 0 ? null :
      /interaction is not allowed|locked/i.test(diagnostic) ? 'interaction-denied-or-locked' :
        /permission denied|operation not permitted/i.test(diagnostic) ? 'permission-denied' :
          /could not be found|no such|invalid keychain/i.test(diagnostic) ? 'keychain-unavailable' : 'other-error';
  return { code: result.status, expectedLoginIncluded: listsPaths ? listedLogin(result.stdout ?? '', login) : null, errorClass };
}

function securityControls(helper, layout, launch, { login, alias }) {
  const executable = '/usr/bin/security';
  const commands = {
    default: ['default-keychain', '-d', 'user'],
    list: ['list-keychains', '-d', 'user'],
    showLogin: ['show-keychain-info', login],
    showAlias: ['show-keychain-info', alias],
  };
  const options = { cwd: layout.source, env: launch.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 };
  const observations = {};
  for (const [name, args] of Object.entries(commands)) {
    const listsPaths = name === 'default' || name === 'list';
    const outside = spawnSync(executable, args, options);
    const inside = spawnSync('/usr/bin/sandbox-exec', helper.agyBuildWall(launch.params, [executable, ...args]), options);
    observations[name] = { outside: securityResult(outside, login, listsPaths), inside: securityResult(inside, login, listsPaths) };
  }
  return observations;
}

function audit(events) {
  return events.map(({ origin, method, path: rpc, status }) => ({
    ...(Object.hasOwn(ROUTES, origin) && { origin }),
    ...(['CONNECT', 'POST', 'GET'].includes(method) && { method }),
    ...(Object.hasOwn(ROUTES, origin) && ROUTES[origin].includes(rpc) && { path: rpc }),
    ...(Number.isInteger(status) && status >= 100 && status <= 599 && { status }),
  }));
}

function launchModels(helper, layout, launch) {
  const { env, params } = launch;
  const logFile = path.join(layout.runtime, 'agy.log');
  const args = helper.agyBuildWall(params,
    [params.bin, '--log-file', logFile, '--output-format', 'json', 'models']);
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', args, {
      cwd: layout.source, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stop = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const interrupts = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    let interrupted = false;
    let timedOut = false;
    const interrupt = () => { interrupted = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, 25_000);
    for (const signal of interrupts) process.on(signal, interrupt);
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.once('error', () => reject(new Error('could not start walled metadata child')));
    child.once('exit', stop);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      for (const name of interrupts) process.off(name, interrupt);
      try {
        const logStat = fs.lstatSync(logFile, { throwIfNoEntry: false });
        const hasSafeLog = logStat?.isFile() && logStat.nlink === 1 && fs.realpathSync.native(logFile) === logFile;
        const log = hasSafeLog ? fs.readFileSync(logFile, 'utf8') : '';
        let reply;
        try { reply = JSON.parse(out); } catch {}
        const turns = Number.isInteger(reply?.num_turns) && reply.num_turns >= 0 ? reply.num_turns : null;
        const models = reply?.command?.data?.models;
        resolve({ code, signal, timedOut, interrupted, turns, reportedZeroTurns: turns === 0,
          successfulMetadata: reply?.status === 'SUCCESS' && turns === 0,
          modelCount: Array.isArray(models) ? models.length : null, ...authFlags(log, out + err),
          cleanPostflight: Boolean(hasSafeLog) && !agyTokenLeft(params.home) && !agyAfterCall(logFile, layout.privateHome),
          brokerEvents: audit(launch.broker.events) });
      } catch {
        reject(new Error('could not classify walled metadata result'));
      }
    });
  });
}

async function observe(helper, directory) {
  const home = fs.realpathSync.native(os.homedir());
  const bin = findExecutable();
  const layout = helper.agyBuildLayout(directory);
  if (agyTokenLeft(home) || agyTokenLeft(layout.privateHome)) throw new Error('plaintext token preflight refused');
  let launch;
  try {
    launch = await helper.prepareAgyLaunch(layout, bin, home, {
      requestUpstream(options, callback) {
        if (!allowedUpstream(options)) throw new Error('control blocked unexpected upstream request');
        return https.request(options, callback);
      },
    });
    const before = privateInputs(layout, home);
    if (!before.aliasMatches || agyTokenLeft(home) || agyTokenLeft(layout.privateHome)) {
      throw new Error('private HOME identity or plaintext guard failed');
    }
    const security = securityControls(helper, layout, launch, before);
    const during = privateInputs(layout, home);
    const privateInputsPinned = before.login === during.login && during.aliasMatches &&
      before.seeds.every((seed, index) => seed === during.seeds[index]);
    if (!privateInputsPinned || agyTokenLeft(home) || agyTokenLeft(layout.privateHome)) {
      throw new Error('private HOME changed during metadata controls');
    }
    const metadata = await launchModels(helper, layout, launch);
    const after = privateInputs(layout, home);
    const plaintextAbsent = !agyTokenLeft(home) && !agyTokenLeft(layout.privateHome);
    console.log(JSON.stringify({ mode: 'metadata-only', modelsCliLaunches: 1, privateInputsPinned,
      aliasMatchesAfter: before.login === after.login && after.aliasMatches,
      seedsMatchAfter: before.seeds.every((seed, index) => seed === after.seeds[index]),
      plaintextAbsent, security, metadata }, null, 2));
    if (!plaintextAbsent || before.login !== after.login || !after.aliasMatches ||
        !metadata.cleanPostflight || metadata.turns > 0) process.exitCode = 1;
  } finally {
    launch?.broker.close();
  }
}

async function fixtureRequest(broker, rpc) {
  const socket = net.connect(broker.port, '127.0.0.1');
  socket.setTimeout(3000, () => socket.destroy(new Error('fixture timeout')));
  await once(socket, 'connect');
  const { username, password } = new URL(broker.url);
  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  const reply = once(socket, 'data');
  socket.write(`CONNECT ${CLOUD}:443 HTTP/1.1\r\nHost: ${CLOUD}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
  assert.match((await reply)[0].toString(), /^HTTP\/1[.]1 200/);
  const secure = tls.connect({ socket, servername: CLOUD, ca: fs.readFileSync(broker.certificate) });
  await once(secure, 'secureConnect');
  secure.write(`POST ${rpc} HTTP/1.1\r\nHost: ${CLOUD}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  let response = '';
  for await (const chunk of secure) response += chunk;
  return Number(response.split(' ')[1]);
}

async function selfTest(helper, directory) {
  const observed = [];
  const exact = { hostname: CLOUD, servername: CLOUD, port: 443, method: 'POST',
    path: '/v1internal:fetchAvailableModels', rejectUnauthorized: true };
  assert.equal(allowedUpstream(exact), true);
  for (const fields of [{ path: '/v1internal:generateContent' }, { path: exact.path + '?query=unsafe' },
    { method: 'GET' }, { servername: PLAY }, { rejectUnauthorized: false }]) {
    assert.equal(allowedUpstream({ ...exact, ...fields }), false);
  }
  const knownAuth = authFlags(Object.values(KEYRING_PREFIXES).map((prefix) => 'keyringAuth: ' + prefix + ' [private fixture]')
    .concat(Object.values(STORAGE_MESSAGES), 'using file-based token storage because fixture detected').join('\n'),
  'Please sign in to view available models');
  assert.equal(knownAuth.anyKeyringPrefix, true);
  assert.equal(knownAuth.unknownKeyringPrefix, false);
  for (const name of [...Object.keys(KEYRING_PREFIXES), ...Object.keys(STORAGE_MESSAGES)]) assert.equal(knownAuth[name], true);
  assert.equal(knownAuth.detectedFileFallback, true);
  assert.equal(knownAuth.signInNeeded, true);
  assert.equal(authFlags('keyringAuth: unknown [private fixture]', '').unknownKeyringPrefix, true);
  assert.doesNotMatch(JSON.stringify(knownAuth), /private fixture/);

  assert.deepEqual(securityResult({ status: 0, stdout: `    "${fs.realpathSync.native(directory)}"\n` },
    fs.realpathSync.native(directory), true), { code: 0, expectedLoginIncluded: true, errorClass: null });
  assert.deepEqual(securityResult({ status: 1, stderr: 'private fixture: operation not permitted' },
    '/private/fixture', false), { code: 1, expectedLoginIncluded: null, errorClass: 'permission-denied' });
  const broker = await helper.agyGoogleBroker(directory, {
    requestUpstream(options, callback) {
      assert.ok(allowedUpstream(options));
      observed.push(options.path);
      const response = Readable.from([]);
      response.statusCode = 200;
      response.headers = {};
      queueMicrotask(() => callback(response));
      return new PassThrough();
    },
  });
  try {
    assert.equal(await fixtureRequest(broker, '/v1internal:generateContent'), 403);
    assert.equal(await fixtureRequest(broker, '/v1internal:streamGenerateContent?alt=sse'), 403);
    assert.deepEqual(observed, []);
    assert.equal(await fixtureRequest(broker, exact.path), 200);
    assert.deepEqual(observed, [exact.path]);
    console.log('fake-only backend, exact metadata gate and safe auth/security projections passed');
  } finally {
    broker.close();
  }
}

const args = process.argv.slice(2);
if (!args.length) {
  console.log(JSON.stringify({ mode: 'disabled', childLaunches: 0 }));
} else if (args.length === 1 && ['--self-test', '--observe-bootstrap'].includes(args[0])) {
  const directory = fs.mkdtempSync('/private/tmp/acs-agy-auth-bootstrap-');
  try {
    const helper = await loadHelper(directory);
    if (args[0] === '--self-test') await selfTest(helper, directory);
    else await observe(helper, directory);
  } catch {
    process.stderr.write('Auth bootstrap control or its fixture failed a local safety check.\n');
    process.exitCode = 1;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
} else {
  process.stderr.write('usage: auth-bootstrap-controls.mjs --self-test | --observe-bootstrap\n');
  process.exitCode = 64;
}
