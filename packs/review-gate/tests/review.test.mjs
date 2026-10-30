#!/usr/bin/env node
/**
 * review.test.mjs — offline tests for review.mjs. Run: node review.test.mjs
 *
 * Stub `model-id`, `codex`, `claude`, `grok` and `jev` executables sit alone on PATH (plus node
 * and git), and HOME is a temp dir, so no real model is called and the real
 * review log is never touched.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'review.mjs')
const ROOT = mkdtempSync(join(tmpdir(), 'review-test-'))
const BIN = join(ROOT, 'bin')
const HOME = join(ROOT, 'home')
const ARGV = join(ROOT, 'argv')
const REPO = join(ROOT, 'repo-under-review')
const LOG = join(HOME, '.agent-config-studio', 'review-log', 'review-log.jsonl')
after(() => rmSync(ROOT, { recursive: true, force: true }))

const stub = (name, body) => {
  const p = join(BIN, name)
  writeFileSync(p, `#!${process.execPath}\n${body}`)
  chmodSync(p, 0o755)
}
const record = (name) => `
const { writeFileSync } = require('node:fs')
writeFileSync(require('node:path').join(${JSON.stringify(ARGV)}, '${name}-' + process.pid + '.json'), JSON.stringify(process.argv.slice(2)))
`
const LOOP = { severity: 'High', issue: 'off-by-one in loop', file: 'a.js', line: '2', quote: 'for (let i = 0; i <= n; i++) {}', suggestion: 'use <' }
const FINDINGS = JSON.stringify({ findings: [LOOP] })
// Each model stub answers a review schema with STUB_FINDINGS (or one real finding) and the
// second-opinion schema with STUB_VERDICTS.
const answer = (schemaExpr) => `
const isVerdict = String(${schemaExpr}).includes('verdicts')
const reply = isVerdict ? (process.env.STUB_VERDICTS || '{"verdicts":[]}') : (process.env.STUB_FINDINGS || ${JSON.stringify(FINDINGS)})
`
mkdirSync(BIN, { recursive: true })
stub(
  'model-id',
  `
const POOL = ['opus', 'sol', 'grok', 'fable']
const LIKES = { opus: ['the go-to default'], sol: ['very efficient'], grok: ['very logical: built for reviewing'], fable: ['the smartest model'] }
const QUIRKS = { opus: ['a step below fable'], sol: ['over-builds'], grok: ['horrible at UI'], fable: ['uses more resources'] }
const IDS = { sol: 'gpt-stub-sol-id', opus: 'claude-stub-opus-id', grok: 'grok-stub-id', fable: 'claude-stub-fable-id', astra: 'gpt-stub-astra-id' }
const EFFORT = { sol: 'high', opus: 'high', grok: 'xhigh', fable: 'high', astra: 'high' }
const a = process.argv.slice(2)
if (process.env.STUB_MODELID_FAIL) { console.error('model-id: registry missing'); console.log('MODEL-ID-UNRESOLVED-' + a[0]); process.exit(1) }
if (a[0] === '--role') {
  const role = { role: a[1], use: POOL, ids: POOL.map((f) => IDS[f]) }
  if (process.env.STUB_ROLE_EFFORT) Object.assign(role, { effort: process.env.STUB_ROLE_EFFORT, provenance: { effort: 'user' } })
  if (process.env.STUB_MEMBERS) role.members = JSON.parse(process.env.STUB_MEMBERS)
  console.log(JSON.stringify(role))
}
else if (a[0] === '--flavor') console.log(JSON.stringify({ family: a[1], flavor: { effort: EFFORT[a[1]] || '', likes: LIKES[a[1]] || [], quirks: QUIRKS[a[1]] || [] } }))
else if (IDS[a[0]]) console.log(IDS[a[0]])
else console.log(a[0])
`,
)
stub(
  'codex',
  `${record('codex')}
const a = process.argv.slice(2)
${answer("require('node:fs').readFileSync(a[a.indexOf('--output-schema') + 1], 'utf8')")}
writeFileSync(a[a.indexOf('-o') + 1], reply)
`,
)
stub(
  'claude',
  `${record('claude')}
const a = process.argv.slice(2)
${answer("a[a.indexOf('--json-schema') + 1]")}
// The real CLI shape with --json-schema: the object in structured_output, result its text.
console.log(JSON.stringify({ type: 'result', is_error: false, result: process.env.STUB_CLAUDE_EMPTY_RESULT ? '' : reply, structured_output: JSON.parse(reply) }))
`,
)
stub(
  'grok',
  `${record('grok')}
const a = process.argv.slice(2)
${answer("a[a.indexOf('--json-schema') + 1]")}
const out = { structuredOutput: JSON.parse(reply) }
if (!process.env.STUB_GROK_NO_USAGE) out.modelUsage = { 'stub-grok-id-build': { inputTokens: 1 } }
console.log(JSON.stringify(out))
`,
)

stub(
  'jev',
  `
const { readFileSync, writeFileSync } = require('node:fs')
const body = readFileSync(0, 'utf8')
writeFileSync(require('node:path').join(${JSON.stringify(ARGV)}, 'jev-' + process.pid + '.json'), body)
const mode = process.env.STUB_JEV || 'confident'
if (mode === 'error') { console.error('jev: HTTP 503 Service Unavailable'); process.exit(1) }
const conf = mode === 'mid' ? 0.55 : 0.82
const probabilities = { opus: 0.08, sol: 0.05, grok: conf, fable: 0.05, unsure: +(1 - conf - 0.18).toFixed(2) }
console.log(JSON.stringify({ answers: { reviewer: { type: 'choice', choice: 'grok', confidence: conf, probabilities } } }))
`,
)

const git = (...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: REPO, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
}
mkdirSync(REPO, { recursive: true })
git('init', '-q', '-b', 'main')
writeFileSync(join(REPO, 'a.js'), 'export const f = (n) => n\n')
git('add', '.')
git('commit', '-qm', 'base')
git('checkout', '-qb', 'feat')
const A_JS = ['export const f = (n) => {', '  for (let i = 0; i <= n; i++) {}', '  return n', '}']
for (let i = 1; i <= 10; i++) A_JS.push(`// pad ${i}`)
writeFileSync(join(REPO, 'a.js'), `${A_JS.join('\n')}\n`)
mkdirSync(join(REPO, 'src', 'payments'), { recursive: true })
writeFileSync(join(REPO, 'src', 'payments', 'charge.js'), 'export const charge = (amt) => Math.round(amt * 100)\n')
git('add', '.')
git('commit', '-qm', 'change')

function run(args, env = {}, { cwd = REPO, bin = BIN } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000, // a hung check fails the test instead of the suite
    env: {
      PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
      HOME,
      TMPDIR: ROOT,
      REVIEW_BASE: 'main',
      ...env,
    },
  })
  return { ...r, out: `${r.stdout}\n${r.stderr}` }
}
const showConfig = (env) => {
  const r = run(['--show-config'], env)
  assert.equal(r.status, 0, r.out)
  return { cfg: JSON.parse(r.stdout), stderr: r.stderr }
}
const argvOf = (name) =>
  readdirSync(ARGV)
    .filter((f) => f.startsWith(`${name}-`))
    .map((f) => JSON.parse(readFileSync(join(ARGV, f), 'utf8')))
const logLines = () =>
  existsSync(LOG)
    ? readFileSync(LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
// Read-only means the tools don't exist (--tools), not that they're merely pre-approved, and no MCP.
function assertClaudeReadOnly(argv) {
  assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Grep,Glob', argv.join(' '))
  assert.ok(argv.includes('--strict-mcp-config'))
  assert.ok(!argv.includes('--mcp-config') && !argv.includes('--allowedTools') && !argv.includes('--allowed-tools'))
}
const findingsJson = (stdout) => JSON.parse(stdout.split('===FINDINGS_JSON===')[1])
const seedLog = (families) => {
  mkdirSync(dirname(LOG), { recursive: true })
  writeFileSync(LOG, families.map((family) => JSON.stringify({ type: 'review', family })).join('\n') + (families.length ? '\n' : ''))
}

beforeEach(() => {
  rmSync(ARGV, { recursive: true, force: true })
  mkdirSync(ARGV, { recursive: true })
  rmSync(join(HOME, '.claude'), { recursive: true, force: true })
  rmSync(dirname(LOG), { recursive: true, force: true })
  rmSync(join(REPO, 'reviews'), { recursive: true, force: true })
})

test('pool resolves from the registry, each family at its flavor effort', () => {
  const { cfg } = showConfig()
  assert.deepEqual(
    cfg.pool.map((m) => [m.family, m.vendor, m.model, m.effort]),
    [
      ['opus', 'claude', 'claude-stub-opus-id', 'high'],
      ['sol', 'codex', 'gpt-stub-sol-id', 'high'],
      ['grok', 'grok', 'grok-stub-id', 'xhigh'],
      ['fable', 'claude', 'claude-stub-fable-id', 'high'],
    ],
  )
  assert.equal(cfg.reviewer, '(pool)')
  assert.deepEqual(cfg.reviewCounts, { sol: 0, opus: 0, grok: 0, fable: 0 })
})

test('pick=first takes pool order, and an unknown author is said, not filtered', () => {
  const { cfg } = showConfig()
  assert.equal(cfg.selected.family, 'opus')
  assert.match(cfg.why, /pick=first/)
  assert.ok(cfg.notes.some((n) => /author unknown/.test(n)), cfg.notes.join('\n'))
})

test('pick=rotate takes the fewest logged reviews, ties go to pool order', () => {
  assert.equal(showConfig({ REVIEW_PICK: 'rotate' }).cfg.selected.family, 'opus')
  seedLog(['sol', 'opus', 'opus', 'grok', 'fable'])
  const { cfg } = showConfig({ REVIEW_PICK: 'rotate' })
  assert.equal(cfg.selected.family, 'sol') // sol 1, grok 1, fable 1 — sol first in pool order
  assert.deepEqual(cfg.reviewCounts, { sol: 1, opus: 2, grok: 1, fable: 1 })
  seedLog(['sol', 'opus', 'grok'])
  assert.equal(showConfig({ REVIEW_PICK: 'rotate' }).cfg.selected.family, 'fable')
})

test('pick=<family> picks that family, from config too', () => {
  const { cfg } = showConfig({ REVIEW_PICK: 'grok' })
  assert.deepEqual(cfg.selected, { family: 'grok', vendor: 'grok', model: 'grok-stub-id', effort: 'xhigh' })
  const confPath = join(ROOT, 'conf.json')
  writeFileSync(confPath, JSON.stringify({ pick: 'fable' }))
  assert.equal(showConfig({ REVIEW_CONFIG: confPath }).cfg.selected.family, 'fable')
})

test('crossFamily=prefer skips the author vendor; off does not', () => {
  const prefer = showConfig({ REVIEW_AUTHOR: 'opus' }).cfg
  assert.equal(prefer.selected.family, 'sol')
  assert.match(prefer.why, /skipped claude/)
  assert.equal(showConfig({ REVIEW_AUTHOR: 'claude' }).cfg.selected.family, 'sol')
  assert.equal(showConfig({ REVIEW_AUTHOR: 'sol' }).cfg.selected.family, 'opus')
  assert.equal(showConfig({ REVIEW_AUTHOR: 'opus', REVIEW_PICK: 'rotate' }).cfg.selected.family, 'sol')
  seedLog(['sol'])
  assert.equal(showConfig({ REVIEW_AUTHOR: 'opus', REVIEW_PICK: 'rotate' }).cfg.selected.family, 'grok')
  assert.equal(showConfig({ REVIEW_AUTHOR: 'opus', REVIEW_CROSS_FAMILY: 'off' }).cfg.selected.family, 'opus')
})

test('explicit reviewers keep working; codex resolves its model through the role', () => {
  assert.deepEqual(showConfig({ REVIEW_REVIEWER: 'codex' }).cfg.selected, {
    family: 'sol',
    vendor: 'codex',
    model: 'gpt-stub-sol-id',
    effort: 'high',
  })
  const astra = showConfig({ REVIEW_REVIEWER: 'codex', REVIEW_MODEL: 'astra', REVIEW_EFFORT: 'xhigh' }).cfg.selected
  assert.deepEqual([astra.model, astra.effort], ['gpt-stub-astra-id', 'xhigh'])
  assert.equal(showConfig({ REVIEW_REVIEWER: 'claude' }).cfg.selected.family, 'claude-team')
  assert.deepEqual(showConfig({ REVIEW_REVIEWER: 'opus' }).cfg.selected, {
    family: 'opus',
    vendor: 'claude',
    model: 'claude-stub-opus-id',
    effort: 'high',
  })
  const bad = run(['--show-config'], { REVIEW_REVIEWER: 'gemini' })
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /codex, claude, grok, or a reviewer family/)
})

test('grok review: read-only tool allowlist, structuredOutput mapped, log line written', () => {
  const r = run(['fix the loop'], { REVIEW_REVIEWER: 'grok' })
  assert.equal(r.status, 0, r.out)
  assert.match(r.stdout, /▶ reviewer · grok \(grok · grok-stub-id · xhigh\)/)
  const [argv] = argvOf('grok')
  const flag = (f) => argv[argv.indexOf(f) + 1]
  assert.equal(flag('--tools'), 'read_file,list_dir,grep')
  for (const t of flag('--tools').split(',')) assert.ok(!/write|edit|bash|shell/i.test(t), t)
  for (const f of ['--disable-web-search', '--no-subagents', '--json-schema', '--max-turns'])
    assert.ok(argv.includes(f), f)
  assert.ok(!argv.includes('--always-approve'))
  // MCP meta-tools survive --tools; they must be removed and MCP calls denied.
  assert.equal(flag('--disallowed-tools'), 'search_tool,use_tool')
  assert.equal(flag('--deny'), 'MCPTool')
  assert.deepEqual(
    [flag('-m'), flag('--reasoning-effort'), realpathSync(flag('--cwd'))],
    ['grok-stub-id', 'xhigh', realpathSync(REPO)],
  )

  const out = findingsJson(r.stdout)
  assert.equal(out.family, 'grok')
  assert.deepEqual(out.findings, [{ ...LOOP, severity: 'high', status: 'verified-quote', id: 'f1' }])
  assert.ok(existsSync(join(REPO, out.reportPath)))

  const [line] = logLines()
  assert.equal(line.type, 'review')
  assert.equal(line.repo, basename(REPO))
  assert.equal(line.base, 'main')
  assert.deepEqual(
    [line.family, line.model, line.effort, line.vendor, line.findings, line.modelUsed],
    ['grok', 'grok-stub-id', 'xhigh', 'grok', 1, 'stub-grok-id-build'],
  )
  assert.equal(typeof line.durationMs, 'number')
  assert.match(line.dir, /^reviews\/\d{4}-\d\d-\d\d-/)
  assert.ok(line.ts)
})

test('grok review without a grok modelUsage fails loudly', () => {
  const r = run([], { REVIEW_REVIEWER: 'grok', STUB_GROK_NO_USAGE: '1' })
  assert.notEqual(r.status, 0)
  assert.match(r.out, /modelUsage names no grok model/)
  assert.equal(logLines().length, 0)
})

test('codex and claude paths still run', () => {
  const codex = run([], { REVIEW_REVIEWER: 'codex' })
  assert.equal(codex.status, 0, codex.out)
  const [cargv] = argvOf('codex')
  assert.ok(cargv.includes('model=gpt-stub-sol-id') && cargv.includes('model_reasoning_effort=high'), cargv.join(' '))
  assert.ok(cargv.includes('read-only'))

  const team = run([], { REVIEW_REVIEWER: 'claude' })
  assert.equal(team.status, 0, team.out)
  const models = argvOf('claude').map((a) => a[a.indexOf('--model') + 1])
  assert.deepEqual(models.sort(), ['claude-stub-fable-id', 'claude-stub-opus-id', 'claude-stub-opus-id'])
  for (const a of argvOf('claude')) assertClaudeReadOnly(a)
  assert.equal(findingsJson(team.stdout).reviewer, 'claude-team(opus+fable+opus)')

  rmSync(ARGV, { recursive: true, force: true })
  mkdirSync(ARGV)
  const fable = run([], { REVIEW_REVIEWER: 'claude', REVIEW_CLAUDE_MODEL: 'fable' })
  assert.equal(fable.status, 0, fable.out)
  const fargv = argvOf('claude')
  assert.equal(fargv.length, 1)
  assertClaudeReadOnly(fargv[0])
  assert.deepEqual([fargv[0][fargv[0].indexOf('--model') + 1], fargv[0][fargv[0].indexOf('--effort') + 1]], ['claude-stub-fable-id', 'high'])
  assert.deepEqual(
    logLines().map((l) => l.family),
    ['sol', 'claude-team', 'fable'],
  )
})

test('--log-outcome appends an outcome line tied to the review', () => {
  const r = run([], { REVIEW_REVIEWER: 'grok' })
  assert.equal(r.status, 0, r.out)
  const ts = basename(logLines()[0].dir)
  const o = run(['--log-outcome', ts, '1', '0'])
  assert.equal(o.status, 0, o.out)
  const lines = logLines()
  assert.equal(lines.length, 2)
  assert.deepEqual(
    [lines[1].type, lines[1].review, lines[1].family, lines[1].confirmed, lines[1].rejected],
    ['outcome', ts, 'grok', 1, 0],
  )
  assert.notEqual(run(['--log-outcome', ts, 'x']).status, 0)
})

test('model-id failure is a hard stop that names the fix; no reviewer CLI runs and nothing is logged', () => {
  const shown = run(['--show-config'], { STUB_MODELID_FAIL: '1' })
  assert.notEqual(shown.status, 0, shown.out)
  assert.match(shown.stderr, /could not resolve the reviewer role/)
  assert.match(shown.stderr, /Fix: set the reviewer role in ACS → Models → Roles/)
  const review = run([], { STUB_MODELID_FAIL: '1' })
  assert.notEqual(review.status, 0, review.out)
  assert.match(review.stderr, /could not resolve the reviewer role/)
  assert.match(review.stderr, /Fix: set the reviewer role in ACS → Models → Roles/)
  for (const cli of ['codex', 'claude', 'grok']) assert.equal(argvOf(cli).length, 0, `${cli} must not run`)
  assert.equal(logLines().length, 0)
})

const writeConf = (obj) => {
  const p = join(ROOT, `conf-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(p, JSON.stringify(obj))
  return p
}
const jevPayloads = () => argvOf('jev')

test('pick=jev: a confident choice is used; probabilities printed and logged; no code sent', () => {
  const r = run([], { REVIEW_PICK: 'jev' })
  assert.equal(r.status, 0, r.out)
  assert.match(r.stdout, /▶ reviewer · grok .*pick=jev: grok at conf 0\.82 · opus=0\.08 sol=0\.05 grok=0\.82/)
  const [payload] = jevPayloads()
  assert.deepEqual(Object.keys(payload).sort(), ['questions', 'state'])
  const q = payload.questions.reviewer
  assert.equal(q.type, 'choice')
  assert.deepEqual(Object.keys(q.criteria), ['opus', 'sol', 'grok', 'fable', 'unsure'])
  assert.match(q.criteria.grok, /very logical: built for reviewing.*horrible at UI/)
  assert.deepEqual(payload.state.diff.paths.sort(), ['a.js', 'src/payments/charge.js'])
  assert.equal(payload.state.diff.touches_risk_paths, true)
  assert.equal(payload.state.diff.languages.javascript, 2)
  const sent = JSON.stringify(payload)
  for (const code of ['for (let i', 'Math.round', 'return n']) assert.ok(!sent.includes(code), code)
  const [line] = logLines()
  assert.equal(line.family, 'grok')
  assert.deepEqual([line.jev.choice, line.jev.confidence, line.jev.probabilities.grok], ['grok', 0.82, 0.82])
})

test('pick=jev: a middle-band choice falls back to the first family', () => {
  const r = run([], { REVIEW_PICK: 'jev', STUB_JEV: 'mid' })
  assert.equal(r.status, 0, r.out)
  assert.match(r.stdout, /▶ reviewer · opus .*grok at conf 0\.55 is in the middle band — first \(opus\)/)
  assert.equal(logLines()[0].jev.confidence, 0.55)
})

test('pick=jev: a jev error falls back to the first family with a warning', () => {
  const r = run([], { REVIEW_PICK: 'jev', STUB_JEV: 'error' })
  assert.equal(r.status, 0, r.out)
  assert.match(r.stdout, /⚠ pick=jev: jev failed \(jev: HTTP 503/)
  assert.match(r.stdout, /▶ reviewer · opus /)
  assert.ok(logLines()[0].jev.error)
})

test('a risk-path force rule overrides jev, and jev is never asked', () => {
  const conf = writeConf({ pick: 'jev', force: [{ paths: 'risk', family: 'fable' }] })
  const r = run([], { REVIEW_CONFIG: conf })
  assert.equal(r.status, 0, r.out)
  assert.match(r.stdout, /▶ reviewer · fable .*force: risk paths \(src\/payments\/charge\.js\) → fable/)
  assert.equal(jevPayloads().length, 0)
  assert.equal(logLines()[0].family, 'fable')
  // Glob rules: `**/payments/**` matches; a pattern that matches nothing leaves the pick to jev.
  const glob = run([], { REVIEW_CONFIG: writeConf({ pick: 'jev', force: [{ paths: ['**/auth/**', '**/payments/**'], family: 'fable' }] }) })
  assert.match(glob.stdout, /▶ reviewer · fable .*force: paths \*\*\/auth\/\*\*, \*\*\/payments\/\*\* \(src\/payments\/charge\.js\) → fable/)
  const miss = run([], { REVIEW_CONFIG: writeConf({ pick: 'jev', force: [{ paths: ['**/migrations/**'], family: 'fable' }] }) })
  assert.match(miss.stdout, /▶ reviewer · grok /)
  const root = run([], { REVIEW_CONFIG: writeConf({ pick: 'jev', force: [{ paths: ['**/a.js'], family: 'sol' }] }) })
  assert.match(root.stdout, /▶ reviewer · sol .*\(a\.js\) → sol/, '**/ also matches at the repo root')
})

test('a fabricated quote is listed as unverified-quote, apart from the findings', () => {
  const findings = {
    findings: [
      { ...LOOP, quote: 'for (let  i = 0;\ti <= n; i++) {}' },
      { severity: 'high', issue: 'throws on undefined', file: 'a.js', line: '3', quote: 'if (n === undefined) throw new Error()', suggestion: null },
      { severity: 'medium', issue: 'real text, wrong place', file: 'a.js', line: '14', quote: 'return n', suggestion: null },
      { severity: 'low', issue: 'no quote at all', file: 'a.js', line: '1', quote: '', suggestion: null },
    ],
  }
  const r = run([], { REVIEW_REVIEWER: 'codex', STUB_FINDINGS: JSON.stringify(findings) })
  assert.equal(r.status, 0, r.out)
  const out = findingsJson(r.stdout)
  assert.deepEqual(out.findings.map((f) => f.issue), ['off-by-one in loop'])
  assert.deepEqual(
    out.unverified.map((f) => [f.issue, f.status, f.quoteCheck]),
    [
      ['throws on undefined', 'unverified-quote', 'quote not found within ±5 lines of a.js:3'],
      ['real text, wrong place', 'unverified-quote', 'quote not found within ±5 lines of a.js:14'],
      ['no quote at all', 'unverified-quote', 'no quote'],
    ],
  )
  const md = readFileSync(join(REPO, out.reportPath), 'utf8')
  const [main, apart] = md.split('## Could not be located in the code (unverified-quote)')
  assert.ok(apart.includes('throws on undefined') && !main.includes('throws on undefined'))
  assert.match(main, /Findings: 1 \(plus 0 disputed, 3 could not be located\)/)
  const [line] = logLines()
  assert.deepEqual([line.findings, line.raw, line.unverified, line.disputed], [1, 4, 3, 0])
  // The review prompt asks for the quote.
  const prompt = argvOf('codex')[0].at(-1)
  assert.match(prompt, /MUST carry `quote`/)
})

test('verify=second-opinion: another vendor checks HIGH/MEDIUM; REFUTED moves to disputed', () => {
  const findings = {
    findings: [
      LOOP,
      { severity: 'medium', issue: 'returns n, not the sum', file: 'a.js', line: '3', quote: 'return n', suggestion: null },
      { severity: 'low', issue: 'padding comments', file: 'a.js', line: '5', quote: '// pad 1', suggestion: null },
    ],
  }
  const verdicts = {
    verdicts: [
      { index: 0, verdict: 'CONFIRMED', evidence: 'a.js:2 loops n+1 times' },
      { index: 1, verdict: 'REFUTED', evidence: 'a.js:3 returning n is the stated intent' },
    ],
  }
  const r = run([], {
    REVIEW_REVIEWER: 'codex',
    REVIEW_VERIFY: 'second-opinion',
    STUB_FINDINGS: JSON.stringify(findings),
    STUB_VERDICTS: JSON.stringify(verdicts),
  })
  assert.equal(r.status, 0, r.out)
  assert.match(r.stdout, /▶ second opinion · opus \(claude · claude-stub-opus-id · high\) on 2 HIGH\/MEDIUM/)
  const [vargv] = argvOf('claude')
  assertClaudeReadOnly(vargv)
  assert.match(vargv[vargv.indexOf('--json-schema') + 1], /verdicts/)
  assert.match(vargv[1], /\[1\] MEDIUM a\.js:3 — returns n, not the sum/)
  assert.ok(!vargv[1].includes('padding comments'), 'LOW findings are not sent')
  const out = findingsJson(r.stdout)
  assert.deepEqual(out.secondOpinion, { family: 'opus', model: 'claude-stub-opus-id' })
  assert.deepEqual(out.findings.map((f) => [f.issue, f.secondOpinion?.verdict]), [
    ['off-by-one in loop', 'CONFIRMED'],
    ['padding comments', undefined],
  ])
  assert.deepEqual(out.disputed.map((f) => [f.issue, f.status, f.secondOpinion.evidence]), [
    ['returns n, not the sum', 'disputed', 'a.js:3 returning n is the stated intent'],
  ])
  const md = readFileSync(join(REPO, out.reportPath), 'utf8')
  assert.match(md, /## Disputed by second opinion\n- \[a\.js:3\] returns n, not the sum/)
  const [line] = logLines()
  assert.deepEqual([line.findings, line.disputed, line.secondOpinion.family], [2, 1, 'opus'])
})

test('verify=second-opinion: a broken verifier keeps every finding', () => {
  const r = run([], {
    REVIEW_REVIEWER: 'codex',
    REVIEW_VERIFY: 'second-opinion',
    STUB_VERDICTS: 'not json',
  })
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /second opinion \(opus\) failed/)
  const out = findingsJson(r.stdout)
  assert.equal(out.findings.length, 1)
  assert.equal(out.disputed.length, 0)
})

test('claude: structured_output is read even when result is empty', () => {
  const r = run([], { REVIEW_REVIEWER: 'opus', STUB_CLAUDE_EMPTY_RESULT: '1' })
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(findingsJson(r.stdout).findings.map((f) => f.issue), ['off-by-one in loop'])
  assertClaudeReadOnly(argvOf('claude')[0])
})

test('model-id missing (ENOENT): raw ids pass through; the pool and named families stop with the install fix', () => {
  const noMid = join(ROOT, 'bin-no-model-id')
  mkdirSync(noMid, { recursive: true })
  for (const n of ['codex', 'claude', 'grok', 'jev']) if (!existsSync(join(noMid, n))) symlinkSync(join(BIN, n), join(noMid, n))
  const raw = run(['--show-config'], { REVIEW_REVIEWER: 'codex', REVIEW_MODEL: 'gpt-custom-1' }, { bin: noMid })
  assert.equal(raw.status, 0, raw.out)
  assert.equal(JSON.parse(raw.stdout).selected.model, 'gpt-custom-1')
  const stopped = run([], {}, { bin: noMid })
  assert.notEqual(stopped.status, 0, stopped.out)
  assert.match(stopped.stderr, /could not resolve the reviewer role/)
  assert.match(stopped.stderr, /run: acs install-model-id/)
  for (const cli of ['codex', 'claude', 'grok']) assert.equal(argvOf(cli).length, 0, `${cli} must not run`)
  assert.equal(logLines().length, 0)
  const opus = run(['--show-config'], { REVIEW_REVIEWER: 'opus' }, { bin: noMid })
  assert.notEqual(opus.status, 0, opus.out)
  assert.match(opus.stderr, /run: acs install-model-id/)
})

test('a rename into auth/ triggers **/auth/** (destination and source both count)', () => {
  const repo2 = join(ROOT, 'repo-rename')
  const g = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo2, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  }
  mkdirSync(join(repo2, 'public'), { recursive: true })
  g('init', '-q', '-b', 'main')
  writeFileSync(join(repo2, 'public', 'login.js'), Array.from({ length: 20 }, (_, i) => `export const l${i} = ${i}`).join('\n'))
  g('add', '.')
  g('commit', '-qm', 'base')
  g('checkout', '-qb', 'feat')
  mkdirSync(join(repo2, 'auth'))
  g('mv', 'public/login.js', 'auth/login.js')
  g('commit', '-qm', 'move')
  const pick = (force) => {
    const r = run(['--show-config'], { REVIEW_CONFIG: writeConf({ pick: 'first', force }) }, { cwd: repo2 })
    assert.equal(r.status, 0, r.out)
    return JSON.parse(r.stdout)
  }
  const dest = pick([{ paths: ['**/auth/**'], family: 'fable' }])
  assert.equal(dest.selected.family, 'fable')
  assert.match(dest.why, /\(auth\/login\.js\)/)
  assert.equal(pick([{ paths: ['public/**'], family: 'fable' }]).selected.family, 'fable')
  assert.equal(pick([{ paths: ['**/billing/**'], family: 'fable' }]).selected.family, 'opus')
  assert.ok(dest.riskFiles.includes('auth/login.js'))
})

test('an absurd or negative cited line is unverified-quote, and the check terminates', () => {
  const bad = ['9007199254740992', '1'.repeat(310), '-500', '0', '15', 'L2']
  const findings = { findings: bad.map((line) => ({ ...LOOP, issue: `line ${line.slice(0, 12)}`, line })) }
  const r = run([], { REVIEW_REVIEWER: 'codex', STUB_FINDINGS: JSON.stringify(findings) })
  assert.equal(r.signal, null, 'timed out')
  assert.equal(r.status, 0, r.out)
  const out = findingsJson(r.stdout)
  assert.equal(out.findings.length, 0)
  assert.deepEqual(
    out.unverified.map((f) => f.quoteCheck),
    [
      'line 9007199254740992 is outside a.js (1–14)',
      `line ${'1'.repeat(20)}… is outside a.js (1–14)`,
      'line "-500" is not a line number',
      'line 0 is outside a.js (1–14)',
      'line 15 is outside a.js (1–14)',
      'line "L2" is not a line number',
    ],
  )
})

test('review ids are unique; --log-outcome resolves by id or report path, refuses ambiguity', () => {
  const a = run([], { REVIEW_REVIEWER: 'codex' })
  const b = run([], { REVIEW_REVIEWER: 'codex' })
  assert.equal(a.status + b.status, 0, a.out + b.out)
  const [la, lb] = logLines()
  assert.notEqual(la.id, lb.id)
  assert.notEqual(la.dir, lb.dir)
  assert.equal(la.dir, `reviews/${la.id}`)
  // Two legacy entries from different repos in the same second (same folder name).
  appendFileSync(LOG, `${JSON.stringify({ type: 'review', repo: 'alpha', dir: 'reviews/2026-10-14-10-00-00', family: 'sol' })}\n`)
  appendFileSync(LOG, `${JSON.stringify({ type: 'review', repo: 'beta', dir: 'reviews/2026-10-14-10-00-00', family: 'opus' })}\n`)
  const amb = run(['--log-outcome', '2026-10-14-10-00-00', '1', '0'])
  assert.notEqual(amb.status, 0)
  assert.match(amb.stderr, /matches 2 logged reviews .*alpha\/reviews.*beta\/reviews/)
  const full = run(['--log-outcome', '/work/beta/reviews/2026-10-14-10-00-00/code-review.md', '2', '1'])
  assert.equal(full.status, 0, full.out)
  const byId = run(['--log-outcome', join(REPO, lb.dir, 'code-review.md'), '1', '0'])
  assert.equal(byId.status, 0, byId.out)
  const outcomes = logLines().filter((l) => l.type === 'outcome')
  assert.deepEqual(outcomes.map((o) => [o.review, o.repo, o.family, o.confirmed]), [
    ['2026-10-14-10-00-00', 'beta', 'opus', 2],
    [lb.id, basename(REPO), 'sol', 1],
  ])
})

test('effort per reviewer: member effort beats job effort beats the model default', () => {
  const eff = (env) => Object.fromEntries(showConfig(env).cfg.pool.map((m) => [m.family, m.effort]))
  assert.deepEqual(eff({}), { opus: 'high', sol: 'high', grok: 'xhigh', fable: 'high' }, 'no job effort: each model default')
  assert.deepEqual(eff({ STUB_ROLE_EFFORT: 'medium' }), { opus: 'medium', sol: 'medium', grok: 'medium', fable: 'medium' }, 'job effort applies to all')
  const members = JSON.stringify([{ family: 'opus', effort: 'max' }, { family: 'sol', effort: 'low' }, { family: 'grok', effort: '' }, { family: 'fable', effort: '' }])
  assert.deepEqual(eff({ STUB_ROLE_EFFORT: 'medium', STUB_MEMBERS: members }), { opus: 'max', sol: 'low', grok: 'medium', fable: 'medium' }, 'member effort wins; empty falls through')
})
