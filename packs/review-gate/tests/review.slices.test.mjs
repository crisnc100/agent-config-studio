import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Sliced reviews (REVIEW_PATHS): the review, its close, the push gate and --summary, against stub CLIs
// in a temporary HOME. The push gate runs through the actual installed pre-push hook.
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime')
const ROOT = mkdtempSync(join(tmpdir(), 'review-slices-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), REMOTE = join(ROOT, 'remote.git')
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
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8') : a[a.indexOf('--json-schema')+1]
const prompt = a.includes('--output-schema') ? a.at(-1) : a[1]
fs.writeFileSync(path.join(${JSON.stringify(CALLS)}, process.pid+'-'+Date.now()+'.json'), JSON.stringify({prompt}))
const reply = schema.includes('"scores"') ? '{"scores":[]}' : (process.env.STUB_FINDINGS || '{"findings":[]}')
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1], reply)
else console.log(JSON.stringify({structured_output:JSON.parse(reply),structuredOutput:JSON.parse(reply),modelUsage:{'stub-grok':{}}}))
`
for (const name of ['codex', 'claude', 'grok']) stub(name, modelBody)
stub('jev', `require('node:fs').writeFileSync(${JSON.stringify(join(ROOT, 'unexpected-jev'))},'jev');process.exit(99)`)
after(() => {
  const unexpected = existsSync(join(ROOT, 'unexpected-jev'))
  rmSync(ROOT, { recursive: true, force: true })
  assert.equal(unexpected, false, 'no test asks Jev')
})

const env = (extra = {}) => ({ HOME, CODEX_HOME: join(HOME, '.codex'), GROK_HOME: join(HOME, '.grok'), GIT_CONFIG_GLOBAL: join(HOME, 'isolated.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1', PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: ROOT, REVIEW_BASE: 'main', REVIEW_REVIEWER: 'sol', ...extra })
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
const rewrite = (change) => writeFileSync(LOG, records().map((e) => JSON.stringify(change(e) || e)).join('\n') + '\n')
const calls = () => readdirSync(CALLS).map((p) => JSON.parse(readFileSync(join(CALLS, p), 'utf8')))
const allowed = (r) => assert.equal(r.status, 0, r.out)
function blocked(r, pattern) {
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /Run \/code-review/)
  if (pattern) assert.match(r.out, pattern)
}
const push = (refs = ['HEAD:refs/heads/feat']) => run('git', ['push', 'origin', ...refs])
// A real review through the stub reviewer; paths go in REVIEW_PATHS.
function review(paths, extra = {}) {
  const r = script([], { ...(paths !== undefined && { REVIEW_PATHS: paths }), ...extra })
  allowed(r)
  return { ...records().filter((e) => e.type === 'review').at(-1), out: r.out, stdout: r.stdout }
}
function close(id, statuses = {}, extra = {}) {
  const path = join(ROOT, 'statuses.json')
  writeFileSync(path, JSON.stringify(statuses))
  const r = script(['--close', id, '--status', path, '--test-cmd', 'true'], extra)
  return { ...r, record: records().at(-1) }
}
function closed(id, statuses) {
  const r = close(id, statuses)
  allowed(r); assert.equal(r.record.type, 'close'); assert.equal(r.record.status, 'complete', r.out)
  return r.record
}
// A sliced review record logged as the script logs one, for gate cases a real run can't set up.
function slice(paths, extra = {}) {
  const record = { type: 'review', kind: 'review', id: `slice-${records().length}`, head: git('rev-parse', 'HEAD'), repo: 'repo',
    repoId: realpathSync(join(REPO, '.git')), branch: 'feat', baseSha: git('merge-base', 'main', 'HEAD'), paths,
    family: 'fixture', model: 'fixture-only', findingDetails: [], ...extra }
  seed(record)
  return record
}
const scored = (extra) => ({ issue: 'one is wrong', file: 'src/one.js', line: '1', quote: 'export const one = 2', suggestion: 'fix it',
  likelihood: 5, impact: 5, protected: false, trigger: 'importing one', ...extra })

beforeEach(() => {
  for (const path of [HOME, REPO, REMOTE, CALLS]) rmSync(path, { recursive: true, force: true })
  mkdirSync(SKILL, { recursive: true }); mkdirSync(dirname(LOG), { recursive: true }); mkdirSync(REPO); mkdirSync(CALLS)
  copyFileSync(join(SOURCE, 'review.mjs'), SCRIPT)
  cpSync(join(SOURCE, 'hooks'), join(SKILL, 'hooks'), { recursive: true, verbatimSymlinks: true })
  git('init', '-q', '-b', 'main')
  commit({ 'README.md': 'base\n' })
  commit({ 'src/one.js': 'export const one = 1\n', 'lib/two.js': 'export const two = 1\n', 'docs/three.md': 'three\n' })
  git('checkout', '-qb', 'feat')
  commit({ 'src/one.js': 'export const one = 2\n' })
  commit({ 'lib/two.js': 'export const two = 2\n' })
  commit({ 'docs/three.md': 'three, edited\n' })
  git('init', '--bare', '-q', REMOTE)
  git('remote', 'add', 'origin', REMOTE)
  allowed(run('sh', [join(SKILL, 'hooks/install-hook.sh'), REPO]))
})

test('S1 REVIEW_PATHS limits the review diff to its paths, stores them normalised and sorted, and the banner and report name them', () => {
  const r = review(' src/ , ./lib/two.js\nsrc/,')
  assert.deepEqual(r.paths, ['lib/two.js', 'src/'])
  const [call] = calls()
  assert.match(call.prompt, /Diff \(git diff main\.\.\.HEAD -- lib\/two\.js src\/\):/)
  assert.match(call.prompt, /export const one = 2/); assert.match(call.prompt, /export const two = 2/)
  assert.doesNotMatch(call.prompt, /docs\/three\.md|three, edited/)
  assert.match(call.prompt, /one slice of the branch: it covers only the paths lib\/two\.js, src\//)
  assert.match(r.out, /▶ review · .* · feat vs main · paths lib\/two\.js, src\/ · single pass/)
  assert.match(readFileSync(join(REPO, r.dir, 'code-review.md'), 'utf8'), /\nPaths: lib\/two\.js, src\/ \(one slice/)
  const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('===FINDINGS_JSON===') + 19))
  assert.deepEqual(json.paths, ['lib/two.js', 'src/'])
})
test('S1 config "paths" slices a review too, and REVIEW_PATHS wins over it', () => {
  mkdirSync(join(REPO, '.claude')); writeFileSync(join(REPO, '.claude/review-config.json'), JSON.stringify({ paths: ['docs/', './lib/'] }))
  assert.deepEqual(review().paths, ['docs/', 'lib/'])
  assert.doesNotMatch(calls()[0].prompt, /export const one = 2/)
  assert.deepEqual(review('src/').paths, ['src/'])
})
test('S1 a pathspec list that matches no changed file is refused with a clear message, before any model runs or log line', () => {
  for (const paths of ['missing/, nothing.js', 'README.md']) {
    const r = script([], { REVIEW_PATHS: paths })
    assert.notEqual(r.status, 0, r.out)
    assert.match(r.out, /REVIEW_PATHS \(.*\) matches no file changed between main and HEAD; nothing was reviewed/)
    assert.match(r.out, /git diff --name-only [0-9a-f]{40}\.\.\.HEAD/)
  }
  assert.deepEqual(calls(), []); assert.deepEqual(records(), [])
})
test('S4 an unsliced review stores no paths, and its prompt, banner and report carry no slice', () => {
  const r = review()
  assert.equal(Object.hasOwn(r, 'paths'), false)
  const [call] = calls()
  assert.match(call.prompt, /Diff \(git diff main\.\.\.HEAD\):/)
  assert.doesNotMatch(call.prompt, /one slice/)
  for (const text of ['export const one = 2', 'export const two = 2', 'three, edited']) assert.ok(call.prompt.includes(text), text)
  assert.match(r.out, /· feat vs main · single pass/)
  assert.doesNotMatch(readFileSync(join(REPO, r.dir, 'code-review.md'), 'utf8'), /Paths:/)
})

test('S2 a sliced close ignores post-review changes outside its paths and applies outOfScope inside them', () => {
  const r = review('src/')
  commit({ 'lib/two.js': 'export const two = 3\n' })
  const outside = closed(r.id)
  assert.deepEqual(outside.outOfScope, [])
  assert.match(close(r.id).out, /closed \(complete\) at [0-9a-f]{40} for paths src\//)
  commit({ 'src/extra.js': 'export const extra = 1\n' })
  const inside = close(r.id)
  allowed(inside)
  assert.equal(inside.record.status, 'partial'); assert.deepEqual(inside.record.outOfScope, ['src/extra.js'])
  // The same post-review changes make an unsliced close partial for both files.
  const whole = review(undefined, { REVIEW_PATHS: '' })
  commit({ 'lib/two.js': 'export const two = 4\n', 'src/extra.js': 'export const extra = 2\n' })
  assert.deepEqual(close(whole.id).record.outOfScope, ['lib/two.js', 'src/extra.js'])
})
test('S2 inside its paths the fix-check rule is unchanged; a test change outside its paths needs none, and the fix check sees only the slice', () => {
  const r = review('src/', { STUB_FINDINGS: JSON.stringify({ findings: [scored()] }) })
  assert.deepEqual(r.findingDetails.map((f) => [f.id, f.severity]), [['f1', 'medium']])
  commit({ 'src/one.js': 'export const one = 1\n', 'lib/two.test.js': 'test outside\n' })
  closed(r.id, { f1: { status: 'fixed' } })
  commit({ 'src/one.test.js': 'test inside\n' })
  const needs = close(r.id, { f1: { status: 'fixed' } })
  assert.notEqual(needs.status, 0); assert.match(needs.out, /run --fix-check first/)
  rmSync(CALLS, { recursive: true }); mkdirSync(CALLS)
  allowed(script(['--fix-check', r.id]))
  const check = records().at(-1)
  assert.equal(check.kind, 'fix-check'); assert.deepEqual(check.paths, ['src/'])
  const [call] = calls()
  assert.match(call.prompt, /test inside/); assert.doesNotMatch(call.prompt, /test outside/)
  assert.match(call.prompt, /-- src\/\):/)
  closed(r.id, { f1: { status: 'fixed' } })
})

test('S3 two complete slices with one baseSha and closeHead pass the actual push gate, which runs no model', () => {
  const first = review('src/'), second = review('lib/,docs/')
  closed(first.id); closed(second.id)
  const before = calls().length
  const r = push(); allowed(r)
  assert.match(r.stderr, /Sliced review: 2 slice\(s\) together cover every file changed from [0-9a-f]{40} to [0-9a-f]{40}/)
  assert.equal(calls().length, before)
  assert.equal(git('ls-remote', 'origin', 'refs/heads/feat').split('\t')[0], git('rev-parse', 'HEAD'))
})
test('S3 a missing slice blocks the push and the message names the uncovered files', () => {
  closed(review('src/').id)
  const r = push()
  blocked(r, /No complete close covers tip [0-9a-f]{40}; the complete slice closes at [0-9a-f]{40} leave 2 file\(s\) uncovered: docs\/three\.md, lib\/two\.js/)
  assert.equal(git('ls-remote', 'origin'), '')
  const summary = script(['--summary'])
  assert.notEqual(summary.status, 0); assert.match(summary.out, /No complete close covers HEAD; .*uncovered: docs\/three\.md, lib\/two\.js/)
})
test('S3 slices count together only with the same repoId, branch and baseSha', () => {
  const first = slice(['src/']), second = slice(['docs/', 'lib/'])
  closed(first.id); closed(second.id)
  allowed(push(['HEAD:refs/heads/control']))
  for (const [field, value] of [['repoId', '/elsewhere/.git'], ['branch', 'other'], ['baseSha', git('rev-parse', 'main~1')]]) {
    rewrite((e) => e.id === second.id ? { ...e, [field]: value } : null)
    blocked(push([`HEAD:refs/heads/${field}`]), /uncovered: src\/one\.js/)
    rewrite((e) => e.id === second.id ? second : null)
  }
  allowed(push(['HEAD:refs/heads/restored']))
})
test('S3 slices count together only at the same closeHead', () => {
  const first = slice(['src/'])
  closed(first.id)
  commit({ 'builds/demo/log.md': 'notes\n' })
  closed(slice(['builds/', 'docs/', 'lib/']).id)
  // Both closes are usable for this tip on their own, but at different closeHeads they never add up.
  blocked(push(), /uncovered: src\/one\.js/)
  closed(first.id)
  allowed(push())
})
test('S3 the tip may descend from the shared closeHead through builds/ commits only', () => {
  closed(slice(['src/']).id); closed(slice(['docs/', 'lib/']).id)
  commit({ 'builds/demo/log.md': 'documented\n' })
  const r = push(['HEAD:refs/heads/documented']); allowed(r)
  assert.match(r.stderr, /Sliced review: 2 slice\(s\)/)
  commit({ 'lib/two.js': 'export const two = 3\n' })
  blocked(push())
})
test('S3 riskPaths must sit in a slice of kind review', () => {
  commit({ 'auth/login.js': 'export const login = 1\n' })
  closed(slice(['docs/', 'lib/', 'src/']).id)
  closed(slice(['auth/'], { kind: 'grade' }).id)
  blocked(push(), /code-review close covers tip.*riskPaths.*uncovered: auth\/login\.js/)
  closed(slice(['auth/']).id)
  allowed(push())
})
test('S3 without pushed riskPaths a non-review slice still counts for ordinary files', () => {
  closed(slice(['lib/', 'src/']).id)
  closed(slice(['docs/'], { kind: 'grade' }).id)
  const r = push(); allowed(r)
  assert.match(r.stderr, /Sliced review: 2 slice\(s\)/)
})

test('S5 --summary lists every slice covering HEAD with reviewer, paths and counts, then the branch-wide deferred findings', () => {
  const first = review('src/', { STUB_FINDINGS: JSON.stringify({ findings: [scored(), scored({ issue: 'one is a little odd', likelihood: 1 })] }) })
  assert.deepEqual(first.findingDetails.map((f) => [f.id, f.severity, f.filed]), [['f1', 'medium', false], ['f2', 'low', true]])
  const second = review('lib/,docs/')
  commit({ 'src/one.js': 'export const one = 1\n' })
  closed(first.id, { f1: { status: 'fixed' } }); closed(second.id)
  const r = script(['--summary']); allowed(r)
  const head = git('rev-parse', 'HEAD')
  const lines = r.stdout.trim().split('\n')
  assert.match(lines[0], /^Sliced review: 2 slice\(s\) together cover every file changed from [0-9a-f]{40} to /)
  const slices = lines.filter((line) => line.startsWith('Slice '))
  assert.deepEqual(slices, ['Slice 1 of 2: docs/, lib/', 'Slice 2 of 2: src/'])
  assert.deepEqual(lines.filter((line) => line.startsWith('Reviewer: ')), ['Reviewer: sol (gpt-stub-sol)', 'Reviewer: sol (gpt-stub-sol)'])
  assert.deepEqual(lines.filter((line) => line.startsWith('Review: ')), [`Review: ${second.id}`, `Review: ${first.id}`])
  assert.deepEqual(lines.filter((line) => line.startsWith('HEAD: ')), [`HEAD: ${head}`, `HEAD: ${head}`])
  assert.deepEqual(lines.filter((line) => line.startsWith('Counts: ')), ['Counts: 0 findings; 0 fixed; 0 rejected', 'Counts: 2 findings; 1 fixed; 0 rejected'])
  assert.equal(lines.filter((line) => line === 'Deferred findings').length, 1)
  assert.deepEqual(lines.slice(lines.indexOf('Deferred findings') + 1), ['f2 risk 5 LOW src/one.js:1 — one is a little odd; Trigger: importing one'])
  const pushed = push(); allowed(pushed)
  assert.ok(pushed.stderr.includes(r.stdout.trim()), pushed.out)
})

test('S6 slices may overlap, and a file is covered when any complete slice close covers it', () => {
  const reviewed = git('rev-parse', 'HEAD')
  commit({ 'docs/four.md': 'added after one slice was reviewed\n' })
  closed(slice(['lib/', 'src/']).id)
  const partial = slice(['docs/', 'lib/'], { head: reviewed })
  assert.equal(close(partial.id).record.status, 'partial')
  // lib/ stays covered by the complete slice even though the overlapping one is partial.
  blocked(push(), /2 file\(s\) uncovered: docs\/four\.md, docs\/three\.md —/)
  closed(slice(['docs/', 'src/']).id)
  const r = push(); allowed(r)
  assert.match(r.stderr, /Sliced review: 2 slice\(s\)/)
})

test('S7 an unsliced diff over DIFF_CAP suggests REVIEW_PATHS and names the largest top-level folders; a sliced one does not', () => {
  const big = Array.from({ length: 3000 }, (_, i) => `export const value${i} = '${'x'.repeat(40)}'`).join('\n')
  commit({ 'src/big.js': `${big}\n`, 'lib/more.js': 'export const more = [\n' + '  1,\n'.repeat(200) + ']\n' })
  const whole = review()
  assert.match(whole.out, /⚠ Diff is \d+ chars — only the first 120000 were inlined/)
  assert.match(whole.out, /Slice it instead: review each path group with REVIEW_PATHS=<pathspec>,<pathspec>, close every slice at\n {2}the same HEAD, and make the slices together cover the whole diff/)
  assert.match(whole.out, /Largest top-level folders: src\/ \(3002 changed lines\), lib\/ \(204 changed lines\), docs\/ \(2 changed lines\)\n/)
  const sliced = review('src/')
  assert.match(sliced.out, /⚠ Diff is \d+ chars/)
  assert.doesNotMatch(sliced.out, /Slice it instead|Largest top-level folders/)
})

test('S8 both code-review skills say when and how to slice, and that the slices together must cover the diff', () => {
  for (const harness of ['claude', 'codex']) {
    const path = join(SOURCE, '..', 'skills', harness, 'code-review', 'SKILL.md'), text = readFileSync(path, 'utf8')
    for (const part of ['Big diffs: review in slices', 'REVIEW_PATHS=<pathspec>,<pathspec>', 'close every slice at the same HEAD', 'The slices together must cover every file of the diff'])
      assert.ok(text.includes(part), `${harness}: ${part}`)
  }
})
