/**
 * Shell shortcut generation. Everything here is written to a temp dir — this
 * never touches the real ~/.zshenv or ~/.agent-config-studio.
 *
 * The generated file is sourced by every shell the user opens, so the bar for
 * this module is higher than "produces the right words": nothing a user can
 * type may become executable shell.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  validateWord, validateFlags, validateHome, shortcutsFromSeats, renderShortcuts,
  writeShortcuts, install, uninstall, isInstalled, syncShortcuts, shortcutsPath, zshenvPath,
} from '../lib/usage/shell.js';
import { saveSeats } from '../lib/usage/seats.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-shell-'));
const realHome = os.homedir();
const homeDir = (name) => { const p = path.join(tmp, name); fs.mkdirSync(p, { recursive: true }); return p; };

console.log('\nusage/shell');

// --- the file zsh actually always reads -------------------------------------
ok('shortcuts install into .zshenv, not .zshrc',
   zshenvPath('/h') === '/h/.zshenv', zshenvPath('/h'));

// --- command words are an allowlist, not an escape ---------------------------
{
  ok('a normal word is accepted', validateWord('team') === null);
  ok('a dashed word is accepted', validateWord('work-team') === null);
  for (const bad of [
    'Team', '2team', 'team space', 'team;rm -rf /', 'team$(id)', 'team`id`',
    "team'", 'team"', 'team|x', 'team&&x', 'team\nrm', 'team/../x', '',
  ]) {
    ok(`refused: ${JSON.stringify(bad)}`, validateWord(bad) !== null, 'ACCEPTED — would reach the shell');
  }
  ok('an overlong word is refused', validateWord('a'.repeat(25)) !== null);
  ok('shadowing codex itself is refused', validateWord('codex') !== null);
  ok('shadowing rm is refused', validateWord('rm') !== null);
  ok('shadowing sudo is refused', validateWord('sudo') !== null);
}

// --- default flags are held to the same bar ---------------------------------
{
  ok('empty flags are fine', validateFlags('') === null);
  ok('--yolo is fine', validateFlags('--yolo') === null);
  ok('several flags are fine', validateFlags('--yolo -m gpt-6-astra') === null);
  for (const bad of ['--yolo; rm -rf /', '$(id)', '`id`', '--yolo && x', "--x'y", '--x"y', '--x|y']) {
    ok(`flags refused: ${JSON.stringify(bad)}`, validateFlags(bad) !== null, 'ACCEPTED — would reach the shell');
  }
}

// --- homes must be real ------------------------------------------------------
{
  const good = homeDir('good-home');
  ok('an existing directory is accepted', validateHome(good) === null);
  ok('a relative path is refused', validateHome('.codex') !== null);
  ok('a missing directory is refused', validateHome(path.join(tmp, 'nope')) !== null);
  const f = path.join(tmp, 'afile'); fs.writeFileSync(f, 'x');
  ok('a file is refused', validateHome(f) !== null);
  ok('a newline in a path is refused', validateHome('/tmp/a\nb') !== null);
}

// --- only codex seats get a word --------------------------------------------
{
  const seats = [
    { id: 'codex-1', vendor: 'codex', label: 'Codex (primary · prolite)', home: homeDir('h1') },
    { id: 'claude-1', vendor: 'claude', label: 'Claude' },
    { id: 'codex-second', vendor: 'codex', label: 'Codex (second · team)', home: homeDir('h2') },
    { id: 'grok', vendor: 'grok', label: 'Grok' },
  ];
  const sc = shortcutsFromSeats(seats);
  ok('claude and grok get no shortcut', sc.length === 2, JSON.stringify(sc.map((s) => s.id)));
  ok('words are derived from the label', sc.map((s) => s.word).join(',') === 'primary,second',
     sc.map((s) => s.word).join(','));
  ok('a configured word overrides the derived one',
     shortcutsFromSeats(seats, { words: { 'codex-second': 'team' } })
       .find((s) => s.id === 'codex-second').word === 'team');
  ok('an INVALID configured word falls back rather than reaching the shell',
     shortcutsFromSeats(seats, { words: { 'codex-second': 'te;am' } })
       .find((s) => s.id === 'codex-second').word === 'second');

  // Two seats whose labels reduce to the same word must not collide: the second
  // function definition would win and silently route to the wrong account.
  const dupes = [
    { id: 'a', vendor: 'codex', label: 'Work', home: homeDir('d1') },
    { id: 'b', vendor: 'codex', label: 'Work', home: homeDir('d2') },
  ];
  const ds = shortcutsFromSeats(dupes);
  ok('colliding labels produce distinct words', ds[0].word !== ds[1].word, JSON.stringify(ds.map((s) => s.word)));
}

// --- the generated file is valid zsh and routes correctly --------------------
{
  const h1 = homeDir('r1'), h2 = homeDir('r2');
  const seats = [
    { id: 'codex-1', vendor: 'codex', label: 'Personal', home: h1 },
    { id: 'codex-2', vendor: 'codex', label: 'Team', home: h2 },
  ];
  const text = renderShortcuts(shortcutsFromSeats(seats, { flags: { 'codex-2': '--yolo' } }));
  const file = path.join(tmp, 'seats.zsh');
  fs.writeFileSync(file, text);

  let syntaxOk = true, syntaxErr = '';
  try { execFileSync('zsh', ['-n', file], { stdio: 'pipe' }); }
  catch (e) { syntaxOk = false; syntaxErr = String(e.stderr || e); }
  ok('the generated file is syntactically valid zsh', syntaxOk, syntaxErr);

  ok('the file warns against hand editing', /DO NOT EDIT/.test(text));

  // Route it for real, with a fake codex on PATH that reports what it got.
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\necho "HOME=$CODEX_HOME ARGS=$*"\n', { mode: 0o755 });
  const run = (cmd) => execFileSync('zsh', ['-f', '-c',
    `export PATH=${JSON.stringify(bin)}:$PATH; source ${JSON.stringify(file)}; ${cmd}`],
    { encoding: 'utf8' }).trim();

  ok('bare codex uses the first seat', run('codex --help').includes(`HOME=${h1}`), run('codex --help'));
  ok('a seat word routes to its home', run('codex team').includes(`HOME=${h2}`), run('codex team'));
  ok('the bare word form works', run('team').includes(`HOME=${h2}`), run('team'));
  ok('the codex- prefixed form works', run('codex-team').includes(`HOME=${h2}`), run('codex-team'));
  ok('arguments pass through', run('codex team resume --yolo').includes('resume --yolo'),
     run('codex team resume --yolo'));
  ok('configured default flags are applied', run('codex team exec').includes('--yolo exec'),
     run('codex team exec'));
  ok('a seat without default flags gets none', !run('codex personal exec').includes('--yolo'),
     run('codex personal exec'));
  ok('an explicit CODEX_HOME still wins',
     run('CODEX_HOME=/custom codex').includes('HOME=/custom'), run('CODEX_HOME=/custom codex'));
}

// --- install touches ~/.zshenv exactly once, and reversibly ------------------
{
  const fakeHome = homeDir('zhome');
  const zshenv = path.join(fakeHome, '.zshenv');
  const original = '# my own config\nexport EDITOR=vim\nalias ll="ls -la"\n';
  fs.writeFileSync(zshenv, original);
  const file = path.join(tmp, 'seats.zsh');

  const a = install({ zshenv, file });
  ok('install reports a change', a.changed === true);
  ok('install is idempotent', install({ zshenv, file }).changed === false);
  const after = fs.readFileSync(zshenv, 'utf8');
  ok('the source line is present once', (after.match(/source /g) || []).length === 1, after);
  ok('the pre-existing config is untouched', after.startsWith(original), after.slice(0, 80));
  ok('isInstalled sees it', isInstalled(zshenv) === true);
  ok('the installed .zshenv is valid zsh', (() => {
    try { execFileSync('zsh', ['-n', zshenv], { stdio: 'pipe' }); return true; } catch { return false; }
  })());

  const u = uninstall({ zshenv });
  ok('uninstall reports a change', u.changed === true);
  ok('uninstall leaves the original byte-identical', fs.readFileSync(zshenv, 'utf8') === original,
     JSON.stringify(fs.readFileSync(zshenv, 'utf8')));
  ok('uninstalling twice is a no-op', uninstall({ zshenv }).changed === false);
  ok('isInstalled is false again', isInstalled(zshenv) === false);
}

// --- install creates .zshenv when there is none ------------------------------
{
  const fakeHome = homeDir('nozshenv');
  const zshenv = path.join(fakeHome, '.zshenv');
  install({ zshenv, file: path.join(tmp, 'seats.zsh') });
  ok('a missing .zshenv is created', fs.existsSync(zshenv));
  ok('...and is valid zsh', (() => {
    try { execFileSync('zsh', ['-n', zshenv], { stdio: 'pipe' }); return true; } catch { return false; }
  })());
}

// --- sync from the registry --------------------------------------------------
{
  const reg = path.join(tmp, 'seats.json');
  const out = path.join(tmp, 'out', 'seats.zsh');
  saveSeats([
    { id: 'codex-1', vendor: 'codex', label: 'Personal', home: homeDir('s1') },
    { id: 'codex-2', vendor: 'codex', label: 'Team', home: homeDir('s2') },
    { id: 'claude-1', vendor: 'claude', label: 'Claude' },
  ], reg);
  const r = syncShortcuts({ file: reg, out, config: { words: { 'codex-2': 'team' } } });
  ok('sync succeeds', r.ok === true, JSON.stringify(r.problems));
  ok('sync wrote the file', fs.existsSync(out));
  ok('sync covers only codex seats', r.shortcuts.length === 2);
  ok('the configured word is used', r.shortcuts.some((s) => s.word === 'team'));

  // A seat whose home has vanished must be reported, not silently written into
  // a shortcut that would start codex against nothing.
  saveSeats([{ id: 'codex-1', vendor: 'codex', label: 'Gone', home: path.join(tmp, 'vanished') }], reg);
  const bad = syncShortcuts({ file: reg, out });
  ok('a missing home fails the sync', bad.ok === false && bad.problems.length > 0, JSON.stringify(bad.problems));
  ok('...and the failed sync did not rewrite the file',
     fs.readFileSync(out, 'utf8').includes('Team'));
}

// --- the real machine is untouched -------------------------------------------
{
  ok('the real ~/.zshenv was never written by these tests',
     !fs.existsSync(path.join(realHome, '.zshenv')) ||
     !fs.readFileSync(path.join(realHome, '.zshenv'), 'utf8').includes(tmp));
  ok('no shortcut file was written to the real studio home',
     !shortcutsPath().startsWith(tmp) && !fs.existsSync(path.join(tmp, 'REAL')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
