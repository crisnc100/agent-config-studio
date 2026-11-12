/**
 * Runs the test files tests/SUITE puts in one group, or (--local) everything
 * ./verify.sh owns, in list order, one process per file.
 *
 *   node tests/run.mjs <group> | --local  [--list] [--jobs N] [--root <dir>]
 *
 * --list prints the files it would run, in order, and runs nothing. --root
 * points at another tree holding tests/SUITE (tests/suite-coverage.mjs and
 * tests/run-jobs.mjs run this against fixture trees).
 *
 * It stops at the first file that fails and exits with that file's code, as
 * `set -e` did. Each file's output goes straight to the terminal as it runs.
 *
 * --jobs N (N > 1) runs up to N files at once. Each file's stdout and stderr
 * go to one temp file (so their interleaving survives and a chatty test
 * costs disk, not memory) and are printed whole when that file's turn comes
 * in list order, so the log reads like a serial run. Files marked `serial`
 * run one at a time after the rest. A failure starts no new file; the files
 * already running finish and print, the files not run are named, and the
 * exit code is the first failing file's in list order.
 *
 * A selection that names no file is refused, never a pass: a
 * typo in a group name in ci.yml must turn the job red, not green with zero
 * tests. So is a malformed list or a listed file that is missing, before any
 * file runs.
 *
 * Node 20.0.0 runs this in CI: no API newer than that.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LANES = ['local', 'pending-ci', 'manual', 'helper'];
const GROUP = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Each entry: { file, line, groups, ciOnly, serial, lane, reason }. lane is 'ci' for
 * a line with ci:<group> tokens, else one of LANES. Errors carry the line
 * number; a caller must refuse the list when there are any.
 */
export function parseSuite(text) {
  const entries = [];
  const errors = [];
  text.split('\n').forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const hash = trimmed.search(/\s#/);
    const body = hash === -1 ? trimmed : trimmed.slice(0, hash);
    const reason = hash === -1 ? '' : trimmed.slice(hash).replace(/^\s*#\s*/, '').trim();
    const [file, ...tokens] = body.trim().split(/\s+/);
    const groups = [];
    const lanes = [];
    let ciOnly = false;
    let serial = false;
    for (const t of tokens) {
      if (t.startsWith('ci:')) {
        const g = t.slice(3);
        if (!GROUP.test(g)) errors.push(`line ${line}: "${t}" is not a group name (lowercase, digits, dashes)`);
        else if (groups.includes(g)) errors.push(`line ${line}: ${t} twice`);
        else groups.push(g);
      } else if (t === 'ci-only') ciOnly = true;
      else if (t === 'serial') serial = true;
      else if (LANES.includes(t)) lanes.push(t);
      else errors.push(`line ${line}: unknown lane "${t}"`);
    }
    const kinds = (groups.length ? 1 : 0) + lanes.length;
    if (kinds === 0) errors.push(`line ${line}: ${file} has no lane`);
    if (kinds > 1) errors.push(`line ${line}: ${file} has more than one lane (${tokens.join(' ')})`);
    if (ciOnly && !groups.length) errors.push(`line ${line}: ci-only needs a ci:<group>`);
    // Only a gate runs files side by side, so serial means nothing on a line no gate runs.
    if (serial && !groups.length && !lanes.includes('local')) errors.push(`line ${line}: serial needs a ci:<group> or local`);
    const lane = groups.length ? 'ci' : lanes[0];
    if (lanes.length && !reason) errors.push(`line ${line}: ${file} is ${lanes[0]} and needs a reason after #`);
    entries.push({ file, line, groups, ciOnly, serial, lane, reason });
  });
  return { entries, errors };
}

/** What `--local` runs: every ci line verify.sh shares, and every local line. */
export const isLocal = (e) => (e.lane === 'ci' && !e.ciOnly) || e.lane === 'local';

function refuse(msg) {
  console.error(`run.mjs: ${msg}`);
  process.exit(2);
}

// A child killed by a signal has no status; 128+n is the shell's convention for it.
const exitCode = (status, signal) => status ?? 128 + (os.constants.signals[signal] || 0);

async function main(argv) {
  let root = path.join(HERE, '..');
  let list = false;
  let jobs = 1;
  const picks = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') list = true;
    else if (a === '--jobs') {
      const n = argv[++i];
      if (!/^[1-9][0-9]*$/.test(n || '')) refuse(`--jobs needs a positive whole number, got ${n === undefined ? 'nothing' : `"${n}"`}`);
      jobs = Number(n);
    } else if (a === '--root') {
      if (!argv[i + 1]) refuse('--root needs a folder');
      root = path.resolve(argv[++i]);
    } else if (a === '--local' || !a.startsWith('-')) picks.push(a);
    else refuse(`unknown option ${a}`);
  }
  if (picks.length !== 1) refuse('usage: node tests/run.mjs <group> | --local  [--list] [--jobs N] [--root <dir>]');
  const pick = picks[0];

  const suitePath = path.join(root, 'tests', 'SUITE');
  let text;
  try { text = fs.readFileSync(suitePath, 'utf8'); } catch (e) { refuse(`cannot read ${suitePath}: ${e.code || e.message}`); }
  const { entries, errors } = parseSuite(text);
  if (errors.length) refuse(`tests/SUITE is malformed:\n  ${errors.join('\n  ')}`);

  const chosen = pick === '--local' ? entries.filter(isLocal) : entries.filter((e) => e.groups.includes(pick));
  if (!chosen.length) {
    const known = [...new Set(entries.flatMap((e) => e.groups))].sort();
    refuse(pick === '--local'
      ? 'no file in tests/SUITE is ci (without ci-only) or local: nothing for verify.sh to run'
      : `no file in tests/SUITE is in group "${pick}" (groups: ${known.join(', ') || 'none'})`);
  }
  const missing = chosen.filter((e) => !fs.existsSync(path.join(root, e.file)));
  if (missing.length) refuse(`tests/SUITE lists files that do not exist: ${missing.map((e) => e.file).join(', ')}`);

  if (list) {
    for (const e of chosen) console.log(e.file);
    return;
  }

  const label = pick === '--local' ? 'local' : pick;
  if (jobs > 1) return runSideBySide(chosen, jobs, root, label);
  const start = performance.now();
  for (const [i, e] of chosen.entries()) {
    console.log(`\n=== ${e.file} (${i + 1}/${chosen.length})`);
    const t0 = performance.now();
    const r = spawnSync(process.execPath, [path.join(root, e.file)], { cwd: root, stdio: 'inherit' });
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (r.error) refuse(`could not start ${e.file}: ${r.error.message}`);
    const code = exitCode(r.status, r.signal);
    if (code !== 0) {
      console.log(`=== FAIL ${e.file}: exit ${r.status ?? r.signal} after ${secs}s; ${chosen.length - i - 1} file(s) not run`);
      process.exit(code);
    }
    console.log(`=== ok   ${e.file}: ${secs}s`);
  }
  console.log(`\n=== ${label}: ${chosen.length} file(s) passed in ${((performance.now() - start) / 1000).toFixed(1)}s`);
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function runSideBySide(chosen, jobs, root, label) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-run-'));
  const sweep = () => { try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {} };
  process.on('exit', sweep);
  for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15]]) process.on(sig, () => process.exit(128 + n));

  const position = new Map(chosen.map((e, i) => [e, i + 1]));
  const shared = chosen.filter((e) => !e.serial);
  const alone = chosen.filter((e) => e.serial);
  const order = [...shared, ...alone];
  const slots = order.map(() => deferred());
  let stopped = false;
  let fileSecs = 0;

  function runOne(k) {
    const e = order[k];
    const log = path.join(outDir, `${k}.log`);
    const fd = fs.openSync(log, 'w');
    const t0 = performance.now();
    return new Promise((resolve) => {
      const done = (r) => { const secs = (performance.now() - t0) / 1000; fileSecs += secs; resolve({ e, log, secs, ...r }); };
      let child;
      try {
        child = spawn(process.execPath, [path.join(root, e.file)], { cwd: root, stdio: ['ignore', fd, fd] });
      } catch (err) {
        done({ error: err });
        return;
      } finally {
        fs.closeSync(fd);
      }
      child.once('error', (err) => done({ error: err }));
      child.once('close', (status, signal) => done({ status, signal }));
    });
  }

  async function pool(from, to, width) {
    let next = from;
    const worker = async () => {
      while (!stopped && next < to) {
        const k = next++;
        const r = await runOne(k);
        if (r.error || exitCode(r.status, r.signal) !== 0) stopped = true;
        slots[k].resolve(r);
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, to - from) }, worker));
  }

  const failures = [];
  const notRun = [];
  const printer = (async () => {
    for (const [k, slot] of slots.entries()) {
      const r = await slot.promise;
      if (!r) { notRun.push(order[k].file); continue; }
      console.log(`\n=== ${r.e.file} (${position.get(r.e)}/${chosen.length})`);
      await new Promise((res, rej) => {
        const s = fs.createReadStream(r.log);
        s.once('error', rej);
        s.once('end', res);
        s.pipe(process.stdout, { end: false });
      });
      fs.rmSync(r.log, { force: true });
      const secs = r.secs.toFixed(1);
      if (r.error) {
        console.log(`=== FAIL ${r.e.file}: could not start: ${r.error.message}`);
        failures.push({ e: r.e, code: 2 });
      } else if (exitCode(r.status, r.signal) !== 0) {
        console.log(`=== FAIL ${r.e.file}: exit ${r.status ?? r.signal} after ${secs}s`);
        failures.push({ e: r.e, code: exitCode(r.status, r.signal) });
      } else console.log(`=== ok   ${r.e.file}: ${secs}s`);
    }
  })();

  const start = performance.now();
  await pool(0, shared.length, jobs);
  await pool(shared.length, order.length, 1);
  for (const slot of slots) slot.resolve(null);
  await printer;
  const wall = ((performance.now() - start) / 1000).toFixed(1);

  if (failures.length) {
    const first = failures.sort((a, b) => position.get(a.e) - position.get(b.e))[0];
    if (notRun.length) console.log(`\n=== ${notRun.length} file(s) not run: ${notRun.join(', ')}`);
    console.log(`=== ${label}: failed after ${wall}s; first failing file in list order: ${first.e.file} (exit ${first.code})`);
    process.exit(first.code);
  }
  console.log(`\n=== ${label}: ${chosen.length} file(s) passed in ${wall}s (--jobs ${jobs}, ${alone.length} serial; ${fileSecs.toFixed(1)}s of file time)`);
}

const invoked = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invoked) await main(process.argv.slice(2));
