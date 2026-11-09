import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// The context pass's review side: a docs-focus slice (review.mjs --focus docs), the comment-only classifier
// (--comment-only) and the merge tier for a comment-only commit a closed docs-focus slice covers. Stub CLIs record every
// model call; temporary HOME and Git config; no real model.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'review.mjs')
const SKILLS = join(dirname(SCRIPT), '..', 'skills')
const ROOT = mkdtempSync(join(tmpdir(), 'review-context-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), BIN = join(ROOT, 'bin'), CALLS = join(ROOT, 'calls.jsonl')
const LOG = join(HOME, '.agent-config-studio/review-log/review-log.jsonl')
const SEC_LOG = join(HOME, '.agent-config-studio/review-log/security-log.jsonl')
const HOME_CONFIG = join(HOME, '.agent-config-studio/review-gate/config.json')
const MARKER = 'SECURITY REVIEW ONLY.'
const ZERO = '0'.repeat(40)
mkdirSync(BIN)
const stub = (name, body) => {
  writeFileSync(join(BIN, name), `#!${process.execPath}\n${body}`)
  chmodSync(join(BIN, name), 0o755)
}
// STUB_ROLES lists the roles model-id knows (default reviewer and security); any other role answers the way model-id
// does for a role nobody chose.
stub('model-id', `
const a = process.argv.slice(2), ids = { sol: 'gpt-stub-sol', opus: 'claude-stub-opus' }
const roles = { reviewer: 'sol,opus', security: 'opus,sol' }
const known = (process.env.STUB_ROLES ?? 'reviewer,security').split(',')
if (a[0] === '--role') {
  if (!known.includes(a[1])) { console.error('model-id: role "' + a[1] + '" is not set — choose its model'); console.log('family=MODEL-ID-UNRESOLVED-' + a[1]); process.exit(2) }
  const use = roles[a[1]].split(',')
  console.log(JSON.stringify({ use, ids: use.map((f) => ids[f]) }))
} else if (a[0] === '--flavor') console.log(JSON.stringify({ flavor: { effort: 'high' } }))
else console.log(ids[a[0]] || 'stub-' + a[0])
`)
const modelBody = `
const fs = require('node:fs')
const a = process.argv.slice(2), cli = require('node:path').basename(process.argv[1])
if (a[0] === 'mcp') { console.log('[]'); process.exit(0) }
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8') : a[a.indexOf('--json-schema')+1]
const prompt = cli === 'codex' ? a.at(-1) : a[a.indexOf('-p')+1]
const kind = schema.includes('"scores"') ? 'scores' : schema.includes('"verdicts"') ? 'verdicts' : prompt.includes(${JSON.stringify(MARKER)}) ? 'security' : 'code'
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ cli, kind, prompt }) + '\\n')
const reply = kind === 'scores' ? '{"scores":[]}' : kind === 'verdicts' ? '{"verdicts":[]}'
  : kind === 'security' ? (process.env.STUB_SEC_FINDINGS || '{"findings":[]}') : (process.env.STUB_FINDINGS || '{"findings":[]}')
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1], reply)
else console.log(JSON.stringify({ structured_output: JSON.parse(reply), structuredOutput: JSON.parse(reply) }))
`
for (const name of ['codex', 'claude']) stub(name, modelBody)
after(() => rmSync(ROOT, { recursive: true, force: true }))

const env = (extra = {}) => ({ HOME, CODEX_HOME: join(HOME, '.codex'), GROK_HOME: join(HOME, '.grok'), GIT_CONFIG_GLOBAL: join(HOME, 'isolated.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1', PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: ROOT, REVIEW_BASE: 'main', ...extra })
function run(command, args, extra = {}, input = undefined, cwd = REPO) {
  const r = spawnSync(command, args, { cwd, env: env(extra), encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024 * 1024, ...(input !== undefined && { input }) })
  return { ...r, out: `${r.stdout || ''}\n${r.stderr || ''}` }
}
const script = (args, extra = {}, input = undefined) => run(process.execPath, [SCRIPT, ...args], extra, input)
function git(...args) {
  const r = run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  assert.equal(r.status, 0, r.out)
  return r.stdout.trim()
}
function commit(files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(REPO, path)), { recursive: true })
    writeFileSync(join(REPO, path), text)
  }
  git('add', ...Object.keys(files)); git('commit', '-qm', `change ${Object.keys(files).join(' ')}`)
}
const lines = (path) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const text = (path) => existsSync(path) ? readFileSync(path, 'utf8') : ''
const calls = () => lines(CALLS)
const allowed = (r) => assert.equal(r.status, 0, r.out)
const refused = (r, pattern) => { assert.notEqual(r.status, 0, r.out); if (pattern) assert.match(r.out, pattern) }
const findingsJson = (r) => JSON.parse(r.stdout.slice(r.stdout.indexOf('===FINDINGS_JSON===') + 19))
const gate = () => script(['--gate'], {}, `refs/heads/feat ${git('rev-parse', 'HEAD')} refs/heads/feat ${ZERO}\n`)
const APP = 'export const one = 1\nexport const two = 2\nexport const three = 3\n'
const finding = (over = {}) => ({ issue: 'two leaks a token', file: 'src/app.js', line: '2', quote: 'export const two = 2', suggestion: 'drop it',
  likelihood: 6, impact: 7, protected: false, trigger: 'reading two', ...over })
const findings = (...list) => JSON.stringify({ findings: list })

function reviewed(extra = {}, args = []) {
  const r = script(args, { REVIEW_REVIEWER: 'sol', ...extra })
  allowed(r)
  return findingsJson(r).reviewId
}
function closed(id, statuses = {}) {
  const path = join(ROOT, 'statuses.json')
  writeFileSync(path, JSON.stringify(statuses))
  const r = script(['--close', id, '--status', path, '--test-cmd', 'true'])
  allowed(r)
  return lines(LOG).at(-1)
}
const homeConfig = (config) => { mkdirSync(dirname(HOME_CONFIG), { recursive: true }); writeFileSync(HOME_CONFIG, JSON.stringify(config)) }
const docsSlice = (paths, extra = {}) => reviewed({ REVIEW_PATHS: paths, ...extra }, ['--focus', 'docs'])
const commentOnly = (from, to, ...paths) => { const r = script(['--comment-only', from, to, ...paths]); allowed(r); return JSON.parse(r.stdout) }

beforeEach(() => {
  for (const path of [HOME, REPO, CALLS]) rmSync(path, { recursive: true, force: true })
  mkdirSync(REPO)
  git('init', '-q', '-b', 'main')
  commit({ 'README.md': 'base\n' })
  git('checkout', '-qb', 'feat')
  commit({ 'src/app.js': APP, 'README.md': 'base\nThe app exports one, two and three.\n' })
})

test('1 --focus docs reviews a slice with the docs prompt, never starts the security pass, and records its focus', () => {
  homeConfig({ security: { run: 'always' } })
  const id = docsSlice('src/app.js,README.md')
  const code = calls().filter((c) => c.kind === 'code'), security = calls().filter((c) => c.kind === 'security')
  assert.equal(code.length, 1); assert.equal(security.length, 0)
  assert.match(code[0].prompt, /DOCS AND COMMENTS REVIEW/)
  assert.doesNotMatch(code[0].prompt, /CODE CORRECTNESS only/)
  for (const part of ['untrue', 'not backed by the code', 'code-line change', '+The app exports one, two and three.'])
    assert.ok(code[0].prompt.includes(part), part)
  const record = lines(LOG).find((e) => e.id === id)
  assert.equal(record.focus, 'docs')
  assert.deepEqual(record.paths, ['README.md', 'src/app.js'])
  assert.equal(record.security.status, 'not-asked')
})

test('2 --focus refuses without a slice, an unknown focus, and a plain review records no focus', () => {
  refused(script(['--focus', 'docs'], { REVIEW_REVIEWER: 'sol' }), /--focus docs reviews a slice/)
  refused(script(['--focus', 'style'], { REVIEW_REVIEWER: 'sol', REVIEW_PATHS: 'README.md' }), /--focus must be docs/)
  assert.equal(calls().length, 0)
  const id = reviewed()
  assert.equal(Object.hasOwn(lines(LOG).find((e) => e.id === id), 'focus'), false)
  assert.equal(script(['--supports', '--focus']).status, 0)
})

test('3 a planted wrong doc claim the docs reviewer flags is a located finding that blocks the slice close until fixed', () => {
  commit({ 'README.md': 'base\nThe app exports one, two, three and four.\n' })
  const wrong = { issue: 'the README says the app exports four; src/app.js exports one, two and three', file: 'README.md', line: '2',
    quote: 'The app exports one, two, three and four.', suggestion: 'drop four', likelihood: 6, impact: 4, protected: false, trigger: 'a reader following the README' }
  const id = docsSlice('README.md', { STUB_FINDINGS: findings(wrong) })
  const record = lines(LOG).find((e) => e.id === id)
  assert.equal(record.findingDetails[0].status, 'verified-quote')
  assert.equal(record.findingDetails[0].severity, 'medium')
  const path = join(ROOT, 'statuses.json')
  writeFileSync(path, '{}')
  refused(script(['--close', id, '--status', path, '--test-cmd', 'true']), /f1/)
})

const JS_OLD = [
  "// Loads the config.",
  "/**",
  " * The parser.",
  " * @param {string} s",
  " */",
  "export function parse(s) {",
  "  const url = 'http://x' // where it lives",
  "  return s.split(',') // split on commas",
  "}",
  "",
].join('\n')

test('4 --comment-only: comment and blank lines only, per language; code, strings, directives and doc tests are code', () => {
  const cases = [
    ['src/a.js', JS_OLD, JS_OLD.replace('// Loads the config.', '// Reads the config once, at start.').replace(' * The parser.\n', ''), true],
    ['src/b.js', JS_OLD, JS_OLD.replace("split(',')", "split(';')"), false],
    ['src/c.js', JS_OLD, JS_OLD.replace("'http://x'", "'http://y'"), false],
    ['src/d.js', JS_OLD, JS_OLD.replace('// where it lives', '// where it is served'), false],
    ['src/e.js', JS_OLD, JS_OLD.replace('// Loads the config.', '// @ts-ignore'), false],
    ['src/f.js', JS_OLD, `${JS_OLD}\n\n`, true],
    ['src/g.py', 'x = 1  # one\n# about y\ny = "#2"\n', 'x = 1  # one\n# about y, kept short\ny = "#2"\n', true],
    ['src/h.py', 'def f():\n    """Doc."""\n    return 1\n', 'def f():\n    """Better doc."""\n    return 1\n', false],
    ['src/i.py', '# about\nx = 1\n', '# type: ignore\nx = 1\n', false],
    ['src/j.sh', 'echo $# # count\n', 'echo $# # the count\n', false],
    ['src/k.sh', '# run it\necho hi\n', '# run it twice\necho hi\n', true],
    ['src/l.rs', '/// Adds.\n/// ```\n/// assert_eq!(add(1), 2);\n/// ```\nfn add(x: i32) -> i32 { x + 1 }\n', '/// Adds one.\n/// ```\n/// assert_eq!(add(1), 2);\n/// ```\nfn add(x: i32) -> i32 { x + 1 }\n', false],
    ['src/m.go', '//go:build linux\npackage m\n', '//go:build darwin\npackage m\n', false],
    ['src/n.unknownext', 'a\n', '# a\na\n', false],
    ['src/o.js', 'const a = 1\n', 'const a = 1\n/* new */\n', true],
  ]
  commit(Object.fromEntries(cases.map(([p, a]) => [p, a])))
  const from = git('rev-parse', 'HEAD')
  commit(Object.fromEntries(cases.map(([p, , b]) => [p, b])))
  const out = commentOnly(from, 'HEAD', ...cases.map(([p]) => p))
  for (const [p, , , want] of cases) assert.equal(out.files[p], want, `${p}: ${JSON.stringify(out.files[p])}`)
  assert.equal(out.commentOnly, false)
  assert.deepEqual(commentOnly(from, 'HEAD', 'src/a.js', 'src/f.js', 'src/o.js'), { commentOnly: true, files: { 'src/a.js': true, 'src/f.js': true, 'src/o.js': true } })
  git('rm', '-q', 'src/a.js'); git('commit', '-qm', 'gone')
  assert.equal(commentOnly(from, 'HEAD', 'src/a.js').files['src/a.js'], false, 'a deleted file is not a comment edit')
})

function tierFlow({ edit, extraSlice = '' }) {
  homeConfig({ security: { run: 'required' } })
  const main = reviewed()
  assert.equal(lines(LOG).find((e) => e.id === main).security.status, 'ran')
  const mainClose = closed(main)
  commit({ 'src/app.js': edit, 'README.md': 'base\nThe app exports one, two and three, each a number.\n' })
  rmSync(CALLS, { force: true })
  const slice = docsSlice(`src/app.js,README.md${extraSlice}`)
  assert.equal(calls().filter((c) => c.kind === 'security').length, 0, 'the docs slice runs no security pass')
  return { mainClose, sliceClose: closed(slice) }
}

test('5 merge tier (protected): a comment-only commit covered by a closed docs-focus slice adds no security reason, and the push passes', () => {
  const { mainClose, sliceClose } = tierFlow({ edit: `// The three numbers the app exports.\n${APP}` })
  assert.ok(!sliceClose.tierReasons.some((r) => /security/.test(r)), JSON.stringify(sliceClose.tierReasons))
  assert.notEqual(sliceClose.tier, 'high', JSON.stringify(sliceClose.tierReasons))
  assert.equal(mainClose.tier, sliceClose.tier, 'the comment-only commit leaves the tier where the main close put it')
  allowed(gate())
  const tip = JSON.parse(script(['--tier-json']).stdout)
  assert.equal(tip.covered, true); assert.equal(tip.tier, mainClose.tier, JSON.stringify(tip))
})

test('5b merge tier (protected): a logic change in the docs slice still makes it HIGH, naming the file', () => {
  const { sliceClose } = tierFlow({ edit: APP.replace('two = 2', 'two = 22') })
  assert.equal(sliceClose.tier, 'high')
  assert.ok(sliceClose.tierReasons.some((r) => /security pass did not see src\/app\.js/.test(r)), JSON.stringify(sliceClose.tierReasons))
})

test('5c merge tier (protected): a comment edit to a file no security pass ever saw stays HIGH', () => {
  homeConfig({ security: { run: 'off' } })
  closed(reviewed())
  homeConfig({ security: { run: 'required' } })
  commit({ 'src/app.js': `// The three numbers.\n${APP}` })
  const sliceClose = closed(docsSlice('src/app.js'))
  assert.equal(sliceClose.tier, 'high')
  assert.ok(sliceClose.tierReasons.some((r) => /security pass did not see src\/app\.js/.test(r)), JSON.stringify(sliceClose.tierReasons))
})

test('5d merge tier (protected): the exemption is the docs-focus slice\'s alone; a plain slice of the same comment edit stays HIGH', () => {
  homeConfig({ security: { run: 'required' } })
  closed(reviewed())
  commit({ 'src/app.js': `// The three numbers.\n${APP}` })
  const plain = closed(reviewed({ REVIEW_PATHS: 'src/app.js' }, ['--code-only']))
  assert.equal(plain.tier, 'high', JSON.stringify(plain.tierReasons))
})
