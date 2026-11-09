import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// context-pass.mjs: the brief check (--check-brief) and the writer-commit check (--check-commit). A real git repo in a
// temporary folder; no model runs.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'context-pass.mjs')
const ROOT = mkdtempSync(join(tmpdir(), 'context-pass-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo')
after(() => rmSync(ROOT, { recursive: true, force: true }))
const env = { HOME, GIT_CONFIG_GLOBAL: join(ROOT, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':') }
const run = (args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, env, encoding: 'utf8' })
  let json = null
  try { json = JSON.parse(r.stdout) } catch { /* the test says what it got */ }
  return { ...r, json, out: `${r.stdout}\n${r.stderr}` }
}
function git(...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: REPO, env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}
function commit(files, message = 'change') {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) { git('rm', '-q', path); continue }
    mkdirSync(dirname(join(REPO, path)), { recursive: true })
    writeFileSync(join(REPO, path), text)
    git('add', path)
  }
  git('commit', '-qm', message)
  return git('rev-parse', 'HEAD')
}
const brief = (doc) => { const p = join(ROOT, 'brief.json'); writeFileSync(p, JSON.stringify(doc)); return p }

const APP = '// Adds one.\nexport const add = (n) => n + 1\n'
const GUIDE = '# Guide\n\nThe add helper adds one.\n'
const README = '# App\n\n<!-- acs:model-guide v1 sep=1 sha256:' + 'a'.repeat(64) + ' -->\nGenerated text.\n<!-- /acs:model-guide -->\n\nRun it with node.\nThe exact line a test pins stays put.\n'
const PINNING_TEST = "assert.ok(readme.includes('The exact line a test pins stays put.'))\n"
const PR = {
  mode: 'pr',
  purpose: 'Adds an add helper',
  mechanism: ['src/app.js exports add', 'docs/guide.md describes it'],
  decisions: ['add adds one, never more; a configurable step was rejected'],
  readers: { 'README.md': 'users', 'docs/guide.md': 'people configuring it', comments: 'the next maintainer' },
  base: 'main',
  docMap: [{ behavior: 'add adds one', docs: ['docs/guide.md'] }],
  untouchable: ['lib/commands.md'],
}

beforeEach(() => {
  rmSync(REPO, { recursive: true, force: true })
  mkdirSync(REPO)
  git('init', '-q', '-b', 'main')
  commit({ 'src/app.js': APP, 'docs/guide.md': GUIDE, 'README.md': README, 'tests/readme.test.mjs': PINNING_TEST, 'lib/commands.md': '# Commands\n- run\n',
    'CLAUDE.md': '# Rules\n', 'pkg/AGENTS.md': '# Rules\n', 'packs/x/instructions/x.md': '# Block\n', 'packs/x/skills/claude/x/SKILL.md': '---\nname: x\n---\n' }, 'base')
})

test('1 --check-brief accepts a whole PR brief and a whole standalone brief', () => {
  const pr = run(['--check-brief', brief(PR)])
  assert.equal(pr.status, 0, pr.out); assert.equal(pr.json.ok, true); assert.equal(pr.json.mode, 'pr')
  const alone = run(['--check-brief', brief({ mode: 'standalone', purpose: 'the add helper', readers: 'the next maintainer', paths: ['src/'] })])
  assert.equal(alone.status, 0, alone.out); assert.equal(alone.json.mode, 'standalone')
})

test('2 --check-brief refuses each missing field by name', () => {
  for (const field of Object.keys(PR)) {
    const { [field]: _, ...rest } = PR
    const r = run(['--check-brief', brief(rest)])
    assert.equal(r.status, 1, `${field}: ${r.out}`)
    assert.ok(r.json.problems.some((p) => p.startsWith(`${field}: missing`)), `${field}: ${JSON.stringify(r.json)}`)
  }
  for (const field of ['purpose', 'readers', 'paths']) {
    const { [field]: _, ...rest } = { mode: 'standalone', purpose: 'p', readers: 'r', paths: ['src/'] }
    const r = run(['--check-brief', brief(rest)])
    assert.ok(r.json.problems.some((p) => p.startsWith(`${field}: missing`)), `standalone ${field}: ${JSON.stringify(r.json)}`)
  }
})

test('3 --check-brief refuses an empty field, a bad shape, an unknown field and a base that does not resolve, each by name', () => {
  const cases = [
    ['purpose', { purpose: '   ' }, /purpose: empty/],
    ['mechanism', { mechanism: [] }, /mechanism: empty/],
    ['decisions', { decisions: [''] }, /decisions: empty/],
    ['readers', { readers: {} }, /readers: empty/],
    ['docMap', { docMap: [{ behavior: '', docs: [] }] }, /docMap\[0\]\.behavior: empty/],
    ['docMap', { docMap: [{ behavior: 'x' }] }, /docMap\[0\]\.docs: missing/],
    ['untouchable', { untouchable: 'lib/commands.md' }, /untouchable: must be a list/],
    ['base', { base: 'no-such-branch' }, /base: no-such-branch does not name a commit/],
    ['extra', { notes: 'x' }, /notes: unknown field/],
    ['mode', { mode: 'quick' }, /mode: must be pr or standalone/],
  ]
  for (const [label, over, re] of cases) {
    const r = run(['--check-brief', brief({ ...PR, ...over })])
    assert.equal(r.status, 1, label)
    assert.ok(r.json.problems.some((p) => re.test(p)), `${label}: ${JSON.stringify(r.json.problems)}`)
  }
  const missing = run(['--check-brief', join(ROOT, 'nope.json')])
  assert.equal(missing.status, 1); assert.match(missing.out, /no such file/)
  writeFileSync(join(ROOT, 'bad.json'), '{ not json')
  assert.match(run(['--check-brief', join(ROOT, 'bad.json')]).out, /not valid JSON/)
})

test('4 --check-commit passes a writer commit of comment and doc edits outside every untouchable', () => {
  const sha = commit({ 'src/app.js': '// Adds one to n; callers rely on it never adding more.\nexport const add = (n) => n + 1\n',
    'docs/guide.md': '# Guide\n\nThe add helper adds exactly one (src/app.js:2).\n', 'README.md': README.replace('Run it with node.', 'Run it with Node 20 or later.') })
  const r = run(['--check-commit', sha, '--brief', brief(PR)])
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(r.json, { ok: true, commit: sha, problems: [], files: ['README.md', 'docs/guide.md', 'src/app.js'] })
})

test('5 --check-commit fails a writer commit that touches any untouchable path, naming the path and why', () => {
  const cases = [
    [{ 'tests/readme.test.mjs': `${PINNING_TEST}// more\n` }, /tests\/readme\.test\.mjs: a test file/],
    [{ 'CLAUDE.md': '# Rules\n\nMore.\n' }, /CLAUDE\.md: an agent-instruction file/],
    [{ 'pkg/AGENTS.md': '# Rules\n\nMore.\n' }, /pkg\/AGENTS\.md: an agent-instruction file/],
    [{ 'packs/x/skills/claude/x/SKILL.md': '---\nname: x\n---\nMore.\n' }, /SKILL\.md: an agent-instruction file/],
    [{ 'packs/x/instructions/x.md': '# Block\nMore.\n' }, /packs\/x\/instructions\/x\.md: an agent-instruction file/],
    [{ 'lib/commands.md': '# Commands\n- run\n- stop\n' }, /lib\/commands\.md: listed untouchable in the brief/],
    [{ 'README.md': README.replace('Generated text.', 'Edited text.') }, /README\.md: inside the generated block acs:model-guide/],
    [{ 'README.md': README.replace('The exact line a test pins stays put.', 'A reworded line.') }, /README\.md: a line a test pins: "The exact line a test pins stays put\."/],
    [{ 'src/app.js': '// Adds one.\nexport const add = (n) => n + 2\n' }, /src\/app\.js: a code line changed/],
    [{ 'src/app.js': null }, /src\/app\.js: a code line changed/],
  ]
  for (const [files, re] of cases) {
    const sha = commit(files)
    const r = run(['--check-commit', sha, '--brief', brief(PR)])
    assert.equal(r.status, 1, `${re}: ${r.out}`)
    assert.ok(r.json.problems.some((p) => re.test(p)), `${re}: ${JSON.stringify(r.json.problems)}`)
    git('reset', '-q', '--hard', 'HEAD~1')
  }
})

test('6 --check-commit without a brief still holds the built-in untouchables, and refuses a commit that is not one', () => {
  const sha = commit({ 'CLAUDE.md': '# Rules\nMore.\n' })
  const r = run(['--check-commit', sha])
  assert.equal(r.status, 1); assert.ok(r.json.problems.some((p) => /CLAUDE\.md: an agent-instruction file/.test(p)))
  assert.equal(run(['--check-commit', 'nope']).status, 1)
  assert.equal(run(['--bogus']).status, 1)
})
