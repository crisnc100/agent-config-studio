import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Parallel slices: the log lock, report folders and reviews/latest under concurrent runs, and the --slices runner.
// Stub CLIs (the reviewer stub sleeps, so call windows can be compared), a temporary HOME and Git config.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'review.mjs')
const ROOT = mkdtempSync(join(tmpdir(), 'review-parallel-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), BIN = join(ROOT, 'bin'), CALLS = join(ROOT, 'calls')
const LOG = join(HOME, '.agent-config-studio/review-log/review-log.jsonl'), LOCK = `${LOG}.lock`
mkdirSync(BIN)
const stub = (name, body) => {
  writeFileSync(join(BIN, name), `#!${process.execPath}\n${body}`)
  chmodSync(join(BIN, name), 0o755)
}
stub('model-id', `const a=process.argv.slice(2), ids={sol:'gpt-stub-sol',opus:'claude-stub-opus',grok:'grok-stub'}; console.log(a[0]==='--role' ? JSON.stringify({use:['sol','opus','grok'],ids:['gpt-stub-sol','claude-stub-opus','grok-stub']}) : a[0]==='--flavor' ? JSON.stringify({flavor:{effort:'high'}}) : ids[a[0]] || 'stub-'+a[0])`)
const modelBody = `
const fs = require('node:fs'), path = require('node:path')
const a = process.argv.slice(2)
if (a[0] === 'mcp') { console.log('[]'); process.exit(0) }
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8') : a[a.indexOf('--json-schema')+1]
const start = Date.now()
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.STUB_SLEEP_MS || 0))
fs.writeFileSync(path.join(${JSON.stringify(CALLS)}, process.pid+'-'+start+'.json'), JSON.stringify({ start, end: Date.now() }))
const reply = schema.includes('"scores"') ? '{"scores":[]}' : (process.env.STUB_FINDINGS_FILE ? fs.readFileSync(process.env.STUB_FINDINGS_FILE, 'utf8') : '{"findings":[]}')
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1], reply)
else console.log(JSON.stringify({structured_output:JSON.parse(reply),structuredOutput:JSON.parse(reply),modelUsage:{'stub-grok':{}}}))
`
for (const name of ['codex', 'claude', 'grok']) stub(name, modelBody)
stub('jev', 'process.exit(1)')
after(() => rmSync(ROOT, { recursive: true, force: true }))

const env = (extra = {}) => ({ HOME, CODEX_HOME: join(HOME, '.codex'), GROK_HOME: join(HOME, '.grok'), GIT_CONFIG_GLOBAL: join(HOME, 'isolated.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1', PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: ROOT, REVIEW_BASE: 'main', REVIEW_REVIEWER: 'sol', ...extra })
function run(args, extra = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, env: env(extra), encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 })
  return { ...r, out: `${r.stdout || ''}\n${r.stderr || ''}` }
}
// Starts a run without waiting; resolves with its exit status and output.
function start(args, extra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: REPO, env: env(extra) })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (status) => resolve({ status, out }))
  })
}
function git(...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: REPO, env: env(), encoding: 'utf8' })
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  return r.stdout.trim()
}
function commit(files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(REPO, path)), { recursive: true })
    writeFileSync(join(REPO, path), text)
  }
  git('add', ...Object.keys(files)); git('commit', '-qm', `change ${Object.keys(files).join(' ')}`)
}
const lines = () => existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean) : []
const records = () => lines().map((line) => JSON.parse(line))
const allowed = (r) => assert.equal(r.status, 0, r.out)
// The largest number of model calls whose windows overlap.
function peak() {
  const calls = readdirSync(CALLS).map((p) => JSON.parse(readFileSync(join(CALLS, p), 'utf8')))
  const edges = calls.flatMap((c) => [[c.start, 1], [c.end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let now = 0, most = 0
  for (const [, step] of edges) most = Math.max(most, now += step)
  return { most, count: calls.length }
}
// A Grade record as large as a review with many findings, logged through the real --log-grade path.
function gradeFile(i, size = 200_000) {
  const path = join(ROOT, `grade-${i}.json`)
  writeFileSync(path, JSON.stringify({ family: 'fixture', model: 'fixture-only', vendor: 'codex',
    criteria: [{ id: `c${i}`, criterion: `criterion ${i}`, verdict: 'PASS', evidence: `${i}:`.padEnd(size, String(i % 10)) }] }))
  return path
}
const deadPid = () => {
  const r = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' })
  return Number(r.stdout.trim())
}

beforeEach(() => {
  for (const path of [HOME, REPO, CALLS]) rmSync(path, { recursive: true, force: true })
  mkdirSync(dirname(LOG), { recursive: true }); mkdirSync(REPO); mkdirSync(CALLS)
  git('init', '-q', '-b', 'main')
  commit({ 'README.md': 'base\n', 'a/x.js': 'a 1\n', 'b/x.js': 'b 1\n', 'c/x.js': 'c 1\n', 'd/x.js': 'd 1\n' })
  git('checkout', '-qb', 'feat')
  commit({ 'a/x.js': 'a 2\n', 'b/x.js': 'b 2\n', 'c/x.js': 'c 2\n', 'd/x.js': 'd 2\n' })
})

test('L1 twelve processes appending 200 KB records at once leave twelve intact lines and no lock', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => start(['--log-grade', gradeFile(i)])))
  for (const r of results) allowed(r)
  const logged = records()
  assert.equal(lines().length, 12)
  assert.deepEqual(logged.map((e) => e.criteria[0].id).sort(), Array.from({ length: 12 }, (_, i) => `c${i}`).sort())
  for (const e of logged) assert.equal(e.criteria[0].evidence.length, 200_000)
  assert.equal(new Set(logged.map((e) => e.id)).size, 12)
  assert.equal(existsSync(LOCK), false)
})

test('L2 an append waits for a live lock, takes over a dead or old one, and gives up on a live one after 10 s', async () => {
  writeFileSync(LOCK, `${process.pid} held-by-the-test`)
  const started = Date.now()
  const waiting = start(['--log-grade', gradeFile(1, 10)])
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(lines().length, 0, 'nothing is appended while the lock is held')
  rmSync(LOCK)
  allowed(await waiting)
  assert.ok(Date.now() - started >= 600)
  assert.equal(lines().length, 1)

  writeFileSync(LOCK, `${deadPid()} left-by-a-crash`)
  allowed(run(['--log-grade', gradeFile(2, 10)]))
  assert.equal(lines().length, 2); assert.equal(existsSync(LOCK), false)

  writeFileSync(LOCK, `${process.pid} too-old`)
  utimesSync(LOCK, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  allowed(run(['--log-grade', gradeFile(3, 10)]))
  assert.equal(lines().length, 3); assert.equal(existsSync(LOCK), false)

  writeFileSync(LOCK, `${process.pid} held-throughout`)
  const stuck = run(['--log-grade', gradeFile(4, 10)])
  assert.notEqual(stuck.status, 0)
  assert.match(stuck.out, /Could not append to .*review-log\.jsonl: .*review-log\.jsonl\.lock has been held for over 10s by another review run/)
  assert.equal(lines().length, 3)
  assert.equal(readFileSync(LOCK, 'utf8'), `${process.pid} held-throughout`, 'a live lock is never removed')
})

test('R1 reviews running at once get their own ids and folders, intact log lines, and reviews/latest names one of them', async () => {
  const groups = ['a/', 'b/', 'c/', 'd/', 'a/,b/', 'c/,d/']
  const results = await Promise.all(groups.map((paths) => start([], { REVIEW_PATHS: paths, STUB_SLEEP_MS: '300' })))
  for (const r of results) allowed(r)
  const reviews = records().filter((e) => e.type === 'review')
  assert.equal(reviews.length, 6)
  assert.equal(new Set(reviews.map((e) => e.id)).size, 6)
  assert.deepEqual(reviews.map((e) => e.paths.join(',')).sort(), [...groups].sort())
  const folders = readdirSync(join(REPO, 'reviews')).filter((name) => name !== 'latest')
  assert.deepEqual(folders.sort(), reviews.map((e) => e.id).sort(), 'one folder per review, no temp links left')
  assert.ok(reviews.some((e) => e.id === readlinkSync(join(REPO, 'reviews/latest'))))
})

test('S1 --slices reviews its groups at the same time, never more than --jobs, and lists every slice in SLICES_JSON', () => {
  const r = run(['--slices', 'a/;b/;c/\nd/', '--jobs', '2', 'the intent'], { STUB_SLEEP_MS: '700' })
  allowed(r)
  assert.deepEqual(peak(), { most: 2, count: 4 })
  for (const [i, paths] of ['a/', 'b/', 'c/', 'd/'].entries())
    assert.match(r.stdout, new RegExp(`=== slice ${i + 1}/4: ${paths.replace('/', '\\/')} \\(exit 0\\) ===`))
  const slices = JSON.parse(r.stdout.slice(r.stdout.indexOf('===SLICES_JSON===') + 17))
  const reviews = records().filter((e) => e.type === 'review')
  assert.deepEqual(slices.map((s) => [s.paths, s.exit]), [['a/', 0], ['b/', 0], ['c/', 0], ['d/', 0]])
  assert.deepEqual(slices.map((s) => s.reviewId).sort(), reviews.map((e) => e.id).sort())
  for (const s of slices) {
    assert.equal(s.result.reviewId, s.reviewId); assert.deepEqual(s.result.paths, [s.paths]); assert.deepEqual(s.result.findings, [])
    assert.deepEqual(reviews.find((e) => e.id === s.reviewId).files, [`${s.paths}x.js`])
  }
  // The intent reaches every slice.
  for (const s of slices) assert.match(readFileSync(join(REPO, 'reviews', s.reviewId, 'code-review.md'), 'utf8'), /Reviewed against: the intent/)
})

test('S1 --jobs 1 runs the slices one after another, and the default runs four at once', () => {
  allowed(run(['--slices', 'a/;b/;c/', '--jobs', '1'], { STUB_SLEEP_MS: '300' }))
  assert.deepEqual(peak(), { most: 1, count: 3 })
  rmSync(CALLS, { recursive: true }); mkdirSync(CALLS)
  allowed(run(['--slices', 'a/;b/;c/;d/;a/,b/'], { STUB_SLEEP_MS: '1500' }))
  assert.deepEqual(peak(), { most: 4, count: 5 })
})

test('S2 a slice that fails makes --slices exit non-zero; the others still run and log', () => {
  const r = run(['--slices', 'a/;missing/;b/'])
  assert.notEqual(r.status, 0)
  assert.match(r.stdout, /=== slice 2\/3: missing\/ \(exit 1\) ===\n[\s\S]*REVIEW_PATHS \(missing\/\) matches no file changed/)
  const slices = JSON.parse(r.stdout.slice(r.stdout.indexOf('===SLICES_JSON===') + 17))
  assert.deepEqual(slices.map((s) => [s.paths, s.exit, s.result === null]), [['a/', 0, false], ['missing/', 1, true], ['b/', 0, false]])
  assert.equal(records().filter((e) => e.type === 'review').length, 2)
})

test('S3 --slices refuses REVIEW_PATHS alongside it, a bad --jobs, no groups, and a dirty tree, before any model runs', () => {
  for (const [args, extra, pattern] of [
    [['--slices', 'a/;b/'], { REVIEW_PATHS: 'a/' }, /Use --slices or REVIEW_PATHS/],
    [['--slices', 'a/', '--jobs', '0'], {}, /--jobs must be a whole number of 1 or more/],
    [['--slices', 'a/', '--jobs', 'two'], {}, /--jobs must be a whole number of 1 or more/],
    [['--slices', ' ; '], {}, /--slices needs at least one group/],
  ]) {
    const r = run(args, extra)
    assert.notEqual(r.status, 0, r.out); assert.match(r.out, pattern)
  }
  writeFileSync(join(REPO, 'a/x.js'), 'dirty\n')
  const dirty = run(['--slices', 'a/;b/'])
  assert.notEqual(dirty.status, 0); assert.match(dirty.out, /Tracked working tree changes present/)
  assert.equal(readdirSync(CALLS).length, 0); assert.deepEqual(lines(), [])
})

const waitFor = async (path, ms = 5000) => {
  for (const until = Date.now() + ms; !existsSync(path); await new Promise((r) => setTimeout(r, 10)))
    if (Date.now() > until) throw new Error(`${path} never appeared`)
}
test('F1 an empty or unreadable lock is one being set up, not a stale one: the append waits for it', async () => {
  for (const text of ['', 'not a pid']) {
    rmSync(LOG, { force: true })
    writeFileSync(LOCK, text)
    const waiting = start(['--log-grade', gradeFile(1, 10)])
    await new Promise((r) => setTimeout(r, 700))
    assert.equal(lines().length, 0, `nothing is appended past a ${JSON.stringify(text)} lock`)
    assert.equal(readFileSync(LOCK, 'utf8'), text, 'the lock is left alone')
    rmSync(LOCK)
    allowed(await waiting)
    assert.equal(lines().length, 1)
  }
})

test('F2 a lock taken fresh after a waiter judged the old one stale is never removed by that waiter', async () => {
  const gate = join(ROOT, 'reclaim-gate')
  rmSync(gate, { force: true }); rmSync(`${gate}.judged`, { force: true })
  writeFileSync(LOCK, `${deadPid()} left-by-a-crash`)
  const waiting = start(['--log-grade', gradeFile(1, 10)], { REVIEW_LOCK_TEST_GATE: gate })
  // The waiter has judged the crashed lock stale; another run now takes the lock before it acts.
  await waitFor(`${gate}.judged`)
  writeFileSync(LOCK, `${process.pid} taken-fresh`)
  writeFileSync(gate, '')
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(readFileSync(LOCK, 'utf8'), `${process.pid} taken-fresh`, 'the fresh lock survives the reclaim')
  assert.equal(lines().length, 0)
  rmSync(LOCK)
  allowed(await waiting)
  assert.equal(lines().length, 1)
  assert.deepEqual(readdirSync(dirname(LOG)).filter((name) => name !== 'review-log.jsonl'), [], 'no lock, temp or tombstone left')
})

test('F3 a slice with a 200 KB finding hands its whole FINDINGS_JSON to the runner', () => {
  const big = { issue: 'x'.repeat(200_000), file: 'a/x.js', line: '1', quote: 'a 2', suggestion: 'fix it', likelihood: 5, impact: 5, protected: false, trigger: 'reading a' }
  const file = join(ROOT, 'big-findings.json')
  writeFileSync(file, JSON.stringify({ findings: [big] }))
  const r = run(['--slices', 'a/;b/'], { STUB_FINDINGS_FILE: file })
  allowed(r)
  const slices = JSON.parse(r.stdout.slice(r.stdout.indexOf('===SLICES_JSON===') + 17))
  assert.deepEqual(slices.map((s) => [s.paths, s.exit]), [['a/', 0], ['b/', 0]])
  assert.equal(slices[0].result.findings[0].issue.length, 200_000)
  assert.equal(slices[1].result.findings[0].issue.length, 200_000)
  for (const s of slices) assert.equal(s.reviewId, s.result.reviewId)
})

// A copy of review.mjs whose FINDINGS_JSON is cut short or never printed, as when a child's output is lost; --slices
// run from it spawns the same copy for every slice.
function brokenCopy(name, replacement) {
  const source = readFileSync(SCRIPT, 'utf8'), marker = "console.log('\\n===FINDINGS_JSON===')"
  assert.ok(source.includes(marker))
  const path = join(ROOT, name)
  writeFileSync(path, source.replace(marker, replacement))
  return path
}
test('F3 a slice that exits 0 with its FINDINGS_JSON missing or cut short fails the slice and the run', () => {
  for (const [name, replacement, error] of [
    ['cut.mjs', "console.log('\\n===FINDINGS_JSON===\\n{\"reviewId\": \"cut')", /its FINDINGS_JSON is malformed/],
    ['missing.mjs', "console.log('\\n===FINDINGS_GONE===')", /it printed no FINDINGS_JSON/],
  ]) {
    const r = spawnSync(process.execPath, [brokenCopy(name, replacement), '--slices', 'a/;b/'], { cwd: REPO, env: env(), encoding: 'utf8', timeout: 60000 })
    assert.notEqual(r.status, 0, r.stdout)
    const slices = JSON.parse(r.stdout.slice(r.stdout.indexOf('===SLICES_JSON===') + 17))
    assert.deepEqual(slices.map((s) => [s.paths, s.exit, s.result]), [['a/', 1, null], ['b/', 1, null]])
    for (const s of slices) assert.match(s.error, error)
    assert.match(r.stdout, new RegExp(`=== slice 1/2: a/ \\(exit 1: ${error.source}`))
  }
})
