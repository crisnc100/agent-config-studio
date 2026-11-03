import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Reviewer routing by diff size, shadow reviewers, and --shadow-report. Stub CLIs (each records its calls, and can
// sleep or fail on request), a temporary HOME and Git config, and the push gate through the installed hook.
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime')
const ROOT = mkdtempSync(join(tmpdir(), 'review-routing-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), REMOTE = join(ROOT, 'remote.git')
const SKILL = join(HOME, '.agent-config-studio/review-gate'), SCRIPT = join(SKILL, 'review.mjs')
const LOGS = join(HOME, '.agent-config-studio/review-log'), LOG = join(LOGS, 'review-log.jsonl'), SHADOW = join(LOGS, 'shadow-log.jsonl')
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
if (${JSON.stringify(name)} === 'grok' && a[0] === 'inspect') {
  fs.writeFileSync(path.join(${JSON.stringify(CALLS)}, 'grok-inspect-' + process.pid + '.json'), '{}')
  console.log(process.env.STUB_GROK_INSPECT || JSON.stringify({ mcpServers: [], plugins: [] })); process.exit(0)
}
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8') : a[a.indexOf('--json-schema')+1]
const scores = schema.includes('"scores"')
const prompt = a.includes('--output-schema') ? a.at(-1) : a[1]
const seen = fs.existsSync('src/a.js') ? fs.readFileSync('src/a.js', 'utf8') : null
if (!scores) fs.writeFileSync(path.join(${JSON.stringify(CALLS)}, ${JSON.stringify(name)} + '-' + process.pid + '.json'), JSON.stringify({ start: Date.now(), prompt, cwd: process.cwd(), seen }))
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
async function shadowRecords(count, ms = 15000) {
  for (const until = Date.now() + ms; Date.now() < until; await new Promise((r) => setTimeout(r, 50)))
    if (records(SHADOW).length >= count) return records(SHADOW)
  throw new Error(`no ${count} shadow record(s) within ${ms} ms: ${JSON.stringify(records(SHADOW))}`)
}

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

test('S1 a shadow runs detached after the real review and never touches its log, close, summary or push', async () => {
  config({ routing: ROUTING, shadow: ['grok'] })
  commit({ 'src/a.js': lines(10) })
  const finding = { issue: 'grok saw this', file: 'src/a.js', line: '3', quote: 'export const x2 = 2', suggestion: 's', likelihood: 5, impact: 5, protected: false, trigger: 't' }
  const started = Date.now()
  const r = script([], { STUB_SLEEP_GROK: '2500', STUB_FINDINGS_GROK: JSON.stringify({ findings: [finding] }) })
  allowed(r)
  assert.ok(Date.now() - started < 2500, `the real review did not wait for the shadow (${Date.now() - started} ms)`)
  assert.match(r.stdout, /▶ shadow · grok started in the background for \S+/)
  const review = records().at(-1)
  assert.equal(review.family, 'opus')
  const status = join(ROOT, 'status.json'); writeFileSync(status, '{}')
  allowed(script(['--close', review.id, '--status', status, '--test-cmd', 'true']))
  const summary = script(['--summary']); allowed(summary)
  allowed(run('git', ['push', 'origin', 'HEAD:refs/heads/feat']))
  assert.deepEqual(records().map((e) => e.type), ['review', 'close'])
  const [shadow] = await shadowRecords(1)
  assert.deepEqual([shadow.type, shadow.reviewId, shadow.family, shadow.model, shadow.ok], ['shadow', review.id, 'grok', IDS.grok, true])
  assert.ok(shadow.durationMs >= 2500, shadow.durationMs)
  assert.deepEqual(shadow.findings.map((f) => [f.file, f.line, f.issue, f.severity]), [['src/a.js', '3', 'grok saw this', 'medium']])
  assert.deepEqual(records().map((e) => e.type), ['review', 'close'], 'the shadow wrote nothing to the review log')
  assert.doesNotMatch(summary.stdout, /grok|shadow/)
  assert.ok(!readdirSync(join(REPO, 'reviews')).some((d) => d.includes('shadow')))
})

test('S2 a shadow that fails, is refused or names an unknown family is logged, never raised', async () => {
  config({ routing: ROUTING, shadow: ['opus', 'grok', 'nosuch'] })
  commit({ 'src/b.js': lines(300, 'b') })
  const r = script([], { STUB_FAIL_CLAUDE: '1', STUB_GROK_INSPECT: JSON.stringify({ mcpServers: [{ name: 'jev' }], plugins: [{ name: 'supabase', provides: { mcpServers: 1 } }] }) })
  allowed(r)
  assert.equal(records().at(-1).family, 'sol')
  const byFamily = Object.fromEntries((await shadowRecords(3)).map((s) => [s.family, s]))
  assert.equal(byFamily.opus.ok, false); assert.match(byFamily.opus.error, /claude review|exited|stub failure/)
  assert.equal(byFamily.grok.ok, false)
  assert.match(byFamily.grok.error, /^refused: grok would start MCP servers no flag keeps out of a run \(jev, supabase \(plugin\)\)/)
  assert.deepEqual(calls('grok'), [], 'a refused grok is never asked to review')
  assert.equal(byFamily.nosuch.ok, false)
})

test('S3 a tracked repo config cannot start shadows', () => {
  rmSync(CONF, { force: true })
  commit({ '.claude/review-config.json': JSON.stringify({ shadow: ['grok'] }), 'src/a.js': lines(10) })
  const r = script([], { REVIEW_CONFIG: '' })
  allowed(r)
  assert.match(r.out, /Ignoring shadow in \.claude\/review-config\.json/)
  assert.doesNotMatch(r.out, /▶ shadow/)
})

test('S4 --shadow-report counts matches, unique and missed findings per family, and their average duration', () => {
  const real = (id, findingDetails) => ({ type: 'review', kind: 'review', id, head: 'h', family: 'sol', findingDetails })
  const shadow = (fields) => ({ type: 'shadow', ts: '2026-11-01T12:00:00.000Z', ok: true, findings: [], ...fields })
  appendFileSync(LOG, [
    real('r1', [{ file: 'src/a.js', line: '10', quote: 'const x = 1' }, { file: 'src/b.js', line: '3', quote: 'foo()' }]),
    real('r2', [{ file: 'lib/c.js', line: '7', quote: 'bar' }]),
  ].map((e) => JSON.stringify(e)).join('\n') + '\n')
  appendFileSync(SHADOW, [
    // Same file (b/ prefix dropped) and 3 lines off; a quote match on another file; one that matches nothing.
    shadow({ reviewId: 'r1', family: 'grok', durationMs: 1000, findings: [
      { file: 'b/src/a.js', line: '13', quote: 'zzz' }, { file: 'x.js', line: '1', quote: '  foo()  ' }, { file: 'src/a.js', line: '40', quote: 'other' }] }),
    shadow({ reviewId: 'r2', family: 'grok', durationMs: 3000 }),
    shadow({ reviewId: 'r1', family: 'grok', ok: false, error: 'refused', durationMs: 5 }),
    shadow({ reviewId: 'r1', family: 'opus', durationMs: 500, ts: '2026-10-01T00:00:00.000Z', findings: [{ file: 'src/b.js', line: '9', quote: 'q' }] }),
    shadow({ reviewId: 'gone', family: 'opus', durationMs: 700, ts: '2026-10-02T00:00:00.000Z' }),
  ].map((e) => JSON.stringify(e)).join('\n') + '\n')
  const r = script(['--shadow-report']); allowed(r)
  const out = r.stdout.trim().split('\n')
  assert.deepEqual(out.slice(1), [
    'grok: 3 run(s), 1 failed; 3 finding(s): 2 matched, 1 unique; missed 1 of 3 real finding(s); average 2000 ms',
    'opus: 2 run(s), 0 failed, 1 with no real review in this log; 1 finding(s): 0 matched, 1 unique; missed 2 of 2 real finding(s); average 500 ms',
  ])
  const since = script(['--shadow-report', '--since', '2026-10-15']); allowed(since)
  assert.deepEqual(since.stdout.trim().split('\n').slice(1), ['grok: 3 run(s), 1 failed; 3 finding(s): 2 matched, 1 unique; missed 1 of 3 real finding(s); average 2000 ms'])
  const bad = script(['--shadow-report', '--since', 'soon'])
  assert.notEqual(bad.status, 0); assert.match(bad.out, /--since needs a date/)
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
test('F1 a shadow reviews the reviewed commit, not the live checkout, and checks its quotes there', async () => {
  config({ routing: ROUTING, shadow: ['grok'] })
  commit({ 'src/a.js': lines(10) })
  const reviewed = readFileSync(join(REPO, 'src/a.js'), 'utf8')
  const located = { issue: 'reviewed line', file: 'src/a.js', line: '3', quote: 'export const x2 = 2', suggestion: 's', likelihood: 5, impact: 5, protected: false, trigger: 't' }
  const made = { ...located, issue: 'made up', line: '1', quote: 'nothing like this' }
  allowed(script([], { STUB_SLEEP_GROK: '2000', STUB_FINDINGS_GROK: JSON.stringify({ findings: [located, made] }) }))
  // While the shadow runs, the branch moves on: the reviewed line is gone from the checkout and HEAD.
  commit({ 'src/a.js': 'rewritten\n' })
  const [shadow] = await shadowRecords(1)
  const call = callOf('grok')
  assert.ok(!call.cwd.startsWith(realpathSync(REPO)) && /review-shadow-snapshot-/.test(call.cwd), `the shadow ran in a snapshot, not the live checkout: ${call.cwd}`)
  assert.equal(call.seen, reviewed, 'the shadow read the reviewed version of the file')
  assert.deepEqual(shadow.findings.map((f) => [f.issue, f.status]), [['reviewed line', 'verified-quote'], ['made up', 'unverified-quote']])
  assert.match(shadow.findings[1].quoteCheck, /quote not found/)
  assert.ok(!existsSync(call.cwd), 'the snapshot is removed afterwards')
})

test('F3 a shadow gets the same verify result in its prompt as the real reviewer', async () => {
  config({ routing: ROUTING, shadow: ['grok'], verifyCmd: 'true' })
  commit({ 'src/a.js': lines(10) })
  allowed(script([]))
  await shadowRecords(1)
  const real = callOf('claude').prompt, shadow = callOf('grok').prompt
  assert.match(real, /This repo's verification command `true` PASSED before this review/)
  assert.match(shadow, /This repo's verification command `true` PASSED before this review/)
})

test('F4 an invalid shadow entry is a failure record, and the real review still prints its result', async () => {
  for (const shadow of [['grok', 'Not A Family!'], 42]) {
    rmSync(SHADOW, { force: true }); rmSync(LOG, { force: true })
    config({ routing: ROUTING, shadow })
    git('reset', '-q', '--hard', 'main'); commit({ 'src/a.js': lines(10) })
    const r = script([])
    allowed(r)
    assert.match(r.stdout, /===FINDINGS_JSON===/)
    assert.equal(records().length, 1)
    const logged = await shadowRecords(Array.isArray(shadow) ? 2 : 1)
    const bad = logged.find((e) => e.family !== 'grok')
    assert.equal(bad.ok, false); assert.match(bad.error, /not a family name/)
  }
})

test('F2 --shadow-report leaves findings that failed the quote check out of matched and unique', () => {
  appendFileSync(LOG, JSON.stringify({ type: 'review', kind: 'review', id: 'r1', head: 'h', family: 'sol', findingDetails: [{ file: 'src/a.js', line: '10', quote: 'const x = 1' }] }) + '\n')
  appendFileSync(SHADOW, JSON.stringify({ type: 'shadow', ts: '2026-11-01T00:00:00.000Z', reviewId: 'r1', family: 'grok', ok: true, durationMs: 100, findings: [
    { file: 'src/a.js', line: '11', quote: 'const x = 1', status: 'verified-quote' },
    { file: 'src/a.js', line: '10', quote: 'const x = 1', status: 'unverified-quote' },
    { file: 'elsewhere.js', line: '1', quote: 'nope', status: 'unverified-quote' }] }) + '\n')
  const r = script(['--shadow-report']); allowed(r)
  assert.equal(r.stdout.trim().split('\n')[1], 'grok: 1 run(s), 0 failed; 1 finding(s): 1 matched, 0 unique, 2 unlocated; missed 0 of 1 real finding(s); average 100 ms')
})
