import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { spawn } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';
import { test } from 'node:test';
import { agyBuildEnv, agyBuildWall, agyGoogleBroker } from '../tools/agy-builder.mjs';

const origin = 'daily-cloudcode-pa.googleapis.com';
const firstPath = '/v1internal:loadCodeAssist';
const modelsPath = '/v1internal:fetchAvailableModels';
const inferencePath = '/v1internal:streamGenerateContent?alt=sse';

function temp(t, directories = []) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-agy-builder-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of directories) fs.mkdirSync(path.join(root, name));
  return root;
}

function waitFor(socket, event) {
  return new Promise((resolve, reject) => {
    socket.once(event, resolve);
    socket.once('error', reject);
    socket.setTimeout(5000, () => socket.destroy(new Error('fixture timed out')));
  });
}

async function connectBroker(broker, target, authenticated = true) {
  const socket = net.connect(broker.port, '127.0.0.1');
  await waitFor(socket, 'connect');
  const { username, password } = new URL(broker.url);
  const auth = authenticated ? `Proxy-Authorization: Basic ${Buffer.from(`${username}:${password}`).toString('base64')}\r\n` : '';
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
  const status = (await waitFor(socket, 'data')).toString().split(' ')[1];
  if (status !== '200') socket.destroy();
  return { status, socket };
}

async function brokerRequest(broker, { authority = origin, hostname = origin, host = origin, pathname = firstPath, method = 'POST', extra = '', framing = 'Content-Length: 0\r\n', body = '' } = {}) {
  const { socket, status } = await connectBroker(broker, `${authority}:443`);
  assert.equal(status, '200');
  const connection = tls.connect({
    socket, servername: hostname, ca: fs.readFileSync(broker.certificate), ALPNProtocols: ['http/1.1'],
  });
  try {
    await waitFor(connection, 'secureConnect');
    connection.write(`${method} ${pathname} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n${framing}\r\n${body}`);
    let reply = '';
    for await (const chunk of connection) reply += chunk.toString();
    return reply;
  } finally {
    connection.destroy();
  }
}

test('Google broker checks CONNECT, SNI, Host, method, route and upstream redirects', async (t) => {
  const forwarded = [];
  const broker = await agyGoogleBroker(temp(t), {
    requestUpstream(options, callback) {
      forwarded.push(options);
      queueMicrotask(() => {
        const redirect = options.path === modelsPath;
        const response = Readable.from(['mock Google response']);
        response.statusCode = redirect ? 302 : 200;
        response.headers = redirect ? { location: 'https://example.test/sensitive' } : { 'alt-svc': 'h3=":443"' };
        callback(response);
      });
      return new PassThrough();
    },
  });
  t.after(() => broker.close());

  assert.equal((await connectBroker(broker, `${origin}:443`, false)).status, '403');
  for (const target of ['example.test:443', '127.0.0.1:443', `${origin}:444`, `${origin}.example.test:443`]) {
    assert.equal((await connectBroker(broker, target)).status, '403');
  }
  await assert.rejects(brokerRequest(broker, { hostname: 'oauth2.googleapis.com' }));
  assert.match(await brokerRequest(broker, { host: 'oauth2.googleapis.com' }), /^HTTP\/1\.1 403/);
  assert.match(await brokerRequest(broker, { extra: `Host: ${origin}\r\n` }), /^HTTP\/1\.1 403/);
  assert.match(await brokerRequest(broker, { method: 'GET' }), /^HTTP\/1\.1 403/);
  assert.match(await brokerRequest(broker, { pathname: inferencePath + '&other=fixture' }), /^HTTP\/1\.1 403/);
  assert.match(await brokerRequest(broker, { pathname: '/v1internal:unknownRequest?key=fixture#sensitive' }), /^HTTP\/1\.1 403/);
  assert.match(await brokerRequest(broker, { pathname: '/v1internal:proxyCommand' }), /^HTTP\/1\.1 403/);
  assert.match(await brokerRequest(broker, { pathname: `https://${origin}${firstPath}` }), /^HTTP\/1\.1 403/);
  const proxyPassword = new URL(broker.url).password;
  assert.match(await brokerRequest(broker, { pathname: `/v1internal:${proxyPassword}` }), /^HTTP\/1\.1 403/);
  assert.equal(forwarded.length, 0);

  const success = await brokerRequest(broker, { extra: 'Authorization: Bearer fixture\r\nProxy-Authorization: fake\r\n' });
  assert.match(success, /^HTTP\/1\.1 200/);
  assert.match(success, /mock Google response/);
  assert.doesNotMatch(success, /alt-svc/i);
  const [allowed] = forwarded;
  assert.equal(allowed.hostname, origin);
  assert.equal(allowed.servername, origin);
  assert.equal(allowed.path, firstPath);
  assert.equal(allowed.port, 443);
  assert.equal(allowed.rejectUnauthorized, true);
  assert.equal(allowed.headers.authorization, 'Bearer fixture');
  assert.equal(allowed.headers['proxy-authorization'], undefined);

  const redirect = await brokerRequest(broker, { pathname: modelsPath });
  assert.match(redirect, /^HTTP\/1\.1 502/);
  assert.doesNotMatch(redirect, /example\.test|location:/i);
  assert.equal(forwarded.length, 2);
  assert.match(await brokerRequest(broker, { pathname: inferencePath }), /^HTTP\/1\.1 200/);
  assert.equal(forwarded[2].path, inferencePath);
  assert.ok(broker.events.some((event) => event.reason === 'CONNECT denied'));
  assert.ok(broker.events.some((event) => event.reason === 'CONNECT denied' && event.origin === undefined && event.method === 'CONNECT' && event.status === 403));
  assert.ok(broker.events.some((event) => event.origin === origin && event.method === 'POST' && event.path === '/v1internal:unknownRequest' && event.status === 403 && event.reason === 'request denied'));
  assert.ok(broker.events.some((event) => event.origin === origin && event.method === 'POST' && event.path === '/v1internal:streamGenerateContent' && event.status === 200));
  assert.ok(broker.events.some((event) => event.path === modelsPath && event.status === 502 && event.upstreamStatus === 302 && event.reason === 'upstream redirect denied'));
  const audit = JSON.stringify(broker.events);
  assert.doesNotMatch(audit, /Bearer|fixture|sensitive|example\.test|\?alt=/);
  assert.ok(!audit.includes(proxyPassword));
});

test('Google broker allows only authenticated play telemetry on the exact HTTPS route', async (t) => {
  const play = 'play.googleapis.com';
  const forwarded = [];
  let redirect = false;
  const broker = await agyGoogleBroker(temp(t), {
    requestUpstream(options, callback) {
      forwarded.push(options);
      const response = Readable.from([]);
      response.statusCode = redirect ? 302 : 200;
      response.headers = redirect ? { location: 'https://example.test/refused' } : {};
      queueMicrotask(() => callback(response));
      return new PassThrough();
    },
  });
  t.after(() => broker.close());
  const rpc = { authority: play, hostname: play, host: play, pathname: '/log' };
  assert.equal((await connectBroker(broker, `${play}:443`, false)).status, '403');
  for (const target of [`${play}:444`, `${play}.example.test:443`, 'other.googleapis.com:443']) {
    assert.equal((await connectBroker(broker, target)).status, '403', target);
  }
  await assert.rejects(brokerRequest(broker, { ...rpc, hostname: origin }));
  assert.match(await brokerRequest(broker, { ...rpc, host: origin }), /^HTTP\/1[.]1 403/);
  assert.match(await brokerRequest(broker, { ...rpc, extra: `Host: ${play}\r\n` }), /^HTTP\/1[.]1 403/);
  assert.match(await brokerRequest(broker, { ...rpc, method: 'GET' }), /^HTTP\/1[.]1 403/);
  for (const pathname of ['/log?extra=value', '/log/', '/logs', inferencePath]) {
    assert.match(await brokerRequest(broker, { ...rpc, pathname }), /^HTTP\/1[.]1 403/, pathname);
  }
  assert.deepEqual(forwarded, []);

  assert.match(await brokerRequest(broker, rpc), /^HTTP\/1[.]1 200/);
  assert.equal(forwarded.length, 1);
  const [request] = forwarded;
  assert.equal(request.hostname, play);
  assert.equal(request.servername, play);
  assert.equal(request.headers.host, play);
  assert.equal(request.port, 443);
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/log');
  assert.equal(request.rejectUnauthorized, true);
  assert.deepEqual(request.ca, tls.rootCertificates);
  assert.equal(request.agent, false);

  redirect = true;
  const deniedRedirect = await brokerRequest(broker, rpc);
  assert.match(deniedRedirect, /^HTTP\/1[.]1 502/);
  assert.doesNotMatch(deniedRedirect, /example[.]test|location:/i);
  assert.equal(forwarded.length, 2);
  assert.ok(broker.events.some((event) => event.origin === play && event.path === '/log' &&
    event.status === 502 && event.upstreamStatus === 302 && event.reason === 'upstream redirect denied'));
});

test('Google broker forwards only the exact authenticated bodyless metadata GETs', async (t) => {
  const forwarded = [];
  const broker = await agyGoogleBroker(temp(t), {
    requestUpstream(options, callback) {
      const dispatch = { ...options, body: null };
      forwarded.push(dispatch);
      const request = new PassThrough();
      const parts = [];
      request.on('data', (part) => parts.push(part));
      request.on('end', () => {
        dispatch.body = Buffer.concat(parts).toString();
        const response = Readable.from([]);
        response.statusCode = 200;
        response.headers = {};
        callback(response);
      });
      return request;
    },
  });
  t.after(() => broker.close());
  const approved = [
    ['www.googleapis.com', '/oauth2/v2/userinfo'],
    ['aicode.googleapis.com', '/v1alpha:fetchConfig'],
  ];
  for (const [authority, pathname] of approved) {
    const rpc = { authority, hostname: authority, host: authority, pathname, method: 'GET' };
    assert.equal((await connectBroker(broker, `${authority}:443`, false)).status, '403');
    assert.equal((await connectBroker(broker, `${authority}:444`)).status, '403');
    assert.equal((await connectBroker(broker, `${authority}.example.test:443`)).status, '403');
    await assert.rejects(brokerRequest(broker, { ...rpc, hostname: origin }));
    for (const variant of [
      { host: origin }, { extra: `Host: ${authority}\r\n` },
      { pathname: pathname + '?fixture=1' }, { method: 'POST' }, { method: 'HEAD' },
      { framing: 'Content-Length: 1\r\n', body: 'x' },
      { framing: 'Content-Length: 00\r\n' },
      { framing: 'Transfer-Encoding: chunked\r\n', body: '1\r\nx\r\n0\r\n\r\n' },
      { framing: 'Transfer-Encoding: chunked\r\n', body: '0\r\n\r\n' },
      { extra: 'X-HTTP-Method-Override: POST\r\n' },
      { extra: 'X-HttpMethodOverride: POST\r\n' },
      { extra: 'X-HTTP-Method: POST\r\n' },
      { extra: 'X-Method-Override: POST\r\n' },
      { extra: 'X-Override-Method: POST\r\n' },
      { extra: 'X-Original-Method: POST\r\n' },
    ]) assert.match(await brokerRequest(broker, { ...rpc, ...variant }), /^HTTP\/1[.]1 403/);
  }
  assert.deepEqual(forwarded, []);

  for (const [index, [authority, pathname]] of approved.entries()) {
    const rpc = { authority, hostname: authority, host: authority, pathname, method: 'GET' };
    assert.match(await brokerRequest(broker, { ...rpc, ...(index === 0 && { framing: '' }) }), /^HTTP\/1[.]1 200/);
    assert.equal(forwarded.length, index + 1);
    const request = forwarded[index];
    assert.equal(request.hostname, authority);
    assert.equal(request.servername, authority);
    assert.equal(request.headers.host, authority);
    assert.equal(request.path, pathname);
    assert.equal(request.method, 'GET');
    assert.equal(request.body, '');
    assert.equal(request.rejectUnauthorized, true);
    assert.deepEqual(request.ca, tls.rootCertificates);
  }
});

function listen(t, options) {
  const server = net.createServer((socket) => socket.end());
  t.after(() => server.close());
  return new Promise((resolve, reject) => server.listen(options, () => resolve(server)).once('error', reject));
}

function execute(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('Mac builder wall confines child file and network access', { skip: process.platform !== 'darwin' }, async (t) => {
  const root = temp(t, ['source', 'runtime', 'ca', 'home', 'other']);
  const [source, runtime, certificateDir, home, other] = ['source', 'runtime', 'ca', 'home', 'other'].map((name) => path.join(root, name));
  const outside = path.join(other, '.env.fixture');
  const alias = '/System/Volumes/Data' + outside;
  fs.mkdirSync(path.join(home, 'Library', 'Keychains'), { recursive: true });
  fs.writeFileSync(outside, 'outside fixture');
  assert.equal(fs.readFileSync(alias, 'utf8'), 'outside fixture');
  fs.symlinkSync(outside, path.join(source, 'linked'));
  fs.writeFileSync(path.join(source, 'source.txt'), 'workspace fixture');
  const otherTcp = await listen(t, { host: '127.0.0.1', port: 0 });
  const otherTcp6 = await listen(t, { host: '::1', port: 0 });
  const unix = path.join(root, 'ipc');
  const unixServer = await listen(t, unix);
  assert.equal(unixServer.address(), unix);

  const broker = await agyGoogleBroker(certificateDir);
  t.after(() => broker.close());
  const bin = path.join(root, 'fixture-node');
  fs.copyFileSync(process.execPath, bin, fs.constants.COPYFILE_FICLONE);
  fs.chmodSync(bin, 0o500);
  const privateHome = path.join(runtime, 'home');
  const config = path.join(privateHome, '.gemini', 'config');
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(path.join(runtime, 'tmp'));
  fs.writeFileSync(path.join(config, 'hooks.json'), 'fixture');
  const library = path.join(privateHome, 'Library');
  fs.mkdirSync(library);
  fs.symlinkSync(path.join(home, 'Library', 'Keychains'), path.join(library, 'Keychains'));
  fs.writeFileSync(path.join(home, 'Library', 'Keychains', 'other.keychain-db'), 'canary');
  const env = agyBuildEnv({ home: privateHome, runtime, broker });
  const params = { home, runtime, source, bin, certificate: broker.certificate, port: broker.port };
  const command = `
    const fs = require('node:fs');
    const net = require('node:net');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const [outside, alias, otherTcp, otherTcp6, unix, broker, home, certificate] = process.argv.slice(1);
    const observe = (operation) => {
      try { return [true, operation()]; } catch (error) { return [false, error.code]; }
    };
    const connect = (...args) => new Promise((resolve) => {
      const socket = net.connect(...args).setTimeout(1500, () => socket.destroy());
      socket.once('connect', () => { resolve(true); socket.destroy(); });
      socket.once('error', (error) => resolve(error.code));
      socket.once('close', () => resolve(false));
    });
    (async () => {
      const startListener = (host) => new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', (error) => resolve(error.code));
        server.listen(0, host, () => server.close(() => resolve(true)));
      });
      const keychains = path.join(home, 'Library', 'Keychains');
      const observations = {
        readSource: observe(() => fs.readFileSync('source.txt', 'utf8')),
        writeSource: observe(() => fs.writeFileSync('source.txt', 'inside edit')),
        writeRuntime: observe(() => fs.writeFileSync(path.join(process.env.TMPDIR, 'log'), 'runtime log')),
        readOutside: observe(() => fs.readFileSync(outside, 'utf8')),
        readAlias: observe(() => fs.readFileSync(alias, 'utf8')),
        writeOutside: observe(() => fs.writeFileSync(outside, 'escaped')),
        readLink: observe(() => fs.readFileSync('linked', 'utf8')),
        writeLink: observe(() => fs.writeFileSync('linked', 'escaped')),
        hardlinkOutside: observe(() => fs.linkSync(outside, 'hardlink')),
        renameOutside: observe(() => fs.renameSync('source.txt', outside)),
        dotGit: observe(() => fs.mkdirSync('.git')),
        caseGit: observe(() => fs.mkdirSync('.GiT')),
        caseEnv: observe(() => fs.writeFileSync('.EnV.Fixture', 'fixture')),
        agentPolicy: observe(() => fs.writeFileSync('AGENTS.md', 'policy')),
        openFallback: observe(() => fs.writeFileSync(path.join(process.env.TMPDIR, 'antigravity-oauth-token'), 'fixture')),
        writeLock: observe(() => fs.writeFileSync(path.join(keychains, '.flABCDEF12'), 'lock')),
        publishKeychainCopy: observe(() => {
          const copy = path.join(keychains, 'login.keychain-db.sb-8ea883a1-WYOv2i');
          fs.writeFileSync(copy, 'fixture data');
          fs.renameSync(copy, path.join(keychains, 'login.keychain-db'));
        }),
        editConfig: observe(() => fs.writeFileSync(path.join(process.env.HOME, '.gemini', 'config', 'hooks.json'), 'unsafe')),
        writeCert: observe(() => fs.writeFileSync(certificate, 'unsafe')),
        writePin: observe(() => fs.chmodSync(process.execPath, 0o777)),
        dependency: observe(() => fs.mkdirSync('node_modules')),
        readOtherKeychainAlias: observe(() => fs.readFileSync(path.join(process.env.HOME, 'Library', 'Keychains', 'other.keychain-db'))),
        writeOtherKeychainAlias: observe(() => fs.writeFileSync(path.join(process.env.HOME, 'Library', 'Keychains', 'other.keychain-db'), 'forbidden')),
        replaceKeychainAlias: observe(() => fs.unlinkSync(path.join(process.env.HOME, 'Library', 'Keychains'))),
        writeOtherKeychain: observe(() => fs.writeFileSync(path.join(keychains, 'other.keychain-db'), 'forbidden')),
        boundLoopback: await startListener('127.0.0.1'),
        descendantRead: spawnSync(process.execPath, ['-e',
          'try { require("node:fs").readFileSync(process.argv[1]); } catch (e) { console.log(e.code); }', outside],
          { encoding: 'utf8' }).stdout?.trim(),
        runShell: spawnSync('/bin/sh', ['-c', 'printf unsafe']).error?.code,
        otherIpv4: await connect(Number(otherTcp), '127.0.0.1'),
        otherIpv6: await connect(Number(otherTcp6), '::1'),
        unix: await connect(unix),
        direct: await connect(443, '192.0.2.1'),
        broker: await connect(Number(broker), '127.0.0.1'),
        extraEnv: ['GOOGLE_APPLICATION_CREDENTIALS', 'OPENAI_API_KEY', 'GIT_DIR', 'SSH_AUTH_SOCK', 'NO_PROXY']
          .filter((key) => key in process.env),
      };
      process.stdout.write(JSON.stringify(observations));
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const result = await execute(agyBuildWall(params, [bin, '-e', command, outside, alias,
    String(otherTcp.address().port), String(otherTcp6.address().port), unix, String(broker.port), home, broker.certificate]), source, env);
  assert.equal(result.code, 0, result.stderr);
  const seen = JSON.parse(result.stdout);
  assert.deepEqual(seen.readSource, [true, 'workspace fixture']);
  assert.equal(seen.writeSource[0], true);
  assert.equal(seen.writeRuntime[0], true);
  for (const name of ['readOutside', 'readAlias', 'writeOutside', 'readLink', 'writeLink', 'hardlinkOutside',
    'renameOutside', 'dotGit', 'caseGit', 'caseEnv', 'agentPolicy', 'openFallback', 'dependency',
    'editConfig', 'writeCert', 'writePin', 'writeOtherKeychain', 'readOtherKeychainAlias',
    'writeOtherKeychainAlias', 'replaceKeychainAlias']) {
    assert.deepEqual(seen[name], [false, 'EPERM'], name);
  }
  for (const name of ['otherIpv4', 'otherIpv6', 'unix', 'direct', 'runShell', 'descendantRead']) assert.equal(seen[name], 'EPERM', name);
  assert.equal(seen.broker, true);
  assert.equal(seen.boundLoopback, true);
  assert.equal(seen.writeLock[0], true);
  assert.equal(seen.publishKeychainCopy[0], true);
  assert.equal(fs.readFileSync(path.join(home, 'Library/Keychains/login.keychain-db'), 'utf8'), 'fixture data');
  assert.equal(fs.readFileSync(path.join(home, 'Library/Keychains/other.keychain-db'), 'utf8'), 'canary');
  assert.deepEqual(seen.extraEnv, []);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside fixture');
  assert.equal(fs.readFileSync(path.join(source, 'source.txt'), 'utf8'), 'inside edit');
  assert.ok(!fs.existsSync(path.join(runtime, 'antigravity-oauth-token')));
});
