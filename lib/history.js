import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HISTORY_REPO, historyRelPath, tilde } from './paths.js';
import { buildRegistry } from './registry.js';

const exec = promisify(execFile);

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

function mirror(abs) {
  const rel = historyRelPath(abs);
  const dest = path.join(HISTORY_REPO, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(abs, dest);
  return rel;
}

async function commit(message) {
  await git(['add', '-A']);
  const status = await git(['status', '--porcelain']);
  if (!status.trim()) return null;
  await git(['commit', '-q', '-m', message]);
  return (await git(['rev-parse', 'HEAD'])).trim();
}

/** Copy every registered file into the shadow repo and commit the lot. */
export async function snapshotAll(message = 'snapshot') {
  const { groups } = buildRegistry();
  let n = 0;
  for (const g of groups) {
    for (const e of g.entries) {
      for (const f of e.files) {
        try { mirror(f.path); n++; } catch {}
      }
    }
  }
  const sha = await commit(`${message} (${n} files)`);
  return { sha, files: n };
}

/** Record one file's new contents as a commit. */
export async function record(abs, message) {
  await ensureRepo();
  mirror(abs);
  const sha = await commit(message);
  return sha;
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
