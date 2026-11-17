import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.realpathSync(tempDir('acs-git-probe-test-'));
const repo = path.join(home, 'repo'), bin = path.join(home, 'bin'), calls = path.join(home, 'calls.jsonl');
fs.mkdirSync(repo); fs.mkdirSync(bin);
const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, PROBE_TEST_CALLS: calls, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
for (const key of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_CONFIG_COUNT']) delete env[key];
const git = (...args) => {
  const r = spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
};
git('init'); git('config', 'user.name', 'Probe test'); git('config', 'user.email', 'test@example.invalid');
fs.writeFileSync(path.join(repo, 'seed'), 'base\n'); git('add', 'seed'); git('commit', '-m', 'base');
const before = git('rev-parse', 'HEAD'), branch = git('symbolic-ref', 'HEAD');
const common = path.join(repo, '.git'), config = fs.readFileSync(path.join(common, 'config'));
fs.writeFileSync(path.join(common, 'hooks', 'existing-hook'), 'keep me\n');
const script = path.join(repo, 'builds/codex-git-admin/probe.sh');
fs.mkdirSync(path.dirname(script), { recursive: true }); fs.copyFileSync(path.join(root, 'builds/codex-git-admin/probe.sh'), script);
fs.writeFileSync(path.join(bin, 'model-id'), `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.PROBE_TEST_CALLS,JSON.stringify({modelArgs:process.argv.slice(2)})+'\\n');if(process.argv.includes('--role'))process.exit(2);console.log('gpt-test');\n`, { mode: 0o755 });
fs.mkdirSync(path.join(repo, 'bin'));
fs.writeFileSync(path.join(repo, 'bin/agent.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url), args = process.argv.slice(2), command = args[0];
const entry = { command, args };
if (command === 'open') {
  const cwd = args[args.indexOf('--cwd') + 1]; process.chdir(cwd); entry.cwd = cwd;
  entry.admin = execFileSync('git', ['rev-parse','--absolute-git-dir'], { encoding:'utf8' }).trim();
  const common = path.resolve(execFileSync('git',['rev-parse','--git-common-dir'],{encoding:'utf8'}).trim());
  const blocked = new Set(['commondir','gitdir','config.worktree'].map(n=>path.join(entry.admin,n)).concat(path.join(common,'config')));
  entry.attempts = [];
  const fakeFs = new Proxy(fs, { get(target, key) {
    if (!['writeFileSync','openSync'].includes(key)) return target[key];
    return (file, ...rest) => {
      const absolute = path.resolve(file);
      const protectedPath = blocked.has(absolute) || absolute.startsWith(path.join(common,'hooks') + path.sep);
      if (protectedPath && (key === 'writeFileSync' || rest[0] === 'r+')) {
        entry.attempts.push(absolute);
        if (process.env.PROBE_TEST_MODE === 'denied') throw Object.assign(new Error('Permission denied'), {code:'EACCES'});
      }
      return target[key](file, ...rest);
    };
  } });
  if (process.env.PROBE_TEST_MODE !== 'stuck') vm.runInNewContext(fs.readFileSync('probe-worker.cjs','utf8'), { require: name => name === 'node:fs' ? fakeFs : require(name), console: { log() {} } });
}
fs.appendFileSync(process.env.PROBE_TEST_CALLS, JSON.stringify(entry)+'\\n');
console.log(JSON.stringify(command === 'open' ? {id:'fake-worker'} : command === 'wait' ? {state:process.env.PROBE_TEST_MODE === 'stuck'?'stuck':'done',kind:'trust'} : {status:'closed'}));
if(command === 'wait' && process.env.PROBE_TEST_MODE === 'stuck') process.exitCode=3;
`);
for (const mode of ['denied', 'leaks', 'stuck']) {
  fs.writeFileSync(calls, '');
  const r = spawnSync('/bin/sh', [script, ...(mode === 'leaks' ? ['probe-codex'] : [])], { env: { ...env, PROBE_TEST_MODE: mode }, encoding: 'utf8', timeout: 90000 });
  assert.equal(r.status, mode === 'denied' ? 0 : 1, `${mode}: ${r.stderr}\n${r.stdout}`);
  const events = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.find(e=>e.modelArgs).modelArgs, [mode === 'leaks' ? 'probe-codex' : 'sol'], 'family selection never queries the builder role');
  const opened = events.find(e=>e.command === 'open');
  assert.ok(opened, 'fake acs-agent opened the worker');
  assert.equal(opened.args[1], mode === 'leaks' ? 'probe-codex' : 'sol');
  assert.equal(events.at(-1).command, 'close', 'the worker closes before worktree removal');
  assert.ok(!fs.existsSync(opened.cwd), `${mode}: temporary linked worktree removed`);
  assert.ok(!fs.existsSync(opened.admin), `${mode}: worktree administration directory removed`);
  assert.ok(!fs.readdirSync(path.join(common, 'hooks')).some(n=>n.startsWith('acs-codex-git-admin-')), `${mode}: leaked unique hook removed`);
  assert.equal(fs.readFileSync(path.join(common, 'hooks', 'existing-hook'), 'utf8'), 'keep me\n');
  assert.ok(fs.readFileSync(path.join(common, 'config')).equals(config), 'shared config bytes remain identical');
  assert.equal(git('rev-parse', 'HEAD'), before); assert.equal(git('symbolic-ref', 'HEAD'), branch);
  assert.equal((git('worktree','list','--porcelain').match(/^worktree /gm)||[]).length, 1);
  assert.match(r.stdout, /Probe worktree removed/);
  if (mode !== 'stuck') {
    assert.match(r.stdout, /commit: ok/);
    assert.match(r.stdout, new RegExp('commondir: ' + (mode === 'denied' ? 'denied' : 'ok')));
    const hook = opened.attempts.find(p=>path.basename(p).startsWith('acs-codex-git-admin-'));
    assert.ok(hook, 'worker attempted the unique hook write');
  }
  const output = r.stdout.match(/Probe output retained at: (.+)/)?.[1];
  assert.ok(output); fs.rmSync(output, { recursive: true, force: true });
}
console.log('git probe uses this repository, selects a Codex family, commits, and cleans up on success, leaked writes, and trust refusal without live models');
