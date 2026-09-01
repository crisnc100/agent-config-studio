import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const HOME = os.homedir();
export const CLAUDE_HOME = path.join(HOME, '.claude');
export const CODEX_HOME = path.join(HOME, '.codex');
export const PROJECTS = path.join(HOME, 'Documents', 'Projects');
export const AGENTS_HOME = path.join(HOME, '.agents');
export const GROK_HOME = path.join(HOME, '.grok');
export const WORKTREE_HOME = path.join(HOME, '.config', 'worktree');
export const STUDIO_HOME = path.join(HOME, '.agent-config-studio');
export const HISTORY_REPO = path.join(STUDIO_HOME, 'history');

/**
 * Only paths under these roots are ever readable or writable.
 * ~/.agents is included because ~/.claude/skills symlinks into it.
 */
export const SAFE_ROOTS = [CLAUDE_HOME, CODEX_HOME, PROJECTS, AGENTS_HOME, GROK_HOME, WORKTREE_HOME];

/**
 * Never read, never write, never list. Secrets and machine state that would be
 * actively harmful to surface in a browser tab.
 */
const DENY_EXACT = new Set([
  path.join(CLAUDE_HOME, '.credentials.json'),
  path.join(CODEX_HOME, 'auth.json'),
  path.join(GROK_HOME, 'auth.json'),
]);

const DENY_SEGMENTS = [
  '.git',
  'node_modules',
  '.credentials.json',
  'auth.json',
];

export function isDenied(abs) {
  if (DENY_EXACT.has(abs)) return true;
  const segs = abs.split(path.sep);
  return DENY_SEGMENTS.some((d) => segs.includes(d));
}

/**
 * Resolve a caller-supplied path and prove it lands inside an allowed root.
 * Uses realpath on the nearest existing ancestor so symlinks cannot escape.
 */
export function resolveSafe(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw Object.assign(new Error('path required'), { status: 400 });
  }
  const expanded = input.startsWith('~') ? path.join(HOME, input.slice(1)) : input;
  const abs = path.resolve(expanded);

  let probe = abs;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  const realProbe = fs.realpathSync(probe);
  const real = path.join(realProbe, path.relative(probe, abs));

  const ok = SAFE_ROOTS.some((r) => real === r || real.startsWith(r + path.sep));
  if (!ok) throw Object.assign(new Error(`path outside allowed roots: ${input}`), { status: 403 });
  if (isDenied(real)) throw Object.assign(new Error('path is protected'), { status: 403 });
  return real;
}

/** ~/.claude/CLAUDE.md -> "~/.claude/CLAUDE.md" for display. */
export function tilde(abs) {
  return abs.startsWith(HOME) ? '~' + abs.slice(HOME.length) : abs;
}

/** Map a live path into its mirrored location inside the shadow history repo. */
export function historyRelPath(abs) {
  const rel = path.relative(HOME, abs);
  if (rel.startsWith('..')) throw new Error('outside home');
  return path.join('home', rel);
}

export function kindOf(filePath) {
  const base = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.json' || base.endsWith('.json')) return 'json';
  if (ext === '.toml') return 'toml';
  if (ext === '.sh' || ext === '.bash' || ext === '.zsh') return 'shell';
  // .worktrees.conf and friends are sourced by the shell, not ini files.
  if (ext === '.conf') return 'shell';
  if (ext === '.rules') return 'text';
  if (ext === '.jsonl') return 'text';
  return 'text';
}
