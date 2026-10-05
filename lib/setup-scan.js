import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * "Scan for projects": which folders under the usual places hold projects,
 * so the setup screen can offer them. Runs only when the person clicks.
 *
 * A project is a folder that is a repo (`.git`, a directory or a worktree's
 * file) or holds a CLAUDE.md / AGENTS.md. A suggestion is a project's
 * immediate parent — the folder its siblings share — never a wider ancestor;
 * when two suggestions nest, the inner one is kept, so nothing broader than
 * the projects found is ever offered. Repos are not walked into: what is
 * inside a repo is that repo's business, not a new project folder.
 *
 * Bounded by class, not by luck: directories opened, entries read, depth,
 * wall time (checked per entry, and the whole scan raced against a timer so a
 * call that blocks — a macOS privacy prompt — cannot hold the request) and
 * the number of suggestions returned. Any cap reached sets `truncated`.
 * Symlinked directories are never followed inside the walk; a symlinked
 * starting folder is followed once, and starting folders are de-duplicated by
 * where they really are.
 */

export const CANDIDATES = ['Documents', 'Projects', 'projects', 'code', 'Code', 'dev', 'src', 'workspace', 'Developer', 'repos', 'GitHub', 'git'];
export const LIMITS = { maxDepth: 3, maxDirs: 5000, maxEntries: 50_000, timeMs: 3000, maxSuggestions: 50 };
const SKIP = new Set(['node_modules', 'Library']);
const CONTEXT = new Set(['CLAUDE.md', 'AGENTS.md']);
const DENIED = new Set(['EACCES', 'EPERM']);

const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

/** Does this volume ignore case? Asked of the folder itself, by its swapped-case spelling. */
function caseInsensitive(dir) {
  const swapped = dir.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  if (swapped === dir) return false;
  try { return fs.statSync(swapped).ino === fs.statSync(dir).ino; } catch { return false; }
}

/** The starting folders that exist, each once, by realpath (case-folded where the volume folds case). */
export function startingFolders(home) {
  const seen = new Set();
  const out = [];
  for (const name of CANDIDATES) {
    const at = path.join(home, name);
    const r = real(at);
    if (!r) continue;
    try { if (!fs.statSync(r).isDirectory()) continue; } catch { continue; }
    const key = caseInsensitive(r) ? r.toLowerCase() : r;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

const blockedReason = () => `permission denied${process.platform === 'darwin' ? ' — macOS may ask for access' : ''}`;

/**
 * The walk itself. `registered` is the realpath of every registered root;
 * `display` turns a path into what the page shows.
 */
export async function scan({ home = os.homedir(), registered = [], display = (p) => p, limits = {} } = {}) {
  const L = { ...LIMITS, ...limits };
  const started = Date.now();
  const st = { dirs: 0, entries: 0, truncated: false, stop: false };
  const nodes = new Map();          // real dir -> { repo, context, parent, root }
  const blocked = [];
  const overTime = () => Date.now() - started > L.timeMs;

  const walk = async (dir, depth, parent, root) => {
    if (st.stop) return;
    if (st.dirs >= L.maxDirs || overTime()) { st.truncated = true; return; }
    st.dirs++;
    const node = { repo: false, context: 0, parent, root };
    nodes.set(dir, node);
    const subdirs = [];
    let handle;
    try { handle = await fsp.opendir(dir); }
    catch (e) {
      if (DENIED.has(e.code)) blocked.push({ path: display(dir), reason: blockedReason() });
      return;
    }
    try {
      for await (const d of handle) {
        if (st.stop) break;
        if (++st.entries > L.maxEntries || overTime()) { st.truncated = true; st.stop = st.stop || st.entries > L.maxEntries; break; }
        if (d.name === '.git' && (d.isDirectory() || d.isFile())) { node.repo = true; continue; }
        if (CONTEXT.has(d.name) && (d.isFile() || d.isSymbolicLink())) { node.context++; continue; }
        // Dirent.isDirectory() is false for a symlink, so links are never followed here.
        if (!d.isDirectory() || d.name.startsWith('.') || SKIP.has(d.name)) continue;
        subdirs.push(path.join(dir, d.name));
      }
    } catch (e) {
      if (DENIED.has(e.code)) blocked.push({ path: display(dir), reason: blockedReason() });
    } finally { try { await handle.close(); } catch {} }
    if (node.repo || depth >= L.maxDepth) return;
    for (const sd of subdirs.sort()) await walk(sd, depth + 1, dir, root);
  };

  const work = (async () => {
    for (const root of startingFolders(home)) await walk(root, 0, null, root);
  })();
  let timer;
  const deadline = new Promise((r) => { timer = setTimeout(() => { st.truncated = true; st.stop = true; r(); }, L.timeMs + 250); });
  await Promise.race([work, deadline]);
  clearTimeout(timer);

  // Each project's immediate parent; a project at a starting folder's top is
  // its own suggestion, since its parent would be HOME.
  const counts = new Map();
  for (const [dir, n] of nodes) {
    if (!n.repo && !n.context) continue;
    const at = n.parent ?? dir;
    const c = counts.get(at) ?? { repos: 0, contextFiles: 0 };
    if (n.parent) { if (n.repo) c.repos++; if (n.context) c.contextFiles++; }
    else { if (n.repo) c.repos++; c.contextFiles += n.context; }
    counts.set(at, c);
  }
  const all = [...counts.keys()];
  const innermost = all.filter((p) => !all.some((q) => q !== p && inside(q, p))).sort();
  const rows = innermost.map((p) => {
    const reg = registered.find((r) => r === p);
    const covering = reg ? null : registered.find((r) => inside(p, r) || inside(r, p));
    return {
      path: p, display: display(p), ...counts.get(p),
      status: reg ? 'added' : covering ? 'covered' : 'new',
      ...(covering ? { coveredBy: display(covering) } : {}),
    };
  });
  if (rows.length > L.maxSuggestions) st.truncated = true;
  return {
    suggestions: rows.slice(0, L.maxSuggestions),
    blocked,
    truncated: st.truncated,
    scanned: { dirs: st.dirs, entries: Math.min(st.entries, L.maxEntries), ms: Date.now() - started },
  };
}

/** One scan at a time: a second request while one runs joins it. */
let running = null;
export function scanOnce(opts) {
  if (!running) running = scan(opts).finally(() => { running = null; });
  return running;
}
