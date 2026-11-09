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
  const code = calls().filter((c) => c.kind === 'code'), security = calls().filter((c) => c.kind === 'security')
  assert.equal(code.length, 1); assert.equal(security.length, 1)
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
