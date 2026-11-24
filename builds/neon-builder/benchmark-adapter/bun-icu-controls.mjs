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
const RUNTIME = [
  ...['security.mac.lockdown_mode_state', 'kern.bootargs', 'kern.osvariant_status'].map((value) => ({
    id: value, op: 'sysctl-read', type: 'sysctl-name', value,
  })),
  ...['com.apple.logd', 'system.notification_center'].map((value) => ({
    id: value, op: 'mach-lookup', type: 'global-name', value,
  })),
];
const READ_TARGETS = [
  ...['/System/Cryptexes/OS', '/System/Cryptexes/App', '/var', '/etc'].map((value, index) => ({
    id: `recorded-metadata-${index + 1}`, op: 'file-read-metadata', type: 'literal', value,
  })),
  { id: 'dtracehelper-data', op: 'file-read-data', type: 'literal', value: '/dev/dtracehelper' },
];
const PROBES = {
  simple: `import { expect, test } from 'bun:test'; test('simple', () => { console.log('fixture-reached'); expect(1 + 1).toBe(2); console.log('fixture-completed'); });`,
  normalize: `console.log('fixture-reached'); if ('e\\u0301'.normalize('NFC') !== 'é') process.exit(2); console.log('fixture-completed');`,
  collator: `console.log('fixture-reached'); if (new Intl.Collator('en').compare('a', 'b') >= 0) process.exit(2); console.log('fixture-completed');`,
  unicodeProperty: `console.log('fixture-reached'); if (!/^\\p{L}$/u.test('é')) process.exit(2); console.log('fixture-completed');`,
};
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

function recordedAncestors(caseDir) {
  if (!caseDir.startsWith('/private/')) throw new Error('fixture is outside the private temporary tree');
  const grants = [];
  for (let dir = caseDir; dir !== '/'; dir = path.dirname(dir)) {
    grants.push({ id: `temp-ancestor-${grants.length + 1}`, op: 'file-read-data', type: 'literal', value: dir });
  }
  return grants;
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

function denialLabels(output, targets) {
  const labels = new Set();
  for (const line of output.split('\n')) {
    for (const { id, op, value } of targets) {
      const detail = line.split(`deny(1) ${op} `)[1]?.trim();
      if (detail === value || (op === 'mach-lookup' && detail === `global-name ${value}`)) labels.add(id);
    }
  }
  return [...labels];
}

async function denialEvidence(result, start, cwd, signal, targets) {
  const pid = result.stderr.match(/\b(\d+)\s+Trace\/BPT trap\b/)?.[1];
  if (!pid) return { log: 'pid-not-captured', denied: [] };
  const query = {
    cmd: '/usr/bin/log',
    args: ['show', '--start', `@${start}`, '--end', `@${Math.floor(Date.now() / 1000) + 1}`, '--style', 'compact', '--info',
      '--predicate', `eventMessage CONTAINS "Sandbox: bun(${pid})"`],
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
  };
  const log = await launch(query, cwd, signal, 15_000, true);
  if (log.code !== 0) return { log: 'query-failed', denied: [] };
  const denied = denialLabels(log.stdout, targets);
  return { log: denied.length ? 'matched' : 'no-matching-denials', denied };
}

function controls(result) {
  if (result.code !== 0) return { status: 'failed' };
  try {
    const observed = JSON.parse(result.stdout);
    const clean = Object.fromEntries(['file', 'unix', 'tcp'].map((kind) => [kind, observed[kind] === 'EPERM' ? 'EPERM' : 'not-EPERM']));
    return { status: Object.values(clean).every((value) => value === 'EPERM') ? 'denied' : 'failed', ...clean };
  } catch { return { status: 'failed' }; }
}

async function confirmRescue(candidate, baseline, run) {
  if (!good(candidate) || candidate.controls?.status !== 'denied' || baseline.exitCode !== 133) return 'inconclusive';
  const withdrawn = await run('withdraw-all', []);
  if (withdrawn.exitCode !== 133) return 'inconclusive';
  // Record the full denial group as a reproducible candidate before spending more runs bisecting it.
  let individualWithdrawalsTrap = candidate.proposed.length <= 7;
  if (individualWithdrawalsTrap && candidate.proposed.length > 1) {
    for (const grant of candidate.proposed) {
      const narrowed = candidate.proposed.filter((entry) => entry !== grant);
      const observation = await run(`withdraw-${grant.id}`, narrowed);
      if (observation.exitCode !== 133) individualWithdrawalsTrap = false;
    }
  }
  const restored = await run('restore-candidate', candidate.proposed);
  if (!good(restored) || restored.controls?.status !== 'denied') return 'inconclusive';
  return individualWithdrawalsTrap ? 'reproduced-rescue-with-withdrawals' : 'reproduced-rescue-needs-bisection';
}

async function runMatrix(casesDir) {
  if (process.platform !== 'darwin') return { status: 'unsupported-platform' };
  let root;
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

    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bun-icu-controls-')));
    const dirs = { case: path.join(root, 'case'), repo: path.join(root, 'case', 'repo') };
    stage = 'checkout';
    const co = await checkoutAt(c, REF, dirs.repo, remotes, { depth: 1 });
    if (co.error) return { status: 'setup-failed', stage };
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
    const tempDir = fs.mkdtempSync('/private/tmp/bic-');
    try {
      const hostFile = path.join(root, 'outside.txt');
      fs.writeFileSync(hostFile, 'fixture');
      const socket = await listen(servers, path.join(tempDir, 'neighbor.sock'));
      const tcp = await listen(servers, { host: '127.0.0.1', port: 0 });
      const fixtures = path.join(dirs.repo, 'apps', 'dealer-portal', 'runtime-checks');
      fs.mkdirSync(fixtures);
      fs.writeFileSync(path.join(fixtures, 'canaries.json'), JSON.stringify({ file: hostFile, unix: socket, tcp: { host: tcp.address, port: tcp.port } }));
      fs.writeFileSync(path.join(fixtures, 'canaries.mjs'), CANARY);
      const parent = 'cd apps/dealer-portal && ';
      const canaryCommand = `${parent}bun ./runtime-checks/canaries.mjs`;
      const probes = [];
      for (const [name, body] of Object.entries(PROBES)) {
        const file = name === 'simple' ? 'simple.test.mjs' : `${name}.mjs`;
        fs.writeFileSync(path.join(fixtures, file), body);
        const probe = worker.invocation(`${parent}bun ${name === 'simple' ? 'test ' : ''}./runtime-checks/${file}`);
        const result = await launch(probe, dirs.repo, signal, 30_000, true);
        probes.push({ name, exitCode: result.code, exitSignal: result.signal,
          reached: result.stdout.includes('fixture-reached'), completed: result.stdout.includes('fixture-completed') });
      }

      stage = 'matrix';
      const recorded = [...READ_TARGETS, ...recordedAncestors(fs.realpathSync(dirs.case))];
      const targets = [ICU, ICU_DATA, ...RUNTIME, ...recorded];
      const results = [];
      const run = async (label, grants) => {
        const start = Math.floor(Date.now() / 1000) - 1;
        const result = await launch(withGrants(worker.invocation(c.testCommand), grants), dirs.repo, signal, 120_000, true);
        const row = { ...project(label, result), grants: grants.map(({ id }) => id) };
        if (good(row)) {
          const canary = withGrants(worker.invocation(canaryCommand), grants);
          row.controls = controls(await launch(canary, dirs.repo, signal, 30_000, true));
        } else row.evidence = await denialEvidence(result, start, dirs.repo, signal, targets);
        results.push(row);
        return { ...row, proposed: grants };
      };
      const baseline = await run('baseline', []);
      if (good(baseline)) return { status: 'baseline-passed', probes, results };
      const metadata = await run('icu-metadata', [ICU]);
      const runtime = await run('runtime', RUNTIME);
      const combined = await run('icu-metadata-and-runtime', [ICU, ...RUNTIME]);
      const tested = [metadata, runtime, combined];
      if (baseline.evidence?.denied.includes(ICU.id) && !baseline.evidence.denied.includes(ICU_DATA.id)
          && !tested.some((row) => good(row) && row.controls?.status === 'denied')) {
        for (const arm of [metadata, combined]) {
          if (arm.evidence?.denied.includes(ICU_DATA.id) && !arm.evidence.denied.includes(ICU.id)) {
            tested.push(await run(`${arm.allowance}-with-confirmed-data-target`, [...arm.proposed, ICU_DATA]));
          }
        }
      }
      if (!tested.some((row) => good(row) && row.controls?.status === 'denied')) {
        tested.push(await run('all-recorded-denials', [...combined.proposed, ...recorded,
          ...(tested.some((row) => row.grants.includes(ICU_DATA.id)) ? [ICU_DATA] : [])]));
      }
      const candidate = tested.find((row) => good(row) && row.controls?.status === 'denied');
      const status = candidate ? await confirmRescue(candidate, baseline, run) : 'inconclusive';
      return { status, probes, results };
    } finally {
      try { await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))); }
      finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
    }
  } catch {
    return { status: signal.aborted ? 'interrupted' : 'diagnostic-failed', stage };
  } finally {
    try { if (root) fs.rmSync(root, { recursive: true, force: true }); }
    finally { for (const event of events) process.removeListener(event, cancel); }
  }
}

async function selfTest() {
  const invocation = { cmd: '/usr/bin/sandbox-exec', args: ['-p', '(deny default)', '/bin/sh', '-c', TEST], env: {} };
  const icu = withGrants(invocation, [ICU]);
  assert.equal(icu.args[1], '(deny default)\n(allow file-read-metadata (literal "/usr/share/icu/icudt76l.dat"))');
  assert.deepEqual(icu.args.slice(2), invocation.args.slice(2));
  assert.equal(icu.env, invocation.env);
  assert.equal(invocation.args[1], '(deny default)');
  assert.deepEqual(denialLabels(`Sandbox: bun(7) deny(1) file-read-data ${ICU_PATH}`, [ICU, ICU_DATA]), [ICU_DATA.id]);
  assert.deepEqual(denialLabels(`Sandbox: bun(7) deny(1) file-read-data ${ICU_PATH}.other`, [ICU_DATA]), []);
  assert.equal(controls({ code: 0, stdout: '{"file":"EPERM","unix":"EPERM","tcp":"EPERM"}' }).status, 'denied');
  assert.equal(controls({ code: 0, stdout: '{"file":"ENOENT","unix":"EPERM","tcp":"EPERM"}' }).status, 'failed');
  assert.equal(good(project('baseline', { code: 133, signal: null, output: '/private/reject\nTrace/BPT trap: 5' })), false);
  const win = { exitCode: 0, passed: 61, failed: 0, errors: 0, controls: { status: 'denied' }, proposed: [ICU] };
  const treatments = [];
  const setting = await confirmRescue(win, { exitCode: 133 }, (name, grants) => {
    treatments.push([name, grants]);
    return grants.length ? win : { exitCode: 133 };
  });
  assert.equal(setting, 'reproduced-rescue-with-withdrawals');
  assert.deepEqual(treatments, [['withdraw-all', []], ['restore-candidate', [ICU]]]);
  treatments.length = 0;
  const pair = [ICU, RUNTIME[0]];
  const pairedSetting = await confirmRescue({ ...win, proposed: pair }, { exitCode: 133 }, (name, grants) => {
    treatments.push([name, grants]);
    return grants.length === 2 ? win : { exitCode: 133 };
  });
  assert.equal(pairedSetting, 'reproduced-rescue-with-withdrawals');
  assert.deepEqual(treatments.map(([name]) => name),
    ['withdraw-all', 'withdraw-icu-metadata', 'withdraw-security.mac.lockdown_mode_state', 'restore-candidate']);
  return { status: 'self-test-passed' };
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--self-test') {
  console.log(JSON.stringify(await selfTest()));
} else if (args.length === 3 && args[0] === '--run-bun-icu' && args[1] === '--cases' && args[2] && !args[2].startsWith('--')) {
  const result = await runMatrix(path.resolve(args[2])).catch(() => ({ status: 'cleanup-failed' }));
  console.log(JSON.stringify(result, null, 2));
  if (!['baseline-passed', 'reproduced-rescue-with-withdrawals', 'reproduced-rescue-needs-bisection', 'inconclusive'].includes(result.status)) process.exitCode = 2;
} else {
  console.log('usage: node bun-icu-controls.mjs [--self-test | --run-bun-icu --cases <directory>]');
  if (args.length) process.exitCode = 2;
}
