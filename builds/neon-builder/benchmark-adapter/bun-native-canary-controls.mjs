import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { prepareNeonGrade } from './neon-grade.mjs';

const WRAPPER = 'bun ./wrapper.mjs';
const NATIVE = 'bun ./native.mjs';
const ICU = '/usr/share/icu/icudt76l.dat';
const WRAPPER_SOURCE = String.raw`
import fs from 'node:fs';
import net from 'node:net';
const targets = JSON.parse(fs.readFileSync(new URL('./targets.json', import.meta.url)));
const fault = (error, status = 'error') => ({
  status, code: error?.code ?? null, errno: error?.errno ?? null, syscall: error?.syscall ?? null, connected: false,
});
function connect(options) {
  return new Promise((resolve) => {
    let client, timer;
    const finish = (outcome) => {
      clearTimeout(timer);
      resolve(outcome);
      client?.destroy();
    };
    try { client = net.connect(options); }
    catch (error) { finish(fault(error, 'threw')); return; }
    timer = setTimeout(() => finish({ status: 'timeout', connected: false }), 2000);
    client.on('error', (error) => finish(fault(error)));
    client.once('close', () => finish({ status: 'closed', connected: false }));
    client.once('connect', () => finish({ status: 'connected', connected: true }));
  });
}
let file;
try { fs.readFileSync(targets.file); file = { status: 'read' }; }
catch (error) { file = fault(error); }
const unix = await connect({ path: targets.unix });
const tcp = await connect(targets.tcp);
console.log(JSON.stringify({ file, unix, tcp }));
`;

const NATIVE_SOURCE = String.raw`
import fs from 'node:fs';
const targets = JSON.parse(fs.readFileSync(new URL('./targets.json', import.meta.url), 'utf8'));
let file;
try { fs.readFileSync(targets.file); file = { status: 'read' }; }
catch (error) { file = { status: 'error', code: error.code, errno: error.errno, syscall: error.syscall }; }

let library;
try {
  const { dlopen, ptr, read } = await import('bun:ffi');
  library = dlopen('/usr/lib/libSystem.B.dylib', {
    socket: { args: ['i32', 'i32', 'i32'], returns: 'i32' },
    connect: { args: ['i32', 'ptr', 'u32'], returns: 'i32' },
    close: { args: ['i32'], returns: 'i32' },
    __error: { args: [], returns: 'ptr' },
  });
  const libc = library.symbols;
  const AF_UNIX = 1, AF_INET = 2, SOCK_STREAM = 1;
  const UNIX_PATH_SIZE = 104;
  const unixPath = new TextEncoder().encode(targets.unix);
  if (unixPath.length >= UNIX_PATH_SIZE) throw new Error('fixture socket path is too long');
  const sockaddrUn = new Uint8Array(2 + unixPath.length + 1);
  sockaddrUn[0] = sockaddrUn.length;
  sockaddrUn[1] = AF_UNIX;
  sockaddrUn.set(unixPath, 2);

  if (targets.tcp.host !== '127.0.0.1') throw new Error('unexpected fixture host');
  const sockaddrIn = new Uint8Array(16);
  sockaddrIn[0] = sockaddrIn.length;
  sockaddrIn[1] = AF_INET;
  new DataView(sockaddrIn.buffer).setUint16(2, targets.tcp.port, false);
  sockaddrIn.set([127, 0, 0, 1], 4);

  // Verify the same thread's errno is observable immediately after a failing connect.
  const checkpoint = libc.connect(-1, ptr(sockaddrUn), sockaddrUn.length);
  const sane = checkpoint === -1 && read.i32(libc.__error()) === 9;
  function nativeConnect(family, bytes) {
    const fd = libc.socket(family, SOCK_STREAM, 0);
    if (fd < 0) return { status: 'error', syscall: 'socket', returnCode: fd, errno: read.i32(libc.__error()), connected: false };
    try {
      const returnCode = libc.connect(fd, ptr(bytes), bytes.length);
      const errno = returnCode === -1 ? read.i32(libc.__error()) : null;
      return { status: returnCode === 0 ? 'connected' : 'error', syscall: 'connect', returnCode, errno, connected: returnCode === 0 };
    } finally { libc.close(fd); }
  }
  console.log(JSON.stringify({ file, nativeStatus: sane ? 'available' : 'errno-control-failed',
    ...(sane ? { unix: nativeConnect(AF_UNIX, sockaddrUn), tcp: nativeConnect(AF_INET, sockaddrIn) } : {}) }));
} catch {
  console.log(JSON.stringify({ file, nativeStatus: 'unavailable' }));
} finally { library?.close(); }
`;

const STATUS = new Set(['error', 'threw', 'timeout', 'closed', 'connected', 'read']);
const SYSCALL = new Set(['connect', 'connectx', 'socket', 'open', 'openat', 'read', 'stat', 'lstat']);
const safeCode = (code) => typeof code === 'string' && /^E[A-Z0-9_]{1,35}$/.test(code) ? code : null;

function project(value, accepted) {
  const picked = (row) => ({
    status: STATUS.has(row?.status) ? row.status : 'unknown',
    code: safeCode(row?.code),
    errno: Number.isInteger(row?.errno) && Math.abs(row.errno) < 8192 ? row.errno : safeCode(row?.errno),
    syscall: SYSCALL.has(row?.syscall) ? row.syscall : null,
    returnCode: row?.returnCode === -1 || row?.returnCode === 0 ? row.returnCode : null,
  });
  const socket = (kind) => ({
    ...picked(value?.[kind]),
    connected: typeof value?.[kind]?.connected === 'boolean' ? value[kind].connected : null,
    parentAccepted: accepted[kind],
  });
  return { file: picked(value?.file), unix: socket('unix'), tcp: socket('tcp') };
}

function launch({ cmd, args, env }, cwd, signal) {
  signal.throwIfAborted();
  return new Promise((resolve) => {
    const child = spawn('/usr/sbin/taskpolicy', ['-b', cmd, ...args], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const kill = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } };
    const timeout = setTimeout(kill, 10_000);
    signal.addEventListener('abort', kill, { once: true });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      if (stdout.length + chunk.length > 8192) kill();
      else stdout += chunk;
    });
    child.on('error', kill);
    child.once('close', (exitCode, exitSignal) => {
      kill();
      clearTimeout(timeout);
      signal.removeEventListener('abort', kill);
      resolve({ exitCode, exitSignal, stdout });
    });
  });
}

function listen(servers, connections, endpoint, accepted) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      accepted();
      connections.add(client);
      client.on('error', () => { /* the client may close immediately after connect */ });
      client.once('close', () => connections.delete(client));
    });
    servers.push(server);
    server.once('error', reject);
    server.listen(endpoint, () => resolve(server.address()));
  });
}

async function run() {
  if (process.platform !== 'darwin') return { status: 'unsupported-platform' };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bun-canary-controls-'));
  let socketDir;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const event of signals) process.on(event, cancel);
  const servers = [];
  const connections = new Set();
  try {
    const parent = fs.realpathSync(root);
    const dirs = { case: path.join(parent, 'case'), repo: path.join(parent, 'case', 'repo') };
    fs.mkdirSync(dirs.repo, { recursive: true, mode: 0o700 });
    const file = path.join(parent, 'outside.txt');
    fs.writeFileSync(file, 'harmless canary');
    socketDir = fs.mkdtempSync('/private/tmp/bcc-');
    const accepts = { unix: 0, tcp: 0 };
    const unix = await listen(servers, connections, path.join(socketDir, 'endpoint.sock'), () => { accepts.unix++; });
    const tcp = await listen(servers, connections, { host: '127.0.0.1', port: 0 }, () => { accepts.tcp++; });
    fs.writeFileSync(path.join(dirs.repo, 'targets.json'), JSON.stringify({ unix, tcp: { host: tcp.address, port: tcp.port }, file }));
    fs.writeFileSync(path.join(dirs.repo, 'wrapper.mjs'), WRAPPER_SOURCE);
    fs.writeFileSync(path.join(dirs.repo, 'native.mjs'), NATIVE_SOURCE);

    const worker = prepareNeonGrade(WRAPPER, dirs);
    const rows = [];
    for (const arm of ['positive-private-env', 'unchanged', 'icu-metadata-and-data']) {
      for (const [kind, command] of [['wrapper', WRAPPER], ['native', NATIVE]]) {
        const baseline = worker.invocation(command);
        const [mode, profile, cmd, ...args] = baseline.args;
        if (mode !== '-p' || cmd !== '/bin/sh' || args.length !== 2 || args[0] !== '-c' || args[1] !== command) {
          return { status: 'unexpected-sandbox-invocation' };
        }
        const icuProfile = `${profile}\n(allow file-read-metadata (literal "${ICU}"))\n(allow file-read-data (literal "${ICU}"))`;
        const invocation = arm === 'positive-private-env' ? { cmd, args, env: baseline.env } : arm === 'unchanged' ? baseline
          : { ...baseline, args: [mode, icuProfile, cmd, ...args] };
        const before = { ...accepts };
        const { exitCode, exitSignal, stdout } = await launch(invocation, dirs.repo, controller.signal);
        await nextTurn();
        const accepted = { unix: accepts.unix > before.unix, tcp: accepts.tcp > before.tcp };
        for (const socket of connections) socket.destroy();
        let value;
        try { value = JSON.parse(stdout); } catch { /* project unknown without emitting raw text */ }
        const nativeStatus = ['available', 'unavailable', 'errno-control-failed'].includes(value?.nativeStatus) ? value.nativeStatus : null;
        rows.push({ arm, kind, exitCode, exitSignal, ...(kind === 'native' && { nativeStatus }), ...project(value, accepted) });
      }
    }
    return { status: verdict(rows), rows };
  } catch {
    return { status: controller.signal.aborted ? 'interrupted' : 'diagnostic-failed' };
  } finally {
    for (const socket of connections) socket.destroy();
    try { await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))); }
    finally {
      if (socketDir) fs.rmSync(socketDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
      for (const event of signals) process.removeListener(event, cancel);
    }
  }
}

function verdict(rows) {
  const [wrapperPositive, nativePositive, , nativeBaseline, , nativeIcu] = rows;
  const native = [nativePositive, nativeBaseline, nativeIcu];
  if (native.some((row) => row.exitCode !== 0 || row.nativeStatus !== 'available')) return 'native-ffi-unavailable';
  const positive = [wrapperPositive, nativePositive];
  if (positive.some((row) => row.exitCode !== 0 || row.file.status !== 'read'
      || [row.unix, row.tcp].some((probe) => !probe.connected || !probe.parentAccepted))) return 'positive-control-failed';
  return [nativeBaseline, nativeIcu].every((row) => row.file.status === 'error' && row.file.code === 'EPERM'
    && [row.unix, row.tcp].every((probe) => probe.status === 'error' && probe.syscall === 'connect'
      && probe.returnCode === -1 && [1, 13].includes(probe.errno) && probe.connected === false && probe.parentAccepted === false))
    ? 'native-denials-observed' : 'native-denial-unconfirmed';
}

function selfTest() {
  const bad = project({ unix: { status: 'timeout', errno: '/private/omit', syscall: '/private/omit', connected: false } },
    { unix: false, tcp: false });
  assert.equal(bad.unix.status, 'timeout');
  assert.equal(bad.unix.errno, null);
  assert.equal(bad.unix.syscall, null);
  assert.equal(bad.tcp.connected, null);
  assert.equal(JSON.stringify(bad).includes('/private'), false);
  const socket = { status: 'connected', connected: true, parentAccepted: true };
  const positive = { exitCode: 0, nativeStatus: 'available', file: { status: 'read' }, unix: socket, tcp: socket };
  const denied = { status: 'error', syscall: 'connect', returnCode: -1, errno: 1, connected: false, parentAccepted: false };
  const expected = { exitCode: 0, nativeStatus: 'available', file: { status: 'error', code: 'EPERM' }, unix: denied, tcp: denied };
  const rows = [positive, positive, {}, expected, {}, expected];
  assert.equal(verdict(rows), 'native-denials-observed');
  assert.equal(verdict([positive, positive, {}, { ...expected, unix: { ...denied, errno: 2 } }, {}, expected]), 'native-denial-unconfirmed');
  assert.equal(verdict([positive, positive, {}, { ...expected, tcp: { ...denied, parentAccepted: true } }, {}, expected]), 'native-denial-unconfirmed');
  assert.equal(verdict([positive, positive, {}, { ...expected, unix: { ...denied, syscall: 'socket' } }, {}, expected]), 'native-denial-unconfirmed');
  assert.equal(verdict([positive, positive, {}, { ...expected, nativeStatus: null }, {}, expected]), 'native-ffi-unavailable');
  assert.equal(verdict([{ ...positive, unix: { ...socket, connected: false } }, positive, {}, expected, {}, expected]), 'positive-control-failed');
  console.log('{"status":"self-test-passed"}');
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--self-test') {
  selfTest();
} else if (args.length === 1 && args[0] === '--observe-native-canaries-only') {
  const result = await run().catch(() => ({ status: 'cleanup-failed' }));
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'native-denials-observed') process.exitCode = 2;
} else {
  console.log('usage: node bun-native-canary-controls.mjs [--self-test | --observe-native-canaries-only]');
  if (args.length) process.exitCode = 2;
}
