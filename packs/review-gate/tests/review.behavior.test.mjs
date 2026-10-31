#!/usr/bin/env node
/**
 * review.behavior.test.mjs — the packaged runtime's behavior on a stranger's machine: the reviewer pool
 * filtered to installed CLIs with loud stops, one-family disputes, the config and log paths, neutral
 * wording, the push-gate opt-in, the guard's reviewgate.* refusal, pinned node, Codex homes, and the
 * project scan roots.
 *
 * Every run uses a temp HOME, GIT_CONFIG_GLOBAL and a PATH built here (stub CLIs, a `node` link, /usr/bin,
 * /bin) — never node's own folder, which may hold real CLIs. The no-node runs get NO_NODE, a folder holding only
 * the commands they need, since /usr/bin often holds a node. No real model is called.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const RUNTIME = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime')
const SCRIPT = join(RUNTIME, 'review.mjs')
const ROOT = mkdtempSync(join(tmpdir(), 'review-behavior-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), REMOTE = join(ROOT, 'remote.git'), ARGV = join(ROOT, 'argv')
const STUBS = join(ROOT, 'stubs'), NODE_BIN = join(ROOT, 'node-bin'), GITCONFIG = join(ROOT, 'gitconfig')
const GATE = join(HOME, '.agent-config-studio/review-gate')
const LOG = join(HOME, '.agent-config-studio/review-log/review-log.jsonl')
const SYSTEM = ['/usr/bin', '/bin']
const J = JSON.stringify
after(() => rmSync(ROOT, { recursive: true, force: true }))

const put = (path, text, mode) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  if (mode) chmodSync(path, mode)
}
mkdirSync(NODE_BIN, { recursive: true })
symlinkSync(process.execPath, join(NODE_BIN, 'node'))
// The PATH for "node is missing": only what the hooks, the guard fallback and git push run, linked from the
// system folders, and no node (/usr/bin often has one). The first test checks it.
const NO_NODE = join(ROOT, 'no-node-bin')
const NO_NODE_TOOLS = ['sh', 'git', 'cat', 'grep']
mkdirSync(NO_NODE)
for (const name of NO_NODE_TOOLS) {
  const found = SYSTEM.map((dir) => join(dir, name)).find((path) => existsSync(path))
  if (found) symlinkSync(found, join(NO_NODE, name))
}

// A located, scored, blocking finding (risk 25, MEDIUM).
const FINDING = { issue: 'off-by-one in loop', file: 'a.js', line: '2', quote: 'for (let i = 0; i <= n; i++) {}', suggestion: 'use <', likelihood: 5, impact: 5, protected: false, trigger: 'calling f(3)' }
const model = (name) => `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const a = process.argv.slice(2)
fs.writeFileSync(path.join(${J(ARGV)}, '${name}-' + process.pid + '.json'), JSON.stringify(a))
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema') + 1], 'utf8') : a[a.indexOf('--json-schema') + 1]
const reply = String(schema).includes('verdicts') ? (process.env.STUB_VERDICTS || '{"verdicts":[]}') : ${J(J({ findings: [FINDING] }))}
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o') + 1], reply)
else if (${J(name)} === 'grok') console.log(JSON.stringify({ structuredOutput: JSON.parse(reply), modelUsage: { 'grok-stub-build': {} } }))
else console.log(JSON.stringify({ type: 'result', is_error: false, result: reply, structured_output: JSON.parse(reply) }))
`
for (const name of ['claude', 'codex', 'grok']) put(join(STUBS, name), model(name), 0o755)
// model-id: the reviewer role from STUB_ROLE ({use, ids}); a family resolves to its role id, anything else echoes.
put(join(STUBS, 'model-id'), `#!${process.execPath}
const a = process.argv.slice(2)
const role = JSON.parse(process.env.STUB_ROLE || ${J(J({ use: ['opus', 'sol', 'grok'], ids: ['claude-opus-stub', 'gpt-sol-stub', 'grok-stub'] }))})
const ids = Object.fromEntries(role.use.map((f, i) => [f, role.ids[i]]))
if (a[0] === '--role') {
  if (process.env.STUB_ROLE_FAIL) { console.error('unknown role "' + a[1] + '" (known: builder)'); process.exit(2) }
  console.log(JSON.stringify({ role: a[1], use: role.use, ids: role.ids }))
} else if (a[0] === '--flavor') console.log(JSON.stringify({ family: a[1], flavor: { effort: 'high', likes: [], quirks: [] } }))
else console.log(ids[a[0]] || a[0])
`, 0o755)
// An optional local classifier under a neutral name: it always picks grok.
put(join(STUBS, 'pick-helper'), `#!${process.execPath}
const fs = require('node:fs')
fs.writeFileSync(require('node:path').join(${J(ARGV)}, 'pick-helper-' + process.pid + '.json'), fs.readFileSync(0, 'utf8'))
console.log(JSON.stringify({ answers: { reviewer: { type: 'choice', choice: 'grok', confidence: 0.9, probabilities: { grok: 0.9, opus: 0.1 } } } }))
`, 0o755)

/** A PATH holding only the named stubs, a node link and the system folders. */
function machine(names) {
  const bin = join(ROOT, `bin-${names.join('-') || 'none'}`)
  if (!existsSync(bin)) {
    mkdirSync(bin)
    for (const name of names) symlinkSync(join(STUBS, name), join(bin, name))
  }
  return [bin, NODE_BIN, ...SYSTEM].join(':')
}
const ALL = machine(['model-id', 'claude', 'codex', 'grok', 'pick-helper'])
const env = (extra = {}) => ({ HOME, PATH: ALL, TMPDIR: ROOT, REVIEW_BASE: 'main', GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: '1', ...extra })
function run(args, extra = {}, { cwd = REPO } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: env(extra), encoding: 'utf8', timeout: 30_000 })
  return { ...r, out: `${r.stdout}\n${r.stderr}` }
}
function sh(command, args, options = {}) {
  const r = spawnSync(command, args, { cwd: REPO, encoding: 'utf8', timeout: 30_000, ...options, env: options.env ?? env() })
  return { ...r, out: `${r.stdout || ''}\n${r.stderr || ''}` }
}
const git = (...args) => {
  const r = sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  assert.equal(r.status, 0, r.out)
  return r.stdout.trim()
}
const calls = (name) => readdirSync(ARGV).filter((f) => f.startsWith(`${name}-`)).map((f) => JSON.parse(readFileSync(join(ARGV, f), 'utf8')))
const noModelRan = () => { for (const name of ['claude', 'codex', 'grok']) assert.equal(calls(name).length, 0, `${name} must not run`) }
const logLines = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [])
const role = (use, ids) => ({ STUB_ROLE: J({ use, ids }) })
const stopped = (r, ...patterns) => {
  assert.notEqual(r.status, 0, r.out)
  for (const pattern of patterns) assert.match(r.stderr, pattern)
}

beforeEach(() => {
  for (const path of [HOME, REPO, REMOTE, ARGV, GITCONFIG]) rmSync(path, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true }); mkdirSync(ARGV); mkdirSync(REPO)
  writeFileSync(GITCONFIG, '')
  git('init', '-q', '-b', 'main')
  writeFileSync(join(REPO, 'a.js'), 'export const f = (n) => n\n')
  git('add', '.'); git('commit', '-qm', 'base')
  git('checkout', '-qb', 'feat')
  writeFileSync(join(REPO, 'a.js'), 'export const f = (n) => {\n  for (let i = 0; i <= n; i++) {}\n  return n\n}\n')
  git('add', '.'); git('commit', '-qm', 'change')
})

// ── 1. The reviewer pool ─────────────────────────────────────────────────────
test('fixture: the no-node PATH holds only sh, git, cat and grep, and finds no node', () => {
  assert.deepEqual(readdirSync(NO_NODE).sort(), [...NO_NODE_TOOLS].sort(), `each of ${NO_NODE_TOOLS.join(', ')} is in ${SYSTEM.join(' or ')}`)
  const probe = spawnSync('/bin/sh', ['-c', 'command -v node'], { env: { PATH: NO_NODE }, encoding: 'utf8' })
  assert.notEqual(probe.status, 0, `node was found on the no-node PATH: ${probe.stdout}`)
})

test('B1 a Claude-only machine reviews on a Claude-family reviewer, names the skipped families in one line, and never runs codex or grok', () => {
  const r = run(['fix the loop'], { PATH: machine(['model-id', 'claude']) })
  assert.equal(r.status, 0, r.out)
  const skips = r.stderr.split('\n').filter((line) => /skipped/.test(line))
  assert.deepEqual(skips, ['ℹ reviewer role: skipped sol (codex CLI not on PATH), grok (grok CLI not on PATH)'])
  assert.match(r.stdout, /▶ reviewer · opus \(claude · claude-opus-stub · high\)/)
  assert.equal(calls('claude').length, 1)
  assert.equal(calls('codex').length + calls('grok').length, 0)
  assert.deepEqual([logLines()[0].family, logLines()[0].vendor], ['opus', 'claude'])
})

test('B1 the CLI follows the model id prefix, whatever the family is called', () => {
  const r = run(['--show-config'], role(['zeta', 'omega', 'kappa'], ['gpt-zeta-1', 'claude-omega-2', 'grok-kappa-3']))
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(JSON.parse(r.stdout).pool.map((m) => [m.family, m.vendor, m.model]),
    [['zeta', 'codex', 'gpt-zeta-1'], ['omega', 'claude', 'claude-omega-2'], ['kappa', 'grok', 'grok-kappa-3']])
})

test('B1 a family whose id has an unknown prefix is skipped with a one-line message', () => {
  const r = run(['--show-config'], role(['mystery', 'zeta'], ['acme-1', 'gpt-zeta-1']))
  assert.equal(r.status, 0, r.out)
  const lines = r.stderr.split('\n').filter((line) => /mystery/.test(line))
  assert.deepEqual(lines, ['⚠ reviewer role family "mystery" has id "acme-1", whose prefix names no known CLI (claude-, gpt-, grok-) — skipped'])
  assert.deepEqual(JSON.parse(r.stdout).pool.map((m) => m.family), ['zeta'])
})

test('B1 loud stops: no model-id, no reviewer role, no installed reviewer CLI, a named reviewer without its CLI — each names the fix and runs no model', () => {
  const cases = [
    ['no model-id', {}, machine(['claude', 'codex', 'grok']), [/could not resolve the reviewer role: model-id is not installed/, /run: acs install-model-id/]],
    ['no reviewer role', { STUB_ROLE_FAIL: '1' }, ALL, [/could not resolve the reviewer role \(unknown role "reviewer"/, /Fix: set the reviewer role in ACS → Models → Roles/]],
    ['every reviewer CLI missing', role(['sol', 'grok'], ['gpt-sol-stub', 'grok-stub']), machine(['model-id', 'claude']),
      [/No reviewer can run: none of the reviewer role's families \(sol, grok\) has its CLI on PATH/, /set the reviewer role to families\n\s+whose CLI you have in ACS → Models → Roles/]],
    ['named grok without its CLI', { REVIEW_REVIEWER: 'grok' }, machine(['model-id', 'claude', 'codex']), [/REVIEW_REVIEWER=grok needs the grok CLI, which is not on PATH/, /Fix: install it, or name another reviewer/]],
    ['named family without its CLI', { REVIEW_REVIEWER: 'sol' }, machine(['model-id', 'claude', 'grok']), [/REVIEW_REVIEWER=sol needs the codex CLI/]],
    ['named codex without its CLI', { REVIEW_REVIEWER: 'codex' }, machine(['model-id', 'claude', 'grok']), [/REVIEW_REVIEWER=codex needs the codex CLI/]],
    ['the claude team without its CLI', { REVIEW_REVIEWER: 'claude' }, machine(['model-id', 'codex', 'grok']), [/REVIEW_REVIEWER=claude needs the claude CLI/]],
  ]
  for (const [name, extra, PATH, patterns] of cases) {
    for (const args of [[], ['--show-config']]) {
      const r = run(args, { ...extra, PATH })
      assert.notEqual(r.status, 0, `${name} ${args}: ${r.out}`)
      for (const pattern of patterns) assert.match(r.stderr, pattern, `${name} ${args}`)
    }
  }
  noModelRan()
  assert.equal(logLines().length, 0)
})

test('B1 no built-in fallback: a named codex reviewer with no codex family in the role stops instead of picking one', () => {
  const r = run([], { ...role(['opus'], ['claude-opus-stub']), REVIEW_REVIEWER: 'codex' })
  stopped(r, /REVIEW_REVIEWER=codex needs a codex family in the reviewer role, and it has none/, /ACS → Models → Roles, or pin one with REVIEW_MODEL/)
  noModelRan()
})

test('B1 the Claude team takes its lenses from the role\'s Claude families, reusing the first; with none it stops and names the fix', () => {
  const r = run([], { ...role(['sol', 'opus'], ['gpt-sol-stub', 'claude-opus-stub']), REVIEW_REVIEWER: 'claude' })
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(calls('claude').map((a) => a[a.indexOf('--model') + 1]), ['claude-opus-stub', 'claude-opus-stub', 'claude-opus-stub'])
  assert.equal(JSON.parse(r.stdout.split('===FINDINGS_JSON===')[1]).reviewer, 'claude-team(opus+opus+opus)')
  const none = run([], { ...role(['sol'], ['gpt-sol-stub']), REVIEW_REVIEWER: 'claude' })
  stopped(none, /Claude multi-agent team has no Claude family to run on/, /add a Claude family to the reviewer role in ACS → Models → Roles/)
})

test('B1 raw model ids a user passes still pass through', () => {
  const r = run([], { REVIEW_REVIEWER: 'claude', REVIEW_CLAUDE_MODEL: 'claude-custom-9' })
  assert.equal(r.status, 0, r.out)
  const [argv] = calls('claude')
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-custom-9')
  const pinned = run(['--show-config'], { REVIEW_MODEL: 'gpt-custom-1' })
  assert.deepEqual([JSON.parse(pinned.stdout).selected.model, JSON.parse(pinned.stdout).selected.vendor], ['gpt-custom-1', 'codex'])
})

test('B1 a pick naming a role family whose CLI is missing stops with the fix; it never reviews on another family', () => {
  const claudeOnly = machine(['model-id', 'claude'])
  const config = join(ROOT, 'pick-config.json')
  writeFileSync(config, J({ pick: 'sol' }))
  for (const [extra, named] of [[{ REVIEW_PICK: 'sol' }, /REVIEW_PICK=sol needs the codex CLI, which is not on PATH/], [{ REVIEW_CONFIG: config }, /config "pick"=sol needs the codex CLI, which is not on PATH/]]) {
    for (const args of [[], ['--show-config']]) stopped(run(args, { ...extra, PATH: claudeOnly }), named, /Fix: install it, or name another reviewer/)
  }
  const mystery = { ...role(['mystery', 'opus'], ['acme-1', 'claude-opus-stub']), REVIEW_PICK: 'mystery', PATH: claudeOnly }
  stopped(run([], mystery), /REVIEW_PICK=mystery names a reviewer role family whose id "acme-1" has no known CLI prefix/, /Fix: check `model-id mystery`/)
  noModelRan()
  assert.equal(logLines().length, 0)
  const usable = run(['--show-config'], { REVIEW_PICK: 'opus', PATH: claudeOnly })
  assert.equal(usable.status, 0, usable.out)
  assert.equal(JSON.parse(usable.stdout).selected.family, 'opus', 'a pick whose CLI is installed still wins')
})

// ── 2. One family ────────────────────────────────────────────────────────────
test('B2 with one family in the role a dispute cannot get a verdict, and the dispute and close name the operator waiver as the path', () => {
  const one = role(['sol'], ['gpt-sol-stub'])
  const review = run([], one)
  assert.equal(review.status, 0, review.out)
  const id = logLines()[0].id
  const before = calls('codex').length
  const dispute = run(['--dispute', id, 'f1', '--reason', 'intended', '--evidence', 'a.js:2'], one)
  assert.equal(dispute.status, 0, dispute.out)
  assert.match(dispute.stdout, new RegExp(`NO-VERDICT: No second reviewer family can give a verdict, so the finding stands\\. The operator waiver is the path: --waive ${id} f1`))
  assert.equal(calls('codex').length, before, 'no model runs for a verdict nobody can give')
  assert.equal(logLines().at(-1).verdict, 'NO-VERDICT')
  const status = join(ROOT, 'status.json')
  writeFileSync(status, J({ f1: { status: 'rejected', reason: 'intended', evidence: 'a.js:2' } }))
  const close = run(['--close', id, '--status', status, '--test-cmd', 'true'], one)
  assert.notEqual(close.status, 0, close.out)
  assert.match(close.stderr, new RegExp(`Rejected f1 requires a REFUTED verdict or an operator waiver; when no second reviewer family can give a verdict, the operator waiver is the path: --waive ${id} f1`))
})

test('B2 a team whose lenses are all one family cannot refute its own finding: no self-verdict at review, dispute or close', () => {
  const claudeOnly = { PATH: machine(['model-id', 'claude']), REVIEW_REVIEWER: 'claude', REVIEW_VERIFY: 'second-opinion',
    STUB_VERDICTS: J({ verdicts: [{ index: 0, verdict: 'REFUTED', evidence: 'a.js:2 is intended' }] }) }
  const review = run([], claudeOnly)
  assert.equal(review.status, 0, review.out)
  const logged = logLines()[0]
  assert.deepEqual([logged.family, logged.model, logged.families], ['claude-team', 'opus+opus+opus', ['opus']], 'the record names the lens families')
  assert.equal(calls('claude').length, 3, 'three lenses; the family that reviewed gives no second opinion')
  assert.match(review.stderr, /verify=second-opinion: no family in the reviewer pool besides the reviewing opus — skipped/)
  assert.deepEqual([logged.findings, logged.disputed], [1, 0], 'the finding was not refuted by its own family')
  const id = logged.id
  const dispute = run(['--dispute', id, 'f1', '--reason', 'intended', '--evidence', 'a.js:2'], claudeOnly)
  assert.equal(dispute.status, 0, dispute.out)
  assert.match(dispute.stdout, new RegExp(`NO-VERDICT: No second reviewer family can give a verdict, so the finding stands\\. The operator waiver is the path: --waive ${id} f1 .*A family that reviewed this \\(opus\\) cannot judge its own finding`))
  assert.equal(calls('claude').length, 3, 'the reviewing family is never asked to judge its own finding')
  assert.deepEqual([logLines().at(-1).verdict, logLines().at(-1).verifier], ['NO-VERDICT', null])
  // That family's REFUTED, as a runtime without this rule logged it, still cannot close the finding.
  appendFileSync(LOG, J({ type: 'dispute', ts: new Date().toISOString(), review: id, finding: 'f1', head: logged.head, verdict: 'REFUTED',
    reason: 'intended', evidence: 'a.js:2', verdictEvidence: 'a.js:2 is intended', family: 'claude-team', verifier: 'opus' }) + '\n')
  const status = join(ROOT, 'status.json')
  writeFileSync(status, J({ f1: { status: 'rejected', reason: 'intended', evidence: 'a.js:2' } }))
  const refusal = [new RegExp(`Rejected f1 requires a REFUTED verdict or an operator waiver; when no second reviewer family can give a verdict, the operator waiver is the path: --waive ${id} f1`),
    /The REFUTED from opus does not count: a family that reviewed this cannot refute its own finding/]
  stopped(run(['--close', id, '--status', status, '--test-cmd', 'true'], claudeOnly), ...refusal)
  // A team record logged before `families` existed is read from its model (opus+opus+opus): still refused.
  writeFileSync(LOG, readFileSync(LOG, 'utf8').trim().split('\n').map((line) => {
    const e = JSON.parse(line)
    if (e.type === 'review') delete e.families
    return J(e)
  }).join('\n') + '\n')
  stopped(run(['--close', id, '--status', status, '--test-cmd', 'true'], claudeOnly), ...refusal)
  assert.equal(logLines().filter((e) => e.type === 'close').length, 0, 'no close was logged')
})

test('B2 every lens family of a team is barred from verifying it; a family outside the team verifies', () => {
  const four = { ...role(['lead', 'second', 'third', 'outside'], ['claude-lead-stub', 'claude-second-stub', 'claude-third-stub', 'claude-outside-stub']),
    PATH: machine(['model-id', 'claude']), REVIEW_REVIEWER: 'claude', STUB_VERDICTS: J({ verdicts: [{ index: 0, verdict: 'CONFIRMED', evidence: 'a.js:2' }] }) }
  const plain = run([], four)
  assert.equal(plain.status, 0, plain.out)
  assert.deepEqual(logLines()[0].families, ['lead', 'second', 'third'])
  const dispute = run(['--dispute', logLines()[0].id, 'f1', '--reason', 'intended', '--evidence', 'a.js:2'], four)
  assert.equal(dispute.status, 0, dispute.out)
  assert.deepEqual([logLines().at(-1).verdict, logLines().at(-1).verifier], ['CONFIRMED', 'outside'])
  const verified = run([], { ...four, REVIEW_VERIFY: 'second-opinion' })
  assert.equal(verified.status, 0, verified.out)
  assert.match(verified.stdout, /▶ second opinion · outside \(claude · claude-outside-stub · high\)/)
  assert.deepEqual(logLines().at(-1).secondOpinion, { family: 'outside', model: 'claude-outside-stub' })
})

test('B2 a dispute with a broken reviewer role stops with the fix instead of logging a verdict', () => {
  assert.equal(run([]).status, 0)
  const id = logLines()[0].id, before = logLines().length
  const r = run(['--dispute', id, 'f1', '--reason', 'intended', '--evidence', 'a.js:2'], { STUB_ROLE_FAIL: '1' })
  stopped(r, /could not resolve the reviewer role/, /ACS → Models → Roles/)
  assert.equal(logLines().length, before, 'no dispute entry')
})

// ── 3. Paths ─────────────────────────────────────────────────────────────────
test('B3 logPath(): the ACS folder, then ~/.claude/review-log/, then the older file, else a new ACS folder', () => {
  const logOf = () => {
    const r = run(['--show-config'])
    assert.equal(r.status, 0, r.out)
    return JSON.parse(r.stdout).log
  }
  assert.equal(logOf(), LOG)
  assert.equal(existsSync(dirname(LOG)), false, 'reading the path creates nothing')
  put(join(HOME, '.claude/review-log.jsonl'), '')
  assert.equal(logOf(), join(HOME, '.claude/review-log.jsonl'))
  mkdirSync(join(HOME, '.claude/review-log'))
  assert.equal(logOf(), join(HOME, '.claude/review-log/review-log.jsonl'))
  mkdirSync(dirname(LOG), { recursive: true })
  assert.equal(logOf(), LOG)
  rmSync(join(HOME, '.claude'), { recursive: true }); rmSync(dirname(LOG), { recursive: true })
  const r = run([])
  assert.equal(r.status, 0, r.out)
  assert.equal(logLines().length, 1, 'the first write creates the ACS folder')
  assert.equal(existsSync(join(HOME, '.claude')), false, 'no ~/.claude is created')
})

test('B3 config: a repo file beats ~/.agent-config-studio/review-gate/config.json, which beats ~/.claude/review-config.json', () => {
  const sourceOf = () => {
    const r = run(['--show-config'])
    assert.equal(r.status, 0, r.out)
    return [JSON.parse(r.stdout).source, JSON.parse(r.stdout).selected.family]
  }
  put(join(HOME, '.claude/review-config.json'), J({ pick: 'grok' }))
  assert.deepEqual(sourceOf(), [join(HOME, '.claude/review-config.json'), 'grok'])
  put(join(GATE, 'config.json'), J({ pick: 'sol' }))
  assert.deepEqual(sourceOf(), [join(GATE, 'config.json'), 'sol'])
  put(join(REPO, '.claude/review-config.json'), J({ pick: 'opus' }))
  assert.deepEqual(sourceOf(), [join('.claude', 'review-config.json'), 'opus'])
})

// ── 4. Neutral wording, the optional classifier ──────────────────────────────
test('B4 operator-only actions say so, without a name, when no real terminal is attached', () => {
  assert.equal(run([]).status, 0)
  const r = run(['--waive', logLines()[0].id, 'f1', '--reason', 'accepted'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /Operator-only action requires a nonempty reason, a real terminal on stderr, and no runtime agent markers/)
})

test('B4 the optional classifier: a pick or dispute uses one only when it is named; without one the first family is used', () => {
  const missing = run(['--show-config'], { REVIEW_PICK: 'no-such-classifier' })
  assert.equal(missing.status, 0, missing.out)
  const shown = JSON.parse(missing.stdout)
  assert.equal(shown.selected.family, 'opus')
  assert.ok(shown.notes.some((n) => /pick "no-such-classifier" is not first, rotate, a pool family \(opus, sol, grok\) or a classifier command on PATH — using first/.test(n)), shown.notes.join('\n'))
  const picked = run([], { REVIEW_PICK: 'pick-helper' })
  assert.equal(picked.status, 0, picked.out)
  assert.match(picked.stdout, /▶ reviewer · grok .*pick=pick-helper: grok at conf 0\.9/)
  assert.deepEqual(logLines()[0]['pick-helper'], { choice: 'grok', confidence: 0.9, probabilities: { grok: 0.9, opus: 0.1 } })
  const asked = calls('pick-helper').length
  const id = logLines()[0].id
  const plain = run(['--dispute', id, 'f1', '--reason', 'intended', '--evidence', 'a.js:2'], { STUB_VERDICTS: J({ verdicts: [] }) })
  assert.equal(plain.status, 0, plain.out)
  assert.equal(calls('pick-helper').length, asked, 'no classifier is asked unless one is named')
  assert.equal(logLines().at(-1).verifier, 'opus', 'another vendor first')
})

// ── 5. Push-gate opt-in, 7. pinned node ──────────────────────────────────────
function installGlobalGate() {
  cpSync(RUNTIME, GATE, { recursive: true, verbatimSymlinks: true })
  writeFileSync(GITCONFIG, `[core]\n\thooksPath = ${join(GATE, 'hooks/global')}\n`)
  git('init', '--bare', '-q', REMOTE); git('remote', 'add', 'origin', REMOTE)
}
const push = (ref = 'feat', options = {}) => sh('git', ['push', 'origin', `HEAD:refs/heads/${ref}`], options)
function cover() {
  const head = git('rev-parse', 'HEAD')
  put(LOG, [{ type: 'review', kind: 'review', id: 'fixture', head, family: 'fixture', model: 'fixture-only', findingDetails: [] },
    { type: 'close', review: 'fixture', closeHead: head, status: 'complete', statuses: {} }].map((e) => J(e)).join('\n') + '\n')
}
const refused = (r, pattern) => { assert.notEqual(r.status, 0, r.out); assert.match(r.out, pattern) }
const pushed = (r) => assert.equal(r.status, 0, r.out)

test('B5 an ordinary repo pushes with no review; reviewgate.enabled true gates it, in the repo or the global config', () => {
  installGlobalGate()
  const ordinary = push('ordinary'); pushed(ordinary)
  assert.doesNotMatch(ordinary.out, /review\.mjs ·/)
  git('config', 'reviewgate.enabled', 'true')
  refused(push('local'), /Push blocked: No review log/)
  git('config', '--unset', 'reviewgate.enabled')
  git('config', '--global', 'reviewgate.enabled', 'true')
  refused(push('global'), /Push blocked: No review log/)
  cover(); pushed(push('reviewed'))
})

test('B5 a .worktrees.conf gates a repo only when reviewgate.worktreeProjects is true, in any scope', () => {
  installGlobalGate()
  writeFileSync(join(REPO, '.worktrees.conf'), 'project\n')
  pushed(push('marker-only'))
  git('config', '--global', 'reviewgate.worktreeProjects', 'true')
  refused(push('global-opt-in'), /Push blocked: No review log/)
  git('config', '--global', '--unset', 'reviewgate.worktreeProjects')
  git('config', 'reviewgate.worktreeProjects', 'yes')
  refused(push('local-opt-in'), /Push blocked: No review log/)
  rmSync(join(REPO, '.worktrees.conf'))
  pushed(push('opt-in-without-marker'))
})

test('B5 a reviewgate setting that is not a boolean blocks the push instead of guessing', () => {
  installGlobalGate()
  git('config', 'reviewgate.enabled', 'maybe')
  refused(push(), /could not classify this repo for the review gate: reviewgate\.enabled is not a boolean/)
})

test('B5 without node, an opted-in repo refuses the push; an ordinary repo passes with a warning', () => {
  installGlobalGate()
  const noNode = env({ PATH: NO_NODE })
  const ordinary = push('ordinary', { env: noNode }); pushed(ordinary)
  assert.match(ordinary.stderr, /node is missing; treating this push as ordinary/)
  git('config', 'reviewgate.enabled', 'true')
  refused(push('opted-in', { env: noNode }), /Push blocked: node is missing; the review gate for this opted-in repo cannot run/)
})

function pinNode(path = join(ROOT, 'pinned-node')) {
  put(join(ROOT, 'pinned-node'), `#!/bin/sh\necho used >> ${J(join(ROOT, 'pinned-used'))}\nexec ${J(process.execPath)} "$@"\n`, 0o755)
  rmSync(join(ROOT, 'pinned-used'), { force: true })
  put(join(GATE, 'hooks/node-path'), `${path}\n`)
}
const pinnedUses = () => (existsSync(join(ROOT, 'pinned-used')) ? readFileSync(join(ROOT, 'pinned-used'), 'utf8').trim().split('\n').length : 0)

test('B7 the global push gate runs on the node pinned in hooks/node-path when PATH has no node', () => {
  installGlobalGate(); git('config', 'reviewgate.enabled', 'true'); pinNode()
  const noNode = env({ PATH: NO_NODE })
  refused(push('unreviewed', { env: noNode }), /Push blocked: No review log/)
  assert.ok(pinnedUses() >= 3, `classification, the gate and review.mjs each ran on the pinned node (${pinnedUses()})`)
  cover(); pushed(push('reviewed', { env: noNode }))
})

test('B7 with no PATH at all (env -i) the pinned hook still gates and still passes a reviewed push', () => {
  installGlobalGate(); git('config', 'reviewgate.enabled', 'true'); pinNode()
  const bare = { HOME, GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: '1' }
  refused(sh('/usr/bin/git', ['push', 'origin', 'HEAD:refs/heads/bare'], { env: bare }), /Push blocked: No review log/)
  assert.ok(pinnedUses() >= 3, `ran on the pinned node (${pinnedUses()})`)
  cover(); pushed(sh('/usr/bin/git', ['push', 'origin', 'HEAD:refs/heads/bare-reviewed'], { env: bare }))
})

test('B7 a missing or non-executable pinned path falls back to node on PATH', () => {
  installGlobalGate(); git('config', 'reviewgate.enabled', 'true')
  for (const pinned of [join(ROOT, 'no-such-node'), join(GATE, 'review.mjs')]) {
    pinNode(pinned)
    refused(push('fallback'), /Push blocked: No review log/)
    assert.equal(pinnedUses(), 0)
  }
})

test('B7 the agent guard launcher and the per-repo shim read the pinned node too', () => {
  cpSync(RUNTIME, GATE, { recursive: true, verbatimSymlinks: true }); pinNode()
  const noNode = env({ PATH: NO_NODE })
  const guard = sh('/bin/sh', [join(GATE, 'hooks/agent-guard')], { env: noNode, input: J({ tool_name: 'Bash', tool_input: { command: 'git push --no-verify' } }) })
  assert.equal(guard.status, 2, guard.out)
  assert.match(guard.stderr, /agents may not run git push --no-verify/, 'the guard itself ran, not the no-node fallback')
  const byGuard = pinnedUses()
  assert.equal(byGuard, 2, 'the launcher checks the pinned node, then runs the guard on it')
  git('init', '--bare', '-q', REMOTE); git('remote', 'add', 'origin', REMOTE)
  assert.equal(sh('sh', [join(GATE, 'hooks/install-hook.sh'), REPO]).status, 0)
  refused(push('shim', { env: noNode }), /Push blocked: No review log/)
  assert.equal(pinnedUses(), byGuard + 1, 'the per-repo shim ran review.mjs on the pinned node')
})

test('B7 --gate needs no model-id', () => {
  installGlobalGate(); cover()
  const head = git('rev-parse', 'HEAD')
  const r = sh(process.execPath, [SCRIPT, '--gate'], { env: env({ PATH: [NODE_BIN, ...SYSTEM].join(':') }), input: `HEAD ${head} refs/heads/feat ${'0'.repeat(40)}\n` })
  assert.equal(r.status, 0, r.out)
  assert.match(r.stderr, /Reviewer: fixture \(fixture-only\)/)
})

// ── 6. The guard refuses agent writes to reviewgate.* ────────────────────────
const guard = (command, PATH = [NODE_BIN, ...SYSTEM].join(':')) =>
  sh('/bin/sh', [join(RUNTIME, 'hooks/agent-guard')], { env: env({ PATH }), input: J({ tool_name: 'Bash', tool_input: { command } }) })
test('B6 the guard refuses agent writes to reviewgate.* git config, the way it refuses core.hooksPath', () => {
  for (const command of [
    'git config reviewgate.enabled false', 'git config --global reviewgate.worktreeProjects false', 'git config --local --replace-all ReviewGate.Enabled false',
    'git config --unset reviewgate.enabled', 'git config --unset-all reviewgate.enabled', 'git config set reviewgate.enabled false', 'git config unset reviewgate.enabled',
    'git config --remove-section reviewgate', 'git config rename-section reviewgate old', 'git -c reviewgate.enabled=false push', 'git -creviewgate.enabled=false push',
    'git --config-env=reviewgate.enabled=V push', 'git -c reviewgate.worktreeProjects=false commit -m x', "git config alias.p '!git -c reviewgate.enabled=false push'",
    'timeout 5 git config reviewgate.enabled false', 'sh -c "git config reviewgate.enabled false"', 'cd x && git config reviewgate.enabled false',
  ]) {
    const r = guard(command)
    assert.equal(r.status, 2, `${command}\n${r.out}`)
    assert.equal(r.stderr.trim().split('\n').length, 1, command)
  }
  for (const command of ['git config --get reviewgate.enabled', 'git config get reviewgate.enabled', 'git config reviewgate.enabled', 'git config --list',
    'git -c reviewgate.enabled=false status', "git commit -m 'turn reviewgate.enabled off later'"])
    assert.equal(guard(command).status, 0, command)
})
test('B6 without node the guard launcher still refuses anything that mentions reviewgate', () => {
  const r = guard('git config reviewgate.enabled false', NO_NODE)
  assert.equal(r.status, 2, r.out)
  assert.match(r.stderr, /node could not start/)
})

// ── 8. Guard homes ───────────────────────────────────────────────────────────
const guardInstall = (action, extra = {}) =>
  sh(process.execPath, [join(RUNTIME, 'hooks/install-agent-guard.mjs'), action], { env: { HOME, PATH: [NODE_BIN, ...SYSTEM].join(':'), GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: '1', ...extra } })
const hasGuard = (home) => existsSync(join(home, 'hooks.json')) && /agent-guard/.test(readFileSync(join(home, 'hooks.json'), 'utf8'))
test('B8 the guard installs into ~/.codex, $CODEX_HOME and codexHomes from the review-gate config, and never discovers ~/.codex-seats', () => {
  const codex = join(HOME, '.codex'), alt = join(HOME, 'alt-codex'), listed = join(HOME, 'work/codex-a'), seat = join(HOME, '.codex-seats/b')
  for (const home of [codex, alt, listed]) mkdirSync(home, { recursive: true })
  put(join(seat, 'config.toml'), '# a seat nobody listed\n')
  put(join(GATE, 'config.json'), J({ codexHomes: ['~/work/codex-a'] }))
  const r = guardInstall('install', { CODEX_HOME: alt })
  assert.equal(r.status, 0, r.out)
  for (const home of [codex, alt, listed]) assert.ok(hasGuard(home), home)
  assert.equal(existsSync(join(seat, 'hooks.json')), false)
  for (const home of [codex, alt, listed]) assert.ok(r.stdout.includes(`Codex ${home}: entry present`), r.out)
  assert.doesNotMatch(r.out, /codex-seats/)
  assert.equal(guardInstall('uninstall', { CODEX_HOME: alt }).status, 0)
  for (const home of [codex, alt, listed]) assert.equal(existsSync(join(home, 'hooks.json')), false, home)
})
test('B8 absent harnesses are skipped silently: nothing is created for a harness that is not there', () => {
  for (const action of ['install', 'status']) {
    const r = guardInstall(action)
    assert.equal(r.status, 0, r.out)
    assert.doesNotMatch(r.out, /Codex|Claude Bash|Warning/)
  }
  for (const folder of ['.claude', '.codex']) assert.equal(existsSync(join(HOME, folder)), false, `${folder} was created`)
  mkdirSync(join(HOME, '.claude'))
  assert.equal(guardInstall('install').status, 0)
  assert.match(readFileSync(join(HOME, '.claude/settings.json'), 'utf8'), /agent-guard/)
  assert.equal(existsSync(join(HOME, '.codex')), false)
})
test('B8 the older ~/.claude/review-config.json codexHomes is read when the ACS config is absent; a malformed list refuses with no writes', () => {
  const listed = join(HOME, 'legacy-codex'); mkdirSync(listed)
  put(join(HOME, '.claude/review-config.json'), J({ codexHomes: [listed] }))
  assert.equal(guardInstall('install').status, 0)
  assert.ok(hasGuard(listed))
  assert.equal(guardInstall('uninstall').status, 0)
  put(join(GATE, 'config.json'), J({ codexHomes: 'legacy-codex' }))
  const bad = guardInstall('install')
  assert.notEqual(bad.status, 0, bad.out)
  assert.match(bad.stderr, /codexHomes in .*config\.json must be a list of folder paths/)
  assert.equal(existsSync(join(listed, 'hooks.json')), false)
})

// ── 9. Project scan roots ────────────────────────────────────────────────────
test('B9 the hooksPath status scan walks ACS roots.json, or --root, and never a folder of its own choosing', () => {
  const repo = (path, hooks) => {
    mkdirSync(path, { recursive: true })
    assert.equal(sh('git', ['init', '-q', path]).status, 0)
    assert.equal(sh('git', ['-C', path, 'config', '--local', 'core.hooksPath', hooks]).status, 0)
  }
  repo(join(HOME, 'listed/repo-a'), '/hooks-a'); repo(join(HOME, 'unlisted/repo-b'), '/hooks-b'); repo(join(HOME, 'Documents/Projects/repo-c'), '/hooks-c')
  const status = (...args) => {
    const r = sh('sh', [join(RUNTIME, 'hooks/install-global.sh'), 'status', ...args])
    assert.equal(r.status, 0, r.out)
    return r
  }
  const none = status()
  assert.match(none.stderr, /No project roots to scan: ACS has no roots\.json here, and no --root was given\./)
  for (const hooks of ['/hooks-a', '/hooks-b', '/hooks-c']) assert.ok(!none.stdout.includes(hooks), hooks)
  put(join(HOME, '.agent-config-studio/roots.json'), J({ version: 1, roots: [{ id: 'listed', path: join(HOME, 'listed'), label: 'Listed', access: 'read' }] }))
  const fromRoots = status()
  assert.ok(fromRoots.stdout.includes(realpathSync(join(HOME, 'listed/repo-a'))) || fromRoots.stdout.includes(join(HOME, 'listed/repo-a')), fromRoots.out)
  assert.ok(fromRoots.stdout.includes('/hooks-a'))
  for (const hooks of ['/hooks-b', '/hooks-c']) assert.ok(!fromRoots.stdout.includes(hooks), hooks)
  const fromFlag = status('--root', join(HOME, 'unlisted'))
  assert.ok(fromFlag.stdout.includes('/hooks-b'))
  for (const hooks of ['/hooks-a', '/hooks-c']) assert.ok(!fromFlag.stdout.includes(hooks), hooks)
  const usage = sh('sh', [join(RUNTIME, 'hooks/install-global.sh'), 'status', '--root'])
  assert.notEqual(usage.status, 0); assert.match(usage.stderr, /Usage: install-global\.sh install \| uninstall \| status \[--root <dir>\]/)
})
