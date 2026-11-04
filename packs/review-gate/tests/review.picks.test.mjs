import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Shadow pickers (config pickShadow): jev and ask-model families say which reviewer they would have picked, in the
// background, and write one pick-shadow record each to the shadow log. Stub CLIs record every call; no real model.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'review.mjs')
const ROOT = mkdtempSync(join(tmpdir(), 'review-picks-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), BIN = join(ROOT, 'bin'), CALLS = join(ROOT, 'calls'), CONF = join(ROOT, 'config.json')
const LOGS = join(HOME, '.agent-config-studio/review-log'), LOG = join(LOGS, 'review-log.jsonl'), SHADOW = join(LOGS, 'shadow-log.jsonl')
const FLAVOR = 'FLAVOR-TEXT-MARKER'
mkdirSync(BIN)
const stub = (name, body) => {
  writeFileSync(join(BIN, name), `#!${process.execPath}\n${body}`)
  chmodSync(join(BIN, name), 0o755)
}
const IDS = { sol: 'gpt-stub-sol', opus: 'claude-stub-opus', grok: 'grok-stub' }
stub('model-id', `const a=process.argv.slice(2), ids=${JSON.stringify(IDS)}; console.log(a[0]==='--role' ? JSON.stringify({use:Object.keys(ids),ids:Object.values(ids)}) : a[0]==='--flavor' ? JSON.stringify({flavor:{effort:'high',likes:['${FLAVOR} likes'],quirks:['${FLAVOR} quirks']}}) : ids[a[0]] || 'stub-'+a[0])`)
const reviewer = `
const fs = require('node:fs')
const a = process.argv.slice(2)
if (a[0] === 'mcp') { console.log('[]'); process.exit(0) }
if (process.env.STUB_DELETE) fs.rmSync(process.env.STUB_DELETE, { force: true })
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8') : a[a.indexOf('--json-schema')+1]
const reply = schema.includes('"scores"') ? '{"scores":[]}' : schema.includes('"verdicts"') ? '{"verdicts":[]}' : (process.env.STUB_FINDINGS || '{"findings":[]}')
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1], reply)
else console.log(JSON.stringify({structured_output:JSON.parse(reply),structuredOutput:JSON.parse(reply),modelUsage:{'claude-stub-opus':{}}}))
`
for (const name of ['codex', 'claude', 'grok']) stub(name, reviewer)
// A picker stub: records its call (args, cwd, input, and the review log as it stood), then acts on STUB_<NAME>:
// ok (the default), fail, sleep, or garbage; STUB_<NAME>_ANSWER replaces the answer.
const pickerBody = (kind) => `
const fs = require('node:fs'), path = require('node:path')
const a = process.argv.slice(2)
const name = ${JSON.stringify(kind)} === 'jev' ? 'jev' : a[a.indexOf('--family') + 1]
const input = ${JSON.stringify(kind)} === 'jev' ? fs.readFileSync(0, 'utf8') : ''
const at = (f) => a.includes(f) ? fs.readFileSync(a[a.indexOf(f) + 1], 'utf8') : null
const log = ${JSON.stringify(LOG)}
fs.writeFileSync(path.join(${JSON.stringify(CALLS)}, 'pick-' + name + '-' + process.pid + '.json'), JSON.stringify({ args: a, cwd: process.cwd(), input, grokHome: process.env.GROK_HOME ?? null,
  prompt: at('--prompt-file'), schema: at('--schema'), reviewLog: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' }))
const mode = process.env['STUB_' + name.toUpperCase()] || 'ok'
if (mode === 'refuse') { console.log(JSON.stringify({ family: name, id: 'stub-' + name, effort: 'high', mode: 'no-tools', answer: null, error: name + ' cannot run with no tools (it has no switch that removes every tool) — not asked' })); process.exit(4) }
if (mode === 'sleep') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000)
if (mode === 'fail') { process.stderr.write('stub picker failure\\n'); if (name !== 'jev') console.log(JSON.stringify({ family: name, id: 'stub-' + name, effort: 'high', answer: null, error: 'stub picker failure' })); process.exit(4) }
const custom = process.env['STUB_' + name.toUpperCase() + '_ANSWER']
if (${JSON.stringify(kind)} === 'jev') {
  console.log(mode === 'garbage' ? 'not json' : custom || JSON.stringify({ answers: {
    reviewer: { type: 'choice', choice: 'opus', confidence: 0.81, probabilities: { opus: 0.81, sol: 0.1, grok: 0.05, unsure: 0.04 } },
    complexity: { type: 'choice', choice: 'moderate', confidence: 0.6, probabilities: { simple: 0.3, moderate: 0.6, deep: 0.1 } } } }))
} else {
  const answer = mode === 'garbage' ? 'the model rambled' : custom || JSON.stringify({ family: 'sol', complexity: 'deep', reason: name + ' thinks sol fits this logic change' })
  console.log(JSON.stringify({ family: name, id: 'stub-' + name, effort: 'xhigh', mode: 'read-only', answer, changed: null, error: null }))
}
`
stub('jev', pickerBody('jev'))
stub('ask-model', pickerBody('ask-model'))
after(() => rmSync(ROOT, { recursive: true, force: true }))

const env = (extra = {}) => ({ HOME, CODEX_HOME: join(HOME, '.codex'), GROK_HOME: join(HOME, '.grok'), GIT_CONFIG_GLOBAL: join(HOME, 'isolated.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1', PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: ROOT, REVIEW_BASE: 'main',
  REVIEW_REVIEWER: 'sol', REVIEW_CLASSIFIER: 'jev', REVIEW_CONFIG: CONF, ...extra })
function run(command, args, extra = {}, input = undefined) {
  const r = spawnSync(command, args, { cwd: REPO, env: env(extra), encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, ...(input !== undefined && { input }) })
  return { ...r, out: `${r.stdout || ''}\n${r.stderr || ''}` }
}
const script = (args, extra = {}, input) => run(process.execPath, [SCRIPT, ...args], extra, input)
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
const lines = (n, tag = 'x') => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i}`).join('\n') + '\n'
const config = (doc) => writeFileSync(CONF, JSON.stringify(doc))
const allowed = (r) => assert.equal(r.status, 0, r.out)
const records = (file = LOG) => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const picks = () => records(SHADOW).filter((e) => e.type === 'pick-shadow')
const pickCalls = (name) => readdirSync(CALLS).filter((f) => f.startsWith(`pick-${name}-`)).map((f) => JSON.parse(readFileSync(join(CALLS, f), 'utf8')))
async function pickRecords(count, ms = 15000) {
  for (const until = Date.now() + ms; Date.now() < until; await new Promise((r) => setTimeout(r, 50)))
    if (picks().length >= count) return picks()
  throw new Error(`no ${count} pick-shadow record(s) within ${ms} ms: ${JSON.stringify(records(SHADOW))}`)
}
const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms))
const PICKERS = ['jev', 'grok', 'astra']
const FIELDS = ['type', 'reviewId', 'picker', 'model', 'effort', 'ts', 'durationMs', 'ok', 'family', 'complexity', 'reason', 'actual']

beforeEach(() => {
  for (const path of [HOME, REPO, CALLS, CONF]) rmSync(path, { recursive: true, force: true })
  mkdirSync(LOGS, { recursive: true }); mkdirSync(REPO); mkdirSync(CALLS)
  git('init', '-q', '-b', 'main')
  commit({ 'README.md': 'base\n', 'src/a.js': lines(5) })
  git('checkout', '-qb', 'feat')
})

test('C1 pickers start after the review record is logged; exit, output (but one line) and record match a run with pickShadow off', async () => {
  commit({ 'src/a.js': lines(10) })
  config({})
  const off = script(['make a ten']); allowed(off)
  const offRecord = records().at(-1)
  config({ pickShadow: PICKERS })
  const started = Date.now()
  const on = script(['make a ten'], { STUB_JEV: 'sleep', STUB_GROK: 'sleep', STUB_ASTRA: 'sleep', REVIEW_PICK_SHADOW_TIMEOUT_MS: '3000' })
  allowed(on)
  assert.ok(Date.now() - started < 3000, `the review did not wait for its pickers (${Date.now() - started} ms)`)
  const onRecord = records().at(-1)
  assert.equal(on.status, off.status)
  const pickLines = on.stdout.split('\n').filter((l) => l.startsWith('▶ pick-shadow'))
  assert.deepEqual(pickLines, [`▶ pick-shadow · jev, grok, astra started in the background for ${onRecord.id} (results: ${SHADOW})`])
  const same = (r, rec) => r.replaceAll(rec.id, 'ID').replace(/"head": "\w+"/, '').split('\n').filter((l) => !l.startsWith('▶ pick-shadow'))
  assert.deepEqual(same(on.stdout, onRecord), same(off.stdout, offRecord))
  assert.deepEqual(same(on.stderr, onRecord), same(off.stderr, offRecord))
  const stable = (rec) => { const { id, ts, dir, durationMs, ...rest } = rec; return rest }
  assert.deepEqual(stable(onRecord), stable(offRecord))
  assert.deepEqual(records().map((e) => e.type), ['review', 'review'], 'the pickers wrote nothing to the review log')
  const done = await pickRecords(3)
  for (const name of PICKERS) {
    const [call] = pickCalls(name)
    assert.ok(call.reviewLog.includes(`"id":"${onRecord.id}"`), `${name} started after the review record was written`)
  }
  assert.ok(done.every((p) => p.ok === false && /timed out after 3000 ms/.test(p.error)), JSON.stringify(done))
})

test('C2 each picker writes exactly one pick-shadow record with the agreed fields', async () => {
  config({ pickShadow: PICKERS })
  commit({ 'src/a.js': lines(10) })
  allowed(script([]))
  const review = records().at(-1)
  const byPicker = Object.fromEntries((await pickRecords(3)).map((p) => [p.picker, p]))
  await settle(500)
  assert.equal(picks().length, 3, 'one record per picker')
  for (const p of Object.values(byPicker)) {
    for (const k of FIELDS) assert.ok(Object.hasOwn(p, k), `${p.picker} record has ${k}`)
    assert.equal(p.type, 'pick-shadow'); assert.equal(p.reviewId, review.id); assert.equal(p.actual, 'sol'); assert.equal(p.ok, true)
    assert.ok(Number.isFinite(p.durationMs) && !Number.isNaN(Date.parse(p.ts)))
    assert.ok(!Object.hasOwn(p, 'error'), 'a successful pick has no error')
  }
  assert.deepEqual([byPicker.grok.model, byPicker.grok.effort, byPicker.grok.family, byPicker.grok.complexity, byPicker.grok.reason],
    ['stub-grok', 'xhigh', 'sol', 'deep', 'grok thinks sol fits this logic change'])
  assert.deepEqual([byPicker.astra.model, byPicker.astra.family], ['stub-astra', 'sol'])
  assert.deepEqual([byPicker.jev.model, byPicker.jev.effort, byPicker.jev.family, byPicker.jev.complexity, byPicker.jev.reason, byPicker.jev.confidence],
    ['jev', null, 'opus', 'moderate', null, 0.81])
  assert.deepEqual(byPicker.jev.probabilities, { opus: 0.81, sol: 0.1, grok: 0.05, unsure: 0.04 })
  assert.equal(byPicker.jev.complexityConfidence, 0.6)
  assert.ok(!Object.hasOwn(byPicker.grok, 'confidence') && !Object.hasOwn(byPicker.grok, 'probabilities'), 'model pickers carry no classifier numbers')
})

test('C2 a failing, timing-out or garbage-answering picker writes ok:false with an error and never affects the review', async () => {
  config({ pickShadow: ['jev', 'grok', 'astra', 'opus', 'sol', 'Bad Name!'] })
  commit({ 'src/a.js': lines(10) })
  const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ')
  const r = script([], { STUB_JEV: 'garbage', STUB_GROK: 'fail', STUB_ASTRA: 'sleep', STUB_OPUS_ANSWER: JSON.stringify({ family: 'nosuch', complexity: 'deep', reason: 'r' }),
    STUB_SOL_ANSWER: JSON.stringify({ family: 'opus', complexity: 'simple', reason: long }), REVIEW_PICK_SHADOW_TIMEOUT_MS: '1500' })
  allowed(r)
  assert.equal(records().at(-1).kind, 'review')
  const by = Object.fromEntries((await pickRecords(6)).map((p) => [p.picker, p]))
  assert.equal(by['Bad Name!'].ok, false); assert.match(by['Bad Name!'].error, /not a picker name/)
  assert.equal(by.jev.ok, false); assert.match(by.jev.error, /unparseable jev output/)
  assert.equal(by.grok.ok, false); assert.match(by.grok.error, /ask-model exited 4: stub picker failure/)
  assert.equal(by.astra.ok, false); assert.match(by.astra.error, /timed out after 1500 ms/)
  assert.equal(by.opus.ok, false); assert.match(by.opus.error, /family "nosuch" is not a candidate/)
  assert.equal(by.sol.ok, true); assert.equal(by.sol.reason.split(' ').length, 40, 'a reason over 40 words is cut to 40')
  for (const p of Object.values(by)) assert.equal(p.type, 'pick-shadow')
  await settle(500)
  assert.equal(picks().length, 6, 'still one record per picker')
})

test('C3 picker input has the candidates and stats, no flavor text; model pickers get the capped diff with no tools, Jev no diff', async () => {
  config({ pickShadow: PICKERS })
  const big = Array.from({ length: 2500 }, (_, i) => `export const bigName${i} = 'some long value number ${i}'`).join('\n') + '\n'
  commit({ 'src/a.js': lines(10), 'src/big.js': big })
  allowed(script(['make it big']))
  await pickRecords(3)
  const [jev] = pickCalls('jev'), [grok] = pickCalls('grok'), [astra] = pickCalls('astra')
  const payload = JSON.parse(jev.input)
  assert.deepEqual(Object.keys(payload.questions.reviewer.criteria), ['sol', 'opus', 'grok', 'unsure'])
  assert.deepEqual(Object.keys(payload.questions.complexity.criteria), ['simple', 'moderate', 'deep'])
  assert.equal(payload.state.diff.stats.files, 2); assert.deepEqual(payload.state.diff.stats.kinds, { static: 0, docs: 0, tests: 0, logic: 2, other: 0 })
  assert.deepEqual(payload.state.diff.paths.sort(), ['src/a.js', 'src/big.js'])
  assert.equal(payload.state.diff.intent, 'make it big'); assert.equal(payload.state.diff.plan_passed, false)
  assert.ok(!jev.input.includes('bigName') && !jev.input.includes('export const'), 'Jev gets no diff')
  for (const call of [jev, grok, astra]) {
    assert.ok(!(call.input + call.prompt + call.schema).includes(FLAVOR), 'no flavor text reaches a picker')
    assert.ok(/review-pick-cwd-/.test(call.cwd) && !call.cwd.startsWith(realpathSync(REPO)) && !call.cwd.startsWith(REPO), `the picker ran from a temp folder, not the repo: ${call.cwd}`)
  }
  for (const call of [grok, astra]) {
    assert.ok(!call.args.includes('--investigate'), 'model pickers get no tools')
    assert.deepEqual(call.args.slice(0, 2), ['--family', call.args[1]])
    assert.match(call.prompt, /Candidates \(family and the effort it would review at\): sol \(high\), opus \(high\), grok \(high\)/)
    assert.match(call.prompt, /Diff stats: \{"files":2/)
    assert.match(call.prompt, /The diff \(\d+ chars; truncated to the first 60000\):/)
    assert.ok(call.prompt.includes('bigName0'))
    assert.ok(call.prompt.length < 62000, `the diff is capped (${call.prompt.length})`)
    assert.deepEqual(JSON.parse(call.schema).properties.family.enum, ['sol', 'opus', 'grok', 'unsure'])
  }
})

test('C4 a tracked repo config cannot enable pickShadow; the env and the home config can', async () => {
  rmSync(CONF, { force: true })
  commit({ '.claude/review-config.json': JSON.stringify({ pickShadow: PICKERS }), 'src/a.js': lines(10) })
  const r = script([], { REVIEW_CONFIG: '' }); allowed(r)
  assert.match(r.out, /Ignoring pickShadow in \.claude\/review-config\.json/)
  assert.doesNotMatch(r.out, /▶ pick-shadow/)
  await settle()
  assert.deepEqual(picks(), [])
  // The classifier picker is the configured classifier command, named by its command's name even when given as a path.
  const viaEnv = script([], { REVIEW_CONFIG: '', REVIEW_PICK_SHADOW: 'jev,grok', REVIEW_CLASSIFIER: join(BIN, 'jev') }); allowed(viaEnv)
  assert.match(viaEnv.stdout, /▶ pick-shadow · jev, grok started/)
  const got = Object.fromEntries((await pickRecords(2)).map((p) => [p.picker, p]))
  assert.deepEqual(Object.keys(got).sort(), ['grok', 'jev'])
  assert.deepEqual([got.jev.ok, got.jev.model, got.jev.family], [true, 'jev', 'opus'])
  const calls = pickCalls('jev')
  assert.equal(calls.length, 1); assert.ok(!calls[0].args.includes('--family') && calls[0].input.includes('"questions"'), 'the classifier ran as itself, not through ask-model')
})

test('C5 no pickers run for fix checks, rechecks, grades or disputes', async () => {
  config({ pickShadow: PICKERS })
  commit({ 'src/a.js': lines(10) })
  const finding = { issue: 'x2 is wrong', file: 'src/a.js', line: '3', quote: 'export const x2 = 2', suggestion: 's', likelihood: 5, impact: 5, protected: false, trigger: 't' }
  allowed(script([], { STUB_FINDINGS: JSON.stringify({ findings: [finding] }) }))
  const review = records().at(-1)
  await pickRecords(3)
  const outs = []
  commit({ 'src/a.js': lines(10).replace('x2 = 2', 'x2 = 20') })
  outs.push(script(['--fix-check', review.id]))
  outs.push(script(['--dispute', review.id, 'f1', '--reason', 'intended behavior', '--evidence', 'src/a.js:3']))
  const grade = join(ROOT, 'grade.json')
  writeFileSync(grade, JSON.stringify({ family: 'opus', model: 'claude-stub-opus', vendor: 'claude', criteria: [{ id: '1', criterion: 'c', verdict: 'FAIL', evidence: 'e' }] }))
  outs.push(script(['--log-grade', grade]))
  const graded = records().at(-1)
  assert.equal(graded.kind, 'grade')
  outs.push(script(['--log-grade', grade, '--recheck-of', graded.id]))
  const kinds = records().map((e) => e.kind || e.type)
  for (const k of ['fix-check', 'grade', 'recheck']) assert.ok(kinds.includes(k), `${k} ran: ${kinds.join(', ')}\n${outs.map((o) => o.out).join('\n')}`)
  assert.ok(kinds.includes('dispute'), `the dispute ran: ${kinds.join(', ')}`)
  for (const o of outs) assert.doesNotMatch(o.out, /pick-shadow/)
  await settle()
  assert.equal(picks().length, 3, 'only the review started pickers')
})

test('C6 --pick-report counts runs, failures, agreement with the actual reviewer, families and complexity per picker', () => {
  const pick = (fields) => JSON.stringify({ type: 'pick-shadow', ts: '2026-11-03T12:00:00.000Z', ok: true, complexity: 'moderate', actual: 'sol', ...fields })
  appendFileSync(SHADOW, [
    pick({ picker: 'grok', family: 'sol' }),
    pick({ picker: 'grok', family: 'opus', complexity: 'deep' }),
    pick({ picker: 'grok', ok: false, family: null, complexity: null, error: 'refused' }),
    pick({ picker: 'jev', family: 'grok', ts: '2026-10-01T00:00:00.000Z' }),
    pick({ picker: 'jev', family: 'sol', actual: 'sol', complexity: 'simple' }),
    JSON.stringify({ type: 'shadow', reviewId: 'r', family: 'grok', ok: true, findings: [] }),
  ].join('\n') + '\n')
  const r = script(['--pick-report']); allowed(r)
  assert.deepEqual(r.stdout.trim().split('\n').slice(1), [
    'grok: 3 run(s), 1 failed; agreed with the actual reviewer 1 of 2 (50%); families: opus 1, sol 1; complexity: deep 1, moderate 1',
    'jev: 2 run(s), 0 failed; agreed with the actual reviewer 1 of 2 (50%); families: grok 1, sol 1; complexity: moderate 1, simple 1',
  ])
  const since = script(['--pick-report', '--since', '2026-10-15']); allowed(since)
  assert.deepEqual(since.stdout.trim().split('\n').slice(1, 3).at(-1), 'jev: 1 run(s), 0 failed; agreed with the actual reviewer 1 of 1 (100%); families: sol 1; complexity: simple 1')
  const shadow = script(['--shadow-report']); allowed(shadow)
  assert.deepEqual(shadow.stdout.trim().split('\n').slice(1).map((l) => l.split(':')[0] + ':' + l.split(':')[1].split(',')[0]), ['grok: 1 run(s)'], 'the shadow report ignores pick records')
  rmSync(SHADOW)
  const none = script(['--pick-report']); allowed(none)
  assert.match(none.stdout, /no pick-shadow runs/)
})

test('X1 model pickers ask with --no-tools; a CLI that cannot run without tools is ok:false with its reason', async () => {
  config({ pickShadow: ['grok', 'opus'] })
  commit({ 'src/a.js': lines(10) })
  allowed(script([], { STUB_GROK: 'refuse' }))
  const by = Object.fromEntries((await pickRecords(2)).map((p) => [p.picker, p]))
  for (const name of ['grok', 'opus']) assert.ok(pickCalls(name)[0].args.includes('--no-tools'), `${name} was asked with --no-tools`)
  assert.equal(by.grok.ok, false); assert.match(by.grok.error, /ask-model exited 4: grok cannot run with no tools/)
  assert.equal(by.opus.ok, true)
})

test('X2 a relative classifier command runs from where the review ran, not the picker folder', async () => {
  config({ pickShadow: ['jev'] })
  mkdirSync(join(REPO, 'tools')); writeFileSync(join(REPO, 'tools/jev'), ''); chmodSync(join(REPO, 'tools/jev'), 0o755)
  commit({ 'src/a.js': lines(10), 'tools/jev': readFileSync(join(BIN, 'jev'), 'utf8') })
  allowed(script([], { REVIEW_CLASSIFIER: './tools/jev' }))
  const [p] = await pickRecords(1)
  assert.deepEqual([p.picker, p.ok, p.family, p.error], ['jev', true, 'opus', undefined])
})

test('X3 a relative GROK_HOME reaches the pickers made absolute against where the review ran', async () => {
  config({ pickShadow: ['grok'] })
  commit({ 'src/a.js': lines(10) })
  allowed(script([], { GROK_HOME: 'rel-grok' }))
  await pickRecords(1)
  assert.equal(pickCalls('grok')[0].grokHome, join(realpathSync(REPO), 'rel-grok'))
})

test('X4 a picker worker that fails to start writes one ok:false record per picker and leaves no job folder', async () => {
  config({ pickShadow: ['jev', 'grok'] })
  commit({ 'src/a.js': lines(10) })
  // The review runs on its own link to node, which the reviewer removes mid-run: the worker's spawn then fails.
  const node = join(ROOT, 'node-link')
  rmSync(node, { force: true })
  try { linkSync(process.execPath, node) } catch { copyFileSync(process.execPath, node) }
  const r = spawnSync(node, [SCRIPT], { cwd: REPO, env: env({ STUB_DELETE: node }), encoding: 'utf8', timeout: 60000 })
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  assert.ok(!existsSync(node), 'the link was removed during the review')
  const by = Object.fromEntries((await pickRecords(2)).map((p) => [p.picker, p]))
  for (const name of ['jev', 'grok']) {
    assert.equal(by[name].ok, false); assert.match(by[name].error, /could not start/)
    assert.equal(by[name].reviewId, records().at(-1).id)
  }
  assert.deepEqual(readdirSync(ROOT).filter((d) => d.startsWith('review-pick-shadow-')), [], 'the unused job folder is removed')
})

// The real ask-model (tools/ask-model.mjs at the repo root) behind the pickers, over stub claude, codex and grok CLIs
// that log their argv and answer the picker's schema. Only the pickers see these CLIs: the review keeps BIN's.
const ASK_MODEL = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tools', 'ask-model.mjs')
const ASK_BIN = join(ROOT, 'ask-bin'), CLI_BIN = join(ROOT, 'cli-bin'), CLI_CALLS = join(ROOT, 'cli-calls.jsonl')
mkdirSync(ASK_BIN); mkdirSync(CLI_BIN)
writeFileSync(join(ASK_BIN, 'ask-model'), `#!/bin/sh\nPATH=${CLI_BIN}:/usr/bin:/bin exec ${JSON.stringify(process.execPath)} ${JSON.stringify(ASK_MODEL)} "$@"\n`)
chmodSync(join(ASK_BIN, 'ask-model'), 0o755)
for (const name of ['claude', 'codex', 'grok']) {
  writeFileSync(join(CLI_BIN, name), `#!${process.execPath}
const fs = require('node:fs')
const a = process.argv.slice(2)
if (${JSON.stringify(name)} === 'grok' && a[0] === 'inspect') { console.log(JSON.stringify({ mcpServers: [], plugins: [] })); process.exit(0) }
if (${JSON.stringify(name)} === 'codex' && a[0] === 'mcp') { console.log('[]'); process.exit(0) }
fs.appendFileSync(${JSON.stringify(CLI_CALLS)}, JSON.stringify({ name: ${JSON.stringify(name)}, argv: a, cwd: process.cwd() }) + '\\n')
if (process.env['STUB_CLI_' + ${JSON.stringify(name.toUpperCase())}] === 'fail') { process.stderr.write('cli boom\\n'); process.exit(1) }
const id = a[a.indexOf(a.includes('--model') ? '--model' : '-m') + 1]
const answer = { family: 'opus', complexity: 'simple', reason: ${JSON.stringify(name)} + ' picked opus' }
if (${JSON.stringify(name)} === 'codex') console.log(JSON.stringify(answer))
else if (${JSON.stringify(name)} === 'claude') console.log(JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: answer, modelUsage: { [id]: {} } }))
else console.log(JSON.stringify({ text: '', structuredOutput: answer, modelUsage: { [id]: {} } }))
`)
  chmodSync(join(CLI_BIN, name), 0o755)
}
const askPath = { PATH: [ASK_BIN, BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':') }
const cliCalls = () => existsSync(CLI_CALLS) ? readFileSync(CLI_CALLS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []

test('M1 model pickers ask with --min-tools; grok and astra answer ok:true with tools "restricted", a claude picker with tools "none"', async () => {
  rmSync(CLI_CALLS, { force: true })
  config({ pickShadow: ['grok', 'astra', 'opus'] })
  commit({ 'src/a.js': lines(10) })
  allowed(script([], askPath))
  const by = Object.fromEntries((await pickRecords(3)).map((p) => [p.picker, p]))
  for (const name of ['grok', 'astra', 'opus']) {
    assert.equal(by[name].ok, true, JSON.stringify(by[name])); assert.equal(by[name].family, 'opus')
  }
  assert.equal(by.grok.tools, 'restricted'); assert.match(by.grok.toolsNote, /list_dir/)
  assert.equal(by.astra.tools, 'restricted'); assert.match(by.astra.toolsNote, /read-only sandbox/)
  assert.equal(by.opus.tools, 'none'); assert.match(by.opus.toolsNote, /no tools/)
  const calls = Object.fromEntries(cliCalls().map((c) => [c.name, c]))
  const after = (argv, flag) => argv[argv.indexOf(flag) + 1]
  assert.equal(after(calls.grok.argv, '--tools'), 'list_dir'); assert.ok(calls.grok.argv.includes('--disable-web-search') && calls.grok.argv.includes('--no-subagents'))
  assert.ok(calls.codex.argv.includes('shell_tool') && calls.codex.argv.includes('unified_exec') && after(calls.codex.argv, '--sandbox') === 'read-only')
  assert.equal(after(calls.claude.argv, '--tools'), '')
  for (const c of Object.values(calls)) assert.match(c.cwd, /review-pick-cwd-/, `${c.name} ran from the picker's temp folder`)
})

test('M2 a picker whose CLI fails is ok:false and still records the tools it had; the classifier picker records tools "none"', async () => {
  rmSync(CLI_CALLS, { force: true })
  config({ pickShadow: ['jev', 'grok', 'astra'] })
  commit({ 'src/a.js': lines(10) })
  allowed(script([], { ...askPath, STUB_CLI_GROK: 'fail' }))
  const by = Object.fromEntries((await pickRecords(3)).map((p) => [p.picker, p]))
  assert.equal(by.grok.ok, false); assert.match(by.grok.error, /ask-model exited 4: grok exited 1 without a JSON reply: cli boom/)
  assert.equal(by.grok.tools, 'restricted'); assert.match(by.grok.toolsNote, /list_dir/)
  assert.equal(by.astra.ok, true); assert.equal(by.astra.tools, 'restricted')
  assert.equal(by.jev.ok, true); assert.equal(by.jev.tools, 'none'); assert.equal(typeof by.jev.toolsNote, 'string')
})

test('M3 a picker that never reached ask-model still has the tools fields, empty', async () => {
  config({ pickShadow: ['Bad Name!'] })
  commit({ 'src/a.js': lines(10) })
  allowed(script([]))
  const [p] = await pickRecords(1)
  assert.equal(p.ok, false); assert.match(p.error, /not a picker name/)
  assert.ok(Object.hasOwn(p, 'tools') && Object.hasOwn(p, 'toolsNote'), 'the record has tools and toolsNote')
  assert.deepEqual([p.tools, p.toolsNote], [null, null])
})

test('M4 --pick-report prints each picker\'s tools beside its numbers, and nothing for records that predate them', () => {
  const pick = (fields) => JSON.stringify({ type: 'pick-shadow', ts: '2026-11-04T12:00:00.000Z', ok: true, complexity: 'moderate', actual: 'sol', ...fields })
  appendFileSync(SHADOW, [
    pick({ picker: 'grok', family: 'sol', tools: 'restricted', toolsNote: 'list_dir only' }),
    pick({ picker: 'grok', ok: false, family: null, complexity: null, error: 'boom', tools: 'restricted', toolsNote: 'list_dir only' }),
    pick({ picker: 'opus', family: 'opus', tools: 'none', toolsNote: 'no tools' }),
    pick({ picker: 'jev', family: 'sol' }),
  ].join('\n') + '\n')
  const r = script(['--pick-report']); allowed(r)
  assert.deepEqual(r.stdout.trim().split('\n').slice(1), [
    'grok: 2 run(s), 1 failed; agreed with the actual reviewer 1 of 1 (100%); families: sol 1; complexity: moderate 1; tools: restricted 2',
    'jev: 1 run(s), 0 failed; agreed with the actual reviewer 1 of 1 (100%); families: sol 1; complexity: moderate 1',
    'opus: 1 run(s), 0 failed; agreed with the actual reviewer 0 of 1 (0%); families: opus 1; complexity: moderate 1; tools: none 1',
  ])
})
