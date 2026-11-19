import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// A reviewed, closed branch that merges in the default branch. Coverage is measured from the coverage base, the tip's
// merge base with the default branch: a file only main changed is no change there, a file only the branch changed keeps
// the triple its review read, so a clean merge re-closes the existing review at the merge tip with no model call, and a
// file both sides changed (or edited inside the merge commit) has a new triple that needs a fresh read. The default branch comes only from a symbolic
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
  blocked(early, /every changed file is covered, but no close is at the tip/)
  const summary = script(['--summary'], { REVIEW_BASE: null })
  assert.notEqual(summary.status, 0)
  assert.match(summary.out, /every changed file is covered, but no close is at the tip/)
  const record = closed(r.id)
  assert.equal(record.closeHead, head()); assert.deepEqual(record.unseen, [])
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
  assert.match(refused.out, /REVIEW_PATHS=shared\.js/)
  assert.doesNotMatch(refused.out, /lib\/two\.js|src\/one\.js|docs\/three\.md/)
  const summary = script(['--summary'], { REVIEW_BASE: null })
  assert.notEqual(summary.status, 0); assert.match(summary.out, uncovered(['shared.js']))
  // Re-closing the existing review without a fix check goes partial and names the both-sides file.
  const partial = close(r.id)
  allowed(partial); assert.equal(partial.record.status, 'partial'); assert.deepEqual(partial.record.unseen, ['shared.js'])
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
  // A merge of any other branch brings content no review read.
  allowed(partial); assert.equal(partial.record.status, 'partial'); assert.deepEqual(partial.record.unseen, ['extra.js'])
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
  // With origin/HEAD missing, the close measures from the review's own base: main's file is unseen.
  git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
  const old = close(r.id)
  allowed(old); assert.equal(old.record.status, 'partial'); assert.deepEqual(old.record.unseen, ['lib/two.js'])
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
  allowed(partial); assert.equal(partial.record.status, 'partial'); assert.deepEqual(partial.record.unseen, ['README.md', 'src/one.js'])
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
  allowed(partial); assert.equal(partial.record.status, 'partial'); assert.deepEqual(partial.record.unseen, ['shared.js'])
  blocked(push(), uncovered(['shared.js']))
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
  blocked(early, /every changed file is covered, but no close is at the tip/)
  assert.doesNotMatch(early.out, /code-review close|touch riskPaths/)
  const record = closed(r.id, { f1: { status: 'fixed' } })
  assert.deepEqual(record.unseen, [])
  assert.ok(!record.tierReasons.some((reason) => /auth/.test(reason)), JSON.stringify(record.tierReasons))
  allowed(push())
  assert.equal(calls().length, 0, 'no model call after the merge')
})

test('BM5b with a fix check, a both-sides file leaves the re-close partial naming it; its slice at the tip lets the push through', () => {
  commit({ 'shared.js': SHARED.replace('a\n', 'A-feat\n') })
  const r = review('', { STUB_FINDINGS: JSON.stringify({ findings: [F1] }) })
  commit({ 'src/one.js': 'export const one = 3\n' })
  fixCheck(r.id)
  closed(r.id, { f1: { status: 'fixed' } })
  landOnMain({ 'shared.js': SHARED.replace('g\n', 'G-main\n') })
  mergeMain()
  const partial = close(r.id, { f1: { status: 'fixed' } })
  allowed(partial); assert.equal(partial.record.status, 'partial'); assert.deepEqual(partial.record.unseen, ['shared.js'])
  assert.match(partial.out, /REVIEW_PATHS=shared\.js/)
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
  assert.deepEqual(record.unseen, [])
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

test('BM7 an edit inside the merge commit to a file fixed before the merge is unseen at the re-close and uncovered at the gate', () => {
  const r = review('', { STUB_FINDINGS: JSON.stringify({ findings: [F1] }) })
  commit({ 'src/one.js': 'export const one = 3\n' })
  fixCheck(r.id)
  closed(r.id, { f1: { status: 'fixed' } })
  landOnMain({ 'lib/two.js': 'export const two = 2\n' })
  mergeMain()
  write({ 'src/one.js': 'export const one = 99\n' })
  git('commit', '--amend', '--no-edit', '-q')
  const partial = close(r.id, { f1: { status: 'fixed' } })
  allowed(partial); assert.equal(partial.record.status, 'partial', partial.out); assert.deepEqual(partial.record.unseen, ['src/one.js'])
  blocked(push(), uncovered(['src/one.js']))
  mirror()
  const elsewhere = push(undefined, {}, 'mirror')
  blocked(elsewhere, /src\/one\.js/)
})

test('BM7 a both-sides file resolved to main\'s version needs no read for origin, which trusts main\'s content; another remote still names it', () => {
  commit({ 'g.js': 'export const g = 1\n', 'shared.js': SHARED.replace('a\n', 'A-feat\n') })
  const r = review('', { STUB_FINDINGS: JSON.stringify({ findings: [FS] }) })
  commit({ 'shared.js': SHARED.replace('a\n', 'A-fix\n') })
  fixCheck(r.id)
  closed(r.id, { f1: { status: 'fixed' } })
  landOnMain({ 'lib/two.js': 'export const two = 2\n', 'shared.js': SHARED.replace('a\n', 'A-main\n') })
  assert.notEqual(gitTry('merge', '--no-edit', '-q', 'origin/main').status, 0, 'the merge conflicts')
  git('checkout', '--theirs', 'shared.js'); git('add', 'shared.js')
  git('commit', '--no-edit', '-q')
  assert.equal(readFileSync(join(REPO, 'shared.js'), 'utf8'), SHARED.replace('a\n', 'A-main\n'))
  const record = closed(r.id, { f1: { status: 'fixed' } })
  assert.deepEqual(record.unseen, [])
  allowed(push())
  mirror()
  blocked(push(undefined, {}, 'mirror'), uncovered(['lib/two.js', 'shared.js']))
})

test('BM7 a both-sides file a fix check saw at the merge tip is in scope with a fixed status, and covered', () => {
  commit({ 'shared.js': SHARED.replace('a\n', 'A-feat\n') })
  const r = review('', { STUB_FINDINGS: JSON.stringify({ findings: [FS] }) })
  landOnMain({ 'shared.js': SHARED.replace('g\n', 'G-main\n') })
  mergeMain()
  commit({ 'shared.js': SHARED.replace('a\n', 'A-fix\n').replace('g\n', 'G-main\n') })
  const check = fixCheck(r.id)
  assert.ok(check.manifest.read.some(([path]) => path === 'shared.js'), JSON.stringify(check.manifest.read))
  const record = closed(r.id, { f1: { status: 'fixed' } })
  assert.deepEqual(record.unseen, [])
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
  allowed(old); assert.equal(old.record.status, 'partial'); assert.ok(old.record.unseen.includes('lib/two.js'))
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
  allowed(old); assert.equal(old.record.status, 'partial', old.out); assert.ok(old.record.unseen.includes('lib/two.js'))
  gitTry('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
  const summary = script(['--summary'], { REVIEW_BASE: null })
  assert.notEqual(summary.status, 0, summary.out); assert.match(summary.out, /lib\/two\.js/)
})

// ── leftovers after the merge of main ──
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

test('BM13 a file both sides changed to the same blob: origin needs no read; for another remote the pre-merge review\'s exact triple still covers it, main\'s other file does not', () => {
  commit({ 'lib/two.js': 'export const two = 2\n' })
  const r = review()
  closed(r.id)
  landOnMain({ 'lib/two.js': 'export const two = 2\n', 'lib/four.js': 'export const four = 4\n' })
  mergeMain()
  const record = closed(r.id)
  assert.deepEqual(record.unseen, [])
  allowed(push())
  mirror()
  blocked(push(undefined, {}, 'mirror'), uncovered(['lib/four.js']))
})

// ── fresh-review fix round ──
test('BM14 a review based on another branch gets none of the default-branch rules: a reverted release edit plus main\'s newer version stays uncovered on another remote', () => {
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'release')
  commit({ 'lib/two.js': 'export const two = "release"\n' })
  git('checkout', '-qb', 'fromrelease')
  commit({ 'lib/two.js': 'export const two = 1\n', 'src/five.js': 'export const five = 5\n' })
  const r = review('', { REVIEW_BASE: 'release' })
  assert.equal(r.base, 'release')
  closed(r.id)
  landOnMain({ 'lib/two.js': 'export const two = 2\n' })
  mergeMain()
  assert.equal(readFileSync(join(REPO, 'lib/two.js'), 'utf8'), 'export const two = 2\n')
  const reclose = close(r.id)
  allowed(reclose)
  assert.equal(reclose.record.status, 'partial'); assert.ok(reclose.record.unseen.includes('lib/two.js'), JSON.stringify(reclose.record))
  mirror()
  blocked(push('HEAD:refs/heads/fromrelease', {}, 'mirror'), /lib\/two\.js/)
})

test('BM15 a test file conflict resolved wholly to main\'s version needs no read: the re-close completes', () => {
  commit({ 'src/one.test.js': 'test one feat\n' })
  const r = review()
  closed(r.id)
  landOnMain({ 'src/one.test.js': 'test one main\n' })
  assert.notEqual(gitTry('merge', '--no-edit', '-q', 'origin/main').status, 0, 'the merge conflicts')
  git('checkout', '--theirs', 'src/one.test.js'); git('add', 'src/one.test.js')
  git('commit', '--no-edit', '-q')
  const record = closed(r.id)
  assert.deepEqual(record.unseen, [])
  allowed(push())
})

test('BM17 with a pre-merge fix check, a both-sides file resolved wholly to main\'s version re-closes complete and the origin push passes', () => {
  commit({ 'shared.js': SHARED.replace('a\n', 'A-feat\n') })
  const r = review('', { STUB_FINDINGS: JSON.stringify({ findings: [F1] }) })
  commit({ 'src/one.js': 'export const one = 3\n' })
  fixCheck(r.id)
  closed(r.id, { f1: { status: 'fixed' } })
  landOnMain({ 'shared.js': SHARED.replace('a\n', 'A-main\n') })
  assert.notEqual(gitTry('merge', '--no-edit', '-q', 'origin/main').status, 0, 'the merge conflicts')
  git('checkout', '--theirs', 'shared.js'); git('add', 'shared.js')
  git('commit', '--no-edit', '-q')
  const record = closed(r.id, { f1: { status: 'fixed' } })
  assert.deepEqual(record.unseen, [])
  allowed(push())
})

// ── the fix check after a merge of main ──
const fixPrompt = () => calls().map((c) => c.prompt).find((p) => p.includes('Fix check:'))
test('BM18 a fix check after a main merge reviews a later deletion of a test the branch added, beside an unrelated fix', () => {
  commit({ 'src/one.test.js': 'test one feat\n' })
  const r = review('', { STUB_FINDINGS: JSON.stringify({ findings: [F1] }) })
  landOnMain({ 'lib/two.js': 'export const two = 2\n' })
  mergeMain()
  commit({ 'src/one.test.js': null, 'src/one.js': 'export const one = 3\n' })
  resetCalls()
  const check = fixCheck(r.id)
  const prompt = fixPrompt()
  assert.ok(prompt, 'the fix check called the model')
  assert.match(prompt, /src\/one\.test\.js/); assert.match(prompt, /test one feat/)
  // Its coverage block reads only the branch's change from the merge base: main's file is in no manifest.
  assert.ok(!check.manifest.read.some(([path]) => path === 'lib/two.js'), JSON.stringify(check.manifest.read))
})

test('BM18 a fix check after a main merge reviews a later restore of a test to main\'s version, beside an unrelated fix', () => {
  landOnMain({ 't/x.test.js': 'main v1\n' }, 'seed')
  mergeMain()
  commit({ 't/x.test.js': 'feat v2\n' })
  const r = review('', { STUB_FINDINGS: JSON.stringify({ findings: [F1] }) })
  landOnMain({ 'lib/two.js': 'export const two = 2\n' })
  mergeMain()
  commit({ 't/x.test.js': 'main v1\n', 'src/one.js': 'export const one = 3\n' })
  resetCalls()
  const check = fixCheck(r.id)
  const prompt = fixPrompt()
  assert.ok(prompt, 'the fix check called the model')
  assert.match(prompt, /t\/x\.test\.js/); assert.match(prompt, /feat v2/)
  assert.ok(!check.manifest.read.some(([path]) => path === 'lib/two.js'), JSON.stringify(check.manifest.read))
})

