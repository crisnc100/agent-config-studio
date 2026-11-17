import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.realpathSync(tempDir('acs-agent-git-fix2-'));
const bin = path.join(home, 'bin'), capture = path.join(home, 'capture.json'); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'cmux'), `#!${process.execPath}\nimport(${JSON.stringify(path.join(root, 'tests/fixtures/agent-cmux.mjs'))});\n`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'caffeinate'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), {spawnSync}=require('node:child_process');
const result={args:process.argv.slice(2),tmpdir:os.tmpdir(),TMPDIR:process.env.TMPDIR,TMP:process.env.TMP,TEMP:process.env.TEMP};
const git=(...args)=>{const r=spawnSync('git',args,{encoding:'utf8',timeout:30000});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim();};
if(process.env.FIX_CASE==='f1') {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'worker-test-'));fs.writeFileSync(path.join(folder,'file'),'ok');fs.rmSync(folder,{recursive:true});
}
if(process.env.FIX_CASE==='f2') {
  const admin=git('rev-parse','--absolute-git-dir');
  result.before=fs.readdirSync(admin).filter(n=>n.startsWith('sharedindex.'));
  result.splitIndex=git('config','--get','core.splitIndex');result.inherited=git('config','--get','probe.inherited');
  git('add','file.txt');git('commit','-m','worker ordinary index');
  result.after=fs.readdirSync(admin).filter(n=>n.startsWith('sharedindex.'));
  result.sharedIndex=git('rev-parse','--shared-index-path');
}
fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(result));
`, { mode: 0o755 });
const env = { ...process.env, HOME: home, TMPDIR: home, PATH: `${bin}:${process.env.PATH}`, CMUX_SOCKET_PATH: 'fake', CMUX_WORKSPACE_ID: 'workspace:1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
for (const key of ['CODEX_HOME','GROK_HOME','CLAUDE_CONFIG_DIR','GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_CONFIG_COUNT','GIT_CONFIG_PARAMETERS']) delete env[key];
const run = (cmd, args, extra = {}) => {
  const r = spawnSync(cmd, args, { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.error?.message || r.stderr); return r.stdout.trim();
};
const git = (cwd, ...args) => run('git', ['-C', cwd, ...args]);
const repo = path.join(home, 'repo'); fs.mkdirSync(repo);
git(repo, 'init'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
fs.writeFileSync(path.join(repo, 'file.txt'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
const linked = path.join(home, 'linked'); git(repo, 'worktree', 'add', '--detach', linked);
const open = (cwd, extra = {}) => {
  const w = JSON.parse(run(process.execPath, [path.join(root, 'bin/agent.mjs'), 'open', 'sol', '--cwd', cwd, 'test', '--json'], extra));
  run('/bin/sh', [w.launcher], extra);
  return { w, ...JSON.parse(fs.readFileSync(capture)) };
};
const grants = args => args.flatMap((a, i) => a === '--add-dir' ? [args[i + 1]] : []);
const cases = {
  f1() {
    const first = open(linked, { FIX_CASE: 'f1' }), second = open(linked, { FIX_CASE: 'f1' });
    for (const worker of [first, second]) {
      const scratch = fs.realpathSync(path.join(worker.w.runDir, 'tmp'));
      assert.equal(worker.tmpdir, scratch, 'os.tmpdir() resolves to private worker scratch');
      for (const key of ['TMPDIR','TMP','TEMP']) assert.equal(worker[key], scratch);
      assert.ok(grants(worker.args).includes(scratch), 'scratch receives an explicit write grant');
      assert.equal(fs.statSync(scratch).mode & 0o777, 0o700);
      assert.ok(!grants(worker.args).includes(home), 'shared temp root remains ungranted');
    }
    assert.notEqual(first.tmpdir, second.tmpdir, 'workers have separate scratch directories');
  },
  f2() {
    git(repo, 'config', 'core.splitIndex', 'true'); git(repo, 'config', 'splitIndex.maxPercentChange', '0');
    git(linked, 'update-index', '--split-index');
    fs.writeFileSync(path.join(linked, 'file.txt'), 'changed\n');
    const worker = open(linked, { FIX_CASE: 'f2', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'probe.inherited', GIT_CONFIG_VALUE_0: 'keep' });
    assert.equal(worker.splitIndex, 'false', 'worker forces ordinary index mode');
    assert.equal(worker.inherited, 'keep', 'existing runtime Git config is preserved');
    assert.ok(worker.before.length > 0, 'fixture starts with a real split index');
    assert.deepEqual(worker.after, worker.before, 'staging and committing create no new shared indexes');
    assert.equal(worker.sharedIndex, '', 'the resulting index is no longer split');
    assert.equal(git(repo, 'config', '--local', '--get', 'core.splitIndex'), 'true', 'persistent configuration is unchanged');
    assert.equal(git(linked, 'log', '-1', '--format=%s'), 'worker ordinary index');
    const admin = git(linked, 'rev-parse', '--absolute-git-dir');
    assert.ok(!grants(worker.args).includes(admin), 'split-index support never grants the admin directory');
  },
  s1() {
    const subdir = path.join(linked, 'subdir'); fs.mkdirSync(subdir);
    const forged = path.join(home, 'forged'); fs.mkdirSync(forged);
    const admin = git(linked, 'rev-parse', '--absolute-git-dir'); fs.writeFileSync(path.join(forged, '.git'), `gitdir: ${admin}\n`);
    const outside = path.join(home, 'outside'); fs.mkdirSync(outside);
    for (const cwd of [repo, linked, subdir, forged, outside]) {
      const worker = open(cwd);
      for (const setting of ['sandbox_workspace_write.writable_roots=[]','sandbox_workspace_write.exclude_tmpdir_env_var=true','sandbox_workspace_write.exclude_slash_tmp=true']) {
        assert.ok(worker.args.some((a,i)=>a==='-c' && worker.args[i+1]===setting), `${cwd}: ${setting}`);
      }
      assert.ok(!grants(worker.args).includes(admin));
      assert.ok(!grants(worker.args).includes(path.join(repo, '.git')));
      if (cwd !== linked) assert.deepEqual(grants(worker.args), [path.join(worker.w.runDir, 'tmp')], 'unvalidated paths get scratch only');
    }
  },
};
for (const [name, test] of Object.entries(cases)) {
  if (process.env.FIX_CASE && process.env.FIX_CASE !== name) continue;
  test(); console.log(`PASS ${name}`);
}
