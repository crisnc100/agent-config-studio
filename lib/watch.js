import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_HOME, CODEX_HOME, PROJECTS, AGENTS_HOME } from './paths.js';

/**
 * Watches only the directories the registry actually cares about.
 *
 * A recursive watch on ~/.claude would be a firehose — session transcripts,
 * file-history and the plugin cache churn constantly and account for nearly all
 * of its ~2GB. So targets are curated, and obvious churn is filtered before it
 * ever reaches the debounce.
 */

const IGNORED_EXT = new Set(['.jsonl', '.log', '.lock', '.tmp', '.swp', '.bak']);
const IGNORED_SEG = ['node_modules', '.git', 'shell-snapshots', 'paste-cache', 'telemetry', 'file-history'];

function isNoise(file) {
  if (!file) return false;
  const base = path.basename(file);
  if (base.startsWith('.') && base !== '.mcp.json') return true;
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

  // Repo memory and project .mcp.json. Recursive, but noise-filtered.
  watch(PROJECTS, true);

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
const expectations = new Map();   // abs -> [{ kind, sha, until }]

export function expectWrite(abs, kind, sha = null, now = Date.now()) {
  const list = (expectations.get(abs) || []).filter((x) => x.until > now);
  list.push({ kind, sha, until: now + EXPECT_MS });
  expectations.set(abs, list);
}

function shaOf(abs) {
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile()) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  } catch { return null; }
}

function consume(abs, kind, now) {
  const list = expectations.get(abs);
  if (!list) return false;
  const live = list.filter((x) => x.until > now);
  const i = live.findIndex((x) => x.kind === kind
    && (kind === 'removed' ? !fs.existsSync(abs) : x.sha !== null && x.sha === shaOf(abs)));
  if (i !== -1) live.splice(i, 1);
  if (live.length) expectations.set(abs, live); else expectations.delete(abs);
  return i !== -1;
}

/** Split `{ added, removed, changed }` (absolute paths) into what the studio did and everything else. */
export function tagOrigin(delta, now = Date.now()) {
  const studio = { added: [], removed: [], changed: [] };
  const outside = { added: [], removed: [], changed: [] };
  for (const kind of ['added', 'removed', 'changed']) {
    for (const p of delta[kind] || []) (consume(p, kind, now) ? studio : outside)[kind].push(p);
  }
  return { studio, outside };
}
