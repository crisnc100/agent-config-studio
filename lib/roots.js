import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The folder registry: where this person's projects live.
 *
 * `~/.agent-config-studio/roots.json` is the truth, `{version: 1, roots: [{id,
 * path, label, access}]}`. An **edit** root joins the built-in homes as a place
 * the editor, the writer and the history mirror may touch; a **read** root is
 * only ever listed (Context, Skills, worktree discovery) and served by id.
 * Nothing else in the studio names a project folder — every consumer asks
 * derive() for the current lists, so a change to the file applies without a
 * restart.
 *
 * Three states, never conflated:
 *   - absent:  nobody has written the file. Reads behave as migration would
 *              (the legacy folders that exist), and nothing is written until
 *              the server starts or the CLI changes something.
 *   - ok:      parsed. Structurally invalid entries are dropped and reported;
 *              an entry whose folder is missing stays in the file, inactive.
 *   - error:   unreadable or unparseable. No roots are active, the CLI refuses
 *              to change it, and nothing ever overwrites it.
 *
 * Roots are stored as typed (absolute) and compared by realpath, and so are the
 * built-in homes: a HOME reached through a symlink (macOS /var) must not make
 * every path look outside every root.
 */

export const VERSION = 1;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
/**
 * Ids a root may not take. A read root's id becomes its skills' `source`
 * (lib/skills.js) and the export's folder token (lib/zip.js), so one named
 * after a fixed source or token would pass for global or edit-root skills.
 */
export const RESERVED_IDS = new Set(['global-claude', 'global-codex', 'global-agents', 'project', 'global', 'codex', 'agents']);
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

const homeOf = (opts) => opts?.home ?? os.homedir();
export const studioHome = (home = os.homedir()) => path.join(home, '.agent-config-studio');
export const rootsPath = (home = os.homedir()) => path.join(studioHome(home), 'roots.json');
export const setupPath = (home = os.homedir()) => path.join(studioHome(home), 'setup.json');

/** The folders migration seeds, in the order they were hardcoded. */
export const legacyRoots = (home = os.homedir()) => [
  { id: 'projects', path: path.join(home, 'Documents', 'Projects'), label: 'Projects', access: 'edit' },
  { id: 'garman-homes', path: path.join(home, 'Documents', 'Garman-Homes'), label: 'Garman Homes', access: 'read' },
];

/** The agents' own homes: always editable, whatever roots.json says. */
const BUILTIN_NAMES = [['.claude'], ['.codex'], ['.agents'], ['.grok'], ['.config', 'worktree']];

function realOr(p) { try { return fs.realpathSync(p); } catch { return null; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const overlaps = (a, b) => inside(a, b) || inside(b, a);

/** HOME as typed and as it really is; both are compared, since callers hold either. */
function homes(home) {
  const real = realOr(home) || path.resolve(home);
  return { typed: path.resolve(home), real };
}

/** Each built-in home, realpath'd when it exists, else placed under the real HOME. */
export function builtinHomes(home = os.homedir()) {
  const { real } = homes(home);
  return BUILTIN_NAMES.map((segs) => realOr(path.join(home, ...segs)) || path.join(real, ...segs));
}

/**
 * What a root may neither contain nor sit inside: the built-in homes, and the
 * studio's own folder (its history repo and this registry), which is guarded
 * but never editable.
 */
function guardedHomes(home) {
  const { real } = homes(home);
  return [...builtinHomes(home), realOr(studioHome(home)) || path.join(real, '.agent-config-studio')];
}

/** Where a typed path really is — realpath if it exists, else lexical. */
function whereIs(p) { return realOr(p) || path.resolve(p); }

function tildeIn(home, abs) {
  for (const h of [homes(home).typed, homes(home).real]) {
    if (abs === h || abs.startsWith(h + path.sep)) return '~' + abs.slice(h.length);
  }
  return abs;
}

/**
 * Structural checks plus every safety rule — everything except "does it exist
 * right now", which is availability, not validity (an unmounted volume comes
 * back). Returns a plain reason, or null.
 */
function ruleProblem(root, home) {
  if (!root || typeof root !== 'object') return 'an entry must be an object';
  if (typeof root.id !== 'string' || !ID_RE.test(root.id)) return 'its id must be lowercase letters, numbers and dashes';
  if (RESERVED_IDS.has(root.id)) return `the id "${root.id}" is reserved for the studio's own skill sources — pick another`;
  if (typeof root.label !== 'string' || !root.label.trim() || root.label.length > 80) return 'its label must be 1–80 characters';
  if (root.access !== 'edit' && root.access !== 'read') return 'access must be "edit" or "read"';
  if (typeof root.path !== 'string' || !root.path) return 'a path is required';
  if (!path.isAbsolute(root.path)) return `${root.path} is not an absolute path`;

  const where = whereIs(root.path);
  const lexical = path.resolve(root.path);
  const h = homes(home);
  const shown = tildeIn(home, lexical);
  for (const p of new Set([where, lexical])) {
    if (p === path.parse(p).root) return 'the filesystem root (/) cannot be a project folder — it would include everything';
    if (p === h.typed || p === h.real) return 'your home folder itself cannot be a project folder — it holds ~/.ssh and the agents\' own config; add the folder your projects live in';
    for (const ssh of [path.join(h.typed, '.ssh'), path.join(h.real, '.ssh')]) {
      if (p === ssh) return '~/.ssh holds your keys and cannot be a project folder';
      if (inside(p, ssh)) return `${shown} is inside ~/.ssh, which holds your keys`;
    }
    for (const b of guardedHomes(home)) {
      const bTyped = path.join(h.typed, path.relative(h.real, b));
      for (const bb of new Set([b, bTyped])) {
        if (inside(p, bb)) return `${shown} is inside ${tildeIn(home, bb)}, which the studio already manages`;
        if (inside(bb, p)) return `${shown} contains ${tildeIn(home, bb)}, which the studio already manages`;
      }
    }
  }
  // History mirrors only $HOME (paths.js historyRelPath), so an edit root
  // outside it could be written with no way back.
  if (root.access === 'edit' && !inside(where, h.real) && !inside(where, h.typed)) {
    return `${shown} is outside your home folder — an edit folder must be inside it so every save has history; add it as a read folder instead`;
  }
  return null;
}

function conflictWith(root, others) {
  const where = whereIs(root.path);
  for (const o of others) {
    const ow = whereIs(o.path);
    if (o.id === root.id) return `the id "${root.id}" is already used by ${o.path}`;
    if (ow === where) return `${root.path} is already registered as "${o.id}"`;
    if (inside(where, ow)) return `${root.path} is inside "${o.id}" (${o.path}) — folders may not overlap`;
    if (inside(ow, where)) return `${root.path} contains "${o.id}" (${o.path}) — folders may not overlap`;
  }
  return null;
}

/**
 * Should this folder be added? A plain reason when not, else null. Shared by
 * the CLI and (build 2) the browser route, so the reject list lives once.
 */
export function validateRoot(root, existing = [], opts = {}) {
  const home = homeOf(opts);
  const rule = ruleProblem(root, home);
  if (rule) return rule;
  if (!fs.existsSync(root.path)) return `${root.path} does not exist`;
  if (!isDir(root.path)) return `${root.path} is not a folder`;
  return conflictWith(root, existing);
}

/* ── reading ─────────────────────────────────────────────────────────── */

let cache = { key: null, value: null };

/** The raw file, parsed and validated. Cached by the file's identity. */
function readFile(home) {
  const file = rootsPath(home);
  let st;
  try { st = fs.statSync(file); }
  catch (e) {
    if (e.code === 'ENOENT') return { state: 'absent', entries: [], invalid: [], error: null };
    return { state: 'error', entries: [], invalid: [], error: `roots.json could not be read: ${e.code || e.message}` };
  }
  const key = `${file}\0${st.ino}\0${st.mtimeMs}\0${st.size}`;
  if (cache.key === key) return cache.value;

  let value;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.roots)) throw new Error('it has no "roots" list');
    const entries = [], invalid = [];
    for (const r of parsed.roots) {
      const why = ruleProblem(r, home) || conflictWith(r, entries);
      if (why) invalid.push({ entry: r, reason: why });
      else entries.push({ id: r.id, path: r.path, label: r.label, access: r.access });
    }
    value = { state: 'ok', entries, invalid, error: null };
  } catch (e) {
    value = { state: 'error', entries: [], invalid: [], error: `roots.json is not valid: ${e.message}` };
  }
  for (const bad of value.invalid) console.error(`roots.json: skipped ${JSON.stringify(bad.entry?.id ?? bad.entry)} — ${bad.reason}`);
  cache = { key, value };
  return value;
}

/**
 * The registry as the studio sees it now. `roots` carries each entry's
 * realpath and whether its folder is there; only present ones are active.
 */
export function loadRoots(opts = {}) {
  const home = homeOf(opts);
  const file = readFile(home);
  const entries = file.state === 'absent'
    ? legacyRoots(home).filter((r) => isDir(r.path))
    : file.entries;
  const roots = entries.map((r) => {
    const real = isDir(r.path) ? realOr(r.path) : null;
    return { ...r, real, status: real ? 'ok' : 'missing' };
  });
  return { state: file.state, roots, invalid: file.invalid, error: file.error, path: rootsPath(home) };
}

/**
 * Every list a consumer needs, from the current file. Cheap enough to call per
 * request: one stat of roots.json, and a realpath per root and built-in home.
 */
export function derive(opts = {}) {
  const home = homeOf(opts);
  const loaded = loadRoots({ home });
  const active = loaded.roots.filter((r) => r.status === 'ok');
  const edit = active.filter((r) => r.access === 'edit');
  const read = active.filter((r) => r.access === 'read');
  const builtins = builtinHomes(home);
  return {
    ...loaded,
    builtinHomes: builtins,
    safeRoots: [...builtins, ...edit.map((r) => r.real)],
    editRoots: edit.map((r) => r.real),
    readRoots: read.map((r) => r.real),
    allRoots: active.map((r) => r.real),
    active,
    contextRoots: active.map((r) => ({ id: r.id, dir: r.real, label: r.label, editable: r.access === 'edit' })),
  };
}

/* ── writing ─────────────────────────────────────────────────────────── */

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Run `fn` holding roots.json.lock, so two writers (two `acs roots add`, or the
 * server's migration racing one) cannot both read the same list and have the
 * last rename erase the other's change. A lock older than LOCK_STALE_MS is a
 * crashed writer's and is taken over.
 */
export function withLock(fn, opts = {}) {
  const home = homeOf(opts);
  const lock = rootsPath(home) + '.lock';
  fs.mkdirSync(studioHome(home), { recursive: true });
  const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS);
  for (;;) {
    try {
      fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
      if (age > LOCK_STALE_MS) { try { fs.unlinkSync(lock); } catch {} continue; }
      if (Date.now() > deadline) throw new Error(`roots.json is locked by another writer (${lock}) — try again`);
      sleep(25);
    }
  }
  try { return fn(); }
  finally { try { fs.unlinkSync(lock); } catch {} }
}

function save(entries, home) {
  const file = rootsPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const roots = entries.map(({ id, path: p, label, access }) => ({ id, path: p, label, access }));
  fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, roots }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);   // atomic: a crash mid-write never truncates the registry
  return file;
}

/**
 * The list a writer starts from: the file's entries — never filtered by
 * availability, so a missing folder survives an unrelated add — or, when no
 * file exists yet, what migration would seed. Refuses an unreadable file.
 */
function startingPoint(home) {
  const file = readFile(home);
  if (file.state === 'error') throw new Error(`${file.error} — fix or remove ${rootsPath(home)} first; it was not changed`);
  if (file.state === 'absent') return { entries: legacyRoots(home).filter((r) => isDir(r.path)), fresh: true };
  // Hand-edited entries that fail validation are kept as they are: the CLI
  // reports them, it does not silently delete what someone typed.
  let raw;
  try { raw = JSON.parse(fs.readFileSync(rootsPath(home), 'utf8')).roots; } catch { raw = file.entries; }
  return { entries: raw, fresh: false };
}

function writeSetupMarker(home) {
  const file = setupPath(home);
  if (fs.existsSync(file)) return;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ completed: 'migrated', at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * First start: write roots.json if nobody has. Seeds the legacy folders that
 * exist; when it seeds any, also marks setup as done — this machine was set up
 * before there was a setup screen. A fresh machine gets an empty list and no
 * marker, so build 2's setup screen still opens.
 */
export function migrateRoots(opts = {}) {
  const home = homeOf(opts);
  if (fs.existsSync(rootsPath(home))) return { migrated: false, seeded: [] };
  return withLock(() => {
    if (fs.existsSync(rootsPath(home))) return { migrated: false, seeded: [] };
    const seeded = legacyRoots(home).filter((r) => isDir(r.path));
    save(seeded, home);
    if (seeded.length) writeSetupMarker(home);
    return { migrated: true, seeded };
  }, { home });
}

/** Lowercase-dashed from the label, unique against the list. */
function idFor(label, taken) {
  const base = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'folder';
  let id = base, n = 1;
  while (taken.has(id) || RESERVED_IDS.has(id)) id = `${base}-${++n}`;
  return id;
}

/** A typed path made absolute: `~` expanded, relative to `cwd`. */
export function resolveTyped(input, { home = os.homedir(), cwd = process.cwd() } = {}) {
  const s = String(input ?? '').trim();
  if (!s) return '';
  const expanded = s === '~' ? home : s.startsWith('~/') ? path.join(home, s.slice(2)) : s;
  return path.resolve(cwd, expanded);
}

/** Add a folder. Throws a plain reason; the file is untouched on any refusal. */
export function addRoot({ path: typed, access = 'read', label, id } = {}, opts = {}) {
  const home = homeOf(opts);
  const abs = resolveTyped(typed, { home, cwd: opts.cwd });
  if (!abs) throw new Error('a folder path is required');
  return withLock(() => {
    const { entries, fresh } = startingPoint(home);
    const name = (label ?? '').trim() || path.basename(abs) || abs;
    const root = { id: id ?? idFor(name, new Set(entries.map((e) => e?.id))), path: abs, label: name, access };
    const why = validateRoot(root, entries.filter((e) => e && typeof e.path === 'string'), { home });
    if (why) throw new Error(why);
    const next = [...entries, root];
    save(next, home);
    if (fresh && entries.length) writeSetupMarker(home);
    return { root, roots: next };
  }, { home });
}

/** Remove a folder by id. The folder itself is never touched. */
export function removeRoot(id, opts = {}) {
  const home = homeOf(opts);
  return withLock(() => {
    const { entries, fresh } = startingPoint(home);
    const next = entries.filter((e) => e?.id !== id);
    if (next.length === entries.length) throw new Error(`no folder with id "${id}"`);
    save(next, home);
    if (fresh && entries.length) writeSetupMarker(home);
    return { removed: entries.find((e) => e?.id === id), roots: next };
  }, { home });
}

/** What adding an edit folder hands the studio — printed before anyone relies on it. */
export const EDIT_GRANTS = 'The studio may now open, save, create and delete instruction files (CLAUDE.md, AGENTS.md, .mcp.json, .worktrees.conf) under this folder, and records each save in its history.';
