#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// A review run from a linked git worktree (where `.git` is a file) still gets reviews/ ignored, through
// the common dir's info/exclude. Stub CLIs, a temporary HOME and an isolated git config.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'review.mjs')
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'review-worktree-test-')))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), TREE = join(ROOT, 'linked'), BIN = join(ROOT, 'bin')
after(() => rmSync(ROOT, { recursive: true, force: true }))
mkdirSync(BIN)
mkdirSync(HOME)
const stub = (name, body) => {
  writeFileSync(join(BIN, name), `#!${process.execPath}\n${body}`)
  chmodSync(join(BIN, name), 0o755)
}
stub('model-id', `const a=process.argv.slice(2), ids={sol:'gpt-stub-sol',opus:'claude-stub-opus',grok:'grok-stub'}; console.log(a[0]==='--role' ? JSON.stringify({use:['sol','opus','grok'],ids:['gpt-stub-sol','claude-stub-opus','grok-stub']}) : a[0]==='--flavor' ? JSON.stringify({flavor:{effort:'high'}}) : ids[a[0]] || 'stub-'+a[0])`)
const modelBody = `
const fs = require('node:fs')
const a = process.argv.slice(2)
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8') : a[a.indexOf('--json-schema')+1]
const reply = schema.includes('"scores"') ? '{"scores":[]}' : '{"findings":[]}'
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1], reply)
else console.log(JSON.stringify({structured_output:JSON.parse(reply),structuredOutput:JSON.parse(reply),modelUsage:{'stub-grok':{}}}))
`
for (const name of ['codex', 'claude', 'grok']) stub(name, modelBody)
const env = { HOME, CODEX_HOME: join(HOME, '.codex'), GROK_HOME: join(HOME, '.grok'), GIT_CONFIG_GLOBAL: join(HOME, 'isolated.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1', PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: ROOT, REVIEW_BASE: 'main', REVIEW_REVIEWER: 'sol' }
function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env, encoding: 'utf8' })
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  return r.stdout.trim()
}

test('a review from a linked worktree adds reviews/ to the common info/exclude, so git ignores it there', () => {
  mkdirSync(REPO)
  git(REPO, 'init', '-q', '-b', 'main')
  writeFileSync(join(REPO, 'a.js'), 'export const f = (n) => n\n')
  git(REPO, 'add', '.')
  git(REPO, 'commit', '-qm', 'base')
  git(REPO, 'worktree', 'add', '-q', '-b', 'feat', TREE)
  writeFileSync(join(TREE, 'a.js'), 'export const f = (n) => {\n  for (let i = 0; i <= n; i++) {}\n  return n\n}\n')
  git(TREE, 'add', '.')
  git(TREE, 'commit', '-qm', 'change')
  assert.ok(!existsSync(join(TREE, '.git', 'info')), 'the linked worktree has a .git file, not a folder')
  const ignored = () => spawnSync('git', ['check-ignore', '-q', 'reviews'], { cwd: TREE, env }).status === 0
  assert.equal(ignored(), false, 'reviews/ is not ignored before the review')

  const r = spawnSync(process.execPath, [SCRIPT, 'fix the loop'], { cwd: TREE, env, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  assert.ok(existsSync(join(TREE, 'reviews', 'latest')), 'the report was written in the worktree')
  assert.ok(ignored(), 'reviews/ is ignored in the linked worktree')
  const exclude = resolve(TREE, git(TREE, 'rev-parse', '--git-path', 'info/exclude'))
  assert.ok(readFileSync(exclude, 'utf8').split('\n').includes('reviews/'), exclude)
  assert.equal(git(TREE, 'status', '--porcelain', '--untracked-files=all'), '', 'nothing under reviews/ shows as untracked')
})
