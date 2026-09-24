/**
 * A throwaway machine for the worktree suites: temp HOME, and every other
 * place the toolkit, git, gh or direnv could read or write redirected into it
 * — WT_HOME, ZDOTDIR, the four XDG dirs (direnv keeps its allow list under
 * XDG_DATA_HOME), a global git config, no system git config.
 *
 * The environment is built from nothing rather than copied from this process,
 * so a WT_HOME, GH_REPO, GIT_DIR or CODEX_HOME exported in the developer's
 * terminal cannot reach a test. PATH is system directories plus two sandbox
 * dirs: `shim/` (a `gh` stub and a logging `git` wrapper) and `tools/`
 * (direnv, linked in when installed). The real gh is never on it, so
 * "gh missing" is just dropping `shim/gh`.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TOOLKIT = path.join(ROOT, 'tools', 'worktree');

const which = (bin) => {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};
export const ZSH = fs.existsSync('/bin/zsh') ? '/bin/zsh' : which('zsh');
export const DIRENV = which('direnv');
const GIT = which('git');

/** Fail loudly, never pass silently, when the toolkit cannot even run here. */
export function requireZsh(suite) {
  if (ZSH) return;
  console.log(`\n${suite}\n  SKIP zsh is not installed — the worktree toolkit is zsh; NOTHING in this suite was checked\n`);
  process.exit(0);
}

const GH_STUB = `#!${process.execPath}
// gh stub: \`gh pr list --repo R --state merged --head B --json ... --limit N\`,
// answered from $WT_TEST_GH (a JSON file { "<branch>": [ ...prs ] | "fail" }).
// Every call is appended to $WT_TEST_GH_LOG with the GH_REPO it saw.
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.WT_TEST_GH_LOG, JSON.stringify({ argv: a, GH_REPO: process.env.GH_REPO ?? null, GIT_OPTIONAL_LOCKS: process.env.GIT_OPTIONAL_LOCKS ?? null }) + '\\n');
const at = (f) => (a.indexOf(f) >= 0 ? a[a.indexOf(f) + 1] : undefined);
if (a[0] !== 'pr' || a[1] !== 'list' || at('--state') !== 'merged' || !at('--head') || !at('--repo')) {
  process.stderr.write('stub: unexpected call ' + a.join(' ') + '\\n'); process.exit(2);
}
const table = JSON.parse(fs.readFileSync(process.env.WT_TEST_GH, 'utf8'));
const prs = table[at('--head')] ?? [];
if (prs === 'fail') { process.stderr.write('HTTP 401: Bad credentials (https://api.github.com/graphql)\\n'); process.exit(1); }
const fields = at('--json').split(',');
const out = prs.map((p) => Object.fromEntries(fields.sort().filter((f) => f in p).map((f) => [f, p[f]])));
process.stdout.write(table.__pretty ? JSON.stringify(out, null, 2) + '\\n' : JSON.stringify(out) + '\\n');
`;

// Logs every git call, then runs the real one. Fault hooks, for the removal
// races only: WT_TEST_FAIL_REMOVE makes \`worktree remove\` fail;
// WT_TEST_MOVE_BRANCH=<branch> advances that branch the moment a removal
// succeeds (before its tip is read); WT_TEST_ADVANCE_ON_DELETE=<branch>
// advances it at the delete itself — after the tip was read and checked.
// Both move it to $WT_TEST_MOVE_TO.
const gitShim = (git) => `#!/bin/sh
printf '%s\\n' "$*" >> "$WT_TEST_GIT_LOG"
case " $* " in
  *" worktree remove "*)
    if [ -n "$WT_TEST_FAIL_REMOVE" ]; then echo "fatal: simulated removal failure" >&2; exit 1; fi
    if [ -n "$WT_TEST_MOVE_BRANCH" ]; then
      ${git} "$@" || exit $?
      ${git} -C "$WT_TEST_TRUNK" update-ref "refs/heads/$WT_TEST_MOVE_BRANCH" "$(${git} -C "$WT_TEST_TRUNK" rev-parse "$WT_TEST_MOVE_TO")"
      exit 0
    fi
    ;;
  *" branch -D $WT_TEST_ADVANCE_ON_DELETE "*|*" update-ref -d refs/heads/$WT_TEST_ADVANCE_ON_DELETE "*)
    if [ -n "$WT_TEST_ADVANCE_ON_DELETE" ]; then
      ${git} -C "$WT_TEST_TRUNK" update-ref "refs/heads/$WT_TEST_ADVANCE_ON_DELETE" "$(${git} -C "$WT_TEST_TRUNK" rev-parse "$WT_TEST_MOVE_TO")"
    fi
    ;;
esac
exec ${git} "$@"
`;

export function sandbox(name) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `acs-wt-${name}-`)));
  const home = path.join(root, 'home');
  const shim = path.join(root, 'shim');
  const tools = path.join(root, 'tools');
  for (const d of [home, shim, tools, path.join(root, 'zsh-tmp')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(shim, 'gh'), GH_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(shim, 'git'), gitShim(GIT), { mode: 0o755 });
  if (DIRENV) fs.symlinkSync(DIRENV, path.join(tools, 'direnv'));
  const ghTable = path.join(root, 'gh.json');
  fs.writeFileSync(ghTable, '{}');
  const env = {
    PATH: [shim, tools, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: home,
    WT_HOME: path.join(home, '.config', 'worktree'),
    ZDOTDIR: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    DIRENV_CONFIG: path.join(home, '.config', 'direnv'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_TERMINAL_PROMPT: '0',
    TMPDIR: os.tmpdir(),
    // zsh writes here-strings to $TMPPREFIX* (default /tmp/zsh); kept in the sandbox too.
    TMPPREFIX: path.join(root, 'zsh-tmp', 'zsh'),
    LANG: 'en_US.UTF-8',
    TERM: 'dumb',
    WT_TEST_GH: ghTable,
    WT_TEST_GH_LOG: path.join(root, 'gh.log'),
    WT_TEST_GIT_LOG: path.join(root, 'git.log'),
  };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n');
  fs.mkdirSync(env.WT_HOME, { recursive: true });
  for (const f of ['wt.zsh', 'defaults.conf']) fs.copyFileSync(path.join(TOOLKIT, f), path.join(env.WT_HOME, f));

  const sb = {
    root, home, env,
    /** Every output any toolkit command printed, for the never-print-a-secret check. */
    outputs: [],
    git(cwd, ...args) {
      const r = spawnSync(GIT, args, { cwd, env, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} (in ${cwd}): ${r.stderr}`);
      return r.stdout.trim();
    },
    /** zsh with the toolkit sourced, in `cwd`; `script` runs after. */
    zsh(cwd, script, { input, extraEnv } = {}) {
      const r = spawnSync(ZSH, ['-f', '-c', `source "$WT_HOME/wt.zsh" || exit 99\n${script}`], {
        cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', input: input ?? '',
      });
      const out = (r.stdout || '') + (r.stderr || '');
      sb.outputs.push(out);
      return { code: r.status, out, stdout: r.stdout || '', stderr: r.stderr || '' };
    },
    /** The same, started in the background: resolves when `until` shows in its stdout. */
    zshLive(cwd, script, extraEnv = {}) {
      const child = spawn(ZSH, ['-f', '-c', `source "$WT_HOME/wt.zsh" || exit 99\n${script}`], {
        cwd, env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      const waiters = [];
      const onData = (d) => { out += d; for (const w of waiters.splice(0)) w(); };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const exited = new Promise((res) => child.on('close', (code) => { sb.outputs.push(out); res(code); }));
      return {
        child,
        get out() { return out; },
        async until(text, ms = 15000) {
          const t0 = Date.now();
          while (!out.includes(text)) {
            if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${JSON.stringify(text)}; got: ${out}`);
            await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
          }
        },
        exited,
      };
    },
    gh(table) { fs.writeFileSync(ghTable, JSON.stringify(table)); },
    ghCalls() {
      try { return fs.readFileSync(env.WT_TEST_GH_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
    },
    gitLog() { try { return fs.readFileSync(env.WT_TEST_GIT_LOG, 'utf8'); } catch { return ''; } },
    noGh() { fs.rmSync(path.join(shim, 'gh'), { force: true }); },
    restoreGh() { fs.writeFileSync(path.join(shim, 'gh'), GH_STUB, { mode: 0o755 }); },
    cleanup() {
      spawnSync('/bin/chmod', ['-R', 'u+rwX', root]);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  return sb;
}

/**
 * A project the way wtinit leaves one: a local bare origin that the repo
 * believes is https://github.com/acme/app (insteadOf routes fetches to the
 * bare repo, and the configured URL is what gh is asked about), a primary
 * clone at <root>/proj/app, a trunk at <root>/proj/app-trunk on main, and
 * `.env` gitignored with a planted secret in the trunk.
 */
export function project(sb, { envFiles, secret = 'ACS_PLANTED_SECRET_7f3a9c', cmd } = {}) {
  const origin = path.join(sb.root, 'origin.git');
  const scratch = path.join(sb.root, 'scratch');
  const primary = path.join(sb.root, 'proj', 'app');
  const url = 'https://github.com/acme/app.git';
  fs.mkdirSync(path.dirname(primary), { recursive: true });
  sb.git(sb.root, 'init', '-q', '--bare', origin);
  sb.git(sb.root, 'config', '--global', `url.${origin}.insteadOf`, url);
  sb.git(sb.root, 'clone', '-q', url, scratch);
  fs.writeFileSync(path.join(scratch, '.gitignore'), '.env\n.env.*\n!.env.example\nsub/.env\nnode_modules/\n');
  fs.writeFileSync(path.join(scratch, 'README.md'), 'app\n');
  fs.writeFileSync(path.join(scratch, 'app.txt'), 'one\n');
  sb.git(scratch, 'add', '.');
  sb.git(scratch, 'commit', '-q', '-m', 'init');
  sb.git(scratch, 'push', '-q', 'origin', 'HEAD:main');
  sb.git(sb.root, 'clone', '-q', url, primary);
  const init = sb.zsh(primary, `wtinit${cmd ? ` --cmd ${cmd}` : ''}`);
  if (init.code !== 0) throw new Error(`wtinit failed: ${init.out}`);
  const trunk = path.join(sb.root, 'proj', 'app-trunk');
  const conf = path.join(trunk, '.worktrees.conf');
  if (envFiles) {
    const text = fs.readFileSync(conf, 'utf8').replace(/^ENV_FILES=.*$/m, `ENV_FILES=${envFiles}`);
    fs.writeFileSync(conf, text);
  }
  fs.writeFileSync(path.join(trunk, '.env'), `API_KEY=${secret}\n`);
  return {
    origin, scratch, primary, trunk, conf, secret, root: path.dirname(trunk),
    wt: (name) => path.join(path.dirname(trunk), `app-${name}`),
    /** Squash-merge `branch` into main on origin, the way GitHub's button does. */
    squash(branch, title = branch) {
      sb.git(scratch, 'fetch', '-q', 'origin');
      sb.git(scratch, 'checkout', '-q', '-B', 'main', 'origin/main');
      sb.git(scratch, 'merge', '--squash', '-q', `origin/${branch}`);
      sb.git(scratch, 'commit', '-q', '-m', `${title} (#1)`);
      sb.git(scratch, 'push', '-q', 'origin', 'main');
    },
    /** Advance main on origin with an unrelated commit. */
    advance(file = 'other.txt') {
      sb.git(scratch, 'fetch', '-q', 'origin');
      sb.git(scratch, 'checkout', '-q', '-B', 'main', 'origin/main');
      fs.writeFileSync(path.join(scratch, file), `${Date.now()}\n`);
      sb.git(scratch, 'add', file);
      sb.git(scratch, 'commit', '-q', '-m', `touch ${file}`);
      sb.git(scratch, 'push', '-q', 'origin', 'main');
    },
    fetch() { sb.git(trunk, 'fetch', '-q', 'origin'); },
  };
}

/** A realistic `gh pr list --json` row: gh's field names and shapes, including the owner object. */
export const pr = (number, headRefOid, { owner = 'acme', base = 'main' } = {}) => ({
  number,
  headRefOid,
  headRepositoryOwner: { id: owner === 'acme' ? 'O_kgDOBwJ8Pg' : 'MDQ6VXNlcjE2NjI2NTM=', login: owner },
  baseRefName: base,
  mergedAt: '2026-09-20T15:04:05Z',
});

export const tests = () => {
  let pass = 0, fail = 0;
  const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 1500)}` : ''}`); }
  };
  const done = () => { console.log(`\n${pass} passed, ${fail} failed\n`); process.exit(fail === 0 ? 0 : 1); };
  return { ok, done };
};
