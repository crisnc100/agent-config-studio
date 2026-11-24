import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { prepareNeonGrade } from './neon-grade.mjs';

const COMMAND = 'bun ./canary.mjs';
const ICU = '/usr/share/icu/icudt76l.dat';
const CHILD = String.raw`
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

const STATUS = new Set(['error', 'threw', 'timeout', 'closed', 'connected', 'read']);
const SYSCALL = new Set(['connect', 'connectx', 'socket', 'open', 'openat', 'read', 'stat', 'lstat']);
const safeCode = (code) => typeof code === 'string' && /^E[A-Z0-9_]{1,35}$/.test(code) ? code : null;

function project(value, accepted) {
  const picked = (row) => ({
    status: STATUS.has(row?.status) ? row.status : 'unknown',
    code: safeCode(row?.code),
    errno: Number.isInteger(row?.errno) && Math.abs(row.errno) < 8192 ? row.errno : safeCode(row?.errno),
    syscall: SYSCALL.has(row?.syscall) ? row.syscall : null,
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

function listen(servers, endpoint, accepted) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      accepted();
      client.destroy();
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
  try {
    const parent = fs.realpathSync(root);
    const dirs = { case: path.join(parent, 'case'), repo: path.join(parent, 'case', 'repo') };
    fs.mkdirSync(dirs.repo, { recursive: true, mode: 0o700 });
    const file = path.join(parent, 'outside.txt');
    fs.writeFileSync(file, 'harmless canary');
    socketDir = fs.mkdtempSync('/private/tmp/bcc-');
    const accepts = { unix: 0, tcp: 0 };
    const unix = await listen(servers, path.join(socketDir, 'endpoint.sock'), () => { accepts.unix++; });
    const tcp = await listen(servers, { host: '127.0.0.1', port: 0 }, () => { accepts.tcp++; });
    fs.writeFileSync(path.join(dirs.repo, 'targets.json'), JSON.stringify({ unix, tcp: { host: tcp.address, port: tcp.port }, file }));
    fs.writeFileSync(path.join(dirs.repo, 'canary.mjs'), CHILD);

    const worker = prepareNeonGrade(COMMAND, dirs);
    const baseline = worker.invocation(COMMAND);
    const [mode, profile, cmd, ...args] = baseline.args;
    if (mode !== '-p' || cmd !== '/bin/sh' || args.length !== 2 || args[0] !== '-c' || args[1] !== COMMAND) {
      return { status: 'unexpected-sandbox-invocation' };
    }
    const icuProfile = `${profile}\n(allow file-read-metadata (literal "${ICU}"))\n(allow file-read-data (literal "${ICU}"))`;
    const trials = [
      ['positive-private-env', { cmd, args, env: baseline.env }],
      ['unchanged', baseline],
      ['icu-metadata-and-data', { ...baseline, args: [mode, icuProfile, cmd, ...args] }],
    ];
    const rows = [];
    for (const [arm, invocation] of trials) {
      const before = { ...accepts };
      const { exitCode, exitSignal, stdout } = await launch(invocation, dirs.repo, controller.signal);
      await nextTurn();
      const accepted = { unix: accepts.unix > before.unix, tcp: accepts.tcp > before.tcp };
      let value;
      try { value = JSON.parse(stdout); } catch { /* project unknown without emitting raw text */ }
      rows.push({ arm, exitCode, exitSignal, ...project(value, accepted) });
    }
    const [positive] = rows;
    const healthy = positive.exitCode === 0 && positive.file.status === 'read'
      && [positive.unix, positive.tcp].every((probe) => probe.connected === true && probe.parentAccepted);
    return { status: healthy ? 'observed' : 'positive-control-failed', rows };
  } catch {
    return { status: controller.signal.aborted ? 'interrupted' : 'diagnostic-failed' };
  } finally {
    try { await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))); }
    finally {
      if (socketDir) fs.rmSync(socketDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
      for (const event of signals) process.removeListener(event, cancel);
    }
  }
}

function selfTest() {
  const value = project({
    file: { status: 'error', code: 'EPERM', errno: -1, syscall: 'open' },
    unix: { status: 'error', code: 'ECONNREFUSED', errno: -61, syscall: 'connect', connected: false, message: '/private/omit' },
    tcp: { status: 'timeout', code: '/private/omit', errno: '/private/omit', syscall: '/private/omit', connected: false },
  }, { unix: false, tcp: false });
  assert.deepEqual(value.file, { status: 'error', code: 'EPERM', errno: -1, syscall: 'open' });
  assert.deepEqual(value.unix, { status: 'error', code: 'ECONNREFUSED', errno: -61, syscall: 'connect', connected: false, parentAccepted: false });
  assert.deepEqual(value.tcp, { status: 'timeout', code: null, errno: null, syscall: null, connected: false, parentAccepted: false });
  assert.equal(project(null, { unix: false, tcp: false }).unix.connected, null);
  assert.deepEqual(project({ tcp: { status: 'connected', connected: true } }, { unix: false, tcp: true }).tcp,
    { status: 'connected', code: null, errno: null, syscall: null, connected: true, parentAccepted: true });
  assert.equal(JSON.stringify(value).includes('/private'), false);
  console.log('{"status":"self-test-passed"}');
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--self-test') {
  selfTest();
} else if (args.length === 1 && args[0] === '--observe-canaries-only') {
  const result = await run().catch(() => ({ status: 'cleanup-failed' }));
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'observed') process.exitCode = 2;
} else {
  console.log('usage: node bun-canary-controls.mjs [--self-test | --observe-canaries-only]');
  if (args.length) process.exitCode = 2;
}
