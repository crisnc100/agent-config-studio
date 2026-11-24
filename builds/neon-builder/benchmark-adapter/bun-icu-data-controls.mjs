import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { prepareNeonGrade } from './neon-grade.mjs';
import { checkoutAt, loadCases, testCounts } from './run.mjs';

const CASE = 'airflo-staff-mail-skip';
const REF = 'b46966fc3143ba0a7a0bce3160e30be4f6a15cd4';
const TEST = 'cd apps/dealer-portal && bun test lib/orders/intake/m365/skip-rules.test.ts lib/orders/intake/m365/ingest.test.ts';
const SETUP = 'bun install --frozen-lockfile';
const EXPECTED_PASSES = 61;

const ICU_PATH = '/usr/share/icu/icudt76l.dat';
const ICU = { id: 'icu-metadata', op: 'file-read-metadata', type: 'literal', value: ICU_PATH };
const ICU_DATA = { ...ICU, id: 'icu-data', op: 'file-read-data' };
const CANARY = String.raw`
import fs from 'node:fs';
import net from 'node:net';
const endpoints = JSON.parse(fs.readFileSync(new URL('./canaries.json', import.meta.url), 'utf8'));
const attempt = (options) => new Promise((resolve) => {
  const socket = net.connect(options);
  socket.setTimeout(2000, () => socket.destroy(Object.assign(new Error(), { code: 'ETIMEDOUT' })));
  socket.on('error', (e) => resolve(e.code));
  socket.on('connect', () => { socket.destroy(); resolve('CONNECTED'); });
});
let file;
try { fs.readFileSync(endpoints.file); file = 'READ'; } catch (e) { file = e.code; }
const unix = await attempt({ path: endpoints.unix });
const tcp = await attempt(endpoints.tcp);
console.log(JSON.stringify({ file, unix, tcp }));
`;

function withGrants(invocation, grants) {
  const [mode, profile, ...exec] = invocation.args;
  if (mode !== '-p' || typeof profile !== 'string') throw new Error('unexpected sandbox invocation');
  const rules = grants.map(({ op, type, value }) => `(allow ${op} (${type} ${JSON.stringify(value)}))`);
  return { ...invocation, args: [mode, [profile, ...rules].join('\n'), ...exec] };
}

function project(allowance, result) {
  return { allowance, exitCode: result.code, exitSignal: result.signal, ...(testCounts(result.output) ?? { passed: null, failed: null, errors: null }) };
}

function good(result) {
  return result.exitCode === 0 && result.passed === EXPECTED_PASSES && result.failed === 0 && result.errors === 0;
}

function launch({ cmd, args, env }, cwd, signal, timeout, capture) {
  signal.throwIfAborted();
  return new Promise((resolve) => {
    const stdio = capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'];
    const child = spawn('/usr/sbin/taskpolicy', ['-b', cmd, ...args], { cwd, env, stdio, detached: true });
    const kill = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } };
    const timer = setTimeout(kill, timeout);
    signal.addEventListener('abort', kill, { once: true });
    const streams = { stdout: [], stderr: [] };
    let outputBytes = 0;
    for (const [key, chunks] of Object.entries(streams)) {
      child[key]?.on('data', (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > 262_144) kill();
        else chunks.push(chunk);
      });
    }
    child.on('error', kill);
    child.once('close', (code, exitSignal) => {
      kill();
      signal.removeEventListener('abort', kill);
      clearTimeout(timer);
      const stdout = Buffer.concat(streams.stdout).toString('utf8');
      const stderr = Buffer.concat(streams.stderr).toString('utf8');
      resolve({ code, signal: exitSignal, stdout, stderr, output: `${stdout}\n${stderr}` });
    });
  });
}

function listen(openServers, location) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((connection) => connection.destroy());
    openServers.push(server);
    server.once('error', reject);
    server.listen(location, () => resolve(server.address()));
  });
}

function controls(result) {
  if (result.code !== 0) return { status: 'failed' };
  try {
    const observed = JSON.parse(result.stdout);
    const clean = Object.fromEntries(['file', 'unix', 'tcp'].map((kind) => [kind, observed[kind] === 'EPERM' ? 'EPERM' : 'not-EPERM']));
    return { status: Object.values(clean).every((value) => value === 'EPERM') ? 'denied' : 'failed', ...clean };
  } catch { return { status: 'failed' }; }
}

const safePass = (row) => good(row) && row.controls?.status === 'denied';

async function compare(run) {
  const baseline = await run('baseline', []);
  if (baseline.exitCode !== 133) return { status: 'inconclusive' };
  const pair = await run('icu-metadata-and-data', [ICU, ICU_DATA]);
  if (!safePass(pair)) return { status: good(pair) ? 'control-failed' : 'inconclusive' };

  const withoutMetadata = await run('withdraw-metadata', [ICU_DATA]);
  let candidate = [ICU_DATA];
  if (!safePass(withoutMetadata)) {
    if (withoutMetadata.exitCode !== 133) return { status: good(withoutMetadata) ? 'control-failed' : 'inconclusive' };
    const withoutData = await run('withdraw-data', [ICU]);
    if (withoutData.exitCode !== 133) return { status: good(withoutData) && !safePass(withoutData) ? 'control-failed' : 'inconclusive' };
    candidate = [ICU, ICU_DATA];
  }

  const withdrawn = await run('withdraw-selected', []);
  if (withdrawn.exitCode !== 133) return { status: 'inconclusive' };
  const restored = await run('restore-selected', candidate);
  if (!safePass(restored)) return { status: good(restored) ? 'control-failed' : 'inconclusive' };
  return { status: 'reproduced-minimal-tested-set', grants: candidate.map(({ id }) => id) };
}

async function runExperiment(casesDir) {
  if (process.platform !== 'darwin') return { status: 'unsupported-platform' };
  let root;
  let socketDir;
  let stage = 'case';
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () => controller.abort();
  const events = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const event of events) process.on(event, cancel);
  const servers = [];
  try {
    const { cases, remotes } = loadCases(casesDir, ['builder'], new Set([CASE]));
    const c = cases[0];
    if (cases.length !== 1 || c.id !== CASE || c.project !== 'airflo' || c.refSha !== REF
        || c.testCommand !== TEST || c.setup?.length !== 1 || c.setup[0] !== SETUP) return { status: 'unexpected-reference' };

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bun-icu-data-'));
    const dirs = { case: path.join(root, 'case'), repo: path.join(root, 'case', 'repo') };
    stage = 'checkout';
    const checked = await checkoutAt(c, REF, dirs.repo, remotes, { depth: 1 });
    if (checked.error) return { status: 'setup-failed', stage };
    signal.throwIfAborted();
    const worker = prepareNeonGrade(c.testCommand, dirs);
    stage = 'dependencies';
    const setup = await launch({
      cmd: '/bin/sh',
      args: ['-c', `${c.setup[0]} --backend copyfile --cache-dir "$BUN_INSTALL_CACHE_DIR"`],
      env: { ...process.env, ...worker.setupEnv },
    }, dirs.repo, signal, 20 * 60_000, false);
    if (setup.code !== 0) return { status: signal.aborted ? 'interrupted' : 'setup-failed', stage, exitCode: setup.code };

    stage = 'controls';
    socketDir = fs.mkdtempSync('/private/tmp/bid-');
    const file = path.join(fs.realpathSync(root), 'outside.txt');
    fs.writeFileSync(file, 'fixture');
    const unix = await listen(servers, path.join(socketDir, 'neighbor.sock'));
    const tcp = await listen(servers, { host: '127.0.0.1', port: 0 });
    const fixtures = path.join(dirs.repo, 'apps', 'dealer-portal', 'runtime-checks');
    fs.mkdirSync(fixtures);
    fs.writeFileSync(path.join(fixtures, 'canaries.json'), JSON.stringify({ file, unix, tcp: { host: tcp.address, port: tcp.port } }));
    fs.writeFileSync(path.join(fixtures, 'canaries.mjs'), CANARY);
    const canaryCommand = 'cd apps/dealer-portal && bun ./runtime-checks/canaries.mjs';

    stage = 'comparison';
    const results = [];
    const run = async (label, grants) => {
      const invocation = withGrants(worker.invocation(c.testCommand), grants);
      const result = await launch(invocation, dirs.repo, signal, 120_000, true);
      const row = { ...project(label, result), grants: grants.map(({ id }) => id) };
      if (good(row)) {
        const canary = withGrants(worker.invocation(canaryCommand), grants);
        row.controls = controls(await launch(canary, dirs.repo, signal, 30_000, true));
      }
      results.push(row);
      return row;
    };
    const verdict = await compare(run);
    return { ...verdict, evidence: 'admin-observed-data-denial', results };
  } catch {
    return { status: signal.aborted ? 'interrupted' : 'diagnostic-failed', stage };
  } finally {
    try {
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    } finally {
      try {
        if (socketDir) fs.rmSync(socketDir, { recursive: true, force: true });
        if (root) fs.rmSync(root, { recursive: true, force: true });
      } finally {
        for (const event of events) process.removeListener(event, cancel);
      }
    }
  }
}

async function selfTest() {
  const baseline = { cmd: '/usr/bin/sandbox-exec', args: ['-p', '(deny default)', '/bin/sh', '-c', TEST], env: {} };
  const arm = withGrants(baseline, [ICU, ICU_DATA]);
  assert.equal(arm.args[1], '(deny default)\n(allow file-read-metadata (literal "/usr/share/icu/icudt76l.dat"))\n(allow file-read-data (literal "/usr/share/icu/icudt76l.dat"))');
  assert.deepEqual(arm.args.slice(2), baseline.args.slice(2));
  assert.equal(arm.env, baseline.env);
  const trap = { exitCode: 133 };
  const pass = { exitCode: 0, passed: 61, failed: 0, errors: 0, controls: { status: 'denied' } };
  async function mock(dataOnly) {
    const seen = [];
    const outcome = await compare(async (label, grants) => {
      seen.push([label, grants.map(({ id }) => id)]);
      return grants.length === 2 || (dataOnly && grants.length === 1 && grants[0] === ICU_DATA) ? pass : trap;
    });
    return { outcome, seen };
  }
  const single = await mock(true);
  assert.deepEqual(single.outcome, { status: 'reproduced-minimal-tested-set', grants: ['icu-data'] });
  assert.deepEqual(single.seen.map(([label]) => label), ['baseline', 'icu-metadata-and-data', 'withdraw-metadata', 'withdraw-selected', 'restore-selected']);
  assert.deepEqual(single.seen.at(-1)[1], ['icu-data']);
  const pair = await mock(false);
  assert.deepEqual(pair.outcome, { status: 'reproduced-minimal-tested-set', grants: ['icu-metadata', 'icu-data'] });
  assert.deepEqual(pair.seen.map(([label]) => label), ['baseline', 'icu-metadata-and-data', 'withdraw-metadata', 'withdraw-data', 'withdraw-selected', 'restore-selected']);
  assert.deepEqual(await compare(async () => trap), { status: 'inconclusive' });
  assert.deepEqual(await compare(async (label) => label === 'baseline' ? trap : { ...pass, controls: { status: 'failed' } }), { status: 'control-failed' });
  assert.deepEqual(project('baseline', { code: 133, signal: null, output: 'private data' }),
    { allowance: 'baseline', exitCode: 133, exitSignal: null, passed: null, failed: null, errors: null });
  console.log('{"status":"self-test-passed"}');
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--self-test') {
  await selfTest();
} else if (args.length === 3 && args[0] === '--icu-data-observed' && args[1] === '--cases' && args[2] && !args[2].startsWith('--')) {
  const result = await runExperiment(path.resolve(args[2])).catch(() => ({ status: 'cleanup-failed' }));
  console.log(JSON.stringify(result, null, 2));
  if (!['reproduced-minimal-tested-set', 'inconclusive'].includes(result.status)) process.exitCode = 2;
} else {
  console.log('usage: node bun-icu-data-controls.mjs [--self-test | --icu-data-observed --cases <directory>]');
  if (args.length) process.exitCode = 2;
}
