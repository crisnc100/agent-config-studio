#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'review.mjs')
const ROOT = mkdtempSync(join(tmpdir(), 'review-close-test-'))
const BIN = join(ROOT, 'bin')
const HOME = join(ROOT, 'home')
const REPO = join(ROOT, 'repo')
const CALLS = join(ROOT, 'calls')
const JEV_LOG = join(ROOT, 'jev.json')
const LOG = join(HOME, '.agent-config-studio', 'review-log', 'review-log.jsonl')
const FINDING = { severity: 'high', issue: 'wrong return', file: 'a.js', line: '1', quote: 'export const a = 2', suggestion: 'return 1' }
const MARKERS = ['CLAUDECODE', 'CODEX_CI', 'CODEX_SANDBOX', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'GROK_AGENT', 'GROK_SESSION_ID']
after(() => rmSync(ROOT, { recursive: true, force: true }))
mkdirSync(BIN)
const stub = (name, body) => {
  const p = join(BIN, name)
  writeFileSync(p, `#!${process.execPath}\n${body}`)
  chmodSync(p, 0o755)
}
stub('model-id', `const a=process.argv.slice(2), ids={sol:'gpt-stub-sol',opus:'claude-stub-opus',grok:'grok-stub'}; console.log(a[0]==='--role' ? JSON.stringify({use:['sol','opus','grok'],ids:['gpt-stub-sol','claude-stub-opus','grok-stub']}) : a[0]==='--flavor' ? JSON.stringify({flavor:{effort:'high'}}) : ids[a[0]] || 'stub-'+a[0])`)
const modelBody = `
const fs = require('node:fs'), path = require('node:path')
const a = process.argv.slice(2)
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8') : a[a.indexOf('--json-schema')+1]
const prompt = a.includes('--output-schema') ? a.at(-1) : a[1]
fs.writeFileSync(path.join(${JSON.stringify(CALLS)}, process.pid+'.json'), JSON.stringify({a,prompt,schema:JSON.parse(schema),cwd:process.cwd(),code:fs.readFileSync('a.js','utf8')}))
if (process.env.STUB_FAIL || schema.includes('\"scores\"') && process.env.STUB_SCORE_FAIL) process.exit(1)
if (process.env.STUB_BLOCK_LOG) fs.mkdirSync(path.join(process.env.HOME,'.agent-config-studio','review-log','review-log.jsonl'),{recursive:true})
const reply = schema.includes('\"scores\"') ? (process.env.STUB_SCORES || '{\"scores\":[]}') : schema.includes('verdicts') ? (process.env.STUB_VERDICTS || '{"verdicts":[{"index":0,"verdict":"REFUTED","evidence":"a.js:1 intentional"}]}') : (process.env.STUB_FINDINGS || ${JSON.stringify(JSON.stringify({ findings: [FINDING] }))})
if(a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1],reply)
else console.log(JSON.stringify({structured_output:JSON.parse(reply),structuredOutput:JSON.parse(reply),modelUsage:{'stub-grok':{}}}))
`
for (const model of ['codex', 'claude', 'grok']) stub(model, modelBody)
stub('jev', `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(JEV_LOG)},fs.readFileSync(0,'utf8')); if(process.env.STUB_JEV_FAIL) process.exit(1); console.log(JSON.stringify({answers:{reviewer:{type:'choice',choice:'grok',confidence:.9,probabilities:{grok:.9,opus:.1}}}}))`)
const git = (...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: REPO, env: environment(), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}
const write = (path, text) => {
  mkdirSync(dirname(join(REPO, path)), { recursive: true })
  writeFileSync(join(REPO, path), text)
}
const commit = (path, text) => { write(path, text); git('add', path); git('commit', '-qm', `change ${path}`) }
const lines = () => existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const seed = (...entries) => { mkdirSync(dirname(LOG), { recursive: true }); appendFileSync(LOG, entries.map(JSON.stringify).join('\n') + '\n') }
const calls = () => readdirSync(CALLS).map((p) => JSON.parse(readFileSync(join(CALLS, p), 'utf8')))
function environment(extra = {}) {
  return { PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), HOME, GIT_CONFIG_GLOBAL: join(HOME, 'isolated.gitconfig'), CODEX_HOME: join(HOME, '.codex'), GROK_HOME: join(HOME, '.grok'), TMPDIR: ROOT, REVIEW_BASE: 'main', REVIEW_REVIEWER: 'sol', REVIEW_CLASSIFIER: 'jev', ...extra }
}
function run(args = [], extra = {}, pty = false, cwd = REPO) {
  const cmd = pty ? '/usr/bin/script' : process.execPath
  const argv = pty ? ['-q', '/dev/null', process.execPath, SCRIPT, ...args] : [SCRIPT, ...args]
  const r = spawnSync(cmd, argv, { cwd, env: environment(extra), encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] })
  return { ...r, out: `${r.stdout}\n${r.stderr}` }
}
function review(extra = {}, args = []) {
  const r = run(args, extra)
  assert.equal(r.status, 0, r.out)
  return lines().filter((e) => e.type === 'review').at(-1)
}
function status(value) { const p = join(ROOT, 'status.json'); writeFileSync(p, JSON.stringify(value)); return p }
function close(id, value = {}, args = [], extra = {}) { return run(['--close', id, '--status', status(value), ...args], extra) }
beforeEach(() => {
  rmSync(JEV_LOG, { force: true })
  for (const p of [HOME, REPO, CALLS]) { rmSync(p, { recursive: true, force: true }); mkdirSync(p, { recursive: true }) }
  git('init', '-q', '-b', 'main')
  commit('a.js', 'export const a = 1\n')
  git('checkout', '-qb', 'feat')
  commit('a.js', 'export const a = 2\n')
})

test('1.1 record identifies all findings, retains unlocated severity, full head/branch and informational remote', () => {
  git('remote', 'add', 'origin', 'https://example.invalid/repo')
  const r = review({ STUB_FINDINGS: JSON.stringify({ findings: [FINDING, { ...FINDING, severity: 'medium', quote: 'invented' }] }) })
  assert.equal(r.kind, 'review')
  assert.equal(r.head, git('rev-parse', 'HEAD'))
  assert.equal(r.branch, 'feat')
  assert.equal(r.remote, 'https://example.invalid/repo')
  assert.deepEqual(r.findingDetails.map((f) => [f.id, f.severity, f.status]), [['f1', 'high', 'verified-quote'], ['f2', 'medium', 'unverified-quote']])
})
test('1.2 review refuses staged, unstaged and deleted tracked files, but accepts untracked files', () => {
  write('untracked', 'ignored')
  review()
  for (const kind of ['unstaged', 'staged', 'deleted']) {
    git('reset', '--hard', 'HEAD')
    if (kind === 'deleted') rmSync(join(REPO, 'a.js'))
    else { write('a.js', 'dirty'); if (kind === 'staged') git('add', 'a.js') }
    const before = lines().length
    const r = run()
    assert.notEqual(r.status, 0, r.out)
    assert.match(r.out, /Tracked working tree changes/)
    assert.equal(lines().length, before)
  }
})
test('1.3 review fails when log cannot be written; log reading reports unreadable count', () => {
  const r = run([], { STUB_BLOCK_LOG: '1' })
  assert.notEqual(r.status, 0)
  assert.match(r.out, /Could not append/)
  rmSync(LOG, { recursive: true })
  seed({ type: 'review', family: 'sol' })
  appendFileSync(LOG, 'bad json\nnull\n')
  const shown = run(['--show-config'])
  assert.equal(shown.status, 0, shown.out)
  assert.match(shown.stderr, /2 unreadable log line/)
})
test('1.4 plan flag and env add plan and adjacent optional build log; missing plan refuses', () => {
  write('builds/part/plan.md', 'Intent: preserve X\nPASS: X\nDecisions: chosen Y')
  write('builds/part/log.md', 'Deliberate choice Z')
  for (const [args, env] of [[['--plan', 'builds/part/plan.md'], {}], [[], { REVIEW_PLAN: 'builds/part/plan.md' }]]) {
    review(env, args)
    assert.ok(calls().some((c) => c.prompt.includes('Intent: preserve X') && c.prompt.includes('Deliberate choice Z')))
  }
  rmSync(join(REPO, 'builds/part/log.md'))
  review({}, ['--plan', 'builds/part/plan.md'])
  const before = lines().length
  const r = run(['--plan', 'missing.md'])
  assert.notEqual(r.status, 0)
  assert.match(r.out, /Missing plan/)
  assert.equal(lines().length, before)
})
test('1.11 outcome requires a logged review and stays an outcome; 1.13 banner precedes every run', () => {
  const missing = run(['--log-outcome', 'missing', '0', '0'])
  assert.notEqual(missing.status, 0)
  assert.equal(lines().length, 0)
  const r = review()
  const outcome = run(['--log-outcome', r.id, '1', '0'])
  assert.equal(outcome.status, 0, outcome.out)
  assert.equal(lines().at(-1).type, 'outcome')
  assert.match(outcome.stderr.split('\n')[0], /review\.mjs · .*review\.mjs · head-aware copy/)
})

test('1.5 close refuses unknown review, missing statuses, unknown keys, severity fields and incomplete rejection without appending', () => {
  const r = review({ STUB_FINDINGS: JSON.stringify({ findings: [FINDING, { ...FINDING, severity: 'medium', quote: 'unlocated' }, { ...FINDING, severity: 'low' }] }) })
  const cases = [
    ['missing', {}], [r.id, {}],
    [r.id, { f1: { status: 'fixed' }, f2: { status: 'fixed' } }],
    [r.id, { f1: { status: 'fixed', severity: 'low' }, f2: { status: 'fixed' }, f3: { status: 'fixed' } }],
    [r.id, { f1: { status: 'fixed' }, f2: { status: 'rejected', reason: 'wrong' }, f3: { status: 'fixed' } }],
    [r.id, { f1: { status: 'rejected', reason: 'wrong', evidence: 'a.js:1' }, f2: { status: 'fixed' }, f3: { status: 'fixed' } }],
    [r.id, { f1: { status: 'fixed' }, f2: { status: 'fixed' }, f3: { status: 'fixed' }, typo: { status: 'fixed' } }],
  ]
  for (const [id, statuses] of cases) {
    const before = lines()
    const result = close(id, statuses, ['--test-cmd', 'true'])
    assert.notEqual(result.status, 0, result.out)
    assert.deepEqual(lines(), before)
  }
  const accepted = close(r.id, { f1: { status: 'fixed' }, f2: { status: 'fixed' }, f3: { status: 'fixed' } }, ['--test-cmd', 'true'])
  assert.equal(accepted.status, 0, accepted.out)
})
test('1.5 close tests HEAD, fails without writes on test failure, dirty state and divergent ancestry', () => {
  const r = review()
  let before = lines()
  const failed = close(r.id, { f1: { status: 'fixed' } }, ['--test-cmd', 'exit 7'])
  assert.notEqual(failed.status, 0)
  assert.match(failed.out, /Tests failed at HEAD/)
  assert.deepEqual(lines(), before)
  write('a.js', 'dirty')
  assert.notEqual(close(r.id, { f1: { status: 'fixed' } }, ['--test-cmd', 'true']).status, 0)
  assert.deepEqual(lines(), before)
  git('reset', '--hard', 'HEAD')
  git('checkout', '-qb', 'divergent', 'main')
  commit('a.js', 'divergent\n')
  const divergent = close(r.id, { f1: { status: 'fixed' } }, ['--test-cmd', 'true'])
  assert.notEqual(divergent.status, 0)
  assert.match(divergent.out, /neither the reviewed commit nor a descendant/)
  assert.deepEqual(lines(), before)
})
test('1.5 configured verifyCmd runs on close; no test command needs logged nonempty reason', () => {
  const r = review({ STUB_FINDINGS: '{"findings":[]}' })
  const noCommand = close(r.id)
  assert.notEqual(noCommand.status, 0)
  assert.match(noCommand.out, /No test command/)
  assert.notEqual(close(r.id, {}, ['--no-tests', '']).status, 0)
  write('.claude/review-config.json', JSON.stringify({ verifyCmd: 'exit 8' }))
  const failed = close(r.id)
  assert.notEqual(failed.status, 0)
  assert.equal(lines().length, 1)
  write('.claude/review-config.json', JSON.stringify({ verifyCmd: 'true' }))
  const passed = close(r.id)
  assert.equal(passed.status, 0, passed.out)
  assert.deepEqual(lines().at(-1).tests, { cmd: 'true', passed: true })
})
test('1.6 clean reviews remain open until close runs tests and records exact closeHead', () => {
  const r = review({ STUB_FINDINGS: '{"findings":[]}' })
  assert.equal(lines().length, 1)
  assert.notEqual(run(['--summary']).status, 0)
  const failed = close(r.id, {}, ['--test-cmd', 'false'])
  assert.notEqual(failed.status, 0)
  assert.equal(lines().length, 1)
  const pass = close(r.id, {}, ['--test-cmd', 'true'])
  assert.equal(pass.status, 0, pass.out)
  assert.equal(lines().at(-1).closeHead, git('rev-parse', 'HEAD'))
})
test('1.7 fixed-file and builds exemptions, out-of-scope files make close partial; all test patterns exempt', () => {
  const r = review()
  commit('a.js', 'export const a = 3\n')
  commit('builds/part/log.md', 'choice')
  commit('other.js', 'unrelated')
  const result = close(r.id, { f1: { status: 'fixed' } }, ['--test-cmd', 'true'])
  assert.equal(result.status, 0, result.out)
  assert.deepEqual(lines().at(-1).outOfScope, ['other.js'])
  assert.equal(lines().at(-1).status, 'partial')
  assert.notEqual(run(['--summary']).status, 0)
})
test('1.8 test patterns and verify scripts require exact-head fix check; only fix diff is reviewed, never a third pass', () => {
  const r = review()
  const files = ['test/a.js', 'tests/a.js', '__tests__/a.js', '__snapshots__/a.js', 'a.test.js', 'a.spec.js', 'a.snap', 'vitest.config.js', 'jest.config.cjs', 'playwright.config.ts', 'scripts/verify.sh', 'check.mjs']
  for (const file of files) write(file, 'test contents\n')
  git('add', '.')
  git('commit', '-qm', 'tests')
  const before = lines()
  const refused = close(r.id, { f1: { status: 'fixed' } }, ['--test-cmd', 'node check.mjs'])
  assert.notEqual(refused.status, 0)
  assert.match(refused.out, /run --fix-check first/)
  assert.deepEqual(lines(), before)
  const fixed = run(['--fix-check', r.id], { STUB_FINDINGS: '{"findings":[]}' })
  assert.equal(fixed.status, 0, fixed.out)
  const check = lines().at(-1)
  assert.equal(check.kind, 'fix-check')
  assert.equal(check.head, git('rev-parse', 'HEAD'))
  const prompt = calls().at(-1).prompt
  assert.match(prompt, /test contents/)
  assert.ok(!prompt.includes('+export const a = 2'), prompt)
  const accepted = close(r.id, { f1: { status: 'fixed' } }, ['--test-cmd', 'true'])
  assert.equal(accepted.status, 0, accepted.out)
  assert.deepEqual(lines().at(-1).outOfScope, ['check.mjs', 'scripts/verify.sh'])
  const passCount = calls().length
  const third = run(['--fix-check', r.id])
  assert.notEqual(third.status, 0)
  assert.match(third.out, /no third model pass/)
  assert.equal(calls().length, passCount)
  commit('builds/new/log.md', 'later')
  const stale = close(r.id, { f1: { status: 'fixed' } }, ['--test-cmd', 'true'])
  assert.notEqual(stale.status, 0)
  assert.match(stale.out, /head must equal closing HEAD/)
})
test('1.8 each risk, verify-command path and runner config independently triggers fix check; dirty fix check refuses', () => {
  const r = review()
  for (const file of ['auth/login.js', 'check.mjs', 'a.test.js', 'vitest.config.js', 'scripts/verify.sh']) {
    git('reset', '--hard', r.head)
    commit(file, 'changed')
    const refused = close(r.id, { f1: { status: 'fixed' } }, ['--test-cmd', 'node check.mjs'])
    assert.notEqual(refused.status, 0)
    assert.match(refused.out, /run --fix-check first/, file)
  }
  write('a.js', 'dirty')
  assert.notEqual(run(['--fix-check', r.id]).status, 0)
})
test('1.8 fix-check findings x ids require their own status and dispute; no unresolved findings close', () => {
  const r = review()
  commit('a.test.js', 'test\n')
  const check = run(['--fix-check', r.id])
  assert.equal(check.status, 0, check.out)
  const x = lines().at(-1)
  assert.equal(x.findingDetails[0].id, 'x1')
  assert.notEqual(close(r.id, { f1: { status: 'fixed' } }, ['--test-cmd', 'true']).status, 0)
  assert.notEqual(close(r.id, { f1: { status: 'fixed' }, x1: { status: 'rejected', reason: 'intent', evidence: 'a.js:1' } }, ['--test-cmd', 'true']).status, 0)
  const dispute = run(['--dispute', x.id, 'x1', '--reason', 'intent', '--evidence', 'a.js:1'])
  assert.equal(dispute.status, 0, dispute.out)
  const result = close(r.id, { f1: { status: 'fixed' }, x1: { status: 'rejected', reason: 'intent', evidence: 'a.js:1' } }, ['--test-cmd', 'true'])
  assert.equal(result.status, 0, result.out)
  assert.deepEqual(lines().at(-1).outOfScope, [])
})
test('1.9 disputes use reviewed snapshot for tool reads, log verdict/families/evidence and allow only one verdict', () => {
  const r = review()
  commit('a.js', 'export const a = 999\n')
  const dispute = run(['--dispute', r.id, 'f1', '--reason', 'intent', '--evidence', 'a.js:1'])
  assert.equal(dispute.status, 0, dispute.out)
  const call = calls().find((c) => c.prompt.includes('Judge this dispute'))
  assert.equal(call.code, 'export const a = 2\n')
  assert.notEqual(resolve(call.cwd), resolve(REPO))
  assert.ok(call.prompt.includes(r.head))
  const logged = lines().at(-1)
  assert.deepEqual([logged.type, logged.verdict, logged.family, logged.verifier, logged.evidence], ['dispute', 'REFUTED', 'sol', 'grok', 'a.js:1'])
  const second = run(['--dispute', r.id, 'f1', '--reason', 'again', '--evidence', 'a.js:1'])
  assert.notEqual(second.status, 0)
  const accepted = close(r.id, { f1: { status: 'rejected', reason: 'intent', evidence: 'a.js:1' } }, ['--test-cmd', 'true'])
  assert.equal(accepted.status, 0, accepted.out)
})
test('1.9 Jev failure falls back to other vendor; CONFIRMED, NO-VERDICT and model failure keep finding standing', () => {
  for (const mode of ['confirmed', 'empty', 'failure']) {
    const r = review()
    const env = { STUB_JEV_FAIL: '1', ...(mode === 'failure' ? { STUB_FAIL: '1' } : { STUB_VERDICTS: mode === 'empty' ? '{"verdicts":[]}' : '{"verdicts":[{"index":0,"verdict":"CONFIRMED","evidence":"a.js:1 bug"}]}' }) }
    const dispute = run(['--dispute', r.id, 'f1', '--reason', 'wrong', '--evidence', 'test name'], env)
    assert.equal(dispute.status, 0, dispute.out)
    assert.equal(lines().at(-1).verifier, 'opus')
    assert.equal(lines().at(-1).verdict, mode === 'confirmed' ? 'CONFIRMED' : 'NO-VERDICT')
    assert.notEqual(close(r.id, { f1: { status: 'rejected', reason: 'wrong', evidence: 'a.js:1' } }, ['--test-cmd', 'true']).status, 0)
  }
})
test('1.9 Grade disputes send criterion text/evidence without quote checking', () => {
  const id = 'seed-grade'
  seed({ type: 'review', kind: 'grade', id, head: git('rev-parse', 'HEAD'), branch: 'feat', family: 'sol', vendor: 'codex', findingDetails: [{ id: 'f1', severity: 'high', issue: 'FAIL criterion', criterion: 'Must preserve account', evidence: 'account test failed' }] })
  const result = run(['--dispute', id, 'f1', '--reason', 'wrong', '--evidence', 'account test'])
  assert.equal(result.status, 0, result.out)
  const call = calls()[0]
  assert.match(call.prompt, /Grade criterion: Must preserve account/)
  assert.match(call.prompt, /Criterion evidence: account test failed/)
})
test('1.4 closed rejections carry finding text; 1.5 prior REFUTED references require same branch', () => {
  const first = review()
  assert.equal(run(['--dispute', first.id, 'f1', '--reason', 'intent', '--evidence', 'a.js:1']).status, 0)
  assert.equal(close(first.id, { f1: { status: 'rejected', reason: 'intent', evidence: 'a.js:1' } }, ['--test-cmd', 'true']).status, 0)
  const next = review()
  const prompt = calls().find((c) => c.prompt.includes('Already decided;'))?.prompt
  assert.ok(prompt.includes('wrong return') && prompt.includes('intent') && prompt.includes('a.js:1'))
  const values = { f1: { status: 'rejected', reason: 'same', evidence: 'a.js:1', refutedBy: { review: first.id, finding: 'f1' } } }
  assert.equal(close(next.id, values, ['--test-cmd', 'true']).status, 0)
  git('checkout', '-qb', 'other-branch')
  const other = review()
  assert.notEqual(close(other.id, values, ['--test-cmd', 'true']).status, 0)
  assert.ok(!calls().at(-1).prompt.includes('Already decided;'))
})
test('1.10 waiver refuses non-terminal and all runtime agent markers even empty; real PTY accepts installation metadata', () => {
  const r = review()
  const args = ['--waive', r.id, 'f1', '--reason', 'accepted known bug']
  const noTty = run(args)
  assert.notEqual(noTty.status, 0)
  assert.match(noTty.out, /Operator-only/)
  for (const key of MARKERS) {
    const denied = run(args, { [key]: '' }, true)
    assert.notEqual(denied.status, 0, `${key}: ${denied.out}`)
    assert.match(denied.out, /Operator-only/)
  }
  assert.equal(lines().length, 1)
  const yes = run(args, { CODEX_HOME: '/metadata', CODEX_VERSION: 'metadata' }, true)
  assert.equal(yes.status, 0, yes.out)
  assert.equal(lines().at(-1).action, 'waive')
  const accepted = close(r.id, { f1: { status: 'rejected', reason: 'accept bug', evidence: 'a.js:1' } }, ['--no-tests', 'no test runner'])
  assert.equal(accepted.status, 0, accepted.out)
  const summary = run(['--summary'])
  assert.equal(summary.status, 0, summary.out)
  assert.match(summary.out, /waived: accepted known bug/)
  assert.match(summary.out, /No tests: no test runner/)
})
test('1.10 waiver refuses empty reason and failed durable append, without prompts', () => {
  const r = review()
  assert.notEqual(run(['--waive', r.id, 'f1', '--reason', ''], {}, true).status, 0)
  chmodSync(LOG, 0o444)
  const failed = run(['--waive', r.id, 'f1', '--reason', 'accepted'], {}, true)
  chmodSync(LOG, 0o644)
  assert.notEqual(failed.status, 0, failed.out)
  assert.match(failed.out, /Could not append/)
  assert.equal(lines().length, 1)
})
test('1.12 summary prints reviewer, counts, serious rejection reasons and carried unlocated findings; remote never matches', () => {
  const r = review({ STUB_FINDINGS: JSON.stringify({ findings: [{ ...FINDING, severity: 'medium', quote: 'invented' }] }) })
  assert.equal(run(['--dispute', r.id, 'f1', '--reason', 'invented', '--evidence', 'a.js:1']).status, 0)
  const result = close(r.id, { f1: { status: 'rejected', reason: 'invented quote', evidence: 'a.js:1' } }, ['--no-tests', 'no suite'])
  assert.equal(result.status, 0, result.out)
  git('remote', 'add', 'origin', 'https://different.invalid')
  const summary = run(['--summary'])
  assert.equal(summary.status, 0, summary.out)
  for (const text of ['Reviewer: sol', '1 findings', '1 rejected', 'MEDIUM wrong return: invented quote', 'Carried unlocated f1', 'No tests: no suite']) assert.ok(summary.out.includes(text), summary.out)
})
test('1.1 legacy records still parse; 1.13 old copies are labelled when they cannot close or cover HEAD', () => {
  seed({ type: 'review', id: 'legacy', family: 'sol', repo: 'repo', findings: 0 })
  const config = run(['--show-config'])
  assert.equal(config.status, 0, config.out)
  assert.equal(JSON.parse(config.stdout).reviewCounts.sol, 1)
  const closed = close('legacy', {}, ['--no-tests', 'legacy'])
  assert.notEqual(closed.status, 0)
  assert.match(closed.out, /old script copy that did not log head/)
  const summary = run(['--summary'])
  assert.notEqual(summary.status, 0)
  assert.match(summary.out, /old script copy that did not log head/)
})

test('1.5 every supplied reference validates even for fixed, LOW and waived statuses; nested unknown keys refuse', () => {
  const r = review({ STUB_FINDINGS: JSON.stringify({ findings: [{ ...FINDING, severity: 'low' }] }) })
  for (const statusValue of [
    { status: 'fixed', refutedBy: { review: 'missing', finding: 'f1' } },
    { status: 'rejected', reason: 'low', evidence: 'a.js:1', refutedBy: { review: 'missing', finding: 'f1' } },
    { status: 'fixed', refutedBy: { review: r.id, finding: 'f1', severity: 'low' } },
    { status: 'fixed', refutedBy: null },
  ]) {
    const before = lines()
    const result = close(r.id, { f1: statusValue }, ['--test-cmd', 'true'])
    assert.notEqual(result.status, 0, result.out)
    assert.deepEqual(lines(), before)
  }
  const prior = review()
  assert.equal(run(['--waive', prior.id, 'f1', '--reason', 'accept'], {}, true).status, 0)
  const result = close(prior.id, { f1: { status: 'rejected', reason: 'accept', evidence: 'test', refutedBy: { review: 'missing', finding: 'f1' } } }, ['--test-cmd', 'true'])
  assert.notEqual(result.status, 0)
})
test('1.5 tests that dirty tracked files or move HEAD cannot append a close', () => {
  const r = review()
  const before = lines()
  const dirty = close(r.id, { f1: { status: 'fixed' } }, ['--test-cmd', 'echo changed >> a.js'])
  assert.notEqual(dirty.status, 0)
  assert.deepEqual(lines(), before)
  git('reset', '--hard', r.head)
  const moved = close(r.id, { f1: { status: 'fixed' } }, ['--test-cmd', 'git checkout -q main'])
  assert.notEqual(moved.status, 0)
  assert.match(moved.out, /HEAD changed/)
  assert.deepEqual(lines(), before)
})

test('M1 review records pin the merge-base commit beside the symbolic base', () => {
  const baseSha = git('rev-parse', 'main')
  const r = review()
  assert.equal(r.base, 'main')
  assert.equal(r.baseSha, baseSha)
})
test('M1 review disputes include every reviewed commit even after the symbolic base moves', () => {
  const baseSha = git('rev-parse', 'main')
  commit('earlier.js', 'export const earlier = 10\n')
  commit('last.js', 'export const last = 20\n')
  const r = review()
  git('branch', '-f', 'main', r.head)
  commit('a.js', 'export const a = 999\n')
  const result = run(['--dispute', r.id, 'f1', '--reason', 'intent', '--evidence', 'a.js:1'])
  assert.equal(result.status, 0, result.out)
  const call = calls().find((c) => c.prompt.includes('Judge this dispute'))
  assert.ok(call.prompt.includes('+export const earlier = 10'), call.prompt)
  assert.ok(call.prompt.includes('+export const last = 20'), call.prompt)
  assert.ok(call.prompt.includes(`Diff (git diff ${baseSha}...${r.head}):`), call.prompt)
  assert.equal(call.code, 'export const a = 2\n')
})
test('M1 fix-check disputes include the entire two-dot fix range only', () => {
  const r = review()
  commit('earlier-fix.js', 'export const earlyFix = 10\n')
  commit('last-fix.js', 'export const lastFix = 20\n')
  const checked = run(['--fix-check', r.id])
  assert.equal(checked.status, 0, checked.out)
  const check = lines().at(-1)
  const disputed = run(['--dispute', check.id, 'x1', '--reason', 'intent', '--evidence', 'a.js:1'])
  assert.equal(disputed.status, 0, disputed.out)
  const call = calls().find((c) => c.prompt.includes('Judge this dispute'))
  assert.ok(call.prompt.includes('+export const earlyFix = 10'), call.prompt)
  assert.ok(call.prompt.includes('+export const lastFix = 20'), call.prompt)
  assert.ok(!call.prompt.includes('diff --git a/a.js b/a.js'), call.prompt)
  assert.ok(call.prompt.includes(`Diff (git diff ${r.head}..${check.head}):`), call.prompt)
  assert.equal(check.baseSha, r.head)
})

test('M2 reviews and fix checks share resolved repository identity across worktrees', () => {
  const r = review()
  const identity = realpathSync(join(REPO, '.git'))
  assert.equal(r.repoId, identity)
  assert.equal(run(['--dispute', r.id, 'f1', '--reason', 'intent', '--evidence', 'a.js:1']).status, 0)
  assert.equal(close(r.id, { f1: { status: 'rejected', reason: 'intent', evidence: 'a.js:1' } }, ['--test-cmd', 'true']).status, 0)
  const linked = join(ROOT, 'linked-worktree')
  git('worktree', 'add', '--quiet', '--force', linked, 'feat')
  const result = run([], {}, false, linked)
  assert.equal(result.status, 0, result.out)
  const next = lines().at(-1)
  assert.equal(next.repoId, identity)
  assert.ok(calls().find((c) => c.cwd === realpathSync(linked)).prompt.includes('Already decided;'))
  const statuses = { f1: { status: 'rejected', reason: 'same', evidence: 'a.js:1', refutedBy: { review: r.id, finding: 'f1' } } }
  assert.equal(close(next.id, statuses, ['--test-cmd', 'true']).status, 0)
  commit('a.test.js', 'test\n')
  const checked = run(['--fix-check', next.id], { STUB_FINDINGS: '{"findings":[]}' })
  assert.equal(checked.status, 0, checked.out)
  assert.equal(lines().at(-1).repoId, identity)
})
test('M2 already-decided context excludes identity-less and foreign repositories on the same branch', () => {
  const other = join(ROOT, 'context-other-repo')
  git('clone', '--quiet', '--no-hardlinks', REPO, other)
  for (const [i, repoId] of [undefined, realpathSync(join(other, '.git'))].entries()) {
    const id = `context-prior-${i}`
    seed({ type: 'review', id, head: git('rev-parse', 'HEAD'), branch: 'feat', ...(repoId && { repoId }), findingDetails: [{ ...FINDING, id: 'f1' }] },
      { type: 'dispute', review: id, finding: 'f1', verdict: 'REFUTED' },
      { type: 'close', review: id, statuses: { f1: { status: 'rejected', reason: 'foreign intent', evidence: 'a.js:1' } } })
  }
  review()
  assert.ok(calls().every((c) => !c.prompt.includes('Already decided;')))
})
test('M2 refutedBy refuses identity-less and foreign repositories despite matching branch names', () => {
  const r = review()
  const other = join(ROOT, 'refuted-other-repo')
  git('clone', '--quiet', '--no-hardlinks', REPO, other)
  for (const [i, repoId] of [undefined, realpathSync(join(other, '.git'))].entries()) {
    const id = `refuted-prior-${i}`
    seed({ type: 'review', id, head: r.head, branch: r.branch, ...(repoId && { repoId }), findingDetails: [{ ...FINDING, id: 'f1' }] },
      { type: 'dispute', review: id, finding: 'f1', verdict: 'REFUTED' })
    const before = lines()
    const result = close(r.id, { f1: { status: 'rejected', reason: 'same branch', evidence: 'a.js:1', refutedBy: { review: id, finding: 'f1' } } }, ['--test-cmd', 'true'])
    assert.notEqual(result.status, 0, result.out)
    assert.deepEqual(lines(), before)
  }
})

test('M3 missing second-opinion verdict permits a dispute; real verdicts still block it', () => {
  const r = review({ REVIEW_VERIFY: 'second-opinion', STUB_VERDICTS: '{"verdicts":[]}' })
  assert.equal(r.findingDetails[0].secondOpinion.verdict, 'NO-VERDICT')
  const disputed = run(['--dispute', r.id, 'f1', '--reason', 'intent', '--evidence', 'a.js:1'])
  assert.equal(disputed.status, 0, disputed.out)
  assert.equal(lines().at(-1).verdict, 'REFUTED')
  for (const verdict of ['CONFIRMED', 'REFUTED']) {
    const checked = review({ REVIEW_VERIFY: 'second-opinion', STUB_VERDICTS: JSON.stringify({ verdicts: [{ index: 0, verdict, evidence: 'a.js:1 checked' }] }) })
    const before = calls().length
    const refused = run(['--dispute', checked.id, 'f1', '--reason', 'again', '--evidence', 'a.js:1'])
    assert.notEqual(refused.status, 0, refused.out)
    assert.equal(calls().length, before)
  }
})
test('L1 missing and failed dispute verdicts may be retried once a real verdict is available', () => {
  for (const env of [{ STUB_VERDICTS: '{"verdicts":[]}' }, { STUB_FAIL: '1' }]) {
    const r = review()
    const args = ['--dispute', r.id, 'f1', '--reason', 'intent', '--evidence', 'a.js:1']
    const missing = run(args, env)
    assert.equal(missing.status, 0, missing.out)
    assert.equal(lines().at(-1).verdict, 'NO-VERDICT')
    const statuses = { f1: { status: 'rejected', reason: 'intent', evidence: 'a.js:1' } }
    assert.notEqual(close(r.id, statuses, ['--test-cmd', 'true']).status, 0)
    const retry = run(args)
    assert.equal(retry.status, 0, retry.out)
    assert.equal(lines().at(-1).verdict, 'REFUTED')
    const before = lines()
    assert.notEqual(run(args).status, 0)
    assert.deepEqual(lines(), before)
    assert.equal(close(r.id, statuses, ['--test-cmd', 'true']).status, 0)
    review()
    const context = calls().filter((c) => c.prompt.includes('Already decided;')).at(-1).prompt
    assert.ok(context.includes('"verdict":"REFUTED"'), context)
    assert.ok(!context.includes('"verdict":"NO-VERDICT"'), context)
  }
})
test('L2 a dispute finding id never becomes review intent', () => {
  const r = review()
  const result = run(['--dispute', r.id, 'f1', '--reason', 'intended behavior', '--evidence', 'a.js:1'])
  assert.equal(result.status, 0, result.out)
  const prompt = calls().find((c) => c.prompt.includes('Judge this dispute')).prompt
  assert.ok(!prompt.includes('(intent:'), prompt)
  assert.ok(prompt.includes('Reason: intended behavior'), prompt)
})
test('L3 configured verifyCmd paths trigger fix checks even when test-cmd overrides execution', () => {
  commit('custom-check.mjs', 'process.exit(0)\n')
  write('.claude/review-config.json', JSON.stringify({ verifyCmd: 'node custom-check.mjs' }))
  const r = review()
  commit('custom-check.mjs', 'process.exit(0)\n// changed verification\n')
  const before = lines()
  const result = close(r.id, { f1: { status: 'fixed' } }, ['--test-cmd', 'true'])
  assert.notEqual(result.status, 0, result.out)
  assert.match(result.out, /run --fix-check first/)
  assert.deepEqual(lines(), before)
})
test('L4 fix-check force rules inspect only the fix diff risk paths', () => {
  commit('auth/login.js', 'export const login = true\n')
  write('.claude/review-config.json', JSON.stringify({ force: [{ paths: 'risk', family: 'grok' }] }))
  const r = review({ REVIEW_REVIEWER: '' })
  assert.equal(r.family, 'grok')
  commit('a.js', 'export const a = 3\n')
  const result = run(['--fix-check', r.id], { REVIEW_REVIEWER: '', STUB_FINDINGS: '{"findings":[]}' })
  assert.equal(result.status, 0, result.out)
  assert.equal(lines().at(-1).family, 'sol')
})
test('L4 fix-check Jev stats contain only the original-head to closing-head changes', () => {
  commit('auth/login.js', 'export const login = true\n')
  const r = review()
  commit('a.js', 'export const a = 3\n')
  const result = run(['--fix-check', r.id], { REVIEW_REVIEWER: '', REVIEW_PICK: 'jev', STUB_FINDINGS: '{"findings":[]}' })
  assert.equal(result.status, 0, result.out)
  const { diff } = JSON.parse(readFileSync(JEV_LOG, 'utf8')).state
  assert.deepEqual(diff.paths, ['a.js'])
  assert.deepEqual(diff.risk_files, [])
  assert.equal(diff.files_changed, 1)
  assert.equal(diff.lines_added, 1)
  assert.equal(diff.lines_removed, 1)
})

function o1Output() {
  const result = run([], {
    REVIEW_VERIFY: 'second-opinion',
    STUB_FINDINGS: JSON.stringify({ findings: [
      { ...FINDING, issue: 'unlocated', severity: 'medium', quote: 'invented' },
      { ...FINDING, issue: 'confirmed' },
      { ...FINDING, issue: 'disputed', severity: 'medium' },
      { ...FINDING, issue: 'low', severity: 'low' },
    ] }),
    STUB_VERDICTS: JSON.stringify({ verdicts: [
      { index: 0, verdict: 'CONFIRMED', evidence: 'a.js:1 defect' },
      { index: 1, verdict: 'REFUTED', evidence: 'a.js:1 intentional' },
    ] }),
  })
  assert.equal(result.status, 0, result.out)
  const output = JSON.parse(result.stdout.split('===FINDINGS_JSON===')[1])
  const record = lines().at(-1)
  const md = readFileSync(join(REPO, output.reportPath), 'utf8')
  return { result, output, record, md }
}
test('O1 JSON findings, disputed and unverified expose the exact logged finding ids', () => {
  const { output, record } = o1Output()
  const all = [...output.findings, ...output.disputed, ...output.unverified]
  assert.deepEqual(all.map((f) => ({ ...f, unscored: true, reviewerSeverity: f.severity })), record.findingDetails)
  assert.deepEqual(all.map((f) => [f.issue, f.id]), [['confirmed', 'f1'], ['low', 'f2'], ['disputed', 'f3'], ['unlocated', 'f4']])
})
test('O1 every Markdown finding first line ends with its logged id across all sections', () => {
  const { md, record } = o1Output()
  const firstLines = md.split('\n').filter((line) => line.startsWith('- ['))
  assert.equal(firstLines.length, record.findingDetails.length)
  for (const finding of record.findingDetails)
    assert.ok(firstLines.includes(`- [${finding.file}:${finding.line}] ${finding.issue} (id ${finding.id})`), md)
})
test('O1 the review id has its own line in console, JSON and Markdown and matches the log', () => {
  const { result, output, record, md } = o1Output()
  assert.equal(output.reviewId, record.id)
  assert.ok(result.stdout.split('\n').includes(`Review ID: ${record.id}`), result.stdout)
  assert.ok(result.stdout.split('\n').some((line) => line.trim() === `"reviewId": "${record.id}",`), result.stdout)
  assert.ok(md.split('\n').includes(`Review ID: ${record.id}`), md)
  assert.equal(output.reportPath, `${record.dir}/code-review.md`)
})
test('O1 multiline finding descriptions keep the id at the end of their first Markdown line', () => {
  const result = run([], { STUB_FINDINGS: JSON.stringify({ findings: [{ ...FINDING, issue: 'summary\nadditional detail' }] }) })
  assert.equal(result.status, 0, result.out)
  const output = JSON.parse(result.stdout.split('===FINDINGS_JSON===')[1])
  const md = readFileSync(join(REPO, output.reportPath), 'utf8')
  assert.ok(md.split('\n').includes('- [a.js:1] summary (id f1)'), md)
  assert.ok(md.split('\n').includes('additional detail'), md)
  assert.equal(output.findings[0].issue, 'summary\nadditional detail')
})

test('Part A a review without repoId can close using its own REFUTED dispute', () => {
  const id = 'own-dispute-without-repo-id'
  seed({ type: 'review', kind: 'review', id, head: git('rev-parse', 'HEAD'), branch: 'feat', family: 'sol', model: 'stub-sol', vendor: 'codex', findingDetails: [{ ...FINDING, id: 'f1' }] },
    { type: 'dispute', review: id, finding: 'f1', verdict: 'REFUTED', verdictEvidence: 'a.js:1 intentional' })
  for (const reference of [{}, { refutedBy: { review: id, finding: 'f1' } }]) {
    const result = close(id, { f1: { status: 'rejected', reason: 'intentional', evidence: 'a.js:1', ...reference } }, ['--test-cmd', 'true'])
    assert.equal(result.status, 0, result.out)
    assert.equal(lines().at(-1).type, 'close')
    assert.equal(lines().at(-1).review, id)
  }
})

const gradeVerdict = () => ({ family: 'opus', model: 'stub-opus', criteria: [
  { id: '2.1', criterion: 'Preserve account', verdict: 'FAIL', evidence: 'account test fails' },
  { id: '2.2', criterion: 'Stable output', verdict: 'PASS', evidence: 'output test passes' },
] })
function gradeFile(value) {
  const path = join(ROOT, 'verdict.json')
  writeFileSync(path, JSON.stringify(value))
  return path
}
function logGrade(value = gradeVerdict(), args = []) {
  const result = run(['--log-grade', gradeFile(value), ...args])
  assert.equal(result.status, 0, result.out)
  return lines().at(-1)
}
test('2.1 Grade records preserve metadata, criteria and ordered findings without quote checks or models', () => {
  const value = { ...gradeVerdict(), effort: 'high', findings: [
    { severity: 'medium', issue: 'External defect', file: 'missing.js', line: 8, evidence: 'external defect test' },
    { severity: 'low', likelihood: 1, impact: 3, protected: false, trigger: 'edge input', issue: 'Another defect', evidence: 'edge test' },
  ] }
  const record = logGrade(value)
  assert.equal(record.type, 'review')
  assert.equal(record.kind, 'grade')
  assert.equal(record.head, git('rev-parse', 'HEAD'))
  assert.equal(record.baseSha, git('merge-base', 'main', 'HEAD'))
  assert.equal(record.branch, 'feat')
  assert.equal(record.repoId, realpathSync(join(REPO, '.git')))
  assert.equal(record.copy, SCRIPT)
  assert.equal(record.family, value.family)
  assert.equal(record.model, value.model)
  assert.equal(record.vendor, 'claude')
  assert.equal(record.effort, 'high')
  assert.deepEqual(record.criteria, value.criteria)
  assert.deepEqual(record.findingDetails.map((f) => [f.id, f.severity]), [['c1', 'high'], ['f2', 'medium'], ['f3', 'low']])
  assert.equal(record.findingDetails[0].criterionId, '2.1')
  assert.equal(record.findingDetails[0].criterion, 'Preserve account')
  assert.equal(record.findingDetails[0].evidence, 'account test fails')
  assert.ok(record.findingDetails.every((f) => f.status !== 'unverified-quote'))
  assert.equal(calls().length, 0)
})
test('2.1 Grade validation rejects malformed schemas, unknown keys and values, absent evidence and dirty trees', () => {
  const original = gradeVerdict()
  const cases = [null, [], {}, { ...original, family: '' }, { ...original, model: '' }, { ...original, criteria: [] },
    { ...original, unexpected: true }, { ...original, vendor: 'unknown' }, { ...original, effort: 4 },
    { ...original, criteria: [{ ...original.criteria[0], verdict: 'UNKNOWN' }] },
    { ...original, criteria: [{ ...original.criteria[0], evidence: '' }] },
    { ...original, criteria: [{ id: '2.1', criterion: 'Missing evidence', verdict: 'PASS' }] },
    { ...original, criteria: [{ ...original.criteria[0], unknown: true }] },
    { ...original, criteria: [original.criteria[0], original.criteria[0]] },
    { ...original, findings: [{ severity: 'high', issue: 'Bug' }] },
    { ...original, findings: [{ severity: 42, issue: 'Bug', evidence: 'test' }] },
    { ...original, findings: [{ severity: 'low', issue: 'Bug', evidence: 'test', quote: 'not permitted' }] },
  ]
  for (const value of cases) {
    const result = run(['--log-grade', gradeFile(value)])
    assert.notEqual(result.status, 0, result.out)
    assert.equal(lines().length, 0)
  }
  writeFileSync(join(ROOT, 'broken.json'), '{')
  assert.notEqual(run(['--log-grade', join(ROOT, 'broken.json')]).status, 0)
  write('a.js', 'dirty')
  const dirty = run(['--log-grade', gradeFile(original)])
  assert.notEqual(dirty.status, 0)
  assert.match(dirty.out, /Tracked working tree changes/)
  assert.equal(lines().length, 0)
  assert.equal(calls().length, 0)
})
test('2.1 Grade records use supplied vendor or require a derivable pool vendor', () => {
  const record = logGrade({ ...gradeVerdict(), family: 'outside-pool', vendor: 'codex' })
  assert.equal(record.vendor, 'codex')
  const before = lines()
  const result = run(['--log-grade', gradeFile({ ...gradeVerdict(), family: 'outside-pool' })])
  assert.notEqual(result.status, 0, result.out)
  assert.deepEqual(lines(), before)
})
test('2.1 Grade criterion disputes, waivers, close and summary use the existing lifecycle', () => {
  const record = logGrade({ ...gradeVerdict(), findings: [{ severity: 'medium', likelihood: 3, impact: 7, protected: false, trigger: 'external input', issue: 'External bug', evidence: 'external test' }] })
  const disputed = run(['--dispute', record.id, 'c1', '--reason', 'intent', '--evidence', 'account test'])
  assert.equal(disputed.status, 0, disputed.out)
  const prompt = calls().find((c) => c.prompt.includes('Judge this dispute')).prompt
  assert.match(prompt, /Grade criterion: Preserve account/)
  assert.match(prompt, /Criterion evidence: account test fails/)
  const waived = run(['--waive', record.id, 'f2', '--reason', 'accepted external bug'], {}, true)
  assert.equal(waived.status, 0, waived.out)
  const statuses = { c1: { status: 'rejected', reason: 'intentional criterion', evidence: 'account test' },
    f2: { status: 'rejected', reason: 'accept defect', evidence: 'external test' } }
  const closed = close(record.id, statuses, ['--test-cmd', 'true'])
  assert.equal(closed.status, 0, closed.out)
  const summary = run(['--summary'])
  assert.equal(summary.status, 0, summary.out)
  for (const text of ['Reviewer: opus', '2 findings', '2 rejected', 'intentional criterion', 'accepted external bug'])
    assert.ok(summary.stdout.includes(text), summary.out)
})
test('2.1 a passing Grade still needs a close and additional findings need statuses', () => {
  const value = gradeVerdict()
  value.criteria[0].verdict = 'PASS'
  const record = logGrade({ ...value, findings: [{ severity: 'low', issue: 'Fix this', file: 'a.js', evidence: 'edge test' }] })
  assert.notEqual(run(['--summary']).status, 0)
  assert.notEqual(close(record.id, {}, ['--test-cmd', 'true']).status, 0)
  const closed = close(record.id, { f1: { status: 'fixed' } }, ['--test-cmd', 'true'])
  assert.equal(closed.status, 0, closed.out)
})

const recheckVerdict = (verdict = 'PASS') => ({ ...gradeVerdict(), criteria: [
  { ...gradeVerdict().criteria[0], verdict, evidence: 'account recheck evidence' },
] })
test('2.2 one recheck supplies fixed-criterion evidence and needs no close of its own', () => {
  const original = logGrade()
  const statuses = { c1: { status: 'fixed' } }
  assert.notEqual(close(original.id, statuses, ['--test-cmd', 'true']).status, 0)
  const recheck = logGrade(recheckVerdict(), ['--recheck-of', original.id])
  assert.equal(recheck.kind, 'recheck')
  assert.equal(recheck.review, original.id)
  assert.deepEqual(recheck.criteria.map((c) => c.id), ['2.1'])
  assert.deepEqual(recheck.findingDetails, [])
  assert.notEqual(close(recheck.id, {}, ['--test-cmd', 'true']).status, 0)
  const closed = close(original.id, statuses, ['--test-cmd', 'true'])
  assert.equal(closed.status, 0, closed.out)
  assert.equal(lines().at(-1).recheck, recheck.id)
  assert.equal(lines().at(-1).statuses.c1.evidence, 'account recheck evidence')
  const before = lines()
  const second = run(['--log-grade', gradeFile(recheckVerdict()), '--recheck-of', original.id])
  assert.notEqual(second.status, 0, second.out)
  assert.deepEqual(lines(), before)
  assert.equal(calls().length, 0)
})
test('2.2 rechecks reject unknown targets, non-FAIL ids, changed criteria, other branches and dirty trees', () => {
  const original = logGrade()
  const before = lines()
  for (const value of [
    { ...recheckVerdict(), criteria: [{ ...gradeVerdict().criteria[1] }] },
    { ...recheckVerdict(), criteria: [{ ...recheckVerdict().criteria[0], id: 'unknown' }] },
    { ...recheckVerdict(), criteria: [{ ...recheckVerdict().criteria[0], criterion: 'Different criterion' }] },
  ]) {
    assert.notEqual(run(['--log-grade', gradeFile(value), '--recheck-of', original.id]).status, 0)
    assert.deepEqual(lines(), before)
  }
  assert.notEqual(run(['--log-grade', gradeFile(recheckVerdict()), '--recheck-of', 'missing']).status, 0)
  const ordinary = review()
  const withOrdinary = lines()
  assert.notEqual(run(['--log-grade', gradeFile(recheckVerdict()), '--recheck-of', ordinary.id]).status, 0)
  assert.deepEqual(lines(), withOrdinary)
  git('checkout', '-qb', 'other-grade-branch')
  assert.notEqual(run(['--log-grade', gradeFile(recheckVerdict()), '--recheck-of', original.id]).status, 0)
  assert.deepEqual(lines(), withOrdinary)
  git('checkout', 'feat')
  write('a.js', 'dirty')
  assert.notEqual(run(['--log-grade', gradeFile(recheckVerdict()), '--recheck-of', original.id]).status, 0)
  assert.deepEqual(lines(), withOrdinary)
})
test('2.2 a recheck FAIL cannot be fixed and needs dispute or waiver before close', () => {
  const original = logGrade()
  logGrade(recheckVerdict('FAIL'), ['--recheck-of', original.id])
  assert.notEqual(close(original.id, { c1: { status: 'fixed', evidence: 'claimed pass' } }, ['--test-cmd', 'true']).status, 0)
  const rejected = { c1: { status: 'rejected', reason: 'accept bug', evidence: 'account test' } }
  assert.notEqual(close(original.id, rejected, ['--test-cmd', 'true']).status, 0)
  const waived = run(['--waive', original.id, 'c1', '--reason', 'accepted criterion failure'], {}, true)
  assert.equal(waived.status, 0, waived.out)
  const closed = close(original.id, rejected, ['--test-cmd', 'true'])
  assert.equal(closed.status, 0, closed.out)
})
test('2.2 recheck findings join original close statuses, disputes, summary and decided context', () => {
  const original = logGrade()
  const recheck = logGrade({ ...recheckVerdict(), findings: [{ severity: 'medium', issue: 'New recheck defect', evidence: 'new defect test' }] }, ['--recheck-of', original.id])
  assert.deepEqual(recheck.findingDetails.map((f) => f.id), ['r1'])
  assert.notEqual(close(original.id, { c1: { status: 'fixed' } }, ['--test-cmd', 'true']).status, 0)
  const dispute = run(['--dispute', recheck.id, 'r1', '--reason', 'intended', '--evidence', 'new defect test'])
  assert.equal(dispute.status, 0, dispute.out)
  const statuses = { c1: { status: 'fixed' }, r1: { status: 'rejected', reason: 'intended recheck behavior', evidence: 'new defect test' } }
  const closed = close(original.id, statuses, ['--test-cmd', 'true'])
  assert.equal(closed.status, 0, closed.out)
  const summary = run(['--summary'])
  assert.equal(summary.status, 0, summary.out)
  assert.match(summary.stdout, /2 findings/)
  assert.match(summary.stdout, /New recheck defect: intended recheck behavior/)
  review()
  assert.ok(calls().some((c) => c.prompt.includes('Already decided;') && c.prompt.includes('New recheck defect')))
})
test('2.2 recheck evidence cannot close a commit older than the checked head', () => {
  const original = logGrade()
  commit('a.js', 'export const a = 3\n')
  const recheck = logGrade(recheckVerdict(), ['--recheck-of', original.id])
  git('reset', '--hard', original.head)
  const before = lines()
  assert.notEqual(close(original.id, { c1: { status: 'fixed' } }, ['--test-cmd', 'true']).status, 0)
  assert.deepEqual(lines(), before)
  git('reset', '--hard', recheck.head)
  assert.equal(close(original.id, { c1: { status: 'fixed' } }, ['--test-cmd', 'true']).status, 0)
})

test('5.2 scores file risk at the boundary, protect sensitive bugs and preserve unscored shapes', () => {
  const variants = [
    { likelihood: 2, impact: 5, protected: false, trigger: 'normal fixture input' },
    { likelihood: 1, impact: 10, protected: true, trigger: 'normal fixture input' },
    { likelihood: 3, impact: 4, protected: false, trigger: 'normal fixture input' },
    {}, { likelihood: '2', impact: 5, protected: false, trigger: 'normal fixture input' },
    { likelihood: 0, impact: 5, protected: false, trigger: 'normal fixture input' },
    { likelihood: 11, impact: 1, protected: false, trigger: 'normal fixture input' },
    { likelihood: 1.5, impact: 5, protected: false, trigger: 'normal fixture input' },
    { likelihood: 1, impact: 1 },
    { likelihood: 1, impact: null, protected: false, trigger: 'normal fixture input' },
  ]
  const r = review({ STUB_FINDINGS: JSON.stringify({ findings: variants.map((v) => ({ ...FINDING, ...v })) }) })
  assert.deepEqual(r.findingDetails.map((f) => !!f.filed), [true, false, false, false, false, false, false, false, false, false])
  assert.equal(r.findingDetails[0].risk, 10); assert.equal(r.findingDetails[1].risk, 10)
  assert.deepEqual(r.findingDetails[3], { ...FINDING, status: 'verified-quote', id: 'f4', unscored: true, reviewerSeverity: 'high' })
  const prompt = calls().at(-1).prompt
  assert.match(prompt, /likelihood/); assert.match(prompt, /impact/); assert.match(prompt, /protected/)
  assert.match(prompt, /risk.*10/); assert.match(prompt, /concrete input, command or call path/)
})

test('5.2 filed findings need no close status, supplied scores cannot be changed and Cris may fix one', () => {
  const r = review({ STUB_FINDINGS: JSON.stringify({ findings: [{ ...FINDING, likelihood: 1, impact: 2, protected: false, trigger: 'normal fixture input' }] }) })
  const closed = close(r.id, {}, ['--test-cmd', 'true']); assert.equal(closed.status, 0, closed.out)
  const bad = close(r.id, { f1: { status: 'fixed', likelihood: 2 } }, ['--test-cmd', 'true'])
  assert.notEqual(bad.status, 0); assert.match(bad.out, /Unknown status field/)
  commit('a.js', 'export const a = 3\n')
  const fixed = close(r.id, { f1: { status: 'fixed' } }, ['--test-cmd', 'true'])
  assert.equal(fixed.status, 0, fixed.out); assert.equal(lines().at(-1).status, 'complete')
})

test('5.2 filed findings are already decided before close and fix-check findings are scored too', () => {
  const r = review({ STUB_FINDINGS: JSON.stringify({ findings: [{ ...FINDING, likelihood: 1, impact: 2, protected: false, trigger: 'normal fixture input' }] }) })
  review({ STUB_FINDINGS: '{"findings":[]}' })
  assert.ok(calls().some((c) => c.prompt.includes('Already decided') && c.prompt.includes(r.id) && c.prompt.includes('"filed":true')))
  commit('a.js', 'export const a = 3\n')
  const check = run(['--fix-check', r.id], { STUB_FINDINGS: JSON.stringify({ findings: [{ ...FINDING, quote: 'export const a = 3', likelihood: 1, impact: 1, protected: false, trigger: 'normal fixture input' }] }) })
  assert.equal(check.status, 0, check.out); assert.equal(lines().at(-1).findingDetails[0].filed, true)
  const closed = close(r.id, { f1: { status: 'fixed' } }, ['--test-cmd', 'true'])
  assert.equal(closed.status, 0, closed.out)
})

test('5.3 summary and deferred show ids, date, risk, severity, location and trigger; repo filter and newest first', () => {
  const r = review({ STUB_FINDINGS: JSON.stringify({ findings: [{ ...FINDING, issue: 'Trigger: empty input returns the wrong value', likelihood: 2, impact: 3, protected: false, trigger: 'normal fixture input' }] }) })
  assert.equal(close(r.id, {}, ['--test-cmd', 'true']).status, 0)
  const summary = run(['--summary']); assert.equal(summary.status, 0, summary.out)
  assert.match(summary.stdout, /Deferred findings/); assert.match(summary.stdout, /risk 6.*LOW.*a.js:1/)
  assert.match(summary.stdout, /Trigger: empty input/)
  seed({ ...r, id: 'foreign-review', repoId: '/other/repo/.git', ts: '2099-01-01T00:00:00Z' },
    { ...r, id: 'newest-local', branch: 'another-branch', ts: '2098-01-01T00:00:00Z' })
  const count = calls().length
  const local = run(['--deferred']); assert.equal(local.status, 0, local.out)
  assert.ok(local.stdout.indexOf('newest-local') < local.stdout.indexOf(r.id))
  assert.doesNotMatch(local.stdout, /foreign-review/)
  for (const value of [r.id, r.ts, 'risk 6', 'LOW', 'a.js:1', 'empty input', 'Trigger:']) assert.ok(local.stdout.includes(value), value)
  const all = run(['--deferred', '--all']); assert.equal(all.status, 0, all.out)
  assert.ok(all.stdout.indexOf('foreign-review') < all.stdout.indexOf('newest-local'))
  assert.equal(calls().length, count, '--deferred invokes no model')
})

test('5.4 log writes follow the precedence: ACS folder, then ~/.claude/review-log/, then the old file', () => {
  const oldFile = join(HOME, '.claude/review-log.jsonl'), claudeDir = join(HOME, '.claude/review-log')
  const read = (p) => readFileSync(p, 'utf8').trim().split('\n').map(JSON.parse)
  mkdirSync(dirname(oldFile), { recursive: true }); writeFileSync(oldFile, '')
  const old = run(); assert.equal(old.status, 0, old.out)
  assert.equal(read(oldFile).length, 1); assert.equal(existsSync(LOG), false)
  mkdirSync(claudeDir)
  const middle = run(); assert.equal(middle.status, 0, middle.out)
  const inClaudeDir = read(join(claudeDir, 'review-log.jsonl'))
  assert.equal(inClaudeDir.length, 1); assert.notEqual(inClaudeDir[0].id, read(oldFile)[0].id)
  assert.equal(read(oldFile).length, 1, 'old log was not written after opting into the new directory')
  mkdirSync(dirname(LOG), { recursive: true })
  const r = review()
  assert.equal(lines().length, 1); assert.equal(lines()[0].id, r.id)
  assert.equal(read(join(claudeDir, 'review-log.jsonl')).length, 1, '~/.claude/review-log/ was not written after the ACS folder appeared')
  assert.equal(read(oldFile).length, 1)
})

test('5.2 Grade FAIL criteria are never filed and still require resolution', () => {
  const r = logGrade()
  assert.equal(r.findingDetails[0].criterionId, '2.1')
  assert.equal(Object.hasOwn(r.findingDetails[0], 'filed'), false)
  const unresolved = close(r.id, {}, ['--test-cmd', 'true'])
  assert.notEqual(unresolved.status, 0); assert.match(unresolved.out, /Finding c1 needs a fixed or rejected status/)
  assert.doesNotMatch(run(['--deferred']).stdout, /Preserve account/)
})

test('5.2 scored disputed and filed unverified findings and preserves identical ids in outputs and log', () => {
  const finding = { ...FINDING, likelihood: 1, impact: 1, protected: false, trigger: 'normal fixture input' }
  const r = run([], { REVIEW_VERIFY: 'second-opinion', STUB_FINDINGS: JSON.stringify({ findings: [{ ...finding, likelihood: 7, impact: 7 }, { ...finding, quote: 'missing code' }] }) })
  assert.equal(r.status, 0, r.out)
  const output = JSON.parse(r.stdout.split('===FINDINGS_JSON===')[1]), record = lines().at(-1)
  assert.equal(output.disputed.length, 1); assert.equal(output.unverified.length, 1)
  assert.deepEqual([...output.disputed, ...output.unverified], record.findingDetails)
  assert.deepEqual(record.findingDetails.map((f) => [f.filed, f.risk]), [[false, 49], [true, 1]])
  const result = close(record.id, { f1: { status: 'rejected', reason: 'refuted', evidence: 'a.js:1' } }, ['--test-cmd', 'true']); assert.equal(result.status, 0, result.out)
  const summary = run(['--summary']); assert.equal(summary.status, 0, summary.out)
  assert.match(summary.stdout, /Carried unlocated f2/); assert.match(summary.stdout, /Deferred findings/)
})

test('5.3 fixed filed findings leave the deferred list and summary; foreign repo decisions stay out of context', () => {
  const r = review({ STUB_FINDINGS: JSON.stringify({ findings: [{ ...FINDING, likelihood: 1, impact: 1, protected: false, trigger: 'normal fixture input' }] }) })
  assert.equal(close(r.id, { f1: { status: 'fixed' } }, ['--test-cmd', 'true']).status, 0)
  assert.doesNotMatch(run(['--deferred']).stdout, /wrong return/)
  assert.match(run(['--summary']).stdout, /Deferred findings\nnone/)
  seed({ ...r, id: 'foreign-decision', repoId: '/foreign/.git', findingDetails: [{ ...r.findingDetails[0], issue: 'foreign-only filed bug' }] })
  review({ STUB_FINDINGS: '{"findings":[]}' })
  assert.ok(calls().every((c) => !c.prompt.includes('foreign-only filed bug')))
})

test('5.3 both skill copies and global instruction files require the deferred PR paper trail', () => {
  const source = resolve(dirname(SCRIPT), '../..')
  // The instruction block is the one file the instructions part puts into both global instruction files.
  for (const path of ['build/skills/claude/build/SKILL.md', 'build/skills/codex/build/SKILL.md', 'review-gate/skills/claude/code-review/SKILL.md', 'review-gate/skills/codex/code-review/SKILL.md', 'review-gate/instructions/review-gate.md']) {
    const text = readFileSync(join(source, path), 'utf8')
    assert.ok(text.includes('**Deferred findings**'), path)
    assert.ok(text.includes('node <review.mjs> --deferred'), path)
    assert.ok(text.includes('gh pr list --state merged --search "Deferred findings in:body"'), path)
    assert.doesNotMatch(text, /File LOW, don't fix it/, path)
  }
})

const SCORED = { ...FINDING, likelihood: 5, impact: 5, protected: false, trigger: 'supported fixture command' }
test('6.1 severity derives from scores at both boundaries and protected is always HIGH; labels are comparison only', () => {
  const scores = [{ likelihood: 2, impact: 5 }, { likelihood: 3, impact: 4 }, { likelihood: 5, impact: 7 }, { likelihood: 5, impact: 8 }, { likelihood: 1, impact: 1, protected: true }]
  const r = review({ STUB_FINDINGS: JSON.stringify({ findings: scores.map((f) => ({ ...SCORED, severity: 'low', ...f })) }) })
  assert.deepEqual(r.findingDetails.map((f) => [f.risk, f.severity, f.filed]), [[10, 'low', true], [12, 'medium', false], [35, 'medium', false], [40, 'high', false], [1, 'high', false]])
  assert.ok(r.findingDetails.every((f) => f.reviewerSeverity === 'low'))
  assert.equal(r.rubricVersion, '2026-10-29.2'); assert.deepEqual(r.rescored, { asked: 0, scored: 0 })
  const schema = calls().find((c) => c.schema.properties.findings).schema.properties.findings.items
  assert.equal(Object.hasOwn(schema.properties, 'severity'), false)
  for (const key of ['likelihood', 'impact', 'protected', 'trigger']) {
    assert.ok(schema.required.includes(key)); assert.equal(Array.isArray(schema.properties[key].type), false)
  }
  const blockingLowLabel = close(r.id, { f2: { status: 'rejected', reason: 'label low', evidence: 'test' }, f3: { status: 'fixed' }, f4: { status: 'fixed' }, f5: { status: 'fixed' } }, ['--test-cmd', 'true'])
  assert.notEqual(blockingLowLabel.status, 0); assert.match(blockingLowLabel.out, /REFUTED/)
})

test('6.2 and 6.3 one rubric contains every anchor and exactly the four narrow protected cases', () => {
  const text = run(['--rubric']); assert.equal(text.status, 0, text.out)
  for (const phrase of ['1: no path', '3: a named, uncommon', '5: a regular optional', '7: most uses', '10: every use', '1: cosmetic', '3: friction', '5: one visible', '7: silently wrong', "10: can't be undone", 'No real trigger means likelihood 1', 'A failure nobody would notice scores one band higher', 'reachable, exploitable security hole', 'revert, reflog, trash or a re-run', 'wrong money', "in the gate's own logic", 'risk >= 40', 'risk <= 10']) assert.ok(text.stdout.includes(phrase), phrase)
  assert.match(text.stdout, /A command phrasing the agent guard \(agent-guard\) doesn't\s+recognize is not protected/)
  assert.match(text.stdout, /score it by likelihood × impact like any other bug, because the guard\s+is an accident barrier/)
  assert.doesNotMatch(text.stdout, /^- any way around the review gate\.$/m)
  review({ STUB_FINDINGS: JSON.stringify({ findings: [SCORED] }) })
  const rubric = text.stdout.split('\n').slice(1).join('\n').trim()
  assert.ok(calls().some((c) => c.prompt.includes(rubric)))
  assert.ok(calls().every((c) => !c.prompt.includes('Return findings with severity')))
})

test('6.4 exactly one same-reviewer score follow-up merges valid indexed answers before quote checks and verification', () => {
  const { severity, ...scored } = SCORED
  const r = review({ REVIEW_VERIFY: 'second-opinion', STUB_FINDINGS: JSON.stringify({ findings: [
    { ...scored, likelihood: 'bad' }, { ...scored, trigger: '  ' }, { ...scored, impact: 0 }, { ...scored, protected: true, likelihood: null }, FINDING,
  ].map((f, i) => ({ ...f, issue: 'score-' + i })) }), STUB_SCORES: JSON.stringify({ scores: [
    { index: 0, likelihood: 1, impact: 1, protected: false, trigger: 'named recovered trigger' },
    { index: 1, likelihood: 4, impact: 5, protected: false, trigger: 'fixed trigger' },
    { index: 2, likelihood: 1.5, impact: 2, protected: false, trigger: 'invalid' },
    { index: 999, likelihood: 1, impact: 1, protected: false, trigger: 'ignore' },
  ] }) })
  assert.deepEqual(r.rescored, { asked: 4, scored: 2 })
  assert.deepEqual(Array.from({ length: 5 }, (_, i) => r.findingDetails.find((f) => f.issue === 'score-' + i)).map((f) => [f.severity, !!f.unscored, !!f.filed]), [['low', false, true], ['medium', false, false], ['medium', true, false], ['high', true, false], ['high', true, false]])
  const followups = calls().filter((c) => c.schema.properties.scores)
  assert.equal(followups.length, 1)
  assert.equal(followups[0].a.includes('--output-schema'), true, 'same Codex reviewer')
  assert.ok(followups[0].prompt.includes('"index":3'))
  assert.ok(!followups[0].prompt.includes('"index":4'), 'legacy finding not re-asked')
  assert.ok(calls().some((c) => c.schema.properties.verdicts && !c.prompt.includes('named recovered trigger')))
})

test('6.4 failed score follow-up keeps findings blocking and legacy LOW needs REFUTED or waiver', () => {
  const r = review({ STUB_SCORE_FAIL: '1', STUB_FINDINGS: JSON.stringify({ findings: [
    { ...SCORED, impact: 11 }, { ...SCORED, protected: true, trigger: '' }, { ...FINDING, severity: 'low' },
  ] }) })
  assert.deepEqual(r.rescored, { asked: 2, scored: 0 })
  assert.deepEqual(r.findingDetails.map((f) => [f.severity, f.unscored, !!f.filed]), [['medium', true, false], ['high', true, false], ['low', true, false]])
  const values = { f1: { status: 'fixed' }, f2: { status: 'fixed' }, f3: { status: 'rejected', reason: 'legacy low', evidence: 'a.js:1' } }
  const refused = close(r.id, values, ['--test-cmd', 'true']); assert.notEqual(refused.status, 0); assert.match(refused.out, /REFUTED/)
  seed({ type: 'dispute', review: r.id, finding: 'f3', verdict: 'REFUTED' })
  const accepted = close(r.id, values, ['--test-cmd', 'true']); assert.equal(accepted.status, 0, accepted.out)
  assert.match(run(['--summary']).stdout, /f3 LOW wrong return: legacy low/)
})

test('6.1 and 6.4 Grade and recheck derive extra findings without calls and every record is versioned', () => {
  const { severity, quote, suggestion, ...plain } = SCORED
  const scores = { ...plain, evidence: 'fixture evidence' }
  const g = logGrade({ ...gradeVerdict(), findings: [scores, { ...scores, severity: 'low', protected: true, impact: null }] })
  assert.deepEqual(g.findingDetails.map((f) => [f.severity, !!f.unscored, !!f.filed]), [['high', false, false], ['medium', false, false], ['high', true, false]])
  assert.equal(Object.hasOwn(g.findingDetails[1], 'reviewerSeverity'), false)
  assert.equal(g.findingDetails[2].reviewerSeverity, 'low')
  assert.equal(g.rubricVersion, '2026-10-29.2'); assert.equal(calls().length, 0)
  const rc = logGrade({ ...recheckVerdict(), findings: [{ issue: 'Missing scores', evidence: 'fixture test' }] }, ['--recheck-of', g.id])
  assert.equal(rc.findingDetails[0].severity, 'medium'); assert.equal(rc.findingDetails[0].unscored, true)
  assert.equal(rc.rubricVersion, g.rubricVersion); assert.equal(calls().length, 0)
})

test('6.4 fix-check uses the identical rubric and one re-ask, retaining unscored HIGH if protected', () => {
  const r = review(); commit('a.js', 'export const a = 3\n')
  const result = run(['--fix-check', r.id], { STUB_FINDINGS: JSON.stringify({ findings: [{ ...SCORED, quote: 'export const a = 3', trigger: '' }] }), STUB_SCORES: JSON.stringify({ scores: [{ index: 0, likelihood: 1, impact: 1, protected: true, trigger: 'gate bypass' }] }) })
  assert.equal(result.status, 0, result.out)
  const check = lines().at(-1)
  assert.deepEqual(check.rescored, { asked: 1, scored: 1 }); assert.equal(check.rubricVersion, '2026-10-29.2')
  assert.equal(check.findingDetails[0].severity, 'high'); assert.equal(check.findingDetails[0].filed, false)
  const rubric = run(['--rubric']).stdout.split('\n').slice(1).join('\n').trim()
  assert.ok(calls().filter((c) => c.schema.properties.scores || c.prompt.startsWith('Fix check:')).every((c) => c.prompt.includes(rubric)))
})

test('6.5 summary gathers every kind on the same branch and repo using each latest close and stored bands', () => {
  const base = review({ STUB_FINDINGS: '{"findings":[]}' }), head = git('rev-parse', 'HEAD')
  const finding = { id: 'f1', issue: 'historically filed issue', severity: 'high', filed: true, risk: 3, file: 'a.js', line: 1 }
  for (const [id, kind] of [['previous', 'review'], ['check', 'fix-check'], ['recheck', 'recheck'], ['grade', 'grade']])
    seed({ ...base, id, kind, findingDetails: [{ ...finding, trigger: id + ' trigger' }] })
  seed({ type: 'close', review: 'previous', statuses: { f1: { status: 'fixed' } } },
    { type: 'close', review: 'previous', statuses: {} },
    { type: 'close', review: 'other-parent', fixCheck: 'check', statuses: { f1: { status: 'fixed' } } },
    { ...base, id: 'old-trigger', findingDetails: [finding] },
    { ...base, id: 'foreign', repoId: '/foreign', findingDetails: [{ ...finding, issue: 'foreign issue' }] },
    { ...base, id: 'other-branch', branch: 'elsewhere', findingDetails: [{ ...finding, issue: 'foreign branch issue' }] })
  assert.equal(close(base.id, {}, ['--test-cmd', 'true']).status, 0)
  const summary = run(['--summary']); assert.equal(summary.status, 0, summary.out)
  for (const trigger of ['previous trigger', 'recheck trigger', 'grade trigger', 'trigger not recorded']) assert.ok(summary.stdout.includes(trigger), summary.stdout)
  assert.doesNotMatch(summary.stdout, /Trigger: check trigger|foreign issue|foreign branch issue/)
  assert.match(summary.stdout, /risk 3 HIGH/)
  const oldLine = summary.stdout.split('\n').find((line) => line.includes('trigger not recorded'))
  assert.equal(oldLine.split('historically filed issue').length - 1, 1)
  assert.equal(lines().find((e) => e.id === 'previous').findingDetails[0].severity, 'high')
})

test('6.6 second opinion targets only unfiled findings, including unscored, while legacy LOW is skipped', () => {
  const r = run([], { REVIEW_VERIFY: 'second-opinion', STUB_FINDINGS: JSON.stringify({ findings: [
    { ...SCORED, issue: 'filed derived low', likelihood: 1, impact: 1 },
    { ...SCORED, issue: 'derived medium', severity: 'low' },
    { ...SCORED, issue: 'unscored medium', impact: null },
    { ...FINDING, issue: 'legacy low', severity: 'low' },
  ] }), STUB_VERDICTS: '{"verdicts":[]}' })
  assert.equal(r.status, 0, r.out); assert.match(r.stdout, /on 2 HIGH\/MEDIUM finding/)
  const prompt = calls().find((c) => c.schema.properties.verdicts).prompt
  assert.match(prompt, /derived medium/); assert.match(prompt, /unscored medium/)
  assert.doesNotMatch(prompt, /filed derived low|legacy low/)
})

test('6.7 calibration is model-free, checks all eight rows, bands, numeric risk and rubric version', () => {
  const result = run(['--calibrate']); assert.equal(result.status, 0, result.out)
  assert.equal(result.stdout.split('\n').filter((line) => /derived.*expected/.test(line)).length, 8)
  const source = readFileSync(join(dirname(SCRIPT), 'calibration.md'), 'utf8'), file = join(ROOT, 'calibration.md')
  for (const text of [source.replace('2026-10-29.2', 'old-version'), source.replace('| 49 | HIGH |', '| 49 | LOW |'), source.replace('| 49 | HIGH |', '| 48 | HIGH |')]) {
    writeFileSync(file, text); assert.notEqual(run(['--calibrate', file]).status, 0)
  }
  assert.equal(calls().length, 0)
})

test('6.4 the multi-agent review re-asks only its lead family once', () => {
  const r = review({ REVIEW_REVIEWER: 'claude', STUB_FINDINGS: JSON.stringify({ findings: [{ ...SCORED, likelihood: null }] }),
    STUB_SCORES: JSON.stringify({ scores: [{ index: 0, likelihood: 5, impact: 5, protected: false, trigger: 'team trigger' }] }) })
  assert.deepEqual(r.rescored, { asked: 1, scored: 1 })
  const requests = calls().filter((c) => c.schema.properties.scores)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].a[requests[0].a.indexOf('--model') + 1], 'claude-stub-opus')
  assert.equal(r.findingDetails[0].severity, 'medium')
})

test('6.1 Grade and skill JSON contracts describe derived scores without changing phase or pass rules', () => {
  const root = resolve(dirname(SCRIPT), '../..')
  for (const name of ['build/skills/claude/build/SKILL.md', 'build/skills/codex/build/SKILL.md', 'review-gate/skills/claude/code-review/SKILL.md', 'review-gate/skills/codex/code-review/SKILL.md']) {
    const text = readFileSync(join(root, name), 'utf8')
    for (const part of ['likelihood', 'impact', 'protected', 'trigger', 'unscored', 'HIGH first, then MEDIUM', 'calibration.md', '--calibrate']) assert.ok(text.includes(part), `${name}: ${part}`)
    assert.doesNotMatch(text, /Keep the reviewer's severity|picks.*severity/)
    if (name.includes('/code-review/')) {
      assert.ok(text.includes("in the gate's own logic"), name)
      assert.match(text, /[Gg]uard command phrasings.*not protected.*likelihood × impact/)
    }
    if (name.includes('/build/')) {
      assert.match(text, /severity is optional|optional severity/)
      assert.match(text, /at most two review passes per phase|At most two review passes per phase/)
      assert.match(text, /recheck.*once|Recheck.*once/)
      const raw = name.includes('/codex/') ? text.replaceAll('\\"', '"') : text
      const start = raw.indexOf('{"family":"<resolved grader family>"'), end = raw.indexOf(']}', start) + 2
      // The nested criterion array ends first; the full example ends after findings.
      const findingStart = raw.indexOf('"findings":[', start), exampleEnd = raw.indexOf(']}', findingStart) + 2
      const contract = JSON.parse(raw.slice(start, exampleEnd))
      assert.equal(contract.findings[0].likelihood, 5); assert.equal(contract.findings[0].protected, false)
      assert.equal(Object.hasOwn(contract.findings[0], 'severity'), false)
    }
  }
})

function oldCloseRecord(id, kind = 'review', findingDetails = [{ ...FINDING, severity: 'low', filed: false, id: 'f1' }]) {
  return { type: 'review', kind, id, head: git('rev-parse', 'HEAD'), branch: 'feat', repoId: realpathSync(join(REPO, '.git')), family: 'fixture', model: 'fixture-only', findingDetails }
}
test('C2 pre-phase-6 LOW unfiled findings still need statuses but not REFUTED to reject', () => {
  const record = oldCloseRecord('old-low'); seed(record)
  const missing = close(record.id, {}, ['--test-cmd', 'true'])
  assert.notEqual(missing.status, 0, missing.out); assert.match(missing.out, /Finding f1 needs/)
  const accepted = close(record.id, { f1: { status: 'rejected', reason: 'ordinary LOW rejection', evidence: 'a.js:1' } }, ['--test-cmd', 'true'])
  assert.equal(accepted.status, 0, accepted.out)
  assert.doesNotMatch(run(['--summary']).stdout, /f1 LOW wrong return: ordinary LOW rejection/)
})
for (const kind of ['fix-check', 'recheck']) test(`C2 ${kind} findings use their own stored record version`, () => {
  const parent = { ...oldCloseRecord('parent-' + kind, 'grade', []), criteria: [], rubricVersion: '2026-10-29.2' }
  const child = { ...oldCloseRecord('child-' + kind, kind, [{ ...FINDING, id: kind === 'fix-check' ? 'x1' : 'r1', severity: 'low', filed: false }]), review: parent.id, criteria: [] }
  seed(parent, child)
  assert.notEqual(close(parent.id, {}, ['--test-cmd', 'true']).status, 0)
  const value = { [child.findingDetails[0].id]: { status: 'rejected', reason: 'old child LOW', evidence: 'a.js:1' } }
  const accepted = close(parent.id, value, ['--test-cmd', 'true']); assert.equal(accepted.status, 0, accepted.out)
  const oldParent = oldCloseRecord('old-parent-' + kind, 'grade', [])
  const modernChild = { ...child, id: 'modern-child-' + kind, review: oldParent.id, rubricVersion: '2026-10-29.2',
    findingDetails: child.findingDetails.map((f) => ({ ...f, unscored: true })) }
  seed(oldParent, modernChild)
  const rejected = close(oldParent.id, value, ['--test-cmd', 'true'])
  assert.notEqual(rejected.status, 0); assert.match(rejected.out, /REFUTED/)
  seed({ type: 'dispute', review: modernChild.id, finding: child.findingDetails[0].id, verdict: 'REFUTED' })
  assert.equal(close(oldParent.id, value, ['--test-cmd', 'true']).status, 0)
  assert.match(run(['--summary']).stdout, /LOW wrong return: old child LOW/)
})
test('C2 old stored rejection rules and summary ignore unscored metadata until the record is versioned', () => {
  const old = oldCloseRecord('old-summary', 'review', [{ ...FINDING, id: 'f1', severity: 'low', filed: false, unscored: true },
    { ...FINDING, id: 'f2', severity: 'medium', filed: false }, { ...FINDING, id: 'f3', severity: 'high', filed: true }])
  const statuses = { f1: { status: 'rejected', reason: 'old LOW', evidence: 'a.js:1' }, f2: { status: 'rejected', reason: 'old MEDIUM', evidence: 'a.js:1' } }
  seed(old, { type: 'close', review: old.id, closeHead: old.head, status: 'complete', statuses })
  const summary = run(['--summary']); assert.equal(summary.status, 0, summary.out)
  assert.doesNotMatch(summary.stdout, /LOW wrong return: old LOW/)
  assert.match(summary.stdout, /MEDIUM wrong return: old MEDIUM/)
  const refused = close(old.id, statuses, ['--test-cmd', 'true']); assert.notEqual(refused.status, 0); assert.match(refused.out, /REFUTED/)
  seed({ type: 'dispute', review: old.id, finding: 'f2', verdict: 'REFUTED' })
  const accepted = close(old.id, statuses, ['--test-cmd', 'true']); assert.equal(accepted.status, 0, accepted.out)
  assert.equal(lines().find((e) => e.id === old.id).findingDetails[2].filed, true)
})
