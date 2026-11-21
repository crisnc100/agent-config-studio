#!/usr/bin/env node
/**
 * review.agy.test.mjs — a family on agy (Antigravity, a gemini- id) as a code reviewer: the read-only argv, the
 * "model unverified" label on the reviewer line and in the record, the ~/.gemini/config refusals, the failures agy
 * reports as success, its exclusion from the security pass, REVIEW_AUTHOR=agy, and a REVIEW_MODEL pin that is not a
 * codex model. A stub agy answers in agy 1.5.13's stream-json shape; temp HOME, Git config and PATH; no real model.
 * On macOS the stub runs inside the real sandbox-exec wall, as agy does, so this file must run from a shell outside any
 * sandbox. Elsewhere a review that passes every check is refused at the wall (reached()), and the tests that need agy's
 * answer are skipped.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
// STUB_AGY: ok | status-error | denied-empty | approval-denied | other-model | not-json | clean | retry | token-file.
// STUB_AGY_VERSION overrides what --version prints; STUB_AGY_VERSION=fail exits 1. STUB_PEEK: paths (joined by \n) the
// stub tries to read, recording each result. The saved subagent run is written into the stub: inside the wall it
// cannot read this checkout.
const SUBAGENT_STREAM = readFileSync(join(dirname(SCRIPT), '..', '..', '..', 'tests', 'fixtures', 'agy-subagent', 'stream.jsonl'), 'utf8')
put(join(STUBS, 'agy'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const a = process.argv.slice(2)
if (a[0] === '--version') {
  fs.writeFileSync(path.join(${J(ARGV)}, 'version-' + process.pid + '.json'), JSON.stringify({ cwd: process.cwd(), entries: fs.readdirSync(process.cwd()) }))
  if (process.env.STUB_AGY_VERSION === 'fail') process.exit(1); console.log(process.env.STUB_AGY_VERSION || '1.5.14'); process.exit(0)
}
const st = fs.fstatSync(0)
const peek = {}
for (const p of (process.env.STUB_PEEK || '').split('\\n').filter(Boolean)) { try { peek[p] = fs.readFileSync(p, 'utf8') } catch (e) { peek[p] = e.code } }
fs.writeFileSync(path.join(${J(ARGV)}, 'agy-' + process.pid + '.json'), JSON.stringify({ argv: a, cwd: process.cwd(),
  stdin: st.isCharacterDevice() ? 'chardev' : 'other', cmuxHooksOff: process.env.CMUX_ANTIGRAVITY_HOOKS_DISABLED ?? null,
  autoUpdateOff: process.env.AGY_CLI_DISABLE_AUTO_UPDATE ?? null, tmpdir: process.env.TMPDIR ?? null,
  tmpdirExists: !!process.env.TMPDIR && fs.existsSync(process.env.TMPDIR), peek }))
const mode = process.env.STUB_AGY || 'ok'
if (mode === 'token-file') fs.appendFileSync(a[a.indexOf('--log-file') + 1], 'W1121 keyring.go] Using file-based token storage because a keyring timeout was recorded within the last 1h0m0s\\n')
const model = a[a.indexOf('--model') + 1]
const out = (o) => console.log(JSON.stringify(o))
out({ event: 'init', conversation_id: 'c', init: { model: mode === 'other-model' ? 'gemini-other' : model, cwd: process.cwd(), tools: [], permission_mode: 'default' } })
if (mode === 'denied-empty') out({ event: 'step_update', step_update: { state: 'ERROR', step_type: 'tool', tool_name: 'write_file',
  tool_info: { name: 'write_file', error: { type: 'TOOL_ERROR', message: 'permission check failed: Matches user-configured deny rule.' } } } })
if (mode === 'retry') {
  // As agy 1.5.13 did on a real case: an answer its finish tool refused, a system message, then the corrected answer;
  // result.response holds both texts on two lines.
  const first = JSON.stringify({ findings: [] }), final = (${replyFor})(a[a.indexOf('--json-schema') + 1])
  out({ event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: first.slice(0, 5) } })
  out({ event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: first.slice(5) } })
  out({ event: 'step_update', step_update: { step_index: 4, state: 'ERROR', step_type: 'finish' } })
  out({ event: 'step_update', step_update: { step_index: 5, state: 'DONE', step_type: 'system_message' } })
  out({ event: 'step_update', step_update: { step_index: 6, state: 'DONE', step_type: 'agent_response', text_delta: final + '\\n' } })
  out({ event: 'step_update', step_update: { step_index: 7, state: 'DONE', step_type: 'agent_response', text_delta: '' } })
  out({ event: 'result', result: { status: 'SUCCESS', response: first + '\\n' + final + '\\n' } })
  process.exit(0)
}
if (mode === 'subagent') {
  // The saved agy 1.5.13 subagent run's own steps, its transcript path moved under this HOME.
  const saved = ${J(SUBAGENT_STREAM)}.trim().split('\\n')
  for (const l of saved) if (/"subagent_info"/.test(l)) console.log(l.replaceAll('file:///Users/someone/', 'file://' + process.env.HOME + '/'))
}
if (mode === 'approval-denied') {
  out({ event: 'result', result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'read_file', display_name: 'ReadFile' }] } })
  process.exit(0)
}
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
// cmux's hook command as it writes it into ~/.gemini/config/hooks.json (socket path and event left open).
const CMUX_TEMPLATE = readFileSync(join(dirname(SCRIPT), '..', '..', '..', 'tests', 'fixtures', 'cmux-antigravity-hook.txt'), 'utf8').trim()
const cmuxCommand = (event, sock = '/Users/someone/.local/state/cmux/cmux.sock') => CMUX_TEMPLATE.replaceAll('<SOCK>', sock).replaceAll('<EVENT>', event)
const DENY = J({ permissions: { deny: ['command(*)', 'write_file(*)', 'mcp(*)', 'read_url(*)', 'download_url(*)', 'execute_url(*)'] } })
// sandbox-exec is macOS only. Elsewhere a review that passes every check reaches the wall and is refused there.
const WALLED = process.platform === 'darwin'
const WALL_REFUSAL = /agy review refused: agy runs only inside its macOS sandbox \(sandbox-exec\), and this is \w+/
const macTest = (name, fn) => test(name, { skip: !WALLED && 'agy runs only inside sandbox-exec, which is macOS only' }, fn)
// A review that passed every check before the wall: on macOS it ran; elsewhere the wall refused it, agy never started.
function reached(r, what = 'the review') {
  if (WALLED) return assert.equal(r.status, 0, `${what}: ${r.out}`)
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, WALL_REFUSAL, what)
  assert.equal(calls('agy').length, 0, `${what}: agy never started`)
}
if (WALLED) {
  const nested = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { encoding: 'utf8' })
  assert.equal(nested.status, 0, `sandbox-exec must run here; run this file from a shell outside any sandbox (exit ${nested.status}: ${nested.stderr})`)
}

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

macTest('agy reviews read-only: the deny list, stream-json, a schema, a per-call log, /dev/null stdin and cmux hooks off', () => {
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

test('off macOS an agy review is refused at the wall, agy never started', { skip: WALLED && 'this is macOS' }, () => {
  const r = run([], { REVIEW_REVIEWER: 'neon' })
  reached(r)
  assert.equal(logLines().filter((e) => e.type === 'review').length, 0)
})

macTest('an agy review runs inside the wall: the reviewed tree is readable, the temp folder beside it and HOME are not', () => {
  const outside = join(ROOT, 'outside', 'secret.txt'), key = join(HOME, '.ssh', 'id_ed25519')
  put(outside, 'token:outside'); put(key, 'token:key')
  const r = run([], { REVIEW_REVIEWER: 'neon', STUB_PEEK: [outside, key, join(REPO, 'a.js')].join('\n') })
  assert.equal(r.status, 0, r.out)
  const [call] = calls('agy')
  assert.deepEqual([call.peek[outside], call.peek[key]], ['EPERM', 'EPERM'])
  assert.match(call.peek[join(REPO, 'a.js')], /export const f/)
  assert.equal(call.autoUpdateOff, 'true', 'agy\'s updater is switched off')
  assert.equal(call.tmpdirExists, true)
  assert.match(call.tmpdir, /\/acs-agy-call-[^/]+$/, 'a TMPDIR of its own')
  assert.equal(existsSync(call.tmpdir), false, 'removed after the review')
  rmSync(join(ROOT, 'outside'), { recursive: true, force: true })
})

macTest('a dispute verifier on agy reads the snapshot clone it judges, not the checkout the review ran in', () => {
  const pool = J({ use: ['opus', 'neon'], ids: ['claude-opus-stub', 'gemini-4-neon'] })
  const r = run([], { REVIEW_REVIEWER: 'opus', STUB_ROLE: pool })
  assert.equal(r.status, 0, r.out)
  const record = logLines().find((e) => e.type === 'review')
  const d = run(['--dispute', record.id, 'f1', '--reason', 'intended behavior', '--evidence', 'a.js:2'], { STUB_ROLE: pool, STUB_PEEK: join(REPO, 'a.js') })
  assert.equal(d.status, 0, d.out)
  const [call] = calls('agy')
  assert.match(call.cwd, /\/snapshot$/, 'it runs in the snapshot')
  assert.equal(call.peek[join(REPO, 'a.js')], 'EPERM', 'the checkout is outside its read root')
})

macTest('a review from HOME, or a folder holding it, is refused: the wall would keep nothing out', () => {
  const r = run([], { REVIEW_REVIEWER: 'neon', HOME: REPO })
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /agy review refused: agy would read .*, which is your home folder or holds it/)
  assert.equal(calls('agy').length, 0)
})

macTest('a review whose agy log says it kept the sign-in token in a file fails and logs none', () => {
  const r = run([], { REVIEW_REVIEWER: 'neon', STUB_AGY: 'token-file' })
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /agy review failed: agy switched to keeping its Google sign-in token in a file .*"file-based token storage"/)
  assert.match(r.out, /If \/.*\/home\/\.gemini\/antigravity-cli\/antigravity-oauth-token now exists, delete it: agy signs in from the keychain without it/)
  assert.doesNotMatch(r.out, /check what it wrote/)
  assert.equal(logLines().filter((e) => e.type === 'review').length, 0)
})

test('a plaintext token file left by agy refuses the review before agy runs, naming the file and the fix', () => {
  const file = join(HOME, '.gemini/antigravity-cli/antigravity-oauth-token')
  put(file, '{"token":"x"}')
  const r = run([], { REVIEW_REVIEWER: 'neon' })
  assert.notEqual(r.status, 0, r.out)
  assert.ok(r.out.includes(`agy review refused: ${file} holds agy's Google sign-in token in plain text`), r.out)
  assert.match(r.out, /; delete it: agy signs in from the keychain without it \(if it then asks you to sign in, run agy once and sign in\)/)
  assert.equal(calls('agy').length, 0)
  assert.equal(logLines().filter((e) => e.type === 'review').length, 0)
})

macTest('agy reviews are labelled model unverified: the reviewer line, the report, FINDINGS_JSON and the record', () => {
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

macTest('a Neon review counts toward a close, and the close names it model unverified', () => {
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

macTest('the answer is agy\'s last response turn, not result.response, which joins a refused answer and its retry', () => {
  const r = run([], { REVIEW_REVIEWER: 'neon', STUB_AGY: 'retry' })
  assert.equal(r.status, 0, r.out)
  assert.equal(logLines().find((e) => e.type === 'review').findings, 1, 'the final answer\'s one finding, not the first empty list')
})

test('another family\'s review carries no modelVerified field', () => {
  const r = run([], { REVIEW_REVIEWER: 'opus' })
  assert.equal(r.status, 0, r.out)
  const record = logLines().find((e) => e.type === 'review')
  assert.equal(record.vendor, 'claude')
  assert.equal(Object.hasOwn(record, 'modelVerified'), false)
  assert.doesNotMatch(r.stdout, /model unverified/)
})

macTest('a failed agy turn fails the review and logs none: a bad status, an empty answer after a denial, another model, an answer that is not JSON', () => {
  for (const [mode, pattern] of [
    ['status-error', /agy review failed \(exit 1, status ERROR\)/],
    ['denied-empty', /agy review: empty answer after 1 denied tool call/],
    ['approval-denied', /agy review: empty answer after 1 denied tool call/],
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
  const unapproved = run([], { REVIEW_REVIEWER: 'neon', STUB_AGY: 'approval-denied' })
  assert.match(unapproved.stderr, /⚠ agy review: denied read_file: needed an approval print mode cannot give/)
})

test('agy runs only on the version its containment was probed on', () => {
  for (const [version, shown] of [['1.6.0', '"1.6.0"'], ['fail', 'null']]) {
    const r = run([], { REVIEW_REVIEWER: 'neon', STUB_AGY_VERSION: version })
    assert.notEqual(r.status, 0, r.out)
    assert.match(r.out, new RegExp(`agy review refused: agy reports version ${shown}, but its containment was probed on 1\\.5\\.14; re-run the probe`))
    assert.equal(calls('agy').length, 0, 'agy never ran a review')
    assert.equal(logLines().filter((e) => e.type === 'review').length, 0)
  }
})

test('a workspace customization agy would run, from the cwd up to the filesystem root, refuses agy before it runs', () => {
  const OUTER = dirname(REPO)
  const planted = [[REPO, '.agents', 'hooks.json'], [REPO, '.agent', 'mcp_config.json'], [OUTER, '_agents', 'plugins.json'], [REPO, '_agent', 'agents.json'], [REPO, '.agents', 'plugins', 'p.json']]
  for (const [at, dir, ...rest] of planted) {
    const p = join(at, dir, ...rest)
    put(p, '{}')
    const r = run([], { REVIEW_REVIEWER: 'neon' })
    rmSync(join(at, dir), { recursive: true, force: true })
    assert.notEqual(r.status, 0, r.out)
    assert.match(r.out, /agy review refused: .*agy runs a workspace's hooks, MCP servers, plugins and agents on every call/)
    assert.ok(r.out.includes(join(realpathSync(at), dir, rest[0])), `${p} is named: ${r.out}`)
    assert.equal(calls('agy').length, 0, 'agy never ran a review')
  }
  put(join(REPO, '.agents', 'rules', 'r.md'), 'text')
  const ok = run([], { REVIEW_REVIEWER: 'neon' })
  rmSync(join(REPO, '.agents'), { recursive: true, force: true })
  reached(ok, 'rules the model reads do not refuse')
})

test('~/.gemini/config plugins refuse agy: a plugin in plugins/ or a plugins.json; an empty plugins folder does not', () => {
  put(join(HOME, '.gemini/config/plugins/p/plugin.json'), '{}')
  const dirPlugin = run([], { REVIEW_REVIEWER: 'neon' })
  assert.notEqual(dirPlugin.status, 0, dirPlugin.out)
  assert.match(dirPlugin.out, /agy review refused: .*config\/plugins holds plugins/)
  rmSync(join(HOME, '.gemini'), { recursive: true, force: true })
  gemini({ 'plugins.json': '{}' })
  const json = run([], { REVIEW_REVIEWER: 'neon' })
  assert.notEqual(json.status, 0, json.out)
  assert.match(json.out, /agy review refused: .*plugins\.json declares plugins/)
  assert.equal(calls('agy').length, 0)
  rmSync(join(HOME, '.gemini'), { recursive: true, force: true })
  mkdirSync(join(HOME, '.gemini/config/plugins'), { recursive: true })
  gemini({ 'mcp_config.json': '' })
  const empty = run([], { REVIEW_REVIEWER: 'neon' })
  reached(empty, 'an empty plugins folder and a zero-length mcp_config.json run')
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
  gemini({ 'mcp_config.json': J({ mcpServers: {} }), 'hooks.json': J({ cmux: { Stop: [{ type: 'command', command: cmuxCommand('stop') }],
    PreToolUse: [{ matcher: '*', hooks: [{ command: cmuxCommand('stop') }] }] } }) })
  const ok = run([], { REVIEW_REVIEWER: 'neon' })
  reached(ok)
  if (WALLED) assert.equal(calls('agy').length >= 1, true)
})

test('a home hook passes only as cmux\'s unchanged command: the marker alone, or cmux\'s command with more added, refuses', () => {
  for (const command of [': cmux-antigravity-hook-v2; true', `${cmuxCommand('stop')}; touch x`, cmuxCommand('stop', "/tmp/a'; touch x; '")]) {
    rmSync(join(HOME, '.gemini'), { recursive: true, force: true })
    gemini({ 'hooks.json': J({ cmux: { Stop: [{ type: 'command', command }] } }) })
    const r = run([], { REVIEW_REVIEWER: 'neon' })
    assert.notEqual(r.status, 0, r.out)
    assert.match(r.out, /agy review refused: .*hooks\.json has hooks that are not cmux's \(cmux\.Stop\)/)
    assert.equal(calls('agy').length, 0, 'agy never ran')
  }
  rmSync(join(HOME, '.gemini'), { recursive: true, force: true })
  gemini({ 'hooks.json': J({ cmux: { Stop: [{ type: 'command', command: cmuxCommand('stop'), timeout: 10 }], SessionStart: [{ type: 'command', command: cmuxCommand('session-start') }] } }) })
  const ok = run([], { REVIEW_REVIEWER: 'neon' })
  reached(ok)
})

test('a foreign handler grouped under a tool hook refuses agy, beside cmux\'s own grouped handler', () => {
  gemini({ 'hooks.json': J({ cmux: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmuxCommand('stop') }, { type: 'command', command: 'touch x' }] }] } }) })
  const r = run([], { REVIEW_REVIEWER: 'neon' })
  assert.notEqual(r.status, 0, r.out)
  assert.match(r.out, /agy review refused: .*hooks\.json has hooks that are not cmux's \(cmux\.PreToolUse\)/)
  assert.equal(calls('agy').length, 0, 'agy never ran')
})

const TRANSCRIPT = readFileSync(join(dirname(SCRIPT), '..', '..', '..', 'tests', 'fixtures', 'agy-subagent', 'transcript.jsonl'), 'utf8')
const SUB_ID = '7239ab1f-70aa-4146-a081-4d09347c094a'
macTest('denials inside a subagent (its transcript, not the parent stream) are reported on stderr; the review still succeeds', () => {
  put(join(HOME, '.gemini/antigravity-cli/brain', SUB_ID, '.system_generated/logs/transcript.jsonl'), TRANSCRIPT)
  const r = run([], { REVIEW_REVIEWER: 'neon', STUB_AGY: 'subagent' })
  assert.equal(r.status, 0, r.out)
  const lines = r.stderr.split('\n').filter((l) => l.startsWith('⚠ agy review: denied (subagent perm-test-subagent)'))
  assert.equal(lines.length, 2, r.stderr)
  assert.match(lines[0], /Permission denied for command\(touch .*Matches user-configured deny rule/)
  assert.match(lines[1], /Permission denied for write_file\(.*Matches user-configured deny rule/)
  assert.equal(logLines().filter((e) => e.type === 'review').length, 1)
})

macTest('a subagent with no transcript is named as one the wall stops; one outside agy\'s brain folder is not read and is named as unknown', () => {
  const r = run([], { REVIEW_REVIEWER: 'neon', STUB_AGY: 'subagent' })
  assert.equal(r.status, 0, r.out)
  assert.match(r.stderr, /^⚠ agy review: neon tried to start a subagent \(perm-test-subagent\); subagents can't run inside the sandbox wall$/m)
  assert.doesNotMatch(r.stderr, /transcript could not be read|⚠ agy review: denied/)
  assert.equal(logLines().filter((e) => e.type === 'review').length, 1)
  const outside = join(ROOT, 'elsewhere', SUB_ID, '.system_generated/logs/transcript.jsonl')
  put(outside, TRANSCRIPT)
  mkdirSync(join(HOME, '.gemini/antigravity-cli/brain', SUB_ID, '.system_generated/logs'), { recursive: true })
  symlinkSync(outside, join(HOME, '.gemini/antigravity-cli/brain', SUB_ID, '.system_generated/logs/transcript.jsonl'))
  const linked = run([], { REVIEW_REVIEWER: 'neon', STUB_AGY: 'subagent' })
  assert.equal(linked.status, 0, linked.out)
  assert.match(linked.stderr, /transcript is not in agy's brain folder, so it was not read/)
  assert.doesNotMatch(linked.stderr, /denied \(subagent/)
})

macTest('agy denials inside eval cases and slices reach the parent\'s stderr, and an eval case counts them', () => {
  put(join(HOME, '.gemini/antigravity-cli/brain', SUB_ID, '.system_generated/logs/transcript.jsonl'), TRANSCRIPT)
  const cases = join(dirname(SCRIPT), 'eval', 'examples')
  const e = run(['--eval', '--family', 'neon', '--cases', cases, '--yes'], { STUB_AGY: 'subagent' })
  assert.equal(e.status, 0, e.out)
  const forwarded = e.stderr.split('\n').filter((l) => / {2}[\w-]+: ⚠ agy review: denied \(subagent perm-test-subagent\)/.test(l))
  assert.equal(forwarded.length, 4, `two cases × two denials on stderr: ${e.stderr}`)
  assert.match(e.stdout, /^ {2}example-clean-helper \[clean\] .*\b2 denied tool calls · [\d.]+s$/m)
  const records = JSON.parse(e.stdout.split('===EVAL_JSON===')[1])
  assert.deepEqual(records[0].cases.map((c) => c.denied), [2, 2])
  const s = run(['--slices', 'a.js'], { REVIEW_REVIEWER: 'neon', STUB_AGY: 'subagent' })
  assert.equal(s.status, 0, s.out)
  assert.equal(s.stderr.split('\n').filter((l) => l.startsWith('slice 1/1: ⚠ agy review: denied (subagent perm-test-subagent)')).length, 2, s.stderr)
})

macTest('in an eval, a subagent the wall stopped is passed on as a note, not counted as a denied call or an error', () => {
  const cases = join(dirname(SCRIPT), 'eval', 'examples')
  const e = run(['--eval', '--family', 'neon', '--cases', cases, '--yes'], { STUB_AGY: 'subagent' })
  assert.equal(e.status, 0, e.out)
  const notes = e.stderr.split('\n').filter((l) => / {2}[\w-]+: ⚠ agy review: neon tried to start a subagent \(perm-test-subagent\); subagents can't run inside the sandbox wall$/.test(l))
  assert.equal(notes.length, 2, `one note per case: ${e.stderr}`)
  const records = JSON.parse(e.stdout.split('===EVAL_JSON===')[1])
  assert.deepEqual(records[0].cases.map((c) => [c.outcome === 'errored', c.denied ?? 0]), [[false, 0], [false, 0]], J(records[0].cases))
})

test('a Grade or recheck from an agy model is recorded and shown model unverified, whatever its verdict file says', () => {
  const verdict = (extra = {}) => ({ family: 'neon', model: 'gemini-4-neon', criteria: [
    { id: '1', criterion: 'Works', verdict: 'FAIL', evidence: 'test fails' }], ...extra })
  const file = join(ROOT, 'verdict.json')
  writeFileSync(file, J(verdict()))
  const g = run(['--log-grade', file])
  assert.equal(g.status, 0, g.out)
  assert.match(g.stdout, /ℹ grade by neon \(gemini-4-neon\) — model unverified/)
  const grade = logLines().at(-1)
  assert.equal(grade.kind, 'grade')
  assert.equal(grade.vendor, 'agy')
  assert.equal(grade.modelVerified, false)
  writeFileSync(file, J(verdict({ vendor: 'claude' })))
  const claimed = run(['--log-grade', file])
  assert.equal(claimed.status, 0, claimed.out)
  assert.equal(logLines().at(-1).modelVerified, false, 'a gemini- model is agy whatever vendor the file claims')
  writeFileSync(file, J({ ...verdict(), criteria: [{ id: '1', criterion: 'Works', verdict: 'PASS', evidence: 'test passes' }] }))
  const re = run(['--log-grade', file, '--recheck-of', grade.id])
  assert.equal(re.status, 0, re.out)
  assert.match(re.stdout, /ℹ recheck by neon \(gemini-4-neon\) — model unverified/)
  assert.equal(logLines().at(-1).kind, 'recheck')
  assert.equal(logLines().at(-1).modelVerified, false)
  writeFileSync(file, J({ family: 'opus', model: 'claude-opus-stub', criteria: [{ id: '1', criterion: 'Works', verdict: 'PASS', evidence: 'ok' }] }))
  const other = run(['--log-grade', file])
  assert.equal(other.status, 0, other.out)
  assert.equal(Object.hasOwn(logLines().at(-1), 'modelVerified'), false)
  assert.doesNotMatch(other.stdout, /model unverified/)
})

test('custom agents (an agents/ folder in any of the four workspace folders) refuse agy', () => {
  for (const dir of ['.agents', '.agent', '_agents', '_agent']) {
    mkdirSync(join(REPO, dir, 'agents'), { recursive: true })
    writeFileSync(join(REPO, dir, 'agents', 'x.md'), '---\nname: x\n---\n# x\n')
    const r = run([], { REVIEW_REVIEWER: 'neon' })
    rmSync(join(REPO, dir), { recursive: true, force: true })
    assert.notEqual(r.status, 0, r.out)
    assert.ok(r.out.includes(join(realpathSync(REPO), dir, 'agents')), r.out)
    assert.equal(calls('agy').length, 0, 'agy never ran')
  }
})

test('the workspace and home checks run before agy --version, which runs in a fresh empty folder', () => {
  const versions = () => readdirSync(ARGV).filter((f) => f.startsWith('version-')).map((f) => JSON.parse(readFileSync(join(ARGV, f), 'utf8')))
  put(join(REPO, '.agents', 'hooks.json'), '{}')
  const w = run([], { REVIEW_REVIEWER: 'neon', STUB_AGY_VERSION: '9.9.9' })
  rmSync(join(REPO, '.agents'), { recursive: true, force: true })
  assert.match(w.out, /agy review refused: .*\.agents\/hooks\.json: agy runs a workspace's hooks/)
  gemini({ 'hooks.json': J({ mine: { Stop: [{ command: 'x' }] } }) })
  const h = run([], { REVIEW_REVIEWER: 'neon', STUB_AGY_VERSION: '9.9.9' })
  rmSync(join(HOME, '.gemini'), { recursive: true, force: true })
  assert.match(h.out, /agy review refused: .*not cmux's/)
  assert.equal(versions().length, 0, 'agy --version never ran')
  const ok = run([], { REVIEW_REVIEWER: 'neon' })
  reached(ok)
  const v = versions()
  assert.equal(v.length >= 1, true)
  for (const x of v) {
    assert.deepEqual(x.entries, [])
    assert.notEqual(x.cwd, realpathSync(REPO))
    assert.match(x.cwd, /acs-agy-version-/)
    assert.equal(existsSync(x.cwd), false, 'the folder is removed')
  }
})

macTest('a fix check by Neon is recorded and printed model unverified', () => {
  const r = run([], { REVIEW_REVIEWER: 'neon' })
  assert.equal(r.status, 0, r.out)
  const id = findingsJson(r).reviewId
  writeFileSync(join(REPO, 'a.js'), 'export const f = (n) => {\n  for (let i = 0; i < n; i++) {}\n  return n\n}\n')
  git('add', '.'); git('commit', '-qm', 'fix')
  const c = run(['--fix-check', id], { REVIEW_REVIEWER: 'neon', STUB_AGY: 'clean' })
  assert.equal(c.status, 0, c.out)
  assert.match(c.stdout, /✓ Fix check \S+ recorded at \S+: 0 finding\(s\) · neon model unverified/)
  const record = logLines().find((e) => e.kind === 'fix-check')
  assert.equal(record.family, 'neon')
  assert.equal(record.modelVerified, false)
})

macTest('a Neon second opinion and a Neon dispute verifier are recorded model unverified; another verifier carries no such field', () => {
  const pool = J({ use: ['opus', 'neon'], ids: ['claude-opus-stub', 'gemini-4-neon'] })
  const r = run([], { REVIEW_REVIEWER: 'opus', STUB_ROLE: pool, REVIEW_VERIFY: 'second-opinion' })
  assert.equal(r.status, 0, r.out)
  assert.match(r.stdout, /▶ second opinion · neon \(agy · gemini-4-neon · \S+ · model unverified\)/)
  const record = logLines().find((e) => e.type === 'review')
  assert.equal(record.secondOpinion.family, 'neon')
  assert.equal(record.secondOpinion.modelVerified, false)
  assert.equal(Object.hasOwn(record, 'modelVerified'), false, 'the reviewer itself (opus) is not marked')
  assert.equal(findingsJson(r).secondOpinion.modelVerified, false)
  const report = readFileSync(join(REPO, record.dir, 'code-review.md'), 'utf8')
  assert.match(report, /^Second opinion: neon \(gemini-4-neon\) — model unverified$/m)
  const d = run(['--dispute', record.id, 'f1', '--reason', 'intended behavior', '--evidence', 'a.js:2'], { STUB_ROLE: pool })
  assert.equal(d.status, 0, d.out)
  const dispute = logLines().find((e) => e.type === 'dispute')
  assert.equal(dispute.verifier, 'neon')
  assert.equal(dispute.verifierModelVerified, false)
  assert.match(d.stdout, /\(verifier neon, model unverified\)/)
})

macTest('the eval summary marks a Neon run model unverified, per family and in its total line', () => {
  const cases = join(dirname(SCRIPT), 'eval', 'examples')
  const r = run(['--eval', '--family', 'neon,opus', '--cases', cases, '--yes'], { STUB_ROLE: J({ use: ['neon', 'opus'], ids: ['gemini-4-neon', 'claude-opus-stub'] }) })
  assert.equal(r.status, 0, r.out)
  assert.match(r.stdout, /▶ neon \(agy · gemini-4-neon · model unverified\)/)
  assert.match(r.stdout, /^neon \(gemini-4-neon · \S+ · model unverified\) · bugs caught/m)
  assert.match(r.stdout, /^opus \(claude-opus-stub · \S+\) · bugs caught/m)
  assert.doesNotMatch(r.stdout, /▶ opus \([^)]*model unverified/)
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

test('--security-only names REVIEW_AUTHOR=agy as unknown too, and picks the security reviewer without it', () => {
  const r = run(['--security-only'], { REVIEW_AUTHOR: 'agy' })
  assert.equal(r.status, 0, r.out)
  assert.match(r.stderr, /author "agy" names the Antigravity CLI, not the model that wrote the branch — treated as unknown; set REVIEW_AUTHOR to the family/)
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
