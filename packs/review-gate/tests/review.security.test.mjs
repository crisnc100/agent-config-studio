import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// The security pass: a reviewer from the `security` role reviews the same diff beside the code reviewer, in a detached
// worker, and its findings (s1…) join the one review record. Stub CLIs record every model call (kind, start, end,
// prompt); temporary HOME and Git config; no real model.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'review.mjs')
const ROOT = mkdtempSync(join(tmpdir(), 'review-security-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), BIN = join(ROOT, 'bin'), CALLS = join(ROOT, 'calls.jsonl'), MARKS = join(ROOT, 'marks')
const LOG = join(HOME, '.agent-config-studio/review-log/review-log.jsonl')
const HOME_CONFIG = join(HOME, '.agent-config-studio/review-gate/config.json')
const MARKER = 'SECURITY REVIEW ONLY.'
mkdirSync(BIN)
const stub = (name, body) => {
  writeFileSync(join(BIN, name), `#!${process.execPath}\n${body}`)
  chmodSync(join(BIN, name), 0o755)
}
// The reviewer role is sol, opus, grok; the security role is STUB_SECURITY_ROLE (families, comma-separated; "unset"
// answers the way model-id does for a role nobody chose), opus then sol by default.
stub('model-id', `
const a = process.argv.slice(2), ids = { sol: 'gpt-stub-sol', opus: 'claude-stub-opus', grok: 'grok-stub', fable: 'claude-stub-fable' }
if (a[0] === '--role') {
  const role = a[1] === 'security' ? (process.env.STUB_SECURITY_ROLE ?? 'opus,sol') : 'sol,opus,grok'
  if (role === 'unset') { console.error('model-id: role "security" is not set — choose its model'); console.log('family=MODEL-ID-UNRESOLVED-security'); process.exit(2) }
  const use = role.split(',')
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
const model = cli === 'codex' ? (a.find((x) => x.startsWith('model=')) || '').slice(6) : a[a.indexOf(cli === 'claude' ? '--model' : '-m')+1]
const kind = schema.includes('"scores"') ? 'scores' : schema.includes('"verdicts"') ? 'verdicts' : prompt.includes(${JSON.stringify(MARKER)}) ? 'security' : 'code'
const start = Date.now()
const sleep = Number(process.env[kind === 'security' ? 'STUB_SEC_SLEEP_MS' : 'STUB_CODE_SLEEP_MS'] || 0)
if (sleep && (kind === 'security' || kind === 'code')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleep)
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ cli, model, kind, start, end: Date.now(), prompt }) + '\\n')
if (kind === 'security' && (process.env.STUB_SEC_FAIL || '').split(',').includes(cli)) { console.error('quota exhausted'); process.exit(3) }
const reply = kind === 'scores' ? '{"scores":[]}' : kind === 'verdicts' ? '{"verdicts":[]}'
  : kind === 'security' ? (process.env.STUB_SEC_FINDINGS || '{"findings":[]}') : (process.env.STUB_FINDINGS || '{"findings":[]}')
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1], reply)
else console.log(JSON.stringify({ structured_output: JSON.parse(reply), structuredOutput: JSON.parse(reply), modelUsage: { 'stub-grok': {} } }))
`
for (const name of ['codex', 'claude', 'grok']) stub(name, modelBody)
after(() => rmSync(ROOT, { recursive: true, force: true }))

const env = (extra = {}) => ({ HOME, CODEX_HOME: join(HOME, '.codex'), GROK_HOME: join(HOME, '.grok'), GIT_CONFIG_GLOBAL: join(HOME, 'isolated.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1', PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: ROOT, REVIEW_BASE: 'main', REVIEW_REVIEWER: 'sol', ...extra })
function run(command, args, extra = {}) {
  const r = spawnSync(command, args, { cwd: REPO, env: env(extra), encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024 * 1024 })
  return { ...r, out: `${r.stdout || ''}\n${r.stderr || ''}` }
}
const script = (args, extra = {}) => run(process.execPath, [SCRIPT, ...args], extra)
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
}
const records = () => existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const reviewRecords = () => records().filter((e) => e.type === 'review' && e.kind === 'review')
const calls = () => existsSync(CALLS) ? readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const securityCalls = () => calls().filter((c) => c.kind === 'security')
const codeCalls = () => calls().filter((c) => c.kind === 'code')
const homeConfig = (config) => { mkdirSync(dirname(HOME_CONFIG), { recursive: true }); writeFileSync(HOME_CONFIG, JSON.stringify(config)) }
const allowed = (r) => assert.equal(r.status, 0, r.out)
const findingsJson = (r) => JSON.parse(r.stdout.slice(r.stdout.indexOf('===FINDINGS_JSON===') + 19))
function reviewed(extra = {}, args = []) {
  const r = script(args, extra)
  allowed(r)
  return { ...r, record: reviewRecords().at(-1), json: findingsJson(r) }
}
const APP = 'export const one = 1\nexport const two = 2\nexport const three = 3\nexport const four = 4\nexport const five = 5\nexport const six = 6\n'
const finding = (over = {}) => ({ issue: 'one is wrong', file: 'src/app.ts', line: '1', quote: 'export const one = 1', suggestion: 'fix it',
  likelihood: 5, impact: 5, protected: false, trigger: 'importing app', ...over })
const findings = (...list) => JSON.stringify({ findings: list })
const SEC = finding({ issue: 'six leaks a secret', line: '6', quote: 'export const six = 6', trigger: 'reading six', likelihood: 6, impact: 7 })
const required = (extra = {}) => homeConfig({ security: { run: 'required' }, ...extra })

beforeEach(() => {
  for (const path of [HOME, REPO, CALLS, MARKS]) rmSync(path, { recursive: true, force: true })
  mkdirSync(dirname(LOG), { recursive: true }); mkdirSync(REPO); mkdirSync(MARKS)
  git('init', '-q', '-b', 'main')
  commit({ 'README.md': 'base\n', 'src/one.js': 'export const one = 1\nexport const two = 2\nexport const three = 3\n' })
  git('checkout', '-qb', 'feat')
})

test('1 required + a .ts change: a code call and a security call on the same diff and plan, f and s findings, one record, verify ran once', () => {
  const verifyMark = join(MARKS, 'verify')
  required({ verifyCmd: `echo ran >> ${verifyMark}` })
  const plan = join(ROOT, 'plan.md')
  writeFileSync(plan, '# Plan\nPLAN-TEXT-7731\n')
  commit({ 'src/app.ts': APP })
  const r = reviewed({ STUB_FINDINGS: findings(finding()), STUB_SEC_FINDINGS: findings(SEC) }, ['--plan', plan])
  const code = codeCalls(), security = securityCalls()
  assert.equal(code.length, 1, JSON.stringify(calls().map((c) => c.kind)))
  assert.equal(security.length, 1, JSON.stringify(calls().map((c) => c.kind)))
  assert.ok(!code[0].prompt.includes(MARKER), 'the code prompt carries no security marker')
  assert.ok(code[0].prompt.includes('CODE CORRECTNESS only'))
  assert.ok(security[0].prompt.includes(MARKER))
  assert.ok(!security[0].prompt.includes('CODE CORRECTNESS only'), 'the security prompt is not the correctness-only one')
  for (const c of [code[0], security[0]]) {
    assert.ok(c.prompt.includes('PLAN-TEXT-7731'), `${c.kind} prompt carries the plan`)
    assert.ok(c.prompt.includes('+export const six = 6'), `${c.kind} prompt carries the diff`)
    assert.ok(c.prompt.includes('PASSED before this review'), `${c.kind} prompt carries the verify result`)
  }
  assert.equal(security[0].cli, 'claude', 'the security reviewer is another vendor than the code reviewer (codex)')
  assert.deepEqual(r.json.findings.map((f) => f.id), ['f1', 's1'])
  assert.equal(r.json.findings[1].source, 'security')
  assert.equal(r.json.findings[1].severity, 'high')
  assert.equal(r.json.security.status, 'ran')
  assert.equal(reviewRecords().length, 1, 'one review record')
  const record = r.record
  assert.deepEqual(record.findingDetails.map((f) => f.id), ['f1', 's1'])
  assert.equal(record.findingDetails[1].source, 'security')
  assert.equal(Object.hasOwn(record.findingDetails[0], 'source'), false, 'a code finding carries no source')
  assert.equal(record.resolvedPaths.s1.path, 'src/app.ts')
  assert.equal(record.security.status, 'ran')
  assert.equal(record.security.family, 'opus')
  assert.equal(record.security.model, 'claude-stub-opus')
  assert.equal(record.security.findings, 1)
  assert.equal(record.family, 'sol', 'the record and rotation count the code reviewer only')
  assert.deepEqual(record.families, ['sol', 'opus'])
  assert.equal(readFileSync(verifyMark, 'utf8').trim().split('\n').length, 1, 'verify ran exactly once')
  // The worker writes no report of its own: one report folder plus latest.
  assert.deepEqual(readdirSync(join(REPO, 'reviews')).filter((d) => d !== 'latest').length, 1)
  assert.match(readFileSync(join(REPO, 'reviews/latest/code-review.md'), 'utf8'), /Security: opus \(claude-stub-opus\) — ran, 1 findings/)
})

test('2 the code call and the security call overlap in time', () => {
  required()
  commit({ 'src/app.ts': APP })
  reviewed({ STUB_CODE_SLEEP_MS: '1500', STUB_SEC_SLEEP_MS: '1500' })
  const [code] = codeCalls(), [security] = securityCalls()
  assert.ok(code && security, JSON.stringify(calls()))
  assert.ok(code.start < security.end && security.start < code.end, `code ${code.start}–${code.end}, security ${security.start}–${security.end}`)
})

test('3 docs, tests and static only, off riskPaths: not-required and no security call; a lockfile alone is not-required too', () => {
  required()
  commit({ 'docs/guide.md': '# Guide\n', 'tests/a.test.js': 'test()\n', 'web/logo.svg': '<svg/>\n' })
  let { record, json } = reviewed()
  assert.equal(record.security.status, 'not-required')
  assert.equal(json.security.status, 'not-required')
  assert.equal(securityCalls().length, 0)
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'lock')
  commit({ 'package-lock.json': '{"lockfileVersion":3}\n' })
  ;({ record } = reviewed())
  assert.equal(record.security.status, 'not-required')
  assert.equal(securityCalls().length, 0)
})

test('3 a package.json-only diff, a docs file on riskPaths and logic renamed under docs/ all run the pass', () => {
  required()
  commit({ 'package.json': '{"name":"x"}\n' })
  assert.equal(reviewed().record.security.status, 'ran')
  assert.equal(securityCalls().length, 1)
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'auth-doc')
  commit({ 'docs/auth.md': '# Auth\n' })
  assert.equal(reviewed().record.security.status, 'ran')
  assert.equal(securityCalls().length, 2)
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'moved')
  mkdirSync(join(REPO, 'docs'), { recursive: true }); git('mv', 'src/one.js', 'docs/one.md'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'move')
  assert.equal(reviewed().record.security.status, 'ran')
  assert.equal(securityCalls().length, 3)
})

test('4 selection: another vendor first; REVIEW_SECURITY_REVIEWER pins; the code review settings never move it', () => {
  required({ routing: [{ family: 'grok' }] })
  commit({ 'src/app.ts': APP })
  // Role order is opus, sol; the code reviewer is codex (sol): opus. With the code reviewer on claude: sol first.
  assert.equal(reviewed().record.security.family, 'opus')
  assert.equal(reviewed({ REVIEW_REVIEWER: 'opus', REVIEW_CLAUDE_MODEL: 'opus', STUB_SECURITY_ROLE: 'opus,sol' }).record.security.family, 'sol')
  const pinned = reviewed({ REVIEW_SECURITY_REVIEWER: 'fable' }).record.security
  assert.equal(pinned.family, 'fable'); assert.equal(pinned.model, 'claude-stub-fable')
  // A single-member role: REVIEW_REVIEWER, REVIEW_MODEL, REVIEW_PICK, REVIEW_CLAUDE_MODEL=team and routing are the code review's.
  rmSync(CALLS, { force: true })
  const solo = reviewed({ STUB_SECURITY_ROLE: 'opus', REVIEW_REVIEWER: '', REVIEW_MODEL: 'gpt-stub-sol', REVIEW_PICK: 'grok', REVIEW_CLAUDE_MODEL: 'team' }).record
  assert.equal(solo.security.family, 'opus'); assert.equal(solo.security.model, 'claude-stub-opus')
  assert.equal(securityCalls().length, 1, 'one security agent, never the team')
  assert.equal(securityCalls()[0].model, 'claude-stub-opus')
  rmSync(CALLS, { force: true })
  const same = reviewed({ STUB_SECURITY_ROLE: 'sol' }).record
  assert.equal(same.security.family, 'sol', 'a role with only the code reviewer’s vendor still runs')
})

test('4 the first member fails after its CLI was found: the next member runs', () => {
  required()
  commit({ 'src/app.ts': APP })
  const { record } = reviewed({ STUB_SEC_FAIL: 'claude', STUB_SEC_FINDINGS: findings(SEC) })
  assert.equal(record.security.status, 'ran')
  assert.equal(record.security.family, 'sol')
  assert.deepEqual(record.security.attempts.map((a) => [a.family, !!a.error]), [['opus', true], ['sol', false]])
  assert.deepEqual(securityCalls().map((c) => c.cli), ['claude', 'codex'])
  assert.ok(record.findingDetails.some((f) => f.id === 's1'))
})

test('4 an unset security role: skipped with the reason', () => {
  required()
  commit({ 'src/app.ts': APP })
  const r = reviewed({ STUB_SECURITY_ROLE: 'unset', STUB_FINDINGS: findings(finding()) })
  assert.equal(r.record.security.status, 'skipped')
  assert.match(r.record.security.reason, /not set/)
  assert.match(r.out, /security pass required .* but skipped/)
  assert.deepEqual(r.record.findingDetails.map((f) => f.id), ['f1'])
})

for (const [name, extra, reason] of [
  ['the model exits non-zero', { STUB_SEC_FAIL: 'claude' }, /quota exhausted|exit/],
  ['the worker exits non-zero', { REVIEW_SECURITY_TEST_FAULT: 'exit' }, /exited 3/],
  ['the worker exits 0 with no result', { REVIEW_SECURITY_TEST_FAULT: 'empty' }, /wrote no result/],
  ['the worker writes a malformed result', { REVIEW_SECURITY_TEST_FAULT: 'malformed' }, /malformed/],
]) {
  test(`5 ${name}: the review completes with its own findings, security failed with the reason`, () => {
    required()
    commit({ 'src/app.ts': APP })
    const r = reviewed({ STUB_SECURITY_ROLE: 'opus', STUB_FINDINGS: findings(finding()), ...extra })
    assert.equal(r.record.security.status, 'failed')
    assert.match(r.record.security.reason, reason)
    assert.deepEqual(r.record.findingDetails.map((f) => f.id), ['f1'])
    assert.equal(r.json.security.status, 'failed')
  })
}

test('5 a security reviewer that hangs past timeoutMs is killed: failed, and the review completes', () => {
  homeConfig({ security: { run: 'required', timeoutMs: 1500 } })
  commit({ 'src/app.ts': APP })
  const begun = Date.now()
  const r = reviewed({ STUB_SECURITY_ROLE: 'opus', STUB_SEC_SLEEP_MS: '30000', STUB_FINDINGS: findings(finding()) })
  assert.ok(Date.now() - begun < 25000, `took ${Date.now() - begun} ms`)
  assert.equal(r.record.security.status, 'failed')
  assert.match(r.record.security.reason, /timed out after 1500 ms/)
  assert.deepEqual(r.record.findingDetails.map((f) => f.id), ['f1'])
})

test('7 trust: a tracked repo config cannot lower security.run; an untracked one can; REVIEW_SECURITY and REVIEW_CONFIG only raise it', () => {
  required()
  commit({ 'src/app.ts': APP, '.claude/review-config.json': JSON.stringify({ security: { run: 'off' } }) })
  let r = reviewed()
  assert.equal(r.record.security.status, 'ran')
  assert.match(r.out, /Ignoring security\.run "off" in \.claude\/review-config\.json/)
  // Untracked: honored.
  git('rm', '-q', '--cached', '.claude/review-config.json'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'untrack')
  appendFileSync(join(REPO, '.git/info/exclude'), '.claude/\n')
  r = reviewed()
  assert.equal(r.record.security.status, 'off')
  rmSync(join(REPO, '.claude'), { recursive: true, force: true })
  // REVIEW_SECURITY=off under home required: still required.
  r = reviewed({ REVIEW_SECURITY: 'off' })
  assert.equal(r.record.security.status, 'ran')
  assert.match(r.out, /Ignoring REVIEW_SECURITY=off/)
  // REVIEW_CONFIG pointing at an "off" file: still required.
  const agentFile = join(ROOT, 'agent-config.json')
  writeFileSync(agentFile, JSON.stringify({ security: { run: 'off' } }))
  r = reviewed({ REVIEW_CONFIG: agentFile })
  assert.equal(r.record.security.status, 'ran')
  // With no home config, REVIEW_SECURITY raises it for one run.
  rmSync(HOME_CONFIG)
  assert.equal(reviewed().record.security.status, 'off')
  r = reviewed({ REVIEW_SECURITY: 'required' })
  assert.equal(r.record.security.status, 'ran')
  assert.equal(r.record.security.raisedBy, 'REVIEW_SECURITY')
})

test('9 --slices with the pass required: one worker per slice, each in its own slice record, no recursion', () => {
  required()
  commit({ 'src/a.js': 'export const a = 1\n', 'src/b.js': 'export const b = 1\n' })
  const r = script(['--slices', 'src/a.js;src/b.js'])
  allowed(r)
  const slices = reviewRecords()
  assert.equal(slices.length, 2)
  for (const record of slices) assert.equal(record.security.status, 'ran', JSON.stringify(record.security))
  assert.equal(securityCalls().length, 2)
  assert.equal(codeCalls().length, 2)
  const prompts = securityCalls().map((c) => c.prompt)
  assert.ok(prompts.some((p) => p.includes('covers only the paths src/a.js')) && prompts.some((p) => p.includes('covers only the paths src/b.js')))
})

test('10 no security config: the pass is off, no security call, and the record says so', () => {
  commit({ 'src/app.ts': APP })
  const r = reviewed({ STUB_FINDINGS: findings(finding()) })
  assert.equal(r.record.security.status, 'off')
  assert.equal(securityCalls().length, 0)
  assert.equal(codeCalls().length, 1)
  assert.deepEqual(r.record.families, ['sol'])
  assert.doesNotMatch(readFileSync(join(REPO, 'reviews/latest/code-review.md'), 'utf8'), /^Security:/m)
})

test('duplicates: an s finding within 3 lines of an f finding at the same file is marked duplicateOf; one further away is not', () => {
  required()
  commit({ 'src/app.ts': APP })
  const near = finding({ issue: 'two leaks', line: '2', quote: 'export const two = 2' })
  const { record } = reviewed({ STUB_FINDINGS: findings(finding()), STUB_SEC_FINDINGS: findings(near, SEC) })
  const s = Object.fromEntries(record.findingDetails.filter((f) => f.source === 'security').map((f) => [f.id, f]))
  assert.equal(s.s1.duplicateOf, 'f1')
  assert.equal(Object.hasOwn(s.s2, 'duplicateOf'), false)
})

test('a reviewer cannot set source or duplicateOf on its own findings', () => {
  required()
  commit({ 'src/app.ts': APP })
  const { record } = reviewed({ STUB_FINDINGS: findings(finding({ source: 'security', duplicateOf: 'f9' })), STUB_SEC_FINDINGS: findings({ ...SEC, duplicateOf: 'f1', source: 'code' }) })
  assert.equal(Object.hasOwn(record.findingDetails[0], 'source'), false)
  assert.equal(Object.hasOwn(record.findingDetails[0], 'duplicateOf'), false)
  assert.equal(record.findingDetails[1].source, 'security')
  assert.equal(Object.hasOwn(record.findingDetails[1], 'duplicateOf'), false)
})

