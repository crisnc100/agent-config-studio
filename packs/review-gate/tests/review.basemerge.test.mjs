import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// A reviewed, closed branch that merges in the default branch: content already on origin's default branch needs no
// coverage, a clean merge re-closes the existing review at the merge tip with no model call, and files changed on both
// sides (or edited inside the merge commit) still need a review. The default branch comes only from a symbolic
// refs/remotes/origin/HEAD whose target exists, and only for pushes to origin. Pushes go through the installed hook
// with REVIEW_BASE unset; reviews and closes keep REVIEW_BASE=main as in the coverage fixture.
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime')
const ROOT = mkdtempSync(join(tmpdir(), 'review-basemerge-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), REMOTE = join(ROOT, 'remote.git'), MIRROR = join(ROOT, 'mirror.git')
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

// A null value removes the variable, so a push runs with REVIEW_BASE unset.
function env(extra = {}) {
  const all = { HOME, CODEX_HOME: join(HOME, '.codex'), GROK_HOME: join(HOME, '.grok'), GIT_CONFIG_GLOBAL: join(HOME, 'isolated.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1', PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: ROOT, REVIEW_BASE: 'main', REVIEW_REVIEWER: 'sol', ...extra }
  for (const key of Object.keys(all)) if (all[key] == null) delete all[key]
  return all
}
function run(command, args, extra = {}, cwd = REPO) {
  const r = spawnSync(command, args, { cwd, env: env(extra), encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 })
  return { ...r, out: `${r.stdout || ''}\n${r.stderr || ''}` }
}
const script = (args, extra = {}) => run(process.execPath, [SCRIPT, ...args], extra)
function git(...args) {
  const r = run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  assert.equal(r.status, 0, r.out)
  return r.stdout.trim()
}
const gitTry = (...args) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
function write(files) {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) { git('rm', '-q', path); continue }
    mkdirSync(dirname(join(REPO, path)), { recursive: true })
    writeFileSync(join(REPO, path), text)
    git('add', path)
  }
}
function commit(files, message = `change ${Object.keys(files).join(' ')}`) {
  write(files)
  git('commit', '-qm', message)
  return git('rev-parse', 'HEAD')
}
const records = () => existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const calls = () => readdirSync(CALLS).map((p) => JSON.parse(readFileSync(join(CALLS, p), 'utf8')))
const resetCalls = () => { rmSync(CALLS, { recursive: true, force: true }); mkdirSync(CALLS) }
const allowed = (r) => assert.equal(r.status, 0, r.out)
function blocked(r, pattern) {
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /Run \/code-review/)
  if (pattern) assert.match(r.out, pattern)
}
// The gate runs with REVIEW_BASE unset unless a test sets it.
const push = (ref = 'HEAD:refs/heads/feat', extra = {}, remote = 'origin') => run('git', ['push', remote, ref], { REVIEW_BASE: null, ...extra })
function review(paths, extra = {}) {
  const r = script([], { REVIEW_PATHS: paths || '', ...extra })
  allowed(r)
  return records().filter((e) => e.type === 'review' && e.kind === 'review').at(-1)
}
function close(id, statuses = {}, extra = {}) {
  const path = join(ROOT, 'statuses.json')
  writeFileSync(path, JSON.stringify(statuses))
  const before = records().length
  const r = script(['--close', id, '--status', path, '--test-cmd', 'true'], extra)
  return { ...r, record: records().length > before ? records().at(-1) : null }
}
function closed(id, statuses, extra) {
  const r = close(id, statuses, extra)
  allowed(r); assert.equal(r.record.type, 'close'); assert.equal(r.record.status, 'complete', r.out)
  return r.record
}
function fixCheck(id, findings = []) {
  allowed(script(['--fix-check', id], { STUB_FINDINGS: JSON.stringify({ findings }) }))
  const check = records().at(-1)
  assert.equal(check.kind, 'fix-check')
  return check
}
const esc = (s) => s.replace(/[./()]/g, '\\$&')
const uncovered = (files) => new RegExp(`${files.length} file\\(s\\) uncovered: ${files.map(esc).join(', ')} —`)
const F1 = { issue: 'one is wrong', file: 'src/one.js', line: '1', quote: 'export const one = 2', suggestion: 'fix it',
  likelihood: 5, impact: 5, protected: false, trigger: 'importing one' }
const SHARED = 'a\nb\nc\nd\ne\nf\ng\n'
const head = () => git('rev-parse', 'HEAD')
const setOriginHead = () => git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
const originHeadStatus = () => gitTry('symbolic-ref', '-q', 'refs/remotes/origin/HEAD')
// Another branch off main changes `files`, is reviewed and closed there, then lands on main as a squash commit that
// reaches origin (outside the hook: main's own push is not under test) and is fetched back.
function landOnMain(files, name = 'other') {
  const back = git('rev-parse', '--abbrev-ref', 'HEAD')
  git('checkout', '-q', 'main'); git('checkout', '-qb', name)
  commit(files)
  closed(review().id)
  git('checkout', '-q', 'main')
  git('merge', '--squash', '-q', name)
  git('commit', '-qm', `${name} (#1)`)
  git('push', '-q', '--no-verify', 'origin', 'main')
  git('fetch', '-q', 'origin')
  git('checkout', '-q', back)
}
const mergeMain = () => git('merge', '--no-edit', '-q', 'origin/main')

beforeEach(() => {
  for (const path of [HOME, REPO, REMOTE, MIRROR, CALLS]) rmSync(path, { recursive: true, force: true })
  mkdirSync(SKILL, { recursive: true }); mkdirSync(dirname(LOG), { recursive: true }); mkdirSync(REPO); mkdirSync(CALLS)
  copyFileSync(join(SOURCE, 'review.mjs'), SCRIPT)
  cpSync(join(SOURCE, 'hooks'), join(SKILL, 'hooks'), { recursive: true, verbatimSymlinks: true })
  git('init', '-q', '-b', 'main')
  commit({ 'README.md': 'base\n', 'src/one.js': 'export const one = 1\n', 'lib/two.js': 'export const two = 1\n', 'docs/three.md': 'three\n', 'shared.js': SHARED })
  git('init', '--bare', '-q', REMOTE)
  git('remote', 'add', 'origin', REMOTE)
  git('push', '-q', '--no-verify', 'origin', 'main')
  git('fetch', '-q', 'origin')
  setOriginHead()
  git('checkout', '-qb', 'feat')
  commit({ 'src/one.js': 'export const one = 2\n', 'docs/three.md': 'three, edited\n' })
  allowed(run('sh', [join(SKILL, 'hooks/install-hook.sh'), REPO]))
})

test('BM1 a clean merge of the default branch re-closes the existing review at the merge tip and pushes with no model call', () => {
  const r = review()
  closed(r.id)
  landOnMain({ 'lib/two.js': 'export const two = 2\n' })
  mergeMain()
  resetCalls()
  // Before the re-close every file is covered; the note asks for the re-close, not a review.
  const early = push()
  blocked(early, /every changed file is covered, but no complete close is at the tip: re-close the existing review/)
  assert.doesNotMatch(early.out, /close a review at the tip/)
  const summary = script(['--summary'], { REVIEW_BASE: null })
  assert.notEqual(summary.status, 0)
  assert.match(summary.out, /re-close the existing review/)
  const record = closed(r.id)
  assert.equal(record.closeHead, head()); assert.deepEqual(record.outOfScope, [])
  // The re-close's tier measures from the new base: main's lib/two.js is not the branch's change.
  assert.equal(record.stats.files, 2, JSON.stringify(record.stats))
  assert.ok(!record.tierReasons.some((reason) => /lib\/two\.js/.test(reason)), JSON.stringify(record.tierReasons))
  const pushed = push(); allowed(pushed)
  assert.equal(calls().length, 0, 'no model call after the merge')
  // --summary and the gate agree on the same tip.
  const shown = script(['--summary'], { REVIEW_BASE: null }); allowed(shown)
  assert.ok(pushed.stderr.includes(shown.stdout.trim()), pushed.out)
  assert.doesNotMatch(shown.stdout, /lib\/two\.js/)
})

test('BM2 a file both sides changed (a resolved conflict) is the only one named; a slice review of it at the tip lets the push through', () => {
  commit({ 'shared.js': SHARED.replace('a\n', 'A-feat\n') })
  const r = review()
  closed(r.id)
  landOnMain({ 'lib/two.js': 'export const two = 2\n', 'shared.js': SHARED.replace('a\n', 'A-main\n') })
  const conflicted = gitTry('merge', '--no-edit', '-q', 'origin/main')
  assert.notEqual(conflicted.status, 0, 'the merge conflicts')
  write({ 'shared.js': SHARED.replace('a\n', 'A-both\n') })
  git('commit', '--no-edit', '-q')
  resetCalls()
  const refused = push()
  blocked(refused, uncovered(['shared.js']))
  assert.match(refused.out, /changed on both sides of a merge of the default branch/)
  assert.match(refused.out, /REVIEW_PATHS=shared\.js/)
  assert.doesNotMatch(refused.out, /lib\/two\.js|src\/one\.js|docs\/three\.md/)
  const summary = script(['--summary'], { REVIEW_BASE: null })
  assert.notEqual(summary.status, 0); assert.match(summary.out, uncovered(['shared.js']))
  // Re-closing the existing review without a fix check goes partial and names the both-sides file.
  const partial = close(r.id)
  allowed(partial); assert.equal(partial.record.status, 'partial'); assert.deepEqual(partial.record.outOfScope, ['shared.js'])
  assert.match(partial.out, /changed on both sides of a merge of the default branch: shared\.js/)
  assert.match(partial.out, /REVIEW_PATHS=shared\.js/)
  closed(review('shared.js').id)
  const [call] = calls()
  assert.equal(calls().length, 1)
  assert.match(call.prompt, /A-both/); assert.doesNotMatch(call.prompt, /export const one = 2|export const two = 2/)
  allowed(push())
})

test('BM3 a merged branch that is not on the default branch stays uncovered, whatever REVIEW_BASE or a repo config says', () => {
  const r = review()
  closed(r.id)
  landOnMain({ 'lib/two.js': 'export const two = 2\n' })
  mergeMain()
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'unreviewed')
  commit({ 'extra.js': 'export const extra = 1\n' })
  git('checkout', '-q', 'feat')
  git('merge', '--no-ff', '--no-edit', '-q', 'unreviewed')
  const partial = close(r.id)
  // A merge of any other branch keeps the old rule: every file its diff against either parent lists.
  allowed(partial); assert.equal(partial.record.status, 'partial'); assert.ok(partial.record.outOfScope.includes('extra.js'))
  blocked(push(), uncovered(['extra.js']))
  blocked(push(undefined, { REVIEW_BASE: 'unreviewed' }), uncovered(['extra.js']))
  blocked(push(undefined, { REVIEW_BASE: 'feat' }), uncovered(['extra.js']))
  mkdirSync(join(REPO, '.claude'), { recursive: true })
  writeFileSync(join(REPO, '.claude/review-config.json'), JSON.stringify({ base: 'unreviewed' }))
  blocked(push(), uncovered(['extra.js']))
})

test('BM4 origin/HEAD missing, detached or dangling, or a push to another remote, keeps the old rule; the gate never sets origin/HEAD', () => {
  const r = review()
  closed(r.id)
  landOnMain({ 'lib/two.js': 'export const two = 2\n' })
  mergeMain()
  // With origin/HEAD missing, the close keeps the old rule too: main's file is out of scope.
  git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
  const old = close(r.id)
  allowed(old); assert.equal(old.record.status, 'partial'); assert.deepEqual(old.record.outOfScope, ['docs/three.md', 'lib/two.js', 'src/one.js'])
  assert.notEqual(originHeadStatus().status, 0, 'the close set no origin/HEAD')
  setOriginHead()
  closed(r.id)
  allowed(push('HEAD:refs/heads/t1'))
  git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
  blocked(push('HEAD:refs/heads/t2'), uncovered(['lib/two.js']))
  assert.notEqual(originHeadStatus().status, 0, 'the gate set no origin/HEAD')
  // Detached: a plain sha, not a symbolic ref.
  git('update-ref', '--no-deref', 'refs/remotes/origin/HEAD', git('rev-parse', 'origin/main'))
  blocked(push('HEAD:refs/heads/t3'), uncovered(['lib/two.js']))
  git('update-ref', '-d', '--no-deref', 'refs/remotes/origin/HEAD')
  // Dangling: a symbolic ref whose target does not exist; and one that leaves refs/remotes/origin/.
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/nope')
  blocked(push('HEAD:refs/heads/t4'), uncovered(['lib/two.js']))
  assert.equal(originHeadStatus().stdout.trim(), 'refs/remotes/origin/nope')
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/main')
  blocked(push('HEAD:refs/heads/t5'), uncovered(['lib/two.js']))
  setOriginHead()
  allowed(push('HEAD:refs/heads/t6'))
  // Another remote: origin's default branch is not trusted for it.
  git('init', '--bare', '-q', MIRROR)
  git('remote', 'add', 'mirror', MIRROR)
  blocked(push(undefined, {}, 'mirror'), uncovered(['lib/two.js']))
  // The gate run straight, without a remote name, keeps the old rule as well.
  const input = `refs/heads/feat ${head()} refs/heads/feat ${'0'.repeat(40)}\n`
  const straight = spawnSync(process.execPath, [SCRIPT, '--gate'], { cwd: REPO, env: env({ REVIEW_BASE: null }), encoding: 'utf8', input })
  assert.notEqual(straight.status, 0, straight.stderr); assert.match(straight.stderr, uncovered(['lib/two.js']))
  const named = spawnSync(process.execPath, [SCRIPT, '--gate', '--remote', 'origin'], { cwd: REPO, env: env({ REVIEW_BASE: null }), encoding: 'utf8', input })
  assert.equal(named.status, 0, named.stderr)
})

test('BM5 an evil merge edit is never hidden: a branch-only file or an untouched file edited inside the merge commit is named', () => {
  const r = review()
  closed(r.id)
  landOnMain({ 'lib/two.js': 'export const two = 2\n' })
  mergeMain()
  write({ 'src/one.js': 'export const one = 99\n', 'README.md': 'evil\n' })
  git('commit', '--amend', '--no-edit', '-q')
  assert.equal(git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'still a merge commit')
  resetCalls()
  const partial = close(r.id)
  allowed(partial); assert.equal(partial.record.status, 'partial'); assert.deepEqual(partial.record.outOfScope, ['README.md', 'src/one.js'])
  blocked(push(), uncovered(['README.md', 'src/one.js']))
})

test('BM5 a file git auto-merged from both sides (different lines, no conflict) is still named', () => {
  commit({ 'shared.js': SHARED.replace('a\n', 'A-feat\n') })
  const r = review()
  closed(r.id)
  landOnMain({ 'shared.js': SHARED.replace('g\n', 'G-main\n') })
  mergeMain()
  assert.equal(readFileSync(join(REPO, 'shared.js'), 'utf8'), SHARED.replace('a\n', 'A-feat\n').replace('g\n', 'G-main\n'))
  const partial = close(r.id)
  allowed(partial); assert.equal(partial.record.status, 'partial'); assert.deepEqual(partial.record.outOfScope, ['shared.js'])
  const refused = push()
  blocked(refused, uncovered(['shared.js']))
  assert.match(refused.out, /changed on both sides of a merge of the default branch/)
})

test('BM5b a clean fix check before the merge re-closes cleanly, even when main touched a riskPaths file', () => {
  const r = review('', { STUB_FINDINGS: JSON.stringify({ findings: [F1] }) })
  commit({ 'src/one.js': 'export const one = 3\n' })
  fixCheck(r.id)
  closed(r.id, { f1: { status: 'fixed' } })
  allowed(push())
  landOnMain({ 'src/auth.js': 'export const auth = 1\n' })
  mergeMain()
  resetCalls()
  const early = push()
  blocked(early, /re-close the existing review/)
  assert.doesNotMatch(early.out, /code-review close|touch riskPaths/)
  const record = closed(r.id, { f1: { status: 'fixed' } })
  assert.deepEqual(record.outOfScope, [])
  assert.ok(!record.tierReasons.some((reason) => /auth/.test(reason)), JSON.stringify(record.tierReasons))
  allowed(push())
  assert.equal(calls().length, 0, 'no model call after the merge')
})

test('BM5b with a fix check, a both-sides file refuses the re-close and names it; its slice at the tip lets the push through', () => {
  commit({ 'shared.js': SHARED.replace('a\n', 'A-feat\n') })
  const r = review('', { STUB_FINDINGS: JSON.stringify({ findings: [F1] }) })
  commit({ 'src/one.js': 'export const one = 3\n' })
  fixCheck(r.id)
  closed(r.id, { f1: { status: 'fixed' } })
  landOnMain({ 'shared.js': SHARED.replace('g\n', 'G-main\n') })
  mergeMain()
  const refused = close(r.id, { f1: { status: 'fixed' } })
  assert.notEqual(refused.status, 0); assert.equal(refused.record, null)
  assert.match(refused.out, /changed on both sides of a merge of the default branch: shared\.js/)
  assert.match(refused.out, /REVIEW_PATHS=shared\.js/)
  assert.doesNotMatch(refused.out, /Fixes land before the fix check/)
  resetCalls()
  closed(review('shared.js').id)
  assert.equal(calls().length, 1)
  allowed(push())
})

test('BM5b a sliced review re-closed at a merge tip covers the tip together with the other slice', () => {
  const src = review('src/'), docs = review('docs/')
  closed(src.id); closed(docs.id)
  landOnMain({ 'lib/two.js': 'export const two = 2\n' })
  mergeMain()
  resetCalls()
  const record = closed(src.id)
  assert.deepEqual(record.outOfScope, [])
  allowed(push())
  assert.equal(calls().length, 0)
})

test('BM6 a rebase onto the new default branch still needs coverage, as before', () => {
  const r = review()
  closed(r.id)
  landOnMain({ 'lib/two.js': 'export const two = 2\n' })
  git('rebase', '-q', 'origin/main')
  blocked(push(), /No complete close covers tip/)
  const refused = close(r.id)
  assert.notEqual(refused.status, 0); assert.match(refused.out, /HEAD is neither the reviewed commit nor a descendant/)
})

// ── fix round: merge content a fixed status or an earlier record never saw ──
const FS = { ...F1, issue: 'shared is wrong', file: 'shared.js', quote: 'A-feat', trigger: 'loading shared' }
const mirror = () => { git('init', '--bare', '-q', MIRROR); git('remote', 'add', 'mirror', MIRROR) }

test('BM7 an edit inside the merge commit to a file fixed before the merge is out of scope at the re-close and uncovered at the gate', () => {
  const r = review('', { STUB_FINDINGS: JSON.stringify({ findings: [F1] }) })
  commit({ 'src/one.js': 'export const one = 3\n' })
  closed(r.id, { f1: { status: 'fixed' } })
  landOnMain({ 'lib/two.js': 'export const two = 2\n' })
  mergeMain()
  write({ 'src/one.js': 'export const one = 99\n' })
  git('commit', '--amend', '--no-edit', '-q')
  const partial = close(r.id, { f1: { status: 'fixed' } })
  allowed(partial); assert.equal(partial.record.status, 'partial', partial.out); assert.deepEqual(partial.record.outOfScope, ['src/one.js'])
  blocked(push(), uncovered(['src/one.js']))
  mirror()
  const elsewhere = push(undefined, {}, 'mirror')
  blocked(elsewhere, /src\/one\.js/)
})

test('BM7 a both-sides file with a fixed status, resolved to main\'s version, gains no coverage: origin trusts main\'s content, another remote does not', () => {
  commit({ 'g.js': 'export const g = 1\n', 'shared.js': SHARED.replace('a\n', 'A-feat\n') })
  const r = review('', { STUB_FINDINGS: JSON.stringify({ findings: [FS] }) })
  commit({ 'shared.js': SHARED.replace('a\n', 'A-fix\n') })
  closed(r.id, { f1: { status: 'fixed' } })
  landOnMain({ 'lib/two.js': 'export const two = 2\n', 'shared.js': SHARED.replace('a\n', 'A-main\n') })
  assert.notEqual(gitTry('merge', '--no-edit', '-q', 'origin/main').status, 0, 'the merge conflicts')
  git('checkout', '--theirs', 'shared.js'); git('add', 'shared.js')
  git('commit', '--no-edit', '-q')
  assert.equal(readFileSync(join(REPO, 'shared.js'), 'utf8'), SHARED.replace('a\n', 'A-main\n'))
  const record = closed(r.id, { f1: { status: 'fixed' } })
  assert.ok(!record.coverage.some(([path]) => path === 'shared.js'), JSON.stringify(record.coverage))
  allowed(push())
  mirror()
  blocked(push(undefined, {}, 'mirror'), uncovered(['lib/two.js', 'shared.js']))
})

test('BM7 a file a merge-tip fix check left out (onlyFiles) gains no coverage from a fixed status', () => {
  commit({ 'shared.js': SHARED.replace('a\n', 'A-feat\n') })
  const r = review('', { STUB_FINDINGS: JSON.stringify({ findings: [FS] }) })
  landOnMain({ 'lib/two.js': 'export const two = 2\n', 'shared.js': SHARED.replace('a\n', 'A-main\n') })
  assert.notEqual(gitTry('merge', '--no-edit', '-q', 'origin/main').status, 0, 'the merge conflicts')
  git('checkout', '--theirs', 'shared.js'); git('add', 'shared.js')
  git('commit', '--no-edit', '-q')
  commit({ 'src/one.js': 'export const one = 3\n' })
  const check = fixCheck(r.id)
  assert.ok(check.onlyFiles.includes('src/one.js') && !check.onlyFiles.includes('shared.js'), JSON.stringify(check.onlyFiles))
  const record = closed(r.id, { f1: { status: 'fixed' } })
  assert.ok(!record.coverage.some(([path]) => path === 'shared.js'), JSON.stringify(record.coverage))
  allowed(push())
  mirror()
  blocked(push(undefined, {}, 'mirror'), /shared\.js/)
})

test('BM7 a both-sides file a fix check saw at the merge tip is in scope with a fixed status, and covered', () => {
  commit({ 'shared.js': SHARED.replace('a\n', 'A-feat\n') })
  const r = review('', { STUB_FINDINGS: JSON.stringify({ findings: [FS] }) })
  landOnMain({ 'shared.js': SHARED.replace('g\n', 'G-main\n') })
  mergeMain()
  commit({ 'shared.js': SHARED.replace('a\n', 'A-fix\n').replace('g\n', 'G-main\n') })
  fixCheck(r.id)
  const record = closed(r.id, { f1: { status: 'fixed' } })
  assert.ok(record.coverage.some(([path]) => path === 'shared.js'))
  allowed(push())
})

test('BM8 an origin/HEAD naming a missing remote ref never resolves through a tag of the same name', () => {
  const r = review()
  closed(r.id)
  landOnMain({ 'lib/two.js': 'export const two = 2\n' })
  mergeMain()
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/missing')
  git('tag', 'refs/remotes/origin/missing', 'origin/main')
  const old = close(r.id)
  allowed(old); assert.equal(old.record.status, 'partial'); assert.ok(old.record.outOfScope.includes('lib/two.js'))
  setOriginHead()
  closed(r.id)
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/missing')
  blocked(push(), uncovered(['lib/two.js']))
})

test('BM9 with REVIEW_BASE unset and origin/HEAD missing, close and --summary do not trust an origin/HEAD their own base detection set', () => {
  run('git', ['--git-dir', REMOTE, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  const r = review()
  closed(r.id)
  landOnMain({ 'lib/two.js': 'export const two = 2\n' })
  mergeMain()
  git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
  const old = close(r.id, {}, { REVIEW_BASE: null })
  allowed(old); assert.equal(old.record.status, 'partial', old.out); assert.ok(old.record.outOfScope.includes('lib/two.js'))
  gitTry('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
  const summary = script(['--summary'], { REVIEW_BASE: null })
  assert.notEqual(summary.status, 0, summary.out); assert.match(summary.out, /lib\/two\.js/)
})

test('BM10 a both-sides refusal names the existing review that keeps covering every other file, at the gate and at close', () => {
  commit({ 'shared.js': SHARED.replace('a\n', 'A-feat\n') })
  const r = review()
  closed(r.id)
  landOnMain({ 'shared.js': SHARED.replace('g\n', 'G-main\n') })
  mergeMain()
  const keeps = new RegExp(`slice-review just (that file|those files) at the tip \\(REVIEW_PATHS=shared\\.js\\) and close that slice; review ${r.id} keeps covering every other file`)
  blocked(push(), keeps)
  const partial = close(r.id)
  allowed(partial); assert.equal(partial.record.status, 'partial'); assert.match(partial.out, keeps)
})

test('BM10 with a fix check, the both-sides refusal at close names the existing review', () => {
  commit({ 'shared.js': SHARED.replace('a\n', 'A-feat\n') })
  const r = review('', { STUB_FINDINGS: JSON.stringify({ findings: [F1] }) })
  commit({ 'src/one.js': 'export const one = 3\n' })
  fixCheck(r.id)
  closed(r.id, { f1: { status: 'fixed' } })
  landOnMain({ 'shared.js': SHARED.replace('g\n', 'G-main\n') })
  mergeMain()
  const refused = close(r.id, { f1: { status: 'fixed' } })
  assert.notEqual(refused.status, 0)
  assert.match(refused.out, new RegExp(`close that slice; review ${r.id} keeps covering every other file`))
})

// ── leftovers after the merge of main ──
test('BM11 a PASS Grade recheck after the merge counts as having seen the both-sides file it graded: the Grade close is complete', () => {
  commit({ 'shared.js': SHARED.replace('a\n', 'A-feat\n') })
  const verdict = join(ROOT, 'verdict.json')
  const criterion = { id: '2.1', criterion: 'Shared reads A', verdict: 'FAIL', evidence: 'shared test fails' }
  writeFileSync(verdict, JSON.stringify({ family: 'opus', model: 'stub-opus', criteria: [criterion] }))
  allowed(script(['--log-grade', verdict]))
  const grade = records().at(-1)
  assert.equal(grade.kind, 'grade')
  landOnMain({ 'shared.js': SHARED.replace('g\n', 'G-main\n') })
  mergeMain()
  commit({ 'shared.js': SHARED.replace('a\n', 'A-fix\n').replace('g\n', 'G-main\n') })
  writeFileSync(verdict, JSON.stringify({ family: 'opus', model: 'stub-opus', criteria: [{ ...criterion, verdict: 'PASS', evidence: 'shared recheck passes' }] }))
  allowed(script(['--log-grade', verdict, '--recheck-of', grade.id]))
  const record = closed(grade.id, { c1: { status: 'fixed' } })
  assert.deepEqual(record.outOfScope, [])
  assert.ok(record.coverage.some(([path]) => path === 'shared.js'), JSON.stringify(record.coverage))
})

test('BM12 close and --summary never write origin/HEAD: a missing one is warned about and falls back, with no ref created', () => {
  run('git', ['--git-dir', REMOTE, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  const r = review()
  git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
  const summary = script(['--summary'], { REVIEW_BASE: null })
  assert.match(summary.out, /Could not resolve origin\/HEAD/)
  assert.notEqual(originHeadStatus().status, 0, 'summary created no origin/HEAD')
  const done = close(r.id, {}, { REVIEW_BASE: null })
  allowed(done); assert.match(done.out, /Could not resolve origin\/HEAD/)
  assert.notEqual(originHeadStatus().status, 0, 'close created no origin/HEAD')
})

test('BM13 a file the review saw at a state that equals main\'s keeps its coverage: another remote does not refuse it', () => {
  commit({ 'lib/two.js': 'export const two = 2\n' })
  const r = review()
  closed(r.id)
  landOnMain({ 'lib/two.js': 'export const two = 2\n', 'lib/four.js': 'export const four = 4\n' })
  mergeMain()
  const record = closed(r.id)
  assert.ok(record.coverage.some(([path]) => path === 'lib/two.js'), JSON.stringify(record.coverage))
  allowed(push())
  mirror()
  blocked(push(undefined, {}, 'mirror'), uncovered(['lib/four.js']))
})
