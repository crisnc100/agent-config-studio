import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Reviewer routing by diff size and grok runs. Stub CLIs (each records its calls, and can
// sleep or fail on request), a temporary HOME and Git config, and the push gate through the installed hook.
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime')
const ROOT = mkdtempSync(join(tmpdir(), 'review-routing-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), REMOTE = join(ROOT, 'remote.git')
const SKILL = join(HOME, '.agent-config-studio/review-gate'), SCRIPT = join(SKILL, 'review.mjs')
const LOGS = join(HOME, '.agent-config-studio/review-log'), LOG = join(LOGS, 'review-log.jsonl')
const BIN = join(ROOT, 'bin'), CALLS = join(ROOT, 'calls'), CONF = join(ROOT, 'config.json')
mkdirSync(BIN)
const stub = (name, body) => {
  writeFileSync(join(BIN, name), `#!${process.execPath}\n${body}`)
  chmodSync(join(BIN, name), 0o755)
}
const IDS = { sol: 'gpt-stub-sol', opus: 'claude-stub-opus', grok: 'grok-stub', fable: 'claude-stub-fable' }
stub('model-id', `const a=process.argv.slice(2), ids=${JSON.stringify(IDS)}; console.log(a[0]==='--role' ? JSON.stringify({use:Object.keys(ids),ids:Object.values(ids)}) : a[0]==='--flavor' ? JSON.stringify({flavor:{effort:'high'}}) : ids[a[0]] || 'stub-'+a[0])`)
const modelBody = (name) => `
const fs = require('node:fs'), path = require('node:path')
const a = process.argv.slice(2)
if (a[0] === 'mcp') { console.log('[]'); process.exit(0) }
// The HOME and GROK_HOME this call got, and how many entries HOME held then.
const seenEnv = () => ({ home: process.env.HOME ?? null, grokHome: process.env.GROK_HOME ?? null,
  homeEntries: (() => { try { return fs.readdirSync(process.env.HOME).length } catch { return null } })() })
if (${JSON.stringify(name)} === 'grok' && a[0] === 'inspect') {
  fs.writeFileSync(path.join(${JSON.stringify(CALLS)}, 'grok-inspect-' + process.pid + '.json'), JSON.stringify(seenEnv()))
  console.log(process.env.STUB_GROK_INSPECT || JSON.stringify({ mcpServers: [], plugins: [] })); process.exit(0)
}
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8') : a[a.indexOf('--json-schema')+1]
const scores = schema.includes('"scores"')
const prompt = a.includes('--output-schema') ? a.at(-1) : a[1]
const seen = fs.existsSync('src/a.js') ? fs.readFileSync('src/a.js', 'utf8') : null
if (!scores) fs.writeFileSync(path.join(${JSON.stringify(CALLS)}, ${JSON.stringify(name)} + '-' + process.pid + '.json'), JSON.stringify({ start: Date.now(), prompt, cwd: process.cwd(), seen, ...seenEnv() }))
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.STUB_SLEEP_${name.toUpperCase()} || 0))
if (process.env.STUB_FAIL_${name.toUpperCase()}) { process.stderr.write('stub failure'); process.exit(1) }
const reply = scores ? '{"scores":[]}' : (process.env.STUB_FINDINGS_${name.toUpperCase()} || '{"findings":[]}')
const model = a[a.indexOf(${JSON.stringify(name)} === 'claude' ? '--model' : '-m') + 1]
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1], reply)
else console.log(JSON.stringify({structured_output:JSON.parse(reply),structuredOutput:JSON.parse(reply),modelUsage:{[model]:{}}}))
`
for (const name of ['codex', 'claude', 'grok']) stub(name, modelBody(name))
stub('jev', 'process.exit(1)')
after(() => rmSync(ROOT, { recursive: true, force: true }))

const env = (extra = {}) => ({ HOME, CODEX_HOME: join(HOME, '.codex'), GROK_HOME: join(HOME, '.grok'), GIT_CONFIG_GLOBAL: join(HOME, 'isolated.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1', PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: ROOT, REVIEW_BASE: 'main', REVIEW_CONFIG: CONF, ...extra })
function run(command, args, extra = {}) {
  const r = spawnSync(command, args, { cwd: REPO, env: env(extra), encoding: 'utf8', timeout: 60000 })
  return { ...r, out: `${r.stdout || ''}\n${r.stderr || ''}` }
}
const script = (args, extra = {}) => run(process.execPath, [SCRIPT, ...args], extra)
function git(...args) {
  const r = run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  assert.equal(r.status, 0, r.out)
  return r.stdout.trim()
}
function commit(files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(REPO, path)), { recursive: true })
    writeFileSync(join(REPO, path), text)
  }
  git('add', ...Object.keys(files)); git('commit', '-qm', `change ${Object.keys(files).join(' ')}`)
}
const lines = (n, tag = 'x') => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i}`).join('\n') + '\n'
const config = (doc) => writeFileSync(CONF, JSON.stringify(doc))
const ROUTING = [{ maxLines: 150, family: 'opus' }, { family: 'sol' }]
const allowed = (r) => assert.equal(r.status, 0, r.out)
const show = (extra = {}) => { const r = script(['--show-config'], extra); allowed(r); return JSON.parse(r.stdout) }
const records = (file = LOG) => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const calls = (name) => readdirSync(CALLS).filter((f) => f.startsWith(`${name}-`) && !f.startsWith('grok-inspect'))

beforeEach(() => {
  for (const path of [HOME, REPO, REMOTE, CALLS, CONF]) rmSync(path, { recursive: true, force: true })
  mkdirSync(SKILL, { recursive: true }); mkdirSync(LOGS, { recursive: true }); mkdirSync(REPO); mkdirSync(CALLS)
  copyFileSync(join(SOURCE, 'review.mjs'), SCRIPT)
  cpSync(join(SOURCE, 'hooks'), join(SKILL, 'hooks'), { recursive: true, verbatimSymlinks: true })
  git('init', '-q', '-b', 'main')
  commit({ 'README.md': 'base\n', 'src/a.js': lines(5) })
  git('checkout', '-qb', 'feat')
  git('init', '--bare', '-q', REMOTE)
  git('remote', 'add', 'origin', REMOTE)
  allowed(run('sh', [join(SKILL, 'hooks/install-hook.sh'), REPO]))
})

test('R1 routing: a small diff goes to the small family, a large one to the catch-all, and a risky one is never small', () => {
  config({ routing: ROUTING })
  commit({ 'src/a.js': lines(10) })
  const small = show()
  assert.equal(small.selected.family, 'opus')
  assert.match(small.why, /^route: \d+ changed line\(s\), under 150 → opus$/)
  assert.equal(small.route, small.why)
  assert.deepEqual(small.routing, ROUTING)
  commit({ 'src/b.js': lines(200, 'b') })
  const large = show()
  assert.equal(large.selected.family, 'sol')
  assert.match(large.why, /^route: \d+ changed line\(s\) → sol \(the catch-all\)$/)
  git('reset', '-q', '--hard', 'main')
  commit({ 'auth/login.js': 'export const login = 1\n' })
  const risky = show()
  assert.equal(risky.selected.family, 'sol')
  assert.match(risky.why, /^route: 1 changed line\(s\), riskPaths touched → sol/)
  // The force rule still wins over routing.
  config({ routing: ROUTING, force: [{ paths: 'risk', family: 'fable' }] })
  const forced = show()
  assert.equal(forced.selected.family, 'fable'); assert.match(forced.why, /^force: risk paths/)
  assert.match(forced.route, /not used/)
})

test('R2 routing: a pick overrides it (REVIEW_PICK for one run, config pick with a note), and crossFamily does not strip it', () => {
  config({ routing: ROUTING })
  commit({ 'src/b.js': lines(200, 'b') })
  const env = show({ REVIEW_PICK: 'opus' })
  assert.equal(env.selected.family, 'opus')
  assert.ok(env.notes.includes('ℹ REVIEW_PICK=opus overrides routing for this run'), env.notes.join('\n'))
  config({ routing: ROUTING, pick: 'first' })
  const conf = show()
  assert.equal(conf.selected.family, 'sol'); assert.match(conf.why, /pick=first/)
  assert.ok(conf.notes.includes('ℹ config "pick"=first overrides routing — remove it to route reviews by size'), conf.notes.join('\n'))
  config({ routing: ROUTING })
  git('reset', '-q', '--hard', 'main'); commit({ 'src/a.js': lines(8) })
  const author = show({ REVIEW_AUTHOR: 'opus' })
  assert.equal(author.selected.family, 'opus', 'a small diff goes to opus even when an Anthropic model built it')
})

test('R3 grok is never routed to unless named; with no routing configured, pick decides as before', () => {
  config({ routing: ROUTING })
  assert.ok(show().pool.some((m) => m.family === 'grok'), 'grok is in the reviewer role')
  for (const files of [{ 'src/a.js': lines(10) }, { 'src/b.js': lines(400, 'b') }, { 'auth/x.js': 'x\n' }]) {
    commit(files)
    assert.notEqual(show().selected.family, 'grok')
  }
  assert.equal(show({ REVIEW_REVIEWER: 'grok' }).selected.family, 'grok')
  config({})
  const plain = show()
  assert.equal(plain.selected.family, 'sol'); assert.match(plain.why, /pick=first/)
  assert.equal(plain.route, '(no routing configured)'); assert.equal(plain.routing, '(none)')
  config({ routing: [{ maxLines: 10, family: 'opus' }] })
  const bad = script(['--show-config'])
  assert.notEqual(bad.status, 0); assert.match(bad.out, /config "routing" must be a list .* with one that has no maxLines/)
})

test('R4 a fix check routes on the fix diff', () => {
  config({ routing: ROUTING })
  commit({ 'src/b.js': lines(300, 'b') })
  allowed(script([]))
  const review = records().at(-1)
  assert.equal(review.family, 'sol')
  commit({ 'src/b.js': lines(300, 'b').replace('b0 = 0', 'b0 = 1') })
  allowed(script(['--fix-check', review.id]))
  const check = records().at(-1)
  assert.equal(check.kind, 'fix-check'); assert.equal(check.family, 'opus')
})

test('G1 a real grok review refuses, with nothing logged, when grok inspect shows MCP servers or project hooks that would start', () => {
  commit({ 'src/a.js': lines(10) })
  for (const [inspect, why] of [
    [{ mcpServers: [{ name: 'jev' }], plugins: [] }, /grok review refused: grok would start MCP servers no flag keeps out of a run \(jev\)/],
    [{ mcpServers: [{ name: 'Neon', compatibilityStatus: 'disabled' }], plugins: [{ name: 'vercel', provides: { mcpServers: 1 } }] }, /\(vercel \(plugin\)\)/],
    [{ mcpServers: [], plugins: [], hooks: [{ event: 'PreToolUse', source: { type: 'project', path: '.grok/hooks/x.json' } }] }, /grok would run this project's hooks \(\.grok\/hooks\/x\.json\)/],
    [{ plugins: [] }, /grok inspect --json has no mcpServers and plugins lists/],
  ]) {
    const r = script([], { REVIEW_REVIEWER: 'grok', STUB_GROK_INSPECT: JSON.stringify(inspect) })
    assert.notEqual(r.status, 0, r.out)
    assert.match(r.out, why)
    assert.deepEqual(calls('grok'), [], 'no grok review call was made')
    assert.deepEqual(records(), [], 'nothing was logged')
  }
  // Disabled sources and plugins with no MCP servers are fine: the review runs.
  const ok = script([], { REVIEW_REVIEWER: 'grok', STUB_GROK_INSPECT: JSON.stringify({
    mcpServers: [{ name: 'Neon', compatibilityStatus: 'disabled' }, { name: 'off', enabled: false }],
    plugins: [{ name: 'resend', provides: { mcpServers: 0 } }, { name: 'vercel', enabled: false, provides: { mcpServers: 1 } }] }) })
  allowed(ok)
  assert.equal(records().at(-1).family, 'grok')
  assert.equal(calls('grok').length, 1)
})

const callOf = (name) => JSON.parse(readFileSync(join(CALLS, calls(name)[0]), 'utf8'))

const inspects = () => readdirSync(CALLS).filter((f) => f.startsWith('grok-inspect')).map((f) => JSON.parse(readFileSync(join(CALLS, f), 'utf8')))
const jevAt = (where) => ({ STUB_GROK_INSPECT: JSON.stringify({ mcpServers: [{ name: 'jev', source: { type: 'configToml', path: where } }], plugins: [] }) })
test('G2 a grok review runs with an empty temporary HOME and the real GROK_HOME, and only a listed grok-native server may start', () => {
  commit({ 'src/a.js': lines(10) })
  const grokHome = join(HOME, '.grok')
  config({ grokMcpAllow: ['jev'] })
  const ok = script([], { REVIEW_REVIEWER: 'grok', ...jevAt(join(grokHome, 'config.toml')) })
  allowed(ok)
  const [ins] = inspects(), call = callOf('grok')
  assert.ok(ins.home && ins.home === call.home && ins.home !== HOME, `one temporary HOME for the check and the call: ${ins.home}`)
  assert.deepEqual([ins.homeEntries, call.homeEntries, ins.grokHome, call.grokHome], [0, 0, grokHome, grokHome])
  assert.ok(!existsSync(ins.home), 'the temporary HOME is removed')
  const refusedWith = (why, extra = {}) => {
    rmSync(CALLS, { recursive: true }); mkdirSync(CALLS); rmSync(LOG, { force: true })
    const r = script([], { REVIEW_REVIEWER: 'grok', ...extra })
    assert.notEqual(r.status, 0, r.out); assert.match(r.out, why)
    assert.deepEqual(calls('grok'), []); assert.deepEqual(records(), [])
  }
  refusedWith(/grok would start MCP servers no flag keeps out of a run \(jev\)/, jevAt(join(REPO, '.grok', 'config.toml')))
  config({})
  refusedWith(/\(jev\).*grokMcpAllow/, jevAt(join(grokHome, 'config.toml')))
  assert.equal(script([], { REVIEW_REVIEWER: 'grok', REVIEW_GROK_MCP_ALLOW: 'jev', ...jevAt(join(grokHome, 'config.toml')) }).status, 0, 'REVIEW_GROK_MCP_ALLOW lists it for one run')
  config({ grokMcpAllow: ['jev', 3] })
  refusedWith(/grokMcpAllow must be a list of server names/, jevAt(join(grokHome, 'config.toml')))
  config({ grokMcpAllow: ['jev'] })
  mkdirSync(grokHome, { recursive: true }); writeFileSync(join(grokHome, 'config.toml'), '[cli]\nuse_leader = true\n')
  refusedWith(/grok's leader mode is on \(use_leader in .*\.grok\/config\.toml\)/, jevAt(join(grokHome, 'config.toml')))
  assert.deepEqual(inspects(), [], 'leader mode refuses before grok inspect runs')
})

test('G3 a tracked repo config cannot allow a grok MCP server', () => {
  rmSync(CONF, { force: true })
  commit({ '.claude/review-config.json': JSON.stringify({ grokMcpAllow: ['jev'] }), 'src/a.js': lines(10) })
  const r = script([], { REVIEW_CONFIG: '', REVIEW_REVIEWER: 'grok', ...jevAt(join(HOME, '.grok', 'config.toml')) })
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /Ignoring grokMcpAllow in \.claude\/review-config\.json/)
  assert.match(r.out, /grok would start MCP servers no flag keeps out of a run \(jev\)/)
})

test('G5 grok leader mode in any TOML spelling or a macOS managed payload refuses, and a relative GROK_HOME is made absolute', () => {
  commit({ 'src/a.js': lines(10) })
  const grokHome = join(HOME, '.grok')
  const refusedWith = (why, extra = {}) => {
    rmSync(CALLS, { recursive: true }); mkdirSync(CALLS); rmSync(LOG, { force: true })
    const r = script([], { REVIEW_REVIEWER: 'grok', ...extra })
    assert.notEqual(r.status, 0, r.out); assert.match(r.out, why)
    assert.deepEqual(calls('grok'), []); assert.deepEqual(inspects(), []); assert.deepEqual(records(), [])
  }
  mkdirSync(grokHome, { recursive: true })
  for (const toml of ['[cli]\n"use_leader" = true\n', "[ cli ]\n'use_leader'=true # shared\n", 'cli = { use_leader = true }\n']) {
    writeFileSync(join(grokHome, 'config.toml'), toml)
    refusedWith(/grok's leader mode is on \(use_leader in .*\.grok\/config\.toml\)/)
  }
  writeFileSync(join(grokHome, 'config.toml'), '[cli]\nuse_leader = "yes"\n')
  refusedWith(/grok's leader mode could not be ruled out \(.*\.grok\/config\.toml: cli\.use_leader set to something other than true or false/)
  writeFileSync(join(grokHome, 'config.toml'), '[other]\nuse_leader = true\n')
  allowed(script([], { REVIEW_REVIEWER: 'grok' }))

  if (process.platform === 'darwin') {
    const prefs = join(ROOT, 'managed-prefs')
    mkdirSync(prefs, { recursive: true })
    const plist = (body) => writeFileSync(join(prefs, 'ai.x.grok.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${body}</dict></plist>\n`)
    plist(`<key>requirements_toml_base64</key><string>${Buffer.from('[cli]\nuse_leader = true\n').toString('base64')}</string>`)
    refusedWith(/grok's leader mode is on \(use_leader in .*ai\.x\.grok\.plist \(requirements_toml_base64\)\)/, { GROK_TEST_MANAGED_PREFS: prefs })
    writeFileSync(join(prefs, 'ai.x.grok.plist'), 'not a plist')
    refusedWith(/could not be ruled out \(.*ai\.x\.grok\.plist: plutil could not read it\)/, { GROK_TEST_MANAGED_PREFS: prefs })
    rmSync(prefs, { recursive: true })
  }

  // A relative GROK_HOME: the real call gets it made absolute.
  rmSync(CALLS, { recursive: true }); mkdirSync(CALLS)
  allowed(script([], { REVIEW_REVIEWER: 'grok', GROK_HOME: 'rel-grok' }))
  assert.equal(callOf('grok').grokHome, join(realpathSync(REPO), 'rel-grok'))
})

// ── removed: shadow reviewers and shadow pickers ────────────────────────────
const HOME_CONFIG = join(SKILL, 'config.json')
const SHADOW_NOTE = 'ignored: shadow pickers were removed'

test('D1 a home config that still has shadow, pickShadow and grokMcpAllow runs a normal review with one note and no shadow job', async () => {
  writeFileSync(HOME_CONFIG, JSON.stringify({ routing: ROUTING, shadow: ['grok'], pickShadow: ['grok', 'opus'], grokMcpAllow: ['jev'] }))
  commit({ 'src/a.js': lines(10) })
  const r = script([], { REVIEW_CONFIG: '' })
  allowed(r)
  assert.equal(r.stderr.split('\n').filter((l) => l.includes(SHADOW_NOTE)).length, 1, r.stderr)
  assert.doesNotMatch(r.out, /▶ (pick-)?shadow/)
  assert.deepEqual(records().map((e) => [e.type, e.family]), [['review', 'opus']])
  // A detached job would have called grok and written the shadow log by now.
  await new Promise((done) => setTimeout(done, 2000))
  assert.deepEqual(calls('grok'), [])
  assert.equal(existsSync(join(LOGS, 'shadow-log.jsonl')), false)
  assert.deepEqual(readdirSync(ROOT).filter((d) => /^review-(pick-)?shadow-/.test(d)), [], 'no shadow job folder')
})

test('D2 REVIEW_SHADOW and REVIEW_PICK_SHADOW get the same note and start nothing; a config without the keys gets no note', async () => {
  config({ routing: ROUTING })
  commit({ 'src/a.js': lines(10) })
  const quiet = script([])
  allowed(quiet)
  assert.ok(!quiet.out.includes(SHADOW_NOTE), quiet.out)
  const r = script([], { REVIEW_SHADOW: 'grok', REVIEW_PICK_SHADOW: 'opus' })
  allowed(r)
  assert.equal(r.stderr.split('\n').filter((l) => l.includes(SHADOW_NOTE)).length, 1, r.stderr)
  assert.doesNotMatch(r.out, /▶ (pick-)?shadow/)
  await new Promise((done) => setTimeout(done, 2000))
  assert.deepEqual(calls('grok'), [])
  assert.equal(existsSync(join(LOGS, 'shadow-log.jsonl')), false)
})

test('D3 the removed commands are unknown flags: a plain error, no review, and an old shadow log is left as it was', () => {
  config({ routing: ROUTING })
  commit({ 'src/a.js': lines(10) })
  const old = `${JSON.stringify({ type: 'pick-shadow', reviewId: 'r', picker: 'jev', ok: true })}\n${JSON.stringify({ type: 'shadow', reviewId: 'r', family: 'grok', ok: true, findings: [] })}\n`
  writeFileSync(join(LOGS, 'shadow-log.jsonl'), old)
  for (const flag of [['--pick-report'], ['--shadow-report'], ['--pick-report', '--since', '2026-11-01'], ['--shadow-run', 'job.json'], ['--pick-shadow-run', 'job.json']]) {
    const r = script(flag)
    assert.equal(r.status, 1, r.out)
    assert.match(r.stderr, new RegExp(`unknown flag ${flag[0]}`), flag.join(' '))
    assert.doesNotMatch(r.out, /Review complete|===FINDINGS_JSON===/)
  }
  assert.deepEqual(records(), [], 'no review ran')
  assert.deepEqual(calls('claude'), [])
  assert.equal(readFileSync(join(LOGS, 'shadow-log.jsonl'), 'utf8'), old)
})
