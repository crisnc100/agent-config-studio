/**
 * The folder registry (builds/configurable-roots/plan.md): lib/roots.js and
 * `acs roots`, against temp HOMEs only. Every rejection rule is driven through
 * both validateRoot() and the real CLI, and a rejected add must leave
 * roots.json byte-identical. Also migration and the setup marker (B13),
 * unavailable-vs-invalid entries and an unreadable file (B8), concurrent
 * writers (B9), relative paths (B10), and realpath'd roots and HOME (F1).
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACS = path.join(ROOT, 'bin', 'acs');
const realHome = os.homedir();
const realBefore = snapshotRealHomes();

const R = await import('../lib/roots.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const temps = [];
/** A fresh temp HOME, realpath'd unless asked for the symlinked spelling. */
function mkHome(tag, { raw = false } = {}) {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), `acs-roots-${tag}-`));
  temps.push(made);
  return raw ? made : fs.realpathSync(made);
}
const mk = (...p) => { fs.mkdirSync(path.join(...p), { recursive: true }); return path.join(...p); };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

const cliEnv = (home) => ({ ...process.env, HOME: home, NO_COLOR: '1', ACS_NO_UPDATE: '1' });
function cli(home, args, { cwd = home } = {}) {
  try {
    const out = execFileSync('/bin/sh', [ACS, 'roots', ...args], { cwd, encoding: 'utf8', env: cliEnv(home), stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) { return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` }; }
}

console.log('\nroots');
ok('the real HOME is never the one under test', !temps.includes(realHome));

/* ── migration and the setup marker (B13) ─────────────────────────────── */
{
  const H = mkHome('legacy');
  mk(H, 'Documents', 'Projects'); mk(H, 'Documents', 'Garman-Homes');
  const before = R.loadRoots({ home: H });
  ok('M1 with no roots.json, reads see the legacy folders without writing anything',
     before.state === 'absent' && before.roots.map((r) => `${r.id}:${r.access}`).join(',') === 'projects:edit,garman-homes:read'
     && !fs.existsSync(R.rootsPath(H)), JSON.stringify(before));
  const m = R.migrateRoots({ home: H });
  const file = JSON.parse(read(R.rootsPath(H)));
  ok('M2 migration writes exactly the two legacy folders, edit and read',
     m.migrated && file.version === 1 && JSON.stringify(file.roots) === JSON.stringify([
       { id: 'projects', path: path.join(H, 'Documents', 'Projects'), label: 'Projects', access: 'edit' },
       { id: 'garman-homes', path: path.join(H, 'Documents', 'Garman-Homes'), label: 'Garman Homes', access: 'read' },
     ]), JSON.stringify(file));
  ok('M3 …written 0600', (fs.statSync(R.rootsPath(H)).mode & 0o777) === 0o600);
  ok('M4 B13 a migrated machine is marked set up (setup.json completed: migrated)',
     JSON.parse(read(R.setupPath(H)) || '{}').completed === 'migrated');
  const again = R.migrateRoots({ home: H });
  ok('M5 migration runs once: a second start changes nothing', !again.migrated && JSON.stringify(JSON.parse(read(R.rootsPath(H)))) === JSON.stringify(file));
}
{
  const H = mkHome('fresh');
  const m = R.migrateRoots({ home: H });
  ok('M6 B13 a fresh machine gets an empty roots.json and NO setup marker',
     m.migrated && JSON.parse(read(R.rootsPath(H))).roots.length === 0 && !fs.existsSync(R.setupPath(H)));
  const H2 = mkHome('fresh-add');
  const target = mk(H2, 'code', 'work');
  const r = cli(H2, ['add', target, '--edit']);
  ok('M7 B13 the first CLI add on a fresh machine writes roots.json but still no setup marker',
     r.code === 0 && JSON.parse(read(R.rootsPath(H2))).roots.length === 1 && !fs.existsSync(R.setupPath(H2)), r.out);
  const H3 = mkHome('legacy-add');
  mk(H3, 'Documents', 'Projects');
  const other = mk(H3, 'code', 'x');
  const r3 = cli(H3, ['add', other]);
  const ids = JSON.parse(read(R.rootsPath(H3)) || '{"roots":[]}').roots.map((x) => x.id);
  ok('M8 a CLI add before the first start seeds the legacy folder too (and marks setup, as migration would)',
     r3.code === 0 && ids.join(',') === 'projects,x' && fs.existsSync(R.setupPath(H3)), `${r3.out} ${ids}`);
}

/* ── every rejection rule, through validateRoot AND the CLI ────────────── */
{
  const H = mkHome('reject');
  mk(H, '.claude', 'skills'); mk(H, '.codex'); mk(H, '.ssh', 'keys'); mk(H, '.agent-config-studio', 'history');
  mk(H, '.config', 'worktree');
  const work = mk(H, 'code', 'work');
  const nested = mk(H, 'code', 'work', 'inner');
  const parentOfWork = path.join(H, 'code');
  const aFile = path.join(H, 'code', 'file.txt'); fs.writeFileSync(aFile, 'x');
  const outside = mkHome('outside-target');
  // Seed one existing root so overlap and duplicate rules have something to hit.
  ok('R0 seed: an edit folder inside HOME is accepted', cli(H, ['add', work, '--edit']).code === 0);
  const existing = R.loadRoots({ home: H }).roots;
  const fileBefore = read(R.rootsPath(H));

  const cases = [
    ['a path that does not exist', { path: path.join(H, 'nope'), access: 'read' }, /does not exist/],
    ['a path that is a file, not a folder', { path: aFile, access: 'read' }, /is not a folder/],
    ['the filesystem root', { path: '/', access: 'read' }, /filesystem root/],
    ['$HOME itself', { path: H, access: 'read' }, /home folder itself/],
    ['a folder inside ~/.claude', { path: path.join(H, '.claude', 'skills'), access: 'read' }, /inside ~\/\.claude, which the studio already manages/],
    ['~/.codex itself', { path: path.join(H, '.codex'), access: 'read' }, /inside ~\/\.codex/],
    ['a folder inside ~/.config/worktree', { path: mk(H, '.config', 'worktree', 'repos'), access: 'read' }, /inside ~\/\.config\/worktree/],
    ['a folder inside ~/.agent-config-studio', { path: path.join(H, '.agent-config-studio', 'history'), access: 'read' }, /inside ~\/\.agent-config-studio/],
    ['an ancestor of the built-in homes (HOME\'s parent)', { path: path.dirname(H), access: 'read' }, /contains ~\/\.claude|home folder/],
    ['~/.ssh', { path: path.join(H, '.ssh'), access: 'read' }, /~\/\.ssh holds your keys/],
    ['a folder under ~/.ssh', { path: path.join(H, '.ssh', 'keys'), access: 'read' }, /inside ~\/\.ssh/],
    ['an edit folder outside HOME', { path: outside, access: 'edit' }, /outside your home folder — an edit folder must be inside it/],
    ['a folder inside an existing root', { path: nested, access: 'read' }, /is inside "work"/],
    ['a folder containing an existing root', { path: parentOfWork, access: 'read' }, /contains "work"/],
    ['a duplicate of an existing root', { path: work, access: 'read' }, /already registered as "work"/],
  ];
  for (const [what, root, re] of cases) {
    const why = R.validateRoot({ id: 'candidate', label: 'Candidate', ...root }, existing, { home: H });
    ok(`R validateRoot rejects ${what} with a plain reason`, typeof why === 'string' && re.test(why), why);
    const args = ['add', root.path, ...(root.access === 'edit' ? ['--edit'] : [])];
    const r = cli(H, args);
    ok(`R the CLI rejects ${what} the same way`, r.code !== 0 && re.test(r.out) && !/at .*\.js:\d+/.test(r.out), r.out);
    ok(`R …and roots.json is byte-identical after it`, read(R.rootsPath(H)) === fileBefore);
  }
  ok('R a read folder outside HOME is accepted (read roots may live anywhere)',
     R.validateRoot({ id: 'shared', label: 'Shared', path: outside, access: 'read' }, existing, { home: H }) === null);
  ok('R a bad id, label or access is refused by validateRoot',
     /id must be/.test(R.validateRoot({ id: 'Bad Id', label: 'x', path: work, access: 'read' }, [], { home: H }))
     && /label must be/.test(R.validateRoot({ id: 'x', label: '', path: work, access: 'read' }, [], { home: H }))
     && /access must be/.test(R.validateRoot({ id: 'x', label: 'x', path: work, access: 'write' }, [], { home: H })));
  for (const id of ['project', 'global-claude', 'global-codex', 'global-agents', 'global', 'codex', 'agents']) {
    const why = R.validateRoot({ id, label: 'X', path: mk(H, 'reserved', id), access: 'read' }, existing, { home: H });
    ok(`R B11 validateRoot rejects the reserved id "${id}" (a skill source or export token)`, /is reserved/.test(why || ''), why);
  }
  ok('R a relative path is refused by validateRoot (B10: roots.json holds absolute paths only)',
     /not an absolute path/.test(R.validateRoot({ id: 'x', label: 'x', path: 'code/work', access: 'read' }, [], { home: H })));

  // Through a symlink: a link inside HOME that points into ~/.claude is judged by where it lands.
  fs.symlinkSync(path.join(H, '.claude', 'skills'), path.join(H, 'sneaky'));
  const viaLink = R.validateRoot({ id: 'sneaky', label: 'Sneaky', path: path.join(H, 'sneaky'), access: 'read' }, existing, { home: H });
  ok('R a symlink into a built-in home is rejected by where it really is', /inside ~\/\.claude/.test(viaLink || ''), viaLink);
}

/* ── B11: reserved ids, through the CLI and in a hand-edited file ──────── */
{
  const H = mkHome('reserved');
  const proj = mk(H, 'code', 'project');
  const r = cli(H, ['add', proj]);
  const r2 = cli(H, ['add', mk(H, 'code', 'x'), '--label', 'Codex']);
  const ids = JSON.parse(read(R.rootsPath(H))).roots.map((x) => x.id);
  ok('B11 a folder named "project" gets a free id, never the reserved one', r.code === 0 && ids.includes('project-2') && !ids.includes('project'), `${r.out} ${ids}`);
  ok('B11 …and a label "Codex" does not become the id "codex"', r2.code === 0 && ids.includes('codex-2') && !ids.includes('codex'), `${r2.out} ${ids}`);
  const f = JSON.parse(read(R.rootsPath(H)));
  f.roots.push({ id: 'global-claude', path: mk(H, 'code', 'sneaky'), label: 'Sneaky', access: 'read' });
  fs.writeFileSync(R.rootsPath(H), JSON.stringify(f));
  const l = R.loadRoots({ home: H });
  ok('B11 a hand-edited entry with a reserved id is reported invalid and skipped',
     l.invalid.some((x) => x.entry.id === 'global-claude' && /reserved/.test(x.reason)) && !l.roots.some((x) => x.id === 'global-claude'));
}

/* ── B10: the CLI anchors relative and ~ paths before validating ───────── */
{
  const H = mkHome('relative');
  const work = mk(H, 'code', 'rel-work');
  const r = cli(H, ['add', 'rel-work', '--edit'], { cwd: path.join(H, 'code') });
  const tl = cli(H, ['add', '~/code2', '--label', 'Two'], { cwd: '/' });
  mk(H, 'code2');
  const tl2 = cli(H, ['add', '~/code2', '--label', 'Two'], { cwd: '/' });
  const roots = JSON.parse(read(R.rootsPath(H))).roots;
  ok('B10 a relative path is stored absolute, resolved against the caller\'s cwd',
     r.code === 0 && roots.find((x) => x.id === 'rel-work')?.path === work, `${r.out} ${JSON.stringify(roots)}`);
  ok('B10 ~ expands to HOME (and a missing folder is refused first)',
     tl.code !== 0 && tl2.code === 0 && roots.find((x) => x.id === 'two')?.path === path.join(H, 'code2'), tl2.out);
  ok('B10 adding an edit folder prints what that grants', /may now open, save, create and delete/.test(r.out), r.out);
  const ls = cli(H, ['ls']);
  ok('B10 acs roots ls lists both with access and path', ls.code === 0 && /rel-work\s+edit\s+~\/code\/rel-work/.test(ls.out) && /two\s+read\s+~\/code2/.test(ls.out), ls.out);
  const rm = cli(H, ['rm', 'two']);
  ok('rm removes by id and leaves the folder alone',
     rm.code === 0 && !JSON.parse(read(R.rootsPath(H))).roots.some((x) => x.id === 'two') && fs.existsSync(path.join(H, 'code2')), rm.out);
  const rm2 = cli(H, ['rm', 'two']);
  ok('rm of an unknown id is a plain refusal', rm2.code !== 0 && /no folder with id "two"/.test(rm2.out), rm2.out);

  // A relative entry hand-written into the file is invalid, not resolved against the server's cwd.
  const f = JSON.parse(read(R.rootsPath(H)));
  f.roots.push({ id: 'relative', path: 'code/rel-work-2', label: 'Rel', access: 'read' });
  fs.writeFileSync(R.rootsPath(H), JSON.stringify(f));
  const l = R.loadRoots({ home: H });
  ok('B10 a relative path in roots.json is reported invalid and skipped',
     l.invalid.some((x) => x.entry.id === 'relative' && /not an absolute path/.test(x.reason)) && !l.roots.some((x) => x.id === 'relative'));
}

/* ── B8 / AC7: missing is not invalid; an unreadable file is an error ──── */
{
  const H = mkHome('b8');
  const a = mk(H, 'code', 'a');
  const vol = mk(H, 'vol', 'shared');
  cli(H, ['add', a, '--edit']);
  cli(H, ['add', vol]);
  fs.rmSync(vol, { recursive: true });
  let l = R.loadRoots({ home: H });
  const d = R.derive({ home: H });
  ok('B8 a folder that disappeared stays in roots.json, marked missing, and is inactive',
     l.roots.find((x) => x.id === 'shared')?.status === 'missing' && !d.allRoots.includes(path.join(H, 'vol', 'shared'))
     && d.editRoots.includes(a), JSON.stringify(l.roots));
  const b = mk(H, 'code', 'b');
  cli(H, ['add', b]);
  ok('B8 an unrelated add keeps the missing entry', JSON.parse(read(R.rootsPath(H))).roots.some((x) => x.id === 'shared'));
  mk(H, 'vol', 'shared');
  ok('B8 the folder coming back makes it active again, with no edit to the file',
     R.loadRoots({ home: H }).roots.find((x) => x.id === 'shared')?.status === 'ok' && R.derive({ home: H }).readRoots.includes(vol));

  // Hand-edited entries failing validation are dropped and reported; valid ones load.
  const f = JSON.parse(read(R.rootsPath(H)));
  f.roots.push({ id: 'evil', path: path.join(H, '.ssh'), label: 'Keys', access: 'read' });
  f.roots.push({ id: 'whole-home', path: H, label: 'Home', access: 'edit' });
  f.roots.push({ id: 'Bad', path: b, label: 'Dup', access: 'read' });
  f.roots.push('not an object');
  fs.writeFileSync(R.rootsPath(H), JSON.stringify(f));
  l = R.loadRoots({ home: H });
  ok('AC7 hand-edited entries failing validation are dropped and reported, valid ones still load',
     l.state === 'ok' && l.invalid.length === 4 && ['a', 'shared', 'b'].every((id) => l.roots.some((x) => x.id === id))
     && !R.derive({ home: H }).allRoots.includes(H), JSON.stringify(l.invalid.map((x) => x.reason)));

  const good = read(R.rootsPath(H));
  fs.writeFileSync(R.rootsPath(H), '{ "version": 1, "roots": [ oops');
  const broken = read(R.rootsPath(H));
  l = R.loadRoots({ home: H });
  const dd = R.derive({ home: H });
  ok('AC7 invalid JSON is an error state, not a crash, with no roots active',
     l.state === 'error' && /not valid/.test(l.error) && dd.allRoots.length === 0 && dd.safeRoots.length === dd.builtinHomes.length, l.error);
  const add = cli(H, ['add', mk(H, 'code', 'c')]);
  const rm = cli(H, ['rm', 'a']);
  ok('B8 the CLI refuses to add or remove against an unreadable file…', add.code !== 0 && rm.code !== 0 && /not valid/.test(add.out) && /not valid/.test(rm.out), add.out);
  ok('B8 …and never overwrites it', read(R.rootsPath(H)) === broken);
  const mig = R.migrateRoots({ home: H });
  ok('B8 migration never overwrites an unreadable file either', !mig.migrated && read(R.rootsPath(H)) === broken);
  const ls = cli(H, ['ls']);
  ok('B8 acs roots ls reports the error', ls.code !== 0 && /not valid/.test(ls.out), ls.out);
  fs.writeFileSync(R.rootsPath(H), good);
}

/* ── B9: concurrent writers ────────────────────────────────────────────── */
{
  const H = mkHome('b9');
  const dirs = Array.from({ length: 6 }, (_, i) => mk(H, 'many', `p${i}`));
  R.migrateRoots({ home: H });
  const run = promisify(execFile);
  const results = await Promise.allSettled(dirs.map((d) => run('/bin/sh', [ACS, 'roots', 'add', d], { env: cliEnv(H) })));
  const ids = JSON.parse(read(R.rootsPath(H))).roots.map((x) => x.id).sort();
  ok('B9 six parallel `acs roots add` all succeed and all persist',
     results.every((r) => r.status === 'fulfilled') && ids.join(',') === 'p0,p1,p2,p3,p4,p5', `${ids} ${results.map((r) => r.status)}`);
  ok('B9 no lock file is left behind', !fs.existsSync(R.rootsPath(H) + '.lock'));

  const lock = R.rootsPath(H) + '.lock';
  fs.writeFileSync(lock, '99999\n');
  const old = (Date.now() - 60_000) / 1000;
  fs.utimesSync(lock, old, old);
  const r = cli(H, ['add', mk(H, 'many', 'after-crash')]);
  ok('B9 a stale lock (a crashed writer, >10s old) is recovered', r.code === 0 && !fs.existsSync(lock), r.out);
  fs.writeFileSync(lock, `${process.pid}\n`);
  let held = null;
  try { R.addRoot({ path: mk(H, 'many', 'blocked') }, { home: H, waitMs: 200 }); } catch (e) { held = e.message; }
  ok('B9 a live lock makes a writer wait and then refuse plainly', /locked by another writer/.test(held || ''), held);
  fs.unlinkSync(lock);
}

/* ── F1: realpath'd roots and HOME ─────────────────────────────────────── */
{
  // os.tmpdir() on macOS is /var/folders/…, itself a symlink to /private/var.
  const raw = mkHome('symhome', { raw: true });
  const real = fs.realpathSync(raw);
  mk(raw, '.claude');
  const work = mk(raw, 'code', 'work');
  R.addRoot({ path: work, access: 'edit' }, { home: raw });
  const d = R.derive({ home: raw });
  ok('F1 built-in homes are realpath\'d', d.builtinHomes[0] === path.join(real, '.claude'), d.builtinHomes[0]);
  ok('F1 an edit root under a symlinked HOME is accepted and compared by realpath',
     d.editRoots[0] === path.join(real, 'code', 'work') && d.safeRoots.includes(path.join(real, 'code', 'work')), JSON.stringify(d.editRoots));
  ok('F1 (this machine really does have a symlinked tmpdir, or the check is moot)', raw !== real || process.platform !== 'darwin', `${raw} ${real}`);

  const H = mkHome('symroot');
  const target = mk(H, 'volumes', 'disk', 'code');
  fs.symlinkSync(target, path.join(H, 'code-link'));
  R.addRoot({ path: path.join(H, 'code-link'), access: 'edit' }, { home: H });
  const d2 = R.derive({ home: H });
  const stored = JSON.parse(read(R.rootsPath(H))).roots[0].path;
  ok('F1 a root whose path is a symlink is stored as typed and active at its realpath',
     stored === path.join(H, 'code-link') && d2.editRoots[0] === target, `${stored} ${d2.editRoots}`);
  let why = R.validateRoot({ id: 'again', label: 'Again', path: target, access: 'read' }, R.loadRoots({ home: H }).roots, { home: H });
  ok('F1 the link and its target are the same folder: a duplicate', /already registered/.test(why || ''), why);
}

/* ── derive: the lists consumers take ─────────────────────────────────── */
{
  const H = mkHome('derive');
  const work = mk(H, 'code', 'work');
  const shared = mkHome('derive-shared');
  R.addRoot({ path: work, access: 'edit', label: 'Work' }, { home: H });
  R.addRoot({ path: shared, access: 'read', label: 'Shared' }, { home: H });
  const d = R.derive({ home: H });
  ok('D1 safeRoots is the built-in homes plus edit roots — never a read root, never the studio\'s own folder',
     d.safeRoots.includes(work) && !d.safeRoots.includes(shared) && !d.safeRoots.some((p) => p.endsWith('.agent-config-studio'))
     && ['.claude', '.codex', '.agents', '.grok', path.join('.config', 'worktree')].every((n) => d.safeRoots.includes(path.join(H, n))));
  ok('D2 editRoots / readRoots / allRoots', d.editRoots.join() === work && d.readRoots.join() === shared && d.allRoots.join() === [work, shared].join());
  ok('D3 the context table carries id, dir, label and editable',
     JSON.stringify(d.contextRoots) === JSON.stringify([
       { id: 'work', dir: work, label: 'Work', editable: true },
       { id: 'shared', dir: shared, label: 'Shared', editable: false },
     ]), JSON.stringify(d.contextRoots));
}

for (const t of temps) { try { fs.rmSync(t, { recursive: true, force: true }); } catch {} }
assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
