import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Close after a fix check: the commits after it may touch only files its fixed x… findings name (in the slice,
// when sliced), the full tests run at close, and nothing runs a model. Stub CLIs, temporary HOME and Git config.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'review.mjs')
const ROOT = mkdtempSync(join(tmpdir(), 'review-fixclose-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), BIN = join(ROOT, 'bin'), CALLS = join(ROOT, 'calls')
const LOG = join(HOME, '.agent-config-studio/review-log/review-log.jsonl')
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
const prompt = a.includes('--output-schema') ? a.at(-1) : a[1]
fs.writeFileSync(path.join(${JSON.stringify(CALLS)}, process.pid+'-'+Date.now()+'.json'), JSON.stringify({prompt}))
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
function run(command, args, extra = {}) {
  const r = spawnSync(command, args, { cwd: REPO, env: env(extra), encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 })
  return { ...r, out: `${r.stdout || ''}\n${r.stderr || ''}` }
}
const script = (args, extra = {}) => run(process.execPath, [SCRIPT, ...args], extra)
function git(...args) {
  const r = run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  assert.equal(r.status, 0, r.out)
  return r.stdout.trim()
}
function commit(files, message = `change ${Object.keys(files).join(' ')}`) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(REPO, path)), { recursive: true })
    writeFileSync(join(REPO, path), text)
  }
  git('add', ...Object.keys(files)); git('commit', '-qm', message)
  return git('rev-parse', 'HEAD')
}
const records = () => existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const seed = (...values) => { mkdirSync(dirname(LOG), { recursive: true }); appendFileSync(LOG, values.map(JSON.stringify).join('\n') + '\n') }
const calls = () => readdirSync(CALLS).length
const allowed = (r) => assert.equal(r.status, 0, r.out)
function close(id, statuses, testCmd = 'true') {
  const path = join(ROOT, 'statuses.json')
  writeFileSync(path, JSON.stringify(statuses))
  const before = records().length
  const r = script(['--close', id, '--status', path, '--test-cmd', testCmd])
  return { ...r, record: records().length > before ? records().at(-1) : null }
}
function closed(id, statuses) {
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
const AFTER = /Fix check head must equal closing HEAD, or the commits after it may only touch files named by its fixed findings: /
const named = (files) => new RegExp(`${AFTER.source}${files.map((f) => f.replace(/[./]/g, '\\$&')).join(', ')}\\. Unresolved work goes to the operator, no third model pass`)
const X1 = { issue: 'one is wrong', file: 'src/one.js', line: '1', quote: 'export const one = 2', suggestion: 'fix it',
  likelihood: 5, impact: 5, protected: false, trigger: 'importing one' }
const FIXED = { x1: { status: 'fixed' } }
const REJECTED = { x1: { status: 'rejected', reason: 'intended', evidence: 'src/one.js:1' } }
// The review, a test change that needs a fix check, and that fix check with x1 on src/one.js.
function fixChecked(paths) {
  allowed(script([], paths ? { REVIEW_PATHS: paths } : {}))
  const review = records().filter((e) => e.type === 'review').at(-1)
  commit({ 'src/one.test.js': 'test one\n' })
  refused(review.id, {}, /run --fix-check first/)
  allowed(script(['--fix-check', review.id], { STUB_FINDINGS: JSON.stringify({ findings: [X1] }) }))
  const check = records().at(-1)
  assert.equal(check.kind, 'fix-check'); assert.equal(check.head, git('rev-parse', 'HEAD'))
  assert.deepEqual(check.findingDetails.map((f) => [f.id, f.file, f.severity, f.status]), [['x1', 'src/one.js', 'medium', 'verified-quote']])
  return { review, check }
}

beforeEach(() => {
  for (const path of [HOME, REPO, CALLS]) rmSync(path, { recursive: true, force: true })
  mkdirSync(dirname(LOG), { recursive: true }); mkdirSync(REPO); mkdirSync(CALLS)
  git('init', '-q', '-b', 'main')
  commit({ 'README.md': 'base\n', 'src/one.js': 'export const one = 1\n', 'lib/two.js': 'export const two = 1\n' })
  git('checkout', '-qb', 'feat')
  commit({ 'src/one.js': 'export const one = 2\n' })
})

test('F1 a commit after the fix check touching only the fixed x1 file closes complete, with no model pass', () => {
  const { review, check } = fixChecked()
  const head = commit({ 'src/one.js': 'export const one = 3\n' })
  const before = calls()
  const record = closed(review.id, FIXED)
  assert.equal(record.closeHead, head); assert.equal(record.fixCheck, check.id)
  assert.deepEqual(record.tests, { cmd: 'true', passed: true })
  assert.equal(calls(), before, 'close runs no model')
  allowed(script(['--summary']))
})
test('F2 the commits after the fix check also touching another file, or a test x1 does not name, are refused and named', () => {
  const { review } = fixChecked()
  commit({ 'src/one.js': 'export const one = 3\n', 'lib/two.js': 'export const two = 2\n' })
  refused(review.id, FIXED, named(['lib/two.js']))
  git('reset', '-q', '--hard', 'HEAD~1')
  commit({ 'src/one.js': 'export const one = 3\n', 'src/one.test.js': 'test one, edited\n' })
  refused(review.id, FIXED, named(['src/one.test.js']))
})
test('F3 a change to the x1 file is refused when x1 is rejected or waived rather than fixed', () => {
  const { review, check } = fixChecked()
  allowed(script(['--dispute', check.id, 'x1', '--reason', 'intended', '--evidence', 'src/one.js:1']))
  assert.equal(records().at(-1).verdict, 'REFUTED')
  commit({ 'src/one.js': 'export const one = 3\n' })
  refused(review.id, REJECTED, named(['src/one.js']))
  // A waiver as --waive logs it (operator-only, under a terminal): still not fixed, so still refused.
  seed({ type: 'override', action: 'waive', ts: new Date().toISOString(), review: check.id, finding: 'x1', reason: 'the operator accepts it' })
  refused(review.id, REJECTED, named(['src/one.js']))
  // The same statuses are valid: at the fix check head they close.
  git('reset', '-q', '--hard', check.head)
  closed(review.id, REJECTED)
})
test('F4 a fix check head that is no longer an ancestor of HEAD (a rewritten branch) is refused with its own message', () => {
  const { review, check } = fixChecked()
  writeFileSync(join(REPO, 'src/one.js'), 'export const one = 3\n')
  git('add', 'src/one.js'); git('commit', '-q', '--amend', '-m', 'rewritten')
  assert.notEqual(git('rev-parse', 'HEAD'), check.head)
  refused(review.id, FIXED, new RegExp(`Fix check head ${check.head} is not an ancestor of closing HEAD \\(the branch was rewritten after it\\)\\. Unresolved work goes to the operator, no third model pass`))
})
test('F5 a builds/-only change after the fix check is still refused; the push gate lets builds/ commits follow the close', () => {
  const { review, check } = fixChecked()
  commit({ 'builds/demo/log.md': 'notes\n' })
  refused(review.id, FIXED, named(['builds/demo/log.md']))
  refused(review.id, REJECTED, named(['builds/demo/log.md']))
  git('reset', '-q', '--hard', 'HEAD~1')
  commit({ 'src/one.js': 'export const one = 3\n', 'builds/demo/log.md': 'notes\n' })
  refused(review.id, FIXED, named(['builds/demo/log.md']))
  // Close first, then commit the notes: a complete close still covers a builds/-only descendant.
  git('reset', '-q', '--hard', check.head)
  closed(review.id, FIXED)
  commit({ 'builds/demo/log.md': 'notes\n' })
  allowed(script(['--summary']))
})
test('F6 sliced: a change outside the slice after the fix check does not block; one inside it that x1 does not name does', () => {
  const { review, check } = fixChecked('src/')
  assert.deepEqual(review.paths, ['src/']); assert.deepEqual(check.paths, ['src/'])
  commit({ 'src/one.js': 'export const one = 3\n', 'lib/two.js': 'export const two = 2\n' })
  const record = closed(review.id, FIXED)
  assert.equal(record.closeHead, git('rev-parse', 'HEAD'))
  commit({ 'src/extra.js': 'export const extra = 1\n' })
  refused(review.id, FIXED, named(['src/extra.js']))
})
test('F7 a failing test command at close still refuses after the fix check', () => {
  const { review } = fixChecked()
  commit({ 'src/one.js': 'export const one = 3\n' })
  const r = close(review.id, FIXED, 'false')
  assert.notEqual(r.status, 0, r.out); assert.equal(r.record, null)
  assert.match(r.out, /Tests failed at HEAD/)
  closed(review.id, FIXED)
})
test('F8 a close at the fix check head is unchanged', () => {
  const { review, check } = fixChecked()
  refused(review.id, {}, /Finding x1 needs a fixed or rejected status/)
  const before = calls()
  const record = closed(review.id, FIXED)
  assert.equal(record.closeHead, check.head); assert.equal(record.fixCheck, check.id)
  assert.equal(calls(), before)
  assert.notEqual(script(['--fix-check', review.id]).status, 0, 'still one fix check per review')
  allowed(script(['--summary']))
})
