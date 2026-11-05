import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// The merge tier: computed at close, logged on the close record, printed by --summary with what the merge policy would
// do. Report only. Stub CLIs, a stub tier classifier, temporary HOME and Git config; no real model.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'review.mjs')
const ROOT = mkdtempSync(join(tmpdir(), 'review-tier-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), BIN = join(ROOT, 'bin'), TIER_CALLS = join(ROOT, 'tier-calls.jsonl')
const LOG = join(HOME, '.agent-config-studio/review-log/review-log.jsonl')
const HOME_CONFIG = join(HOME, '.agent-config-studio/review-gate/config.json')
const ZERO = '0'.repeat(40)
mkdirSync(BIN)
const stub = (name, body) => {
  writeFileSync(join(BIN, name), `#!${process.execPath}\n${body}`)
  chmodSync(join(BIN, name), 0o755)
}
stub('model-id', `const a=process.argv.slice(2), ids={sol:'gpt-stub-sol',opus:'claude-stub-opus',grok:'grok-stub'}; console.log(a[0]==='--role' ? JSON.stringify({use:['sol','opus','grok'],ids:['gpt-stub-sol','claude-stub-opus','grok-stub']}) : a[0]==='--flavor' ? JSON.stringify({flavor:{effort:'high'}}) : ids[a[0]] || 'stub-'+a[0])`)
const modelBody = `
const fs = require('node:fs')
const a = process.argv.slice(2)
if (a[0] === 'mcp') { console.log('[]'); process.exit(0) }
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8') : a[a.indexOf('--json-schema')+1]
const reply = schema.includes('"scores"') ? '{"scores":[]}'
  : schema.includes('"verdicts"') ? '{"verdicts":[]}'
  : (process.env.STUB_FINDINGS || '{"findings":[]}')
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1], reply)
else console.log(JSON.stringify({structured_output:JSON.parse(reply),structuredOutput:JSON.parse(reply),modelUsage:{'stub-grok':{}}}))
`
for (const name of ['codex', 'claude', 'grok']) stub(name, modelBody)
// The tier classifier: logs its argv and stdin, then answers STUB_TIER ("fail" exits 3, anything else is printed as is).
stub('tierjev', `
const fs = require('node:fs')
const input = fs.readFileSync(0, 'utf8')
fs.appendFileSync(${JSON.stringify(TIER_CALLS)}, JSON.stringify({ args: process.argv.slice(2), input }) + '\\n')
const mode = process.env.STUB_TIER || ''
if (mode === 'fail') { console.error('tierjev broke'); process.exit(3) }
console.log(mode)
`)
after(() => rmSync(ROOT, { recursive: true, force: true }))

const env = (extra = {}) => ({ HOME, CODEX_HOME: join(HOME, '.codex'), GROK_HOME: join(HOME, '.grok'), GIT_CONFIG_GLOBAL: join(HOME, 'isolated.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1', PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: ROOT, REVIEW_BASE: 'main', REVIEW_REVIEWER: 'sol', ...extra })
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
function commit(files) {
  write(files)
  git('add', ...Object.keys(files)); git('commit', '-qm', `change ${Object.keys(files).join(' ')}`)
  return git('rev-parse', 'HEAD')
}
const records = () => existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const allowed = (r) => assert.equal(r.status, 0, r.out)
const homeConfig = (config) => { mkdirSync(dirname(HOME_CONFIG), { recursive: true }); writeFileSync(HOME_CONFIG, JSON.stringify(config)) }
const tierCalls = () => existsSync(TIER_CALLS) ? readFileSync(TIER_CALLS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
function reviewed(findings = [], extra = {}) {
  allowed(script([], { STUB_FINDINGS: JSON.stringify({ findings }), ...extra }))
  return records().filter((e) => e.type === 'review' && e.kind === 'review').at(-1)
}
function close(id, statuses = {}, { tests = ['--test-cmd', 'true'], extra = {} } = {}) {
  const path = join(ROOT, 'statuses.json')
  writeFileSync(path, JSON.stringify(statuses))
  const before = records().length
  const r = script(['--close', id, '--status', path, ...tests], extra)
  return { ...r, record: records().length > before ? records().at(-1) : null }
}
function closed(id, statuses = {}, options = {}) {
  const r = close(id, statuses, options)
  allowed(r); assert.equal(r.record?.type, 'close', r.out)
  return r.record
}
// Review the branch as it stands and close it; returns the close record.
const reviewAndClose = (options = {}, findings = [], statuses = {}) => closed(reviewed(findings, options.extra).id, statuses, options)
const summary = (extra = {}) => { const r = script(['--summary'], extra); allowed(r); return r }
const tierLine = (text) => text.split('\n').filter((line) => line.startsWith('Merge tier: '))
const gate = () => script(['--gate'], {}, `refs/heads/feat ${git('rev-parse', 'HEAD')} refs/heads/feat ${ZERO}\n`)
const TSX = 'export const A = 1\nexport const B = 2\n'
const scored = (over = {}) => ({ issue: 'a is wrong', file: 'web/App.tsx', line: '1', quote: 'export const A = 1', suggestion: 'fix a',
  likelihood: 5, impact: 5, protected: false, trigger: 'rendering App', ...over })

beforeEach(() => {
  for (const path of [HOME, REPO, TIER_CALLS]) rmSync(path, { recursive: true, force: true })
  mkdirSync(dirname(LOG), { recursive: true }); mkdirSync(REPO)
  git('init', '-q', '-b', 'main')
  commit({ 'README.md': 'base\n', 'src/one.js': 'export const one = 1\n' })
  git('checkout', '-qb', 'feat')
})

test('1 a docs-only change with a complete close, tests run and nothing deferred is LOW, with reasons', () => {
  commit({ 'docs/guide.md': '# Guide\ntext\n', 'README.md': 'base\nmore\n' })
  const record = reviewAndClose()
  assert.equal(record.status, 'complete')
  assert.equal(record.tier, 'low')
  assert.equal(record.tierBy, 'rules')
  assert.ok(Array.isArray(record.tierReasons) && record.tierReasons.length >= 2, JSON.stringify(record.tierReasons))
  assert.ok(record.tierReasons.some((r) => /no logic/i.test(r)), JSON.stringify(record.tierReasons))
  assert.ok(record.tierReasons.some((r) => /nothing deferred/i.test(r)), JSON.stringify(record.tierReasons))
  assert.equal(Object.hasOwn(record, 'tierClassifier'), false, 'no classifier configured: none logged')
  assert.deepEqual(record.stats.kinds, { static: 0, docs: 2, tests: 0, logic: 0, other: 0 })
})

test('2 a .tsx logic change is MEDIUM; adding a riskPaths file makes it HIGH', () => {
  commit({ 'web/App.tsx': TSX })
  const medium = reviewAndClose()
  assert.equal(medium.tier, 'medium')
  assert.ok(medium.tierReasons.some((r) => /logic/i.test(r) && r.includes('2')), JSON.stringify(medium.tierReasons))
  commit({ 'src/auth/login.ts': 'export const login = 1\n' })
  const high = reviewAndClose()
  assert.equal(high.tier, 'high')
  assert.ok(high.tierReasons.some((r) => /riskPaths/.test(r) && r.includes('src/auth/login.ts')), JSON.stringify(high.tierReasons))
})

test('2 a deferred HIGH, or a deferred finding marked protected, makes the tier HIGH', () => {
  commit({ 'web/App.tsx': TSX })
  const review = reviewed([scored()])
  commit({ 'web/App.tsx': 'export const A = 10\nexport const B = 2\n' })
  const check = script(['--fix-check', review.id], { STUB_FINDINGS: JSON.stringify({ findings: [
    scored({ issue: 'b leaks', line: '2', quote: 'export const B = 2', likelihood: 9, impact: 9 }),
  ] }) })
  allowed(check)
  const record = closed(review.id, { f1: { status: 'fixed' }, x1: { status: 'deferred', reason: 'later' } })
  assert.equal(record.tier, 'high')
  assert.ok(record.tierReasons.some((r) => /deferred HIGH/.test(r) && r.includes('x1')), JSON.stringify(record.tierReasons))
})

test('2 a deferred finding marked protected makes a docs-only change HIGH', () => {
  commit({ 'docs/guide.md': '# Guide\n' })
  const review = reviewed([scored({ file: 'docs/guide.md', quote: '# Guide' })])
  commit({ 'docs/guide.md': '# Guide\nfixed\n' })
  allowed(script(['--fix-check', review.id], { STUB_FINDINGS: JSON.stringify({ findings: [
    scored({ issue: 'guide is thin', file: 'docs/guide.md', quote: '# Guide' }),
    scored({ issue: 'guide wipes data', file: 'docs/guide.md', line: '2', quote: 'fixed', likelihood: 1, impact: 2, protected: true }),
  ] }) }))
  const record = closed(review.id, { f1: { status: 'fixed' }, x1: { status: 'deferred', reason: 'later' }, x2: { status: 'deferred', reason: 'later' } })
  assert.equal(record.tier, 'high')
  assert.ok(record.tierReasons.some((r) => /protected/.test(r) && r.includes('x2')), JSON.stringify(record.tierReasons))
})

test('2 --no-tests makes the tier HIGH, and so does a partial close', () => {
  commit({ 'docs/guide.md': '# Guide\n' })
  const record = reviewAndClose({ tests: ['--no-tests', 'no suite here'] })
  assert.equal(record.tier, 'high')
  assert.ok(record.tierReasons.some((r) => /tests did not run/i.test(r) && r.includes('no suite here')), JSON.stringify(record.tierReasons))
  commit({ 'docs/more.md': 'more\n' })
  const review = reviewed()
  commit({ 'docs/late.md': 'late\n' })
  const partial = closed(review.id)
  assert.equal(partial.status, 'partial')
  assert.equal(partial.tier, 'high')
  assert.ok(partial.tierReasons.some((r) => /partial/.test(r)), JSON.stringify(partial.tierReasons))
})

test('2 alwaysHuman: .github/workflows and package.json by default, plus merge.alwaysHuman globs; lockfiles are not on it', () => {
  commit({ '.github/workflows/ci.yml': 'on: push\n' })
  const workflow = reviewAndClose()
  assert.equal(workflow.tier, 'high')
  assert.ok(workflow.tierReasons.some((r) => /always human/i.test(r) && r.includes('.github/workflows/ci.yml')), JSON.stringify(workflow.tierReasons))
  git('checkout', '-q', '-B', 'feat', 'main')
  commit({ 'package.json': '{}\n' })
  assert.equal(reviewAndClose().tier, 'high')
  git('checkout', '-q', '-B', 'feat', 'main')
  commit({ 'package-lock.json': '{}\n' })
  assert.notEqual(reviewAndClose().tier, 'high', 'a lockfile is not always-human')
  git('checkout', '-q', '-B', 'feat', 'main')
  homeConfig({ merge: { alwaysHuman: ['docs/legal/**'] } })
  commit({ 'docs/legal/terms.md': 'terms\n' })
  const legal = reviewAndClose()
  assert.equal(legal.tier, 'high')
  assert.ok(legal.tierReasons.some((r) => r.includes('docs/legal/terms.md')), JSON.stringify(legal.tierReasons))
})

test('3 --summary prints the tier line before Deferred findings; the policy defaults to off, and each policy says what it would do', () => {
  commit({ 'docs/guide.md': '# Guide\n' })
  reviewAndClose()
  const text = summary().stdout
  const lines = text.trim().split('\n')
  const [line] = tierLine(text)
  assert.match(line, /^Merge tier: LOW \(.+\)\. Policy off: needs a human$/)
  assert.equal(lines.indexOf(line), lines.indexOf('Deferred findings') - 1, text)
  assert.equal(tierLine(text).length, 1)
  const policy = (p) => { homeConfig({ merge: { policy: p } }); return tierLine(summary().stdout)[0] }
  assert.match(policy('strict'), /Policy strict: would merge$/)
  assert.match(policy('standard'), /Policy standard: would merge$/)
  assert.match(policy('always'), /Policy always: would merge$/)
  assert.match(policy('off'), /Policy off: needs a human$/)
  assert.match(policy('bogus'), /Policy off: needs a human$/, 'an unknown policy is off')
  // The push gate prints the same summary, tier line included; it still decides nothing by tier.
  homeConfig({})
  const pushed = gate(); allowed(pushed)
  assert.ok(pushed.stderr.includes(text.trim()), pushed.out)
})

test('3 strict merges a LOW only when every file is docs or tests; always merges MEDIUM but never HIGH', () => {
  commit({ 'docs/guide.md': '# Guide\n', 'web/app.css': 'a{}\n' })
  assert.equal(reviewAndClose().tier, 'low')
  homeConfig({ merge: { policy: 'strict' } })
  assert.match(tierLine(summary().stdout)[0], /^Merge tier: LOW .*Policy strict: needs a human$/)
  homeConfig({ merge: { policy: 'standard' } })
  assert.match(tierLine(summary().stdout)[0], /Policy standard: would merge$/)
  commit({ 'web/App.tsx': TSX })
  homeConfig({ merge: { policy: 'always' } })
  assert.equal(reviewAndClose().tier, 'medium')
  assert.match(tierLine(summary().stdout)[0], /^Merge tier: MEDIUM .*Policy always: would merge$/)
  homeConfig({ merge: { policy: 'standard' } })
  assert.match(tierLine(summary().stdout)[0], /Policy standard: needs a human$/)
  commit({ 'src/billing.js': 'export const bill = 1\n' })
  homeConfig({ merge: { policy: 'always' } })
  assert.equal(reviewAndClose().tier, 'high')
  assert.match(tierLine(summary().stdout)[0], /^Merge tier: HIGH .*Policy always: needs a human$/)
})

const answer = (choice, confidence, probabilities) => JSON.stringify({ answers: { tier: { type: 'choice', choice, confidence, probabilities } } })
test('4 the classifier moves a MEDIUM to LOW at or above the threshold, and is logged with its probabilities', () => {
  homeConfig({ merge: { classifier: 'tierjev', threshold: 0.8 } })
  commit({ 'web/App.tsx': TSX })
  const record = reviewAndClose({ extra: { STUB_TIER: answer('low', 0.8, { low: 0.8, medium: 0.2 }) } })
  assert.equal(record.tier, 'low')
  assert.equal(record.tierBy, 'classifier')
  assert.deepEqual(record.tierClassifier.probabilities, { low: 0.8, medium: 0.2 })
  assert.equal(record.tierClassifier.confidence, 0.8)
  assert.equal(record.tierClassifier.choice, 'low')
  const calls = tierCalls()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['--json-out'])
  const payload = JSON.parse(calls[0].input)
  assert.equal(payload.questions.tier.type, 'choice')
  assert.deepEqual(Object.keys(payload.questions.tier.criteria), ['low', 'medium'])
  assert.deepEqual(payload.state.facts.paths, ['web/App.tsx'])
  assert.equal(payload.state.facts.stats.logicLines, 2)
  assert.ok(Array.isArray(payload.state.facts.findings) && Array.isArray(payload.state.facts.deferred))
  assert.ok(typeof payload.state.facts.kinds === 'object')
  assert.match(tierLine(summary().stdout)[0], /^Merge tier: LOW \(.*classifier.*\)\. Policy off: needs a human$/)
})

test('4 below the threshold, on a failure, on garbage or a choice outside low|medium, the rules\' MEDIUM stands', () => {
  homeConfig({ merge: { classifier: 'tierjev' } })
  commit({ 'web/App.tsx': TSX })
  const below = reviewAndClose({ extra: { STUB_TIER: answer('low', 0.79, { low: 0.79, medium: 0.21 }) } })
  assert.deepEqual([below.tier, below.tierBy], ['medium', 'rules'])
  assert.deepEqual(below.tierClassifier.probabilities, { low: 0.79, medium: 0.21 }, 'probabilities are logged even when the rules stand')
  for (const [i, mode] of ['fail', 'not json at all', answer('high', 0.99, { high: 0.99 }), JSON.stringify({ answers: {} })].entries()) {
    commit({ 'web/App.tsx': `${TSX}export const C${i} = 3\n` })
    const record = reviewAndClose({ extra: { STUB_TIER: mode } })
    assert.deepEqual([record.tier, record.tierBy], ['medium', 'rules'], mode)
    assert.ok(typeof record.tierClassifier.error === 'string' && record.tierClassifier.error, `${mode}: ${JSON.stringify(record.tierClassifier)}`)
  }
  assert.equal(tierCalls().length, 5)
  // A threshold the config sets higher is honored.
  homeConfig({ merge: { classifier: 'tierjev', threshold: 0.95 } })
  commit({ 'web/App.tsx': `${TSX}export const D = 4\n` })
  assert.equal(reviewAndClose({ extra: { STUB_TIER: answer('low', 0.9, { low: 0.9, medium: 0.1 }) } }).tier, 'medium')
})

test('4 the classifier is never called for a HIGH or a LOW', () => {
  homeConfig({ merge: { classifier: 'tierjev' } })
  const extra = { STUB_TIER: answer('low', 0.99, { low: 0.99, medium: 0.01 }) }
  commit({ 'docs/guide.md': '# Guide\n' })
  const low = reviewAndClose({ extra })
  assert.deepEqual([low.tier, low.tierBy], ['low', 'rules'])
  commit({ 'src/auth.js': 'export const auth = 1\n' })
  const high = reviewAndClose({ extra })
  assert.deepEqual([high.tier, high.tierBy], ['high', 'rules'])
  assert.deepEqual(tierCalls(), [])
  assert.equal(Object.hasOwn(low, 'tierClassifier') || Object.hasOwn(high, 'tierClassifier'), false)
})

test('5 a tracked repo config may only make the policy stricter, and cannot set merge.classifier; an untracked one can loosen', () => {
  homeConfig({ merge: { policy: 'standard' } })
  commit({ 'docs/guide.md': '# Guide\n', '.claude/review-config.json': JSON.stringify({ merge: { policy: 'always', classifier: 'tierjev' } }) })
  const record = reviewAndClose({ extra: { REVIEW_CONFIG: '', STUB_TIER: answer('low', 0.99, {}) } })
  assert.equal(tierCalls().length, 0, 'the tracked classifier never ran')
  assert.ok(record.tier)
  const loose = script(['--summary'], { REVIEW_CONFIG: '' }); allowed(loose)
  assert.match(loose.stderr, /Ignoring merge\.policy "always" in \.claude\/review-config\.json/)
  assert.match(loose.stderr, /Ignoring merge\.classifier in \.claude\/review-config\.json/)
  assert.match(tierLine(loose.stdout)[0], /Policy standard: /)
  // Stricter than the home config: honored, no warning.
  write({ '.claude/review-config.json': JSON.stringify({ merge: { policy: 'off' } }) })
  const strict = script(['--summary'], { REVIEW_CONFIG: '' }); allowed(strict)
  assert.match(tierLine(strict.stdout)[0], /Policy off: needs a human$/)
  assert.doesNotMatch(strict.stderr, /Ignoring merge/)
  // Without a merge key the tracked file leaves the home policy alone.
  write({ '.claude/review-config.json': JSON.stringify({ pick: 'first' }) })
  assert.match(tierLine(script(['--summary'], { REVIEW_CONFIG: '' }).stdout)[0], /Policy standard: /)
  // An untracked repo config is the operator's own file: it may loosen.
  git('rm', '-q', '--cached', '.claude/review-config.json'); git('commit', '-qm', 'untrack config')
  write({ '.claude/review-config.json': JSON.stringify({ merge: { policy: 'always' } }) })
  reviewAndClose({ extra: { REVIEW_CONFIG: '' } })
  const own = script(['--summary'], { REVIEW_CONFIG: '' }); allowed(own)
  assert.doesNotMatch(own.stderr, /Ignoring merge/)
  assert.match(tierLine(own.stdout)[0], /Policy always: would merge$/)
})

test('6 legacy closes without a tier summarize exactly as before: the only difference is the tier line', () => {
  commit({ 'web/App.tsx': TSX })
  const record = reviewAndClose()
  assert.deepEqual([record.tier, record.tierBy], ['medium', 'rules'])
  for (const key of ['tier', 'tierReasons', 'tierBy', 'stats']) assert.ok(Object.hasOwn(record, key), key)
  const fresh = summary().stdout
  writeFileSync(LOG, records().map((e) => {
    if (e.type !== 'close') return JSON.stringify(e)
    const { tier, tierReasons, tierBy, tierClassifier, stats, ...rest } = e
    return JSON.stringify(rest)
  }).join('\n') + '\n')
  const legacy = summary().stdout
  assert.deepEqual(tierLine(legacy), [])
  assert.equal(legacy, fresh.split('\n').filter((line) => !line.startsWith('Merge tier: ')).join('\n'))
  allowed(gate())
})

test('6 sliced closes summarize the worst tier; a legacy slice among tiered ones counts as HIGH', () => {
  commit({ 'docs/guide.md': '# Guide\n', 'web/App.tsx': TSX })
  closed(reviewed([], { REVIEW_PATHS: 'docs/' }).id)
  closed(reviewed([], { REVIEW_PATHS: 'web/' }).id)
  const [line] = tierLine(summary().stdout)
  assert.match(line, /^Merge tier: MEDIUM \(/)
  const docsClose = records().find((e) => e.type === 'close' && e.tier === 'low')
  writeFileSync(LOG, records().map((e) => {
    if (!(e.type === 'close' && e.review === docsClose.review)) return JSON.stringify(e)
    const { tier, tierReasons, tierBy, stats, ...rest } = e
    return JSON.stringify(rest)
  }).join('\n') + '\n')
  assert.match(tierLine(summary().stdout)[0], /^Merge tier: HIGH \(.*no merge tier.*\)/)
})

test('8 the skills describe the tier and the policy keys; the example config carries the merge block', () => {
  const pack = join(dirname(SCRIPT), '..')
  for (const harness of ['claude', 'codex']) {
    const text = readFileSync(join(pack, 'skills', harness, 'code-review', 'SKILL.md'), 'utf8')
    for (const phrase of ['Merge tier', 'merge.policy', 'merge.classifier', 'merge.threshold', 'merge.alwaysHuman'])
      assert.ok(text.includes(phrase), `${harness}: ${phrase}`)
  }
  const example = JSON.parse(readFileSync(join(pack, 'runtime', 'review-config.example.json'), 'utf8'))
  assert.deepEqual(example.merge, { policy: 'off', classifier: null, threshold: 0.8, alwaysHuman: [] })
})

// Fix round (review 2026-11-05-16-43-13-bb1c0a and the orchestrator's o1).
test('f1 the summary judges every file the tip changes against base: a package.json covered only by a clean fix check is HIGH', () => {
  commit({ 'docs/guide.md': '# Guide\n' })
  const first = reviewed()
  closed(first.id)
  commit({ 'package.json': '{"name":"x"}\n', 'docs/more.md': 'more\n' })
  allowed(script(['--fix-check', first.id], { STUB_FINDINGS: JSON.stringify({ findings: [] }) }))
  closed(reviewed([], { REVIEW_PATHS: 'docs/more.md' }).id)
  homeConfig({ merge: { policy: 'standard' } })
  const [line] = tierLine(summary().stdout)
  assert.match(line, /^Merge tier: HIGH \(.*always human: package\.json.*\)\. Policy standard: needs a human$/)
})

test('f2 the tier line counts every deferred finding the summary lists, including an earlier close\'s deferred HIGH', () => {
  commit({ 'docs/guide.md': '# Guide\n' })
  const review = reviewed([scored({ file: 'docs/guide.md', quote: '# Guide' })])
  commit({ 'docs/guide.md': '# Guide\nfixed\n' })
  allowed(script(['--fix-check', review.id], { STUB_FINDINGS: JSON.stringify({ findings: [
    scored({ issue: 'guide misleads', file: 'docs/guide.md', line: '2', quote: 'fixed', likelihood: 9, impact: 9 }),
  ] }) }))
  closed(review.id, { f1: { status: 'fixed' }, x1: { status: 'deferred', reason: 'later' } })
  commit({ 'docs/other.md': 'other\n' })
  const fresh = reviewAndClose()
  assert.equal(fresh.tier, 'low', 'the fresh close alone sees nothing deferred')
  homeConfig({ merge: { policy: 'standard' } })
  const text = summary().stdout
  assert.ok(text.includes('x1 HIGH'), text)
  const [line] = tierLine(text)
  assert.match(line, /^Merge tier: HIGH \(.*deferred HIGH: x1.*\)\. Policy standard: needs a human$/)
  assert.doesNotMatch(line, /nothing deferred/)
})

test('f2 a deferred MEDIUM from an earlier close keeps the summary from LOW', () => {
  commit({ 'docs/guide.md': '# Guide\n' })
  const review = reviewed([scored({ file: 'docs/guide.md', quote: '# Guide' })])
  commit({ 'docs/guide.md': '# Guide\nfixed\n' })
  allowed(script(['--fix-check', review.id], { STUB_FINDINGS: JSON.stringify({ findings: [
    scored({ issue: 'guide is thin', file: 'docs/guide.md', line: '2', quote: 'fixed' }),
  ] }) }))
  closed(review.id, { f1: { status: 'fixed' }, x1: { status: 'deferred', reason: 'later' } })
  commit({ 'docs/other.md': 'other\n' })
  assert.equal(reviewAndClose().tier, 'low')
  homeConfig({ merge: { policy: 'standard' } })
  assert.match(tierLine(summary().stdout)[0], /^Merge tier: MEDIUM \(.*deferred: x1.*\)\. Policy standard: needs a human$/)
})

test('f3 a rename is judged by its source and its destination: logic moved under tests/ is not LOW', () => {
  mkdirSync(join(REPO, 'tests')); git('mv', 'src/one.js', 'tests/one.js'); git('commit', '-qm', 'move one')
  const record = reviewAndClose()
  assert.notEqual(record.tier, 'low', JSON.stringify(record.tierReasons))
  assert.equal(record.stats.kinds.logic, 1)
  assert.match(tierLine(summary().stdout)[0], /^Merge tier: MEDIUM /)
})

test('f3 riskPaths and always-human apply to a rename\'s source too', () => {
  git('checkout', '-q', 'main'); commit({ '.github/workflows/ci.yml': 'on: push\n' }); git('checkout', '-q', '-B', 'feat', 'main')
  mkdirSync(join(REPO, 'docs')); git('mv', '.github/workflows/ci.yml', 'docs/ci.md'); git('commit', '-qm', 'move ci')
  const record = reviewAndClose()
  assert.equal(record.tier, 'high')
  assert.ok(record.tierReasons.some((r) => /always human/.test(r) && r.includes('.github/workflows/ci.yml')), JSON.stringify(record.tierReasons))
  assert.match(tierLine(summary().stdout)[0], /^Merge tier: HIGH \(.*always human: .*\.github\/workflows\/ci\.yml/)
})

test('f4 the review records its intent, and the tier classifier reads it at --close', () => {
  homeConfig({ merge: { classifier: 'tierjev' } })
  commit({ 'web/App.tsx': TSX })
  allowed(script(['make the button blue'], { STUB_FINDINGS: JSON.stringify({ findings: [] }) }))
  const review = records().filter((e) => e.type === 'review').at(-1)
  assert.equal(review.intent, 'make the button blue')
  closed(review.id, {}, { extra: { STUB_TIER: answer('medium', 0.9, {}) } })
  assert.equal(JSON.parse(tierCalls()[0].input).state.facts.intent, 'make the button blue')
  // A legacy review record without intent falls back to the intent given at --close.
  commit({ 'web/App.tsx': `${TSX}export const C = 3\n` })
  const legacy = reviewed()
  writeFileSync(LOG, records().map((e) => { if (e.id !== legacy.id) return JSON.stringify(e); const { intent, ...rest } = e; return JSON.stringify(rest) }).join('\n') + '\n')
  const path = join(ROOT, 'statuses.json'); writeFileSync(path, '{}')
  allowed(script(['--close', legacy.id, '--status', path, '--test-cmd', 'true', 'legacy intent'], { STUB_TIER: answer('medium', 0.9, {}) }))
  assert.equal(JSON.parse(tierCalls()[1].input).state.facts.intent, 'legacy intent')
})

test('o1 the classifier is never asked when anything is deferred, even one that would answer low at 0.99', () => {
  homeConfig({ merge: { classifier: 'tierjev' } })
  commit({ 'web/App.tsx': TSX })
  const record = reviewAndClose({ extra: { STUB_TIER: answer('low', 0.99, { low: 0.99, medium: 0.01 }) } },
    [scored({ issue: 'a name is vague', likelihood: 1, impact: 2 })])
  assert.deepEqual([record.tier, record.tierBy], ['medium', 'rules'])
  assert.ok(record.tierReasons.some((r) => /deferred: f1/.test(r)), JSON.stringify(record.tierReasons))
  assert.equal(Object.hasOwn(record, 'tierClassifier'), false)
  assert.deepEqual(tierCalls(), [])
})

// Same class as f1, for file kinds: a file covered only by a clean fix check still counts toward LOW and strict.
function fixCheckCovers(files) {
  commit({ 'docs/guide.md': '# Guide\n' })
  const first = reviewed()
  closed(first.id)
  commit({ ...files, 'docs/more.md': 'more\n' })
  allowed(script(['--fix-check', first.id], { STUB_FINDINGS: JSON.stringify({ findings: [] }) }))
  closed(reviewed([], { REVIEW_PATHS: 'docs/more.md' }).id)
}
test('f1k a logic file covered only by a clean fix check keeps the summary from LOW', () => {
  fixCheckCovers({ 'src/two.js': 'export const two = 2\n' })
  homeConfig({ merge: { policy: 'standard' } })
  assert.match(tierLine(summary().stdout)[0], /^Merge tier: MEDIUM \(.*src\/two\.js.*\)\. Policy standard: needs a human$/)
})
test('f1k a static file covered only by a clean fix check leaves LOW but fails strict\'s docs-and-tests-only check', () => {
  fixCheckCovers({ 'web/app.css': 'a{}\n' })
  homeConfig({ merge: { policy: 'strict' } })
  assert.match(tierLine(summary().stdout)[0], /^Merge tier: LOW .*Policy strict: needs a human$/)
  homeConfig({ merge: { policy: 'standard' } })
  assert.match(tierLine(summary().stdout)[0], /^Merge tier: LOW .*Policy standard: would merge$/)
})
test('f1k a classifier LOW on a close\'s own logic file stands in the summary', () => {
  homeConfig({ merge: { classifier: 'tierjev' } })
  commit({ 'web/App.tsx': TSX })
  assert.equal(reviewAndClose({ extra: { STUB_TIER: answer('low', 0.9, { low: 0.9, medium: 0.1 }) } }).tier, 'low')
  assert.match(tierLine(summary().stdout)[0], /^Merge tier: LOW /)
})
