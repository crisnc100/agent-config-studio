import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  CLAUDE_HOME, CODEX_HOME, PROJECTS, STUDIO_HOME, resolveSafe, tilde,
} from './paths.js';
import * as history from './history.js';

const TRASH = path.join(STUDIO_HOME, 'trash');

/* ── creation ─────────────────────────────────────────────────────────── */

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * What each kind creates and where. `dir` builds the container, `file` is the
 * primary file written inside it (or alongside it, for flat kinds).
 */
const KINDS = {
  'claude-skill': {
    label: 'Claude skill',
    root: () => path.join(CLAUDE_HOME, 'skills'),
    nested: true,
    file: 'SKILL.md',
    template: skillTemplate,
  },
  'codex-skill': {
    label: 'Codex skill',
    root: () => path.join(CODEX_HOME, 'skills'),
    nested: true,
    file: 'SKILL.md',
    template: skillTemplate,
  },
  hook: {
    label: 'hook',
    root: () => path.join(CLAUDE_HOME, 'hooks'),
    nested: false,
    ext: '.sh',
    executable: true,
    template: (name) =>
      `#!/usr/bin/env bash\n# ${name}\n# Wire this up under "hooks" in settings.json.\nset -euo pipefail\n\n`,
  },
  agent: {
    label: 'subagent',
    root: () => path.join(CLAUDE_HOME, 'agents'),
    nested: false,
    ext: '.md',
    template: (name) =>
      `---\nname: ${name}\ndescription: What this agent does, and when to delegate to it.\ntools: Read, Grep, Glob\n---\n\n` +
      `# ${name}\n\nInstructions for this subagent.\n`,
  },
  command: {
    label: 'slash command',
    root: () => path.join(CLAUDE_HOME, 'commands'),
    nested: false,
    ext: '.md',
    template: (name) =>
      `---\ndescription: What /${name} does.\n---\n\n# /${name}\n\nWhat this command should do when invoked.\n`,
  },
};

function skillTemplate(name) {
  return `---
name: ${name}
description: What this skill does, and when to use it — include the phrases a user would actually say. This text is the only thing the model sees when deciding whether to load the skill.
---

# /${name}

What this skill does when invoked.

## When to use it

## Steps
`;
}

export function listKinds() {
  return Object.entries(KINDS).map(([id, k]) => ({ id, label: k.label }));
}

/**
 * Create a new skill / hook / agent / command. Optionally seeds the body from
 * an existing file — the usual case is porting a Claude skill to Codex, where
 * the copy is a starting point and is expected to diverge.
 */
export async function create({ kind, name, sourcePath }) {
  const spec = KINDS[kind];
  if (!spec) throw bad(`unknown kind: ${kind}`);

  const clean = String(name || '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!NAME_RE.test(clean)) {
    throw bad('Name must be lowercase letters, numbers and hyphens, starting with a letter or number.');
  }

  const root = spec.root();
  await fsp.mkdir(root, { recursive: true });

  const target = spec.nested
    ? path.join(root, clean, spec.file)
    : path.join(root, clean + spec.ext);

  // resolveSafe both normalises and proves the destination is inside a root.
  const abs = resolveSafe(target);
  if (fs.existsSync(abs)) throw bad(`${tilde(abs)} already exists.`);
  if (spec.nested && fs.existsSync(path.dirname(abs))) {
    throw bad(`A ${spec.label} named "${clean}" already exists.`);
  }

  let content;
  if (sourcePath) {
    const src = resolveSafe(sourcePath);
    content = await fsp.readFile(src, 'utf8');
    // Retarget the frontmatter name so the copy is not a duplicate identity.
    content = content.replace(/^(---\s*\n(?:.*\n)*?name:).*$/m, `$1 ${clean}`);
  } else {
    content = spec.template(clean);
  }

  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
  if (spec.executable) await fsp.chmod(abs, 0o755);

  const sha = await history.record(abs, `create ${tilde(abs)}`).catch(() => null);
  return { path: abs, display: tilde(abs), sha };
}

/** Add another file inside an existing skill directory (a reference doc). */
export async function addFile({ dir, name }) {
  const absDir = resolveSafe(dir);
  if (!fs.statSync(absDir).isDirectory()) throw bad('not a directory');

  const clean = String(name || '').trim().replace(/[/\\]/g, '');
  if (!clean || clean.startsWith('.')) throw bad('Invalid file name.');
  if (!/\.(md|json|txt|sh|toml|ya?ml)$/i.test(clean)) {
    throw bad('File must end in .md, .json, .txt, .sh, .toml or .yaml.');
  }

  const abs = resolveSafe(path.join(absDir, clean));
  if (fs.existsSync(abs)) throw bad(`${clean} already exists.`);

  await fsp.writeFile(abs, clean.endsWith('.json') ? '{\n}\n' : `# ${clean.replace(/\.[^.]+$/, '')}\n\n`, 'utf8');
  const sha = await history.record(abs, `create ${tilde(abs)}`).catch(() => null);
  return { path: abs, display: tilde(abs), sha };
}

/* ── deletion ─────────────────────────────────────────────────────────── */

const META = 'trash-meta.json';
// Written BEFORE the data moves and renamed to META after, so a trash that is
// interrupted at any point still has a record listTrash can find.
const PENDING_META = 'trash-meta.pending.json';
// The payload lives one level down, so no trashed name — `trash-meta.json`
// included — can share a directory entry with the metadata. Entries from
// before this layout keep their payload beside the metadata; `layout` says
// which one a record uses.
const DATA_DIR = 'data';

/**
 * Soft delete. The content is committed to the shadow repo first, then moved
 * into a trash directory, then the removal is committed. That leaves two
 * independent ways back: restore from trash, or `git show` the prior commit.
 * Nothing is ever unlinked outright.
 */
export async function remove({ path: p }) {
  return trashResolved(resolveSafe(p));
}

/**
 * The trash itself, for a path the caller has ALREADY proven. remove() proves
 * it with resolveSafe; lib/memory-ops.js proves more than that (no link on the
 * path at all) and must not have the path re-resolved through a symlink.
 *
 * Order, and why:
 *   1. history baseline of every file (a failure is reported, not swallowed);
 *   2. an exclusive, collision-proof trash directory — millisecond stamp plus
 *      a random suffix, created with a non-recursive mkdir that fails rather
 *      than reuse a directory, so two same-named items trashed in the same
 *      millisecond can never share (and overwrite) one;
 *   3. the pending metadata, written before anything moves;
 *   4. the move;
 *   5. the pending metadata renamed to final.
 * Killed after 3, listTrash shows an entry whose data never left; killed
 * after 4, one that restores normally.
 */
export async function trashResolved(abs, { id: wantId = null, beforeMove = null } = {}) {
  const stat = await fsp.lstat(abs);
  const isDir = stat.isDirectory();

  if (isProtected(abs)) {
    throw bad(`${tilde(abs)} is managed by the plugin system — deleting it here would be undone on the next plugin update.`);
  }

  const historyErrors = [];
  // Capture current contents in history before anything moves.
  const files = isDir ? walkFiles(abs) : [abs];
  for (const f of files) {
    await history.recordBaseline(f, `state of ${tilde(f)} before delete`)
      .catch((e) => historyErrors.push(e.message));
  }

  const { id, dest } = await makeTrashDir(path.basename(abs), wantId);
  const meta = {
    id,
    originalPath: abs,
    display: tilde(abs),
    name: path.basename(abs),
    isDir,
    fileCount: files.length,
    deletedAt: Date.now(),
    layout: DATA_DIR,
  };
  await fsp.writeFile(path.join(dest, PENDING_META), JSON.stringify(meta, null, 2), { flag: 'wx' });
  await fsp.mkdir(path.join(dest, DATA_DIR));
  await fault('after-pending-meta');

  // The caller's last word, immediately before the move: the history work
  // above is asynchronous, and whatever it proved about `abs` may be stale.
  if (beforeMove) {
    try { await beforeMove(); }
    catch (e) { await fsp.rm(dest, { recursive: true, force: true }); throw e; }
  }
  const payload = path.join(dest, DATA_DIR, meta.name);
  await fsp.rename(abs, payload)
    .catch(async (e) => {
      if (e.code !== 'EXDEV') throw e;
      await fsp.cp(abs, payload, { recursive: true });
      await fsp.rm(abs, { recursive: true, force: true });
    });
  await fault('after-move');

  await fsp.rename(path.join(dest, PENDING_META), path.join(dest, META));

  let sha = null;
  try { sha = (await history.snapshotAll(`delete ${tilde(abs)}`))?.sha ?? null; }
  catch (e) { historyErrors.push(e.message); }
  const historyError = historyErrors.length ? historyErrors.join('; ') : null;
  if (historyError) console.error(`trash ${tilde(abs)}: history not recorded — ${historyError}`);
  return { deleted: true, id, display: tilde(abs), files: files.length, sha, historyError };
}

/**
 * A fresh trash id, for a caller that must record it BEFORE the trash runs so
 * that an interruption between the move and its own bookkeeping still leaves
 * it knowing where the data went.
 */
export function newTrashId(basename) {
  return `${stamp()}-${crypto.randomBytes(4).toString('hex')}-${basename}`.replace(/[^A-Za-z0-9._-]/g, '_');
}

async function makeTrashDir(basename, wantId = null) {
  await fsp.mkdir(TRASH, { recursive: true });
  for (let attempt = 0; attempt < 8; attempt++) {
    // A requested id is used as is — the exclusive mkdir still refuses a reused one.
    if (wantId && (attempt > 0 || !/^[A-Za-z0-9._-]+$/.test(wantId))) throw new Error(`trash id not available: ${wantId}`);
    const id = wantId || newTrashId(basename);
    const dest = path.join(TRASH, id);
    try {
      await fsp.mkdir(dest);
      return { id, dest };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('could not allocate a trash entry');
}

/**
 * The record for one trash directory: the final metadata, or the pending one
 * an interrupted trash left behind. `interrupted` is true for the latter, and
 * `moved` says whether the data made it into the trash before the stop.
 */
async function readMeta(dir) {
  for (const [file, interrupted] of [[META, false], [PENDING_META, true]]) {
    let meta;
    try { meta = JSON.parse(await fsp.readFile(path.join(dir, file), 'utf8')); } catch { continue; }
    const payload = meta.layout === DATA_DIR ? path.join(dir, DATA_DIR, meta.name) : path.join(dir, meta.name);
    let moved = true;
    try { await fsp.lstat(payload); } catch { moved = false; }
    return { ...meta, interrupted, moved, payload };
  }
  return null;
}

export async function listTrash() {
  let ents;
  try { ents = await fsp.readdir(TRASH, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const meta = await readMeta(path.join(TRASH, e.name));
    // An interrupted trash whose data never moved has nothing to restore: the
    // original is still where it was. It is still listed, so it is visible.
    if (!meta) continue;
    const { payload, ...pub } = meta;
    out.push({ ...pub, restorable: meta.moved && !fs.existsSync(meta.originalPath) });
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

/**
 * Put a trashed item back. The destination is claimed EXCLUSIVELY — a hard
 * link for a file, a fresh mkdir for a directory — so something created at
 * that path after the existence check makes the restore fail instead of being
 * overwritten by it.
 */
export async function restoreTrash({ id }, { verifyDest = null } = {}) {
  const safeId = String(id || '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!safeId) throw bad('trash id required');
  const dir = path.join(TRASH, safeId);
  const meta = await readMeta(dir);
  if (!meta) throw Object.assign(new Error('no such trash entry'), { status: 404 });
  if (!meta.moved) throw bad(`${meta.display} never left its original location — nothing to restore.`);
  const abs = resolveSafe(meta.originalPath);

  if (fs.existsSync(abs)) {
    throw bad(`${tilde(abs)} exists again — rename or remove it before restoring.`);
  }

  await fsp.mkdir(path.dirname(abs), { recursive: true });
  // As with trashResolved's beforeMove: the caller's containment check, run
  // at the last moment before the destination is claimed.
  if (verifyDest) await verifyDest(abs, meta);
  const src = meta.payload;
  const exists = () => bad(`${tilde(abs)} exists again — rename or remove it before restoring.`);
  if (meta.isDir) {
    try { await fsp.mkdir(abs); } catch (e) { if (e.code === 'EEXIST') throw exists(); throw e; }
    // rename over the empty directory we just created; if anything appeared
    // inside it meanwhile, rename fails with ENOTEMPTY and nothing is lost.
    await fsp.rename(src, abs).catch(async (e) => {
      if (e.code !== 'EXDEV') { await fsp.rmdir(abs).catch(() => {}); throw e; }
      await fsp.cp(src, abs, { recursive: true, errorOnExist: true, force: false });
      await fsp.rm(src, { recursive: true, force: true });
    });
  } else {
    try { await fsp.link(src, abs); }
    catch (e) {
      if (e.code === 'EEXIST') throw exists();
      if (e.code !== 'EXDEV' && e.code !== 'EPERM') throw e;
      await fsp.copyFile(src, abs, fs.constants.COPYFILE_EXCL);
    }
    await fsp.rm(src, { force: true });
  }

  await fsp.rm(dir, { recursive: true, force: true });
  let historyError = null;
  try { await history.snapshotAll(`restore ${tilde(abs)}`); }
  catch (e) { historyError = e.message; console.error(`restore ${tilde(abs)}: history not recorded — ${historyError}`); }
  return { restored: true, path: abs, display: tilde(abs), historyError };
}

/**
 * A test seam for the interruption tests, which kill the process at a named
 * step. Nothing in the app sets it.
 */
let faultHook = null;
export function _setTrashFault(fn) { faultHook = fn; }
async function fault(step) { if (faultHook) await faultHook(step); }

/* ── helpers ──────────────────────────────────────────────────────────── */

/** Plugin-cache files are owned by the plugin manager; deleting them here is futile. */
function isProtected(abs) {
  return abs.startsWith(path.join(CLAUDE_HOME, 'plugins') + path.sep);
}

function walkFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(abs));
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

/** Local time to the millisecond; the random suffix beside it does the rest. */
function stamp() {
  const d = new Date(Date.now());
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
