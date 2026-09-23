/**
 * Skill discovery.
 *
 * A skill is a directory holding a SKILL.md, plus whatever companion files sit
 * beside it. This module finds every one on the machine, labels it by where it
 * came from, collapses the copies, and hands back rows that carry an opaque id
 * instead of a path.
 *
 * The containment rule is the point of this file. "Inside an allowed root" is
 * far too weak a boundary for a bundle: ~/Documents/Projects is an allowed
 * root, so a companion symlink named `notes.md` pointing at a sibling project's
 * .env satisfies it perfectly and gets read, hashed and — later — exported. A
 * file therefore belongs to a skill ONLY if it resolves inside that skill's own
 * directory, and any symlink inside a skill folder is refused outright rather
 * than resolved, because resolve-then-open leaves a window in which the target
 * can be swapped. The one exception is a skill directory that is ITSELF a
 * symlink, which is how ~/.claude/skills/find-skills is meant to work; that is
 * resolved once, at the root, and the resolved directory becomes the boundary.
 *
 * Every read goes through readInSkill(). Not only the export — discovery reads
 * frontmatter and hashing reads contents, both long before anyone clicks
 * download, so a rule enforced only at export time would be no rule at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { ZIP_LIMITS } from './zip.js';
import {
  CLAUDE_HOME, CODEX_HOME, AGENTS_HOME, PROJECTS, GARMAN_HOME,
  SKILL_ROOTS, isDenied, resolveSafe,
} from './paths.js';

/**
 * The roots, in the order a duplicate group picks its canonical row: a global
 * skill wins over a project copy, which wins over a Garman-Homes worktree copy.
 * `nested` marks the trees that are ordinary project checkouts rather than
 * skills directories, so they are searched for `.claude/skills` first.
 */
const SOURCES = [
  { source: 'global-claude', root: path.join(CLAUDE_HOME, 'skills'), nested: false },
  { source: 'global-codex', root: path.join(CODEX_HOME, 'skills'), nested: false },
  { source: 'global-agents', root: path.join(AGENTS_HOME, 'skills'), nested: false },
  { source: 'project', root: PROJECTS, nested: true },
  { source: 'garman-homes', root: GARMAN_HOME, nested: true },
];

/** Harness config directories whose `skills/` subdirectory holds project skills. */
const HARNESS_DIRS = new Set(['.claude', '.codex', '.agents']);

// ~/.claude/skills/synced/<uuid>/<name>/SKILL.md already sits 4 deep, so the
// limit exists to stop a pathological tree, not to encode an expected shape.
const SKILL_SCAN_DEPTH = 8;
const PROJECT_SCAN_DEPTH = 6;
// Deep enough for any real bundle (none on this machine passes 8); a bundle
// deeper than this is refused whole rather than exported with a hole in it.
const BUNDLE_DEPTH = 32;

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BUNDLE_BYTES = ZIP_LIMITS.maxBundleBytes;

const refuse = (msg) => Object.assign(new Error(msg), { status: 403, contained: true });
const tooLarge = (msg) => Object.assign(new Error(msg), { status: 413, contained: true });

/** The per-file and per-bundle caps, for callers that preflight from metadata. */
export const SKILL_LIMITS = { maxFileBytes: MAX_FILE_BYTES, maxBundleBytes: MAX_BUNDLE_BYTES };

// Directories that are tooling state, never skills or bundle content. Every
// other dot-directory is walked: ~/.codex/skills/.system holds real skills.
const SKIP_DIRS = new Set(['.git', '.hg', '.svn', '.cache', '__pycache__', 'node_modules']);

/**
 * Resolve `rel` inside `skillDir` without ever following a link.
 *
 * Walked component by component: a symlink anywhere along the way is refused
 * rather than resolved. `skillDir` must already be a real path (findSkillDirs
 * resolves the roots and the one permitted root-level link before it gets
 * here). Returns the path and the lstat of every component, so a caller can
 * walk again later and prove nothing moved.
 */
function containedPath(skillDir, rel, io = fs) {
  if (typeof rel !== 'string' || !rel) throw refuse('a relative name is required');
  if (path.isAbsolute(rel) || rel.includes('\0')) throw refuse(`refusing name: ${JSON.stringify(rel)}`);

  let cur = skillDir;
  const stats = [];
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.' || seg === '..') throw refuse(`refusing name: ${JSON.stringify(rel)}`);
    cur = path.join(cur, seg);
    let st;
    try { st = io.lstatSync(cur); }
    catch { throw Object.assign(new Error(`not in this skill: ${rel}`), { status: 404, contained: true }); }
    if (st.isSymbolicLink()) throw refuse(`symlink inside a skill folder: ${rel}`);
    stats.push(st);
  }
  if (isDenied(cur)) throw refuse(`protected path: ${rel}`);
  return { abs: cur, stats };
}

const sameInode = (a, b) => a.ino === b.ino && a.dev === b.dev;

// O_NONBLOCK so a FIFO planted in a skill cannot hang the open; it has no
// effect on a regular file. O_NOFOLLOW refuses a link in the LAST component.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
const CHUNK = 64 * 1024;

/**
 * THE shared reader. Returns the bytes of `rel` within `skillDir`, or throws.
 *
 * Containment is anchored to the DESCRIPTOR, not to a path check made before
 * it. A check-then-open reader loses to an intermediate directory swapped for
 * a link between the two: both its second stat and its open follow the link,
 * agree with each other, and read the outside file. So the order here is
 * open first, then prove what was opened:
 *
 *   1. walk without following links (a cheap early refusal, and it keeps a
 *      FIFO or a directory from ever being opened);
 *   2. open with O_NOFOLLOW;
 *   3. walk AGAIN, after the open — every component must still be a
 *      non-link, every directory the same inode as in step 1, and the leaf
 *      the very inode the descriptor holds;
 *   4. realpath the opened path: it must be itself, inside the skill, and
 *      pass the deny check (which therefore sees the real path, not the
 *      lexical one).
 *
 * A single swap at any point is caught: before step 3 it changes an inode
 * step 3 compares, after it the descriptor is already fixed.
 *
 * ACCEPTED LIMIT (Cris, 2026-09-23). A REPEATED swap still wins, and it needs
 * nothing more than write access to a subdirectory INSIDE the skill: flip
 * `sub/` to a link for the open and the two leaf stats, back to the real
 * directory for the two directory stats and the realpath, and every check
 * above agrees while the descriptor holds the outside file. Closing it needs a
 * descriptor-relative walk (openat with O_NOFOLLOW per component), and Node on
 * macOS has no openat. Whoever can rewrite a skill's own folder mid-export can
 * already put any bytes they like in that skill.
 *
 * Bytes are counted while they are read: at most min(8MB, budget) + 1 bytes
 * are ever buffered, so a file that grew after discovery is refused, not
 * slurped. `budget` is shared across a whole archive, which is what makes the
 * cap a cap on the selection rather than on each file.
 *
 * `io` exists for the swap tests: they hand in an fs whose calls mutate the
 * tree at a chosen moment. Nothing in the app passes it.
 */
export function readInSkill(skillDir, rel, { io = fs, budget = null } = {}) {
  const pre = containedPath(skillDir, rel, io);
  const abs = pre.abs;
  if (!pre.stats[pre.stats.length - 1].isFile()) throw refuse(`not a regular file: ${rel}`);

  let fd;
  try { fd = io.openSync(abs, OPEN_FLAGS); }
  catch (e) {
    if (e.code === 'ELOOP' || e.code === 'EMLINK') throw refuse(`symlink inside a skill folder: ${rel}`);
    throw Object.assign(new Error(`not in this skill: ${rel}`), { status: 404, contained: true });
  }
  try {
    const st = io.fstatSync(fd);
    if (!st.isFile()) throw refuse(`not a regular file: ${rel}`);

    const post = containedPath(skillDir, rel, io);
    if (post.abs !== abs || post.stats.length !== pre.stats.length
        || post.stats.some((s, i) => !sameInode(s, pre.stats[i]))
        || !sameInode(post.stats[post.stats.length - 1], st)) {
      throw refuse(`file changed underneath the read: ${rel}`);
    }
    let real;
    try { real = io.realpathSync(abs); } catch { throw refuse(`file changed underneath the read: ${rel}`); }
    // Deny first, on the REAL path, so a resolution that lands on a secret is
    // refused as protected whatever else is also wrong with it.
    if (isDenied(real)) throw Object.assign(refuse(`protected path: ${rel}`), { reason: 'protected' });
    if (real !== abs || !real.startsWith(skillDir + path.sep)) throw refuse(`resolves outside the skill: ${rel}`);

    const cap = Math.min(MAX_FILE_BYTES, budget ? Math.max(0, budget.remaining) : Infinity);
    const chunks = [];
    let total = 0;
    for (;;) {
      const want = Math.min(CHUNK, cap + 1 - total);
      const buf = Buffer.allocUnsafe(want);
      const n = io.readSync(fd, buf, 0, want, total);
      if (n <= 0) break;
      chunks.push(n === want ? buf : buf.subarray(0, n));
      total += n;
      if (total > cap) {
        throw tooLarge(cap === MAX_FILE_BYTES ? `file too large: ${rel}` : 'selection is larger than the size cap');
      }
    }
    if (budget) budget.remaining -= total;
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
  } finally {
    io.closeSync(fd);
  }
}

export function readTextInSkill(skillDir, rel) {
  return readInSkill(skillDir, rel).toString('utf8');
}

/**
 * Every file and empty directory that belongs to the bundle, plus the names
 * that were refused.
 *
 * `excluded` is reported rather than silently dropped: a symlink someone
 * planted, a protected name or a FIFO deserves to be visible, and none of them
 * is ever shipped. Everything else IS shipped — empty directories included,
 * since an extractor only recreates one it has a record for. A bundle deeper
 * than BUNDLE_DEPTH is not trimmed to fit: `tooDeep` names where it went over,
 * and the caller refuses the whole skill rather than export part of it.
 *
 * A directory is listed only between two no-follow walks that agree on its
 * inode, so a directory swapped for another mid-listing is refused rather
 * than enumerated.
 */
export function listSkillFiles(skillDir) {
  const files = [];
  const emptyDirs = [];
  const excluded = [];
  let tooDeep = null;

  const walk = (relDir, depth) => {
    if (tooDeep) return;
    if (depth > BUNDLE_DEPTH) { tooDeep = `${relDir}/`; return; }
    let full = skillDir;
    let pre = null;
    if (relDir) {
      ({ abs: full, stats: pre } = containedPath(skillDir, relDir));
    }
    let entries;
    try { entries = fs.readdirSync(full, { withFileTypes: true }); }
    catch { excluded.push({ rel: relDir ? `${relDir}/` : '.', reason: 'unreadable' }); return; }
    if (pre) {
      const post = containedPath(skillDir, relDir).stats;
      if (post.some((st, i) => !sameInode(st, pre[i]))) throw refuse(`directory changed during the listing: ${relDir}`);
    }
    if (relDir && entries.length === 0) {
      const st = pre[pre.length - 1];
      emptyDirs.push({ rel: `${relDir}/`, mode: st.mode & 0o7777, mtime: st.mtime });
      return;
    }
    for (const d of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const rel = relDir ? `${relDir}/${d.name}` : d.name;
      const abs = path.join(full, d.name);
      if (d.isSymbolicLink()) { excluded.push({ rel, reason: 'symlink' }); continue; }
      if (isDenied(abs)) { excluded.push({ rel, reason: 'protected' }); continue; }
      if (d.isDirectory()) { walk(rel, depth + 1); continue; }
      if (!d.isFile()) { excluded.push({ rel, reason: 'not a regular file' }); continue; }
      let st;
      try { st = fs.lstatSync(abs); } catch { excluded.push({ rel, reason: 'unreadable' }); continue; }
      // mode and mtime come from the stat that was already needed for size: the
      // export path cannot stat for itself (nothing outside readInSkill may
      // touch the filesystem), and without them scripts/run.sh extracts 0644.
      files.push({ rel, abs, size: st.size, mode: st.mode & 0o7777, mtime: st.mtime });
    }
  };

  walk('', 0);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  emptyDirs.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, emptyDirs, excluded, tooDeep };
}

/**
 * Identity of the whole bundle, not of SKILL.md.
 *
 * Seven copies of `decision` that share a SKILL.md but differ in
 * scripts/run.sh are seven different skills, and collapsing them on the
 * prose alone would hand someone the wrong script. The digest is over a
 * canonical JSON list of {path, mode, sha256} — JSON quoting makes the
 * encoding injective, so no arrangement of bytes inside one file can mimic
 * a different set of files, and a script that lost its executable bit is a
 * different bundle. Empty directories are part of the bundle too (their
 * `path` ends in `/`, and they carry no digest).
 */
export function bundleHash(skillDir, files, opts, emptyDirs = []) {
  const items = files.map((f) => ({
    path: f.rel,
    mode: f.mode ?? null,
    sha256: crypto.createHash('sha256').update(readInSkill(skillDir, f.rel, opts)).digest('hex'),
  }));
  for (const d of emptyDirs) items.push({ path: d.rel, mode: d.mode ?? null, sha256: null });
  return crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex');
}

/** Opaque, stable, and derived from the real directory — never sent back to us as a path. */
export function skillId(realDir) {
  return crypto.createHash('sha256').update(realDir).digest('hex').slice(0, 12);
}

/**
 * `name:` and `description:` out of a SKILL.md frontmatter block.
 *
 * Takes text rather than a path — deliberately unlike registry.js's
 * readFrontmatter, which opens the file itself. Nothing in this feature may
 * open a file except readInSkill().
 */
export function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return null;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return null;
  const out = {};
  let key = null;
  for (const line of raw.slice(3, end).split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) { key = m[1]; out[key] = m[2].trim(); }
    else if (key && line.trim()) out[key] += ' ' + line.trim();
  }
  return out;
}

function isSkillDir(dir) {
  try { return fs.lstatSync(path.join(dir, 'SKILL.md')).isFile(); }
  catch { return false; }
}

function brokenRow(dir, source, reason, name) {
  return {
    id: skillId(dir), name: name ?? path.basename(dir), displayName: name ?? path.basename(dir),
    source, dir, files: [], emptyDirs: [], excluded: [], totalBytes: 0, broken: true, reason, aliases: [],
  };
}

/**
 * Walk a skills directory looking for SKILL.md. Depth is discovered, not
 * assumed: the synced/ tree puts skills four levels down, and once a directory
 * IS a skill we stop — anything below it is part of that bundle.
 *
 * `rootLevel` carries the single symlink exception. A direct child of a skills
 * directory may be a link (find-skills points into ~/.agents); it is resolved
 * exactly once here and the resolved directory becomes the containment
 * boundary. Deeper links are never followed.
 */
function scanSkillsDir(dir, source, out, depth, rootLevel) {
  if (depth > SKILL_SCAN_DEPTH) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) {
    out.push(brokenRow(dir, source, `directory could not be read: ${e.code || e.message}`));
    return;
  }
  for (const d of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (SKIP_DIRS.has(d.name)) continue;
    const abs = path.join(dir, d.name);
    let real = abs;

    if (d.isSymbolicLink()) {
      // Deep links are refused, not reported: they are companion files of some
      // skill above, and listSkillFiles already accounts for them there.
      if (!rootLevel) continue;
      try { real = fs.realpathSync(abs); }
      catch (e) {
        out.push(brokenRow(abs, source, `symlink target is missing: ${e.code || e.message}`, d.name));
        continue;
      }
      try { resolveSafe(real, SKILL_ROOTS); }
      catch { out.push(brokenRow(abs, source, 'symlink points outside the skill roots', d.name)); continue; }
      try { if (!fs.statSync(real).isDirectory()) continue; }
      catch { out.push(brokenRow(abs, source, 'symlink target is missing', d.name)); continue; }
    } else if (!d.isDirectory()) {
      continue;
    }

    if (isSkillDir(real)) out.push({ dir: real, source, name: d.name, linkedFrom: real === abs ? null : abs });
    else scanSkillsDir(real, source, out, depth + 1, false);
  }
}

/**
 * A skills ROOT (~/.claude/skills, or a project's .claude/skills) may itself be
 * a link. It is resolved here, once, and scanned only if the target is inside
 * the skill roots and not a protected path — otherwise a project could point
 * `.claude/skills` at ~/.ssh and every file under it would become exportable.
 * Returns the real directory to scan, or null after recording why not.
 */
function resolveSkillsRoot(root, source, out) {
  let lst;
  try { lst = fs.lstatSync(root); } catch { return null; }
  if (!lst.isSymbolicLink() && !lst.isDirectory()) return null;
  let real;
  try { real = fs.realpathSync(root); }
  catch (e) { out.push(brokenRow(root, source, `skills root link target is missing: ${e.code || e.message}`)); return null; }
  if (lst.isSymbolicLink()) {
    try { resolveSafe(real, SKILL_ROOTS); }
    catch { out.push(brokenRow(root, source, 'skills root is a link that points outside the skill roots')); return null; }
  }
  try { if (!fs.statSync(real).isDirectory()) return null; } catch { return null; }
  return real;
}

/**
 * Project trees are checkouts, not skill libraries, so they are searched for
 * the harness directories that hold skills rather than walked exhaustively.
 * node_modules and .git are the two that would dominate the cost, and both are
 * already refused by isDenied.
 */
function scanProjectRoot(root, source, out, dir = root, depth = 0) {
  if (depth > PROJECT_SCAN_DEPTH) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const d of entries) {
    if (!d.isDirectory() || d.isSymbolicLink()) continue;
    const abs = path.join(dir, d.name);
    if (HARNESS_DIRS.has(d.name)) {
      const skillsDir = resolveSkillsRoot(path.join(abs, 'skills'), source, out);
      if (skillsDir) scanSkillsDir(skillsDir, source, out, 0, true);
      continue;
    }
    if (d.name.startsWith('.') || isDenied(abs)) continue;
    scanProjectRoot(root, source, out, abs, depth + 1);
  }
}

/** Raw candidates, before contents are read or duplicates collapsed. */
function findSkillDirs() {
  const out = [];
  for (const { source, root: configured, nested } of SOURCES) {
    // Real paths from here down: readInSkill proves containment by comparing
    // realpaths, which only works if the skill directory is one already.
    const root = resolveSkillsRoot(configured, source, out);
    if (!root) continue;
    if (nested) scanProjectRoot(root, source, out);
    else scanSkillsDir(root, source, out, 0, true);
  }
  return out;
}

/**
 * A row's contents WITHOUT reading any of them: the file list, sizes, modes
 * and exclusions come from no-follow stats alone. What the export resolves a
 * selection to, so caps can be enforced before a single byte is buffered.
 */
function describeSkill(c) {
  const { files, emptyDirs, excluded, tooDeep } = listSkillFiles(c.dir);
  if (tooDeep) {
    return brokenRow(c.dir, c.source,
      `bundle is deeper than the ${BUNDLE_DEPTH}-level limit (at ${tooDeep}); refusing to export it partially`, c.name);
  }
  return {
    id: skillId(c.dir), name: c.name, displayName: c.name, source: c.source, dir: c.dir,
    files, emptyDirs, excluded, totalBytes: files.reduce((n, f) => n + f.size, 0),
    broken: false, reason: null, aliases: [],
  };
}

/**
 * Just the selected skills, by id, described from metadata — the export's
 * lookup. listSkills() is the wrong tool there: it reads and hashes every
 * bundle on the machine before the selection has even been checked against
 * the caps. Unknown ids are simply absent from the result.
 */
export function resolveSkills(ids) {
  const want = new Set(ids);
  const found = new Map();
  for (const c of findSkillDirs()) {
    const id = skillId(c.dir);
    if (!want.has(id) || found.has(id)) continue;
    if (c.broken) { found.set(id, c); continue; }
    try { found.set(id, describeSkill(c)); }
    catch (e) { found.set(id, brokenRow(c.dir, c.source, `could not be read: ${e.message}`, c.name)); }
  }
  return found;
}

/**
 * Every skill on the machine, duplicates collapsed.
 *
 * Nothing here throws for a broken entry: a dangling symlink or an unreadable
 * directory is a row with broken:true and a reason, because one bad skill
 * folder taking the whole list down is how this panel becomes unusable on the
 * machine that needs it most.
 */
export function listSkills() {
  const candidates = findSkillDirs();
  const rows = [];

  for (const c of candidates) {
    if (c.broken) { rows.push(c); continue; }
    let row;
    try {
      const described = describeSkill(c);
      if (described.broken) { rows.push(described); continue; }
      const { files, emptyDirs, excluded, totalBytes } = described;
      if (totalBytes > MAX_BUNDLE_BYTES) {
        rows.push(brokenRow(c.dir, c.source, 'bundle is larger than the size cap', c.name));
        continue;
      }
      // The same per-bundle cap, enforced on the bytes as they are read: the
      // sizes above are a stat, and a file can grow between it and here.
      const hash = bundleHash(c.dir, files, { budget: { remaining: MAX_BUNDLE_BYTES } }, emptyDirs);
      const fm = parseFrontmatter(readTextInSkill(c.dir, 'SKILL.md'));
      row = {
        id: skillId(c.dir),
        name: c.name,
        displayName: (fm?.name || '').trim() || c.name,
        source: c.source,
        dir: c.dir,
        ...(c.linkedFrom ? { linkedFrom: c.linkedFrom } : {}),
        description: fm?.description ?? '',
        files, emptyDirs, excluded, totalBytes, hash,
        broken: false, reason: null, aliases: [],
      };
    } catch (e) {
      rows.push(brokenRow(c.dir, c.source, `could not be read: ${e.message}`, c.name));
      continue;
    }
    rows.push(row);
  }

  // Sorted before grouping so the canonical copy of a duplicate is decided by
  // source precedence and path, not by the order the filesystem happened to
  // hand back — otherwise the same machine produces different ids run to run.
  const order = new Map(SOURCES.map((s, i) => [s.source, i]));
  rows.sort((a, b) => (order.get(a.source) - order.get(b.source))
    || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));

  const byHash = new Map();
  const out = [];
  for (const row of rows) {
    if (row.broken) { out.push(row); continue; }
    const first = byHash.get(row.hash);
    if (first) { first.aliases.push({ dir: row.dir, source: row.source, name: row.name }); continue; }
    byHash.set(row.hash, row);
    out.push(row);
  }
  return out;
}

/**
 * The HTTP shape. dir, abs and the alias directories are stripped: the client
 * gets an opaque id and nothing it could feed back as a path, so the download
 * endpoints that follow have no filesystem argument to accept in the first
 * place. `rel` survives because it names a position inside a bundle, not a
 * location on this machine.
 */
export function toPublic(row) {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    source: row.source,
    description: row.description ?? '',
    files: row.files.map((f) => ({ rel: f.rel, size: f.size })),
    emptyDirs: (row.emptyDirs || []).map((d) => d.rel),
    excluded: (row.excluded || []).map((x) => ({ rel: x.rel, reason: x.reason })),
    totalBytes: row.totalBytes,
    broken: row.broken,
    reason: row.reason ?? null,
    aliasCount: row.aliases.length,
    aliasSources: [...new Set(row.aliases.map((a) => a.source))],
  };
}
