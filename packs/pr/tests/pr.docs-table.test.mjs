#!/usr/bin/env node
/**
 * The docs table the context pass writes (builds/<slug>/docs-table.json, beside the plan, or --docs-table) and what
 * pr-facts makes of it: the facts carry it, and --check fails a changed code file no row covers, a row with neither
 * docs nor a reason, and a claim whose file:line is not in the repo. A temp HOME and repo; no model, no gh.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HELPER = resolve(dirname(fileURLToPath(import.meta.url)), '../skills/claude/pr/pr-facts.mjs')
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'pr-docs-table-test-')))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), NODE = join(ROOT, 'node-bin')
mkdirSync(HOME); mkdirSync(NODE); symlinkSync(process.execPath, join(NODE, 'node'))
after(() => rmSync(ROOT, { recursive: true, force: true }))
const env = { HOME, PATH: [NODE, '/usr/bin', '/bin'].join(':'), LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(ROOT, 'gitconfig'), TMPDIR: ROOT }
const sh = (cmd, args) => { const r = spawnSync(cmd, args, { cwd: REPO, env, encoding: 'utf8' }); return { code: r.status, stdout: r.stdout || '', out: `${r.stdout}\n${r.stderr}` } }
const git = (...args) => { const r = sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args]); assert.equal(r.code, 0, r.out); return r.stdout.trim() }
const commit = (files) => {
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(REPO, p)), { recursive: true }); writeFileSync(join(REPO, p), typeof t === 'string' ? t : JSON.stringify(t, null, 2)) }
  git('add', '-A'); git('commit', '-qm', 'change')
}
const facts = (args = []) => { const r = sh(process.execPath, [HELPER, '--base', 'main', ...args]); assert.equal(r.code, 0, r.out); return JSON.parse(r.stdout) }
const problems = (args = []) => {
  writeFileSync(join(ROOT, 'body.md'), '# x\n')
  const r = sh(process.execPath, [HELPER, '--base', 'main', '--check', join(ROOT, 'body.md'), ...args])
  return JSON.parse(r.stdout).problems.filter((p) => /docs table/.test(p))
}
const PLAN = '# Plan\n\n## Outcome\nAdds add and sub.\n'
const ROW_ADD = { behavior: 'add adds one', files: ['src/add.js'], docs: [{ path: 'docs/guide.md', claims: [{ claim: 'add adds one', at: 'src/add.js:2' }] }] }
const ROW_SUB = { behavior: 'sub is internal', files: ['src/sub.js'], none: 'internal helper; no reader-facing doc' }

beforeEach(() => {
  rmSync(REPO, { recursive: true, force: true }); mkdirSync(REPO)
  git('init', '-q', '-b', 'main')
  commit({ 'README.md': 'base\n' })
  git('checkout', '-qb', 'feat')
  commit({ 'builds/feat/plan.md': PLAN, 'src/add.js': '// Adds one.\nexport const add = (n) => n + 1\n', 'src/sub.js': 'export const sub = (n) => n - 1\n',
    'docs/guide.md': '# Guide\nadd adds one (src/add.js:2).\n' })
})

test('1 no docs table: the facts say null and --check adds no docs-table problem', () => {
  assert.equal(facts().docsTable, null)
  assert.deepEqual(problems(), [])
})

test('2 a table beside the plan that covers every changed code file passes, and the facts carry its rows', () => {
  commit({ 'builds/feat/docs-table.json': { rows: [ROW_ADD, ROW_SUB] } })
  const f = facts()
  assert.equal(f.docsTable.path, 'builds/feat/docs-table.json')
  assert.deepEqual(f.docsTable.rows.map((r) => r.behavior), ['add adds one', 'sub is internal'])
  assert.deepEqual(f.docsTable.uncovered, [])
  assert.deepEqual(problems(), [])
})

test('3 --check fails a changed behavior with no row: a changed code file no row covers', () => {
  commit({ 'builds/feat/docs-table.json': { rows: [ROW_ADD] } })
  assert.deepEqual(facts().docsTable.uncovered, ['src/sub.js'])
  assert.deepEqual(problems(), ['docs table: src/sub.js changed, but no row covers it'])
})

test('4 --check fails a row with neither docs nor a reason, an empty field, and a claim whose file:line is not there', () => {
  commit({ 'builds/feat/docs-table.json': { rows: [
    { behavior: 'add adds one', files: ['src/add.js'] },
    { behavior: '', files: ['src/sub.js'], none: 'internal' },
    { behavior: 'sub', files: ['src/sub.js'], docs: [{ path: 'docs/guide.md', claims: [{ claim: 'x', at: 'src/sub.js:9' }, { claim: 'y', at: 'src/gone.js:1' }, { claim: 'z' }] }] },
    { behavior: 'guide', files: ['src/add.js'], docs: [{ path: 'docs/nope.md', claims: [] }] },
  ] } })
  const got = problems()
  for (const want of [
    'docs table row 1 (add adds one): needs docs with claims, or a reason no doc is needed ("none")',
    'docs table row 2: behavior is empty',
    'docs table row 3 (sub): claim "x" points at src/sub.js:9, but src/sub.js has 1 line(s)',
    'docs table row 3 (sub): claim "y" points at src/gone.js:1, which is not in the repo at HEAD',
    'docs table row 3 (sub): claim "z" has no file:line ("at")',
    'docs table row 4 (guide): docs/nope.md is not in the repo at HEAD',
    'docs table row 4 (guide): docs/nope.md lists no claims',
  ]) assert.ok(got.includes(want), `${want}\n${JSON.stringify(got, null, 1)}`)
})

test('5 --docs-table names the file; a missing one, or one that is not JSON, is refused or reported', () => {
  commit({ 'notes/table.json': { rows: [ROW_ADD, ROW_SUB] } })
  assert.equal(facts(['--docs-table', 'notes/table.json']).docsTable.path, 'notes/table.json')
  const r = sh(process.execPath, [HELPER, '--base', 'main', '--docs-table', 'notes/none.json'])
  assert.equal(r.code, 1); assert.match(r.out, /--docs-table notes\/none\.json: no such file/)
  commit({ 'builds/feat/docs-table.json': '{ not json' })
  assert.ok(problems().some((p) => /^docs table: builds\/feat\/docs-table\.json is not valid JSON/.test(p)), JSON.stringify(problems()))
})

test('6 with no plan, the table is still found in the build folder: a changed builds/<slug>/docs-table.json, else builds/<branch>/', () => {
  git('rm', '-q', 'builds/feat/plan.md'); git('commit', '-qm', 'no plan')
  commit({ 'builds/feat/docs-table.json': { rows: [ROW_ADD] } })
  assert.equal(facts().plan, null)
  assert.equal(facts().docsTable?.path, 'builds/feat/docs-table.json')
  assert.deepEqual(problems(), ['docs table: src/sub.js changed, but no row covers it'])
  git('mv', 'builds/feat', 'builds/other-slug'); git('commit', '-qm', 'move')
  assert.equal(facts().docsTable?.path, 'builds/other-slug/docs-table.json')
})

test('7 an empty table with changed code fails, naming every uncovered file', () => {
  commit({ 'builds/feat/docs-table.json': { rows: [] } })
  assert.deepEqual(problems().sort(), ['docs table: src/add.js changed, but no row covers it', 'docs table: src/sub.js changed, but no row covers it'])
})
