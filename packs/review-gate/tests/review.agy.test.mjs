#!/usr/bin/env node
/**
 * review.agy.test.mjs — a family on agy (Antigravity, a gemini- id) as a code reviewer: the read-only argv, the
 * "model unverified" label on the reviewer line and in the record, the ~/.gemini/config refusals, the failures agy
 * reports as success, its exclusion from the security pass, REVIEW_AUTHOR=agy, and a REVIEW_MODEL pin that is not a
 * codex model. A stub agy answers in agy 1.5.13's stream-json shape; temp HOME, Git config and PATH; no real model.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'review.mjs')
const ROOT = mkdtempSync(join(tmpdir(), 'review-agy-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), ARGV = join(ROOT, 'argv'), STUBS = join(ROOT, 'stubs'), NODE_BIN = join(ROOT, 'node-bin')
const GITCONFIG = join(ROOT, 'gitconfig')
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

const FINDING = { issue: 'off-by-one in loop', file: 'a.js', line: '2', quote: 'for (let i = 0; i <= n; i++) {}', suggestion: 'use <', likelihood: 5, impact: 5, protected: false, trigger: 'calling f(3)' }
const replyFor = `(schema) => String(schema).includes('"verdicts"') ? '{"verdicts":[]}' : String(schema).includes('"scores"') ? '{"scores":[]}' : ${J(J({ findings: [FINDING] }))}`
// STUB_AGY: ok | status-error | denied-empty | other-model | not-json.
put(join(STUBS, 'agy'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const a = process.argv.slice(2)
const st = fs.fstatSync(0)
fs.writeFileSync(path.join(${J(ARGV)}, 'agy-' + process.pid + '.json'), JSON.stringify({ argv: a, cwd: process.cwd(),
  stdin: st.isCharacterDevice() ? 'chardev' : 'other', cmuxHooksOff: process.env.CMUX_ANTIGRAVITY_HOOKS_DISABLED ?? null }))
const mode = process.env.STUB_AGY || 'ok'
const model = a[a.indexOf('--model') + 1]
const out = (o) => console.log(JSON.stringify(o))
out({ event: 'init', conversation_id: 'c', init: { model: mode === 'other-model' ? 'gemini-other' : model, cwd: process.cwd(), tools: [], permission_mode: 'default' } })
if (mode === 'denied-empty') out({ event: 'step_update', step_update: { state: 'ERROR', step_type: 'tool', tool_name: 'write_file',
  tool_info: { name: 'write_file', error: { type: 'TOOL_ERROR', message: 'permission check failed: Matches user-configured deny rule.' } } } })
const response = mode === 'denied-empty' ? '' : mode === 'not-json' ? 'I looked and it is fine.' : mode === 'clean' ? '{"findings":[]}' : (${replyFor})(a[a.indexOf('--json-schema') + 1])
out({ event: 'result', result: { conversation_id: 'c', status: mode === 'status-error' ? 'ERROR' : 'SUCCESS', response, num_turns: 1 } })
process.exit(mode === 'status-error' ? 1 : 0)
`, 0o755)
// claude and codex: a structured answer, every call recorded.
const model = (name) => `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const a = process.argv.slice(2)
if (a[0] === 'mcp') { console.log('[]'); process.exit(0) }
fs.writeFileSync(path.join(${J(ARGV)}, '${name}-' + process.pid + '.json'), JSON.stringify({ argv: a }))
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema') + 1], 'utf8') : a[a.indexOf('--json-schema') + 1]
const reply = (${replyFor})(schema)
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o') + 1], reply)
else console.log(JSON.stringify({ type: 'result', is_error: false, result: reply, structured_output: JSON.parse(reply) }))
`
for (const name of ['claude', 'codex']) put(join(STUBS, name), model(name), 0o755)
// model-id: STUB_ROLE / STUB_SECURITY ({use, ids}); a family resolves to its id in either, anything else echoes.
put(join(STUBS, 'model-id'), `#!${process.execPath}
const a = process.argv.slice(2)
const roles = { reviewer: JSON.parse(process.env.STUB_ROLE || ${J(J({ use: ['neon', 'opus'], ids: ['gemini-4-neon', 'claude-opus-stub'] }))}),
  security: JSON.parse(process.env.STUB_SECURITY || ${J(J({ use: ['opus'], ids: ['claude-opus-stub'] }))}) }
const ids = Object.fromEntries(Object.values(roles).flatMap((r) => r.use.map((f, i) => [f, r.ids[i]])))
if (a[0] === '--role') console.log(JSON.stringify({ role: a[1], use: roles[a[1]].use, ids: roles[a[1]].ids }))
else if (a[0] === '--flavor') console.log(JSON.stringify({ family: a[1], flavor: { effort: 'high', likes: [], quirks: [] } }))
else console.log(ids[a[0]] || a[0])
`, 0o755)

const PATH = [STUBS, NODE_BIN, ...SYSTEM].join(':')
const env = (extra = {}) => ({ HOME, PATH, TMPDIR: ROOT, REVIEW_BASE: 'main', GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: '1', ...extra })
function run(args, extra = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, env: env(extra), encoding: 'utf8', timeout: 60_000 })
  return { ...r, out: `${r.stdout}\n${r.stderr}` }
}
const git = (...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: REPO, env: env(), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}
const calls = (name) => readdirSync(ARGV).filter((f) => f.startsWith(`${name}-`)).map((f) => JSON.parse(readFileSync(join(ARGV, f), 'utf8')))
const logLines = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [])
const findingsJson = (r) => JSON.parse(r.stdout.split('===FINDINGS_JSON===')[1])
const gemini = (files) => { for (const [name, text] of Object.entries(files)) put(join(HOME, '.gemini/config', name), text) }
const DENY = J({ permissions: { deny: ['command(*)', 'write_file(*)', 'mcp(*)', 'read_url(*)'] } })

beforeEach(() => {
  for (const path of [HOME, REPO, ARGV, GITCONFIG]) rmSync(path, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true }); mkdirSync(ARGV); mkdirSync(REPO)
  writeFileSync(GITCONFIG, '')
  git('init', '-q', '-b', 'main')
  writeFileSync(join(REPO, 'a.js'), 'export const f = (n) => n\n')
  git('add', '.'); git('commit', '-qm', 'base')
  git('checkout', '-qb', 'feat')
  writeFileSync(join(REPO, 'a.js'), 'export const f = (n) => {\n  for (let i = 0; i <= n; i++) {}\n  return n\n}\n')
  git('add', '.'); git('commit', '-qm', 'change')
})

test('agy reviews read-only: the deny list, stream-json, a schema, a per-call log, /dev/null stdin and cmux hooks off', () => {
  const r = run([], { REVIEW_REVIEWER: 'neon' })
  assert.equal(r.status, 0, r.out)
  const [call] = calls('agy')
  assert.ok(call, r.out)
  const a = call.argv
  const at = (flag) => a[a.indexOf(flag) + 1]
  assert.deepEqual([a[0], at('--model'), at('--effort'), at('--output-format'), at('--print-timeout'), at('--settings')],
    ['-p', 'gemini-4-neon', 'high', 'stream-json', '3600s', DENY])
  assert.ok(a.includes('--disable-slash-commands'), a.join(' '))
  assert.ok(JSON.parse(at('--json-schema')).properties?.findings, 'the findings schema')
  assert.equal(dirname(at('--log-file')), join(HOME, '.agent-config-studio/logs/agy'))
  assert.deepEqual([call.stdin, call.cmuxHooksOff], ['chardev', '1'])
  assert.equal(call.cwd, git('rev-parse', '--show-toplevel'))
  assert.match(a[1], /Running commands, writing files, MCP tools and reading URLs are all denied/, 'the agy tool note')
  assert.equal(calls('codex').length + calls('claude').length, 0, 'no other CLI ran')
})

test('agy reviews are labelled model unverified: the reviewer line, the report, FINDINGS_JSON and the record', () => {
  const r = run([], { REVIEW_REVIEWER: 'neon' })
  assert.equal(r.status, 0, r.out)
  assert.match(r.stdout, /▶ reviewer · neon \(agy · gemini-4-neon · high · model unverified\)/)
  assert.match(r.stderr, /agy review: model unverified \(agy names only the model it was asked for, gemini-4-neon\); its log: /)
  const json = findingsJson(r)
  assert.equal(json.reviewer, 'agy-gemini-4-neon-high (model unverified)')
  const record = logLines().find((e) => e.type === 'review')
  assert.deepEqual([record.vendor, record.family, record.model, record.modelUsed, record.modelVerified], ['agy', 'neon', 'gemini-4-neon', 'gemini-4-neon', false])
  assert.equal(record.findings, 1)
  const report = readFileSync(join(REPO, record.dir, 'code-review.md'), 'utf8')
  assert.match(report, /^Reviewer: agy-gemini-4-neon-high \(model unverified\)$/m)
})

test('a Neon review counts toward a close, and the close names it model unverified', () => {
  const r = run([], { REVIEW_REVIEWER: 'neon', STUB_AGY: 'clean' })
  assert.equal(r.status, 0, r.out)
  const id = findingsJson(r).reviewId
  const statuses = join(ROOT, 'statuses.json')
  writeFileSync(statuses, '{}')
  const c = run(['--close', id, '--status', statuses, '--test-cmd', 'true'])
  assert.equal(c.status, 0, c.out)
  const close = logLines().at(-1)
  assert.equal(close.review, id)
  const summary = run(['--summary'])
  assert.match(summary.out, /Reviewer: neon \(gemini-4-neon\) — model unverified/)
})

test('another family\'s review carries no modelVerified field', () => {
  const r = run([], { REVIEW_REVIEWER: 'opus' })
  assert.equal(r.status, 0, r.out)
  const record = logLines().find((e) => e.type === 'review')
  assert.equal(record.vendor, 'claude')
  assert.equal(Object.hasOwn(record, 'modelVerified'), false)
  assert.doesNotMatch(r.stdout, /model unverified/)
})

test('a failed agy turn fails the review and logs none: a bad status, an empty answer after a denial, another model, an answer that is not JSON', () => {
  for (const [mode, pattern] of [
    ['status-error', /agy review failed \(exit 1, status ERROR\)/],
    ['denied-empty', /agy review: empty answer after its deny list refused 1 tool call/],
    ['other-model', /asked for gemini-4-neon, but agy reports it was asked for gemini-other/],
    ['not-json', /agy review: the answer is not JSON/],
  ]) {
    const r = run([], { REVIEW_REVIEWER: 'neon', STUB_AGY: mode })
    assert.notEqual(r.status, 0, `${mode}: ${r.out}`)
    assert.match(r.out, pattern, mode)
    assert.equal(logLines().filter((e) => e.type === 'review').length, 0, `${mode}: no review logged`)
  }
  const denied = run([], { REVIEW_REVIEWER: 'neon', STUB_AGY: 'denied-empty' })
  assert.match(denied.stderr, /⚠ agy review: denied write_file: permission check failed/)
})

test('~/.gemini/config: an MCP server or a hook that is not cmux\'s refuses agy before it runs; cmux\'s own hooks and an empty server list do not', () => {
  const refusals = [
    [{ 'mcp_config.json': J({ mcpServers: { probe: { command: 'sh' } } }) }, /agy review refused: .*mcp_config\.json configures MCP servers \(probe\)/],
    [{ 'hooks.json': J({ mine: { SessionStart: [{ type: 'command', command: 'touch x' }] } }) }, /agy review refused: .*hooks\.json has hooks that are not cmux's \(mine\.SessionStart\)/],
    [{ 'hooks.json': '{' }, /agy review refused: .*hooks\.json is not JSON/],
  ]
  for (const [files, pattern] of refusals) {
    rmSync(join(HOME, '.gemini'), { recursive: true, force: true })
    gemini(files)
    const r = run([], { REVIEW_REVIEWER: 'neon' })
    assert.notEqual(r.status, 0, r.out)
    assert.match(r.out, pattern)
    assert.equal(calls('agy').length, 0, 'agy never ran')
  }
  rmSync(join(HOME, '.gemini'), { recursive: true, force: true })
  gemini({ 'mcp_config.json': J({ mcpServers: {} }), 'hooks.json': J({ cmux: { Stop: [{ type: 'command', command: ': cmux-antigravity-hook-v2; true' }],
    PreToolUse: [{ matcher: '*', hooks: [{ command: ': cmux-antigravity-hook-v2; true' }] }] } }) })
  const ok = run([], { REVIEW_REVIEWER: 'neon' })
  assert.equal(ok.status, 0, ok.out)
  assert.equal(calls('agy').length >= 1, true)
})

test('agy never runs the security pass: a pinned agy family refuses, a role of agy families only refuses, and agy members are skipped', () => {
  const pinned = run(['--security-only'], { REVIEW_SECURITY_REVIEWER: 'neon' })
  assert.notEqual(pinned.status, 0, pinned.out)
  assert.match(pinned.out, /REVIEW_SECURITY_REVIEWER=neon runs on agy, which never runs the security pass: agy keeps web search on/)
  const only = run(['--security-only'], { STUB_SECURITY: J({ use: ['neon'], ids: ['gemini-4-neon'] }) })
  assert.notEqual(only.status, 0, only.out)
  assert.match(only.out, /security role: every usable member runs on agy \(neon\), which never runs the security pass/)
  assert.equal(calls('agy').length, 0, 'agy never ran')
  const mixed = run(['--security-only'], { STUB_SECURITY: J({ use: ['neon', 'opus'], ids: ['gemini-4-neon', 'claude-opus-stub'] }) })
  assert.equal(mixed.status, 0, mixed.out)
  assert.equal(calls('agy').length, 0, 'the agy member was skipped')
  assert.ok(calls('claude').length >= 1, 'opus ran the check')
})

test('a security worker job naming an agy member refuses before any CLI runs', () => {
  const job = join(ROOT, 'agy-job.json'), result = join(ROOT, 'agy-result.json')
  writeFileSync(job, J({ member: { family: 'neon', vendor: 'agy', id: 'gemini-4-neon', effort: 'high' }, result, diff: 'diff --git a/a.js b/a.js', paths: ['a.js'] }))
  const r = run(['--security-worker', job])
  assert.notEqual(r.status, 0, r.out)
  const out = JSON.parse(readFileSync(result, 'utf8'))
  assert.equal(out.ok, false)
  assert.match(out.error, /agy cannot run the security pass/)
  assert.equal(calls('agy').length, 0)
})

test('REVIEW_AUTHOR=agy is not a vendor alias: the author is unknown, with a note to name the family', () => {
  const r = run(['--show-config'], { REVIEW_AUTHOR: 'agy', STUB_ROLE: J({ use: ['neon', 'opus'], ids: ['gemini-4-neon', 'claude-opus-stub'] }) })
  assert.equal(r.status, 0, r.out)
  const notes = JSON.parse(r.stdout).notes.join('\n')
  assert.match(notes, /author "agy" names the Antigravity CLI, not the model that wrote the branch — treated as unknown; set REVIEW_AUTHOR to the family/)
  assert.match(notes, /author unknown — crossFamily not applied/)
})

test('REVIEW_AUTHOR=neon is a family: crossFamily skips the agy reviewer', () => {
  const r = run(['--show-config'], { REVIEW_AUTHOR: 'neon', STUB_ROLE: J({ use: ['neon', 'opus'], ids: ['gemini-4-neon', 'claude-opus-stub'] }) })
  assert.equal(r.status, 0, r.out)
  assert.equal(JSON.parse(r.stdout).selected.family, 'opus')
})

test('a REVIEW_MODEL pin that is not a codex model stops naming its CLI; it never runs on codex', () => {
  const config = join(ROOT, 'pin-config.json')
  writeFileSync(config, J({ model: 'neon' }))
  for (const [extra, pattern] of [
    [{ REVIEW_MODEL: 'neon' }, /REVIEW_MODEL=neon resolves to "gemini-4-neon", which is not a codex model \(it runs on agy\)/],
    [{ REVIEW_MODEL: 'claude-opus-stub' }, /REVIEW_MODEL=claude-opus-stub resolves to "claude-opus-stub", which is not a codex model \(it runs on claude\)/],
    [{ REVIEW_MODEL: 'grok-4.7' }, /which is not a codex model \(it runs on grok\)/],
    [{ REVIEW_REVIEWER: 'codex', REVIEW_MODEL: 'gemini-4-neon' }, /REVIEW_MODEL=gemini-4-neon resolves to "gemini-4-neon", which is not a codex model/],
    [{ REVIEW_CONFIG: config }, /config "model"=neon resolves to "gemini-4-neon", which is not a codex model/],
  ]) {
    for (const args of [[], ['--show-config']]) {
      const r = run(args, extra)
      assert.notEqual(r.status, 0, r.out)
      assert.match(r.stderr, pattern)
      assert.match(r.stderr, /name that family with REVIEW_REVIEWER=<family> instead/)
    }
  }
  for (const name of ['agy', 'codex', 'claude']) assert.equal(calls(name).length, 0, `${name} never ran`)
  assert.equal(logLines().length, 0)
})

test('REVIEW_REVIEWER=gemini stays unknown (the family is neon), with the error text unchanged', () => {
  const r = run([], { REVIEW_REVIEWER: 'gemini' })
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.stderr, /must be codex, claude, grok, or a reviewer family/)
  assert.equal(calls('agy').length, 0)
})
