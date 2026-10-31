#!/usr/bin/env node
/**
 * Which config can run a command. A .claude/review-config.json the repository can ship (one git tracks)
 * never sets verifyCmd, classifier, base or a pick that names a command; env, the home config and an
 * untracked repo file still can. The global-hook state file, a copy of the gitconfig, is owner-only.
 * Temp HOME, temp repos and stub CLIs only: no model, no real git config.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const RUNTIME = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime')
const SCRIPT = join(RUNTIME, 'review.mjs')
const ROOT = mkdtempSync(join(tmpdir(), 'review-config-trust-test-'))
const BIN = join(ROOT, 'bin'), TOOLS = join(ROOT, 'tools'), HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), MARKS = join(ROOT, 'marks')
const LOG = join(HOME, '.agent-config-studio', 'review-log', 'review-log.jsonl')
const HOME_CONFIG = join(HOME, '.agent-config-studio', 'review-gate', 'config.json')
const REPO_CONFIG = '.claude/review-config.json'
const FINDING = { severity: 'high', issue: 'wrong return', file: 'a.js', line: '1', quote: 'export const a = 2', suggestion: 'return 1' }
const CHOICE = JSON.stringify({ answers: { reviewer: { type: 'choice', choice: 'grok', confidence: 0.9, probabilities: { grok: 0.9 } } } })
after(() => rmSync(ROOT, { recursive: true, force: true }))

const executable = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); chmodSync(path, 0o755) }
const node = (path, body) => executable(path, `#!${process.execPath}\n${body}`)
const marker = (name) => join(MARKS, name)
// A classifier stub that leaves a marker, so "it never ran" is a file that is not there.
const classifierBody = (name) => `require('node:fs').writeFileSync(${JSON.stringify(marker(name))}, ''); console.log(${JSON.stringify(CHOICE)})`
node(join(BIN, 'model-id'), `const a=process.argv.slice(2), ids={sol:'gpt-stub-sol',opus:'claude-stub-opus',grok:'grok-stub'}; console.log(a[0]==='--role' ? JSON.stringify({use:['sol','opus','grok'],ids:['gpt-stub-sol','claude-stub-opus','grok-stub']}) : a[0]==='--flavor' ? JSON.stringify({flavor:{effort:'high'}}) : ids[a[0]] || 'stub-'+a[0])`)
const modelBody = `
const fs = require('node:fs')
const a = process.argv.slice(2)
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8') : a[a.indexOf('--json-schema')+1]
const reply = schema.includes('"scores"') ? '{"scores":[]}' : schema.includes('verdicts') ? '{"verdicts":[{"index":0,"verdict":"REFUTED","evidence":"a.js:1 intentional"}]}' : (process.env.STUB_FINDINGS || '{"findings":[]}')
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1], reply)
else console.log(JSON.stringify({structured_output:JSON.parse(reply),structuredOutput:JSON.parse(reply),modelUsage:{'stub-grok':{}}}))
`
for (const cli of ['codex', 'claude', 'grok']) node(join(BIN, cli), modelBody)
node(join(BIN, 'pick-helper'), classifierBody('pick'))
const CLASSIFY = join(TOOLS, 'classify')
node(CLASSIFY, classifierBody('classifier'))

const environment = (extra = {}) => ({ PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), HOME, GIT_CONFIG_GLOBAL: join(HOME, 'isolated.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  CODEX_HOME: join(HOME, '.codex'), GROK_HOME: join(HOME, '.grok'), TMPDIR: ROOT, ...extra })
function git(...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: REPO, env: environment(), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}
const write = (path, text) => { mkdirSync(dirname(join(REPO, path)), { recursive: true }); writeFileSync(join(REPO, path), text) }
const commit = (path, text) => { write(path, text); git('add', path); git('commit', '-qm', `change ${path}`) }
const ignore = (pattern) => appendFileSync(join(REPO, '.git/info/exclude'), `${pattern}\n`)
function run(args = [], extra = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, env: environment(extra), encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] })
  return { ...r, out: `${r.stdout}\n${r.stderr}` }
}
const reviews = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []).filter((e) => e.type === 'review')
function review(extra = {}) {
  const r = run([], { REVIEW_BASE: 'main', ...extra })
  assert.equal(r.status, 0, r.out)
  return { ...r, record: reviews().at(-1) }
}
const dispute = (id) => run(['--dispute', id, 'f1', '--reason', 'intended behavior', '--evidence', 'a.js:1'], { REVIEW_BASE: 'main' })
const ignoredLines = (out, key) => out.split('\n').filter((l) => l.includes(`Ignoring ${key}`) && l.includes(REPO_CONFIG))

beforeEach(() => {
  for (const p of [HOME, REPO, MARKS]) { rmSync(p, { recursive: true, force: true }); mkdirSync(p, { recursive: true }) }
  git('init', '-q', '-b', 'main')
  commit('a.js', 'export const a = 1\n')
  git('checkout', '-qb', 'feat')
  commit('a.js', 'export const a = 2\n')
})

test('a tracked repo config never runs its verifyCmd, a command pick or its classifier, and names the file and keys once', () => {
  executable(join(REPO, 'repo-helper'), `#!/bin/sh\n: > ${JSON.stringify(marker('repo-pick'))}\necho '${CHOICE}'\n`)
  git('add', 'repo-helper')
  commit(REPO_CONFIG, JSON.stringify({ verifyCmd: `touch ${JSON.stringify(marker('verify'))}`, pick: './repo-helper' }))
  const r = review({ STUB_FINDINGS: JSON.stringify({ findings: [FINDING] }) })
  assert.ok(!existsSync(marker('verify')), 'the tracked verifyCmd ran')
  assert.ok(!existsSync(marker('repo-pick')), 'the tracked pick command ran')
  assert.equal(ignoredLines(r.out, 'verifyCmd').length, 1, r.out)
  assert.equal(ignoredLines(r.out, 'pick "./repo-helper"').length, 1, r.out)
  assert.equal(r.record.family, 'sol', 'the pick falls back to the first family')
  // close: the ignored verifyCmd is no test command either
  const status = join(ROOT, 'status.json')
  writeFileSync(status, JSON.stringify({ f1: { status: 'fixed' } }))
  const close = run(['--close', r.record.id, '--status', status], { REVIEW_BASE: 'main' })
  assert.notEqual(close.status, 0, close.out)
  assert.match(close.out, /No test command configured/)
  assert.ok(!existsSync(marker('verify')), 'the tracked verifyCmd ran on close')
  // dispute: a tracked classifier is never asked
  commit(REPO_CONFIG, JSON.stringify({ classifier: CLASSIFY }))
  const d = dispute(r.record.id)
  assert.equal(d.status, 0, d.out)
  assert.ok(!existsSync(marker('classifier')), 'the tracked classifier ran')
  assert.equal(ignoredLines(d.out, 'classifier').length, 1, d.out)
  assert.match(d.out, /REFUTED/)
})

test('an untracked repo config is honored even when git does not ignore it; once tracked, it is refused', () => {
  write(REPO_CONFIG, JSON.stringify({ verifyCmd: `touch ${JSON.stringify(marker('verify'))}`, pick: 'pick-helper' }))
  const r = review()
  assert.ok(existsSync(marker('verify')) && existsSync(marker('pick')), r.out)
  assert.ok(!/Ignoring/.test(r.out), r.out)
  rmSync(MARKS, { recursive: true, force: true })
  mkdirSync(MARKS)
  git('add', REPO_CONFIG)
  git('commit', '-qm', 'track the config')
  const tracked = review()
  assert.ok(!existsSync(marker('verify')) && !existsSync(marker('pick')), tracked.out)
  assert.equal(ignoredLines(tracked.out, 'verifyCmd').length, 1, tracked.out)
  assert.equal(ignoredLines(tracked.out, 'pick "pick-helper"').length, 1, tracked.out)
})

test('a malicious base never reaches git fetch as an option, from the repo, the environment or the home config', () => {
  const evil = '--upload-pack=touch fetch-marker #/.'
  const planted = join(REPO, 'fetch-marker')
  commit(REPO_CONFIG, JSON.stringify({ base: evil }))
  const repo = run()
  assert.ok(!existsSync(planted), repo.out)
  assert.equal(ignoredLines(repo.out, 'base').length, 1, repo.out)
  git('rm', '-q', REPO_CONFIG); git('commit', '-qm', 'drop config')
  const fromEnv = run([], { REVIEW_BASE: evil })
  assert.notEqual(fromEnv.status, 0)
  assert.match(fromEnv.out, /REVIEW_BASE must be a branch, tag or commit like origin\/main; got "--upload-pack=/)
  mkdirSync(dirname(HOME_CONFIG), { recursive: true })
  writeFileSync(HOME_CONFIG, JSON.stringify({ base: evil }))
  const fromHome = run()
  assert.notEqual(fromHome.status, 0)
  assert.match(fromHome.out, /config "base" must be a branch, tag or commit/)
  for (const bad of ['origin/--upload-pack=x', 'origin/+main:refs/heads/main', 'ext::sh/main', 'origin main'])
    assert.match(run([], { REVIEW_BASE: bad }).out, /REVIEW_BASE must be a branch, tag or commit/, bad)
  assert.ok(!existsSync(planted), 'git ran the planted upload-pack')
})

test('a remote base still fetches through the -- separator', () => {
  const remote = join(ROOT, 'remote.git')
  rmSync(remote, { recursive: true, force: true })
  assert.equal(spawnSync('git', ['init', '-q', '--bare', remote], { env: environment() }).status, 0)
  git('remote', 'add', 'origin', remote)
  git('push', '-q', 'origin', 'main')
  git('update-ref', '-d', 'refs/remotes/origin/main')
  const r = review({ REVIEW_BASE: 'origin/main' })
  assert.ok(!/Could not fetch/.test(r.out), r.out)
  assert.equal(git('rev-parse', 'origin/main'), git('rev-parse', 'main'))
})

test('an untracked, ignored repo config still runs its verifyCmd, pick and classifier', () => {
  ignore('.claude/')
  const verify = `touch ${JSON.stringify(marker('verify'))}`
  write(REPO_CONFIG, JSON.stringify({ verifyCmd: verify, pick: 'pick-helper' }))
  const r = review({ STUB_FINDINGS: JSON.stringify({ findings: [FINDING] }) })
  assert.ok(existsSync(marker('verify')), r.out)
  assert.ok(existsSync(marker('pick')), r.out)
  assert.ok(!/Ignoring/.test(r.out), r.out)
  rmSync(marker('verify'))
  const status = join(ROOT, 'status.json')
  writeFileSync(status, JSON.stringify({ f1: { status: 'fixed' } }))
  const close = run(['--close', r.record.id, '--status', status], { REVIEW_BASE: 'main' })
  assert.equal(close.status, 0, close.out)
  assert.ok(existsSync(marker('verify')), close.out)
  write(REPO_CONFIG, JSON.stringify({ classifier: CLASSIFY }))
  const d = dispute(r.record.id)
  assert.equal(d.status, 0, d.out)
  assert.ok(existsSync(marker('classifier')), d.out)
})

test('the home config still runs its verifyCmd, pick and classifier, and sets the base', () => {
  mkdirSync(dirname(HOME_CONFIG), { recursive: true })
  writeFileSync(HOME_CONFIG, JSON.stringify({ verifyCmd: `touch ${JSON.stringify(marker('verify'))}`, pick: 'pick-helper', classifier: CLASSIFY, base: 'main' }))
  const shown = run(['--show-config'])
  assert.equal(shown.status, 0, shown.out)
  const config = JSON.parse(shown.stdout)
  assert.equal(config.base, 'main')
  assert.equal(config.baseSource, 'configured')
  const r = run([], { STUB_FINDINGS: JSON.stringify({ findings: [FINDING] }) })
  assert.equal(r.status, 0, r.out)
  assert.ok(existsSync(marker('verify')) && existsSync(marker('pick')), r.out)
  const d = run(['--dispute', reviews().at(-1).id, 'f1', '--reason', 'intended behavior', '--evidence', 'a.js:1'])
  assert.equal(d.status, 0, d.out)
  assert.ok(existsSync(marker('classifier')), d.out)
})

test('the global-hook state file, which copies the gitconfig, is written 0600, even over a stale 0644 temp file', () => {
  const skill = join(ROOT, 'skill')
  rmSync(skill, { recursive: true, force: true })
  cpSync(join(RUNTIME, 'hooks'), join(skill, 'hooks'), { recursive: true, verbatimSymlinks: true })
  const gitconfig = join(HOME, 'isolated.gitconfig')
  writeFileSync(gitconfig, '[url "https://user:token-stub@example.test/"]\n\tinsteadOf = https://example.test/\n')
  const state = join(HOME, '.agent-config-studio', 'review-gate-global-hook.json')
  const sh = (command) => spawnSync('sh', [join(skill, 'hooks', 'install-global.sh'), command], { cwd: HOME, env: environment(), encoding: 'utf8', timeout: 30000 })
  const mode = () => statSync(state).mode & 0o777
  const installed = sh('install')
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`)
  const before = Buffer.from(JSON.parse(readFileSync(state, 'utf8')).before.bytes, 'base64').toString('utf8')
  assert.match(before, /token-stub/, 'the state file holds the gitconfig bytes this test protects')
  assert.equal(mode(), 0o600)
  assert.equal(sh('uninstall').status, 0)
  assert.ok(!existsSync(state))
  writeFileSync(`${state}.tmp`, 'stale', { mode: 0o644 })
  chmodSync(`${state}.tmp`, 0o644)
  const again = sh('install')
  assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`)
  assert.equal(mode(), 0o600)
  assert.equal(sh('uninstall').status, 0)
})
