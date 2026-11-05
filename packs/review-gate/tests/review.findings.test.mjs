import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Findings that mean something: the pre-existing tag (with inDiff on the review diff), grouped instances, response
// labels at close with --noise-report, and the fixCheck option. Stub CLIs, temporary HOME and Git config; no real model.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'review.mjs')
const ROOT = mkdtempSync(join(tmpdir(), 'review-findings-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), BIN = join(ROOT, 'bin'), CALLS = join(ROOT, 'calls')
const LOG = join(HOME, '.agent-config-studio/review-log/review-log.jsonl')
const HOME_CONFIG = join(HOME, '.agent-config-studio/review-gate/config.json')
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
const prompt = a.includes('--output-schema') ? a.at(-1) : a[1]
fs.writeFileSync(path.join(${JSON.stringify(CALLS)}, process.pid+'-'+Date.now()+'.json'), JSON.stringify({prompt, schema}))
const reply = schema.includes('"scores"') ? '{"scores":[]}'
  : schema.includes('"verdicts"') ? '{"verdicts":[]}'
  : (process.env.STUB_FINDINGS || '{"findings":[]}')
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1], reply)
else console.log(JSON.stringify({structured_output:JSON.parse(reply),structuredOutput:JSON.parse(reply),modelUsage:{'stub-grok':{}}}))
`
for (const name of ['codex', 'claude', 'grok']) stub(name, modelBody)
stub('jev', 'process.exit(1)')
after(() => rmSync(ROOT, { recursive: true, force: true }))

const env = (extra = {}) => ({ HOME, CODEX_HOME: join(HOME, '.codex'), GROK_HOME: join(HOME, '.grok'), GIT_CONFIG_GLOBAL: join(HOME, 'isolated.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1', PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: ROOT, REVIEW_BASE: 'main', REVIEW_REVIEWER: 'sol', REVIEW_CLASSIFIER: 'jev', ...extra })
function run(command, args, extra = {}, input = undefined) {
  const r = spawnSync(command, args, { cwd: REPO, env: env(extra), encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, ...(input !== undefined && { input }) })
  return { ...r, out: `${r.stdout || ''}\n${r.stderr || ''}` }
}
const script = (args, extra = {}, input = undefined) => run(process.execPath, [SCRIPT, ...args], extra, input)
function git(...args) {
  const r = run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  assert.equal(r.status, 0, r.out)
  return r.stdout.trim()
}
function write(files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(REPO, path)), { recursive: true })
    writeFileSync(join(REPO, path), text)
  }
}
function commit(files, message = `change ${Object.keys(files).join(' ')}`) {
  write(files)
  git('add', ...Object.keys(files)); git('commit', '-qm', message)
  return git('rev-parse', 'HEAD')
}
const records = () => existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const allowed = (r) => assert.equal(r.status, 0, r.out)
const prompts = () => readdirSync(CALLS).sort().map((name) => JSON.parse(readFileSync(join(CALLS, name), 'utf8')))
const homeConfig = (value) => { mkdirSync(dirname(HOME_CONFIG), { recursive: true }); writeFileSync(HOME_CONFIG, JSON.stringify(value)) }
function close(id, statuses, extra = {}) {
  const path = join(ROOT, 'statuses.json')
  writeFileSync(path, JSON.stringify(statuses))
  const before = records().length
  const r = script(['--close', id, '--status', path, '--test-cmd', 'true'], extra)
  return { ...r, record: records().length > before ? records().at(-1) : null }
}
function closed(id, statuses, extra = {}) {
  const r = close(id, statuses, extra)
  allowed(r); assert.equal(r.record?.type, 'close', r.out); assert.equal(r.record.status, 'complete', r.out)
  return r.record
}
function refused(id, statuses, pattern, extra = {}) {
  const r = close(id, statuses, extra)
  assert.notEqual(r.status, 0, r.out); assert.equal(r.record, null, 'a refused close logs nothing')
  if (typeof pattern === 'string') assert.ok(r.stderr.includes(pattern), r.out)
  else assert.match(r.out, pattern)
  return r
}
const summary = () => { const r = script(['--summary']); allowed(r); return r.stdout }
// A REFUTED verdict from a family that did not review, appended as a dispute record: the refutation a rejection needs.
const refute = (review, finding) => appendFileSync(LOG, `${JSON.stringify({ type: 'dispute', ts: new Date().toISOString(), review, finding, verdict: 'REFUTED', verifier: 'opus', family: 'sol' })}\n`)

// src/one.js has 20 lines `export const vN = N`; the branch changes line 2 (so lines 1-5 are within 3 of the diff).
const lines = (over = {}, n = 20, name = 'v') => Array.from({ length: n }, (_, i) => over[i + 1] ?? `export const ${name}${i + 1} = ${i + 1}`).join('\n') + '\n'
const scored = (over = {}) => ({ issue: 'v2 is wrong', file: 'src/one.js', line: '2', quote: 'export const v2 = 20', suggestion: 'use 2',
  likelihood: 5, impact: 5, protected: false, trigger: 'importing v2 at startup', ...over })
// An old bug at src/one.js:18, which the branch never touched.
const OLD = scored({ issue: 'v18 overflows', line: '18', quote: 'export const v18 = 18', trigger: 'reading v18', preExisting: true })
function reviewed(findings = [], extra = {}, args = []) {
  const r = script(args, { STUB_FINDINGS: JSON.stringify({ findings }), ...extra })
  allowed(r)
  return Object.assign(records().filter((e) => e.type === 'review' && e.kind === 'review').at(-1), { out: r.out })
}
function fixChecked(review, findings = [], fix = { 'src/one.js': lines({ 2: 'export const v2 = 2' }), 'src/one.test.js': 'test v2\n' }) {
  commit(fix)
  allowed(script(['--fix-check', review.id], { STUB_FINDINGS: JSON.stringify({ findings }) }))
  const check = records().at(-1)
  assert.equal(check.kind, 'fix-check'); assert.equal(check.review, review.id)
  return check
}
const section = (text, title) => {
  const all = text.trimEnd().split('\n'), at = all.indexOf(title)
  if (at === -1) return null
  const end = all.findIndex((l, i) => i > at && /^(Deferred findings|Pre-existing \(not introduced here\)|Merge tier: )/.test(l))
  return all.slice(at + 1, end === -1 ? undefined : end)
}

beforeEach(() => {
  for (const path of [HOME, REPO, CALLS]) rmSync(path, { recursive: true, force: true })
  mkdirSync(dirname(LOG), { recursive: true }); mkdirSync(REPO); mkdirSync(CALLS)
  git('init', '-q', '-b', 'main')
  commit({ 'README.md': 'base\n', 'src/one.js': lines() })
  git('checkout', '-qb', 'feat')
  commit({ 'src/one.js': lines({ 2: 'export const v2 = 20' }) })
})

// ── 1. pre-existing ─────────────────────────────────────────────────────────
test('P1 a pre-existing finding outside the diff is recorded with inDiff false, needs no status, and is listed in --summary, not under Deferred findings', () => {
  const review = reviewed([OLD])
  const [f] = review.findingDetails
  assert.equal(f.preExisting, true); assert.equal(f.inDiff, false)
  assert.match(readFileSync(join(REPO, review.dir, 'code-review.md'), 'utf8'), /pre-existing \(not introduced here\), no close status needed/)
  const record = closed(review.id, {})
  assert.equal(record.tier, 'medium', JSON.stringify(record.tierReasons))
  assert.ok(!record.tierReasons.some((r) => /deferred/.test(r)), JSON.stringify(record.tierReasons))
  const text = summary()
  assert.deepEqual(section(text, 'Deferred findings'), ['none'])
  assert.deepEqual(section(text, 'Pre-existing (not introduced here)'),
    ['f1 MEDIUM 25/100 (likelihood 5/10 × impact 5/10) src/one.js:18 — v18 overflows; Trigger: reading v18'])
  // --deferred does not list it either.
  assert.ok(!script(['--deferred']).stdout.includes('v18 overflows'))
})
test('P1 a pre-existing claim inside the diff is ignored (logged as such) and still blocks', () => {
  const review = reviewed([scored({ preExisting: true })])
  const [f] = review.findingDetails
  assert.equal(f.preExisting, true); assert.equal(f.inDiff, true)
  assert.match(review.out, /f1: marked pre-existing, but it is within 3 lines of a line this branch changed; it counts as the branch's/)
  refused(review.id, {}, /Finding f1 needs a fixed or rejected status/)
})
test('P1 inDiff that cannot be computed (an unlocated finding) is null, and the finding is not pre-existing', () => {
  const review = reviewed([scored({ line: '18', quote: 'not in the file', preExisting: true })])
  const [f] = review.findingDetails
  assert.equal(f.status, 'unverified-quote'); assert.equal(f.inDiff, null)
  refused(review.id, {}, /Finding f1 needs a fixed or rejected status/)
})
test('P1 a protected pre-existing finding is listed first as Pre-existing HIGH, makes the merge tier HIGH, and never blocks the close', () => {
  const review = reviewed([OLD, scored({ issue: 'v17 leaks a secret', line: '17', quote: 'export const v17 = 17', likelihood: 2, impact: 3, protected: true, trigger: 'reading v17', preExisting: true })])
  const record = closed(review.id, {})
  assert.equal(record.tier, 'high')
  assert.ok(record.tierReasons.includes('pre-existing protected: f2'), JSON.stringify(record.tierReasons))
  assert.ok(!record.tierReasons.some((r) => /deferred/.test(r)), JSON.stringify(record.tierReasons))
  const text = summary()
  assert.deepEqual(section(text, 'Pre-existing (not introduced here)'), [
    'Pre-existing HIGH f2 HIGH 6/100 (likelihood 2/10 × impact 3/10) src/one.js:17 — v17 leaks a secret; Trigger: reading v17',
    'f1 MEDIUM 25/100 (likelihood 5/10 × impact 5/10) src/one.js:18 — v18 overflows; Trigger: reading v18',
  ])
  assert.match(text, /^Merge tier: HIGH \(.*pre-existing protected: f2.*\)/m)
  const tier = JSON.parse(script(['--tier-json']).stdout)
  assert.equal(tier.tier, 'high'); assert.deepEqual(tier.deferred, [])
})
test('P1 a pre-existing finding that was fixed anyway leaves the summary list and the tier', () => {
  const review = reviewed([scored({ ...OLD, protected: true })])
  commit({ 'src/one.js': lines({ 2: 'export const v2 = 20', 18: 'export const v18 = 0' }) })
  const record = closed(review.id, { f1: { status: 'fixed' } })
  assert.ok(!record.tierReasons.some((r) => /pre-existing/.test(r)), JSON.stringify(record.tierReasons))
  assert.equal(section(summary(), 'Pre-existing (not introduced here)'), null)
})
test('P1 the reviewer is asked for preExisting and instances; the schema lists both as required and nullable', () => {
  reviewed([])
  const call = prompts().find((c) => c.prompt.includes('CODE CORRECTNESS'))
  assert.match(call.prompt, /preExisting/); assert.match(call.prompt, /instances/)
  const schema = JSON.parse(call.schema).properties.findings.items
  for (const key of ['preExisting', 'instances']) {
    assert.ok(schema.required.includes(key), key)
    assert.ok(schema.properties[key].type.includes('null'), key)
  }
  const item = schema.properties.instances.items
  assert.deepEqual(item.required, ['file', 'line', 'quote']); assert.equal(item.additionalProperties, false)
})
test('P1 a fix-check finding marked preExisting is never pre-existing: it still needs a status', () => {
  const review = reviewed([scored()])
  const check = fixChecked(review, [{ ...OLD, line: '18' }])
  assert.equal(check.findingDetails[0].inDiff, undefined)
  refused(review.id, { f1: { status: 'fixed' } }, /Finding x1 needs a fixed or rejected status/)
  const prompt = prompts().find((c) => c.prompt.startsWith('Fix check:')).prompt
  assert.ok(!/preExisting/.test(prompt), 'the fix check is not asked for preExisting')
})
test('P1 reviewer JSON cannot set inDiff', () => {
  const review = reviewed([scored({ preExisting: true, inDiff: false })])
  assert.equal(review.findingDetails[0].inDiff, true)
  refused(review.id, {}, /Finding f1 needs a fixed or rejected status/)
})
