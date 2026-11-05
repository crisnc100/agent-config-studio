import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// What review and fix-check records hold about what they reviewed (stats, plan, inFix), the fix-check prompt's
// original findings, and a fixed status's optional test. Stub CLIs, temporary HOME and Git config; no real model.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'review.mjs')
const ROOT = mkdtempSync(join(tmpdir(), 'review-records-test-'))
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
if (a[0] === 'mcp') { console.log('[]'); process.exit(0) }
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8') : a[a.indexOf('--json-schema')+1]
const prompt = a.includes('--output-schema') ? a.at(-1) : a[1]
fs.writeFileSync(path.join(${JSON.stringify(CALLS)}, process.pid+'-'+Date.now()+'.json'), JSON.stringify({prompt}))
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
const prompts = () => readdirSync(CALLS).sort().map((name) => JSON.parse(readFileSync(join(CALLS, name), 'utf8')).prompt)
function close(id, statuses) {
  const path = join(ROOT, 'statuses.json')
  writeFileSync(path, JSON.stringify(statuses))
  const before = records().length
  const r = script(['--close', id, '--status', path, '--test-cmd', 'true'])
  return { ...r, record: records().length > before ? records().at(-1) : null }
}
function closed(id, statuses) {
  const r = close(id, statuses)
  allowed(r); assert.equal(r.record?.type, 'close', r.out); assert.equal(r.record.status, 'complete', r.out)
  return r.record
}
function refused(id, statuses, pattern) {
  const r = close(id, statuses)
  assert.notEqual(r.status, 0, r.out); assert.equal(r.record, null, 'a refused close logs nothing')
  assert.match(r.out, pattern)
}
const gate = () => script(['--gate'], {}, `refs/heads/feat ${git('rev-parse', 'HEAD')} refs/heads/feat ${ZERO}\n`)

// src/one.js has 20 lines `export const vN = N`; the branch changes line 2, a fix later changes line 18.
const lines = (over = {}) => Array.from({ length: 20 }, (_, i) => over[i + 1] ?? `export const v${i + 1} = ${i + 1}`).join('\n') + '\n'
const scored = (over = {}) => ({ issue: 'v2 is wrong', file: 'src/one.js', line: '2', quote: 'export const v2 = 20', suggestion: 'use 2',
  likelihood: 5, impact: 5, protected: false, trigger: 'importing v2 at startup', ...over })
const F1 = scored()
const F2_LOW = scored({ issue: 'v3 name is vague', line: '3', quote: 'export const v3 = 3', likelihood: 1, impact: 2, trigger: 'reading v3' })
function reviewed(findings = [], extra = {}, args = []) {
  allowed(script(args, { STUB_FINDINGS: JSON.stringify({ findings }), ...extra }))
  return records().filter((e) => e.type === 'review' && e.kind === 'review').at(-1)
}
function fixChecked(review, findings = [], fix = { 'src/one.js': lines({ 2: 'export const v2 = 2', 18: 'export const v18 = 180' }), 'src/one.test.js': 'test v2\n' }) {
  commit(fix)
  allowed(script(['--fix-check', review.id], { STUB_FINDINGS: JSON.stringify({ findings }) }))
  const check = records().at(-1)
  assert.equal(check.kind, 'fix-check'); assert.equal(check.review, review.id)
  return check
}

beforeEach(() => {
  for (const path of [HOME, REPO, CALLS]) rmSync(path, { recursive: true, force: true })
  mkdirSync(dirname(LOG), { recursive: true }); mkdirSync(REPO); mkdirSync(CALLS)
  git('init', '-q', '-b', 'main')
  commit({ 'README.md': 'base\n', 'src/one.js': lines() })
  git('checkout', '-qb', 'feat')
  commit({ 'src/one.js': lines({ 2: 'export const v2 = 20' }) })
})

test('S1 a review records stats by file kind: CSS is static, .tsx is logic, .md is docs, tests and lockfiles are not logic; plan is null without one', () => {
  commit({
    'web/app.css': 'a{}\nb{}\nc{}\n',
    'web/App.tsx': 'export const A = 1\nexport const B = 2\nexport const C = 3\nexport const D = 4\nexport const E = 5\n',
    'docs/guide.md': '# Guide\ntext\n',
    'src/one.test.js': 'test\n',
    'package-lock.json': '{}\n',
  })
  const review = reviewed()
  assert.deepEqual(review.stats, {
    files: 6, linesAdded: 13, linesRemoved: 1,
    kinds: { static: 1, docs: 1, tests: 1, logic: 2, other: 1 },
    logicLines: 7, // src/one.js 1+1, web/App.tsx 5
  })
  assert.equal(review.plan, null)
  assert.ok(Object.hasOwn(review, 'plan'), 'plan is recorded as null, not left out')
})
test('S1 a review records the plan path passed by --plan or REVIEW_PLAN', () => {
  write({ 'builds/x/plan.md': '# Plan\n', 'builds/y/plan.md': '# Other\n' })
  assert.equal(reviewed([], {}, ['--plan', 'builds/x/plan.md']).plan, 'builds/x/plan.md')
  assert.equal(reviewed([], { REVIEW_PLAN: 'builds/y/plan.md' }).plan, 'builds/y/plan.md')
})
test('S1 a fix check records the fix diff stats and the plan', () => {
  write({ 'builds/x/plan.md': '# Plan\n' })
  const review = reviewed([F1])
  commit({ 'src/one.js': lines({ 2: 'export const v2 = 2' }), 'src/one.test.js': 'test v2\n', 'docs/fix.md': 'note\n' })
  allowed(script(['--fix-check', review.id, '--plan', 'builds/x/plan.md']))
  const check = records().at(-1)
  assert.equal(check.kind, 'fix-check')
  assert.deepEqual(check.stats, { files: 3, linesAdded: 3, linesRemoved: 1, kinds: { static: 0, docs: 1, tests: 1, logic: 1, other: 0 }, logicLines: 2 })
  assert.equal(check.plan, 'builds/x/plan.md')
})

test('P1 the fix-check prompt names every original finding being fixed: id, file:line, issue and trigger; filed LOWs are left out', () => {
  const review = reviewed([F1, F2_LOW])
  assert.deepEqual(review.findingDetails.map((f) => [f.id, f.severity]), [['f1', 'medium'], ['f2', 'low']])
  const before = prompts().length
  fixChecked(review)
  const prompt = prompts().slice(before).find((p) => p.startsWith('Fix check:'))
  assert.ok(prompt, 'the fix check called its reviewer')
  assert.ok(prompt.includes(`from review ${review.id}`), prompt)
  assert.ok(prompt.includes('- f1 MEDIUM src/one.js:2 — v2 is wrong; Trigger: importing v2 at startup'), prompt)
  // The filed LOW still reaches the reviewer as already decided context, never as a finding the fix repairs.
  const section = prompt.slice(prompt.indexOf('The fix is meant to repair')).split('\n\n')[0]
  assert.equal(section.split('\n').filter((l) => l.startsWith('- ')).length, 1, section)
  assert.ok(!section.includes('v3 name is vague'), section)
})
test('P1 with no original finding to fix the fix-check prompt adds no findings section', () => {
  const review = reviewed([F2_LOW])
  const before = prompts().length
  fixChecked(review)
  const prompt = prompts().slice(before).find((p) => p.startsWith('Fix check:'))
  assert.ok(prompt && !prompt.includes('The fix is meant to repair'), prompt)
})

test('I1 fix-check findings are tagged inFix: true within 3 lines of a fix-changed line, false elsewhere, null when unresolvable', () => {
  const review = reviewed([F1])
  const check = fixChecked(review, [
    scored({ issue: 'near the fix', line: '15', quote: 'export const v15 = 15' }), // 3 lines above changed line 18
    scored({ issue: 'on the fix', line: '18', quote: 'export const v18 = 180' }),
    scored({ issue: 'far from the fix', line: '10', quote: 'export const v10 = 10' }), // 8 from line 2, 8 from 18
    scored({ issue: 'just outside', line: '6', quote: 'export const v6 = 6' }), // 4 below changed line 2
    scored({ issue: 'unchanged file', file: 'README.md', line: '1', quote: 'base' }),
    scored({ issue: 'cannot be located', line: '12', quote: 'not in the file' }),
  ])
  assert.deepEqual(check.findingDetails.map((f) => [f.id, f.issue, f.inFix]), [
    ['x1', 'near the fix', true], ['x2', 'on the fix', true], ['x3', 'far from the fix', false],
    ['x4', 'just outside', false], ['x5', 'unchanged file', false], ['x6', 'cannot be located', null],
  ])
  assert.equal(check.findingDetails[5].status, 'unverified-quote')
})
test('I1 a pure deletion counts as a change at the line it follows', () => {
  const review = reviewed([F1])
  const shorter = lines({ 2: 'export const v2 = 2' }).split('\n').filter((l) => l !== 'export const v12 = 12').join('\n')
  const check = fixChecked(review, [
    scored({ issue: 'after the deletion', line: '13', quote: 'export const v14 = 14' }), // the old line 14, now 13
    scored({ issue: 'far below', line: '18', quote: 'export const v19 = 19' }),
  ], { 'src/one.js': shorter })
  assert.deepEqual(check.findingDetails.map((f) => f.inFix), [true, false])
})

test('T1 a fixed status may name its test, which --summary and the push gate print beside the finding', () => {
  const review = reviewed([F1])
  fixChecked(review)
  const statuses = { f1: { status: 'fixed', test: 'src/one.test.js', response: 'real' } }
  assert.deepEqual(closed(review.id, statuses).statuses, statuses)
  const summary = script(['--summary']); allowed(summary)
  assert.ok(summary.stdout.includes('f1 MEDIUM v2 is wrong: fixed; test: src/one.test.js'), summary.stdout)
  const pushed = gate(); allowed(pushed)
  assert.ok(pushed.stderr.includes('f1 MEDIUM v2 is wrong: fixed; test: src/one.test.js'), pushed.out)
})
test('T1 any other status key is still refused, test is refused off a fixed status, and test must be a repo-relative path', () => {
  const review = reviewed([F1])
  fixChecked(review)
  refused(review.id, { f1: { status: 'fixed', tests: 'src/one.test.js' } }, /Unknown status field for f1/)
  refused(review.id, { f1: { status: 'fixed', test: 'src/one.test.js', severity: 'low' } }, /Unknown status field for f1/)
  refused(review.id, { f1: { status: 'rejected', reason: 'intended', response: 'intentional', evidence: 'src/one.js:2', test: 'src/one.test.js' } }, /Unknown status field for f1/)
  for (const test of ['', ' ', '/abs/one.test.js', '../one.test.js', 'src/../../one.test.js', 'C:\\one.test.js', 7, null, ['src/one.test.js']])
    refused(review.id, { f1: { status: 'fixed', test } }, /Fixed f1 test must be a repo-relative path/)
})

// The same flow under a log whose review and fix-check records lack stats, plan and inFix (logged before them):
// close, --summary and the push gate answer exactly as they do with the new fields.
function legacyRun(strip) {
  for (const path of [HOME, CALLS]) rmSync(path, { recursive: true, force: true })
  mkdirSync(dirname(LOG), { recursive: true }); mkdirSync(CALLS)
  git('checkout', '-q', '-B', 'feat', 'main')
  commit({ 'src/one.js': lines({ 2: 'export const v2 = 20' }) })
  const review = reviewed([F1, F2_LOW])
  const check = fixChecked(review, [scored({ issue: 'on the fix', line: '18', quote: 'export const v18 = 180' })])
  if (strip) {
    const kept = records().map((e) => {
      if (e.type !== 'review') return e
      const { stats, plan, ...rest } = e
      return { ...rest, findingDetails: rest.findingDetails.map(({ inFix, ...f }) => f) }
    })
    assert.ok(kept.every((e) => !Object.hasOwn(e, 'stats') && !Object.hasOwn(e, 'plan') && !(e.findingDetails || []).some((f) => Object.hasOwn(f, 'inFix'))))
    writeFileSync(LOG, kept.map((e) => JSON.stringify(e)).join('\n') + '\n')
  }
  const record = closed(review.id, { f1: { status: 'fixed' }, x1: { status: 'deferred', reason: 'later' } })
  const summary = script(['--summary']); allowed(summary)
  const pushed = gate(); allowed(pushed)
  const ids = [review.id, check.id, git('rev-parse', 'HEAD')]
  const plain = (text) => ids.reduce((t, id, i) => t.split(id).join(`<id${i}>`), text)
  return { record: { ...record, ts: null, review: null, closeHead: null, fixCheck: null }, summary: plain(summary.stdout), gate: plain(pushed.stderr) }
}
test('L1 legacy records without stats, plan or inFix close, summarize and push exactly as records with them', () => {
  const fresh = legacyRun(false), legacy = legacyRun(true)
  assert.deepEqual(legacy.record, fresh.record)
  assert.equal(legacy.summary, fresh.summary)
  assert.equal(legacy.gate, fresh.gate)
  assert.match(legacy.summary, /Counts: 3 findings; 1 fixed; 0 rejected; 1 deferred/)
  assert.ok(!legacy.summary.includes('test:'), 'no status named a test')
})

test('K1 the code-review skills route by the review config, not by a changed-line count', () => {
  const skills = join(dirname(SCRIPT), '..', 'skills')
  for (const harness of ['claude', 'codex']) {
    const text = readFileSync(join(skills, harness, 'code-review', 'SKILL.md'), 'utf8')
    assert.doesNotMatch(text, />\s*400 changed lines/, harness)
    assert.doesNotMatch(text, /changed lines\)? → \*\*premium/, harness)
  }
  const claude = readFileSync(join(skills, 'claude', 'code-review', 'SKILL.md'), 'utf8')
  const auto = claude.slice(claude.indexOf('**Auto-routing')).split('\n\n')[0]
  for (const phrase of ['`force` rule', 'risk paths still force the configured family', '`routing`', 'which reviewer ran and why'])
    assert.ok(auto.includes(phrase), `${phrase}\n${auto}`)
})

test('I2 inFix reads file names git writes oddly: a space (trailing tab in the header) and a C-quoted name', () => {
  const ten = (name, over = {}) => Array.from({ length: 10 }, (_, i) => over[i + 1] ?? `export const ${name}${i + 1} = ${i + 1}`).join('\n') + '\n'
  commit({ 'src/foo bar.js': ten('a'), 'src/say "hi".js': ten('b') })
  const review = reviewed([F1])
  const check = fixChecked(review, [
    scored({ issue: 'spaced, on the fix', file: 'src/foo bar.js', line: '5', quote: 'export const a5 = 50' }),
    scored({ issue: 'quoted, on the fix', file: 'src/say "hi".js', line: '5', quote: 'export const b5 = 50' }),
    scored({ issue: 'spaced, far from the fix', file: 'src/foo bar.js', line: '10', quote: 'export const a10 = 10' }),
  ], { 'src/foo bar.js': ten('a', { 5: 'export const a5 = 50' }), 'src/say "hi".js': ten('b', { 5: 'export const b5 = 50' }) })
  assert.deepEqual(check.findingDetails.map((f) => [f.issue, f.status, f.inFix]), [
    ['spaced, on the fix', 'verified-quote', true], ['quoted, on the fix', 'verified-quote', true], ['spaced, far from the fix', 'verified-quote', false],
  ])
})
