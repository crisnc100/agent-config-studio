/**
 * Memory cleanups as operations: preview, Accept, Restore.
 *
 * THE SAFETY CORE. Every cleanup is one operation record `{id, action, steps}`
 * holding the preimage of everything it changes, written to the ACS state dir
 * BEFORE its first step runs and updated after each one, so an Accept that is
 * interrupted — or a server that restarts — still knows what happened and how
 * to undo it. Restore replays the preimages in reverse; for an index edit it
 * first proves the index is byte-for-byte what the operation left, and refuses
 * with the diff when someone has edited it since, rather than clobber them.
 *
 * NOTHING IS TRUSTED FROM THE CLIENT BUT AN ID. Ids are random, minted here and
 * mapped in memory to a finding; they carry no path. At Accept the targets are
 * re-checked from scratch: no symlink anywhere under ~/.claude/projects on the
 * way, the real path still inside that slug's memory/, nothing on the
 * credential deny-list, and every participating file re-hashed (sha256)
 * against the preview. Any mismatch aborts the whole operation before step
 * one — except the bulk empty-folder trash, where a folder that gained a file
 * is skipped and reported and the rest proceed.
 *
 * Accepts and Restores run one at a time; a second Accept of the same
 * operation finds the record already on disk and changes nothing.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { STUDIO_HOME, isDenied, resolveSafe, tilde } from './paths.js';
import { readInSkill } from './skills.js';
import * as mutate from './mutate.js';
import * as history from './history.js';
import { expectWrite } from './watch.js';
import {
  discoverMemory, editLinks, parseLinks, appendEntries, indexEntry,
  PROJECTS_DIR, INDEX_NAME, OVERSIZED_INDEX_LINES, LAST_WRITE_CAVEAT,
} from './memory-index.js';

export const OPS_DIR = path.join(STUDIO_HOME, 'memory-ops');
export const REVIEW_FILE = path.join(STUDIO_HOME, 'memory-review.json');
/** A kept fact comes back to the queue after this long, or at once if its content changes. */
export const KEEP_DAYS = 90;
/** Exactly what mint() produces; nothing path-shaped can match it. */
export const MEMORY_ID = /^[0-9a-f]{24}$/;
const PREVIEW_TTL_MS = 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const fail = (msg, status = 400, extra = {}) => Object.assign(new Error(msg), { status, ...extra });

/* ── ids ──────────────────────────────────────────────────────────────── */

const idByKey = new Map();
const targetById = new Map();

/** Stable for the life of the process for the same finding; random, never derived from a path. */
function mint(key, target) {
  let id = idByKey.get(key);
  if (!id) { id = crypto.randomBytes(12).toString('hex'); idByKey.set(key, id); }
  targetById.set(id, target);
  return id;
}

function lookup(id, kind) {
  if (typeof id !== 'string' || !MEMORY_ID.test(id)) throw fail(`not a memory id: ${JSON.stringify(String(id).slice(0, 40))}`);
  const t = targetById.get(id);
  if (!t) throw fail('unknown id — reopen the Memory view', 404);
  if (kind && t.kind !== kind) throw fail(`that id is not ${kind.replace('-', ' ')} finding`, 400);
  return t;
}

/* ── containment ──────────────────────────────────────────────────────── */

/**
 * Prove `abs` is a plain path under ~/.claude/projects: no component from the
 * projects dir down is a symlink, it is not on the deny-list, and — for a
 * memory file — its real directory is still that slug's memory/. Returns the
 * slug. Throws a 403 otherwise.
 */
function assertPlain(abs, { memoryFile = false } = {}) {
  const rel = path.relative(PROJECTS_DIR, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw fail(`outside ~/.claude/projects: ${tilde(abs)}`, 403);
  if (isDenied(abs)) throw fail(`protected path: ${tilde(abs)}`, 403);
  let cur = PROJECTS_DIR;
  const check = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return false; throw fail(`cannot inspect ${tilde(p)}`, 403); }
    if (st.isSymbolicLink()) throw fail(`symlink on the path: ${tilde(p)}`, 403);
    return true;
  };
  check(cur);
  for (const seg of rel.split(path.sep)) {
    cur = path.join(cur, seg);
    if (!check(cur)) break;
  }
  const [slug, second] = rel.split(path.sep);
  if (memoryFile) {
    if (second !== 'memory') throw fail(`not inside a memory folder: ${tilde(abs)}`, 403);
    const memDir = path.join(PROJECTS_DIR, slug, 'memory');
    let realDir;
    try { realDir = fs.realpathSync(path.dirname(abs)); } catch { throw fail(`folder is gone: ${tilde(path.dirname(abs))}`, 409); }
    if (realDir !== memDir && !realDir.startsWith(memDir + path.sep)) throw fail(`resolves outside its memory folder: ${tilde(abs)}`, 403);
  }
  if (fs.existsSync(abs) && resolveSafe(abs) !== abs) throw fail(`does not resolve to itself: ${tilde(abs)}`, 403);
  return slug;
}

/** A memory file's bytes, through the contained reader, or null when absent. */
function readMemoryFile(abs) {
  assertPlain(abs, { memoryFile: true });
  const slug = path.relative(PROJECTS_DIR, abs).split(path.sep)[0];
  const memDir = path.join(PROJECTS_DIR, slug, 'memory');
  try { return readInSkill(memDir, path.relative(memDir, abs).split(path.sep).join('/')); }
  catch (e) { if (e.status === 404) return null; throw e; }
}

/** What a participant looks like right now, in the same terms the preview recorded. */
function observe(p) {
  if (p.check === 'empty-slug') {
    assertPlain(p.abs);
    let top, mem;
    try { top = fs.readdirSync(p.abs); } catch { return 'gone'; }
    if (top.length !== 1 || top[0] !== 'memory') return `now holds ${top.length} entr${top.length === 1 ? 'y' : 'ies'}`;
    assertPlain(path.join(p.abs, 'memory'));
    try { mem = fs.readdirSync(path.join(p.abs, 'memory')); } catch { return 'memory/ is gone'; }
    if (mem.length) return `memory/ now holds ${mem.length} file${mem.length === 1 ? '' : 's'}`;
    return null;
  }
  if (p.check === 'absent') {
    // Only the path is checked, not its folder's containment: a link target
    // in a subfolder that does not exist is as absent as it gets.
    assertPlain(p.abs);
    try { fs.lstatSync(p.abs); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    return 'now exists';
  }
  const buf = readMemoryFile(p.abs);
  if (buf === null) return 'is gone';
  return sha256(buf) === p.sha ? null : 'changed since the preview';
}

/* ── the view ─────────────────────────────────────────────────────────── */

function loadReview() {
  try {
    const raw = JSON.parse(fs.readFileSync(REVIEW_FILE, 'utf8'));
    if (raw && typeof raw.keeps === 'object') return raw;
  } catch {}
  return { version: 1, keeps: {} };
}

function saveJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

/**
 * The Memory view's payload. Paths appear only as display text and as the
 * editor path of a fact (the existing editor opens files by path); every
 * action is addressed by an id.
 */
export async function memoryView({ writes } = {}) {
  const inv = await discoverMemory({ writes });
  const review = loadReview();
  const now = inv.now;
  const groupId = (key) => mint(`group\0${key}`, { kind: 'group', key });

  // A temp probe's memory is real, but a scratch session is not a project:
  // it is left out of every list and only counted. The empty-folder trash
  // still offers a probe holding nothing but an empty memory/.
  const probes = new Set(inv.slugs.filter((s) => s.probe).map((s) => s.slug));
  const shown = (slug) => !probes.has(slug);

  const rowId = new Map();
  const rows = inv.rows.filter((r) => shown(r.slug)).map((r) => {
    const id = mint(`row\0${r.abs}`, { kind: 'row', abs: r.abs, slug: r.slug, rel: r.rel, memDir: r.memDir, fm: r.fm, name: r.name });
    rowId.set(r.abs, id);
    const kept = review.keeps[r.abs] || null;
    const keepValid = kept && kept.sha256 === r.sha256 && now - kept.reviewedAt < KEEP_DAYS * DAY;
    const activity = Math.max(r.modified || 0, r.lastWrite ? Date.parse(r.lastWrite) : 0);
    return {
      id, group: groupId(r.groupKey), slug: r.slug, rel: r.rel, name: r.name,
      description: r.description, type: r.type, format: r.format,
      modified: iso(r.modified), modifiedSource: r.modifiedSource, modifiedFlag: r.modifiedFlag,
      lastWrite: r.lastWrite, writeCount: r.writeCount, activity: iso(activity),
      archived: r.archived, indexed: r.indexed, size: r.size,
      display: tilde(r.abs), openPath: r.abs,
      kept: kept ? { reviewedAt: iso(kept.reviewedAt), until: iso(kept.reviewedAt + KEEP_DAYS * DAY), contentChanged: kept.sha256 !== r.sha256 } : null,
      inQueue: !r.archived && !keepValid,
    };
  });

  const groups = inv.groups
    .filter((g) => !g.probe && (g.rows.length || g.indexes.length))
    .map((g) => ({
      id: groupId(g.key), label: g.label, state: g.state,
      display: g.root ? tilde(g.root) : g.slugs[0].slug,
      slugs: g.slugs.filter((s) => s.memory.files.length || s.state !== 'resolved' || !s.repo?.worktree).map((s) => ({
        slug: s.slug, state: s.state, display: s.path ? tilde(s.path) : null,
        worktree: Boolean(s.repo?.worktree), memoryFiles: s.memory.files.length,
        excluded: s.memory.excluded.map((x) => ({ rel: x.rel, reason: x.reason })),
      })),
      rowCount: g.rows.length,
      indexes: g.indexes.map((ix) => ({ slug: ix.slug, lines: ix.lines, oversized: ix.lines > OVERSIZED_INDEX_LINES })),
    }))
    .sort((a, b) => b.rowCount - a.rowCount || a.label.localeCompare(b.label));

  const f = inv.findings;
  const findings = {
    emptySlugs: f.emptySlugs.map((e) => ({
      id: mint(`empty\0${e.slug}`, { kind: 'empty-slug', slug: e.slug, abs: e.abs }),
      slug: e.slug, probe: e.probe, state: e.state,
    })),
    dangling: f.dangling.filter((d) => shown(d.slug)).map((d) => ({
      id: mint(`dangling\0${d.indexAbs}\0${d.start}\0${d.target}`, { kind: 'dangling-link', indexAbs: d.indexAbs, start: d.start, target: d.target, archiveRel: d.archiveRel }),
      group: groupId(inv.slugs.find((s) => s.slug === d.slug).groupKey), slug: d.slug,
      line: d.line, label: d.label, target: d.target, lineText: d.lineText,
      offer: d.archiveRel ? 'archive' : 'remove', archiveRel: d.archiveRel,
    })),
    unindexed: f.unindexed.filter((u) => shown(u.slug)).map((u) => ({
      id: mint(`unindexed\0${u.abs}`, { kind: 'unindexed', abs: u.abs }),
      group: groupId(inv.slugs.find((s) => s.slug === u.slug).groupKey), slug: u.slug,
      rel: u.rel, row: rowId.get(u.abs), createsIndex: !u.hasIndex,
    })),
    oversized: f.oversized.filter((o) => shown(o.slug)).map((o) => ({ ...o, group: groupId(inv.slugs.find((s) => s.slug === o.slug).groupKey), threshold: OVERSIZED_INDEX_LINES })),
    orphans: f.orphans.map((o) => ({
      group: groupId(o.groupKey), slug: o.slug, state: o.state,
      nearest: o.nearest ? tilde(o.nearest) : null, candidates: o.candidates.map(tilde),
      counterparts: o.counterparts.map(groupId),
    })),
    duplicates: f.duplicates
      .map((d) => ({ name: d.name, rows: d.rows.filter((r) => shown(r.slug)) }))
      .filter((d) => new Set(d.rows.map((r) => r.memDir)).size > 1)
      .map((d) => ({ name: d.name, rows: d.rows.map((r) => rowId.get(r.abs)) })),
  };

  const states = {};
  for (const s of inv.slugs) states[s.state] = (states[s.state] || 0) + 1;

  return {
    caveat: LAST_WRITE_CAVEAT,
    keepDays: KEEP_DAYS,
    states,
    slugCount: inv.slugs.length,
    hiddenProbeFiles: inv.rows.filter((r) => !shown(r.slug)).length,
    scan: inv.scan,
    other: inv.other,
    groups, rows, findings,
  };
}

/** A fact's own content, by row id — for the side-by-side and review views. */
export function memoryFile(id) {
  const t = lookup(id, 'row');
  const buf = readMemoryFile(t.abs);
  if (buf === null) throw fail('that memory file is gone', 404);
  return { id, name: t.name, display: tilde(t.abs), content: buf.toString('utf8') };
}

/* ── keep ─────────────────────────────────────────────────────────────── */

/** Keep: remember the content hash; the fact is never edited. */
export function keep(id) {
  const t = lookup(id, 'row');
  const buf = readMemoryFile(t.abs);
  if (buf === null) throw fail('that memory file is gone', 404);
  const review = loadReview();
  const reviewedAt = Date.now();
  review.keeps[t.abs] = { sha256: sha256(buf), reviewedAt };
  saveJson(REVIEW_FILE, review);
  return { kept: true, reviewedAt: iso(reviewedAt), until: iso(reviewedAt + KEEP_DAYS * DAY) };
}

/* ── previews ─────────────────────────────────────────────────────────── */

const pending = new Map();

function currentIndex(indexAbs) {
  const buf = readMemoryFile(indexAbs);
  if (buf === null) throw fail(`${tilde(indexAbs)} is gone — reopen the Memory view`, 409);
  return { buf, text: buf.toString('utf8'), sha: sha256(buf) };
}

/** Remove every link in an index that points at `rel`; null when there is none. */
function unlinkFact(indexText, rel) {
  const edits = parseLinks(indexText).filter((l) => l.rel === rel).map((l) => ({ start: l.start, action: 'remove' }));
  return edits.length ? editLinks(indexText, edits) : null;
}

/**
 * Build an operation from findings and park it until Accept. Returns what the
 * UI shows: a diff for every file that would change, and a list for every
 * folder or file that would go to the trash.
 */
export function preview({ action, ids }) {
  if (!Array.isArray(ids) || !ids.length) throw fail('ids is required');
  if (ids.length > 500) throw fail('too many ids at once');
  const uniq = [...new Set(ids)];
  const participants = [];
  const steps = [];
  const diffs = [];
  const items = [];

  if (action === 'trash-empty-slugs') {
    for (const id of uniq) {
      const t = lookup(id, 'empty-slug');
      const p = { abs: t.abs, check: 'empty-slug', label: t.slug };
      const why = observe(p);
      if (why) throw fail(`${t.slug} is no longer empty (${why}) — reopen the Memory view`, 409);
      participants.push(p);
      steps.push({ type: 'trash', target: 'slug', abs: t.abs, label: `~/.claude/projects/${t.slug}/`, participant: participants.length - 1 });
      items.push(`~/.claude/projects/${t.slug}/ — nothing inside but an empty memory/`);
    }
  } else if (action === 'fix-links') {
    const byIndex = new Map();
    for (const id of uniq) {
      const t = lookup(id, 'dangling-link');
      if (!byIndex.has(t.indexAbs)) byIndex.set(t.indexAbs, []);
      byIndex.get(t.indexAbs).push(t);
    }
    for (const [indexAbs, ts] of byIndex) {
      const cur = currentIndex(indexAbs);
      const links = parseLinks(cur.text);
      const memDir = path.dirname(indexAbs);
      const facts = [];
      const edits = ts.map((t) => {
        const l = links.find((x) => x.start === t.start && x.target === t.target);
        if (!l) throw fail(`${tilde(indexAbs)} changed since the view — reopen it`, 409);
        // Still a finding? The target must still be missing, and an archive
        // replacement must still be there — checked now, and again at Accept.
        const target = { abs: path.join(memDir, l.rel), check: 'absent', label: `${l.rel} (still missing)` };
        const why = observe(target);
        if (why) throw fail(`${l.rel} ${why} — its link is no longer dangling. Reopen the Memory view.`, 409);
        facts.push(target);
        if (t.archiveRel) {
          const arch = path.join(memDir, t.archiveRel);
          const buf = readMemoryFile(arch);
          if (buf === null) throw fail(`${t.archiveRel} is gone — reopen the Memory view`, 409);
          facts.push({ abs: arch, check: 'file', sha: sha256(buf), label: t.archiveRel });
          return { start: t.start, action: 'retarget', to: t.archiveRel };
        }
        return { start: t.start, action: 'remove' };
      });
      const after = editLinks(cur.text, edits);
      participants.push(...facts);
      participants.push({ abs: indexAbs, check: 'file', sha: cur.sha, label: tilde(indexAbs) });
      steps.push({ type: 'edit-index', abs: indexAbs, before: cur.text, after, beforeSha: cur.sha, afterSha: sha256(Buffer.from(after)), label: tilde(indexAbs) });
      diffs.push({ label: tilde(indexAbs), before: cur.text, after });
    }
  } else if (action === 'add-to-index') {
    const byDir = new Map();
    for (const id of uniq) {
      const u = lookup(id, 'unindexed');
      const row = [...targetById.values()].find((x) => x.kind === 'row' && x.abs === u.abs);
      if (!row) throw fail('reopen the Memory view', 409);
      if (!byDir.has(row.memDir)) byDir.set(row.memDir, []);
      byDir.get(row.memDir).push(row);
    }
    for (const [memDir, facts] of byDir) {
      const indexAbs = path.join(memDir, INDEX_NAME);
      // The entries are built from these files, so they must not change either.
      const requires = [];
      for (const r of facts) {
        const buf = readMemoryFile(r.abs);
        if (buf === null) throw fail(`${tilde(r.abs)} is gone — reopen the Memory view`, 409);
        requires.push({ abs: r.abs, check: 'file', sha: sha256(buf), label: tilde(r.abs) });
      }
      participants.push(...requires);
      const entries = facts.sort((a, b) => a.rel.localeCompare(b.rel)).map((r) => indexEntry(r.rel, r.fm));
      const existing = readMemoryFile(indexAbs);
      if (existing !== null) {
        const linked = new Set(parseLinks(existing.toString('utf8')).map((l) => l.rel));
        const already = facts.filter((r) => linked.has(r.rel));
        if (already.length) throw fail(`${already.map((r) => r.rel).join(', ')} is already in ${tilde(indexAbs)} — reopen the Memory view`, 409);
      }
      if (existing === null) {
        const after = appendEntries('', entries);
        participants.push({ abs: indexAbs, check: 'absent', label: tilde(indexAbs) });
        steps.push({ type: 'create-index', abs: indexAbs, after, afterSha: sha256(Buffer.from(after)), label: tilde(indexAbs) });
        diffs.push({ label: `${tilde(indexAbs)} (new file)`, before: '', after });
      } else {
        const before = existing.toString('utf8');
        const after = appendEntries(before, entries);
        participants.push({ abs: indexAbs, check: 'file', sha: sha256(existing), label: tilde(indexAbs) });
        steps.push({ type: 'edit-index', abs: indexAbs, before, after, beforeSha: sha256(existing), afterSha: sha256(Buffer.from(after)), label: tilde(indexAbs) });
        diffs.push({ label: tilde(indexAbs), before, after });
      }
    }
  } else if (action === 'trash-fact') {
    // Every fact first, then one edit per index with all of its facts'
    // links removed — so Restore, which runs newest first, puts the links
    // back only once the index is the one this operation wrote.
    const byIndex = new Map();
    for (const id of uniq) {
      const r = lookup(id, 'row');
      const buf = readMemoryFile(r.abs);
      if (buf === null) throw fail(`${tilde(r.abs)} is gone — reopen the Memory view`, 409);
      participants.push({ abs: r.abs, check: 'file', sha: sha256(buf), label: tilde(r.abs) });
      steps.push({ type: 'trash', target: 'fact', abs: r.abs, sha: sha256(buf), label: tilde(r.abs), participant: participants.length - 1 });
      items.push(`${tilde(r.abs)} — moves to the ACS trash`);
      if (r.rel === INDEX_NAME) continue;
      const indexAbs = path.join(r.memDir, INDEX_NAME);
      if (!byIndex.has(indexAbs)) byIndex.set(indexAbs, []);
      byIndex.get(indexAbs).push(r.rel);
    }
    for (const [indexAbs, rels] of byIndex) {
      const idx = readMemoryFile(indexAbs);
      if (idx === null) continue;
      const before = idx.toString('utf8');
      let after = before;
      for (const rel of rels) after = unlinkFact(after, rel) ?? after;
      if (after === before) continue;
      participants.push({ abs: indexAbs, check: 'file', sha: sha256(idx), label: tilde(indexAbs) });
      steps.push({ type: 'edit-index', abs: indexAbs, before, after, beforeSha: sha256(idx), afterSha: sha256(Buffer.from(after)), label: tilde(indexAbs) });
      diffs.push({ label: tilde(indexAbs), before, after });
    }
  } else {
    throw fail(`unknown action: ${JSON.stringify(String(action).slice(0, 40))}`);
  }

  const id = crypto.randomBytes(12).toString('hex');
  const summary = {
    'trash-empty-slugs': `Trash ${steps.length} empty folder${steps.length === 1 ? '' : 's'}`,
    'fix-links': `Repair ${uniq.length} index link${uniq.length === 1 ? '' : 's'} in ${steps.length} index${steps.length === 1 ? '' : 'es'}`,
    'add-to-index': `Index ${uniq.length} file${uniq.length === 1 ? '' : 's'}`,
    'trash-fact': uniq.length === 1
      ? `Trash ${path.basename(steps[0]?.abs || '')}${steps.length > 1 ? ' and its index link' : ''}`
      : `Trash ${uniq.length} facts${steps.length > uniq.length ? ' and their index links' : ''}`,
  }[action];
  for (const [k, v] of pending) if (Date.now() - v.createdAt > PREVIEW_TTL_MS) pending.delete(k);
  pending.set(id, { id, action, summary, participants, steps, createdAt: Date.now() });
  return { opId: id, action, summary, diffs, items };
}

/* ── accept & restore ─────────────────────────────────────────────────── */

let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

/** The record shape this code writes. Anything else is refused, never guessed at. */
const SCHEMA = 2;
const opFile = (id) => path.join(OPS_DIR, `${id}.json`);
const readRecord = (id) => { try { return JSON.parse(fs.readFileSync(opFile(id), 'utf8')); } catch { return null; } };
const writeRecord = (rec) => saveJson(opFile(rec.id), rec);

/**
 * Is this a record this code wrote? No memory-op record ever existed before
 * SCHEMA 2 outside the test suites, so there is no legacy shape to honour —
 * and a record that has to be interpreted by guessing (a trash step with no
 * `target`, a step with no `state`) is exactly how Restore once reported
 * success without undoing anything. It is refused instead.
 */
function recognised(rec) {
  const STATES = new Set(['pending', 'started', 'done', 'refused']);
  const hex = (x) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
  if (rec?.schema !== SCHEMA || !Array.isArray(rec.steps) || !Array.isArray(rec.participants)) return false;
  return rec.steps.every((s) => {
    if (typeof s?.abs !== 'string' || !STATES.has(s.state)) return false;
    if (s.type === 'trash') {
      if (s.target !== 'slug' && s.target !== 'fact') return false;
      if (s.target === 'fact' && !hex(s.sha)) return false;
      return s.state === 'pending' || s.state === 'refused' || typeof s.trashId === 'string';
    }
    if (s.type === 'edit-index') return typeof s.before === 'string' && typeof s.after === 'string' && hex(s.beforeSha) && hex(s.afterSha);
    if (s.type === 'create-index') return typeof s.after === 'string' && hex(s.afterSha);
    return false;
  });
}

async function recordHistory(abs, message, errors, baseline = false) {
  try { await (baseline ? history.recordBaseline(abs, message) : history.record(abs, message)); }
  catch (e) { errors.push(e.message); }
}

const refusal = (msg) => Object.assign(fail(msg, 409), { refusal: true });

/**
 * Replace (or, with `exclusive`, create) an index so that the last check and
 * the change are one synchronous stretch: the temp file is written first
 * (asynchronously, it is not the target yet), then `verify()` and the rename
 * or link run in the same tick. Nothing in this process can interleave, which
 * closes every window an await used to leave — including the temp write.
 *
 * ACCEPTED LIMIT. Another PROCESS can still write the index in the
 * microseconds between verify()'s read and renameSync. Closing that needs an
 * atomic compare-and-swap on a path, which neither macOS nor Node offers (the
 * same class of limit readInSkill documents in lib/skills.js). The window is
 * a few system calls wide, and whatever lands in it is still in the history
 * baseline taken just before.
 */
async function writeIndex(abs, text, verify, { exclusive = false, phase = 'accept' } = {}) {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.acs-${crypto.randomBytes(4).toString('hex')}.tmp`);
  // Checked and created in one tick, so the temp file cannot land through a
  // folder swapped for a link while this process was awaiting something else.
  verify();
  const fd = fs.openSync(tmp, 'wx');
  const want = Buffer.from(text);
  try {
    // writeSync may write less than asked; loop until every byte is down,
    // and prove the temp file holds exactly `text` before it can be published.
    try {
      for (let off = 0; off < want.length;) {
        const n = opIo.writeSync(fd, want, off, want.length - off);
        if (!(n > 0)) throw new Error(`short write to ${tilde(tmp)} (${off} of ${want.length} bytes)`);
        off += n;
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const written = fs.readFileSync(tmp);
    if (written.length !== want.length || sha256(written) !== sha256(want)) {
      throw new Error(`${tilde(abs)}: the temp file does not hold the intended bytes — nothing was published`);
    }
    await fault('after-temp-write', { phase, abs });
    verify();
    if (exclusive) { fs.linkSync(tmp, abs); fs.unlinkSync(tmp); }
    else fs.renameSync(tmp, abs);
    expectWrite(abs, exclusive ? 'added' : 'changed', sha256(want));
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    if (e.code === 'EEXIST') throw refusal(`${tilde(abs)} now exists`);
    throw e;
  }
}

/**
 * Everything the operation still depends on, checked together: every
 * participant not consumed by a step already done. Run immediately before
 * EACH step's mutation (synchronously, in the same tick as it), so a change
 * to any participant — not only the one this step touches — refuses the
 * step before it changes anything.
 */
function verifyRemaining(rec) {
  const consumed = new Set(rec.steps.filter((x) => x.state === 'done').map((x) => x.abs));
  for (const p of rec.participants) {
    if (consumed.has(p.abs)) continue;
    let why;
    try { why = observe(p); } catch (e) { why = e.message; }
    if (why) throw refusal(`${p.label}: ${why}`);
  }
}

function publicRecord(rec) {
  const live = running.has(rec.id);
  if (!recognised(rec)) {
    return { id: rec.id, action: rec.action ?? null, summary: rec.summary ?? '(unrecognised record)', status: 'unrecognised',
      acceptedAt: rec.acceptedAt ?? null, restoredAt: null, steps: [], skipped: [], historyError: null, error: null };
  }
  return {
    id: rec.id, action: rec.action, summary: rec.summary,
    status: !live && rec.status === 'applying' ? 'interrupted'
      : !live && rec.status === 'restoring' ? 'restore interrupted' : rec.status,
    acceptedAt: rec.acceptedAt, restoredAt: rec.restoredAt ?? null,
    steps: rec.steps.map((s) => ({ type: s.type, label: s.label, path: tilde(s.abs), done: s.state === 'done', restored: Boolean(s.restored) })),
    skipped: rec.skipped || [], historyError: rec.historyError ?? null, error: rec.error ?? null,
  };
}

const running = new Set();
// Refused operations, so a resubmission is refused the same way, not "unknown".
const refused = new Set();

/**
 * A test seam for the crash and race tests, which act at a named point:
 * 'before-step', 'after-baseline', 'after-temp-write', 'after-mutation' (the
 * file changed, the record not yet), 'restore-after-step'. Nothing in the
 * app sets it.
 */
let faultHook = null;
export function _setOpFault(fn) { faultHook = fn; }
// The temp-file write, swappable so a test can force short writes.
const opIo = { writeSync: fs.writeSync };
export function _setOpIo(over) { opIo.writeSync = over?.writeSync ?? fs.writeSync; }
async function fault(point, step) { if (faultHook) await faultHook(point, step); }

/**
 * Accept a previewed operation.
 *
 * Every participant is re-checked up front and the operation refused whole on
 * any change. Then, before each step mutates, every participant still
 * outstanding is checked again in the same tick as the mutation, and the
 * step's progress is written to the record on both sides of it: `started`
 * (with the trash id it will use, allocated in advance) before, `done` after.
 * A crash between the two leaves a step Restore can still recognise by its
 * bytes. A step refused at its last check changes nothing, and the steps
 * before it stay restorable.
 */
export function accept(opId) {
  if (typeof opId !== 'string' || !MEMORY_ID.test(opId)) throw fail('not an operation id');
  return serial(async () => {
    if (readRecord(opId)) throw fail('that operation was already accepted — nothing changed', 409);
    if (refused.has(opId)) throw fail('that operation was refused — nothing changed; preview again', 409);
    const op = pending.get(opId);
    if (!op) throw fail('no such preview (it expired, or the server restarted) — preview again', 404);
    pending.delete(opId);

    const problems = [];
    const skipped = [];
    const blocked = new Set();
    op.participants.forEach((p, i) => {
      let why;
      try { why = observe(p); } catch (e) { why = e.message; }
      if (!why) return;
      if (op.action === 'trash-empty-slugs') { skipped.push(`${p.label}: ${why}`); blocked.add(i); }
      else problems.push(`${p.label}: ${why}`);
    });
    if (problems.length) {
      refused.add(opId);
      throw fail(`Nothing was changed — ${problems.join('; ')}. Preview again.`, 409, { problems });
    }
    const steps = op.steps.filter((s) => !(s.participant !== undefined && blocked.has(s.participant)))
      .map(({ participant, ...s }) => ({ ...s, state: 'pending' }));

    const rec = {
      schema: SCHEMA, id: op.id, action: op.action, summary: op.summary, status: 'applying',
      acceptedAt: new Date().toISOString(), steps, skipped,
      participants: op.participants.filter((_, i) => !blocked.has(i)),
    };
    running.add(rec.id);
    writeRecord(rec);
    const historyErrors = [];
    let error = null;
    try {
      for (const s of rec.steps) {
        await fault('before-step', s);
        verifyRemaining(rec);
        s.state = 'started';
        if (s.type === 'trash') s.trashId = mutate.newTrashId(path.basename(s.abs));
        writeRecord(rec);
        try {
          if (s.type === 'trash') {
            const r = await mutate.trashResolved(s.abs, { id: s.trashId, beforeMove: () => verifyRemaining(rec), sameDevice: true });
            if (r.historyError) historyErrors.push(r.historyError);
          } else if (s.type === 'edit-index') {
            await recordHistory(s.abs, `state of ${tilde(s.abs)} before memory cleanup`, historyErrors, true);
            await fault('after-baseline', s);
            await writeIndex(s.abs, s.after, () => verifyRemaining(rec));
          } else if (s.type === 'create-index') {
            await writeIndex(s.abs, s.after, () => { assertPlain(s.abs, { memoryFile: true }); verifyRemaining(rec); }, { exclusive: true });
          }
        } catch (e) {
          // Refused at its own last check: this step changed nothing.
          if (e.refusal || e.status === 403) { s.state = 'refused'; e.refusal = true; }
          throw e;
        }
        await fault('after-mutation', s);
        s.state = 'done';
        writeRecord(rec);
        if (s.type !== 'trash') await recordHistory(s.abs, `memory cleanup: ${rec.summary}`, historyErrors);
      }
      rec.status = 'applied';
    } catch (e) {
      error = e;
      const anyRan = rec.steps.some((s) => s.state === 'done' || s.state === 'started');
      rec.status = e.refusal && !anyRan ? 'refused' : 'failed';
      rec.error = e.message;
    } finally {
      rec.historyError = historyErrors.length ? historyErrors.join('; ') : null;
      if (rec.historyError) console.error(`memory op ${rec.id}: history not recorded — ${rec.historyError}`);
      writeRecord(rec);
      running.delete(rec.id);
    }
    if (error) {
      const tail = rec.status === 'refused' ? 'nothing was changed' : 'the steps that ran can be restored from Operations';
      // `payload` reaches the client's error body (server.js), so the page can
      // say which steps ran.
      const op = publicRecord(rec);
      throw fail(`${error.message} — ${tail}`, error.refusal ? 409 : 500, { op, payload: { op } });
    }
    return publicRecord(rec);
  });
}

/**
 * What Restore must do for one step, judged from what is on disk now rather
 * than from what the record claims — a crash can separate the two in either
 * direction. Returns 'undo', 'skip' (never happened, or already undone), or
 * a problem (with the diff, for an index someone else edited).
 */
function inspectForRestore(s, trash) {
  if (s.type === 'edit-index' || s.type === 'create-index') {
    const buf = readMemoryFile(s.abs);
    if (buf === null) return s.type === 'create-index' ? 'skip' : { problem: `${s.label} is gone` };
    const sha = sha256(buf);
    if (sha === s.afterSha) return 'undo';
    if (s.type === 'edit-index' && sha === s.beforeSha) return 'skip';
    return { problem: `${s.label} was edited after this cleanup`, diff: { label: s.label, before: s.after, after: buf.toString('utf8') } };
  }
  const entry = trash.get(s.trashId) || null;
  let st = null;
  try { st = fs.lstatSync(s.abs); } catch {}
  if (entry?.moved) {
    if (!st) return 'undo';
    // A restore interrupted after it put the data back but before it cleared
    // the trash copy: identical bytes (or the empty folder it claimed) are
    // that restore, and it is finished rather than refused.
    if (s.target === 'fact' && st.isFile()) {
      if (st.nlink > 1) return mutate.isRestoreLink(s.trashId, s.abs, s.sha) ? 'undo' : { problem: `something exists at ${s.label} again` };
      let sha = null;
      try { sha = sha256(readMemoryFile(s.abs)); } catch {}
      if (sha === s.sha) return 'undo';
    }
    if (s.target === 'slug' && st.isDirectory() && fs.readdirSync(s.abs).length === 0) return 'undo';
    return { problem: `something exists at ${s.label} again` };
  }
  if (entry || !st) {
    // An entry whose data never moved means the original never left.
    return st ? 'skip' : { problem: `${s.label} is no longer in the trash` };
  }
  // No entry and the original is there: never trashed, or already put back.
  if (s.target === 'slug') return 'skip';
  let same = false;
  try { same = sha256(readMemoryFile(s.abs)) === s.sha; } catch {}
  return same ? 'skip' : { problem: `something exists at ${s.label} again` };
}

/**
 * Create the folders a trashed item goes back into, one at a time, under
 * Memory's rule: from ~/.claude/projects down, every existing component must
 * be a real directory — never a link — BEFORE anything below it is made, and
 * each one made is checked again with lstat. A recursive mkdir would follow a
 * substituted link and build folders wherever it points.
 */
function ensureMemoryParent(abs) {
  const rel = path.relative(PROJECTS_DIR, path.dirname(abs));
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw refusal(`outside ~/.claude/projects: ${tilde(abs)}`);
  let cur = PROJECTS_DIR;
  const plain = (p) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink() || !st.isDirectory()) throw refusal(`not a plain folder: ${tilde(p)}`);
  };
  plain(cur);
  for (const seg of rel ? rel.split(path.sep) : []) {
    cur = path.join(cur, seg);
    try { plain(cur); continue; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    fs.mkdirSync(cur);
    plain(cur);
  }
}

/**
 * Undo an operation: every step that ran or may have run, newest first. All
 * preconditions are checked before anything moves; each undo re-checks its
 * own target in the same tick as it lands and is recorded as it lands — so a
 * Restore that is interrupted can simply be run again. An index that is no
 * longer exactly what the operation wrote is not overwritten: the restore is
 * refused and the diff of what changed since is returned instead.
 */
export function restore(opId) {
  if (typeof opId !== 'string' || !MEMORY_ID.test(opId)) throw fail('not an operation id');
  return serial(async () => {
    const rec = readRecord(opId);
    if (!rec) throw fail('no such operation', 404);
    if (!recognised(rec)) throw fail('unrecognised operation record — refused, nothing was restored', 409);
    if (rec.status === 'restored') throw fail('already restored — nothing changed', 409);
    if (rec.status === 'refused') throw fail('that operation changed nothing — there is nothing to restore', 409);
    if (running.has(rec.id)) throw fail('that operation is still running', 409);

    const todo = rec.steps.filter((s) => (s.state === 'done' || s.state === 'started') && !s.restored).reverse();
    const trash = new Map((await mutate.listTrash()).map((t) => [t.id, t]));
    const plan = todo.map((s) => {
      try { return [s, inspectForRestore(s, trash)]; }
      catch (e) { return [s, { problem: `${s.label}: ${e.message}` }]; }
    });
    const problems = plan.filter(([, v]) => typeof v === 'object');
    if (problems.length) {
      return {
        restored: false,
        reason: `Nothing was restored — ${problems.map(([, v]) => v.problem).join('; ')}.`,
        diffs: problems.map(([, v]) => v.diff).filter(Boolean), op: publicRecord(rec),
      };
    }

    rec.status = 'restoring';
    writeRecord(rec);
    const historyErrors = [];
    try {
      for (const [s, what] of plan) {
        if (what === 'undo') {
          if (s.type === 'edit-index' || s.type === 'create-index') {
            const recheck = () => {
              assertPlain(s.abs, { memoryFile: true });
              const buf = readMemoryFile(s.abs);
              if (buf === null || sha256(buf) !== s.afterSha) throw refusal(`${s.label} changed during the restore`);
            };
            if (s.type === 'edit-index') {
              await writeIndex(s.abs, s.before, recheck, { phase: 'restore' });
            } else {
              const r = await mutate.trashResolved(s.abs, { beforeMove: recheck, sameDevice: true });
              if (r.historyError) historyErrors.push(r.historyError);
            }
          } else {
            const r = await mutate.restoreTrash({ id: s.trashId }, {
              // Memory's containment, not just the allowed roots: exactly the
              // recorded path, no link anywhere on it — checked before any
              // folder is created, and again in the tick of the claim.
              verifyDest: (abs, meta, phase) => {
                if (abs !== s.abs || meta.originalPath !== s.abs) throw refusal(`${s.label} now resolves elsewhere`);
                assertPlain(s.abs, { memoryFile: phase === 'claim' && s.target === 'fact' });
              },
              ensureParent: ensureMemoryParent,
              sameDevice: true,
            });
            if (r.historyError) historyErrors.push(r.historyError);
          }
          await fault('restore-after-step', s);
        }
        s.restored = true;
        writeRecord(rec);
        if (what === 'undo' && s.type === 'edit-index') await recordHistory(s.abs, `restore ${tilde(s.abs)} (undo memory cleanup)`, historyErrors);
      }
    } catch (e) {
      rec.status = 'restoring';
      rec.restoreError = e.message;
      writeRecord(rec);
      return { restored: false, reason: `Restore stopped — ${e.message}. What was already put back stays put back; run Restore again once this is resolved.`, diffs: [], op: publicRecord(rec) };
    }
    rec.status = 'restored';
    rec.restoredAt = new Date().toISOString();
    rec.restoreHistoryError = historyErrors.length ? historyErrors.join('; ') : null;
    writeRecord(rec);
    return { restored: true, op: publicRecord(rec), historyError: rec.restoreHistoryError };
  });
}

/** Every recorded operation, newest first. Survives restarts: it is read from disk. */
export function listOps() {
  let names = [];
  try { names = fs.readdirSync(OPS_DIR).filter((n) => /^[0-9a-f]{24}\.json$/.test(n)); } catch {}
  return names.map((n) => readRecord(n.slice(0, -5))).filter(Boolean)
    .sort((a, b) => (a.acceptedAt < b.acceptedAt ? 1 : -1)).map(publicRecord);
}

