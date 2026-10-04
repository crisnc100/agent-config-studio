import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HOME, currentRoots, tilde } from './paths.js';

const exec = promisify(execFile);

export const WT_HOME = path.join(HOME, '.config', 'worktree');
const WT_LIB = path.join(WT_HOME, 'wt.zsh');
const REPOS = path.join(WT_HOME, 'repos');

/** Registered projects are not confined to the safe roots — some live outside
 *  every project folder, and registering them is the point. Discovery scans
 *  every folder in roots.json, read ones included. */

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
 * deep enough for <folder>/personal or <folder>/05-Development, shallow
 * enough not to walk node_modules.
 */
export async function listCandidates() {
  const seen = new Set();
  const out = [];
  const roots = currentRoots().allRoots;

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
 * "Read" means ACS never writes there, and `wtinit` writes a trunk, a
 * .worktrees.conf and a registry entry. So a project in a read folder — by
 * the path given, its main checkout, or the root/trunk it would write — is
 * refused here, with the command to run it from a terminal instead. Edit
 * folders and paths outside every folder are unchanged.
 */
export async function refuseReadRoots({ repoPath, key, root, trunk } = {}) {
  const read = currentRoots().readRoots;
  if (!read.length) return;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const candidates = [repoPath, root, trunk].filter((p) => typeof p === 'string' && p);
  if (typeof repoPath === 'string' && repoPath && isDir(repoPath)) {
    const primary = await primaryOf(repoPath);
    if (primary) candidates.push(primary);
  }
  for (const c of candidates) {
    const abs = real(c);
    if (read.some((r) => abs === r || abs.startsWith(r + path.sep))) {
      const where = tilde(typeof repoPath === 'string' && repoPath ? repoPath : abs);
      throw Object.assign(new Error(
        `${tilde(abs)} is in a read-only folder — the studio never writes there. ` +
        `To set up worktrees for it, run in a terminal: cd ${JSON.stringify(where)} && wtinit --key ${NAME.test(key || '') ? key : '<key>'}`,
      ), { status: 403 });
    }
  }
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

/**
 * What the read-only panel shows for a project: its worktrees with branch,
 * env summary and cleanup verdict. Computed by the toolkit itself — `wls
 * --json` and `wclean --json --no-fetch` — so the rules exist once, in
 * wt.zsh, and ACS never parses shell config.
 *
 * Both scripts are literals; the only values passed in are the toolkit path
 * and a trunk read from repos/, as positional arguments. `-f` keeps the
 * user's startup files out; GH_REPO and the git repository overrides are
 * dropped so neither can point a query at another repository. No fetch: a
 * GET must not move refs, and a stale BASE only ever hides a done worktree.
 */
const STATUS_MS = Number(process.env.ACS_WORKTREE_STATUS_MS) || 20000;   // env: tests only
const STATUS_BYTES = 1024 * 1024;
const STATUS_PARALLEL = 4;
const WLS_SCRIPT = 'source "$1" || exit 1; cd "$2" || exit 1; wls --json';
const WCLEAN_SCRIPT = 'source "$1" || exit 1; cd "$2" || exit 1; wclean --json --no-fetch';
const STRIPPED_ENV = ['GH_REPO', 'GH_HOST', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'];

function toolkitEnv() {
  // GIT_OPTIONAL_LOCKS=0: a status read never refreshes (writes) an index.
  const env = { ...process.env, WT_HOME, GH_PROMPT_DISABLED: '1', GIT_OPTIONAL_LOCKS: '0' };
  for (const k of STRIPPED_ENV) delete env[k];
  return env;
}

async function toolkitJson(script, trunk) {
  let stdout;
  try {
    ({ stdout } = await exec('zsh', ['-f', '-c', script, 'wt', WT_LIB, trunk], {
      cwd: trunk, env: toolkitEnv(), timeout: STATUS_MS, maxBuffer: STATUS_BYTES,
    }));
  } catch (e) {
    if (e.killed || e.signal) throw new Error(`timed out after ${STATUS_MS / 1000}s`);
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('toolkit output too large');
    throw new Error(((e.stdout || '') + (e.stderr || '')).trim().split('\n')[0] || e.message);
  }
  try { return JSON.parse(stdout); } catch {
    throw new Error(`toolkit output not understood — update it: ./bin/acs install-worktree`);
  }
}

// No `~` in the safe set: inside quotes it is literal, so a command built
// for pasting uses the absolute path, never the display form.
const shq = (s) => (/^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** One registered project's panel, or `status: 'unknown'` with the reason. Never throws for a known key. */
export async function projectStatus(key) {
  const reg = listRegistered().find((r) => r.key === key);
  if (!reg) {
    const e = new Error(`no registered project "${String(key).slice(0, 40)}"`);
    e.status = 404;
    throw e;
  }
  const base = { key: reg.key, cmd: reg.cmd, trunk: reg.trunk, display: reg.display };
  const removeCmd = reg.cmd ? `${reg.cmd}clean --remove` : `cd ${shq(reg.trunk)} && wclean --remove`;
  if (!fs.existsSync(WT_LIB)) return { ...base, status: 'unknown', error: `worktree toolkit not installed at ${tilde(WT_LIB)}`, worktrees: [] };
  if (!reg.exists) return { ...base, status: 'unknown', error: `trunk ${reg.display} does not exist`, worktrees: [] };
  try {
    const [ls, clean] = await Promise.all([toolkitJson(WLS_SCRIPT, reg.trunk), toolkitJson(WCLEAN_SCRIPT, reg.trunk)]);
    if (!Array.isArray(ls.worktrees) || !Array.isArray(clean.worktrees)) throw new Error('toolkit output not understood — update it: ./bin/acs install-worktree');
    const verdicts = new Map(clean.worktrees.map((w) => [w.path, w]));
    const worktrees = ls.worktrees.map((w) => {
      const v = verdicts.get(w.path);
      return {
        path: w.path, display: tilde(w.path), name: w.name, branch: w.branch, trunk: w.trunk, offBook: w.offBook,
        port: w.port || null, dirty: w.dirty, env: w.env, envrc: w.envrc || null,
        files: (w.files || []).map((f) => ({ file: f.file, state: f.state })),
        verdict: v ? { status: v.status, reason: v.reason, via: v.via || null } : { status: 'unknown', reason: 'no verdict' },
        removeCmd: v?.status === 'done' ? removeCmd : null,
      };
    });
    return { ...base, status: 'ok', base: ls.base, notes: clean.notes || [], worktrees };
  } catch (e) {
    return { ...base, status: 'unknown', error: e.message, worktrees: [] };
  }
}

/** Every registered project's panel, a few at a time. */
export async function allProjectStatus() {
  const keys = listRegistered().map((r) => r.key);
  const out = new Array(keys.length);
  let next = 0;
  const worker = async () => {
    while (next < keys.length) {
      const i = next++;
      out[i] = await projectStatus(keys[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(STATUS_PARALLEL, keys.length) }, worker));
  return out;
}
