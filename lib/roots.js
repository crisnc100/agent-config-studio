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

// libc realpath: Node's JavaScript one joins a link's target lexically.
function realOr(p) { try { return fs.realpathSync.native(p); } catch { return null; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

/** HOME as typed and as it really is; both are compared, since callers hold either. */
function homes(home) {
  const real = realOr(home) || path.resolve(home);
  return { typed: path.resolve(home), real };
}

/**
 * Is this real location one no root — built-in or registered — may stand on?
 * The filesystem root, HOME or anything above it, ~/.ssh by any spelling, or
 * the studio's own folder, either way round. A plain reason, or null.
 */
export function unsafeLocation(real, opts = {}) {
  const home = homeOf(opts);
  const h = homes(home);
  const spell = (name) => [...new Set([path.join(h.typed, name), path.join(h.real, name), realOr(path.join(home, name))].filter(Boolean))];
  const shown = tildeIn(home, real);
  if (real === path.parse(real).root) return 'it resolves to the filesystem root (/)';
  if (inside(h.real, real) || inside(h.typed, real)) return `it resolves to ${shown}, your home folder or a folder above it`;
  for (const ssh of spell('.ssh')) if (inside(real, ssh) || inside(ssh, real)) return `it resolves to ${shown}, which is or holds ~/.ssh`;
  for (const st of spell('.agent-config-studio')) if (inside(real, st) || inside(st, real)) return `it resolves to ${shown}, which is or holds ~/.agent-config-studio`;
  return null;
}

/**
 * Each built-in home where it really is — a ~/.claude linked into a dotfiles
 * repo is legitimate, and the editor sees real paths — and whether that real
 * location is safe. A home linked to ~/.ssh, HOME or the studio's folder is
 * not: trusting it would make keys editable. Judged on every call.
 */
export function builtinState(home = os.homedir()) {
  const { real } = homes(home);
  return BUILTIN_NAMES.map((segs) => {
    const linked = realOr(path.join(home, ...segs));
    const at = linked || path.join(real, ...segs);
    return { name: `~/${segs.join('/')}`, real: at, problem: linked ? unsafeLocation(at, { home }) : null };
  });
}

/** The built-in homes that are safe to use, at their real locations. */
export function builtinHomes(home = os.homedir()) {
  return builtinState(home).filter((b) => !b.problem).map((b) => b.real);
}

/**
 * What a root may neither contain nor sit inside — ~/.ssh, the built-in homes,
 * and the studio's own folder (its history repo and this registry) — each by
 * EVERY spelling a path could reach it by: under HOME as typed, under the real
 * HOME, and at its own realpath. A ~/.ssh that is a link to ~/key-store makes
 * ~/key-store as protected as ~/.ssh. Computed fresh on every call: a link
 * re-pointed since the last look must be judged where it points now.
 */
function protectedDirs(home) {
  const h = homes(home);
  // A built-in home whose own realpath is unsafe (say ~/.agents -> HOME) is
  // guarded by its typed spellings only; its target would guard everything.
  const unsafe = new Set(builtinState(home).filter((b) => b.problem).map((b) => b.name));
  const spellings = (segs) => [...new Set([
    path.join(h.typed, ...segs), path.join(h.real, ...segs),
    unsafe.has(`~/${segs.join('/')}`) ? null : realOr(path.join(home, ...segs)),
  ].filter(Boolean))];
  return {
    ssh: spellings(['.ssh']),
    guarded: [...BUILTIN_NAMES, ['.agent-config-studio']].map((segs) => ({ shown: `~/${segs.join('/')}`, at: spellings(segs) })),
  };
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
 * back). Returns a plain reason, or null. `where` is the realpath the caller
 * is about to use, so the verdict is about exactly that destination.
 */
function ruleProblem(root, home, where = null) {
  if (!root || typeof root !== 'object') return 'an entry must be an object';
  if (typeof root.id !== 'string' || !ID_RE.test(root.id)) return 'its id must be lowercase letters, numbers and dashes';
  if (RESERVED_IDS.has(root.id)) return `the id "${root.id}" is reserved for the studio's own skill sources — pick another`;
  if (typeof root.label !== 'string' || !root.label.trim() || root.label.length > 80) return 'its label must be 1–80 characters';
  if (root.access !== 'edit' && root.access !== 'read') return 'access must be "edit" or "read"';
  if (typeof root.path !== 'string' || !root.path) return 'a path is required';
  if (!path.isAbsolute(root.path)) return `${root.path} is not an absolute path`;

  where ??= whereIs(root.path);
  const lexical = path.resolve(root.path);
  const h = homes(home);
  const shown = tildeIn(home, lexical);
  const guard = protectedDirs(home);
  const via = (p) => (p === lexical ? '' : ` (it resolves to ${tildeIn(home, p)})`);
  for (const p of new Set([where, lexical])) {
    if (p === path.parse(p).root) return `the filesystem root (/) cannot be a project folder — it would include everything${via(p)}`;
    if (p === h.typed || p === h.real) return `your home folder itself cannot be a project folder — it holds ~/.ssh and the agents' own config; add the folder your projects live in${via(p)}`;
    for (const ssh of guard.ssh) {
      if (p === ssh) return `~/.ssh holds your keys and cannot be a project folder${via(p)}`;
      if (inside(p, ssh)) return `${shown} is inside ~/.ssh, which holds your keys${via(p)}`;
    }
    for (const g of guard.guarded) {
      for (const at of g.at) {
        if (inside(p, at)) return `${shown} is inside ${g.shown}, which the studio already manages${via(p)}`;
        if (inside(at, p)) return `${shown} contains ${g.shown}, which the studio already manages${via(p)}`;
      }
    }
    for (const ssh of guard.ssh) {
      if (inside(ssh, p)) return `${shown} contains ~/.ssh, which holds your keys${via(p)}`;
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

/**
 * The raw file. Read and parsed on every call — it is a few hundred bytes —
 * so nothing about it is ever remembered: not its contents, not whether it
 * can be read (a chmod leaves inode, mtime and size alone).
 */
function readFile(home) {
  const file = rootsPath(home);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { state: 'absent', raw: [], error: null };
    return { state: 'error', raw: [], error: `roots.json could not be read: ${e.code || e.message}` };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.roots)) throw new Error('it has no "roots" list');
    return { state: 'ok', raw: parsed.roots, error: null };
  } catch (e) {
    return { state: 'error', raw: [], error: `roots.json is not valid: ${e.message}` };
  }
}

/** Each skipped entry is logged once per distinct reason, not on every request. */
let lastLogged = '';
function logSkipped(invalid) {
  const line = invalid.map((x) => `${JSON.stringify(x.entry?.id ?? x.entry)} — ${x.reason}`).join('\n');
  if (line === lastLogged) return;
  lastLogged = line;
  for (const l of line ? line.split('\n') : []) console.error(`roots.json: skipped ${l}`);
}

/**
 * The registry as the studio sees it now. Every entry is judged afresh, by
 * every rule, against the realpath it has at this moment — the same realpath
 * that is then handed to consumers — so a root whose link was re-pointed at
 * HOME, ~/.ssh or a built-in home is reported invalid, never activated.
 * A folder that is not there is `missing` (inactive, kept); a structurally
 * bad or unsafe entry is `invalid` (skipped, reported).
 */
export function loadRoots(opts = {}) {
  const home = homeOf(opts);
  const file = readFile(home);
  const raw = file.state === 'absent' ? legacyRoots(home).filter((r) => isDir(r.path)) : file.raw;
  const roots = [], invalid = [];
  for (const r of raw) {
    const real = r && typeof r.path === 'string' && path.isAbsolute(r.path) && isDir(r.path) ? realOr(r.path) : null;
    const why = ruleProblem(r, home, real ?? undefined) || conflictWith(r, roots);
    if (why) { invalid.push({ entry: r, reason: why }); continue; }
    roots.push({ id: r.id, path: r.path, label: r.label, access: r.access, real, status: real ? 'ok' : 'missing' });
  }
  logSkipped(invalid);
  return { state: file.state, roots, invalid, error: file.error, path: rootsPath(home) };
}

/**
 * Every list a consumer needs, from the current file. Cheap enough to call per
 * request: one small read, and a handful of realpaths per root.
 */
export function derive(opts = {}) {
  const home = homeOf(opts);
  const loaded = loadRoots({ home });
  const active = loaded.roots.filter((r) => r.status === 'ok');
  const edit = active.filter((r) => r.access === 'edit');
  const read = active.filter((r) => r.access === 'read');
  const state = builtinState(home);
  const builtins = state.filter((b) => !b.problem).map((b) => b.real);
  return {
    ...loaded,
    builtinHomes: builtins,
    // Built-in homes left out because of where they really are: reported in
    // the banner and the Folders view, never used.
    builtinInvalid: state.filter((b) => b.problem).map(({ name, problem }) => ({ name, reason: problem })),
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
  return { entries: file.raw, fresh: false };
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
