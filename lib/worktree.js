import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HOME, currentRoots, realpathNearest, tilde } from './paths.js';

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
  const common = await gitCommonOf(dir);
  return common ? path.dirname(common) : null;
}

/** The repo's git common dir (`.git`, shared by every worktree), as wtinit computes it. */
async function gitCommonOf(dir) {
  try {
    const { stdout } = await exec('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    return stdout.trim();
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

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * One setting from the toolkit's template, exactly as wt.zsh's _wt_tmpl_val
 * reads it: the first `NAME=` line, quotes dropped, {key} and {parent}
 * substituted. Null when the template or the line is missing or empty.
 */
function templateValue(name, key, parent) {
  let text;
  try { text = fs.readFileSync(path.join(WT_HOME, 'defaults.conf'), 'utf8'); } catch { return null; }
  const line = text.split('\n').find((l) => l.startsWith(`${name}=`));
  if (line === undefined) return null;
  const v = line.slice(name.length + 1).replace(/"/g, '').split('{key}').join(key).split('{parent}').join(parent);
  return v || null;
}

/**
 * Where `wtinit` will write for this request, computed here by its own rule
 * (wt.zsh wtinit: --trunk/--root, else the template, else <parent>/<key>-trunk
 * and <parent>/<key>-wt, relative to the main checkout). initProject then
 * hands these to wtinit explicitly, so what was authorized is what is used.
 */
async function plannedDestinations({ repoPath, key, trunk, root }) {
  const gitCommon = await gitCommonOf(repoPath);
  if (!gitCommon) return null;
  const primary = path.dirname(gitCommon);
  const parent = path.dirname(primary);
  const pick = (given, name, fallback) => path.resolve(primary, given || templateValue(name, key, parent) || fallback);
  return {
    primary, gitCommon,
    trunk: pick(trunk, 'TRUNK', path.join(parent, `${key}-trunk`)),
    root: pick(root, 'ROOT', path.join(parent, `${key}-wt`)),
  };
}

/**
 * "Read" means ACS never writes there, and `wtinit` writes a trunk, a
 * .worktrees.conf and a worktrees folder. So a project in a read folder — by
 * the path given, its main checkout, or any destination wtinit would write,
 * explicit or from the template — is refused, with the command to run it from
 * a terminal instead. Every path is judged where it really is: a destination
 * that does not exist yet by its nearest existing ancestor's realpath, so a
 * link to a read folder is no way in. Edit folders and paths outside every
 * folder are unchanged.
 */
/**
 * Every filesystem write `wtinit` can make for an ACS request (it is always
 * given --key, --root and --trunk; never --register), by tools/worktree/wt.zsh
 * line:
 *
 *   1486  git worktree add TRUNK  creates TRUNK, its checkout and TRUNK/.git, and
 *                                <git-common>/worktrees/<id>/ (HEAD, index, gitdir…)
 *   1489  git checkout -B BRANCH  files under TRUNK; <git-common>/refs/heads/BRANCH,
 *                                logs/…, packed-refs, config (the upstream)
 *   1494  mkdir -p ROOT
 *   1501, 1513, 1523             TRUNK/.worktrees.conf, truncated then appended
 *   1531  mkdir -p <git-common>/info
 *   1534  >> <git-common>/info/exclude
 *   1563, 1567                   mkdir -p WT_HOME/repos; WT_HOME/repos/<key>.conf
 *                                (the same write from 1427, 1433 and 1448, when the
 *                                project is already configured and only registered)
 *
 * Each named destination is resolved by realpathNearest — links, dangling ones
 * included, followed the way the kernel follows them — and refused if it lands
 * in a read root. Inside <git-common> the leaf names (the worktree id, the
 * branch) are git's choice, so that directory is judged as a whole: it must
 * itself resolve outside every read root, and no link anywhere in it (bar
 * objects/, which none of these commands writes) may lead into one. Then
 * every write there lands inside it. TRUNK, when wtinit creates it, is a new
 * real directory, and git never writes through a link inside a checkout.
 *
 * Code wtinit runs, whose writes no list can predict, is closed where it can
 * be and accepted where it cannot:
 *   - git hooks (post-checkout, at 1486 and 1489): switched off (initEnv).
 *   - ~/.zshenv: not read (initProject runs `zsh -f`).
 *   - ACCEPTED LIMIT (Cris, 2026-10-04): git filters and other config-driven
 *     commands during the checkout (smudge, LFS), and sourcing an existing
 *     .worktrees.conf at 1426 / 1447 when a configured project is registered
 *     with --cmd. Both are the user's own code in a repo they chose — the same
 *     trust as running wtinit in a terminal.
 */
function writeSites(plan, key) {
  return [
    ['the trunk (wt.zsh 1486, 1489)', plan.trunk],
    ['the worktrees folder (1494)', plan.root],
    ['the trunk\'s .worktrees.conf (1501, 1513, 1523)', path.join(plan.trunk, '.worktrees.conf')],
    ['the git folder (1486, 1489, 1531, 1534)', plan.gitCommon],
    ['git\'s info folder (1531)', path.join(plan.gitCommon, 'info')],
    ['git\'s info/exclude (1534)', path.join(plan.gitCommon, 'info', 'exclude')],
    ['the worktree registry (1563)', REPOS],
    [`the registration repos/${key}.conf (1567)`, path.join(REPOS, `${key}.conf`)],
  ];
}

/** Every link inside the git common dir (objects/ aside), for writeSites' whole-directory rule. */
function linksWithin(dir, limit = 50_000) {
  const out = [];
  let seen = 0;
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (++seen > limit) throw Object.assign(new Error(`too many entries to check in ${tilde(dir)}`), { status: 403 });
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) out.push(p);
      else if (e.isDirectory() && !(d === dir && e.name === 'objects')) walk(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * Cris, 2026-10-04: ACS does not set up worktrees for a repo that contains
 * symlinks, rather than chase every place a link can redirect a write. Two
 * places count:
 *   - the commits wtinit could check out (wt.zsh 1458-1481 picks BASE from
 *     --base, else origin/staging, origin/main or origin/master, else the
 *     current branch or HEAD). The pick depends on remote state, so every
 *     candidate that exists is checked: any tree entry of mode 120000 refuses.
 *     A candidate that does not resolve to a commit has nothing to check out.
 *   - the repo's .git (dir or file) and its git common dir, walked in full
 *     with lstat, objects/ included, nothing skipped: any link refuses.
 */
const SYMLINK_MODE = '120000';
async function commitHasSymlink(primary, ref) {
  let commit;
  try { commit = (await exec('git', ['-C', primary, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).stdout.trim(); }
  catch { return false; }
  const { stdout } = await exec('git', ['-C', primary, 'ls-tree', '-r', '-z', '--full-tree', commit], { maxBuffer: 256 * 1024 * 1024 });
  return stdout.split('\0').some((line) => line.startsWith(`${SYMLINK_MODE} `));
}
function linkUnder(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return null; }
  if (st.isSymbolicLink()) return p;
  if (!st.isDirectory()) return null;
  let ents;
  try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { return p; }
  for (const e of ents) {
    const found = linkUnder(path.join(p, e.name));
    if (found) return found;
  }
  return null;
}
export async function refuseSymlinkedRepos({ repoPath, key, base } = {}, plan = undefined) {
  if (typeof repoPath !== 'string' || !repoPath || !isDir(repoPath) || !NAME.test(key || '')) return;
  plan ??= await plannedDestinations({ repoPath, key });
  if (!plan) return;
  const refuse = (why) => {
    throw Object.assign(new Error(
      `This repo contains symlinks, so ACS won't set up worktrees for it — run in a terminal: cd ${shellQuote(path.resolve(repoPath))} && wtinit --key ${key} (${why})`,
    ), { status: 403 });
  };
  for (const p of new Set([path.join(path.resolve(repoPath), '.git'), path.join(plan.primary, '.git'), plan.gitCommon])) {
    const found = linkUnder(p);
    if (found) refuse(`link at ${tilde(found)}`);
  }
  let branch = '';
  try { branch = (await exec('git', ['-C', plan.primary, 'branch', '--show-current'])).stdout.trim(); } catch {}
  const refs = base ? [base] : ['origin/staging', 'origin/main', 'origin/master', ...(branch ? [branch] : []), 'HEAD'];
  for (const ref of refs) {
    if (await commitHasSymlink(plan.primary, ref)) refuse(`${ref} has a symlink in its tree`);
  }
}

export async function refuseReadRoots({ repoPath, key, root, trunk } = {}, plan = undefined) {
  const read = currentRoots().readRoots;
  if (!read.length) return;
  const candidates = [repoPath, root, trunk].filter((p) => typeof p === 'string' && p && path.isAbsolute(p));
  if (typeof repoPath === 'string' && repoPath && isDir(repoPath) && NAME.test(key || '')) {
    plan ??= await plannedDestinations({ repoPath, key, trunk, root });
    if (plan) {
      candidates.push(plan.primary, ...writeSites(plan, key).map(([, p]) => p));
      if (isDir(plan.gitCommon)) candidates.push(...linksWithin(plan.gitCommon));
    }
  }
  for (const c of candidates) {
    let abs;
    // A path whose destination cannot be worked out is not authorized.
    try { abs = realpathNearest(c); }
    catch (e) { throw Object.assign(new Error(`${tilde(path.resolve(c))}: cannot tell where it leads (${e.message}) — refusing`), { status: 403 }); }
    if (read.some((r) => abs === r || abs.startsWith(r + path.sep))) {
      // The absolute path, single-quoted: a quoted ~ would not expand.
      const where = typeof repoPath === 'string' && repoPath ? path.resolve(repoPath) : abs;
      throw Object.assign(new Error(
        `${tilde(abs)} is in a read-only folder — the studio never writes there. ` +
        `To set up worktrees for it, run in a terminal: cd ${shellQuote(where)} && wtinit --key ${NAME.test(key || '') ? key : '<key>'}`,
      ), { status: 403 });
    }
  }
}

/**
 * The environment wtinit runs in. WT_HOME is pinned to the one whose template
 * plannedDestinations read. Git hooks are switched off for every git call
 * inside it: a post-checkout hook runs on `worktree add` and `checkout -B`,
 * can write anywhere, and cannot be authorized in advance. Command-line-scope
 * config (GIT_CONFIG_COUNT/KEY_n/VALUE_n) outranks a repo's own core.hooksPath
 * and the default .git/hooks (verified with git 2.50 before relying on it, and
 * by tests/roots-worktree-init.mjs). Appended after any pairs already set.
 */
function initEnv() {
  const env = { ...process.env, WT_HOME };
  const n = Number.parseInt(env.GIT_CONFIG_COUNT, 10) || 0;
  env[`GIT_CONFIG_KEY_${n}`] = 'core.hooksPath';
  env[`GIT_CONFIG_VALUE_${n}`] = '/dev/null';
  env.GIT_CONFIG_COUNT = String(n + 1);
  return env;
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

  // The destinations are decided here and passed explicitly, after the
  // read-folder check has seen them — never computed by the toolkit later.
  const plan = await plannedDestinations({ repoPath, key, trunk, root });
  await refuseReadRoots({ repoPath, key, root, trunk }, plan);
  await refuseSymlinkedRepos({ repoPath, key, base }, plan);

  const args = ['--key', key];
  if (cmd) args.push('--cmd', cmd);
  if (base) args.push('--base', base);
  args.push('--root', plan.root, '--trunk', plan.trunk);

  const script = 'source "$1" || exit 1; cd "$2" || exit 1; wtinit "${@:3}"';
  try {
    const { stdout, stderr } = await exec(
      // -f: no ~/.zshenv — nothing but the toolkit runs. See initEnv for git.
      'zsh', ['-f', '-c', script, 'wtinit', WT_LIB, primary, ...args],
      { timeout: 120000, maxBuffer: 1024 * 1024, env: initEnv() },
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
