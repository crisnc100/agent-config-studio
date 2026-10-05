import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * "Scan for projects": which folders under the usual places hold projects,
 * so the setup screen can offer them. Runs only when the person clicks.
 *
 * A project is a folder that is a repo (`.git`, a directory or a worktree's
 * file) or holds a CLAUDE.md / AGENTS.md. A suggestion is each project's
 * immediate parent — the folder its siblings share — never a wider ancestor,
 * and nothing is collapsed: two suggestions may nest, and once the outer one
 * is added the inner one reads "covered". Repos are not walked into: what is
 * inside a repo is that repo's business, not a new project folder.
 *
 * Bounded by class, not by luck: directories opened, entries read, depth,
 * wall time (checked per entry, and the whole scan — finding the starting
 * folders included — raced against a timer so a call that blocks, a macOS
 * privacy prompt, cannot hold the request) and the number of suggestions
 * returned. Any cap reached sets `truncated`.
 *
 * ACCEPTED LIMIT: a single filesystem call that blocks (that prompt, a hung
 * network mount) cannot be interrupted from JavaScript. The response still
 * goes out on time; the walk behind it ends only when that call returns, and
 * until it does no second scan starts (scanOnce answers 409).
 * Symlinked directories are never followed inside the walk; a symlinked
 * starting folder is followed once, and starting folders are de-duplicated by
 * where they really are.
 */

export const CANDIDATES = ['Documents', 'Projects', 'projects', 'code', 'Code', 'dev', 'src', 'workspace', 'Developer', 'repos', 'GitHub', 'git'];
export const LIMITS = { maxDepth: 3, maxDirs: 5000, maxEntries: 50_000, timeMs: 3000, maxSuggestions: 50 };
const SKIP = new Set(['node_modules', 'Library']);
const CONTEXT = new Set(['CLAUDE.md', 'AGENTS.md']);
const DENIED = new Set(['EACCES', 'EPERM']);

const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

/** Does this volume ignore case? Asked of the folder itself, by its swapped-case spelling. */
async function caseInsensitive(dir, io) {
  const swapped = dir.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  if (swapped === dir) return false;
  try { return (await io.stat(swapped)).ino === (await io.stat(dir)).ino; } catch { return false; }
}

/**
 * The starting folders that exist, each once, by realpath (case-folded where
 * the volume folds case). Asynchronous, so it runs under the scan's timer.
 * fs.promises.realpath is libuv's, the native one.
 */
export async function startingFolders(home, io = fsp) {
  const seen = new Set();
  const out = [];
  for (const name of CANDIDATES) {
    let r;
    try { r = await io.realpath(path.join(home, name)); } catch { continue; }
    try { if (!(await io.stat(r)).isDirectory()) continue; } catch { continue; }
    const key = (await caseInsensitive(r, io)) ? r.toLowerCase() : r;
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
export function scan(opts) { return scanJob(opts).answer; }

/**
 * The scan as two promises: `answer`, which settles by the deadline, and
 * `work`, which settles only when the filesystem calls behind it have.
 * `io` is fs.promises; the slot tests hand in a slow one.
 */
function scanJob({ home = os.homedir(), registered = [], display = (p) => p, limits = {}, io = fsp } = {}) {
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
    try { handle = await io.opendir(dir); }
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

  let timer;
  const deadline = new Promise((r) => { timer = setTimeout(() => { st.truncated = true; st.stop = true; r(); }, L.timeMs + 250); });
  const work = (async () => {
    for (const root of await startingFolders(home, io)) await walk(root, 0, null, root);
  })().catch(() => {});
  const answer = Promise.race([work, deadline]).then(() => { clearTimeout(timer); return summarise(); });
  return { answer, work };

  function summarise() {

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
  const rows = [...counts.keys()].sort().map((p) => {
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
    blocked: [...blocked],
    truncated: st.truncated,
    scanned: { dirs: st.dirs, entries: Math.min(st.entries, L.maxEntries), ms: Date.now() - started },
  };
  }
}

/**
 * One scan at a time. A request while one is answering joins it. One that
 * arrives after the answer went out but while that scan's filesystem work is
 * still running — a timed-out walk stuck in a call — gets `busy`, never a
 * second walk beside it. The slot frees when the work settles, not the timer.
 */
let slot = null;
export function scanOnce(opts) {
  if (slot?.answered) return Promise.resolve({ busy: true });
  if (slot) return slot.answer;
  const job = scanJob(opts);
  const mine = { answer: job.answer, answered: false };
  slot = mine;
  job.answer.then(() => { mine.answered = true; });
  job.work.finally(() => { if (slot === mine) slot = null; });
  return job.answer;
}
