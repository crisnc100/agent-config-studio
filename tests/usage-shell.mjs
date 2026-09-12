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
  validateWord, validateFlags, validateHome, validateLabel, shortcutsFromSeats, renderShortcuts,
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

// --- a LABEL is input too: it is rendered into the file ---------------------
{
  // Review finding: labels went into the generated file as comments with no
  // validation. A newline ends the comment and the remainder executes in every
  // shell that sources it. Reproduced by the reviewer as `x\necho PWNED`.
  ok('a normal label passes', validateLabel('Codex (primary · prolite)') === null);
  for (const bad of ['x\necho PWNED', 'x\rwhoami', 'x\u0000y', 'a'.repeat(81)]) {
    ok(`label refused: ${JSON.stringify(bad).slice(0, 30)}`, validateLabel(bad) !== null,
       'ACCEPTED — would reach the shell');
  }

  const h = homeDir('lbl');
  const evil = [{ id: 'codex-1', vendor: 'codex', label: 'x\necho PWNED', home: h }];
  const text = renderShortcuts(shortcutsFromSeats(evil));
  ok('a newline never survives into the generated file', !/\necho PWNED/.test(text),
     JSON.stringify(text.slice(0, 120)));
  const file = path.join(tmp, 'evil.zsh');
  fs.writeFileSync(file, text);
  const out = execFileSync('zsh', ['-f', '-c', `source ${JSON.stringify(file)}; echo DONE`],
    { encoding: 'utf8' });
  ok('sourcing it executes nothing from the label', !/PWNED/.test(out), out.trim());
}

// --- word derivation must terminate ------------------------------------------
{
  // Review finding: `${base}${n++}`.slice(0, 24) leaves the word unchanged once
  // base is already 24 chars, so the uniqueness loop spun forever — inside a
  // route, blocking the whole studio.
  const long = 'abcdefghijklmnopqrstuvwxyz';
  const seats = [
    { id: 'a', vendor: 'codex', label: long, home: homeDir('L1') },
    { id: 'b', vendor: 'codex', label: long, home: homeDir('L2') },
    { id: 'c', vendor: 'codex', label: long, home: homeDir('L3') },
  ];
  const started = Date.now();
  const sc = shortcutsFromSeats(seats);
  ok('long identical labels do not hang', Date.now() - started < 2000, `${Date.now() - started}ms`);
  ok('...and still produce distinct words', new Set(sc.map((x) => x.word)).size === 3,
     JSON.stringify(sc.map((x) => x.word)));
  ok('...each within the length limit', sc.every((x) => x.word.length <= 24));
}

// --- a configured word cannot steal another seat's ---------------------------
{
  // Review finding: uniqueness was enforced only for DERIVED words, so a
  // configured duplicate defined the function twice and routed one
  // subscription to the other's account.
  const seats = [
    { id: 'a', vendor: 'codex', label: 'Team', home: homeDir('W1') },
    { id: 'b', vendor: 'codex', label: 'Other', home: homeDir('W2') },
  ];
  const sc = shortcutsFromSeats(seats, { words: { b: 'team' } });
  ok('a configured word that collides is not honoured',
     new Set(sc.map((x) => x.word)).size === 2, JSON.stringify(sc.map((x) => x.word)));

  const text = renderShortcuts(sc);
  for (const w of sc.map((x) => x.word)) {
    const defs = (text.match(new RegExp(`^${w}\\(\\) \\{`, 'gm')) || []).length;
    ok(`${w}() is defined exactly once`, defs === 1, String(defs));
  }
}

// --- the default seat is chosen, never inherited from list order ------------
{
  // Registry order deciding which subscription bare `codex` bills is exactly
  // the silent-automatic behaviour this whole feature exists to remove.
  const h1 = homeDir('def1'), h2 = homeDir('def2');
  const seats = [
    { id: 'codex-1', vendor: 'codex', label: 'Personal', home: h1 },
    { id: 'codex-2', vendor: 'codex', label: 'Team', home: h2 },
  ];
  const first = shortcutsFromSeats(seats);
  ok('with nothing chosen, the first seat is the default',
     first.find((s) => s.isDefault).id === 'codex-1');

  const chosen = shortcutsFromSeats(seats, { defaultId: 'codex-2' });
  ok('an explicit default wins', chosen.find((s) => s.isDefault).id === 'codex-2');
  ok('...and only one seat is ever the default',
     chosen.filter((s) => s.isDefault).length === 1);

  // Reordering must not move the default off the chosen seat.
  const reordered = shortcutsFromSeats([seats[1], seats[0]], { defaultId: 'codex-2' });
  ok('reordering the registry does not change which seat bare codex bills',
     reordered.find((s) => s.isDefault).id === 'codex-2');

  const bogus = shortcutsFromSeats(seats, { defaultId: 'no-such-seat' });
  ok('a stale defaultId falls back rather than leaving none',
     bogus.filter((s) => s.isDefault).length === 1);

  // The export is what reaches non-shell children (node spawns, scripts).
  const text = renderShortcuts(chosen);
  ok('the generated file exports CODEX_HOME for the default seat',
     /^export CODEX_HOME=/m.test(text), text.split('\n').slice(0, 20).join('\n'));
  const file = path.join(tmp, 'default.zsh');
  fs.writeFileSync(file, text);
  const out = execFileSync('zsh', ['-f', '-c',
    `source ${JSON.stringify(file)}; printenv CODEX_HOME`], { encoding: 'utf8' }).trim();
  ok('CODEX_HOME is exported to the chosen seat', out === h2, `${out} (wanted ${h2})`);
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

// --- uninstall is reversible even when the block is not last ----------------
{
  // Review finding: uninstall skipped EVERY following comment line and greedily
  // stripped preceding blanks, so anything the user appended after the ACS
  // block was eaten. This is the only edit made to a file a human owns.
  const fakeHome = homeDir('zafter');
  const zshenv = path.join(fakeHome, '.zshenv');
  const before = '# mine\nexport EDITOR=vim\n\n';
  const after = '\n# my own notes below\n# another note\nalias gs="git status"\n';
  fs.writeFileSync(zshenv, before);
  install({ zshenv, file: path.join(tmp, 'seats.zsh') });
  fs.appendFileSync(zshenv, after);

  uninstall({ zshenv });
  const left = fs.readFileSync(zshenv, 'utf8');
  ok('the user\'s own comments after the block survive', /my own notes below/.test(left), left);
  ok('...and their alias survives', /alias gs=/.test(left), left);
  ok('...and nothing of ours is left', !/agent-config-studio: seat shortcuts/.test(left));
  ok('...and their own blank line is preserved',
     left.startsWith('# mine\nexport EDITOR=vim\n\n'), JSON.stringify(left.slice(0, 40)));
}

// --- a seat word can never shadow a codex subcommand ------------------------
{
  // Review finding: the wrapper matches the first argument, so a seat labelled
  // "Login" or "Review Team" derived a word that silently turned `codex login`
  // into a seat switch.
  for (const sub of ['login', 'logout', 'resume', 'exec', 'review', 'doctor', 'apply', 'fork']) {
    ok(`"${sub}" is refused as a seat word`, validateWord(sub) !== null, 'ACCEPTED — shadows a subcommand');
  }
  const seats = [{ id: 'a', vendor: 'codex', label: 'Login Account', home: homeDir('sub1') }];
  ok('a label starting with a subcommand does not derive one',
     shortcutsFromSeats(seats)[0].word !== 'login', shortcutsFromSeats(seats)[0].word);
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
