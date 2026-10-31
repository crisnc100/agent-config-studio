import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime')
const ROOT = mkdtempSync(join(tmpdir(), 'review-gate-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), REMOTE = join(ROOT, 'remote.git')
const SKILL = join(HOME, '.agent-config-studio/review-gate'), SCRIPT = join(SKILL, 'review.mjs')
const LOG = join(HOME, '.agent-config-studio/review-log/review-log.jsonl'), BIN = join(ROOT, 'bin')
const ZERO = '0'.repeat(40)
mkdirSync(BIN)
for (const name of ['model-id', 'codex', 'claude', 'grok', 'jev']) {
  const path = join(BIN, name)
  writeFileSync(path, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(ROOT, 'unexpected-model'))},process.argv.join(' '));process.exit(99)\n`)
  chmodSync(path, 0o755)
}
const env = (extra = {}) => ({ HOME, CODEX_HOME: join(HOME, '.codex'), GROK_HOME: join(HOME, '.grok'), GIT_CONFIG_GLOBAL: join(HOME, 'isolated.gitconfig'), PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: ROOT, GIT_CONFIG_NOSYSTEM: '1', ...extra })
function run(command, args, extra = {}, options = {}) {
  const r = spawnSync(command, args, { cwd: REPO, env: env(extra), encoding: 'utf8', timeout: 30000, ...options })
  return { ...r, out: `${r.stdout || ''}\n${r.stderr || ''}` }
}
function git(...args) {
  const r = run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  assert.equal(r.status, 0, r.out)
  return r.stdout.trim()
}
function commit(path, content) {
  mkdirSync(dirname(join(REPO, path)), { recursive: true })
  writeFileSync(join(REPO, path), content)
  git('add', path); git('commit', '-qm', `change ${path}`)
  return git('rev-parse', 'HEAD')
}
const records = () => existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const seed = (...values) => appendFileSync(LOG, values.map(JSON.stringify).join('\n') + '\n')
function review(kind = 'review', details = []) {
  const record = { type: 'review', kind, id: `fixture-${records().length}`, head: git('rev-parse', 'HEAD'), repo: 'repo',
    repoId: realpathSync(join(REPO, '.git')), branch: 'feat', family: 'fixture', model: 'fixture-only', findingDetails: details }
  seed(record)
  return record
}
function close(record = review()) {
  const path = join(ROOT, 'statuses.json')
  writeFileSync(path, '{}')
  const r = run(process.execPath, [SCRIPT, '--close', record.id, '--status', path, '--test-cmd', 'true'], { REVIEW_BASE: 'main' })
  assert.equal(r.status, 0, r.out)
  assert.equal(records().at(-1).status, 'complete')
  return records().at(-1)
}
function push(args = ['HEAD:refs/heads/feat'], extra = {}, pty = false) {
  return pty
    ? run('/usr/bin/script', ['-q', '/dev/null', 'git', 'push', 'origin', ...args], extra, { stdio: ['ignore', 'pipe', 'pipe'] })
    : run('git', ['push', 'origin', ...args], extra)
}
function blocked(result, pattern = /Run \/code-review/) {
  assert.notEqual(result.status, 0, result.out)
  assert.match(result.out, pattern)
  assert.doesNotMatch(result.out, /REVIEW_GATE_OVERRIDE|override/i)
}
const allowed = (result) => assert.equal(result.status, 0, result.out)
beforeEach(() => {
  for (const path of [HOME, REPO, REMOTE]) rmSync(path, { recursive: true, force: true })
  mkdirSync(SKILL, { recursive: true }); mkdirSync(dirname(LOG), { recursive: true }); mkdirSync(REPO)
  copyFileSync(join(SOURCE, 'review.mjs'), SCRIPT)
  cpSync(join(SOURCE, 'hooks'), join(SKILL, 'hooks'), { recursive: true, verbatimSymlinks: true })
  git('init', '-q', '-b', 'main')
  commit('a.js', 'export const a = 1\n')
  git('checkout', '-qb', 'feat')
  commit('a.js', 'export const a = 2\n')
  git('init', '--bare', '-q', REMOTE)
  git('remote', 'add', 'origin', REMOTE)
  const installed = run('sh', [join(SKILL, 'hooks/install-hook.sh'), REPO])
  allowed(installed)
  assert.match(installed.out, /Installed .*\/\.git\/hooks\/pre-push/)
})
after(() => {
  const unexpected = existsSync(join(ROOT, 'unexpected-model'))
  rmSync(ROOT, { recursive: true, force: true })
  assert.equal(unexpected, false, 'gate must never invoke a model or registry')
})

test('3.1/3.4 actual hook blocks a missing log, naming the full tip and first commits', () => {
  const r = push()
  blocked(r, /No review log/)
  assert.match(r.out, new RegExp(git('rev-parse', 'HEAD')))
  assert.match(r.out, /First commits without a complete close/)
  assert.match(r.out, /change a.js/)
})
test('3.1 actual hook blocks a log with no review', () => { seed({ type: 'outcome' }); blocked(push()) })
test('3.1 actual hook blocks an open review with findings', () => { review('review', [{ id: 'f1', severity: 'high' }]); blocked(push()) })
test('3.1 actual hook blocks a clean review without a close', () => { review(); blocked(push()) })
test('3.1 actual hook blocks partial closes', () => {
  const r = review()
  seed({ type: 'close', review: r.id, closeHead: r.head, status: 'partial', statuses: {} })
  blocked(push())
})
test('3.1 actual hook permits a complete close and prints exactly the summary to stderr', () => {
  close()
  const summary = run(process.execPath, [SCRIPT, '--summary'], { REVIEW_BASE: 'main' })
  allowed(summary)
  const r = push(); allowed(r)
  assert.ok(r.stderr.includes(summary.stdout.trim()), r.out)
  assert.doesNotMatch(r.stdout, /Reviewer:/)
  assert.doesNotMatch(r.out, /Could not resolve origin\/HEAD/)
})
test('3.1 build-only descendants are covered and share summary content', () => {
  close(); commit('builds/demo/log.md', 'documented\n')
  const r = push(); allowed(r)
  const summary = run(process.execPath, [SCRIPT, '--summary'], { REVIEW_BASE: 'main' })
  allowed(summary); assert.ok(r.stderr.includes(summary.stdout.trim()), r.out)
})
test('3.1 a code commit after close blocks and names that first uncovered commit', () => {
  const c = close(); const changed = commit('a.js', 'export const a = 3\n')
  const r = push(); blocked(r)
  assert.match(r.out, new RegExp(`after complete close ${c.closeHead}`))
  assert.match(r.out, new RegExp(changed))
})
test('3.1 a code change then revert cannot hide behind an unchanged net diff', () => {
  close(); commit('a.js', 'export const a = 3\n'); commit('a.js', 'export const a = 2\n')
  blocked(push())
})
test('3.1 merge ancestry is checked commit by commit', () => {
  close(); git('checkout', '-qb', 'side'); commit('other.js', 'code\n'); git('checkout', '-q', 'feat')
  commit('builds/log.md', 'docs\n'); git('merge', '--no-ff', '-qm', 'merge side', 'side')
  blocked(push())
})
test('3.1 a leading-space path outside builds is never treated as builds-only', () => {
  close(); commit(' builds/log.md', 'code\n'); blocked(push())
})
test('3.1 matching uses full commit alone, independent of branch, remote and repo metadata', () => {
  const r = review(); r.repoId = '/different/repo'; r.branch = 'other'; r.remote = 'different'
  writeFileSync(LOG, JSON.stringify(r) + '\n'); close(r); allowed(push())
})
test('3.1 abbreviated close heads do not match; the pushed ref rather than HEAD is checked', () => {
  const c = close()
  const all = records(); all.at(-1).closeHead = git('rev-parse', '--short', 'HEAD')
  writeFileSync(LOG, all.map(JSON.stringify).join('\n') + '\n'); blocked(push())
  seed(c); git('branch', 'covered'); commit('a.js', 'new code\n')
  allowed(push(['covered:refs/heads/covered']))
})
test('3.1 an old script record without head is explained', () => {
  seed({ type: 'review', id: 'old', repo: 'repo' })
  blocked(push(), /old script copy that did not log head/)
})
test('3.1 tag pushes and branch deletions pass without a log', () => {
  git('tag', '-a', 'v1', '-m', 'tag')
  allowed(push(['refs/tags/v1']))
  close(); allowed(push()); rmSync(LOG)
  allowed(push([':refs/heads/feat']))
})
test('3.1 one uncovered ref blocks the entire multi-ref push', () => {
  close(); git('branch', 'covered'); commit('a.js', 'new code\n')
  blocked(push(['covered:refs/heads/covered', 'HEAD:refs/heads/feat']))
  assert.equal(git('ls-remote', 'origin'), '')
})
test('3.2 pushed risk paths require a review close, even when a Grade is complete', () => {
  commit('auth/login.js', 'risk\n'); close(review('grade'))
  blocked(push(), /code-review close.*riskPaths/)
  close(review()); close(review('grade')); allowed(push())
})
test('3.2 configured riskPaths are respected and risk changes followed by reverts still count', () => {
  writeFileSync(join(SKILL, 'config.json'), JSON.stringify({ riskPaths: ['private/**'] }))
  commit('private/data.js', 'secret\n'); git('rm', '-q', 'private/data.js'); git('commit', '-qm', 'revert risk')
  close(review('grade')); blocked(push(), /riskPaths/)
})
test('3.2 update ranges and new-branch remote exclusions do not include already-pushed risk work', () => {
  commit('auth/login.js', 'risk\n'); close(); allowed(push())
  commit('a.js', 'nonrisk\n'); close(review('grade')); allowed(push())
  commit('other.js', 'also nonrisk\n'); close(review('grade'))
  allowed(push(['HEAD:refs/heads/another']))
})
test('3.4 any unreadable log line blocks even with a covering complete close', () => {
  close(); appendFileSync(LOG, 'broken\nnull\n'); blocked(push(), /2 unreadable log line/)
})
test('3.6 a dirty-tree close attempt leaves the actual push blocked', () => {
  const r = review(); writeFileSync(join(REPO, 'a.js'), 'dirty\n')
  const path = join(ROOT, 'statuses.json'); writeFileSync(path, '{}')
  const result = run(process.execPath, [SCRIPT, '--close', r.id, '--status', path, '--test-cmd', 'true'], { REVIEW_BASE: 'main' })
  assert.notEqual(result.status, 0); assert.match(result.out, /Tracked working tree changes/)
  blocked(push())
})
test('3.3 explicit push override is refused without a terminal, including for covered tips', () => {
  for (const covered of [false, true]) {
    if (covered) close()
    const r = push(undefined, { REVIEW_GATE_OVERRIDE: 'reason' })
    assert.notEqual(r.status, 0); assert.match(r.out, /override refused/)
    if (covered) assert.doesNotMatch(r.out, /Run \/code-review|Uncovered tip/)
    else assert.match(r.out, /Run \/code-review/)
    assert.equal(records().filter((e) => e.type === 'override').length, 0)
  }
})
test('3.3 real PTY push override succeeds and logs reason, refs, full tips and repoId', () => {
  const r = push(undefined, { REVIEW_GATE_OVERRIDE: 'rebase' }, true); allowed(r)
  const entry = records().at(-1)
  assert.equal(entry.type, 'override'); assert.equal(entry.action, 'push'); assert.equal(entry.reason, 'rebase')
  assert.equal(entry.repoId, realpathSync(join(REPO, '.git')))
  const tip = git('rev-parse', 'HEAD')
  assert.deepEqual(entry.tips, [tip])
  assert.deepEqual(entry.refs, [{ localRef: 'HEAD', localSha: tip, remoteRef: 'refs/heads/feat', remoteSha: ZERO }])
})
test('3.3 real PTY refuses CLAUDECODE and every existing Codex runtime marker, even empty', () => {
  for (const marker of ['CLAUDECODE', 'CODEX_CI', 'CODEX_SANDBOX', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID']) {
    const r = push(undefined, { REVIEW_GATE_OVERRIDE: 'reason', [marker]: '' }, true)
    assert.notEqual(r.status, 0, r.out); assert.match(r.out, /override refused/)
  }
  assert.equal(existsSync(LOG), false)
})
test('3.3/3.4 PTY override still works for unreadable logs, but a failed append blocks', () => {
  writeFileSync(LOG, 'broken\n')
  allowed(push(undefined, { REVIEW_GATE_OVERRIDE: 'repair later' }, true))
  assert.equal(JSON.parse(readFileSync(LOG, 'utf8').trim().split('\n').at(-1)).action, 'push')
  rmSync(LOG); mkdirSync(LOG)
  const r = push(['HEAD:refs/heads/another'], { REVIEW_GATE_OVERRIDE: 'reason' }, true)
  assert.notEqual(r.status, 0, r.out); assert.match(r.out, /Could not append/)
})
test('3.4 malformed ref lines and gate git errors fail closed; a real PTY can override both', () => {
  const tip = git('rev-parse', 'HEAD')
  for (const input of [`refs/heads/feat ${tip}\n`, `HEAD ${tip} invalid-ref ${ZERO}\n`, `HEAD abbreviated refs/heads/feat ${ZERO}\n`])
    blocked(run(process.execPath, [SCRIPT, '--gate'], {}, { input }), /Malformed pre-push ref line/)
  close()
  const input = `HEAD ${tip} refs/heads/feat ${'f'.repeat(40)}\n`
  blocked(run(process.execPath, [SCRIPT, '--gate'], {}, { input }), /git rev-list.*failed/)
  // script's command gets a file as stdin through a POSIX shell; stderr is a real PTY.
  const inputPath = join(ROOT, 'refs'), runner = join(ROOT, 'run-gate.sh')
  writeFileSync(runner, `#!/bin/sh\nexec "$1" "$2" --gate < "$3"\n`)
  for (const text of ['malformed\n', input]) {
    writeFileSync(inputPath, text)
    const r = run('/usr/bin/script', ['-q', '/dev/null', 'sh', runner, process.execPath, SCRIPT, inputPath],
      { REVIEW_GATE_OVERRIDE: 'repair' }, { stdio: ['ignore', 'pipe', 'pipe'] })
    allowed(r); assert.equal(records().at(-1).action, 'push')
  }
})
test('3.5 hook installer refuses existing hooks and any core.hooksPath without changing either', () => {
  const installer = join(SKILL, 'hooks/install-hook.sh'), hook = join(REPO, '.git/hooks/pre-push')
  const before = readFileSync(hook)
  const existing = run('sh', [installer, REPO]); assert.notEqual(existing.status, 0); assert.match(existing.out, /pre-push already exists/)
  assert.deepEqual(readFileSync(hook), before)
  rmSync(hook); git('config', 'core.hooksPath', '')
  const configured = run('sh', [installer, REPO]); assert.notEqual(configured.status, 0); assert.match(configured.out, /core.hooksPath is set/)
  assert.equal(existsSync(hook), false); assert.equal(git('config', '--get', 'core.hooksPath'), '')
})
test('3.5 hook installed from a worktree lives in the common hooks directory', () => {
  const hook = join(REPO, '.git/hooks/pre-push'), worktree = join(ROOT, 'worktree')
  rmSync(hook); rmSync(worktree, { recursive: true, force: true })
  git('worktree', 'add', '-q', '-b', 'linked', worktree)
  allowed(run('sh', [join(SKILL, 'hooks/install-hook.sh'), worktree]))
  assert.deepEqual(readFileSync(hook), readFileSync(join(SOURCE, 'hooks/pre-push')))
  const r = run('git', ['push', 'origin', 'HEAD:refs/heads/linked'], {}, { cwd: worktree })
  blocked(r, /No review log/)
})
test('3.1 shim refuses missing global script or missing node and never uses a project copy', () => {
  mkdirSync(join(REPO, 'scripts')); writeFileSync(join(REPO, 'scripts/review.mjs'), 'process.exit(0)\n')
  rmSync(SCRIPT); blocked(push(), /global .*review.mjs is missing/)
  const empty = join(ROOT, 'empty-bin'); mkdirSync(empty, { recursive: true })
  const r = run('/bin/sh', [join(SKILL, 'hooks/pre-push')], { PATH: empty })
  assert.notEqual(r.status, 0); assert.match(r.out, /node is missing/)
})

function criterionGrade(verdict, original) {
  const path = join(ROOT, 'criterion-grade.json')
  writeFileSync(path, JSON.stringify({ family: 'fixture', model: 'fixture-only', vendor: 'codex', criteria: [
    { id: 'criterion-1', criterion: 'Return the correct account', verdict, evidence: `account test ${verdict}` },
  ] }))
  allowed(run(process.execPath, [SCRIPT, '--log-grade', path, ...(original ? ['--recheck-of', original.id] : [])], { REVIEW_BASE: 'main' }))
  return records().at(-1)
}
function criterionClose(original, status = { status: 'fixed' }) {
  const path = join(ROOT, 'criterion-status.json')
  writeFileSync(path, JSON.stringify({ c1: status }))
  allowed(run(process.execPath, [SCRIPT, '--close', original.id, '--status', path, '--test-cmd', 'true'], { REVIEW_BASE: 'main' }))
  return records().at(-1)
}
test('H1 a FAIL criterion code fix with recheck PASS closes complete and passes the actual hook', () => {
  const original = criterionGrade('FAIL')
  commit('a.js', 'export const a = 3\n')
  criterionGrade('PASS', original)
  const result = criterionClose(original)
  assert.equal(result.status, 'complete')
  assert.deepEqual(result.outOfScope, [])
  allowed(push())
})
test('H1 code after the PASS recheck stays out of scope', () => {
  const original = criterionGrade('FAIL')
  commit('a.js', 'export const a = 3\n'); criterionGrade('PASS', original)
  commit('unrelated.js', 'new work\n')
  const result = criterionClose(original)
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.outOfScope, ['unrelated.js'])
  blocked(push())
})
test('H1 a rejected criterion does not exempt files changed before the recheck', () => {
  const original = criterionGrade('FAIL')
  commit('a.js', 'export const a = 3\n'); criterionGrade('PASS', original)
  seed({ type: 'dispute', review: original.id, finding: 'c1', verdict: 'REFUTED' })
  const result = criterionClose(original, { status: 'rejected', reason: 'intended', evidence: 'account test' })
  assert.equal(result.status, 'partial'); assert.deepEqual(result.outOfScope, ['a.js'])
  blocked(push())
})
test('M1 a local tag pushed to a branch never exempts an unreviewed commit', () => {
  git('tag', 'unreviewed')
  blocked(push(['unreviewed:refs/heads/from-tag']), /No review log/)
  assert.equal(git('ls-remote', 'origin', 'refs/heads/from-tag'), '')
})
test('L1 mixed pushes name only truly uncovered refs in either input order', () => {
  const covered = close().closeHead; git('branch', 'covered'); const uncovered = commit('a.js', 'new code\n')
  for (const refs of [['covered:refs/heads/covered', 'HEAD:refs/heads/feat'], ['HEAD:refs/heads/feat', 'covered:refs/heads/covered']]) {
    const result = push(refs); blocked(result)
    const lines = result.stderr.split('\n').filter((line) => line.startsWith('Uncovered tip:'))
    assert.deepEqual(lines, [`Uncovered tip: ${uncovered} (refs/heads/feat)`])
    assert.ok(!lines.some((line) => line.includes(covered)))
  }
})
test('L1 a refused override for covered work reports only override refusal', () => {
  close()
  const result = push(undefined, { REVIEW_GATE_OVERRIDE: 'reason' })
  assert.notEqual(result.status, 0); assert.match(result.out, /override refused/)
  assert.doesNotMatch(result.out, /Uncovered tip|First commits|Run \/code-review|Operator-only action/)
})
test('L2 malformed repo or global config blocks the actual hook with its reason and permits a logged PTY override', () => {
  commit('private/data.js', 'custom risk\n'); close(review('grade'))
  for (const [place, path] of [['repo', join(REPO, '.claude/review-config.json')], ['global', join(SKILL, 'config.json')], ['legacy-global', join(HOME, '.claude/review-config.json')]]) {
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '{"riskPaths":["private/**"]')
    const args = [`HEAD:refs/heads/bad-${place}`]
    const result = push(args); blocked(result, /Malformed review config/)
    assert.ok(result.out.includes(path) || result.out.includes('.claude/review-config.json') || result.out.includes('review-gate/config.json'), result.out)
    allowed(push(args, { REVIEW_GATE_OVERRIDE: 'repair config' }, true))
    assert.match(records().at(-1).gateError, /Malformed review config/)
    rmSync(path)
  }
})

test('6.8 Grok runtime markers refuse a real-terminal push override, including empty values', () => {
  for (const marker of ['GROK_AGENT', 'GROK_SESSION_ID']) for (const value of ['', '1']) {
    const r = push(undefined, { REVIEW_GATE_OVERRIDE: 'reason', [marker]: value }, true)
    assert.notEqual(r.status, 0, r.out); assert.match(r.out, /override refused/)
  }
  assert.equal(existsSync(LOG), false)
})
