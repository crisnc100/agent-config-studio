/**
 * `acs` fast-forwards a clean checkout on the default branch before starting,
 * so a merge followed by `acs` runs the merged code. Exercised through
 * `acs update`, which runs the same step without starting the studio, against
 * throwaway repos: a bare origin, the checkout under test, and a second clone
 * that pushes the "merge".
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ACS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'acs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-update-'));
const env = {
  ...process.env, HOME: tmp, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  ACS_NO_UPDATE: '',
};

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const acs = (cwd, extra = {}) => {
  try {
    return { code: 0, out: execFileSync(path.join(cwd, 'bin', 'acs'), ['update'], { env: { ...env, ...extra }, encoding: 'utf8' }) };
  } catch (e) { return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` }; }
};

// origin with one commit holding this launcher, cloned twice.
const origin = path.join(tmp, 'origin.git');
const seed = path.join(tmp, 'seed');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
fs.mkdirSync(path.join(seed, 'bin'), { recursive: true });
git(seed, 'init', '-q', '-b', 'main');
fs.copyFileSync(ACS, path.join(seed, 'bin', 'acs'));
fs.chmodSync(path.join(seed, 'bin', 'acs'), 0o755);
fs.writeFileSync(path.join(seed, 'app.txt'), 'v1\n');
git(seed, 'add', '.');
git(seed, 'commit', '-q', '-m', 'v1');
git(seed, 'remote', 'add', 'origin', origin);
git(seed, 'push', '-q', 'origin', 'main');
const co = path.join(tmp, 'checkout');
git(tmp, 'clone', '-q', origin, co);

const merge = (file, body, msg) => {
  fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
  fs.writeFileSync(path.join(seed, file), body);
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', msg);
  git(seed, 'push', '-q', 'origin', 'main');
  return git(seed, 'rev-parse', 'HEAD');
};

console.log('\nacs update');
ok('HOME is redirected', tmp !== os.homedir());

{
  const head = merge('app.txt', 'v2\n', 'v2');
  const r = acs(co);
  ok('a clean checkout on main is fast-forwarded to the merge', r.code === 0 && git(co, 'rev-parse', 'HEAD') === head, r.out);
  ok('it says what it updated to', /updated to \w+ v2/.test(r.out), r.out);
  const again = acs(co);
  ok('already current: exits 0 and says nothing', again.code === 0 && again.out === '', again.out);
}

{
  const head = merge('tools/worktree/wt.zsh', 'x\n', 'wt');
  const r = acs(co);
  ok('a pull that changes tools/worktree says to reinstall it',
     git(co, 'rev-parse', 'HEAD') === head && /acs install-worktree/.test(r.out) && !/install-model-id/.test(r.out), r.out);
  merge('models.default.json', '{}\n', 'models');
  ok('a pull that changes the resolver says to reinstall it', /acs install-model-id/.test(acs(co).out));
  // The resolver's code lives in bin/model-id.mjs (bin/model-id is a link to it) and lib/models.js.
  merge('bin/model-id.mjs', '// v2\n', 'resolver code');
  ok('a pull that changes only bin/model-id.mjs says to reinstall it', /acs install-model-id/.test(acs(co).out));
  merge('lib/models.js', '// v2\n', 'models code');
  ok('a pull that changes only lib/models.js says to reinstall it', /acs install-model-id/.test(acs(co).out));
}

{
  const before = git(co, 'rev-parse', 'HEAD');
  merge('app.txt', 'v3\n', 'v3');
  fs.writeFileSync(path.join(co, 'app.txt'), 'local edit\n');
  const r = acs(co);
  ok('local changes: not updated, and it says so',
     git(co, 'rev-parse', 'HEAD') === before && /local changes/.test(r.out) && r.code === 0, r.out);
  ok('the local edit is untouched', fs.readFileSync(path.join(co, 'app.txt'), 'utf8') === 'local edit\n');
  git(co, 'checkout', '-q', '--', 'app.txt');

  fs.writeFileSync(path.join(co, 'scratch.txt'), 'untracked\n');
  const u = acs(co);
  ok('an untracked file alone does not block the update', /updated to \w+ v3/.test(u.out), u.out);
  fs.rmSync(path.join(co, 'scratch.txt'));
}

{
  merge('app.txt', 'v4\n', 'v4');
  git(co, 'checkout', '-q', '-b', 'feature');
  const before = git(co, 'rev-parse', 'HEAD');
  const r = acs(co);
  ok('a feature branch is never moved', git(co, 'rev-parse', 'HEAD') === before && r.code === 0 && r.out === '', r.out);
  git(co, 'checkout', '-q', 'main');

  const skipped = acs(co, { ACS_NO_UPDATE: '1' });
  ok('ACS_NO_UPDATE=1 skips the update', git(co, 'rev-parse', 'HEAD') === before && skipped.out === '', skipped.out);
}

{
  const before = git(co, 'rev-parse', 'HEAD');
  git(co, 'remote', 'set-url', 'origin', path.join(tmp, 'gone.git'));
  const r = acs(co);
  ok('origin unreachable: exits 0, names the commit it will start',
     r.code === 0 && git(co, 'rev-parse', 'HEAD') === before && /could not reach origin/.test(r.out)
       && r.out.includes(before.slice(0, 7)), r.out);
  git(co, 'remote', 'set-url', 'origin', origin);
}

{
  // An SSH remote that never answers: the deadline kills the pull and the
  // launcher carries on. The ssh stand-in sleeps; `#` drops the -o flags.
  const before = git(co, 'rev-parse', 'HEAD');
  git(co, 'remote', 'set-url', 'origin', 'ssh://acs-test.invalid/repo.git');
  const t0 = Date.now();
  const r = acs(co, { GIT_SSH_COMMAND: 'sleep 30 #', ACS_UPDATE_TIMEOUT: '1' });
  const took = Date.now() - t0;
  ok('a remote that never answers is given up on at the deadline, not waited out',
     r.code === 0 && took < 10000 && /could not reach origin/.test(r.out) && git(co, 'rev-parse', 'HEAD') === before,
     `${took}ms ${r.out}`);
  git(co, 'remote', 'set-url', 'origin', origin);
}

{
  // No origin/HEAD: the default branch is unknown, so nothing is guessed.
  merge('app.txt', 'v4b\n', 'v4b');
  const before = git(co, 'rev-parse', 'HEAD');
  git(co, 'remote', 'set-head', 'origin', '-d');
  const r = acs(co);
  ok('origin/HEAD unknown: main is not assumed, and it says how to fix it',
     git(co, 'rev-parse', 'HEAD') === before && /default branch is unknown/.test(r.out) && /set-head origin --auto/.test(r.out), r.out);
  git(co, 'remote', 'set-head', 'origin', 'main');
  ok('with origin/HEAD restored it updates again', /updated to \w+ v4b/.test(acs(co).out));
}

{
  // Diverged: a local commit on main that origin does not have.
  fs.writeFileSync(path.join(co, 'local.txt'), 'mine\n');
  git(co, 'add', 'local.txt');
  git(co, 'commit', '-q', '-m', 'local');
  merge('app.txt', 'v5\n', 'v5');
  const before = git(co, 'rev-parse', 'HEAD');
  const r = acs(co);
  ok('a diverged main is never merged or rebased', git(co, 'rev-parse', 'HEAD') === before && /has diverged from origin/.test(r.out), r.out);
}

{
  // A configured fsmonitor hook that hangs must not stall startup: the
  // clean-check and fast-forward run with fsmonitor off.
  const hook = path.join(tmp, 'slow-fsmonitor.sh');
  fs.writeFileSync(hook, '#!/bin/sh\nsleep 30\n');
  fs.chmodSync(hook, 0o755);
  git(co, 'reset', '-q', '--hard', 'origin/main');
  merge('app.txt', 'v6\n', 'v6');
  git(co, 'config', 'core.fsmonitor', hook);
  const t0 = Date.now();
  const r = acs(co);
  const took = Date.now() - t0;
  ok('a hanging fsmonitor hook does not stall the update', took < 10000 && /updated to \w+ v6/.test(r.out), `${took}ms ${r.out}`);
  git(co, 'config', '--unset', 'core.fsmonitor');
}

{
  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(path.join(plain, 'bin'), { recursive: true });
  fs.copyFileSync(ACS, path.join(plain, 'bin', 'acs'));
  fs.chmodSync(path.join(plain, 'bin', 'acs'), 0o755);
  const r = acs(plain);
  ok('not a git checkout (a tarball install): exits 0 silently', r.code === 0 && r.out === '', r.out);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
