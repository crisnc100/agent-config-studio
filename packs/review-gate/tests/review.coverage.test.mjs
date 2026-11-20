import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Content coverage at the push gate: a file is covered when its exact [path, base state, tip state] is in the read list of
// a code manifest in the chain (review and fix check) of a close in this repository, at a head the tip descends from. Stub CLIs, a temporary HOME and Git config,
// and the push gate through the actual installed pre-push hook.
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime')
const ROOT = mkdtempSync(join(tmpdir(), 'review-coverage-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), CLONE = join(ROOT, 'clone'), REMOTE = join(ROOT, 'remote.git')
const SKILL = join(HOME, '.agent-config-studio/review-gate'), SCRIPT = join(SKILL, 'review.mjs')
const LOG = join(HOME, '.agent-config-studio/review-log/review-log.jsonl'), BIN = join(ROOT, 'bin'), CALLS = join(ROOT, 'calls')
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
const reply = schema.includes('"scores"') ? '{"scores":[]}' : (process.env.STUB_FINDINGS || '{"findings":[]}')
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1], reply)
else console.log(JSON.stringify({structured_output:JSON.parse(reply),structuredOutput:JSON.parse(reply),modelUsage:{'stub-grok':{}}}))
`
for (const name of ['codex', 'claude', 'grok']) stub(name, modelBody)
stub('jev', 'process.exit(1)')
after(() => rmSync(ROOT, { recursive: true, force: true }))

const env = (extra = {}) => ({ HOME, CODEX_HOME: join(HOME, '.codex'), GROK_HOME: join(HOME, '.grok'), GIT_CONFIG_GLOBAL: join(HOME, 'isolated.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1', PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: ROOT, REVIEW_BASE: 'main', REVIEW_REVIEWER: 'sol', ...extra })
function run(command, args, extra = {}, cwd = REPO) {
  const r = spawnSync(command, args, { cwd, env: env(extra), encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 })
  return { ...r, out: `${r.stdout || ''}\n${r.stderr || ''}` }
}
const script = (args, extra = {}, cwd = REPO) => run(process.execPath, [SCRIPT, ...args], extra, cwd)
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
const calls = () => readdirSync(CALLS).map((p) => JSON.parse(readFileSync(join(CALLS, p), 'utf8')))
const allowed = (r) => assert.equal(r.status, 0, r.out)
function blocked(r, pattern) {
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /Run \/code-review/)
  if (pattern) assert.match(r.out, pattern)
}
const push = (ref = 'HEAD:refs/heads/feat') => run('git', ['push', 'origin', ref])
// A review through the stub reviewer; paths go in REVIEW_PATHS.
function review(paths, extra = {}, cwd = REPO) {
  const r = script([], { REVIEW_PATHS: paths || '', ...extra }, cwd)
  allowed(r)
  return records().filter((e) => e.type === 'review' && e.kind === 'review').at(-1)
}
function close(id, statuses = {}, cwd = REPO) {
  const path = join(ROOT, 'statuses.json')
  writeFileSync(path, JSON.stringify(statuses))
  const before = records().length
  const r = script(['--close', id, '--status', path, '--test-cmd', 'true'], {}, cwd)
  return { ...r, record: records().length > before ? records().at(-1) : null }
}
function closed(id, statuses, cwd, status = 'complete') {
  const r = close(id, statuses, cwd)
  allowed(r); assert.equal(r.record.type, 'close'); assert.equal(r.record.status, status, r.out)
  return r.record
}
function fixCheck(id, findings = []) {
  allowed(script(['--fix-check', id], { STUB_FINDINGS: JSON.stringify({ findings }) }))
  const check = records().at(-1)
  assert.equal(check.kind, 'fix-check')
  return check
}
const uncovered = (files) => new RegExp(`${files.length} file\\(s\\) uncovered: ${files.map((f) => f.replace(/[./]/g, '\\$&')).join(', ')} — review them as a slice \\(REVIEW_PATHS=${files.map((f) => f.replace(/[./]/g, '\\$&')).join(',')}\\)`)
const F1 = { issue: 'one is wrong', file: 'src/one.js', line: '1', quote: 'export const one = 2', suggestion: 'fix it',
  likelihood: 5, impact: 5, protected: false, trigger: 'importing one' }
const blob = (rev, path) => git('rev-parse', `${rev}:${path}`)

beforeEach(() => {
  for (const path of [HOME, REPO, CLONE, REMOTE, CALLS]) rmSync(path, { recursive: true, force: true })
  mkdirSync(SKILL, { recursive: true }); mkdirSync(dirname(LOG), { recursive: true }); mkdirSync(REPO); mkdirSync(CALLS)
  copyFileSync(join(SOURCE, 'review.mjs'), SCRIPT)
  cpSync(join(SOURCE, 'hooks'), join(SKILL, 'hooks'), { recursive: true, verbatimSymlinks: true })
  git('init', '-q', '-b', 'main')
  commit({ 'README.md': 'base\n', 'src/one.js': 'export const one = 1\n', 'lib/two.js': 'export const two = 1\n', 'docs/three.md': 'three\n', 'shared.js': 'shared v1\n' })
  git('checkout', '-qb', 'feat')
  commit({ 'src/one.js': 'export const one = 2\n', 'docs/three.md': 'three, edited\n' })
  git('init', '--bare', '-q', REMOTE)
  git('remote', 'add', 'origin', REMOTE)
  allowed(run('sh', [join(SKILL, 'hooks/install-hook.sh'), REPO]))
})

test('C1 a sibling-file fix seen by the fix check keeps the close complete, and the fix check logs what it read and how long it took', () => {
  const r = review('', { STUB_FINDINGS: JSON.stringify({ findings: [F1] }) })
  assert.deepEqual(r.manifest.unread, [])
  commit({ 'src/one.js': 'export const one = 3\n', 'lib/two.js': 'export const two = 3\n' })
  const early = close(r.id, { f1: { status: 'fixed' } })
  assert.notEqual(early.status, 0); assert.equal(early.record, null)
  assert.match(early.out, /Fixed f1 needs a fix check/)
  const check = fixCheck(r.id)
  assert.equal(typeof check.durationMs, 'number'); assert.ok(check.durationMs >= 0)
  assert.deepEqual(check.manifest.unread, [])
  const head = git('rev-parse', 'HEAD'), base = git('merge-base', 'main', 'HEAD')
  assert.deepEqual(check.manifest.read, [['lib/two.js', `100644 ${blob(base, 'lib/two.js')}`, `100644 ${blob(head, 'lib/two.js')}`],
    ['src/one.js', `100644 ${blob(base, 'src/one.js')}`, `100644 ${blob(head, 'src/one.js')}`]])
  const record = closed(r.id, { f1: { status: 'fixed' } })
  assert.deepEqual(record.unseen, []); assert.equal(record.fixCheck, check.id)
  assert.equal(record.repoId, records().find((e) => e.id === r.id).repoId)
  allowed(push())
})

test('C1 a fix check counts only through its review\'s close: one logged after the close covers nothing', () => {
  const r = review()
  closed(r.id)
  commit({ 'lib/two.js': 'export const two = 3\n', 'shared.js': 'shared v2\n' })
  const late = fixCheck(r.id)
  assert.ok(late.manifest.read.some(([p]) => p === 'lib/two.js'), 'the unlinked check did read the file the gate still refuses')
  // The tip close comes from a slice of the other file; the fix check is in no close's chain, so lib/two.js is uncovered.
  closed(review('shared.js').id)
  blocked(push(), uncovered(['lib/two.js']))
})

test('C2 a late one-file commit needs only that file reviewed and one close at the tip, not a re-review of the rest', () => {
  const first = review('src/'), second = review('docs/')
  closed(first.id); closed(second.id)
  allowed(push())
  commit({ 'lib/two.js': 'export const two = 2\n' })
  const r = push(); blocked(r, uncovered(['lib/two.js']))
  assert.match(r.out, /no close this tip descends from has a manifest that read the tip state of 1 file\(s\)/)
  const summary = script(['--summary'])
  assert.notEqual(summary.status, 0); assert.match(summary.out, uncovered(['lib/two.js']))
  rmSync(CALLS, { recursive: true }); mkdirSync(CALLS)
  closed(review('lib/two.js').id)
  const [call] = calls()
  assert.match(call.prompt, /export const two = 2/); assert.doesNotMatch(call.prompt, /export const one = 2|three, edited/)
  const pushed = push(); allowed(pushed)
  assert.match(pushed.stderr, /Content coverage: 3 record\(s\) together cover every file changed from/)
  assert.match(pushed.stderr, /Close 1 of 3: review \S+ at [0-9a-f]{40} for paths lib\/two\.js; covers 1 file\(s\), and the tests ran at the tip/)
  const shown = script(['--summary']); allowed(shown)
  assert.ok(pushed.stderr.includes(shown.stdout.trim()), pushed.out)
})

test('C2 every file can be covered while no close is at the tip: the push still needs one close there', () => {
  const r = review()
  closed(r.id)
  commit({ 'lib/two.js': 'export const two = 2\n' })
  commit({ 'lib/two.js': 'export const two = 1\n' })
  blocked(push(), /every changed file is covered, but no close is at the tip/)
})

test('C3 a merge of two reviewed branches: each file is covered by the manifest that read its exact change from the base', () => {
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'left')
  commit({ 'left.js': 'export const left = 1\n', 'shared.js': 'shared v2\n' })
  closed(review().id)
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'right')
  commit({ 'right.js': 'export const right = 1\n', 'shared.js': 'shared v2\n' })
  closed(review().id)
  git('checkout', '-q', 'left')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '--no-ff', '-qm', 'merge right', 'right')
  // Both sides read shared.js from main's v1 to the very blob the merge has; right.js only the right side read.
  assert.equal(blob('HEAD', 'shared.js'), blob('right', 'shared.js'))
  blocked(push('HEAD:refs/heads/left'), /every changed file is covered, but no close is at the tip/)
  closed(review('shared.js').id)
  allowed(push('HEAD:refs/heads/left'))
  // A third state of the shared file is read by neither side.
  commit({ 'shared.js': 'shared v3\n' })
  closed(review('left.js').id)
  blocked(push('HEAD:refs/heads/left'), uncovered(['shared.js']))
})

test('C4 a deletion and a chmod-only change are uncovered until reviewed', () => {
  closed(review().id)
  const base = git('merge-base', 'main', 'HEAD')
  commit({ 'docs/three.md': null })
  blocked(push(), uncovered(['docs/three.md']))
  const deletion = review('docs/three.md')
  assert.deepEqual(deletion.manifest.read, [['docs/three.md', `100644 ${blob(base, 'docs/three.md')}`, null]])
  closed(deletion.id)
  allowed(push())
  chmodSync(join(REPO, 'src/one.js'), 0o755)
  git('add', 'src/one.js'); git('commit', '-qm', 'executable')
  blocked(push(), uncovered(['src/one.js']))
  const mode = review('src/one.js')
  assert.deepEqual(mode.manifest.read, [['src/one.js', `100644 ${blob(base, 'src/one.js')}`, `100755 ${blob('HEAD', 'src/one.js')}`]])
  closed(mode.id)
  allowed(push())
})

test('C6 a review on an unrelated branch or in another repository covers nothing, even for the same blob at the same commit', () => {
  closed(review().id)
  const tip = commit({ 'lib/two.js': 'export const two = 2\n' })
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'other')
  commit({ 'lib/two.js': 'export const two = 2\n' })
  const elsewhere = review('lib/two.js')
  assert.deepEqual(elsewhere.manifest.read, [['lib/two.js', `100644 ${blob('main', 'lib/two.js')}`, `100644 ${blob('feat', 'lib/two.js')}`]])
  closed(elsewhere.id)
  git('checkout', '-q', 'feat')
  blocked(push(), uncovered(['lib/two.js']))
  // A clone holds the same commits; its review and close at this very tip still count only there.
  allowed(run('git', ['clone', '-q', '--branch', 'feat', REPO, CLONE], {}, ROOT))
  allowed(run('git', ['branch', '-q', 'main', 'origin/main'], {}, CLONE))
  assert.equal(run('git', ['rev-parse', 'HEAD'], {}, CLONE).stdout.trim(), tip)
  const cloned = review('lib/two.js', {}, CLONE)
  assert.equal(cloned.head, tip); assert.notEqual(cloned.repoId, elsewhere.repoId)
  closed(cloned.id, {}, CLONE)
  blocked(push(), uncovered(['lib/two.js']))
})

const BIG = Array.from({ length: 3000 }, (_, i) => `export const value${i} = '${'x'.repeat(40)}'`).join('\n') + '\n'
// Under the 120000-char cap on its own, so a lower cap can leave it out as capped.
const MID = Array.from({ length: 200 }, (_, i) => `export const value${i} = '${'x'.repeat(40)}'`).join('\n') + '\n'
// A cap under which `path`'s section no longer fits after the src/one.js section ahead of it, though it fits alone.
const capFor = (path) => ({ REVIEW_TEST_DIFF_CAP: String(git('diff', 'main...HEAD', '--', path).length + 40) })
test('E1 coverageExempt from the environment or the home config skips those files, and the summary and refusal name them as not reviewed', () => {
  commit({ 'z/big.js': MID })
  const r = review('', capFor('z/big.js'))
  assert.ok(r.manifest.unread.some(([p, why]) => p === 'z/big.js' && why === 'capped'), JSON.stringify(r.manifest.unread))
  closed(r.id, {}, REPO, 'partial')
  blocked(push(), uncovered(['z/big.js']))
  const pushed = run('git', ['push', 'origin', 'HEAD:refs/heads/feat'], { REVIEW_COVERAGE_EXEMPT: 'z/**' }); allowed(pushed)
  assert.match(pushed.stderr, /\nCoverage exempt \(not reviewed\): z\/big\.js\n/)
  // A pattern with no slash matches any path segment, as in riskPaths.
  writeFileSync(join(SKILL, 'config.json'), JSON.stringify({ coverageExempt: ['big.js'] }))
  commit({ 'lib/two.js': 'export const two = 2\n' })
  blocked(push(), /1 file\(s\) uncovered: lib\/two\.js — review them as a slice \(REVIEW_PATHS=lib\/two\.js\) and close it at the tip; exempt \(not reviewed\): z\/big\.js/)
  closed(review('lib/two.js').id)
  const summary = script(['--summary']); allowed(summary)
  assert.equal(summary.stdout.trim().split('\n').at(-1), 'Coverage exempt (not reviewed): z/big.js')
  allowed(push())
})

test('E2 a tracked repo config cannot set coverageExempt; an untracked one can', () => {
  commit({ '.claude/review-config.json': JSON.stringify({ coverageExempt: ['z/**'] }), 'z/big.js': MID })
  closed(review('', capFor('z/big.js')).id, {}, REPO, 'partial')
  blocked(push(), uncovered(['z/big.js']))
  rmSync(LOG)
  git('rm', '-q', '--cached', '.claude/review-config.json'); git('commit', '-qm', 'untrack the config')
  assert.equal(existsSync(join(REPO, '.claude/review-config.json')), true)
  closed(review('', capFor('z/big.js')).id)
  const pushed = push(); allowed(pushed)
  assert.match(pushed.stderr, /Coverage exempt \(not reviewed\): z\/big\.js/)
})

test('R1 a tracked repo config cannot set coverageExempt or a command key with any value; a malformed trusted list fails loudly', () => {
  commit({ '.claude/review-config.json': JSON.stringify({ coverageExempt: [null], verifyCmd: [null] }) })
  const r = script([], { REVIEW_PATHS: '' }); allowed(r)
  assert.match(r.out, /Ignoring verifyCmd, coverageExempt in \.claude\/review-config\.json/)
  closed(records().filter((e) => e.type === 'review').at(-1).id)
  commit({ 'null/x.js': 'export const x = 1\n' })
  blocked(push(), uncovered(['null/x.js']))
  git('rm', '-q', '.claude/review-config.json'); git('commit', '-qm', 'drop the config')
  for (const value of [[null], [''], ['  '], [3], { 'z/**': true }]) {
    writeFileSync(join(SKILL, 'config.json'), JSON.stringify({ coverageExempt: value }))
    blocked(push(), /coverageExempt must be a list of non-empty path patterns/)
  }
})

test('R2 a fixed finding whose file the fix check could not read (its change from the base is over the cap) is refused at close', () => {
  const r = review('', { STUB_FINDINGS: JSON.stringify({ findings: [F1] }) })
  commit({ 'src/one.js': `export const one = 3\n${BIG}`, 'src/one.test.js': 'test one\n' })
  const check = fixCheck(r.id)
  assert.deepEqual(check.manifest.unread, [['src/one.js', 'oversize']])
  const refused = close(r.id, { f1: { status: 'fixed' } })
  assert.notEqual(refused.status, 0); assert.equal(refused.record, null)
  assert.match(refused.out, /Fixed f1: the fix check did not read src\/one\.js/)
})

test('R3 a file the review read only in part is read whole by the fix check, from the base, and is covered', () => {
  commit({ 'z/big.js': MID })
  const r = review('', { ...capFor('z/big.js'), STUB_FINDINGS: JSON.stringify({ findings: [F1] }) })
  assert.ok(r.manifest.unread.some(([p, why]) => p === 'z/big.js' && why === 'capped'))
  commit({ 'src/one.js': 'export const one = 3\n', 'src/one.test.js': 'test one\n' })
  rmSync(CALLS, { recursive: true, force: true }); mkdirSync(CALLS)
  const check = fixCheck(r.id)
  assert.deepEqual(check.manifest.unread, [])
  assert.deepEqual(check.manifest.read.map(([path]) => path), ['src/one.js', 'src/one.test.js', 'z/big.js'])
  const prompt = calls().map((c) => c.prompt).find((p) => p.startsWith('Fix check:'))
  assert.ok(prompt.includes('+++ b/z/big.js') && MID.split('\n').filter(Boolean).every((l) => prompt.includes(`+${l}`)), 'the prompt holds z/big.js whole')
  const record = closed(r.id, { f1: { status: 'fixed' } })
  assert.deepEqual(record.unseen, [])
  allowed(push())
})

test('X1 a file the review left out, moved before the fix check, is read whole under its new name by the fix check', () => {
  commit({ 'z/big.js': MID })
  const r = review('', { ...capFor('z/big.js'), STUB_FINDINGS: JSON.stringify({ findings: [F1] }) })
  assert.ok(r.manifest.unread.some(([p, why]) => p === 'z/big.js' && why === 'capped'))
  git('mv', 'z/big.js', 'z/moved.js')
  commit({ 'src/one.js': 'export const one = 3\n', 'src/one.test.js': 'test one\n' }, 'move big, fix one')
  rmSync(CALLS, { recursive: true, force: true }); mkdirSync(CALLS)
  const check = fixCheck(r.id)
  const prompt = calls().map((c) => c.prompt).find((p) => p.startsWith('Fix check:'))
  assert.ok(prompt.includes('+++ b/z/moved.js') && MID.split('\n').filter(Boolean).every((l) => prompt.includes(`+${l}`)), 'the prompt holds z/moved.js whole')
  const moved = check.manifest.read.find(([path]) => path === 'z/moved.js')
  assert.deepEqual(moved, ['z/moved.js', null, `100644 ${blob('HEAD', 'z/moved.js')}`], 'an addition, never a short rename section')
  assert.equal(check.manifest.read.some(([path]) => path === 'z/big.js'), false, 'added and removed since the base: no change to read')
  closed(r.id, { f1: { status: 'fixed' } })
  allowed(push())
})

test('X2 a tracked repo config loses every own-file key it sets, blank values included', () => {
  commit({ '.claude/review-config.json': JSON.stringify({ verifyCmd: ' ', base: '', classifier: '\n' }) })
  const r = script([], { REVIEW_PATHS: '' }); allowed(r)
  assert.match(r.out, /Ignoring verifyCmd, classifier, base in \.claude\/review-config\.json/)
})
test('X2 a whitespace-only verifyCmd or --test-cmd is no test command: close asks for one', () => {
  const r = review()
  const path = join(ROOT, 'statuses.json')
  writeFileSync(path, '{}')
  for (const [args, extra] of [[['--test-cmd', ' '], {}], [['--test-cmd', '\n'], {}], [[], { REVIEW_VERIFY_CMD: ' ' }], [[], { REVIEW_VERIFY_CMD: '\t\n' }]]) {
    const before = records().length
    const refused = script(['--close', r.id, '--status', path, ...args], extra)
    assert.notEqual(refused.status, 0, refused.out)
    assert.match(refused.out, /No test command configured; use --test-cmd or --no-tests "reason"/)
    assert.equal(records().length, before, 'a refused close logs nothing')
  }
  // An untracked repo config is trusted, and a blank verifyCmd there is unset too.
  mkdirSync(join(REPO, '.claude'), { recursive: true })
  writeFileSync(join(REPO, '.claude/review-config.json'), JSON.stringify({ verifyCmd: '  ' }))
  const untracked = script(['--close', r.id, '--status', path])
  assert.notEqual(untracked.status, 0, untracked.out)
  assert.match(untracked.out, /No test command configured/)
})

test('K1 a generated lockfile is exempt by default by its exact name, in any folder, and named as not reviewed', () => {
  commit({ 'package-lock.json': BIG, 'web/yarn.lock': BIG })
  // The code is reviewed; the lockfiles, each over the cap on its own, are not.
  closed(review('docs/,src/').id)
  const pushed = push(); allowed(pushed)
  assert.match(pushed.stderr, /\nCoverage exempt \(not reviewed\): package-lock\.json, web\/yarn\.lock\n/)
  // A lookalike name is not a lockfile: it needs a review like any file.
  commit({ 'package-lock.json.bak': BIG, 'my-yarn.lock': BIG })
  closed(review('docs/,src/').id)
  blocked(push(), /leave 2 file\(s\) uncovered: my-yarn\.lock, package-lock\.json\.bak — .*; exempt \(not reviewed\): package-lock\.json, web\/yarn\.lock/)
})

test('K2 coverageExemptDefaults: false in the home config turns the default list off; a tracked repo config cannot', () => {
  commit({ 'package-lock.json': BIG })
  closed(review('docs/,src/').id)
  writeFileSync(join(SKILL, 'config.json'), JSON.stringify({ coverageExemptDefaults: false }))
  blocked(push(), uncovered(['package-lock.json']))
  writeFileSync(join(SKILL, 'config.json'), JSON.stringify({ coverageExemptDefaults: false, coverageExempt: ['package-lock.json'] }))
  allowed(push())
  for (const value of ['no', 0, null, []]) {
    writeFileSync(join(SKILL, 'config.json'), JSON.stringify({ coverageExemptDefaults: value }))
    blocked(push(), /coverageExemptDefaults must be true or false/)
  }
  rmSync(join(SKILL, 'config.json'))
  commit({ '.claude/review-config.json': JSON.stringify({ coverageExemptDefaults: false }) })
  const r = script([], { REVIEW_PATHS: '.claude/,docs/,src/' }); allowed(r)
  assert.match(r.out, /Ignoring coverageExemptDefaults in \.claude\/review-config\.json/)
  closed(records().filter((e) => e.type === 'review').at(-1).id)
  const pushed = push(); allowed(pushed)
  assert.match(pushed.stderr, /Coverage exempt \(not reviewed\): package-lock\.json/)
})

test('K3 a tracked repo config, even {}, leaves the home config\'s coverageExemptDefaults: false in force', () => {
  writeFileSync(join(SKILL, 'config.json'), JSON.stringify({ coverageExemptDefaults: false }))
  commit({ 'package-lock.json': BIG, '.claude/review-config.json': '{}' })
  closed(review('.claude/,docs/,src/').id)
  blocked(push(), uncovered(['package-lock.json']))
  // The repo file's own value is still ignored, with the warning, and the home value stays.
  commit({ '.claude/review-config.json': JSON.stringify({ coverageExemptDefaults: true }) })
  const r = script([], { REVIEW_PATHS: '.claude/,docs/,src/' }); allowed(r)
  assert.match(r.out, /Ignoring coverageExemptDefaults in \.claude\/review-config\.json/)
  closed(records().filter((e) => e.type === 'review').at(-1).id)
  blocked(push(), uncovered(['package-lock.json']))
})

test('K3 a tracked repo config, even {}, keeps the home config\'s coverageExempt list, and cannot replace it', () => {
  writeFileSync(join(SKILL, 'config.json'), JSON.stringify({ coverageExempt: ['z/**'] }))
  commit({ 'z/big.js': BIG, '.claude/review-config.json': '{}' })
  closed(review('.claude/,docs/,src/').id)
  const pushed = push(); allowed(pushed)
  assert.match(pushed.stderr, /Coverage exempt \(not reviewed\): z\/big\.js/)
  commit({ '.claude/review-config.json': JSON.stringify({ coverageExempt: ['y/**'] }), 'y/big.js': BIG })
  const r = script([], { REVIEW_PATHS: '.claude/,docs/,src/' }); allowed(r)
  assert.match(r.out, /Ignoring coverageExempt in \.claude\/review-config\.json/)
  closed(records().filter((e) => e.type === 'review').at(-1).id)
  blocked(push(), /1 file\(s\) uncovered: y\/big\.js .*exempt \(not reviewed\): z\/big\.js/)
})

test('X1 a current close whose linked fix check predates manifests: its old coverage field grants nothing', () => {
  const r = review()
  commit({ 'lib/two.js': 'export const two = 3\n' })
  const head = git('rev-parse', 'HEAD')
  appendFileSync(LOG, `${JSON.stringify({ type: 'review', kind: 'fix-check', id: 'fix-legacy-1', review: r.id, ts: new Date().toISOString(), head, branch: 'feat', repo: 'repo',
    repoId: r.repoId, base: r.head, baseSha: r.head, family: 'sol', model: 'gpt-stub-sol', findings: 0, findingDetails: [],
    coverage: [['lib/two.js', `100644 ${git('rev-parse', 'HEAD:lib/two.js')}`]], truncated: [] })}\n`)
  const record = closed(r.id, {}, undefined, 'partial')
  assert.equal(record.fixCheck, 'fix-legacy-1')
  assert.deepEqual(record.unseen, ['lib/two.js'])
  blocked(push(), uncovered(['lib/two.js']))
})
