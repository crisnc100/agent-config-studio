/**
 * The acs-usage CLI, run as a real child process against a redirected HOME.
 * Nothing here reads or writes the real ~/.agent-config-studio or ~/.codex.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'usage.mjs');
const realHome = os.homedir();
const home = tempDir('acs-cli-');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
// No real agy on PATH or in the login directories the refresh hands on (ACS_LOGIN_PATH_DIRS, lib/login-path.js):
// detect suggests Gemini whenever agy is installed, and the next --json would run it.
const PATH_NO_AGY = (process.env.PATH || '').split(path.delimiter).filter((d) => d && !fs.existsSync(path.join(d, 'agy'))).join(path.delimiter);
const run = (...args) => {
  try {
    return execFileSync(process.execPath, [CLI, ...args],
      { encoding: 'utf8', env: { ...process.env, ACS_LOGIN_PATH_DIRS: '', HOME: home, CODEX_HOME: '', NO_COLOR: '1', PATH: PATH_NO_AGY } });
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
     /\+ Add account/.test(out) && !/acs-usage/.test(out), out);
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

// --- the advertised entrypoint exists ---------------------------------------
{
  // Onboarding prints `acs usage`. Testing bin/usage.mjs directly never
  // exercised that, so the advertised command could stay unwired.
  const acs = path.join(path.dirname(CLI), 'acs');
  ok('bin/acs exists and is executable', fs.existsSync(acs) && (fs.statSync(acs).mode & 0o111) !== 0);

  // The launcher must not depend on a shell the target machine may not have.
  // A zsh shebang passed every local test and then failed CI with exit 127 and
  // a message naming zsh rather than this project — the least legible possible
  // first-run failure for someone who just cloned it.
  const shebang = fs.readFileSync(acs, 'utf8').split('\n')[0];
  ok('bin/acs runs under a shell that always exists',
     /^#!\/bin\/sh$|^#!\/usr\/bin\/env sh$/.test(shebang), shebang);
  ok('bin/acs parses as POSIX sh', (() => {
    try { execFileSync('sh', ['-n', acs], { stdio: 'pipe' }); return true; }
    catch (e) { return String(e.stderr || e); }
  })() === true);
  const out = (() => {
    try {
      return execFileSync(acs, ['usage', '--json'],
        { encoding: 'utf8', env: { ...process.env, ACS_LOGIN_PATH_DIRS: '', HOME: home, NO_COLOR: '1' } });
    } catch (e) { return `EXIT ${e.status}\n${e.stdout || ''}${e.stderr || ''}`; }
  })();
  let parsed = null;
  try { parsed = JSON.parse(out); } catch { /* stays null */ }
  ok('`acs usage --json` runs the tracker', parsed !== null && Array.isArray(parsed.seats), out.slice(0, 120));
}

// --- codex-home must skip a preserved directory -----------------------------
{
  // Removal preserves the home. The CLI had its own id allocator that saw only
  // the registry, so re-creating under the same label hit "already exists".
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const first = run('codex-home', 'Work');
  ok('codex-home creates a seat', /created/.test(first), first.slice(0, 120));
  const id = JSON.parse(run('--json')).seats.map((s2) => s2.seatId).find((x) => x.startsWith('work'));
  run('rm', id);
  const second = run('codex-home', 'Work');
  ok('the same label works again after removal', /created/.test(second) && !/already exists/.test(second),
     second.slice(0, 160));
  const dirs = fs.readdirSync(path.join(home, '.codex-seats'));
  ok('it got a fresh directory rather than colliding', dirs.length === 2, JSON.stringify(dirs));
}

// --- Gemini: detect finds agy as Setup does, and never takes another build's id ---
{
  const g = tempDir('acs-cli-gemini-');
  const reg = path.join(g, '.agent-config-studio', 'seats.json');
  // PATH without any real agy, so nothing here can start one; a fake goes first where a test wants agy installed.
  const noAgy = (process.env.PATH || '').split(path.delimiter).filter((d) => d && !fs.existsSync(path.join(d, 'agy'))).join(path.delimiter);
  const fakeBin = path.join(g, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'agy'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const runG = (pathVar, ...args) => {
    try { return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ACS_LOGIN_PATH_DIRS: '', HOME: g, CODEX_HOME: '', NO_COLOR: '1', PATH: pathVar } }); }
    catch (e) { return `EXIT ${e.status}\n${e.stdout || ''}${e.stderr || ''}`; }
  };
  const out = runG(`${fakeBin}${path.delimiter}${noAgy}`, 'detect');
  ok('detect suggests Gemini when agy is installed, before agy has made its folder', /^\s*gemini\s+gemini\s+Gemini\b/m.test(out) && !fs.existsSync(path.join(g, '.gemini')), out);
  ok('...and not without agy', !/gemini/.test(runG(noAgy, 'detect')));

  fs.mkdirSync(path.dirname(reg), { recursive: true });
  const future = { id: 'gemini', vendor: 'someday', label: 'From a newer build' };
  fs.writeFileSync(reg, JSON.stringify({ version: 1, seats: [future] }));
  const saved = runG(`${fakeBin}${path.delimiter}${noAgy}`, 'detect', '--save');
  const seats = JSON.parse(fs.readFileSync(reg, 'utf8')).seats;
  ok('detect --save keeps the entry another build owns', seats.some((x) => JSON.stringify(x) === JSON.stringify(future)), JSON.stringify(seats));
  const mine = seats.find((x) => x.vendor === 'gemini');
  ok('...registers Gemini under a fresh id', mine && mine.id !== 'gemini' && mine.harness === 'agy', JSON.stringify(seats));
  ok('...and says which id it registered', mine && new RegExp(`registered ${mine.id} \\(gemini\\)`).test(saved), saved);
}
{
  // A Gemini seat under an id detection does not use (a UI label slugs to anything), so only the
  // vendor-level rule can keep a second suggestion away; a matching id would hide it on its own.
  const g = tempDir('acs-cli-gemini-ui-');
  const reg = path.join(g, '.agent-config-studio', 'seats.json');
  fs.mkdirSync(path.dirname(reg), { recursive: true });
  fs.writeFileSync(reg, JSON.stringify({ version: 1, seats: [{ id: 'work', vendor: 'gemini', harness: 'agy', label: 'Work' }] }));
  const fakeBin = path.join(g, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'agy'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const out = (() => {
    try { return execFileSync(process.execPath, [CLI, 'detect'], { encoding: 'utf8', env: { ...process.env, ACS_LOGIN_PATH_DIRS: '', HOME: g, CODEX_HOME: '', NO_COLOR: '1', PATH: `${fakeBin}${path.delimiter}${PATH_NO_AGY}` } }); }
    catch (e) { return `EXIT ${e.status}\n${e.stdout || ''}${e.stderr || ''}`; }
  })();
  ok('detect does not suggest a second Gemini seat beside a UI-added one', !/\bgemini\b/i.test(out), out);
}

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
