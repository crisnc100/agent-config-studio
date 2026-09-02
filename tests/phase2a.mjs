import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { createApp } from '../server.js';
import { detectHarnesses, HARNESSES } from '../lib/harness.js';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));

let failed = 0;
let passed = 0;

function ok(name) {
  passed++;
  console.log(`PASS  ${name}`);
}
function fail(name, err) {
  failed++;
  const msg = err && err.stack ? err.stack : String(err);
  console.error(`FAIL  ${name}\n  ${msg.replace(/\n/g, '\n  ')}`);
}
async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    fail(name, e);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
function is4xx(status) {
  return status >= 400 && status < 500;
}

function makeTemp(prefix) {
  const bases = [os.tmpdir(), path.join(ROOT, '.tmp')];
  let last;
  for (const b of bases) {
    try {
      fs.mkdirSync(b, { recursive: true });
      return fs.mkdtempSync(path.join(b, prefix));
    } catch (e) { last = e; }
  }
  throw last || new Error('cannot create temp dir');
}

function rmTemp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function fakeDetected(ids = ['claude', 'grok']) {
  return ids.map((id) => {
    const d = HARNESSES[id];
    if (!d) throw new Error(`no descriptor for ${id}`);
    return {
      id: d.id,
      label: d.label,
      models: Object.entries(d.models).map(([mid, m]) => ({ id: mid, label: m.label })),
      defaultModel: d.defaultModel,
      streams: d.streams,
    };
  });
}

function mockStreamTurn(handler) {
  const calls = [];
  const streamTurn = (opts, onDelta) => {
    calls.push(opts);
    const result = handler ? handler(opts, onDelta) : {
      text: 'ok', sessionId: 'sess-ok', code: 0, stats: null, rateLimit: null,
    };
    if (result && result.text && onDelta) onDelta(result.text);
    return {
      done: Promise.resolve(result),
      kill() {},
    };
  };
  return { streamTurn, calls };
}

const inprocessServers = new Map();
let fakePort = 1;
let warnedPerm = false;

function duplexPair() {
  let a;
  let b;
  a = new Duplex({
    read() {},
    write(chunk, _e, cb) { b.push(chunk); cb(); },
    final(cb) { b.push(null); cb(); },
  });
  b = new Duplex({
    read() {},
    write(chunk, _e, cb) { a.push(chunk); cb(); },
    final(cb) { a.push(null); cb(); },
  });
  for (const s of [a, b]) {
    s.setTimeout = () => s;
    s.setNoDelay = () => s;
    s.setKeepAlive = () => s;
    s.ref = () => s;
    s.unref = () => s;
    s.destroySoon = function destroySoon() { this.destroy(); };
    s.remoteAddress = '127.0.0.1';
    s.remotePort = 9;
    s.localAddress = '127.0.0.1';
    s.localPort = 0;
    s.bytesRead = 0;
    s.bytesWritten = 0;
    s.connecting = false;
    s.address = () => ({ address: '127.0.0.1', family: 'IPv4', port: 0 });
  }
  return { serverSide: a, clientSide: b };
}

function parseHttpResult(status, headers, text) {
  let json = null;
  try { json = JSON.parse(text); } catch { /* ndjson or plain */ }
  const events = [];
  const ct = (headers['content-type'] || headers.get?.('content-type') || '').toString();
  if (ct.includes('ndjson')) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      events.push(JSON.parse(line));
    }
  }
  return { status, text, json, events };
}

function httpJsonInprocess(server, method, pathname, body) {
  const { serverSide, clientSide } = duplexPair();
  server.emit('connection', serverSide);
  const payload = body !== undefined ? JSON.stringify(body) : null;
  const headers = { host: '127.0.0.1' };
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({
      method,
      path: pathname,
      headers,
      createConnection: () => {
        queueMicrotask(() => clientSide.emit('connect'));
        return clientSide;
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve(parseHttpResult(res.statusCode, res.headers, Buffer.concat(chunks).toString('utf8')));
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function listen(app) {
  try {
    const port = await new Promise((resolve, reject) => {
      const onErr = (e) => reject(e);
      app.server.once('error', onErr);
      app.server.listen(0, '127.0.0.1', () => {
        app.server.off('error', onErr);
        resolve(app.server.address().port);
      });
    });
    return {
      port,
      sessions: app.sessions,
      close() {
        return new Promise((resolve, reject) => {
          app.server.close((e) => e ? reject(e) : resolve());
        });
      },
    };
  } catch (e) {
    if (e.code !== 'EPERM') throw e;
    const port = 61000 + fakePort++;
    inprocessServers.set(port, app.server);
    if (!warnedPerm) {
      warnedPerm = true;
      console.log('    WARN  listen EPERM — driving real HTTP/1.1 in-process (ephemeral TCP bind is blocked here)');
    }
    return {
      port,
      sessions: app.sessions,
      close() {
        inprocessServers.delete(port);
        return Promise.resolve();
      },
    };
  }
}

async function httpJson(port, method, pathname, body) {
  const server = inprocessServers.get(port);
  if (server) return httpJsonInprocess(server, method, pathname, body);
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const headers = {};
  for (const [k, v] of res.headers) headers[k] = v;
  return parseHttpResult(res.status, headers, await res.text());
}

function pathWithoutBinary(origPath, name) {
  return (origPath || '').split(path.delimiter).filter((dir) => {
    if (!dir) return false;
    try { return !fs.existsSync(path.join(dir, name)); }
    catch { return true; }
  }).join(path.delimiter);
}

async function withHiddenGrok(fn) {
  const origHome = process.env.HOME;
  const origPath = process.env.PATH;
  const dir = makeTemp('acs-hide-grok-');
  process.env.HOME = dir;
  process.env.PATH = pathWithoutBinary(origPath, 'grok');
  try {
    return await fn();
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origPath === undefined) delete process.env.PATH;
    else process.env.PATH = origPath;
    rmTemp(dir);
  }
}

async function main() {
  console.log('phase2a — server harness routing, validation, session binding\n');

  await check('payload lists only currently detected harnesses', async () => {
    const live = await detectHarnesses();
    const { streamTurn } = mockStreamTurn();
    const srv = await listen(createApp({ streamTurn }));
    try {
      const r = await httpJson(srv.port, 'GET', '/api/registry');
      eq(r.status, 200, 'registry status');
      assert(Array.isArray(r.json?.harnesses), 'missing harnesses array');
      const got = r.json.harnesses.map((h) => h.id).sort();
      const want = live.map((h) => h.id).sort();
      eq(JSON.stringify(got), JSON.stringify(want), 'harness ids');
      for (const h of r.json.harnesses) {
        assert(Object.hasOwn(HARNESSES, h.id), `payload includes unknown id ${h.id}`);
        assert(live.some((d) => d.id === h.id), `payload includes undetected ${h.id}`);
        const desc = HARNESSES[h.id];
        const modelIds = (h.models || []).map((m) => m.id).sort();
        const descIds = Object.keys(desc.models).sort();
        eq(JSON.stringify(modelIds), JSON.stringify(descIds), `${h.id} models`);
        eq(h.defaultModel, desc.defaultModel, `${h.id} defaultModel`);
      }
      if (live.some((h) => h.id === 'claude')) eq(r.json.defaultHarness, 'claude', 'defaultHarness');
      assert(!r.json.harnesses.some((h) => h.id === 'codex') || live.some((d) => d.id === 'codex'),
        'codex appeared without being detected');
    } finally {
      await srv.close();
    }
  });

  await check('unknown harness is rejected on /api/chat and /api/assist', async () => {
    const { streamTurn, calls } = mockStreamTurn();
    const srv = await listen(createApp({
      streamTurn,
      detectHarnesses: async () => fakeDetected(),
    }));
    try {
      const chat = await httpJson(srv.port, 'POST', '/api/chat', {
        message: 'hi', harness: 'not-a-harness',
      });
      assert(is4xx(chat.status), `chat status ${chat.status}`);
      assert(/unknown harness/i.test(chat.json?.error || chat.text), chat.text);
      eq(calls.length, 0, 'unknown harness reached streamTurn');

      const assist = await httpJson(srv.port, 'POST', '/api/assist', {
        harness: 'not-a-harness', action: 'critique',
      });
      assert(is4xx(assist.status), `assist status ${assist.status}`);
      assert(/unknown harness/i.test(assist.json?.error || assist.text), assist.text);
    } finally {
      await srv.close();
    }
  });

  await check('undetected harness is rejected (PATH/HOME injection, binaries untouched)', async () => {
    const { streamTurn, calls } = mockStreamTurn();
    const srv = await listen(createApp({ streamTurn }));
    try {
      await withHiddenGrok(async () => {
        const now = await detectHarnesses();
        assert(!now.some((h) => h.id === 'grok'),
          `injection failed: grok still detected as ${now.find((h) => h.id === 'grok')?.binary}`);
        const chat = await httpJson(srv.port, 'POST', '/api/chat', {
          message: 'hi', harness: 'grok',
        });
        assert(is4xx(chat.status), `chat status ${chat.status}`);
        assert(/not detected|not installed/i.test(chat.json?.error || chat.text), chat.text);
        eq(calls.length, 0, 'undetected harness reached streamTurn');

        const assist = await httpJson(srv.port, 'POST', '/api/assist', { harness: 'grok' });
        assert(is4xx(assist.status), `assist status ${assist.status}`);

        const reg = await httpJson(srv.port, 'GET', '/api/registry');
        eq(reg.status, 200, 'registry status while grok hidden');
        assert(!(reg.json.harnesses || []).some((h) => h.id === 'grok'),
          'hidden grok still listed in payload');
      });
    } finally {
      await srv.close();
    }
  });

  await check('crossed harness/model pair is rejected', async () => {
    const { streamTurn, calls } = mockStreamTurn();
    const srv = await listen(createApp({
      streamTurn,
      detectHarnesses: async () => fakeDetected(),
    }));
    try {
      const chat = await httpJson(srv.port, 'POST', '/api/chat', {
        message: 'hi', harness: 'claude', model: 'grok-4.6',
      });
      assert(is4xx(chat.status), `chat status ${chat.status}`);
      assert(/model/i.test(chat.json?.error || chat.text), chat.text);
      eq(calls.length, 0, 'crossed pair reached streamTurn');

      const other = await httpJson(srv.port, 'POST', '/api/chat', {
        message: 'hi', harness: 'grok', model: 'claude-sonnet-5',
      });
      assert(is4xx(other.status), `reverse chat status ${other.status}`);

      const assist = await httpJson(srv.port, 'POST', '/api/assist', {
        harness: 'claude', model: 'grok-4.6', action: 'critique',
      });
      assert(is4xx(assist.status), `assist status ${assist.status}`);
    } finally {
      await srv.close();
    }
  });

  await check('__proto__ / constructor as harness id is rejected; no prototype pollution', async () => {
    const { streamTurn, calls } = mockStreamTurn();
    const srv = await listen(createApp({
      streamTurn,
      detectHarnesses: async () => fakeDetected(),
    }));
    try {
      const marker = 'acs-polluted-' + Date.now();
      const proto = await httpJson(srv.port, 'POST', '/api/chat', {
        message: 'hi', harness: '__proto__',
      });
      assert(is4xx(proto.status), `__proto__ status ${proto.status}`);
      assert(/unknown harness/i.test(proto.json?.error || proto.text), proto.text);

      const ctor = await httpJson(srv.port, 'POST', '/api/chat', {
        message: 'hi', harness: 'constructor',
      });
      assert(is4xx(ctor.status), `constructor status ${ctor.status}`);

      const assist = await httpJson(srv.port, 'POST', '/api/assist', { harness: '__proto__' });
      assert(is4xx(assist.status), `assist __proto__ status ${assist.status}`);

      eq(calls.length, 0, 'prototype-key harness reached streamTurn');
      assert(!Object.hasOwn(HARNESSES, '__proto__'), 'HARNESSES gained __proto__ own key');
      assert(!Object.hasOwn(HARNESSES, marker), 'HARNESSES gained a polluted key');
      assert(Object.prototype[marker] === undefined, 'Object.prototype was polluted');
      assert(({}).harness === undefined, 'object literal gained a harness property');
    } finally {
      await srv.close();
    }
  });

  await check('Claude session id sent with harness=grok is rejected', async () => {
    const { streamTurn, calls } = mockStreamTurn(() => ({
      text: 'hello', sessionId: 'claude-sess-1', code: 0, stats: null, rateLimit: null,
    }));
    const srv = await listen(createApp({
      streamTurn,
      detectHarnesses: async () => fakeDetected(),
    }));
    try {
      const first = await httpJson(srv.port, 'POST', '/api/chat', {
        message: 'hi', harness: 'claude',
      });
      eq(first.status, 200, 'seed turn');
      const done = first.events.find((e) => e.t === 'done');
      eq(done?.sessionId, 'claude-sess-1', 'seed session id');

      const mismatch = await httpJson(srv.port, 'POST', '/api/chat', {
        message: 'hi', harness: 'grok', sessionId: 'claude-sess-1',
      });
      assert(is4xx(mismatch.status), `mismatch status ${mismatch.status}`);
      assert(/session/i.test(mismatch.json?.error || mismatch.text), mismatch.text);
      assert(calls.every((c) => c.harness !== 'grok'), 'mismatched session reached grok streamTurn');

      const resume = await httpJson(srv.port, 'POST', '/api/chat', {
        message: 'again', harness: 'claude', sessionId: 'claude-sess-1',
      });
      eq(resume.status, 200, 'same-harness resume');
      const last = calls[calls.length - 1];
      eq(last.sessionId, 'claude-sess-1', 'same-harness session not forwarded');
      eq(last.harness, 'claude', 'resume harness');
    } finally {
      await srv.close();
    }
  });

  await check('a failed turn does not persist a session id', async () => {
    const results = [
      { text: '', sessionId: 'fail-exit', code: 1 },
      { text: 'error text', sessionId: 'fail-err', code: 0, err: 'is_error' },
      { text: '   ', sessionId: 'fail-empty', code: 0 },
    ];
    let n = 0;
    const { streamTurn, calls } = mockStreamTurn((opts) => {
      if (opts.harness === 'claude') return results[n++];
      return { text: 'grok-ok', sessionId: 'grok-new', code: 0 };
    });
    const srv = await listen(createApp({
      streamTurn,
      detectHarnesses: async () => fakeDetected(),
    }));
    try {
      for (const fail of results) {
        const turn = await httpJson(srv.port, 'POST', '/api/chat', {
          message: 'hi', harness: 'claude',
        });
        eq(turn.status, 200, `failed turn http ${fail.sessionId}`);
        const grok = await httpJson(srv.port, 'POST', '/api/chat', {
          message: 'hi', harness: 'grok', sessionId: fail.sessionId,
        });
        assert(!is4xx(grok.status) || !/session/i.test(grok.json?.error || ''),
          `failed session ${fail.sessionId} was bound: ${grok.text}`);
        eq(grok.status, 200, `unknown failed id should start new, got ${grok.status} ${grok.text}`);
        const forwarded = calls.filter((c) => c.harness === 'grok' && c.sessionId === fail.sessionId);
        eq(forwarded.length, 0, `failed id ${fail.sessionId} was resumed on grok`);
      }
    } finally {
      await srv.close();
    }
  });

  await check('unknown session id is treated as a new session, not resumed blind', async () => {
    const { streamTurn, calls } = mockStreamTurn(() => ({
      text: 'fresh', sessionId: 'new-sess', code: 0,
    }));
    const srv = await listen(createApp({
      streamTurn,
      detectHarnesses: async () => fakeDetected(),
    }));
    try {
      const r = await httpJson(srv.port, 'POST', '/api/chat', {
        message: 'hi', harness: 'grok', sessionId: 'never-seen-id',
      });
      eq(r.status, 200, 'unknown session http');
      eq(calls.length, 1, 'call count');
      eq(calls[0].sessionId, null, 'unknown id must not be forwarded');
      eq(calls[0].harness, 'grok', 'harness');
    } finally {
      await srv.close();
    }
  });

  await check('absent harness defaults to claude', async () => {
    const { streamTurn, calls } = mockStreamTurn(() => ({
      text: 'ok', sessionId: 'c1', code: 0,
    }));
    const srv = await listen(createApp({
      streamTurn,
      detectHarnesses: async () => fakeDetected(['claude']),
    }));
    try {
      const r = await httpJson(srv.port, 'POST', '/api/chat', { message: 'hi' });
      eq(r.status, 200, 'default harness http');
      eq(calls[0].harness, 'claude', 'default harness');
      eq(calls[0].model, HARNESSES.claude.defaultModel, 'default model');
    } finally {
      await srv.close();
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
