#!/usr/bin/env node
/**
 * flag.test.mjs — the /flag helper: reports written with their modes, every redaction kind, excerpts stored as
 * references (by line and by tool id, from Claude Code and Codex transcripts) and resolved by show, redacted, the
 * refusals, and list with its filters. Every run is a temp HOME; no real ~/.claude, ~/.codex or ~/.agent-config-studio is read.
 * Planted secrets are built at run time so no scanner mistakes this file for a leak.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { redact, redactText } from '../skills/claude/flag/flag.mjs'

const b64 = (s) => Buffer.from(s).toString('base64')
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const transcriptLines = (file) => readFileSync(file, 'utf8').split('\n').slice(0, -1)
// The excerpt lines show prints, by line number, each parsed back from its redacted JSON.
const shown = (out) => Object.fromEntries(out.split('(redacted, not stored) ---\n')[1].trim().split('\n').map((l) => { const [n, ...rest] = l.split('\t'); return [Number(n), JSON.parse(rest.join('\t'))] }))

const FLAG = resolve(dirname(fileURLToPath(import.meta.url)), '../skills/claude/flag/flag.mjs')
const roots = []
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

// A fresh machine: HOME, a git repo on branch feat-x, and nothing of the real environment's harness variables.
function box() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flag-test-')))
  roots.push(root)
  const home = join(root, 'home'), repo = join(root, 'repo')
  mkdirSync(home); mkdirSync(repo)
  const env = { HOME: home, PATH: process.env.PATH, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig') }
  spawnSync('git', ['init', '-q', '-b', 'feat-x'], { cwd: repo, env })
  const run = (args, { input, cwd = repo, extra = {} } = {}) => {
    const r = spawnSync(process.execPath, [FLAG, ...args], { cwd, env: { ...env, ...extra }, input, encoding: 'utf8' })
    return { code: r.status, out: r.stdout, err: r.stderr }
  }
  const write = (report, opts = {}) => run(['write'], { ...opts, input: JSON.stringify(report) })
  const reports = join(home, '.agent-config-studio', 'field-reports')
  const files = () => (existsSync(reports) ? readdirSync(reports).filter((f) => f.endsWith('.json')) : [])
  const only = () => { const f = files(); assert.equal(f.length, 1, f.join()); return { text: readFileSync(join(reports, f[0]), 'utf8'), data: JSON.parse(readFileSync(join(reports, f[0]), 'utf8')), file: join(reports, f[0]) } }
  return { root, home, repo, env, run, write, reports, files, only }
}

const SECRETS = {
  anthropic: 'sk-' + 'ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0'.repeat(2),
  openai: 'sk-' + 'proj-' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3'.repeat(2),
  ghp: 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0'.repeat(2),
  gho: 'gh' + 'o_' + 'Q1w2E3r4T5y6U7i8O9p0'.repeat(2),
  ghpat: 'github' + '_pat_' + '11ABCDEFG0' + 'x'.repeat(30),
  slack: 'xo' + 'xb-' + '1234567890-0987654321-' + 'AbCdEfGhIjKl',
  aws: 'AK' + 'IA' + 'IOSFODNN7EXAMPL2',
  render: 'rn' + 'd_' + 'AbCdEfGh12345678IjKl',
  google: 'AI' + 'za' + 'SyA1234567890abcdefghijklmnopqrstu',
  gitlab: 'gl' + 'pat-' + 'abcdEFGH1234ijklMNOP',
  npm: 'np' + 'm_' + 'abcdefghijklmnopqrstuvwxyz0123456789',
  jwt: 'ey' + 'JhbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  bearer: 'tok' + 'en.' + 'Opaque_value-1234567890',
  basic: 'dXNlcj' + 'pwYXNzd29yZA==',
  pem: '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7bq0\nq9c2PLANTED\n-----END ' + 'RSA PRIVATE KEY-----',
}

test('every token prefix is redacted with its kind, and nothing of the token is left', () => {
  for (const [name, kind] of [['anthropic', 'anthropic-key'], ['openai', 'openai-key'], ['ghp', 'github-token'], ['gho', 'github-token'],
    ['ghpat', 'github-token'], ['slack', 'slack-token'], ['aws', 'aws-key'], ['render', 'render-key'], ['google', 'google-key'],
    ['gitlab', 'gitlab-token'], ['npm', 'npm-token'], ['jwt', 'jwt']]) {
    const out = redactText(`before ${SECRETS[name]} after`)
    assert.equal(out, `before [REDACTED:${kind}] after`, name)
  }
})

test('Bearer and Basic credentials, private-key blocks and passwords in URLs', () => {
  assert.equal(redactText(`curl -H "Authorization: Bearer ${SECRETS.bearer}" x`), 'curl -H "Authorization: Bearer [REDACTED:bearer]" x')
  assert.equal(redactText(`Authorization: Basic ${SECRETS.basic}`), 'Authorization: Basic [REDACTED:basic-auth]')
  assert.equal(redactText(`key file:\n${SECRETS.pem}\ndone`), 'key file:\n[REDACTED:private-key]\ndone')
  const cut = SECRETS.pem.slice(0, 50)
  assert.equal(redactText(`tail: ${cut}`), 'tail: [REDACTED:private-key]', 'an unterminated block goes to the end')
  assert.equal(redactText('git clone https://bot:s3cretPass@example.test/r.git'), 'git clone https://bot:[REDACTED:url-password]@example.test/r.git')
})

test('values of names holding KEY, TOKEN, SECRET or PASSWORD: env, JSON text, flags', () => {
  const cases = [
    ['export GITHUB_TOKEN=abc', 'export GITHUB_TOKEN=[REDACTED:named-secret]'],
    ['DB_PASSWORD=hunter2 npm start', 'DB_PASSWORD=[REDACTED:named-secret] npm start'],
    ['MY_SECRET="two words"', 'MY_SECRET="[REDACTED:named-secret]"'],
    ["AWS_SECRET_ACCESS_KEY='wJalrXUtnFEMI/K7MDENG'", "AWS_SECRET_ACCESS_KEY='[REDACTED:named-secret]'"],
    ['{"apiKey": "abc", "user": "me"}', '{"apiKey": "[REDACTED:named-secret]", "user": "me"}'],
    ['client_secret: "xyz"', 'client_secret: "[REDACTED:named-secret]"'],
    ['API_KEY: abc', 'API_KEY: [REDACTED:named-secret]'],
    ['password: letmein99', 'password: [REDACTED:named-secret]'],
    ['tool --api-key abc123 --verbose', 'tool --api-key [REDACTED:named-secret] --verbose'],
    ['tool --token=xyz', 'tool --token=[REDACTED:named-secret]'],
    [`OPENAI_API_KEY=${SECRETS.openai}`, 'OPENAI_API_KEY=[REDACTED:openai-key]'],
    ['SECRET_COUNT=0', 'SECRET_COUNT=[REDACTED:named-secret]'],
  ]
  for (const [input, want] of cases) assert.equal(redactText(input), want, input)
})

test('numbers, flags with numbers and prose after a colon are left alone (it does not redact everything)', () => {
  for (const fine of ['"input_tokens": 2, "output_tokens": 105', 'max_tokens=4096', 'tool --max-tokens 100', 'token: the agent kept going',
    'the key: yes', 'KEY_COUNT=0', 'Basic setup', 'Basic understanding of tokens', 'a plain sentence about tasks and risk-free desks', 'task-abcdefghijklmnopqrstuvwxyz'])
    assert.equal(redactText(fine), fine, fine)
})

test('in parsed JSON, a key named like a secret has its string value redacted whole; numbers stay', () => {
  const out = redact({ password: 'pw1', nested: { client_secret: 'abc', list: [`Bearer ${SECRETS.bearer}`] }, output_tokens: 5, keyCount: 3, note: 'fine' })
  assert.deepEqual(out, { password: '[REDACTED:named-secret]', nested: { client_secret: '[REDACTED:named-secret]', list: ['Bearer [REDACTED:bearer]'] }, output_tokens: 5, keyCount: 3, note: 'fine' })
})

test('write: one report, 0600 in a 0700 folder, with every field, the project, branch and a slug from what', () => {
  const b = box()
  const r = b.write({ what: 'Gate asked the user to paste a shell command', expected: 'The gate unblocks itself', severity: 'high', harness: 'claude',
    model: 'some-model', rulesInForce: 'Never ask the operator to run --waive', toolCalls: ['$ pnpm install\nERR lockfile'], agentTake: 'The skill text says to ask' })
  assert.equal(r.code, 0, r.err)
  const { data, file } = b.only()
  assert.match(r.out, new RegExp(`^flagged ${data.id}\n${file.replace(/[.]/g, '\\.')}\n$`))
  assert.match(data.id, /^\d{4}-\d{2}-\d{2}-gate-asked-the-user-to-paste-[0-9a-f]{6}$/)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(statSync(b.reports).mode & 0o777, 0o700)
  assert.deepEqual(Object.keys(data), ['id', 'ts', 'project', 'branch', 'harness', 'model', 'severity', 'what', 'expected', 'rulesInForce', 'toolCalls', 'agentTake', 'transcript', 'transcriptHow'])
  assert.deepEqual(data.project, { path: b.repo, name: 'repo' })
  assert.equal(data.branch, 'feat-x')
  assert.deepEqual([data.harness, data.model, data.severity], ['claude', 'some-model', 'high'])
  assert.deepEqual(data.rulesInForce, ['Never ask the operator to run --waive'])
  assert.deepEqual(data.toolCalls, [{ source: 'agent', quote: '$ pnpm install\nERR lockfile' }])
  assert.equal(data.transcript, null)
  assert.ok(Math.abs(Date.parse(data.ts) - Date.now()) < 60000)
})

test('write: an existing looser folder is tightened to 0700, and outside a repo the project is the cwd', () => {
  const b = box()
  mkdirSync(b.reports, { recursive: true, mode: 0o755 })
  chmodSync(b.reports, 0o755)
  const r = b.write({ what: 'x', severity: 'low', harness: 'codex' }, { cwd: b.home })
  assert.equal(r.code, 0, r.err)
  assert.equal(statSync(b.reports).mode & 0o777, 0o700)
  const { data } = b.only()
  assert.deepEqual([data.project.path, data.branch], [b.home, null])
})

test('write: every string field is redacted before it is written, the file name included', () => {
  const b = box()
  const r = b.write({ what: `Pasted ${SECRETS.ghp} into chat`, expected: `no ${SECRETS.aws}`, severity: 'medium', harness: 'claude', model: SECRETS.npm,
    rulesInForce: [`KEY=${SECRETS.render}`], toolCalls: [{ name: 'Bash', input: { command: `curl -H 'Authorization: Bearer ${SECRETS.bearer}'` }, token: 'tk-plain' }],
    agentTake: SECRETS.pem })
  assert.equal(r.code, 0, r.err)
  const { text, file } = b.only()
  for (const [name, s] of Object.entries(SECRETS)) assert.ok(!text.includes(s), `${name} leaked`)
  assert.ok(!text.includes('tk-plain'))
  assert.match(text, /\[REDACTED:github-token\]/)
  assert.match(file, /-pasted-into-chat-[0-9a-f]{6}\.json$/)
})

test('write refuses bad input and writes nothing: unknown field, no what, bad severity, bad harness, not JSON', () => {
  const b = box()
  for (const [input, err] of [
    [JSON.stringify({ what: 'x', severity: 'low', harness: 'claude', sevrity: 'x' }), /unknown field: sevrity/],
    [JSON.stringify({ severity: 'low', harness: 'claude' }), /what is required/],
    [JSON.stringify({ what: 'x', severity: 'urgent', harness: 'claude' }), /severity must be one of low, medium, high/],
    [JSON.stringify({ what: 'x', severity: 'low', harness: 'vim' }), /harness must be one of/],
    [JSON.stringify({ what: 'x', severity: 'low' }), /harness must be one of/],
    [JSON.stringify({ what: 'x', severity: 'low', harness: 'claude', excerpts: { lines: ['1'] } }), /excerpts need a transcript/],
    ['not json', /stdin is not JSON/],
  ]) {
    const r = b.run(['write'], { input })
    assert.equal(r.code, 1, input)
    assert.match(r.err, err, input)
  }
  assert.equal(b.files().length, 0)
})

test('write: a folder the sandbox will not let it write exits 3, says to rerun with permission and prints the redacted report', () => {
  const b = box()
  mkdirSync(join(b.home, '.agent-config-studio'))
  chmodSync(join(b.home, '.agent-config-studio'), 0o500)
  const r = b.write({ what: `x ${SECRETS.ghp}`, severity: 'low', harness: 'claude' })
  chmodSync(join(b.home, '.agent-config-studio'), 0o700)
  assert.equal(r.code, 3, r.err)
  assert.match(r.err, /refused writing .*field-reports \(EACCES\) — rerun this same command with permission/)
  assert.equal(JSON.parse(r.out).what, 'x [REDACTED:github-token]')
  assert.equal(b.files().length, 0)
})

// A Claude Code transcript, in the shape ~/.claude/projects/<slug>/<session>.jsonl lines have.
function claudeTranscript(b, session = 'sess-1') {
  const dir = join(b.home, '.claude', 'projects', '-tmp-repo')
  mkdirSync(dir, { recursive: true })
  const lines = [
    { type: 'user', message: { role: 'user', content: 'install it' }, uuid: 'u1' },
    { type: 'assistant', message: { model: 'model-a', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01AAA', name: 'Bash', input: { command: 'pnpm install' } }] }, uuid: 'a1' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01AAA', content: `ERR lockfile; env had OPENAI_API_KEY=${SECRETS.openai} and ${SECRETS.anthropic}` }] }, toolUseResult: { stdout: `token ${SECRETS.ghp}` }, uuid: 'u2' },
    { type: 'assistant', message: { model: 'model-b', role: 'assistant', content: [{ type: 'text', text: 'Please run: rm pnpm-lock.yaml' }], usage: { input_tokens: 2, output_tokens: 9 } }, uuid: 'a2' },
  ]
  const file = join(dir, `${session}.jsonl`)
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
  return { file, lines }
}

test('a Claude Code excerpt by tool id references its call and result by line and sha256; show prints them as they were, the planted keys redacted', () => {
  const b = box()
  const t = claudeTranscript(b)
  const r = b.write({ what: 'asked to paste a command', severity: 'medium', harness: 'claude', transcript: t.file, excerpts: { toolIds: ['toolu_01AAA'] } })
  assert.equal(r.code, 0, r.err)
  const { text, data } = b.only()
  assert.ok(!text.includes(SECRETS.openai) && !text.includes(SECRETS.anthropic) && !text.includes(SECRETS.ghp), 'a planted key leaked from the excerpt')
  assert.ok(!text.includes('pnpm install') && !text.includes('ERR lockfile'), 'transcript text is in the report')
  const raw = transcriptLines(t.file)
  assert.deepEqual(data.excerpts, { transcript: t.file, toolIds: ['toolu_01AAA'], lines: [2, 3].map((n) => ({ line: n, sha256: sha(raw[n - 1]) })) })
  assert.deepEqual(data.toolCalls, [])
  const s = b.run(['show', data.id])
  assert.equal(s.code, 0, s.err)
  const lines = shown(s.out)
  assert.deepEqual(Object.keys(lines), ['2', '3'])
  assert.deepEqual(lines[2], t.lines[1], 'the call is shown as it was')
  const result = structuredClone(t.lines[2])
  result.message.content[0].content = 'ERR lockfile; env had OPENAI_API_KEY=[REDACTED:openai-key] and [REDACTED:anthropic-key]'
  result.toolUseResult.stdout = 'token [REDACTED:github-token]'
  assert.deepEqual(lines[3], result, 'the result is shown as it was, only the secrets replaced')
  assert.deepEqual([data.transcript, data.transcriptHow, data.model], [t.file, 'given', 'model-b'])
})

test('excerpts by line range, merged with tool ids, in order and without repeats; numbers in usage stay', () => {
  const b = box()
  const t = claudeTranscript(b)
  const r = b.write({ what: 'x', severity: 'low', harness: 'claude', transcript: t.file, excerpts: { lines: ['3-4', '1'], toolIds: ['toolu_01AAA'] } })
  assert.equal(r.code, 0, r.err)
  const { data } = b.only()
  assert.deepEqual(data.excerpts.lines.map((l) => l.line), [1, 2, 3, 4])
  assert.deepEqual(shown(b.run(['show', data.id]).out)[4].message.usage, { input_tokens: 2, output_tokens: 9 })
})

test('transcript "auto" in Claude Code finds this session from CLAUDE_CODE_SESSION_ID', () => {
  const b = box()
  const t = claudeTranscript(b, 'sess-auto')
  const r = b.write({ what: 'x', severity: 'low', harness: 'claude', transcript: 'auto', excerpts: { lines: ['2'] } }, { extra: { CLAUDE_CODE_SESSION_ID: 'sess-auto' } })
  assert.equal(r.code, 0, r.err)
  const { data } = b.only()
  assert.deepEqual([data.transcript, data.transcriptHow, data.excerpts.lines], [t.file, 'session-id', [{ line: 2, sha256: sha(JSON.stringify(t.lines[1])) }]])
})

// A Codex rollout, in the shape ~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl lines have.
function codexTranscript(b, { id = '0000-thread', cwd = b.repo, home = join(b.home, '.codex') } = {}) {
  const dir = join(home, 'sessions', '2026', '11', '02')
  mkdirSync(dir, { recursive: true })
  const lines = [
    { timestamp: 't0', type: 'session_meta', payload: { id, cwd } },
    { timestamp: 't1', type: 'turn_context', payload: { cwd, model: 'model-c' } },
    { timestamp: 't2', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_abc', name: 'exec', input: `export GH_TOKEN=${SECRETS.gho}; gh pr list` } },
    { timestamp: 't3', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_abc', output: [{ type: 'input_text', text: `denied: ${SECRETS.jwt}` }] } },
    { timestamp: 't4', type: 'response_item', payload: { type: 'function_call', call_id: 'call_old', name: 'shell', arguments: '{"cmd":"ls"}' } },
  ]
  const file = join(dir, `rollout-2026-11-02T10-00-00-${id}.jsonl`)
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
  return { file, lines }
}

test('a Codex excerpt by call id references the call and its output; show prints them redacted; the model comes from turn_context', () => {
  const b = box()
  const t = codexTranscript(b)
  const r = b.write({ what: 'x', severity: 'low', harness: 'codex', transcript: t.file, excerpts: { toolIds: ['call_abc', 'call_old'] } })
  assert.equal(r.code, 0, r.err)
  const { text, data } = b.only()
  assert.ok(!text.includes(SECRETS.gho) && !text.includes(SECRETS.jwt))
  assert.ok(!text.includes('gh pr list') && !text.includes('denied:'), 'transcript text is in the report')
  assert.deepEqual(data.excerpts.lines.map((l) => l.line), [3, 4, 5])
  assert.deepEqual(data.excerpts.toolIds, ['call_abc', 'call_old'])
  const lines = shown(b.run(['show', data.id]).out)
  assert.equal(lines[3].payload.input, 'export GH_TOKEN=[REDACTED:github-token]; gh pr list')
  assert.equal(lines[4].payload.output[0].text, 'denied: [REDACTED:jwt]')
  assert.deepEqual(lines[5], t.lines[4])
  assert.equal(data.model, 'model-c')
})

test('transcript "auto" in Codex: CODEX_THREAD_ID first, else the newest rollout started in this cwd', () => {
  const b = box()
  const mine = codexTranscript(b, { id: 'aaaa-mine' })
  codexTranscript(b, { id: 'bbbb-other', cwd: '/elsewhere' })
  const byId = b.write({ what: 'x', severity: 'low', harness: 'codex', transcript: 'auto' }, { extra: { CODEX_THREAD_ID: 'aaaa-mine' } })
  assert.equal(byId.code, 0, byId.err)
  assert.deepEqual([b.only().data.transcript, b.only().data.transcriptHow], [mine.file, 'session-id'])
  rmSync(b.reports, { recursive: true })
  const byCwd = b.write({ what: 'x', severity: 'low', harness: 'codex', transcript: 'auto' })
  assert.equal(byCwd.code, 0, byCwd.err)
  assert.deepEqual([b.only().data.transcript, b.only().data.transcriptHow], [mine.file, 'newest-in-cwd'])
  rmSync(b.reports, { recursive: true })
  const custom = codexTranscript(b, { id: 'cccc-custom', home: join(b.root, 'codex-home') })
  const byHome = b.write({ what: 'x', severity: 'low', harness: 'codex', transcript: 'auto' }, { extra: { CODEX_HOME: join(b.root, 'codex-home'), CODEX_THREAD_ID: 'cccc-custom' } })
  assert.equal(byHome.code, 0, byHome.err)
  assert.equal(b.only().data.transcript, custom.file)
})

test('excerpt refusals: a missing id, a line past the end, a bad range, too many lines; nothing is written', () => {
  const b = box()
  const t = claudeTranscript(b)
  for (const [excerpts, err] of [
    [{ toolIds: ['toolu_nope'] }, /toolu_nope is not in the transcript/],
    [{ lines: ['5'] }, /past the end of the transcript \(4 lines\)/],
    [{ lines: ['4-2'] }, /not a valid range/],
    [{ lines: ['abc'] }, /not a line or a range/],
    [{ lines: '1' }, /must be lists/],
  ]) {
    const r = b.write({ what: 'x', severity: 'low', harness: 'claude', transcript: t.file, excerpts })
    assert.equal(r.code, 1, JSON.stringify(excerpts))
    assert.match(r.err, err)
  }
  const big = join(b.root, 'big.jsonl')
  writeFileSync(big, `${Array.from({ length: 300 }, (_, i) => JSON.stringify({ n: i })).join('\n')}\n`)
  const r = b.write({ what: 'x', severity: 'low', harness: 'claude', transcript: big, excerpts: { lines: ['1-201'] } })
  assert.match(r.err, /201 lines; keep it to 200/)
  assert.equal(b.files().length, 0)
})

test('a credential file is never read as a transcript, under its own name or through a .jsonl link', () => {
  const b = box()
  const creds = join(b.home, '.claude', '.credentials.json')
  mkdirSync(dirname(creds), { recursive: true })
  writeFileSync(creds, '{"claudeAiOauth":{"accessToken":"x"}}\n')
  const auth = join(b.home, '.codex', 'auth.json')
  mkdirSync(dirname(auth), { recursive: true })
  writeFileSync(auth, '{"OPENAI_API_KEY":"x"}\n')
  const link = join(b.root, 'innocent.jsonl')
  symlinkSync(creds, link)
  const linkedAuth = join(b.root, 'auth.jsonl')
  symlinkSync(auth, linkedAuth)
  for (const p of [creds, auth, link]) {
    const r = b.write({ what: 'x', severity: 'low', harness: 'claude', transcript: p, excerpts: { lines: ['1'] } })
    assert.equal(r.code, 1, p)
    assert.match(r.err, /is not a session \.jsonl file/, p)
  }
  assert.equal(b.write({ what: 'x', severity: 'low', harness: 'claude', transcript: linkedAuth }).code, 1, 'a .jsonl link to auth.json')
  assert.equal(b.files().length, 0)
})

test('a string over 20,000 characters is cut with a marker, after redaction, so a key at the cut never leaks', () => {
  const b = box()
  const long = `${'x'.repeat(19990)} ${SECRETS.anthropic} ${'y'.repeat(5000)}`
  const r = b.write({ what: 'x', severity: 'low', harness: 'claude', agentTake: long })
  assert.equal(r.code, 0, r.err)
  const { text, data } = b.only()
  assert.ok(!text.includes(SECRETS.anthropic.slice(0, 14)), 'no part of the key')
  assert.match(data.agentTake, /\[TRUNCATED \d+ chars\]$/)
  assert.equal(data.agentTake.length, 20000 + data.agentTake.match(/\[TRUNCATED \d+ chars\]$/)[0].length)
})

test('find lists the matching lines with their tool ids and a redacted preview', () => {
  const b = box()
  const t = claudeTranscript(b)
  const r = b.run(['find', '--transcript', t.file, '--text', 'lockfile'])
  assert.equal(r.code, 0, r.err)
  const rows = r.out.trim().split('\n')
  assert.equal(rows[0], `${t.file} (given)`)
  assert.equal(rows.length, 2)
  assert.match(rows[1], /^3\ttoolu_01AAA\t-\t.*ERR lockfile/)
  assert.ok(!r.out.includes(SECRETS.openai))
  const call = b.run(['find', '--transcript', t.file, '--text', 'pnpm install'])
  assert.match(call.out, /\n2\ttoolu_01AAA\tBash\t/)
  const none = b.run(['find', '--harness', 'claude', '--text', 'x'])
  assert.equal(none.code, 1)
  assert.match(none.err, /no transcript found/)
})

// A report as write leaves it, with a chosen time and project.
function plant(b, id, ts, name, extra = {}) {
  mkdirSync(b.reports, { recursive: true })
  writeFileSync(join(b.reports, `${id}.json`), JSON.stringify({ id, ts, project: { path: `/w/${name}`, name }, branch: 'main', severity: 'low', what: `about ${id}`, ...extra }))
}

test('list: newest first; --since takes a date or 7d / 24h; --project takes a name or a path; --json gives the reports', () => {
  const b = box()
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString()
  plant(b, 'old', '2026-01-02T00:00:00.000Z', 'alpha')
  plant(b, 'mid', day(3), 'beta')
  plant(b, 'new', day(0.1), 'alpha')
  const all = b.run(['list'])
  assert.equal(all.code, 0, all.err)
  assert.deepEqual(all.out.trim().split('\n').map((l) => l.split('\t')[0]), ['new', 'mid', 'old'])
  assert.match(all.out.split('\n')[0], /^new\t\S+\tlow\talpha\tmain\tabout new$/)
  const ids = (args) => JSON.parse(b.run(['list', '--json', ...args]).out).map((r) => r.id)
  assert.deepEqual(ids(['--since', '7d']), ['new', 'mid'])
  assert.deepEqual(ids(['--since', '24h']), ['new'])
  assert.deepEqual(ids(['--since', '2026-01-01']), ['new', 'mid', 'old'])
  assert.deepEqual(ids(['--since', '2026-01-03']), ['new', 'mid'])
  assert.deepEqual(ids(['--project', 'alpha']), ['new', 'old'])
  assert.deepEqual(ids(['--project', '/w/beta']), ['mid'])
  assert.deepEqual(ids(['--project', 'alpha', '--since', '7d']), ['new'])
  assert.equal(JSON.parse(b.run(['list', '--json']).out)[0].what, 'about new')
})

test('list: an unreadable report is named and skipped; a bad --since is refused; no reports says so', () => {
  const b = box()
  assert.equal(b.run(['list']).out, 'no field reports\n')
  plant(b, 'good', new Date().toISOString(), 'alpha')
  writeFileSync(join(b.reports, 'broken.json'), '{nope')
  const r = b.run(['list'])
  assert.equal(r.code, 0)
  assert.match(r.err, /skipped broken\.json/)
  assert.match(r.out, /^good\t/)
  const bad = b.run(['list', '--since', 'last tuesday'])
  assert.equal(bad.code, 1)
  assert.match(bad.err, /--since last tuesday: give a date/)
})

test('show prints one report; an unknown id or a path is refused', () => {
  const b = box()
  plant(b, 'one', new Date().toISOString(), 'alpha')
  assert.equal(JSON.parse(b.run(['show', 'one']).out).id, 'one')
  assert.match(b.run(['show', 'two']).err, /no report two/)
  assert.match(b.run(['show', '../x']).err, /show needs a report id/)
  assert.match(b.run(['nope']).err, /unknown command nope/)
})

/* ── fix round: review 2026-11-03-00-17-41-9c26c6 ───────────────────── */

test('f1: an escaped quote around a value in JSON-encoded text does not leave the value behind', () => {
  const cmd = { cmd: 'DB_PASSWORD="opaque-pass" npm start' }
  for (const s of [JSON.stringify(cmd), `ran: ${JSON.stringify(cmd)}`, `twice: ${JSON.stringify(JSON.stringify(cmd))}`, String.raw`MY_TOKEN=\"opaque-pass\"`]) {
    const out = redactText(s)
    assert.ok(!out.includes('opaque-pass'), `${s} -> ${out}`)
    assert.match(out, /\[REDACTED:named-secret\]/, s)
  }
  assert.equal(redactText(String.raw`{\"api_key\": \"opaque-value\"}`), String.raw`{\"api_key\": \"[REDACTED:named-secret]\"}`)
})

test('f2: a Basic credential is redacted from its value alone, with no header name beside it', () => {
  const cred = b64('agent:opaque-pass')
  assert.deepEqual(redact({ headers: { Authorization: `Basic ${cred}` } }), { headers: { Authorization: 'Basic [REDACTED:basic-auth]' } })
  assert.equal(redactText(`["Basic ${cred}"]`), '["Basic [REDACTED:basic-auth]"]')
  assert.equal(redactText(`auth=Basic ${cred}`), 'auth=Basic [REDACTED:basic-auth]')
})

test('f3: a string under a secret-named key is redacted even when it reads as a number or a boolean', () => {
  assert.deepEqual(redact({ password: '123456', client_secret: 'false', api_key: '42', token: 'null' }),
    { password: '[REDACTED:named-secret]', client_secret: '[REDACTED:named-secret]', api_key: '[REDACTED:named-secret]', token: '[REDACTED:named-secret]' })
  assert.deepEqual(redact({ max_tokens: 4096, input_tokens: 2 }), { max_tokens: 4096, input_tokens: 2 })
  assert.equal(redactText('PASSWORD=123456 make'), 'PASSWORD=[REDACTED:named-secret] make')
  assert.equal(redactText('--password 000000'), '--password [REDACTED:named-secret]')
  assert.equal(redactText('max_tokens=4096'), 'max_tokens=4096')
})

test('f4: the secret-name context reaches through arrays and nested objects', () => {
  assert.deepEqual(redact({ api_tokens: ['opaque-credential-value', 'second-one'], auth: { secrets: [{ v: 'x1y2z3w4' }, ['deep-value']] }, list: ['fine'] }),
    { api_tokens: ['[REDACTED:named-secret]', '[REDACTED:named-secret]'], auth: { secrets: [{ v: '[REDACTED:named-secret]' }, ['[REDACTED:named-secret]']] }, list: ['fine'] })
})

test('a secret found once is scrubbed wherever else it appears, raw or escaped; plain words are not', () => {
  const secret = 'Zq9"opaque-77'
  const out = redact({ env: { DB_PASSWORD: secret }, log: `connected with ${secret}`, raw: JSON.stringify({ x: secret }), raw2: JSON.stringify(JSON.stringify({ x: secret })), mode: { token: 'standard' }, tier: 'standard' })
  assert.ok(!JSON.stringify(out).includes('opaque-77'), JSON.stringify(out))
  assert.deepEqual([out.raw, out.raw2], [JSON.stringify({ x: '[REDACTED:named-secret]' }), JSON.stringify(JSON.stringify({ x: '[REDACTED:named-secret]' }))], 'the JSON-escaped forms, once and twice')
  assert.equal(out.log, 'connected with [REDACTED:named-secret]')
  assert.deepEqual([out.mode.token, out.tier], ['[REDACTED:named-secret]', 'standard'], 'a plain word is redacted where found, not everywhere')
})

test('f5: find redacts the whole line before cutting the preview, so a key or password outside the window never shows', () => {
  const b = box()
  const body = Array.from({ length: 40 }, (_, i) => `MIIEpAIBAAKCAQEA${String(i).padStart(4, '0')}PlantedKeyMaterial`).join('\n')
  const pem = `-----BEGIN ${'RSA PRIVATE KEY'}-----\n${body}\n-----END ${'RSA PRIVATE KEY'}-----`
  const file = join(b.root, 's.jsonl')
  writeFileSync(file, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_k', content: pem }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_p', name: 'Bash', input: { command: `deploy --password${' '.repeat(120)}Wide-Gap-Secret-9 --target prod` } }] } }),
  ].join('\n') + '\n')
  const key = b.run(['find', '--transcript', file, '--text', '0020PlantedKeyMaterial'])
  assert.equal(key.code, 0, key.err)
  assert.ok(!key.out.includes('PlantedKeyMaterial') && !key.out.includes('MIIEpAIBAAKCAQEA'), key.out)
  assert.match(key.out, /\n1\ttoolu_k\t-\t\(the match is inside redacted text\) /)
  const pw = b.run(['find', '--transcript', file, '--text', '--target prod'])
  assert.ok(!pw.out.includes('Wide-Gap-Secret-9'), pw.out)
  assert.match(pw.out, /\n2\ttoolu_p\tBash\t/)
})

test('f6: find needs the harness for "auto"; the Codex skill passes --harness codex, which reaches the newest-in-cwd fallback', () => {
  const b = box()
  const t = codexTranscript(b)
  const none = b.run(['find', '--transcript', 'auto', '--text', 'gh pr list'])
  assert.equal(none.code, 1)
  assert.match(none.err, /pass --harness claude or --harness codex/)
  const found = b.run(['find', '--harness', 'codex', '--transcript', 'auto', '--text', 'gh pr list'])
  assert.equal(found.code, 0, found.err)
  assert.equal(found.out.split('\n')[0], `${t.file} (newest-in-cwd)`)
  assert.match(found.out, /\n3\tcall_abc\texec\t/)
  for (const h of ['claude', 'codex']) {
    const skill = readFileSync(resolve(dirname(FLAG), '../..', h, 'flag', 'SKILL.md'), 'utf8')
    assert.match(skill, new RegExp(`node "\\$FLAG" find --harness ${h} --transcript auto `), `${h} skill`)
  }
})

test('f7: list and show read only plain report files: a link (to a credential file or anything) and a non-report are skipped', () => {
  const b = box()
  plant(b, 'real', new Date().toISOString(), 'alpha')
  const creds = join(b.home, '.codex', 'auth.json')
  mkdirSync(dirname(creds), { recursive: true })
  writeFileSync(creds, '{"id":"x","ts":"2026-11-02T00:00:00Z","what":"x","OPENAI_API_KEY":"planted-cred-value"}\n')
  symlinkSync(creds, join(b.reports, 'linked.json'))
  writeFileSync(join(b.reports, 'other.json'), '{"some":"json"}')
  const l = b.run(['list', '--json'])
  assert.equal(l.code, 0, l.err)
  assert.deepEqual(JSON.parse(l.out).map((r) => r.id), ['real'])
  assert.ok(!l.out.includes('planted-cred-value'))
  assert.match(l.err, /skipped linked\.json: not a plain file/)
  assert.match(l.err, /skipped other\.json: not a field report/)
  const s = b.run(['show', 'linked'])
  assert.equal(s.code, 1)
  assert.ok(!s.out.includes('planted-cred-value'))
  assert.match(s.err, /linked: not a plain file/)
})

test('the property: a realistic transcript excerpt with every secret form, nested, escaped and in arrays, leaves no planted secret in the file', () => {
  const b = box()
  const basic = b64('deploy-bot:Basic-Pass-31')
  const planted = { ...SECRETS, basic, basicPass: 'Basic-Pass-31', dbpass: 'Db-Pass-0042', numpin: '918273', arr: 'Array-Held-Token-55', urlpass: 'Url-Pass-66', wide: 'Wide-Flag-Pass-77', envq: 'Env-Quoted-88', cookie: 'Cookie-Secret-99',
    // The follow-up shapes: short and plain-word secrets in embedded JSON, shell-escaped values, any-case Basic and Bearer.
    shortpw: 'zq7k', plainpw: 'marmalade', shortkey: 'kq9w', prefixedPlain: 'tangerine', shellEsc: 'Shell-Esc-Pass-5',
    lowerBasic: b64('u:lower-basic-pw'), upperBasic: b64('v:upper-basic-pw'), lowerBearer: 'lower-bearer-tok-1', upperBearer: 'UPPER-BEARER-TOK-2' }
  const nestedArgs = JSON.stringify({ cmd: `DB_PASSWORD="${planted.dbpass}" API_KEY=${SECRETS.openai} psql`, env: { GH_TOKEN: SECRETS.ghp } })
  const lines = [
    { type: 'assistant', message: { model: 'model-a', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_all', name: 'Bash', input: {
      command: `curl -H 'Authorization: Bearer ${SECRETS.bearer}' -H "x-api-key: ${SECRETS.anthropic}" https://bot:${planted.urlpass}@example.test && deploy --password      ${planted.wide}`,
      headers: { Authorization: `Basic ${basic}` }, pin: { password: planted.numpin }, api_tokens: [planted.arr, { nested: [SECRETS.npm] }] } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_all', content: [
      { type: 'text', text: `config: ${JSON.stringify({ client_secret: planted.cookie, keys: [SECRETS.aws, SECRETS.google], pem: SECRETS.pem })}` },
      { type: 'text', text: `export MY_SECRET="${planted.envq}"; echo ${SECRETS.slack} ${SECRETS.render} ${SECRETS.gitlab} ${SECRETS.jwt} ${SECRETS.ghpat} ${SECRETS.gho}` },
    ] }] }, toolUseResult: { stdout: `again: ${planted.dbpass} ${planted.cookie} ${planted.arr}`, stderr: JSON.stringify(JSON.stringify({ password: planted.dbpass })) } },
    { timestamp: 't', type: 'response_item', payload: { type: 'function_call', call_id: 'call_all', name: 'shell', arguments: nestedArgs } },
    { timestamp: 't', type: 'response_item', payload: { type: 'function_call', call_id: 'call_more', name: 'shell',
      arguments: JSON.stringify({ password: [planted.shortpw, planted.plainpw], api_key: planted.shortkey, cmd: String.raw`DB_PASSWORD=\$${planted.shellEsc} tool` }) } },
    { timestamp: 't', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_more', output:
      `note: ${JSON.stringify({ password: planted.prefixedPlain })} then authorization: basic ${planted.lowerBasic}, BASIC ${planted.upperBasic}, bearer ${planted.lowerBearer} BEARER ${planted.upperBearer}; ` +
      `again: ${JSON.stringify(JSON.stringify({ api_key: planted.shortkey }))}` } },
    { timestamp: 't', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_all', output: `ran ${nestedArgs}` } },
  ]
  const file = join(b.root, 'all.jsonl')
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
  const r = b.write({ what: `leak test ${planted.dbpass}`, severity: 'high', harness: 'claude', transcript: file, excerpts: { toolIds: ['toolu_all', 'call_all', 'call_more'] },
    agentTake: `the result held ${planted.cookie}`, toolCalls: [{ name: 'Bash', input: nestedArgs }] })
  assert.equal(r.code, 0, r.err)
  const { text, data } = b.only()
  assert.equal(data.toolCalls.length, 1, 'the agent quote')
  assert.equal(data.excerpts.lines.length, 6, 'six transcript lines, referenced')
  const leaks = Object.entries(planted).filter(([, v]) => text.includes(v) || text.includes(JSON.stringify(v).slice(1, -1)))
  assert.deepEqual(leaks.map(([k]) => k), [], 'planted secrets left in the written file')
  const s = b.run(['show', data.id])
  assert.equal(Object.keys(shown(s.out)).length, 6)
  assert.deepEqual(Object.entries(planted).filter(([, v]) => s.out.includes(v) || s.out.includes(JSON.stringify(v).slice(1, -1))).map(([k]) => k), [], 'planted secrets in show output')
  for (const text of ['toolu_all', 'call_more']) {
    const f = b.run(['find', '--transcript', file, '--text', text])
    assert.ok(f.out.split('\n').length > 2, f.out)
    assert.deepEqual(Object.entries(planted).filter(([, v]) => f.out.includes(v)).map(([k]) => k), [], `planted secrets in find output for ${text}`)
  }
})

/* ── follow-up: the fix check's four gaps (x1–x4) ───────────────────── */

test('x1: short and plain-word secrets inside embedded JSON stay redacted, in the redacted structure itself', () => {
  const out = redact({ arguments: JSON.stringify({ password: ['1234', 'secret'], api_key: '42', note: 'fine' }) })
  assert.deepEqual(JSON.parse(out.arguments), { password: ['[REDACTED:named-secret]', '[REDACTED:named-secret]'], api_key: '[REDACTED:named-secret]', note: 'fine' })
  const pretty = `${JSON.stringify({ a: 1, secret: 'plain' }, null, 2)}\n`
  assert.equal(redactText(pretty), pretty.replace('"plain"', '"[REDACTED:named-secret]"'), 'the piece keeps its own formatting')
})

test('x2: a bare value with backslash-escaped characters is consumed whole', () => {
  assert.equal(redactText(String.raw`DB_PASSWORD=\$OpaquePass123 tool`), 'DB_PASSWORD=[REDACTED:named-secret] tool')
  assert.equal(redactText(String.raw`--api-key ab\ cd\$ef next`), '--api-key [REDACTED:named-secret] next')
})

test('x3: Basic and Bearer are matched in any case', () => {
  for (const w of ['basic', 'BASIC', 'Basic', 'bAsIc']) assert.equal(redactText(`${w} ${b64('u:opaque-pw')}`), `${w} [REDACTED:basic-auth]`, w)
  for (const w of ['bearer', 'BEARER', 'Bearer']) assert.equal(redactText(`${w} opaque-token-123`), `${w} [REDACTED:bearer]`, w)
})

test('x4: JSON after other text (or JSON-encoded inside it) gets the structured walk too', () => {
  assert.equal(redactText(`config: ${JSON.stringify({ api_tokens: ['Array-Held-Token-55'] })} tail`), 'config: {"api_tokens":["[REDACTED:named-secret]"]} tail')
  assert.equal(redactText(`a {"password":"pw"} b [{"secret":"s1"}] c {not json} [1, 2]`), 'a {"password":"[REDACTED:named-secret]"} b [{"secret":"[REDACTED:named-secret]"}] c {not json} [1, 2]')
  const twice = `stderr: ${JSON.stringify(JSON.stringify({ password: '1234' }))}`
  assert.equal(redactText(twice), `stderr: ${JSON.stringify(JSON.stringify({ password: '[REDACTED:named-secret]' }))}`)
})

/* ── follow-up fix round: review 2026-11-03-00-57-10-e98dd6 ─────────── */

test('f1: JSON encoded inside a JSON string is decoded before its brackets are matched: arrays and nested secret containers', () => {
  const twice = (v) => JSON.stringify(JSON.stringify(v))
  const value = { password: ['Dbl-Arr-1', 'Dbl-Arr-2'], nest: { auth: { secrets: [{ v: 'deep9' }, ['deeper'] ] } }, keep: 'fine' }
  const out = redactText(`log: ${twice(value)} end`)
  assert.equal(out, `log: ${twice({ password: ['[REDACTED:named-secret]', '[REDACTED:named-secret]'], nest: { auth: { secrets: [{ v: '[REDACTED:named-secret]' }, ['[REDACTED:named-secret]']] } }, keep: 'fine' })} end`)
  assert.equal(redactText(twice([{ api_key: 'k1' }, { list: [1, 2] }])), twice([{ api_key: '[REDACTED:named-secret]' }, { list: [1, 2] }]))
  // Without its surrounding quotes, as a fragment of an escaped log line.
  const bare = JSON.stringify(JSON.stringify({ password: ['frag-pw'] })).slice(1, -1)
  assert.ok(!redactText(`args=${bare};`).includes('frag-pw'), redactText(`args=${bare};`))
})

test('f2: a string too long to scan is replaced whole with [REDACTED:oversize], never passed through unread', () => {
  const b = box()
  const big = JSON.stringify({ password: ['Megabyte-Pass-13'], pad: 'x'.repeat(1 << 20) })
  assert.equal(redact({ big }).big, '[REDACTED:oversize]')
  const r = b.write({ what: 'x', severity: 'low', harness: 'claude', agentTake: big })
  assert.equal(r.code, 0, r.err)
  const { text, data } = b.only()
  assert.ok(!text.includes('Megabyte-Pass-13'))
  assert.equal(data.agentTake, '[REDACTED:oversize]')
  const justUnder = `${JSON.stringify({ password: ['Under-Limit-7'] })} ${'y'.repeat((1 << 20) - 100)}`
  assert.ok(!redactText(justUnder).includes('Under-Limit-7'), 'under the limit the structured walk still runs')
})

test('a string whose brackets would take too long to match is replaced whole with [REDACTED:unscannable], quickly', () => {
  const t = Date.now()
  assert.equal(redactText(`${'{'.repeat(200000)} "password": ["Brace-Pw-3"]`), '[REDACTED:unscannable]')
  assert.ok(Date.now() - t < 5000, `${Date.now() - t}ms`)
  const code = `function f() { if (a) { return [1, {b: 2}] } }\n`.repeat(2000)
  assert.equal(redactText(code), code, 'ordinary bracket-heavy text is scanned, not given up on')
})

test('f3: only the secret strings change in embedded JSON; big integers, number forms and spacing stay byte-exact', () => {
  const src = '{"password":"pw","note":"pw","id":9007199254740993,  "f": 1.50e+3, "neg":-0.0,\n "arr":[ 1 ,2 ], "esc":"a\\/b\\u0041"}'
  const want = src.replace('"password":"pw"', '"password":"[REDACTED:named-secret]"')
  assert.equal(redactText(src), want)
  assert.equal(redactText(`prefix ${src} suffix`), `prefix ${want} suffix`)
  const enc = JSON.stringify(src)
  assert.equal(redactText(enc), JSON.stringify(want), 'encoded once more, too')
  const b = box()
  const r = b.write({ what: 'x', severity: 'low', harness: 'claude', toolCalls: [src] })
  assert.equal(r.code, 0, r.err)
  assert.equal(b.only().data.toolCalls[0].quote, want)
})

test('a long run of name characters is matched once, not retried from every position (no quadratic time)', () => {
  const t = Date.now()
  for (const s of ['y'.repeat((1 << 20) - 10), 'tokentokentoken'.repeat(60000), `${'a'.repeat(500000)}_PASSWORD=Run-Pw-1`]) redactText(s)
  assert.ok(Date.now() - t < 5000, `${Date.now() - t}ms`)
  assert.equal(redactText(`x ${'a'.repeat(50)}_PASSWORD=Run-Pw-1 y`), `x ${'a'.repeat(50)}_PASSWORD=[REDACTED:named-secret] y`)
})

/* ── excerpts are references to the transcript, never copies ────────── */

test('refs: an excerpt stores the real path, the line numbers, the tool ids and each line\'s sha256, and no transcript text', () => {
  const b = box()
  // A secret in a shape redact() does not know: no prefix, no secret-named key, no Bearer, nothing to match.
  const unknown = 'qz' + 'Vx8-Lm3Pw9-Tr4Kd7-Unknown-Shape-Cred'
  const file = join(b.root, 'unk.jsonl')
  const lines = [
    { type: 'assistant', message: { model: 'model-a', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_unk', name: 'Bash', input: { command: `deploy ${unknown} --distinctive-transcript-marker` } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_unk', content: `echoed ${unknown}` }] } },
    { type: 'user', message: { role: 'user', content: 'plain line about unrelated-transcript-prose' } },
  ]
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
  const link = join(b.root, 'link.jsonl')
  symlinkSync(file, link)
  const r = b.write({ what: 'x', severity: 'low', harness: 'claude', transcript: link, excerpts: { toolIds: ['toolu_unk'], lines: ['3'] } })
  assert.equal(r.code, 0, r.err)
  const { text, data } = b.only()
  assert.ok(!text.includes(unknown), 'the unknown-shape secret is in the written report')
  for (const s of ['--distinctive-transcript-marker', 'echoed', 'unrelated-transcript-prose', 'tool_result']) assert.ok(!text.includes(s), `transcript text "${s}" is in the report`)
  const raw = transcriptLines(file)
  assert.deepEqual(data.excerpts, { transcript: file, toolIds: ['toolu_unk'], lines: [1, 2, 3].map((n) => ({ line: n, sha256: sha(raw[n - 1]) })) })
  assert.deepEqual(data.toolCalls, [], 'no transcript entry is copied into toolCalls')
  // list --json returns the stored reference, not resolved text.
  const listed = b.run(['list', '--json'])
  assert.deepEqual(JSON.parse(listed.out)[0].excerpts, data.excerpts)
  assert.ok(!listed.out.includes(unknown) && !listed.out.includes('echoed'))
})

test('refs: show reads the referenced lines now, redacted; --refs-only prints only the stored report; nothing is written', () => {
  const b = box()
  const t = claudeTranscript(b)
  assert.equal(b.write({ what: 'x', severity: 'low', harness: 'claude', transcript: t.file, excerpts: { toolIds: ['toolu_01AAA'] } }).code, 0)
  const { data, text: before } = b.only()
  const s = b.run(['show', data.id])
  assert.equal(s.code, 0, s.err)
  assert.match(s.out, /--- excerpts, read now from .* \(redacted, not stored\) ---\n2\t\{.*pnpm install.*\n3\t\{.*ERR lockfile.*\[REDACTED:openai-key\]/s)
  assert.ok(!s.out.includes(SECRETS.openai) && !s.out.includes(SECRETS.anthropic) && !s.out.includes(SECRETS.ghp))
  assert.ok(!s.out.includes('CHANGED'))
  const refs = b.run(['show', data.id, '--refs-only'])
  assert.equal(refs.code, 0, refs.err)
  assert.deepEqual(JSON.parse(refs.out), data, 'just the stored report, references only')
  assert.ok(!refs.out.includes('ERR lockfile'))
  assert.equal(b.only().text, before, 'show leaves the report as it was')
  assert.equal(b.files().length, 1)
})

test('refs: show marks a line whose sha256 no longer matches, and a line past the end', () => {
  const b = box()
  const t = claudeTranscript(b)
  assert.equal(b.write({ what: 'x', severity: 'low', harness: 'claude', transcript: t.file, excerpts: { lines: ['2-4'] } }).code, 0)
  const { data } = b.only()
  const raw = transcriptLines(t.file)
  raw[1] = JSON.stringify({ type: 'user', message: { role: 'user', content: 'rewritten line' } })
  writeFileSync(t.file, `${raw.slice(0, 3).join('\n')}\n`)
  const s = b.run(['show', data.id])
  assert.equal(s.code, 0, s.err)
  assert.match(s.out, /\n2\t\[CHANGED since the report: this line no longer matches its sha256\] .*rewritten line/)
  assert.match(s.out, /\n3\t\{/)
  assert.ok(!/\n3\t\[CHANGED/.test(s.out), 'an unchanged line is not marked')
  assert.match(s.out, /\n4\t\[MISSING: the transcript now has 3 lines\]/)
})

test('refs: show says plainly when the transcript is gone, and never reads a credential file swapped in for it', () => {
  const b = box()
  const t = claudeTranscript(b)
  assert.equal(b.write({ what: 'x', severity: 'low', harness: 'claude', transcript: t.file, excerpts: { lines: ['1'] } }).code, 0)
  const { data } = b.only()
  rmSync(t.file)
  const gone = b.run(['show', data.id])
  assert.equal(gone.code, 0, gone.err)
  assert.match(gone.out, /the transcript is gone \(the harness may have cleaned it up\)/)
  assert.equal(JSON.parse(gone.out.split('\n--- excerpts')[0]).id, data.id, 'the report itself still shows')
  const creds = join(b.home, '.claude', '.credentials.json')
  writeFileSync(creds, '{"claudeAiOauth":{"accessToken":"planted-cred-value"}}\n')
  symlinkSync(creds, t.file)
  const swapped = b.run(['show', data.id])
  assert.match(swapped.out, /not read: transcript .* is not a session \.jsonl file/)
  assert.ok(!swapped.out.includes('planted-cred-value'))
})

test('refs: a report written before references (copied excerpt text in toolCalls) still lists and shows, unchanged', () => {
  const b = box()
  const copied = { source: 'transcript', line: 3, entry: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: 'ERR old copied text' }] } } }
  plant(b, 'legacy', new Date().toISOString(), 'alpha', { transcript: '/gone/old.jsonl', transcriptHow: 'given', toolCalls: [{ source: 'agent', quote: 'q' }, copied] })
  const l = b.run(['list'])
  assert.equal(l.code, 0, l.err)
  assert.match(l.out, /^legacy\t/)
  const s = b.run(['show', 'legacy'])
  assert.equal(s.code, 0, s.err)
  assert.deepEqual(JSON.parse(s.out).toolCalls[1], copied, 'shown as stored, with no excerpt section to resolve')
  assert.deepEqual(JSON.parse(b.run(['list', '--json']).out)[0].toolCalls[1], copied)
})

/* ── fix round: review 2026-11-03-15-35-39-6c0d61 ───────────────────── */

// A call whose result echoes `pass`, and a report referencing only the result line.
function echoTranscript(b, callInput) {
  const file = join(b.root, 'echo.jsonl')
  const lines = [
    { type: 'assistant', message: { model: 'model-a', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_echo', name: 'Bash', input: callInput }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_echo', content: 'unrelated' }] } },
  ]
  return { file, lines, write: (pass) => { lines[1].message.content[0].content = `connected; session for ${pass} open`; writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`) } }
}

test('g1: a result-only excerpt whose password sits under a secret-named field only in its call: show never prints it', () => {
  const b = box()
  const pass = 'Opaque-Ctx-Pass-1'
  const t = echoTranscript(b, { command: 'psql', password: pass })
  t.write(pass)
  assert.equal(b.write({ what: 'x', severity: 'low', harness: 'claude', transcript: t.file, excerpts: { lines: ['2'] } }).code, 0)
  const { text, data } = b.only()
  assert.ok(!text.includes(pass))
  assert.deepEqual(data.excerpts.lines.map((l) => l.line), [2])
  const s = b.run(['show', data.id])
  assert.equal(s.code, 0, s.err)
  assert.ok(!s.out.includes(pass), s.out)
  assert.equal(shown(s.out)[2].message.content[0].content, 'connected; session for [REDACTED:named-secret] open')
  assert.ok(!/\n1\t/.test(s.out), 'the call line is context only, never printed')
})

test('g2: the same, with the secret name only in the agent\'s quote: show never prints it, and withholds the line if it changed', () => {
  const b = box()
  const pass = 'Opaque-Quote-Pass-2'
  const t = echoTranscript(b, { command: `psql -W ${pass}` })
  t.write(pass)
  assert.equal(b.write({ what: 'x', severity: 'low', harness: 'claude', transcript: t.file, excerpts: { lines: ['2'] }, toolCalls: [`DB_PASSWORD=${pass} psql`] }).code, 0)
  const { text, data } = b.only()
  assert.ok(!text.includes(pass))
  const s = b.run(['show', data.id])
  assert.equal(s.code, 0, s.err)
  assert.ok(!s.out.includes(pass), s.out)
  assert.match(shown(s.out)[2].message.content[0].content, /^connected; session for \[REDACTED:[a-z-]+\] open$/)
  t.write(`${pass} `)
  const changed = b.run(['show', data.id])
  assert.ok(!changed.out.includes(pass), changed.out)
  assert.match(changed.out, /\n2\t\[CHANGED since the report: this line no longer matches its sha256; not shown, it held a secret learned elsewhere\]\n/)
})

/* ── deferred finding x1 (PR #33) ────────────────────────────────────── */

test('x1: call and result both referenced, the agent\'s quote naming the whole assignment: the mask never hides the password from show', () => {
  const b = box()
  const pass = 'Opaque-Overlap-Pass-3'
  const t = echoTranscript(b, { command: `DB_PASSWORD=${pass} psql` })
  t.write(pass)
  assert.equal(b.write({ what: 'x', severity: 'low', harness: 'claude', transcript: t.file, excerpts: { lines: ['1-2'] }, toolCalls: [`MY_SECRET='DB_PASSWORD=${pass}' tool`] }).code, 0)
  const { text, data } = b.only()
  assert.ok(!text.includes(pass))
  assert.ok(data.excerpts.lines[0].mask?.length, 'the call line carries a mask, so this is the overlapping case')
  const s = b.run(['show', data.id])
  assert.equal(s.code, 0, s.err)
  assert.ok(!s.out.includes(pass), s.out)
  assert.match(shown(s.out)[2].message.content[0].content, /^connected; session for \[REDACTED:[a-z-]+\] open$/)
})
