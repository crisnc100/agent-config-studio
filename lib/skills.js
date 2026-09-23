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
const BUNDLE_DEPTH = 8;

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

const refuse = (msg) => Object.assign(new Error(msg), { status: 403, contained: true });

/**
 * Resolve `rel` inside `skillDir` without ever following a link.
 *
 * Walked component by component: a symlink anywhere along the way is refused
 * rather than resolved, which is what makes the later open safe. `skillDir`
 * must already be a real path (findSkills resolves the one permitted root-level
 * link before it gets here), so no component of the result can leave it.
 */
function containedPath(skillDir, rel) {
  if (typeof rel !== 'string' || !rel) throw refuse('a relative name is required');
  if (path.isAbsolute(rel) || rel.includes('\0')) throw refuse(`refusing name: ${JSON.stringify(rel)}`);

  let cur = skillDir;
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.' || seg === '..') throw refuse(`refusing name: ${JSON.stringify(rel)}`);
    cur = path.join(cur, seg);
    let st;
    try { st = fs.lstatSync(cur); }
    catch { throw Object.assign(new Error(`not in this skill: ${rel}`), { status: 404, contained: true }); }
    if (st.isSymbolicLink()) throw refuse(`symlink inside a skill folder: ${rel}`);
  }
  if (isDenied(cur)) throw refuse(`protected path: ${rel}`);
  return cur;
}

/**
 * THE shared reader. Returns the bytes of `rel` within `skillDir`, or throws.
 *
 * The inode comparison closes the gap between deciding the path is safe and
 * actually opening it: if anything replaced the file in between, the descriptor
 * we hold is not the file we checked, and the read is abandoned.
 */
export function readInSkill(skillDir, rel) {
  const abs = containedPath(skillDir, rel);
  const before = fs.lstatSync(abs);
  if (!before.isFile()) throw refuse(`not a regular file: ${rel}`);

  const fd = fs.openSync(abs, 'r');
  try {
    const st = fs.fstatSync(fd);
    if (st.ino !== before.ino || st.dev !== before.dev) {
      throw refuse(`file changed underneath the read: ${rel}`);
    }
    if (!st.isFile()) throw refuse(`not a regular file: ${rel}`);
    if (st.size > MAX_FILE_BYTES) {
      throw Object.assign(new Error(`file too large: ${rel}`), { status: 413, contained: true });
    }
    const buf = Buffer.allocUnsafe(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    fs.closeSync(fd);
  }
}

export function readTextInSkill(skillDir, rel) {
  return readInSkill(skillDir, rel).toString('utf8');
}

/**
 * Every file that belongs to the bundle, plus the names that were refused.
 *
 * `excluded` is reported rather than silently dropped: a skill that quietly
 * loses a companion file at export time looks like a packaging bug, and a
 * symlink someone planted deserves to be visible.
 */
export function listSkillFiles(skillDir) {
  const files = [];
  const excluded = [];

  const walk = (relDir, depth) => {
    if (depth > BUNDLE_DEPTH) return;
    const full = relDir ? containedPath(skillDir, relDir) : skillDir;
    let entries;
    try { entries = fs.readdirSync(full, { withFileTypes: true }); }
    catch { return; }
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
  return { files, excluded };
}

/**
 * Identity of the whole bundle, not of SKILL.md.
 *
 * Seven copies of `decision` that share a SKILL.md but differ in
 * scripts/run.sh are seven different skills, and collapsing them on the
 * prose alone would hand someone the wrong script.
 */
export function bundleHash(skillDir, files) {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f.rel);
    h.update('\0');
    h.update(readInSkill(skillDir, f.rel));
    h.update('\0');
  }
  return h.digest('hex');
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
    source, dir, files: [], excluded: [], totalBytes: 0, broken: true, reason, aliases: [],
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
    if (d.name.startsWith('.')) continue;
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
      const skillsDir = path.join(abs, 'skills');
      try { if (fs.statSync(skillsDir).isDirectory()) scanSkillsDir(skillsDir, source, out, 0, true); }
      catch {}
      continue;
    }
    if (d.name.startsWith('.') || isDenied(abs)) continue;
    scanProjectRoot(root, source, out, abs, depth + 1);
  }
}

/** Raw candidates, before contents are read or duplicates collapsed. */
function findSkillDirs() {
  const out = [];
  for (const { source, root, nested } of SOURCES) {
    let st;
    try { st = fs.statSync(root); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (nested) scanProjectRoot(root, source, out);
    else scanSkillsDir(root, source, out, 0, true);
  }
  return out;
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
      const { files, excluded } = listSkillFiles(c.dir);
      const totalBytes = files.reduce((n, f) => n + f.size, 0);
      if (totalBytes > MAX_BUNDLE_BYTES) {
        rows.push(brokenRow(c.dir, c.source, 'bundle is larger than the size cap', c.name));
        continue;
      }
      const hash = bundleHash(c.dir, files);
      const fm = parseFrontmatter(readTextInSkill(c.dir, 'SKILL.md'));
      row = {
        id: skillId(c.dir),
        name: c.name,
        displayName: (fm?.name || '').trim() || c.name,
        source: c.source,
        dir: c.dir,
        ...(c.linkedFrom ? { linkedFrom: c.linkedFrom } : {}),
        description: fm?.description ?? '',
        files, excluded, totalBytes, hash,
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
    excluded: (row.excluded || []).map((x) => ({ rel: x.rel, reason: x.reason })),
    totalBytes: row.totalBytes,
    broken: row.broken,
    reason: row.reason ?? null,
    aliasCount: row.aliases.length,
    aliasSources: [...new Set(row.aliases.map((a) => a.source))],
  };
}
