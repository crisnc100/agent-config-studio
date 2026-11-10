import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime')
const ROOT = mkdtempSync(join(tmpdir(), 'review-root-commit-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), REMOTE = join(ROOT, 'remote.git')
const SKILL = join(HOME, '.agent-config-studio/review-gate'), SCRIPT = join(SKILL, 'review.mjs')
const LOG = join(HOME, '.agent-config-studio/review-log/review-log.jsonl'), BIN = join(ROOT, 'bin'), CALLS = join(ROOT, 'calls')
mkdirSync(BIN)
function stub(name, body) {
  writeFileSync(join(BIN, name), `#!${process.execPath}\n${body}`)
  chmodSync(join(BIN, name), 0o755)
}
stub('model-id', `const a=process.argv.slice(2); console.log(a[0]==='--role' ? JSON.stringify({use:['sol'],ids:['gpt-stub-sol']}) : a[0]==='--flavor' ? JSON.stringify({flavor:{effort:'high'}}) : 'gpt-stub-sol')`)
stub('codex', `const fs=require('node:fs'), a=process.argv.slice(2); if(a[0]==='mcp'){console.log('[]');process.exit(0)}; fs.writeFileSync(${JSON.stringify(CALLS)}+'/'+process.pid+'.json',JSON.stringify({prompt:a.at(-1)})); fs.writeFileSync(a[a.indexOf('-o')+1],JSON.stringify({findings:[]}))`)
stub('jev', 'process.exit(1)')
const env = (extra = {}) => ({ HOME, CODEX_HOME: join(HOME, '.codex'), GIT_CONFIG_GLOBAL: join(HOME, 'isolated.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1', PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: ROOT,
  REVIEW_BASE: 'origin/main', REVIEW_REVIEWER: 'sol', ...extra })
function run(command, args, extra = {}) {
  const r = spawnSync(command, args, { cwd: REPO, env: env(extra), encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 })
  return { ...r, out: `${r.stdout || ''}\n${r.stderr || ''}` }
}
const allowed = (r) => assert.equal(r.status, 0, r.out)
function git(...args) {
  const r = run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  allowed(r)
  return r.stdout.trim()
}
const script = (args = [], extra = {}) => run(process.execPath, [SCRIPT, ...args], extra)
const records = () => existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const emptyTree = () => git('hash-object', '-t', 'tree', '/dev/null')
function push() {
  allowed(run('sh', [join(SKILL, 'hooks/install-hook.sh'), REPO]))
  return run('git', ['push', 'origin', 'main'])
}
function commit(path, text) {
  writeFileSync(join(REPO, path), text)
  git('add', path); git('commit', '-qm', `change ${path}`)
  return git('rev-parse', 'HEAD')
}
function review(extra = {}) {
  allowed(script([], extra))
  const record = records().filter((e) => e.type === 'review').at(-1)
  assert.ok(record, 'the root diff must be reviewed, not treated as empty')
  return record
}
function close(record) {
  const statuses = join(ROOT, 'statuses.json')
  writeFileSync(statuses, '{}')
  allowed(script(['--close', record.id, '--status', statuses, '--test-cmd', 'true']))
  const closed = records().at(-1)
  assert.equal(closed.type, 'close'); assert.equal(closed.status, 'complete')
  return closed
}
beforeEach(() => {
  for (const path of [HOME, REPO, REMOTE, CALLS]) rmSync(path, { recursive: true, force: true })
  mkdirSync(SKILL, { recursive: true }); mkdirSync(REPO); mkdirSync(CALLS)
  copyFileSync(join(SOURCE, 'review.mjs'), SCRIPT)
  cpSync(join(SOURCE, 'hooks'), join(SKILL, 'hooks'), { recursive: true, verbatimSymlinks: true })
  git('init', '-q', '-b', 'main')
  commit('README.md', 'First project\n')
  git('init', '--bare', '-q', REMOTE)
  git('remote', 'add', 'origin', REMOTE)
})
after(() => rmSync(ROOT, { recursive: true, force: true }))

test('a root review closes against the empty tree and the installed pre-push hook accepts main', () => {
  const r = review()
  assert.equal(r.baseSha, emptyTree())
  const c = close(r)
  assert.deepEqual(c.coverage, [['README.md', `100644 ${git('rev-parse', 'HEAD:README.md')}`]])
  allowed(push())
  assert.equal(git('ls-remote', 'origin', 'refs/heads/main').split('\t')[0], r.head)
  const prompts = readdirSync(CALLS).map((p) => JSON.parse(readFileSync(join(CALLS, p), 'utf8')).prompt)
  assert.ok(prompts.some((p) => p.includes('+First project')))
  assert.ok(prompts.some((p) => p.includes(`git diff ${r.baseSha}..HEAD`)))
  assert.ok(prompts.every((p) => !p.includes('origin/main...HEAD')))
})

test('a close at the second commit covers both commits on the first push', () => {
  commit('notes.md', 'Second commit\n')
  const r = review()
  assert.equal(r.baseSha, emptyTree())
  assert.deepEqual(close(r).coverage.map(([p]) => p), ['README.md', 'notes.md'])
  allowed(push())
})

test('an uncovered root push names the first-commit review path', () => {
  const r = push()
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /this is the repo's first commit: run the review on it; it is reviewed against the empty tree/)
  assert.match(r.out, new RegExp(git('rev-parse', 'HEAD')))
  assert.equal(git('ls-remote', 'origin'), '')
})

test('an established repo with a bad REVIEW_BASE fails without logging a review', () => {
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  commit('notes.md', 'Established history\n')
  const r = script([], { REVIEW_BASE: 'misspelled-base' })
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /git merge-base.*misspelled-base.*failed/)
  assert.deepEqual(records(), [])
  assert.deepEqual(readdirSync(CALLS), [])
})

test('a parentless commit already pushed on an orphan remote branch does not trigger fallback', () => {
  git('checkout', '--orphan', 'elsewhere')
  git('rm', '-q', '-rf', '.')
  commit('elsewhere.md', 'Other root\n')
  git('push', '-q', 'origin', 'elsewhere')
  git('checkout', '-q', 'main')
  git('push', '-q', 'origin', 'main:published-root')
  allowed(run('sh', [join(SKILL, 'hooks/install-hook.sh'), REPO]))
  const r = script([], { REVIEW_BASE: 'origin/elsewhere' })
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /git merge-base.*origin\/elsewhere.*failed/)
  assert.deepEqual(records(), [])
})

test('summary of a root review reports a normal LOW docs tier with readable diff stats', () => {
  const r = review()
  const c = close(r)
  assert.equal(c.tier, 'low')
  const summary = script(['--summary'])
  allowed(summary)
  assert.match(summary.stdout, new RegExp(r.id))
  assert.match(summary.stdout, /LOW/)
  assert.doesNotMatch(summary.out, /diff.*could not be read|HIGH/)
  const pushed = push(); allowed(pushed)
  assert.ok(pushed.stderr.includes(summary.stdout.trim()), pushed.out)
})

test('an explicit empty-tree REVIEW_BASE reviews the root normally', () => {
  assert.equal(review({ REVIEW_BASE: emptyTree() }).baseSha, emptyTree())
})

test('a successful merge-base keeps its existing base even before the first push', () => {
  const base = git('rev-parse', 'HEAD')
  commit('notes.md', 'Local branch change\n')
  assert.equal(review({ REVIEW_BASE: base }).baseSha, base)
})
