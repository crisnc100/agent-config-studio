import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime'), ROOT = mkdtempSync(join(tmpdir(), 'review-global-test-'))
const HOME = join(ROOT, 'home'), CONFIG = join(HOME, 'isolated.gitconfig'), REPO = join(HOME, 'Documents/Projects/example')
const REMOTE = join(ROOT, 'remote.git'), SKILL = join(HOME, '.agent-config-studio/review-gate'), GLOBAL = join(SKILL, 'hooks/global')
const INSTALL = join(SKILL, 'hooks/install-global.sh'), LOG = join(HOME, '.agent-config-studio/review-log/review-log.jsonl')
const BIN = join(ROOT, 'bin'), CALL = join(ROOT, 'hook-call.json'), ORDER = join(ROOT, 'order')
const CLIENT_HOOKS = ['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'reference-transaction', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate', 'fsmonitor-watchman', 'p4-changelist', 'p4-prepare-changelist', 'p4-post-changelist', 'p4-pre-submit', 'post-index-change']
const ORIGINAL_CONFIG = '# existing global settings\n[user]\n\tname = Original\n\temail = original@example.test\n'
mkdirSync(BIN)
for (const name of ['model-id', 'codex', 'claude', 'grok', 'jev']) {
  const path = join(BIN, name)
  writeFileSync(path, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(ROOT, 'unexpected-model'))},process.argv.join(' '));process.exit(99)\n`)
  chmodSync(path, 0o755)
}
const environment = (extra = {}) => ({ HOME, CODEX_HOME: join(HOME, '.codex'), GROK_HOME: join(HOME, '.grok'), GIT_CONFIG_GLOBAL: CONFIG, GIT_CONFIG_NOSYSTEM: '1', PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), ...extra })
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: REPO, env: environment(), encoding: 'utf8', timeout: 30000, ...options })
  return { ...result, out: `${result.stdout || ''}\n${result.stderr || ''}` }
}
const allowed = (r) => assert.equal(r.status, 0, r.out)
function git(...args) {
  const r = run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args]); allowed(r)
  return r.stdout.trim()
}
const install = (command) => run('sh', [INSTALL, command])
function commit(content = 'code\n') {
  writeFileSync(join(REPO, 'a.js'), content); git('add', 'a.js'); git('commit', '-qm', 'code')
  return git('rev-parse', 'HEAD')
}
function ownHook(name, exit = 0) {
  const path = join(REPO, '.git/hooks', name)
  writeFileSync(path, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(CALL)},JSON.stringify({args:process.argv.slice(2),input:fs.readFileSync(0).toString('base64')}));fs.appendFileSync(${JSON.stringify(ORDER)},'own\\n');process.stdout.write('own stdout\\n');process.exit(${exit});\n`)
  chmodSync(path, 0o755)
}
function cover(cwd = REPO) {
  const r = run('git', ['rev-parse', 'HEAD'], { cwd }); allowed(r)
  const head = r.stdout.trim()
  writeFileSync(LOG, [
    { type: 'review', kind: 'review', id: 'fixture', head, family: 'fixture', model: 'fixture-only', findingDetails: [] },
    { type: 'close', review: 'fixture', closeHead: head, status: 'complete', statuses: {} },
  ].map(JSON.stringify).join('\n') + '\n')
  return head
}
const push = (options = {}) => run('git', ['push', 'origin', 'HEAD:refs/heads/feature'], options)
function fastPath() {
  const path = join(ROOT, 'fast-bin'), calls = join(ROOT, 'git-calls')
  mkdirSync(path, { recursive: true }); rmSync(calls, { force: true })
  writeFileSync(join(path, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexec /usr/bin/git "$@"\n`)
  chmodSync(join(path, 'git'), 0o755)
  if (!existsSync(join(path, 'sh'))) symlinkSync('/bin/sh', join(path, 'sh'))
  return { env: environment({ PATH: path }), calls }
}
beforeEach(() => {
  for (const path of [HOME, REMOTE, CALL, ORDER]) rmSync(path, { recursive: true, force: true })
  mkdirSync(REPO, { recursive: true }); mkdirSync(SKILL, { recursive: true }); mkdirSync(dirname(LOG), { recursive: true })
  // The project scan reads ACS's roots; the repo opts into worktree-project gating (a .worktrees.conf still decides).
  writeFileSync(join(HOME, '.agent-config-studio/roots.json'), JSON.stringify({ version: 1, roots: [{ id: 'projects', path: join(HOME, 'Documents/Projects'), label: 'Projects', access: 'edit' }] }))
  writeFileSync(CONFIG, ORIGINAL_CONFIG)
  writeFileSync(join(HOME, '.gitconfig'), '# do not use this file\n')
  copyFileSync(join(SOURCE, 'review.mjs'), join(SKILL, 'review.mjs'))
  cpSync(join(SOURCE, 'hooks'), join(SKILL, 'hooks'), { recursive: true, verbatimSymlinks: true })
  git('init', '-q', '-b', 'main'); git('config', 'reviewgate.worktreeProjects', 'true'); commit()
  git('init', '--bare', '-q', REMOTE); git('remote', 'add', 'origin', REMOTE)
  allowed(install('install'))
})
after(() => {
  const unexpected = existsSync(join(ROOT, 'unexpected-model'))
  rmSync(ROOT, { recursive: true, force: true })
  assert.equal(unexpected, false, 'global hooks must never invoke a model or registry')
})

for (const bare of [false, true]) test(`Live A git init${bare ? ' --bare' : ''} is silent with global hooks`, () => {
  const target = join(ROOT, bare ? 'live-init-bare' : 'live-init-normal'); rmSync(target, { recursive: true, force: true })
  const result = run('git', ['init', '-q', ...(bare ? ['--bare'] : []), target])
  allowed(result); assert.equal(result.stderr, '')
})
test('Live A cloning an empty bare repo emits only Git own empty-repository warning', () => {
  const target = join(ROOT, 'live-empty-clone'); rmSync(target, { recursive: true, force: true })
  const result = run('git', ['clone', '-q', REMOTE, target])
  allowed(result); assert.doesNotMatch(result.stderr, /fatal:|review gate/i)
})
test('Live A repo reference-transaction hook still runs after silent initialization', () => {
  const target = join(ROOT, 'live-reference-repo'), marker = join(ROOT, 'live-reference-phases')
  rmSync(target, { recursive: true, force: true }); rmSync(marker, { force: true })
  const init = run('git', ['init', '-q', target]); allowed(init); assert.equal(init.stderr, '')
  const hook = join(target, '.git/hooks/reference-transaction')
  writeFileSync(hook, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)},process.argv[2]+'\\n');`); chmodSync(hook, 0o755)
  const result = run('git', ['-C', target, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'after init'])
  allowed(result); assert.doesNotMatch(result.stderr, /fatal:|review gate/i)
  assert.match(readFileSync(marker, 'utf8'), /prepared\ncommitted\n/)
})

test('4.1 all 22 documented client hooks preserve arguments, binary stdin, stdout and exit status', () => {
  assert.deepEqual(readdirSync(GLOBAL).filter((name) => CLIENT_HOOKS.includes(name)).sort(), [...CLIENT_HOOKS].sort())
  const input = Buffer.from([0, 255, 10, 97, 13, 0]), args = ['with spaces', '', 'line\nargument']
  for (const name of CLIENT_HOOKS) {
    assert.ok(lstatSync(join(GLOBAL, name)).isSymbolicLink())
    ownHook(name, 23)
    const result = run('/bin/sh', [join(GLOBAL, name), ...args], { input })
    assert.equal(result.status, 23, `${name}: ${result.out}`)
    assert.equal(result.stdout, 'own stdout\n', name)
    assert.deepEqual(JSON.parse(readFileSync(CALL)), { args, input: input.toString('base64') }, name)
    rmSync(join(REPO, '.git/hooks', name))
  }
})
test('4.1 frequent hooks without repo hooks use one git call and no node', () => {
  const fast = fastPath()
  const hooks = CLIENT_HOOKS.filter((name) => name !== 'pre-push')
  for (const name of hooks) allowed(run('/bin/sh', [join(GLOBAL, name), 'prepared'], { env: fast.env }))
  assert.deepEqual(readFileSync(fast.calls, 'utf8').trim().split('\n'), hooks.map(() => 'rev-parse --git-common-dir'))
})
test('4.1 own-hook failure still blocks a real commit; ordinary commits and pushes otherwise pass', () => {
  commit('changed\n'); const p = push(); allowed(p)
  assert.doesNotMatch(p.out, /review\.mjs|Reviewer:/); assert.equal(existsSync(LOG), false)
  ownHook('pre-commit', 19)
  writeFileSync(join(REPO, 'a.js'), 'refused\n'); git('add', 'a.js')
  const r = run('git', ['commit', '-qm', 'blocked']); assert.notEqual(r.status, 0, r.out)
  assert.equal(JSON.parse(readFileSync(CALL)).input, '')
})
test('4.1 ordinary repo pre-push sees original Git arguments and ref input', () => {
  ownHook('pre-push')
  const head = git('rev-parse', 'HEAD'); allowed(push())
  assert.deepEqual(JSON.parse(readFileSync(CALL)), { args: ['origin', REMOTE], input: Buffer.from(`HEAD ${head} refs/heads/feature ${'0'.repeat(40)}\n`).toString('base64') })
})
test('4.1 global-directory and individual-hook aliases cannot recurse', () => {
  const hooks = join(REPO, '.git/hooks')
  symlinkSync(join(GLOBAL, 'pre-commit'), join(hooks, 'pre-commit'))
  allowed(run('/bin/sh', [join(GLOBAL, 'pre-commit')], { timeout: 3000 }))
  rmSync(hooks, { recursive: true }); symlinkSync(GLOBAL, hooks)
  allowed(run('/bin/sh', [join(GLOBAL, 'pre-commit')], { timeout: 3000 }))
})
test('4.2 project pushes run the real gate before the repo hook and retain identical input', () => {
  writeFileSync(join(REPO, '.worktrees.conf'), 'project\n'); ownHook('pre-push')
  const blocked = push(); assert.notEqual(blocked.status, 0, blocked.out); assert.match(blocked.out, /No review log/)
  assert.equal(existsSync(CALL), false)
  const head = cover(); allowed(push())
  assert.deepEqual(JSON.parse(readFileSync(CALL)), { args: ['origin', REMOTE], input: Buffer.from(`HEAD ${head} refs/heads/feature ${'0'.repeat(40)}\n`).toString('base64') })
  assert.equal(readFileSync(ORDER, 'utf8'), 'own\n')
})
test('4.2 linked worktree pushes detect the trunk marker and use common-directory hooks', () => {
  writeFileSync(join(REPO, '.worktrees.conf'), 'project\n')
  const linked = join(ROOT, 'linked worktree'); rmSync(linked, { recursive: true, force: true })
  git('worktree', 'add', '-qb', 'linked', linked); ownHook('pre-push')
  const blocked = push({ cwd: linked }); assert.notEqual(blocked.status, 0); assert.match(blocked.out, /No review log/)
  cover(linked); allowed(push({ cwd: linked })); assert.ok(existsSync(CALL))
})
test('4.2 quoted worktree paths with newlines still detect a project marker', () => {
  const linked = join(ROOT, 'linked\nquoted'); rmSync(linked, { recursive: true, force: true })
  git('worktree', 'add', '-qb', 'quoted', linked); writeFileSync(join(linked, '.worktrees.conf'), 'project\n')
  const blocked = push(); assert.notEqual(blocked.status, 0); assert.match(blocked.out, /No review log/)
})
test('4.2 project buffering preserves large binary stdin and gates before delegation', () => {
  writeFileSync(join(REPO, '.worktrees.conf'), 'project\n'); ownHook('pre-push')
  const captured = join(ROOT, 'gate-input')
  writeFileSync(join(SKILL, 'review.mjs'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(captured)},fs.readFileSync(0));fs.appendFileSync(${JSON.stringify(ORDER)},'gate\\n');`)
  const input = Buffer.concat([Buffer.alloc(256000, 255), Buffer.from('\0a\r\nb\n')])
  allowed(run('/bin/sh', [join(GLOBAL, 'pre-push'), 'remote with spaces', 'url'], { input }))
  assert.deepEqual(readFileSync(captured), input)
  assert.deepEqual(JSON.parse(readFileSync(CALL)), { args: ['remote with spaces', 'url'], input: input.toString('base64') })
  assert.equal(readFileSync(ORDER, 'utf8'), 'gate\nown\n')
  rmSync(CALL); writeFileSync(join(SKILL, 'review.mjs'), 'process.exit(7)\n')
  const failed = run('/bin/sh', [join(GLOBAL, 'pre-push')], { input })
  assert.equal(failed.status, 7); assert.equal(existsSync(CALL), false)
  writeFileSync(join(SKILL, 'review.mjs'), "import fs from 'node:fs'; fs.readFileSync(0);\n")
  writeFileSync(join(REPO, '.git/hooks/pre-push'), `#!${process.execPath}\nprocess.exit(19)\n`)
  const ownFailed = run('/bin/sh', [join(GLOBAL, 'pre-push')], { input })
  assert.equal(ownFailed.status, 19, ownFailed.out)
})
test('4.2 own pre-push refusal after a successful gate still blocks the actual push', () => {
  writeFileSync(join(REPO, '.worktrees.conf'), 'project\n'); cover(); ownHook('pre-push', 29)
  const result = push(); assert.notEqual(result.status, 0, result.out); assert.ok(existsSync(CALL))
  assert.equal(git('ls-remote', 'origin', 'refs/heads/feature'), '')
})
test('4.3 missing, invalid and failing dispatchers warn and fail open in ordinary repos', () => {
  const dispatcher = join(GLOBAL, 'dispatch.sh')
  for (const [index, body] of [null, 'invalid shell (\n', 'exit 42\n'].entries()) {
    if (body === null) rmSync(dispatcher); else writeFileSync(dispatcher, body)
    commit(`ordinary ${index}\n`)
    const result = push(); allowed(result); assert.match(result.out, /warning: broken dispatcher/)
  }
})
test('4.3 missing, invalid and failing dispatchers fail closed for covered project pushes', () => {
  writeFileSync(join(REPO, '.worktrees.conf'), 'project\n'); cover()
  const dispatcher = join(GLOBAL, 'dispatch.sh')
  for (const body of [null, 'invalid shell (\n', 'exit 42\n']) {
    if (body === null) rmSync(dispatcher); else writeFileSync(dispatcher, body)
    const result = push(); assert.notEqual(result.status, 0, result.out); assert.match(result.out, /review gate for this opted-in repo could not run/)
  }
})
test('4.3 missing review script blocks projects; missing node warns and passes through unclassified repos', () => {
  rmSync(join(SKILL, 'review.mjs')); allowed(push())
  const fast = fastPath()
  const ordinary = run('git', ['push', 'origin', 'HEAD:refs/heads/no-node'], { env: fast.env })
  allowed(ordinary); assert.match(ordinary.out, /node is missing; treating this push as ordinary/)
  writeFileSync(join(REPO, '.worktrees.conf'), 'project\n')
  const missing = run('git', ['push', 'origin', 'HEAD:refs/heads/another'])
  assert.notEqual(missing.status, 0); assert.match(missing.out, /review.mjs is missing/)
  ownHook('pre-push')
  const noNode = run('git', ['push', 'origin', 'HEAD:refs/heads/another'], { env: fast.env })
  allowed(noNode); assert.match(noNode.out, /node is missing; treating this push as ordinary/)
  assert.ok(existsSync(CALL), 'the missing-node fallback must still delegate the repo hook')
})
test('4.3 node disappearing after project classification still blocks the known project gate', () => {
  writeFileSync(join(REPO, '.worktrees.conf'), 'project\n'); cover()
  const fast = fastPath(), node = join(ROOT, 'fast-bin/node')
  writeFileSync(node, `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');fs.rmSync(__filename);const r=cp.spawnSync(process.execPath,process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);\n`)
  chmodSync(node, 0o755)
  const result = run('git', ['push', 'origin', 'HEAD:refs/heads/another'], { env: fast.env })
  assert.notEqual(result.status, 0, result.out); assert.match(result.out, /node is missing; the review gate for this opted-in repo cannot run/)
  assert.equal(git('ls-remote', 'origin', 'refs/heads/another'), '')
})
test('4.4 install is idempotent and uninstall restores the original global config bytes', () => {
  const installed = readFileSync(CONFIG), state = readFileSync(join(HOME, '.agent-config-studio/review-gate-global-hook.json'))
  const again = install('install'); allowed(again); assert.match(again.out, /Already installed/)
  assert.deepEqual(readFileSync(CONFIG), installed); assert.deepEqual(readFileSync(join(HOME, '.agent-config-studio/review-gate-global-hook.json')), state)
  allowed(install('uninstall')); assert.equal(readFileSync(CONFIG, 'utf8'), ORIGINAL_CONFIG)
  assert.equal(readFileSync(join(HOME, '.gitconfig'), 'utf8'), '# do not use this file\n')
  allowed(install('uninstall'))
})
test('4.4 install refuses a different global hooksPath without changing configuration', () => {
  allowed(install('uninstall')); git('config', '--global', 'core.hooksPath', '/different/hooks')
  const before = readFileSync(CONFIG), result = install('install')
  assert.notEqual(result.status, 0); assert.match(result.out, /different global core.hooksPath/)
  assert.deepEqual(readFileSync(CONFIG), before)
})
test('4.4 uninstall restores an absent config file and preserves later unrelated config edits', () => {
  allowed(install('uninstall')); rmSync(CONFIG)
  allowed(install('install')); allowed(install('uninstall')); assert.equal(existsSync(CONFIG), false)
  writeFileSync(CONFIG, ORIGINAL_CONFIG); allowed(install('install'))
  git('config', '--global', 'user.extra', 'keep this')
  allowed(install('uninstall')); assert.equal(git('config', '--global', '--get', 'user.extra'), 'keep this')
  const unset = run('git', ['config', '--global', '--get', 'core.hooksPath']); assert.equal(unset.status, 1)
})
test('4.4 status reports local overrides under Projects without changing them; local hooks still win', () => {
  writeFileSync(join(REPO, '.worktrees.conf'), 'project\n')
  const local = join(ROOT, 'husky'); mkdirSync(local, { recursive: true })
  ownHook('pre-push'); copyFileSync(join(REPO, '.git/hooks/pre-push'), join(local, 'pre-push'))
  git('config', '--local', 'core.hooksPath', local)
  const config = readFileSync(join(REPO, '.git/config')), global = readFileSync(CONFIG)
  const result = install('status'); allowed(result); assert.ok(result.out.includes(REPO)); assert.ok(result.out.includes(local))
  assert.deepEqual(readFileSync(join(REPO, '.git/config')), config); assert.deepEqual(readFileSync(CONFIG), global)
  allowed(push()); assert.ok(existsSync(CALL)); assert.equal(existsSync(LOG), false)
})

test('f1 a byte-identical legacy per-repo shim runs the project gate exactly once', () => {
  writeFileSync(join(REPO, '.worktrees.conf'), 'project\n'); cover()
  copyFileSync(join(SKILL, 'hooks/pre-push'), join(REPO, '.git/hooks/pre-push'))
  const result = push(); allowed(result)
  assert.equal((result.out.match(/^review\.mjs · /gm) || []).length, 1, result.out)
  assert.equal((result.out.match(/^Reviewer: /gm) || []).length, 1, result.out)
})
test('f1 one real PTY override with a legacy per-repo shim writes one override entry', () => {
  writeFileSync(join(REPO, '.worktrees.conf'), 'project\n')
  copyFileSync(join(SKILL, 'hooks/pre-push'), join(REPO, '.git/hooks/pre-push'))
  const result = run('/usr/bin/script', ['-q', '/dev/null', 'git', 'push', 'origin', 'HEAD:refs/heads/feature'], {
    env: environment({ REVIEW_GATE_OVERRIDE: 'legacy shim migration' }), stdio: ['ignore', 'pipe', 'pipe'],
  })
  allowed(result)
  const overrides = readFileSync(LOG, 'utf8').trim().split('\n').map(JSON.parse).filter((record) => record.type === 'override' && record.action === 'push')
  assert.equal(overrides.length, 1, JSON.stringify(overrides))
  assert.equal(overrides[0].reason, 'legacy shim migration')
  // A real PTY may echo EOF/backspaces immediately before the first banner.
  assert.equal((result.out.match(/ · head-aware copy/g) || []).length, 1, result.out)
})
test('f1 a repo hook differing from the legacy shim by one comment still runs', () => {
  writeFileSync(join(REPO, '.worktrees.conf'), 'project\n'); cover()
  const own = join(REPO, '.git/hooks/pre-push')
  writeFileSync(own, Buffer.concat([readFileSync(join(SKILL, 'hooks/pre-push')), Buffer.from('\n# repo-specific hook\n')]))
  chmodSync(own, 0o755)
  const result = push(); allowed(result)
  assert.equal((result.out.match(/^review\.mjs · /gm) || []).length, 2, result.out)
})

test('5.1 five server hooks pass through with arguments, binary input and status, without Node', () => {
  const fast = fastPath(), input = Buffer.from([0, 255, 10, 13]), args = ['ref with spaces', '', 'old', 'new']
  for (const name of ['pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update']) {
    assert.ok(lstatSync(join(GLOBAL, name)).isSymbolicLink())
    ownHook(name, 23)
    const r = run('/bin/sh', [join(GLOBAL, name), ...args], { input, env: fast.env })
    assert.equal(r.status, 23, r.out)
    assert.equal(r.stdout, 'own stdout\n')
    assert.deepEqual(JSON.parse(readFileSync(CALL)), { args, input: input.toString('base64') })
  }
  assert.equal(readFileSync(fast.calls, 'utf8').trim().split('\n').length, 5)
})

test('5.1 unreadable worktree marker paths warn and pass ordinary pushes through for any stat error', () => {
  ownHook('pre-push')
  const preload = join(ROOT, 'stat-error.cjs')
  writeFileSync(preload, `const fs=require('node:fs'),orig=fs.statSync;fs.statSync=function(p,...a){if(String(p).endsWith('/.worktrees.conf'))throw Object.assign(new Error('fixture unreadable'),{code:process.env.STAT_ERROR});return orig(p,...a)};require('node:module').syncBuiltinESMExports();`)
  for (const code of ['EACCES', 'EPERM', 'EIO']) {
    rmSync(CALL, { force: true })
    const r = run('/bin/sh', [join(GLOBAL, 'pre-push')], { env: environment({ NODE_OPTIONS: `--require=${preload}`, STAT_ERROR: code }) })
    allowed(r); assert.match(r.stderr, /warning.*unreadable/i); assert.ok(existsSync(CALL))
  }
})

test('5.1 classification preserves non-UTF8 worktree bytes through stat', () => {
  const preload = join(ROOT, 'byte-path.cjs')
  writeFileSync(preload, `const fs=require('node:fs'),cp=require('node:child_process');cp.spawnSync=(cmd,args)=>args[0]==='config'?(args.includes('reviewgate.worktreeProjects')?{status:0,stdout:Buffer.from('true\\n'),stderr:Buffer.alloc(0)}:{status:1,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}):({status:0,stdout:Buffer.from([...'worktree /fixture/'.split('').map(c=>c.charCodeAt(0)),255,0]),stderr:Buffer.alloc(0)});fs.statSync=p=>{if(!Buffer.isBuffer(p)||!p.equals(Buffer.concat([Buffer.from('/fixture/'),Buffer.from([255]),Buffer.from('/.worktrees.conf')])))throw new Error('path bytes changed');return {isFile:()=>true}};require('node:module').syncBuiltinESMExports();`)
  const r = run(process.execPath, ['--require', preload, join(GLOBAL, 'project.mjs')])
  allowed(r); assert.equal(r.stdout, '1\n')
})

test('5.1 project own hook retries ENOEXEC with /bin/sh and preserves input, arguments and refusal', () => {
  writeFileSync(join(REPO, '.worktrees.conf'), 'project\n'); cover()
  const own = join(REPO, '.git/hooks/pre-push'), captured = join(ROOT, 'shell-input')
  writeFileSync(own, `cat > '${captured}'\nprintf '%s|%s' "$1" "$2"\nexit 27\n`); chmodSync(own, 0o755)
  const preload = join(ROOT, 'enoexec.cjs')
  writeFileSync(preload, `const cp=require('node:child_process'),orig=cp.spawnSync;cp.spawnSync=function(cmd,...args){if(cmd===${JSON.stringify(own)})return {error:Object.assign(new Error('fixture ENOEXEC'),{code:'ENOEXEC'}),status:null};return orig(cmd,...args)};require('node:module').syncBuiltinESMExports();`)
  const input = Buffer.from([0, 255, 10, 97])
  const r = run('/bin/sh', [join(GLOBAL, 'pre-push'), 'remote name', 'url'], { input, env: environment({ NODE_OPTIONS: `--require=${preload}` }) })
  // The actual gate is replaced only for this binary-input hook test.
  // A gate failure must still prevent the fallback, covered by the existing buffering test.
  assert.notEqual(r.status, 0)
  writeFileSync(join(SKILL, 'review.mjs'), "import fs from 'node:fs';fs.readFileSync(0);\n")
  const retried = run('/bin/sh', [join(GLOBAL, 'pre-push'), 'remote name', 'url'], { input, env: environment({ NODE_OPTIONS: `--require=${preload}` }) })
  assert.equal(retried.status, 27, retried.out); assert.equal(retried.stdout, 'remote name|url')
  assert.deepEqual(readFileSync(captured), input)
})

test('5.1 a real bare remote retains its receive guard and post-receive hook under global hooksPath', () => {
  const guard = join(REMOTE, 'hooks/pre-receive'), received = join(ROOT, 'received-refs')
  writeFileSync(guard, '#!/bin/sh\ncat >/dev/null\nexit 33\n'); chmodSync(guard, 0o755)
  const refused = push(); assert.notEqual(refused.status, 0, refused.out)
  assert.match(refused.out, /pre-receive hook declined/)
  assert.doesNotMatch(refused.out, /review\.mjs/)
  writeFileSync(guard, '#!/bin/sh\ncat >/dev/null\nexit 0\n')
  const hook = join(REMOTE, 'hooks/post-receive')
  writeFileSync(hook, `#!/bin/sh\ncat > '${received}'\n`); chmodSync(hook, 0o755)
  allowed(push())
  assert.equal(readFileSync(received, 'utf8'), `${'0'.repeat(40)} ${git('rev-parse', 'HEAD')} refs/heads/feature\n`)
})

test('phase 5 f1 updateInstead pushes update the non-bare working tree and index with global hooksPath', () => {
  const target = join(HOME, 'Documents/Projects/deploy')
  allowed(run('git', ['clone', '-q', REPO, target]))
  allowed(run('git', ['-C', target, 'config', 'receive.denyCurrentBranch', 'updateInstead']))
  const content = 'pushed deployment content\n', head = commit(content)
  allowed(run('git', ['push', target, 'HEAD:refs/heads/main']))
  assert.equal(run('git', ['-C', target, 'rev-parse', 'HEAD']).stdout.trim(), head)
  assert.equal(readFileSync(join(target, 'a.js'), 'utf8'), content)
  const index = run('git', ['-C', target, 'show', ':a.js']); allowed(index)
  assert.equal(index.stdout, content)
  const status = run('git', ['-C', target, 'status', '--porcelain']); allowed(status)
  assert.equal(status.stdout, '')
  assert.equal(existsSync(join(GLOBAL, 'push-to-checkout')), false)
})

test('phase 5 f1 install and status name repos whose own push-to-checkout hooks are masked', () => {
  allowed(install('uninstall'))
  ownHook('push-to-checkout')
  const own = join(REPO, '.git/hooks/push-to-checkout'), original = readFileSync(own)
  const bare = join(HOME, 'Documents/Projects/team/deploy.git')
  git('init', '--bare', '-q', bare)
  const bareHook = join(bare, 'hooks/push-to-checkout')
  writeFileSync(bareHook, '#!/bin/sh\nexit 0\n'); chmodSync(bareHook, 0o755)
  const linked = join(HOME, 'Documents/Projects/linked-deploy')
  git('worktree', 'add', '-qb', 'deploy-warning', linked)
  for (const command of ['install', 'status', 'install']) {
    const r = install(command); allowed(r)
    assert.match(r.stderr, /Warning:.*push-to-checkout.*will not run/)
    for (const name of [REPO, bare, linked, own, bareHook]) assert.ok(r.stderr.includes(name), `${command}: missing ${name}\n${r.out}`)
  }
  assert.deepEqual(readFileSync(own), original)
  const before = readFileSync(CONFIG)
  allowed(install('status')); assert.deepEqual(readFileSync(CONFIG), before)
})

test('Grade fix install and status bound the Projects scan while retaining named hook warnings', () => {
  const projects = join(HOME, 'Documents/Projects')
  const modules = join(projects, 'node_modules'), hidden = join(projects, '.cache')
  const output = join(REPO, 'build-output'), boundary = join(projects, 'group/second/third/boundary.git')
  const linked = join(projects, 'scan-linked'), linkedOutput = join(linked, 'build-output')
  const beyond = join(projects, 'one/two/three/four/five')
  mkdirSync(join(modules, ...Array.from({ length: 30 }, (_, i) => `package-${i}`)), { recursive: true })
  for (const path of [join(hidden, 'deep/cache'), join(output, 'nested/cache'), beyond]) mkdirSync(path, { recursive: true })
  git('init', '--bare', '-q', boundary)
  git('worktree', 'add', '-qb', 'scan-boundary', linked)
  mkdirSync(join(linkedOutput, 'nested/cache'), { recursive: true })
  git('config', '--local', 'core.hooksPath', '/example-local-hooks')
  git('-C', boundary, 'config', '--local', 'core.hooksPath', '/boundary-local-hooks')
  ownHook('push-to-checkout')
  const boundaryHook = join(boundary, 'hooks/push-to-checkout')
  writeFileSync(boundaryHook, '#!/bin/sh\nexit 0\n'); chmodSync(boundaryHook, 0o755)
  const preload = join(ROOT, 'scan-observer.cjs'), visited = join(ROOT, 'scan-visited.jsonl')
  writeFileSync(preload, `const fs=require('node:fs'),original=fs.readdirSync;fs.readdirSync=function(path,...args){fs.appendFileSync(${JSON.stringify(visited)},JSON.stringify(String(path))+'\\n');return original(path,...args)};require('node:module').syncBuiltinESMExports();`)
  allowed(install('uninstall'))
  for (const command of ['install', 'status']) {
    writeFileSync(visited, '')
    const r = run('sh', [INSTALL, command], { env: environment({ NODE_OPTIONS: `--require=${preload}` }) }); allowed(r)
    const walked = readFileSync(visited, 'utf8').trim().split('\n').map(JSON.parse)
    for (const skipped of [modules, hidden, output, linkedOutput, beyond])
      assert.ok(!walked.some((path) => path === skipped || path.startsWith(skipped + '/')), `${command} descended into ${skipped}: ${JSON.stringify(walked)}`)
    assert.ok(walked.includes(boundary), `${command} must still inspect a repo at depth four`)
    for (const path of walked) assert.ok(path.slice(projects.length).split('/').filter(Boolean).length <= 4, path)
    for (const path of [REPO, linked, boundary]) assert.ok(r.stderr.includes(path), `${command} lost named warning for ${path}`)
    assert.match(r.stderr, /push-to-checkout.*will not run/)
    if (command === 'status') for (const name of [REPO, '/example-local-hooks', boundary, '/boundary-local-hooks']) assert.ok(r.stdout.includes(name), name)
  }
})
