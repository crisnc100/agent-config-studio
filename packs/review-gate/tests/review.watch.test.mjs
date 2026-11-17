import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Watching a review (acs-agent watch): inside cmux, a top-level run writes its run file and starts one detached
// watcher, and nothing else about the run changes. A stub acs-agent records how it was called (and the run files
// present when it started); stub model CLIs record whether they ran under a child marked REVIEW_WATCH_CHILD;
// a stub cmux records any call. Temporary HOME and Git config; no real model, watcher or cmux.
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(PACK, 'runtime', 'review.mjs')
const EXAMPLES = join(PACK, 'runtime', 'eval', 'examples')
const ROOT = mkdtempSync(join(tmpdir(), 'review-watch-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), BIN = join(ROOT, 'bin'), AGENT_BIN = join(ROOT, 'agent-bin')
const CALLS = join(ROOT, 'calls.jsonl'), AGENT_CALLS = join(ROOT, 'agent-calls.jsonl'), CMUX_CALLS = join(ROOT, 'cmux-calls.jsonl')
const CASES = join(ROOT, 'cases')
const HOME_CONFIG = join(HOME, '.agent-config-studio/review-gate/config.json')
const RUNS = join(HOME, '.agent-config-studio/runs')
const MARKER = 'SECURITY REVIEW ONLY.'
const WS = 'workspace:3'
mkdirSync(BIN); mkdirSync(AGENT_BIN)
const stub = (dir, name, body) => {
  writeFileSync(join(dir, name), `#!${process.execPath}\n${body}`)
  chmodSync(join(dir, name), 0o755)
}
stub(BIN, 'model-id', `
const a = process.argv.slice(2), ids = { sol: 'gpt-stub-sol', opus: 'claude-stub-opus', grok: 'grok-stub', fable: 'claude-stub-fable' }
if (a[0] === '--role') {
  const use = a[1] === 'security' ? ['opus', 'sol'] : ['sol', 'opus', 'grok']
  console.log(JSON.stringify({ use, ids: use.map((f) => ids[f]) }))
} else if (a[0] === '--flavor') console.log(JSON.stringify({ flavor: { effort: 'high' } }))
else console.log(ids[a[0]] || 'stub-' + a[0])
`)
stub(BIN, 'codex', modelStub())
stub(BIN, 'claude', modelStub())
stub(BIN, 'grok', modelStub())
function modelStub() {
  return `
const fs = require('node:fs')
const a = process.argv.slice(2), cli = require('node:path').basename(process.argv[1])
if (a[0] === 'mcp') { console.log('[]'); process.exit(0) }
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8') : a[a.indexOf('--json-schema')+1]
const prompt = cli === 'codex' ? a.at(-1) : a[a.indexOf('-p')+1]
const kind = schema.includes('"scores"') ? 'scores' : schema.includes('"verdicts"') ? 'verdicts' : prompt.includes(${JSON.stringify(MARKER)}) ? 'security' : 'code'
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ cli, kind, argv: a, child: process.env.REVIEW_WATCH_CHILD ?? null }) + '\\n')
const sleep = Number(process.env.STUB_SLEEP_MS || 0)
if (sleep) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleep)
const reply = kind === 'scores' ? '{"scores":[]}' : kind === 'verdicts' ? '{"verdicts":[]}'
  : kind === 'security' ? (process.env.STUB_SEC_FINDINGS || '{"findings":[]}') : (process.env.STUB_FINDINGS || '{"findings":[]}')
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1], reply)
else console.log(JSON.stringify({ structured_output: JSON.parse(reply), structuredOutput: JSON.parse(reply), modelUsage: { 'stub-grok': {} } }))
`
}
// STUB_AGENT_OLD: an acs-agent from before watch, which prints its usage and exits 2.
stub(AGENT_BIN, 'acs-agent', `
const fs = require('node:fs'), path = require('node:path')
const a = process.argv.slice(2), runs = path.join(process.env.HOME, '.agent-config-studio', 'runs')
let files = []
try { files = fs.readdirSync(runs).map((name) => ({ name, body: JSON.parse(fs.readFileSync(path.join(runs, name), 'utf8')) })) } catch {}
fs.appendFileSync(${JSON.stringify(AGENT_CALLS)}, JSON.stringify({ argv: a, ppid: process.ppid, runs: files, child: process.env.REVIEW_WATCH_CHILD ?? null }) + '\\n')
if (process.env.STUB_AGENT_OLD) { console.error('usage: acs-agent open <family>'); process.exit(2) }
if (a[0] === 'watch' && a[1] === '--version') console.log('acs-agent watch ' + (process.env.STUB_AGENT_VERSION || '1'))
`)
stub(BIN, 'cmux', `require('node:fs').appendFileSync(${JSON.stringify(CMUX_CALLS)}, JSON.stringify(process.argv.slice(2)) + '\\n'); console.log('OK')`)
after(() => rmSync(ROOT, { recursive: true, force: true }))

const CMUX = { CMUX_SOCKET_PATH: join(ROOT, 'cmux.sock'), CMUX_WORKSPACE_ID: WS }
const env = (extra = {}) => ({ HOME, CODEX_HOME: join(HOME, '.codex'), GROK_HOME: join(HOME, '.grok'), GIT_CONFIG_GLOBAL: join(HOME, 'isolated.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1', PATH: [BIN, AGENT_BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: ROOT, REVIEW_BASE: 'main',
  REVIEW_REVIEWER: 'sol', ...extra })
function run(command, args, extra = {}) {
  const r = spawnSync(command, args, { cwd: REPO, env: env(extra), encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024 * 1024 })
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
const lines = (file) => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const calls = () => lines(CALLS)
const agentCalls = () => lines(AGENT_CALLS)
const watchCalls = () => agentCalls().filter((c) => c.argv[0] === 'watch' && c.argv[1] !== '--version')
const probes = () => agentCalls().filter((c) => c.argv[0] === 'watch' && c.argv[1] === '--version')
const homeConfig = (config) => { mkdirSync(dirname(HOME_CONFIG), { recursive: true }); writeFileSync(HOME_CONFIG, JSON.stringify(config)) }
const allowed = (r) => assert.equal(r.status, 0, r.out)
const findingsJson = (r) => JSON.parse(r.stdout.slice(r.stdout.indexOf('===FINDINGS_JSON===') + 19))
const settle = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
// The watcher is detached: its stub may still be starting when the gate has exited.
function waitForWatch(count = 1) {
  const end = Date.now() + 10_000
  while (Date.now() < end && watchCalls().length < count) settle(25)
  settle(300)
  return watchCalls()
}
function noWatch() {
  settle(600)
  assert.deepEqual(watchCalls(), [], JSON.stringify(agentCalls()))
}
const APP = 'export const one = 1\nexport const two = 2\nexport const three = 3\n'
const finding = (over = {}) => ({ issue: 'one is wrong', file: 'src/app.ts', line: '1', quote: 'export const one = 1', suggestion: 'fix it',
  likelihood: 5, impact: 5, protected: false, trigger: 'importing app', ...over })
const findings = (...list) => JSON.stringify({ findings: list })

beforeEach(() => {
  for (const path of [HOME, REPO, CALLS, AGENT_CALLS, CMUX_CALLS, CASES]) rmSync(path, { recursive: true, force: true })
  mkdirSync(HOME); mkdirSync(REPO)
  git('init', '-q', '-b', 'main')
  commit({ 'README.md': 'base\n' })
  git('checkout', '-qb', 'feat')
  commit({ 'src/app.ts': APP })
})

test('1 a review inside cmux: one probe, one detached watcher for its own pid, its run file written first; the security worker starts none', () => {
  homeConfig({ security: { run: 'always' } })
  const r = script(['watch intent'], { ...CMUX, STUB_FINDINGS: findings(finding()) })
  allowed(r)
  const [w, ...more] = waitForWatch()
  assert.equal(more.length, 0, JSON.stringify(watchCalls()))
  assert.equal(probes().length, 1)
  const pid = w.argv[2]
  assert.deepEqual(w.argv, ['watch', '--pid', pid, '--kind', 'review', '--workspace', WS])
  assert.equal(String(w.ppid), pid, 'the gate itself starts the watcher, for its own pid')
  const runFiles = w.runs.filter((f) => f.body.pid === Number(pid))
  assert.equal(runFiles.length, 1, JSON.stringify(w.runs))
  const [file] = runFiles
  assert.match(file.name, /^[A-Za-z0-9-]+\.json$/)
  assert.deepEqual(Object.keys(file.body).sort(), ['branch', 'intent', 'kind', 'pid', 'started', 'version', 'workspace'])
  assert.equal(file.body.version, 1)
  assert.equal(file.body.branch, 'feat', "the branch checked out in the gate's cwd")
  assert.equal(file.body.kind, 'review')
  assert.equal(file.body.intent, 'watch intent')
  assert.equal(file.body.workspace, WS)
  assert.ok(Number.isFinite(Date.parse(file.body.started)))
  const security = calls().filter((c) => c.kind === 'security'), code = calls().filter((c) => c.kind === 'code')
  assert.equal(security.length, 1); assert.equal(code.length, 1)
  assert.equal(security[0].child, '1', 'the security worker runs marked as a child')
  assert.equal(code[0].child, null, 'the top-level run is not marked')
  for (const c of calls()) assert.ok(!c.argv.some((x) => /WATCH|acs-agent/.test(x)), 'no model CLI argv changes')
  assert.deepEqual(lines(CMUX_CALLS), [], 'the gate never calls cmux itself')
  assert.ok(!/acs-agent|watch(?:er)? /i.test(r.stdout + r.stderr), 'nothing about watching is printed')
})

test('2 watch: pane adds --pane; off (home config or REVIEW_WATCH) starts nothing and probes nothing', () => {
  homeConfig({ watch: 'pane' })
  allowed(script(['x'], CMUX))
  assert.deepEqual(waitForWatch()[0].argv.slice(-1), ['--pane'])
  rmSync(AGENT_CALLS, { force: true })
  homeConfig({ watch: 'off' })
  allowed(script(['x'], CMUX))
  noWatch()
  assert.deepEqual(agentCalls(), [])
  homeConfig({})
  allowed(script(['x'], { ...CMUX, REVIEW_WATCH: 'off' }))
  noWatch()
  assert.deepEqual(agentCalls(), [])
})

test('3 outside cmux, or a cmux shell without a workspace: watch 1 is only probed; watch 2 runs one --log-only watcher, no workspace, no cmux', () => {
  const outsides = [{}, { CMUX_SOCKET_PATH: CMUX.CMUX_SOCKET_PATH }, { ...CMUX, CMUX_WORKSPACE_ID: '--pane' }]
  for (const outside of outsides) {
    rmSync(AGENT_CALLS, { force: true })
    allowed(script(['x'], outside))
    noWatch()
    assert.equal(probes().length, 1, `probed once; watch 1 has no --log-only: ${JSON.stringify(outside)}`)
    assert.deepEqual(existsSync(RUNS) ? readdirSync(RUNS) : [], [], `no run file left: ${JSON.stringify(outside)}`)
  }
  homeConfig({ watch: 'pane' })
  for (const outside of outsides) {
    rmSync(AGENT_CALLS, { force: true })
    allowed(script(['x'], { ...outside, STUB_AGENT_VERSION: '2' }))
    const [w, ...more] = waitForWatch()
    assert.equal(more.length, 0, JSON.stringify(watchCalls()))
    assert.equal(probes().length, 1)
    const pid = w.argv[2]
    assert.deepEqual(w.argv, ['watch', '--pid', pid, '--kind', 'review', '--log-only'], 'log-only, even with watch: pane')
    assert.equal(String(w.ppid), pid)
    const file = w.runs.find((f) => f.body.pid === Number(pid))
    assert.ok(file, JSON.stringify(w.runs))
    assert.deepEqual(Object.keys(file.body).sort(), ['branch', 'intent', 'kind', 'pid', 'started', 'version'], 'no workspace outside cmux')
    assert.equal(file.body.branch, 'feat', "outside cmux too: the branch checked out in the gate's cwd")
  }
  rmSync(AGENT_CALLS, { force: true }); rmSync(RUNS, { recursive: true, force: true })
  homeConfig({ watch: 'off' })
  allowed(script(['x'], { STUB_AGENT_VERSION: '2' }))
  noWatch()
  assert.deepEqual(agentCalls(), [], 'watch off outside cmux: no probe')
  assert.deepEqual(existsSync(RUNS) ? readdirSync(RUNS) : [], [], 'watch off outside cmux: no run file')
  assert.deepEqual(lines(CMUX_CALLS), [], 'the gate never calls cmux itself')
})

test('4 acs-agent missing or too old: the review runs as before, no watcher, no run file left', () => {
  const missing = script(['x'], { ...CMUX, PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':') })
  allowed(missing)
  noWatch()
  const old = script(['x'], { ...CMUX, STUB_AGENT_OLD: '1' })
  allowed(old)
  noWatch()
  assert.equal(probes().length, 1, 'the old one is only probed')
  assert.deepEqual(existsSync(RUNS) ? readdirSync(RUNS) : [], [])
})

test('5 watch is home-config only: a tracked repo config cannot turn it on or to pane; an untracked one counts', () => {
  homeConfig({ watch: 'off' })
  commit({ '.claude/review-config.json': JSON.stringify({ watch: 'pane' }) })
  allowed(script(['x'], CMUX))
  noWatch()
  assert.deepEqual(agentCalls(), [])
  rmSync(HOME_CONFIG)
  allowed(script(['x'], CMUX))
  assert.deepEqual(waitForWatch()[0].argv.slice(-2), ['--workspace', WS], 'the default, sidebar, without --pane')
  git('rm', '-q', '--cached', '.claude/review-config.json'); git('commit', '-qm', 'untrack')
  rmSync(AGENT_CALLS, { force: true })
  allowed(script(['x'], CMUX))
  assert.deepEqual(waitForWatch()[0].argv.slice(-1), ['--pane'], 'your own untracked file counts')
})

test('6 --slices: one watcher for the parent; every slice child runs marked', () => {
  commit({ 'src/b.ts': 'export const b = 1\n' })
  const r = script(['--slices', 'src/app.ts;src/b.ts'], CMUX)
  allowed(r)
  const watched = waitForWatch()
  assert.equal(watched.length, 1, JSON.stringify(watched))
  assert.equal(watched[0].argv[4], 'review')
  const code = calls().filter((c) => c.kind === 'code')
  assert.equal(code.length, 2)
  for (const c of code) assert.equal(c.child, '1')
})

test('7 --eval: one watcher of kind eval; its case reviews run marked', () => {
  cpSync(EXAMPLES, CASES, { recursive: true })
  const r = script(['--eval', '--cases', CASES, '--family', 'sol'], CMUX)
  allowed(r)
  const watched = waitForWatch()
  assert.equal(watched.length, 1, JSON.stringify(watched))
  assert.equal(watched[0].argv[4], 'eval')
  assert.ok(calls().length >= 2)
  for (const c of calls()) assert.equal(c.child, '1')
})

test('8 --fix-check and --security-only start a watcher of their own kind', () => {
  const first = script(['x'], { STUB_FINDINGS: findings(finding()) })
  allowed(first)
  commit({ 'src/app.ts': APP.replace('one = 1', 'one = 11') })
  allowed(script(['--fix-check', findingsJson(first).reviewId], CMUX))
  assert.equal(waitForWatch()[0].argv[4], 'fix-check')
  rmSync(AGENT_CALLS, { force: true })
  allowed(script(['--security-only', 'x'], CMUX))
  assert.equal(waitForWatch()[0].argv[4], 'security')
})

// The same review, watch off and watch on: the console, the report and FINDINGS_JSON are equal once these are
// normalised, field by field: the review id (<kind>-<epoch ms>-<6 hex>) wherever it appears; the report folder and
// security pass names (<date>-<time>-<6 hex>); ISO timestamps; and durations (`durationMs` values, and seconds printed
// as `<n>s` or `<n.n>s`). Wall time stays within 2s.
function normalise(text) {
  return String(text)
    .replace(/\b([a-z]+)-\d{13}-[0-9a-f]{6}\b/g, '$1-ID')
    .replace(/\b\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[0-9a-f]{6}\b/g, 'FOLDER-ID')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, 'TS')
    .replace(/("durationMs":\s*)\d+/g, '$1N')
    .replace(/\b\d+(?:\.\d+)?s\b/g, 'Ns')
}
function reportText() {
  const dir = join(REPO, 'reviews')
  const runs = existsSync(dir) ? readdirSync(dir).filter((f) => f !== 'latest' && existsSync(join(dir, f, 'code-review.md'))).sort() : []
  assert.equal(runs.length, 1, 'one report was written')
  const text = readFileSync(join(dir, runs[0], 'code-review.md'), 'utf8')
  rmSync(dir, { recursive: true, force: true })
  return text
}
test('9 output unchanged: watch off and watch on give the same console, report and FINDINGS_JSON, within 2s', () => {
  homeConfig({ security: { run: 'always' } })
  const stubs = { STUB_FINDINGS: findings(finding()), STUB_SEC_FINDINGS: findings(finding({ issue: 'three leaks', line: '3', quote: 'export const three = 3' })) }
  const once = (watch) => {
    rmSync(join(HOME, '.agent-config-studio/review-log'), { recursive: true, force: true })
    const t = Date.now()
    const r = script(['same intent'], { ...CMUX, ...stubs, REVIEW_WATCH: watch })
    const ms = Date.now() - t
    allowed(r)
    return { r, ms, report: reportText(), json: findingsJson(r) }
  }
  const off = once('off')
  noWatch()
  const on = once('sidebar')
  assert.equal(waitForWatch().length, 1, 'the second run was watched')
  assert.equal(normalise(on.r.stdout), normalise(off.r.stdout))
  assert.equal(normalise(on.r.stderr), normalise(off.r.stderr))
  assert.equal(normalise(on.report), normalise(off.report))
  assert.equal(normalise(JSON.stringify(on.json)), normalise(JSON.stringify(off.json)))
  assert.equal(on.json.findings.length, 2)
  assert.ok(Math.abs(on.ms - off.ms) < 2000, `wall time off ${off.ms}ms, on ${on.ms}ms`)
})
