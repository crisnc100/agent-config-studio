/**
 * "Scan for projects" and the discovery walks' caps (builds/setup-screen
 * criterion 6, S4, S5, S13), on temp HOMEs:
 *
 *   - a fixture tree yields exactly the expected suggestions, each the
 *     immediate parent of its projects, with direct-child counts; a `.git`
 *     file counts; dot-dirs, node_modules, symlinked dirs and repo insides are
 *     skipped; nested suggestions are both kept (no collapse); starting folders are
 *     de-duplicated by realpath (a symlinked one followed once, a case alias
 *     folded); registered folders show as added or covered; an unreadable
 *     folder is reported as blocked; a symlink loop terminates; depth is 3
 *   - a directory of 200,000 files and a tree past 5,000 directories each
 *     return within 3.5 s with truncated: true
 *   - through the server: GET /api/setup/scan answers, a second concurrent
 *     request joins the first; adding that 200,000-file folder as an edit
 *     root never holds /api/health for 3 s, and Folders reports it as
 *     partially indexed
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { startServer } from './fixtures/roots-home.mjs';
import { scan, scanOnce } from '../lib/setup-scan.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realHome = os.homedir();
const realBefore = snapshotRealHomes();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const temps = [];
const mkTemp = (tag) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `acs-scan-${tag}-`))); temps.push(d); return d; };
const mk = (...p) => { fs.mkdirSync(path.join(...p), { recursive: true }); return path.join(...p); };
const put = (f, body = '') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };

console.log('\nsetup: scan');

/* ── the fixture tree ──────────────────────────────────────────────────── */
{
  const H = mkTemp('tree');
  const elsewhere = mkTemp('elsewhere');
  ok('the real HOME is never a test HOME', H !== realHome);
  // ~/code/work: two repos (one a worktree's .git FILE) and a context-only folder.
  mk(H, 'code', 'work', 'app1', '.git');
  put(path.join(H, 'code', 'work', 'app2', '.git'), 'gitdir: /somewhere/else\n');
  put(path.join(H, 'code', 'work', 'notes', 'CLAUDE.md'), '# notes\n');
  put(path.join(H, 'code', 'work', 'app1', 'packages', 'x', 'CLAUDE.md'), '# inside a repo\n');
  mk(H, 'code', 'work', 'plain');
  // Skipped: dot-dirs, node_modules, a symlinked dir (its target holds a repo).
  mk(H, 'code', '.hidden', 'r', '.git');
  mk(H, 'code', 'node_modules', 'pkg', '.git');
  mk(elsewhere, 'outside-parent', 'r', '.git');
  fs.symlinkSync(path.join(elsewhere, 'outside-parent'), path.join(H, 'code', 'linked'));
  // A loop: ~/code/work/plain/back -> ~/code
  fs.symlinkSync(path.join(H, 'code'), path.join(H, 'code', 'work', 'plain', 'back'));
  // Nested: ~/dev/workspace holds a CLAUDE.md AND a repo — ~/dev must not be offered.
  put(path.join(H, 'dev', 'workspace', 'CLAUDE.md'), '# ws\n');
  mk(H, 'dev', 'workspace', 'r', '.git');
  // Too deep: ~/src/a/b/c/d/repo
  mk(H, 'src', 'a', 'b', 'c', 'd', 'repo', '.git');
  // A symlinked starting folder, pointing at one already scanned.
  fs.symlinkSync(path.join(H, 'code'), path.join(H, 'repos'));
  // Registered: ~/git/mine exactly, and ~/GitHub/big/inner under a suggestion.
  mk(H, 'git', 'mine', 'p', '.git');
  mk(H, 'GitHub', 'big', 'inner', '.git');
  mk(H, 'GitHub', 'big', 'other', '.git');
  // Unreadable.
  mk(H, 'workspace', 'locked', 'r', '.git');
  fs.chmodSync(path.join(H, 'workspace', 'locked'), 0o000);

  const display = (p) => (p.startsWith(H) ? '~' + p.slice(H.length) : p);
  const t0 = Date.now();
  const r = await scan({ home: H, registered: [path.join(H, 'git', 'mine'), path.join(H, 'GitHub', 'big', 'inner')], display });
  const took = Date.now() - t0;
  fs.chmodSync(path.join(H, 'workspace', 'locked'), 0o700);
  const by = Object.fromEntries(r.suggestions.map((s) => [s.display, s]));
  const names = r.suggestions.map((s) => s.display).sort();
  ok('6 S13 exactly the expected suggestions', JSON.stringify(names) === JSON.stringify(['~/GitHub/big', '~/code/work', '~/dev', '~/dev/workspace', '~/git/mine']), JSON.stringify(names));
  ok('6 S13 counts are of direct children; a .git FILE counts as a repo',
     by['~/code/work']?.repos === 2 && by['~/code/work'].contextFiles === 1, JSON.stringify(by['~/code/work']));
  ok('S13 nested suggestions are both kept: ~/dev (for workspace\'s CLAUDE.md) and ~/dev/workspace (for its repo)',
     by['~/dev']?.contextFiles === 1 && by['~/dev'].repos === 0 && by['~/dev/workspace']?.repos === 1);
  ok('6 dot-dirs, node_modules and symlinked dirs are ignored; repo insides are not walked',
     !names.some((n) => /hidden|node_modules|linked|outside|packages/.test(n)));
  ok('6 depth stops at 3', !names.some((n) => n.startsWith('~/src')));
  ok('S13 a symlinked starting folder is followed once and de-duplicated by realpath', names.filter((n) => n === '~/code/work').length === 1);
  ok('S13 an exactly-registered folder shows as added', by['~/git/mine']?.status === 'added');
  ok('S13 a folder overlapping a registered one is "covered", not offered',
     by['~/GitHub/big']?.status === 'covered' && by['~/GitHub/big'].coveredBy === '~/GitHub/big/inner', JSON.stringify(by['~/GitHub/big']));
  ok('6 S13 an unreadable folder is reported as blocked, in plain words, not as an error',
     r.blocked.some((b) => b.path === '~/workspace/locked' && /^permission denied/.test(b.reason) && (process.platform !== 'darwin' || /macOS may ask/.test(b.reason))), JSON.stringify(r.blocked));
  ok('6 a symlink loop terminates, the scan is not truncated, and it is quick', !r.truncated && took < 3000, `${took} ms truncated=${r.truncated}`);

  // A case alias: on a volume that folds case, ~/Code IS ~/code.
  const folds = fs.existsSync(path.join(H, 'CODE'));
  if (folds) {
    const r2 = await scan({ home: H, display });
    ok('S13 on a case-insensitive volume, ~/code and ~/Code are scanned once', r2.suggestions.filter((s) => s.display.toLowerCase() === '~/code/work').length === 1);
  } else {
    mk(H, 'Code', 'side', 'r', '.git');
    const r2 = await scan({ home: H, display });
    ok('S13 on a case-sensitive volume, ~/Code is its own folder', r2.suggestions.some((s) => s.display === '~/Code/side'));
  }
}

/* ── S13: every project's immediate parent, nothing collapsed ─────────── */
{
  const H = mkTemp('parents');
  mk(H, 'code', 'one', '.git');
  mk(H, 'code', 'group', 'two', '.git');
  const display = (p) => '~' + p.slice(H.length);
  const r = await scan({ home: H, display });
  const names = r.suggestions.map((s) => s.display).sort();
  ok('S13 code/one/.git and code/group/two/.git suggest both ~/code and ~/code/group', JSON.stringify(names) === JSON.stringify(['~/code', '~/code/group']), JSON.stringify(names));
  const after = await scan({ home: H, display, registered: [path.join(H, 'code')] });
  const by = Object.fromEntries(after.suggestions.map((s) => [s.display, s]));
  ok('S13 once the outer one is added, the inner one reads covered', by['~/code']?.status === 'added' && by['~/code/group']?.status === 'covered', JSON.stringify(after.suggestions));
}

/* ── S4 / S5: the slot and the timer ───────────────────────────────────── */
{
  const H = mkTemp('slot');
  for (let i = 0; i < 5; i++) mk(H, 'code', `d${i}`);
  // fs.promises, but every opendir takes 400 ms: the walk outlives the answer.
  let open = 0, most = 0;
  const fsp = fs.promises;
  const slow = { ...fsp, realpath: fsp.realpath, stat: fsp.stat,
    opendir: async (d) => { open++; most = Math.max(most, open); try { await sleep(400); return await fsp.opendir(d); } finally { open--; } } };
  const opts = { home: H, io: slow, limits: { timeMs: 100 } };
  const t0 = Date.now();
  const first = await scanOnce(opts);
  const took = Date.now() - t0;
  const second = await scanOnce(opts);
  ok('S4 a timed-out scan answers on time, truncated', first.truncated && took < 1000, `${took} ms`);
  ok('S4 a scan asked while that walk is still running gets busy — no second walk', second.busy === true && most === 1, `busy=${second.busy} most=${most}`);
  while (open) await sleep(50);
  await sleep(50);
  const third = await scanOnce({ home: H });
  ok('S4 once the walk has really ended, the slot is free again', !third.busy && Array.isArray(third.suggestions));

  // Finding the starting folders is under the timer too.
  const stuck = { ...fsp, realpath: async (p) => { await sleep(2000); return fsp.realpath(p); } };
  const t1 = Date.now();
  const r = await scan({ home: H, io: stuck, limits: { timeMs: 300 } });
  ok('S5 a slow realpath on the starting folders still answers within the deadline', Date.now() - t1 < 1000 && r.truncated, `${Date.now() - t1} ms`);
}

/* ── the caps ──────────────────────────────────────────────────────────── */
const wideHome = mkTemp('wide');
const wide = mk(wideHome, 'git', 'wide');
{
  const t = Date.now();
  for (let i = 0; i < 200_000; i++) fs.writeFileSync(path.join(wide, `f${i}`), '');
  console.log(`  (made 200,000 files in ${Date.now() - t} ms)`);
  mk(wide, 'z-repo', '.git');
  const t0 = Date.now();
  const r = await scan({ home: wideHome });
  const took = Date.now() - t0;
  ok('S5 a 200,000-file directory returns within 3.5 s with truncated: true', took < 3500 && r.truncated && r.scanned.entries <= 50_000, `${took} ms ${JSON.stringify(r.scanned)}`);
}
{
  const H = mkTemp('many');
  for (let i = 0; i < 80; i++) for (let j = 0; j < 70; j++) mk(H, 'code', `d${i}`, `e${j}`);
  const t0 = Date.now();
  const r = await scan({ home: H });
  const took = Date.now() - t0;
  ok('6 S5 a tree past 5,000 directories returns within 3.5 s with truncated: true', took < 3500 && r.truncated && r.scanned.dirs <= 5000, `${took} ms ${JSON.stringify(r.scanned)}`);
}
{
  const H = mkTemp('cap50');
  for (let i = 0; i < 60; i++) mk(H, 'code', `group${String(i).padStart(2, '0')}`, 'r', '.git');
  const r = await scan({ home: H });
  ok('S5 at most 50 suggestions, and truncated says there were more', r.suggestions.length === 50 && r.truncated, `${r.suggestions.length} ${r.truncated}`);
}

/* ── through the server ────────────────────────────────────────────────── */
{
  mk(wideHome, 'code', 'team', 'svc', '.git');
  const srv = await startServer(wideHome, { root: ROOT });
  ok('the server boots', srv.up, srv.log().slice(-300));
  const get = (p) => fetch(srv.base + p).then(async (r) => ({ status: r.status, json: await r.json() }));
  const [a, b] = await Promise.all([get('/api/setup/scan'), get('/api/setup/scan')]);
  ok('S4 two concurrent scans: both answer, and the second joined the first',
     a.status === 200 && b.status === 200 && JSON.stringify(a.json) === JSON.stringify(b.json), `${a.status} ${b.status}`);
  ok('6 the route returns suggestions in display form', a.json.suggestions.some((s) => s.display === '~/code/team' && s.repos === 1), JSON.stringify(a.json.suggestions));

  // S5: adding a 200,000-file edit root never freezes the server.
  let worst = 0, stop = false;
  const probe = (async () => {
    while (!stop) {
      const h0 = Date.now();
      try { await fetch(`${srv.base}/api/health`).then((r) => r.json()); } catch {}
      worst = Math.max(worst, Date.now() - h0);
      await sleep(50);
    }
  })();
  const pv = await fetch(`${srv.base}/api/roots/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: wide }) }).then((r) => r.json());
  const add = await fetch(`${srv.base}/api/roots/add`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: wide, access: 'edit', confirm: pv.canonical }) });
  ok('S5 the large edit folder is added', add.status === 200, await add.text());
  await get('/api/registry');
  await get('/api/context');
  await sleep(3000);
  stop = true; await probe;
  ok('S5 /api/health is never held for 3 s while it is added and indexed', worst < 3000, `worst ${worst} ms`);
  const roots = await get('/api/roots');
  ok('S5 Folders reports it as partially indexed', roots.json.roots.some((r) => r.id === 'wide' && r.partial === true), JSON.stringify(roots.json.roots));

  // The same, on a loaded machine: two CPU hogs beside the server while a
  // second 200,000-file folder is added and indexed. The server's own
  // synchronous share must stay small however slow the machine is.
  const wide2 = mk(wideHome, 'git', 'wide2');
  for (let i = 0; i < 200_000; i++) fs.writeFileSync(path.join(wide2, `g${i}`), '');
  const { spawn } = await import('node:child_process');
  const hogs = [0, 1].map(() => spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' }));
  let worst2 = 0; stop = false;
  const probe2 = (async () => {
    while (!stop) {
      const h0 = Date.now();
      try { await fetch(`${srv.base}/api/health`).then((r) => r.json()); } catch {}
      worst2 = Math.max(worst2, Date.now() - h0);
      await sleep(50);
    }
  })();
  const pv2 = await fetch(`${srv.base}/api/roots/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: wide2 }) }).then((r) => r.json());
  const add2 = await fetch(`${srv.base}/api/roots/add`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: wide2, access: 'edit', confirm: pv2.canonical }) });
  const reg2 = await get('/api/registry');
  const ctx2 = await get('/api/context');
  ok('S5 …the registry and Context still answer (200) while it is indexed', reg2.status === 200 && ctx2.status === 200, `${reg2.status} ${ctx2.status}`);
  await sleep(4000);
  ok('S5 …and after indexing too', (await get('/api/registry')).status === 200);
  stop = true; await probe2;
  for (const h of hogs) h.kill('SIGKILL');
  ok('S5 under load (two CPU hogs), adding and indexing another 200,000-file folder holds /api/health under 1 s',
     add2.status === 200 && worst2 < 1000, `worst ${worst2} ms`);
  const roots2 = await get('/api/roots');
  ok('S5 …and it too is reported as partially indexed', roots2.json.roots.some((r) => r.id === 'wide2' && r.partial === true), JSON.stringify(roots2.json.roots));
  await srv.stop();
}

assertRealHomesUnchanged(realBefore, ok);
for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
