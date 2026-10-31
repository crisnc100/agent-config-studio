import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Deferral of what the one fix check or recheck leaves, the PR-body order, and review carry-over across a history
// rewrite with an identical tree. Stub CLIs, temporary HOME and Git config; nothing runs a real model.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'review.mjs')
const ROOT = mkdtempSync(join(tmpdir(), 'review-defer-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), BIN = join(ROOT, 'bin'), CALLS = join(ROOT, 'calls')
const LOG = join(HOME, '.agent-config-studio/review-log/review-log.jsonl')
const ZERO = '0'.repeat(40)
mkdirSync(BIN)
const stub = (name, body) => {
  writeFileSync(join(BIN, name), `#!${process.execPath}\n${body}`)
  chmodSync(join(BIN, name), 0o755)
}
stub('model-id', `const a=process.argv.slice(2), ids={sol:'gpt-stub-sol',opus:'claude-stub-opus',grok:'grok-stub'}; console.log(a[0]==='--role' ? JSON.stringify({use:['sol','opus','grok'],ids:['gpt-stub-sol','claude-stub-opus','grok-stub']}) : a[0]==='--flavor' ? JSON.stringify({flavor:{effort:'high'}}) : ids[a[0]] || 'stub-'+a[0])`)
const modelBody = `
const fs = require('node:fs'), path = require('node:path')
const a = process.argv.slice(2)
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8') : a[a.indexOf('--json-schema')+1]
fs.writeFileSync(path.join(${JSON.stringify(CALLS)}, process.pid+'-'+Date.now()+'.json'), '{}')
const reply = schema.includes('"scores"') ? '{"scores":[]}'
  : schema.includes('"verdicts"') ? '{"verdicts":[{"index":0,"verdict":"REFUTED","evidence":"src/one.js:1 intended"}]}'
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
function close(id, statuses) {
  const path = join(ROOT, 'statuses.json')
  writeFileSync(path, JSON.stringify(statuses))
  const before = records().length
  const r = script(['--close', id, '--status', path, '--test-cmd', 'true'])
  return { ...r, record: records().length > before ? records().at(-1) : null }
}
function closed(id, statuses = {}) {
  const r = close(id, statuses)
  allowed(r); assert.equal(r.record?.type, 'close', r.out); assert.equal(r.record.status, 'complete', r.out)
  assert.deepEqual(r.record.outOfScope, [])
  return r.record
}
function refused(id, statuses, pattern) {
  const r = close(id, statuses)
  assert.notEqual(r.status, 0, r.out); assert.equal(r.record, null, 'a refused close logs nothing')
  assert.match(r.out, pattern)
  return r
}
const scored = (over = {}) => ({ issue: 'one is wrong', file: 'src/one.js', line: '1', quote: 'export const one = 2', suggestion: 'return 1',
  likelihood: 5, impact: 5, protected: false, trigger: 'importing one', ...over })
function reviewed(findings = []) {
  allowed(script([], { STUB_FINDINGS: JSON.stringify({ findings }) }))
  return records().filter((e) => e.type === 'review').at(-1)
}
// The fix round (the f1 file and a test, which needs a fix check), then the one fix check with these findings.
function fixChecked(review, findings) {
  commit({ 'src/one.js': 'export const one = 3\n', 'src/one.test.js': 'test one\n' })
  allowed(script(['--fix-check', review.id], { STUB_FINDINGS: JSON.stringify({ findings }) }))
  const check = records().at(-1)
  assert.equal(check.kind, 'fix-check'); assert.equal(check.review, review.id)
  return check
}
const X_HIGH = scored({ issue: 'three leaks', quote: 'export const one = 3', protected: true, trigger: 'importing three' })
const X_MEDIUM = scored({ issue: 'the test is thin', file: 'src/one.test.js', quote: 'test one', trigger: 'running the test' })
const GRADE = { family: 'opus', model: 'claude-stub-opus', vendor: 'claude', criteria: [{ id: '2.1', criterion: 'Preserve account', verdict: 'FAIL', evidence: 'account test fails' }] }
function graded(value = GRADE, args = []) {
  const path = join(ROOT, 'grade.json')
  writeFileSync(path, JSON.stringify(value))
  allowed(script(['--log-grade', path, ...args]))
  return records().at(-1)
}
const rechecked = (grade, verdict = 'FAIL', findings = []) =>
  graded({ ...GRADE, criteria: [{ ...GRADE.criteria[0], verdict, evidence: `recheck ${verdict} evidence` }], findings }, ['--recheck-of', grade.id])
const gate = (tip = git('rev-parse', 'HEAD')) => script(['--gate'], {}, `refs/heads/feat ${tip} refs/heads/feat ${ZERO}\n`)
// One commit on main with the branch's whole tree, optionally with some files changed.
function squash(files = {}) {
  git('reset', '-q', '--soft', 'main')
  if (Object.keys(files).length) { write(files); git('add', ...Object.keys(files)) }
  git('commit', '-qm', 'squashed')
  return git('rev-parse', 'HEAD')
}
const tree = (rev) => git('rev-parse', `${rev}^{tree}`)

beforeEach(() => {
  for (const path of [HOME, REPO, CALLS]) rmSync(path, { recursive: true, force: true })
  mkdirSync(dirname(LOG), { recursive: true }); mkdirSync(REPO); mkdirSync(CALLS)
  git('init', '-q', '-b', 'main')
  commit({ 'README.md': 'base\n', 'src/one.js': 'export const one = 1\n', 'lib/two.js': 'export const two = 1\n' })
  git('checkout', '-qb', 'feat')
  commit({ 'src/one.js': 'export const one = 2\n' })
})

const ORIGINAL = /is from the original (review|Grade); only findings a fix check or recheck raised, or a criterion still failing after its recheck, may be deferred/
test('D1 deferral is refused for an original finding, of a review or of a Grade, and for a criterion before its recheck', () => {
  const review = reviewed([scored()])
  refused(review.id, { f1: { status: 'deferred', reason: 'later' } }, /Finding f1 is from the original review/)
  closed(review.id, { f1: { status: 'fixed' } })
  const grade = graded()
  refused(grade.id, { c1: { status: 'deferred', reason: 'later' } }, /Deferred criterion c1 needs its one recheck first/)
  const passing = graded({ ...GRADE, criteria: [{ ...GRADE.criteria[0], verdict: 'PASS' }],
    findings: [{ issue: 'grade bug', evidence: 'grade test', likelihood: 5, impact: 5, protected: false, trigger: 'grade input' }] })
  assert.deepEqual(passing.findingDetails.map((f) => [f.id, f.severity]), [['f1', 'medium']])
  refused(passing.id, { f1: { status: 'deferred', reason: 'later' } }, /Finding f1 is from the original Grade/)
})
test('D2 deferral is refused before a fix check exists', () => {
  const review = reviewed([scored()])
  commit({ 'src/one.js': 'export const one = 3\n' })
  refused(review.id, { f1: { status: 'fixed' }, x1: { status: 'deferred', reason: 'later' } }, /Unknown finding status key: x1/)
  refused(review.id, { f1: { status: 'deferred', reason: 'later' } }, ORIGINAL)
  commit({ 'src/one.test.js': 'test one\n' })
  refused(review.id, { f1: { status: 'fixed' }, x1: { status: 'deferred', reason: 'later' } }, /run --fix-check first/)
  assert.equal(records().filter((e) => e.type === 'close').length, 0)
})
test('D3 deferral without a nonempty reason, or with an empty fix idea, is refused', () => {
  const review = reviewed([scored()])
  fixChecked(review, [X_HIGH])
  for (const deferral of [{ status: 'deferred' }, { status: 'deferred', reason: '' }, { status: 'deferred', reason: '   ' }, { status: 'deferred', reason: 7 }])
    refused(review.id, { f1: { status: 'fixed' }, x1: deferral }, /Deferred x1 requires a nonempty reason/)
  refused(review.id, { f1: { status: 'fixed' }, x1: { status: 'deferred', reason: 'later', fix: ' ' } }, /Deferred x1 fix idea must be nonempty text when given/)
})
test('D4 deferral with a severity or score field is refused: the reviewer score stands', () => {
  const review = reviewed([scored()])
  fixChecked(review, [X_HIGH])
  for (const field of [{ severity: 'low' }, { likelihood: 1 }, { impact: 1 }, { protected: false }, { risk: 1 }, { evidence: 'a.js:1' }])
    refused(review.id, { f1: { status: 'fixed' }, x1: { status: 'deferred', reason: 'later', ...field } }, /Unknown status field for x1; reviewer severity cannot be changed/)
})
test('D5 x… findings deferred after the fix check close complete, keep their scores, and show in the summary, --deferred and the push gate', () => {
  const review = reviewed([scored()])
  const check = fixChecked(review, [X_HIGH, X_MEDIUM])
  assert.deepEqual(check.findingDetails.map((f) => [f.id, f.severity]), [['x1', 'high'], ['x2', 'medium']])
  refused(review.id, { f1: { status: 'fixed' } }, /Finding x1 needs a fixed or rejected status, or deferred with a reason/)
  const statuses = { f1: { status: 'fixed' }, x1: { status: 'deferred', reason: 'needs a schema change', fix: 'add a column' }, x2: { status: 'deferred', reason: 'thin but passing' } }
  const record = closed(review.id, statuses)
  assert.deepEqual(record.statuses, statuses); assert.equal(record.fixCheck, check.id)
  assert.deepEqual(records().find((e) => e.id === check.id).findingDetails.map((f) => [f.id, f.severity, f.risk]), [['x1', 'high', 25], ['x2', 'medium', 25]])
  const summary = script(['--summary']); allowed(summary)
  assert.match(summary.stdout, /Counts: 3 findings; 1 fixed; 0 rejected; 2 deferred/)
  assert.ok(summary.stdout.includes('x1 HIGH 25/100 (likelihood 5/10 × impact 5/10) src/one.js:1 — three leaks; Trigger: importing three; Deferred: needs a schema change; Fix idea: add a column'), summary.stdout)
  assert.ok(summary.stdout.includes('x2 MEDIUM 25/100 (likelihood 5/10 × impact 5/10) src/one.test.js:1 — the test is thin; Trigger: running the test; Deferred: thin but passing; Fix idea: return 1'), summary.stdout)
  assert.doesNotMatch(summary.stdout, /Acceptance criteria not met/)
  const deferred = script(['--deferred']); allowed(deferred)
  assert.match(deferred.stdout, new RegExp(`${check.id} \\S+ x1 HIGH 25/100 \\(likelihood 5/10 × impact 5/10\\) .*Deferred: needs a schema change`))
  assert.match(deferred.stdout, new RegExp(`${check.id} \\S+ x2 MEDIUM 25/100 \\(likelihood 5/10 × impact 5/10\\) .*Deferred: thin but passing`))
  const pushed = gate(); allowed(pushed)
  assert.ok(pushed.stderr.includes(summary.stdout.trim()), pushed.out)
  // A deferred finding is not fixed: it authorizes no change after the fix check.
  commit({ 'src/one.js': 'export const one = 4\n' })
  refused(review.id, statuses, /may only touch files named by its fixed findings: src\/one\.js\./)
})
test('D6 a Grade criterion still failing after its one recheck, and the recheck findings, may be deferred; a criterion that passed may not', () => {
  const grade = graded()
  commit({ 'src/one.js': 'export const one = 3\n' })
  const recheck = rechecked(grade, 'FAIL', [{ issue: 'recheck bug', evidence: 'recheck test', likelihood: 6, impact: 6, protected: false, trigger: 'recheck input' }])
  assert.deepEqual(recheck.findingDetails.map((f) => [f.id, f.severity]), [['r1', 'medium']])
  refused(grade.id, { c1: { status: 'fixed' }, r1: { status: 'deferred', reason: 'later' } }, /requires a PASS in the single recheck/)
  refused(grade.id, { c1: { status: 'deferred', reason: 'later' } }, /Finding r1 needs a fixed or rejected status, or deferred with a reason/)
  const statuses = { c1: { status: 'deferred', reason: 'account rework is its own PR', fix: 'split the account module' }, r1: { status: 'deferred', reason: 'same rework' } }
  const record = closed(grade.id, statuses)
  assert.equal(record.recheck, recheck.id)
  const summary = script(['--summary']); allowed(summary)
  const lines = summary.stdout.trim().split('\n')
  assert.equal(lines[0], 'Acceptance criteria not met')
  assert.equal(lines[1], 'c1 criterion 2.1 not met: Preserve account; recheck: recheck FAIL evidence; Deferred: account rework is its own PR; Fix idea: split the account module')
  assert.ok(lines.includes('r1 MEDIUM 36/100 (likelihood 6/10 × impact 6/10) ?:? — recheck bug; Trigger: recheck input; Deferred: same rework'), summary.stdout)
  const deferred = script(['--deferred']); allowed(deferred)
  assert.match(deferred.stdout, new RegExp(`${grade.id} \\S+ c1 criterion 2\\.1 not met: Preserve account`))
  allowed(gate())
  // A criterion that passed its recheck is fixed, never deferred.
  const passing = graded()
  commit({ 'src/one.js': 'export const one = 4\n' })
  rechecked(passing, 'PASS')
  refused(passing.id, { c1: { status: 'deferred', reason: 'later' } }, /Criterion c1 passed its recheck; mark it fixed rather than deferred/)
  closed(passing.id, { c1: { status: 'fixed' } })
})
test('D7 --summary puts criteria not met on top, then deferred HIGHs, then every other deferred finding', () => {
  // Log order is LOW (filed in the review), then MEDIUM and HIGH (the fix check), then the criterion (the Grade).
  const review = reviewed([scored(), scored({ issue: 'one is a little odd', likelihood: 1, impact: 2, trigger: 'reading one' })])
  assert.deepEqual(review.findingDetails.map((f) => [f.id, f.severity, f.filed]), [['f1', 'medium', false], ['f2', 'low', true]])
  fixChecked(review, [X_MEDIUM, X_HIGH])
  closed(review.id, { f1: { status: 'fixed' }, x1: { status: 'deferred', reason: 'medium later' }, x2: { status: 'deferred', reason: 'high later' } })
  const grade = graded()
  rechecked(grade, 'FAIL')
  closed(grade.id, { c1: { status: 'deferred', reason: 'criterion later' } })
  const summary = script(['--summary']); allowed(summary)
  const lines = summary.stdout.trim().split('\n')
  const at = (prefix) => lines.findIndex((line) => line.startsWith(prefix))
  assert.deepEqual(lines.slice(0, 2), ['Acceptance criteria not met', 'c1 criterion 2.1 not met: Preserve account; recheck: recheck FAIL evidence; Deferred: criterion later'])
  assert.ok(at('Reviewer: ') > 1 && at('Deferred findings') > at('Reviewer: '), summary.stdout)
  assert.deepEqual(lines.slice(at('Deferred findings') + 1).map((line) => line.split(' — ')[0]),
    ['x2 HIGH 25/100 (likelihood 5/10 × impact 5/10) src/one.js:1', 'x1 MEDIUM 25/100 (likelihood 5/10 × impact 5/10) src/one.test.js:1', 'f2 LOW 2/100 (likelihood 1/10 × impact 2/10) src/one.js:1'])
  assert.equal(lines.filter((line) => line === 'Acceptance criteria not met').length, 1)
  const deferred = script(['--deferred']); allowed(deferred)
  const order = ['c1 criterion 2.1', 'x2 HIGH 25/100', 'x1 MEDIUM 25/100', 'f2 LOW 2/100'].map((text) => deferred.stdout.indexOf(text))
  assert.ok(order.every((i) => i > 0), deferred.stdout)
  assert.ok(order[1] < order[2], 'HIGH before MEDIUM in the fix check record')
  allowed(gate())
})
test('D8 a squash with the reviewed tree closes as carried, and the push gate passes', () => {
  commit({ 'lib/two.js': 'export const two = 2\n' })
  const review = reviewed()
  const squashed = squash()
  assert.equal(tree(squashed), tree(review.head)); assert.equal(isAncestorOf(review.head, squashed), false)
  const record = closed(review.id)
  assert.equal(record.closeHead, squashed)
  assert.deepEqual(record.carried, { from: review.head, kind: 'review', record: review.id, tree: tree(squashed) })
  const summary = script(['--summary']); allowed(summary)
  assert.match(summary.stdout, new RegExp(`Carried at close: ${squashed} has the exact tree of the review head ${review.head}`))
  allowed(gate())
})
test('D8b a close, then a squash with the closed tree: the push gate and --summary carry it over and the gate logs it', () => {
  commit({ 'lib/two.js': 'export const two = 2\n' })
  const review = reviewed([scored()])
  const fixed = commit({ 'src/one.js': 'export const one = 3\n' })
  closed(review.id, { f1: { status: 'fixed' } })
  const squashed = squash()
  assert.equal(tree(squashed), tree(fixed))
  const summary = script(['--summary']); allowed(summary)
  assert.match(summary.stdout, new RegExp(`Carried: ${squashed} has the exact tree of ${fixed}`))
  const before = records().length
  const pushed = gate(); allowed(pushed)
  assert.match(pushed.stderr, new RegExp(`Carried: ${squashed} has the exact tree of ${fixed}`))
  const logged = records().slice(before)
  assert.deepEqual(logged.map((e) => [e.type, e.tip, e.from, e.tree, e.reviews, e.ref]), [['carried', squashed, fixed, tree(fixed), [review.id], 'refs/heads/feat']])
})
test('D9 a split with the reviewed tree closes as carried, and the push gate passes', () => {
  write({ 'lib/two.js': 'export const two = 2\n' }); git('add', 'lib/two.js'); git('commit', '-q', '--amend', '-m', 'one commit, two files')
  const review = reviewed()
  git('reset', '-q', 'main')
  git('add', 'src/one.js'); git('commit', '-qm', 'split: one')
  git('add', 'lib/two.js'); git('commit', '-qm', 'split: two')
  const split = git('rev-parse', 'HEAD')
  assert.equal(tree(split), tree(review.head)); assert.equal(git('rev-list', '--count', 'main..HEAD'), '2')
  const record = closed(review.id)
  assert.equal(record.carried.from, review.head)
  allowed(gate())
})
test('D10 a squash with the fix-check tree closes as carried from the fix-check head, with a deferred x1', () => {
  const review = reviewed([scored()])
  const check = fixChecked(review, [X_HIGH])
  const squashed = squash()
  assert.equal(tree(squashed), tree(check.head))
  const record = closed(review.id, { f1: { status: 'fixed' }, x1: { status: 'deferred', reason: 'later' } })
  assert.deepEqual(record.carried, { from: check.head, kind: 'fix-check', record: check.id, tree: tree(check.head) })
  assert.equal(record.fixCheck, check.id)
  allowed(gate())
})
test('D11 a squash with the recheck tree closes as carried from the recheck head, with a deferred criterion', () => {
  const grade = graded()
  commit({ 'src/one.js': 'export const one = 3\n' })
  const recheck = rechecked(grade)
  squash()
  const record = closed(grade.id, { c1: { status: 'deferred', reason: 'later' } })
  assert.deepEqual(record.carried, { from: recheck.head, kind: 'recheck', record: recheck.id, tree: tree(recheck.head) })
  allowed(gate())
})
test('D12 a rewrite where one byte differs is refused at close, at --summary and at the push gate, and logs no carry-over', () => {
  commit({ 'lib/two.js': 'export const two = 2\n' })
  const review = reviewed()
  const original = git('rev-parse', 'HEAD')
  squash({ 'lib/two.js': 'export const two = 3\n' })
  refused(review.id, {}, /HEAD is neither the reviewed commit nor a descendant, and its tree is not the exact tree of the review, fix-check or recheck head; a rewritten branch with any other tree needs a fresh review/)
  // Closed at the reviewed commit, then rewritten with one byte changed.
  git('reset', '-q', '--hard', original)
  closed(review.id)
  const changed = squash({ 'lib/two.js': 'export const two = 3\n' })
  const before = records().length
  const summary = script(['--summary'])
  assert.notEqual(summary.status, 0); assert.match(summary.out, /No complete close covers HEAD/)
  const pushed = gate(changed)
  assert.notEqual(pushed.status, 0); assert.match(pushed.out, new RegExp(`No complete close covers tip ${changed}`))
  assert.equal(records().length, before)
})
test('D13 a rewrite back to the reviewed tree that drops a closed fix is refused at the push gate', () => {
  const original = commit({ 'lib/two.js': 'export const two = 2\n' })
  const review = reviewed([scored({ file: 'lib/two.js', quote: 'export const two = 2' })])
  commit({ 'lib/two.js': 'export const two = 4\n' })
  closed(review.id, { f1: { status: 'fixed' } })
  allowed(gate())
  git('reset', '-q', '--hard', original)
  const back = squash()
  assert.equal(tree(back), tree(review.head))
  const before = records().length
  const pushed = gate(back)
  assert.notEqual(pushed.status, 0, pushed.out); assert.match(pushed.out, /No complete close covers tip/)
  assert.equal(records().length, before)
})
test('D14 findings shown to the owner carry their numbers: the report, rejections, carried unlocated and deferred lines; unscored says so', () => {
  const review = reviewed([scored(), scored({ issue: 'two is wrong', likelihood: null }), scored({ issue: 'not there', quote: 'missing code', likelihood: 2, impact: 3 })])
  assert.deepEqual(review.findingDetails.map((f) => [f.id, f.severity, f.risk ?? null, f.status]),
    [['f1', 'medium', 25, 'verified-quote'], ['f2', 'medium', null, 'verified-quote'], ['f3', 'low', 6, 'unverified-quote']])
  const report = readFileSync(join(REPO, 'reviews/latest/code-review.md'), 'utf8')
  assert.ok(report.includes('- [src/one.js:1] one is wrong (id f1)\n  Score: MEDIUM 25/100 (likelihood 5/10 × impact 5/10)\n'), report)
  assert.ok(report.includes('- [src/one.js:1] two is wrong (id f2)\n  Score: MEDIUM unscored\n'), report)
  assert.ok(report.includes('- [src/one.js:1] not there (id f3)\n  Score: LOW 6/100 (likelihood 2/10 × impact 3/10) — filed, no close status needed\n'), report)
  allowed(script(['--dispute', review.id, 'f2', '--reason', 'intended', '--evidence', 'src/one.js:1']))
  fixChecked(review, [scored({ issue: 'three is odd', quote: 'export const one = 3', impact: null })])
  closed(review.id, { f1: { status: 'fixed' }, f2: { status: 'rejected', reason: 'intended', evidence: 'src/one.js:1' }, x1: { status: 'deferred', reason: 'later' } })
  const summary = script(['--summary']); allowed(summary)
  for (const line of ['f2 MEDIUM two is wrong: intended — MEDIUM unscored',
    'x1 MEDIUM unscored src/one.js:1 — three is odd; Trigger: importing one; Deferred: later; Fix idea: return 1'])
    assert.ok(summary.stdout.split('\n').includes(line), `${line}\n${summary.stdout}`)
  assert.match(summary.stdout, /^Carried unlocated f3 LOW not there: .* — LOW 6\/100 \(likelihood 2\/10 × impact 3\/10\)$/m)
  assert.match(script(['--deferred']).stdout, /x1 MEDIUM unscored src\/one\.js:1 — three is odd/)
})

function isAncestorOf(a, b) {
  return run('git', ['merge-base', '--is-ancestor', a, b]).status === 0
}
