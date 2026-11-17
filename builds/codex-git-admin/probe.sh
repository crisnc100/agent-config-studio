#!/bin/sh
set -eu
node --input-type=module - "$0" "$@" <<'JS'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(process.argv[2]), '../..');
const family = process.argv[3] || 'sol';
if (process.argv.length > 4) throw new Error('usage: probe.sh [codex-family]');
const run = (cmd, args, options = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 90000, ...options });
const checked = (cmd, args, options) => {
  const r = run(cmd, args, options);
  if (r.status !== 0) throw new Error(r.error?.message || r.stderr || r.stdout || `${cmd} exited ${r.status}`);
  return r.stdout.trim();
};
if (!checked('model-id', [family]).startsWith('gpt-')) throw new Error('Choose a family that resolves to Codex.');
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
for (const key of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_CONFIG_COUNT']) delete gitEnv[key];
// Use this checkout's acs-agent entry point so an older installed copy cannot mask the result.
const agent = (...args) => run(process.execPath, [path.join(root, 'bin/agent.mjs'), ...args], { env: gitEnv });
const git = (cwd, ...args) => checked('git', ['-C', cwd, ...args], { env: gitEnv });
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-codex-git-admin-')));
const worktree = path.join(temp, 'probe-wt'), token = crypto.randomUUID();
const payload = `acs-codex-git-admin-${token}.txt`, hookName = `acs-codex-git-admin-${token}`;
const resultName = 'probe-results.json';
let id, added = false, admin, hook, hadWorktreeConfig = false;
function workerProbe({ payload, hookName, resultName }) {
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
    fs.writeFileSync(resultName, JSON.stringify(results, null, 2));
  };
  // Avoid truncating shared config or pointer files, even briefly.
  const identicalWrite = target => {
    const fd = fs.openSync(target, 'r+');
    try { const bytes = fs.readFileSync(fd); fs.writeSync(fd, bytes, 0, bytes.length, 0); }
    finally { fs.closeSync(fd); }
  };
  attempt('commit', () => {
    fs.writeFileSync(payload, 'builder probe\n', { flag: 'wx' });
    git('add', payload);
    git('-c', 'user.name=Codex sandbox probe', '-c', 'user.email=probe@example.invalid', 'commit', '-m', 'sandbox probe commit');
  });
  for (const name of ['commondir', 'gitdir']) attempt(name, () => identicalWrite(path.join(admin, name)));
  attempt('config.worktree', () => {
    const target = path.join(admin, 'config.worktree');
    if (fs.existsSync(target)) identicalWrite(target);
    else fs.writeFileSync(target, '[probe]\n\tvalue = true\n', { flag: 'wx' });
  });
  attempt('common/hooks/unique', () => fs.writeFileSync(path.join(common, 'hooks', hookName), '#!/bin/sh\nexit 0\n', { flag: 'wx' }));
  attempt('common/config', () => identicalWrite(path.join(common, 'config')));
}
console.log(`Probe output retained at: ${temp}`);
try {
  git(root, 'worktree', 'add', '--detach', worktree, 'HEAD'); added = true;
  admin = git(worktree, 'rev-parse', '--absolute-git-dir');
  const common = fs.realpathSync(path.resolve(worktree, git(worktree, 'rev-parse', '--git-common-dir')));
  hook = path.join(common, 'hooks', hookName);
  if (!fs.statSync(path.dirname(hook)).isDirectory() || fs.existsSync(hook)) throw new Error('A hooks directory and an unused probe hook name are required.');
  const worktreeConfig = path.join(admin, 'config.worktree');
  hadWorktreeConfig = fs.existsSync(worktreeConfig);
  const protectedPaths = ['commondir', 'gitdir'].map(n => path.join(admin, n)).concat(path.join(common, 'config'), hadWorktreeConfig ? [worktreeConfig] : []);
  const originals = protectedPaths.map(p => fs.readFileSync(p));
  const before = git(worktree, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(worktree, 'probe-worker.cjs'), `(${workerProbe.toString()})(${JSON.stringify({ payload, hookName, resultName })});\n`, { flag: 'wx' });
  const prompt = path.join(temp, 'prompt.txt');
  fs.writeFileSync(prompt, 'Run exactly `node probe-worker.cjs` in the current directory using your sandboxed shell tool. Do not request elevated permissions, use another tool to bypass the sandbox, edit the script, or retry failed writes. It attempts a git add + commit and harmless writes to protected Git paths. Report its output and finish.');
  const opened = agent('open', family, '--effort', 'medium', '--cwd', worktree, '--prompt-file', prompt, '--json');
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
  fs.copyFileSync(path.join(worktree, resultName), path.join(temp, resultName));
  const results = JSON.parse(fs.readFileSync(path.join(temp, resultName), 'utf8'));
  const steps = ['commit', 'commondir', 'gitdir', 'config.worktree', 'common/hooks/unique', 'common/config'];
  if (results.length !== steps.length) throw new Error('Incomplete worker results.');
  let failed = false;
  steps.forEach((step, i) => {
    const expected = i === 0 ? 'ok' : 'denied', result = results[i];
    console.log(`${step}: ${result.status}`);
    if (result.step !== step || result.status !== expected) failed = true;
  });
  protectedPaths.forEach((p, i) => { if (!fs.readFileSync(p).equals(originals[i])) failed = true; });
  if ((!hadWorktreeConfig && fs.existsSync(worktreeConfig)) || fs.existsSync(hook)) failed = true;
  if (git(worktree, 'rev-parse', 'HEAD') === before || git(worktree, 'show', `HEAD:${payload}`) !== 'builder probe') failed = true;
  if (failed) throw new Error('Probe failed; inspect the retained probe-results.json.');
} finally {
  if (id) {
    const closed = agent('close', id, '--json');
    if (closed.status !== 0) throw new Error(`Could not close worker ${id}; worktree retained at ${worktree}: ${closed.stderr || closed.error?.message}`);
  }
  if (hook) fs.rmSync(hook, { force: true });
  if (admin && !hadWorktreeConfig) fs.rmSync(path.join(admin, 'config.worktree'), { force: true });
  if (added) { git(root, 'worktree', 'remove', '--force', worktree); console.log('Probe worktree removed.'); }
}
JS
