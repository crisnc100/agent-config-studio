import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Recorded finding paths: the quote check records the exact path that held each quote on the review or fix-check
// record (resolvedPaths, keyed by finding id), and close compares them byte for byte: a fixed finding needs the fix
// check to have read every recorded path, and what no pass read is unseen under its exact name. Stub CLIs, temporary
// HOME and Git config; nothing runs a model.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'review.mjs')
const ROOT = mkdtempSync(join(tmpdir(), 'review-paths-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), BIN = join(ROOT, 'bin')
const LOG = join(HOME, '.agent-config-studio/review-log/review-log.jsonl')
mkdirSync(BIN)
const stub = (name, body) => {
  writeFileSync(join(BIN, name), `#!${process.execPath}\n${body}`)
  chmodSync(join(BIN, name), 0o755)
}
stub('model-id', `const a=process.argv.slice(2), ids={sol:'gpt-stub-sol',opus:'claude-stub-opus',grok:'grok-stub'}; console.log(a[0]==='--role' ? JSON.stringify({use:['sol','opus','grok'],ids:['gpt-stub-sol','claude-stub-opus','grok-stub']}) : a[0]==='--flavor' ? JSON.stringify({flavor:{effort:'high'}}) : ids[a[0]] || 'stub-'+a[0])`)
const modelBody = `
const fs = require('node:fs')
const a = process.argv.slice(2)
if (a[0] === 'mcp') { console.log('[]'); process.exit(0) } // codex mcp list: no MCP servers, never recorded
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8') : a[a.indexOf('--json-schema')+1]
const reply = schema.includes('"scores"') ? '{"scores":[]}' : (process.env.STUB_FINDINGS || '{"findings":[]}')
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1], reply)
else console.log(JSON.stringify({structured_output:JSON.parse(reply),structuredOutput:JSON.parse(reply),modelUsage:{'stub-grok':{}}}))
`
for (const name of ['codex', 'claude', 'grok']) stub(name, modelBody)
stub('jev', 'process.exit(1)')
after(() => rmSync(ROOT, { recursive: true, force: true }))

const env = (extra = {}) => ({ HOME, CODEX_HOME: join(HOME, '.codex'), GROK_HOME: join(HOME, '.grok'), GIT_CONFIG_GLOBAL: join(HOME, 'isolated.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1', PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: ROOT, REVIEW_BASE: 'main', REVIEW_REVIEWER: 'sol', REVIEW_CLASSIFIER: 'jev', ...extra })
function run(command, args, extra = {}) {
  const r = spawnSync(command, args, { cwd: REPO, env: env(extra), encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 })
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
    mkdirSync(dirname(join(REPO, path)), { recursive: true })
    writeFileSync(join(REPO, path), text)
  }
  git('add', ...Object.keys(files)); git('commit', '-qm', message)
  return git('rev-parse', 'HEAD')
}
const records = () => existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const seed = (...values) => { mkdirSync(dirname(LOG), { recursive: true }); appendFileSync(LOG, values.map(JSON.stringify).join('\n') + '\n') }
const allowed = (r) => assert.equal(r.status, 0, r.out)
function close(id, statuses) {
  const path = join(ROOT, 'statuses.json')
  writeFileSync(path, JSON.stringify(statuses))
  const before = records().length
  const r = script(['--close', id, '--status', path, '--test-cmd', 'true'])
  return { ...r, record: records().length > before ? records().at(-1) : null }
}
function closedAs(id, statuses, status, unseen) {
  const r = close(id, statuses)
  allowed(r); assert.equal(r.record?.type, 'close', r.out)
  assert.equal(r.record.status, status, r.out); assert.deepEqual(r.record.unseen, unseen)
  return r.record
}
function refused(id, statuses, pattern) {
  const r = close(id, statuses)
  assert.notEqual(r.status, 0, r.out); assert.equal(r.record, null, 'a refused close logs nothing')
  assert.match(r.out, pattern)
}
const notRead = (files) => new RegExp(`Fixed f1: the fix check did not read ${files.map((f) => f.replace(/[./]/g, '\\$&')).join(', ')};`)
const finding = (file, quote, extra = {}) => ({ issue: 'it is wrong', file, line: '1', quote, suggestion: 'fix it',
  likelihood: 5, impact: 5, protected: false, trigger: 'importing it', ...extra })
const ONE = finding('src/one.js', 'export const one = 2')
const FIXED = { f1: { status: 'fixed' } }, X_FIXED = { x1: { status: 'deferred', reason: 'fixed after the fix check; sliced at the tip' } }
// A review through the stub reviewer with the given findings; returns the logged record and the command output.
function review(findings = [], extra = {}) {
  const r = script([], { STUB_FINDINGS: JSON.stringify({ findings }), ...extra })
  allowed(r)
  return { record: records().filter((e) => e.type === 'review').at(-1), out: r.out, stdout: r.stdout }
}
// The review's fix check, with the given findings of its own.
function checked(original, findings = []) {
  allowed(script(['--fix-check', original.id], { STUB_FINDINGS: JSON.stringify({ findings }) }))
  const check = records().at(-1)
  assert.equal(check.kind, 'fix-check')
  return check
}
// A file whose section alone is over the 1500-character cap cappedCheck runs the fix check with: oversize.
const PAD = Array.from({ length: 200 }, (_, i) => `export const p${i} = ${i}`).join('\n') + '\n'
function cappedCheck(original) {
  allowed(script(['--fix-check', original.id], { STUB_FINDINGS: JSON.stringify({ findings: [] }), REVIEW_TEST_DIFF_CAP: '1500' }))
  return records().at(-1)
}
// The review, a test change, and the fix check with one finding x1.
function fixChecked(x1, status = 'verified-quote') {
  const { record: original } = review()
  commit({ 'src/one.test.js': 'test one\n' })
  const r = script(['--fix-check', original.id], { STUB_FINDINGS: JSON.stringify({ findings: [x1] }) })
  allowed(r)
  const check = records().at(-1)
  assert.equal(check.kind, 'fix-check'); assert.equal(check.findingDetails[0].status, status)
  return { original, check, out: r.out }
}

beforeEach(() => {
  for (const path of [HOME, REPO]) rmSync(path, { recursive: true, force: true })
  mkdirSync(dirname(LOG), { recursive: true }); mkdirSync(REPO)
  git('init', '-q', '-b', 'main')
  commit({ 'README.md': 'base\n', 'src/one.js': 'export const one = 1\n', 'lib/two.js': 'export const two = 1\n' })
  git('checkout', '-qb', 'feat')
  commit({ 'src/one.js': 'export const one = 2\n' })
})

test('P1 the review and fix-check records carry resolvedPaths with the commit each quote held in; findings and FINDINGS_JSON keep their shape', () => {
  git('rm', '-q', 'lib/two.js'); git('commit', '-qm', 'drop two')
  const { record, stdout } = review([ONE, finding('lib/two.js', 'export const two = 1')])
  assert.deepEqual(record.resolvedPaths, {
    f1: { path: 'src/one.js', commit: git('rev-parse', 'HEAD') },
    f2: { path: 'lib/two.js', commit: git('rev-parse', 'main') },
  })
  assert.equal(Object.hasOwn(record, 'ambiguousPaths'), false)
  for (const f of record.findingDetails) assert.deepEqual(Object.keys(f).filter((k) => /resolved|ambiguous/i.test(k)), [])
  const json = JSON.parse(stdout.slice(stdout.indexOf('===FINDINGS_JSON===') + 19))
  assert.deepEqual(json.findings, record.findingDetails)
  const { check } = fixChecked(finding('src/one.test.js', 'test one'))
  assert.deepEqual(check.resolvedPaths, { x1: { path: 'src/one.test.js', commit: check.head } })
})

test('P2 hole 1, after a fix check: a leading-space file changed alongside the x1 file is its own unseen file', () => {
  const { original } = fixChecked(ONE)
  commit({ 'src/one.js': 'export const one = 3\n', ' src/one.js': 'a different file\n' })
  closedAs(original.id, X_FIXED, 'partial', [' src/one.js', 'src/one.js'])
})
test('P3 hole 2, after a fix check: a finding on a real b/src/one.js does not stand for the root src/one.js', () => {
  commit({ 'b/src/one.js': 'export const b = 1\n' })
  const { original, check } = fixChecked(finding('b/src/one.js', 'export const b = 1'))
  assert.equal(check.resolvedPaths.x1.path, 'b/src/one.js')
  commit({ 'src/one.js': 'export const one = 3\n' })
  closedAs(original.id, X_FIXED, 'partial', ['src/one.js'])
})
test('P4 hole 3: a b/src/one.test.js finding is validated against src/one.test.js; a test change after the fix check is unseen', () => {
  const { original, check } = fixChecked(finding('b/src/one.test.js', 'test one'))
  assert.deepEqual(check.resolvedPaths.x1, { path: 'src/one.test.js', commit: check.head })
  commit({ 'src/one.test.js': 'test one, fixed\n' })
  closedAs(original.id, X_FIXED, 'partial', ['src/one.test.js'])
})

test('P5 hole 1 in the fixed rule: a fix check that read src/one.js has not read the leading-space file a finding cites', () => {
  // The cited file changed on the branch, so the fixed rule needs it read; the fix makes it too big for the fix check.
  commit({ ' src/one.js': 'export const spaced = 1\n' })
  const { record } = review([finding(' src/one.js', 'export const spaced = 1')])
  assert.equal(record.resolvedPaths.f1.path, ' src/one.js')
  commit({ 'src/one.js': 'export const one = 3\n', ' src/one.js': PAD })
  const check = cappedCheck(record)
  assert.ok(check.manifest.read.some(([p]) => p === 'src/one.js'))
  assert.ok(check.manifest.unread.some(([p, why]) => p === ' src/one.js' && why === 'oversize'), JSON.stringify(check.manifest.unread))
  refused(record.id, FIXED, /Fixed f1: the fix check did not read  src\/one\.js \(oversize\);/)
})
test('P6 hole 2 in the fixed rule: a fix check that read the root src/one.js has not read the real b/src/one.js a finding cites', () => {
  commit({ 'b/src/one.js': 'export const b = 1\n' })
  const { record } = review([finding('b/src/one.js', 'export const b = 1')])
  assert.equal(record.resolvedPaths.f1.path, 'b/src/one.js')
  commit({ 'src/one.js': 'export const one = 3\n', 'b/src/one.js': PAD })
  const check = cappedCheck(record)
  assert.ok(check.manifest.read.some(([p]) => p === 'src/one.js'))
  refused(record.id, FIXED, /Fixed f1: the fix check did not read b\/src\/one\.js \(oversize\);/)
})
test('P7 a diff-prefixed finding validated against the root file is fixed once the fix check read the root file; after the fix check its change is unseen', () => {
  const { record } = review([finding('b/src/one.js', 'export const one = 2')])
  assert.equal(existsSync(join(REPO, 'b')), false); assert.equal(record.resolvedPaths.f1.path, 'src/one.js')
  commit({ 'src/one.js': 'export const one = 3\n' })
  checked(record)
  closedAs(record.id, FIXED, 'complete', [])
  const { original, check } = fixChecked(finding('a/src/one.js', 'export const one = 3'))
  assert.equal(check.resolvedPaths.x1.path, 'src/one.js')
  commit({ 'src/one.js': 'export const one = 4\n' })
  closedAs(original.id, X_FIXED, 'partial', ['src/one.js'])
})
test('P8 an ambiguous finding (the quote is in both b/x.js and x.js) records no path, is reported, and needs only that the fix check was asked', () => {
  commit({ 'x.js': 'export const x = 1\n', 'b/x.js': 'export const x = 1\n' })
  const { record, out } = review([finding('b/x.js', 'export const x = 1')])
  assert.equal(record.findingDetails[0].status, 'verified-quote')
  assert.deepEqual(record.resolvedPaths, {}); assert.deepEqual(record.ambiguousPaths, { f1: ['b/x.js', 'x.js'] })
  assert.match(out, /1 finding\(s\) quote code found at two paths/)
  assert.match(readFileSync(join(REPO, 'reviews/latest/code-review.md'), 'utf8'),
    /\(id f1\)[\s\S]*Path ambiguous: the quote is in both b\/x\.js and x\.js, so this finding authorizes no file at close/)
  commit({ 'x.js': 'export const x = 2\n', 'b/x.js': 'export const x = 2\n' })
  refused(record.id, FIXED, /Fixed f1 needs a fix check/)
  assert.deepEqual(checked(record).asked, ['f1'])
  closedAs(record.id, FIXED, 'complete', [])
  const { original, check, out: checkedOut } = fixChecked(finding('b/x.js', 'export const x = 2'))
  assert.deepEqual(check.resolvedPaths, {}); assert.deepEqual(check.ambiguousPaths, { x1: ['b/x.js', 'x.js'] })
  assert.match(checkedOut, /x1: path ambiguous, the quote is in both b\/x\.js and x\.js; it authorizes no file at close/)
  commit({ 'x.js': 'export const x = 3\n' })
  closedAs(original.id, X_FIXED, 'partial', ['x.js'])
})
test('P9 an unverified finding records no path: it needs only that the fix check was asked about it', () => {
  const { record } = review([finding('src/one.js', 'not in the file')])
  assert.equal(record.findingDetails[0].status, 'unverified-quote'); assert.deepEqual(record.resolvedPaths, {})
  commit({ 'src/one.js': 'export const one = 3\n' })
  refused(record.id, FIXED, /Fixed f1 needs a fix check/)
  assert.deepEqual(checked(record).asked, ['f1'])
  closedAs(record.id, FIXED, 'complete', [])
  const { original } = fixChecked(finding('src/one.js', 'not in the file either'), 'unverified-quote')
  commit({ 'src/one.js': 'export const one = 4\n' })
  closedAs(original.id, X_FIXED, 'partial', ['src/one.js'])
})
test('P10 a reviewer-supplied resolvedPath, or any resolved… key, is dropped: the fixed rule asks only for the recorded path', () => {
  const forged = { resolvedPath: 'lib/two.js', resolvedCommit: 'deadbeef', ResolvedPaths: { f1: { path: 'lib/two.js' } }, resolved_path: 'lib/two.js' }
  const { record } = review([{ ...ONE, ...forged }])
  assert.deepEqual(Object.keys(record.findingDetails[0]).filter((k) => /^resolved/i.test(k)), [])
  assert.deepEqual(Object.keys(record.resolvedPaths), ['f1']); assert.equal(record.resolvedPaths.f1.path, 'src/one.js')
  commit({ 'src/one.js': 'export const one = 3\n' })
  const check = checked(record)
  assert.ok(!check.manifest.read.some(([p]) => p === 'lib/two.js'), 'the forged path is never read, and never asked for')
  closedAs(record.id, FIXED, 'complete', [])
  const { original, check: second } = fixChecked({ ...finding('src/one.js', 'export const one = 3'), ...forged })
  assert.equal(second.resolvedPaths.x1.path, 'src/one.js')
  commit({ 'lib/two.js': 'export const two = 3\n' })
  closedAs(original.id, X_FIXED, 'partial', ['lib/two.js'])
})
test('P11 a legacy log entry without resolvedPaths fails closed: a fixed finding needs a fix check that was asked about it', () => {
  const head = git('rev-parse', 'HEAD'), base = git('merge-base', 'main', 'HEAD')
  const legacy = { ...ONE, severity: 'medium', id: 'f1', status: 'verified-quote' }
  seed({ type: 'review', kind: 'review', id: 'legacy-review', head, base: 'main', baseSha: base, branch: 'feat', repo: 'repo', family: 'fixture', model: 'fixture-only', findingDetails: [legacy] })
  commit({ 'src/one.js': 'export const one = 3\n' })
  refused('legacy-review', FIXED, /Fixed f1 needs a fix check/)
  seed({ type: 'review', kind: 'fix-check', id: 'legacy-check', review: 'legacy-review', head: git('rev-parse', 'HEAD'), branch: 'feat', repo: 'repo', family: 'fixture', model: 'fixture-only',
    findingDetails: [] })
  refused('legacy-review', FIXED, /Fixed f1: the fix check legacy-check was not asked about it/)
  // A populated asked list that leaves f1 out is the same refusal.
  seed({ type: 'review', kind: 'review', id: 'legacy-review-2', head, base: 'main', baseSha: base, branch: 'feat', repo: 'repo', family: 'fixture', model: 'fixture-only', findingDetails: [legacy] })
  seed({ type: 'review', kind: 'fix-check', id: 'legacy-check-2', review: 'legacy-review-2', head: git('rev-parse', 'HEAD'), branch: 'feat', repo: 'repo', family: 'fixture', model: 'fixture-only',
    findingDetails: [], asked: ['f2'] })
  refused('legacy-review-2', FIXED, /Fixed f1: the fix check legacy-check-2 was not asked about it/)
})
test('P12 a rename after the fix check is a delete plus an add: both paths are unseen', () => {
  const { original } = fixChecked(ONE)
  git('mv', 'src/one.js', 'src/uno.js'); git('commit', '-qm', 'rename one')
  closedAs(original.id, X_FIXED, 'partial', ['src/one.js', 'src/uno.js'])
})
test('P13 a Grade reads no diff: its close covers nothing, the leading-space file and the file without the space are each unseen', () => {
  const grade = (verdict, recheckOf) => {
    const path = join(ROOT, 'grade.json')
    writeFileSync(path, JSON.stringify({ family: 'fixture', model: 'fixture-only', vendor: 'codex', criteria: [
      { id: 'criterion-1', criterion: 'Return the right value', verdict, evidence: `value test ${verdict}` }] }))
    allowed(script(['--log-grade', path, ...(recheckOf ? ['--recheck-of', recheckOf] : [])]))
    return records().at(-1)
  }
  const original = grade('FAIL')
  commit({ ' src/one.js': 'the fix lives here\n' })
  grade('PASS', original.id)
  commit({ 'src/one.js': 'export const one = 3\n' })
  closedAs(original.id, { c1: { status: 'fixed' } }, 'partial', [' src/one.js', 'src/one.js'])
})

// A file whose name has a raw 0xff byte, which APFS cannot hold on disk: added through the index and marked
// skip-worktree, so the work tree stays clean. Committed with the next commit().
function stageByteName(prefix, suffix, content) {
  const name = Buffer.concat([Buffer.from(prefix), Buffer.from([0xff]), Buffer.from(suffix)])
  const plumb = (args, input) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: REPO, env: env(), input })
    assert.equal(r.status, 0, String(r.stderr))
    return String(r.stdout).trim()
  }
  const blob = plumb(['hash-object', '-w', '--stdin'], content)
  plumb(['update-index', '-z', '--index-info'], Buffer.concat([Buffer.from(`100644 ${blob}\t`), name, Buffer.from([0])]))
  plumb(['update-index', '-z', '--skip-worktree', '--stdin'], Buffer.concat([name, Buffer.from([0])]))
}
const FFFD = 'src/�.js'

const notUtf8 = /git diff --name-only [0-9a-f]{40} [0-9a-f]{40} lists a file name that is not valid UTF-8 \(bytes 7372632fff2e6a73\); the gate compares exact names, so it refuses/

test('P14 a file changed and then reverted after the fix check is no change: only the net diff is unseen', () => {
  const { original, check } = fixChecked(ONE)
  commit({ 'lib/two.js': 'export const two = 2\n' })
  commit({ 'lib/two.js': 'export const two = 1\n' })
  commit({ 'src/one.js': 'export const one = 3\n' })
  assert.equal(git('diff', '--name-only', check.head, 'HEAD'), 'src/one.js')
  closedAs(original.id, X_FIXED, 'partial', ['src/one.js'])
})
test('P15 a file changed and then reverted after the review is no change: the fix check reads the net diff and the close completes', () => {
  const { record } = review([ONE])
  commit({ 'lib/two.js': 'export const two = 2\n' })
  commit({ 'lib/two.js': 'export const two = 1\n' })
  commit({ 'src/one.js': 'export const one = 3\n' })
  assert.equal(git('diff', '--name-only', record.head, 'HEAD'), 'src/one.js')
  assert.deepEqual(checked(record).manifest.read.map(([p]) => p), ['src/one.js'])
  closedAs(record.id, FIXED, 'complete', [])
})
test('P16 a merge after the fix check that brings in an unnamed file leaves it unseen; one whose change the merge dropped is no change', () => {
  const { original, check } = fixChecked(ONE)
  git('checkout', '-qb', 'side'); commit({ 'm.js': 'export const m = 1\n' }); git('checkout', '-q', 'feat')
  commit({ 'src/one.js': 'export const one = 3\n' })
  git('merge', '--no-ff', '-qm', 'merge side', 'side')
  closedAs(original.id, X_FIXED, 'partial', ['m.js', 'src/one.js'])
  git('reset', '-q', '--hard', check.head)
  git('checkout', '-qb', 'kept'); commit({ 'lib/two.js': 'export const two = 2\n' }); git('checkout', '-q', 'feat')
  commit({ 'src/one.js': 'export const one = 3\n' })
  git('merge', '-s', 'ours', '--no-ff', '-qm', 'merge kept, keeping ours', 'kept')
  assert.equal(git('diff', '--name-only', check.head, 'HEAD'), 'src/one.js')
  closedAs(original.id, X_FIXED, 'partial', ['src/one.js'])
})
test('P17 a raw 0xff file name next to a recorded U+FFFD file refuses the close, naming the problem', () => {
  commit({ [FFFD]: 'export const odd = 1\n' })
  const { record } = review([finding(FFFD, 'export const odd = 1')])
  assert.equal(record.resolvedPaths.f1.path, FFFD)
  commit({ [FFFD]: 'export const odd = 2\n' })
  checked(record)
  stageByteName('src/', '.js', 'export const odd = 2\n')
  commit({ 'lib/two.js': 'export const two = 2\n' })
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '')
  refused(record.id, FIXED, notUtf8)
})
test('P18 after a fix check too, a raw 0xff file name next to the recorded U+FFFD file refuses the close', () => {
  commit({ [FFFD]: 'export const odd = 1\n' })
  const { original, check } = fixChecked(finding(FFFD, 'export const odd = 1'))
  assert.equal(check.resolvedPaths.x1.path, FFFD)
  stageByteName('src/', '.js', 'export const odd = 2\n')
  commit({ [FFFD]: 'export const odd = 2\n' })
  refused(original.id, X_FIXED, notUtf8)
})
