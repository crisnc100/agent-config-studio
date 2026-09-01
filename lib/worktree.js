import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HOME, PROJECTS, tilde } from './paths.js';

const exec = promisify(execFile);

export const WT_HOME = path.join(HOME, '.config', 'worktree');
const WT_LIB = path.join(WT_HOME, 'wt.zsh');
const REPOS = path.join(WT_HOME, 'repos');

/** Registered projects are not confined to SAFE_ROOTS — Kylie and Stella live
 *  outside ~/Documents/Projects, and registering them is the point. */
const EXTRA_SCAN = [path.join(HOME, 'Documents', 'Garman-Homes')];

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const REF = /^[A-Za-z0-9._\/-]{1,64}$/;

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

/** The primary worktree of the repo containing `dir`, or null. */
async function primaryOf(dir) {
  try {
    const { stdout } = await exec('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    return path.dirname(stdout.trim());
  } catch { return null; }
}

export function listRegistered() {
  let files = [];
  try { files = fs.readdirSync(REPOS).filter((f) => f.endsWith('.conf')); } catch {}
  return files.map((f) => {
    const text = fs.readFileSync(path.join(REPOS, f), 'utf8');
    const get = (k) => (text.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] || '').replace(/"/g, '');
    const trunk = get('TRUNK');
    return { key: f.replace(/\.conf$/, ''), cmd: get('CMD'), trunk, display: tilde(trunk), exists: isDir(trunk) };
  }).sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Git repos that could be registered but are not yet. Scans one level deep —
 * deep enough for Projects/personal and Garman-Homes/05-Development, shallow
 * enough not to walk node_modules.
 */
export async function listCandidates() {
  const seen = new Set();
  const out = [];
  const roots = [PROJECTS, ...EXTRA_SCAN].filter(isDir);

  const consider = async (dir) => {
    if (!isDir(path.join(dir, '.git'))) return;
    const primary = await primaryOf(dir);
    if (!primary || seen.has(primary)) return;
    seen.add(primary);
    out.push({ path: primary, display: tilde(primary), name: path.basename(primary) });
  };

  const walk = async (root, depth) => {
    if (depth > 2) return;
    let ents = [];
    try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const abs = path.join(root, e.name);
      await consider(abs);
      await walk(abs, depth + 1);
    }
  };

  for (const r of roots) { await consider(r); await walk(r, 0); }

  // Drop repos already registered, comparing by the trunk's own repo.
  const registeredRepos = new Set();
  for (const r of listRegistered()) {
    if (!r.exists) continue;
    const p = await primaryOf(r.trunk);
    if (p) registeredRepos.add(p);
  }
  return out.filter((c) => !registeredRepos.has(c.path)).sort((a, b) => a.display.localeCompare(b.display));
}

/** Branches this repo could sensibly be based on, best guess first. */
export async function listBases(repoPath) {
  const primary = await primaryOf(repoPath);
  if (!primary) throw new Error('not a git repository');
  let head = '';
  try {
    const { stdout } = await exec('git', ['-C', primary, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    head = stdout.trim().replace('refs/remotes/', '');
  } catch {}
  const out = [];
  for (const b of ['main', 'master', 'staging', 'develop']) {
    try {
      await exec('git', ['-C', primary, 'rev-parse', '--verify', '--quiet', `origin/${b}`]);
      out.push(`origin/${b}`);
    } catch {}
  }
  // origin/HEAD is what the remote itself considers default — lead with it.
  if (head && out.includes(head)) out.splice(out.indexOf(head), 1);
  if (head) out.unshift(head);
  return { primary, display: tilde(primary), bases: out, suggested: head || out[0] || '' };
}

/**
 * Run `wtinit` for a project. Arguments are passed positionally, never
 * interpolated into a command string — this endpoint takes a filesystem path
 * from a request body, and building a shell string from that is how a page in
 * another tab gets to run commands.
 */
export async function initProject({ repoPath, key, cmd, base, root, trunk }) {
  if (!fs.existsSync(WT_LIB)) throw new Error(`worktree toolkit not installed at ${tilde(WT_LIB)}`);
  if (!repoPath || !isDir(repoPath)) throw new Error('repoPath is not a directory');
  const primary = await primaryOf(repoPath);
  if (!primary) throw new Error(`${tilde(repoPath)} is not a git repository`);
  if (!NAME.test(key || '')) throw new Error('key must be lowercase letters, numbers and hyphens');
  if (cmd && !NAME.test(cmd)) throw new Error('command prefix must be lowercase letters, numbers and hyphens');
  if (base && !REF.test(base)) throw new Error('base is not a valid ref name');
  for (const [label, p] of [['root', root], ['trunk', trunk]]) {
    if (p && !path.isAbsolute(p)) throw new Error(`${label} must be an absolute path`);
  }

  const args = ['--key', key];
  if (cmd) args.push('--cmd', cmd);
  if (base) args.push('--base', base);
  if (root) args.push('--root', root);
  if (trunk) args.push('--trunk', trunk);

  const script = 'source "$1" || exit 1; cd "$2" || exit 1; wtinit "${@:3}"';
  try {
    const { stdout, stderr } = await exec(
      'zsh', ['-c', script, 'wtinit', WT_LIB, primary, ...args],
      { timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    return { ok: true, output: (stdout + stderr).trim(), registered: listRegistered() };
  } catch (e) {
    const msg = ((e.stdout || '') + (e.stderr || '') || e.message).trim();
    throw new Error(msg || 'wtinit failed');
  }
}
