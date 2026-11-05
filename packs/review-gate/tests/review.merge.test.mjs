import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// merge.mjs: reads the tip's tier (review.mjs --tier-json) and the merge policy, then merges the PR, labels it
// needs-human and comments once, or does nothing. gh is a PATH stub that logs every argv and answers only the calls
// a test's table names; anything else exits 2. Most tests stand a fake scripts/review.mjs in the repo (merge.mjs
// prefers it) that prints a chosen --tier-json; the B9 and B10 tests run the real review.mjs end to end.
// gh fixture shapes come from real read-only calls on 2026-11-05 (gh 2.83.2): `gh pr view 40 --json number,state,
// isDraft,headRefOid,baseRefName,mergeStateStatus,reviewDecision,labels,url` and `gh pr checks 40 --json
// name,state,bucket` on crisnc100/agent-config-studio; that `pr checks --json` exited 0 with a pending check. The
// label objects follow gh's documented { id, name, description, color }.
const RUNTIME = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime')
const MERGE = join(RUNTIME, 'merge.mjs'), REVIEW = join(RUNTIME, 'review.mjs')
const ROOT = mkdtempSync(join(tmpdir(), 'review-merge-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), BIN = join(ROOT, 'bin')
const GH_LOG = join(ROOT, 'gh-calls.jsonl'), GH_TABLE = join(ROOT, 'gh-table.json')
const FAKE_LOG = join(ROOT, 'fake-log', 'review-log.jsonl'), MERGE_LOG = join(ROOT, 'fake-log', 'merge-log.jsonl')
const REAL_LOG = join(HOME, '.agent-config-studio/review-log/review-log.jsonl')
const HOME_CONFIG = join(HOME, '.agent-config-studio/review-gate/config.json')
mkdirSync(BIN)
after(() => rmSync(ROOT, { recursive: true, force: true }))
const stub = (name, body) => { writeFileSync(join(BIN, name), `#!${process.execPath}\n${body}`); chmodSync(join(BIN, name), 0o755) }
// The gh stub: table keys are "<a0> <a1>" ("pr view", "pr checks", "pr merge", "label list", ...), each
// { stdout, stderr, code }. A key missing from the table is an unexpected call: logged, refused with exit 2.
// gh api graphql calls are keyed by their query: "graphql queue" (the base's merge queue), "graphql pr" (the PR read
// after a merge) and "graphql dequeue" (the dequeuePullRequest mutation).
stub('gh', `
const fs = require('node:fs')
const a = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(GH_LOG)}, JSON.stringify(a) + '\\n')
const table = fs.existsSync(${JSON.stringify(GH_TABLE)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(GH_TABLE)}, 'utf8')) : {}
const keyOf = (x) => {
  if (x[0] !== 'api' || x[1] !== 'graphql') return x.slice(0, 2).join(' ')
  const q = x.find((v) => v.startsWith('query=')) || ''
  return q.includes('dequeuePullRequest') ? 'graphql dequeue' : q.includes('mergeQueue') ? 'graphql queue' : q.includes('pullRequest') ? 'graphql pr' : 'graphql ?'
}
const key = keyOf(a)
let answer = table[key]
// A list answers call by call (the last one repeats): the nth call with this key gets the nth answer.
if (Array.isArray(answer)) {
  const seen = fs.readFileSync(${JSON.stringify(GH_LOG)}, 'utf8').trim().split('\\n').filter((l) => keyOf(JSON.parse(l)) === key).length
  answer = answer[Math.min(seen, answer.length) - 1]
}
if (!answer) { process.stderr.write('gh stub: unexpected call ' + a.join(' ') + '\\n'); process.exit(2) }
if (answer.stdout) process.stdout.write(answer.stdout)
if (answer.stderr) process.stderr.write(answer.stderr)
process.exit(answer.code ?? 0)
`)
// Model CLIs for the real review.mjs runs: no findings, ever.
stub('model-id', `const a=process.argv.slice(2), ids={sol:'gpt-stub-sol',opus:'claude-stub-opus',grok:'grok-stub'}; console.log(a[0]==='--role' ? JSON.stringify({use:['sol','opus','grok'],ids:['gpt-stub-sol','claude-stub-opus','grok-stub']}) : a[0]==='--flavor' ? JSON.stringify({flavor:{effort:'high'}}) : ids[a[0]] || 'stub-'+a[0])`)
const modelBody = `
const fs = require('node:fs')
const a = process.argv.slice(2)
if (a[0] === 'mcp') { console.log('[]'); process.exit(0) }
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8') : a[a.indexOf('--json-schema')+1]
const reply = schema.includes('"scores"') ? '{"scores":[]}' : schema.includes('"verdicts"') ? '{"verdicts":[]}' : '{"findings":[]}'
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1], reply)
else console.log(JSON.stringify({structured_output:JSON.parse(reply),structuredOutput:JSON.parse(reply),modelUsage:{'stub-grok':{}}}))
`
for (const name of ['codex', 'claude', 'grok']) stub(name, modelBody)

// The fake review script: prints FAKE_TIER over a covered LOW at HEAD; { "covered": false } prints the uncovered shape.
const FAKE_REVIEW = `import { execFileSync } from 'node:child_process'
if (!process.argv.includes('--tier-json')) { console.error('fake review: --tier-json only'); process.exit(9) }
const tip = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const over = JSON.parse(process.env.FAKE_TIER || '{}')
if (process.env.FAKE_TIER_RAW) { console.log(process.env.FAKE_TIER_RAW); process.exit(Number(process.env.FAKE_TIER_CODE || 0)) }
if (over.covered === false) { console.log(JSON.stringify({ tip, covered: false, reason: 'No complete close covers HEAD', logPath: process.env.FAKE_LOG })); process.exit(3) }
console.log(JSON.stringify({ tip, covered: true, base: 'a'.repeat(40), baseRef: 'origin/main', tier: 'low', reasons: ['no logic or other files changed'],
  policy: 'standard', merges: true, docsTestsOnly: true, deferred: [], logPath: process.env.FAKE_LOG,
  merge: { onHuman: 'comment', humanComment: 'Needs human approval before merging.', requireChecks: true, allowBehind: false }, ...over }))
`

const env = (extra = {}) => ({ HOME, CODEX_HOME: join(HOME, '.codex'), GROK_HOME: join(HOME, '.grok'), GIT_CONFIG_GLOBAL: join(HOME, 'isolated.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1', PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: ROOT, REVIEW_BASE: 'main', REVIEW_REVIEWER: 'sol',
  FAKE_LOG, MERGE_UNKNOWN_DELAY_MS: '0', ...extra })
function run(command, args, extra = {}) {
  const r = spawnSync(command, args, { cwd: REPO, env: env(extra), encoding: 'utf8', timeout: 60000 })
  return { ...r, out: `${r.stdout || ''}\n${r.stderr || ''}` }
}
const merge = (args = [], extra = {}) => run(process.execPath, [MERGE, ...args], extra)
const fake = (tier = {}, args = [], extra = {}) => merge(args, { FAKE_TIER: JSON.stringify(tier), ...extra })
function git(...args) {
  const r = run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  assert.equal(r.status, 0, r.out)
  return r.stdout.trim()
}
function commit(files) {
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(REPO, path)), { recursive: true }); writeFileSync(join(REPO, path), text) }
  git('add', ...Object.keys(files)); git('commit', '-qm', `change ${Object.keys(files).join(' ')}`)
  return git('rev-parse', 'HEAD')
}
const jsonl = (path) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const calls = () => jsonl(GH_LOG)
const WRITES = ['pr merge', 'pr edit', 'pr comment', 'label create']
const writes = () => calls().filter((a) => WRITES.includes(a.slice(0, 2).join(' ')) || a.some((v) => /^query=\s*mutation/.test(v)))
const graphql = (data) => out({ data })
// The stub's key for one logged call (the same rule as inside the stub).
const keyOf = (x) => {
  if (x[0] !== 'api' || x[1] !== 'graphql') return x.slice(0, 2).join(' ')
  const q = x.find((v) => v.startsWith('query=')) || ''
  return q.includes('dequeuePullRequest') ? 'graphql dequeue' : q.includes('mergeQueue') ? 'graphql queue' : q.includes('pullRequest') ? 'graphql pr' : 'graphql ?'
}
const prAfter = (over = {}) => graphql({ repository: { pullRequest: { id: 'PR_node41', state: 'MERGED', isInMergeQueue: false, autoMergeRequest: null, ...over } } })
const varOf = (a, name) => { const i = a.findIndex((v, j) => ['-f', '-F'].includes(a[j - 1]) && v.startsWith(`${name}=`)); return i < 0 ? undefined : a[i].slice(name.length + 1) }
const head = () => git('rev-parse', 'HEAD')

// gh answers in the captured shapes.
const prView = (over = {}) => ({ baseRefName: 'main', headRefOid: head(), isDraft: false, labels: [], mergeStateStatus: 'CLEAN', number: 41,
  reviewDecision: '', state: 'OPEN', url: 'https://github.com/o/r/pull/41', ...over })
const check = (name, bucket, state = { pass: 'SUCCESS', fail: 'FAILURE', pending: 'IN_PROGRESS', skipping: 'SKIPPED', cancel: 'CANCELLED' }[bucket]) => ({ bucket, name, state })
const label = (name) => ({ id: `LA_${name}`, name, description: '', color: 'd93f0b' })
const out = (value, code = 0) => ({ stdout: JSON.stringify(value) + '\n', code })
function gh({ view = prView(), checks = [check('syntax', 'pass'), check('docs', 'skipping')], repoLabels = [], merged = { stdout: '' }, extra = {} } = {}) {
  const table = { 'pr view': out(view), 'graphql queue': graphql({ repository: { mergeQueue: null } }), 'graphql pr': prAfter(), 'pr checks': out(checks), 'pr merge': merged, 'label list': out(repoLabels),
    'label create': { stdout: '' }, 'pr edit': { stdout: 'https://github.com/o/r/pull/41\n' }, 'pr comment': { stdout: 'https://github.com/o/r/pull/41#issuecomment-1\n' }, ...extra }
  writeFileSync(GH_TABLE, JSON.stringify(table))
}
const NEVER = ['--auto', '--admin', '--squash', '--rebase']
const neverFlags = () => { for (const a of calls()) for (const flag of NEVER) assert.ok(!a.includes(flag), `${flag} in ${a.join(' ')}`) }
const lastOutcome = (path = MERGE_LOG) => jsonl(path).filter((e) => e.phase === 'outcome').at(-1)

beforeEach(() => {
  for (const path of [HOME, REPO, GH_LOG, GH_TABLE, dirname(FAKE_LOG)]) rmSync(path, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true }); mkdirSync(REPO); mkdirSync(dirname(FAKE_LOG))
  git('init', '-q', '-b', 'main')
  git('remote', 'add', 'origin', 'https://example.invalid/o/r.git')
  commit({ 'README.md': 'base\n' })
  // Untracked, so the tree stays clean and removing it changes no diff.
  mkdirSync(join(REPO, 'scripts')); writeFileSync(join(REPO, 'scripts/review.mjs'), FAKE_REVIEW)
  git('checkout', '-qb', 'feat')
  commit({ 'docs/guide.md': '# Guide\n' })
})

test('B1 policy off: no gh call at all, none, exit 0, logged', () => {
  gh()
  const r = fake({ policy: 'off', merges: false })
  assert.equal(r.status, 0, r.out)
  assert.match(r.stdout, /^none: /)
  assert.equal(r.stdout.trim().split('\n').length, 1, 'one stdout line')
  assert.deepEqual(calls(), [])
  assert.equal(lastOutcome().action, 'none')
})

test('B1 with the real review.mjs and no config the policy is off: no gh call', () => {
  rmSync(join(REPO, 'scripts'), { recursive: true })
  assert.equal(run(process.execPath, [REVIEW], {}).status, 0)
  const id = jsonl(REAL_LOG).filter((e) => e.type === 'review').at(-1).id
  writeFileSync(join(ROOT, 'statuses.json'), '{}')
  assert.equal(run(process.execPath, [REVIEW, '--close', id, '--status', join(ROOT, 'statuses.json'), '--test-cmd', 'true']).status, 0)
  writeFileSync(GH_TABLE, '{}')
  const r = merge()
  assert.equal(r.status, 0, r.out)
  assert.match(r.stdout, /^none: /)
  assert.deepEqual(calls(), [])
})

test('B2 standard, LOW, checks pass or skipping, CLEAN: checks are read before exactly one merge at HEAD', () => {
  gh()
  const r = fake()
  assert.equal(r.status, 0, r.out)
  assert.match(r.stdout, /^merged: /)
  const seen = calls().map((a) => a.slice(0, 2).join(' '))
  assert.deepEqual(seen, ['pr view', 'pr checks', 'api graphql', 'pr merge', 'api graphql'])
  assert.deepEqual(calls()[1], ['pr', 'checks', '41', '--json', 'name,state,bucket'])
  assert.deepEqual([keyOf(calls()[2]), varOf(calls()[2], 'owner'), varOf(calls()[2], 'name'), varOf(calls()[2], 'branch')], ['graphql queue', 'o', 'r', 'main'])
  assert.deepEqual(calls()[3], ['pr', 'merge', '41', '--merge', '--match-head-commit', head()])
  assert.deepEqual([keyOf(calls()[4]), varOf(calls()[4], 'number')], ['graphql pr', '41'])
  assert.equal(calls()[0][0], 'pr'); assert.ok(calls()[0].includes('--json'))
  neverFlags()
  assert.equal(lastOutcome().action, 'merged')
})

test('B2 --pr is passed to gh pr view', () => {
  gh()
  allowedMerge(fake({}, ['--pr', '41']))
  assert.deepEqual(calls()[0].slice(0, 3), ['pr', 'view', '41'])
})
function allowedMerge(r) { assert.equal(r.status, 0, r.out); assert.match(r.stdout, /^merged: /) }

test('B3 MEDIUM: label created when missing, added, one comment with the tier line and reasons; exit 10', () => {
  gh()
  const r = fake({ tier: 'medium', reasons: ['logic changed: 2 line(s) in 1 file(s)'], merges: false })
  assert.equal(r.status, 10, r.out)
  assert.match(r.stdout, /^labeled: /)
  const seen = calls().map((a) => a.slice(0, 2).join(' '))
  assert.ok(!seen.includes('pr merge') && !seen.includes('pr checks'), seen.join(', '))
  assert.equal(calls().filter((a) => a[0] === 'label' && a[1] === 'create').length, 1)
  assert.deepEqual(calls().find((a) => a[1] === 'edit'), ['pr', 'edit', '41', '--add-label', 'needs-human'])
  const comments = calls().filter((a) => a[1] === 'comment')
  assert.equal(comments.length, 1)
  const body = comments[0][comments[0].indexOf('--body') + 1]
  assert.match(body, /^Needs human approval before merging\./)
  assert.match(body, /Merge tier: MEDIUM \(logic changed: 2 line\(s\) in 1 file\(s\)\)\. Policy standard: needs a human/)
  assert.equal(lastOutcome().action, 'labeled')
})

test('B3 a second run with the label present posts no new comment and writes nothing', () => {
  gh({ view: prView({ labels: [label('needs-human')] }), repoLabels: [label('needs-human')] })
  const r = fake({ tier: 'medium', reasons: ['logic changed'], merges: false })
  assert.equal(r.status, 10, r.out)
  assert.match(r.stdout, /^labeled: /)
  assert.deepEqual(writes(), [])
})

test('B3 a label the repo already has is not created again', () => {
  gh({ repoLabels: [label('needs-human')] })
  assert.equal(fake({ tier: 'medium', merges: false }).status, 10)
  assert.equal(calls().filter((a) => a[0] === 'label' && a[1] === 'create').length, 0)
  assert.equal(calls().filter((a) => a[1] === 'comment').length, 1)
})

const bodyOf = () => { const c = calls().find((a) => a[1] === 'comment'); return c && c[c.indexOf('--body') + 1] }
test('B4 LOW with a failing, pending or cancelled check, zero checks, BEHIND, or a needs-human label: needs a human, with the reason', () => {
  const cases = [
    [{ checks: [check('syntax', 'pass'), check('unit', 'fail')] }, /checks not green: unit \(fail\)/],
    [{ checks: [check('unit', 'pending')] }, /checks not green: unit \(pending\)/],
    [{ checks: [check('unit', 'cancel')] }, /checks not green: unit \(cancel\)/],
    [{ checks: [] }, /no CI checks/],
    [{ view: null, behind: true }, /base moved/],
    [{ view: null, labeled: true }, /needs-human label/],
  ]
  for (const [setup, reason] of cases) {
    rmSync(GH_LOG, { force: true })
    const view = setup.behind ? prView({ mergeStateStatus: 'BEHIND' }) : setup.labeled ? prView({ labels: [label('needs-human')] }) : prView()
    gh({ view, ...(setup.checks && { checks: setup.checks }) })
    const r = fake()
    assert.equal(r.status, 10, `${reason}: ${r.out}`)
    assert.match(r.stdout, /^labeled: /)
    assert.match(r.stdout, reason)
    assert.ok(!calls().some((a) => a[1] === 'merge'), `${reason}: merged`)
    if (!setup.labeled) assert.match(bodyOf(), reason)
    else assert.deepEqual(writes(), [], 'the label was there: no new comment')
    assert.match(lastOutcome().reason, reason)
  }
})

test('B4 a check with an unknown bucket is not green', () => {
  gh({ checks: [check('odd', 'neutral', 'NEUTRAL')] })
  const r = fake()
  assert.equal(r.status, 10, r.out)
  assert.match(r.stdout, /checks not green: odd \(neutral\)/)
})

test('B4 allowBehind (home-only) lets a BEHIND PR merge', () => {
  gh({ view: prView({ mergeStateStatus: 'BEHIND' }) })
  allowedMerge(fake({ merge: { onHuman: 'comment', humanComment: 'x', requireChecks: true, allowBehind: true } }))
})

test('B5 requireChecks false never lets a failing or pending check through; it only allows zero checks', () => {
  const loose = { merge: { onHuman: 'comment', humanComment: 'Needs human approval before merging.', requireChecks: false, allowBehind: false } }
  for (const bucket of ['fail', 'pending', 'cancel']) {
    rmSync(GH_LOG, { force: true })
    gh({ checks: [check('unit', bucket)] })
    const r = fake(loose)
    assert.equal(r.status, 10, `${bucket}: ${r.out}`)
    assert.ok(!calls().some((a) => a[1] === 'merge'), bucket)
  }
  rmSync(GH_LOG, { force: true })
  gh({ checks: [] })
  allowedMerge(fake(loose))
})

test('B5 zero checks reported as gh\'s "no checks reported" error count as zero checks', () => {
  gh({ extra: { 'pr checks': { stderr: "no checks reported on the 'feat' branch\n", code: 1 } } })
  const r = fake()
  assert.equal(r.status, 10, r.out)
  assert.match(r.stdout, /no CI checks/)
})

test('B6 refused, with no gh write, exit 2 and a log record, for every unsafe state', () => {
  const other = 'b'.repeat(40)
  const cases = [
    ['head differs', () => gh({ view: prView({ headRefOid: other }) }), {}, /head/i],
    ['draft', () => gh({ view: prView({ isDraft: true }) }), {}, /draft/i],
    ['closed', () => gh({ view: prView({ state: 'CLOSED' }) }), {}, /CLOSED/],
    ['merged', () => gh({ view: prView({ state: 'MERGED' }) }), {}, /MERGED/],
    ['uncovered', () => gh(), { covered: false }, /No complete close covers HEAD/],
    ['tier tip differs', () => gh(), { tip: other }, /tip/i],
    ['base mismatch', () => gh({ view: prView({ baseRefName: 'staging' }) }), {}, /base/i],
    ['DIRTY', () => gh({ view: prView({ mergeStateStatus: 'DIRTY' }) }), {}, /DIRTY/],
    ['UNKNOWN', () => gh({ view: prView({ mergeStateStatus: 'UNKNOWN' }) }), {}, /UNKNOWN/],
    ['changes requested', () => gh({ view: prView({ reviewDecision: 'CHANGES_REQUESTED' }) }), {}, /CHANGES_REQUESTED/],
    ['gh view fails', () => gh({ extra: { 'pr view': { stderr: 'HTTP 401: Bad credentials\n', code: 1 } } }), {}, /401/],
    ['gh view garbage', () => gh({ extra: { 'pr view': { stdout: 'not json\n' } } }), {}, /gh pr view/],
    ['gh checks fails', () => gh({ extra: { 'pr checks': { stderr: 'HTTP 502\n', code: 1 } } }), {}, /502/],
    ['merge fails', () => gh({ merged: { stderr: 'Pull request is not mergeable: the base branch policy prohibits the merge\n', code: 1 } }), {}, /base branch policy/],
  ]
  for (const [name, setup, tier, reason] of cases) {
    rmSync(GH_LOG, { force: true })
    setup()
    const r = fake(tier)
    assert.equal(r.status, 2, `${name}: ${r.out}`)
    assert.match(r.stdout, /^refused: /, name)
    assert.match(r.stdout, reason, name)
    const written = writes().filter((a) => !(name === 'merge fails' && a[1] === 'merge'))
    assert.deepEqual(written, [], `${name}: ${JSON.stringify(written)}`)
    if (name === 'merge fails') assert.equal(writes().length, 1, 'one merge attempt, then no label or comment')
    if (name === 'uncovered' || name === 'tier tip differs') assert.deepEqual(calls(), [], `${name}: refused before gh`)
    const outcome = lastOutcome()
    assert.equal(outcome.action, 'refused', name)
    assert.match(outcome.reason, reason, name)
  }
})

test('B6 a dirty working tree is refused before gh', () => {
  gh()
  writeFileSync(join(REPO, 'docs/guide.md'), '# Guide\nedited\n')
  const r = fake()
  assert.equal(r.status, 2, r.out)
  assert.match(r.stdout, /^refused: .*uncommitted/i)
  assert.deepEqual(calls(), [])
})

test('B6 the review script failing or printing garbage is refused', () => {
  gh()
  const r = merge([], { FAKE_TIER_RAW: 'not json', FAKE_TIER_CODE: '1' })
  assert.equal(r.status, 2, r.out)
  assert.match(r.stdout, /^refused: /)
  assert.deepEqual(calls(), [])
})

test('B7 no tier on any covering close: needs a human, naming the untiered close', () => {
  gh()
  const r = fake({ tier: null, merges: false, reasons: ['the close of review 2026-11-05-r1 has no merge tier (logged before tiers)'] })
  assert.equal(r.status, 10, r.out)
  assert.match(r.stdout, /2026-11-05-r1 has no merge tier/)
  assert.match(bodyOf(), /2026-11-05-r1 has no merge tier/)
  assert.ok(!calls().some((a) => a[1] === 'merge'))
})

test('B7 onHuman none: no writes, none, exit 11', () => {
  gh()
  const r = fake({ tier: 'medium', merges: false, merge: { onHuman: 'none', humanComment: 'x', requireChecks: true, allowBehind: false } })
  assert.equal(r.status, 11, r.out)
  assert.match(r.stdout, /^none: /)
  assert.deepEqual(writes(), [])
})

test('B8 --dry-run makes no write and logs the would-be action', () => {
  gh()
  const merged = fake({}, ['--dry-run'])
  assert.equal(merged.status, 0, merged.out)
  assert.match(merged.stdout, /^merged \(dry run\): /)
  assert.deepEqual(writes(), [])
  assert.deepEqual([lastOutcome().action, lastOutcome().dryRun], ['merged', true])
  rmSync(GH_LOG, { force: true })
  const labeled = fake({ tier: 'medium', merges: false }, ['--dry-run'])
  assert.equal(labeled.status, 10, labeled.out)
  assert.match(labeled.stdout, /^labeled \(dry run\): /)
  assert.deepEqual(writes(), [])
  assert.deepEqual([lastOutcome().action, lastOutcome().dryRun], ['labeled', true])
})

test('B10 an intent record, then an outcome record, on every path, in merge-log.jsonl beside the review log', () => {
  const paths = [
    [() => gh(), {}, 'merged'],
    [() => gh(), { tier: 'medium', merges: false }, 'labeled'],
    [() => gh(), { policy: 'off', merges: false }, 'none'],
    [() => gh(), { covered: false }, 'refused'],
    [() => gh({ view: prView({ isDraft: true }) }), {}, 'refused'],
    [() => gh({ merged: { stderr: 'boom\n', code: 1 } }), {}, 'refused'],
  ]
  for (const [setup, tier, action] of paths) {
    rmSync(MERGE_LOG, { force: true })
    setup()
    fake(tier)
    const log = jsonl(MERGE_LOG)
    assert.deepEqual(log.map((e) => [e.type, e.phase]), [['merge', 'intent'], ['merge', 'outcome']], action)
    assert.equal(log[1].action, action)
    assert.equal(log[0].run, log[1].run)
    assert.equal(log[0].tip, head())
    assert.equal(log[1].dryRun, false)
  }
})

// Real review.mjs: review, close, then merge.mjs reads the real --tier-json.
function realClose(extra = {}) {
  rmSync(join(REPO, 'scripts'), { recursive: true, force: true })
  const r = run(process.execPath, [REVIEW], extra)
  assert.equal(r.status, 0, r.out)
  const id = jsonl(REAL_LOG).filter((e) => e.type === 'review').at(-1).id
  writeFileSync(join(ROOT, 'statuses.json'), '{}')
  const c = run(process.execPath, [REVIEW, '--close', id, '--status', join(ROOT, 'statuses.json'), '--test-cmd', 'true'], extra)
  assert.equal(c.status, 0, c.out)
}
const homeConfig = (config) => { mkdirSync(dirname(HOME_CONFIG), { recursive: true }); writeFileSync(HOME_CONFIG, JSON.stringify(config)) }

test('B10 with the real review.mjs the merge log sits beside the review log, and the run merges a LOW', () => {
  homeConfig({ merge: { policy: 'standard' } })
  realClose()
  gh({ view: prView({ baseRefName: 'main' }) })
  const r = merge([], { REVIEW_BASE: 'origin/main' })
  allowedMerge(r)
  const log = jsonl(join(dirname(REAL_LOG), 'merge-log.jsonl'))
  assert.deepEqual(log.map((e) => e.phase), ['intent', 'outcome'])
  assert.equal(log[1].tier, 'low')
})

test('B9 a tracked repo config cannot set requireChecks, allowBehind, humanComment or a looser policy; onHuman it may', () => {
  homeConfig({ merge: { policy: 'standard' } })
  commit({ '.claude/review-config.json': JSON.stringify({ merge: { policy: 'always', requireChecks: false, allowBehind: true, humanComment: '@bot deploy', onHuman: 'none' } }) })
  realClose({ REVIEW_CONFIG: '' })
  const t = run(process.execPath, [REVIEW, '--tier-json'], { REVIEW_CONFIG: '' })
  assert.equal(t.status, 0, t.out)
  const json = JSON.parse(t.stdout)
  assert.equal(json.policy, 'standard')
  assert.deepEqual(json.merge, { onHuman: 'none', humanComment: 'Needs human approval before merging.', requireChecks: true, allowBehind: false })
  for (const key of ['merge.policy "always"', 'merge.requireChecks', 'merge.allowBehind', 'merge.humanComment'])
    assert.ok(t.stderr.includes(`Ignoring ${key}`), `${key}: ${t.stderr}`)
  // Through merge.mjs: the config file makes the tier MEDIUM, so a human is needed, and the tracked onHuman none writes nothing.
  gh({ checks: [] })
  const r = merge([], { REVIEW_CONFIG: '' })
  assert.equal(r.status, 11, r.out)
  assert.match(r.stdout, /^none: .*onHuman none/)
  assert.deepEqual(writes(), [])
  // Tightening is honored: a tracked requireChecks true / allowBehind false is no warning.
  commit({ '.claude/review-config.json': JSON.stringify({ merge: { requireChecks: true, allowBehind: false } }) })
  const tight = run(process.execPath, [REVIEW, '--tier-json'], { REVIEW_CONFIG: '' })
  assert.doesNotMatch(tight.stderr, /Ignoring merge/)
})

test('B9 home and untracked repo configs set every merge key', () => {
  homeConfig({ merge: { policy: 'standard', requireChecks: false, allowBehind: true, humanComment: 'Ping the operator.', onHuman: 'none' } })
  realClose()
  const home = JSON.parse(run(process.execPath, [REVIEW, '--tier-json']).stdout)
  assert.deepEqual(home.merge, { onHuman: 'none', humanComment: 'Ping the operator.', requireChecks: false, allowBehind: true })
  homeConfig({ merge: { policy: 'standard' } })
  mkdirSync(join(REPO, '.claude'), { recursive: true })
  writeFileSync(join(REPO, '.claude/review-config.json'), JSON.stringify({ merge: { policy: 'standard', requireChecks: false, humanComment: 'Mine.' } }))
  const own = run(process.execPath, [REVIEW, '--tier-json'], { REVIEW_CONFIG: '' })
  assert.doesNotMatch(own.stderr, /Ignoring merge/)
  assert.deepEqual(JSON.parse(own.stdout).merge, { onHuman: 'comment', humanComment: 'Mine.', requireChecks: false, allowBehind: false })
})

test('B11 the pack ships merge.mjs, and both skills say the orchestrator runs it once and never merges another way', () => {
  const pack = join(RUNTIME, '..')
  const manifest = JSON.parse(readFileSync(join(pack, 'pack.json'), 'utf8'))
  const part = manifest.parts.find((p) => p.id === 'code-review')
  assert.ok(part.files.includes('packs/review-gate/runtime/merge.mjs'))
  for (const harness of ['claude', 'codex']) {
    const text = readFileSync(join(pack, 'skills', harness, 'code-review', 'SKILL.md'), 'utf8')
    for (const phrase of ['merge.mjs', 'merge.onHuman', 'merge.requireChecks', 'merge.allowBehind', 'merge.humanComment', 'needs-human', 'never merge'])
      assert.ok(text.includes(phrase), `${harness}: ${phrase}`)
    // Always the shared runtime's merge.mjs: a repo's scripts/review.mjs has no merge.mjs beside it.
    assert.ok(text.includes('node ~/.agent-config-studio/review-gate/merge.mjs'), `${harness}: shared merge.mjs`)
    assert.ok(!text.includes('dir of $REVIEW_SCRIPT'), `${harness}: no REVIEW_SCRIPT-relative merge.mjs`)
  }
  const example = readFileSync(join(RUNTIME, 'review-config.example.json'), 'utf8')
  for (const key of ['onHuman', 'humanComment', 'requireChecks', 'allowBehind']) assert.ok(example.includes(key), key)
})

test('B9 each loosening key in a tracked repo config is ignored on its own, with its own warning', () => {
  homeConfig({ merge: { policy: 'standard' } })
  commit({ '.claude/review-config.json': JSON.stringify({ merge: {} }) })
  realClose({ REVIEW_CONFIG: '' })
  const defaults = { onHuman: 'comment', humanComment: 'Needs human approval before merging.', requireChecks: true, allowBehind: false }
  // The file stays tracked while its working-tree content changes, so each case is read under the tracked rules.
  const cases = [
    [{ humanComment: '@bot deploy' }, 'merge.humanComment', {}],
    [{ requireChecks: false }, 'merge.requireChecks', {}],
    [{ allowBehind: true }, 'merge.allowBehind', {}],
    [{ policy: 'always' }, 'merge.policy "always"', {}],
    [{ onHuman: 'none' }, null, { onHuman: 'none' }],
  ]
  for (const [own, warned, changed] of cases) {
    writeFileSync(join(REPO, '.claude/review-config.json'), JSON.stringify({ merge: own }))
    const t = run(process.execPath, [REVIEW, '--tier-json'], { REVIEW_CONFIG: '' })
    assert.equal(t.status, 0, t.out)
    const json = JSON.parse(t.stdout)
    assert.equal(json.policy, 'standard', JSON.stringify(own))
    assert.deepEqual(json.merge, { ...defaults, ...changed }, JSON.stringify(own))
    const warnings = t.stderr.split('\n').filter((l) => /Ignoring merge\./.test(l))
    if (warned) { assert.equal(warnings.length, 1, t.stderr); assert.ok(warnings[0].includes(`Ignoring ${warned}`), t.stderr) }
    else assert.deepEqual(warnings, [], t.stderr)
  }
})

// Fix round: BLOCKED needs a human; UNKNOWN is read again before it is refused.
test('B12 BLOCKED (branch protection) takes the needs-human path: label and one comment, no merge, not refused', () => {
  gh({ view: prView({ mergeStateStatus: 'BLOCKED' }) })
  const r = fake()
  assert.equal(r.status, 10, r.out)
  assert.match(r.stdout, /^labeled: .*blocked by branch protection/)
  assert.ok(!calls().some((a) => a[1] === 'merge'))
  assert.equal(calls().filter((a) => a[1] === 'comment').length, 1)
  assert.match(bodyOf(), /blocked by branch protection/)
  assert.deepEqual(calls().find((a) => a[1] === 'edit'), ['pr', 'edit', '41', '--add-label', 'needs-human'])
  assert.deepEqual([lastOutcome().action, /blocked by branch protection/.test(lastOutcome().reason)], ['labeled', true])
  // A MEDIUM that is also blocked names both reasons; onHuman none still writes nothing.
  rmSync(GH_LOG, { force: true })
  gh({ view: prView({ mergeStateStatus: 'BLOCKED' }) })
  const medium = fake({ tier: 'medium', merges: false })
  assert.equal(medium.status, 10, medium.out)
  assert.match(medium.stdout, /tier MEDIUM.*blocked by branch protection/)
  rmSync(GH_LOG, { force: true })
  gh({ view: prView({ mergeStateStatus: 'BLOCKED' }) })
  const none = fake({ merge: { onHuman: 'none', humanComment: 'x', requireChecks: true, allowBehind: false } })
  assert.equal(none.status, 11, none.out)
  assert.deepEqual(writes(), [])
})

test('B12 UNKNOWN is read again: CLEAN on a re-read merges', () => {
  gh({ extra: { 'pr view': [out(prView({ mergeStateStatus: 'UNKNOWN' })), out(prView({ mergeStateStatus: 'UNKNOWN' })), out(prView())] } })
  allowedMerge(fake())
  assert.equal(calls().filter((a) => a[1] === 'view').length, 3, 'three reads before the merge')
})

test('B12 UNKNOWN on the first read and all 3 re-reads is refused, with no write', () => {
  gh({ view: prView({ mergeStateStatus: 'UNKNOWN' }) })
  const r = fake()
  assert.equal(r.status, 2, r.out)
  assert.match(r.stdout, /^refused: .*UNKNOWN/)
  assert.equal(calls().filter((a) => a[1] === 'view').length, 4)
  assert.deepEqual(writes(), [])
})

test('B12 the re-reads wait MERGE_UNKNOWN_DELAY_MS between them (5 seconds by default)', () => {
  gh({ view: prView({ mergeStateStatus: 'UNKNOWN' }) })
  const start = Date.now()
  assert.equal(fake({}, [], { MERGE_UNKNOWN_DELAY_MS: '200' }).status, 2)
  assert.ok(Date.now() - start >= 600, `${Date.now() - start}ms`)
  assert.match(readFileSync(MERGE, 'utf8'), /MERGE_UNKNOWN_DELAY_MS[^\n]*5000/)
})

// Fix round (review 2026-11-05-18-21-30-29699b).
test('B13 run from a subdirectory, the repo config still counts: a repo policy off beats a home standard', () => {
  homeConfig({ merge: { policy: 'standard' } })
  realClose()
  // Untracked, so the tip stays covered and the repo config may set the policy.
  mkdirSync(join(REPO, '.claude'), { recursive: true })
  writeFileSync(join(REPO, '.claude/review-config.json'), JSON.stringify({ merge: { policy: 'off' } }))
  writeFileSync(GH_TABLE, '{}')
  const r = spawnSync(process.execPath, [MERGE], { cwd: join(REPO, 'docs'), env: env(), encoding: 'utf8', timeout: 60000 })
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout, /^none: merge policy off/)
  assert.deepEqual(calls(), [])
})

test('B14 a merge that only queued or set auto-merge is undone and goes to a human, not reported merged', () => {
  const queued = { autoMergeRequest: { enabledAt: '2026-11-05T18:00:00Z' }, state: 'OPEN' }
  for (const disable of [{ stdout: '' }, { stderr: 'no auto-merge to disable\n', code: 1 }]) {
    rmSync(GH_LOG, { force: true })
    gh({ extra: { 'graphql pr': prAfter(queued), 'pr merge': [{ stdout: '' }, disable] } })
    const r = fake()
    assert.equal(r.status, 10, r.out)
    assert.match(r.stdout, /^labeled: .*base uses a merge queue or auto-merge; not merged/)
    const merges = calls().filter((a) => a[1] === 'merge')
    assert.deepEqual(merges, [['pr', 'merge', '41', '--merge', '--match-head-commit', head()], ['pr', 'merge', '41', '--disable-auto']])
    assert.match(bodyOf(), /merge queue or auto-merge; not merged/)
    assert.equal(lastOutcome().action, 'labeled')
    neverFlags()
  }
})

test('B14 a merge whose result cannot be read again is refused after disabling auto-merge', () => {
  gh({ extra: { 'graphql pr': { stderr: 'HTTP 502\n', code: 1 }, 'pr merge': [{ stdout: '' }, { stdout: '' }] } })
  const r = fake()
  assert.equal(r.status, 2, r.out)
  assert.match(r.stdout, /^refused: .*502/)
  assert.deepEqual(calls().filter((a) => a[1] === 'merge').at(-1), ['pr', 'merge', '41', '--disable-auto'])
  assert.ok(!calls().some((a) => ['edit', 'comment'].includes(a[1])))
})

const ACS_LOG_DIR = join(HOME, '.agent-config-studio', 'review-log')
test('B15 an early refusal on a legacy-only install writes beside the legacy log and creates no ACS folder', () => {
  mkdirSync(join(HOME, '.claude'), { recursive: true })
  writeFileSync(join(HOME, '.claude/review-log.jsonl'), '')
  gh()
  const r = merge([], { FAKE_TIER_RAW: 'not json', FAKE_TIER_CODE: '1' })
  assert.equal(r.status, 2, r.out)
  assert.equal(existsSync(join(HOME, '.agent-config-studio')), false, 'no ACS folder')
  assert.deepEqual(jsonl(join(HOME, '.claude/merge-log.jsonl')).map((e) => e.phase), ['intent', 'outcome'])
})

test('B15 with no review log anywhere an early refusal prints its records to stderr and creates nothing', () => {
  gh()
  const r = merge([], { FAKE_TIER_RAW: 'not json', FAKE_TIER_CODE: '1' })
  assert.equal(r.status, 2, r.out)
  assert.equal(existsSync(join(HOME, '.agent-config-studio')), false)
  assert.equal(existsSync(join(HOME, '.claude')), false)
  assert.match(r.stderr, /"phase":"outcome"/)
})

test('B15 the --tier-json log folder is never created: a missing one refuses before gh', () => {
  rmSync(dirname(FAKE_LOG), { recursive: true })
  gh()
  const r = fake()
  assert.equal(r.status, 2, r.out)
  assert.match(r.stdout, /^refused: /)
  assert.equal(existsSync(dirname(FAKE_LOG)), false)
  assert.deepEqual(calls(), [])
})

test('B16 an intent record that cannot be written refuses before any gh call, exit 2, the error on stderr', () => {
  mkdirSync(dirname(FAKE_LOG), { recursive: true })
  writeFileSync(MERGE_LOG, '')
  chmodSync(MERGE_LOG, 0o444)
  gh()
  try {
    const r = fake()
    assert.equal(r.status, 2, r.out)
    assert.match(r.stdout, /^refused: .*intent/)
    assert.match(r.stderr, /could not append/)
    assert.deepEqual(calls(), [])
    assert.equal(readFileSync(MERGE_LOG, 'utf8'), '')
  } finally { chmodSync(MERGE_LOG, 0o644) }
})

// Fix check x1: --disable-auto does not take a PR out of a merge queue.
test('B17 a base with a merge queue needs a human before any merge call', () => {
  gh({ extra: { 'graphql queue': graphql({ repository: { mergeQueue: { id: 'MQ_1' } } }) } })
  const r = fake()
  assert.equal(r.status, 10, r.out)
  assert.match(r.stdout, /^labeled: .*base uses a merge queue/)
  assert.ok(!calls().some((a) => a[1] === 'merge'), 'never calls merge')
  assert.match(bodyOf(), /base uses a merge queue/)
  rmSync(GH_LOG, { force: true })
  gh({ extra: { 'graphql queue': graphql({ repository: { mergeQueue: { id: 'MQ_1' } } }) } })
  const dry = fake({}, ['--dry-run'])
  assert.equal(dry.status, 10, dry.out)
  assert.match(dry.stdout, /^labeled \(dry run\): .*merge queue/)
  assert.deepEqual(writes(), [])
})

test('B17 the merge-queue check failing is refused, with no merge call', () => {
  gh({ extra: { 'graphql queue': { stderr: 'HTTP 401: Bad credentials\n', code: 1 } } })
  const r = fake()
  assert.equal(r.status, 2, r.out)
  assert.match(r.stdout, /^refused: .*merge queue.*401/)
  assert.deepEqual(writes(), [])
})

test('B17 a PR still queued after the merge call is dequeued, then needs a human', () => {
  gh({ extra: { 'graphql pr': prAfter({ state: 'OPEN', isInMergeQueue: true }), 'graphql dequeue': graphql({ dequeuePullRequest: { clientMutationId: null } }) } })
  const r = fake()
  assert.equal(r.status, 10, r.out)
  assert.match(r.stdout, /^labeled: .*base uses a merge queue; not merged/)
  const dequeue = calls().find((a) => keyOf(a) === 'graphql dequeue')
  assert.ok(dequeue, 'dequeuePullRequest called')
  assert.equal(varOf(dequeue, 'id'), 'PR_node41')
  assert.equal(calls().filter((a) => a[1] === 'comment').length, 1)
  neverFlags()
})

test('B17 a failed dequeue is refused and says the PR may still be queued; no label or comment', () => {
  gh({ extra: { 'graphql pr': prAfter({ state: 'OPEN', isInMergeQueue: true }), 'graphql dequeue': { stderr: 'GraphQL: Could not dequeue\n', code: 1 } } })
  const r = fake()
  assert.equal(r.status, 2, r.out)
  assert.match(r.stdout, /^refused: .*may still be queued/)
  assert.ok(!calls().some((a) => ['edit', 'comment'].includes(a[1])))
})
