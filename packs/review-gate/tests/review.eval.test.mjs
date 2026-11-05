import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// review.mjs --eval: each chosen reviewer family reviews every case (a base/ and a head/ tree) in a throwaway repo, as a
// child in eval mode, and the run is scored from the child's own record. Stub CLIs record every model call (cli, model,
// kind, cwd); temporary HOME and Git config; no real model.
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(PACK, 'runtime', 'review.mjs')
const EXAMPLES = join(PACK, 'runtime', 'eval', 'examples')
const ROOT = mkdtempSync(join(tmpdir(), 'review-eval-test-'))
const HOME = join(ROOT, 'home'), OPERATOR = join(ROOT, 'operator'), BIN = join(ROOT, 'bin'), GROK_BIN = join(ROOT, 'grok-bin')
const CALLS = join(ROOT, 'calls.jsonl'), CASES = join(ROOT, 'cases'), TMP = join(ROOT, 'tmp'), MARKS = join(ROOT, 'marks')
const LOG_DIR = join(HOME, '.agent-config-studio/review-log')
const LOG = join(LOG_DIR, 'review-log.jsonl'), EVAL_LOG = join(LOG_DIR, 'eval-log.jsonl')
const HOME_CONFIG = join(HOME, '.agent-config-studio/review-gate/config.json')
mkdirSync(BIN); mkdirSync(GROK_BIN)
const stub = (dir, name, body) => {
  writeFileSync(join(dir, name), `#!${process.execPath}\n${body}`)
  chmodSync(join(dir, name), 0o755)
}
stub(BIN, 'model-id', `
const a = process.argv.slice(2), ids = { sol: 'gpt-stub-sol', opus: 'claude-stub-opus', grok: 'grok-stub', fable: 'claude-stub-fable' }
if (a[0] === '--role') {
  const use = a[1] === 'security' ? ['opus', 'sol'] : ['sol', 'opus', 'grok']
  console.log(JSON.stringify({ use, ids: use.map((f) => ids[f]) }))
} else if (a[0] === '--flavor') console.log(JSON.stringify({ flavor: { effort: 'high' } }))
else console.log(ids[a[0]] || 'stub-' + a[0])
`)
// STUB_REPLIES: [{ model?, intent?, reply }] — the first entry whose model and intent (a substring of the prompt) match
// answers a code call; else STUB_FINDINGS. STUB_FAIL: models that fail with a quota error. STUB_SLEEP_MS: code calls hang.
const modelBody = `
const fs = require('node:fs')
const a = process.argv.slice(2), cli = require('node:path').basename(process.argv[1])
if (a[0] === 'mcp') { console.log('[]'); process.exit(0) }
if (a[0] === 'inspect') { console.log(JSON.stringify({ mcpServers: [], plugins: [] })); process.exit(0) }
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8') : a[a.indexOf('--json-schema')+1]
const prompt = cli === 'codex' ? a.at(-1) : a[a.indexOf('-p')+1]
const model = cli === 'codex' ? (a.find((x) => x.startsWith('model=')) || '').slice(6) : a[a.indexOf(cli === 'claude' ? '--model' : '-m')+1]
const kind = schema.includes('"scores"') ? 'scores' : schema.includes('"verdicts"') ? 'verdicts' : prompt.includes('SECURITY REVIEW ONLY.') ? 'security' : 'code'
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ cli, model, kind, cwd: process.cwd() }) + '\\n')
if (kind === 'code' && (process.env.STUB_FAIL || '').split(',').includes(model)) { console.error('quota exhausted'); process.exit(3) }
if (kind === 'code' && process.env.STUB_SLEEP_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.STUB_SLEEP_MS))
const replies = JSON.parse(process.env.STUB_REPLIES || '[]')
const hit = replies.find((r) => (!r.model || r.model === model) && (!r.intent || prompt.includes(r.intent)))
const reply = (kind === 'scores' ? '{"scores":[]}' : kind === 'verdicts' ? '{"verdicts":[]}' : kind === 'security' ? '{"findings":[]}'
  : hit ? JSON.stringify(hit.reply) : (process.env.STUB_FINDINGS || '{"findings":[]}')).replaceAll('@CWD@', process.cwd())
// STUB_ECHO: the CLI also echoes its answer to stdout, as codex does.
if (process.env.STUB_ECHO) console.log(reply)
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1], reply)
else console.log(JSON.stringify({ structured_output: JSON.parse(reply), structuredOutput: JSON.parse(reply), modelUsage: { [cli === 'claude' ? model : 'stub-grok']: {} } }))
`
for (const name of ['codex', 'claude']) stub(BIN, name, modelBody)
stub(GROK_BIN, 'grok', modelBody)
after(() => rmSync(ROOT, { recursive: true, force: true }))

const PATH_ALL = [BIN, GROK_BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':')
const env = (extra = {}) => ({ HOME, CODEX_HOME: join(HOME, '.codex'), GROK_HOME: join(HOME, '.grok'), GIT_CONFIG_GLOBAL: join(HOME, 'isolated.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1', PATH: PATH_ALL, TMPDIR: TMP, ...extra })
function run(command, args, { cwd = OPERATOR, ...extra } = {}) {
  const r = spawnSync(command, args, { cwd, env: env(extra), encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
  return { ...r, out: `${r.stdout || ''}\n${r.stderr || ''}` }
}
const script = (args, extra = {}) => run(process.execPath, [SCRIPT, ...args], extra)
const evalRun = (args = [], extra = {}) => script(['--eval', '--cases', CASES, ...args], extra)
function git(cwd, ...args) {
  const r = run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd })
  assert.equal(r.status, 0, r.out)
  return r.stdout.trim()
}
const lines = (path) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const calls = () => lines(CALLS)
const evalJson = (r) => {
  const at = r.stdout.indexOf('===EVAL_JSON===')
  assert.notEqual(at, -1, r.out)
  return JSON.parse(r.stdout.slice(at + 15))
}
const homeConfig = (config) => { mkdirSync(dirname(HOME_CONFIG), { recursive: true }); writeFileSync(HOME_CONFIG, JSON.stringify(config)) }
// A case folder: case.json, then base/ and head/ trees ({ path: text }); a missing tree is left out.
function makeCase(name, json, base, head) {
  const dir = join(CASES, name)
  mkdirSync(dir, { recursive: true })
  if (json !== undefined) writeFileSync(join(dir, 'case.json'), typeof json === 'string' ? json : JSON.stringify(json))
  for (const [side, tree] of [['base', base], ['head', head]]) {
    if (!tree) continue
    mkdirSync(join(dir, side), { recursive: true })
    for (const [path, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(dir, side, path)), { recursive: true })
      writeFileSync(join(dir, side, path), text)
    }
  }
  return dir
}
const examples = () => cpSync(EXAMPLES, CASES, { recursive: true })
// Hash of every file under a folder (path and bytes), to show it is byte-identical.
function treeHash(dir) {
  const h = createHash('sha256')
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else h.update(`${relative(dir, p)}\0`).update(readFileSync(p)).update('\0')
    }
  }
  walk(dir)
  return h.digest('hex')
}
const find = (dir, name) => {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true }).filter((p) => String(p).split('/').at(-1) === name)
}

// A repo the way --eval builds one: inside a review-eval- folder of the temp folder, main plus a branch commit.
function evalRoot(files = { 'src/app.js': 'export const one = 1\n' }) {
  const root = mkdtempSync(join(TMP, 'review-eval-')), repo = join(root, 'c', 'repo'), logDir = join(root, 'c', 'log')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), 'base\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base')
  git(repo, 'checkout', '-qb', 'eval-case')
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text) }
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'head')
  return { root, repo, logDir }
}
const evalEnv = ({ root, logDir }, extra = {}) => ({ REVIEW_EVAL: '1', REVIEW_EVAL_ROOT: root, REVIEW_EVAL_LOG_DIR: logDir, REVIEW_BASE: 'main', REVIEW_REVIEWER: 'sol', ...extra })
const finding = (over = {}) => ({ issue: 'a defect', suggestion: 'fix it', likelihood: 7, impact: 5, protected: false, trigger: 'calling it', ...over })
const BUG_HIT = finding({ issue: 'off by one', file: 'src/list.js', line: '2', quote: 'return items.slice(items.length - n + 1)' })
const ELSEWHERE = finding({ issue: 'readme', file: 'README.md', line: '1', quote: 'A tiny list helper module.' })
const FAREWELL = 'export const farewell = (name) => `Goodbye, ${name}`'
const findings = (...list) => ({ findings: list })

beforeEach(() => {
  for (const path of [HOME, OPERATOR, CALLS, CASES, TMP, MARKS]) rmSync(path, { recursive: true, force: true })
  mkdirSync(LOG_DIR, { recursive: true }); mkdirSync(OPERATOR); mkdirSync(CASES); mkdirSync(TMP); mkdirSync(MARKS)
  git(OPERATOR, 'init', '-q', '-b', 'main')
  writeFileSync(join(OPERATOR, 'README.md'), 'operator repo\n')
  git(OPERATOR, 'add', 'README.md'); git(OPERATOR, 'commit', '-qm', 'init')
})

test('1 the example bug case: the expected line is caught (with its severity), another file is missed', () => {
  examples()
  let r = evalRun(['--family', 'sol'], { STUB_REPLIES: JSON.stringify([{ intent: 'last(items, n)', reply: findings(BUG_HIT) }]) })
  assert.equal(r.status, 0, r.out)
  let [record] = evalJson(r)
  const bug = record.cases.find((c) => c.id === 'example-off-by-one')
  assert.equal(bug.outcome, 'caught', JSON.stringify(bug))
  assert.equal(bug.severity, 'medium')
  assert.equal(bug.expects[0].by, 'f1')
  assert.equal(bug.extra, 0)
  assert.match(r.stdout, /example-off-by-one \[bug\] caught \(medium/)

  r = evalRun(['--family', 'sol'], { STUB_REPLIES: JSON.stringify([{ intent: 'last(items, n)', reply: findings(ELSEWHERE) }]) })
  assert.equal(r.status, 0, r.out)
  ;[record] = evalJson(r)
  const miss = record.cases.find((c) => c.id === 'example-off-by-one')
  assert.equal(miss.outcome, 'missed', JSON.stringify(miss))
  assert.equal(miss.extra, 1, 'a located finding that matches no expect is extra')
  assert.equal(record.totals.missed, 1)
  assert.equal(record.totals.caught, 0)
})

test('1 the example clean case: a MEDIUM is one false alarm, a LOW is none (noted)', () => {
  examples()
  const medium = finding({ file: 'src/greet.js', line: '2', quote: FAREWELL, likelihood: 5, impact: 5 })
  let r = evalRun(['--family', 'sol'], { STUB_REPLIES: JSON.stringify([{ intent: 'farewell(name)', reply: findings(medium) }]) })
  assert.equal(r.status, 0, r.out)
  let clean = evalJson(r)[0].cases.find((c) => c.id === 'example-clean-helper')
  assert.equal(clean.outcome, 'false-alarm', JSON.stringify(clean))
  assert.equal(clean.falseAlarms, 1)
  assert.equal(evalJson(r)[0].totals.falseAlarms, 1)
  r = evalRun(['--family', 'sol'], { STUB_REPLIES: JSON.stringify([{ intent: 'farewell(name)', reply: findings({ ...medium, likelihood: 2, impact: 3 }) }]) })
  assert.equal(r.status, 0, r.out)
  clean = evalJson(r)[0].cases.find((c) => c.id === 'example-clean-helper')
  assert.equal(clean.outcome, 'clean', JSON.stringify(clean))
  assert.equal(clean.falseAlarms, 0)
  assert.equal(clean.lows, 1)
})

test('2 two families: two rows, two eval-log records with case results, and each row ran its own family\'s model', () => {
  examples()
  writeFileSync(EVAL_LOG, `${JSON.stringify({ type: 'eval', earlier: true })}\n`)
  const r = evalRun(['--family', 'sol,grok'], { STUB_REPLIES: JSON.stringify([
    { model: 'gpt-stub-sol', intent: 'last(items, n)', reply: findings(BUG_HIT) },
    { model: 'grok-stub', intent: 'last(items, n)', reply: findings(ELSEWHERE) },
  ]) })
  assert.equal(r.status, 0, r.out)
  const json = evalJson(r)
  assert.deepEqual(json.map((x) => x.family), ['sol', 'grok'])
  assert.match(r.stdout, /^sol \(gpt-stub-sol · high\).*bugs caught 1\/1/m)
  assert.match(r.stdout, /^grok \(grok-stub · high\).*bugs caught 0\/1/m)
  const logged = lines(EVAL_LOG)
  assert.equal(logged.length, 3, 'one record per family per run, appended')
  const [sol, grok] = logged.slice(1)
  assert.equal(sol.type, 'eval'); assert.equal(sol.runId, grok.runId)
  assert.equal(sol.family, 'sol'); assert.equal(sol.model, 'gpt-stub-sol'); assert.equal(sol.vendor, 'codex'); assert.equal(sol.effort, 'high')
  assert.equal(grok.family, 'grok'); assert.equal(grok.model, 'grok-stub'); assert.equal(grok.vendor, 'grok')
  assert.deepEqual(sol.cases.map((c) => [c.id, c.outcome]), [['example-clean-helper', 'clean'], ['example-off-by-one', 'caught']])
  assert.deepEqual(grok.cases.map((c) => [c.id, c.outcome]), [['example-clean-helper', 'clean'], ['example-off-by-one', 'missed']])
  for (const c of sol.cases) assert.equal(c.model, 'gpt-stub-sol')
  for (const c of grok.cases) assert.equal(c.model, 'grok-stub')
  assert.deepEqual(sol.caseIds, ['example-clean-helper', 'example-off-by-one'])
  assert.match(sol.rubricVersion, /^\d{4}-\d{2}-\d{2}/)
  assert.equal(sol.runtimeHash, createHash('sha256').update(readFileSync(SCRIPT)).digest('hex'))
  assert.match(sol.promptHash, /^[0-9a-f]{64}$/)
  assert.notEqual(sol.promptHash, grok.promptHash, 'the prompt differs by vendor (tool notes)')
  assert.equal(sol.repeat, 1)
  for (const c of sol.cases) { assert.ok(Number.isInteger(c.durationMs)); assert.match(c.caseHash, /^[0-9a-f]{64}$/) }
  // The calls: each family's model, once per case, in a throwaway repo (never the operator's).
  const code = calls().filter((c) => c.kind === 'code')
  assert.deepEqual(code.map((c) => c.model).sort(), ['gpt-stub-sol', 'gpt-stub-sol', 'grok-stub', 'grok-stub'])
  assert.equal(new Set(code.map((c) => c.cwd)).size, 4, 'a fresh repo for every review')
  for (const c of code) assert.ok(!c.cwd.startsWith(OPERATOR), c.cwd)
  // Scored runs leave no temp repo behind.
  assert.deepEqual(readdirSync(TMP).filter((d) => d.startsWith('review-eval-')), [])
})

test('3 the operator\'s log, shadow log, reviews/ and repo .git are untouched; planted shadow, security, verify and verifyCmd never fire', () => {
  examples()
  const mark = join(MARKS, 'verify')
  homeConfig({ shadow: 'opus', pickShadow: ['opus'], security: { run: 'required' }, verify: 'second-opinion', verifyCmd: `echo ran >> ${mark}` })
  writeFileSync(LOG, `${JSON.stringify({ type: 'review', id: 'old', family: 'sol' })}\n`)
  // An origin with no origin/HEAD: a base auto-detect would write refs/remotes/origin/HEAD with set-head.
  const remote = join(ROOT, 'remote.git')
  rmSync(remote, { recursive: true, force: true })
  git(ROOT, 'init', '-q', '--bare', '-b', 'main', remote)
  git(OPERATOR, 'remote', 'add', 'origin', remote)
  git(OPERATOR, 'push', '-q', 'origin', 'main')
  rmSync(join(OPERATOR, '.git/refs/remotes/origin/HEAD'), { force: true })
  const logBefore = readFileSync(LOG), gitBefore = treeHash(join(OPERATOR, '.git'))
  const r = evalRun(['--family', 'sol'], {
    REVIEW_SECURITY: 'always', REVIEW_SHADOW: 'opus', REVIEW_PICK_SHADOW: 'opus', REVIEW_VERIFY: 'second-opinion', REVIEW_VERIFY_CMD: `echo env >> ${mark}`,
    STUB_REPLIES: JSON.stringify([{ intent: 'last(items, n)', reply: findings(BUG_HIT) }, { intent: 'farewell(name)', reply: findings(finding({ file: 'src/greet.js', line: '2', quote: FAREWELL })) }]),
  })
  assert.equal(r.status, 0, r.out)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500) // a detached shadow would have started by now
  assert.deepEqual(calls().map((c) => c.kind), ['code', 'code'], 'one code call per case: no security, verdict, shadow or picker call')
  assert.equal(existsSync(mark), false, 'verifyCmd never ran')
  assert.deepEqual(find(ROOT, 'shadow-log.jsonl'), [], 'no shadow log anywhere')
  assert.deepEqual(readFileSync(LOG), logBefore, 'the review log is byte-identical')
  assert.equal(existsSync(join(OPERATOR, 'reviews')), false)
  assert.equal(treeHash(join(OPERATOR, '.git')), gitBefore, 'the operator repo .git is byte-identical (no set-head)')
  assert.equal(existsSync(join(OPERATOR, '.git/refs/remotes/origin/HEAD')), false)
  assert.equal(lines(EVAL_LOG).length, 1, 'the eval log beside it gains the run')
  for (const c of evalJson(r)[0].cases) assert.equal(c.security, 'off')
})

test('3 control: the same planted config does fire on an ordinary review (the isolation test cannot pass vacuously)', () => {
  const mark = join(MARKS, 'verify')
  homeConfig({ shadow: 'opus', security: { run: 'required' }, verify: 'second-opinion', verifyCmd: `echo ran >> ${mark}` })
  git(OPERATOR, 'checkout', '-qb', 'feat')
  mkdirSync(join(OPERATOR, 'src'))
  writeFileSync(join(OPERATOR, 'src/app.js'), 'export const one = 1\n')
  git(OPERATOR, 'add', 'src/app.js'); git(OPERATOR, 'commit', '-qm', 'app')
  const r = script([], { REVIEW_BASE: 'main', REVIEW_REVIEWER: 'sol',
    STUB_FINDINGS: JSON.stringify(findings(finding({ file: 'src/app.js', line: '1', quote: 'export const one = 1' }))) })
  assert.equal(r.status, 0, r.out)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
  assert.ok(existsSync(mark), 'verifyCmd ran')
  const kinds = calls().map((c) => c.kind)
  assert.ok(kinds.includes('security'), JSON.stringify(kinds))
  assert.ok(kinds.includes('verdicts'), JSON.stringify(kinds))
  assert.equal(lines(LOG).filter((e) => e.type === 'review').length, 1)
})

test('3 eval mode in the child: no security, verify, second opinion or shadow even when asked, and the record lands only in the eval log dir', () => {
  const mark = join(MARKS, 'verify'), box = evalRoot(), evalDir = box.logDir
  homeConfig({ shadow: 'opus', pickShadow: ['opus'], security: { run: 'required' }, verify: 'second-opinion', verifyCmd: `echo ran >> ${mark}` })
  const r = script([], { cwd: box.repo, ...evalEnv(box, { REVIEW_SECURITY: 'always',
    REVIEW_SHADOW: 'opus', REVIEW_VERIFY: 'second-opinion', REVIEW_VERIFY_CMD: `echo env >> ${mark}`,
    STUB_FINDINGS: JSON.stringify(findings(finding({ file: 'src/app.js', line: '1', quote: 'export const one = 1' }))) }) })
  assert.equal(r.status, 0, r.out)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
  assert.deepEqual(calls().map((c) => c.kind), ['code'])
  assert.equal(existsSync(mark), false)
  assert.equal(existsSync(LOG), false, 'nothing reaches the real review log')
  const [record] = lines(join(evalDir, 'review-log.jsonl'))
  assert.equal(record.type, 'review'); assert.equal(record.security.status, 'off')
  assert.equal(Object.hasOwn(record, 'secondOpinion'), false)
  assert.deepEqual(find(ROOT, 'shadow-log.jsonl'), [])
})

test('3 --gate, --close, --summary and the other log commands refuse in eval mode; the log-dir override needs the marker', () => {
  const evalDir = join(ROOT, 'eval-log-dir')
  rmSync(evalDir, { recursive: true, force: true })
  for (const args of [['--gate'], ['--close', 'x'], ['--summary'], ['--tier-json'], ['--deferred'], ['--fix-check', 'x'], ['--log-outcome', 'x', '1', '0'], ['--eval']]) {
    const r = script(args, { REVIEW_EVAL: '1', REVIEW_EVAL_LOG_DIR: evalDir, REVIEW_BASE: 'main' })
    assert.notEqual(r.status, 0, `${args[0]}: ${r.out}`)
    assert.match(r.out, /eval mode/, args[0])
  }
  // The marker without its own log dir stops before anything is written.
  let r = script([], { REVIEW_EVAL: '1', REVIEW_BASE: 'main', REVIEW_REVIEWER: 'sol' })
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /REVIEW_EVAL_LOG_DIR/)
  // The log-dir override without the marker is ignored: an ordinary review logs to the real log.
  git(OPERATOR, 'checkout', '-qb', 'feat')
  writeFileSync(join(OPERATOR, 'app.js'), 'export const one = 1\n')
  git(OPERATOR, 'add', 'app.js'); git(OPERATOR, 'commit', '-qm', 'app')
  r = script([], { REVIEW_EVAL_LOG_DIR: evalDir, REVIEW_BASE: 'main', REVIEW_REVIEWER: 'sol' })
  assert.equal(r.status, 0, r.out)
  assert.equal(lines(LOG).filter((e) => e.type === 'review').length, 1)
  assert.equal(existsSync(join(evalDir, 'review-log.jsonl')), false)
  assert.match(r.out, /Ignoring REVIEW_EVAL_LOG_DIR/)
})

test('4 malformed cases are skipped with a named error and the run continues', () => {
  examples()
  const ok = { kind: 'clean', intent: 'tidy' }
  makeCase('no-base', { id: 'no-base', ...ok }, null, { 'a.js': 'x\n' })
  makeCase('bad-json', '{ not json', { 'a.js': 'x\n' }, { 'a.js': 'y\n' })
  makeCase('no-op', { id: 'no-op', ...ok }, { 'a.js': 'x\n' }, { 'a.js': 'x\n' })
  makeCase('empty-expect', { id: 'empty-expect', kind: 'bug', intent: 'tidy', expect: [] }, { 'a.js': 'x\n' }, { 'a.js': 'y\n' })
  makeCase('clean-expect', { id: 'clean-expect', ...ok, expect: [{ file: 'a.js', lines: [1, 1], what: 'w' }] }, { 'a.js': 'x\n' }, { 'a.js': 'y\n' })
  makeCase('absent-file', { id: 'absent-file', kind: 'bug', intent: 'tidy', expect: [{ file: 'b.js', side: 'head', lines: [1, 1], what: 'w' }] }, { 'a.js': 'x\n' }, { 'a.js': 'y\n' })
  makeCase('dup-one', { id: 'dup', ...ok }, { 'a.js': 'x\n' }, { 'a.js': 'y\n' })
  makeCase('dup-two', { id: 'dup', ...ok }, { 'a.js': 'x\n' }, { 'a.js': 'z\n' })
  makeCase('bad-kind', { id: 'bad-kind', kind: 'maybe', intent: 'tidy' }, { 'a.js': 'x\n' }, { 'a.js': 'y\n' })
  writeFileSync(join(CASES, 'notes.txt'), 'not a case\n')
  const r = evalRun(['--family', 'sol'])
  assert.equal(r.status, 0, r.out)
  for (const [name, why] of [['no-base', /no base\/ folder/], ['bad-json', /case\.json/], ['no-op', /head\/ is the same as base\//],
    ['empty-expect', /expect/], ['clean-expect', /clean case.*expect/], ['absent-file', /b\.js.*not in head\//], ['dup-one', /duplicate id "dup"/],
    ['dup-two', /duplicate id "dup"/], ['bad-kind', /kind/], ['notes.txt', /not a folder/]])
    assert.match(r.out, new RegExp(`skipped ${name}: .*${why.source}`), name)
  assert.deepEqual(evalJson(r)[0].caseIds, ['example-clean-helper', 'example-off-by-one'])
  assert.equal(calls().filter((c) => c.kind === 'code').length, 2)
})

test('5 more than 10 reviews without --yes: prints families × valid cases and stops before any call; team and default pool are counted', () => {
  for (let i = 1; i <= 6; i++) makeCase(`c${i}`, { id: `c${i}`, kind: 'clean', intent: `tidy ${i}` }, { 'a.js': 'x\n' }, { 'a.js': `y${i}\n` })
  makeCase('no-op', { id: 'no-op', kind: 'clean', intent: 'tidy' }, { 'a.js': 'x\n' }, { 'a.js': 'x\n' })
  let r = evalRun(['--family', 'sol,grok'])
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /2 families \(sol, grok\) × 6 cases × 1 run = 12 reviews/)
  assert.match(r.out, /--yes/)
  assert.deepEqual(calls(), [])
  assert.equal(existsSync(EVAL_LOG), false)
  r = evalRun([])
  assert.match(r.out, /3 families \(sol, opus, grok\) × 6 cases × 1 run = 18 reviews/, 'no --family: the reviewer role')
  r = evalRun(['--family', 'claude,sol'])
  assert.match(r.out, /claude runs as the multi-agent team: 3 model calls per review/)
  assert.match(r.out, /= 12 reviews/)
  r = evalRun(['--family', 'sol', '--repeat', '2'])
  assert.match(r.out, /1 family \(sol\) × 6 cases × 2 runs = 12 reviews/)
  assert.deepEqual(calls(), [])
  rmSync(join(CASES, 'c6'), { recursive: true })
  r = evalRun(['--family', 'sol,grok', '--yes'])
  assert.equal(r.status, 0, r.out)
  assert.equal(calls().filter((c) => c.kind === 'code').length, 10)
})

test('scoring: the ±3 window edges, a b/ prefix, a range, a LOW catch, an unlocated quote, extra findings, a base-side expect and every expect required', () => {
  const long = (changed) => Object.fromEntries([['src/long.js', Array.from({ length: 40 }, (_, i) => `export const v${i + 1} = ${i + 1 === 21 ? changed : i + 1}`).join('\n') + '\n']])
  const at = (line, over = {}) => finding({ file: 'src/long.js', line: String(line), quote: `export const v${line} = ${line === 21 ? 0 : line}`, ...over })
  const bug = (id, extra = {}) => makeCase(id, { id, kind: 'bug', intent: `token-${id}`, expect: [{ file: 'src/long.js', side: 'head', lines: [20, 22], what: 'v21 is zero' }], ...extra }, long(21), long(0))
  const replies = []
  const reply = (id, ...list) => replies.push({ intent: `token-${id}`, reply: findings(...list) })
  bug('hi-in'); reply('hi-in', at(25))
  bug('hi-out'); reply('hi-out', at(26))
  bug('lo-in'); reply('lo-in', at(17))
  bug('lo-out'); reply('lo-out', at(16))
  bug('prefix'); reply('prefix', at(21, { file: 'b/src/long.js' }))
  bug('range'); reply('range', at(24, { line: '24-30' }))
  bug('low'); reply('low', at(21, { likelihood: 2, impact: 3 }))
  bug('unlocated'); reply('unlocated', at(21, { quote: 'export const nothing = here' }))
  bug('extra'); reply('extra', at(21), at(2), at(40))
  bug('both', { expect: [{ file: 'src/long.js', side: 'head', lines: [5, 5], what: 'a' }, { file: 'src/long.js', side: 'head', lines: [35, 35], what: 'b' }] })
  reply('both', at(5))
  makeCase('deleted', { id: 'deleted', kind: 'bug', intent: 'token-deleted', expect: [{ file: 'src/gone.js', side: 'base', lines: [3, 3], what: 'the guard is gone' }] },
    { 'src/gone.js': 'a\nb\nif (!x) return\nc\n', 'src/keep.js': 'k\n' }, { 'src/keep.js': 'k\n' })
  reply('deleted', finding({ file: 'src/gone.js', line: '3', quote: 'if (!x) return' }))
  const clean = (id) => makeCase(id, { id, kind: 'clean', intent: `token-${id}`, allow: [{ file: 'src/long.js', lines: [10, 10] }] }, long(21), long(0))
  clean('allowed'); reply('allowed', at(10, { likelihood: 5, impact: 5 }))
  clean('alarm'); reply('alarm', at(30, { likelihood: 5, impact: 5 }))
  clean('unscored'); reply('unscored', at(30, { likelihood: 0 }))
  const r = evalRun(['--family', 'sol', '--yes'], { STUB_REPLIES: JSON.stringify(replies) })
  assert.equal(r.status, 0, r.out)
  const cases = Object.fromEntries(evalJson(r)[0].cases.map((c) => [c.id, c]))
  const outcome = (id) => cases[id].outcome
  assert.equal(outcome('hi-in'), 'caught'); assert.equal(outcome('hi-out'), 'missed')
  assert.equal(outcome('lo-in'), 'caught'); assert.equal(outcome('lo-out'), 'missed')
  assert.equal(cases['hi-out'].extra, 1)
  assert.equal(outcome('prefix'), 'caught')
  assert.equal(outcome('range'), 'caught')
  assert.equal(outcome('low'), 'caught'); assert.equal(cases.low.severity, 'low')
  assert.equal(outcome('unlocated'), 'missed'); assert.equal(cases.unlocated.unlocated, 1); assert.equal(cases.unlocated.extra, 0)
  assert.equal(outcome('extra'), 'caught'); assert.equal(cases.extra.extra, 2)
  assert.equal(outcome('both'), 'missed'); assert.deepEqual(cases.both.expects.map((e) => e.caught), [true, false])
  assert.equal(outcome('deleted'), 'caught')
  assert.equal(outcome('allowed'), 'clean'); assert.equal(cases.allowed.allowed, 1)
  assert.equal(outcome('alarm'), 'false-alarm')
  assert.equal(outcome('unscored'), 'false-alarm', 'an unscored finding blocks as MEDIUM, so it is a false alarm')
})

test('errored: a failing child, a timeout and a family whose CLI is missing are never counted as missed', () => {
  examples()
  let r = evalRun(['--family', 'sol'], { STUB_FAIL: 'gpt-stub-sol' })
  assert.equal(r.status, 0, r.out)
  let [record] = evalJson(r)
  assert.deepEqual(record.cases.map((c) => c.outcome), ['errored', 'errored'])
  assert.match(record.cases[0].error, /quota exhausted/)
  assert.equal(record.totals.missed, 0); assert.equal(record.totals.errored, 2); assert.equal(record.totals.falseAlarms, 0)
  // The failed reviews' temp repos are kept for inspection, and the output says where.
  assert.match(r.out, /kept for inspection: /)

  const started = Date.now()
  r = evalRun(['--family', 'sol', '--timeout', '2s'], { STUB_SLEEP_MS: '30000' })
  assert.equal(r.status, 0, r.out)
  assert.ok(Date.now() - started < 25000, `timed out promptly (${Date.now() - started} ms)`)
  ;[record] = evalJson(r)
  assert.deepEqual(record.cases.map((c) => c.outcome), ['errored', 'errored'])
  assert.match(record.cases[0].error, /timed out after 2s/)
  assert.equal(record.timeoutMs, 2000)

  rmSync(CALLS, { force: true })
  r = evalRun(['--family', 'grok,sol'], { PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':') })
  assert.equal(r.status, 0, r.out)
  assert.equal(r.out.match(/grok: the grok CLI is not on PATH/g)?.length, 1, 'reported once')
  assert.match(r.out, /1 family \(sol\) × 2 cases × 1 run = 2 reviews/)
  assert.deepEqual(evalJson(r).map((x) => x.family), ['sol'])
})

test('--repeat runs each case N times and the output says n', () => {
  examples()
  const r = evalRun(['--family', 'sol', '--repeat', '2'], { STUB_REPLIES: JSON.stringify([{ intent: 'last(items, n)', reply: findings(BUG_HIT) }]) })
  assert.equal(r.status, 0, r.out)
  const [record] = evalJson(r)
  assert.equal(record.repeat, 2)
  assert.deepEqual(record.cases.map((c) => [c.id, c.run]), [['example-clean-helper', 1], ['example-clean-helper', 2], ['example-off-by-one', 1], ['example-off-by-one', 2]])
  assert.match(r.stdout, /bugs caught 2\/2/)
  assert.match(r.stdout, /n=2/)
})

test('a missing cases folder and a bad flag value stop with a named error', () => {
  let r = script(['--eval', '--cases', join(ROOT, 'nowhere'), '--family', 'sol'])
  assert.notEqual(r.status, 0); assert.match(r.out, /No cases folder/)
  r = script(['--eval', '--family', 'sol'])
  assert.notEqual(r.status, 0); assert.match(r.out, /\.agent-config-studio\/review-gate\/eval\/cases/, 'the default folder is named')
  for (const [flag, value] of [['--repeat', '0'], ['--timeout', 'soon']]) {
    r = evalRun(['--family', 'sol', flag, value])
    assert.notEqual(r.status, 0, r.out); assert.match(r.out, new RegExp(flag))
  }
})

test('the examples ship: listed in pack.json, valid cases, and both skill twins say how to run --eval', () => {
  const pack = JSON.parse(readFileSync(join(PACK, 'pack.json'), 'utf8'))
  const listed = pack.parts.flatMap((p) => p.files)
  for (const file of readdirSync(EXAMPLES, { recursive: true }).filter((p) => statSync(join(EXAMPLES, p)).isFile()))
    assert.ok(listed.includes(`packs/review-gate/runtime/eval/examples/${file}`), file)
  for (const harness of ['claude', 'codex']) {
    const body = readFileSync(join(PACK, 'skills', harness, 'code-review', 'SKILL.md'), 'utf8')
    assert.match(body, /--eval/, harness)
    assert.match(body, /eval-log\.jsonl/, harness)
  }
})

const pushInput = (repo) => { const head = git(repo, 'rev-parse', 'HEAD'); return `refs/heads/eval-case ${head} refs/heads/eval-case ${'0'.repeat(40)}\n` }
function gateRun(repo) {
  const r = spawnSync(process.execPath, [SCRIPT, '--gate'], { cwd: repo, env: env(), encoding: 'utf8', input: pushInput(repo), timeout: 60000 })
  return { ...r, out: `${r.stdout || ''}\n${r.stderr || ''}` }
}

test('fix 1 eval mode never yields a gate-eligible review: the real log dir is refused, records are tagged, and a tagged record never counts once the marker is unset', () => {
  // The exact trigger: the marker with REVIEW_EVAL_LOG_DIR at the real log folder, from the operator's repo.
  git(OPERATOR, 'checkout', '-qb', 'feat')
  writeFileSync(join(OPERATOR, 'app.js'), 'export const one = 1\n')
  git(OPERATOR, 'add', 'app.js'); git(OPERATOR, 'commit', '-qm', 'app')
  for (const dir of [LOG_DIR, join(LOG_DIR, 'sub'), join(HOME, '.claude/review-log'), join(HOME, '.claude')]) {
    const r = script([], { REVIEW_EVAL: '1', REVIEW_EVAL_LOG_DIR: dir, REVIEW_BASE: 'main', REVIEW_REVIEWER: 'sol' })
    assert.notEqual(r.status, 0, `${dir}: ${r.out}`)
    assert.match(r.out, /real review-log folder/, dir)
  }
  assert.equal(existsSync(LOG), false, 'nothing was written to the real log')
  // A log dir inside an eval root, but run from the operator repo (outside the root): refused, and no reviews/ there.
  const box = evalRoot()
  let r = script([], evalEnv(box))
  assert.notEqual(r.status, 0, r.out); assert.match(r.out, /eval run's temp folder/)
  assert.equal(existsSync(join(OPERATOR, 'reviews')), false)
  // A root that is not a review-eval- folder in the temp folder: refused.
  r = script([], { cwd: box.repo, ...evalEnv({ root: ROOT, logDir: box.logDir }) })
  assert.notEqual(r.status, 0, r.out); assert.match(r.out, /REVIEW_EVAL_ROOT/)
  // A real eval-mode review inside its root: tagged eval, and its report and exclude stay in the temp repo.
  r = script([], { cwd: box.repo, ...evalEnv(box) })
  assert.equal(r.status, 0, r.out)
  const [record] = lines(join(box.logDir, 'review-log.jsonl'))
  assert.equal(record.eval, true)
  assert.ok(existsSync(join(box.repo, 'reviews')))
  // The record reaches the real log anyway (copied there); with the marker unset nothing counts it.
  writeFileSync(LOG, `${JSON.stringify(record)}\n`)
  writeFileSync(join(ROOT, 'statuses.json'), '{}')
  r = script(['--close', record.id, '--status', join(ROOT, 'statuses.json'), '--test-cmd', 'true'], { cwd: box.repo, REVIEW_BASE: 'main' })
  assert.notEqual(r.status, 0, r.out); assert.match(r.out, /No logged review matches/)
  r = script(['--show-config'], { cwd: box.repo, REVIEW_BASE: 'main' })
  assert.equal(JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))).reviewCounts.sol, 0, 'rotation never counts it')
  r = script(['--tier-json'], { cwd: box.repo, REVIEW_BASE: 'main' })
  assert.equal(JSON.parse(r.stdout).covered, false)
  assert.notEqual(gateRun(box.repo).status, 0)
  // Control: the same record untagged is closable and passes the gate; tagged again, the gate refuses it despite the close.
  const { eval: _tag, ...untagged } = record
  writeFileSync(LOG, `${JSON.stringify(untagged)}\n`)
  r = script(['--close', record.id, '--status', join(ROOT, 'statuses.json'), '--test-cmd', 'true'], { cwd: box.repo, REVIEW_BASE: 'main' })
  assert.equal(r.status, 0, r.out)
  let g = gateRun(box.repo)
  assert.equal(g.status, 0, g.out)
  const logged = lines(LOG)
  writeFileSync(LOG, logged.map((e, i) => JSON.stringify(i === 0 ? { ...e, eval: true } : e)).join('\n') + '\n')
  g = gateRun(box.repo)
  assert.notEqual(g.status, 0, g.out)
  r = script(['--summary'], { cwd: box.repo, REVIEW_BASE: 'main' })
  assert.doesNotMatch(r.out, new RegExp(record.id))
})

test('fix 2 --eval with any other command flag is refused before anything runs', () => {
  examples()
  for (const extra of [['--gate'], ['--close', 'x'], ['--summary'], ['--fix-check', 'x'], ['--tier-json'], ['--deferred'], ['--show-config'], ['--log-outcome', 'x', '1', '0'], ['--slices', 'a']]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...extra, '--eval', '--cases', CASES, '--family', 'sol'], { cwd: OPERATOR, env: env(), encoding: 'utf8', input: '', timeout: 60000 })
    assert.notEqual(r.status, 0, `${extra[0]}: ${r.stdout}${r.stderr}`)
    assert.match(`${r.stdout}${r.stderr}`, /--eval runs alone/, extra[0])
  }
  assert.deepEqual(calls(), [])
  assert.equal(existsSync(EVAL_LOG), false)
})

test('fix 3 an inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE never reaches the case repos: the operator checkout stays byte-identical', () => {
  examples()
  const before = treeHash(OPERATOR)
  const r = evalRun(['--family', 'sol'], { GIT_DIR: join(OPERATOR, '.git'), GIT_WORK_TREE: OPERATOR, GIT_INDEX_FILE: join(OPERATOR, '.git/index'),
    STUB_REPLIES: JSON.stringify([{ intent: 'last(items, n)', reply: findings(BUG_HIT) }]) })
  assert.equal(r.status, 0, r.out)
  assert.equal(treeHash(OPERATOR), before)
  assert.deepEqual(evalJson(r)[0].cases.map((c) => c.outcome), ['clean', 'caught'])
  // The child refuses those variables itself.
  const box = evalRoot()
  const child = script([], { cwd: box.repo, ...evalEnv(box), GIT_DIR: join(box.repo, '.git') })
  assert.notEqual(child.status, 0, child.out); assert.match(child.out, /GIT_DIR/)
})

test('fix 4 a base-side expect is caught by a quote of the removed code in a file that survives', () => {
  const base = { 'src/guard.js': 'export function value(x) {\n  if (!x) return null\n  return x.value\n}\n' }
  const head = { 'src/guard.js': 'export function value(x) {\n  return x.value\n}\n' }
  makeCase('removed-guard', { id: 'removed-guard', kind: 'bug', intent: 'token-guard', expect: [{ file: 'src/guard.js', side: 'base', lines: [2, 2], what: 'the null guard is gone' }] }, base, head)
  makeCase('removed-far', { id: 'removed-far', kind: 'bug', intent: 'token-far', expect: [{ file: 'src/guard.js', side: 'base', lines: [2, 2], what: 'the null guard is gone' }] },
    { 'src/guard.js': base['src/guard.js'] + Array.from({ length: 20 }, (_, i) => `export const pad${i} = ${i}\n`).join('') }, head)
  const r = evalRun(['--family', 'sol'], { STUB_REPLIES: JSON.stringify([
    { intent: 'token-guard', reply: findings(finding({ file: 'src/guard.js', line: '2', quote: 'if (!x) return null' })) },
    { intent: 'token-far', reply: findings(finding({ file: 'src/guard.js', line: '20', quote: 'export const pad14 = 14' })) },
  ]) })
  assert.equal(r.status, 0, r.out)
  const cases = Object.fromEntries(evalJson(r)[0].cases.map((c) => [c.id, c]))
  assert.equal(cases['removed-guard'].outcome, 'caught', JSON.stringify(cases['removed-guard']))
  assert.equal(cases['removed-guard'].unlocated, 0, 'the finding that caught it is not counted as unlocated')
  assert.equal(cases['removed-far'].outcome, 'missed', 'a quote far from the expected lines does not catch it')
})

test('fix 5 provenance: a Claude team records each lens\'s resolved model and the model the CLI reports; normal records do not change', () => {
  makeCase('one', { id: 'one', kind: 'clean', intent: 'tidy' }, { 'a.js': 'x\n' }, { 'a.js': 'y\n' })
  const r = evalRun(['--family', 'claude'])
  assert.equal(r.status, 0, r.out)
  const [c] = evalJson(r)[0].cases
  assert.deepEqual(c.lenses.map((l) => [l.key, l.model, l.modelUsed]), [['correctness', 'claude-stub-opus', 'claude-stub-opus'],
    ['regressions', 'claude-stub-opus', 'claude-stub-opus'], ['inputs-and-edges', 'claude-stub-opus', 'claude-stub-opus']])
  // A normal claude review record: no lenses and no claude modelUsed.
  git(OPERATOR, 'checkout', '-qb', 'feat')
  writeFileSync(join(OPERATOR, 'app.js'), 'export const one = 1\n')
  git(OPERATOR, 'add', 'app.js'); git(OPERATOR, 'commit', '-qm', 'app')
  for (const extra of [{}, { REVIEW_CLAUDE_MODEL: 'opus' }]) {
    const n = script([], { REVIEW_BASE: 'main', REVIEW_REVIEWER: 'claude', ...extra })
    assert.equal(n.status, 0, n.out)
    const record = lines(LOG).at(-1)
    assert.equal(Object.hasOwn(record, 'lenses'), false)
    assert.equal(Object.hasOwn(record, 'modelUsed'), false)
    assert.equal(Object.hasOwn(record, 'eval'), false)
  }
})

test('fix 6 the cost note follows the config the child sees: not the operator env or repo config, but the home config', () => {
  makeCase('one', { id: 'one', kind: 'clean', intent: 'tidy' }, { 'a.js': 'x\n' }, { 'a.js': 'y\n' })
  mkdirSync(join(OPERATOR, '.claude'))
  writeFileSync(join(OPERATOR, '.claude/review-config.json'), JSON.stringify({ claudeModel: 'opus' }))
  let r = evalRun(['--family', 'claude'], { REVIEW_CLAUDE_MODEL: 'opus' })
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /claude runs as the multi-agent team: 3 model calls per review/)
  assert.match(r.out, /= 1 review \(3 model calls\)/)
  assert.equal(calls().filter((c) => c.kind === 'code').length, 3, 'the child ran the team')
  rmSync(CALLS, { force: true })
  homeConfig({ claudeModel: 'opus' })
  r = evalRun(['--family', 'claude'])
  assert.equal(r.status, 0, r.out)
  assert.doesNotMatch(r.out, /multi-agent team/)
  assert.match(r.out, /= 1 review ·/)
  assert.equal(calls().filter((c) => c.kind === 'code').length, 1, 'the child ran one agent')
})

test('fix 7 a family whose CLI is missing is reported exactly once, named or from the role', () => {
  examples()
  const path = [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':')
  for (const args of [['--family', 'grok,sol'], []]) {
    const r = evalRun(args, { PATH: path })
    assert.equal(r.status, 0, r.out)
    assert.equal(r.out.split('\n').filter((l) => /grok/.test(l) && /not on PATH/.test(l)).length, 1, `${args.join(' ')}:\n${r.out}`)
  }
})

test('slice f1 a finding that quotes the FINDINGS_JSON delimiter (echoed by the CLI) still scores: the result comes from the eval log record', () => {
  makeCase('delim', { id: 'delim', kind: 'bug', intent: 'token-delim', expect: [{ file: 'src/out.js', side: 'head', lines: [1, 1], what: 'prints the delimiter' }] },
    { 'src/out.js': 'export const marker = null\n' }, { 'src/out.js': "export const marker = '===FINDINGS_JSON==='\n" })
  const r = evalRun(['--family', 'sol'], { STUB_ECHO: '1',
    STUB_REPLIES: JSON.stringify([{ intent: 'token-delim', reply: findings(finding({ file: 'src/out.js', line: '1', quote: "export const marker = '===FINDINGS_JSON==='" })) }]) })
  assert.equal(r.status, 0, r.out)
  const [c] = evalJson(r)[0].cases
  assert.equal(c.outcome, 'caught', JSON.stringify(c))
})

test('x1 a base-side catch needs the finding\'s cited line near the expected lines: the same guard quoted far away does not catch', () => {
  const pad = Array.from({ length: 84 }, (_, i) => `export const pad${i} = ${i}`)
  const base = ['export function value(x) {', '  if (!x) return null', '  return x.value', '}', ...pad, '  if (!x) return null', ''].join('\n')
  const head = ['export function value(x) {', '  return x.value', '}', ...pad, '  if (!x) return null', ''].join('\n')
  assert.equal(base.split('\n')[88], '  if (!x) return null', 'the second copy sits at base line 89')
  const expect = [{ file: 'src/guard.js', side: 'base', lines: [2, 2], what: 'the null guard is gone' }]
  makeCase('far-copy', { id: 'far-copy', kind: 'bug', intent: 'token-far-copy', expect }, { 'src/guard.js': base }, { 'src/guard.js': head })
  makeCase('near', { id: 'near', kind: 'bug', intent: 'token-near', expect }, { 'src/guard.js': base }, { 'src/guard.js': head })
  const r = evalRun(['--family', 'sol'], { STUB_REPLIES: JSON.stringify([
    { intent: 'token-far-copy', reply: findings(finding({ file: 'src/guard.js', line: '89', quote: 'if (!x) return null' })) },
    { intent: 'token-near', reply: findings(finding({ file: 'src/guard.js', line: '2', quote: 'if (!x) return null' })) },
  ]) })
  assert.equal(r.status, 0, r.out)
  const cases = Object.fromEntries(evalJson(r)[0].cases.map((c) => [c.id, c]))
  assert.equal(cases['far-copy'].outcome, 'missed', JSON.stringify(cases['far-copy']))
  assert.equal(cases['far-copy'].extra + cases['far-copy'].unlocated, 1, 'the distant finding stays extra or unlocated')
  assert.equal(cases.near.outcome, 'caught', JSON.stringify(cases.near))
})

test('x2 a finding cited by absolute path inside the case repo keeps its own folders (src/repo/guard.js)', () => {
  makeCase('abs', { id: 'abs', kind: 'bug', intent: 'token-abs', expect: [{ file: 'src/repo/guard.js', side: 'base', lines: [2, 2], what: 'the null guard is gone' }] },
    { 'src/repo/guard.js': 'export function value(x) {\n  if (!x) return null\n  return x.value\n}\n' },
    { 'src/repo/guard.js': 'export function value(x) {\n  return x.value\n}\n' })
  const r = evalRun(['--family', 'sol'], { STUB_REPLIES: JSON.stringify([
    { intent: 'token-abs', reply: findings(finding({ file: '@CWD@/src/repo/guard.js', line: '2', quote: 'if (!x) return null' })) },
  ]) })
  assert.equal(r.status, 0, r.out)
  const [c] = evalJson(r)[0].cases
  assert.equal(c.outcome, 'caught', JSON.stringify(c))
})
