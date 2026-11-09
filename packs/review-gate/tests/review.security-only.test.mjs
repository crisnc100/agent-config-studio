import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// The standalone security check (review.mjs --security-only, the /security-check skill): the security reviewer alone,
// logged to its own file. Every way its record could reach the gate is planted here and must be refused. Stub CLIs record
// every model call; temporary HOME and Git config; no real model.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'review.mjs')
const SKILLS = join(dirname(SCRIPT), '..', 'skills')
const ROOT = mkdtempSync(join(tmpdir(), 'review-security-only-test-'))
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

function securityOnly(extra = {}, args = []) {
  const r = script(['--security-only', ...args], extra)
  allowed(r)
  return { ...r, json: findingsJson(r), record: lines(SEC_LOG).at(-1) }
}
function reviewed(extra = {}) {
  const r = script([], { REVIEW_REVIEWER: 'sol', ...extra })
  allowed(r)
  return findingsJson(r).reviewId
}
function closed(id) {
  const path = join(ROOT, 'statuses.json')
  writeFileSync(path, '{}')
  allowed(script(['--close', id, '--status', path, '--test-cmd', 'true']))
  return lines(LOG).at(-1)
}

beforeEach(() => {
  for (const path of [HOME, REPO, CALLS]) rmSync(path, { recursive: true, force: true })
  mkdirSync(REPO)
  git('init', '-q', '-b', 'main')
  commit({ 'README.md': 'base\n' })
  git('checkout', '-qb', 'feat')
  commit({ 'src/app.js': APP })
})

test('1 --security-only calls only the security reviewer, whatever security.run says, and logs only to the security log', () => {
  mkdirSync(dirname(HOME_CONFIG), { recursive: true })
  writeFileSync(HOME_CONFIG, JSON.stringify({ security: { run: 'off' } }))
  const r = securityOnly({ STUB_SEC_FINDINGS: findings(finding()) })
  assert.deepEqual(calls().map((c) => c.kind), ['security'])
  assert.equal(calls()[0].cli, 'claude', 'the security role order: opus first')
  assert.deepEqual(r.json.findings.map((f) => [f.id, f.source, f.severity]), [['s1', 'security', 'high']])
  assert.equal(r.json.standalone, true)
  assert.match(r.json.securityCheckId, /^sec-/)
  assert.equal(r.record.type, 'security-check'); assert.equal(r.record.securityOnly, true); assert.equal(r.record.id, r.json.securityCheckId)
  assert.equal(r.record.resolvedPaths.s1.path, 'src/app.js')
  assert.equal(existsSync(LOG), false, 'nothing reaches the review log')
  assert.ok(existsSync(join(REPO, r.json.reportPath)), r.json.reportPath)
  assert.match(r.json.reportPath, /^reviews\/security\/sec-/)
  assert.match(r.out, /HIGH s1 src\/app\.js:2 — two leaks a token/, 'a HIGH is printed plainly')
  assert.match(r.out, /closes nothing and covers no push/)
})

test('2 reviews/latest, rotation counts and the review log are untouched by a security check', () => {
  const first = reviewed()
  const latest = readlinkSync(join(REPO, 'reviews/latest'))
  assert.equal(latest, first)
  const logBefore = text(LOG)
  const countsBefore = JSON.parse(script(['--show-config']).stdout).reviewCounts
  securityOnly({ STUB_SEC_FINDINGS: findings(finding()) })
  securityOnly()
  assert.equal(readlinkSync(join(REPO, 'reviews/latest')), latest)
  assert.equal(text(LOG), logBefore, 'the review log is byte-identical')
  assert.deepEqual(JSON.parse(script(['--show-config']).stdout).reviewCounts, countsBefore)
  assert.equal(lines(SEC_LOG).length, 2)
})

test('3 leak: a complete close planted for a security check refuses at the push gate, --summary and --tier-json', () => {
  // A real close at this HEAD is the template, so the planted close is complete in every field the gate reads.
  const template = closed(reviewed())
  const realReview = lines(LOG).find((e) => e.type === 'review')
  const check = securityOnly({ STUB_SEC_FINDINGS: findings(finding({ likelihood: 1, impact: 2 })) }).record
  const plant = (review) => {
    writeFileSync(LOG, '')
    appendFileSync(LOG, `${JSON.stringify(review)}\n${JSON.stringify({ ...template, review: review.id })}\n`)
  }
  // The control: the same plant with the real review passes, so the refusals below are the security marker's doing.
  plant(realReview)
  allowed(gate()); allowed(script(['--summary']))
  assert.equal(JSON.parse(script(['--tier-json']).stdout).covered, true)
  const forged = [
    ['as logged', check],
    ['typed as a review', { ...realReview, ...check, type: 'review', kind: 'review' }],
    ['typed as a review, security kind', { ...realReview, ...check, type: 'review' }],
  ]
  for (const [label, record] of forged) {
    plant(record)
    refused(gate(), /Push blocked/)
    refused(script(['--summary']), /No complete close covers HEAD/)
    const tier = script(['--tier-json'])
    assert.equal(tier.status, 3, `${label}: ${tier.out}`)
    assert.equal(JSON.parse(tier.stdout).covered, false, label)
  }
})

test('4 leak: --fix-check and --close refuse a security check id, from its own log or planted in the review log', () => {
  const check = securityOnly({ STUB_SEC_FINDINGS: findings(finding()) }).record
  commit({ 'src/app.js': APP.replace('two = 2', 'two = 22') })
  const path = join(ROOT, 'statuses.json')
  writeFileSync(path, '{"s1":{"status":"fixed"}}')
  for (const planted of [false, true]) {
    if (planted) appendFileSync(LOG, `${JSON.stringify({ ...check, type: 'review', kind: 'review' })}\n`)
    refused(script(['--fix-check', check.id], { REVIEW_REVIEWER: 'sol' }), /No logged review matches/)
    refused(script(['--close', check.id, '--status', path, '--test-cmd', 'true']), /No logged review matches/)
  }
  assert.equal(calls().filter((c) => c.kind === 'code').length, 0, 'no fix check model ran')
})

test('5 leak: a security check\'s filed and open findings never reach a later review as already decided', () => {
  securityOnly({ STUB_SEC_FINDINGS: findings(finding({ issue: 'FILED-SEC-7731', likelihood: 1, impact: 2 }), finding({ issue: 'OPEN-SEC-7732' })) })
  reviewed()
  const code = calls().filter((c) => c.kind === 'code')
  assert.equal(code.length, 1)
  assert.doesNotMatch(code[0].prompt, /Already decided/)
  assert.doesNotMatch(code[0].prompt, /FILED-SEC-7731|OPEN-SEC-7732/)
  // Planted in the review log as a review of this branch, it still feeds nothing forward.
  appendFileSync(LOG, `${JSON.stringify({ ...lines(SEC_LOG).at(-1), type: 'review', kind: 'review' })}\n`)
  reviewed()
  const again = calls().filter((c) => c.kind === 'code').at(-1)
  assert.doesNotMatch(again.prompt, /FILED-SEC-7731|OPEN-SEC-7732/)
})

test('6 --security-findings lists this branch\'s open standalone findings, not filed ones, and drops one whose code changed', () => {
  assert.match(script(['--security-findings']).stdout, /No open standalone security findings on feat/)
  securityOnly({ STUB_SEC_FINDINGS: findings(finding({ issue: 'OPEN-ONE' }), finding({ issue: 'FILED-ONE', likelihood: 1, impact: 2 }),
    finding({ issue: 'OPEN-THREE', line: '3', quote: 'export const three = 3' })) })
  securityOnly({ STUB_SEC_FINDINGS: findings(finding({ issue: 'OPEN-ONE' })) })
  const out = script(['--security-findings']).stdout
  assert.match(out, /not decided: check whether each still holds/)
  assert.equal(out.match(/OPEN-ONE/g)?.length, 1, 'one line per finding across checks')
  assert.match(out, /HIGH 42\/100 \(likelihood 6\/10 × impact 7\/10\) src\/app\.js:2 — OPEN-ONE/)
  assert.match(out, /OPEN-THREE/)
  assert.doesNotMatch(out, /FILED-ONE/)
  commit({ 'src/app.js': APP.replace('three = 3', 'three = 4') })
  assert.doesNotMatch(script(['--security-findings']).stdout, /OPEN-THREE/)
  git('checkout', '-qb', 'other')
  assert.match(script(['--security-findings']).stdout, /No open standalone security findings on other/)
})

test('7 --security-only runs alone, refuses eval mode, and stops by name when no security reviewer can run', () => {
  refused(script(['--security-only', '--close', 'x']), /--security-only runs alone: it cannot be combined with --close/)
  refused(script(['--security-only', '--fix-check', 'x']), /cannot be combined with --fix-check/)
  refused(script(['--security-only'], { STUB_ROLES: 'reviewer' }), /security check: security role:[\s\S]*ACS → Models → Roles/)
  for (const flag of ['--security-only', '--security-findings'])
    refused(script([flag], { REVIEW_EVAL: '1', REVIEW_EVAL_LOG_DIR: join(ROOT, 'eval-log') }), new RegExp(`${flag} refuses to run in eval mode`))
  assert.equal(calls().length, 0)
  const plan = join(ROOT, 'plan.md')
  writeFileSync(plan, '# Plan\nPLAN-SEC-55\n')
  securityOnly({}, ['--plan', plan, 'what it delivers'])
  assert.match(calls()[0].prompt, /PLAN-SEC-55/)
  assert.match(calls()[0].prompt, /what it delivers/)
})

// ── portability: each skill's commands in a scratch repo, no review-gate config, no other skill installed ──
const fenced = (body, opener) => {
  const start = body.indexOf(opener)
  assert.notEqual(start, -1, opener)
  const from = body.indexOf('\n', body.lastIndexOf('```bash', start)) + 1
  return body.slice(from, body.indexOf('```', from))
}
function scratch() {
  const home = join(ROOT, 'scratch-home'), repo = join(ROOT, 'scratch-repo')
  for (const p of [home, repo]) rmSync(p, { recursive: true, force: true })
  mkdirSync(join(home, '.agent-config-studio/review-gate'), { recursive: true }); mkdirSync(repo)
  cpSync(SCRIPT, join(home, '.agent-config-studio/review-gate/review.mjs'))
  const sh = (cmd, extra = {}) => run('bash', ['-c', cmd], { HOME: home, GIT_CONFIG_GLOBAL: join(home, 'isolated.gitconfig'), ...extra }, undefined, repo)
  for (const c of ['git init -q -b main', 'git -c user.name=t -c user.email=t@t commit -q --allow-empty -m base', 'git checkout -qb feat',
    'mkdir src && printf "export const one = 1\\n" > src/a.js && git add src && git -c user.name=t -c user.email=t@t commit -qm a']) allowed(sh(c))
  return { home, repo, sh }
}
for (const [skill, opener, roles, kind] of [['code-review', '=scripts/review.mjs', 'reviewer', 'code'], ['security-check', '=scripts/review.mjs', 'security', 'security']]) {
  test(`8 portability: /${skill}'s command runs in a scratch repo with no review-gate config, only its own role, and no other skill`, () => {
    for (const harness of ['claude', 'codex']) {
      rmSync(CALLS, { force: true })
      const { home, sh } = scratch()
      const block = fenced(readFileSync(join(SKILLS, harness, skill, 'SKILL.md'), 'utf8'), opener).replace(/"<intent:[^"]*>"/g, '"add a"')
      const r = sh(block, { STUB_ROLES: roles })
      allowed(r)
      assert.match(r.stdout, /===FINDINGS_JSON===/, `${harness}: ${r.out}`)
      assert.deepEqual(calls().map((c) => c.kind), [kind], harness)
      assert.equal(existsSync(join(home, '.agent-config-studio/review-gate/config.json')), false)
      assert.equal(existsSync(join(home, '.claude/skills')) || existsSync(join(home, '.codex/skills')), false, 'no skill is installed')
      if (skill !== 'code-review') continue
      // /code-review never starts the security pass on its own, even with the setting at its highest.
      rmSync(CALLS, { force: true })
      writeFileSync(join(home, '.agent-config-studio/review-gate/config.json'), JSON.stringify({ security: { run: 'always' } }))
      const always = sh(block)
      allowed(always)
      assert.deepEqual(calls().map((c) => c.kind), ['code'], `${harness}: ${always.out}`)
    }
  })
}

test('11 /pr-review\'s review command hands open standalone findings to both reviewers as context, in one record', () => {
  mkdirSync(dirname(HOME_CONFIG), { recursive: true })
  writeFileSync(HOME_CONFIG, JSON.stringify({ security: { run: 'required' } }))
  securityOnly({ STUB_SEC_FINDINGS: findings(finding({ issue: 'OPEN-CTX-9' })) })
  rmSync(CALLS, { force: true })
  for (const harness of ['claude', 'codex']) {
    const body = readFileSync(join(SKILLS, harness, 'pr-review', 'SKILL.md'), 'utf8')
    const block = fenced(body, 'OPEN=$(node').replace('--plan <plan.md> ', '').replace(/"<intent:[^"]*>"/, '"add app"')
    const r = run('bash', ['-c', `SCRIPT=${JSON.stringify(SCRIPT)}\n${block}`], { REVIEW_REVIEWER: 'sol' })
    allowed(r)
    const json = findingsJson(r)
    assert.equal(json.security.status, 'ran', harness)
    const latest = calls().slice(-2)
    assert.deepEqual(latest.map((c) => c.kind).sort(), ['code', 'security'], harness)
    for (const c of latest) assert.match(c.prompt, /OPEN-CTX-9/, `${harness}: ${c.kind} prompt carries the open finding`)
    for (const c of latest) assert.doesNotMatch(c.prompt, /Already decided/, harness)
  }
})

test('9 --code-only (the /code-review skill) never starts the security pass; with security.run on, the merge tier says so', () => {
  mkdirSync(dirname(HOME_CONFIG), { recursive: true })
  writeFileSync(HOME_CONFIG, JSON.stringify({ security: { run: 'required' } }))
  assert.equal(JSON.parse(script(['--show-config'], { REVIEW_REVIEWER: 'sol' }).stdout).security, 'required', '/pr-review reads the setting here')
  const id = (() => { const r = script(['--code-only'], { REVIEW_REVIEWER: 'sol' }); allowed(r); return findingsJson(r).reviewId })()
  assert.deepEqual(calls().map((c) => c.kind), ['code'])
  const review = lines(LOG).find((e) => e.id === id)
  assert.equal(review.security.status, 'not-asked')
  assert.equal(review.security.run, 'required')
  const tier = closed(id)
  assert.equal(tier.tier, 'high')
  assert.ok(tier.tierReasons.some((r) => /security pass did not cover logic changed after review \(not-asked at review/.test(r)), JSON.stringify(tier.tierReasons))
  // The same run without --code-only (the /pr-review flow) runs the pass in the same record.
  rmSync(CALLS, { force: true })
  const both = script([], { REVIEW_REVIEWER: 'sol' })
  allowed(both)
  assert.deepEqual(calls().map((c) => c.kind).sort(), ['code', 'security'])
  assert.equal(findingsJson(both).security.status, 'ran')
})

test('10 --code-only with security.run off records the pass as off, and the tier names no security reason', () => {
  const r = script(['--code-only'], { REVIEW_REVIEWER: 'sol' })
  allowed(r)
  assert.equal(findingsJson(r).security.status, 'off')
  const tier = closed(findingsJson(r).reviewId)
  assert.ok(!tier.tierReasons.some((x) => /security/.test(x)), JSON.stringify(tier.tierReasons))
})

// ── fix round: review 2026-11-09-19-05-06-55cb9f ──
test('fix s1 a link at any level of the report path refuses the check, and nothing is written outside the checkout', () => {
  const outside = join(ROOT, 'outside')
  for (const [label, plant] of [
    ['reviews/security is a link', () => { mkdirSync(join(REPO, 'reviews'), { recursive: true }); run('ln', ['-s', outside, join(REPO, 'reviews/security')]) }],
    ['reviews is a link', () => run('ln', ['-s', outside, join(REPO, 'reviews')])],
  ]) {
    rmSync(outside, { recursive: true, force: true }); mkdirSync(outside)
    rmSync(join(REPO, 'reviews'), { recursive: true, force: true })
    plant()
    git('add', '-f', 'reviews'); git('commit', '-qm', `plant ${label}`)
    rmSync(CALLS, { force: true })
    const r = script(['--security-only'], { STUB_SEC_FINDINGS: findings(finding()) })
    refused(r, /is a symlink/)
    assert.deepEqual(readdirSync(outside), [], `${label}: nothing written outside`)
    assert.equal(calls().length, 0, `${label}: refused before any model call`)
    assert.equal(lines(SEC_LOG).length, 0, label)
    git('rm', '-rq', '--cached', 'reviews'); rmSync(join(REPO, 'reviews'), { recursive: true, force: true }); git('commit', '-qm', `unplant ${label}`)
  }
  mkdirSync(join(REPO, 'reviews'), { recursive: true }); writeFileSync(join(REPO, 'reviews/security'), 'a file\n')
  git('add', '-f', 'reviews'); git('commit', '-qm', 'plant a file')
  refused(script(['--security-only']), /reviews\/security is not a folder/)
})

test('fix m1 --security-findings finds a quote that moved far, follows a rename, and lists a deleted file as can\'t tell', () => {
  securityOnly({ STUB_SEC_FINDINGS: findings(finding({ issue: 'MOVED-ONE' })) })
  commit({ 'src/app.js': `${'// pad\n'.repeat(20)}${APP}` })
  assert.match(script(['--security-findings']).stdout, /src\/app\.js:\d+ — MOVED-ONE/, 'moved 20 lines down: still open')
  git('mv', 'src/app.js', 'src/main.js'); git('commit', '-qm', 'rename')
  const renamed = script(['--security-findings']).stdout
  assert.match(renamed, /src\/main\.js \(was src\/app\.js:2\) — MOVED-ONE/, renamed)
  git('rm', '-q', 'src/main.js'); git('commit', '-qm', 'delete')
  const gone = script(['--security-findings']).stdout
  assert.match(gone, /Can't tell[^\n]*\n[\s\S]*MOVED-ONE/, gone)
  assert.doesNotMatch(gone, /No open standalone security findings/)
})

test('fix m2 an unknown flag is a plain error with no review; --supports answers for each flag', () => {
  for (const flag of ['--bogus', '--security-onyl', '--']) {
    const r = script([flag], { REVIEW_REVIEWER: 'sol' })
    assert.equal(r.status, 1, r.out)
    assert.match(r.stderr, new RegExp(`unknown flag ${flag}`))
  }
  assert.equal(calls().length, 0); assert.equal(existsSync(LOG), false)
  for (const flag of ['--security-only', '--security-findings', '--code-only', '--close']) assert.equal(script(['--supports', flag]).status, 0, flag)
  assert.equal(script(['--supports', '--nope']).status, 1)
})

for (const [skill, flag] of [['security-check', '--security-only'], ['code-review', '--code-only']]) {
  test(`fix m2 /${skill}: an older repo copy without ${flag} is skipped for the shared runtime, and says so`, () => {
    for (const harness of ['claude', 'codex']) {
      rmSync(CALLS, { force: true })
      const { repo, sh } = scratch()
      const block = fenced(readFileSync(join(SKILLS, harness, skill, 'SKILL.md'), 'utf8'), '=scripts/review.mjs').replace(/"<intent:[^"]*>"/g, '"add a"')
      mkdirSync(join(repo, 'scripts'))
      writeFileSync(join(repo, 'scripts/review.mjs'), "console.log('OLD COPY RAN ' + process.argv.slice(2).join(' '))\n")
      const old = sh(block)
      allowed(old)
      assert.doesNotMatch(old.out, /OLD COPY RAN/, `${harness}: ${old.out}`)
      assert.match(old.out, new RegExp(`scripts/review\\.mjs does not support ${flag}; using the shared runtime`), harness)
      assert.match(old.stdout, /===FINDINGS_JSON===/)
      // A current copy in the repo is the one that runs.
      cpSync(SCRIPT, join(repo, 'scripts/review.mjs'))
      const now = sh(block)
      allowed(now)
      assert.match(now.out, /review\.mjs · scripts\/review\.mjs/, `${harness}: ${now.out.slice(0, 400)}`)
    }
  })
}
