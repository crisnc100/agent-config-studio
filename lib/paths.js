import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { derive, unsafeLocation } from './roots.js';

export const HOME = os.homedir();
export const CLAUDE_HOME = path.join(HOME, '.claude');
export const CODEX_HOME = path.join(HOME, '.codex');
export const AGENTS_HOME = path.join(HOME, '.agents');
export const GROK_HOME = path.join(HOME, '.grok');
export const WORKTREE_HOME = path.join(HOME, '.config', 'worktree');
export const STUDIO_HOME = path.join(HOME, '.agent-config-studio');
export const HISTORY_REPO = path.join(STUDIO_HOME, 'history');

/**
 * The project folders, as roots.json says right now (lib/roots.js). Read per
 * call, never bound at load, so `acs roots add` applies without a restart.
 * Edit roots are realpath'd and active; read roots appear only in `readRoots`.
 */
export const currentRoots = () => derive({ home: HOME });

/**
 * Only paths under these roots are ever readable or writable: the agents'
 * homes plus the edit roots. ~/.agents is included because ~/.claude/skills
 * symlinks into it. A read root is never here — the editor, the writer and
 * the history mirror have no business touching it.
 */
export const safeRoots = () => currentRoots().safeRoots;

/**
 * Where skill discovery is allowed to look, and NOTHING else: the skills
 * trees plus every root, read ones included. lib/skills.js passes this list to
 * resolveSafe() as its own roots, so the widening to read roots stops at that
 * one caller — and a test asserts GET /api/file still 403s on a read-root path.
 */
export function skillRoots() {
  const d = currentRoots();
  const skipped = new Set(d.builtinInvalid.map((b) => b.name));
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  // A skills tree counts only if its home is safe and it, too, really sits
  // somewhere safe — never ~/.ssh, HOME or above, or the studio's folder.
  const global = [['~/.claude', CLAUDE_HOME], ['~/.codex', CODEX_HOME], ['~/.agents', AGENTS_HOME]]
    .filter(([name]) => !skipped.has(name))
    .map(([, dir]) => real(path.join(dir, 'skills')))
    .filter((p) => !unsafeLocation(p, { home: HOME }));
  return [...global, ...d.allRoots];
}

/** HOME as it really is; paths come back from realpath in this spelling. */
let realHomeCache = null;
export function realHome() {
  if (realHomeCache === null) { try { realHomeCache = fs.realpathSync(HOME); } catch { realHomeCache = HOME; } }
  return realHomeCache;
}

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
 * Where a path really is, even if it does not exist yet: the realpath of its
 * nearest existing ancestor, with the rest appended. `/alias/new-dir`, with
 * `/alias` a link to `/read`, is `/read/new-dir` — never judged lexically.
 */
export function realpathNearest(p) {
  const abs = path.resolve(p);
  let probe = abs;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  return path.join(fs.realpathSync(probe), path.relative(probe, abs));
}

/**
 * Resolve a caller-supplied path and prove it lands inside an allowed root.
 * Uses realpath on the nearest existing ancestor so symlinks cannot escape.
 */
export function resolveSafe(input, roots = safeRoots()) {
  if (typeof input !== 'string' || !input.trim()) {
    throw Object.assign(new Error('path required'), { status: 400 });
  }
  const expanded = input.startsWith('~') ? path.join(HOME, input.slice(1)) : input;
  const real = realpathNearest(expanded);

  const ok = roots.some((r) => real === r || real.startsWith(r + path.sep));
  if (!ok) throw Object.assign(new Error(`path outside allowed roots: ${input}`), { status: 403 });
  if (isDenied(real)) throw Object.assign(new Error('path is protected'), { status: 403 });
  return real;
}

/**
 * The write-time half of resolveSafe. Every mutation calls this immediately
 * before it touches the filesystem, against the roots as they are NOW: the
 * request was authorized before history and other awaits ran, and a folder
 * removed (or made read-only) in between must stop the write. A write already
 * past this point may finish.
 */
let beforeWriteCheck = null;
/** A test seam: runs first, so a test can revoke a root at exactly this point. Nothing in the app sets it. */
export function _setBeforeWriteCheck(fn) { beforeWriteCheck = fn; }
export function assertWritable(abs) {
  if (beforeWriteCheck) beforeWriteCheck(abs);
  return resolveSafe(abs);
}

/**
 * ~/.claude/CLAUDE.md -> "~/.claude/CLAUDE.md" for display. Either spelling of
 * HOME counts: resolved paths carry the real one (macOS /var -> /private/var).
 */
export function tilde(abs) {
  if (abs.startsWith(HOME)) return '~' + abs.slice(HOME.length);
  const real = realHome();
  return real !== HOME && abs.startsWith(real) ? '~' + abs.slice(real.length) : abs;
}

/**
 * Map a live path into its mirrored location inside the shadow history repo.
 * Measured from whichever spelling of HOME the path is under, so a save
 * under a symlinked HOME still lands in history.
 */
export function historyRelPath(abs) {
  let rel = path.relative(HOME, abs);
  if (rel.startsWith('..')) rel = path.relative(realHome(), abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('outside home');
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
