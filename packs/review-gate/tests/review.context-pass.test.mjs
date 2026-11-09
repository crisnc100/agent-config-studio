import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// ── the code-line check: an accident barrier for the writer, failing closed ──
const JS = ["// Loads the config.", "/**", " * The parser.", " */", "export function parse(s) {", "  const url = 'http://x' // where it lives", "  return s.split(',')", "}", ""].join('\n')
function verdicts(cases) {
  commit(Object.fromEntries(cases.map(([p, a]) => [p, a])), 'before')
  const sha = commit(Object.fromEntries(cases.map(([p, , b]) => [p, b])), 'after')
  const r = run(['--check-commit', sha])
  const bad = new Set(r.json.problems.map((x) => x.split(':')[0]))
  return Object.fromEntries(cases.map(([p]) => [p, !bad.has(p)]))
}
test('7 a code file passes only when its changed lines are wholly comment or blank, by its language', () => {
  const cases = [
    ['src/a.js', JS, JS.replace('// Loads the config.', '// Reads the config once, at start.'), true],
    ['src/b.js', JS, `${JS}\n\n`, true],
    ['src/n.js', JS, JS.replace(' * The parser.', ' * The config parser, comma-separated.'), true],
    ['src/o.js', JS, JS.replace(' * The parser.\n', ''), true],
    ['src/p.py', 'def f():\n    """Doc."""\n    return 1\n', 'def f():\n    """Better doc."""\n    return 1\n', false],
    ['src/c.js', JS, JS.replace("split(',')", "split(';')"), false],
    ['src/d.js', JS, JS.replace("'http://x'", "'http://y'"), false],
    ['src/e.js', JS, JS.replace('// where it lives', '// where it is served'), false],
    ['src/f.js', JS, JS.replace('// Loads the config.', '// @ts-ignore'), false],
    ['src/g.py', 'x = 1  # one\n# about y\ny = "#2"\n', 'x = 1  # one\n# about y, kept short\ny = "#2"\n', true],
    ['src/h.py', '# about\nx = 1\n', '# type: ignore\nx = 1\n', false],
    ['src/i.sh', 'echo $# # count\n', 'echo $# # the count\n', false],
    ['src/j.sh', '# run it\necho hi\n', '# run it twice\necho hi\n', true],
    ['src/k.rs', '/// Adds.\nfn add(x: i32) -> i32 { x + 1 }\n', '/// Adds one.\nfn add(x: i32) -> i32 { x + 1 }\n', false],
    ['src/l.go', '//go:build linux\npackage m\n', '//go:build darwin\npackage m\n', false],
    ['src/m.unknownext', 'a\n', '# a\na\n', false],
  ]
  const got = verdicts(cases)
  for (const [p, , , want] of cases) assert.equal(got[p], want, p)
})
test('8 it fails closed: block-comment delimiters, regex literals, string continuations, heredocs and YAML block scalars count as code', () => {
  const cases = [
    ['src/a.js', JS, JS.replace('/**\n * The parser.\n */\n', ''), 'a removed block comment (delimiters change)'],
    ['src/b.js', 'const a = 1\n', 'const a = 1\n/* new */\n', 'an added block comment'],
    ['src/c.js', 'const re = /\\/*x/\nconst b = 2 // b\n', 'const re = /\\/*x/\nconst b = 2 // the b\n', 'a regex literal that looks like a comment start'],
    ['src/d.js', 'const r = /"/\n// note\nconst s = 1\n', 'const r = /"/\n// a note\nconst s = 1\n', 'a regex literal with a quote'],
    ['src/e.js', 'const t = `a\n// not a comment\nb`\n', 'const t = `a\n// still not a comment\nb`\n', 'a template literal across lines'],
    ['src/f.py', 'def f():\n    """Doc.\n    # not a comment\n    """\n', 'def f():\n    """Doc.\n    # changed text\n    """\n', 'a triple-quoted string'],
    ['src/g.sh', "cat <<EOF\n# not a comment\nEOF\n", "cat <<EOF\n# changed\nEOF\n", 'a heredoc'],
    ['src/h.yaml', 'script: |\n  # not a comment\n  run\n', 'script: |\n  # changed\n  run\n', 'a YAML block scalar'],
    ['src/i.c', 'int a = 1; \\\n// x\n', 'int a = 1; \\\n// y\n', 'a line continuation'],
  ]
  const got = verdicts(cases.map(([p, a, b]) => [p, a, b]))
  for (const [p, , , why] of cases) assert.equal(got[p], false, `${p}: ${why}`)
})
test('9 a large file is judged by its change, never refused for its length', () => {
  const big = Array.from({ length: 30000 }, (_, i) => `export const v${i} = ${i} // value ${i}`).join('\n') + '\n'
  const comment = big.replace('export const v15000 = 15000 // value 15000\n', 'export const v15000 = 15000 // value 15000\n// The middle one.\n')
  const changed = big.replace('export const v15000 = 15000', 'export const v15000 = 1')
  assert.deepEqual(verdicts([['src/big.js', big, comment]]), { 'src/big.js': true })
  git('reset', '-q', '--hard', 'HEAD~2')
  assert.deepEqual(verdicts([['src/big.js', big, changed]]), { 'src/big.js': false })
})
test('10 the agent-instruction list is wide and case-insensitive', () => {
  for (const path of ['sub/claude.md', 'docs/Agents.md', 'CLAUDE.local.md', 'AGENTS.override.md', '.github/copilot-instructions.md', '.github/instructions/web.instructions.md',
    '.gemini/styleguide.md', '.windsurf/rules/x.md', '.cursor/rules/x.mdc', 'GEMINI.md', 'pkg/skill.md']) {
    const sha = commit({ [path]: '# Rules\n' }, `add ${path}`)
    const edit = commit({ [path]: '# Rules\nMore.\n' }, `edit ${path}`)
    const r = run(['--check-commit', edit])
    assert.ok(r.json.problems?.some((p) => p.startsWith(`${path}: an agent-instruction file`)), `${path}: ${JSON.stringify(r.json)}`)
    assert.ok(sha)
  }
})
test('11 the script says the gate never trusts its code-line check', () => {
  const text = readFileSync(SCRIPT, 'utf8')
  assert.match(text, /never trusts? (it|this check)/i)
})
