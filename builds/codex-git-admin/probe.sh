#!/bin/sh
set -eu
node --input-type=module - "$0" <<'JS'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(process.argv[2]), '../..');
const run = (cmd, args, options = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 90000, ...options });
const checked = (cmd, args, options) => {
  const r = run(cmd, args, options);
  if (r.status !== 0) throw new Error(r.error?.message || r.stderr || r.stdout || `${cmd} exited ${r.status}`);
  return r.stdout.trim();
};
// Use this checkout's acs-agent entry point so an older installed copy cannot mask the result.
const agent = (...args) => run(process.execPath, [path.join(root, 'bin/agent.mjs'), ...args], { env: gitEnv });
const role = JSON.parse(checked('model-id', ['--role', 'builder', '--json']));
if (!role.id?.startsWith('gpt-')) throw new Error('The builder role must resolve to a Codex family for this probe.');
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-codex-git-admin-')));
const repo = path.join(temp, 'repo'), worktree = path.join(temp, "linked ' worktree");
fs.mkdirSync(repo);
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
for (const key of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_CONFIG_COUNT']) delete gitEnv[key];
const git = (cwd, ...args) => checked('git', ['-C', cwd, ...args], { env: gitEnv });
git(repo, 'init');
git(repo, 'config', 'user.name', 'Codex sandbox probe');
git(repo, 'config', 'user.email', 'probe@example.invalid');
git(repo, 'config', 'extensions.worktreeConfig', 'true');
fs.writeFileSync(path.join(repo, 'payload.txt'), 'base\n');
git(repo, 'add', 'payload.txt'); git(repo, 'commit', '-m', 'base');
git(repo, 'worktree', 'add', '-b', 'probe', worktree);
const admin = git(worktree, 'rev-parse', '--absolute-git-dir'), common = path.join(repo, '.git');
const before = git(worktree, 'rev-parse', 'HEAD');
const protectedPaths = ['commondir', 'gitdir'].map(n => path.join(admin, n)).concat(path.join(common, 'config'));
const originals = protectedPaths.map(p => fs.readFileSync(p));
function workerProbe() {
  const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
  const git = (...args) => {
    const r = spawnSync('git', args, { encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) throw new Error(r.error?.message || r.stderr);
    return r.stdout.trim();
  };
  const admin = git('rev-parse', '--absolute-git-dir');
  const common = path.resolve(git('rev-parse', '--git-common-dir'));
  const results = [];
  const attempt = (step, action) => {
    let status = 'ok', error;
    try { action(); } catch (e) { status = ['EACCES', 'EPERM', 'EROFS'].includes(e.code) ? 'denied' : 'error'; error = e.message; }
    results.push({ step, status, ...(error ? { error } : {}) });
    console.log(`${step}: ${status}`);
    fs.writeFileSync('probe-results.json', JSON.stringify(results, null, 2));
  };
  attempt('commit', () => {
    fs.writeFileSync('payload.txt', 'builder probe\n');
    git('add', 'payload.txt'); git('commit', '-m', 'sandbox probe commit');
  });
  // Identical pointer/config bytes prove write access without redirecting later Git commands.
  for (const name of ['commondir', 'gitdir']) attempt(name, () => {
    const target = path.join(admin, name); fs.writeFileSync(target, fs.readFileSync(target));
  });
  attempt('config.worktree', () => fs.writeFileSync(path.join(admin, 'config.worktree'), '[probe]\n\tvalue = true\n'));
  attempt('common/hooks/x', () => fs.writeFileSync(path.join(common, 'hooks/x'), '#!/bin/sh\nexit 0\n'));
  attempt('common/config', () => {
    const target = path.join(common, 'config'); fs.writeFileSync(target, fs.readFileSync(target));
  });
}
fs.writeFileSync(path.join(worktree, 'probe-worker.cjs'), `(${workerProbe.toString()})();\n`);
const prompt = path.join(temp, 'prompt.txt');
fs.writeFileSync(prompt, 'Run exactly `node probe-worker.cjs` in the current directory using your sandboxed shell tool. Do not request elevated permissions, use another tool to bypass the sandbox, edit the script, or retry failed writes. It attempts a git add + commit and harmless writes to protected Git paths. Report its output and finish.');
console.log(`Fixture retained at: ${temp}`);
let id;
try {
  const opened = agent('open', role.family, '--effort', 'medium', '--cwd', worktree, '--prompt-file', prompt, '--json');
  if (opened.status !== 0) throw new Error(opened.stderr || opened.error?.message || opened.stdout);
  id = JSON.parse(opened.stdout).id;
  console.log(`Worker: ${id}`);
  let done = false;
  for (let n = 0; n < 10; n++) {
    const waited = agent('wait', id, '--timeout', '60', '--json');
    if (waited.status === 0) { done = true; break; }
    if (waited.status !== 4) throw new Error(`Worker did not finish: ${waited.stdout || waited.stderr || waited.error?.message}`);
  }
  if (!done) throw new Error('Worker exceeded the ten-minute probe deadline.');
  const results = JSON.parse(fs.readFileSync(path.join(worktree, 'probe-results.json'), 'utf8'));
  const steps = ['commit', 'commondir', 'gitdir', 'config.worktree', 'common/hooks/x', 'common/config'];
  if (results.length !== steps.length) throw new Error('Incomplete worker results.');
  let failed = false;
  steps.forEach((step, i) => {
    const expected = i === 0 ? 'ok' : 'denied', result = results[i];
    console.log(`${step}: ${result.status}`);
    if (result.step !== step || result.status !== expected) failed = true;
  });
  protectedPaths.forEach((p, i) => { if (!fs.readFileSync(p).equals(originals[i])) failed = true; });
  if (fs.existsSync(path.join(admin, 'config.worktree')) || fs.existsSync(path.join(common, 'hooks/x'))) failed = true;
  if (git(worktree, 'rev-parse', 'HEAD') === before || git(worktree, 'show', 'HEAD:payload.txt') !== 'builder probe') failed = true;
  if (failed) throw new Error('Probe failed; inspect the retained fixture and probe-results.json.');
} finally {
  if (id) {
    const closed = agent('close', id, '--json');
    if (closed.status !== 0) console.error(`Could not close worker ${id}: ${closed.stderr || closed.error?.message}`);
  }
}
JS
