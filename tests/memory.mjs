/**
 * The Memory view: discovery, the link-level index editor, eligibility, the
 * trash, operations and undo, conflicts, and the id-only HTTP surface
 * (criteria 1–7 and 11 of builds/memory-review/plan.md).
 *
 * HOME is redirected to a temp directory BEFORE anything from lib/ is
 * imported, because lib/paths.js binds HOME at module load. The fixture is
 * tests/fixtures/memory-home.mjs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import {
  seedMemoryHome, unlockMemoryHome, alphaIndex, RUN_LINE, RUN_LINKS, MARK, TS, enc,
} from './fixtures/memory-home.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realHome = os.homedir();
const realBefore = snapshotRealHomes();

const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-memory-')));
process.env.HOME = fakeHome;
process.env.ACS_SUITE = 'offline';
delete process.env.CODEX_HOME;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
/** Every file and directory under `root`, by sha256 — "nothing changed" is this, compared. */
const treeHash = (root) => {
  const out = {};
  const walk = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    if (st.isSymbolicLink()) { out[p] = `link:${fs.readlinkSync(p)}`; return; }
    if (st.isFile()) { out[p] = sha(p); return; }
    if (!st.isDirectory()) return;
    out[p] = 'dir';
    let names = [];
    try { names = fs.readdirSync(p); } catch { return; }
    for (const n of names) walk(path.join(p, n));
  };
  walk(root);
  return JSON.stringify(out);
};

console.log('\nmemory');
ok('HOME is redirected away from the real one', os.homedir() === fakeHome && fakeHome !== realHome);

const fx = seedMemoryHome(fakeHome);
const PROJ = path.join(fakeHome, '.claude', 'projects');

const mi = await import('../lib/memory-index.js');
const ops = await import('../lib/memory-ops.js');
const mutate = await import('../lib/mutate.js');
// Initialised up front, as the server does at start: a history repo created
// lazily by two concurrent first writes races on `git init`.
await (await import('../lib/history.js')).ensureRepo();

// ── criterion 1: discovery on fixtures ────────────────────────────────────
{
  const writes = await mi.scanMemoryWrites({ cache: false });
  const inv = await mi.discoverMemory({ writes });
  const slug = (name) => inv.slugs.find((s) => s.slug === name);

  ok('C1 resolved: the main checkout slug', slug(fx.slugs.alpha)?.state === 'resolved', slug(fx.slugs.alpha)?.state);
  ok('C1 non-git: a plain folder', slug(fx.slugs.notes)?.state === 'non-git', slug(fx.slugs.notes)?.state);
  ok('C1 ambiguous: my-app and my_app encode to one slug', slug(fx.slugs.ambiguous)?.state === 'ambiguous'
     && slug(fx.slugs.ambiguous).candidates.length === 2, JSON.stringify(slug(fx.slugs.ambiguous)));
  ok('C1 inaccessible: a directory on the way cannot be listed', slug(fx.slugs.inaccessible)?.state === 'inaccessible',
     slug(fx.slugs.inaccessible)?.state);
  ok('C1 missing: every candidate prefix listed, none led anywhere', slug(fx.slugs.missing)?.state === 'missing'
     && slug(fx.slugs.missing).nearest === path.join(fakeHome, 'Documents'), JSON.stringify(slug(fx.slugs.missing)?.nearest));

  const alphaKey = slug(fx.slugs.alpha).groupKey;
  ok('C1 two-step worktree: .git file (relative gitdir) → commondir → the main .git',
     slug(fx.slugs.wt)?.state === 'resolved' && slug(fx.slugs.wt).repo.worktree === true
     && slug(fx.slugs.wt).groupKey === alphaKey, JSON.stringify(slug(fx.slugs.wt)?.repo));
  ok('C1 a project dir below the checkout root groups with its repo',
     slug(fx.slugs.web)?.groupKey === alphaKey && slug(fx.slugs.web).repo.root === fx.alpha);
  ok('C1 the group is keyed by the common dir, labelled by the main checkout',
     inv.groups.find((g) => g.key === alphaKey)?.label === 'alpha');

  const probes = inv.slugs.filter((s) => s.probe).map((s) => s.slug).sort();
  ok('C1 temp probes are recognised', probes.length === 2 && probes.every((p) => /^-private-/.test(p)), JSON.stringify(probes));

  const alphaRows = inv.rows.filter((r) => r.slug === fx.slugs.alpha);
  ok('C1 MEMORY.md is never a row', !inv.rows.some((r) => path.basename(r.rel) === 'MEMORY.md'));
  const moved = alphaRows.find((r) => r.rel === '_archive/moved.md');
  ok('C1 _archive/ files are rows marked archived', moved?.archived === true && alphaRows.find((r) => r.rel === '_archive/never-linked.md')?.archived === true);
  ok('C1 …and never offered for indexing', !inv.findings.unindexed.some((u) => u.rel.startsWith('_archive/')),
     JSON.stringify(inv.findings.unindexed.map((u) => u.rel)));
  const byRel = (rel) => alphaRows.find((r) => r.rel === rel);
  ok('C1 nested frontmatter format', byRel('fact-a.md')?.format === 'nested' && byRel('fact-a.md').type === 'project'
     && byRel('fact-a.md').modifiedSource === 'frontmatter' && byRel('fact-a.md').modified === Date.parse('2026-03-01T00:00:00.000Z'));
  ok('C1 flat (older) frontmatter format', byRel('fact-b.md')?.format === 'flat' && byRel('fact-b.md').type === 'feedback');
  ok('C1 no frontmatter at all', byRel('fact-c.md')?.format === 'none' && byRel('fact-c.md').name === 'fact-c');
  ok('C1 a future date is flagged and falls back to mtime',
     byRel('future.md')?.modifiedFlag === 'future' && byRel('future.md').modifiedSource === 'mtime'
     && byRel('future.md').modified === byRel('future.md').mtimeMs);

  const a = byRel('fact-a.md');
  ok('C1 lastWrite: 50 mentions, 1 ok Edit, 1 errored, 1 unanswered, 1 subagent Write → exactly 2 writes',
     a?.writeCount === 2, `writeCount=${a?.writeCount}`);
  ok('C1 lastWrite is the subagent write (newest SUCCESSFUL), not the newer failed attempts',
     a?.lastWrite === TS.sub, a?.lastWrite);
  ok('C1 no evidence → unknown (null), never a zero or a "never"', byRel('fact-b.md')?.lastWrite === null
     && byRel('fact-b.md').writeCount === 0);
  ok('C1 the torn last line did not break the scan', writes.stats.transcripts >= 4, JSON.stringify(writes.stats));

  const excluded = slug(fx.slugs.alpha).memory.excluded.map((x) => `${x.rel}:${x.reason}`);
  ok('C1 a symlink planted in memory/ is excluded, not read', excluded.some((x) => x.startsWith('sneaky.md:symlink')), excluded.join(', '));
  ok('C1 a deny-listed name is excluded', excluded.some((x) => x.startsWith('auth.json:protected')), excluded.join(', '));
  ok('C1 a symlinked memory dir yields no rows', !inv.rows.some((r) => r.slug === enc(path.join(fakeHome, 'Documents', 'Projects', 'linked-mem'))));
  ok('C1 a symlinked slug dir is skipped', !inv.slugs.some((s) => s.slug === enc(path.join(fakeHome, 'Documents', 'Projects', 'linked-slug'))));

  const f = inv.findings;
  ok('C1 orphan: the missing slug with memory, with its state and a same-named counterpart',
     f.orphans.some((o) => o.slug === fx.slugs.missing && o.state === 'missing' && o.counterparts.includes(alphaKey)),
     JSON.stringify(f.orphans.map((o) => [o.slug.slice(-20), o.state, o.counterparts.length])));
  ok('C1 ambiguous and inaccessible memory are listed with THEIR state, not as missing',
     f.orphans.some((o) => o.slug === fx.slugs.ambiguous && o.state === 'ambiguous')
     && f.orphans.some((o) => o.slug === fx.slugs.inaccessible && o.state === 'inaccessible'));
  ok('C1 duplicate names across dirs are found', f.duplicates.some((d) => d.name === 'fact-a' && d.rows.length === 2));
  ok('C1 dangling links: 5 in the run, the missing entry, and the archive one',
     f.dangling.filter((d) => d.slug === fx.slugs.alpha).length === 7, String(f.dangling.length));
  ok('C1 a dangling link whose file is in _archive/ is offered "point at archive"',
     f.dangling.find((d) => d.rel === 'moved.md')?.archiveRel === '_archive/moved.md');
  ok('C1 unindexed: the live file, and the fact in a dir with no index',
     f.unindexed.some((u) => u.rel === 'unindexed.md' && u.hasIndex) && f.unindexed.some((u) => u.rel === 'jot.md' && !u.hasIndex),
     JSON.stringify(f.unindexed.map((u) => u.rel)));
  ok('C1 unindexed does not include indexed facts', !f.unindexed.some((u) => ['fact-a.md', 'live-1.md'].includes(u.rel)));
  ok('C1 other stores: absent stores say so, with no count invented',
     inv.other.codex.count === null && /not present/.test(inv.other.codex.note) && inv.other.grok.count === null);
}

// ── freshness: one scan at a time, and the cache notices new writes ───────
{
  const p1 = mi.scanMemoryWrites();
  const p2 = mi.scanMemoryWrites();
  ok('concurrent callers share one scan', p1 === p2);
  const first = await p1;
  const again = await mi.scanMemoryWrites();
  ok('a second scan reuses every unchanged transcript', again.stats.scanned === 0 && again.stats.reused === first.stats.transcripts,
     JSON.stringify(again.stats));
  const factB = path.join(fx.mem, 'fact-b.md');
  const extra = path.join(PROJ, fx.slugs.alpha, 'session-new.jsonl');
  fs.writeFileSync(extra, [
    { type: 'assistant', timestamp: '2026-07-01T00:00:00.000Z', message: { content: [{ type: 'tool_use', id: 'toolu_new', name: 'Write', input: { file_path: factB, content: 'x' } }] } },
    { type: 'user', timestamp: '2026-07-01T00:00:00.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_new', content: 'ok' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const fresh = await mi.scanMemoryWrites();
  ok('a new transcript is found by the listing and read', fresh.stats.scanned === 1 && fresh.byPath.get(factB)?.last === '2026-07-01T00:00:00.000Z',
     JSON.stringify(fresh.stats));
  fs.rmSync(extra);
  const gone = await mi.scanMemoryWrites();
  ok('…and a deleted one drops its evidence', !gone.byPath.has(factB));
}

// ── criterion 2: link-level index edits are exact ─────────────────────────
{
  const text = alphaIndex();
  const links = mi.parseLinks(text);
  const run = links.filter((l) => text.slice(l.lineStart, l.lineEnd) === RUN_LINE);
  ok('C2 the fixture line holds 13 links', run.length === 13, String(run.length));
  const gone = run.filter((l) => l.rel.startsWith('gone-'));
  ok('C2 …5 of them dangling', gone.length === 5);

  // Fixing one: exactly `[fresh branches](gone-1.md) · ` disappears.
  const one = mi.editLinks(text, [{ start: gone[0].start, action: 'remove' }]);
  const expectOne = text.replace('[fresh branches](gone-1.md) · ', '');
  ok('C2 fixing one link removes exactly that link and one separator', one === expectOne);
  const lineOf = (t) => t.split('\n').find((l) => l.startsWith('- [dev:all]'));
  const others = RUN_LINKS.filter(([, f]) => f !== 'gone-1.md').map(([t, f]) => `[${t}](${f})`);
  ok('C2 …the other 12 links are byte-identical and in order', others.every((l) => lineOf(one).includes(l))
     && lineOf(one) === '- ' + others.join(' · '));
  const outside = (t) => t.split('\n').filter((l) => !l.startsWith('- [dev:all]')).join('\n');
  ok('C2 …every other byte of the file is identical', outside(one) === outside(text));
  // The byte diff, asserted: one contiguous deletion, nothing inserted.
  let i = 0;
  while (i < one.length && one[i] === text[i]) i++;
  ok('C2 …as one contiguous deletion with nothing inserted',
     text.slice(0, i) + text.slice(i + (text.length - one.length)) === one && text.length - one.length === '[fresh branches](gone-1.md) · '.length);

  const all = mi.editLinks(text, gone.map((l) => ({ start: l.start, action: 'remove' })));
  const live = RUN_LINKS.filter(([, f]) => f.startsWith('live-')).map(([t, f]) => `[${t}](${f})`);
  ok('C2 fixing all 5 in one edit leaves the 8 live links, each with its own separator',
     lineOf(all) === '- ' + live.join(' · '), lineOf(all));
  ok('C2 …and every other byte identical', outside(all) === outside(text));
  // Applied one at a time instead, the result is the same bytes.
  let seq = text;
  for (const target of ['gone-5.md', 'gone-4.md', 'gone-3.md', 'gone-2.md', 'gone-1.md']) {
    const l = mi.parseLinks(seq).find((x) => x.rel === target);
    seq = mi.editLinks(seq, [{ start: l.start, action: 'remove' }]);
  }
  ok('C2 one-at-a-time gives the same bytes as all-at-once', seq === all);

  const entry = links.find((l) => l.rel === 'gone-entry.md');
  const noEntry = mi.editLinks(text, [{ start: entry.start, action: 'remove' }]);
  // Corrected (grade bug 6): the old assertion blessed deleting the prose after the link.
  ok('C2 B6 a bullet with prose after its only link keeps the prose (the link becomes its words)',
     noEntry === text.replace('- [Gone entry](gone-entry.md) — a whole entry whose file is missing', '- Gone entry — a whole entry whose file is missing'),
     JSON.stringify(noEntry.split('\n').find((l) => l.includes('whole entry'))));
  const unrelated = '- [Missing](gone.md) — KEEP THIS UNRELATED PROSE\n';
  ok('C2 B6 the grader\'s reproduction: unrelated prose on the bullet survives',
     mi.editLinks(unrelated, [{ start: 2, action: 'remove' }]) === '- Missing — KEEP THIS UNRELATED PROSE\n');
  const bare = 'a\n- [Only](only.md)\nb\n';
  ok('C2 B6 a bullet holding nothing but the link goes whole', mi.editLinks(bare, [{ start: 4, action: 'remove' }]) === 'a\nb\n');
  const sepOnly = '- [a](a.md) · [b](b.md)\n';
  ok('C2 B6 a bullet left with only separators goes whole',
     mi.editLinks(sepOnly, mi.parseLinks(sepOnly).map((l) => ({ start: l.start, action: 'remove' }))) === '');
  const prose = links.find((l) => l.label === 'the notes');
  ok('C2 a link inside prose keeps its words', mi.editLinks(text, [{ start: prose.start, action: 'remove' }])
     === text.replace('See also [the notes](live-1.md) for more.', 'See also the notes for more.'));
  const movedL = links.find((l) => l.rel === 'moved.md');
  ok('C2 "point at archive" rewrites only the target', mi.editLinks(text, [{ start: movedL.start, action: 'retarget', to: '_archive/moved.md' }])
     === text.replace('[Moved](moved.md)', '[Moved](_archive/moved.md)'));
  let threw = false;
  try { mi.editLinks(text, [{ start: 3, action: 'remove' }]); } catch { threw = true; }
  ok('C2 an edit naming no link is refused', threw);
}

// ── the HTTP surface ──────────────────────────────────────────────────────
const { createApp } = await import('../server.js');
const { server } = createApp();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const B = `http://localhost:${server.address().port}`;
const seen = [];
const call = async (method, p, body) => {
  const r = await fetch(B + p, {
    method, headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  seen.push(text);
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return [r.status, json];
};
const view = async () => (await call('GET', '/api/memory'))[1];

let V = await view();
{
  ok('the view loads', Array.isArray(V?.rows) && V.rows.length > 0, JSON.stringify(V).slice(0, 200));
  ok('C1 temp probes are hidden from the project list', !V.groups.some((g) => g.slugs.some((s) => mi.isTempProbe(s.slug))) && V.states['temp-probe'] === 2);
  ok('C1 the view counts every slug state', ['resolved', 'non-git', 'ambiguous', 'inaccessible', 'missing', 'temp-probe'].every((k) => V.states[k] > 0),
     JSON.stringify(V.states));
  ok('C11 the payload never says unused, stale or never used', !/\bunused\b|\bstale\b|never used/i.test(JSON.stringify(V)));
  ok('C11 the caveat travels with the data', /Unknown/.test(V.caveat.text) && /says nothing about whether a memory is read/.test(V.caveat.text));
}
const row = (rel, slug = fx.slugs.alpha) => V.rows.find((r) => r.rel === rel && r.slug === slug);
const snapTree = () => treeHash(PROJ);

// ── criterion 3: eligibility is exact ─────────────────────────────────────
{
  const empties = V.findings.emptySlugs.map((e) => e.slug).sort();
  const want = [enc(path.join(fakeHome, 'Documents', 'Projects', 'empty-one')), enc(path.join(fakeHome, 'Documents', 'Projects', 'empty-two')),
    '-private-var-folders-xx-T-acs-claude-writeprobe-AbC123'].sort();
  ok('C3 offered: exactly the slugs holding nothing but an empty memory/ (a probe included)', JSON.stringify(empties) === JSON.stringify(want), JSON.stringify(empties));
  ok('C3 a slug with a transcript is never offered', !empties.includes(enc(path.join(fakeHome, 'Documents', 'Projects', 'has-transcript')))
     && !empties.includes('-private-tmp-claude-501-scratch-Zz9'));

  const ids = V.findings.emptySlugs.filter((e) => !e.probe).map((e) => e.id);
  const [ps, pv] = await call('POST', '/api/memory/preview', { action: 'trash-empty-slugs', ids });
  ok('C3 preview lists both folders', ps === 200 && pv.items.length === 2, JSON.stringify(pv));
  fs.writeFileSync(path.join(fx.emptyB, 'memory', 'arrived.md'), 'late\n');
  const [as, av] = await call('POST', '/api/memory/accept', { opId: pv.opId });
  ok('C3 a slug that gained a file after the preview is skipped and reported',
     as === 200 && av.skipped.length === 1 && /empty-two/.test(av.skipped[0]) && av.steps.length === 1, JSON.stringify(av));
  ok('C3 …it is still there, untouched', fs.readFileSync(path.join(fx.emptyB, 'memory', 'arrived.md'), 'utf8') === 'late\n');
  ok('C3 …and the still-empty one went to the trash', !fs.existsSync(fx.emptyA));
  const [rs, rv] = await call('POST', '/api/memory/restore', { opId: pv.opId });
  ok('C3 the bulk trash restores', rs === 200 && rv.restored === true && fs.existsSync(path.join(fx.emptyA, 'memory')), JSON.stringify(rv));
  fs.rmSync(path.join(fx.emptyB, 'memory', 'arrived.md'));
}

// ── criterion 4: the trash cannot lose data ───────────────────────────────
{
  const d1 = path.join(PROJ, fx.slugs.notes, 'memory', 'same.md');
  const d2 = path.join(fx.mem, 'same.md');
  fs.writeFileSync(d1, 'first\n');
  fs.writeFileSync(d2, 'second\n');
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen;
  let r1, r2;
  try { [r1, r2] = await Promise.all([mutate.remove({ path: d1 }), mutate.remove({ path: d2 })]); }
  finally { Date.now = realNow; }
  ok('C4 two same-basename files trashed in the same millisecond get different entries', r1.id !== r2.id, `${r1.id} ${r2.id}`);
  const listed = (await mutate.listTrash()).filter((t) => t.id === r1.id || t.id === r2.id);
  ok('C4 …both are listed', listed.length === 2);
  await mutate.restoreTrash({ id: r1.id });
  await mutate.restoreTrash({ id: r2.id });
  ok('C4 …and both restore, byte-identical', fs.readFileSync(d1, 'utf8') === 'first\n' && fs.readFileSync(d2, 'utf8') === 'second\n');
  fs.rmSync(d1); fs.rmSync(d2);

  // An interrupted trash: a child process SIGKILLed between the move and the
  // final metadata rename, exactly where the old code left no record at all.
  const victim = path.join(PROJ, fx.slugs.notes, 'memory', 'victim.md');
  fs.writeFileSync(victim, 'survive me\n');
  const kill = (step, target) => spawnSync(process.execPath, ['--input-type=module', '-e', `
    const m = await import(${JSON.stringify(path.join(ROOT, 'lib', 'mutate.js'))});
    m._setTrashFault((s) => { if (s === ${JSON.stringify(step)}) process.kill(process.pid, 'SIGKILL'); });
    await m.remove({ path: ${JSON.stringify(target)} });
  `], { env: { ...process.env, HOME: fakeHome }, encoding: 'utf8' });
  const k1 = kill('after-move', victim);
  ok('C4 the child really was killed mid-trash', k1.signal === 'SIGKILL', `${k1.status} ${k1.signal} ${k1.stderr}`);
  const t1 = (await mutate.listTrash()).find((t) => t.originalPath === victim);
  ok('C4 an interrupted trash is still listed', t1?.interrupted === true && t1.moved === true && t1.restorable === true, JSON.stringify(t1));
  await mutate.restoreTrash({ id: t1.id });
  ok('C4 …and restores', fs.readFileSync(victim, 'utf8') === 'survive me\n');
  const k2 = kill('after-pending-meta', victim);
  const t2 = (await mutate.listTrash()).find((t) => t.originalPath === victim);
  ok('C4 killed before the move: listed, not restorable, original untouched',
     k2.signal === 'SIGKILL' && t2?.moved === false && t2.restorable === false && fs.readFileSync(victim, 'utf8') === 'survive me\n', JSON.stringify(t2));
  fs.rmSync(path.join(fakeHome, '.agent-config-studio', 'trash', t2.id), { recursive: true });

  // A history failure is surfaced, not swallowed.
  const hist = path.join(fakeHome, '.agent-config-studio', 'history');
  fs.mkdirSync(hist, { recursive: true });
  const parked = `${hist}.parked`;
  if (fs.existsSync(path.join(hist, '.git'))) fs.renameSync(path.join(hist, '.git'), parked);
  fs.writeFileSync(path.join(hist, '.git'), 'gitdir: /nonexistent\n');
  let r;
  try { r = await mutate.remove({ path: victim }); }
  finally {
    fs.rmSync(path.join(hist, '.git'), { force: true });
    if (fs.existsSync(parked)) fs.renameSync(parked, path.join(hist, '.git'));
  }
  ok('C4 a history failure is surfaced on the result', typeof r.historyError === 'string' && r.historyError.length > 0, JSON.stringify(r));
  ok('C4 …and the trash itself still happened and restores', !fs.existsSync(victim)
     && (await mutate.restoreTrash({ id: r.id })).restored && fs.existsSync(victim));
  fs.rmSync(victim);
}

// ── criterion 5: operations undo completely ───────────────────────────────
V = await view();
{
  const indexPath = path.join(fx.mem, 'MEMORY.md');
  const factB = path.join(fx.mem, 'fact-b.md');
  const indexBefore = fs.readFileSync(indexPath, 'utf8');
  const bBefore = sha(factB);
  const [ps, pv] = await call('POST', '/api/memory/preview', { action: 'trash-fact', ids: [row('fact-b.md').id] });
  ok('C5 a fact trash previews the file and its index link', ps === 200 && pv.items.length === 1 && pv.diffs.length === 1
     && !pv.diffs[0].after.includes('(fact-b.md)'), JSON.stringify(pv).slice(0, 300));
  const [as] = await call('POST', '/api/memory/accept', { opId: pv.opId });
  ok('C5 …accepted: the file is gone and so is its link', as === 200 && !fs.existsSync(factB)
     && !fs.readFileSync(indexPath, 'utf8').includes('(fact-b.md)'));
  const [rs, rv] = await call('POST', '/api/memory/restore', { opId: pv.opId });
  ok('C5 …restored: file and index link both back, byte-identical',
     rs === 200 && rv.restored && sha(factB) === bBefore && fs.readFileSync(indexPath, 'utf8') === indexBefore, JSON.stringify(rv));

  V = await view();
  const ids = V.findings.dangling.filter((d) => d.slug === fx.slugs.alpha).map((d) => d.id);
  const [p2s, p2] = await call('POST', '/api/memory/preview', { action: 'fix-links', ids });
  ok('C5 an index repair previews as one diff', p2s === 200 && p2.diffs.length === 1, JSON.stringify(p2).slice(0, 200));
  ok('C5 …the archive link is retargeted, the rest removed, prose intact',
     p2.diffs[0].after.includes('[Moved](_archive/moved.md)') && !p2.diffs[0].after.includes('gone-')
     && p2.diffs[0].after.includes('Prose that must survive every edit byte for byte.'));
  await call('POST', '/api/memory/accept', { opId: p2.opId });
  ok('C5 …applied exactly as previewed', fs.readFileSync(indexPath, 'utf8') === p2.diffs[0].after);
  const [r2s, r2] = await call('POST', '/api/memory/restore', { opId: p2.opId });
  ok('C5 an index repair restores to the pre-image', r2s === 200 && r2.restored && fs.readFileSync(indexPath, 'utf8') === indexBefore);

  V = await view();
  const [, p3] = await call('POST', '/api/memory/preview', { action: 'fix-links', ids: [V.findings.dangling.find((d) => d.target === 'moved.md').id] });
  await call('POST', '/api/memory/accept', { opId: p3.opId });
  fs.appendFileSync(indexPath, '- [Added later](fact-a.md) — by someone else\n');
  const edited = fs.readFileSync(indexPath, 'utf8');
  const [r3s, r3] = await call('POST', '/api/memory/restore', { opId: p3.opId });
  ok('C5 restore after someone else edited the index refuses', r3s === 200 && r3.restored === false && /edited after/.test(r3.reason), JSON.stringify(r3));
  ok('C5 …and shows the diff of what changed since', r3.diffs.length === 1 && r3.diffs[0].after.includes('Added later') && !r3.diffs[0].before.includes('Added later'));
  ok('C5 …and changed nothing', fs.readFileSync(indexPath, 'utf8') === edited);
  fs.writeFileSync(indexPath, p3.diffs[0].after);   // undo the outside edit so restore can run

  // Survives a restart: a fresh process lists the operation and restores it.
  const child = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
    const m = await import(${JSON.stringify(path.join(ROOT, 'lib', 'memory-ops.js'))});
    const listed = m.listOps().find((o) => o.id === ${JSON.stringify(p3.opId)});
    const r = await m.restore(${JSON.stringify(p3.opId)});
    console.log(JSON.stringify({ listed, restored: r.restored }));
  `], { env: { ...process.env, HOME: fakeHome }, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(child.stdout.trim().split('\n').pop()); } catch {}
  ok('C5 operations survive a server restart (a new process lists and restores it)',
     out?.listed?.status === 'applied' && out.restored === true && fs.readFileSync(indexPath, 'utf8') === indexBefore,
     `${child.stdout} ${child.stderr}`.slice(0, 300));
  const [, list] = await call('GET', '/api/memory/ops');
  ok('C5 …and this server sees it as restored', list.ops.find((o) => o.id === p3.opId)?.status === 'restored');

  // Creating an index for a dir that had none, and undoing it.
  V = await view();
  const jot = V.findings.unindexed.find((u) => u.rel === 'jot.md');
  const notesIndex = path.join(PROJ, fx.slugs.notes, 'memory', 'MEMORY.md');
  const [, p4] = await call('POST', '/api/memory/preview', { action: 'add-to-index', ids: [jot.id] });
  ok('C5 a dir with no MEMORY.md gets one, shown as a diff from empty', p4.diffs[0].before === ''
     && p4.diffs[0].after === '- [jot](jot.md) — A note with no index\n', JSON.stringify(p4.diffs));
  await call('POST', '/api/memory/accept', { opId: p4.opId });
  ok('C5 …created', fs.readFileSync(notesIndex, 'utf8') === p4.diffs[0].after);
  const [, r4] = await call('POST', '/api/memory/restore', { opId: p4.opId });
  ok('C5 …and undone (the created index goes to the trash, not unlinked)', r4.restored && !fs.existsSync(notesIndex)
     && (await mutate.listTrash()).some((t) => t.originalPath === notesIndex));

  const un = V.findings.unindexed.find((u) => u.rel === 'unindexed.md');
  const [, p5] = await call('POST', '/api/memory/preview', { action: 'add-to-index', ids: [un.id] });
  ok('C5 an unindexed live file is appended to the existing index, nothing else changes',
     p5.diffs[0].after === indexBefore + '- [unindexed-fact](unindexed.md) — Nobody linked me\n');
}

// ── criterion 6: conflicts abort before step one ──────────────────────────
V = await view();
{
  const indexPath = path.join(fx.mem, 'MEMORY.md');
  const d = V.findings.dangling.filter((x) => x.slug === fx.slugs.alpha);

  const [, p1] = await call('POST', '/api/memory/preview', { action: 'trash-fact', ids: [row('fact-c.md').id] });
  fs.appendFileSync(path.join(fx.mem, 'fact-c.md'), 'edited after preview\n');
  let before = snapTree();
  const [s1, j1] = await call('POST', '/api/memory/accept', { opId: p1.opId });
  ok('C6 a participating file changed after the preview → refused', s1 === 409 && /changed since the preview/.test(j1.error), JSON.stringify(j1));
  ok('C6 …with nothing changed', snapTree() === before);

  const [, p2] = await call('POST', '/api/memory/preview', { action: 'trash-fact', ids: [row('live-2.md').id] });
  fs.appendFileSync(indexPath, '\n');   // the OTHER participant, the index
  before = snapTree();
  const [s2] = await call('POST', '/api/memory/accept', { opId: p2.opId });
  ok('C6 the index changed after a fact-trash preview → refused, nothing changed', s2 === 409 && snapTree() === before);
  fs.writeFileSync(indexPath, fs.readFileSync(indexPath, 'utf8').replace(/\n$/, ''));

  V = await view();
  const [, p3] = await call('POST', '/api/memory/preview', { action: 'fix-links', ids: [V.findings.dangling.find((x) => x.target === 'gone-1.md').id] });
  const [s3a] = await call('POST', '/api/memory/accept', { opId: p3.opId });
  before = snapTree();
  const [s3b, j3b] = await call('POST', '/api/memory/accept', { opId: p3.opId });
  ok('C6 a duplicate submission is refused', s3a === 200 && s3b === 409 && /already accepted/.test(j3b.error), `${s3a} ${s3b}`);
  ok('C6 …with nothing changed', snapTree() === before);
  await call('POST', '/api/memory/restore', { opId: p3.opId });

  V = await view();
  const g2 = V.findings.dangling.find((x) => x.target === 'gone-2.md').id;
  const g3 = V.findings.dangling.find((x) => x.target === 'gone-3.md').id;
  const [, pa] = await call('POST', '/api/memory/preview', { action: 'fix-links', ids: [g2] });
  const [, pb] = await call('POST', '/api/memory/preview', { action: 'fix-links', ids: [g3] });
  const indexAtPreview = fs.readFileSync(indexPath, 'utf8');
  const results = await Promise.all([
    call('POST', '/api/memory/accept', { opId: pa.opId }),
    call('POST', '/api/memory/accept', { opId: pb.opId }),
    call('POST', '/api/memory/accept', { opId: pa.opId }),
  ]);
  const codes = results.map(([s]) => s);
  ok('C6 concurrent Accepts are serialised: one applies, the rest are refused',
     codes.filter((c) => c === 200).length === 1 && codes.filter((c) => c === 409).length === 2, JSON.stringify(codes));
  const winner = results.findIndex(([s]) => s === 200) === 1 ? pb : pa;
  ok('C6 …and the index is exactly the winner\'s preview, nothing from the loser', fs.readFileSync(indexPath, 'utf8') === winner.diffs[0].after
     && winner.diffs[0].before === indexAtPreview);
  await call('POST', '/api/memory/restore', { opId: winner.opId });

  V = await view();
  const target = path.join(fx.mem, 'live-3.md');
  const [, p4] = await call('POST', '/api/memory/preview', { action: 'trash-fact', ids: [row('live-3.md').id] });
  const bytes = fs.readFileSync(target);
  const decoy = path.join(fakeHome, 'decoy.md');
  fs.writeFileSync(decoy, bytes);                    // identical bytes: only the link check can catch it
  fs.rmSync(target);
  fs.symlinkSync(decoy, target);
  before = snapTree();
  const decoyBefore = sha(decoy);
  const [s4, j4] = await call('POST', '/api/memory/accept', { opId: p4.opId });
  ok('C6 a symlink swapped in after the preview → refused', s4 === 409 && /symlink/.test(j4.error), JSON.stringify(j4));
  ok('C6 …nothing changed, the link target included', snapTree() === before && sha(decoy) === decoyBefore && fs.lstatSync(target).isSymbolicLink());
  fs.rmSync(target);
  fs.writeFileSync(target, bytes);
}

// ── criterion 7: ids and paths ────────────────────────────────────────────
V = await view();
{
  const forged = crypto.randomBytes(12).toString('hex');
  const [s1] = await call('POST', '/api/memory/preview', { action: 'trash-fact', ids: [forged] });
  ok('C7 a forged id is refused', s1 === 404, String(s1));
  const b64 = Buffer.from(path.join(fx.mem, 'fact-a.md')).toString('base64url');
  const [s2] = await call('POST', '/api/memory/preview', { action: 'trash-fact', ids: [b64] });
  const [s2b] = await call('POST', '/api/memory/preview', { action: 'trash-fact', ids: [path.join(fx.mem, 'fact-a.md')] });
  ok('C7 a base64-path id and a raw path are refused', s2 === 400 && s2b === 400, `${s2} ${s2b}`);
  const [s3] = await call('POST', '/api/memory/preview', { action: 'trash-empty-slugs', ids: [row('fact-a.md').id] });
  ok('C7 a valid id used for the wrong action is refused', s3 === 400, String(s3));
  const [s3b] = await call('POST', '/api/memory/preview', { action: 'fix-links', ids: [V.findings.emptySlugs[0].id] });
  ok('C7 …and the other way round', s3b === 400, String(s3b));
  const [s4, j4] = await call('POST', '/api/memory/preview', { action: 'trash-fact', path: path.join(fx.mem, 'fact-a.md') });
  ok('C7 a path in the body is not an input', s4 === 400 && /ids is required/.test(j4.error));
  const [s5] = await call('GET', `/api/memory/file?path=${encodeURIComponent(path.join(fx.mem, 'fact-a.md'))}`);
  ok('C7 GET /api/memory/file takes no path', s5 === 400, String(s5));
  const [s6, j6] = await call('GET', `/api/memory/file?id=${row('fact-a.md').id}`);
  ok('C7 …and serves a fact by id', s6 === 200 && j6.content.includes('Body of fact A.'));
  const [s7] = await call('POST', '/api/memory/keep', { id: '../../etc/passwd' });
  const [s8] = await call('POST', '/api/memory/accept', { opId: forged });
  const [s9] = await call('POST', '/api/memory/restore', { opId: 'x'.repeat(24) });
  ok('C7 keep / accept / restore refuse what they were not minted', s7 === 400 && s8 === 404 && s9 === 400, `${s7} ${s8} ${s9}`);

  ok('C7 the symlinked memory dir and slug produced no ids', !V.rows.some((r) => /linked-(mem|slug)/.test(r.slug)));
  ok('C7 the deny-listed file behind a .md name never reached a response',
     !seen.some((t) => t.includes(MARK.credential)));
  ok('C7 no response carries transcript text', !seen.some((t) => t.includes(MARK.transcript)));

  // No memory or context route reads a path from its request.
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const block = src.slice(src.indexOf("'GET /api/memory'"), src.indexOf("'GET /api/models'"));
  ok('C7 the memory and context handlers read only id / ids / opId / action',
     block.length > 200 && !/searchParams\.get\('(?!id')/.test(block) && !/\b(path|dir|file)\b\s*[,}]\s*=\s*await readBody/.test(block)
     && [...block.matchAll(/const \{([^}]*)\} = await readBody/g)].every((m) => m[1].split(',').every((k) => ['action', 'ids'].includes(k.trim()))),
     block.slice(0, 120));
}

// ── the review queue: Keep persists and resurfaces on a content change ────
V = await view();
{
  const a = row('fact-a.md');
  ok('review: live facts are queued, archived ones are not', a.inQueue === true && row('_archive/moved.md').inQueue === false);
  const [ks, kv] = await call('POST', '/api/memory/keep', { id: a.id });
  ok('review: Keep records a review', ks === 200 && kv.kept === true);
  V = await view();
  ok('review: a kept fact leaves the queue', row('fact-a.md').inQueue === false && row('fact-a.md').kept?.contentChanged === false);
  ok('review: Keep never edits the memory file', fs.readFileSync(fx.factA, 'utf8').includes('Body of fact A.\n'));
  fs.appendFileSync(fx.factA, 'a change\n');
  V = await view();
  ok('review: …and resurfaces at once when its content changes', row('fact-a.md').inQueue === true && row('fact-a.md').kept?.contentChanged === true);
  const review = JSON.parse(fs.readFileSync(path.join(fakeHome, '.agent-config-studio', 'memory-review.json'), 'utf8'));
  ok('review: the state lives in the ACS state dir', Object.values(review.keeps).some((k) => typeof k.sha256 === 'string'));
}

// ── an oversized index is flagged, and offered nothing ────────────────────
{
  const big = path.join(PROJ, fx.slugs.notes, 'memory', 'MEMORY.md');
  fs.writeFileSync(big, '- [jot](jot.md) — the note\n' + 'filler line\n'.repeat(200));
  V = await view();
  const o = V.findings.oversized.find((x) => x.slug === fx.slugs.notes);
  ok('an index over 200 lines is flagged, with its line count', o?.lines === 201 && o.threshold === 200, JSON.stringify(V.findings.oversized));
  fs.rmSync(big);
}

// ── grade bugs: each reproduced before its fix ────────────────────────────
const opsPath = path.join(ROOT, 'lib', 'memory-ops.js');
/** Run `body` in a fresh process against the fake HOME; it may SIGKILL itself. */
const child = (body) => spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e',
  `const ops = await import(${JSON.stringify(opsPath)}); const mutate = await import(${JSON.stringify(path.join(ROOT, 'lib', 'mutate.js'))});\n${body}`],
  { env: { ...process.env, HOME: fakeHome }, encoding: 'utf8' });
const opIdFrom = (r) => (/OP ([0-9a-f]{24})/.exec(r.stdout) || [])[1];
const indexPath = path.join(fx.mem, 'MEMORY.md');

// B1: a file named like the trash's own metadata keeps its bytes.
{
  const f = path.join(PROJ, fx.slugs.notes, 'memory', 'trash-meta.json');
  fs.writeFileSync(f, 'PAYLOAD-BYTES\n');
  const r = await mutate.remove({ path: f });
  const listed = (await mutate.listTrash()).find((t) => t.id === r.id);
  ok('B1 trashing a file named trash-meta.json keeps its entry listable', listed?.name === 'trash-meta.json', JSON.stringify(listed));
  await mutate.restoreTrash({ id: r.id }).catch(() => {});
  ok('B1 …and restores its own bytes, not the metadata', fs.existsSync(f) && fs.readFileSync(f, 'utf8') === 'PAYLOAD-BYTES\n',
     fs.existsSync(f) ? fs.readFileSync(f, 'utf8').slice(0, 60) : 'missing');
  fs.rmSync(f, { force: true });
}

// B2: an Accept killed after its step changed the file, before the step was recorded.
{
  const before = fs.readFileSync(indexPath, 'utf8');
  const r = child(`
    const v = await ops.memoryView();
    const d = v.findings.dangling.find((x) => x.target === 'gone-1.md');
    const p = ops.preview({ action: 'fix-links', ids: [d.id] });
    console.log('OP ' + p.opId);
    ops._setOpFault((pt) => { if (pt === 'after-mutation') process.kill(process.pid, 'SIGKILL'); });
    await ops.accept(p.opId);`);
  const opId = opIdFrom(r);
  const changed = fs.readFileSync(indexPath, 'utf8');
  ok('B2 the child was killed after the index changed', r.signal === 'SIGKILL' && changed !== before, `${r.signal} ${r.stderr.slice(0, 200)}`);
  const [, rv] = await call('POST', '/api/memory/restore', { opId });
  ok('B2 restore of that interrupted Accept really undoes it', rv?.restored === true && fs.readFileSync(indexPath, 'utf8') === before,
     JSON.stringify(rv).slice(0, 300));
  if (fs.readFileSync(indexPath, 'utf8') !== before) fs.writeFileSync(indexPath, before);
}
// B2: a trash step killed between the move and the record is still found by restore.
{
  const target = path.join(fx.mem, 'live-4.md');
  const bytes = fs.readFileSync(target, 'utf8');
  const indexBefore = fs.readFileSync(indexPath, 'utf8');
  const r = child(`
    const v = await ops.memoryView();
    const row = v.rows.find((x) => x.rel === 'live-4.md' && x.slug === ${JSON.stringify(fx.slugs.alpha)});
    const p = ops.preview({ action: 'trash-fact', ids: [row.id] });
    console.log('OP ' + p.opId);
    ops._setOpFault((pt) => { if (pt === 'after-mutation') process.kill(process.pid, 'SIGKILL'); });
    await ops.accept(p.opId);`);
  const opId = opIdFrom(r);
  ok('B2 the child was killed right after the fact moved to the trash', r.signal === 'SIGKILL' && !fs.existsSync(target), r.stderr.slice(0, 200));
  const [, rv] = await call('POST', '/api/memory/restore', { opId });
  ok('B2 restore finds the unrecorded trash entry and puts the fact back', rv?.restored === true && fs.existsSync(target)
     && fs.readFileSync(target, 'utf8') === bytes && fs.readFileSync(indexPath, 'utf8') === indexBefore, JSON.stringify(rv).slice(0, 300));
}
// B2: a Restore killed half-way, then retried, recognises the step it already undid.
{
  V = await view();
  const target = path.join(fx.mem, 'live-5.md');
  const bytes = fs.readFileSync(target, 'utf8');
  const indexBefore = fs.readFileSync(indexPath, 'utf8');
  const [, pv] = await call('POST', '/api/memory/preview', { action: 'trash-fact', ids: [row('live-5.md').id] });
  await call('POST', '/api/memory/accept', { opId: pv.opId });
  const r = child(`
    ops._setOpFault((pt) => { if (pt === 'restore-after-step') process.kill(process.pid, 'SIGKILL'); });
    await ops.restore(${JSON.stringify(pv.opId)});`);
  ok('B2 the restoring child was killed after its first step', r.signal === 'SIGKILL' && fs.readFileSync(indexPath, 'utf8') === indexBefore && !fs.existsSync(target),
     r.stderr.slice(0, 200));
  const [, rv] = await call('POST', '/api/memory/restore', { opId: pv.opId });
  ok('B2 …the retry completes instead of calling the restored index an outside edit',
     rv?.restored === true && fs.readFileSync(target, 'utf8') === bytes && fs.readFileSync(indexPath, 'utf8') === indexBefore, JSON.stringify(rv).slice(0, 300));
}

// B3: something edits the index after Accept's up-front check, before its write.
{
  V = await view();
  const [, pv] = await call('POST', '/api/memory/preview', { action: 'fix-links', ids: [V.findings.dangling.find((d) => d.target === 'gone-2.md').id] });
  ops._setOpFault((pt, s) => { if (pt === 'before-step' && s.type === 'edit-index') fs.appendFileSync(indexPath, 'EXTERNAL EDIT\n'); });
  const [st, body] = await call('POST', '/api/memory/accept', { opId: pv.opId });
  ops._setOpFault(null);
  const now = fs.readFileSync(indexPath, 'utf8');
  ok('B3 an edit landing mid-Accept is not overwritten', now.endsWith('EXTERNAL EDIT\n') && now.includes('(gone-2.md)'), now.slice(-80));
  ok('B3 …and the Accept reports the refusal', st === 409, `${st} ${JSON.stringify(body).slice(0, 200)}`);
  fs.writeFileSync(indexPath, now.replace('EXTERNAL EDIT\n', ''));

  V = await view();
  const target = path.join(fx.mem, 'live-6.md');
  const bytes = fs.readFileSync(target);
  const decoy = path.join(fakeHome, 'decoy-2.md');
  const [, p2] = await call('POST', '/api/memory/preview', { action: 'trash-fact', ids: [row('live-6.md').id] });
  ops._setOpFault((pt, s) => {
    if (pt === 'before-step' && s.type === 'trash') { fs.writeFileSync(decoy, bytes); fs.rmSync(target); fs.symlinkSync(decoy, target); }
  });
  const [st2] = await call('POST', '/api/memory/accept', { opId: p2.opId });
  ops._setOpFault(null);
  let isLink = false;
  try { isLink = fs.lstatSync(target).isSymbolicLink(); } catch {}
  ok('B3 a symlink swapped in mid-Accept is refused and left alone', st2 === 409 && isLink && fs.existsSync(decoy), String(st2));
  fs.rmSync(target, { force: true }); fs.writeFileSync(target, bytes);
}

// B4: restoring a trashed fact must not follow a symlink planted where its folder was.
{
  V = await view();
  const notesMem = path.join(PROJ, fx.slugs.notes, 'memory');
  const jot = path.join(notesMem, 'jot.md');
  const [, pv] = await call('POST', '/api/memory/preview', { action: 'trash-fact', ids: [row('jot.md', fx.slugs.notes).id] });
  await call('POST', '/api/memory/accept', { opId: pv.opId });
  const elsewhere = path.join(fakeHome, '.claude', 'hooks');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.renameSync(notesMem, `${notesMem}.real`);
  fs.symlinkSync(elsewhere, notesMem);
  const [, rv] = await call('POST', '/api/memory/restore', { opId: pv.opId });
  ok('B4 restore refuses a memory folder swapped for a symlink', rv?.restored !== true && !fs.existsSync(path.join(elsewhere, 'jot.md')),
     JSON.stringify(rv).slice(0, 200));
  fs.unlinkSync(notesMem); fs.renameSync(`${notesMem}.real`, notesMem);
  const [, rv2] = await call('POST', '/api/memory/restore', { opId: pv.opId });
  ok('B4 …and restores normally once the folder is real again', rv2?.restored === true && fs.existsSync(jot), JSON.stringify(rv2).slice(0, 200));
}

// B5: a context-named symlink to a transcript never serves the transcript.
{
  const link = path.join(fx.alpha, 'apps', 'AGENTS.md');
  fs.symlinkSync(path.join(fx.alphaSlug, 'session-2', 'subagents', 'agent-x.jsonl'), link);
  const cm = await import('../lib/context-map.js');
  const m = await cm.contextMap();
  const texts = [];
  for (const g of m.groups) for (const sc of g.scopes) for (const v of sc.variants) {
    try { texts.push((await cm.contextFile(v.id)).content); } catch {}
  }
  const [, body] = await call('GET', '/api/context');
  ok('B5 the transcript behind an AGENTS.md link is not read or served',
     !texts.some((t) => t.includes('toolu_sub')) && !JSON.stringify(body).includes('toolu_sub') && JSON.stringify(m.unreadable).includes('apps/AGENTS.md'),
     JSON.stringify(m.unreadable));
  fs.rmSync(link);
}

// B7: a finding that stopped being true is refused, at preview and at Accept.
{
  V = await view();
  const g3 = V.findings.dangling.find((d) => d.target === 'gone-3.md');
  fs.writeFileSync(path.join(fx.mem, 'gone-3.md'), 'I came back\n');
  const [s1] = await call('POST', '/api/memory/preview', { action: 'fix-links', ids: [g3.id] });
  ok('B7 a link whose file reappeared is not offered for removal', s1 === 409, String(s1));
  fs.rmSync(path.join(fx.mem, 'gone-3.md'));
  const [, p2] = await call('POST', '/api/memory/preview', { action: 'fix-links', ids: [g3.id] });
  fs.writeFileSync(path.join(fx.mem, 'gone-3.md'), 'I came back\n');
  const before = fs.readFileSync(indexPath, 'utf8');
  const [s2] = await call('POST', '/api/memory/accept', { opId: p2.opId });
  ok('B7 …nor removed at Accept when it reappears after the preview', s2 === 409 && fs.readFileSync(indexPath, 'utf8') === before, String(s2));
  fs.rmSync(path.join(fx.mem, 'gone-3.md'));

  const mv = V.findings.dangling.find((d) => d.target === 'moved.md');
  const [, p3] = await call('POST', '/api/memory/preview', { action: 'fix-links', ids: [mv.id] });
  const arch = path.join(fx.mem, '_archive', 'moved.md');
  const archBytes = fs.readFileSync(arch);
  fs.rmSync(arch);
  const [s3] = await call('POST', '/api/memory/accept', { opId: p3.opId });
  ok('B7 "point at archive" is refused when the archived file is gone', s3 === 409 && fs.readFileSync(indexPath, 'utf8') === before, String(s3));
  fs.writeFileSync(arch, archBytes);

  const un = V.findings.unindexed.find((u) => u.rel === 'unindexed.md');
  fs.appendFileSync(indexPath, '- [Now linked](unindexed.md)\n');
  const [s4] = await call('POST', '/api/memory/preview', { action: 'add-to-index', ids: [un.id] });
  ok('B7 a file that got indexed meanwhile is not indexed twice', s4 === 409, String(s4));
  fs.writeFileSync(indexPath, before);
}

// B8: the real-home comparator fails on additions it used to fail on.
{
  const { compareRealHomes, isLiveSuiteProbeSlug } = await import('./real-home.mjs');
  const projects = path.join(realHome, '.claude', 'projects');
  const docs = path.join(realHome, 'Documents', 'Projects');
  const base = { [`slugs:${projects}`]: JSON.stringify(['-a']), [`context:${docs}`]: JSON.stringify([]), [path.join(projects, '-a')]: 'dir' };
  const withCtx = { ...base, [`context:${docs}`]: JSON.stringify([path.join(docs, 'p', '.claude', 'skills', 't', 'CLAUDE.md')]), [path.join(docs, 'p', '.claude', 'skills', 't', 'CLAUDE.md')]: 'sha' };
  ok('B8 a context file appearing during a run is a failure', compareRealHomes(base, withCtx).content.length > 0);
  const slug = (n) => ({ ...base, [`slugs:${projects}`]: JSON.stringify(['-a', n]), [path.join(projects, n)]: 'dir', [path.join(projects, n, 'memory')]: 'dir' });
  ok('B8 an arbitrary new slug is a failure', compareRealHomes(base, slug('-Users-x-new-project')).content.length > 0);
  const tmp = fs.realpathSync(os.tmpdir()).replace(/[^A-Za-z0-9]/g, '-');
  const probe = `${tmp}-acs-claude-writeprobe-Ab12Cd`;
  ok('B8 only the phase1 probe slugs are exempt', isLiveSuiteProbeSlug(probe) && isLiveSuiteProbeSlug(`${tmp}-acs-contain-claude-Zz9Yy8`)
     && !isLiveSuiteProbeSlug(`${tmp}-acs-anything-else-Ab12Cd`) && !isLiveSuiteProbeSlug(`${tmp}-acs-claude-writeprobe-Ab12Cd-x`)
     && compareRealHomes(base, slug(probe)).content.length === 0);
}

// B9: a populated temp probe is not a project.
{
  V = await view();
  ok('B9 a temp probe holding memory is hidden from the project list and the queue',
     !V.groups.some((g) => g.slugs.some((sl) => mi.isTempProbe(sl.slug))) && !V.rows.some((r) => mi.isTempProbe(r.slug))
     && !V.findings.unindexed.some((u) => mi.isTempProbe(u.slug)) && V.hiddenProbeFiles === 1, JSON.stringify(V.hiddenProbeFiles));
}

// ── regrade round 3 ───────────────────────────────────────────────────────
const opsDir = path.join(fakeHome, '.agent-config-studio', 'memory-ops');
const shaOf = (t) => crypto.createHash('sha256').update(t).digest('hex');

// A: a record not in the current schema is refused, never acted on.
{
  const now = fs.readFileSync(indexPath, 'utf8');
  const legacy = {
    id: 'a'.repeat(24), action: 'fix-links', summary: 'legacy', status: 'applying', acceptedAt: new Date().toISOString(),
    steps: [{ type: 'edit-index', abs: indexPath, before: 'OLD\n', after: now, beforeSha: shaOf('OLD\n'), afterSha: shaOf(now), done: false, label: 'MEMORY.md' }],
  };
  const legacySlug = {
    id: 'b'.repeat(24), action: 'trash-empty-slugs', summary: 'legacy slug', status: 'applied', acceptedAt: new Date().toISOString(),
    steps: [{ type: 'trash', abs: fx.emptyA, trashId: 'x', done: true, label: 'slug' }],
  };
  fs.mkdirSync(opsDir, { recursive: true });
  fs.writeFileSync(path.join(opsDir, `${legacy.id}.json`), JSON.stringify(legacy));
  fs.writeFileSync(path.join(opsDir, `${legacySlug.id}.json`), JSON.stringify(legacySlug));
  const before = snapTree();
  const [s1, j1] = await call('POST', '/api/memory/restore', { opId: legacy.id });
  const [s2, j2] = await call('POST', '/api/memory/restore', { opId: legacySlug.id });
  ok('A a legacy record (done:false, no schema) is refused as unrecognised, never restored:true',
     s1 === 409 && /unrecognised/.test(j1.error) && j1.restored !== true, `${s1} ${JSON.stringify(j1)}`);
  ok('A a legacy trash step with no target is refused, not guessed at', s2 === 409 && /unrecognised/.test(j2.error), `${s2} ${JSON.stringify(j2)}`);
  ok('A …and nothing was touched', snapTree() === before && fs.readFileSync(indexPath, 'utf8') === now);
  const [, list] = await call('GET', '/api/memory/ops');
  ok('A unrecognised records list as unrecognised', list.ops.filter((o) => o.status === 'unrecognised').length === 2);
  fs.rmSync(path.join(opsDir, `${legacy.id}.json`)); fs.rmSync(path.join(opsDir, `${legacySlug.id}.json`));
}

// B: an edit injected at every await point of an index write is refused.
for (const point of ['before-step', 'after-baseline', 'after-temp-write']) {
  V = await view();
  const orig = fs.readFileSync(indexPath, 'utf8');
  const [, pv] = await call('POST', '/api/memory/preview', { action: 'fix-links', ids: [V.findings.dangling.find((d) => d.target === 'gone-4.md').id] });
  ops._setOpFault((pt, x) => { if (pt === point && (x.type === 'edit-index' || x.phase === 'accept')) fs.appendFileSync(indexPath, `INJECTED ${point}\n`); });
  const [st] = await call('POST', '/api/memory/accept', { opId: pv.opId });
  ops._setOpFault(null);
  ok(`B an edit injected at ${point} is refused, and survives`, st === 409 && fs.readFileSync(indexPath, 'utf8') === `${orig}INJECTED ${point}\n`, String(st));
  ok(`B …no temp file left behind (${point})`, !fs.readdirSync(fx.mem).some((n) => n.includes('.acs-')));
  fs.writeFileSync(indexPath, orig);
}
{
  // The memory folder swapped for a link during the temp write: nothing lands through it.
  V = await view();
  const [, pv] = await call('POST', '/api/memory/preview', { action: 'fix-links', ids: [V.findings.dangling.find((d) => d.target === 'gone-4.md').id] });
  const elsewhere = path.join(fakeHome, '.claude', 'hooks');
  const moved = `${fx.mem}.real`;
  ops._setOpFault((pt) => {
    if (pt === 'after-temp-write') { fs.renameSync(fx.mem, moved); fs.mkdirSync(elsewhere, { recursive: true }); fs.symlinkSync(elsewhere, fx.mem); }
  });
  const [st] = await call('POST', '/api/memory/accept', { opId: pv.opId });
  ops._setOpFault(null);
  ok('B a memory folder swapped for a link mid-write is refused, nothing written through it',
     st === 409 && !fs.existsSync(path.join(elsewhere, 'MEMORY.md')), String(st));
  fs.unlinkSync(fx.mem); fs.renameSync(moved, fx.mem);
  for (const n of fs.readdirSync(fx.mem)) if (n.includes('.acs-')) fs.rmSync(path.join(fx.mem, n));
}
{
  // Restore's own write: an edit injected during its temp write survives.
  V = await view();
  const orig = fs.readFileSync(indexPath, 'utf8');
  const [, pv] = await call('POST', '/api/memory/preview', { action: 'fix-links', ids: [V.findings.dangling.find((d) => d.target === 'gone-4.md').id] });
  await call('POST', '/api/memory/accept', { opId: pv.opId });
  const applied = fs.readFileSync(indexPath, 'utf8');
  ops._setOpFault((pt, x) => { if (pt === 'after-temp-write' && x.phase === 'restore') fs.appendFileSync(indexPath, 'INJECTED restore\n'); });
  const [, rv] = await call('POST', '/api/memory/restore', { opId: pv.opId });
  ops._setOpFault(null);
  ok('B an edit injected during Restore\'s temp write is refused, and survives',
     rv?.restored === false && fs.readFileSync(indexPath, 'utf8') === `${applied}INJECTED restore\n`, JSON.stringify(rv).slice(0, 200));
  fs.writeFileSync(indexPath, applied);
  const [, rv2] = await call('POST', '/api/memory/restore', { opId: pv.opId });
  ok('B …and the retried Restore completes', rv2?.restored === true && fs.readFileSync(indexPath, 'utf8') === orig, JSON.stringify(rv2).slice(0, 200));
}

// C: a change to ANY participant refuses the next mutation — the grader's case.
for (const [label, hook] of [
  ['during the fact\'s history baseline', (m) => m._setTrashFault(async (pt) => { if (pt === 'after-pending-meta') fs.appendFileSync(indexPath, 'MID-TRASH\n'); })],
  ['before the trash step', () => ops._setOpFault((pt, x) => { if (pt === 'before-step' && x.type === 'trash') fs.appendFileSync(indexPath, 'MID-TRASH\n'); })],
]) {
  V = await view();
  const target = path.join(fx.mem, 'live-7.md');
  const orig = fs.readFileSync(indexPath, 'utf8');
  const [, pv] = await call('POST', '/api/memory/preview', { action: 'trash-fact', ids: [row('live-7.md').id] });
  hook(mutate);
  const [st] = await call('POST', '/api/memory/accept', { opId: pv.opId });
  mutate._setTrashFault(null); ops._setOpFault(null);
  ok(`C the index changed ${label} → the fact is NOT trashed`, st === 409 && fs.existsSync(target)
     && !(await mutate.listTrash()).some((t) => t.originalPath === target && t.moved), String(st));
  fs.writeFileSync(indexPath, orig);
  if (!fs.existsSync(target)) {   // only on a failing build: put it back for the checks that follow
    const t = (await mutate.listTrash()).find((x) => x.originalPath === target && x.moved);
    if (t) await mutate.restoreTrash({ id: t.id });
  }
}

// D: a refused restore creates nothing outside memory/.
{
  const notesMem = path.join(PROJ, fx.slugs.notes, 'memory');
  fs.mkdirSync(path.join(notesMem, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(notesMem, 'sub', 'deep.md'), '---\nname: deep\n---\nDeep.\n');
  V = await view();
  const [, pv] = await call('POST', '/api/memory/preview', { action: 'trash-fact', ids: [row('sub/deep.md', fx.slugs.notes).id] });
  await call('POST', '/api/memory/accept', { opId: pv.opId });
  fs.rmdirSync(path.join(notesMem, 'sub'));
  const hooks = path.join(fakeHome, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  const hooksBefore = treeHash(hooks);
  fs.renameSync(notesMem, `${notesMem}.real`);
  fs.symlinkSync(hooks, notesMem);
  const [, rv] = await call('POST', '/api/memory/restore', { opId: pv.opId });
  ok('D restore through a memory folder swapped for a link to .claude/hooks is refused',
     rv?.restored !== true && !fs.existsSync(path.join(hooks, 'sub')) && treeHash(hooks) === hooksBefore, JSON.stringify(rv).slice(0, 200));
  fs.unlinkSync(notesMem); fs.renameSync(`${notesMem}.real`, notesMem);
  const [, rv2] = await call('POST', '/api/memory/restore', { opId: pv.opId });
  ok('D …once the folder is real, restore re-creates sub/ inside memory and puts the fact back',
     rv2?.restored === true && fs.readFileSync(path.join(notesMem, 'sub', 'deep.md'), 'utf8').includes('Deep.'), JSON.stringify(rv2).slice(0, 200));
  fs.rmSync(path.join(notesMem, 'sub'), { recursive: true });
}

// E: a restore killed between linking the fact back and removing the trash copy.
{
  V = await view();
  const target = path.join(fx.mem, 'live-8.md');
  const bytes = fs.readFileSync(target, 'utf8');
  const [, pv] = await call('POST', '/api/memory/preview', { action: 'trash-fact', ids: [row('live-8.md').id] });
  await call('POST', '/api/memory/accept', { opId: pv.opId });
  const r = child(`
    mutate._setTrashFault((pt) => { if (pt === 'restore-after-link') process.kill(process.pid, 'SIGKILL'); });
    await ops.restore(${JSON.stringify(pv.opId)});`);
  const leftover = (await mutate.listTrash()).find((t) => t.originalPath === target);
  ok('E the child was killed with the fact linked back and its trash copy still there',
     r.signal === 'SIGKILL' && fs.readFileSync(target, 'utf8') === bytes && leftover?.moved === true, `${r.signal} ${r.stderr.slice(0, 200)}`);
  const [, rv] = await call('POST', '/api/memory/restore', { opId: pv.opId });
  ok('E the retry recognises identical bytes, finishes, and clears the trash copy',
     rv?.restored === true && fs.readFileSync(target, 'utf8') === bytes && !(await mutate.listTrash()).some((t) => t.originalPath === target),
     JSON.stringify(rv).slice(0, 200));
}

// F: the probe-slug exemption covers an empty memory/ and nothing else.
{
  const { compareRealHomes } = await import('./real-home.mjs');
  const projects = path.join(realHome, '.claude', 'projects');
  const docs = path.join(realHome, 'Documents', 'Projects');
  const tmp = fs.realpathSync(os.tmpdir()).replace(/[^A-Za-z0-9]/g, '-');
  const probe = `${tmp}-acs-claude-writeprobe-Qq11Ww`;
  const base = { [`slugs:${projects}`]: JSON.stringify(['-a']), [`context:${docs}`]: JSON.stringify([]), [path.join(projects, '-a')]: 'dir' };
  const withProbe = (extra) => ({ ...base, [`slugs:${projects}`]: JSON.stringify(['-a', probe]), [path.join(projects, probe)]: 'dir', [path.join(projects, probe, 'memory')]: 'dir', ...extra });
  ok('F a probe slug holding an empty memory/ is exempt', compareRealHomes(base, withProbe({})).content.length === 0);
  ok('F …but memory/UNEXPECTED.md under it fails', compareRealHomes(base, withProbe({ [path.join(projects, probe, 'memory', 'UNEXPECTED.md')]: 'sha' })).content.length > 0);
  ok('F …and a memory/ that is a link fails', compareRealHomes(base, withProbe({ [path.join(projects, probe, 'memory')]: 'link:/x' })).content.length > 0);
  ok('F …and a slug that is a link fails', compareRealHomes(base, withProbe({ [path.join(projects, probe)]: 'link:/x' })).content.length > 0);
}

// ── round 4 ───────────────────────────────────────────────────────────────
// R1: a Memory trash that would cross devices is refused, not copied.
{
  V = await view();
  const target = path.join(fx.mem, 'live-1.md');
  const bytes = fs.readFileSync(target, 'utf8');
  const indexBefore = fs.readFileSync(indexPath, 'utf8');
  const [, pv] = await call('POST', '/api/memory/preview', { action: 'trash-fact', ids: [row('live-1.md').id] });
  mutate._setTrashIo({ renameSync: () => { throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }); } });
  const [st, body] = await call('POST', '/api/memory/accept', { opId: pv.opId });
  mutate._setTrashIo(null);
  ok('R1 a forced EXDEV in a memory op is refused with a clear message', st === 409 && /different volume/.test(body.error), `${st} ${JSON.stringify(body).slice(0, 200)}`);
  ok('R1 …the source is intact and the index untouched', fs.existsSync(target) && fs.readFileSync(target, 'utf8') === bytes && fs.readFileSync(indexPath, 'utf8') === indexBefore);
  const left = (await mutate.listTrash()).find((t) => t.originalPath === target);
  ok('R1 …and no trash entry for it is left behind', !left);
  if (left?.moved) {   // only on a failing build: undo the copy-and-remove so later checks run
    fs.writeFileSync(indexPath, indexBefore);
    await mutate.restoreTrash({ id: left.id });
  }
}

// R2: memory swapped for a link to .claude/hooks during the history baseline.
{
  V = await view();
  const [, pv] = await call('POST', '/api/memory/preview', { action: 'fix-links', ids: [V.findings.dangling.find((d) => d.target === 'gone-5.md').id] });
  const hooks = path.join(fakeHome, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  const hooksBefore = treeHash(hooks);
  const moved = `${fx.mem}.real`;
  // `seen` is hooks as it is at every later await point, so a temp file that
  // lands there and is cleaned up afterwards is still caught.
  const seen = [];
  ops._setOpFault((pt) => {
    if (pt === 'after-baseline') { fs.renameSync(fx.mem, moved); fs.symlinkSync(hooks, fx.mem); }
    else seen.push(treeHash(hooks));
  });
  const [st] = await call('POST', '/api/memory/accept', { opId: pv.opId });
  ops._setOpFault(null);
  ok('R2 memory swapped for a link during the baseline: refused, and nothing is ever created under hooks',
     st === 409 && treeHash(hooks) === hooksBefore && seen.every((h) => h === hooksBefore), `${st} seen=${seen.length} ${seen.some((h) => h !== hooksBefore)}`);
  fs.unlinkSync(fx.mem); fs.renameSync(moved, fx.mem);
}

// ── round 5: short writes never publish a truncated index ────────────────
{
  V = await view();
  const orig = fs.readFileSync(indexPath, 'utf8');
  const [, pv] = await call('POST', '/api/memory/preview', { action: 'fix-links', ids: [V.findings.dangling.find((d) => d.target === 'gone-5.md').id] });
  // At most 5 bytes per call, whatever form the caller writes in (Buffer + range, or a string).
  const short = (fd, data, off = 0, len) => {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    return fs.writeSync(fd, b, off, Math.min(len ?? b.length - off, 5));
  };
  const dribble = { writeSync: short };
  ops._setOpIo(dribble);
  const [st] = await call('POST', '/api/memory/accept', { opId: pv.opId });
  ops._setOpIo(null);
  ok('S1 Accept with writes of 5 bytes at a time publishes the complete index', st === 200 && fs.readFileSync(indexPath, 'utf8') === pv.diffs[0].after,
     `${st} ${fs.readFileSync(indexPath, 'utf8').length} vs ${pv.diffs[0].after.length}`);
  ops._setOpIo(dribble);
  const [, rv] = await call('POST', '/api/memory/restore', { opId: pv.opId });
  ops._setOpIo(null);
  ok('S1 …and Restore with the same short writes puts back the complete pre-image', rv?.restored === true && fs.readFileSync(indexPath, 'utf8') === orig,
     JSON.stringify(rv).slice(0, 160));

  V = await view();
  const [, p2] = await call('POST', '/api/memory/preview', { action: 'fix-links', ids: [V.findings.dangling.find((d) => d.target === 'gone-5.md').id] });
  let calls = 0;
  ops._setOpIo({ writeSync: (...args) => (++calls === 1 ? short(...args) : 0) });
  const [st2] = await call('POST', '/api/memory/accept', { opId: p2.opId });
  ops._setOpIo(null);
  ok('S1 a write that stalls part-way fails the step and publishes nothing', st2 !== 200 && fs.readFileSync(indexPath, 'utf8') === orig
     && !fs.readdirSync(fx.mem).some((n) => n.includes('.acs-')), `${st2} ${fs.readFileSync(indexPath, 'utf8').slice(0, 20)}`);
}

// ── criterion 11: the UI wording ──────────────────────────────────────────
{
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const start = app.indexOf('/* ── Memory view');
  const end = app.indexOf('/* ── Usage view');
  const section = app.slice(start, end > start ? end : undefined)
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('C11 the Memory and Context views exist in app.js', start !== -1 && section.includes("'/api/memory'") && section.includes("'/api/context'"));
  ok('C11 no UI string says unused, stale or never used', !/\bunused\b|\bstale\b|never used/i.test(section),
     (section.match(/.{0,40}(\bunused\b|\bstale\b|never used).{0,40}/i) || [''])[0]);
  ok('C11 the UI says "last written" and "unknown"', /last written/i.test(section) && /unknown/.test(section));
}

// ── cleanup ───────────────────────────────────────────────────────────────
server.close();
assertRealHomesUnchanged(realBefore, ok);
unlockMemoryHome(fakeHome);
fs.rmSync(fakeHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
