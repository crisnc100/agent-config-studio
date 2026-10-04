import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HOME, HISTORY_REPO, historyRelPath, realHome, resolveSafe, safeRoots, tilde } from './paths.js';
import { buildRegistry } from './registry.js';
import { userPath } from './models.js';

const exec = promisify(execFile);

/**
 * All repository mutations run one at a time. `git add -A` plus commit is not
 * safe to interleave: concurrent saves would absorb each other's changes or
 * collide on index.lock.
 */
let queue = Promise.resolve();
function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

async function git(args, opts = {}) {
  const { stdout } = await exec('git', ['-C', HISTORY_REPO, ...args], {
    maxBuffer: 32 * 1024 * 1024, ...opts,
  });
  return stdout;
}

/**
 * A shadow repo rather than `git init` inside ~/.claude: those directories hold
 * gigabytes of session churn, and project memory files already live in their own
 * repos. Mirroring keeps full history without touching either.
 */
export async function ensureRepo() {
  if (!fs.existsSync(path.join(HISTORY_REPO, '.git'))) {
    fs.mkdirSync(HISTORY_REPO, { recursive: true });
    await exec('git', ['-C', HISTORY_REPO, 'init', '-q', '-b', 'main']);
    await exec('git', ['-C', HISTORY_REPO, 'config', 'user.name', 'agent-config-studio']);
    await exec('git', ['-C', HISTORY_REPO, 'config', 'user.email', 'studio@localhost']);
    fs.writeFileSync(
      path.join(HISTORY_REPO, 'README.md'),
      '# agent-config-studio history\n\nMirrored copies of Claude Code + Codex config files.\n' +
      'Every save made in the studio lands here as a commit. Safe to delete;\n' +
      'you lose history, not live config.\n'
    );
    await snapshotAll('baseline: initial snapshot of all config surfaces');
  }
}

/**
 * The file's real path, re-proved at the moment it is read: inside the safe
 * roots as they are now, and not denied (resolveSafe does both). A registry
 * entry or an editor path is only evidence about the past — the file may have
 * become a link to a credential since — so nothing is copied or compared on
 * its strength. The model registry's user file is the one addition: the
 * Models panel edits it, and it lives in the studio's own folder.
 */
let snapshotHook = null;
/** A test seam: runs between the registry build and the copies in snapshotAll. Nothing in the app sets it. */
export function _setSnapshotHook(fn) { snapshotHook = fn; }
function readable(abs) {
  const models = path.join(realHome(), path.relative(HOME, userPath()));
  return resolveSafe(abs, [...safeRoots(), models]);
}

function mirror(abs) {
  const real = readable(abs);
  const rel = historyRelPath(abs);
  const dest = path.join(HISTORY_REPO, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(real, dest);
  return rel;
}

async function commit(message) {
  await git(['add', '-A']);
  const status = await git(['status', '--porcelain']);
  if (!status.trim()) return null;
  await git(['commit', '-q', '-m', message]);
  return (await git(['rev-parse', 'HEAD'])).trim();
}

/** Every file currently in the mirror, relative to the repo. */
function actualMirrorPaths(dir = HISTORY_REPO, prefix = '') {
  const out = [];
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name === '.git') continue;
    const rel = prefix ? path.join(prefix, e.name) : e.name;
    if (e.isDirectory()) out.push(...actualMirrorPaths(path.join(dir, e.name), rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Copy every registered file into the shadow repo and commit the lot. Files
 * that have disappeared from disk are removed from the mirror so the commit
 * records the deletion — otherwise the tip of history keeps claiming a config
 * file exists long after it was deleted.
 */
export async function snapshotAll(message = 'snapshot') {
  return serialize(async () => {
    const { groups } = buildRegistry();
    if (snapshotHook) await snapshotHook();
    const expected = new Set(['README.md']);
    let n = 0;
    for (const g of groups) {
      // Harness-written files churn constantly; snapshotting them would make a
      // large commit on every startup. Explicit edits still get recorded.
      if (g.ephemeral) continue;
      for (const e of g.entries) {
        for (const f of e.files) {
          try { expected.add(mirror(f.path)); n++; } catch {}
        }
      }
    }
    // The model registry's user file is edited from the Models panel, not the
    // file tree, so it is not in buildRegistry — without this every startup
    // snapshot would record it as deleted.
    try { if (fs.existsSync(userPath())) { expected.add(mirror(userPath())); n++; } } catch {}
    // Ephemeral files already in the mirror stay there; they are not "deleted".
    for (const g of groups) {
      if (!g.ephemeral) continue;
      for (const e of g.entries) {
        for (const f of e.files) {
          try { expected.add(historyRelPath(f.path)); } catch {}
        }
      }
    }
    let removed = 0;
    for (const rel of actualMirrorPaths()) {
      if (expected.has(rel)) continue;
      try { fs.rmSync(path.join(HISTORY_REPO, rel)); removed++; } catch {}
    }
    const parts = [`${n} files`];
    if (removed) parts.push(`${removed} removed`);
    const sha = await commit(`${message} (${parts.join(', ')})`);
    return { sha, files: n, removed };
  });
}

/**
 * Commit the file's CURRENT on-disk contents only if the mirror is out of date.
 * Called before an overwrite so there is always a prior version to diff and
 * restore against — including for files changed outside the studio.
 */
export async function recordBaseline(abs, message) {
  await ensureRepo();
  return serialize(async () => {
    const rel = historyRelPath(abs);
    const mirrored = path.join(HISTORY_REPO, rel);
    const real = readable(abs);
    try {
      if (fs.existsSync(mirrored) &&
          fs.readFileSync(mirrored, 'utf8') === fs.readFileSync(real, 'utf8')) {
        return null;
      }
    } catch { /* fall through and record it */ }
    mirror(abs);
    return commit(message);
  });
}

/** Record one file's new contents as a commit. */
export async function record(abs, message) {
  await ensureRepo();
  return serialize(async () => {
    mirror(abs);
    return commit(message);
  });
}

export async function logFor(abs, limit = 50) {
  await ensureRepo();
  const rel = historyRelPath(abs);
  let out = '';
  try {
    out = await git([
      'log', `-${limit}`, '--format=%H%x1f%at%x1f%s', '--', rel,
    ]);
  } catch { return []; }
  return out.split('\n').filter(Boolean).map((line) => {
    const [sha, at, subject] = line.split('\x1f');
    return { sha, at: Number(at) * 1000, subject };
  });
}

export async function contentAt(abs, sha) {
  const rel = historyRelPath(abs);
  try {
    return await git(['show', `${sha}:${rel}`]);
  } catch {
    throw Object.assign(new Error('that version does not contain this file'), { status: 404 });
  }
}

export async function diffAgainst(abs, sha) {
  const rel = historyRelPath(abs);
  try {
    return await git(['diff', '--no-color', `${sha}`, 'HEAD', '--', rel]);
  } catch {
    return '';
  }
}

export async function repoStats() {
  try {
    await ensureRepo();
    const count = (await git(['rev-list', '--count', 'HEAD'])).trim();
    const last = (await git(['log', '-1', '--format=%at%x1f%s'])).trim().split('\x1f');
    return {
      path: tilde(HISTORY_REPO),
      commits: Number(count),
      lastAt: Number(last[0]) * 1000,
      lastSubject: last[1] ?? '',
    };
  } catch {
    return { path: tilde(HISTORY_REPO), commits: 0 };
  }
}
