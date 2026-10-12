/**
 * How often a skill NAME was actually invoked, and when it was last seen.
 *
 * WHAT COUNTS. A `"skill":"x"` string match does not prove an invocation. That
 * exact text occurs in at least four places in the real corpus that are not
 * invocations: the Skill tool's own input_schema inside a `prompt_snapshot`
 * attachment, the tool_result echoed back after a skill runs, prose in a user
 * message that happens to quote it, and the separate `skill-injections.jsonl`
 * logs written by a plugin. Measured on ~/.claude/projects, the only structure
 * that marks a real invocation is an ASSISTANT message carrying a content block
 * with `type:"tool_use"`, `name:"Skill"` and a string `input.skill` — 247 of
 * them across 1392 transcripts, every one from `type:"assistant"`. So that, and
 * nothing else, is what this module counts; a tool_result carrying the same
 * text is a *consequence* of an invocation already counted at the tool_use, and
 * counting it again would double every number.
 *
 * WHAT THE NUMBER IS NOT. It is keyed by the invoked NAME, and seven different
 * `decision` skills on this machine share one name — so one count covers all
 * seven and cannot say which ran. Claude Code transcripts also say nothing
 * about Codex or Grok, and nothing about anything older than retained history.
 * "Never seen" therefore means UNKNOWN, never "unused". USAGE_CAVEAT below
 * travels with the data so a UI cannot render it as anything stronger; it is a
 * field, not a footnote, because the footnote is the part that gets dropped.
 *
 * WHAT IT COSTS. The corpus is ~1.1GB. Nothing here reads a whole file: each
 * transcript is read in 256KB chunks and split into lines, a single
 * pathological line is dropped rather than buffered without bound, and at most
 * SCAN_CONCURRENCY files are open at once. A per-file cache keyed on
 * size+mtime+inode means the second read touches only what changed, and an
 * incremental update is exactly a full scan with the unchanged files' results
 * restored — which is asserted, not assumed.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { CLAUDE_HOME, STUDIO_HOME } from './paths.js';

/** ~/.claude/projects/<slug>/<session>.jsonl, plus subagents/ and scratchpad trees below it. */
export const TRANSCRIPT_ROOT = path.join(CLAUDE_HOME, 'projects');
export const USAGE_CACHE_FILE = path.join(STUDIO_HOME, 'skill-usage-cache.json');

const CHUNK_BYTES = 256 * 1024;
// The longest real line measured in the corpus is 4.1MB (a prompt snapshot), so
// the cap is set above it: a line past this point is not a transcript record
// anyone wrote, and buffering it would be how one corrupt file eats the heap.
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const SCAN_CONCURRENCY = 8;
const SCAN_DEPTH = 8;
const CACHE_VERSION = 1;

/**
 * The limitations of this signal, in a form a UI can branch on rather than a
 * sentence it can forget to print.
 */
export const USAGE_CAVEAT = Object.freeze({
  granularity: 'name',
  harnesses: ['claude-code'],
  missingHarnesses: ['codex', 'grok'],
  boundedBy: 'retained-claude-code-transcripts',
  neverSeenMeans: 'unknown',
  evidence: 'assistant tool_use blocks named "Skill"',
  text: 'Counted by skill NAME from Claude Code transcripts only — copies sharing a name '
      + 'share one count, Codex and Grok invocations are invisible here, and history goes '
      + 'back only as far as transcripts are retained. No observations means UNKNOWN, not unused.',
});

/** A cheap pre-filter: parsing 1.1GB of JSON to find 247 blocks would be the whole cost. */
const mightInvoke = (line) => line.includes('"tool_use"') && line.includes('"Skill"');

/**
 * The invocations in one already-split line, or nothing.
 *
 * Deliberately strict about `type === 'assistant'`: a user message can carry a
 * content array too, and an echoed tool_use block inside one is input, not an
 * invocation this machine made.
 */
function invocationsIn(line) {
  let rec;
  try { rec = JSON.parse(line); } catch { return null; }
  if (!rec || rec.type !== 'assistant') return null;
  const content = rec.message && rec.message.content;
  if (!Array.isArray(content)) return null;
  let out = null;
  for (const block of content) {
    if (!block || block.type !== 'tool_use' || block.name !== 'Skill') continue;
    const skill = block.input && block.input.skill;
    if (typeof skill !== 'string' || !skill) continue;
    (out ||= []).push([skill, typeof rec.timestamp === 'string' ? rec.timestamp : null, block.id || null]);
  }
  return out;
}

/**
 * Read one transcript line-wise and return its invocations plus the identity of
 * the bytes they came from.
 *
 * The stat is taken before and after: a file appended to WHILE we read it would
 * otherwise be cached under a fingerprint that never matches what we actually
 * saw, and the next incremental run would disagree with a full scan. `volatile`
 * says "do not cache this one", which keeps that disagreement impossible rather
 * than unlikely.
 */
async function scanFile(abs) {
  const fh = await fsp.open(abs, 'r');
  try {
    const before = await fh.stat();
    const hits = [];
    const decoder = new StringDecoder('utf8');
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let carry = '';
    let dropping = false;
    let lines = 0;
    let skippedLines = 0;
    let pos = 0;

    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK_BYTES, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      carry += decoder.write(buf.subarray(0, bytesRead));

      let nl;
      while ((nl = carry.indexOf('\n')) !== -1) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (dropping) { dropping = false; skippedLines++; continue; }
        lines++;
        if (mightInvoke(line)) { const found = invocationsIn(line); if (found) hits.push(...found); }
      }
      // No newline in sight and the buffer is already absurd: throw away
      // everything up to the next newline instead of growing without bound.
      if (carry.length > MAX_LINE_BYTES) { carry = ''; dropping = true; }
    }
    carry += decoder.end();
    if (carry) {
      if (dropping) skippedLines++;
      else { lines++; if (mightInvoke(carry)) { const found = invocationsIn(carry); if (found) hits.push(...found); } }
    }

    const after = await fh.stat();
    const volatileFile = after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ino !== before.ino;

    return {
      hits,
      lines,
      skippedLines,
      bytes: pos,
      stamp: { size: after.size, mtimeMs: after.mtimeMs, ino: after.ino },
      volatile: volatileFile,
    };
  } finally {
    await fh.close();
  }
}

/** Every *.jsonl under the corpus, relative to its root, sorted for a stable cache. */
function listTranscripts(root) {
  const out = [];
  const walk = (dir, rel, depth) => {
    if (depth > SCAN_DEPTH) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      const abs = path.join(dir, d.name);
      const r = rel ? `${rel}/${d.name}` : d.name;
      // Never followed: the corpus is read-only input, and a link inside it
      // could point the reader at a file this feature has no business opening.
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) walk(abs, r, depth + 1);
      else if (d.isFile() && d.name.endsWith('.jsonl')) out.push(r);
    }
  };
  walk(root, '', 0);
  out.sort();
  return out;
}

function loadCache(file, root) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw.version === CACHE_VERSION && raw.root === root && raw.files) return raw.files;
  } catch {}
  return {};
}

function saveCache(file, root, files) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, root, files }));
    fs.renameSync(tmp, file);
  } catch {
    // A cache that cannot be written costs a rescan, not a failure.
  }
}

async function pool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

/**
 * The signal.
 *
 * Returns the per-name map the rest of the app consumes, plus the stats that
 * prove what it cost and the caveat that bounds what it means. `cache:false`
 * forces a full scan, which is what the equivalence test compares against.
 */
export async function readSkillUsage({
  root = TRANSCRIPT_ROOT,
  cacheFile = USAGE_CACHE_FILE,
  cache = true,
} = {}) {
  const started = Date.now();
  const rels = listTranscripts(root);
  const prev = cache ? loadCache(cacheFile, root) : {};
  const next = Object.create(null);

  let reused = 0, scanned = 0, bytes = 0, lines = 0, skippedLines = 0, volatileFiles = 0;
  // Observations from files that moved mid-read: they count towards THIS
  // answer, but they never enter `next` and so are never cached.
  const volatileHits = [];

  await pool(rels, SCAN_CONCURRENCY, async (rel) => {
    const abs = path.join(root, rel);
    const cached = prev[rel];
    if (cached) {
      // Stat only: the whole point of the cache is not opening the file.
      let st;
      try { st = await fsp.stat(abs); } catch { return; }
      if (st.size === cached.size && st.mtimeMs === cached.mtimeMs && st.ino === cached.ino) {
        next[rel] = cached;
        reused++;
        return;
      }
    }
    let r;
    try { r = await scanFile(abs); } catch { return; }
    scanned++;
    bytes += r.bytes;
    lines += r.lines;
    skippedLines += r.skippedLines;
    // A file that moved under us is used for this answer but not remembered,
    // so the next run re-reads it rather than trusting a torn fingerprint.
    if (r.volatile) { volatileFiles++; volatileHits.push(...r.hits); }
    else next[rel] = { ...r.stamp, hits: r.hits };
  });

  const byName = Object.create(null);
  const seenIds = new Set();
  let observations = 0;

  const tally = ([name, at, id]) => {
    // Defensive: a resumed session can replay a line into a second transcript.
    // None was observed in the real corpus, but a double-counted invocation is
    // exactly the kind of silent inflation this signal cannot afford.
    if (id) { if (seenIds.has(id)) return; seenIds.add(id); }
    observations++;
    const cur = byName[name] || (byName[name] = { count: 0, lastUsedAt: null });
    cur.count++;
    if (at && (!cur.lastUsedAt || at > cur.lastUsedAt)) cur.lastUsedAt = at;
  };

  for (const rel of Object.keys(next)) for (const hit of next[rel].hits) tally(hit);
  for (const hit of volatileHits) tally(hit);

  if (cache) saveCache(cacheFile, root, next);

  return {
    byName,
    caveat: USAGE_CAVEAT,
    stats: {
      root,
      files: rels.length,
      filesScanned: scanned,
      filesReused: reused,
      volatileFiles,
      bytesRead: bytes,
      linesRead: lines,
      linesSkipped: skippedLines,
      observations,
      distinctNames: Object.keys(byName).length,
      ms: Date.now() - started,
      at: new Date().toISOString(),
    },
  };
}

/**
 * Find a row's observations.
 *
 * Plugin skills are invoked as `plugin:skill` while the skill's directory is
 * named `skill`, so an exact miss falls back to summing every namespaced token
 * that ends in the row's name. That fallback is itself name-level guessing, and
 * it is reported as such via `matchedNames`.
 */
export function lookupUsage(byName, name) {
  if (typeof name !== 'string' || !name) return null;
  if (byName[name]) return { ...byName[name], matchedNames: [name] };

  const suffix = `:${name}`;
  const matched = Object.keys(byName).filter((k) => k.endsWith(suffix));
  if (!matched.length) return null;
  let count = 0, lastUsedAt = null;
  for (const k of matched) {
    count += byName[k].count;
    const at = byName[k].lastUsedAt;
    if (at && (!lastUsedAt || at > lastUsedAt)) lastUsedAt = at;
  }
  return { count, lastUsedAt, matchedNames: matched.sort() };
}

/**
 * Hang the signal off public skill rows.
 *
 * Two honesty rules are enforced here rather than left to the template:
 *   - a row with no observations gets `observed:false` and a NULL count, so a
 *     UI that renders `usage.count` prints nothing rather than "0 — unused";
 *   - rows sharing a name are marked `nameShared`, with the number of rows the
 *     single count actually covers, because that is the one distortion a reader
 *     would otherwise have no way to see.
 *
 * A skill is invoked by its frontmatter `name`, which is the row's
 * displayName; the directory name is only a fallback. They differ exactly
 * where it matters — a synced skill lives in a folder its author never named —
 * and looking up the folder alone reported "no recorded use" for a skill
 * with observations. Rows share a count when they resolve to the same key.
 */
export function attachUsage(rows, usage) {
  const byName = usage.byName || Object.create(null);
  const keyed = rows.map((r) => {
    for (const key of [r.displayName, r.name]) {
      const hit = lookupUsage(byName, key);
      if (hit) return { r, key, hit };
    }
    return { r, key: r.displayName || r.name, hit: null };
  });
  const nameCounts = new Map();
  for (const { key } of keyed) nameCounts.set(key, (nameCounts.get(key) || 0) + 1);

  return keyed.map(({ r, key, hit }) => {
    const shares = nameCounts.get(key) || 1;
    return {
      ...r,
      usage: {
        observed: Boolean(hit),
        count: hit ? hit.count : null,
        lastUsedAt: hit ? hit.lastUsedAt : null,
        matchedNames: hit ? hit.matchedNames : [],
        nameShared: shares > 1,
        nameSharedWith: shares,
        caveat: USAGE_CAVEAT.text,
      },
    };
  });
}
