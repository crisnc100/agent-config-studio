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
    ['const AGY_VERSION =', `const COMPARISON_ROUTES = ${JSON.stringify(ROUTES)};\nconst AGY_VERSION =`],
    ['const AGY_DIGEST =', 'export const AGY_DIGEST ='],
    ['const route = Object.hasOwn(GOOGLE_ROUTES[origin], req.url);',
      'const route = Object.hasOwn(GOOGLE_ROUTES[origin], req.url) && COMPARISON_ROUTES[origin]?.includes(req.url);'],
    ['privateHome }, bin, home) {\n  const pinned', 'privateHome }, bin, home, brokerOptions) {\n  const pinned'],
    ['const broker = await agyGoogleBroker(ca);', 'const broker = await agyGoogleBroker(ca, brokerOptions);'],
  ];
  const file = path.join(directory, 'auth-compare-helper.mjs');
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

async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

function signature(file) {
  const inspected = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', file],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
  if (inspected.status !== 0) throw new Error('could not inspect executable signature');
  const fields = ['Identifier', 'TeamIdentifier', 'CDHash'].map((key) =>
    new RegExp(`^${key}=([^\\r\\n]+)$`, 'm').exec(inspected.stderr)?.[1]);
  if (fields.some((value) => !value) || !/^[A-Fa-f0-9]{40}$/.test(fields[2])) {
    throw new Error('executable signature metadata incomplete');
  }
  return fields;
}

async function verifyOriginal(original, pinned, expectedDigest) {
  assert.equal(fs.realpathSync.native(original), original, 'original executable path changed');
  assert.equal(fs.statSync(original).size, fs.statSync(pinned).size, 'executable size mismatch');
  const pair = await Promise.all([digest(original), digest(pinned)]);
  if (pair.some((value) => value !== expectedDigest) || signature(original).join('\n') !== signature(pinned).join('\n')) {
    throw new Error('original does not match production-pinned executable');
  }
}

function matchingSeeds(a, b, home) {
  const keychains = path.join('Library', 'Keychains');
  const expected = fs.realpathSync.native(path.join(home, keychains));
  const login = 'login.keychain-db';
  const realLogin = fs.realpathSync.native(path.join(expected, login));
  for (const layout of [a, b]) {
    const alias = path.join(layout.privateHome, keychains);
    if (fs.realpathSync.native(alias) !== expected ||
        fs.realpathSync.native(path.join(alias, login)) !== realLogin) return false;
  }
  return SEEDS.every((file) => {
    const inputs = [a, b].map(({ privateHome }) => path.join(privateHome, file));
    const present = inputs.map((input) => fs.existsSync(input));
    return present[0] === present[1] && (!present[0] || fs.readFileSync(inputs[0]).equals(fs.readFileSync(inputs[1])));
  });
}

function authFlags(log, output) {
  return {
    keychainLoaded: /keyringAuth: loaded token/i.test(log),
    keychainAuthenticated: /authenticated via keyring/i.test(log),
    failedOAuthParams: /keyringAuth: failed to get oauth params/i.test(log),
    failedStoredTokenLookup: /keyringAuth: failed to load stored token/i.test(log),
    invalidStoredToken: /keyringAuth: saved token invalid/i.test(log),
    cancelledKeyring: /keyringAuth: context cancelled/i.test(log),
    signInNeeded: /Please sign in to view available models/i.test(output),
  };
}

function audit(events) {
  return events.map(({ origin, method, path: rpc, status }) => ({
    ...(Object.hasOwn(ROUTES, origin) && { origin }),
    ...(['CONNECT', 'POST', 'GET'].includes(method) && { method }),
    ...(Object.hasOwn(ROUTES, origin) && ROUTES[origin].includes(rpc) && { path: rpc }),
    ...(Number.isInteger(status) && status >= 100 && status <= 599 && { status }),
  }));
}

function launchModels(helper, layout, launch, exe) {
  const { env, params } = launch;
  const logFile = path.join(layout.runtime, 'agy.log');
  const args = helper.agyBuildWall({ ...params, bin: exe },
    [exe, '--log-file', logFile, '--output-format', 'json', 'models']);
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

async function compare(helper, directory) {
  const home = fs.realpathSync.native(os.homedir());
  const original = findExecutable();
  const arms = [];
  const reports = [];
  if (agyTokenLeft(home)) throw new Error('plaintext token preflight refused');
  try {
    for (const name of ['private-clone', 'installed-original']) {
      const root = path.join(directory, name);
      fs.mkdirSync(root, { mode: 0o700 });
      const layout = helper.agyBuildLayout(root);
      if (agyTokenLeft(layout.privateHome)) throw new Error('private plaintext token preflight refused');
      const launch = await helper.prepareAgyLaunch(layout, original, home, {
        requestUpstream(options, callback) {
          if (!allowedUpstream(options)) throw new Error('comparison blocked unexpected upstream request');
          return https.request(options, callback);
        },
      });
      arms.push({ name, layout, launch });
    }
    if (!matchingSeeds(arms[0].layout, arms[1].layout, home)) throw new Error('private HOME inputs do not match');
    await verifyOriginal(original, arms[1].launch.params.bin, helper.AGY_DIGEST);
    for (const { name, layout, launch } of arms) {
      if (agyTokenLeft(home) || agyTokenLeft(layout.privateHome)) throw new Error('plaintext token preflight refused');
      if (name === 'installed-original') await verifyOriginal(original, launch.params.bin, helper.AGY_DIGEST);
      const executable = name === 'private-clone' ? launch.params.bin : original;
      const result = await launchModels(helper, layout, launch, executable);
      reports.push({ name, ...result });
      if (result.interrupted || result.turns > 0 || agyTokenLeft(home) || agyTokenLeft(layout.privateHome)) break;
    }
    const oauthObserved = reports.some(({ brokerEvents }) => brokerEvents.some(({ origin, method }) => origin === OAUTH && method === 'POST'));
    console.log(JSON.stringify({ mode: 'metadata-only', privateInputsMatched: true, signatureMatched: true,
      paired: reports.length === 2, oauthObserved, arms: reports }, null, 2));
    if (reports.length !== 2 || reports.some(({ cleanPostflight, turns }) => !cleanPostflight || turns > 0)) process.exitCode = 1;
  } finally {
    for (const { launch } of arms) launch.broker.close();
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
  assert.deepEqual(authFlags('keyringAuth: failed to load stored token: secret fixture', 'Please sign in to view available models'), {
    keychainLoaded: false, keychainAuthenticated: false, failedOAuthParams: false, failedStoredTokenLookup: true,
    invalidStoredToken: false, cancelledKeyring: false, signInNeeded: true,
  });
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
    console.log('fake-only backend, exact metadata gate and safe auth projection passed');
  } finally {
    broker.close();
  }
}

const args = process.argv.slice(2);
if (!args.length) {
  console.log(JSON.stringify({ mode: 'disabled', childLaunches: 0 }));
} else if (args.length === 1 && ['--self-test', '--compare-executables'].includes(args[0])) {
  const directory = fs.mkdtempSync('/private/tmp/acs-agy-auth-executable-');
  try {
    const helper = await loadHelper(directory);
    if (args[0] === '--self-test') await selfTest(helper, directory);
    else await compare(helper, directory);
  } catch {
    process.stderr.write('Executable comparison or its fixture failed a local safety check.\n');
    process.exitCode = 1;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
} else {
  process.stderr.write('usage: auth-executable-compare.mjs --self-test | --compare-executables\n');
  process.exitCode = 64;
}
