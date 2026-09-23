/**
 * Claude auto-memory, as an inventory: every fact under
 * ~/.claude/projects/<slug>/memory/, grouped by the repository it belongs to,
 * with the structural rot around it. READ-ONLY — nothing in this module
 * writes; lib/memory-ops.js turns its findings into operations.
 *
 * SLUGS ARE LOSSY. A slug is the session's working directory with `/`, `_`,
 * `.` and spaces all turned into `-`, and older sessions used a different
 * rule. So a slug is decoded by walking the filesystem from `/`, trying every
 * entry whose encoding fits, and it lands in one of five states: `resolved`
 * (a git checkout), `non-git`, `ambiguous` (more than one real path encodes to
 * it), `inaccessible` (a directory on the way could not be listed, or a volume
 * is not mounted) and `missing` — which is claimed only after every candidate
 * prefix was listed successfully and none led anywhere. A failed decode is
 * NOT evidence that memory is orphaned; the state says how sure we are.
 *
 * MEMORY IS KEYED BY THE MAIN CHECKOUT, transcripts by each worktree. Slugs
 * are therefore grouped by git common dir (lib/gitmeta.js), so a repository's
 * worktrees and subdirectories roll up into one group.
 *
 * "LAST WRITTEN" IS NARROW ON PURPOSE. MEMORY.md is loaded into every session,
 * so every memory name appears in every transcript and a name search proves
 * nothing. The only evidence taken is an assistant Write/Edit/MultiEdit
 * tool_use on that exact path whose tool_result came back without an error.
 * No such record means UNKNOWN: transcripts are pruned, and a memory can be
 * read on every session without ever being written.
 *
 * Every file under a memory directory is read through readInSkill() — the
 * contained, no-follow reader from lib/skills.js — so a symlink planted in a
 * memory folder is refused rather than resolved.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

import { HOME, CLAUDE_HOME, CODEX_HOME, GROK_HOME, STUDIO_HOME, isDenied, tilde } from './paths.js';
import { readInSkill } from './skills.js';
import { repoOf, mainCheckoutOf } from './gitmeta.js';

export const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
export const WRITES_CACHE_FILE = path.join(STUDIO_HOME, 'memory-writes-cache.json');
export const INDEX_NAME = 'MEMORY.md';
export const ARCHIVE_DIR = '_archive';
/** Above this many lines the index is flagged: the harness truncates long ones. */
export const OVERSIZED_INDEX_LINES = 200;

export const LAST_WRITE_CAVEAT = Object.freeze({
  evidence: 'successful Write/Edit/MultiEdit tool calls on the exact file, in Claude Code transcripts',
  unknownMeans: 'no retained record of a write',
  text: '"Last written" is the newest Write, Edit or MultiEdit on that exact file that succeeded, '
      + 'taken from the Claude Code transcripts still on disk. "Unknown" means no such record is left — '
      + 'transcripts are pruned, and a memory can be read in every session without ever being written. '
      + 'It says nothing about whether a memory is read.',
});

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/* ── slugs ────────────────────────────────────────────────────────────── */

/** The current Claude Code encoding: every character outside [A-Za-z0-9] becomes `-`. */
export const encodeSlug = (abs) => abs.replace(/[^A-Za-z0-9]/g, '-');

/**
 * Scratch directories whose sessions are throwaway: an ACS probe, a
 * scratchpad, a tool's temp cwd. Recognised by the slug STARTING in a temp
 * root — and never when the slug is under HOME, which in a test is itself a
 * temp directory.
 */
const TEMP_ROOTS = ['/private/tmp', '/tmp', '/private/var/folders', '/var/folders'];
export function isTempProbe(slug) {
  const home = encodeSlug(HOME);
  if (slug === home || slug.startsWith(home + '-')) return false;
  return TEMP_ROOTS.some((r) => slug.startsWith(encodeSlug(r) + '-'));
}

/** A slug with the HOME prefix dropped, for a label when it resolves nowhere. */
const homeRelative = (slug) => {
  const home = encodeSlug(HOME) + '-';
  return slug.startsWith(home) ? slug.slice(home.length) : slug;
};

/** The two encodings a path component may have been written with. */
const componentForms = (name) => [...new Set([name.replace(/[^A-Za-z0-9]/g, '-'), name.replace(/\//g, '-')])];

const MAX_MATCHES = 8;

/**
 * Decode one slug against the filesystem.
 *
 * Depth-first over every directory entry whose encoded name is the next
 * stretch of the slug. `listing` memoises readdir for the whole scan (383
 * slugs share most of their prefixes). Returns `{ state, path, candidates,
 * nearest }`: `nearest` is the deepest real directory any candidate reached,
 * which is what the UI shows for a slug that resolves nowhere.
 */
export function decodeSlug(slug, listing = new Map()) {
  const matches = [];
  let inaccessible = false;
  let nearest = '/';

  const list = (dir) => {
    if (listing.has(dir)) return listing.get(dir);
    let out;
    try { out = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { out = { error: e.code || 'EIO' }; }
    listing.set(dir, out);
    return out;
  };
  const isDirEntry = (dir, d) => {
    if (d.isDirectory()) return true;
    if (!d.isSymbolicLink()) return false;
    try { return fs.statSync(path.join(dir, d.name)).isDirectory(); } catch { return false; }
  };

  const walk = (dir, rest) => {
    if (matches.length >= MAX_MATCHES) return;
    if (dir.length > nearest.length) nearest = dir;
    const ents = list(dir);
    if (!Array.isArray(ents)) {
      if (ents.error === 'EACCES' || ents.error === 'EPERM') inaccessible = true;
      return;
    }
    for (const d of ents) {
      for (const form of componentForms(d.name)) {
        const token = `-${form}`;
        if (rest !== token && !rest.startsWith(token + '-')) continue;
        if (!isDirEntry(dir, d)) continue;
        const next = path.join(dir, d.name);
        if (rest === token) { if (!matches.includes(next)) matches.push(next); }
        else walk(next, rest.slice(token.length));
      }
    }
  };
  if (slug.startsWith('-')) walk('/', slug);

  // A slug under /Volumes whose volume is absent is unmounted, not missing.
  if (!matches.length && !inaccessible) {
    const vol = /^-Volumes-/.test(slug);
    if (vol && nearest === '/Volumes') inaccessible = true;
  }
  if (matches.length > 1) return { state: 'ambiguous', path: null, candidates: matches.sort(), nearest };
  if (matches.length === 1) return { state: 'found', path: matches[0], candidates: matches, nearest: matches[0] };
  return { state: inaccessible ? 'inaccessible' : 'missing', path: null, candidates: [], nearest };
}

/* ── frontmatter ──────────────────────────────────────────────────────── */

const unquote = (v) => {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) return t.slice(1, -1);
  return t;
};

/**
 * Both formats the harness has written: the older flat one (`type:` at the
 * top) and the current one with a nested `metadata:` block holding `type`,
 * `modified` and `originSessionId`. Null when there is no frontmatter.
 */
export function parseMemoryFrontmatter(raw) {
  if (!raw.startsWith('---')) return null;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return null;
  const top = {};
  const meta = {};
  let nested = false, inMeta = false, key = null, target = top;
  for (const line of raw.slice(3, end).split('\n')) {
    let m;
    if ((m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line))) {
      key = m[1];
      if (key === 'metadata' && !m[2].trim()) { inMeta = true; nested = true; continue; }
      inMeta = false;
      top[key] = unquote(m[2]);
      target = top;
      continue;
    }
    if (inMeta && (m = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line))) {
      key = m[1];
      meta[key] = unquote(m[2]);
      target = meta;
      continue;
    }
    if (key && line.trim()) target[key] += ' ' + line.trim();
  }
  return {
    format: nested ? 'nested' : 'flat',
    name: top.name ?? null,
    description: top.description ?? null,
    type: meta.type ?? top.type ?? null,
    modified: meta.modified ?? top.modified ?? null,
  };
}

/**
 * When a fact was last modified: the frontmatter date when it is a real,
 * non-future date, else the file's mtime — with the reason flagged, since a
 * date in the future is a sign something wrote nonsense.
 */
export function modifiedOf(fm, mtimeMs, now = Date.now()) {
  if (fm?.modified) {
    const t = Date.parse(fm.modified);
    if (Number.isNaN(t)) return { at: mtimeMs, source: 'mtime', flag: 'unparseable' };
    if (t > now + 60_000) return { at: mtimeMs, source: 'mtime', flag: 'future' };
    return { at: t, source: 'frontmatter', flag: null };
  }
  return { at: mtimeMs, source: 'mtime', flag: null };
}

/* ── index links ──────────────────────────────────────────────────────── */

const LINK_RE = /\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^()\s]+)(?:\s+"[^"\n]*")?\s*\)/g;

/** The memory-relative file a link target names, or null when it is not a local file. */
export function localTarget(target) {
  let t = target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target;
  if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('#') || t.startsWith('/')) return null;
  t = t.replace(/[#?].*$/, '');
  try { t = decodeURI(t); } catch { /* keep it raw */ }
  const n = path.posix.normalize(t);
  if (!n || n === '.' || n.startsWith('../') || n === '..') return null;
  return n;
}

/**
 * Every markdown link in an index, with byte-exact positions. Links inside
 * fenced code are not links. Image links (`![…](…)`) are skipped.
 */
export function parseLinks(text) {
  const links = [];
  const fences = [];
  const fenceRe = /^[ \t]*(```|~~~)/gm;
  let open = null, m;
  while ((m = fenceRe.exec(text))) {
    if (open === null) open = m.index;
    else { fences.push([open, m.index]); open = null; }
  }
  if (open !== null) fences.push([open, text.length]);
  const inFence = (i) => fences.some(([a, b]) => i >= a && i < b);

  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text))) {
    if (m.index > 0 && text[m.index - 1] === '!') continue;
    if (inFence(m.index)) continue;
    const start = m.index, end = m.index + m[0].length;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const nl = text.indexOf('\n', end);
    const open = start + 1 + m[1].length + 2;
    const targetStart = open + /^\s*/.exec(text.slice(open, end))[0].length;
    links.push({
      start, end, label: m[1], target: m[2], rel: localTarget(m[2]),
      targetStart, targetEnd: targetStart + m[2].length,
      lineStart, lineEnd: nl === -1 ? text.length : nl,
      line: text.slice(0, start).split('\n').length,
    });
  }
  return links;
}

// What sits between two links in a list of them: `a · b`, `a, b`, `a | b`.
const SEP = /^\s*[·•,;|]\s*$/;
const BULLET = /^(\s*(?:[-*+]|\d+[.)])\s+)/;

/**
 * Apply link-level edits to an index and return the new text.
 *
 * `edits` are `{ start, action: 'remove' | 'retarget', to }`, keyed by the
 * link's start offset in `text` as parseLinks reports it. The contract is that
 * nothing but the named links changes:
 *
 *  - a link in a run of links (`[a](a) · [b](b) · [c](c)`) goes with exactly
 *    one of its separators, so the rest of the run and every other byte on
 *    the line are untouched — however many of the run's links are removed at
 *    once, each surviving link keeps the separator it originally had;
 *  - a lone link (`- [Title](f.md) — hook`, or one inside prose) loses its
 *    markdown and keeps its words, so the prose after it survives;
 *  - a bullet left with nothing but its marker, removed links and
 *    punctuation goes whole.
 *
 * `retarget` rewrites only the target inside the parentheses.
 */
export function editLinks(text, edits) {
  const all = parseLinks(text);
  const byStart = new Map(all.map((l) => [l.start, l]));
  const want = new Map();
  for (const e of edits) {
    if (!byStart.has(e.start)) throw Object.assign(new Error(`no link at offset ${e.start}`), { status: 409 });
    want.set(e.start, e);
  }
  const lines = new Map();
  for (const l of all) {
    if (!lines.has(l.lineStart)) lines.set(l.lineStart, []);
    lines.get(l.lineStart).push(l);
  }

  let out = text;
  // Last line first, so earlier offsets stay valid.
  const touched = [...new Set([...want.keys()].map((s) => byStart.get(s).lineStart))].sort((a, b) => b - a);
  for (const ls of touched) {
    const links = lines.get(ls);
    const lineStart = ls, lineEnd = links[0].lineEnd;
    const line = text.slice(lineStart, lineEnd);
    const rel = (i) => i - lineStart;
    const linkText = (l) => {
      const e = want.get(l.start);
      if (e?.action === 'retarget') {
        return text.slice(l.start, l.targetStart) + e.to + text.slice(l.targetEnd, l.end);
      }
      return text.slice(l.start, l.end);
    };
    const removed = (l) => want.get(l.start)?.action === 'remove';

    // Runs: maximal stretches of links joined only by separators.
    const runs = [];
    links.forEach((l, i) => {
      const gap = i > 0 ? line.slice(rel(links[i - 1].end), rel(l.start)) : null;
      if (i > 0 && SEP.test(gap)) runs[runs.length - 1].push(i);
      else runs.push([i]);
    });

    const bullet = BULLET.exec(line);
    // `bare` is the line with every removed link excised outright; it decides
    // whether anything but the links was on the line. `rebuilt` is what is kept.
    let rebuilt = line.slice(0, rel(links[0].start));
    let bare = rebuilt;
    const both = (t) => { rebuilt += t; bare += t; };
    runs.forEach((run, r) => {
      if (run.length === 1) {
        const l = links[run[0]];
        if (removed(l)) rebuilt += l.label;
        else both(linkText(l));
      } else {
        const kept = run.filter((i) => !removed(links[i]));
        kept.forEach((i, k) => {
          if (k > 0) both(line.slice(rel(links[i - 1].end), rel(links[i].start)));
          both(linkText(links[i]));
        });
      }
      const lastOfRun = links[run[run.length - 1]];
      const nextRun = runs[r + 1];
      both(nextRun
        ? line.slice(rel(lastOfRun.end), rel(links[nextRun[0]].start))
        : line.slice(rel(lastOfRun.end)));
    });

    // The bullet goes only when nothing but its links and their separators
    // was on it; any prose keeps the line.
    const dropLine = links.some(removed) && Boolean(bullet) && /^[\s\p{P}\p{S}]*$/u.test(bare.slice(bullet[1].length));

    if (dropLine) {
      // The line and its newline; the previous newline when it is the last line.
      if (lineEnd < out.length && out[lineEnd] === '\n') out = out.slice(0, lineStart) + out.slice(lineEnd + 1);
      else out = out.slice(0, Math.max(0, lineStart - 1)) + out.slice(lineEnd);
    } else {
      out = out.slice(0, lineStart) + rebuilt + out.slice(lineEnd);
    }
  }
  return out;
}

/** One index entry for a fact, built from its frontmatter. */
export function indexEntry(rel, fm) {
  const title = (fm?.name || path.posix.basename(rel, '.md')).replace(/[[\]\n]/g, ' ').trim();
  const hook = (fm?.description || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const target = rel.split('/').map(encodeURIComponent).join('/');
  return `- [${title}](${target})${hook ? ` — ${hook}` : ''}`;
}

/** The index with entries appended — a trailing newline is added first when missing. */
export function appendEntries(text, entries) {
  if (!entries.length) return text;
  const lead = text && !text.endsWith('\n') ? '\n' : '';
  return text + lead + entries.join('\n') + '\n';
}

/* ── last written ─────────────────────────────────────────────────────── */

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const CHUNK_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const SCAN_CONCURRENCY = 8;
const WRITES_CACHE_VERSION = 1;

const mightWriteMemory = (line) => line.includes('"tool_use"') && line.includes('/memory/')
  && (line.includes('"Write"') || line.includes('"Edit"') || line.includes('"MultiEdit"'));

/**
 * The completed memory writes in one transcript: `[[path, timestamp]]`.
 *
 * A tool_use is only an ATTEMPT. It becomes evidence when a tool_result with
 * its id arrives and is not an error; one with no result (an interrupted
 * session) or an error result is dropped. A partial last line is tolerated —
 * a live session is appending to it.
 */
async function scanTranscript(abs) {
  const fh = await fsp.open(abs, 'r');
  try {
    const before = await fh.stat();
    const pending = new Map();
    const writes = [];
    const decoder = new StringDecoder('utf8');
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let carry = '', dropping = false, pos = 0;

    const onLine = (line) => {
      if (mightWriteMemory(line)) {
        let rec;
        try { rec = JSON.parse(line); } catch { return; }
        if (rec?.type !== 'assistant' || !Array.isArray(rec.message?.content)) return;
        for (const b of rec.message.content) {
          if (b?.type !== 'tool_use' || !WRITE_TOOLS.has(b.name) || typeof b.id !== 'string') continue;
          const fp = b.input?.file_path;
          if (typeof fp === 'string' && fp.includes('/memory/')) {
            pending.set(b.id, [fp, typeof rec.timestamp === 'string' ? rec.timestamp : null]);
          }
        }
        return;
      }
      if (!pending.size || !line.includes('"tool_result"')) return;
      let hit = false;
      for (const id of pending.keys()) if (line.includes(id)) { hit = true; break; }
      if (!hit) return;
      let rec;
      try { rec = JSON.parse(line); } catch { return; }
      if (!Array.isArray(rec?.message?.content)) return;
      for (const b of rec.message.content) {
        if (b?.type !== 'tool_result' || !pending.has(b.tool_use_id)) continue;
        if (b.is_error !== true) writes.push(pending.get(b.tool_use_id));
        pending.delete(b.tool_use_id);
      }
    };

    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK_BYTES, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      carry += decoder.write(buf.subarray(0, bytesRead));
      let nl;
      while ((nl = carry.indexOf('\n')) !== -1) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (dropping) { dropping = false; continue; }
        onLine(line);
      }
      if (carry.length > MAX_LINE_BYTES) { carry = ''; dropping = true; }
    }
    carry += decoder.end();
    if (carry && !dropping) onLine(carry);

    const after = await fh.stat();
    return {
      writes,
      bytes: pos,
      stamp: { size: after.size, mtimeMs: after.mtimeMs, ino: after.ino },
      volatile: after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino,
    };
  } finally {
    await fh.close();
  }
}

/** Every session transcript and subagent transcript, relative to the projects dir. */
function listTranscripts(root) {
  const out = [];
  const walk = (dir, rel, depth) => {
    if (depth > 4) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (d.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (depth > 0 && (d.name === 'memory' || d.name === 'tool-results')) continue;
        walk(path.join(dir, d.name), r, depth + 1);
      } else if (d.isFile() && d.name.endsWith('.jsonl') && depth > 0) out.push(r);
    }
  };
  walk(root, '', 0);
  return out.sort();
}

function loadWritesCache(file, root) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw?.version === WRITES_CACHE_VERSION && raw.root === root && raw.files) return raw.files;
  } catch {}
  return {};
}

function saveWritesCache(file, root, files) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: WRITES_CACHE_VERSION, root, files }));
    fs.renameSync(tmp, file);
  } catch { /* a cache that cannot be written costs a rescan, not a failure */ }
}

async function pool(items, limit, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  }));
}

const inflight = new Map();

/**
 * Completed memory writes across every transcript, as `path -> { last, count }`.
 *
 * Cached per transcript by size, mtime and inode, so a view open costs a
 * listing and a stat of each file; a new transcript is found by the listing.
 * One scan runs at a time per root and concurrent callers share it. The scan
 * is streamed and asynchronous, so the server keeps answering while it runs;
 * its duration and peak RSS are part of the result.
 */
export function scanMemoryWrites(opts = {}) {
  const root = opts.root ?? PROJECTS_DIR;
  if (inflight.has(root)) return inflight.get(root);
  const run = doScan({ ...opts, root }).finally(() => inflight.delete(root));
  inflight.set(root, run);
  return run;
}

async function doScan({ root, cacheFile = WRITES_CACHE_FILE, cache = true }) {
  const started = Date.now();
  let peakRss = process.memoryUsage.rss();
  const rels = listTranscripts(root);
  const prev = cache ? loadWritesCache(cacheFile, root) : {};
  const next = Object.create(null);
  const volatileWrites = [];
  let scanned = 0, reused = 0, bytes = 0, volatileFiles = 0;

  await pool(rels, SCAN_CONCURRENCY, async (rel) => {
    const abs = path.join(root, rel);
    const cached = prev[rel];
    if (cached) {
      let st;
      try { st = await fsp.stat(abs); } catch { return; }
      if (st.size === cached.size && st.mtimeMs === cached.mtimeMs && st.ino === cached.ino) {
        next[rel] = cached; reused++; return;
      }
    }
    let r;
    try { r = await scanTranscript(abs); } catch { return; }
    scanned++;
    bytes += r.bytes;
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
    if (r.volatile) { volatileFiles++; volatileWrites.push(...r.writes); }
    else next[rel] = { ...r.stamp, writes: r.writes };
  });

  const byPath = new Map();
  const tally = ([p, at]) => {
    const cur = byPath.get(p) || { last: null, count: 0 };
    cur.count++;
    if (at && (!cur.last || at > cur.last)) cur.last = at;
    byPath.set(p, cur);
  };
  for (const rel of Object.keys(next)) for (const w of next[rel].writes) tally(w);
  for (const w of volatileWrites) tally(w);
  if (cache) saveWritesCache(cacheFile, root, next);

  return {
    byPath,
    stats: {
      transcripts: rels.length, scanned, reused, volatileFiles, bytesRead: bytes,
      ms: Date.now() - started, peakRss, at: new Date().toISOString(),
    },
  };
}

/* ── discovery ────────────────────────────────────────────────────────── */

const lstatOr = (abs) => { try { return fs.lstatSync(abs); } catch { return null; } };

/**
 * A memory directory's contents, read without following a single link.
 * `excluded` names what was refused and why (a symlink, a protected name, a
 * non-file), because a silently skipped file is a lie about the inventory.
 */
function readMemoryDir(memDir) {
  const files = [];
  const excluded = [];
  const walk = (relDir, depth) => {
    if (depth > 4) { excluded.push({ rel: relDir, reason: 'too deep' }); return; }
    let ents;
    try { ents = fs.readdirSync(relDir ? path.join(memDir, relDir) : memDir, { withFileTypes: true }); }
    catch (e) { excluded.push({ rel: relDir || '.', reason: `unreadable (${e.code || e.message})` }); return; }
    for (const d of ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const rel = relDir ? `${relDir}/${d.name}` : d.name;
      const abs = path.join(memDir, rel);
      if (d.isSymbolicLink()) { excluded.push({ rel, reason: 'symlink' }); continue; }
      if (isDenied(abs)) { excluded.push({ rel, reason: 'protected' }); continue; }
      if (d.isDirectory()) { walk(rel, depth + 1); continue; }
      if (!d.isFile()) { excluded.push({ rel, reason: 'not a regular file' }); continue; }
      if (!d.name.endsWith('.md')) continue;
      let buf;
      try { buf = readInSkill(memDir, rel); }
      catch (e) { excluded.push({ rel, reason: e.message }); continue; }
      const st = lstatOr(abs);
      files.push({ rel, abs, buf, size: buf.length, mtimeMs: st ? st.mtimeMs : 0 });
    }
  };
  walk('', 0);
  return { files, excluded };
}

/** Counts for the other harnesses' memory, read-only, with no spawn. */
async function otherStores() {
  const codexDb = path.join(CODEX_HOME, 'memories_1.sqlite');
  const codex = { store: tilde(codexDb), count: null, unit: 'memory rows', note: null };
  if (!fs.existsSync(codexDb)) codex.note = 'not present';
  else {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      // immutable=1: no lock, no journal, no -wal/-shm created beside a live database.
      const db = new DatabaseSync(`file:${codexDb}?immutable=1`, { readOnly: true });
      try { codex.count = db.prepare('SELECT count(*) AS n FROM stage1_outputs').get().n; }
      finally { db.close(); }
    } catch (e) { codex.note = `count could not be read (${e.message})`; }
  }

  // Grok keeps each observation as its own file; the sqlite beside them holds
  // bookkeeping, not memories, so the files are what is counted.
  const grokRoot = path.join(GROK_HOME, 'memory-v2');
  const grok = { store: tilde(grokRoot), count: null, scopes: 0, unit: 'observations', note: null };
  if (!fs.existsSync(grokRoot)) grok.note = 'not present';
  else {
    const scopes = [path.join(grokRoot, 'global')];
    try { for (const w of fs.readdirSync(path.join(grokRoot, 'workspaces'))) scopes.push(path.join(grokRoot, 'workspaces', w)); } catch {}
    let count = 0, withAny = 0;
    const countMd = (dir, depth) => {
      let n = 0;
      if (depth > 4) return 0;
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
      for (const d of ents) {
        if (d.isSymbolicLink()) continue;
        if (d.isDirectory()) n += countMd(path.join(dir, d.name), depth + 1);
        else if (d.isFile() && d.name.endsWith('.md')) n++;
      }
      return n;
    };
    for (const s of scopes) {
      const n = countMd(path.join(s, 'observations'), 0);
      count += n;
      if (n) withAny++;
    }
    grok.count = count;
    grok.scopes = withAny;
  }
  return { codex, grok };
}

/**
 * The whole inventory. Internal: rows carry absolute paths and file bytes;
 * lib/memory-ops.js strips both and mints ids before anything reaches HTTP.
 */
export async function discoverMemory({ writes = null, now = Date.now() } = {}) {
  const writeScan = writes ?? await scanMemoryWrites();
  const listing = new Map();
  const slugs = [];
  let names = [];
  try { names = fs.readdirSync(PROJECTS_DIR).sort(); } catch {}

  for (const slug of names) {
    const abs = path.join(PROJECTS_DIR, slug);
    const st = lstatOr(abs);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) continue;
    let entries = [];
    try { entries = fs.readdirSync(abs); } catch {}
    const probe = isTempProbe(slug);
    const dec = probe ? { state: 'temp-probe', path: null, candidates: [], nearest: null } : decodeSlug(slug, listing);
    let state = dec.state;
    let repo = null;
    if (state === 'found') {
      repo = repoOf(dec.path);
      state = repo ? 'resolved' : 'non-git';
    }

    const memAbs = path.join(abs, 'memory');
    const mst = lstatOr(memAbs);
    const memory = { abs: memAbs, kind: !mst ? 'absent' : mst.isSymbolicLink() ? 'symlink' : mst.isDirectory() ? 'dir' : 'other', files: [], excluded: [], index: null };
    if (memory.kind === 'dir') {
      let real = memAbs;
      try { real = fs.realpathSync(memAbs); } catch {}
      if (real !== memAbs) memory.kind = 'symlink';
      else Object.assign(memory, readMemoryDir(memAbs));
    }
    let memEntries = null;
    if (memory.kind === 'dir') { try { memEntries = fs.readdirSync(memAbs); } catch {} }

    slugs.push({
      slug, abs, state, probe, path: dec.path, candidates: dec.candidates, nearest: dec.nearest, repo,
      entries, memory,
      // Nothing but an empty memory/ — the only slug shape offered for deletion.
      trulyEmpty: entries.length === 1 && entries[0] === 'memory' && memory.kind === 'dir'
        && Array.isArray(memEntries) && memEntries.length === 0,
    });
  }

  // Groups: every resolved slug by common dir, everything else on its own.
  const groups = new Map();
  for (const s of slugs) {
    const key = s.state === 'resolved' ? `repo:${s.repo.commonDir}` : `slug:${s.slug}`;
    if (!groups.has(key)) {
      const label = s.state === 'resolved'
        ? path.basename(mainCheckoutOf(s.repo.commonDir))
        : s.path ? path.basename(s.path) : homeRelative(s.slug);
      groups.set(key, {
        key, label, state: s.state === 'resolved' ? 'resolved' : s.state,
        root: s.state === 'resolved' ? mainCheckoutOf(s.repo.commonDir) : s.path,
        slugs: [], rows: [], indexes: [], probe: s.probe,
      });
    }
    const g = groups.get(key);
    g.slugs.push(s);
    s.groupKey = key;
  }

  const rows = [];
  const indexes = [];
  for (const s of slugs) {
    if (s.memory.kind !== 'dir') continue;
    const g = groups.get(s.groupKey);
    const memDir = s.memory.abs;
    const indexFile = s.memory.files.find((f) => f.rel === INDEX_NAME);
    let index = null;
    if (indexFile) {
      const text = indexFile.buf.toString('utf8');
      const links = parseLinks(text);
      for (const l of links) {
        l.exists = l.rel ? Boolean(lstatOr(path.join(memDir, l.rel))) : null;
        const inArchive = l.rel ? path.posix.join(ARCHIVE_DIR, path.posix.basename(l.rel)) : null;
        l.archiveRel = l.rel && !l.exists && !l.rel.startsWith(ARCHIVE_DIR + '/') && lstatOr(path.join(memDir, inArchive))?.isFile()
          ? inArchive : null;
      }
      index = {
        slug: s.slug, abs: indexFile.abs, memDir, text, sha256: sha256(indexFile.buf),
        lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0), links,
      };
      indexes.push(index);
      g.indexes.push(index);
    }
    s.memory.index = index;
    const indexed = new Set(index ? index.links.filter((l) => l.rel).map((l) => l.rel) : []);

    for (const f of s.memory.files) {
      if (path.posix.basename(f.rel) === INDEX_NAME) continue;
      const text = f.buf.toString('utf8');
      const fm = parseMemoryFrontmatter(text);
      const mod = modifiedOf(fm, f.mtimeMs, now);
      const w = writeScan.byPath.get(f.abs) || null;
      const row = {
        slug: s.slug, groupKey: s.groupKey, memDir, rel: f.rel, abs: f.abs,
        archived: f.rel.startsWith(ARCHIVE_DIR + '/'),
        name: fm?.name || path.posix.basename(f.rel, '.md'),
        description: fm?.description || '',
        type: fm?.type || null,
        format: fm ? fm.format : 'none',
        fm,
        modified: mod.at, modifiedSource: mod.source, modifiedFlag: mod.flag,
        mtimeMs: f.mtimeMs, size: f.size, sha256: sha256(f.buf),
        lastWrite: w?.last ?? null, writeCount: w?.count ?? 0,
        indexed: indexed.has(f.rel),
      };
      rows.push(row);
      g.rows.push(row);
    }
  }

  const findings = buildFindings({ slugs, rows, indexes });
  return {
    slugs, groups: [...groups.values()], rows, indexes, findings,
    scan: writeScan.stats, other: await otherStores(), now,
  };
}

function buildFindings({ slugs, rows, indexes }) {
  const emptySlugs = slugs.filter((s) => s.trulyEmpty).map((s) => ({ slug: s.slug, abs: s.abs, probe: s.probe, state: s.state }));

  const dangling = [];
  for (const ix of indexes) {
    for (const l of ix.links) {
      if (!l.rel || l.exists) continue;
      dangling.push({
        slug: ix.slug, indexAbs: ix.abs, start: l.start, target: l.target, rel: l.rel, label: l.label,
        line: l.line, lineText: ix.text.slice(l.lineStart, l.lineEnd), archiveRel: l.archiveRel,
      });
    }
  }

  const unindexed = rows.filter((r) => !r.archived && !r.indexed)
    .map((r) => ({ slug: r.slug, rel: r.rel, abs: r.abs, hasIndex: indexes.some((ix) => ix.slug === r.slug) }));

  const oversized = indexes.filter((ix) => ix.lines > OVERSIZED_INDEX_LINES).map((ix) => ({ slug: ix.slug, lines: ix.lines }));

  // Orphans: memory whose project could not be found. The state travels with
  // it, because "missing" and "could not look" are different claims.
  const resolvedWithBase = slugs.filter((s) => s.path && (s.state === 'resolved' || s.state === 'non-git'));
  const orphans = [];
  for (const s of slugs) {
    if (!['missing', 'ambiguous', 'inaccessible'].includes(s.state)) continue;
    if (!s.memory.files.some((f) => path.posix.basename(f.rel) !== INDEX_NAME)) continue;
    const counterparts = [...new Set(resolvedWithBase
      .filter((c) => c.slug !== s.slug && s.slug.endsWith('-' + encodeSlug(path.basename(c.path))))
      .map((c) => c.groupKey))];
    orphans.push({ slug: s.slug, state: s.state, nearest: s.nearest, candidates: s.candidates, groupKey: s.groupKey, counterparts });
  }

  // Duplicates: one fact name in more than one memory directory.
  const byName = new Map();
  for (const r of rows) {
    if (r.archived) continue;
    const k = r.name.trim().toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
  }
  const duplicates = [...byName.entries()]
    .filter(([, rs]) => new Set(rs.map((r) => r.memDir)).size > 1)
    .map(([name, rs]) => ({ name, rows: rs }));

  return { emptySlugs, dangling, unindexed, oversized, orphans, duplicates };
}
