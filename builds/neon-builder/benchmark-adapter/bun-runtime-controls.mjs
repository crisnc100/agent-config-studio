import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareNeonGrade } from './neon-grade.mjs';
import { checkoutAt, loadCases, testCounts } from './run.mjs';

const CASE = 'airflo-staff-mail-skip';
const REF = 'b46966fc3143ba0a7a0bce3160e30be4f6a15cd4';
const TEST = 'cd apps/dealer-portal && bun test lib/orders/intake/m365/skip-rules.test.ts lib/orders/intake/m365/ingest.test.ts';
const SETUP = 'bun install --frozen-lockfile';
const EXPECTED_PASSES = 61;

function addDirectoryListing(invocation, dirs) {
  const [mode, profile, ...exec] = invocation.args;
  if (mode !== '-p' || typeof profile !== 'string') throw new Error('unexpected sandbox invocation');
  if (!dirs.length || dirs.includes(path.sep) || dirs.some((dir) => !path.isAbsolute(dir))) throw new Error('invalid directory grant');
  const literals = dirs.map((dir) => `(literal ${JSON.stringify(dir)})`).join(' ');
  return { ...invocation, args: [mode, `${profile}\n(allow file-read-data ${literals})`, ...exec] };
}

function directoryChain(caseDir, tmpDir) {
  if (!caseDir.startsWith(tmpDir + path.sep)) throw new Error('fixture is outside the user temp directory');
  const result = [];
  for (let dir = caseDir; dir !== tmpDir; dir = path.dirname(dir)) result.push(dir);
  return [...result, tmpDir];
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
    const chunks = [];
    let outputBytes = 0;
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (chunk) => {
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
      resolve({ code, signal: exitSignal, output: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

async function runBun(casesDir, includeAncestors) {
  if (process.platform !== 'darwin') return { status: 'unsupported-platform' };
  let root;
  let stage = 'case';
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () => controller.abort();
  const handled = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const name of handled) process.on(name, cancel);
  try {
    const { cases, remotes } = loadCases(casesDir, ['builder'], new Set([CASE]));
    const c = cases[0];
    // The control outside Seatbelt is permitted only for this exact audited reference and commands.
    if (cases.length !== 1 || c.id !== CASE || c.project !== 'airflo' || c.refSha !== REF
        || c.testCommand !== TEST || c.setup?.length !== 1 || c.setup[0] !== SETUP) {
      return { status: 'unexpected-reference' };
    }
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bun-runtime-controls-'));
    const dirs = { case: path.join(root, 'case'), repo: path.join(root, 'case', 'repo') };
    stage = 'checkout';
    const checkout = await checkoutAt(c, REF, dirs.repo, remotes, { depth: 1 });
    if (checkout.error) return { status: 'setup-failed', stage };
    signal.throwIfAborted();
    const worker = prepareNeonGrade(c.testCommand, dirs);
    stage = 'dependencies';
    const setup = await launch({
      cmd: '/bin/sh',
      args: ['-c', `${c.setup[0]} --backend copyfile --cache-dir "$BUN_INSTALL_CACHE_DIR"`],
      env: { ...process.env, ...worker.setupEnv },
    }, dirs.repo, signal, 20 * 60_000, false);
    if (setup.code !== 0) return { status: signal.aborted ? 'interrupted' : 'setup-failed', stage, exitCode: setup.code };

    stage = 'grade';
    const invocation = worker.invocation(c.testCommand);
    const caseDir = fs.realpathSync(dirs.case);
    const run = async (allowance, variant) => project(allowance, await launch(variant, dirs.repo, signal, 120_000, true));
    const results = [await run('unchanged', invocation)];
    if (!good(results[0])) {
      const [mode, , cmd, ...args] = invocation.args;
      if (mode !== '-p' || cmd !== '/bin/sh' || args.length !== 2 || args[0] !== '-c' || args[1] !== TEST) {
        throw new Error('unexpected sandbox invocation');
      }
      const control = await run('trusted-ref-private-env', { cmd, args, env: invocation.env });
      results.push(control);
      if (good(control)) {
        results.push(await run('case-parent-directory-list', addDirectoryListing(invocation, [caseDir])));
        if (includeAncestors && !good(results.at(-1))) {
          const dirs = directoryChain(caseDir, fs.realpathSync(os.tmpdir()));
          results.push(await run('exact-temp-ancestor-directory-list', addDirectoryListing(invocation, dirs)));
        }
      }
    }
    return { status: signal.aborted ? 'interrupted' : 'observed', results };
  } catch {
    return { status: signal.aborted ? 'interrupted' : 'diagnostic-failed', stage };
  } finally {
    try { if (root) fs.rmSync(root, { recursive: true, force: true }); }
    finally { for (const name of handled) process.removeListener(name, cancel); }
  }
}

function selfTest() {
  const baseline = { cmd: '/usr/bin/sandbox-exec', args: ['-p', '(deny default)', '/bin/sh', '-c', TEST], env: { HOME: '/private/tmp/isolated' } };
  const variant = addDirectoryListing(baseline, ['/private/tmp/disposable case']);
  assert.equal(variant.args[1], '(deny default)\n(allow file-read-data (literal "/private/tmp/disposable case"))');
  assert.deepEqual(variant.args.slice(2), baseline.args.slice(2));
  assert.equal(variant.env, baseline.env);
  assert.equal(baseline.args[1], '(deny default)');
  assert.deepEqual(directoryChain('/private/tmp/owned/run/case', '/private/tmp/owned'),
    ['/private/tmp/owned/run/case', '/private/tmp/owned/run', '/private/tmp/owned']);
  assert.throws(() => directoryChain('/private/tmp/owned-other', '/private/tmp/owned'));
  assert.throws(() => addDirectoryListing(baseline, ['/']));
  const check = project('unchanged', { code: 0, signal: null, output: 'secretish /private/do-not-emit\n 61 pass\n 0 fail' });
  assert.deepEqual(check, { allowance: 'unchanged', exitCode: 0, exitSignal: null, passed: 61, failed: 0, errors: 0 });
  assert.equal(good(check), true);
  assert.equal(good(project('unchanged', { code: 133, signal: null, output: 'Trace/BPT trap: 5' })), false);
  return { status: 'self-test-passed' };
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--self-test') {
  console.log(JSON.stringify(selfTest()));
} else if ([3, 4].includes(args.length) && args[0] === '--run-bun' && args[1] === '--cases'
    && args[2] && !args[2].startsWith('--') && (args.length === 3 || args[3] === '--bun-ancestors')) {
  const result = await runBun(path.resolve(args[2]), args.length === 4).catch(() => ({ status: 'cleanup-failed' }));
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'observed') process.exitCode = 2;
} else {
  console.log('usage: node bun-runtime-controls.mjs [--self-test | --run-bun --cases <directory> [--bun-ancestors]]');
  if (args.length) process.exitCode = 2;
}
