import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// The coverage rule and the fixed rule, both decided only from prompt manifests: a changed file counts as reviewed at the
// tip only when its exact [path, base state, head state] is in the read list of a manifest in the chain (review and fix
// check) of a close the tip descends from; a fixed blocking or protected finding needs the review's fix check to have been
// asked about it and to have read every path it cites. Stub CLIs record every prompt; temporary HOME and Git config; the
// push gate runs through the installed pre-push hook.
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime')
const ROOT = mkdtempSync(join(tmpdir(), 'review-coverrule-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), REMOTE = join(ROOT, 'remote.git')
const SKILL = join(HOME, '.agent-config-studio/review-gate'), SCRIPT = join(SKILL, 'review.mjs')
const LOG = join(HOME, '.agent-config-studio/review-log/review-log.jsonl'), BIN = join(ROOT, 'bin'), CALLS = join(ROOT, 'calls')
const MARKER = 'SECURITY REVIEW ONLY.'
mkdirSync(BIN)
const stub = (name, body) => {
  writeFileSync(join(BIN, name), `#!${process.execPath}\n${body}`)
  chmodSync(join(BIN, name), 0o755)
}
stub('model-id', `
const a = process.argv.slice(2), ids = { sol: 'gpt-stub-sol', opus: 'claude-stub-opus' }
const roles = { reviewer: 'sol,opus', security: 'opus,sol' }
if (a[0] === '--role') { const use = (roles[a[1]] || 'sol').split(','); console.log(JSON.stringify({ use, ids: use.map((f) => ids[f]) })) }
else if (a[0] === '--flavor') console.log(JSON.stringify({ flavor: { effort: 'high' } }))
else console.log(ids[a[0]] || 'stub-' + a[0])
`)
// STUB_FINDINGS / STUB_SEC_FINDINGS: the code and security replies, as JSON text (default: no findings).
const modelBody = `
const fs = require('node:fs'), path = require('node:path')
const a = process.argv.slice(2), cli = path.basename(process.argv[1])
if (a[0] === 'mcp') { console.log('[]'); process.exit(0) }
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8') : a[a.indexOf('--json-schema')+1]
const prompt = cli === 'codex' ? a.at(-1) : a[a.indexOf('-p')+1]
const kind = schema.includes('"scores"') ? 'scores' : schema.includes('"verdicts"') ? 'verdicts' : prompt.includes(${JSON.stringify(MARKER)}) ? 'security' : 'code'
fs.writeFileSync(path.join(${JSON.stringify(CALLS)}, process.pid + '-' + Date.now() + '.json'), JSON.stringify({ kind, prompt }))
const reply = kind === 'scores' ? '{"scores":[]}' : kind === 'verdicts' ? '{"verdicts":[]}'
  : kind === 'security' ? (process.env.STUB_SEC_FINDINGS || '{"findings":[]}') : (process.env.STUB_FINDINGS || '{"findings":[]}')
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1], reply)
else console.log(JSON.stringify({ structured_output: JSON.parse(reply), structuredOutput: JSON.parse(reply) }))
`
for (const name of ['codex', 'claude']) stub(name, modelBody)
stub('jev', 'process.exit(1)')
after(() => rmSync(ROOT, { recursive: true, force: true }))

const env = (extra = {}) => ({ HOME, CODEX_HOME: join(HOME, '.codex'), GROK_HOME: join(HOME, '.grok'), GIT_CONFIG_GLOBAL: join(HOME, 'isolated.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1', PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: ROOT, REVIEW_BASE: 'main', REVIEW_REVIEWER: 'sol', ...extra })
function run(command, args, extra = {}) {
  const r = spawnSync(command, args, { cwd: REPO, env: env(extra), encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
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
    if (text === null) { git('rm', '-q', path); continue }
    mkdirSync(dirname(join(REPO, path)), { recursive: true })
    writeFileSync(join(REPO, path), text)
    git('add', path)
  }
  git('commit', '-qm', message)
  return git('rev-parse', 'HEAD')
}
const records = () => existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const calls = () => readdirSync(CALLS).sort().map((p) => JSON.parse(readFileSync(join(CALLS, p), 'utf8')))
const allowed = (r) => assert.equal(r.status, 0, r.out)
const refused = (r, pattern) => { assert.notEqual(r.status, 0, r.out); if (pattern) assert.match(r.out, pattern) }
function blocked(r, pattern) {
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /Run \/code-review/)
  if (pattern) assert.match(r.out, pattern)
}
const homeConfig = (config) => writeFileSync(join(SKILL, 'config.json'), JSON.stringify(config))
const push = (ref = 'HEAD:refs/heads/feat') => run('git', ['push', 'origin', ref])
const findingsJson = (r) => JSON.parse(r.stdout.slice(r.stdout.indexOf('===FINDINGS_JSON===') + 19))
function review(extra = {}, args = []) {
  const r = script(args, extra)
  allowed(r)
  return records().find((e) => e.id === findingsJson(r).reviewId)
}
function fixCheck(id, extra = {}) {
  allowed(script(['--fix-check', id], extra))
  const check = records().at(-1)
  assert.equal(check.kind, 'fix-check')
  return check
}
function close(id, statuses = {}, extra = {}) {
  const path = join(ROOT, 'statuses.json')
  writeFileSync(path, JSON.stringify(statuses))
  const before = records().length
  const r = script(['--close', id, '--status', path, '--test-cmd', 'true'], extra)
  return { ...r, record: records().length > before ? records().at(-1) : null }
}
function closed(id, statuses, status = 'complete') {
  const r = close(id, statuses)
  allowed(r); assert.equal(r.record.type, 'close'); assert.equal(r.record.status, status, r.out)
  return r.record
}
const tierJson = () => JSON.parse(script(['--tier-json']).stdout)
const fixed = { status: 'fixed', response: 'real' }
const scored = (f) => ({ suggestion: 'fix it', likelihood: 5, impact: 5, protected: false, trigger: 'importing it', ...f })
const ONE = scored({ issue: 'one is wrong', file: 'src/one.js', line: '1', quote: 'export const one = 2' })

beforeEach(() => {
  for (const path of [HOME, REPO, REMOTE, CALLS]) rmSync(path, { recursive: true, force: true })
  mkdirSync(SKILL, { recursive: true }); mkdirSync(dirname(LOG), { recursive: true }); mkdirSync(REPO); mkdirSync(CALLS)
  copyFileSync(join(SOURCE, 'review.mjs'), SCRIPT)
  cpSync(join(SOURCE, 'hooks'), join(SKILL, 'hooks'), { recursive: true, verbatimSymlinks: true })
  git('init', '-q', '-b', 'main')
  commit({ 'README.md': 'base\n', 'src/one.js': 'export const one = 1\n', 'src/two.js': 'export const two = 1\n', 'src/base-only.js': 'export const one = 2 // here too\n',
    'docs/three.md': 'three\n' })
  git('init', '--bare', '-q', REMOTE)
  git('remote', 'add', 'origin', REMOTE)
  git('push', '-q', '--no-verify', 'origin', 'main')
  git('fetch', '-q', 'origin')
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  git('checkout', '-qb', 'feat')
  commit({ 'src/one.js': 'export const one = 2\n', 'src/two.js': 'export const two = 2\n', 'docs/three.md': 'three, edited\n' })
  allowed(run('sh', [join(SKILL, 'hooks/install-hook.sh'), REPO]))
})

// ── the fixed rule ──────────────────────────────────────────────────────────
test('x1 a protected finding fixed in another file is accepted: the fix check was asked about it and read its file, unchanged since the review', () => {
  const r = review({ STUB_FINDINGS: JSON.stringify({ findings: [{ ...ONE, protected: true }] }) })
  commit({ 'src/two.js': 'export const two = 3 // guards one\n' }, 'fix one through two')
  const check = fixCheck(r.id)
  assert.deepEqual(check.asked, ['f1'])
  assert.ok(check.manifest.read.some(([p]) => p === 'src/one.js'), 'the cited file is read again from the base, though the fix did not touch it')
  closed(r.id, { f1: fixed })
  allowed(push())
})

test('x1 a blocking fixed finding needs the fix check: without one the close refuses and names the run', () => {
  const r = review({ STUB_FINDINGS: JSON.stringify({ findings: [ONE] }) })
  commit({ 'src/one.js': 'export const one = 3\n' })
  refused(close(r.id, { f1: fixed }), new RegExp(`Fixed f1 needs a fix check.*--fix-check ${r.id}`))
  assert.equal(records().filter((e) => e.type === 'close').length, 0)
})

test('x3 a protected finding with no file (unlocated) is accepted once a fix check was asked about it, refused without one', () => {
  const lost = scored({ issue: 'something is off', file: 'src/nowhere.js', line: '1', quote: 'no such line', protected: true })
  const r = review({ STUB_FINDINGS: JSON.stringify({ findings: [lost] }) })
  assert.equal(r.findingDetails[0].status, 'unverified-quote')
  commit({ 'src/one.js': 'export const one = 3\n' })
  refused(close(r.id, { f1: fixed }), /Fixed f1 needs a fix check/)
  const check = fixCheck(r.id)
  assert.deepEqual(check.asked, ['f1'])
  closed(r.id, { f1: fixed })
})

test('x4 a filed protected finding marked fixed needs the fix check to have asked about it and read its file', () => {
  const rare = { ...ONE, protected: true, likelihood: 1, impact: 9 }
  const r = review({ STUB_FINDINGS: JSON.stringify({ findings: [rare] }) })
  assert.equal(r.findingDetails[0].filed, true)
  commit({ 'src/one.js': 'export const one = 3\n' })
  refused(close(r.id, { f1: fixed }), /Fixed f1 needs a fix check/)
  const check = fixCheck(r.id)
  assert.deepEqual(check.asked, ['f1'], 'the fix check is asked about the filed protected finding too')
  assert.ok(calls().at(-1).prompt.includes('f1 LOW src/one.js:1'), 'its prompt lists it')
  closed(r.id, { f1: fixed })
})

test('x5 grouped instances: a fixed status needs every changed instance path in the fix check\'s read list; an oversize one is refused, naming dispute or waive', () => {
  const pad = (n) => Array.from({ length: n }, (_, i) => `export const p${i} = ${i}`).join('\n') + '\n'
  commit({ 'src/huge.js': 'export const huge = 1\n' })
  const grouped = { ...ONE, instances: [
    { file: 'src/one.js', line: '1', quote: 'export const one = 2' },
    { file: 'src/two.js', line: '1', quote: 'export const two = 2' },
    { file: 'src/huge.js', line: '1', quote: 'export const huge = 1' }] }
  const r = review({ STUB_FINDINGS: JSON.stringify({ findings: [grouped] }) })
  assert.deepEqual(r.instancePaths.f1.sort(), ['src/huge.js', 'src/one.js', 'src/two.js'])
  commit({ 'src/one.js': 'export const one = 3\n', 'src/two.js': 'export const two = 3\n', 'src/huge.js': pad(200) })
  const check = fixCheck(r.id, { REVIEW_TEST_DIFF_CAP: '1500' })
  assert.ok(check.manifest.unread.some(([p, why]) => p === 'src/huge.js' && why === 'oversize'), JSON.stringify(check.manifest.unread))
  refused(close(r.id, { f1: fixed }), /Fixed f1: the fix check did not read src\/huge\.js \(oversize\).*dispute.*waive/s)
  assert.equal(records().filter((e) => e.type === 'close').length, 0)
})

test('x1 a blocking fix-check finding has no later reader: it is deferred, and its fix is unseen until a slice reads it', () => {
  const r = review()
  commit({ 'src/one.js': 'export const one = 3\n' })
  const x1 = scored({ issue: 'three is wrong', file: 'src/one.js', line: '1', quote: 'export const one = 3' })
  fixCheck(r.id, { STUB_FINDINGS: JSON.stringify({ findings: [x1] }) })
  commit({ 'src/one.js': 'export const one = 4\n' })
  const c = closed(r.id, { x1: { status: 'deferred', reason: 'fixed after the fix check; sliced at the tip' } }, 'partial')
  assert.deepEqual(c.unseen, ['src/one.js'])
})

// ── the coverage rule ───────────────────────────────────────────────────────
test('a test file edited after the fix check is unseen: the close is partial naming it, the push refuses it, and a slice at the tip closes it', () => {
  const r = review({ STUB_FINDINGS: JSON.stringify({ findings: [ONE] }) })
  commit({ 'src/one.js': 'export const one = 3\n' })
  fixCheck(r.id)
  commit({ 'tests/one.test.js': 'test("one", () => {})\n' })
  const c = closed(r.id, { f1: fixed }, 'partial')
  assert.deepEqual(c.unseen, ['tests/one.test.js'])
  assert.equal(Object.hasOwn(c, 'outOfScope'), false)
  assert.equal(Object.hasOwn(c, 'coverage'), false)
  blocked(push(), /tests\/one\.test\.js/)
  const slice = review({ REVIEW_PATHS: 'tests/one.test.js' })
  closed(slice.id, {})
  allowed(push())
})

test('a code commit after the fix check is no longer refused at close: it is unseen until a slice reads it', () => {
  const r = review()
  commit({ 'src/one.js': 'export const one = 3\n' })
  fixCheck(r.id)
  commit({ 'src/two.js': 'export const two = 9\n' })
  const c = closed(r.id, {}, 'partial')
  assert.deepEqual(c.unseen, ['src/two.js'])
  blocked(push(), /src\/two\.js/)
  closed(review({ REVIEW_PATHS: 'src/two.js' }).id, {})
  allowed(push())
})

test('a binary change is not read by any reviewer: the push goes through, the tier is HIGH and names it', () => {
  commit({ 'src/blob.dat': 'payload\u0000\u0001\n' })
  const r = review()
  assert.deepEqual(r.manifest.unread, [['src/blob.dat', 'binary']])
  const c = closed(r.id, {})
  assert.deepEqual(c.unseen, [])
  const tier = tierJson()
  assert.equal(tier.covered, true)
  assert.equal(tier.tier, 'high')
  assert.ok(tier.reasons.some((x) => /^not read by any reviewer: src\/blob\.dat/.test(x)), JSON.stringify(tier))
  const p = push()
  allowed(p)
  assert.match(p.out, /not read by any reviewer: src\/blob\.dat/)
})

test('a submodule pointer update is unreadable: it grants no coverage, the tier is HIGH and names it', () => {
  const root = git('rev-parse', 'main')
  mkdirSync(join(REPO, 'vendor/sub'), { recursive: true })
  git('update-index', '--add', '--cacheinfo', `160000,${root},vendor/sub`); git('commit', '-qm', 'submodule')
  const r = review()
  assert.deepEqual(r.manifest.unread, [['vendor/sub', 'submodule']])
  closed(r.id, {})
  const tier = tierJson()
  assert.equal(tier.tier, 'high')
  assert.ok(tier.reasons.some((x) => /^not read by any reviewer: vendor\/sub/.test(x)), JSON.stringify(tier))
})

test('a capped file is unseen: the push refuses naming it, and a slice of it at the tip lets the push through', () => {
  const pad = (n) => Array.from({ length: n }, (_, i) => `export const p${i} = ${i}`).join('\n') + '\n'
  commit({ 'docs/big.md': pad(60) })
  const r = review({ REVIEW_TEST_DIFF_CAP: '1500' })
  assert.ok(r.manifest.unread.some(([p, why]) => p === 'docs/big.md' && why === 'capped'), JSON.stringify(r.manifest.unread))
  const c = closed(r.id, {}, 'partial')
  assert.deepEqual(c.unseen, ['docs/big.md'])
  blocked(push(), /docs\/big\.md/)
  closed(review({ REVIEW_PATHS: 'docs/big.md', REVIEW_TEST_DIFF_CAP: '3000' }).id, {})
  allowed(push())
})

test('an oversize file is unreadable: the push goes through and the tier is HIGH', () => {
  const pad = (n) => Array.from({ length: n }, (_, i) => `export const p${i} = ${i}`).join('\n') + '\n'
  // Over the production cap on its own (about 150,000 characters of section), so no slice can ever read it.
  commit({ 'src/huge.js': pad(6000) })
  const r = review()
  assert.equal(r.manifest.cap, 120000)
  assert.ok(r.manifest.unread.some(([p, why]) => p === 'src/huge.js' && why === 'oversize'))
  assert.ok(!r.manifest.read.some(([p]) => p === 'src/huge.js'))
  closed(r.id, {})
  const tier = tierJson()
  assert.equal(tier.tier, 'high')
  assert.ok(tier.reasons.some((x) => /^not read by any reviewer: src\/huge\.js/.test(x)), JSON.stringify(tier))
  allowed(push())
})

test('a merge of main: a file both sides touched needs a fresh read, a file only main touched does not', () => {
  const r = review()
  closed(r.id, {})
  git('checkout', '-q', 'main')
  commit({ 'src/one.js': 'export const one = 1\nexport const extra = 1\n', 'README.md': 'base, moved on\n' })
  git('push', '-q', '--no-verify', 'origin', 'main'); git('fetch', '-q', 'origin')
  git('checkout', '-q', 'feat')
  git('merge', '--no-edit', '-q', '-X', 'ours', 'origin/main')
  const again = closed(r.id, {}, 'partial')
  assert.deepEqual(again.unseen, ['src/one.js'], 'two.js keeps its triple; README.md is main\'s alone')
  blocked(push(), /1 file\(s\) uncovered: src\/one\.js —/)
  closed(review({ REVIEW_PATHS: 'src/one.js' }).id, {})
  allowed(push())
})

test('security.run always with a docs-only change and no security pass: the tier is HIGH, the security pass did not read it', () => {
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'docs-only')
  commit({ 'docs/three.md': 'three, docs only\n' })
  homeConfig({ security: { run: 'always' } })
  const r = review({}, ['--code-only'])
  assert.equal(r.security.status, 'not-asked')
  closed(r.id, {})
  const tier = tierJson()
  assert.equal(tier.covered, true)
  assert.equal(tier.tier, 'high')
  assert.ok(tier.reasons.some((x) => /^security pass did not read: docs\/three\.md/.test(x)), JSON.stringify(tier))
})

test('a security pass that read every owed file keeps the security reason out of the tier', () => {
  homeConfig({ security: { run: 'always' } })
  closed(review().id, {})
  const tier = tierJson()
  assert.ok(!tier.reasons.some((x) => /security pass/.test(x)), JSON.stringify(tier))
})

test('an old record grants no coverage: the push refuses, saying the close predates prompt manifests', () => {
  const head = git('rev-parse', 'HEAD'), base = git('merge-base', 'main', 'HEAD')
  const id = 'old-review-1', repoId = realpathSync(join(REPO, '.git'))
  appendFileSync(LOG, `${[
    { type: 'review', kind: 'review', id, head, baseSha: base, base: 'main', branch: 'feat', repo: 'repo', repoId, family: 'sol', model: 'gpt-stub-sol', findingDetails: [],
      truncated: [] },
    { type: 'close', review: id, closeHead: head, repoId, status: 'complete', statuses: {}, outOfScope: [], tests: { cmd: 'true', passed: true },
      coverage: [['docs/three.md', `100644 ${git('rev-parse', 'HEAD:docs/three.md')}`], ['src/one.js', `100644 ${git('rev-parse', 'HEAD:src/one.js')}`], ['src/two.js', `100644 ${git('rev-parse', 'HEAD:src/two.js')}`]],
      tier: 'medium', tierReasons: ['logic changed'] },
  ].map(JSON.stringify).join('\n')}\n`)
  blocked(push(), new RegExp(`close of review ${id} predates prompt manifests; run one fresh review at the tip`))
  refused(script(['--summary']), /predates prompt manifests/)
})

test('a failed security pass in the chain makes the tier HIGH, naming the pass', () => {
  homeConfig({ security: { run: 'always', timeoutMs: 3000 } })
  const r = review({ REVIEW_SECURITY_TEST_FAULT: 'exit' })
  assert.equal(r.security.status, 'failed')
  closed(r.id, {})
  const tier = tierJson()
  assert.equal(tier.tier, 'high')
  assert.ok(tier.reasons.some((x) => /^security pass failed/.test(x)), JSON.stringify(tier))
})

test('the fix check reads every file changed since the review in full from the base, and every cited file; the fix diff grants nothing', () => {
  homeConfig({ security: { run: 'always' } })
  const r = review({ STUB_FINDINGS: JSON.stringify({ findings: [ONE] }) })
  commit({ 'src/two.js': 'export const two = 3\n' })
  rmSync(CALLS, { recursive: true, force: true }); mkdirSync(CALLS)
  const check = fixCheck(r.id)
  const base = git('merge-base', 'main', 'HEAD')
  assert.equal(check.manifest.base, base, 'diffed from the coverage base, not the review head')
  assert.deepEqual(check.manifest.read.map(([p]) => p), ['src/one.js', 'src/two.js'])
  assert.deepEqual(check.security.manifest.read.map(([p]) => p), ['src/one.js', 'src/two.js'])
  for (const key of ['truncated', 'coverage', 'noRenames', 'onlyFiles']) assert.equal(Object.hasOwn(check, key), false, key)
  assert.equal(Object.hasOwn(check.security, 'saw'), false)
  const prompt = calls().find((c) => c.kind === 'code').prompt
  assert.ok(prompt.includes('-export const two = 1\n+export const two = 3'), 'the coverage block diffs two.js from the base')
  assert.ok(prompt.includes('-export const two = 2\n+export const two = 3'), 'the fix diff shows what moved since the review')
})

// ── Grade findings: carried to the tip review ───────────────────────────────
function grade(findings) {
  const path = join(ROOT, 'verdict.json')
  writeFileSync(path, JSON.stringify({ family: 'opus', model: 'claude-stub-opus', criteria: [{ id: 'c', criterion: 'works', verdict: 'PASS', evidence: 'tests pass' }], findings }))
  const r = script(['--log-grade', path])
  allowed(r)
  return records().at(-1)
}
const GRADE_FINDING = { issue: 'no check on two', evidence: 'two accepts anything', likelihood: 4, impact: 6, protected: true, trigger: 'calling two' }

test('x6 a Grade finding is carried, never fixed: refused until a tip review lists it among its open findings, which reach both reviewers', () => {
  homeConfig({ security: { run: 'always' } })
  const g = grade([GRADE_FINDING])
  assert.equal(g.findingDetails[0].id, 'f1')
  refused(close(g.id, { f1: fixed }), /Fixed f1 is a Grade finding: it is carried to the tip review/)
  refused(close(g.id, { f1: { status: 'carried' } }), /Carried f1 needs a review after the Grade that lists it among its open findings/)
  const open = script(['--open-findings'])
  allowed(open)
  assert.match(open.stdout, new RegExp(`no check on two \\(Grade ${g.id}, f1\\)`))
  rmSync(CALLS, { recursive: true, force: true }); mkdirSync(CALLS)
  const r = review()
  assert.deepEqual(r.openFindings, [{ record: g.id, id: 'f1' }])
  for (const kind of ['code', 'security']) assert.ok(calls().find((c) => c.kind === kind).prompt.includes('no check on two'), `the ${kind} prompt lists it`)
  const c = close(g.id, { f1: { status: 'carried' } })
  allowed(c)
  assert.equal(c.record.statuses.f1.status, 'carried')
  // Once its Grade is closed, a finding is no longer open.
  assert.doesNotMatch(script(['--open-findings']).stdout, /no check on two/)
})

test('x6 a closed review\'s findings are not open; an unclosed phase review\'s blocking findings are, and a filed unprotected one is not', () => {
  const low = scored({ issue: 'tiny nit', file: 'src/two.js', line: '1', quote: 'export const two = 2', likelihood: 1, impact: 2 })
  const phase = review({ STUB_FINDINGS: JSON.stringify({ findings: [ONE, low] }) })
  const open = script(['--open-findings']).stdout
  assert.match(open, new RegExp(`one is wrong \\(review ${phase.id}, f1\\)`))
  assert.doesNotMatch(open, /tiny nit/)
  commit({ 'src/one.js': 'export const one = 3\n' })
  fixCheck(phase.id)
  closed(phase.id, { f1: fixed })
  assert.match(script(['--open-findings']).stdout, /No open findings on feat/)
})

// ── PR 2 decisions ──────────────────────────────────────────────────────────
test('open findings: a --code-only review neither reads nor records them; a full review does', () => {
  const phase = review({ STUB_FINDINGS: JSON.stringify({ findings: [ONE] }) })
  rmSync(CALLS, { recursive: true, force: true }); mkdirSync(CALLS)
  const codeOnly = review({}, ['--code-only'])
  assert.equal(Object.hasOwn(codeOnly, 'openFindings'), false)
  assert.ok(!calls().find((c) => c.kind === 'code').prompt.includes('one is wrong'), 'a --code-only prompt is not handed open findings')
  rmSync(CALLS, { recursive: true, force: true }); mkdirSync(CALLS)
  const full = review()
  assert.deepEqual(full.openFindings, [{ record: phase.id, id: 'f1' }])
  assert.ok(calls().find((c) => c.kind === 'code').prompt.includes('one is wrong'))
})

test('a Grade close covers nothing and prints no slice hint; a LOW Grade finding marked fixed is refused, saying a LOW one needs no status', () => {
  const g = grade([{ ...GRADE_FINDING, protected: false, likelihood: 1, impact: 2 }])
  refused(close(g.id, { f1: fixed }), /Fixed f1 is a Grade finding.*a LOW one needs no status/s)
  const c = close(g.id, {})
  allowed(c)
  assert.equal(c.record.type, 'close')
  assert.ok(c.record.unseen.length, 'a Grade reads no diff, so its close covers nothing')
  assert.doesNotMatch(c.out, /REVIEW_PATHS=|Review exactly/)
  assert.ok(!c.record.tierReasons.some((x) => /not read by any reviewer|security pass/.test(x)), JSON.stringify(c.record.tierReasons))
})

test('coverage reasons stay out of a close\'s stored tier: the tip computes them once from every manifest', () => {
  commit({ 'src/blob.dat': 'payload\u0000\u0001\n' })
  homeConfig({ security: { run: 'always' } })
  const codeOnly = review({}, ['--code-only'])
  const first = closed(codeOnly.id, {})
  assert.ok(!first.tierReasons.some((x) => /not read by any reviewer|security pass did not read/.test(x)), JSON.stringify(first.tierReasons))
  // A second review at the same tip runs the security pass over every file the first one left unread by it.
  closed(review().id, {})
  const tier = tierJson()
  assert.ok(!tier.reasons.some((x) => /security pass did not read/.test(x)), JSON.stringify(tier))
  assert.ok(tier.reasons.some((x) => /^not read by any reviewer: src\/blob\.dat/.test(x)), JSON.stringify(tier))
})

test('the tier classifier is told the rules that are left: no partial-close rule, and a LOW close says only that tests passed', () => {
  const seen = join(ROOT, 'classifier-input.json')
  stub('tierstub', `require('node:fs').writeFileSync(${JSON.stringify(seen)}, require('node:fs').readFileSync(0, 'utf8'))
console.log(JSON.stringify({ answers: { tier: { type: 'choice', choice: 'medium', confidence: 0.9 } } }))`)
  homeConfig({ merge: { classifier: 'tierstub' } })
  closed(review().id, {})
  const rules = JSON.parse(readFileSync(seen, 'utf8')).state.rules
  assert.doesNotMatch(rules.high, /partial close/)
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'docs-only')
  commit({ 'docs/three.md': 'three, docs only\n' })
  const low = closed(review().id, {})
  assert.equal(low.tier, 'low')
  assert.ok(low.tierReasons.includes('tests passed') && !low.tierReasons.some((x) => /complete close/.test(x)), JSON.stringify(low.tierReasons))
})

test('a security finding on a path the security pass does not owe is judged by the fix check\'s code manifest', () => {
  homeConfig({ security: { run: 'required' } })
  const onDocs = scored({ issue: 'docs leak a token', file: 'docs/three.md', line: '1', quote: 'three, edited' })
  const r = review({ STUB_SEC_FINDINGS: JSON.stringify({ findings: [onDocs] }) })
  assert.equal(r.security.status, 'ran')
  const s1 = r.findingDetails.find((f) => f.source === 'security')
  assert.equal(s1.id, 's1')
  commit({ 'docs/three.md': 'three, scrubbed\n', 'src/one.js': 'export const one = 3\n' })
  const check = fixCheck(r.id)
  assert.equal(check.security.status, 'ran')
  assert.ok(!check.security.manifest.read.some(([p]) => p === 'docs/three.md'), 'a docs file is not owed under required')
  assert.ok(check.manifest.read.some(([p]) => p === 'docs/three.md'))
  closed(r.id, { s1: fixed })
})

test('a sliced review\'s fix check reads only the slice\'s scope, plus every cited file; builds/ and coverage-exempt files are left out', () => {
  const onTwo = scored({ issue: 'two is wrong', file: 'src/two.js', line: '1', quote: 'export const two = 2' })
  const r = review({ REVIEW_PATHS: 'src/one.js', STUB_FINDINGS: JSON.stringify({ findings: [onTwo] }) })
  commit({ 'src/one.js': 'export const one = 3\n', 'src/two.js': 'export const two = 3\n', 'docs/three.md': 'three, again\n', 'builds/x/log.md': 'log\n',
    'src/package-lock.json': '{}\n' })
  const check = fixCheck(r.id)
  assert.deepEqual(check.manifest.read.map(([p]) => p), ['src/one.js', 'src/two.js'])
})

test('a cited path unchanged since the base: the fixed rule needs only the asking; without a fix diff there is no fix check', () => {
  const onBase = scored({ issue: 'caller breaks', file: 'src/base-only.js', line: '1', quote: 'export const one = 2 // here too' })
  const r = review({ STUB_FINDINGS: JSON.stringify({ findings: [onBase] }) })
  assert.equal(r.resolvedPaths.f1.path, 'src/base-only.js')
  refused(script(['--fix-check', r.id]), /No fix diff to check/)
  refused(close(r.id, { f1: fixed }), /Fixed f1 needs a fix check/)
  commit({ 'src/one.js': 'export const one = 3\n' }, 'fix the caller through one')
  const check = fixCheck(r.id)
  assert.deepEqual(check.asked, ['f1'])
  assert.ok(!check.manifest.read.some(([p]) => p === 'src/base-only.js'))
  closed(r.id, { f1: fixed })
})

test('a file that is not UTF-8 is unreadable: the push goes through and the tier is HIGH', () => {
  commit({ 'src/latin.js': Buffer.from('export const café = 1\n', 'latin1') })
  const r = review()
  assert.deepEqual(r.manifest.unread, [['src/latin.js', 'encoding']])
  closed(r.id, {})
  const tier = tierJson()
  assert.equal(tier.tier, 'high')
  assert.ok(tier.reasons.some((x) => /^not read by any reviewer: src\/latin\.js/.test(x)), JSON.stringify(tier))
  allowed(push())
})

test('a gitlink replaced by a binary file is unreadable: the push goes through and the tier is HIGH', () => {
  git('checkout', '-q', 'main')
  mkdirSync(join(REPO, 'vendor/sub'), { recursive: true })
  git('update-index', '--add', '--cacheinfo', `160000,${git('rev-parse', 'HEAD')},vendor/sub`); git('commit', '-qm', 'submodule on main')
  git('push', '-q', '--no-verify', 'origin', 'main'); git('fetch', '-q', 'origin')
  git('checkout', '-qb', 'unsub')
  git('rm', '-q', '--cached', 'vendor/sub'); rmSync(join(REPO, 'vendor/sub'), { recursive: true, force: true })
  commit({ 'vendor/sub': 'blob\u0000\u0001\n' }, 'replace the gitlink')
  const r = review()
  assert.deepEqual(r.manifest.unread, [['vendor/sub', 'submodule-change']])
  closed(r.id, {})
  const tier = tierJson()
  assert.equal(tier.tier, 'high')
  assert.ok(tier.reasons.some((x) => /^not read by any reviewer: vendor\/sub/.test(x)), JSON.stringify(tier))
  allowed(push('HEAD:refs/heads/unsub'))
})

test('a blocking fix-check finding marked fixed is refused: defer it and slice; a cited path the fix check capped is refused, naming dispute or waive', () => {
  const pad = (n, name) => Array.from({ length: n }, (_, i) => `export const ${name}${i} = ${i}`).join('\n') + '\n'
  commit({ 'src/a.js': 'export const a = 1\n', 'src/b.js': 'export const b = 1\n' })
  const grouped = scored({ issue: 'a and b are wrong', file: 'src/a.js', line: '1', quote: 'export const a = 1',
    instances: [{ file: 'src/a.js', line: '1', quote: 'export const a = 1' }, { file: 'src/b.js', line: '1', quote: 'export const b = 1' }] })
  const r = review({ STUB_FINDINGS: JSON.stringify({ findings: [grouped] }) })
  commit({ 'src/a.js': pad(40, 'a'), 'src/b.js': pad(40, 'b') })
  const x1 = scored({ issue: 'a0 is wrong', file: 'src/a.js', line: '1', quote: 'export const a0 = 0' })
  const check = fixCheck(r.id, { REVIEW_TEST_DIFF_CAP: '1500', STUB_FINDINGS: JSON.stringify({ findings: [x1] }) })
  assert.ok(check.manifest.unread.some(([p, why]) => p === 'src/b.js' && why === 'capped'), JSON.stringify(check.manifest.unread))
  const deferX1 = { x1: { status: 'deferred', reason: 'next PR' } }
  refused(close(r.id, { f1: fixed, ...deferX1 }), /Fixed f1: the fix check did not read src\/b\.js \(capped\).*dispute.*waive/s)
  // With f1 settled by a REFUTED from another family, the fix-check finding's own refusal shows.
  appendFileSync(LOG, `${JSON.stringify({ type: 'dispute', ts: new Date().toISOString(), review: r.id, finding: 'f1', verdict: 'REFUTED', verifier: 'opus', family: 'sol' })}\n`)
  const rejectF1 = { f1: { status: 'rejected', reason: 'a and b are meant', evidence: 'src/a.js:1', response: 'intentional' } }
  refused(close(r.id, { ...rejectF1, x1: fixed }), /Fixed x1 is a fix-check finding.*defer it.*REVIEW_PATHS/s)
  closed(r.id, { ...rejectF1, ...deferX1 }, 'partial')
})

test('a failed security pass counts only in a chain that still supplies coverage at the tip', () => {
  homeConfig({ security: { run: 'always', timeoutMs: 3000 } })
  const failed = review({ REVIEW_SECURITY_TEST_FAULT: 'exit' })
  assert.equal(failed.security.status, 'failed')
  closed(failed.id, {})
  commit({ 'src/one.js': 'export const one = 5\n', 'src/two.js': 'export const two = 5\n', 'docs/three.md': 'three, once more\n' })
  closed(review().id, {})
  const tier = tierJson()
  assert.ok(!tier.reasons.some((x) => /security pass failed/.test(x)), JSON.stringify(tier))
})

// ── PR 2 review fixes ───────────────────────────────────────────────────────
test('code s3: a Grade chain grants no coverage, also through a fix check run against the Grade', () => {
  const g = grade([])
  commit({ 'src/one.js': 'export const one = 3\n' })
  const check = fixCheck(g.id)
  assert.ok(check.manifest.read.length, 'the fix check read the branch')
  const c = close(g.id, {})
  allowed(c)
  assert.deepEqual([...c.record.unseen].sort(), ['docs/three.md', 'src/one.js', 'src/two.js'])
  blocked(push(), /src\/one\.js/)
})

test('code s4: a slice records only the open findings within its own paths; a Grade finding is carried only by a review shown it', () => {
  const g = grade([{ ...GRADE_FINDING, file: 'src/two.js' }, { ...GRADE_FINDING, issue: 'no file at all' }])
  rmSync(CALLS, { recursive: true, force: true }); mkdirSync(CALLS)
  const docs = review({ REVIEW_PATHS: 'docs/three.md' })
  assert.equal(Object.hasOwn(docs, 'openFindings'), false, 'a docs slice is not handed a finding in src/two.js, nor one with no file')
  assert.ok(!calls().find((c) => c.kind === 'code').prompt.includes('no check on two'))
  refused(close(g.id, { f1: { status: 'carried' }, f2: { status: 'carried' } }), /Carried f1 needs a review after the Grade that lists it/)
  const two = review({ REVIEW_PATHS: 'src/two.js' })
  assert.deepEqual(two.openFindings, [{ record: g.id, id: 'f1' }], 'the slice holding src/two.js carries f1 only')
  refused(close(g.id, { f1: { status: 'carried' }, f2: { status: 'carried' } }), /Carried f2 needs a review after the Grade that lists it/)
  const all = review()
  assert.deepEqual(all.openFindings, [{ record: g.id, id: 'f1' }, { record: g.id, id: 'f2' }])
  allowed(close(g.id, { f1: { status: 'carried' }, f2: { status: 'carried' } }))
})

test('code f1: a sliced review\'s fix check runs when the fix landed outside the slice, and the fixed finding closes', () => {
  const r = review({ REVIEW_PATHS: 'src/one.js', STUB_FINDINGS: JSON.stringify({ findings: [ONE] }) })
  commit({ 'src/two.js': 'export const two = 3 // guards one\n' }, 'fix one through two')
  rmSync(CALLS, { recursive: true, force: true }); mkdirSync(CALLS)
  const check = fixCheck(r.id)
  assert.deepEqual(check.asked, ['f1'])
  assert.ok(calls().find((c) => c.kind === 'code').prompt.includes('-export const two = 2\n+export const two = 3 // guards one'), 'the fix outside the slice is shown')
  closed(r.id, { f1: fixed })
})

test('code s2: a fix check whose manifest was diffed from the review head (PR 1) never satisfies the fixed rule', () => {
  const r = review({ STUB_FINDINGS: JSON.stringify({ findings: [ONE] }) })
  commit({ 'src/two.js': 'export const two = 3\n' })
  const head = git('rev-parse', 'HEAD'), state = (rev, p) => `100644 ${git('rev-parse', `${rev}:${p}`)}`
  appendFileSync(LOG, `${JSON.stringify({ type: 'review', kind: 'fix-check', id: 'fix-pr1-1', review: r.id, ts: new Date().toISOString(), head, branch: 'feat', repo: 'repo',
    repoId: r.repoId, base: r.head, baseSha: r.head, family: 'sol', model: 'gpt-stub-sol', vendor: 'codex', families: ['sol'], findings: 0, findingDetails: [], asked: ['f1'],
    manifest: { v: 1, role: 'code', base: r.head, head, read: [['src/two.js', state(r.head, 'src/two.js'), state(head, 'src/two.js')]], unread: [], promptSha256: 'x', cap: 120000 } })}\n`)
  refused(close(r.id, { f1: fixed }), /Fixed f1: the fix check fix-pr1-1 predates/)
})

test('code s6: a tree-identical rewrite onto newer main is judged against the new base, so a file main changed and the rewrite restored is unseen', () => {
  closed(review().id, {})
  const reviewed = git('rev-parse', 'HEAD')
  git('checkout', '-q', 'main')
  commit({ 'src/base-only.js': 'export const one = 2 // here too\nexport const guard = true\n' }, 'main adds a guard')
  git('push', '-q', '--no-verify', 'origin', 'main'); git('fetch', '-q', 'origin')
  git('checkout', '-qb', 'rewritten')
  git('checkout', reviewed, '--', '.'); git('commit', '-qm', 'the reviewed tree on newer main')
  assert.equal(git('rev-parse', 'HEAD^{tree}'), git('rev-parse', `${reviewed}^{tree}`))
  // The carry finds src/base-only.js unread against the new base, so nothing covers the tip.
  blocked(push('HEAD:refs/heads/rewritten'), /No complete close covers tip/)
})
