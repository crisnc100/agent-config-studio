/**
 * Which live-change events are the studio's own writes (lib/watch.js
 * expectWrite / tagOrigin): the server tags them at the moment it writes, and
 * a change counts as the studio's only while the file on disk is exactly what
 * it wrote. Everything else must reach the page as an outside change.
 *
 * HOME is redirected to a temp dir before anything from lib/ loads.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { seedMemoryHome, unlockMemoryHome } from './fixtures/memory-home.mjs';

const realBefore = snapshotRealHomes();
const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-own-')));
process.env.HOME = fakeHome;
process.env.ACS_SUITE = 'offline';
delete process.env.CODEX_HOME;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\nown writes');

const fx = seedMemoryHome(fakeHome);
const { expectWrite, tagOrigin, _expectationCount } = await import('../lib/watch.js');
const mutate = await import('../lib/mutate.js');
const ops = await import('../lib/memory-ops.js');
await (await import('../lib/history.js')).ensureRepo();
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const tag = (delta) => tagOrigin({ added: [], removed: [], changed: [], ...delta });
const isStudio = (r, kind, p) => r.studio[kind].includes(p) && !r.outside[kind].includes(p);
const isOutside = (r, kind, p) => r.outside[kind].includes(p) && !r.studio[kind].includes(p);
const index = path.join(fx.mem, 'MEMORY.md');

// The basics, on a scratch file.
{
  const f = path.join(fx.mem, 'scratch.md');
  fs.writeFileSync(f, 'mine\n');
  expectWrite(f, 'changed', sha('mine\n'));
  ok('a studio write whose bytes are still on disk is tagged studio', isStudio(tag({ changed: [f] }), 'changed', f));
  ok('…once: the same change seen again is an outside change', isOutside(tag({ changed: [f] }), 'changed', f));

  expectWrite(f, 'changed', sha('mine\n'));
  fs.writeFileSync(f, 'theirs\n');
  ok('an outside write of different bytes inside the window is not the studio\'s', isOutside(tag({ changed: [f] }), 'changed', f));

  const g = path.join(fx.mem, 'scratch-2.md');
  fs.writeFileSync(g, 'mine\n');
  expectWrite(g, 'changed', sha('mine\n'), Date.now() - 11_000);
  ok('an expectation lapses after its window', isOutside(tag({ changed: [g] }), 'changed', g));
  fs.rmSync(g);

  expectWrite(f, 'changed', sha('mine\n'));
  ok('the kind must match too: a removal is not the expected change', isOutside(tag({ removed: [f] }), 'removed', f));
  fs.rmSync(f);
}

// Real operations: Accept and Restore tag exactly what they wrote.
const view = () => ops.memoryView();
let V = await view();
const row = (rel) => V.rows.find((r) => r.rel === rel && r.slug === fx.slugs.alpha);
const fact = path.join(fx.mem, 'fact-c.md');
const factBytes = fs.readFileSync(fact, 'utf8');
const p1 = ops.preview({ action: 'trash-fact', ids: [row('fact-c.md').id] });
await ops.accept(p1.opId);
{
  const r = tag({ removed: [fact], changed: [index] });
  ok('Accept of a fact trash: its removal and its index edit are tagged studio', isStudio(r, 'removed', fact) && isStudio(r, 'changed', index));
  // Repro 2: someone recreates the just-trashed fact.
  fs.writeFileSync(fact, factBytes);
  ok('an outside recreation of a just-trashed fact is announced, even with the same bytes', isOutside(tag({ added: [fact] }), 'added', fact));
  fs.rmSync(fact);
}

const r1 = await ops.restore(p1.opId);
{
  const r = tag({ added: [fact], changed: [index] });
  ok('Restore tags the fact it put back and the index it rewrote', r1.restored && isStudio(r, 'added', fact) && isStudio(r, 'changed', index));
  // Repro 1: a refused retry writes nothing, so an outside change at a path
  // the restore undid earlier is announced.
  let refused = false;
  try { await ops.restore(p1.opId); } catch (e) { refused = e.status === 409; }
  fs.appendFileSync(index, 'outside edit\n');
  ok('after a refused Restore retry, an outside change at a previously undone path is announced',
     refused && isOutside(tag({ changed: [index] }), 'changed', index));
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace('outside edit\n', ''));
  tag({ changed: [index] });
}

// Repro 3: two overlapping restores each tag only their own writes.
{
  V = await view();
  const a = path.join(fx.mem, 'live-1.md');
  const b = path.join(fx.mem, 'live-2.md');
  const pa = ops.preview({ action: 'trash-fact', ids: [row('live-1.md').id] });
  await ops.accept(pa.opId);
  V = await view();
  const pb = ops.preview({ action: 'trash-fact', ids: [row('live-2.md').id] });
  await ops.accept(pb.opId);
  tag({ removed: [a, b], changed: [index, index] });   // consume the Accepts' own events
  const other = path.join(fx.mem, 'live-3.md');
  const [ra, rb] = await Promise.all([ops.restore(pb.opId), ops.restore(pa.opId)]);
  fs.appendFileSync(other, 'outside\n');
  const r = tag({ added: [a, b], changed: [other] });
  ok('two overlapping restores both land', ra.restored && rb.restored, JSON.stringify([ra.reason, rb.reason]));
  ok('…each tags its own fact as studio', isStudio(r, 'added', a) && isStudio(r, 'added', b));
  ok('…and an outside change in the same batch stays outside', isOutside(r, 'changed', other));
}

// The grader's earlier case: a bulk trash that skipped a slug, then someone
// drops OUTSIDE.md under the skipped slug.
{
  V = await view();
  const ids = V.findings.emptySlugs.filter((e) => !e.probe).map((e) => e.id);
  const pv = ops.preview({ action: 'trash-empty-slugs', ids });
  fs.writeFileSync(path.join(fx.emptyB, 'memory', 'late.md'), 'late\n');
  await ops.accept(pv.opId);
  const outsideFile = path.join(fx.emptyB, 'memory', 'OUTSIDE.md');
  fs.writeFileSync(outsideFile, 'outside\n');
  const r = tag({ removed: [fx.emptyA], added: [outsideFile] });
  ok('the trashed slug is tagged studio', isStudio(r, 'removed', fx.emptyA));
  ok('OUTSIDE.md under the skipped slug is announced', isOutside(r, 'added', outsideFile));
}

// An editor save: the route records its own write the same way.
{
  const { createApp } = await import('../server.js');
  const { server } = createApp();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const B = `http://localhost:${server.address().port}`;
  const f = path.join(fx.mem, 'fact-a.md');
  const file = await (await fetch(`${B}/api/file?path=${encodeURIComponent(f)}`)).json();
  const content = file.content + 'saved in the editor\n';
  const put = await fetch(`${B}/api/file`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: f, content, mtime: file.mtime }) });
  ok('an editor save is tagged studio', put.ok && isStudio(tag({ changed: [f] }), 'changed', f));
  fs.appendFileSync(f, 'then someone else\n');
  ok('…and the next outside edit of it is not', isOutside(tag({ changed: [f] }), 'changed', f));
  server.close();
}

// Round 7 — 1: a trash registers one removal per path, and a mismatch cancels.
{
  const f = path.join(fx.mem, 'gone-soon.md');
  fs.writeFileSync(f, 'studio bytes\n');
  await mutate.remove({ path: f });
  ok('R7 the trash itself is tagged studio', isStudio(tag({ removed: [f] }), 'removed', f));
  fs.writeFileSync(f, 'someone else\n');
  ok('R7 an outside recreation with different bytes is announced', isOutside(tag({ added: [f] }), 'added', f));
  fs.rmSync(f);
  ok('R7 …and its outside deletion within 10 s is announced too (no second removal left over)', isOutside(tag({ removed: [f] }), 'removed', f));

  const g = path.join(fx.mem, 'bounce.md');
  fs.writeFileSync(g, 'studio\n');
  expectWrite(g, 'changed', sha('studio\n'));
  fs.writeFileSync(g, 'theirs\n');
  ok('R7 a mismatching event cancels the expectation', isOutside(tag({ changed: [g] }), 'changed', g));
  fs.writeFileSync(g, 'studio\n');
  ok('R7 …so a later return to the studio\'s exact bytes is not tagged studio', isOutside(tag({ changed: [g] }), 'changed', g));
  fs.rmSync(g);
}

// Round 7 — 2: expectations are reclaimed, and capped.
{
  tagOrigin({}, Date.now() + 60_000);   // clear whatever the tests above left open
  const dir = path.join(fx.mem, 'bulk');
  fs.mkdirSync(dir);
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(dir, `f${i}.md`), `n${i}\n`);
  await mutate.remove({ path: dir });
  ok('R7 a 200-file trash registers one expectation per path (plus the folder)', _expectationCount() === 201, String(_expectationCount()));
  const files = Array.from({ length: 200 }, (_, i) => path.join(dir, `f${i}.md`));
  const r = tag({ removed: files });
  ok('R7 …its 200 removals are tagged studio and consumed', r.studio.removed.length === 200 && _expectationCount() === 1, String(_expectationCount()));
  tagOrigin({}, Date.now() + 11_000);
  ok('R7 …and after the window nothing is left', _expectationCount() === 0, String(_expectationCount()));
  const t0 = Date.now();
  for (let i = 0; i < 6_000; i++) expectWrite(path.join(fx.mem, `cap-${i}.md`), 'changed', sha(String(i)), t0);
  ok('R7 the open expectations are capped at 5,000', _expectationCount() === 5_000, String(_expectationCount()));
  fs.writeFileSync(path.join(fx.mem, 'cap-0.md'), '0');
  fs.writeFileSync(path.join(fx.mem, 'cap-5999.md'), '5999');
  const rc = tag({ changed: [path.join(fx.mem, 'cap-0.md'), path.join(fx.mem, 'cap-5999.md')] });
  ok('R7 …evicting the oldest first', rc.outside.changed.includes(path.join(fx.mem, 'cap-0.md')) && rc.studio.changed.includes(path.join(fx.mem, 'cap-5999.md')));
  tagOrigin({}, t0 + 60_000);
}

// Round 7 — 3: a studio event still syncs other tabs; only the wording changes.
{
  const vm = await import('node:vm');
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'file-events.js'), 'utf8'), ctx);
  const plan = (d, o) => JSON.parse(JSON.stringify(ctx.fileEventPlan(d, o)));
  const f = '/x/memory/fact.md';
  ok('R7 a studio change to a clean open file is reloaded, quietly',
     JSON.stringify(plan({ origin: 'studio', changedPaths: [f] }, { openPath: f, dirty: false })) === JSON.stringify({ open: 'reload', studio: true }));
  ok('R7 a studio change to a dirty open file still gets the conflict warning',
     plan({ origin: 'studio', changedPaths: [f] }, { openPath: f, dirty: true }).open === 'conflict');
  ok('R7 a studio removal of the open file closes it', plan({ origin: 'studio', removedPaths: [f] }, { openPath: f }).open === 'closed');
  ok('R7 an outside change is reloaded and announced', JSON.stringify(plan({ origin: 'outside', changedPaths: [f] }, { openPath: f })) === JSON.stringify({ open: 'reload', studio: false }));
  ok('R7 studio adds/removes elsewhere are not announced; outside ones are',
     plan({ origin: 'studio', added: ['~/a'] }, { openPath: f }).announce === false && plan({ origin: 'outside', added: ['~/a'] }, { openPath: f }).announce === true);
  const app = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'app.js'), 'utf8');
  const handler = app.slice(app.indexOf('async function handleFileEvent'), app.indexOf('\n}\n', app.indexOf('async function handleFileEvent')));
  ok('R7 the page acts on that plan and no longer returns early for studio events',
     handler.includes('fileEventPlan(') && !/origin === 'studio'\) \{ setLive\(true\); return; \}/.test(handler));
}

assertRealHomesUnchanged(realBefore, ok);
unlockMemoryHome(fakeHome);
fs.rmSync(fakeHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
