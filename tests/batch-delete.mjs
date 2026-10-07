/**
 * POST /api/delete/batch — the Context view's multi-select delete
 * (builds/batch-delete/plan.md, criterion 1 and folds D2–D7, D9). Every
 * refusal is checked against a hash of the whole tree: refused means nothing
 * moved. Faults are injected through mutate's and paths' test seams.
 *
 * HOME is redirected to a temp directory before anything from lib/ loads.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';

const realHome = os.homedir();
const realBefore = snapshotRealHomes();
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-batch-')));
process.env.HOME = home;
process.env.ACS_SUITE = 'offline';
delete process.env.CODEX_HOME;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const put = (f, body) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
/** Every file, link and folder under `root` — "nothing moved" is this, compared. */
const treeHash = (root) => {
  const out = {};
  const walk = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    if (st.isSymbolicLink()) { out[p] = `link:${fs.readlinkSync(p)}`; return; }
    if (st.isFile()) { out[p] = sha(p); return; }
    if (!st.isDirectory()) return;
    let names;
    try { names = fs.readdirSync(p); } catch { out[p] = 'dir (unreadable)'; return; }
    out[p] = 'dir';
    for (const n of names) walk(path.join(p, n));
  };
  walk(root);
  return JSON.stringify(out);
};
// Everything a batch could touch, minus the studio's own history and trash.
const userTree = () => treeHash(path.join(home, 'code')) + treeHash(path.join(home, '.claude')) + treeHash(path.join(home, '.codex'));

console.log('\nbatch delete');
ok('HOME is redirected away from the real one', os.homedir() === home && home !== realHome);

// An edit root `work` holding a repository with a worktree (identical copy)
// and an AGENTS.md alias; a read root `client` holding a second worktree of
// the same repository, so one variant spans both permissions.
const work = path.join(home, 'code', 'work');
const client = path.join(home, 'code', 'client');
const app = path.join(work, 'app');
const wt = path.join(work, 'app-wt', 'feat');
const roWt = path.join(client, 'feat-ro');
const body = '# app\n\n## Rules\n\nbe kind\n';
fs.mkdirSync(path.join(app, '.git', 'objects'), { recursive: true });
for (const [dir, name] of [[wt, 'feat'], [roWt, 'feat-ro']]) {
  put(path.join(app, '.git', 'worktrees', name, 'commondir'), '../..\n');
  put(path.join(dir, '.git'), `gitdir: ${path.join(app, '.git', 'worktrees', name)}\n`);
  put(path.join(dir, 'CLAUDE.md'), body);
}
put(path.join(app, 'CLAUDE.md'), body);
fs.symlinkSync('CLAUDE.md', path.join(app, 'AGENTS.md'));
put(path.join(work, 'CLAUDE.md'), '# work root\n');
put(path.join(client, 'other', 'CLAUDE.md'), '# client only\n');
put(path.join(home, '.claude', 'CLAUDE.md'), '# global\n');
put(path.join(home, '.codex', 'AGENTS.md'), '# codex global\n');
put(path.join(home, '.codex', 'rules', 'default.rules'), 'prefix_rule(pattern=["ls"], decision="allow")\n');
put(path.join(home, '.codex', 'auth.json'), '{"token":"SECRET"}\n');
put(path.join(home, '.claude', 'plugins', 'cache', 'p', 'SKILL.md'), '# plugin\n');
put(path.join(home, '.agent-config-studio', 'seats.json'), '{"version":1,"seats":[]}\n');

const roots = await import('../lib/roots.js');
const mutate = await import('../lib/mutate.js');
const history = await import('../lib/history.js');
const { _setBeforeWriteCheck } = await import('../lib/paths.js');
const addWork = () => roots.addRoot({ path: work, access: 'edit', label: 'Work', id: 'work' }, { home });
addWork();
roots.addRoot({ path: client, access: 'read', label: 'Client', id: 'client' }, { home });
await history.ensureRepo();

const { createApp } = await import('../server.js');
const { server } = createApp();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://localhost:${server.address().port}`;
const call = async (p, method = 'GET', b, headers = {}) => {
  const r = await fetch(base + p, {
    method, headers: { ...(b !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: b === undefined ? undefined : typeof b === 'string' ? b : JSON.stringify(b),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
const batch = (paths, headers) => call('/api/delete/batch', 'POST', { paths }, headers);
const scratch = (rel, text = `${rel}\n`) => { const f = path.join(work, 'scratch', rel); put(f, text); return f; };
const trashed = async (id) => (await mutate.listTrash()).find((t) => t.id === id);

/** A batch that must be refused whole: 400 (or `status`), and the tree hash unchanged. */
async function refused(name, paths, { status = 400, re = null, headers } = {}) {
  const before = userTree();
  const r = typeof paths === 'string' ? await call('/api/delete/batch', 'POST', paths, headers) : await batch(paths, headers);
  ok(name, r.status === status && (!re || re.test(r.json?.error || r.text)), `${r.status} ${r.text.slice(0, 200)}`);
  ok(`${name} — nothing moved`, userTree() === before);
  return r;
}

// ── origin matrix ─────────────────────────────────────────────────────────
{
  const f = scratch('origin.md');
  const port = server.address().port;
  await refused('origin: a foreign Origin is 403', [f], { status: 403, headers: { origin: 'http://evil.example' } });
  await refused('origin: another localhost port is 403', [f], { status: 403, headers: { origin: `http://localhost:${port + 1}`, 'sec-fetch-site': 'same-site' } });
  await refused('origin: Origin null is 403', [f], { status: 403, headers: { origin: 'null' } });
  await refused('origin: Sec-Fetch-Site same-site with no Origin is 403', [f], { status: 403, headers: { 'sec-fetch-site': 'same-site' } });
  await refused('origin: Sec-Fetch-Site cross-site is 403', [f], { status: 403, headers: { 'sec-fetch-site': 'cross-site' } });
  const r = await batch([f], { origin: base, 'sec-fetch-site': 'same-origin' });
  ok('origin: this page (same-origin) is let through', r.status === 200 && r.json.results[0].status === 'trashed', r.text);
}

// ── malformed bodies and the limit ────────────────────────────────────────
{
  const f = scratch('shape.md');
  await refused('shape: invalid JSON is 400', '{"paths": [');
  await refused('shape: no body is 400', '');
  await refused('shape: paths not an array is 400', JSON.stringify({ paths: f }));
  await refused('shape: a body that is an array is 400', JSON.stringify([f]));
  await refused('shape: a body that is null is 400', 'null');
  await refused('shape: an empty list is 400', []);
  await refused('shape: a non-string path is 400 (the valid one beside it stays)', [f, 42]);
  await refused('shape: a blank path is 400', [f, '  ']);
  const many = Array.from({ length: 201 }, (_, i) => scratch(`many/n${i}.md`));
  await refused('limit: 201 distinct existing paths is 400', many, { re: /201 after de-duplication/ });
  fs.rmSync(path.join(work, 'scratch', 'many'), { recursive: true });
  await refused('limit: over 10000 raw paths is 400, and says it is a per-request bound', Array.from({ length: 10001 }, () => f),
    { re: /over 10000 before de-duplication/ });
  const r = await batch(Array.from({ length: 1001 }, () => f));
  ok('D9 limit: 1001 copies of one path count once, after de-duplication', r.status === 200 && r.json.results.length === 1
     && r.json.results[0].status === 'trashed', r.text.slice(0, 200));
}

// ── each refusal single delete makes, plus the batch's own, refuses the whole batch ──
{
  const good = scratch('good.md');
  const outside = path.join(home, 'elsewhere.md');
  put(outside, 'outside\n');
  const r1 = await refused('refuse: a path outside the roots', [good, outside], { re: /outside allowed roots/ });
  ok('refuse: …the 400 names the refused path', r1.json?.path === outside, JSON.stringify(r1.json));
  await refused('refuse: a read-root path', [good, path.join(client, 'other', 'CLAUDE.md')], { re: /outside allowed roots/ });
  await refused('refuse: a credential by name', [good, path.join(home, '.codex', 'auth.json')], { re: /protected/ });
  await refused('refuse: a missing file', [good, path.join(work, 'scratch', 'never-was.md')], { re: /does not exist/ });

  const linked = scratch('linked.md');
  fs.linkSync(linked, path.join(work, 'scratch', 'linked-twin.md'));
  await refused('D4 refuse: a hard-linked file (beyond single delete)', [good, linked], { re: /hard-linked/ });
  const innocent = path.join(work, 'scratch', 'innocent.md');
  fs.linkSync(path.join(home, '.codex', 'auth.json'), innocent);
  await refused('D4 refuse: a credential hard link under an innocent name', [good, innocent], { re: /credential|hard-linked/ });
  const hidden = path.join(work, 'hides');
  fs.mkdirSync(hidden);
  fs.linkSync(linked, path.join(hidden, 'deep.md'));
  await refused('D4 refuse: a folder holding a hard-linked file', [good, hidden], { re: /holds .*deep\.md/ });
  fs.rmSync(hidden, { recursive: true });
  fs.rmSync(innocent);

  // Every input is checked before a folder may swallow it.
  const folder = path.join(work, 'scratch', 'swallow');
  put(path.join(folder, 'kept.md'), 'kept\n');
  const r5 = await refused('grade 5: [file, folder, folder/missing.md] refuses — the missing child is checked before collapse',
    [good, folder, path.join(folder, 'missing.md')], { re: /missing\.md does not exist/ });
  ok('grade 5: …the 400 names the missing child', r5.json?.path === path.join(folder, 'missing.md'), JSON.stringify(r5.json));
  const sealed = path.join(folder, 'sealed');
  fs.mkdirSync(sealed);
  fs.writeFileSync(path.join(sealed, 'x.md'), 'x\n');
  fs.chmodSync(sealed, 0o000);
  let r6;
  try { r6 = await refused('grade 6: a folder holding an unreadable folder is 400, not 500', [good, folder], { re: /cannot be read/ }); }
  finally { fs.chmodSync(sealed, 0o755); }
  ok('grade 6: …with the path in the body', r6.json?.path === folder && typeof r6.json.error === 'string', JSON.stringify(r6.json));
  fs.rmSync(folder, { recursive: true });

  // assertWritable runs in preflight too: a root gone by then refuses the whole batch.
  _setBeforeWriteCheck((abs) => { if (abs === good) { _setBeforeWriteCheck(null); roots.removeRoot('work', { home }); } });
  try { await refused('D4 preflight assertWritable: a root revoked during preflight refuses the whole batch', [good], { re: /cannot be changed here/ }); }
  finally { _setBeforeWriteCheck(null); addWork(); }
  fs.rmSync(path.join(work, 'scratch', 'linked-twin.md'));

  await refused('D3 refuse: an allowed root itself', [good, work], { re: /folder itself/ });
  await refused('D3 refuse: a folder holding an allowed root', [good, path.join(home, 'code')], { re: /outside allowed roots|folder itself/ });
  await refused('D3 refuse: a plugin-owned file, after a valid item (preflight, not mid-batch)',
    [good, path.join(home, '.claude', 'plugins', 'cache', 'p', 'SKILL.md')], { re: /plugin system/ });
  await refused('D3 refuse: the plugin folder itself', [good, path.join(home, '.claude', 'plugins')], { re: /plugin system/ });
}

// ── protection, derived from the registry ─────────────────────────────────
{
  const good = scratch('good2.md');
  await refused('D3 protected: an edit root\'s CLAUDE.md', [good, path.join(work, 'CLAUDE.md')], { re: /loaded on every session/ });
  await refused('D3 protected: the global CLAUDE.md', [good, path.join(home, '.claude', 'CLAUDE.md')], { re: /loaded on every session/ });
  await refused('D3 protected: the global AGENTS.md, by a tilde spelling', [good, '~/.codex/AGENTS.md'], { re: /loaded on every session/ });
  await refused('D3 protected: a settings entry', [good, path.join(home, '.codex', 'rules', 'default.rules')], { re: /loaded on every session/ });
  await refused('D3 protected descendant: a folder holding a settings entry', [good, path.join(home, '.codex', 'rules')], { re: /holds .*default\.rules/ });
  const alias = path.join(work, 'ROOT-ALIAS.md');
  fs.symlinkSync('CLAUDE.md', alias);
  await refused('D3 protected: an alias resolving to a protected file', [good, alias], { re: /loaded on every session/ });
  fs.rmSync(alias);
  const single = await call('/api/delete', 'POST', { path: path.join(work, 'scratch', 'good2.md') });
  ok('D3 single delete is unchanged (an ordinary file still deletes)', single.status === 200 && single.json.deleted, single.text);
}

// ── a valid batch, with history ───────────────────────────────────────────
{
  const files = ['a.md', 'b.md', 'c.md'].map((n) => scratch(`three/${n}`, `bytes of ${n}\n`));
  const r = await batch(files);
  ok('C1 a batch of 3: 200 with three trashed results, in order', r.status === 200
     && r.json.results.map((x) => `${x.path}:${x.status}`).join() === files.map((f) => `${f}:trashed`).join(), r.text.slice(0, 300));
  ok('C1 …all three are gone', files.every((f) => !fs.existsSync(f)));
  const entries = await Promise.all(r.json.results.map((x) => trashed(x.trashId)));
  ok('C1 …each is in Trash and restorable', entries.every((t) => t?.restorable === true), JSON.stringify(entries));
  ok('D5 …results carry display and trashId; no history warning', r.json.results.every((x) => x.display.startsWith('~/') && x.trashId)
     && Array.isArray(r.json.historyWarnings) && r.json.historyWarnings.length === 0, JSON.stringify(r.json));
  let recoverable = true;
  for (const f of files) {
    const log = await history.logFor(f);
    const before = log.find((c) => /before delete/.test(c.subject));
    if (!before || (await history.contentAt(f, before.sha)) !== `bytes of ${path.basename(f)}\n`) recoverable = false;
  }
  ok('D7 the pre-delete bytes of each are recoverable from history', recoverable);
  for (const x of r.json.results) await mutate.restoreTrash({ id: x.trashId });
  ok('C1 …and each restores, byte-identical', files.every((f) => fs.readFileSync(f, 'utf8') === `bytes of ${path.basename(f)}\n`));
}

// ── overlap and canonicalisation ──────────────────────────────────────────
{
  const dir = path.join(work, 'scratch', 'ab');
  const child = scratch('ab/inner.md');
  const sib = scratch('abc/sib.md');
  const r1 = await batch([child, dir]);
  ok('D9 a folder and a file inside it collapse to the folder (child first)', r1.status === 200 && r1.json.results.length === 1
     && r1.json.results[0].path === dir && !fs.existsSync(dir), r1.text);
  ok('D9 …and the sibling with a shared prefix is untouched', fs.existsSync(sib));
  await mutate.restoreTrash({ id: r1.json.results[0].trashId });
  const r2 = await batch([dir, child]);
  ok('D9 …the same, folder first', r2.status === 200 && r2.json.results.length === 1 && r2.json.results[0].path === dir, r2.text);
  await mutate.restoreTrash({ id: r2.json.results[0].trashId });
  const sibDir = path.dirname(sib);
  const r3 = await batch([sibDir, dir]);
  ok('D9 /…/ab does not swallow /…/abc: both go, as two items', r3.status === 200 && r3.json.results.length === 2
     && r3.json.results.every((x) => x.status === 'trashed'), r3.text);
  for (const x of r3.json.results) await mutate.restoreTrash({ id: x.trashId });
  const r4 = await batch([child, child.replace(home, '~'), path.join(dir, '.', 'inner.md')]);
  ok('D9 absolute, tilde and dotted spellings are one path', r4.status === 200 && r4.json.results.length === 1, r4.text);
  await mutate.restoreTrash({ id: r4.json.results[0].trashId });
}

// ── a real Context payload: collapsed copies, an alias, mixed permissions ──
{
  const ctx = (await call('/api/context')).json;
  const variants = ctx.groups.flatMap((g) => g.scopes.flatMap((s) => s.variants.map((v) => ({ ...v, group: g.label, scope: s.scope }))));
  const appRow = variants.find((v) => v.group === 'app' && v.scope === 'CLAUDE.md');
  ok('D2 the repository\'s CLAUDE.md is one variant of four copies (trunk, worktree, read-root worktree, alias)',
     appRow?.copies === 4 && appRow.paths.some((p) => p.alias) && appRow.paths.some((p) => p.readOnly), JSON.stringify(appRow));
  ok('D2 …its representative is the trunk copy, editable', appRow?.open.path === path.join(app, 'CLAUDE.md') && !appRow.readOnly);
  ok('D2 …and it is not protected', appRow?.protected === false);
  const rootRow = variants.find((v) => v.open.path === path.join(work, 'CLAUDE.md'));
  ok('D3 the edit root\'s CLAUDE.md row is marked protected from the registry', rootRow?.protected === true, JSON.stringify(rootRow));
  const roRow = variants.find((v) => v.open.display.endsWith('other/CLAUDE.md'));
  ok('D2 a read-root row has no editable path to select', roRow?.readOnly === true && roRow.open.path === undefined, JSON.stringify(roRow));

  const before = { wt: sha(path.join(wt, 'CLAUDE.md')), ro: sha(path.join(roWt, 'CLAUDE.md')) };
  const r = await batch([appRow.open.path, path.join(app, 'AGENTS.md')]);
  ok('D2 the row and its alias canonicalise to one item', r.status === 200 && r.json.results.length === 1
     && r.json.results[0].status === 'trashed' && !fs.existsSync(path.join(app, 'CLAUDE.md')), r.text);
  ok('D2 …only the representative went: the worktree and read-root copies are untouched',
     sha(path.join(wt, 'CLAUDE.md')) === before.wt && sha(path.join(roWt, 'CLAUDE.md')) === before.ro);
  await mutate.restoreTrash({ id: r.json.results[0].trashId });
  const after = (await call('/api/context')).json;
  ok('D2 restored, the Context payload is whole again', after.totals.files === ctx.totals.files, JSON.stringify(after.totals));
}

// ── one source of protection: the Context flag and the route agree ────────
{
  const { preflight } = await import('../lib/batch-delete.js');
  const ctx = (await call('/api/context')).json;
  const rows = ctx.groups.flatMap((g) => g.scopes.flatMap((s) => s.variants)).filter((v) => v.open.path);
  const verdicts = rows.map((v) => {
    let refusedAsProtected = false;
    try { preflight({ paths: [v.open.path] }); } catch (e) { refusedAsProtected = /loaded on every session/.test(e.message); }
    return { path: v.open.path, flag: v.protected, refusedAsProtected };
  });
  ok('D3 every Context row\'s protected flag matches the batch route\'s protected refusal', verdicts.length >= 2
     && verdicts.some((v) => v.flag) && verdicts.some((v) => !v.flag) && verdicts.every((v) => v.flag === v.refusedAsProtected), JSON.stringify(verdicts));
}

// ── the error-body payload is opt-in: other routes' bodies are unchanged ──
{
  const r = await call('/api/delete', 'POST', { path: path.join(work, 'scratch', 'not-there.md') });
  ok('POST /api/delete on a missing file still answers { error } and nothing else', r.status >= 400
     && JSON.stringify(Object.keys(r.json || {})) === '["error"]', r.text);
  const r2 = await call('/api/delete', 'POST', { path: path.join(home, 'elsewhere.md') });
  ok('…and on a path outside the roots', r2.status === 403 && JSON.stringify(Object.keys(r2.json || {})) === '["error"]', r2.text);
}

// ── partial failures: before the move, after it, during metadata ──────────
{
  const four = ['1', '2', '3', '4'].map((n) => scratch(`four/f${n}.md`, `f${n}\n`));
  let moves = 0;
  mutate._setTrashFault((step) => { if (step === 'after-pending-meta' && ++moves === 3) throw new Error('injected: disk full'); });
  let r;
  try { r = await batch(four); } finally { mutate._setTrashFault(null); }
  const st = r.json?.results?.map((x) => x.status).join();
  ok('C1 a fault on item 3 of 4 (before its move): 200, trashed,trashed,failed,not-attempted',
     r.status === 200 && st === 'trashed,trashed,failed,not-attempted', r.text.slice(0, 400));
  ok('D5 …the failure carries its error', /disk full/.test(r.json.results[2].error));
  ok('C1 …the two trashed are restorable', (await trashed(r.json.results[0].trashId))?.restorable
     && (await trashed(r.json.results[1].trashId))?.restorable);
  ok('D6 …the failed and the not-attempted are still in place', fs.readFileSync(four[2], 'utf8') === 'f3\n' && fs.readFileSync(four[3], 'utf8') === 'f4\n');
  for (const x of r.json.results.slice(0, 2)) await mutate.restoreTrash({ id: x.trashId });
  // The record the interrupted item left is listed but holds nothing.
  const stray = (await mutate.listTrash()).find((t) => t.originalPath === four[2]);
  ok('D6 …its trash record says it never moved', stray?.moved === false && stray.restorable === false, JSON.stringify(stray));
  fs.rmSync(path.join(home, '.agent-config-studio', 'trash', stray.id), { recursive: true });

  mutate._setTrashFault((step) => { if (step === 'after-move') throw new Error('injected: after the move'); });
  try { r = await batch(four.slice(0, 2)); } finally { mutate._setTrashFault(null); }
  ok('D6 a throw after the move is moved-but-unfinished, never failed', r.json?.results?.[0]?.status === 'moved-but-unfinished'
     && r.json.results[1].status === 'not-attempted' && r.json.results[0].trashId, r.text.slice(0, 300));
  const t1 = await trashed(r.json.results[0].trashId);
  ok('D6 …the file is gone and listTrash has it restorable', !fs.existsSync(four[0]) && t1?.restorable === true, JSON.stringify(t1));
  await mutate.restoreTrash({ id: t1.id });
  ok('D6 …and it restores', fs.readFileSync(four[0], 'utf8') === 'f1\n');

  // The final metadata rename fails: a folder squats where the record goes.
  const trashRoot = path.join(home, '.agent-config-studio', 'trash');
  mutate._setTrashFault((step) => {
    if (step !== 'after-move') return;
    for (const d of fs.readdirSync(trashRoot)) {
      const pending = path.join(trashRoot, d, 'trash-meta.pending.json');
      try { if (JSON.parse(fs.readFileSync(pending, 'utf8')).originalPath === four[1]) fs.mkdirSync(path.join(trashRoot, d, 'trash-meta.json')); } catch {}
    }
  });
  try { r = await batch([four[1]]); } finally { mutate._setTrashFault(null); }
  ok('D6 a failure finalising the metadata is moved-but-unfinished', r.json?.results?.[0]?.status === 'moved-but-unfinished', r.text.slice(0, 300));
  const t2 = await trashed(r.json.results[0].trashId);
  ok('D6 …listed as an interrupted, restorable entry', t2?.interrupted === true && t2.restorable === true && !fs.existsSync(four[1]), JSON.stringify(t2));
  fs.rmdirSync(path.join(trashRoot, t2.id, 'trash-meta.json'));
  await mutate.restoreTrash({ id: t2.id });
  ok('D6 …and restores', fs.readFileSync(four[1], 'utf8') === 'f2\n');
}

// ── a root revoked between preflight and the move ─────────────────────────
{
  const three = ['x', 'y', 'z'].map((n) => scratch(`rev/${n}.md`));
  // The second check of item 2 is the one immediately before its move (the first is preflight's).
  let seen = 0;
  _setBeforeWriteCheck((abs) => {
    if (abs !== three[1] || ++seen < 2) return;
    _setBeforeWriteCheck(null);
    roots.removeRoot('work', { home });
  });
  let r;
  try { r = await batch(three); } finally { _setBeforeWriteCheck(null); }
  ok('D4 revoked before item 2 moves: trashed, failed, not-attempted', r.status === 200
     && r.json.results.map((x) => x.status).join() === 'trashed,failed,not-attempted', r.text.slice(0, 300));
  ok('D4 …items 2 and 3 stay where they were', fs.existsSync(three[1]) && fs.existsSync(three[2]) && !fs.existsSync(three[0]));
  addWork();
  await mutate.restoreTrash({ id: r.json.results[0].trashId });
}

// ── a history failure is a warning, and the delete still happens ──────────
{
  const f = scratch('hist.md', 'keep my bytes\n');
  const hist = path.join(home, '.agent-config-studio', 'history');
  const parked = `${hist}.parked`;
  fs.renameSync(path.join(hist, '.git'), parked);
  fs.writeFileSync(path.join(hist, '.git'), 'gitdir: /nonexistent\n');
  let r;
  try { r = await batch([f]); }
  finally { fs.rmSync(path.join(hist, '.git'), { force: true }); fs.renameSync(parked, path.join(hist, '.git')); }
  ok('D7 a history failure surfaces in historyWarnings', r.status === 200 && r.json.historyWarnings.length === 1
     && r.json.historyWarnings[0].display === '~/code/work/scratch/hist.md' && r.json.historyWarnings[0].error, r.text.slice(0, 300));
  ok('D7 …the item is still trashed, and its bytes come back from Trash', r.json.results[0].status === 'trashed'
     && (await mutate.restoreTrash({ id: r.json.results[0].trashId })).restored && fs.readFileSync(f, 'utf8') === 'keep my bytes\n');
}

// ── end to end: the real route's partial answer reaches the page's notice ──
{
  const { bootPage, routesFor, settle } = await import('./fixtures/shell-page.mjs');
  const proxy = (p, method) => async (b) => {
    const r = await call(p, method, b);
    if (r.status !== 200) throw { status: r.status, body: r.json };
    return r.json;
  };
  const page = await bootPage({ hash: '#context', routes: routesFor({
    'GET /api/context': proxy('/api/context', 'GET'),
    'POST /api/delete/batch': proxy('/api/delete/batch', 'POST'),
  }) });
  await settle(30);
  const pick = ['e2e-1', 'e2e-2', 'e2e-3'].map((n) => { const f = path.join(work, n, 'CLAUDE.md'); put(f, `# ${n}\n`); return f; });
  const box = (f) => page.$('content').querySelectorAll('.sel-check').find((b) => b.getAttribute('aria-label') === `Select ${'~' + f.slice(home.length)}`);
  // Wait for the new files themselves, not for any checkbox: the rows from
  // boot are already there, and a slow runner's re-read can land later. The
  // server learns of new files through its watcher, so re-open until they show
  // (bounded at ~5 s); the assertion below is unchanged.
  page.eval('openContext()');
  for (let i = 0; i < 100 && !pick.every(box); i++) {
    await settle(50);
    if (i % 10 === 9) page.eval('openContext()');
  }
  ok('E2E the real Context payload renders a checkbox for each new file', pick.every(box), page.$('content').querySelectorAll('.sel-check').map((b) => b.getAttribute('aria-label')).join(' | '));
  for (const f of pick) box(f).click();
  let n = 0;
  mutate._setTrashFault((step) => { if (step === 'after-move' && ++n === 2) throw new Error('injected: metadata write failed'); });
  try {
    page.$('content').querySelector('.sel-bar').querySelectorAll('button').find((b) => b.textContent.startsWith('Delete')).click();
    for (let i = 0; i < 100 && !/Deleted/.test(page.text(page.$('notice-slot'))); i++) await settle(20);
  } finally { mutate._setTrashFault(null); }
  const t = page.text(page.$('notice-slot'));
  ok('E2E the notice reports one trashed, one moved-but-unfinished with its error, one not attempted',
     /Deleted 1 file\./.test(t) && /e2e-2\/CLAUDE\.md: moved to Trash, but the delete did not finish \(injected: metadata write failed\)/.test(t)
     && /e2e-3\/CLAUDE\.md: not attempted/.test(t), t);
  ok('E2E …and the disk agrees', !fs.existsSync(pick[0]) && !fs.existsSync(pick[1]) && fs.existsSync(pick[2]));
  ok('E2E …the re-read Context no longer offers the deleted two', !box(pick[0]) && !box(pick[1]) && box(pick[2]));
  ok('E2E no page errors', page.errors.length === 0, page.errors.join('; '));
  page.done();
}

await new Promise((r) => server.close(r));
fs.rmSync(home, { recursive: true, force: true });
assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
