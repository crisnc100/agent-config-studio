/**
 * Which repository a directory belongs to, read from git's own metadata.
 *
 * A worktree is two hops from its repository, not one. Its `.git` is a FILE
 * naming `<main>/.git/worktrees/<name>`, and it is that directory's
 * `commondir` file — a path relative to itself, `../..` in practice — that
 * leads to the shared `.git`. Following only the first hop files every
 * worktree as a repository of its own, which is how one project's memory and
 * transcripts end up in five groups.
 *
 * `.git` stays denied to every general file route (lib/paths.js). This module
 * is the one exception, and it is deliberately narrow: it reads only a file
 * named `.git` or `commondir`, never follows a link to one, and never reads
 * more than META_BYTES. It returns paths, never contents.
 */
import fs from 'node:fs';
import path from 'node:path';

const META_BYTES = 4096;
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/** The text of a tiny git metadata file, or null. Only the two names this module needs. */
function readMeta(abs) {
  const base = path.basename(abs);
  if (base !== '.git' && base !== 'commondir') return null;
  let fd;
  try { fd = fs.openSync(abs, OPEN_FLAGS); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > META_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, st.size, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch { return null; } finally { fs.closeSync(fd); }
}

function isDir(abs) {
  try { return fs.statSync(abs).isDirectory(); } catch { return false; }
}

function real(abs) {
  try { return fs.realpathSync(abs); } catch { return abs; }
}

/**
 * The checkout `dir` sits in, found by walking up to the nearest `.git`.
 *
 * Returns `{ root, commonDir, worktree }` — `root` is the checkout's top,
 * `commonDir` the shared `.git` every worktree of the repository resolves to
 * (the grouping key), `worktree` whether `root` is a linked worktree rather
 * than the main checkout. Null when no ancestor is a checkout, or when the
 * metadata is unreadable or points nowhere: an unresolvable worktree is
 * reported as not-a-repository rather than guessed into a group.
 */
export function repoOf(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    const dotGit = path.join(cur, '.git');
    let st = null;
    try { st = fs.lstatSync(dotGit); } catch {}
    if (st?.isDirectory()) return { root: cur, commonDir: real(dotGit), worktree: false };
    if (st?.isFile()) {
      const text = readMeta(dotGit);
      const m = text && /^gitdir:\s*(.+?)\s*$/m.exec(text);
      if (!m) return null;
      const gitdir = path.resolve(cur, m[1]);
      if (!isDir(gitdir)) return null;
      const common = readMeta(path.join(gitdir, 'commondir'));
      const commonDir = common && common.trim() ? path.resolve(gitdir, common.trim()) : gitdir;
      if (!isDir(commonDir)) return null;
      return { root: cur, commonDir: real(commonDir), worktree: true };
    }
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/** The main checkout a common dir belongs to: its parent, when it is a plain `.git`. */
export function mainCheckoutOf(commonDir) {
  return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
}
