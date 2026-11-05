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

// ── 2. grouped instances ────────────────────────────────────────────────────
// The branch also adds src/two.js (10 lines `export const wN = 20`), the same defect again at w1.
const two = (over = {}) => lines({ 1: 'export const w1 = 20', ...over }, 10, 'w')
const GROUPED = scored({ issue: 'constants set to 20', instances: [
  { file: 'src/two.js', line: '1', quote: 'export const w1 = 20' },
  { file: 'src/one.js', line: '2', quote: 'export const v2 = 20' },
] })
test('I1 two located instances: one finding, both places recorded, one fixed status authorizes both files', () => {
  commit({ 'src/two.js': two() })
  const review = reviewed([GROUPED])
  assert.equal(review.findingDetails.length, 1)
  const [f] = review.findingDetails
  assert.deepEqual(f.instances, GROUPED.instances)
  assert.equal(f.instancesDropped, undefined)
  assert.deepEqual(review.instancePaths, { f1: ['src/two.js', 'src/one.js'] })
  assert.match(readFileSync(join(REPO, review.dir, 'code-review.md'), 'utf8'), /\n  Also at: src\/two\.js:1, src\/one\.js:2\n/)
  commit({ 'src/one.js': lines(), 'src/two.js': two({ 1: 'export const w1 = 1' }) })
  const record = closed(review.id, { f1: { status: 'fixed' } })
  assert.deepEqual(record.outOfScope, [])
})
test('I1 without the instance, the second file is out of scope: the instances are what authorize it', () => {
  commit({ 'src/two.js': two() })
  const review = reviewed([scored()])
  commit({ 'src/one.js': lines(), 'src/two.js': two({ 1: 'export const w1 = 1' }) })
  const r = close(review.id, { f1: { status: 'fixed' } })
  allowed(r); assert.deepEqual(r.record.outOfScope, ['src/two.js'])
})
test('I2 an unlocated instance is dropped with a note; the finding keeps its located places', () => {
  commit({ 'src/two.js': two() })
  const review = reviewed([scored({ instances: [{ file: 'src/two.js', line: '1', quote: 'not there' }, { file: 'src/one.js', line: '2', quote: 'export const v2 = 20' }] })])
  const [f] = review.findingDetails
  assert.deepEqual(f.instances, [{ file: 'src/one.js', line: '2', quote: 'export const v2 = 20' }])
  assert.deepEqual(f.instancesDropped, [{ file: 'src/two.js', line: '1', quoteCheck: 'quote not found within ±5 lines of src/two.js:1' }])
  assert.match(review.out, /f1: 1 instance\(s\) could not be located and were dropped: src\/two\.js:1/)
  assert.deepEqual(review.instancePaths, { f1: ['src/one.js'] })
})
test('I2 an unlocated main location makes the finding unlocated, whatever its instances; null instances are absent', () => {
  commit({ 'src/two.js': two() })
  const review = reviewed([scored({ quote: 'nowhere', instances: GROUPED.instances }), scored({ line: '3', quote: 'export const v3 = 3', instances: null, preExisting: null })])
  const [bad, plain] = review.findingDetails.sort((a, b) => a.line.localeCompare(b.line))
  assert.equal(bad.status, 'unverified-quote'); assert.equal(bad.instances, undefined)
  assert.equal(review.instancePaths, undefined)
  assert.ok(!Object.hasOwn(plain, 'instances') && !Object.hasOwn(plain, 'preExisting'), JSON.stringify(plain))
})
test('I3 the fix check is shown every instance of the original findings; a pre-existing finding with an instance in the diff is not pre-existing', () => {
  commit({ 'src/two.js': two() })
  const review = reviewed([GROUPED, { ...OLD, instances: [{ file: 'src/two.js', line: '1', quote: 'export const w1 = 20' }] }])
  assert.equal(review.findingDetails[1].inDiff, true)
  fixChecked(review)
  const prompt = prompts().find((c) => c.prompt.startsWith('Fix check:')).prompt
  assert.match(prompt, /- f1 MEDIUM src\/one\.js:2 — constants set to 20; Trigger: importing v2 at startup; also at src\/two\.js:1, src\/one\.js:2/)
})
test('I3 the summary lists a deferred or pre-existing finding\'s other places', () => {
  const review = reviewed([{ ...OLD, instances: [{ file: 'src/one.js', line: '19', quote: 'export const v19 = 19' }] }])
  assert.equal(review.findingDetails[0].inDiff, false)
  closed(review.id, {})
  assert.deepEqual(section(summary(), 'Pre-existing (not introduced here)'),
    ['f1 MEDIUM 25/100 (likelihood 5/10 × impact 5/10) src/one.js:18 — v18 overflows; Trigger: reading v18; also at src/one.js:19'])
})
test('I4 shadow matching counts a grouped finding\'s instances, on either side', () => {
  const real = { file: 'a.js', line: '10', quote: 'alpha()', issue: 'x', instances: [{ file: 'b.js', line: '5', quote: 'beta()' }] }
  appendFileSync(LOG, `${JSON.stringify({ type: 'review', kind: 'review', id: 'r-1', findingDetails: [real] })}\n`)
  const shadow = (findings) => JSON.stringify({ type: 'shadow', reviewId: 'r-1', family: 'grok', ok: true, ts: new Date().toISOString(), durationMs: 10, findings })
  writeFileSync(join(dirname(LOG), 'shadow-log.jsonl'), [
    shadow([{ file: 'b.js', line: '7', quote: 'other', status: 'verified-quote' }]),
    shadow([{ file: 'c.js', line: '1', quote: 'gamma()', status: 'verified-quote', instances: [{ file: 'a.js', line: '12', quote: 'zzz' }] }]),
  ].join('\n') + '\n')
  const r = script(['--shadow-report']); allowed(r)
  assert.match(r.stdout, /^grok: 2 run\(s\), 0 failed; 2 finding\(s\): 2 matched, 0 unique; missed 0 of 2 real finding\(s\); average 10 ms$/m)
})

// ── 3. response labels and --noise-report ───────────────────────────────────
test('R1 a fixed status may say real or unimportant; anything else is refused, and the label is logged on the close', () => {
  const review = reviewed([scored()])
  commit({ 'src/one.js': lines() })
  refused(review.id, { f1: { status: 'fixed', response: 'wrong' } }, 'Fixed f1 response must be real or unimportant')
  refused(review.id, { f1: { status: 'fixed', response: 'nice' } }, 'Fixed f1 response must be real or unimportant')
  const record = closed(review.id, { f1: { status: 'fixed', response: 'unimportant' } })
  assert.equal(record.statuses.f1.response, 'unimportant')
})
test('R1 a rejection may say wrong or intentional; an unknown one is refused; a label never replaces the REFUTED verdict or waiver', () => {
  const review = reviewed([scored(), scored({ issue: 'v3 is odd', line: '3', quote: 'export const v3 = 3' })])
  const both = (response) => ({ f1: { status: 'rejected', reason: 'not a bug', evidence: 'src/one.js:2', response }, f2: { status: 'rejected', reason: 'meant', evidence: 'src/one.js:3', response: 'intentional' } })
  refused(review.id, both('wrong'), /Rejected f1 requires a REFUTED verdict or an operator waiver/)
  refute(review.id, 'f1'); refute(review.id, 'f2')
  refused(review.id, both('unimportant'), 'Rejected f1 response must be wrong or intentional')
  const unlabeled = both('wrong'); delete unlabeled.f1.response
  refused(review.id, unlabeled, '✖ Rejected f1 needs a response: wrong (not a defect) or intentional (the behavior is meant)')
  const record = closed(review.id, both('wrong'))
  assert.deepEqual([record.statuses.f1.response, record.statuses.f2.response], ['wrong', 'intentional'])
})
test('R1 a deferral takes no response', () => {
  const review = reviewed([scored()])
  fixChecked(review, [scored({ issue: 'v18 off', line: '18', quote: 'export const v18 = 18' })])
  refused(review.id, { f1: { status: 'fixed' }, x1: { status: 'deferred', reason: 'later', response: 'real' } }, /Unknown status field for x1/)
})

// A fixture log: closes in this repository and another, a team review, a fix check, a security finding, a legacy close
// (no labels), a superseded partial close, a filed and a pre-existing finding, and one close before --since.
function noiseFixture() {
  const repoId = realpathSync(join(REPO, '.git')), other = '/elsewhere/.git'
  const f = (id, severity, extra = {}) => ({ id, severity, issue: id, ...extra })
  const review = (id, family, findingDetails, extra = {}) => ({ type: 'review', kind: 'review', id, family, findingDetails, branch: 'feat', ...extra })
  const closeOf = (reviewId, ts, statuses, extra = {}) => ({ type: 'close', review: reviewId, ts, statuses, status: 'complete', ...extra })
  const log = [
    review('A', 'sol', [f('f1', 'high'), f('f2', 'medium'), f('f3', 'low', { filed: true }), f('f4', 'medium', { preExisting: true, inDiff: false }),
      f('s1', 'medium', { source: 'security' })], { repoId, families: ['sol', 'grok'], security: { status: 'ran', family: 'grok' } }),
    { type: 'review', kind: 'fix-check', id: 'XA', review: 'A', family: 'grok', repoId, findingDetails: [f('x1', 'medium')] },
    closeOf('A', '2026-11-02T00:00:00Z', { f1: { status: 'rejected', response: 'wrong' } }, { repoId, status: 'partial' }),
    closeOf('A', '2026-11-03T00:00:00Z', { f1: { status: 'fixed', response: 'real' }, f2: { status: 'rejected', response: 'wrong' },
      s1: { status: 'fixed', response: 'unimportant' }, x1: { status: 'deferred', reason: 'later' } }, { repoId, fixCheck: 'XA' }),
    review('B', 'claude-team', [f('f1', 'medium')], { repoId, families: ['opus', 'fable'] }),
    closeOf('B', '2026-11-04T00:00:00Z', { f1: { status: 'rejected', response: 'intentional' } }, { repoId }),
    review('C', 'sol', [f('f1', 'medium'), f('f2', 'high')], { repoId }),
    closeOf('C', '2026-11-04T00:00:00Z', { f1: { status: 'fixed' }, f2: { status: 'rejected' } }, { repoId }),
    review('D', 'sol', [f('f1', 'medium')], { repoId: other }),
    closeOf('D', '2026-11-04T00:00:00Z', { f1: { status: 'fixed', response: 'real' } }, { repoId: other }),
    review('E', 'sol', [f('f1', 'high')], { repoId }),
    closeOf('E', '2026-10-01T00:00:00Z', { f1: { status: 'fixed', response: 'real' } }, { repoId }),
  ]
  writeFileSync(LOG, log.map((e) => JSON.stringify(e)).join('\n') + '\n')
}
const noise = (...args) => { const r = script(['--noise-report', ...args]); allowed(r); return r.stdout.trim().split('\n') }
const row = (family, band, counts = {}) => `${family} ${band}: ` +
  ['real', 'unimportant', 'wrong', 'intentional', 'unlabeled', 'deferred', 'filed', 'pre-existing'].map((k) => `${k} ${counts[k] || 0}`).join(', ')
test('R2 --noise-report counts per reviewing family and severity band, from each review\'s latest close in this repository', () => {
  noiseFixture()
  assert.deepEqual(noise('--since', '2026-11-01'), [
    'Noise report (this repository, closes since 2026-11-01): 3 review(s) closed',
    row('fable', 'MEDIUM', { intentional: 1 }),
    row('grok', 'MEDIUM', { unimportant: 1, deferred: 1 }),
    row('opus', 'MEDIUM', { intentional: 1 }),
    row('sol', 'HIGH', { real: 1, unlabeled: 1 }),
    row('sol', 'MEDIUM', { wrong: 1, unlabeled: 1, 'pre-existing': 1 }),
    row('sol', 'LOW', { filed: 1 }),
  ])
  const all = noise('--all')
  assert.equal(all[0], 'Noise report (all repositories): 5 review(s) closed')
  assert.ok(all.includes(row('sol', 'HIGH', { real: 2, unlabeled: 1 })), all.join('\n'))
  assert.ok(all.includes(row('sol', 'MEDIUM', { real: 1, wrong: 1, unlabeled: 1, 'pre-existing': 1 })), all.join('\n'))
  const bad = script(['--noise-report', '--since', 'soon'])
  assert.notEqual(bad.status, 0); assert.match(bad.out, /--since needs a date such as 2026-11-01; got soon/)
})
test('R2 --noise-report with nothing closed says so', () => {
  assert.deepEqual(noise(), ['Noise report (this repository): 0 review(s) closed', 'no closes'])
})

// ── 4. fixCheck: "risk" (default) | "always" ────────────────────────────────
const ALWAYS_REFUSAL = '✖ Fix changes code after the review and fixCheck is "always": src/one.js; run --fix-check first (docs, static, coverage-exempt and builds/ files never need one)'
test('F1 fixCheck "always": a code fix after review with no fix check is refused, with the reason in full; a fix check lets it close', () => {
  homeConfig({ fixCheck: 'always' })
  const review = reviewed([scored()])
  commit({ 'src/one.js': lines() })
  refused(review.id, { f1: { status: 'fixed' } }, ALWAYS_REFUSAL)
  allowed(script(['--fix-check', review.id]))
  closed(review.id, { f1: { status: 'fixed' } })
  assert.match(script(['--show-config']).stdout, /"fixCheck": "always"/)
})
test('F1 the default ("risk") still closes a plain code fix without a fix check', () => {
  const review = reviewed([scored()])
  commit({ 'src/one.js': lines() })
  closed(review.id, { f1: { status: 'fixed' } })
  assert.match(script(['--show-config']).stdout, /"fixCheck": "risk"/)
})
test('F2 under "always", builds/, docs, static and coverage-exempt files never need a fix check', () => {
  homeConfig({ fixCheck: 'always' })
  const review = reviewed([])
  commit({ 'builds/x/log.md': 'note\n', 'docs/guide.md': '# Guide\n', 'web/app.css': 'a{}\n', 'package-lock.json': '{}\n' })
  const r = close(review.id, {})
  allowed(r); assert.ok(!r.out.includes('run --fix-check first'), r.out)
})
test('F3 a tracked repo config or REVIEW_FIX_CHECK can raise fixCheck to "always", never lower the home config\'s', () => {
  homeConfig({ fixCheck: 'always' })
  commit({ '.claude/review-config.json': JSON.stringify({ fixCheck: 'risk' }) })
  const review = reviewed([scored()])
  commit({ 'src/one.js': lines() })
  refused(review.id, { f1: { status: 'fixed' } }, ALWAYS_REFUSAL)
  refused(review.id, { f1: { status: 'fixed' } }, ALWAYS_REFUSAL, { REVIEW_FIX_CHECK: 'risk' })
  homeConfig({})
  closed(review.id, { f1: { status: 'fixed' } })
  refused(review.id, { f1: { status: 'fixed' } }, ALWAYS_REFUSAL, { REVIEW_FIX_CHECK: 'always' })
  const odd = script(['--show-config'], { REVIEW_FIX_CHECK: 'sometimes' })
  assert.match(odd.out, /Unknown fixCheck "sometimes" in REVIEW_FIX_CHECK; using the others \(risk \| always\)/)
})
test('F4 a Grade close under "always": the recheck counts as its check; without one a code fix needs a fix check', () => {
  homeConfig({ fixCheck: 'always' })
  const grade = (value, args = []) => {
    const path = join(ROOT, 'grade.json'); writeFileSync(path, JSON.stringify(value))
    allowed(script(['--log-grade', path, ...args]))
    return records().at(-1)
  }
  const criteria = (verdict) => [{ id: 'k1', criterion: 'v2 is 2', verdict, evidence: 'src/one.js:2' }]
  const failed = grade({ family: 'opus', model: 'claude-stub-opus', criteria: criteria('FAIL') })
  commit({ 'src/one.js': lines() })
  refused(failed.id, { c1: { status: 'fixed' } }, ALWAYS_REFUSAL)
  grade({ family: 'opus', model: 'claude-stub-opus', criteria: criteria('PASS') }, ['--recheck-of', failed.id])
  closed(failed.id, { c1: { status: 'fixed' } })
  const passed = grade({ family: 'opus', model: 'claude-stub-opus', criteria: criteria('PASS'),
    findings: [{ issue: 'v18 off', evidence: 'src/one.js:18', likelihood: 5, impact: 5, protected: false, trigger: 'reading v18' }] })
  commit({ 'src/one.js': lines({ 18: 'export const v18 = 0' }) })
  refused(passed.id, { f1: { status: 'fixed' } }, '✖ Fix changes code after the review and fixCheck is "always": src/one.js; run --fix-check first')
})

// ── 6. skill text (claude and codex twins) ──────────────────────────────────
test('K1 both code-review skills describe pre-existing, grouped findings, responses and --noise-report, fixCheck, and the one-slice flow for a fix-check HIGH', () => {
  const skills = join(dirname(SCRIPT), '..', 'skills')
  for (const harness of ['claude', 'codex']) {
    const text = readFileSync(join(skills, harness, 'code-review', 'SKILL.md'), 'utf8')
    const has = (phrase) => assert.ok(text.includes(phrase), `${harness}: ${phrase}`)
    for (const phrase of ['**Pre-existing findings.**', '`preExisting: true`', '`inDiff`', 'Pre-existing (not introduced here)', '"Pre-existing HIGH"',
      'makes the merge tier HIGH', '**Grouped findings.**', '`instances`', 'one status covers them all',
      '`"real"` or `"unimportant"`', '`"wrong"` (not a defect) or `"intentional"`', 'required on every rejection', '--noise-report [--since <date>] [--all]',
      'Config `fixCheck`: `"risk"` (default', '`"always"` (any code fix after the review needs one', 'a protected pre-existing finding']) has(phrase)
    assert.match(text, /fix check raises a HIGH in the fix itself \(`inFix: true`\), defer it at close.*one more commit.*`REVIEW_PATHS=<those files>`.*close the slice at the tip; whatever that slice's own fix check finds is deferred\. Hard stop/, harness)
    assert.match(text, /When the rule 3 slice ran, that report comes after the slice's close/, harness)
  }
})

// ── end to end ──────────────────────────────────────────────────────────────
test('E1 one close with a pre-existing finding, a grouped finding, a labelled rejection and fixCheck "always", then the summary, tier and noise report', () => {
  homeConfig({ fixCheck: 'always' })
  commit({ 'src/two.js': two() })
  const REJ = scored({ issue: 'v3 is odd', line: '3', quote: 'export const v3 = 3', trigger: 'reading v3' })
  const review = reviewed([GROUPED, OLD, REJ])
  assert.deepEqual(review.findingDetails.map((f) => [f.id, f.severity, f.inDiff ?? null]), [['f1', 'medium', null], ['f2', 'medium', false], ['f3', 'medium', null]])
  refute(review.id, 'f3')
  commit({ 'src/one.js': lines(), 'src/two.js': two({ 1: 'export const w1 = 1' }) })
  const statuses = { f1: { status: 'fixed', response: 'real' }, f3: { status: 'rejected', reason: 'v3 is meant', evidence: 'src/one.js:3', response: 'wrong' } }
  refused(review.id, statuses, '✖ Fix changes code after the review and fixCheck is "always": src/one.js, src/two.js; run --fix-check first (docs, static, coverage-exempt and builds/ files never need one)')
  allowed(script(['--fix-check', review.id], { STUB_FINDINGS: JSON.stringify({ findings: [scored({ issue: 'w1 = 1 breaks callers', file: 'src/two.js', line: '1', quote: 'export const w1 = 1', likelihood: 8, impact: 8, trigger: 'importing w1' })] }) }))
  const check = records().at(-1)
  assert.deepEqual(check.findingDetails.map((f) => [f.id, f.severity, f.inFix]), [['x1', 'high', true]])
  refused(review.id, statuses, /Finding x1 needs a fixed or rejected status, or deferred with a reason/)
  const record = closed(review.id, { ...statuses, x1: { status: 'deferred', reason: 'next PR' } })
  assert.deepEqual(record.outOfScope, [])
  assert.equal(record.fixCheck, check.id)
  assert.deepEqual([record.statuses.f1.response, record.statuses.f3.response], ['real', 'wrong'])
  assert.equal(record.tier, 'high')
  assert.ok(record.tierReasons.includes('deferred HIGH: x1'), JSON.stringify(record.tierReasons))
  assert.ok(!record.tierReasons.some((r) => /f2|pre-existing/.test(r)), JSON.stringify(record.tierReasons))
  const text = summary()
  assert.match(text, /^Counts: 4 findings; 1 fixed; 1 rejected; 1 deferred$/m)
  assert.match(text, /^f3 MEDIUM v3 is odd: v3 is meant — MEDIUM 25\/100/m)
  assert.deepEqual(section(text, 'Deferred findings'),
    ['x1 HIGH 64/100 (likelihood 8/10 × impact 8/10) src/two.js:1 — w1 = 1 breaks callers; Trigger: importing w1; Deferred: next PR; Fix idea: use 2'])
  assert.deepEqual(section(text, 'Pre-existing (not introduced here)'),
    ['f2 MEDIUM 25/100 (likelihood 5/10 × impact 5/10) src/one.js:18 — v18 overflows; Trigger: reading v18'])
  const tier = JSON.parse(script(['--tier-json']).stdout)
  assert.deepEqual([tier.tier, tier.deferred], ['high', ['x1']])
  assert.deepEqual(noise(), ['Noise report (this repository): 1 review(s) closed',
    row('sol', 'HIGH', { deferred: 1 }), row('sol', 'MEDIUM', { real: 1, wrong: 1, 'pre-existing': 1 })])
})
