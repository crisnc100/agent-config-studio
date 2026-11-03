#!/usr/bin/env node
/**
 * flag.test.mjs — the /flag helper: reports written with their modes, every redaction kind (inside a transcript
 * excerpt too), excerpts copied by line and by tool id from Claude Code and Codex transcripts, the refusals, and
 * list with its filters. Every run is a temp HOME; no real ~/.claude, ~/.codex or ~/.agent-config-studio is read.
 * Planted secrets are built at run time so no scanner mistakes this file for a leak.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { redact, redactText } from '../skills/claude/flag/flag.mjs'

const b64 = (s) => Buffer.from(s).toString('base64')

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

test('a Claude Code excerpt by tool id copies the call and its result verbatim, with the planted keys redacted', () => {
  const b = box()
  const t = claudeTranscript(b)
  const r = b.write({ what: 'asked to paste a command', severity: 'medium', harness: 'claude', transcript: t.file, excerpts: { toolIds: ['toolu_01AAA'] } })
  assert.equal(r.code, 0, r.err)
  const { text, data } = b.only()
  assert.ok(!text.includes(SECRETS.openai) && !text.includes(SECRETS.anthropic) && !text.includes(SECRETS.ghp), 'a planted key leaked from the excerpt')
  assert.deepEqual(data.toolCalls.map((c) => [c.source, c.line]), [['transcript', 2], ['transcript', 3]])
  assert.deepEqual(data.toolCalls[0].entry, t.lines[1], 'the call is copied as it was')
  const result = structuredClone(t.lines[2])
  result.message.content[0].content = 'ERR lockfile; env had OPENAI_API_KEY=[REDACTED:openai-key] and [REDACTED:anthropic-key]'
  result.toolUseResult.stdout = 'token [REDACTED:github-token]'
  assert.deepEqual(data.toolCalls[1].entry, result, 'the result is copied as it was, only the secrets replaced')
  assert.deepEqual([data.transcript, data.transcriptHow, data.model], [t.file, 'given', 'model-b'])
})

test('excerpts by line range, merged with tool ids, in order and without repeats; numbers in usage stay', () => {
  const b = box()
  const t = claudeTranscript(b)
  const r = b.write({ what: 'x', severity: 'low', harness: 'claude', transcript: t.file, excerpts: { lines: ['3-4', '1'], toolIds: ['toolu_01AAA'] } })
  assert.equal(r.code, 0, r.err)
  const { data } = b.only()
  assert.deepEqual(data.toolCalls.map((c) => c.line), [1, 2, 3, 4])
  assert.deepEqual(data.toolCalls[3].entry.message.usage, { input_tokens: 2, output_tokens: 9 })
})

test('transcript "auto" in Claude Code finds this session from CLAUDE_CODE_SESSION_ID', () => {
  const b = box()
  const t = claudeTranscript(b, 'sess-auto')
  const r = b.write({ what: 'x', severity: 'low', harness: 'claude', transcript: 'auto', excerpts: { lines: ['2'] } }, { extra: { CLAUDE_CODE_SESSION_ID: 'sess-auto' } })
  assert.equal(r.code, 0, r.err)
  const { data } = b.only()
  assert.deepEqual([data.transcript, data.transcriptHow, data.toolCalls[0].entry.uuid], [t.file, 'session-id', 'a1'])
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

test('a Codex excerpt by call id copies the call and its output, redacted; the model comes from turn_context', () => {
  const b = box()
  const t = codexTranscript(b)
  const r = b.write({ what: 'x', severity: 'low', harness: 'codex', transcript: t.file, excerpts: { toolIds: ['call_abc', 'call_old'] } })
  assert.equal(r.code, 0, r.err)
  const { text, data } = b.only()
  assert.ok(!text.includes(SECRETS.gho) && !text.includes(SECRETS.jwt))
  assert.deepEqual(data.toolCalls.map((c) => c.line), [3, 4, 5])
  assert.equal(data.toolCalls[0].entry.payload.input, 'export GH_TOKEN=[REDACTED:github-token]; gh pr list')
  assert.equal(data.toolCalls[1].entry.payload.output[0].text, 'denied: [REDACTED:jwt]')
  assert.deepEqual(data.toolCalls[2].entry, t.lines[4])
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
  const planted = { ...SECRETS, basic, basicPass: 'Basic-Pass-31', dbpass: 'Db-Pass-0042', numpin: '918273', arr: 'Array-Held-Token-55', urlpass: 'Url-Pass-66', wide: 'Wide-Flag-Pass-77', envq: 'Env-Quoted-88', cookie: 'Cookie-Secret-99' }
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
    { timestamp: 't', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_all', output: `ran ${nestedArgs}` } },
  ]
  const file = join(b.root, 'all.jsonl')
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
  const r = b.write({ what: `leak test ${planted.dbpass}`, severity: 'high', harness: 'claude', transcript: file, excerpts: { toolIds: ['toolu_all', 'call_all'] },
    agentTake: `the result held ${planted.cookie}`, toolCalls: [{ name: 'Bash', input: nestedArgs }] })
  assert.equal(r.code, 0, r.err)
  const { text, data } = b.only()
  assert.equal(data.toolCalls.length, 5, 'the agent quote and four transcript lines')
  const leaks = Object.entries(planted).filter(([, v]) => text.includes(v) || text.includes(JSON.stringify(v).slice(1, -1)))
  assert.deepEqual(leaks.map(([k]) => k), [], 'planted secrets left in the written file')
  const f = b.run(['find', '--transcript', file, '--text', 'toolu_all'])
  assert.deepEqual(Object.entries(planted).filter(([, v]) => f.out.includes(v)).map(([k]) => k), [], 'planted secrets in find output')
})
