import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_HOME, CODEX_HOME, AGENTS_HOME, currentRoots, openUserFile } from './paths.js';

/**
 * Watches only the directories the registry actually cares about.
 *
 * A recursive watch on ~/.claude would be a firehose — session transcripts,
 * file-history and the plugin cache churn constantly and account for nearly all
 * of its ~2GB. So targets are curated, and obvious churn is filtered before it
 * ever reaches the debounce.
 */

// The dotfiles the registry lists; every other one is churn.
const WATCHED_DOTFILES = new Set(['.mcp.json', '.worktrees.conf']);
const IGNORED_EXT = new Set(['.jsonl', '.log', '.lock', '.tmp', '.swp', '.bak']);
const IGNORED_SEG = ['node_modules', '.git', 'shell-snapshots', 'paste-cache', 'telemetry', 'file-history'];

function isNoise(file) {
  if (!file) return false;
  const base = path.basename(file);
  if (base.startsWith('.') && !WATCHED_DOTFILES.has(base)) return true;
  if (IGNORED_EXT.has(path.extname(base))) return true;
  if (/\.sqlite(-wal|-shm)?$/.test(base)) return true;
  return IGNORED_SEG.some((seg) => file.split(path.sep).includes(seg));
}

export function createWatcher(onChange, { debounceMs = 400 } = {}) {
  const watchers = [];
  let timer = null;

  const trigger = (_event, filename) => {
    if (isNoise(filename)) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };

  const watch = (dir, recursive) => {
    try {
      if (!fs.existsSync(dir)) return;
      watchers.push(fs.watch(dir, { recursive, persistent: false }, trigger));
    } catch { /* a directory we cannot watch simply stays static */ }
  };

  // Skill trees and their reference files.
  watch(path.join(CLAUDE_HOME, 'skills'), true);
  watch(path.join(CLAUDE_HOME, 'skills_retired'), true);
  watch(path.join(CODEX_HOME, 'skills'), true);
  watch(path.join(AGENTS_HOME, 'skills'), true);

  // Flat directories — these also catch the dir being created later.
  watch(path.join(CLAUDE_HOME, 'hooks'), false);
  watch(path.join(CLAUDE_HOME, 'agents'), false);
  watch(path.join(CLAUDE_HOME, 'commands'), false);
  watch(path.join(CODEX_HOME, 'rules'), false);

  // Top level: CLAUDE.md, AGENTS.md, settings.json, config.toml, and the
  // appearance of agents/ or commands/ for the first time.
  watch(CLAUDE_HOME, false);
  watch(CODEX_HOME, false);

  // Repo memory, .mcp.json and .worktrees.conf in every edit folder: the
  // registry lists only those. Recursive, but noise-filtered. The list is
  // read when the watcher is made; a roots.json change makes a new one.
  for (const dir of currentRoots().editRoots) watch(dir, true);

  // Auto-memory: one watch per project scope rather than a recursive watch on
  // ~/.claude/projects, which is where the session churn lives.
  const projectsDir = path.join(CLAUDE_HOME, 'projects');
  try {
    for (const slug of fs.readdirSync(projectsDir)) {
      const mem = path.join(projectsDir, slug, 'memory');
      if (fs.existsSync(mem)) watch(mem, false);
    }
  } catch { /* no auto-memory yet */ }

  return {
    count: watchers.length,
    close() {
      clearTimeout(timer);
      for (const w of watchers) { try { w.close(); } catch {} }
      watchers.length = 0;
    },
  };
}

/** Flatten a registry into path -> mtime, for diffing one scan against the next. */
export function snapshotOf(registry) {
  const map = new Map();
  for (const g of registry.groups) {
    for (const e of g.entries) {
      for (const f of e.files) map.set(f.path, f.mtime);
    }
  }
  return map;
}

export function diffSnapshots(before, after) {
  const added = [], removed = [], changed = [];
  for (const [p, mtime] of after) {
    if (!before.has(p)) added.push(p);
    else if (before.get(p) !== mtime) changed.push(p);
  }
  for (const p of before.keys()) if (!after.has(p)) removed.push(p);
  return { added, removed, changed };
}

/* ── which changes the studio made itself ─────────────────────────────── */

/**
 * The watcher cannot tell the studio's own writes from anyone else's, so the
 * code that performs one says so here, AT THE MOMENT it writes: the path, the
 * kind of change it makes, and the sha256 of the bytes it leaves (null for a
 * removal). tagOrigin() then splits a batch of changes in two. A change is
 * the studio's only if an expectation for that path and kind is still open
 * AND the file on disk is exactly what the studio wrote (a removal: the path
 * is gone). Each expectation is consumed by the first change it matches and
 * lapses after EXPECT_MS, so a later outside rewrite, a recreation with any
 * bytes, or a deletion is always announced as an outside change.
 */
const EXPECT_MS = 10_000;
// A bound on memory, not a working limit: a bulk trash of thousands of files
// registers one expectation each, and the oldest are the first to lapse anyway.
const MAX_EXPECTATIONS = 5_000;
const expectations = new Map();   // abs -> [{ kind, sha, until }], in insertion order
let count = 0;

/** Drop every lapsed expectation — each by its own expiry — then the oldest paths until under the cap. */
function prune(now) {
  for (const [abs, list] of expectations) {
    const live = list.filter((x) => x.until > now);
    if (live.length === list.length) continue;
    count -= list.length - live.length;
    if (live.length) expectations.set(abs, live); else expectations.delete(abs);
  }
  for (const [abs, list] of expectations) {
    if (count <= MAX_EXPECTATIONS) break;
    count -= list.length;
    expectations.delete(abs);
  }
}

export function expectWrite(abs, kind, sha = null, now = Date.now()) {
  prune(now);
  const list = expectations.get(abs) || [];
  if (list.some((x) => x.kind === kind && x.sha === sha)) return;   // one studio write, one expectation
  list.push({ kind, sha, until: now + EXPECT_MS });
  count++;
  // Re-inserted at the end, so the Map stays ordered oldest-first for eviction.
  expectations.delete(abs);
  expectations.set(abs, list);
  prune(now);
}

/** How many expectations are open — for the tests. */
export const _expectationCount = () => count;

function shaOf(abs) {
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile()) return null;
    return crypto.createHash('sha256').update(openUserFile(abs).buf).digest('hex');
  } catch { return null; }
}

/**
 * Is this change the studio's? Any event on a path settles every expectation
 * for it: a match is consumed, and a mismatch cancels them all — something
 * other than the studio touched the file, so a later return to the studio's
 * exact bytes is not the studio's either.
 */
function consume(abs, kind, now) {
  const list = expectations.get(abs);
  if (!list) return false;
  const hit = list.some((x) => x.until > now && x.kind === kind
    && (kind === 'removed' ? !fs.existsSync(abs) : x.sha !== null && x.sha === shaOf(abs)));
  count -= list.length;
  expectations.delete(abs);
  return hit;
}

/** Split `{ added, removed, changed }` (absolute paths) into what the studio did and everything else. */
export function tagOrigin(delta, now = Date.now()) {
  prune(now);
  const studio = { added: [], removed: [], changed: [] };
  const outside = { added: [], removed: [], changed: [] };
  for (const kind of ['added', 'removed', 'changed']) {
    for (const p of delta[kind] || []) (consume(p, kind, now) ? studio : outside)[kind].push(p);
  }
  return { studio, outside };
}
