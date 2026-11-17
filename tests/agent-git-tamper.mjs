import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.realpathSync(tempDir('acs-git-tamper-')), bin = path.join(home, 'bin'); fs.mkdirSync(bin);
process.env.HOME = home;
for (const key of ['CODEX_HOME','GROK_HOME','CLAUDE_CONFIG_DIR','GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_CONFIG_COUNT','GIT_CONFIG_PARAMETERS']) delete process.env[key];
Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, CMUX_SOCKET_PATH: 'fake', CMUX_WORKSPACE_ID: 'workspace:1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
fs.writeFileSync(path.join(bin,'cmux'),`#!${process.execPath}\nimport(${JSON.stringify(path.join(root,'tests/fixtures/agent-cmux.mjs'))});\n`,{mode:0o755});
for (const binary of ['codex','caffeinate']) fs.writeFileSync(path.join(bin,binary),'#!/bin/sh\nexit 0\n',{mode:0o755});
const { waitWorker, sendWorker, answerWorker, closeWorker, listWorkers } = await import('../lib/agent.js');
const ctx = { workspace:'workspace:1', pane:'pane:1' };
const run = (cmd,args) => { const r=spawnSync(cmd,args,{encoding:'utf8',timeout:30000}); assert.equal(r.status,0,r.stderr); return r.stdout.trim(); };
const git = (cwd,...args) => run('git',['-C',cwd,...args]);
const repo = path.join(home,'repo'); fs.mkdirSync(repo); git(repo,'init');
git(repo,'config','user.name','Test'); git(repo,'config','user.email','test@example.invalid');
fs.writeFileSync(path.join(repo,'file'),'base\n'); git(repo,'add','.'); git(repo,'commit','-m','base');
const target = path.join(home,'outside'), sentinel='operator file must survive\n'; fs.writeFileSync(target,sentinel);
const recordPath = w => path.join(home,'.agent-config-studio/agents',`${w.id}.json`);
const record = w => JSON.parse(fs.readFileSync(recordPath(w)));
let serial=0;
function open() {
  const cwd=path.join(home,`linked-${serial++}`); git(repo,'worktree','add','--detach',cwd);
  const w=JSON.parse(run(process.execPath,[path.join(root,'bin/agent.mjs'),'open','sol','--cwd',cwd,'test','--json']));
  run('/bin/sh',[w.launcher]);
  return {...w,admin:git(cwd,'rev-parse','--absolute-git-dir')};
}
function swap(w,name) {
  const file=path.join(w.admin,name); fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.rmSync(file,{recursive:true,force:true}); fs.symlinkSync(target,file); return file;
}
function reported(result,file) {
  assert.equal(result.status,'stuck'); assert.equal(result.kind,'git_tamper');
  assert.ok(result.paths.includes(file)); assert.match(result.prompt,/git_tamper/);
  assert.ok(!fs.existsSync(file),'unsafe leaf is removed without following it');
  assert.equal(fs.readFileSync(target,'utf8'),sentinel);
}
const refusal = (e,file) => e.exitCode===3 && e.kind==='git_tamper' && e.message.includes(file);
for (const name of ['COMMIT_EDITMSG','index','index.lock','HEAD','HEAD.lock','logs/HEAD','logs/nested/entry','logs']) {
  const w=open(), file=swap(w,name);
  reported(await waitWorker(w.id,0,ctx),file);
  const again=await waitWorker(w.id,0,ctx); reported(again,file);
  const cli=spawnSync(process.execPath,[path.join(root,'bin/agent.mjs'),'wait',w.id,'--timeout','0','--json'],{encoding:'utf8',timeout:30000});
  assert.equal(cli.status,3,cli.stderr); reported(JSON.parse(cli.stdout),file);
  if(name==='COMMIT_EDITMSG') {
    fs.writeFileSync(path.join(w.cwd,'file'),'safe next commit\n'); git(w.cwd,'add','file'); git(w.cwd,'commit','-m','safe after unlink');
    assert.equal(fs.lstatSync(file).isFile(),true); assert.equal(fs.readFileSync(target,'utf8'),sentinel);
  }
  assert.throws(()=>closeWorker(w.id,ctx),e=>refusal(e,file));
  assert.equal(record(w).surfaceClosed,true,'close terminates the surface while preserving the warning');
  assert.equal((await waitWorker(w.id,0,ctx)).kind,'git_tamper','closed workers retain the tamper warning');
}
for (const api of ['send','answer','close','list','expiry']) {
  const w=open();
  if(api==='expiry') { const saved=record(w);saved.status='done';saved.lastActivityAt=Date.now()-31*60000;fs.writeFileSync(recordPath(w),JSON.stringify(saved)); }
  const file=swap(w,'COMMIT_EDITMSG');
  if(api==='send') await assert.rejects(sendWorker(w.id,'do not send',ctx),e=>refusal(e,file));
  if(api==='answer') assert.throws(()=>answerWorker(w.id,ctx),e=>refusal(e,file));
  if(api==='close') assert.throws(()=>closeWorker(w.id,ctx),e=>refusal(e,file));
  if(api==='list'||api==='expiry') reported(listWorkers(ctx).find(r=>r.id===w.id),file);
  reported(record(w),file);
  if(api!=='close') assert.throws(()=>closeWorker(w.id,ctx),e=>refusal(e,file));
}
const outsideDir=path.join(home,'outside-directory'); fs.mkdirSync(outsideDir);
fs.writeFileSync(path.join(outsideDir,'sentinel'),sentinel);
{
  const w=open(), file=path.join(w.admin,'logs','directory-link');
  fs.symlinkSync(outsideDir,file);
  reported(await waitWorker(w.id,0,ctx),file);
  assert.equal(fs.readFileSync(path.join(outsideDir,'sentinel'),'utf8'),sentinel,'reflog traversal never enters a linked directory');
  assert.throws(()=>closeWorker(w.id,ctx),e=>refusal(e,file));
}
for (const nonempty of [false,true]) {
  const w=open(), file=path.join(w.admin,'index.lock'); fs.mkdirSync(file);
  if(nonempty) fs.writeFileSync(path.join(file,'keep'),'unexpected directory contents');
  const result=await waitWorker(w.id,0,ctx);
  assert.equal(result.kind,'git_tamper'); assert.ok(result.paths.includes(file));
  assert.equal(fs.existsSync(file),nonempty,'empty unexpected directories are removed; nonempty ones stay blocked without recursion');
  assert.throws(()=>closeWorker(w.id,ctx),e=>refusal(e,file));
}
const normal=open();
assert.equal((await waitWorker(normal.id,0,ctx)).state,'done','regular and missing transient files are accepted');
assert.equal(closeWorker(normal.id,ctx).status,'closed');
const state=JSON.parse(fs.readFileSync(path.join(home,'fake-cmux.json')));
assert.ok(!state.calls.some(a=>a.includes('send')||a.includes('send-key')),'tamper detection never sends input');
console.log('Git leaf swaps are unlinked without touching their targets; every observation reports persistent git_tamper, including close and expiry');
