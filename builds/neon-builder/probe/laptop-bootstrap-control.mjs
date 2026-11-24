import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { resolveModel, vendorOf } from '../../../lib/models.js';
import { agyAfterCall, agyTokenLeft } from '../../../tools/ask-model.mjs';

const baseline = new URL('./connect-diagnostic.mjs', import.meta.url);
const baselineHash = '4ae51fe64a5e0eb2c74decd2925232d99ed554e7afcc97a449daebc796580071';
const cloud = 'daily-cloudcode-pa.googleapis.com';
const metadata = [
  [cloud, 'POST', '/v1internal:loadCodeAssist', 'load-code-assist'],
  [cloud, 'POST', '/v1internal:fetchAvailableModels', 'models'],
  [cloud, 'POST', '/v1internal:retrieveUserQuota', 'quota'],
  [cloud, 'POST', '/v1internal:listExperiments', 'experiments'],
  ['oauth2.googleapis.com', 'POST', '/token', 'oauth'],
  ['play.googleapis.com', 'POST', '/log', 'telemetry'],
  ['www.googleapis.com', 'GET', '/oauth2/v2/userinfo', 'google-userinfo'],
  ['aicode.googleapis.com', 'GET', '/v1alpha:fetchConfig', 'aicode-config'],
];
const generation = ['/v1internal:generateContent', '/v1internal:streamGenerateContent',
  '/v1internal:streamGenerateContent?alt=sse'];
const gets = Object.fromEntries(metadata.filter(([, method]) => method === 'GET').map(([host, , route]) => [host, route]));
const deniedLabels = new Map([...metadata.map(([host, method, route, label]) => [[host, method, route].join(' '), label]),
  ...generation.map((route) => [[cloud, 'POST', route.split('?')[0]].join(' '), 'generation']),
  ...['fetchAdminControls', 'retrieveUserQuotaSummary', 'fetchUserInfo'].map((name) =>
    [[cloud, 'POST', '/v1internal:' + name].join(' '), name])]);

async function loadControl(directory) {
  const bytes = fs.readFileSync(baseline);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== baselineHash) throw new Error('bootstrap baseline changed');
  const parts = bytes.toString('utf8').split('\nconst [mode, familyFlag, family, ...extra] = process.argv.slice(2);\n');
  if (parts.length !== 2) throw new Error('bootstrap entry point changed');
  let source = parts[0];
  function replace(before, after) {
    if (source.split(before).length !== 2) throw new Error('bootstrap source anchor changed');
    source = source.replace(before, () => after);
  }
  for (const relative of ['../../../lib/models.js', '../../../tools/ask-model.mjs']) {
    replace("from '" + relative + "';", 'from ' + JSON.stringify(new URL(relative, baseline).href) + ';');
  }
  const builder = '../../../tools/agy-builder.mjs';
  replace("new URL('" + builder + "', import.meta.url)", 'new URL(' + JSON.stringify(new URL(builder, baseline).href) + ')');
  replace("DIAGNOSTIC_BOOTSTRAP[origin]?.includes(req.url);'],",
    '((req.method === "POST" && DIAGNOSTIC_BOOTSTRAP[origin]?.includes(req.url)) || ' +
      '(req.method === "GET" && ' + JSON.stringify(gets) + '[origin] === req.url));\'],');
  const observe = "observeDeniedRpc(evidence);\\n      record";
  const projection = [
    'observeDeniedRpc({ ...evidence, queryPresent: req.url.includes("?"),',
    '      generationDenied: origin === ' + JSON.stringify(cloud) + ' && req.method === "POST" &&',
    '        ' + JSON.stringify(generation) + '.includes(req.url) && GOOGLE_ROUTES[origin][req.url] === "POST" &&',
    '        req.headersDistinct.host?.length === 1 &&',
    '        (req.headers.host === origin || req.headers.host === origin + ":443") });',
    '      record',
  ].join('\\n');
  replace(observe, projection.replaceAll('"', '\\"'));
  const file = path.join(directory, 'laptop-bootstrap-helper.mjs');
  fs.writeFileSync(file, source + '\nexport { temporaryHelper, connect, authorityShape };\n', { mode: 0o600, flag: 'wx' });
  return import(pathToFileURL(file).href);
}

function recorder(request) {
  const dispatches = {};
  let gateRejections = 0;
  function requestUpstream(options, callback) {
    const { hostname, method, path: route, servername, port, rejectUnauthorized, ca, agent } = options;
    const label = metadata.find(([host, verb, rpc]) =>
      hostname === host && method === verb && route === rpc)?.[3] ??
      (hostname === cloud && method === 'POST' && generation.includes(route) ? 'generation' : null);
    if (!label || label === 'generation' || servername !== hostname || port !== 443 ||
        rejectUnauthorized !== true || ca !== tls.rootCertificates || agent !== false) {
      ++gateRejections;
      throw new Error('bootstrap upstream gate refused dispatch');
    }
    const bucket = dispatches[label] ??= { count: 0, statuses: {} };
    const upstream = request(options, (response) => {
      if (Number.isInteger(response.statusCode) && response.statusCode >= 100 && response.statusCode <= 599) {
        bucket.statuses[response.statusCode] = (bucket.statuses[response.statusCode] ?? 0) + 1;
      }
      callback(response);
    });
    ++bucket.count;
    return upstream;
  }
  return { requestUpstream, summary: () => ({ dispatches, gateRejections, forwardedInference: dispatches.generation?.count ?? 0 }) };
}

function observation(api) {
  const authorities = [];
  const denied = [];
  let truncated = false;
  const add = (list, item) => list.length < 100 ? list.push(item) : (truncated = true);
  return {
    observeConnect(authority, checks) { add(authorities, { ...api.authorityShape(authority), ...checks }); },
    observeDeniedRpc({ origin, method, path: route, queryPresent, generationDenied }) {
      const label = deniedLabels.get([origin, method, route].join(' ')) ?? 'other';
      add(denied, { label, queryPresent: Boolean(queryPresent), generationDenied: Boolean(generationDenied), status: 403 });
    },
    summary: () => ({ authorities, denied, truncated }),
  };
}

function qualifies({ refusedPublication, resultCallbackReached, keychainLoaded, keychainAuthenticated, cleanPostflight, noOperatorPlaintext,
  truncated, denied, gateRejections, forwardedInference }) {
  return refusedPublication && resultCallbackReached && keychainLoaded && keychainAuthenticated && cleanPostflight && noOperatorPlaintext &&
    !truncated && gateRejections === 0 && forwardedInference === 0 &&
    !denied.some(({ label, queryPresent }) => queryPresent && (label === 'aicode-config' || label === 'google-userinfo')) &&
    denied.some(({ generationDenied }) => generationDenied);
}

async function run(helper, api, directory, family) {
  const { id } = resolveModel(family);
  if (vendorOf(id) !== 'agy') throw new Error('bootstrap requires an agy model family');
  const root = path.join(directory, 'fixture');
  const home = fs.realpathSync.native(os.homedir());
  const bin = (process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute).map((entry) => path.join(entry, 'agy')).find((file) => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); }
    catch { return false; }
  });
  if (!bin) throw new Error('agy CLI not found');
  fs.mkdirSync(root, { mode: 0o700 });
  const git = spawnSync('/usr/bin/git', ['init', '-q'], {
    cwd: root, env: { PATH: '/usr/bin:/bin', HOME: '/var/empty', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
    stdio: 'ignore', timeout: 5000,
  });
  if (git.status !== 0) throw new Error('fixture Git init failed');
  fs.writeFileSync(path.join(root, 'fixture.txt'), 'harmless fixture\n', { mode: 0o600 });
  const calls = recorder(https.request);
  const seen = observation(api);
  let phase = 'preflight';
  let resultCallbackReached = false;
  let keychainLoaded = false;
  let keychainAuthenticated = false;
  let cleanPostflight = false;
  let refusedPublication = false;
  const cancel = setTimeout(() => process.emit('SIGTERM', 'SIGTERM'), 25_000);
  try {
    await helper.runAgyBuilder({
      root, home, bin, id, effort: 'high', prompt: 'Return the text fixture.',
      checkWorkspace: () => [], checkConfig: () => null, checkToken: agyTokenLeft,
      checkSignIn(logFile, privateHome) {
        const problem = agyAfterCall(logFile, privateHome);
        const log = fs.readFileSync(logFile, 'utf8');
        keychainLoaded = /keyringAuth: loaded token/i.test(log);
        keychainAuthenticated = /ChainedAuth: authenticated via keyring/i.test(log);
        cleanPostflight = !problem;
        return problem;
      },
      readResult() {
        resultCallbackReached = true;
        return { exit: 4, error: 'diagnostic cannot publish' };
      },
    }, {
      async prepare(layout, executable, actualHome) {
        phase = 'prepare';
        const launch = await helper.prepareAgyLaunch(layout, executable, actualHome, {
          observeConnect: seen.observeConnect, observeDeniedRpc: seen.observeDeniedRpc, requestUpstream: calls.requestUpstream,
        });
        phase = 'print';
        return launch;
      },
    });
  } catch {
    refusedPublication = true;
  } finally {
    clearTimeout(cancel);
  }
  const evidence = { phase, refusedPublication, resultCallbackReached, keychainLoaded, keychainAuthenticated, cleanPostflight,
    noOperatorPlaintext: !agyTokenLeft(home), ...seen.summary(), ...calls.summary() };
  const passed = qualifies(evidence);
  console.log(JSON.stringify({ ...evidence, passed }, null, 2));
  if (!passed) process.exitCode = 1;
}

async function selfTest(helper, api, directory) {
  const seen = observation(api);
  let requests = 0;
  const calls = recorder((_options, callback) => {
    ++requests;
    const response = Readable.from([]);
    response.statusCode = 200;
    response.headers = {};
    queueMicrotask(() => callback(response));
    return new PassThrough();
  });
  const broker = await helper.agyGoogleBroker(directory, {
    observeConnect: seen.observeConnect, observeDeniedRpc: seen.observeDeniedRpc, requestUpstream: calls.requestUpstream,
  });
  async function send(host, method, route, framing = 'Content-Length: 0\r\n', body = '') {
    const { socket, status } = await api.connect(broker, host + ':443', 'right');
    assert.equal(status, 200);
    const client = tls.connect({ socket, servername: host, ca: fs.readFileSync(broker.certificate) });
    await once(client, 'secureConnect');
    client.write(method + ' ' + route + ' HTTP/1.1\r\nHost: ' + host + '\r\nConnection: close\r\n' + framing + '\r\n' + body);
    let reply = '';
    for await (const chunk of client) reply += chunk;
    return Number(reply.split(' ')[1]);
  }
  try {
    for (const [host, route] of Object.entries(gets)) {
      assert.equal(await send(host, 'GET', route + '?private=secret'), 403);
      assert.equal(await send(host, 'GET', route, 'Transfer-Encoding: chunked\r\n', '1\r\nx\r\n0\r\n\r\n'), 403);
      assert.equal(await send(host, 'GET', route, 'Content-Length: 1\r\n', 'x'), 403);
      assert.equal(await send(host, 'GET', route, 'X-HTTP-Method-Override: POST\r\n'), 403);
    }
    for (const route of generation) assert.equal(await send(cloud, 'POST', route), 403);
    assert.equal(await send(cloud, 'POST', generation[0] + '?alternate=secret'), 403);
    assert.equal(requests, 0);
    assert.equal(seen.summary().denied.filter(({ generationDenied }) => generationDenied).length, 3);
    assert.equal(seen.summary().denied.filter(({ queryPresent }) => queryPresent).length, 4);
    assert.doesNotMatch(JSON.stringify(seen.summary()), /private|secret|alternate/);
    assert.throws(() => calls.requestUpstream({ hostname: cloud, servername: cloud, port: 443, method: 'POST',
      path: generation[0], rejectUnauthorized: true, ca: tls.rootCertificates, agent: false }), /gate refused/);
    assert.equal(requests, 0);
    for (const [host, route] of Object.entries(gets)) assert.equal(await send(host, 'GET', route), 200);
    assert.equal(requests, 2);
    assert.deepEqual(calls.summary(), { dispatches: {
      'google-userinfo': { count: 1, statuses: { 200: 1 } }, 'aicode-config': { count: 1, statuses: { 200: 1 } },
    }, gateRejections: 1, forwardedInference: 0 });
    const evidence = { refusedPublication: true, resultCallbackReached: true, keychainLoaded: true, keychainAuthenticated: true,
      cleanPostflight: true, noOperatorPlaintext: true, truncated: false,
      gateRejections: 0, forwardedInference: 0, denied: [{ generationDenied: true }] };
    assert.equal(qualifies(evidence), true);
    for (const change of [{ refusedPublication: false }, { keychainLoaded: false }, { keychainAuthenticated: false }, { cleanPostflight: false },
      { denied: [] }, { forwardedInference: 1 }, { denied: [{ generationDenied: true }, { label: 'aicode-config', queryPresent: true }] }]) {
      assert.equal(qualifies({ ...evidence, ...change }), false);
    }
    console.log('fake-only exact bodyless GETs, dual generation blocks, dispatch counts and auth proof passed');
  } finally {
    broker.close();
  }
}

const [mode, familyFlag, family, ...extra] = process.argv.slice(2);
if (mode === undefined) {
  console.log(JSON.stringify({ mode: 'disabled', childLaunches: 0 }));
} else if ((mode === '--self-test' && process.argv.length === 3) ||
    (mode === '--laptop-bootstrap-no-inference' && familyFlag === '--family' && family && !extra.length)) {
  const directory = fs.mkdtempSync('/private/tmp/acs-agy-laptop-bootstrap-');
  try {
    const api = await loadControl(directory);
    const helper = await api.temporaryHelper(directory);
    if (mode === '--self-test') await selfTest(helper, api, directory);
    else await run(helper, api, directory, family);
  } catch {
    process.stderr.write('Laptop bootstrap control failed a local safety check.\n');
    process.exitCode = 1;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
} else {
  process.stderr.write('usage: laptop-bootstrap-control.mjs --self-test | --laptop-bootstrap-no-inference --family <family>\n');
  process.exitCode = 64;
}
