/**
 * Memory's multi-select delete is the trash-fact operation over several ids
 * (builds/batch-delete/plan.md, fold D1): every fact to the ACS trash, its
 * index links removed, and one Restore bringing every file and link back.
 * Indexed and unindexed facts, two indexes, one memory folder with none.
 *
 * HOME is redirected to a temp directory before anything from lib/ loads.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { seedMemoryHome, unlockMemoryHome } from './fixtures/memory-home.mjs';

const realHome = os.homedir();
const realBefore = snapshotRealHomes();
const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-batch-mem-')));
process.env.HOME = fakeHome;
process.env.ACS_SUITE = 'offline';
delete process.env.CODEX_HOME;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

console.log('\nbatch delete — memory');
ok('HOME is redirected away from the real one', os.homedir() === fakeHome && fakeHome !== realHome);
const fx = seedMemoryHome(fakeHome);
const PROJ = path.join(fakeHome, '.claude', 'projects');
await (await import('../lib/history.js')).ensureRepo();
const mutate = await import('../lib/mutate.js');

const { createApp } = await import('../server.js');
const { server } = createApp();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const B = `http://localhost:${server.address().port}`;
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch {}
  return [r.status, json];
};
const view = async () => (await call('GET', '/api/memory'))[1];

let V = await view();
const row = (rel, slug = fx.slugs.alpha) => V.rows.find((r) => r.rel === rel && r.slug === slug);
const alphaIndex = path.join(fx.mem, 'MEMORY.md');
const oldIndex = path.join(fx.oldAlpha, 'memory', 'MEMORY.md');
const picks = [
  row('fact-b.md'),                                   // indexed, one link
  row('live-1.md'),                                   // indexed, two links on two lines
  row('unindexed.md'),                                // in a folder with an index, but not in it
  row('jot.md', fx.slugs.notes),                      // a folder with no index at all
  V.rows.find((r) => r.openPath === path.join(fx.oldAlpha, 'memory', 'fact-a.md')), // a second index
];
ok('every picked fact is a row with an id', picks.every((r) => r?.id), JSON.stringify(picks.map((r) => r?.rel)));
const files = picks.map((r) => r.openPath);
const before = Object.fromEntries([...files, alphaIndex, oldIndex].map((f) => [f, sha(f)]));
const alphaText = fs.readFileSync(alphaIndex, 'utf8');
const danglingBefore = V.findings.dangling.length;

{
  const [, one] = await call('POST', '/api/memory/preview', { action: 'trash-fact', ids: [row('fact-b.md').id] });
  ok('D1 one id still previews exactly as before', one.summary === 'Trash fact-b.md and its index link'
     && one.items.length === 1 && one.diffs.length === 1, JSON.stringify(one).slice(0, 200));
}

const [ps, pv] = await call('POST', '/api/memory/preview', { action: 'trash-fact', ids: picks.map((r) => r.id) });
ok('D1 several facts preview as one operation', ps === 200 && pv.summary === 'Trash 5 facts and their index links', JSON.stringify(pv).slice(0, 300));
ok('D1 …listing every file', pv.items.length === 5 && files.every((f) => pv.items.some((it) => it.startsWith('~' + f.slice(fakeHome.length)))));
ok('D1 …with one diff per index touched (two), none for the folder without one', pv.diffs.length === 2, JSON.stringify(pv.diffs.map((d) => d.label)));
const alphaDiff = pv.diffs.find((d) => d.label.endsWith(path.join(fx.slugs.alpha, 'memory', 'MEMORY.md')));
ok('D1 …the alpha index loses every link to the picked facts, and only those',
   alphaDiff && !/\(fact-b\.md\)|\(live-1\.md\)/.test(alphaDiff.after) && alphaDiff.after.includes('(fact-a.md)')
   && alphaDiff.after.includes('(live-2.md)') && alphaDiff.after.includes('Prose that must survive every edit byte for byte.'), alphaDiff?.after);
ok('D1 …and nothing has changed yet', [...files, alphaIndex, oldIndex].every((f) => sha(f) === before[f]));

const [as, ar] = await call('POST', '/api/memory/accept', { opId: pv.opId });
ok('D1 accepted: every file is gone', as === 200 && ar.status === 'applied' && files.every((f) => !fs.existsSync(f)), JSON.stringify(ar).slice(0, 300));
ok('D1 …the index is exactly the preview', fs.readFileSync(alphaIndex, 'utf8') === alphaDiff.after);
ok('D1 …the second index lost its link', !fs.readFileSync(oldIndex, 'utf8').includes('(fact-a.md)'));
const trash = await mutate.listTrash();
ok('D1 …and each file is in the ACS trash', files.every((f) => trash.some((t) => t.originalPath === f && t.moved)));
V = await view();
ok('D1 the refreshed view has none of them, and no new dangling link', picks.every((p) => !V.rows.some((r) => r.openPath === p.openPath))
   && V.findings.dangling.length === danglingBefore, `${V.findings.dangling.length} vs ${danglingBefore}`);

const [rs, rr] = await call('POST', '/api/memory/restore', { opId: pv.opId });
ok('D1 one Restore brings every file back, byte-identical', rs === 200 && rr.restored && files.every((f) => sha(f) === before[f]), JSON.stringify(rr).slice(0, 300));
ok('D1 …and every link: both indexes byte-identical', fs.readFileSync(alphaIndex, 'utf8') === alphaText && sha(oldIndex) === before[oldIndex]);

// A fact edited between preview and Accept refuses the whole operation.
V = await view();
const [, p2] = await call('POST', '/api/memory/preview', { action: 'trash-fact', ids: [row('fact-b.md').id, row('fact-c.md').id] });
fs.appendFileSync(path.join(fx.mem, 'fact-c.md'), 'edited meanwhile\n');
const treeBefore = [path.join(fx.mem, 'fact-b.md'), alphaIndex].map(sha).join();
const [s2] = await call('POST', '/api/memory/accept', { opId: p2.opId });
ok('D1 a fact edited after the preview refuses the batch, nothing changed', s2 === 409
   && [path.join(fx.mem, 'fact-b.md'), alphaIndex].map(sha).join() === treeBefore);

fs.writeFileSync(path.join(fx.mem, 'fact-c.md'), fs.readFileSync(path.join(fx.mem, 'fact-c.md'), 'utf8').replace('edited meanwhile\n', ''));
const ops = await import('../lib/memory-ops.js');

// Freshness at preview: a fact gone since the view loaded refuses the whole preview, by name.
{
  V = await view();
  const ids = [row('fact-b.md').id, row('future.md').id];
  const futurePath = path.join(fx.mem, 'future.md');
  const parked = `${futurePath}.parked`;
  fs.renameSync(futurePath, parked);
  const [s, j] = await call('POST', '/api/memory/preview', { action: 'trash-fact', ids });
  fs.renameSync(parked, futurePath);
  ok('D1 a fact gone since the view refuses the whole preview with 409, naming it', s === 409 && /future\.md is gone/.test(j?.error), JSON.stringify(j));
  ok('D1 …and nothing changed', fs.existsSync(path.join(fx.mem, 'fact-b.md')) && fs.readFileSync(alphaIndex, 'utf8') === alphaText);
}

// One edit per index: three facts sharing alpha's MEMORY.md, one in the old copy's.
const trio = ['fact-b.md', 'fact-c.md', 'live-1.md'];
const shared = (rels) => {
  const lines0 = alphaText.split('\n');
  return lines0.filter((l) => !rels.some((r) => l.includes(`(${r})`)));
};
{
  V = await view();
  const ids = [...trio.map((r) => row(r).id), V.rows.find((r) => r.openPath === path.join(fx.oldAlpha, 'memory', 'fact-a.md')).id];
  const [, p3] = await call('POST', '/api/memory/preview', { action: 'trash-fact', ids });
  ok('D1 3 facts in one index + 1 in another: exactly two index diffs', p3.diffs.length === 2, JSON.stringify(p3.diffs.map((d) => d.label)));
  const [as3, ar3] = await call('POST', '/api/memory/accept', { opId: p3.opId });
  const editSteps = ar3.steps.filter((s) => s.type === 'edit-index');
  ok('D1 …accepted as 4 trash steps and ONE edit-index step per index', as3 === 200 && ar3.steps.filter((s) => s.type === 'trash').length === 4
     && editSteps.length === 2 && new Set(editSteps.map((s) => s.path)).size === 2, JSON.stringify(ar3.steps));
  const after = fs.readFileSync(alphaIndex, 'utf8');
  ok('D1 …every link to the three is gone from the shared index', trio.every((r) => !after.includes(`(${r})`)));
  ok('D1 …and every line that held none of them is byte-identical', shared(trio).every((l) => after.split('\n').includes(l)), after);
  ok('D1 …the other index lost its link', !fs.readFileSync(oldIndex, 'utf8').includes('(fact-a.md)'));
  const [, rr3] = await call('POST', '/api/memory/restore', { opId: p3.opId });
  ok('D1 restore: both indexes byte-identical to before, all 4 files back', rr3.restored && fs.readFileSync(alphaIndex, 'utf8') === alphaText
     && sha(oldIndex) === before[oldIndex] && [...trio.map((r) => path.join(fx.mem, r)), path.join(fx.oldAlpha, 'memory', 'fact-a.md')].every((f) => fs.existsSync(f))
     && sha(path.join(fx.mem, 'fact-b.md')) === before[path.join(fx.mem, 'fact-b.md')], JSON.stringify(rr3).slice(0, 200));
}

// A fault mid-accept leaves an operation Restore can undo.
{
  V = await view();
  const ids = trio.map((r) => row(r).id);
  const filesT = trio.map((r) => path.join(fx.mem, r));
  const shas = filesT.map(sha);
  const [, p4] = await call('POST', '/api/memory/preview', { action: 'trash-fact', ids });
  let steps = 0;
  ops._setOpFault((pt) => { if (pt === 'before-step' && ++steps === 3) throw new Error('injected mid-accept'); });
  let s4, a4;
  try { [s4, a4] = await call('POST', '/api/memory/accept', { opId: p4.opId }); } finally { ops._setOpFault(null); }
  ok('D1 a fault before step 3 stops the accept with an error', s4 === 500 && /injected mid-accept/.test(a4?.error), JSON.stringify(a4));
  ok('grade 4: the error body carries the op record, naming the two facts that moved', a4?.op?.status === 'failed'
     && a4.op.steps.filter((x) => x.type === 'trash' && x.done).map((x) => x.path).join() === filesT.slice(0, 2).map((f) => '~' + f.slice(fakeHome.length)).join(),
     JSON.stringify(a4?.op?.steps));
  ok('D1 …two facts are already trashed, the third and the index untouched', !fs.existsSync(filesT[0]) && !fs.existsSync(filesT[1])
     && sha(filesT[2]) === shas[2] && fs.readFileSync(alphaIndex, 'utf8') === alphaText);
  const [, list] = await call('GET', '/api/memory/ops');
  ok('D1 …the operation is recorded as failed', list.ops.find((o) => o.id === p4.opId)?.status === 'failed');
  const [, r4] = await call('POST', '/api/memory/restore', { opId: p4.opId });
  ok('D1 …and Restore brings both back, byte-identical, index unchanged', r4.restored && filesT.every((f, i) => sha(f) === shas[i])
     && fs.readFileSync(alphaIndex, 'utf8') === alphaText, JSON.stringify(r4).slice(0, 300));
}

await new Promise((r) => server.close(r));
assertRealHomesUnchanged(realBefore, ok);
unlockMemoryHome(fakeHome);
fs.rmSync(fakeHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
