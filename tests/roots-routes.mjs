/**
 * Configurable roots through the real server (builds/configurable-roots/plan.md):
 * each scenario boots `node server.js` against its own temp HOME.
 *
 *   AC1   legacy folders, no roots.json: the first start writes exactly them
 *   AC2   custom roots (B12): read-root files reach Context, Skills and
 *         Worktrees, never the registry, search or history; writes follow access
 *   AC4   a symlinked HOME and a symlinked root work; a link out of every root 403s
 *   B1    an instruction file linked to a credential, a read root or outside
 *         never reaches the registry, search hits or the history repo
 *   B3    under a symlinked HOME: save → commit → versions → restore, byte-identical
 *   B4    worktree init refuses a project in a read root, naming the command
 *   AC7   hand-edited bad entries and invalid JSON never crash boot (B8)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { seedProjectTree, seedGlobals, legacyHome, startServer } from './fixtures/roots-home.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realHome = os.homedir();
const realBefore = snapshotRealHomes();

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const temps = [];
const mkTemp = (tag, { raw = false } = {}) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `acs-rr-${tag}-`));
  temps.push(d);
  return raw ? d : fs.realpathSync(d);
};
const writeRoots = (home, roots) => {
  fs.mkdirSync(path.join(home, '.agent-config-studio'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agent-config-studio', 'roots.json'), JSON.stringify({ version: 1, roots }, null, 2));
};
const registryPaths = (reg) => reg.groups.flatMap((g) => g.entries.flatMap((e) => e.files.map((f) => f.path)));
/** Every file in the history mirror, with its bytes. */
function historyFiles(home) {
  const repo = path.join(home, '.agent-config-studio', 'history');
  const out = new Map();
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out.set(path.relative(repo, p), fs.readFileSync(p, 'utf8'));
    }
  };
  walk(repo);
  // …and every blob ever committed, so a file mirrored then removed still counts.
  let blobs = '';
  try { blobs = execFileSync('git', ['-C', repo, 'log', '--all', '-p', '--format='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch {}
  return { files: out, everCommitted: blobs };
}

console.log('\nroots through the server');
ok('the real HOME is never a test HOME', !temps.includes(realHome));

/* ── AC1: first start on a legacy machine ──────────────────────────────── */
{
  const home = mkTemp('legacy');
  legacyHome(home);
  const srv = await startServer(home, { root: ROOT });
  ok('AC1 the server boots on a legacy HOME with no roots.json', srv.up, srv.log().slice(-400));
  const file = JSON.parse(fs.readFileSync(path.join(home, '.agent-config-studio', 'roots.json'), 'utf8'));
  ok('AC1 the first start writes exactly Projects (edit) and Garman-Homes (read)',
     JSON.stringify(file.roots.map((r) => [r.id, r.access, r.path])) === JSON.stringify([
       ['projects', 'edit', path.join(home, 'Documents', 'Projects')],
       ['garman-homes', 'read', path.join(home, 'Documents', 'Garman-Homes')],
     ]), JSON.stringify(file));
  ok('AC1 B13 …and marks setup done, since it migrated', fs.existsSync(path.join(home, '.agent-config-studio', 'setup.json')));
  ok('AC1 the banner lists the real folders', /folders\s+edit\s+~\/Documents\/Projects/.test(srv.log()) && /read\s+~\/Documents\/Garman-Homes/.test(srv.log()), srv.log());
  const roots = await srv.call('/api/roots');
  ok('AC1 /api/roots reports both, by label', roots.status === 200 && roots.json.state === 'ok'
     && roots.json.roots.map((r) => `${r.label}:${r.access}:${r.status}`).join() === 'Projects:edit:ok,Garman Homes:read:ok', roots.text);
  const skills = await srv.call('/api/skills');
  const src = new Set(skills.json.skills.map((s) => s.source));
  ok('AC1 B11 skill sources keep their values: project and garman-homes, with a rootId beside them',
     src.has('project') && src.has('garman-homes')
     && skills.json.skills.find((s) => s.source === 'garman-homes')?.rootId === 'garman-homes'
     && skills.json.skills.find((s) => s.source === 'project')?.rootId === 'projects', JSON.stringify([...src]));
  await srv.stop();
}

/* ── AC2 / B12: custom roots, no ~/Documents ───────────────────────────── */
{
  const home = mkTemp('custom');
  const elsewhere = mkTemp('elsewhere');
  seedGlobals(home);
  const work = path.join(home, 'code', 'work');
  const shared = path.join(elsewhere, 'shared');
  const w = seedProjectTree(work, 'work');
  const s = seedProjectTree(shared, 'shared');
  // B1 fixtures inside the edit root: links to a credential, into the read
  // root, and out of every root.
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"token":"CRED-SECRET-MARKER"}\n');
  const outside = mkTemp('outside');
  fs.writeFileSync(path.join(outside, 'CLAUDE.md'), '# OUTSIDE-SECRET-MARKER\n');
  for (const [dir, target] of [
    ['to-cred', path.join(home, '.codex', 'auth.json')],
    ['to-read-root', path.join(s.app, 'CLAUDE.md')],
    ['to-outside', path.join(outside, 'CLAUDE.md')],
  ]) {
    fs.mkdirSync(path.join(work, dir), { recursive: true });
    fs.symlinkSync(target, path.join(work, dir, 'CLAUDE.md'));
  }
  fs.mkdirSync(path.join(work, 'dir-link'), { recursive: true });
  fs.symlinkSync(s.app, path.join(work, 'dir-link', 'into-shared'));
  writeRoots(home, [
    { id: 'work', path: work, label: 'Work', access: 'edit' },
    { id: 'shared', path: shared, label: 'Shared', access: 'read' },
  ]);
  const srv = await startServer(home, { root: ROOT });
  ok('AC2 the server boots with custom roots and no ~/Documents', srv.up && !fs.existsSync(path.join(home, 'Documents')), srv.log().slice(-400));

  const reg = (await srv.call('/api/registry')).json;
  const paths = registryPaths(reg);
  ok('AC2 the registry lists the edit root\'s instruction files', paths.includes(path.join(w.app, 'CLAUDE.md')) && paths.includes(path.join(work, 'CLAUDE.md')), JSON.stringify(paths));
  ok('AC2 B12 …and nothing from the read root', !paths.some((p) => p.startsWith(shared)), JSON.stringify(paths.filter((p) => p.startsWith(shared))));
  const mcp = reg.groups.find((g) => g.id === 'mcp');
  ok('AC2 B12 the MCP registry group holds the edit root\'s .mcp.json only',
     mcp?.entries.length === 1 && mcp.entries[0].files[0].path === path.join(w.app, '.mcp.json'), JSON.stringify(mcp?.entries.map((e) => e.files[0].path)));
  const wt = reg.groups.find((g) => g.id === 'worktrees');
  ok('AC2 the edit root\'s .worktrees.conf is listed', wt.entries.some((e) => e.files[0].path === path.join(w.app, '.worktrees.conf')));
  ok('AC2 edit-root entries carry scope project and their rootId',
     reg.groups.find((g) => g.id === 'memory').entries.filter((e) => e.files[0].path.startsWith(work)).every((e) => e.scope === 'project' && e.rootId === 'work'));
  ok('AC2 the workspace file is named for its folder', reg.groups.find((g) => g.id === 'memory').entries.some((e) => e.label === 'Work workspace' && e.description === 'Applies to everything under ~/code/work.'));
  ok('B1 a CLAUDE.md linked to a credential, a read-root file or an outside file is never in the registry',
     !paths.some((p) => /auth\.json$/.test(p) || p.startsWith(outside) || p.startsWith(shared))
     && !JSON.stringify(reg).includes('to-cred') && !JSON.stringify(reg).includes('to-outside'), JSON.stringify(paths));

  const ctx = (await srv.call('/api/context')).json;
  const ctxRoots = new Set(ctx.groups.map((g) => g.root));
  ok('AC2 Context lists both roots, the read one read-only', ctxRoots.has('work') && ctxRoots.has('shared')
     && ctx.groups.find((g) => g.root === 'shared').readOnly === true && ctx.roots.shared.readOnly === true && ctx.roots.work.readOnly === false, JSON.stringify(ctx.roots));
  const sharedVariant = ctx.groups.find((g) => g.root === 'shared').scopes[0].variants[0];
  ok('AC2 a read-root file opens by id, never by path', !sharedVariant.open.path && sharedVariant.readOnly === true);

  const skills = (await srv.call('/api/skills')).json.skills;
  ok('AC2 Skills lists both roots: the edit root as project, the read root by its id',
     skills.some((x) => x.source === 'project' && x.rootId === 'work' && x.name === 'work-skill')
     && skills.some((x) => x.source === 'shared' && x.rootId === 'shared' && x.name === 'shared-skill'), JSON.stringify(skills.map((x) => `${x.source}:${x.name}`)));

  const wtr = (await srv.call('/api/worktree?status=0')).json;
  ok('AC2 Worktrees discovery finds checkouts in both roots',
     wtr.candidates.some((c) => c.path === w.app) && wtr.candidates.some((c) => c.path === s.app), JSON.stringify(wtr.candidates));

  const dirs = (await srv.call('/api/scope/dirs')).json.dirs.map((d) => d.path);
  ok('AC2 the scope walker walks edit roots only', dirs.includes(work) && dirs.includes(w.app) && !dirs.some((d) => d.startsWith(shared)), JSON.stringify(dirs));

  // Writes follow access.
  const target = path.join(w.app, 'CLAUDE.md');
  const g = await srv.call(`/api/file?path=${encodeURIComponent(target)}`);
  const put = await srv.call('/api/file', { method: 'PUT', body: { path: target, content: '# work app\n\nedited\n', mtime: g.json.mtime } });
  ok('AC2 a write under the edit root succeeds', put.status === 200 && put.json.saved === true && fs.readFileSync(target, 'utf8') === '# work app\n\nedited\n', put.text);
  const sharedFile = path.join(s.app, 'CLAUDE.md');
  const sharedBefore = fs.readFileSync(sharedFile, 'utf8');
  const putShared = await srv.call('/api/file', { method: 'PUT', body: { path: sharedFile, content: 'x' } });
  ok('AC2 a write under the read root 403s and leaves it alone', putShared.status === 403 && fs.readFileSync(sharedFile, 'utf8') === sharedBefore, putShared.text);
  const getShared = await srv.call(`/api/file?path=${encodeURIComponent(sharedFile)}`);
  ok('AC2 …and the editor cannot read it either', getShared.status === 403, getShared.text);
  const neither = path.join(outside, 'CLAUDE.md');
  const getNeither = await srv.call(`/api/file?path=${encodeURIComponent(neither)}`);
  ok('AC2 GET /api/file on a path under neither root 403s', getNeither.status === 403, getNeither.text);
  const createInShared = await srv.call('/api/create-file', { method: 'POST', body: { dir: s.app, name: 'new.md' } });
  ok('AC2 creating a file in the read root 403s', createInShared.status === 403 && !fs.existsSync(path.join(s.app, 'new.md')), createInShared.text);
  const delShared = await srv.call('/api/delete', { method: 'POST', body: { path: sharedFile } });
  ok('AC2 deleting in the read root 403s', delShared.status === 403 && fs.existsSync(sharedFile), delShared.text);

  // AC4: a link inside an edit root pointing out of every root.
  const viaLink = await srv.call(`/api/file?path=${encodeURIComponent(path.join(work, 'to-outside', 'CLAUDE.md'))}`);
  ok('AC4 a symlink inside a root that points outside every root still 403s', viaLink.status === 403, viaLink.text);

  // B1: search and history never see the linked bytes.
  const hitsFor = async (q) => (await srv.call(`/api/search?q=${encodeURIComponent(q)}`)).json.hits;
  ok('B1 search finds edit-root text (the probe works)', (await hitsFor('edited')).some((h) => h.path === target));
  ok('B1 search never returns credential, read-root or outside bytes',
     (await hitsFor('CRED-SECRET-MARKER')).length === 0 && (await hitsFor('OUTSIDE-SECRET-MARKER')).length === 0
     && (await hitsFor('shared app')).length === 0);
  await srv.call('/api/snapshot', { method: 'POST' });
  const hist = historyFiles(home);
  const mirrored = [...hist.files.keys()];
  ok('B1 the history repo holds the edit root\'s files (the probe works)', mirrored.some((p) => p.endsWith(path.join('code', 'work', 'work-app', 'CLAUDE.md'))), JSON.stringify(mirrored));
  ok('B1 B12 …and never a credential, a read-root file or an outside file, in any commit',
     ![...hist.files.values()].some((t) => /CRED-SECRET-MARKER|OUTSIDE-SECRET-MARKER|# shared app/.test(t))
     && !/CRED-SECRET-MARKER|OUTSIDE-SECRET-MARKER|# shared app/.test(hist.everCommitted)
     && !mirrored.some((p) => p.includes('auth.json') || p.includes('shared')), JSON.stringify(mirrored));

  // B4: worktree init on a read root.
  const init = await srv.call('/api/worktree/init', { method: 'POST', body: { repoPath: s.app, key: 'shared-app' } });
  ok('B4 POST /api/worktree/init 403s for a project in a read root, naming the terminal command',
     init.status === 403 && /read-only folder/.test(init.json?.error) && /wtinit --key shared-app/.test(init.json?.error)
     && !fs.existsSync(path.join(s.app, '.worktrees.conf.bak')), init.text);
  const initTrunk = await srv.call('/api/worktree/init', { method: 'POST', body: { repoPath: w.app, key: 'work-app', trunk: path.join(shared, 'trunk') } });
  ok('B4 …and for a trunk it would write into a read root', initTrunk.status === 403 && /read-only folder/.test(initTrunk.json?.error), initTrunk.text);
  const initEdit = await srv.call('/api/worktree/init', { method: 'POST', body: { repoPath: w.app, key: 'work-app' } });
  ok('B4 an edit-root project is not refused for its folder (it fails later, on the missing toolkit)',
     initEdit.status !== 403 && /toolkit not installed/.test(initEdit.json?.error || ''), initEdit.text);
  await srv.stop();
}

/* ── AC4 / B3: symlinked HOME and a symlinked root ─────────────────────── */
{
  const raw = mkTemp('symhome', { raw: true });
  const real = fs.realpathSync(raw);
  // On Linux the tmpdir is no symlink: make one, so the scenario is the same everywhere.
  let home = raw;
  if (raw === real) { home = path.join(mkTemp('symlink-host'), 'home-link'); fs.symlinkSync(real, home); }
  ok('AC4 HOME under test really is reached through a symlink', fs.realpathSync(home) !== home, home);
  seedGlobals(home);
  const disk = path.join(home, 'volumes', 'disk', 'code');
  const w = seedProjectTree(disk, 'linked');
  fs.symlinkSync(disk, path.join(home, 'code-link'));
  writeRoots(home, [{ id: 'code', path: path.join(home, 'code-link'), label: 'Code', access: 'edit' }]);
  const srv = await startServer(home, { root: ROOT });
  ok('AC4 the server boots under a symlinked HOME', srv.up, srv.log().slice(-400));
  const reg = (await srv.call('/api/registry')).json;
  const target = registryPaths(reg).find((p) => p.endsWith(path.join('linked-app', 'CLAUDE.md')));
  ok('AC4 a root whose path is a symlink lists its files (at their real path)', target === fs.realpathSync(path.join(w.app, 'CLAUDE.md')), JSON.stringify(registryPaths(reg)));
  const v1 = fs.readFileSync(target, 'utf8');
  const g = await srv.call(`/api/file?path=${encodeURIComponent(target)}`);
  ok('AC4 the editor opens it under a symlinked HOME', g.status === 200 && g.json.content === v1 && g.json.display.startsWith('~/'), g.text);
  const gTyped = await srv.call(`/api/file?path=${encodeURIComponent(path.join(home, 'code-link', 'linked-app', 'CLAUDE.md'))}`);
  ok('AC4 …by the symlinked spelling too', gTyped.status === 200 && gTyped.json.path === target, gTyped.text);
  const gGlobal = await srv.call(`/api/file?path=${encodeURIComponent(path.join(home, '.claude', 'CLAUDE.md'))}`);
  ok('AC4 a built-in home opens under a symlinked HOME (no 403)', gGlobal.status === 200, gGlobal.text);
  const v2 = '# linked app\n\nversion two\n';
  const put = await srv.call('/api/file', { method: 'PUT', body: { path: target, content: v2, mtime: g.json.mtime } });
  ok('B3 a save under a symlinked HOME commits to history', put.status === 200 && put.json.saved && /^[0-9a-f]{40}$/.test(put.json.sha || '') && !put.json.historyError, put.text);
  const log = await srv.call(`/api/history?path=${encodeURIComponent(target)}`);
  ok('B3 …and the version list has the baseline and the edit', log.status === 200 && log.json.commits.length >= 2, log.text);
  const baseline = log.json.commits[log.json.commits.length - 1].sha;
  const ver = await srv.call(`/api/history/version?path=${encodeURIComponent(target)}&sha=${baseline}`);
  ok('B3 …the oldest version is the original bytes', ver.status === 200 && ver.json.content === v1, ver.text);
  const st = fs.statSync(target);
  const rest = await srv.call('/api/history/restore', { method: 'POST', body: { path: target, sha: baseline, mtime: st.mtimeMs } });
  ok('B3 …and restore puts them back byte-identical', rest.status === 200 && rest.json.restored && fs.readFileSync(target, 'utf8') === v1 && !rest.json.historyError, rest.text);
  await srv.stop();
}

/* ── AC7 / B8: a hand-edited or corrupt roots.json never crashes boot ──── */
{
  const home = mkTemp('handedit');
  seedGlobals(home);
  const work = path.join(home, 'code', 'work');
  const w = seedProjectTree(work, 'work');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  writeRoots(home, [
    { id: 'work', path: work, label: 'Work', access: 'edit' },
    { id: 'keys', path: path.join(home, '.ssh'), label: 'Keys', access: 'read' },
    { id: 'rel', path: 'code/other', label: 'Rel', access: 'read' },
    { id: 'gone', path: path.join(home, 'unplugged'), label: 'Gone', access: 'read' },
  ]);
  const before = fs.readFileSync(path.join(home, '.agent-config-studio', 'roots.json'), 'utf8');
  const srv = await startServer(home, { root: ROOT });
  ok('AC7 the server boots with entries failing validation', srv.up, srv.log().slice(-400));
  const r = (await srv.call('/api/roots')).json;
  ok('AC7 bad entries are dropped and reported for the Folders view, each with its reason',
     r.invalid.length === 2 && r.invalid.some((x) => x.id === 'keys' && /\.ssh/.test(x.reason)) && r.invalid.some((x) => x.id === 'rel' && /absolute/.test(x.reason)), JSON.stringify(r.invalid));
  ok('AC7 valid entries still load; B8 a missing one is listed as missing, not dropped',
     r.roots.map((x) => `${x.id}:${x.status}`).join() === 'work:ok,gone:missing', JSON.stringify(r.roots));
  ok('AC7 …and the registry lists the valid root\'s files', registryPaths((await srv.call('/api/registry')).json).includes(path.join(w.app, 'CLAUDE.md')));
  ok('B8 the server never rewrites a hand-edited file', fs.readFileSync(path.join(home, '.agent-config-studio', 'roots.json'), 'utf8') === before);
  await srv.stop();
}
{
  const home = mkTemp('corrupt');
  seedGlobals(home);
  legacyHome(home);
  fs.mkdirSync(path.join(home, '.agent-config-studio'), { recursive: true });
  const f = path.join(home, '.agent-config-studio', 'roots.json');
  fs.writeFileSync(f, '{"version":1,"roots":[{"id":');
  const srv = await startServer(home, { root: ROOT });
  ok('AC7 the server boots with invalid JSON in roots.json', srv.up, srv.log().slice(-400));
  const r = (await srv.call('/api/roots')).json;
  ok('B8 roots go into an error state the Folders view can show', r.state === 'error' && /not valid/.test(r.error) && r.roots.length === 0, JSON.stringify(r));
  ok('B8 …the banner says so', /roots\.json is not valid/.test(srv.log()), srv.log());
  const reg = (await srv.call('/api/registry')).json;
  ok('B8 …no project folder is active (not even the legacy ones on disk)', !registryPaths(reg).some((p) => p.includes(`${path.sep}Documents${path.sep}`)));
  ok('B8 …and the file is never overwritten, migration included', fs.readFileSync(f, 'utf8') === '{"version":1,"roots":[{"id":');
  await srv.stop();
}

/* ── P1: a registered root's link re-pointed at HOME while the server runs ── */
{
  const home = mkTemp('retarget');
  seedGlobals(home);
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  const key = path.join(home, '.ssh', 'id_rsa');
  fs.writeFileSync(key, 'SSH-PRIVATE-KEY-MARKER\n');
  const real = path.join(home, 'code', 'real');
  seedProjectTree(real, 'real');
  const link = path.join(home, 'code-link');
  fs.symlinkSync(real, link);
  writeRoots(home, [{ id: 'code', path: link, label: 'Code', access: 'edit' }]);
  const srv = await startServer(home, { root: ROOT });
  ok('RT the server boots with a linked edit root', srv.up && (await srv.call('/api/roots')).json.roots[0]?.status === 'ok');
  for (const [what, target] of [['HOME', home], ['~/.ssh', path.join(home, '.ssh')]]) {
    fs.unlinkSync(link);
    fs.symlinkSync(target, link);
    const g = await srv.call(`/api/file?path=${encodeURIComponent(key)}`);
    ok(`RT re-pointed at ${what}: the editor still cannot read ~/.ssh/id_rsa`, g.status === 403 && !g.text.includes('SSH-PRIVATE-KEY-MARKER'), g.text);
    const put = await srv.call('/api/file', { method: 'PUT', body: { path: key, content: 'x' } });
    ok(`RT …nor write it`, put.status === 403 && fs.readFileSync(key, 'utf8') === 'SSH-PRIVATE-KEY-MARKER\n', put.text);
    const roots = (await srv.call('/api/roots')).json;
    ok(`RT …and Folders reports the root skipped, with why`,
       roots.roots.length === 0 && roots.invalid.some((x) => x.id === 'code' && /resolves to/.test(x.reason)), JSON.stringify(roots.invalid));
  }
  await srv.stop();
}

/* ── the registry resolves links as the kernel does (jump/.. shapes) ────── */
{
  const home = mkTemp('kernel');
  const other = mkTemp('kernel-read');
  seedGlobals(home);
  const W = path.join(home, 'code', 'work');
  const RS = path.join(other, 'shared', 'sub');
  fs.mkdirSync(RS, { recursive: true });
  fs.mkdirSync(path.join(W, 'deep', 'inner'), { recursive: true });
  fs.mkdirSync(path.join(W, 'a'), { recursive: true });
  fs.mkdirSync(path.join(W, 'b'), { recursive: true });
  fs.symlinkSync(RS, path.join(W, 'jump'));                         // into the read root
  fs.symlinkSync(path.join(W, 'deep', 'inner'), path.join(W, 'jump2')); // within the edit root
  fs.writeFileSync(path.join(W, 'decoy.md'), 'LEXICAL-DECOY\n');
  fs.writeFileSync(path.join(other, 'shared', 'decoy.md'), 'READ-ROOT-BYTES\n');
  fs.writeFileSync(path.join(W, 't.md'), 'LEXICAL-T\n');
  fs.writeFileSync(path.join(W, 'deep', 't.md'), 'TRUE-T\n');
  fs.symlinkSync(`${W}/jump/../decoy.md`, path.join(W, 'a', 'CLAUDE.md'));   // kernel: <read>/shared/decoy.md
  fs.symlinkSync(`${W}/jump2/../t.md`, path.join(W, 'b', 'CLAUDE.md'));      // kernel: <work>/deep/t.md
  writeRoots(home, [
    { id: 'work', path: W, label: 'Work', access: 'edit' },
    { id: 'shared', path: path.join(other, 'shared'), label: 'Shared', access: 'read' },
  ]);
  const srv = await startServer(home, { root: ROOT });
  const paths = registryPaths((await srv.call('/api/registry')).json);
  ok('KR a CLAUDE.md -> jump/../x into the read root is dropped (B1), never listed as the lexical file',
     !paths.includes(path.join(W, 'decoy.md')) && !paths.some((p) => p.startsWith(other)), JSON.stringify(paths));
  ok('KR a CLAUDE.md -> jump2/../t.md within the edit root lists its true target, not the lexical one',
     paths.includes(path.join(W, 'deep', 't.md')) && !paths.includes(path.join(W, 't.md')), JSON.stringify(paths));
  const g = await srv.call(`/api/file?path=${encodeURIComponent(path.join(W, 'deep', 't.md'))}`);
  ok('KR …and the editor opens those true bytes', g.status === 200 && g.json.content === 'TRUE-T\n', g.text);
  const hits = (await srv.call('/api/search?q=LEXICAL')).json.hits;
  ok('KR search finds neither lexical decoy through the links', !hits.length, JSON.stringify(hits));
  await srv.stop();
}

for (const t of temps) { try { fs.rmSync(t, { recursive: true, force: true }); } catch {} }
assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
