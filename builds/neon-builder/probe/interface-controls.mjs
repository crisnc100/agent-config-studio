import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const originalDeadlineMs = 400;
const operationDeadlineMs = 2000;
const runDeadlineMs = 45000;
const concurrency = 3;

export function candidates(interfaces = os.networkInterfaces()) {
  return Object.entries(interfaces).flatMap(([name, entries]) => (entries || [])
    .filter(({ internal, family }) => !internal && ['IPv4', 'IPv6'].includes(family))
    .map(({ address, family }) => {
      const linkLocalV6 = family === 'IPv6' && /^fe[89ab]/i.test(address);
      const linkLocal = linkLocalV6 || (family === 'IPv4' && address.startsWith('169.254.'));
      return {
        host: linkLocalV6 ? `${address}%${name}` : address,
        interfaceName: name, family, scope: linkLocal ? 'link-local' : 'non-loopback',
      };
    })).map((candidate, index) => ({ ...candidate, ordinal: index + 1 }));
}

function errno(code) {
  return typeof code === 'string' && /^E[A-Z0-9_]{2,31}$/.test(code) ? code : 'UNKNOWN';
}

function elapsed(started) {
  return Math.round(performance.now() - started);
}

function bounded(signal, run) {
  if (signal.aborted) return Promise.resolve({ status: 'aborted', durationMs: 0 });
  return new Promise((resolve) => {
    const started = performance.now();
    const finish = (status, extra = {}) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve({ status, durationMs: elapsed(started), ...extra });
    };
    const abort = () => finish('aborted');
    const timer = setTimeout(() => finish('timeout'), operationDeadlineMs);
    signal.addEventListener('abort', abort, { once: true });
    try { run(finish); } catch (error) { finish('error', { errno: errno(error.code) }); }
  });
}

async function withListener(host, port, signal, work) {
  if (!net.isIP(host)) return { bind: { status: 'error', errno: 'EINVAL', durationMs: 0 } };
  const accepted = new Set();
  const sockets = new Set();
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const source = peer(socket.remoteAddress, socket.remotePort);
    if (source) accepted.add(source);
    socket.pause();
  });
  try {
    const bind = await bounded(signal, (finish) => {
      server.on('error', (error) => finish('error', { errno: errno(error.code) }));
      server.listen({ host, port, ipv6Only: net.isIPv6(host), exclusive: true }, () => finish('listening'));
    });
    if (bind.status !== 'listening') return { bind };
    return { bind, value: await work({ port: server.address().port, accepted }) };
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

function peer(address, port) {
  return address && port ? address.split('%', 1)[0] + ':' + port : null;
}

export async function probe(host, port, signal, listener) {
  if (!net.isIP(host)) return { status: 'error', errno: 'EINVAL', durationMs: 0 };
  const socket = new net.Socket();
  let source;
  let result;
  try {
    result = await bounded(signal, (finish) => {
      socket.on('error', ({ code }) =>
        finish(code === 'ECONNREFUSED' ? 'refused' : 'error', { errno: errno(code) }));
      socket.once('connect', () => {
        source = peer(socket.localAddress, socket.localPort);
        finish('connected');
      });
      socket.connect({ host, port, family: net.isIP(host), autoSelectFamily: false });
    });
    if (listener && result.status === 'connected') {
      const end = performance.now() + 200;
      while (!listener.accepted.has(source) && !signal.aborted && performance.now() < end) await delay(10);
      result.accepted = source !== null && listener.accepted.has(source);
    }
  } finally {
    socket.destroy();
  }
  return result;
}

function conclusion(exactAccept, loopbackAccept, candidateToLoopback) {
  if (candidateToLoopback?.status === 'connected') return 'unexpected-candidate-connection';
  if (!(loopbackAccept?.status === 'connected' && loopbackAccept.accepted)) return 'loopback-control-unproven';
  if (!(exactAccept?.status === 'connected' && exactAccept.accepted)) return 'candidate-reachability-unproven';
  if (candidateToLoopback?.status !== 'refused') return 'candidate-refusal-unproven';
  return 'candidate-usable-and-refused';
}

async function diagnose({ host, ordinal, family, scope }, signal, listen = withListener, connect = probe) {
  const loopback = family === 'IPv6' ? '::1' : '127.0.0.1';
  const reservation = await listen(loopback, 0, signal, ({ port }) => port);
  const port = reservation.value;
  const identity = { ordinal, family, scope };
  if (!port) return { ...identity, reservation: reservation.bind, conclusion: 'same-port-control-unavailable' };

  const exact = await listen(host, port, signal, (listener) => connect(host, port, signal, listener));
  const loopbackOnly = await listen(loopback, port, signal, async (listener) => {
    const [loopbackAccept, candidateToLoopback] = await Promise.all([
      connect(loopback, port, signal, listener), connect(host, port, signal),
    ]);
    return { loopbackAccept, candidateToLoopback };
  });
  const { loopbackAccept, candidateToLoopback } = loopbackOnly.value ?? {};
  return {
    ...identity,
    reservation: reservation.bind,
    exactBind: exact.bind,
    exactAccept: exact.value,
    loopbackBind: loopbackOnly.bind,
    loopbackAccept,
    candidateToLoopback,
    conclusion: conclusion(exact.value, loopbackAccept, candidateToLoopback),
  };
}

export async function runControls(interfaces = candidates()) {
  const results = new Array(interfaces.length);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runDeadlineMs);
  const abort = () => controller.abort();
  const signals = ['SIGHUP', 'SIGINT', 'SIGTERM'];
  for (const signal of signals) process.on(signal, abort);
  try {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, interfaces.length) }, async () => {
      while (next < interfaces.length) {
        const index = next++;
        const { ordinal, family, scope } = interfaces[index];
        try {
          results[index] = await diagnose(interfaces[index], controller.signal);
        } catch {
          results[index] = { ordinal, family, scope, conclusion: 'diagnostic-error' };
        }
      }
    }));
    return {
      mode: 'local-controls',
      originalDeadlineMs,
      operationDeadlineMs,
      runDeadlineMs,
      aborted: controller.signal.aborted,
      results,
    };
  } finally {
    clearTimeout(timer);
    for (const signal of signals) process.off(signal, abort);
  }
}

async function selfTest() {
  const addresses = candidates({
    fixture0: [
      { address: '127.0.0.1', family: 'IPv4', internal: true },
      { address: '192.0.2.75', family: 'IPv4', internal: false },
      { address: 'fe80::d', family: 'IPv6', internal: false },
    ],
    fixture2: [{ address: '2001:db8::1', family: 'IPv6', internal: false }],
  });
  assert.deepEqual(addresses, [
    { host: '192.0.2.75', interfaceName: 'fixture0', ordinal: 1, family: 'IPv4', scope: 'non-loopback' },
    { host: 'fe80::d%fixture0', interfaceName: 'fixture0', ordinal: 2, family: 'IPv6', scope: 'link-local' },
    { host: '2001:db8::1', interfaceName: 'fixture2', ordinal: 3, family: 'IPv6', scope: 'non-loopback' },
  ]);
  const candidate = addresses[1];
  const port = 49375;
  const signal = new AbortController().signal;
  const listening = { status: 'listening', durationMs: 1 };
  const accepted = { status: 'connected', durationMs: 2, accepted: true };
  for (const [exact, loopback, negative, reason] of [
    [accepted, accepted, { status: 'refused', errno: 'ECONNREFUSED', durationMs: 560 }, 'candidate-usable-and-refused'],
    [accepted, accepted, { status: 'timeout', durationMs: 2000 }, 'candidate-refusal-unproven'],
    [{ status: 'timeout' }, accepted, { status: 'timeout' }, 'candidate-reachability-unproven'],
    [{ status: 'connected', accepted: false }, accepted, { status: 'refused' }, 'candidate-reachability-unproven'],
    [accepted, { status: 'error', errno: 'EADDRNOTAVAIL' }, { status: 'timeout' }, 'loopback-control-unproven'],
    [accepted, accepted, { status: 'connected' }, 'unexpected-candidate-connection'],
  ]) {
    const calls = [];
    const listen = async (host, requestedPort, _, work) => {
      calls.push([host, requestedPort]);
      return { bind: listening, value: await work({ port }) };
    };
    const connect = async (host, actualPort, _, listener) => {
      assert.equal(actualPort, port);
      if (!listener) {
        assert.equal(host, candidate.host);
        return negative;
      }
      return host === '::1' ? loopback : exact;
    };
    const result = await diagnose(candidate, signal, listen, connect);
    assert.equal(result.conclusion, reason);
    assert.deepEqual(calls, [['::1', 0], [candidate.host, port], ['::1', port]]);
    assert.ok(!JSON.stringify(result).includes(candidate.host));
    assert.ok(!JSON.stringify(result).includes(String(port)));
  }
  const bindFailure = { status: 'error', errno: 'EADDRNOTAVAIL', durationMs: 1 };
  const failure = await diagnose(candidate, signal, async (host, _, __, work) => host === candidate.host
    ? { bind: bindFailure } : { bind: listening, value: await work({ port }) },
  async (host) => host === '::1' ? accepted : { status: 'timeout' });
  assert.equal(failure.conclusion, 'candidate-reachability-unproven');
  assert.deepEqual(failure.exactBind, bindFailure);
  assert.equal(failure.candidateToLoopback.status, 'timeout');
  return { mode: 'fake-only', passed: true, networkCalls: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length) {
    process.stdout.write(JSON.stringify({ mode: 'disabled', networkCalls: 0 }) + '\n');
  } else if (args.length === 1 && args[0] === '--self-test') {
    process.stdout.write(JSON.stringify(await selfTest()) + '\n');
  } else if (args.length === 1 && args[0] === '--run') {
    process.stdout.write(JSON.stringify(await runControls(), null, 2) + '\n');
  } else {
    process.stderr.write('Usage: interface-controls.mjs --self-test | --run\n');
    process.exitCode = 2;
  }
}
