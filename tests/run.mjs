/**
 * Runs the test files tests/SUITE puts in one group, or (--local) everything
 * ./verify.sh owns, in list order, one process per file.
 *
 *   node tests/run.mjs <group> | --local  [--list] [--root <dir>]
 *
 * --list prints the files it would run, in order, and runs nothing. --root
 * points at another tree holding tests/SUITE (tests/suite-coverage.mjs runs
 * this against fixture trees).
 *
 * It stops at the first file that fails and exits with that file's code, as
 * `set -e` did. A selection that names no file is refused, never a pass: a
 * typo in a group name in ci.yml must turn the job red, not green with zero
 * tests. So is a malformed list or a listed file that is missing, before any
 * file runs.
 *
 * Node 20.0.0 runs this in CI: no API newer than that.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LANES = ['local', 'pending-ci', 'manual', 'helper'];
const GROUP = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Each entry: { file, line, groups, ciOnly, lane, reason }. lane is 'ci' for
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
    for (const t of tokens) {
      if (t.startsWith('ci:')) {
        const g = t.slice(3);
        if (!GROUP.test(g)) errors.push(`line ${line}: "${t}" is not a group name (lowercase, digits, dashes)`);
        else if (groups.includes(g)) errors.push(`line ${line}: ${t} twice`);
        else groups.push(g);
      } else if (t === 'ci-only') ciOnly = true;
      else if (LANES.includes(t)) lanes.push(t);
      else errors.push(`line ${line}: unknown lane "${t}"`);
    }
    const kinds = (groups.length ? 1 : 0) + lanes.length;
    if (kinds === 0) errors.push(`line ${line}: ${file} has no lane`);
    if (kinds > 1) errors.push(`line ${line}: ${file} has more than one lane (${tokens.join(' ')})`);
    if (ciOnly && !groups.length) errors.push(`line ${line}: ci-only needs a ci:<group>`);
    const lane = groups.length ? 'ci' : lanes[0];
    if (lanes.length && !reason) errors.push(`line ${line}: ${file} is ${lanes[0]} and needs a reason after #`);
    entries.push({ file, line, groups, ciOnly, lane, reason });
  });
  return { entries, errors };
}

/** What `--local` runs: every ci line verify.sh shares, and every local line. */
export const isLocal = (e) => (e.lane === 'ci' && !e.ciOnly) || e.lane === 'local';

function refuse(msg) {
  console.error(`run.mjs: ${msg}`);
  process.exit(2);
}

function main(argv) {
  let root = path.join(HERE, '..');
  let list = false;
  const picks = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') list = true;
    else if (a === '--root') {
      if (!argv[i + 1]) refuse('--root needs a folder');
      root = path.resolve(argv[++i]);
    } else if (a === '--local' || !a.startsWith('-')) picks.push(a);
    else refuse(`unknown option ${a}`);
  }
  if (picks.length !== 1) refuse('usage: node tests/run.mjs <group> | --local  [--list] [--root <dir>]');
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
  const start = performance.now();
  for (const [i, e] of chosen.entries()) {
    console.log(`\n=== ${e.file} (${i + 1}/${chosen.length})`);
    const t0 = performance.now();
    const r = spawnSync(process.execPath, [path.join(root, e.file)], { cwd: root, stdio: 'inherit' });
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (r.error) refuse(`could not start ${e.file}: ${r.error.message}`);
    // A child killed by a signal has no status; 128+n is the shell's convention for it.
    const code = r.status ?? 128 + (os.constants.signals[r.signal] || 0);
    if (code !== 0) {
      console.log(`=== FAIL ${e.file}: exit ${r.status ?? r.signal} after ${secs}s; ${chosen.length - i - 1} file(s) not run`);
      process.exit(code);
    }
    console.log(`=== ok   ${e.file}: ${secs}s`);
  }
  console.log(`\n=== ${label}: ${chosen.length} file(s) passed in ${((performance.now() - start) / 1000).toFixed(1)}s`);
}

const invoked = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invoked) main(process.argv.slice(2));
