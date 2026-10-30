import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime'), HOOKS = join(SOURCE, 'hooks')
const ROOT = mkdtempSync(join(tmpdir(), 'review-guard-test-')), HOME = join(ROOT, 'home'), BIN = join(ROOT, 'bin')
const CODEX = join(HOME, '.codex'), GROK = join(HOME, '.grok'), RPC = join(ROOT, 'rpc.jsonl')
const SETTINGS = join(HOME, '.claude/settings.json'), CONFIG = join(CODEX, 'config.toml'), HOOK_FILE = join(CODEX, 'hooks.json')
const installer = join(HOOKS, 'install-agent-guard.mjs'), launcher = join(HOOKS, 'agent-guard')
const put = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text) }
// Extra Codex homes are listed in the review-gate config; nothing is discovered by folder name.
const listCodexHomes = (homes) => put(join(HOME, '.agent-config-studio/review-gate/config.json'), JSON.stringify({ codexHomes: homes }))
const env = (extra = {}) => ({ HOME, CODEX_HOME: CODEX, GROK_HOME: GROK, GIT_CONFIG_GLOBAL: join(HOME, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), RPC_LOG: RPC, ...extra })
function run(binary, args, options = {}) {
  const r = spawnSync(binary, args, { cwd: ROOT, env: env(), encoding: 'utf8', timeout: 30000, ...options })
  return { ...r, out: `${r.stdout || ''}\n${r.stderr || ''}` }
}
const guard = (command, payload = {}) => run(process.execPath, [join(HOOKS, 'agent-guard.mjs')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, ...payload }) })
const install = (action, args = [], extra = {}) => run(process.execPath, [installer, action, ...args], { env: env(extra) })
const allowed = (r) => assert.equal(r.status, 0, r.out)
const json = (p) => JSON.parse(readFileSync(p, 'utf8'))
function homeSnapshot(path = HOME) {
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const p = join(path, entry.name)
    const stat = statSync(p)
    return entry.isDirectory() ? [[p, stat.mode, stat.mtimeMs, 'directory'], ...homeSnapshot(p)] : [[p, stat.mode, stat.mtimeMs, readFileSync(p).toString('base64')]]
  })
}
mkdirSync(BIN)
for (const tool of ['claude', 'grok']) {
  put(join(BIN, tool), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(ROOT, 'unexpected-harness'))},'${tool}');process.exit(99);`)
  chmodSync(join(BIN, tool), 0o755)
}
put(join(BIN, 'codex'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
if(process.argv[2]!=='app-server'){fs.writeFileSync(${JSON.stringify(join(ROOT, 'unexpected-harness'))},'codex model invocation');process.exit(99)}
const home=process.env.CODEX_HOME;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(process.env.RPC_LOG,JSON.stringify({home,method:m.method})+'\\n');
 const reply=value=>console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,...value}));
 if(process.env.STUB_RPC_HANG)return;
 if(m.method==='initialize')return reply({result:{}});
 if(m.method!=='hooks/list')return;
 if(process.env.STUB_RPC_FAIL)return reply({error:{message:'fixture failure'}});
 if(process.env.STUB_RPC_BAD){console.log('invalid RPC json');return}
 const config=fs.existsSync(path.join(home,'config.toml'))?fs.readFileSync(path.join(home,'config.toml'),'utf8'):'';
 const groups=JSON.parse(fs.readFileSync(path.join(home,'hooks.json'),'utf8')).hooks.PreToolUse;
 const hooks=groups.flatMap((g,i)=>g.hooks.map((h,j)=>{const key=path.join(home,'hooks.json')+':pre_tool_use:'+i+':'+j,currentHash='sha256:'+crypto.createHash('sha256').update(JSON.stringify(h)).digest('hex');return {...h,key,currentHash,trustStatus:process.env.STUB_RPC_TRUSTED||config.includes(JSON.stringify(key))&&config.includes(JSON.stringify(currentHash))?'trusted':'untrusted'}}));
 reply({result:{data:[{hooks:process.env.STUB_RPC_MISSING?[]:hooks}]}});
});
`)
chmodSync(join(BIN, 'codex'), 0o755)
beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true }); mkdirSync(CODEX, { recursive: true }); mkdirSync(GROK)
  rmSync(RPC, { force: true })
})
after(() => {
  const unexpected = existsSync(join(ROOT, 'unexpected-harness'))
  rmSync(ROOT, { recursive: true, force: true })
  assert.equal(unexpected, false, 'tests may invoke only the stub Codex app-server, never a real harness or model')
})

const LIVE_FALSE_REFUSAL = {"tool_name":"Bash","tool_input":{"command":"cd /Users/cortega/Documents/Projects/personal/skills-work && python3 - <<'PY'\np='HANDOFF-review-gate.md'\nt=open(p).read()\nold='''- **Not live:** the global hooksPath (step 3 of `builds/review-gate/phase6-report.md` §5). It waits\n  for the prod-down pilot.'''\nnew='''- **Global hooksPath is LIVE** (Cris ran `install-global.sh install`, 2026-10-29 evening). It\n  followed the prod-down pilot, which passed every check (PR https://github.com/crisnc100/prod-down/pull/44):\n  - an unreviewed push was refused;\n  - an agent's `--no-verify` was refused;\n  - a Sol xhigh review came back clean;\n  - the close passed with `npm test`;\n  - the reviewed push went through;\n  - the PR body carries the summary and a Deferred findings section.\n\n  After the switch, an unreviewed AirFlo push (dry-run) was refused and a plain repo pushed normally.\n- **Open bug (MEDIUM, sent to the helper):** every `git init` prints \"broken dispatcher for\n  reference-transaction\" three times. It is harmless noise. Fix it in `hooks/global/dispatch.sh`\n  (rev-parse fails before the repo exists), then reinstall the skills.\n- **Cleanup when Cris is done:**\n  - the pilot worktree `prod-down-wt/prod-down-review-gate-pilot` (after PR #44 closes);\n  - the `airflo-wt/airflo-review-pr-385` worktree.'''\nassert old in t\nopen(p,'w').write(t.replace(old,new))\nPY\necho ok"}}
test('Live B saved Python heredoc payload is opaque data', () => {
  allowed(guard(LIVE_FALSE_REFUSAL.tool_input.command, LIVE_FALSE_REFUSAL))
})
for (const [name, command] of [
  ['Python script', "python3 - <<'PY'\ndon't parse git push --no-verify\nPY"],
  ['Node script', "node - <<'EOF'\nconst text = \"an agent's --no-verify\";\nEOF"],
]) test(`Live B ${name} heredoc is opaque data`, () => { allowed(guard(command)) })
test('Live B delimiter quoting controls only the outer shell substitutions in opaque bodies', () => {
  for (const delimiter of ["'EOF'", '"EOF"', '\\EOF'])
    allowed(guard(`cat <<${delimiter}\n$(git push --no-verify) \`git commit -n\` don't parse this\nEOF`))
  for (const body of ["don't parse $(git push --no-verify)", "an agent's `git commit -n`", '"$(git push --no-verify)"'])
    assert.equal(guard(`cat <<EOF\n${body}\nEOF`).status, 2, body)
  allowed(guard("python3 - <<EOF\ndon't parse git push --no-verify\nEOF"))
  allowed(guard('cat <<EOF\n\\$(git push --no-verify) \\`git commit -n\\`\nEOF'))
})

const prototypeCases = [
  ['git push --no-verify', true], ['git push origin main --no-verify', true], ['git -C dir commit --no-verify -m x', true],
  ['git commit -n -m x', true], ['git commit -nm x', true], ['git commit -am x -n', true], ['git commit -mn', false],
  ['cd x && git push --no-verify', true], ['sh -c "git push --no-verify"', true], ["bash -lc 'git commit -n -m y'", true],
  ['/usr/bin/git push --no-verify', true], ['FOO=1 git push --no-verify', true], ['git push --no-verif origin main', true],
  // O1 deliberately accepts the harmless echo false positive to inspect Git words in any position.
  ['git push -n', false], ['git push origin main', false], ['git commit -m "mention --no-verify in msg"', false], ['echo git push --no-verify', true],
  ['git -c core.hooksPath=/dev/null push', true], ['GIT_CONFIG_GLOBAL=/dev/null git push', true], ['git config core.hooksPath /tmp/x', true],
  ['G=git; $G push --no-verify', false], ['git ci', false],
]
const shapes = [
  ...prototypeCases,
  ['git push --no-veri', true], ['git push --no-v', false], ['git push --no-ve', false], ['git push --no-ver', false],
  ['git push -- --no-verify', false], ['git commit -- -n', false], ['git commit -m "--no-verify"', false],
  ['git commit -F -n', false], ['git commit -Cn', false], ['git commit -cn', false], ['git commit -tn', false],
  ['git commit -un', false], ['git commit -Sn', false], ['git commit -an', true], ['git commit -S -n', true],
  ['git push --push-option --no-verify', false],
  ['env -i HOME=/tmp git commit -m normal', true], ['command /usr/bin/git push --no-verify', true],
  ['exec git commit -n', true], ['nohup git push --no-verify', true], ['time -p git push --no-verify', true],
  ['sudo -u root git push --no-verify', true], ['env -u TEMP FOO=1 git push --no-verify', true],
  ['git -P --git-dir .git --work-tree . --namespace name --no-pager commit -n', true],
  ['git --config-env=CORE.HOOKSPATH=HOOKS push', true], ['git --config-env core.hooksPath=HOOKS commit', true],
  ['git -cCORE.HOOKSPATH=/tmp push', true], ['git -c core.hooksPath=/tmp status', false],
  ['export GIT_CONFIG=/tmp/config; git push', true], ['GIT_CONFIG_KEY_0=core.hooksPath; git commit -m ordinary', true],
  ['GIT_CONFIG_VALUE_0=/tmp git push', true], ['XDG_CONFIG_HOME=/tmp git push', true], ['HOME=/tmp git status', false],
  ['git config --global --add core.hooksPath /tmp', true], ['git config --local --replace-all CORE.HOOKSPATH /tmp', true],
  ['git config --unset core.hooksPath', true], ['git config --unset-all core.hooksPath', true], ['git config set core.hooksPath /tmp', true],
  ['git config unset core.hooksPath', true], ['git config --get core.hooksPath', false], ['git config get core.hooksPath', false],
  ['git config --list', false], ['git config core.hooksPath', false], ['git config user.name someone', false],
  ["git config alias.unsafe '!git push --no-verify'", true], ['git config alias.safe status', false],
  ["git config alias.print '!echo GIT_CONFIG'", false],
  ['git config --get alias.unsafe', false], ['(git push --no-verify)', true], ['{ git commit -n; }', true],
  ['echo x | git push --no-verify', true], ['false || git commit -n', true], ['git push --no-verify & echo done', true],
  ['echo hello\ngit push --no-verify', true], ['echo $(git push --no-verify)', true], ['echo "$(git commit -n)"', true],
  ["echo '$(git push --no-verify)'", false], ['echo `git commit -n`', true], ['echo "literal git push --no-verify"', false],
  ['sh -ec "git push --no-verify"', true], ["eval 'git push --no-verify'", true], ["eval 'git' 'commit' '-n'", true],
  ['git-push --no-verify', true], ['/usr/libexec/git-core/git-commit -n', true],
  ['printf "%s" "--no-verify"', false], ["git commit -m 'git push --no-verify'", false],
]
for (const [text, blocked] of shapes) test(`6.8 command ${blocked ? 'blocks' : 'passes'}: ${text}`, () => {
  const r = guard(text)
  assert.equal(r.status, blocked ? 2 : 0, r.out)
  if (blocked) { assert.equal(r.stderr.trim().split('\n').length, 1); assert.doesNotMatch(r.stderr, /OVERRIDE|--waive|Cris|[Oo]perator/); }
})

test('6.8 three harness payload forms, subagent shape, argv arrays and non-shell tools', () => {
  for (const payload of [
    { tool_name: 'Bash', tool_input: { command: 'git push --no-verify' } },
    { toolName: 'run_terminal_command', toolInput: { command: 'git commit -n' } },
    { tool_name: 'Bash', agent_id: 'subagent', tool_input: { command: 'git push --no-verif' } },
    { tool_name: 'Bash', tool_input: { command: ['/usr/bin/git', 'push', '--no-verify'] } },
    { tool_name: 'Bash', tool_input: { command: ['/bin/bash', '-lc', 'git commit -n'] } },
    { tool_name: 'Monitor', tool_input: { command: 'git push --no-verify' } },
  ]) assert.equal(run(process.execPath, [join(HOOKS, 'agent-guard.mjs')], { input: JSON.stringify(payload) }).status, 2)
  allowed(guard(['git', 'commit', '-m', 'literal git push --no-verify']))
  allowed(guard('git push --no-verify', { tool_name: 'Read' }))
  allowed(guard(undefined))
})

test('6.8 parse and internal errors fail closed only for sensitive raw input', () => {
  for (const raw of ['not JSON no-veri', 'not JSON HOOKSPATH', 'not JSON GIT_CONFIG', JSON.stringify({ tool_input: { command: "git push --no-verify '" } })]) {
    const r = run(process.execPath, [join(HOOKS, 'agent-guard.mjs')], { input: raw })
    assert.equal(r.status, 2, r.out); assert.match(r.stderr, /guard error/)
  }
  const r = run(process.execPath, [join(HOOKS, 'agent-guard.mjs')], { input: 'not JSON ordinary' })
  allowed(r); assert.match(r.stderr, /guard error/)
})

test('6.8 POSIX launcher forwards input and has a conservative no-node or broken-node fallback', () => {
  const path = join(ROOT, 'no-node'); mkdirSync(path, { recursive: true })
  for (const name of ['cat', 'grep']) if (!existsSync(join(path, name))) symlinkSync(name === 'cat' ? '/bin/cat' : '/usr/bin/grep', join(path, name))
  for (const brokenNode of [false, true]) {
    const node = join(path, 'node'); rmSync(node, { force: true })
    if (brokenNode) { put(node, '#!/bin/sh\nexit 127\n'); chmodSync(node, 0o755) }
    for (const text of ['git push --NO-VERIFY', 'git -c CORE.HOOKSPATH=x push', 'git commit -an']) {
      const r = run('/bin/sh', [launcher], { env: env({ PATH: path }), input: JSON.stringify({ tool_input: { command: text } }) })
      assert.equal(r.status, 2, r.out)
    }
    const r = run('/bin/sh', [launcher], { env: env({ PATH: path }), input: JSON.stringify({ tool_input: { command: 'git status' } }) })
    allowed(r); assert.match(r.stderr, /warning/)
  }
  const forwarded = run('/bin/sh', [launcher], { input: JSON.stringify({ tool_input: { command: 'git push --no-verify' } }) })
  assert.equal(forwarded.status, 2, forwarded.out)
})

test('6.8 install merges hooks, trusts every Codex home using RPC, preserves modes and uninstalls byte-exactly', () => {
  const seat = join(HOME, '.codex-seats/work'), original = '{"keep":7,"hooks":{"PreToolUse":[{"matcher":"Read","hooks":[{"type":"command","command":"keep-existing-hook"}]}]}}\n'
  put(SETTINGS, original); chmodSync(SETTINGS, 0o640)
  put(HOOK_FILE, '{"keepCodex":true}\n'); put(CONFIG, 'model = "fixture-only"\n')
  put(join(seat, 'config.toml'), '# a second Codex home\n'); listCodexHomes([seat])
  const before = new Map([SETTINGS, HOOK_FILE, CONFIG, join(seat, 'config.toml')].map((p) => [p, readFileSync(p)]))
  allowed(install('install'))
  const groups = json(SETTINGS).hooks.PreToolUse
  assert.equal(groups.length, 3); assert.equal(groups[0].hooks[0].command, 'keep-existing-hook')
  for (const matcher of ['Bash', 'Monitor']) assert.equal(groups.filter((g) => g.matcher === matcher && g.hooks[0].command === launcher).length, 1)
  for (const home of [CODEX, seat]) {
    const hooks = json(join(home, 'hooks.json')).hooks.PreToolUse
    assert.equal(hooks[0].matcher, '^Bash$'); assert.equal(hooks[0].hooks[0].timeout, 30)
    assert.match(readFileSync(join(home, 'config.toml'), 'utf8'), /# review-gate agent guard begin\n\[hooks.state\./)
  }
  const methods = readFileSync(RPC, 'utf8').trim().split('\n').map(JSON.parse)
  for (const home of [CODEX, seat]) assert.deepEqual(methods.filter((m) => m.home === home).map((m) => m.method), ['initialize', 'initialized', 'hooks/list'])
  const stable = homeSnapshot(); allowed(install('install')); assert.deepEqual(homeSnapshot(), stable)
  const status = install('status'); allowed(status); assert.match(status.stdout, /Claude Bash: present/); assert.match(status.stdout, /Claude Monitor: present/)
  for (const home of [CODEX, seat]) assert.ok(status.stdout.includes(`Codex ${home}: entry present, trusted`), status.out)
  assert.deepEqual(homeSnapshot(), stable)
  assert.equal(statSync(SETTINGS).mode & 0o777, 0o640)
  assert.ok(readdirSync(join(HOME, '.agent-config-studio/backups')).length > 0)
  const backedUp = homeSnapshot(join(HOME, '.agent-config-studio/backups'))
  for (const bytes of before.values()) assert.ok(backedUp.some((row) => row[3] === bytes.toString('base64')), 'every changed pre-existing file has a backup')
  allowed(install('uninstall'))
  for (const [path, bytes] of before) assert.deepEqual(readFileSync(path), bytes, path)
  assert.equal(statSync(SETTINGS).mode & 0o777, 0o640)
  assert.equal(existsSync(join(seat, 'hooks.json')), false)
  allowed(install('uninstall'))
})

test('6.8 invalid JSON anywhere refuses with no writes and no RPC; overrides and Grok compat status are isolated', () => {
  put(SETTINGS, '{"keep":1}\n'); put(HOOK_FILE, 'broken json')
  const before = homeSnapshot(), r = install('install')
  assert.notEqual(r.status, 0); assert.deepEqual(homeSnapshot(), before); assert.equal(existsSync(RPC), false)
  rmSync(HOOK_FILE)
  const settings = join(HOME, 'alternate/settings.json'), codex = join(HOME, 'alternate/codex'), grok = join(HOME, 'alternate/grok.toml')
  put(grok, '[compat.claude]\nhooks = false\n')
  const args = ['--claude-settings', settings, '--codex-home', codex, '--grok-config', grok]
  allowed(install('install', args)); const status = install('status', args); allowed(status)
  assert.match(status.stderr, /Grok.*hooks = false/)
  assert.deepEqual(json(SETTINGS), { keep: 1 })
  allowed(install('uninstall', args)); assert.equal(existsSync(settings), false); assert.equal(existsSync(join(codex, 'hooks.json')), false)
})

test('6.8 missing or failed Codex RPC leaves the hook present and explicitly reports untrusted', () => {
  for (const extra of [{ STUB_RPC_FAIL: '1' }, { STUB_RPC_BAD: '1' }, { STUB_RPC_MISSING: '1' }, { PATH: join(ROOT, 'no-codex') }]) {
    rmSync(HOME, { recursive: true, force: true }); mkdirSync(HOME)
    if (extra.PATH) mkdirSync(extra.PATH, { recursive: true })
    const r = install('install', [], extra); allowed(r)
    assert.match(r.stderr, /untrusted/); assert.match(r.stdout, /entry present, untrusted/)
    assert.equal(json(HOOK_FILE).hooks.PreToolUse[0].hooks[0].command, launcher)
    assert.equal(existsSync(CONFIG), false)
    const status = install('status', [], extra); allowed(status); assert.match(status.stdout, /untrusted/)
  }
})

test('6.8 RPC timeout is bounded at 20 seconds and reports untrusted', () => {
  const preload = join(ROOT, 'fast-timeout.cjs')
  put(preload, `const original=global.setTimeout;global.setTimeout=(fn,ms,...args)=>{if(ms!==20000)throw new Error('wrong RPC timeout');return original(fn,10,...args)};`)
  const r = install('install', [], { NODE_OPTIONS: `--require=${preload}`, STUB_RPC_HANG: '1' })
  allowed(r); assert.match(r.stderr, /timed out after 20 seconds/); assert.match(r.stdout, /untrusted/)
})

test('6.8 uninstall preserves unrelated edits in JSON and TOML and removes only our entries', () => {
  put(SETTINGS, '{"keep":true}\n'); put(CONFIG, '# original\n')
  allowed(install('install'))
  const claude = json(SETTINGS); claude.newSetting = 'human edit'; put(SETTINGS, JSON.stringify(claude))
  const codex = json(HOOK_FILE); codex.other = { retained: true }; put(HOOK_FILE, JSON.stringify(codex))
  put(CONFIG, readFileSync(CONFIG, 'utf8') + '\n# added after install\nother = true\n')
  allowed(install('uninstall'))
  assert.deepEqual(json(SETTINGS), { keep: true, newSetting: 'human edit' })
  assert.deepEqual(json(HOOK_FILE), { other: { retained: true } })
  assert.match(readFileSync(CONFIG, 'utf8'), /# added after install/)
  assert.doesNotMatch(readFileSync(CONFIG, 'utf8'), /review-gate agent guard|trusted_hash/)
})

test('6.8 reused Codex trust keys merge without duplicate TOML sections and restore prior trust after unrelated edits', () => {
  const key = HOOK_FILE + ':pre_tool_use:0:0'
  const old = `[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = "stale-hash"\nkeep_metadata = true\n`
  put(CONFIG, old)
  allowed(install('install'))
  const installed = readFileSync(CONFIG, 'utf8')
  assert.equal(installed.split(`[hooks.state.${JSON.stringify(key)}]`).length - 1, 1)
  assert.match(installed, /keep_metadata = true/); assert.doesNotMatch(installed, /stale-hash/)
  put(CONFIG, installed + '\n[human]\nkeep = true\n')
  allowed(install('uninstall'))
  const restored = readFileSync(CONFIG, 'utf8')
  assert.match(restored, /stale-hash/); assert.match(restored, /keep_metadata = true/)
  assert.match(restored, /\[human\]\nkeep = true/); assert.doesNotMatch(restored, /review-gate agent guard/)
})

test('6.8 installing harness guards leaves terminal Git and global Git configuration untouched', () => {
  const global = join(HOME, 'gitconfig')
  put(global, '# terminal config stays unchanged\n')
  const before = readFileSync(global)
  allowed(install('install'))
  assert.deepEqual(readFileSync(global), before)
  const repo = join(ROOT, 'terminal-repo'); rmSync(repo, { recursive: true, force: true })
  allowed(run('git', ['init', '-q', repo]))
  allowed(run('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'terminal remains outside harness hooks', '--no-verify']))
  assert.deepEqual(readFileSync(global), before)
})

test('G2 glued and interleaved redirects cannot hide bypass flags', () => {
  for (const command of ['git push --no-verify>/dev/null', 'git commit -n>log', 'git push > out --no-verify',
    'git push --no-verif>>out', 'git commit -n2>&1', 'git push --no-verify>|out', 'git push --no-verify<&0',
    'git push --no-verify&>out', 'git push --no-verify&>>out', 'git push --no-verify 2>log', 'git push --no-verify 2>&1',
    'git commit -m \\2>out -n', 'git commit -m "2">out -n'])
    assert.equal(guard(command).status, 2, command)
  for (const command of ['git push > "--no-verify"', 'git push >out 2>&1', 'git commit -m "--no-verify>quoted"', 'git push <input'])
    allowed(guard(command))
})

test('O1 launcher blocks literal Git at any position and decodes ANSI-C quoted words', () => {
  for (const command of ['timeout 60 git push --no-verify', 'if true; then git push --no-verify; fi',
    'for i in 1; do git commit -n -m x; done', '! git push --no-verify', "git push $'--no-verify'",
    'nice git push --no-verify', 'xargs git push --no-verify', 'script -q /dev/null git push --no-verify',
    'stdbuf -oL git push --no-verify', 'caffeinate git commit -n', 'HOME=x timeout 5 git push',
    'timeout 5 HOME=x git push', 'wrapper git status git push --no-verify', "g$'it' push $'\\x2d\\055no-veri\\u0066\\U00000079'",
    'echo git push --no-verify']) {
    const r = run('/bin/sh', [launcher], { input: JSON.stringify({ tool_input: { command } }) })
    assert.equal(r.status, 2, command + '\n' + r.out)
  }
  for (const command of ['grep "git push --no-verify" notes.md', "git commit -m $'don\\'t use --no-verify'", "printf '%s' $'\\a\\b\\e\\E\\f\\n\\r\\t\\v\\\\\\\"\\?'", "git push $'--no-ver'"])
    allowed(guard(command))
})

test('G1 standard commit-message heredocs pass even with quotes and bypass words in their body', () => {
  const command = "git commit -m \"$(cat <<'EOF'\ndon't mention --no-verify or hooksPath here\nEOF\n)\""
  allowed(guard(command))
})
test('G1 a commit -n with a heredoc message still blocks', () => {
  const command = "git commit -n -m \"$(cat <<'EOF'\ndon't skip this commit\nEOF\n)\""
  assert.equal(guard(command).status, 2)
})
test('G1 literal heredoc bodies are skipped for each delimiter form and here-strings stay separate', () => {
  for (const header of ['<<EOF', "<<'EOF'", '<<"EOF"', '<<-EOF']) {
    const tab = header.includes('<<-') ? '\t' : ''
    allowed(guard(`cat > notes.md ${header}\n${tab}git push --no-verify\n${tab}don't parse \"these quotes\n${tab}EOF\n`))
  }
  allowed(guard("cat <<A <<'B'\ngit push --no-verify\nA\ngit commit -n\nB\n"))
  allowed(guard('cat <<< "git push --no-verify"'))
  allowed(guard(`git commit -m "$(cat <<<"don't mention --no-verify"\n)"`))
  allowed(guard('echo `cat <<"EOF"\ngit push --no-verify\nEOF\n`'))
  assert.equal(guard('cat <<< hello\ngit push --no-verify').status, 2)
})
test('f1 parse-error fallback checks the full raw payload including data heredocs', () => {
  const body = "cat <<'EOF'\ngit push --no-verify; don't parse this\nEOF\n"
  // The last-pass contract supersedes G1's redacted fallback: any parse error checks raw input.
  const sensitive = guard(body + "printf 'unterminated")
  assert.equal(sensitive.status, 2); assert.match(sensitive.stderr, /guard error/)
  assert.equal(guard(body + "git push --no-verify '").status, 2)
  const benign = guard("cat <<EOF\nordinary message\nEOF\nprintf 'unterminated")
  allowed(benign); assert.match(benign.stderr, /warning:.*guard error/)
  assert.equal(guard("printf 'unterminated", { metadata: '--no-verify' }).status, 2)
})

for (const [name, command] of [
  ['shell-owned heredoc', "bash <<'EOF'\ngit push --no-verify\nEOF"],
  ['heredoc piped to a shell', 'cat <<EOF | sh\ngit commit -n -m wip\nEOF'],
  ['stdin-script shell heredoc', 'sh -s <<EOF\ngit push --no-verify\nEOF'],
  ['eval of a heredoc substitution', "eval \"$(cat <<'EOF'\ngit push --no-verify\nEOF\n)\""],
  ['shell-owned here-string', "bash <<< 'git push --no-verify'"],
  ['shell script from a heredoc substitution', "sh -c \"$(cat <<'EOF'\ngit push --no-verify\nEOF\n)\""],
  ['unterminated executable heredoc', "bash <<'EOF'\ngit push --no-verify\n"],
]) test(`f1 blocks ${name}`, () => {
  const result = guard(command)
  assert.equal(result.status, 2, command + '\n' + result.out)
})

test('f1 data-sink heredocs and the three required G1 cases retain their behavior', () => {
  for (const option of ['-F -', '--file=-', '--file -'])
    allowed(guard(`git commit ${option} <<'EOF'\ndon't use --no-verify\nEOF`))
  allowed(guard("git commit -m \"$(cat <<'EOF'\ndon't use --no-verify\nEOF\n)\""))
  assert.equal(guard("git commit -n -m \"$(cat <<'EOF'\ndon't skip this\nEOF\n)\"").status, 2)
  allowed(guard("cat > notes.md <<'EOF'\ngit push --no-verify\nEOF"))
  allowed(guard("tee notes.md <<'EOF'\ndon't use --no-verify\nEOF"))
  allowed(guard("cat <<EOF | sh -c cat\ngit push --no-verify\nEOF"))
  allowed(guard("cat <<< 'git push --no-verify'"))
})

for (const interpreter of ['sh', 'bash', 'zsh', 'dash', 'ksh', 'eval', 'source', '.', 'xargs', 'env sh', 'sh -sc cat']) {
  test(`f1 inspects heredocs and here-strings piped to ${interpreter}`, () => {
    // Live B treats xargs as opaque: it is not one of the named shell consumers.
    const expected = interpreter === 'xargs' ? 0 : 2
    for (const command of [`cat <<EOF | cat | ${interpreter}\ngit commit -n -m wip\nEOF`, `cat <<< 'git commit -n -m wip' | ${interpreter}`,
      `${interpreter} <<EOF\ngit commit -n -m wip\nEOF`, `${interpreter} <<< 'git commit -n -m wip'`])
      assert.equal(guard(command).status, expected, command)
  })
}
test('f1 unknown heredoc owners and nested substitutions used as code fail toward blocking', () => {
  // Live B replaces the unknown-owner default with opaque data for non-shell consumers.
  allowed(guard('unknown <<EOF\ngit commit -n -m wip\nEOF'))
  for (const command of [
    "eval \"$(printf '%s' \"$(cat <<'EOF'\ngit commit -n -m wip\nEOF\n)\")\"",
    "bash <<< \"$(cat <<'EOF'\ngit commit -n -m wip\nEOF\n)\"",
    "timeout 5 sh -c \"$(cat <<'EOF'\ngit commit -n -m wip\nEOF\n)\"",
    "eval \"$(cat <<< 'git commit -n -m wip')\"",
    "sh -c \"$(cat <<< 'git commit -n -m wip')\"",
  ]) assert.equal(guard(command).status, 2, command)
})

const launchGuard = (command) => run('/bin/sh', [launcher], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }) })
for (const command of ['git push origin ${BRANCH} --no-verify', 'git commit -m ${MSG} -n']) {
  test(`Grade parameter expansion keeps the bypass flag visible: ${command}`, () => {
    assert.equal(launchGuard(command).status, 2, command)
  })
}
test('Grade parameter and literal braces remain words while command-position groups still work', () => {
  for (const command of [
    'git push origin ${BRANCH:-${FALLBACK:-{one,two}}} --no-verify',
    'git commit -m ${MSG:-a message with {nested braces}} -n',
    'git commit -m "${MSG:-a } quoted brace}" -n',
    'git commit -m ${MSG:-"a } quoted brace"} -n',
    'git commit -m ${MSG:-$(git commit -n -m inner)}',
    'git commit -m ${MSG:-$(printf x)} -n',
    'git commit -m "$(printf %s ${MSG:-{a,b}})" -n',
    'git push origin path{one,two} --no-verify', 'git push origin } --no-verify',
    '{ git push --no-verify; }', '{ git commit -n -m wip; }',
  ]) assert.equal(launchGuard(command).status, 2, command)
  for (const command of ['git push origin ${BRANCH}', 'git commit -m ${MSG}',
    'git commit -m ${MSG:-"mention --no-verify"}', 'git commit -m "$(printf %s ${MSG:-{a,b}})"',
    'git commit -m {--no-verify}', '{ git push origin main; }']) allowed(launchGuard(command))
})

for (const command of [
  'git config --global --remove-section core', 'git config --global --rename-section core backup',
  'git config remove-section core', 'git config rename-section core x',
  'git config --global --rename-section backup CoRe', 'git config rename-section backup CORE',
]) test(`Grade core-section writes block: ${command}`, () => {
  assert.equal(launchGuard(command).status, 2, command)
})
test('Grade core-section matching ignores option values and permits other sections', () => {
  for (const command of ['git config --file fixture --remove-section CORE', 'git config --rename-section core get',
    'git config rename-section core list', 'timeout 5 git config --global --rename-section other core'])
    assert.equal(launchGuard(command).status, 2, command)
  for (const command of ['git config --remove-section core.backup', 'git config --rename-section backup archive',
    'git config remove-section backup', 'git config rename-section backup archive',
    'git config --file core --remove-section backup', 'git config --file core --rename-section backup archive',
    'git config --get core.hooksPath', 'git config get core.hooksPath']) allowed(launchGuard(command))
})

for (const command of ['git send-pack remote HEAD:refs/heads/x', 'git-send-pack remote HEAD:refs/heads/x']) {
  test(`Grade blocks pre-push-skipping transport: ${command}`, () => {
    assert.equal(launchGuard(command).status, 2, command)
  })
}
test('Grade send-pack detection covers paths, wrappers, every position and argv payloads', () => {
  for (const command of ['timeout 5 git send-pack remote HEAD:refs/heads/x',
    'if true; then /usr/bin/git send-pack remote HEAD:refs/heads/x; fi',
    '/usr/libexec/git-core/git-send-pack remote HEAD:refs/heads/x',
    'wrapper git status git-send-pack remote HEAD:refs/heads/x', 'echo git send-pack remote HEAD:refs/heads/x',
    'git -C ${REPO} send-pack remote HEAD:refs/heads/x']) assert.equal(launchGuard(command).status, 2, command)
  for (const argv of [['git', 'send-pack', 'remote', 'HEAD:refs/heads/x'], ['git-send-pack', 'remote', 'HEAD:refs/heads/x']])
    assert.equal(guard(argv).status, 2, JSON.stringify(argv))
  allowed(launchGuard('git push remote HEAD:refs/heads/x'))
  allowed(launchGuard('git commit -m "git send-pack is blocked"'))
})

const sharedKey = (home) => join(home, 'hooks.json') + ':pre_tool_use:0:0'
const sharedKeys = () => [...readFileSync(CONFIG, 'utf8').matchAll(/^\[hooks\.state\.(".*")\]$/gm)].map((m) => JSON.parse(m[1])).sort()
function sharedFixture(sharedHooks = false) {
  const seats = ['codex-prolite', 'codex-second'].map((name) => join(HOME, '.codex-seats', name))
  const config = '# shared original, without a final newline', hooks = '{ "keepCodex": true }\n', settings = '{ "keepClaude": true }\n'
  put(CONFIG, config); chmodSync(CONFIG, 0o640); put(HOOK_FILE, hooks); chmodSync(HOOK_FILE, 0o640)
  const settingsTarget = join(HOME, 'shared-settings.json')
  put(settingsTarget, settings); chmodSync(settingsTarget, 0o640); mkdirSync(dirname(SETTINGS), { recursive: true }); symlinkSync(settingsTarget, SETTINGS)
  for (const seat of seats) {
    mkdirSync(seat, { recursive: true }); symlinkSync(CONFIG, join(seat, 'config.toml'))
    if (sharedHooks) symlinkSync(HOOK_FILE, join(seat, 'hooks.json'))
  }
  listCodexHomes(seats)
  return { seats, homes: [CODEX, ...seats], config, hooks, settings }
}
function assertSharedTrusted(homes) {
  const status = install('status'); allowed(status)
  for (const home of homes) {
    assert.ok(status.stdout.includes(`Codex ${home}: entry present, trusted`), status.out)
    assert.ok(status.stdout.includes(`Codex ${home}: entry present, trusted, trust entry present, app-server trusted`), status.out)
  }
}
test('Shared config install merges three homes once, preserves symlinks and modes, and restores original bytes', () => {
  const fixture = sharedFixture()
  allowed(install('install'))
  assert.deepEqual(sharedKeys(), fixture.homes.map(sharedKey).sort())
  assert.equal(readFileSync(CONFIG, 'utf8').split('# review-gate agent guard begin').length - 1, 1)
  for (const seat of fixture.seats) assert.equal(lstatSync(join(seat, 'config.toml')).isSymbolicLink(), true)
  assert.equal(lstatSync(SETTINGS).isSymbolicLink(), true)
  assert.equal(statSync(CONFIG).mode & 0o777, 0o640); assert.equal(statSync(SETTINGS).mode & 0o777, 0o640)
  const backup = homeSnapshot(join(HOME, '.agent-config-studio/backups'))
  assert.equal(backup.filter((row) => row[3] === Buffer.from(fixture.config).toString('base64')).length, 1)
  assert.equal(backup.filter((row) => row[3] === Buffer.from(fixture.settings).toString('base64')).length, 1)
  allowed(install('uninstall'))
  assert.equal(readFileSync(CONFIG, 'utf8'), fixture.config)
  assert.equal(readFileSync(HOOK_FILE, 'utf8'), fixture.hooks)
  assert.equal(readFileSync(SETTINGS, 'utf8'), fixture.settings)
  for (const seat of fixture.seats) assert.equal(lstatSync(join(seat, 'config.toml')).isSymbolicLink(), true)
  assert.equal(lstatSync(SETTINGS).isSymbolicLink(), true)
})
test('Shared config status checks each home and remains read-only', () => {
  const { homes } = sharedFixture(); allowed(install('install'))
  const before = homeSnapshot(); assertSharedTrusted(homes); assert.deepEqual(homeSnapshot(), before)
})
test('Shared config reinstall is byte and mtime idempotent', () => {
  sharedFixture(); allowed(install('install'))
  const before = homeSnapshot(); allowed(install('install')); assert.deepEqual(homeSnapshot(), before)
})
test('Shared config partial uninstall removes only one seat then full uninstall restores the original', () => {
  const { homes, seats, config } = sharedFixture(); allowed(install('install'))
  allowed(install('uninstall', ['--codex-home', seats[0]]))
  assert.deepEqual(sharedKeys(), [homes[0], homes[2]].map(sharedKey).sort())
  assertSharedTrusted([homes[0], homes[2]])
  allowed(install('uninstall')); assert.equal(readFileSync(CONFIG, 'utf8'), config)
  assert.doesNotMatch(readFileSync(CONFIG, 'utf8'), /review-gate agent guard|hooks\.state/)
  for (const seat of seats) assert.equal(lstatSync(join(seat, 'config.toml')).isSymbolicLink(), true)
})
test('Shared config one-home install keeps other homes and replaces its key without duplicates', () => {
  const { homes } = sharedFixture(); allowed(install('install'))
  allowed(install('install', ['--codex-home', CODEX]))
  assert.deepEqual(sharedKeys(), homes.map(sharedKey).sort()); assertSharedTrusted(homes)
})
test('Shared hooks JSON keeps one handler and both seat keys through partial uninstall', () => {
  const { homes, seats, config, hooks } = sharedFixture(true); allowed(install('install'))
  assert.deepEqual(sharedKeys(), homes.map(sharedKey).sort())
  assert.equal(json(HOOK_FILE).hooks.PreToolUse.length, 1)
  const backup = homeSnapshot(join(HOME, '.agent-config-studio/backups'))
  assert.equal(backup.filter((row) => row[3] === Buffer.from(hooks).toString('base64')).length, 1)
  allowed(install('uninstall', ['--codex-home', seats[0]]))
  assert.equal(json(HOOK_FILE).hooks.PreToolUse.length, 1)
  assertSharedTrusted([homes[0], homes[2]])
  allowed(install('uninstall')); assert.equal(readFileSync(CONFIG, 'utf8'), config); assert.equal(readFileSync(HOOK_FILE, 'utf8'), hooks)
  for (const seat of seats) assert.equal(lstatSync(join(seat, 'hooks.json')).isSymbolicLink(), true)
})
test('Shared config status refuses a missing own block key even when RPC reports trusted', () => {
  put(CONFIG, '# original\n'); allowed(install('install'))
  put(CONFIG, readFileSync(CONFIG, 'utf8').replace(JSON.stringify(sharedKey(CODEX)), JSON.stringify('another-home-key')))
  const status = install('status', [], { STUB_RPC_TRUSTED: '1' }); allowed(status)
  assert.ok(status.stdout.includes(`Codex ${CODEX}: entry present, untrusted, trust entry missing, app-server trusted`), status.out)
})
test('Shared config partial uninstall never absorbs unrelated edits into its restoration baseline', () => {
  const { homes, seats } = sharedFixture(); allowed(install('install'))
  put(CONFIG, readFileSync(CONFIG, 'utf8') + '\n[human]\nkeep = true\n')
  allowed(install('uninstall', ['--codex-home', seats[0]])); assertSharedTrusted([homes[0], homes[2]])
  allowed(install('uninstall'))
  assert.match(readFileSync(CONFIG, 'utf8'), /\[human\]\nkeep = true/)
  assert.doesNotMatch(readFileSync(CONFIG, 'utf8'), /review-gate agent guard|hooks\.state/)
})
