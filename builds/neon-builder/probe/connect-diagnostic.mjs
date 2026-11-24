import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { resolveModel, vendorOf } from '../../../lib/models.js';
import { agyAfterCall, agyTokenLeft } from '../../../tools/ask-model.mjs';

const PLAY = 'play.googleapis.com';
const BOOTSTRAP = {
  'daily-cloudcode-pa.googleapis.com': ['/v1internal:loadCodeAssist', '/v1internal:fetchAvailableModels',
    '/v1internal:retrieveUserQuota', '/v1internal:listExperiments'],
  'oauth2.googleapis.com': ['/token'],
  [PLAY]: ['/log'],
};
const PUBLIC_HOSTS = new Set([...Object.keys(BOOTSTRAP), 'cloudcode-pa.googleapis.com',
  'www.googleapis.com', 'accounts.google.com', 'generativelanguage.googleapis.com', 'aicode.googleapis.com']);
const EVENT_LIMIT = 100;

function authorityShape(value) {
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):([0-9]{1,5})$/i.exec(value);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return { authorityClass: 'malformed' };
  const host = match[1].toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  const portIs443 = match[2] === '443';
  if (PUBLIC_HOSTS.has(host)) return { authorityClass: 'named-google', googleHost: host, portIs443 };
  if (host.endsWith('.googleapis.com') || host.endsWith('.google.com')) return { authorityClass: 'other-google', portIs443 };
  if (host === 'localhost' || /^127\./.test(host) && net.isIP(host) === 4 || /^(?:0*:){2,7}1$/.test(host) && net.isIP(host) === 6) {
    return { authorityClass: 'loopback', portIs443 };
  }
  return { authorityClass: net.isIP(host) ? 'other-ip' : 'non-google', portIs443 };
}

function insertExactly(source, find, replacement) {
  if (source.split(find).length !== 2) throw new Error('builder helper changed shape');
  return source.replace(find, () => replacement);
}

async function temporaryHelper(directory) {
  const helper = new URL('../../../tools/agy-builder.mjs', import.meta.url);
  const operations = [
    ["from './agy-builder-source.mjs';", `from '${new URL('./agy-builder-source.mjs', helper).href}';`],
    ['const AGY_VERSION =', `const DIAGNOSTIC_BOOTSTRAP = ${JSON.stringify(BOOTSTRAP)};\nconst AGY_VERSION =`],
    ['{ requestUpstream = https.request } = {})', '{ requestUpstream, observeConnect, observeDeniedRpc } = {})'],
    ['const route = Object.hasOwn(GOOGLE_ROUTES[origin], req.url);',
      'const route = Object.hasOwn(GOOGLE_ROUTES[origin], req.url) && DIAGNOSTIC_BOOTSTRAP[origin]?.includes(req.url);'],
    ["      record({ ...evidence, status: 403, reason: 'request denied' });",
      "      observeDeniedRpc(evidence);\n      record({ ...evidence, status: 403, reason: 'request denied' });"],
    ['    if (!origin || req.headersDistinct[\'proxy-authorization\']?.length !== 1 || req.headers[\'proxy-authorization\'] !== auth) {',
      `    const supplied = req.headersDistinct['proxy-authorization']?.length ?? 0;
    const authMatched = supplied === 1 && req.headers['proxy-authorization'] === auth;
    observeConnect(req.url, { authorityExact: Boolean(origin), authPresent: supplied > 0, authMatched });
    if (!origin || !authMatched) {`],
    ['privateHome }, bin, home) {\n  const pinned', 'privateHome }, bin, home, diagnostic) {\n  const pinned'],
    ['const broker = await agyGoogleBroker(ca);', 'const broker = await agyGoogleBroker(ca, diagnostic);'],
  ];
  const builder = operations.reduce((source, [find, replacement]) => insertExactly(source, find, replacement),
    fs.readFileSync(helper, 'utf8'));
  const file = path.join(directory, 'diagnostic-helper.mjs');
  fs.writeFileSync(file, builder, { flag: 'wx', mode: 0o600 });
  return import(pathToFileURL(file).href);
}

function observer() {
  const events = [];
  const deniedRequests = [];
  let truncated = false;
  const append = (list, entry) => {
    if (list.length === EVENT_LIMIT) truncated = true;
    else list.push(entry);
  };
  const observeConnect = (authority, checks) => append(events, { ...authorityShape(authority), ...checks });
  const observeDeniedRpc = ({ origin, path: pathname, method }) => {
    const safePath = typeof pathname === 'string' && /^\/(?!\/)[a-z0-9/_:.-]{1,160}$/i.test(pathname) &&
      !/[0-9a-f]{20,}|[a-z0-9_-]{50,}|AIza[a-z0-9_-]{15,}|(?:^|\/)ya29[.]/i.test(pathname);
    append(deniedRequests, { origin, method, ...(safePath && { path: pathname }) });
  };
  return { observeConnect, observeDeniedRpc, summary: () => ({ events, deniedRequests, truncated }) };
}

async function connect(broker, authority, kind) {
  const socket = net.connect(broker.port, '127.0.0.1');
  socket.setTimeout(3000, () => socket.destroy(new Error('fixture timeout')));
  await once(socket, 'connect');
  const { username, password } = new URL(broker.url);
  const credentials = Buffer.from(`${username}:${kind === 'wrong' ? 'wrong' : password}`).toString('base64');
  const auth = kind ? `Proxy-Authorization: Basic ${credentials}\r\n` : '';
  const response = once(socket, 'data');
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`);
  const [bytes] = await response;
  return { socket, status: Number(bytes.toString().split(' ')[1]) };
}

async function assertRpcStatus(broker, origin, rpc, expected = 403, method = 'POST') {
  const { socket, status } = await connect(broker, `${origin}:443`, 'right');
  assert.equal(status, 200);
  const secure = tls.connect({ socket, servername: origin, ca: fs.readFileSync(broker.certificate) });
  await once(secure, 'secureConnect');
  secure.write(`${method} ${rpc} HTTP/1.1\r\nHost: ${origin}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  let reply = '';
  for await (const data of secure) reply += data.toString();
  assert.equal(Number(reply.split(' ')[1]), expected);
}

async function selfTest(helper, directory) {
  const { observeConnect, observeDeniedRpc, summary } = observer();
  const forwarded = [];
  const ca = path.join(directory, 'ca');
  fs.mkdirSync(ca, { mode: 0o700 });
  const broker = await helper.agyGoogleBroker(ca, {
    observeConnect, observeDeniedRpc,
    requestUpstream(options, callback) {
      forwarded.push([options.hostname, options.method, options.path]);
      const response = Readable.from([]);
      response.statusCode = 200;
      response.headers = {};
      queueMicrotask(() => callback(response));
      return new PassThrough();
    },
  });
  try {
    const host = 'daily-cloudcode-pa.googleapis.com';
    const cases = [
      [host + ':443', null, { authorityClass: 'named-google', googleHost: host, portIs443: true, authorityExact: true,
        authPresent: false, authMatched: false }],
      [host + ':443', 'wrong', { authorityClass: 'named-google', googleHost: host, portIs443: true, authorityExact: true,
        authPresent: true, authMatched: false }],
      ['cloudcode-pa.googleapis.com:443', 'right', { authorityClass: 'named-google', googleHost: 'cloudcode-pa.googleapis.com',
        portIs443: true, authorityExact: false, authPresent: true, authMatched: true }],
      [PLAY + ':443', 'wrong', { authorityClass: 'named-google', googleHost: PLAY, portIs443: true, authorityExact: true,
        authPresent: true, authMatched: false }],
      ['127.0.0.1:3333', 'right', { authorityClass: 'loopback', portIs443: false, authorityExact: false,
        authPresent: true, authMatched: true }],
      ['credential-canary.invalid:443', null, { authorityClass: 'non-google', portIs443: true, authorityExact: false,
        authPresent: false, authMatched: false }],
    ];
    for (const [authority, kind, event] of cases) {
      const { socket, status } = await connect(broker, authority, kind);
      assert.equal(status, 403);
      socket.destroy();
      assert.deepEqual(summary().events.at(-1), event);
    }
    for (const rpc of ['/v1internal:generateContent', '/v1internal:streamGenerateContent',
      '/v1internal:streamGenerateContent?alt=sse', '/v1beta/models/example:generateContent']) {
      await assertRpcStatus(broker, host, rpc);
    }
    await assertRpcStatus(broker, 'oauth2.googleapis.com', '/v1internal:generateContent');
    await assertRpcStatus(broker, PLAY, '/log?fixture-secret=discarded');
    await assertRpcStatus(broker, PLAY, '/log', 403, 'GET');
    await assertRpcStatus(broker, PLAY, '/v1internal:generateContent');
    await assertRpcStatus(broker, PLAY, '/ya29.fixture-credential?fixture-secret=discarded');
    assert.deepEqual(summary().deniedRequests.filter((entry) => entry.origin === PLAY), [
      { origin: PLAY, method: 'POST', path: '/log' },
      { origin: PLAY, method: 'GET', path: '/log' },
      { origin: PLAY, method: 'POST', path: '/v1internal:generateContent' },
      { origin: PLAY, method: 'POST' },
    ]);
    assert.ok(summary().deniedRequests.some((entry) =>
      entry.origin === host && entry.method === 'POST' && entry.path === '/v1internal:streamGenerateContent'));
    await assertRpcStatus(broker, host, '/v1internal:loadCodeAssist?unexpected=yes');
    await assertRpcStatus(broker, host, '/v1internal:loadCodeAssist', 403, 'GET');
    assert.deepEqual(forwarded, []);
    await assertRpcStatus(broker, host, '/v1internal:loadCodeAssist', 200);
    await assertRpcStatus(broker, PLAY, '/log', 200);
    assert.deepEqual(forwarded, [[host, 'POST', '/v1internal:loadCodeAssist'], [PLAY, 'POST', '/log']]);
    const exact = { hostname: PLAY, servername: PLAY, port: 443, method: 'POST', path: '/log', rejectUnauthorized: true };
    assert.equal(allowedUpstream(exact), true);
    for (const change of [{ path: '/v1internal:generateContent' }, { path: '/log?fixture=1' },
      { method: 'GET' }, { servername: host }, { rejectUnauthorized: false }]) {
      assert.equal(allowedUpstream({ ...exact, ...change }), false);
    }
    assert.equal(summary().truncated, false);
    console.log('CONNECT and denied RPC projections, exact bootstrap and zero forwarded inference passed');
  } finally {
    broker.close();
  }
}

function allowedUpstream({ hostname, port, method, path: rpc, servername, rejectUnauthorized }) {
  return Object.hasOwn(BOOTSTRAP, hostname) && BOOTSTRAP[hostname].includes(rpc) &&
    method === 'POST' && port === 443 && servername === hostname && rejectUnauthorized === true;
}

async function observePrint(helper, directory, family) {
  const { id } = resolveModel(family);
  if (vendorOf(id) !== 'agy') throw new Error('diagnostic requires a family that resolves to agy');
  const root = path.join(directory, 'worktree');
  const home = fs.realpathSync.native(os.homedir());
  const bin = String(process.env.PATH || '').split(path.delimiter).filter((entry) => path.isAbsolute(entry))
    .map((entry) => path.join(entry, 'agy')).find((file) => {
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
      } catch { return false; }
    });
  if (!bin) throw new Error('agy CLI was not found on the absolute entries of PATH');
  fs.mkdirSync(root);
  const git = spawnSync('/usr/bin/git', ['init', '-q'], {
    cwd: root, env: { PATH: '/usr/bin:/bin', HOME: '/var/empty', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
    stdio: 'ignore', timeout: 5000,
  });
  if (git.status !== 0) throw new Error('fixture Git init failed');
  fs.writeFileSync(path.join(root, 'fixture.txt'), 'harmless fixture\n');
  const { observeConnect, observeDeniedRpc, summary } = observer();
  const metadataCounts = {};
  let phase = 'preflight';
  let parsedPrintResult = false;
  const cancel = setTimeout(() => process.emit('SIGTERM', 'SIGTERM'), 25_000);
  try {
    await helper.runAgyBuilder({
      root, home, bin, id, effort: 'high', prompt: 'Return the text fixture.',
      checkWorkspace: () => [], checkConfig: () => null, checkToken: agyTokenLeft, checkSignIn: agyAfterCall,
      readResult() {
        parsedPrintResult = true;
        return { exit: 4, error: 'diagnostic cannot publish' };
      },
    }, {
      async prepare(layout, executable, actualHome) {
        phase = 'prepare';
        const launch = await helper.prepareAgyLaunch(layout, executable, actualHome, {
          observeConnect, observeDeniedRpc,
          requestUpstream(options, callback) {
            if (!allowedUpstream(options)) {
              throw new Error('diagnostic attempted a forbidden upstream request');
            }
            const type = options.hostname === 'oauth2.googleapis.com' ? 'oauth' :
              options.hostname === PLAY ? 'telemetry' : 'bootstrap';
            metadataCounts[type] = (metadataCounts[type] ?? 0) + 1;
            return https.request(options, callback);
          },
        });
        phase = 'print';
        return launch;
      },
    });
    throw new Error('diagnostic unexpectedly published');
  } catch {
    // The normal print refusal can include provider text. Emit only bounded, classified evidence.
    console.log(JSON.stringify({ phase, parsedPrintResult, ...summary(), metadataCounts,
      forwardedInference: 0, noOperatorPlaintext: !agyTokenLeft(home) }));
  } finally {
    clearTimeout(cancel);
  }
}

const [mode, familyFlag, family, ...extra] = process.argv.slice(2);
const selfTestMode = mode === '--self-test' && process.argv.length === 3;
const observeMode = mode === '--bootstrap-no-inference' && familyFlag === '--family' && family && !extra.length;
if (!selfTestMode && !observeMode) {
  throw new Error('usage: connect-diagnostic.mjs --self-test | --bootstrap-no-inference --family <family>');
}
const directory = fs.mkdtempSync('/private/tmp/acs-agy-connect-probe-');
try {
  const helper = await temporaryHelper(directory);
  if (selfTestMode) await selfTest(helper, directory);
  else await observePrint(helper, directory, family);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
