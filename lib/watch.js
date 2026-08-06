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
