import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.realpathSync(tempDir('acs-agent-git-access-'));
const bin = path.join(home,'bin'); fs.mkdirSync(bin);
const capture=path.join(home,'argv.json');
fs.writeFileSync(path.join(bin,'cmux'),`#!${process.execPath}\nimport(${JSON.stringify(path.join(root,'tests/fixtures/agent-cmux.mjs'))});\n`,{mode:0o755});
fs.writeFileSync(path.join(bin,'codex'),`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));\n`,{mode:0o755});
fs.writeFileSync(path.join(bin,'caffeinate'),'#!/bin/sh\nexit 0\n',{mode:0o755});
const env={...process.env,HOME:home,PATH:`${bin}:${process.env.PATH}`,CMUX_SOCKET_PATH:'fake',CMUX_WORKSPACE_ID:'workspace:1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
for(const key of ['CODEX_HOME','GROK_HOME','CLAUDE_CONFIG_DIR','GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_CONFIG_COUNT']) delete env[key];
const run=(cmd,args,opts={})=>{const r=spawnSync(cmd,args,{env,encoding:'utf8',...opts});assert.equal(r.status,0,`${cmd} ${args.join(' ')}: ${r.stderr}`);return r.stdout.trim();};
const git=(cwd,...args)=>run('git',['-C',cwd,...args]);
function argv(cwd) {
  const w=JSON.parse(run(process.execPath,[path.join(root,'bin/agent.mjs'),'open','sol','--cwd',cwd,'test task','--json']));
  run('/bin/sh',[w.launcher]);
  return JSON.parse(fs.readFileSync(capture));
}
const grants=args=>args.flatMap((a,i)=>a==='--add-dir'?[args[i+1]]:[]);
const repo=path.join(home,'source repo'); fs.mkdirSync(repo);
git(repo,'init'); git(repo,'config','user.name','Test Builder'); git(repo,'config','user.email','builder@example.invalid');
fs.writeFileSync(path.join(repo,'file.txt'),'base\n'); git(repo,'add','file.txt'); git(repo,'commit','-m','base');
const linked=path.join(home,"linked ' worktree"); git(repo,'worktree','add','-b','builder',linked);
const common=fs.realpathSync(path.join(repo,'.git'));
const own=fs.realpathSync(git(linked,'rev-parse','--absolute-git-dir'));
const commitFiles=['index','index.lock','HEAD','HEAD.lock','COMMIT_EDITMSG'];
const expected=['objects','refs','logs'].map(n=>path.join(common,n)).concat(commitFiles.concat('logs').map(n=>path.join(own,n)));
assert.deepEqual(grants(argv(linked)),expected,'grant only common commit data and specific worktree commit paths');
assert.ok(!expected.includes(common));
assert.deepEqual(grants(argv(repo)),[],'a normal checkout needs no extra grant');
const sibling=path.join(home,'sibling'); git(repo,'worktree','add','-b','sibling',sibling);
assert.ok(!grants(argv(linked)).includes(git(sibling,'rev-parse','--absolute-git-dir')));
const spoof=path.join(home,'crafted archive'); fs.mkdirSync(spoof);
fs.writeFileSync(path.join(spoof,'.git'),`gitdir: ${own}\n`);
assert.equal(git(spoof,'rev-parse','--git-common-dir'),common,'Git accepts a pointer to another existing worktree');
assert.deepEqual(grants(argv(spoof)),[],'a backlink to another worktree grants nothing');
const externalAdmin=path.join(home,'outside admin'); fs.mkdirSync(externalAdmin);
fs.writeFileSync(path.join(externalAdmin,'commondir'),common+'\n');
fs.writeFileSync(path.join(externalAdmin,'HEAD'),'ref: refs/heads/builder\n');
fs.writeFileSync(path.join(externalAdmin,'gitdir'),path.join(spoof,'.git')+'\n');
fs.writeFileSync(path.join(spoof,'.git'),`gitdir: ${externalAdmin}\n`);
assert.equal(git(spoof,'rev-parse','--git-common-dir'),common);
assert.deepEqual(grants(argv(spoof)),[],'a matching backlink outside common/worktrees grants nothing');
fs.rmSync(path.join(externalAdmin,'gitdir'));
assert.deepEqual(grants(argv(spoof)),[],'missing backlink grants nothing');
const fakeLogs=path.join(home,'unrelated logs'); fs.mkdirSync(fakeLogs);
fs.renameSync(path.join(common,'logs'),path.join(common,'saved-logs'));
fs.symlinkSync(fakeLogs,path.join(common,'logs'));
try {
  const actual=grants(argv(linked));
  assert.deepEqual(actual,expected.filter(p=>p!==path.join(common,'logs')),'symlinked fixture grants only the remaining Git directories');
  assert.ok(!actual.includes(path.join(common,'logs')),'symlinked commit directories cannot widen the grant');
  assert.ok(!actual.includes(fakeLogs),'the symlink target receives no grant');
}
finally { fs.unlinkSync(path.join(common,'logs')); fs.renameSync(path.join(common,'saved-logs'),path.join(common,'logs')); }
function files(folder, prefix='') {
  const out={};
  for(const e of fs.readdirSync(folder,{withFileTypes:true})) {
    const rel=prefix+e.name, full=path.join(folder,e.name);
    if(e.isDirectory()) Object.assign(out,files(full,rel+'/'));
    else if(e.isFile()) out[rel]=crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  }
  return out;
}
git(repo,'pack-refs','--all');
assert.ok(fs.existsSync(path.join(common,'packed-refs')));
fs.writeFileSync(path.join(linked,'file.txt'),'builder commit\n'); git(linked,'add','file.txt');
const before=files(common);
const locked=[common,path.join(common,'hooks'),path.join(common,'info')];
const modes=locked.map(p=>fs.statSync(p).mode&0o777);
const config=path.join(common,'config'), configMode=fs.statSync(config).mode&0o777;
try {
  locked.forEach(p=>fs.chmodSync(p,0o555)); fs.chmodSync(config,0o444);
  git(linked,'commit','-m','commit with read-only common root');
} finally { locked.forEach((p,i)=>fs.chmodSync(p,modes[i])); fs.chmodSync(config,configMode); }
const after=files(common), changed=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(p=>before[p]!==after[p]);
const allowed=['objects/','refs/','logs/'];
const adminPrefix=path.relative(common,own)+'/';
assert.ok(changed.length>0);
assert.ok(changed.every(p=>allowed.some(prefix=>p.startsWith(prefix)) || commitFiles.concat('logs/HEAD').some(n=>p===adminPrefix+n)),JSON.stringify(changed));
assert.equal(after.config,before.config); assert.equal(after['packed-refs'],before['packed-refs']);
assert.equal(git(linked,'log','-1','--format=%s'),'commit with read-only common root');
assert.ok(!fs.existsSync(path.join(common,'packed-refs.lock')));
const linkedArgs=argv(linked);
for (const setting of ['sandbox_workspace_write.writable_roots=[]','sandbox_workspace_write.exclude_tmpdir_env_var=true','sandbox_workspace_write.exclude_slash_tmp=true']) {
  assert.ok(linkedArgs.some((arg,i)=>arg==='-c' && linkedArgs[i+1]===setting),`linked workers pin ${setting}`);
}
for (const forbidden of [own,'commondir','gitdir','config.worktree','config','hooks','objects'].map(n=>n===own?n:path.join(own,n))) {
  assert.ok(!grants(linkedArgs).some(p=>forbidden===p || forbidden.startsWith(p+path.sep)),`${forbidden} has no writable ancestor`);
}
assert.ok(!fs.existsSync(path.join(own,'index.lock')),'granting a missing lock does not create it');
assert.ok(!fs.existsSync(path.join(own,'HEAD.lock')),'granting a missing HEAD lock does not create it');
for (const name of ['index','index.lock','HEAD','HEAD.lock','COMMIT_EDITMSG','logs']) {
  const target=path.join(own,name), saved=target+'.saved', existed=fs.existsSync(target);
  if (existed) fs.renameSync(target,saved);
  fs.symlinkSync(fakeLogs,target);
  try {
    const actual=grants(argv(linked));
    assert.ok(!actual.includes(target),`symlinked ${name} receives no grant`);
    assert.ok(!actual.includes(fakeLogs),`symlinked ${name} target receives no grant`);
    assert.ok(!actual.includes(own),'no fallback to the admin directory');
  } finally { fs.unlinkSync(target); if(existed) fs.renameSync(saved,target); }
}
git(linked,'checkout','--detach');
fs.writeFileSync(path.join(linked,'file.txt'),'detached commit\n');
const detachedBefore=files(own);
git(linked,'add','file.txt'); git(linked,'commit','-m','detached builder commit');
const detachedAfter=files(own);
const detachedChanged=[...new Set([...Object.keys(detachedBefore),...Object.keys(detachedAfter)])].filter(p=>detachedBefore[p]!==detachedAfter[p]);
assert.ok(detachedChanged.includes('HEAD'),'detached commits need writable HEAD');
assert.ok(detachedChanged.every(p=>commitFiles.includes(p)||p==='logs/HEAD'),JSON.stringify(detachedChanged));
for (const name of ['commondir','gitdir','ORIG_HEAD']) assert.equal(detachedAfter[name],detachedBefore[name],`${name} is unchanged by a commit`);
console.log('agent grants specific commit paths without config redirects; symlinks and forged links are rejected; branch and detached commits fit the allowlist');
