/**
 * The acs-usage CLI, run as a real child process against a redirected HOME.
 * Nothing here reads or writes the real ~/.agent-config-studio or ~/.codex.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'usage.mjs');
const realHome = os.homedir();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-cli-'));

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const run = (...args) => {
  try {
    return execFileSync(process.execPath, [CLI, ...args],
      { encoding: 'utf8', env: { ...process.env, HOME: home, CODEX_HOME: '', NO_COLOR: '1' } });
  } catch (e) { return `EXIT ${e.status}\n${e.stdout || ''}${e.stderr || ''}`; }
};
const snapFile = path.join(home, '.agent-config-studio', 'usage-snapshot.json');

console.log('\nusage/cli');
ok('HOME is redirected', home !== realHome);

// --- zero seats: --json must still be JSON ----------------------------------
{
  // The bug: `--json` was parsed as an unknown subcommand on an empty registry,
  // printed onboarding prose, and wrote no snapshot — so a JSON consumer broke
  // precisely on first run.
  const out = run('--json');
  let parsed = null;
  try { parsed = JSON.parse(out); } catch { /* stays null */ }
  ok('--json with zero seats emits JSON, not prose', parsed !== null, out.slice(0, 120));
  ok('...with an empty seats array', Array.isArray(parsed?.seats) && parsed.seats.length === 0);
  ok('...and persists an empty snapshot', fs.existsSync(snapFile));
}
{
  const out = run();
  ok('the human view still explains what to do', /No subscriptions tracked yet/.test(out), out.slice(0, 80));
  ok('it points at the studio, not a command that does not exist',
     /\+ Add seat/.test(out) && !/acs-usage/.test(out), out);
}

// --- a stale snapshot must not survive every seat being removed -------------
{
  fs.mkdirSync(path.join(home, '.codex', 'sessions', '2026', '09', '07'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'sessions', '2026', '09', '07', 'rollout-2026-09-07T10-00-00-a.jsonl'),
    JSON.stringify({ timestamp: '2026-09-07T10:00:00.000Z',
      info: { rate_limits: { primary: { used_percent: 40, window_minutes: 10080, resets_at: 1789047414 } } } }) + '\n');

  run('detect', '--save');
  const withSeats = JSON.parse(run('--json'));
  ok('detect --save registers the codex home', withSeats.seats.length >= 1, JSON.stringify(withSeats.seats.map(s => s.seatId)));

  // The bug: dedupe was by generated id only, so the same home registered again
  // under a different label — one subscription counted twice.
  run('add', 'codex', 'Codex again', '--home', path.join(home, '.codex'));
  const before = JSON.parse(run('--json')).seats.length;
  run('detect', '--save');
  const after = JSON.parse(run('--json')).seats.length;
  ok('detect --save does not re-register an already-tracked home', after === before, `${before} -> ${after}`);

  const homes = JSON.parse(run('--json')).seats.filter((s) => s.vendor === 'codex').map((s) => s.home);
  ok('no two codex seats share a home', new Set(homes).size === homes.length, JSON.stringify(homes));
}
{
  for (const s of JSON.parse(run('--json')).seats) run('rm', s.seatId);
  const out = run('--json');
  const parsed = JSON.parse(out);
  ok('removing every seat leaves an empty snapshot, not the previous one',
     parsed.seats.length === 0 && JSON.parse(fs.readFileSync(snapFile, 'utf8')).seats.length === 0);
}

// --- unknown commands still fail loudly -------------------------------------
{
  const out = run('nonsense');
  ok('an unknown subcommand prints help and exits non-zero', /EXIT 2/.test(out), out.slice(0, 60));
}

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
