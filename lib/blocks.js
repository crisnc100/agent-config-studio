import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDenied, readUserText, tilde } from './paths.js';
import { sha256 } from './proposals.js';
import { globalInstructionFiles, skillsDirs } from './registry.js';

/**
 * Building blocks: shared rule text kept once in blocks/<id>.md and carried
 * as copies inside skills and instruction files. Read-only — this finds the copies and rates each
 * against its block; nothing here writes.
 *
 * A marked copy sits between marker lines, the shape of the model-guide block:
 *
 *   <!-- block:<id> sha256:<hex of the body as pasted> -->
 *   …body…
 *   <!-- /block:<id> -->
 *
 * An unmarked copy is found by close match: the file is cut into paragraphs
 * and list items, each is scored against the block's own paragraphs and list
 * items, and a run of neighbours that each match one of them is one copy.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BLOCKS_DIR = path.join(ROOT, 'blocks');
const PACKS_DIR = path.join(ROOT, 'packs');

/**
 * Word-pair overlap (Dice, 0–1). UNIT_MATCH decides what counts as a copy at
 * all; REWORDED splits a copy that says the same thing in other words from one
 * that says something else. CONTAINED is the share of a block, or of one of
 * its paragraphs, that must sit inside longer text to count; a paragraph needs
 * CONTAINED_MIN word pairs for that, since a short list item turns up inside
 * any long paragraph. Measured on real skills: copies with a sentence swapped
 * or added scored 0.70–0.96; copies with a rule added or cut, or the block
 * buried in a longer paragraph, 0.15–0.63.
 */
export const THRESHOLDS = Object.freeze({ UNIT_MATCH: 0.5, REWORDED: 0.7, CONTAINED: 0.9, CONTAINED_MIN: 12 });

export const BLOCK_LIMITS = Object.freeze({ fileBytes: 1024 * 1024, files: 3000 });

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const START_RE = /^<!-- block:([a-z0-9][a-z0-9-]{0,63}) sha256:([0-9a-f]{64}) -->$/;
const endLine = (id) => `<!-- /block:${id} -->`;
const GENERATED_START = /^<!-- acs:([a-z0-9-]+)\b.*-->$/;

/** The start marker for a block body (LF text ending in a newline). */
export const startMarker = (id, body) => `<!-- block:${id} sha256:${sha256(body)} -->`;

/** One block file: `name` and `summary` in frontmatter, the block text after it. */
export function parseBlock(id, raw) {
  const text = raw.replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const meta = {};
  for (const line of (m ? m[1] : '').split('\n')) {
    const kv = /^([a-z]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  const body = `${text.slice(m ? m[0].length : 0).replace(/^\n+/, '').replace(/\s+$/, '')}\n`;
  return { id, name: meta.name || id, summary: meta.summary || '', body };
}

/** Every blocks/<id>.md, sorted by name. */
export function loadBlocks(dir = BLOCKS_DIR) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md') && ID_RE.test(n.slice(0, -3))); } catch {}
  return names
    .map((n) => parseBlock(n.slice(0, -3), readUserText(path.join(dir, n), { maxBytes: BLOCK_LIMITS.fileBytes })))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ── comparing text ─────────────────────────────────────────────────── */

/** Lowercased words, with Markdown marks, list numbers and punctuation gone. */
export function words(text) {
  return text.toLowerCase()
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, ' ')
    .replace(/['’]/g, '')
    .match(/[\p{L}\p{N}]+/gu) || [];
}

function pairs(ws) {
  if (ws.length < 3) return new Set(ws);
  const out = new Set();
  for (let i = 1; i < ws.length; i++) out.add(`${ws[i - 1]} ${ws[i]}`);
  return out;
}

function dice(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const x of small) if (big.has(x)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/** How alike two texts are, 0–1, by shared word pairs. */
export const similarity = (a, b) => dice(pairs(words(a)), pairs(words(b)));

/**
 * same: the same words in the same order (spacing, line breaks and Markdown
 * marks aside); reworded: close (REWORDED or above); differs: anything else.
 */
export function rate(copy, body) {
  const a = words(copy), b = words(body);
  if (a.length === b.length && a.every((w, i) => w === b[i])) return 'same';
  return dice(pairs(a), pairs(b)) >= THRESHOLDS.REWORDED ? 'reworded' : 'differs';
}

/** The share of `inner`'s word pairs that also appear in `outer`. */
function covered(inner, outer) {
  if (!inner.size) return 0;
  let shared = 0;
  for (const x of inner) if (outer.has(x)) shared++;
  return shared / inner.size;
}

/** Whether nearly all of `body`'s word pairs appear in `copy`. */
const contains = (copy, body) => covered(pairs(words(body)), pairs(words(copy))) >= THRESHOLDS.CONTAINED;

/** Paragraphs and list items, each as { start, end } line indexes (0-based, inclusive), skipping masked lines. */
function unitsOf(lines, masked = new Set()) {
  const units = [];
  let cur = null;
  const close = () => { if (cur) units.push(cur); cur = null; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // A whole-line HTML comment (a marker, a broken marker) is never part of a copy's words.
    if (masked.has(i) || !l.trim() || /^\s*<!--.*-->\s*$/.test(l)) { close(); continue; }
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(l) || /^#{1,6}\s/.test(l)) close();
    if (!cur) cur = { start: i, end: i };
    else cur.end = i;
    if (/^#{1,6}\s/.test(l)) close();
  }
  close();
  return units;
}

const textOf = (lines, u) => lines.slice(u.start, u.end + 1).join('\n');

/** A block's own units as word-pair sets, computed once per scan. */
function prepare(blocks) {
  return blocks.map((b) => {
    const lines = b.body.replace(/\n$/, '').split('\n');
    return { block: b, units: unitsOf(lines).map((u) => pairs(words(textOf(lines, u)))) };
  });
}

/**
 * The copies of `blocks` in one file's text: [{ id, line, endLine, rating,
 * marked, note }], lines 1-based. A marked copy covers its markers; a marker
 * without its end is ignored and its text scanned like any other.
 */
export function scanText(text, blocks, prepared = prepare(blocks)) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const copies = [];
  const masked = new Set();
  // A block the studio generates (the model guide) is its own text, never a copy.
  for (let i = 0; i < lines.length; i++) {
    const g = GENERATED_START.exec(lines[i].trim());
    if (!g) continue;
    const end = lines.findIndex((l, j) => j > i && l.trim() === `<!-- /acs:${g[1]} -->`);
    if (end === -1) continue;
    for (let j = i; j <= end; j++) masked.add(j);
    i = end;
  }
  for (let i = 0; i < lines.length; i++) {
    if (masked.has(i)) continue;
    const m = START_RE.exec(lines[i].trim());
    if (!m || !byId.has(m[1])) continue;
    const end = lines.findIndex((l, j) => j > i && l.trim() === endLine(m[1]));
    if (end === -1) continue;
    const inner = lines.slice(i + 1, end);
    const found = inner.length ? `${inner.join('\n')}\n` : '';
    const block = byId.get(m[1]);
    const rating = found === block.body ? 'same' : rate(found, block.body);
    // Which side moved: the copy was edited after it was pasted, or the block changed since.
    const note = rating === 'same' ? null
      : sha256(found) !== m[2] ? 'edited after it was added'
        : 'an older version of the block';
    copies.push({ id: m[1], line: i + 1, endLine: end + 1, rating, marked: true, note });
    for (let j = i; j <= end; j++) masked.add(j);
    i = end;
  }
  const units = unitsOf(lines, masked).map((u) => ({ ...u, set: pairs(words(textOf(lines, u))) }));
  for (const { block, units: own } of prepared) {
    let run = null;
    const flush = () => {
      if (!run) return;
      const copy = lines.slice(run.start, run.end + 1).join('\n');
      const rating = rate(copy, block.body);
      const inside = rating === 'differs' && contains(copy, block.body);
      copies.push({ id: block.id, line: run.start + 1, endLine: run.end + 1, rating, marked: false, note: inside ? 'the whole block is there, with more added' : null });
      run = null;
    };
    for (const u of units) {
      const hit = own.some((s) => dice(s, u.set) >= THRESHOLDS.UNIT_MATCH
        || (s.size >= THRESHOLDS.CONTAINED_MIN && covered(s, u.set) >= THRESHOLDS.CONTAINED));
      if (!hit) { flush(); continue; }
      if (run) run.end = u.end; else run = { start: u.start, end: u.end };
    }
    flush();
  }
  return copies.sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));
}

/* ── where copies live ──────────────────────────────────────────────── */

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const entries = (dir) => { try { return fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort(); } catch { return []; } };

/** A skill folder's .md files: its own and one folder down, as the registry lists them. */
function skillFiles(dir) {
  const out = [];
  for (const n of entries(dir)) {
    const p = path.join(dir, n);
    if (n.endsWith('.md') && isFile(p)) out.push(p);
    else if (isDir(p)) for (const m of entries(p)) if (m.endsWith('.md') && isFile(path.join(p, m))) out.push(path.join(p, m));
  }
  return out;
}

/** Every .md file under a pack's skills/ and instructions/ (its tests are not copies). */
function packFiles(packsDir) {
  const out = [];
  const walk = (dir, depth) => {
    for (const n of entries(dir)) {
      const p = path.join(dir, n);
      if (isDir(p)) { if (depth < 6) walk(p, depth + 1); } else if (n.endsWith('.md') && isFile(p)) out.push(p);
    }
  };
  for (const pack of entries(packsDir)) for (const part of ['skills', 'instructions']) walk(path.join(packsDir, pack, part), 0);
  return out;
}

/**
 * The files that may carry copies: each CLI's global instruction file, every
 * skill folder the studio lists for each CLI, and this checkout's packs. Each
 * real file once, with where it was found (`source`) and whether it is an
 * instruction file or part of a skill (`kind`).
 */
export function sourceFiles({ dirs = skillsDirs(), packsDir = PACKS_DIR, instructions = globalInstructionFiles() } = {}) {
  const out = [];
  const seen = new Set();
  const add = (abs, display, source, kind = 'skill') => {
    if (isDenied(abs)) return;
    let real = abs;
    try { real = fs.realpathSync.native(abs); } catch {}
    if (seen.has(real)) return;
    seen.add(real);
    out.push({ abs, display, source, kind });
  };
  for (const { harness, file } of instructions) if (isFile(file)) add(file, tilde(file), harness, 'instructions');
  for (const { harness, dir } of dirs) {
    for (const skill of entries(dir)) {
      const sd = path.join(dir, skill);
      if (isDir(sd)) for (const f of skillFiles(sd)) add(f, tilde(f), harness);
    }
  }
  for (const f of packFiles(packsDir)) add(f, path.relative(path.dirname(packsDir), f).split(path.sep).join('/'), 'pack');
  return out.slice(0, BLOCK_LIMITS.files);
}

/** The page's payload: each block, its text, and every copy with file, line and rating. */
export function blocksView({ blocksDir = BLOCKS_DIR, ...where } = {}) {
  const blocks = loadBlocks(blocksDir);
  const prepared = prepare(blocks);
  const files = sourceFiles(where);
  const byBlock = new Map(blocks.map((b) => [b.id, []]));
  let read = 0;
  const unreadable = [];
  for (const f of files) {
    let text;
    try { text = readUserText(f.abs, { maxBytes: BLOCK_LIMITS.fileBytes }); }
    catch { unreadable.push(f.display); continue; }
    read++;
    for (const c of scanText(text, blocks, prepared)) {
      byBlock.get(c.id).push({ file: f.display, source: f.source, kind: f.kind, line: c.line, endLine: c.endLine, rating: c.rating, marked: c.marked, note: c.note });
    }
  }
  return {
    blocks: blocks.map((b) => {
      const copies = byBlock.get(b.id);
      const counts = { same: 0, reworded: 0, differs: 0 };
      for (const c of copies) counts[c.rating]++;
      return { id: b.id, name: b.name, summary: b.summary, text: b.body, marker: startMarker(b.id, b.body), copies, counts };
    }),
    scanned: { files: read, unreadable },
  };
}
