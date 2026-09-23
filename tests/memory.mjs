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
  ok('C2 an entry bullet whose only link is removed goes whole (with its newline)',
     noEntry === text.replace('- [Gone entry](gone-entry.md) — a whole entry whose file is missing\n', ''));
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
