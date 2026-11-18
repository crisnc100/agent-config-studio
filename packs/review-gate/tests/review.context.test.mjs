import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// The context pass's review side: a docs-focus slice (review.mjs --focus docs), the comment-only classifier
// (--comment-only) and the merge tier for a comment-only commit a closed docs-focus slice covers. Stub CLIs record every
// model call; temporary HOME and Git config; no real model.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'review.mjs')
const SKILLS = join(dirname(SCRIPT), '..', 'skills')
const ROOT = mkdtempSync(join(tmpdir(), 'review-context-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), BIN = join(ROOT, 'bin'), CALLS = join(ROOT, 'calls.jsonl')
const LOG = join(HOME, '.agent-config-studio/review-log/review-log.jsonl')
const SEC_LOG = join(HOME, '.agent-config-studio/review-log/security-log.jsonl')
const HOME_CONFIG = join(HOME, '.agent-config-studio/review-gate/config.json')
const MARKER = 'SECURITY REVIEW ONLY.'
const ZERO = '0'.repeat(40)
mkdirSync(BIN)
const stub = (name, body) => {
  writeFileSync(join(BIN, name), `#!${process.execPath}\n${body}`)
  chmodSync(join(BIN, name), 0o755)
}
// STUB_ROLES lists the roles model-id knows (default reviewer and security); any other role answers the way model-id
// does for a role nobody chose.
stub('model-id', `
const a = process.argv.slice(2), ids = { sol: 'gpt-stub-sol', opus: 'claude-stub-opus' }
const roles = { reviewer: 'sol,opus', security: 'opus,sol' }
const known = (process.env.STUB_ROLES ?? 'reviewer,security').split(',')
if (a[0] === '--role') {
  if (!known.includes(a[1])) { console.error('model-id: role "' + a[1] + '" is not set — choose its model'); console.log('family=MODEL-ID-UNRESOLVED-' + a[1]); process.exit(2) }
  const use = roles[a[1]].split(',')
  console.log(JSON.stringify({ use, ids: use.map((f) => ids[f]) }))
} else if (a[0] === '--flavor') console.log(JSON.stringify({ flavor: { effort: 'high' } }))
else console.log(ids[a[0]] || 'stub-' + a[0])
`)
const modelBody = `
const fs = require('node:fs')
const a = process.argv.slice(2), cli = require('node:path').basename(process.argv[1])
if (a[0] === 'mcp') { console.log('[]'); process.exit(0) }
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8') : a[a.indexOf('--json-schema')+1]
const prompt = cli === 'codex' ? a.at(-1) : a[a.indexOf('-p')+1]
const kind = schema.includes('"scores"') ? 'scores' : schema.includes('"verdicts"') ? 'verdicts' : prompt.includes(${JSON.stringify(MARKER)}) ? 'security' : 'code'
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ cli, kind, prompt }) + '\\n')
const reply = kind === 'scores' ? '{"scores":[]}' : kind === 'verdicts' ? '{"verdicts":[]}'
  : kind === 'security' ? (process.env.STUB_SEC_FINDINGS || '{"findings":[]}') : (process.env.STUB_FINDINGS || '{"findings":[]}')
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1], reply)
else console.log(JSON.stringify({ structured_output: JSON.parse(reply), structuredOutput: JSON.parse(reply) }))
`
for (const name of ['codex', 'claude']) stub(name, modelBody)
after(() => rmSync(ROOT, { recursive: true, force: true }))

const env = (extra = {}) => ({ HOME, CODEX_HOME: join(HOME, '.codex'), GROK_HOME: join(HOME, '.grok'), GIT_CONFIG_GLOBAL: join(HOME, 'isolated.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1', PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: ROOT, REVIEW_BASE: 'main', ...extra })
function run(command, args, extra = {}, input = undefined, cwd = REPO) {
  const r = spawnSync(command, args, { cwd, env: env(extra), encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024 * 1024, ...(input !== undefined && { input }) })
  return { ...r, out: `${r.stdout || ''}\n${r.stderr || ''}` }
}
const script = (args, extra = {}, input = undefined) => run(process.execPath, [SCRIPT, ...args], extra, input)
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
const lines = (path) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const text = (path) => existsSync(path) ? readFileSync(path, 'utf8') : ''
const calls = () => lines(CALLS)
const allowed = (r) => assert.equal(r.status, 0, r.out)
const refused = (r, pattern) => { assert.notEqual(r.status, 0, r.out); if (pattern) assert.match(r.out, pattern) }
const findingsJson = (r) => JSON.parse(r.stdout.slice(r.stdout.indexOf('===FINDINGS_JSON===') + 19))
const gate = () => script(['--gate'], {}, `refs/heads/feat ${git('rev-parse', 'HEAD')} refs/heads/feat ${ZERO}\n`)
const APP = 'export const one = 1\nexport const two = 2\nexport const three = 3\n'
const finding = (over = {}) => ({ issue: 'two leaks a token', file: 'src/app.js', line: '2', quote: 'export const two = 2', suggestion: 'drop it',
  likelihood: 6, impact: 7, protected: false, trigger: 'reading two', ...over })
const findings = (...list) => JSON.stringify({ findings: list })

function reviewed(extra = {}, args = []) {
  const r = script(args, { REVIEW_REVIEWER: 'sol', ...extra })
  allowed(r)
  return findingsJson(r).reviewId
}
function closed(id, statuses = {}) {
  const path = join(ROOT, 'statuses.json')
  writeFileSync(path, JSON.stringify(statuses))
  const r = script(['--close', id, '--status', path, '--test-cmd', 'true'])
  allowed(r)
  return lines(LOG).at(-1)
}
const homeConfig = (config) => { mkdirSync(dirname(HOME_CONFIG), { recursive: true }); writeFileSync(HOME_CONFIG, JSON.stringify(config)) }
const docsSlice = (paths, extra = {}) => reviewed({ REVIEW_PATHS: paths, ...extra }, ['--focus', 'docs'])
const commentOnly = (from, to, ...paths) => { const r = script(['--comment-only', from, to, ...paths]); allowed(r); return JSON.parse(r.stdout) }

beforeEach(() => {
  for (const path of [HOME, REPO, CALLS]) rmSync(path, { recursive: true, force: true })
  mkdirSync(REPO)
  git('init', '-q', '-b', 'main')
  commit({ 'README.md': 'base\n' })
  git('checkout', '-qb', 'feat')
  commit({ 'src/app.js': APP, 'README.md': 'base\nThe app exports one, two and three.\n' })
})

test('1 --focus docs reviews a slice with the full code-correctness prompt plus the docs instructions, and the security pass runs on it', () => {
  homeConfig({ security: { run: 'always' } })
  const id = docsSlice('src/app.js,README.md')
  const code = calls().filter((c) => c.kind === 'code'), security = calls().filter((c) => c.kind === 'security')
  assert.equal(code.length, 1); assert.equal(security.length, 1, 'a docs slice is a real review: the security pass runs')
  assert.match(code[0].prompt, /CODE CORRECTNESS only/)
  assert.match(code[0].prompt, /DOCS AND COMMENTS/)
  for (const part of ['untrue', 'not backed by the code', 'code-line change', '+The app exports one, two and three.'])
    assert.ok(code[0].prompt.includes(part), part)
  const record = lines(LOG).find((e) => e.id === id)
  assert.equal(record.focus, 'docs')
  assert.deepEqual(record.paths, ['README.md', 'src/app.js'])
  assert.equal(record.security.status, 'ran')
})

test('2 --focus refuses without a slice, an unknown focus, and a plain review records no focus', () => {
  refused(script(['--focus', 'docs'], { REVIEW_REVIEWER: 'sol' }), /--focus docs reviews a slice/)
  refused(script(['--focus', 'style'], { REVIEW_REVIEWER: 'sol', REVIEW_PATHS: 'README.md' }), /--focus must be docs/)
  assert.equal(calls().length, 0)
  const id = reviewed()
  assert.equal(Object.hasOwn(lines(LOG).find((e) => e.id === id), 'focus'), false)
  assert.equal(script(['--supports', '--focus']).status, 0)
})

test('3 a planted wrong doc claim the docs reviewer flags is a located finding that blocks the slice close until fixed', () => {
  commit({ 'README.md': 'base\nThe app exports one, two, three and four.\n' })
  const wrong = { issue: 'the README says the app exports four; src/app.js exports one, two and three', file: 'README.md', line: '2',
    quote: 'The app exports one, two, three and four.', suggestion: 'drop four', likelihood: 6, impact: 4, protected: false, trigger: 'a reader following the README' }
  const id = docsSlice('README.md', { STUB_FINDINGS: findings(wrong) })
  const record = lines(LOG).find((e) => e.id === id)
  assert.equal(record.findingDetails[0].status, 'verified-quote')
  assert.equal(record.findingDetails[0].severity, 'medium')
  const path = join(ROOT, 'statuses.json')
  writeFileSync(path, '{}')
  refused(script(['--close', id, '--status', path, '--test-cmd', 'true']), /f1/)
})

// ── the Bar: the coordinated PR flow, end to end, on a test repo ──
const CONTEXT_PASS = join(dirname(SCRIPT), 'context-pass.mjs')
const PR_FACTS = join(dirname(SCRIPT), '..', '..', 'pr', 'skills', 'claude', 'pr', 'pr-facts.mjs')
const node = (file, args) => run(process.execPath, [file, ...args])

test('6 the coordinated flow: code and security in one record, one fix round, one fix check, close, then a checked context commit covered by a closed docs-focus slice of its own diff; the push passes', () => {
  homeConfig({ security: { run: 'required' } })
  commit({ 'builds/feat/plan.md': '# Plan\n\n## Outcome\nThe app exports three numbers.\n' })
  // Review: one record with a code finding and a security finding.
  const codeF = { issue: 'two should be 22', file: 'src/app.js', line: '2', quote: 'export const two = 2', suggestion: 'use 22', likelihood: 5, impact: 5, protected: false, trigger: 'reading two' }
  const secF = { issue: 'three leaks', file: 'src/app.js', line: '3', quote: 'export const three = 3', suggestion: 'drop it', likelihood: 4, impact: 5, protected: false, trigger: 'reading three' }
  const main = reviewed({ STUB_FINDINGS: findings(codeF), STUB_SEC_FINDINGS: findings(secF) })
  const record = lines(LOG).find((e) => e.id === main)
  assert.deepEqual(record.findingDetails.map((f) => f.id), ['f1', 's1'])
  assert.equal(record.security.status, 'ran')
  // One fix round, one fix check (clean), close.
  commit({ 'src/app.js': 'export const one = 1\nexport const two = 22\nexport const three = 0\n' })
  allowed(script(['--fix-check', main], { REVIEW_REVIEWER: 'sol', STUB_FINDINGS: findings() }))
  const mainClose = closed(main, { f1: { status: 'fixed' }, s1: { status: 'fixed' } })
  assert.equal(mainClose.status, 'complete')
  // The context pass: a brief that passes, one writer commit of a comment and a doc edit, and its check.
  const briefPath = join(ROOT, 'context-brief.json')
  writeFileSync(briefPath, JSON.stringify({ mode: 'pr', purpose: 'The app exports three numbers', mechanism: ['src/app.js exports one, two and three'],
    decisions: ['two is 22 and three is 0 after review'], readers: { 'README.md': 'users', comments: 'the next maintainer' }, base: 'main',
    docMap: [{ behavior: 'the exported numbers', docs: ['README.md'] }], untouchable: ['builds/**'] }))
  allowed(node(CONTEXT_PASS, ['--check-brief', briefPath]))
  commit({ 'src/app.js': '// Callers read these three numbers at start; two and three changed after review.\nexport const one = 1\nexport const two = 22\nexport const three = 0\n',
    'README.md': 'base\nThe app exports one (1), two (22) and three (0).\n' })
  const touched = git('diff', '--name-only', 'HEAD~1', 'HEAD').split('\n')
  assert.deepEqual(touched, ['README.md', 'src/app.js'])
  const checkCommit = node(CONTEXT_PASS, ['--check-commit', 'HEAD', '--brief', briefPath])
  assert.equal(checkCommit.status, 0, checkCommit.out)
  // The docs table, committed in the build folder beside the plan.
  commit({ 'builds/feat/docs-table.json': JSON.stringify({ rows: [{ behavior: 'the exported numbers', files: ['src/app.js'],
    docs: [{ path: 'README.md', claims: [{ claim: 'two is 22', at: 'src/app.js:3' }, { claim: 'three is 0', at: 'src/app.js:4' }] }] }] }) })
  // A docs-focus slice of exactly the files the context commit touched, since the main close's head, closed at the tip.
  rmSync(CALLS, { force: true })
  const slice = reviewed({ REVIEW_PATHS: touched.join(',') }, ['--focus', 'docs', '--since-close', mainClose.closeHead])
  assert.deepEqual(calls().map((c) => c.kind).sort(), ['code', 'security'], 'exactly one docs reviewer and one security pass, nothing else')
  const code = calls().filter((c) => c.kind === 'code'), security = calls().filter((c) => c.kind === 'security')
  assert.match(code[0].prompt, /\+\/\/ Callers read these three numbers/, 'the docs reviewer sees the context commit')
  assert.doesNotMatch(code[0].prompt, /\+export const two = 22/, 'and only it: not the fix the main review already covered')
  assert.match(security[0].prompt, /\+export const two = 22/, 'the security pass reads the whole slice, the fix it never saw included')
  const sliceClose = closed(slice)
  assert.equal(sliceClose.status, 'complete')
  assert.ok(!sliceClose.tierReasons.some((r) => /security pass did not see/.test(r)), JSON.stringify(sliceClose.tierReasons))
  // The push passes through the normal gate: no override, no new exception.
  const pushed = gate()
  allowed(pushed)
  assert.doesNotMatch(pushed.out, /override/i)
  assert.equal(JSON.parse(script(['--tier-json']).stdout).covered, true)
  // pr-facts reads the table: complete passes; a code file no row covers fails.
  writeFileSync(join(ROOT, 'body.md'), '# x\n')
  const docsProblems = () => JSON.parse(node(PR_FACTS, ['--base', 'main', '--check', join(ROOT, 'body.md')]).stdout).problems.filter((p) => /docs table/.test(p))
  assert.deepEqual(docsProblems(), [])
  commit({ 'src/extra.js': 'export const extra = 1\n' })
  assert.deepEqual(docsProblems(), ['docs table: src/extra.js changed, but no row covers it'])
})

// ── --since-close: a slice that reviews only what changed after a close ──
function closedMain() {
  const main = reviewed()
  return closed(main)
}
test('7 --since-close reviews only the delta after a complete close, records it, covers its files at the tip, and the push passes', () => {
  const mainClose = closedMain()
  commit({ 'src/app.js': `// The three numbers.\n${APP}` })
  rmSync(CALLS, { force: true })
  const id = reviewed({ REVIEW_PATHS: 'src/app.js' }, ['--focus', 'docs', '--since-close', mainClose.closeHead])
  const prompt = calls().find((c) => c.kind === 'code').prompt
  assert.match(prompt, /\+\/\/ The three numbers\./)
  assert.doesNotMatch(prompt, /\+export const one = 1/, 'lines the main review saw are not in the delta')
  assert.match(prompt, new RegExp(`git diff ${mainClose.closeHead}\\.\\.HEAD -- src/app\\.js`))
  const record = lines(LOG).find((e) => e.id === id)
  assert.equal(record.sinceClose, mainClose.closeHead)
  assert.deepEqual(record.files, ['src/app.js'])
  assert.equal(record.baseSha, lines(LOG).find((e) => e.id === mainClose.review).baseSha, 'the base stays the branch base')
  closed(id)
  allowed(gate())
})

test('8 --since-close refuses without a slice, at a commit no complete close of this branch ended at, and for a file that close did not cover', () => {
  const mainClose = closedMain()
  commit({ 'src/app.js': `// The three numbers.\n${APP}` })
  refused(script(['--since-close', mainClose.closeHead], { REVIEW_REVIEWER: 'sol' }), /--since-close reviews a slice/)
  const first = git('rev-list', '--max-parents=0', 'HEAD')
  refused(script(['--since-close', first], { REVIEW_REVIEWER: 'sol', REVIEW_PATHS: 'src/app.js' }), /no complete close of this branch ended at/)
  refused(script(['--since-close', 'nope'], { REVIEW_REVIEWER: 'sol', REVIEW_PATHS: 'src/app.js' }), /does not name a commit/)
  assert.equal(calls().filter((c) => c.kind === 'code').length, 1, 'only the main review ran a model')
  // A main close that was a slice of README only never covered src/app.js at its head.
  git('checkout', '-qb', 'feat2', 'main')
  commit({ 'src/app.js': APP, 'README.md': 'base\nMore.\n' })
  const readmeOnly = closed(reviewed({ REVIEW_PATHS: 'README.md' }))
  commit({ 'src/app.js': `// The three numbers.\n${APP}` })
  refused(script(['--since-close', readmeOnly.closeHead], { REVIEW_REVIEWER: 'sol', REVIEW_PATHS: 'src/app.js' }),
    /src\/app\.js: its state at .* was not covered by that close/)
})

test('9 --since-close: a file the security prompt cut at the cap stays out of what the pass saw, and the close names it', () => {
  homeConfig({ security: { run: 'required' } })
  const body = (name, n) => Array.from({ length: n }, (_, i) => `export const ${name}${i} = ${i}`).join('\n') + '\n'
  const A = body('a', 4300), Z = body('z', 800)
  commit({ 'src/a.js': A, 'src/z.js': Z })
  const head = git('rev-parse', 'HEAD')
  // The main review in two slices, each under the cap on its own, closed at one head: both files covered there.
  const aClose = closed(reviewed({ REVIEW_PATHS: 'src/a.js' }))
  const zClose = closed(reviewed({ REVIEW_PATHS: 'src/z.js' }))
  assert.equal(aClose.closeHead, head); assert.equal(zClose.closeHead, head)
  commit({ 'src/a.js': `// The a numbers.\n${A}`, 'src/z.js': `// The z numbers.\n${Z}` })
  rmSync(CALLS, { force: true })
  const id = reviewed({ REVIEW_PATHS: 'src/a.js,src/z.js' }, ['--focus', 'docs', '--since-close', head])
  const record = lines(LOG).find((e) => e.id === id)
  assert.equal(record.security.status, 'ran')
  const saw = new Map(record.security.saw)
  assert.ok(saw.has('src/a.js'), 'a.js is inside the cap')
  assert.equal(saw.has('src/z.js'), false, 'z.js is past the cap in the diff the security pass got')
  const close = closed(id)
  assert.ok(close.tierReasons.some((r) => /security pass did not see src\/z\.js/.test(r)), JSON.stringify(close.tierReasons))
  assert.equal(close.tier, 'high')
})

// ── close once: the context pass runs before the one fix check, which reviews it with the docs focus ──
// The docs focus names the context commit; in these tests it is the last commit.
const DOCS_CHECK = 'docs'
const fixCheck = (id, extra = {}, args = [DOCS_CHECK]) => {
  args = args.flatMap((a) => a === DOCS_CHECK ? ['--focus', 'docs', '--context-commit', git('rev-parse', 'HEAD')] : [a])
  const r = script(['--fix-check', id, ...args], { REVIEW_REVIEWER: 'sol', ...extra })
  allowed(r)
  return lines(LOG).filter((e) => e.kind === 'fix-check' && e.review === id).at(-1)
}
const closes = () => lines(LOG).filter((e) => e.type === 'close')
const COMMENTED = `// Callers read these three numbers at start.\n${APP}`

test('10 --fix-check --focus docs runs the fix check with the docs instructions for the diff\'s comment and doc edits, and the record logs the focus', () => {
  const id = reviewed()
  commit({ 'src/app.js': COMMENTED, 'README.md': 'base\nThe app exports one, two and three numbers.\n' })
  rmSync(CALLS, { force: true })
  const check = fixCheck(id)
  const code = calls().filter((c) => c.kind === 'code')
  assert.equal(code.length, 1)
  assert.match(code[0].prompt, /^Fix check: review only this fix diff/)
  assert.match(code[0].prompt, /DOCS AND COMMENTS/)
  assert.match(code[0].prompt, /the comment and doc edits in this diff/)
  for (const part of ['untrue', 'not backed by the code', '+// Callers read these three numbers at start.']) assert.ok(code[0].prompt.includes(part), part)
  assert.doesNotMatch(code[0].prompt, /any code-line change/, 'a fix check\'s diff holds the fix round\'s code lines too')
  assert.equal(check.focus, 'docs')
  // A plain fix check records no focus and gets no docs instructions.
  const other = reviewed({ REVIEW_PATHS: 'README.md' })
  commit({ 'README.md': 'base\nThe app exports three numbers.\n' })
  rmSync(CALLS, { force: true })
  const plain = fixCheck(other, {}, [])
  assert.equal(Object.hasOwn(plain, 'focus'), false)
  assert.doesNotMatch(calls().find((c) => c.kind === 'code').prompt, /DOCS AND COMMENTS/)
})

test('11 the unsliced close-once flow: review → fix → context commit → fix check --focus docs → one close; the push, --summary and the tier are clean', () => {
  homeConfig({ security: { run: 'required' } })
  const id = reviewed({ STUB_FINDINGS: findings(finding({ issue: 'two should be 22' })) })
  commit({ 'src/app.js': 'export const one = 1\nexport const two = 22\nexport const three = 3\n' })
  commit({ 'src/app.js': '// Callers read these three numbers at start.\nexport const one = 1\nexport const two = 22\nexport const three = 3\n',
    'README.md': 'base\nThe app exports one, two (22) and three.\n' })
  rmSync(CALLS, { force: true })
  const check = fixCheck(id)
  assert.deepEqual(calls().map((c) => c.kind).sort(), ['code', 'security'], 'the fix round changed src/app.js after the review\'s pass saw it')
  assert.equal(check.security.status, 'ran')
  const close = closed(id, { f1: { status: 'fixed' } })
  assert.equal(close.status, 'complete')
  assert.equal(closes().length, 1, 'exactly one close')
  const state = git('ls-tree', 'HEAD', 'src/app.js').split(/\s+/)
  assert.deepEqual(close.coverage.find(([p]) => p === 'src/app.js'), ['src/app.js', `${state[0]} ${state[2]}`], 'the commented file is covered at its tip state')
  assert.ok(!close.tierReasons.some((t) => /security/.test(t)), JSON.stringify(close.tierReasons))
  assert.notEqual(close.tier, 'high')
  allowed(gate())
  const tier = JSON.parse(script(['--tier-json']).stdout)
  assert.equal(tier.covered, true); assert.notEqual(tier.tier, 'high', JSON.stringify(tier))
  const summary = script(['--summary'])
  allowed(summary)
  assert.doesNotMatch(summary.out, /security pass did not|no security pass ran/)
})

test('12 a fix check whose fix round and context commit touched only docs and tests starts no security pass, says why, and the tier does not count it', () => {
  homeConfig({ security: { run: 'required' } })
  const id = reviewed({ STUB_FINDINGS: findings(finding({ issue: 'README is wrong', file: 'README.md', line: '2', quote: 'The app exports one, two and three.' })) })
  commit({ 'README.md': 'base\nThe app exports one, two and three numbers.\n', 'test/app.test.js': 'import "../src/app.js"\n' })
  rmSync(CALLS, { force: true })
  const r = script(['--fix-check', id, '--focus', 'docs', '--context-commit', git('rev-parse', 'HEAD')], { REVIEW_REVIEWER: 'sol' })
  allowed(r)
  assert.deepEqual(calls().map((c) => c.kind), ['code'])
  assert.match(r.out, /security pass: not-required \(no security-relevant file changed since a security pass saw it\)/)
  const check = lines(LOG).find((e) => e.kind === 'fix-check' && e.review === id)
  assert.equal(check.security.status, 'not-required')
  const close = closed(id, { f1: { status: 'fixed' } })
  assert.equal(close.status, 'complete')
  assert.ok(!close.tierReasons.some((t) => /security/.test(t)), JSON.stringify(close.tierReasons))
})

test('13 security.run "always" runs the pass in every fix check; off and --code-only run none', () => {
  homeConfig({ security: { run: 'always' } })
  const id = reviewed()
  commit({ 'README.md': 'base\nThe app exports one, two and three numbers.\n' })
  rmSync(CALLS, { force: true })
  assert.equal(fixCheck(id).security.status, 'ran')
  assert.deepEqual(calls().map((c) => c.kind).sort(), ['code', 'security'])
  for (const [config, args, status, n] of [[{ security: { run: 'off' } }, [DOCS_CHECK], 'off', 4], [{ security: { run: 'required' } }, ['--code-only'], 'not-asked', 5]]) {
    homeConfig(config)
    const next = reviewed({ REVIEW_PATHS: 'src/app.js' }, args.includes('--code-only') ? ['--code-only'] : [])
    commit({ 'src/app.js': `${APP}export const n = ${n}\n` })
    rmSync(CALLS, { force: true })
    const check = fixCheck(next, {}, args)
    assert.deepEqual(calls().map((c) => c.kind), ['code'], status)
    assert.equal(check.security?.status ?? 'off', status)
  }
})

test('14 docs findings of a --focus docs fix check are deferred like any fix-check finding, and --summary lists them with their numbers', () => {
  const id = reviewed()
  commit({ 'src/app.js': `// Callers read these three numbers once.\nexport const one = 1\nexport const two = 2\nexport const three = 30\n`,
    'README.md': 'base\nThe app exports one, two and four.\n' })
  const medium = { likelihood: 5, impact: 5 }
  const docs = finding({ ...medium, issue: 'README says four', file: 'README.md', line: '2', quote: 'The app exports one, two and four.' })
  const comment = finding({ ...medium, issue: 'the comment says once', file: 'src/app.js', line: '1', quote: '// Callers read these three numbers once.' })
  const code = finding({ ...medium, issue: 'three became 30', file: 'src/app.js', line: '4', quote: 'export const three = 30' })
  const check = fixCheck(id, { STUB_FINDINGS: findings(docs, comment, code) })
  assert.deepEqual(check.findingDetails.map((f) => [f.id, f.severity]), [['x1', 'medium'], ['x2', 'medium'], ['x3', 'medium']])
  const statusFile = join(ROOT, 'statuses.json')
  const defer = { status: 'deferred', reason: 'later' }
  writeFileSync(statusFile, JSON.stringify({ x1: defer, x2: defer, x3: defer }))
  allowed(script(['--close', id, '--status', statusFile, '--test-cmd', 'true']))
  assert.equal(closes().length, 1)
  const summary = script(['--summary'])
  allowed(summary)
  const deferred = summary.out.slice(summary.out.indexOf('Deferred findings'))
  for (const issue of ['README says four', 'the comment says once', 'three became 30']) assert.ok(deferred.includes(issue), issue)
  assert.equal((deferred.match(/MEDIUM 25\/100 \(likelihood 5\/10 × impact 5\/10\)/g) || []).length, 3, deferred)
})

// ── the fix check's security pass vouches only for what it read; a close counts only this review's passes ──
const secCalls = () => calls().filter((c) => c.kind === 'security')
test('15 after a --code-only review, the fix check\'s security pass reads the whole base..HEAD change of each file it vouches for, not only the fix', () => {
  homeConfig({ security: { run: 'required' } })
  const id = reviewed({}, ['--code-only'])
  commit({ 'src/app.js': 'export const one = 1\nexport const two = 2\nexport const three = 33\n' })
  rmSync(CALLS, { force: true })
  const check = fixCheck(id, {}, [])
  assert.equal(check.security.status, 'ran')
  assert.match(secCalls()[0].prompt, /\+export const one = 1/, 'the branch\'s original change to src/app.js, which no pass had seen')
  const close = closed(id)
  assert.ok(!close.tierReasons.some((t) => /security/.test(t)), JSON.stringify(close.tierReasons))
})

test('16 a close never borrows another review\'s security pass', () => {
  homeConfig({ security: { run: 'required' } })
  const other = reviewed()
  assert.equal(lines(LOG).find((e) => e.id === other).security.status, 'ran')
  const id = reviewed({}, ['--code-only'])
  const close = closed(id)
  assert.equal(close.tier, 'high')
  assert.ok(close.tierReasons.some((t) => /security pass did not cover/.test(t)), JSON.stringify(close.tierReasons))
})

test('17 a rename needs its source\'s deletion seen too, not only the destination', () => {
  const BODY = Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n'
  git('checkout', '-q', 'main'); commit({ 'src/old.js': BODY }); git('checkout', '-qb', 'feat4')
  homeConfig({ security: { run: 'required' } })
  commit({ 'src/new.js': `${BODY}export const extra = 1\n` })
  const id = reviewed()
  assert.ok(lines(LOG).find((e) => e.id === id).security.saw.some(([p]) => p === 'src/new.js'))
  git('rm', '-q', 'src/old.js'); git('commit', '-qm', 'drop old')
  fixCheck(id, {}, ['--code-only'])
  const close = closed(id)
  assert.ok(close.tierReasons.some((t) => /security pass did not see .*src\/new\.js/.test(t)), JSON.stringify(close.tierReasons))
})

test('18 a required fix-check security pass that failed puts a reason in the tier, even when nothing else is unseen', () => {
  homeConfig({ security: { run: 'always' } })
  const id = reviewed()
  commit({ 'README.md': 'base\nThe app exports one, two and three numbers.\n' })
  const check = fixCheck(id, { REVIEW_SECURITY_TEST_FAULT: 'exit' })
  assert.equal(check.security.status, 'failed')
  const close = closed(id)
  assert.equal(close.tier, 'high')
  assert.ok(close.tierReasons.some((t) => /fix check's security pass failed/.test(t)), JSON.stringify(close.tierReasons))
})

test('19 under security.run "always" a close with no security pass at all is HIGH, docs-only included', () => {
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'docs-only')
  commit({ 'README.md': 'base\nOnly docs.\n' })
  homeConfig({ security: { run: 'always' } })
  const close = closed(reviewed({}, ['--code-only']))
  assert.equal(close.tier, 'high')
  assert.ok(close.tierReasons.some((t) => /security/.test(t)), JSON.stringify(close.tierReasons))
})

test('20 a fix check whose security pass ran lists the security family among its reviewers, so it cannot judge its own finding', () => {
  homeConfig({ security: { run: 'required' } })
  const id = reviewed()
  commit({ 'src/app.js': 'export const one = 1\nexport const two = 2\nexport const three = 33\n' })
  const check = fixCheck(id, { STUB_SEC_FINDINGS: findings(finding({ file: 'src/app.js', line: '3', quote: 'export const three = 33' })) }, [])
  assert.equal(check.security.status, 'ran')
  assert.deepEqual(check.families.sort(), [check.family, check.security.family].sort())
  assert.equal(check.findingDetails.find((f) => f.quote === 'export const three = 33').source, 'security')
})

test('21 under "always", a changed docs file no pass saw after the review is named at close, as code would be', () => {
  homeConfig({ security: { run: 'always' } })
  const id = reviewed()
  commit({ 'README.md': 'base\nThe app exports one, two and three numbers.\n' })
  fixCheck(id, {}, ['--code-only'])
  const close = closed(id)
  assert.equal(close.tier, 'high')
  assert.ok(close.tierReasons.some((t) => /security pass did not see README\.md/.test(t)), JSON.stringify(close.tierReasons))
})

test('22 a fix check whose required security pass failed covers nothing for the push gate', () => {
  homeConfig({ security: { run: 'required' } })
  const a = reviewed({ REVIEW_PATHS: 'src/app.js' })
  commit({ 'src/app.js': 'export const one = 1\nexport const two = 2\nexport const three = 33\n' })
  const check = fixCheck(a, { REVIEW_SECURITY_TEST_FAULT: 'exit', STUB_FINDINGS: findings() }, [])
  assert.equal(check.security.status, 'failed')
  assert.equal(check.findings, 0)
  closed(reviewed({ REVIEW_PATHS: 'README.md' }))
  const pushed = gate()
  refused(pushed, /src\/app\.js/)
})

test('23 a binary diff of a code file is never recorded as seen, by the security pass or the reviewer; a binary image stays covered', () => {
  homeConfig({ security: { run: 'required' } })
  commit({ 'src/blob.js': 'export const x = 1\u0000\n', 'img/logo.png': '\u0089PNG\u0000\u0001' })
  const id = reviewed()
  const record = lines(LOG).find((e) => e.id === id)
  assert.ok(record.truncated.includes('src/blob.js'), JSON.stringify(record.truncated))
  assert.ok(!record.truncated.includes('img/logo.png'), JSON.stringify(record.truncated))
  assert.ok(!record.security.saw.some(([p]) => p === 'src/blob.js'), JSON.stringify(record.security.saw))
  commit({ 'src/blob.js': 'export const x = 2\u0000\n' })
  const check = fixCheck(id, {}, [])
  assert.equal(check.security.status, 'ran')
  assert.ok(!check.security.saw.some(([p]) => p === 'src/blob.js'), JSON.stringify(check.security.saw))
  assert.ok(!check.coverage.some(([p]) => p === 'src/blob.js'), JSON.stringify(check.coverage))
})

test('24 a --focus docs fix check needs --context-commit inside the fix range; its prompt names that commit and its files and asks for any code-line change there', () => {
  const id = reviewed()
  commit({ 'src/app.js': 'export const one = 1\nexport const two = 2\nexport const three = 33\n' })
  commit({ 'src/app.js': '// Callers read these at start.\nexport const one = 1\nexport const two = 2\nexport const three = 33\n', 'README.md': 'base\nThree numbers.\n' })
  const context = git('rev-parse', 'HEAD')
  refused(script(['--fix-check', id, '--focus', 'docs'], { REVIEW_REVIEWER: 'sol' }), /--context-commit/)
  refused(script(['--fix-check', id, '--focus', 'docs', '--context-commit', git('rev-parse', 'main')], { REVIEW_REVIEWER: 'sol' }), /--context-commit .* is not a commit after the review/)
  rmSync(CALLS, { force: true })
  const check = fixCheck(id)
  const prompt = calls().find((c) => c.kind === 'code').prompt
  assert.ok(prompt.includes(`context commit ${context}`), 'names the commit')
  assert.match(prompt, /README\.md, src\/app\.js/)
  assert.match(prompt, /any code-line change in the context commit/)
  assert.equal(check.contextCommit, context)
})

test('25 a security finding of the fix check on code outside the fix diff is fixed or disputed, never deferred; one in the fix may be deferred', () => {
  homeConfig({ security: { run: 'required' } })
  const LONG = (last) => ['export const one = 1', ...Array.from({ length: 12 }, (_, i) => `export const pad${i} = ${i}`), `export const last = ${last}`].join('\n') + '\n'
  commit({ 'src/app.js': LONG(1) })
  const id = reviewed({}, ['--code-only'])
  commit({ 'src/app.js': LONG(2) })
  const old = finding({ issue: 'one leaks', file: 'src/app.js', line: '1', quote: 'export const one = 1', likelihood: 5, impact: 5 })
  const inFix = finding({ issue: 'last leaks', file: 'src/app.js', line: '14', quote: 'export const last = 2', likelihood: 5, impact: 5 })
  const check = fixCheck(id, { STUB_SEC_FINDINGS: findings(old, inFix) }, [])
  const [x1, x2] = check.findingDetails
  assert.deepEqual([x1.source, x1.inFix, x2.source, x2.inFix], ['security', false, 'security', true])
  const statusFile = join(ROOT, 'statuses.json')
  const defer = { status: 'deferred', reason: 'later' }
  writeFileSync(statusFile, JSON.stringify({ x1: defer, x2: defer }))
  refused(script(['--close', id, '--status', statusFile, '--test-cmd', 'true']), /x1.*code no security pass had read.*fix it or dispute it/)
  writeFileSync(statusFile, JSON.stringify({ x1: { status: 'fixed' }, x2: defer }))
  allowed(script(['--close', id, '--status', statusFile, '--test-cmd', 'true']))
})
