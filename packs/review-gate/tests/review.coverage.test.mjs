import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Content coverage at the push gate: a file is covered when its exact state at the tip was seen by a complete close
// or a clean fix check in this repository, at a head the tip descends from. Stub CLIs, a temporary HOME and Git config,
// and the push gate through the actual installed pre-push hook.
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime')
const ROOT = mkdtempSync(join(tmpdir(), 'review-coverage-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), CLONE = join(ROOT, 'clone'), REMOTE = join(ROOT, 'remote.git')
const SKILL = join(HOME, '.agent-config-studio/review-gate'), SCRIPT = join(SKILL, 'review.mjs')
const LOG = join(HOME, '.agent-config-studio/review-log/review-log.jsonl'), BIN = join(ROOT, 'bin'), CALLS = join(ROOT, 'calls')
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
fs.writeFileSync(path.join(${JSON.stringify(CALLS)}, process.pid+'-'+Date.now()+'.json'), JSON.stringify({prompt}))
const reply = schema.includes('"scores"') ? '{"scores":[]}' : (process.env.STUB_FINDINGS || '{"findings":[]}')
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1], reply)
else console.log(JSON.stringify({structured_output:JSON.parse(reply),structuredOutput:JSON.parse(reply),modelUsage:{'stub-grok':{}}}))
`
for (const name of ['codex', 'claude', 'grok']) stub(name, modelBody)
stub('jev', 'process.exit(1)')
after(() => rmSync(ROOT, { recursive: true, force: true }))

const env = (extra = {}) => ({ HOME, CODEX_HOME: join(HOME, '.codex'), GROK_HOME: join(HOME, '.grok'), GIT_CONFIG_GLOBAL: join(HOME, 'isolated.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1', PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: ROOT, REVIEW_BASE: 'main', REVIEW_REVIEWER: 'sol', ...extra })
function run(command, args, extra = {}, cwd = REPO) {
  const r = spawnSync(command, args, { cwd, env: env(extra), encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 })
  return { ...r, out: `${r.stdout || ''}\n${r.stderr || ''}` }
}
const script = (args, extra = {}, cwd = REPO) => run(process.execPath, [SCRIPT, ...args], extra, cwd)
function git(...args) {
  const r = run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  assert.equal(r.status, 0, r.out)
  return r.stdout.trim()
}
function commit(files, message = `change ${Object.keys(files).join(' ')}`) {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) { git('rm', '-q', path); continue }
    mkdirSync(dirname(join(REPO, path)), { recursive: true })
    writeFileSync(join(REPO, path), text)
    git('add', path)
  }
  git('commit', '-qm', message)
  return git('rev-parse', 'HEAD')
}
const records = () => existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const calls = () => readdirSync(CALLS).map((p) => JSON.parse(readFileSync(join(CALLS, p), 'utf8')))
const allowed = (r) => assert.equal(r.status, 0, r.out)
function blocked(r, pattern) {
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /Run \/code-review/)
  if (pattern) assert.match(r.out, pattern)
}
const push = (ref = 'HEAD:refs/heads/feat') => run('git', ['push', 'origin', ref])
// A review through the stub reviewer; paths go in REVIEW_PATHS.
function review(paths, extra = {}, cwd = REPO) {
  const r = script([], { REVIEW_PATHS: paths || '', ...extra }, cwd)
  allowed(r)
  return records().filter((e) => e.type === 'review' && e.kind === 'review').at(-1)
}
function close(id, statuses = {}, cwd = REPO) {
  const path = join(ROOT, 'statuses.json')
  writeFileSync(path, JSON.stringify(statuses))
  const before = records().length
  const r = script(['--close', id, '--status', path, '--test-cmd', 'true'], {}, cwd)
  return { ...r, record: records().length > before ? records().at(-1) : null }
}
function closed(id, statuses, cwd) {
  const r = close(id, statuses, cwd)
  allowed(r); assert.equal(r.record.type, 'close'); assert.equal(r.record.status, 'complete', r.out)
  return r.record
}
function fixCheck(id, findings = []) {
  allowed(script(['--fix-check', id], { STUB_FINDINGS: JSON.stringify({ findings }) }))
  const check = records().at(-1)
  assert.equal(check.kind, 'fix-check')
  return check
}
const uncovered = (files) => new RegExp(`${files.length} file\\(s\\) uncovered: ${files.map((f) => f.replace(/[./]/g, '\\$&')).join(', ')} — review them as a slice \\(REVIEW_PATHS=${files.map((f) => f.replace(/[./]/g, '\\$&')).join(',')}\\)`)
const F1 = { issue: 'one is wrong', file: 'src/one.js', line: '1', quote: 'export const one = 2', suggestion: 'fix it',
  likelihood: 5, impact: 5, protected: false, trigger: 'importing one' }
const blob = (rev, path) => git('rev-parse', `${rev}:${path}`)

beforeEach(() => {
  for (const path of [HOME, REPO, CLONE, REMOTE, CALLS]) rmSync(path, { recursive: true, force: true })
  mkdirSync(SKILL, { recursive: true }); mkdirSync(dirname(LOG), { recursive: true }); mkdirSync(REPO); mkdirSync(CALLS)
  copyFileSync(join(SOURCE, 'review.mjs'), SCRIPT)
  cpSync(join(SOURCE, 'hooks'), join(SKILL, 'hooks'), { recursive: true, verbatimSymlinks: true })
  git('init', '-q', '-b', 'main')
  commit({ 'README.md': 'base\n', 'src/one.js': 'export const one = 1\n', 'lib/two.js': 'export const two = 1\n', 'docs/three.md': 'three\n', 'shared.js': 'shared v1\n' })
  git('checkout', '-qb', 'feat')
  commit({ 'src/one.js': 'export const one = 2\n', 'docs/three.md': 'three, edited\n' })
  git('init', '--bare', '-q', REMOTE)
  git('remote', 'add', 'origin', REMOTE)
  allowed(run('sh', [join(SKILL, 'hooks/install-hook.sh'), REPO]))
})

test('C1 a sibling-file fix seen by the fix check keeps the close complete, and the fix check logs what it saw and how long it took', () => {
  const r = review('', { STUB_FINDINGS: JSON.stringify({ findings: [F1] }) })
  assert.deepEqual(r.truncated, [])
  commit({ 'src/one.js': 'export const one = 3\n', 'lib/two.js': 'export const two = 3\n' })
  const partial = close(r.id, { f1: { status: 'fixed' } })
  allowed(partial); assert.equal(partial.record.status, 'partial'); assert.deepEqual(partial.record.outOfScope, ['lib/two.js'])
  assert.equal(Object.hasOwn(partial.record, 'coverage'), false, 'a partial close logs no coverage')
  const check = fixCheck(r.id)
  assert.equal(typeof check.durationMs, 'number'); assert.ok(check.durationMs >= 0)
  assert.deepEqual(check.truncated, [])
  const head = git('rev-parse', 'HEAD')
  assert.deepEqual(check.coverage, [['lib/two.js', `100644 ${blob(head, 'lib/two.js')}`], ['src/one.js', `100644 ${blob(head, 'src/one.js')}`]])
  const record = closed(r.id, { f1: { status: 'fixed' } })
  assert.deepEqual(record.outOfScope, []); assert.equal(record.fixCheck, check.id)
  assert.equal(record.repoId, records().find((e) => e.id === r.id).repoId)
  assert.deepEqual(record.coverage.map(([path]) => path), ['docs/three.md', 'lib/two.js', 'src/one.js'])
  allowed(push())
})

test('C1 a clean fix check covers the files it saw on its own; one with a finding that needs a status covers none', () => {
  const r = review()
  closed(r.id)
  commit({ 'lib/two.js': 'export const two = 3\n', 'shared.js': 'shared v2\n' })
  const check = fixCheck(r.id, [{ ...F1, file: 'lib/two.js', quote: 'export const two = 3' }])
  assert.equal(check.findingDetails[0].severity, 'medium')
  // The tip close comes from a slice of the other file; the fix check with a finding leaves lib/two.js uncovered.
  closed(review('shared.js').id)
  blocked(push(), uncovered(['lib/two.js']))
  // Rewound and redone with a clean fix check, the same file is covered by that check alone.
  git('reset', '-q', '--hard', r.head)
  rmSync(LOG)
  const again = review()
  closed(again.id)
  commit({ 'lib/two.js': 'export const two = 3\n', 'shared.js': 'shared v2\n' })
  fixCheck(again.id)
  closed(review('shared.js').id)
  const pushed = push(); allowed(pushed)
  assert.match(pushed.stderr, /Content coverage: 3 record\(s\) together cover every file changed from [0-9a-f]{40} to [0-9a-f]{40}/)
  assert.match(pushed.stderr, /Fix check 3 of 3: fix-\S+ of review \S+, clean at [0-9a-f]{40}; covers 1 file\(s\)/)
})

test('C2 a late one-file commit needs only that file reviewed and one close at the tip, not a re-review of the rest', () => {
  const first = review('src/'), second = review('docs/')
  closed(first.id); closed(second.id)
  allowed(push())
  commit({ 'lib/two.js': 'export const two = 2\n' })
  const r = push(); blocked(r, uncovered(['lib/two.js']))
  assert.match(r.out, /no complete close or clean fix check saw the tip state of 1 file\(s\)/)
  const summary = script(['--summary'])
  assert.notEqual(summary.status, 0); assert.match(summary.out, uncovered(['lib/two.js']))
  rmSync(CALLS, { recursive: true }); mkdirSync(CALLS)
  closed(review('lib/two.js').id)
  const [call] = calls()
  assert.match(call.prompt, /export const two = 2/); assert.doesNotMatch(call.prompt, /export const one = 2|three, edited/)
  const pushed = push(); allowed(pushed)
  assert.match(pushed.stderr, /Content coverage: 3 record\(s\) together cover every file changed from/)
  assert.match(pushed.stderr, /Close 1 of 3: review \S+ at [0-9a-f]{40} for paths lib\/two\.js; covers 1 file\(s\), and the tests ran at the tip/)
  const shown = script(['--summary']); allowed(shown)
  assert.ok(pushed.stderr.includes(shown.stdout.trim()), pushed.out)
})

test('C2 every file can be covered while no close is at the tip: the push still needs one close there', () => {
  const r = review()
  closed(r.id)
  commit({ 'lib/two.js': 'export const two = 2\n' })
  commit({ 'lib/two.js': 'export const two = 1\n' })
  blocked(push(), /every changed file is covered, but no complete close is at the tip/)
})

test('C3 a merge of two reviewed branches is refused for the file both sides changed, and only that file', () => {
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'left')
  commit({ 'left.js': 'export const left = 1\n', 'shared.js': 'shared v2\n' })
  closed(review().id)
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'right')
  commit({ 'right.js': 'export const right = 1\n', 'shared.js': 'shared v2\n' })
  closed(review().id)
  git('checkout', '-q', 'left')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '--no-ff', '-qm', 'merge right', 'right')
  // Both sides logged the very blob the merge has; each saw it without the other side's changes.
  assert.equal(blob('HEAD', 'shared.js'), blob('right', 'shared.js'))
  blocked(push('HEAD:refs/heads/left'), uncovered(['shared.js']))
  closed(review('shared.js').id)
  allowed(push('HEAD:refs/heads/left'))
})

test('C4 a deletion and a chmod-only change are uncovered until reviewed', () => {
  closed(review().id)
  commit({ 'docs/three.md': null })
  blocked(push(), uncovered(['docs/three.md']))
  const deleted = closed(review('docs/three.md').id)
  assert.deepEqual(deleted.coverage, [['docs/three.md', null]])
  allowed(push())
  chmodSync(join(REPO, 'src/one.js'), 0o755)
  git('add', 'src/one.js'); git('commit', '-qm', 'executable')
  blocked(push(), uncovered(['src/one.js']))
  const mode = closed(review('src/one.js').id)
  assert.deepEqual(mode.coverage, [['src/one.js', `100755 ${blob('HEAD', 'src/one.js')}`]])
  allowed(push())
})

test('C5 a file whose diff the size cap cut is not covered; the files before the cut are', () => {
  const big = Array.from({ length: 3000 }, (_, i) => `export const value${i} = '${'x'.repeat(40)}'`).join('\n')
  commit({ 'z/big.js': `${big}\n` })
  const r = review()
  assert.deepEqual(r.truncated, ['z/big.js'])
  const record = closed(r.id)
  assert.deepEqual(record.coverage.map(([path]) => path), ['docs/three.md', 'src/one.js'])
  blocked(push(), /the complete closes at [0-9a-f]{40} leave 1 file\(s\) uncovered: z\/big\.js —/)
})

test('C6 a review on an unrelated branch or in another repository covers nothing, even for the same blob at the same commit', () => {
  closed(review().id)
  const tip = commit({ 'lib/two.js': 'export const two = 2\n' })
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'other')
  commit({ 'lib/two.js': 'export const two = 2\n' })
  const elsewhere = closed(review('lib/two.js').id)
  assert.deepEqual(elsewhere.coverage, [['lib/two.js', `100644 ${blob('feat', 'lib/two.js')}`]])
  git('checkout', '-q', 'feat')
  blocked(push(), uncovered(['lib/two.js']))
  // A clone holds the same commits; its review and close at this very tip still count only there.
  allowed(run('git', ['clone', '-q', '--branch', 'feat', REPO, CLONE], {}, ROOT))
  allowed(run('git', ['branch', '-q', 'main', 'origin/main'], {}, CLONE))
  assert.equal(run('git', ['rev-parse', 'HEAD'], {}, CLONE).stdout.trim(), tip)
  const cloned = review('lib/two.js', {}, CLONE)
  assert.equal(cloned.head, tip); assert.notEqual(cloned.repoId, elsewhere.repoId)
  closed(cloned.id, {}, CLONE)
  blocked(push(), uncovered(['lib/two.js']))
})

test('C7 a close logged without coverage gives no content coverage; only the old whole-tip rule still applies to it', () => {
  const r = review()
  const record = closed(r.id)
  const legacy = { type: 'close', ts: record.ts, review: r.id, closeHead: record.closeHead, statuses: {}, outOfScope: [], status: 'complete', tests: record.tests }
  writeFileSync(LOG, records().map((e) => JSON.stringify(e.type === 'close' ? legacy : e)).join('\n') + '\n')
  allowed(push())
  commit({ 'lib/two.js': 'export const two = 2\n' })
  closed(review('lib/two.js').id)
  blocked(push(), /the complete slice closes at [0-9a-f]{40} leave 2 file\(s\) uncovered: docs\/three\.md, src\/one\.js —/)
})

test('C8 a code commit after the fix check is refused at close and uncovered at the gate; builds/ and test files may follow it', () => {
  const r = review('', { STUB_FINDINGS: JSON.stringify({ findings: [F1] }) })
  commit({ 'src/one.js': 'export const one = 3\n', 'src/one.test.js': 'test one\n' })
  const check = fixCheck(r.id)
  commit({ 'src/one.js': 'export const one = 4\n' })
  const refused = close(r.id, { f1: { status: 'fixed' } })
  assert.notEqual(refused.status, 0); assert.equal(refused.record, null)
  assert.match(refused.out, /Fix check head must equal closing HEAD, or the commits after it may touch only builds\/ and test files: src\/one\.js\. Fixes land before the fix check/)
  // Closed at the fix check head, the later commit is the one uncovered file.
  git('checkout', '-q', '--detach', check.head)
  closed(r.id, { f1: { status: 'fixed' } })
  git('checkout', '-q', 'feat')
  blocked(push(), uncovered(['src/one.js']))
  closed(review('src/one.js').id)
  allowed(push())
  // builds/ and test-only commits after the fix check close complete.
  git('reset', '-q', '--hard', check.head)
  commit({ 'builds/demo/log.md': 'notes\n', 'src/one.test.js': 'test one, tightened\n' })
  const later = closed(r.id, { f1: { status: 'fixed' } })
  assert.deepEqual(later.outOfScope, [])
  allowed(push('HEAD:refs/heads/later'))
})

const BIG = Array.from({ length: 3000 }, (_, i) => `export const value${i} = '${'x'.repeat(40)}'`).join('\n') + '\n'
test('E1 coverageExempt from the environment or the home config skips those files, and the summary and refusal name them as not reviewed', () => {
  commit({ 'z/big.js': BIG })
  closed(review().id)
  blocked(push(), uncovered(['z/big.js']))
  const pushed = run('git', ['push', 'origin', 'HEAD:refs/heads/feat'], { REVIEW_COVERAGE_EXEMPT: 'z/**' }); allowed(pushed)
  assert.match(pushed.stderr, /\nCoverage exempt \(not reviewed\): z\/big\.js\n/)
  // A pattern with no slash matches any path segment, as in riskPaths.
  writeFileSync(join(SKILL, 'config.json'), JSON.stringify({ coverageExempt: ['big.js'] }))
  commit({ 'lib/two.js': 'export const two = 2\n' })
  blocked(push(), /1 file\(s\) uncovered: lib\/two\.js — review them as a slice \(REVIEW_PATHS=lib\/two\.js\) and close it at the tip; exempt \(not reviewed\): z\/big\.js/)
  closed(review('lib/two.js').id)
  const summary = script(['--summary']); allowed(summary)
  assert.equal(summary.stdout.trim().split('\n').at(-1), 'Coverage exempt (not reviewed): z/big.js')
  allowed(push())
})

test('E2 a tracked repo config cannot set coverageExempt; an untracked one can', () => {
  commit({ '.claude/review-config.json': JSON.stringify({ coverageExempt: ['z/**'] }), 'z/big.js': BIG })
  closed(review().id)
  blocked(push(), uncovered(['z/big.js']))
  rmSync(LOG)
  git('rm', '-q', '--cached', '.claude/review-config.json'); git('commit', '-qm', 'untrack the config')
  assert.equal(existsSync(join(REPO, '.claude/review-config.json')), true)
  closed(review().id)
  const pushed = push(); allowed(pushed)
  assert.match(pushed.stderr, /Coverage exempt \(not reviewed\): z\/big\.js/)
})

test('R1 a tracked repo config cannot set coverageExempt or a command key with any value; a malformed trusted list fails loudly', () => {
  commit({ '.claude/review-config.json': JSON.stringify({ coverageExempt: [null], verifyCmd: [null] }) })
  const r = script([], { REVIEW_PATHS: '' }); allowed(r)
  assert.match(r.out, /Ignoring verifyCmd, coverageExempt in \.claude\/review-config\.json/)
  closed(records().filter((e) => e.type === 'review').at(-1).id)
  commit({ 'null/x.js': 'export const x = 1\n' })
  blocked(push(), uncovered(['null/x.js']))
  git('rm', '-q', '.claude/review-config.json'); git('commit', '-qm', 'drop the config')
  for (const value of [[null], [''], ['  '], [3], { 'z/**': true }]) {
    writeFileSync(join(SKILL, 'config.json'), JSON.stringify({ coverageExempt: value }))
    blocked(push(), /coverageExempt must be a list of non-empty path patterns/)
  }
})

test('R2 a fixed file whose fix diff the size cap cut leaves that file uncovered after a complete close', () => {
  const r = review('', { STUB_FINDINGS: JSON.stringify({ findings: [F1] }) })
  commit({ 'src/one.js': `export const one = 3\n${BIG}`, 'src/one.test.js': 'test one\n' })
  const check = fixCheck(r.id)
  assert.deepEqual(check.truncated, ['src/one.js', 'src/one.test.js'])
  const record = closed(r.id, { f1: { status: 'fixed' } })
  assert.deepEqual(record.coverage.map(([path]) => path), ['docs/three.md'])
  blocked(push(), /leave 2 file\(s\) uncovered: src\/one\.js, src\/one\.test\.js —/)
})

test('R3 a file the review saw only in part stays uncovered after the fix check sees its later change, in the close and in the check', () => {
  commit({ 'z/big.js': BIG })
  const r = review('', { STUB_FINDINGS: JSON.stringify({ findings: [F1] }) })
  assert.deepEqual(r.truncated, ['z/big.js'])
  commit({ 'z/big.js': `${BIG}export const more = 1\n`, 'src/one.js': 'export const one = 3\n', 'src/one.test.js': 'test one\n' })
  const check = fixCheck(r.id)
  assert.deepEqual(check.truncated, [])
  assert.deepEqual(check.coverage.map(([path]) => path), ['src/one.js', 'src/one.test.js'])
  // The check saw the change, so the close is complete; the cut part was never read, so the file is not covered.
  const record = closed(r.id, { f1: { status: 'fixed' } })
  assert.deepEqual(record.outOfScope, [])
  assert.deepEqual(record.coverage.map(([path]) => path), ['docs/three.md', 'src/one.js', 'src/one.test.js'])
  blocked(push(), /leave 1 file\(s\) uncovered: z\/big\.js —/)
})

test('R4 a new close of an old review whose diff measures over the cap logs empty coverage and is not taken as a legacy close', () => {
  commit({ 'z/big.js': BIG })
  const r = review()
  writeFileSync(LOG, records().map((e) => {
    if (e.id !== r.id) return JSON.stringify(e)
    const { truncated, ...old } = e
    return JSON.stringify(old)
  }).join('\n') + '\n')
  const record = closed(r.id)
  assert.deepEqual(record.coverage, [])
  blocked(push())
})
