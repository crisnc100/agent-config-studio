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

test('a reviewer cannot set source on its own findings', () => {
  required()
  commit({ 'src/app.ts': APP })
  const { record } = reviewed({ STUB_FINDINGS: findings(finding({ source: 'security' })), STUB_SEC_FINDINGS: findings({ ...SEC, source: 'code' }) })
  assert.equal(Object.hasOwn(record.findingDetails[0], 'source'), false)
  assert.equal(record.findingDetails[1].source, 'security')
})

// ── close, dispute, fix check, summary, deferred and tier ──
function close(id, statuses = {}, extra = {}) {
  const path = join(ROOT, 'statuses.json')
  writeFileSync(path, JSON.stringify(statuses))
  const before = records().length
  const r = script(['--close', id, '--status', path, '--test-cmd', 'true'], extra)
  return { ...r, record: records().length > before ? records().at(-1) : null }
}
const closed = (id, statuses = {}, extra = {}) => {
  const r = close(id, statuses, extra)
  allowed(r); assert.equal(r.record?.type, 'close', r.out)
  return r.record
}

test('6 close refuses an s HIGH without a status, and closes once it has one', () => {
  required()
  commit({ 'src/app.ts': APP })
  const { record } = reviewed({ STUB_FINDINGS: findings(finding()), STUB_SEC_FINDINGS: findings(SEC) })
  const refused = close(record.id, { f1: { status: 'fixed' } })
  assert.notEqual(refused.status, 0)
  assert.match(refused.out, /Finding s1 needs a fixed or rejected status/)
  const done = closed(record.id, { f1: { status: 'fixed' }, s1: { status: 'fixed' } })
  assert.equal(done.status, 'complete')
})

test('6 --dispute <review> s1 works, and the security family cannot refute its own finding', () => {
  required()
  commit({ 'src/app.ts': APP })
  const { record } = reviewed({ STUB_FINDINGS: findings(finding()), STUB_SEC_FINDINGS: findings(SEC) })
  const r = script(['--dispute', record.id, 's1', '--reason', 'not reachable', '--evidence', 'src/app.ts:6'])
  allowed(r)
  const dispute = records().filter((e) => e.type === 'dispute').at(-1)
  assert.equal(dispute.finding, 's1')
  assert.ok(!['sol', 'opus'].includes(dispute.verifier), `verifier ${dispute.verifier} reviewed this record`)
  // A REFUTED from the security family itself does not count.
  appendFileSync(LOG, `${JSON.stringify({ type: 'dispute', ts: new Date().toISOString(), review: record.id, finding: 's1', head: record.head,
    verdict: 'REFUTED', reason: 'x', evidence: 'y', verdictEvidence: 'z', family: 'sol', verifier: 'opus' })}\n`)
  const refused = close(record.id, { f1: { status: 'fixed' }, s1: { status: 'rejected', reason: 'not reachable', response: 'wrong', evidence: 'src/app.ts:6' } })
  assert.notEqual(refused.status, 0)
  assert.match(refused.out, /Rejected s1 requires a REFUTED verdict or an operator waiver.*REFUTED from opus does not count/)
})

test('6 the fix check prompt names the s findings: id, file:line, issue and trigger', () => {
  required()
  commit({ 'src/app.ts': APP })
  const { record } = reviewed({ STUB_FINDINGS: findings(finding()), STUB_SEC_FINDINGS: findings(SEC) })
  commit({ 'src/app.ts': APP.replace('export const six = 6', 'export const six = 60') })
  rmSync(CALLS, { force: true })
  allowed(script(['--fix-check', record.id]))
  const prompt = codeCalls().at(-1).prompt
  assert.ok(prompt.includes('- s1 HIGH src/app.ts:6 — six leaks a secret; Trigger: reading six'), prompt.slice(0, 2000))
  assert.ok(prompt.includes('- f1 MEDIUM src/app.ts:1 — one is wrong'))
})

test('6 --summary shows the security line and --deferred lists a filed s finding with its score', () => {
  required()
  commit({ 'src/app.ts': APP })
  const low = { ...SEC, issue: 'six is logged', likelihood: 2, impact: 3 }
  const { record } = reviewed({ STUB_FINDINGS: findings(finding()), STUB_SEC_FINDINGS: findings(low) })
  assert.equal(record.findingDetails[1].severity, 'low')
  closed(record.id, { f1: { status: 'fixed' } })
  const summary = script(['--summary'])
  allowed(summary)
  assert.match(summary.stdout, /^Reviewer: sol \(gpt-stub-sol\)\nSecurity: opus \(claude-stub-opus\) — ran, 1 findings$/m)
  assert.match(summary.stdout, /^s1 LOW 6\/100 \(likelihood 2\/10 × impact 3\/10\) src\/app\.ts:6 — six is logged; Trigger: reading six$/m)
  const deferred = script(['--deferred'])
  allowed(deferred)
  assert.match(deferred.stdout, new RegExp(`^${record.id} .* s1 LOW 6/100 \\(likelihood 2/10 × impact 3/10\\) src/app\\.ts:6 — six is logged`, 'm'))
})

test('4/5 a required pass that was skipped or failed makes the closed tier HIGH, with the reason', () => {
  required()
  commit({ 'src/app.ts': APP })
  const skipped = reviewed({ STUB_SECURITY_ROLE: 'unset' }).record
  const tier = closed(skipped.id)
  assert.equal(tier.tier, 'high')
  assert.ok(tier.tierReasons.some((r) => /^security pass skipped: .*not set/.test(r)), JSON.stringify(tier.tierReasons))
  const failed = reviewed({ STUB_SECURITY_ROLE: 'opus', STUB_SEC_FAIL: 'claude' }).record
  const tier2 = closed(failed.id)
  assert.equal(tier2.tier, 'high')
  assert.ok(tier2.tierReasons.some((r) => /^security pass failed: /.test(r)), JSON.stringify(tier2.tierReasons))
  const ran = reviewed().record
  const tier3 = closed(ran.id)
  assert.equal(tier3.tier, 'medium', JSON.stringify(tier3.tierReasons))
})

test('8 security off or not required at review, then logic in the close diff with the pass on: HIGH at close', () => {
  // Off at review (no home config), required at close.
  commit({ 'src/app.ts': APP })
  const off = reviewed().record
  assert.equal(off.security.status, 'off')
  required()
  let tier = closed(off.id)
  assert.equal(tier.tier, 'high')
  assert.ok(tier.tierReasons.some((r) => /^security pass did not cover logic changed after review \(off at review/.test(r)), JSON.stringify(tier.tierReasons))
  // Not required at review (docs only); fix commits add logic.
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'docs-then-logic')
  commit({ 'docs/guide.md': '# Guide\n' })
  const docs = reviewed().record
  assert.equal(docs.security.status, 'not-required')
  commit({ 'src/late.ts': 'export const late = 1\n' })
  const r = close(docs.id, {})
  allowed(r)
  assert.equal(r.record.tier, 'high')
  assert.ok(r.record.tierReasons.some((x) => /^security pass did not cover logic changed after review \(not-required at review; logic or other files: src\/late\.ts\)/.test(x)), JSON.stringify(r.record.tierReasons))
  // With the pass off at close as well, a review without it adds no reason.
  rmSync(HOME_CONFIG)
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'all-off')
  commit({ 'src/app.ts': APP })
  tier = closed(reviewed().record.id)
  assert.equal(tier.tier, 'medium')
})

test('12 the code-review skill text (claude and codex twins) describes the security pass, not "not a security audit"', () => {
  const skills = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
  for (const harness of ['claude', 'codex']) {
    const text = ['SKILL.md', 'reference.md'].map((f) => join(skills, harness, 'code-review', f)).filter(existsSync).map((p) => readFileSync(p, 'utf8')).join('\n')
    assert.doesNotMatch(text, /security audit/i, harness)
    assert.match(text, /\*\*Security pass\.\*\* Config `security\.run`: `"off"` \(default\) \| `"required"` \| `"always"`/, harness)
    assert.match(text, /`security` role/, harness)
    assert.match(text, /REVIEW_SECURITY_REVIEWER/, harness)
    assert.doesNotMatch(text, /duplicateOf/, harness)
  }
})

// ── fix round: review 2026-11-05-18-00-49-52d8e8 and grade-1793901763426-a0780f ──
test('fix 1 an s finding next to a filed LOW f finding needs its own status; so does one next to an f HIGH', () => {
  required()
  commit({ 'src/app.ts': APP })
  const lowCode = finding({ likelihood: 1, impact: 2 })
  const nearHigh = finding({ issue: 'one is injectable', likelihood: 8, impact: 9, protected: true, trigger: 'a crafted import' })
  const { record } = reviewed({ STUB_FINDINGS: findings(lowCode), STUB_SEC_FINDINGS: findings(nearHigh) })
  assert.equal(record.findingDetails[0].severity, 'low')
  assert.equal(Object.hasOwn(record.findingDetails[1], 'duplicateOf'), false)
  const refused = close(record.id, {})
  assert.notEqual(refused.status, 0)
  assert.match(refused.out, /Finding s1 needs a fixed or rejected status/)
  const r2 = reviewed({ STUB_FINDINGS: findings(finding({ likelihood: 8, impact: 8 })), STUB_SEC_FINDINGS: findings(nearHigh) }).record
  const refused2 = close(r2.id, { f1: { status: 'fixed' } })
  assert.notEqual(refused2.status, 0)
  assert.match(refused2.out, /Finding s1 needs a fixed or rejected status/)
})

test('fix 2 REVIEW_CONFIG at the older ~/.claude/review-config.json cannot go below the primary home config', () => {
  required()
  const legacy = join(HOME, '.claude', 'review-config.json')
  mkdirSync(dirname(legacy), { recursive: true }); writeFileSync(legacy, JSON.stringify({ security: { run: 'off' } }))
  commit({ 'src/app.ts': APP })
  assert.equal(reviewed({ REVIEW_CONFIG: legacy }).record.security.status, 'ran')
  // With no primary home config, the older one is the floor, and REVIEW_CONFIG at it is honored.
  rmSync(HOME_CONFIG)
  assert.equal(reviewed({ REVIEW_CONFIG: legacy }).record.security.status, 'off')
})

test('fix 3 coverage exemptions from env or config never make the pass not-required, at review or at close', () => {
  required({ coverageExempt: ['web/**'] })
  commit({ 'src/app.ts': APP, 'web/page.ts': 'export const p = 1\n' })
  assert.equal(reviewed({ REVIEW_COVERAGE_EXEMPT: 'src/**' }).record.security.status, 'ran')
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'web-only')
  commit({ 'web/page.ts': 'export const p = 1\n' })
  assert.equal(reviewed().record.security.status, 'ran', 'a config coverageExempt does not exempt it either')
  // Off at review, required at close with the same exemption: the HIGH reason stands.
  rmSync(HOME_CONFIG)
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'exempt-close')
  commit({ 'src/app.ts': APP })
  const off = reviewed().record
  required()
  const tier = closed(off.id, {}, { REVIEW_COVERAGE_EXEMPT: 'src/**' })
  assert.ok(tier.tierReasons.some((r) => /^security pass did not cover logic changed after review/.test(r)), JSON.stringify(tier.tierReasons))
})

test('fix 4 logic changed after a pass that ran: HIGH "security pass did not see"; a fix check does not count; docs do not', () => {
  required()
  commit({ 'src/app.ts': APP })
  const { record } = reviewed({ STUB_FINDINGS: findings(finding()) })
  assert.equal(record.security.status, 'ran')
  assert.ok(Array.isArray(record.security.saw) && record.security.saw.some(([path, state]) => path === 'src/app.ts' && /^100644 [0-9a-f]{40}$/.test(state)), JSON.stringify(record.security.saw))
  commit({ 'src/app.ts': APP.replace('export const one = 1', 'export const one = 10'), 'docs/notes.md': '# notes\n' })
  allowed(script(['--fix-check', record.id]))
  const tier = closed(record.id, { f1: { status: 'fixed' } })
  assert.equal(tier.tier, 'high')
  assert.ok(tier.tierReasons.includes('security pass did not see src/app.ts (changed after review)'), JSON.stringify(tier.tierReasons))
  assert.ok(!tier.tierReasons.some((r) => r.includes('docs/notes.md')), JSON.stringify(tier.tierReasons))
  // Only docs after the review: no such reason.
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'docs-after')
  commit({ 'src/app.ts': APP })
  const clean = reviewed().record
  commit({ 'docs/notes.md': '# notes\n' })
  const tier2 = closed(clean.id)
  assert.ok(!tier2.tierReasons.some((r) => /security pass did not see/.test(r)), JSON.stringify(tier2.tierReasons))
})

test('fix 5 a Grade-only close with the pass on is HIGH with a reason that names the fix', () => {
  required()
  commit({ 'src/app.ts': APP })
  const path = join(ROOT, 'grade.json')
  writeFileSync(path, JSON.stringify({ family: 'opus', model: 'claude-stub-opus', vendor: 'claude', criteria: [{ id: '1', criterion: 'works', verdict: 'PASS', evidence: 'test passes' }] }))
  allowed(script(['--log-grade', path]))
  const grade = records().filter((e) => e.type === 'review' && e.kind === 'grade').at(-1)
  const tier = closed(grade.id)
  assert.equal(tier.tier, 'high')
  assert.ok(tier.tierReasons.includes('no security pass ran (Grade-only close; run /code-review for the security pass)'), JSON.stringify(tier.tierReasons))
})

test('fix 6 short timeout, the security result arriving later, the parent busy longer: failed, timed out', () => {
  homeConfig({ security: { run: 'required', timeoutMs: 1500 } })
  commit({ 'src/app.ts': APP })
  const r = reviewed({ STUB_SECURITY_ROLE: 'sol', STUB_SEC_SLEEP_MS: '4000', STUB_CODE_SLEEP_MS: '6000', STUB_FINDINGS: findings(finding()), STUB_SEC_FINDINGS: findings(SEC) })
  assert.equal(r.record.security.status, 'failed', JSON.stringify(r.record.security))
  assert.match(r.record.security.reason, /timed out after 1500 ms/)
  assert.deepEqual(r.record.findingDetails.map((f) => f.id), ['f1'])
  assert.equal(securityCalls().length, 0, 'the worker killed its model call at the deadline, before the stub finished')
})

test('fix 6 a result written after the deadline counts as timed out', () => {
  homeConfig({ security: { run: 'required', timeoutMs: 1500 } })
  commit({ 'src/app.ts': APP })
  const r = reviewed({ STUB_SECURITY_ROLE: 'opus', REVIEW_SECURITY_TEST_FAULT: 'late', STUB_CODE_SLEEP_MS: '4000' })
  assert.equal(r.record.security.status, 'failed', JSON.stringify(r.record.security))
  assert.match(r.record.security.reason, /timed out after 1500 ms/)
})

test('fix 7 a timeoutMs above what a timer holds is clamped, not fired at once', () => {
  homeConfig({ security: { run: 'required', timeoutMs: 99999999999 } })
  commit({ 'src/app.ts': APP })
  assert.equal(reviewed({ STUB_SEC_SLEEP_MS: '500' }).record.security.status, 'ran')
})

// ── attack-class checklists, the hardening rule and the harmed-principal rule ──
const CLASS_LISTS = {
  ai: 'Checklist: AI and agent tools.',
  supply: 'Checklist: supply chain.',
  ipc: 'Checklist: local IPC.',
}
const HARDENING = 'A missing extra layer of defense is a hardening note (LOW), not a vulnerability.'
const PRINCIPAL = 'Do not report a vulnerability without a concrete harmed principal: who is harmed, and how an attacker reaches them.'
// The security prompt for a branch of these files, with the pass on for every diff.
function securityPromptFor(files) {
  git('checkout', '-q', 'main'); git('checkout', '-qb', `b${Date.now()}${Math.random().toString(36).slice(2, 6)}`)
  rmSync(CALLS, { force: true })
  commit(files)
  const r = reviewed()
  assert.equal(r.record.security.status, 'ran', JSON.stringify(r.record.security))
  const [call] = securityCalls()
  assert.ok(call, 'a security call ran')
  return call.prompt
}
const listsIn = (prompt) => Object.entries(CLASS_LISTS).filter(([, heading]) => prompt.includes(heading)).map(([k]) => k)

test('13 each attack class: a diff touching it gets that class\'s checklist and no other; the two rules are always there', () => {
  homeConfig({ security: { run: 'always' } })
  const cases = [
    ['ai', { 'src/agents/run.js': 'export const run = 1\n' }],
    ['ai', { 'tools/ask-model.mjs': 'export const ask = 1\n' }],
    ['ai', { 'skills/review/SKILL.md': '# Skill\n' }],
    ['supply', { 'package.json': '{"name":"x"}\n' }],
    ['supply', { 'package-lock.json': '{"lockfileVersion":3}\n' }],
    ['supply', { 'scripts/install.sh': 'echo hi\n' }],
    ['supply', { '.github/workflows/ci.yml': 'on: push\n' }],
    ['ipc', { 'src/server.js': 'export const listen = 1\n' }],
    ['ipc', { 'lib/ipc/socket.js': 'export const s = 1\n' }],
  ]
  for (const [cls, files] of cases) {
    const prompt = securityPromptFor(files)
    assert.deepEqual(listsIn(prompt), [cls], `${Object.keys(files)}: ${listsIn(prompt)}`)
    assert.ok(prompt.includes(HARDENING), `${Object.keys(files)}: hardening rule`)
    assert.ok(prompt.includes(PRINCIPAL), `${Object.keys(files)}: harmed-principal rule`)
  }
  // The AI list names its three checks; supply chain and IPC theirs.
  const ai = securityPromptFor({ 'src/agents/run.js': 'export const run = 2\n' })
  for (const phrase of ['Prompt injection through tool output', 'tool permissions', 'commands a model chooses']) assert.ok(ai.includes(phrase), phrase)
  const supply = securityPromptFor({ 'package.json': '{"name":"y"}\n' })
  for (const phrase of ['Install scripts', 'lockfile or registry changes', 'fetched code']) assert.ok(supply.includes(phrase), phrase)
  const ipc = securityPromptFor({ 'src/server.js': 'export const listen = 2\n' })
  for (const phrase of ['localhost servers', 'Host and Origin checks', 'sockets', 'file-permission races']) assert.ok(ipc.includes(phrase), phrase)
})

test('13 a diff touching several classes gets each of their lists; a docs-only diff gets none, and still both rules', () => {
  homeConfig({ security: { run: 'always' } })
  const both = securityPromptFor({ 'src/agents/run.js': 'export const run = 1\n', 'src/server.js': 'export const listen = 1\n' })
  assert.deepEqual(listsIn(both), ['ai', 'ipc'])
  // A rename counts by either name.
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'moved-server')
  rmSync(CALLS, { force: true })
  git('mv', 'src/one.js', 'src/server.js'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'move')
  allowed(script([]))
  assert.deepEqual(listsIn(securityCalls()[0].prompt), ['ipc'])
  // Docs, even ones named like a class (prompts, servers, install), add no list.
  const docs = securityPromptFor({ 'README.md': 'more\n', 'docs/guide.md': '# Guide\n', 'docs/prompts.md': '# Prompts\n', 'docs/server-install.md': '# Server\n' })
  assert.deepEqual(listsIn(docs), [])
  assert.ok(docs.includes(HARDENING) && docs.includes(PRINCIPAL))
  assert.doesNotMatch(docs, /Checklist:/)
})
