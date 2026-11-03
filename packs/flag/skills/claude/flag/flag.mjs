#!/usr/bin/env node
/**
 * flag.mjs — write and list workflow field reports.
 *
 * When an agent hits a problem with its own workflow (a skill that says the wrong thing, a rule
 * misread, a gate that asks the user to do something by hand), the /flag skill files a report here
 * so a later session can group the reports and fix the rules with evidence instead of memory.
 *
 * USAGE
 *   node flag.mjs write < report.json        # one report from JSON on stdin; prints its id and path
 *   node flag.mjs find --transcript <path|auto> --text <s> [--harness claude|codex]
 *   node flag.mjs list [--since 2026-11-01|7d|24h] [--project <name|path>] [--json]
 *   node flag.mjs show <id>
 *
 * The input is JSON, never argv, so nothing in it sits in a process list or shell history:
 *   { "what", "severity": "low|medium|high", "expected", "rulesInForce": [], "toolCalls": [],
 *     "agentTake", "harness", "model", "transcript": "<path>|auto",
 *     "excerpts": { "lines": ["120-140"], "toolIds": ["toolu_…", "call_…"] } }
 * Excerpts copy those transcript lines verbatim (a tool id brings its call and its result).
 *
 * Every string is redacted before anything is written (redact() below). Reports land in
 * ~/.agent-config-studio/field-reports/<date>-<slug>-<rand>.json, 0600, in a 0700 folder.
 * The only files read are the reports and the one transcript named; never a credential file.
 *
 * Exit: 0 done · 1 bad input or not found · 3 the sandbox refused the write (rerun with permission)
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = process.env.HOME || ''
const REPORTS = join(HOME, '.agent-config-studio', 'field-reports')
const SEVERITIES = ['low', 'medium', 'high']
const HARNESSES = ['claude', 'codex', 'grok']
const INPUT_KEYS = ['what', 'severity', 'expected', 'rulesInForce', 'toolCalls', 'agentTake', 'harness', 'model', 'transcript', 'excerpts']
const MAX_STRING = 20000
const MAX_EXCERPT = 200
const CREDENTIAL_FILE = /^(?:\.credentials\.json|auth\.json|credentials(?:\.json)?)$|keychain/i

class Refusal extends Error {}
const refuse = (msg) => { throw new Refusal(msg) }

/* ── redaction ───────────────────────────────────────────────────────── */

const SECRET_NAME = /key|token|secret|passw(?:or)?d/i
const mark = (kind) => `[REDACTED:${kind}]`
const NOT_ALNUM = '(?<![A-Za-z0-9])'
const TOKENS = [
  ['anthropic-key', new RegExp(`${NOT_ALNUM}sk-ant-[A-Za-z0-9_-]{10,}`, 'g')],
  ['openai-key', new RegExp(`${NOT_ALNUM}sk-[A-Za-z0-9_-]{16,}`, 'g')],
  ['github-token', new RegExp(`${NOT_ALNUM}(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`, 'g')],
  ['slack-token', new RegExp(`${NOT_ALNUM}xox[a-z]-[A-Za-z0-9-]{10,}`, 'g')],
  ['aws-key', new RegExp(`${NOT_ALNUM}(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])`, 'g')],
  ['render-key', new RegExp(`${NOT_ALNUM}rnd_[A-Za-z0-9]{16,}`, 'g')],
  ['google-key', new RegExp(`${NOT_ALNUM}AIza[0-9A-Za-z_-]{30,}`, 'g')],
  ['gitlab-token', new RegExp(`${NOT_ALNUM}glpat-[A-Za-z0-9_-]{20,}`, 'g')],
  ['npm-token', new RegExp(`${NOT_ALNUM}npm_[A-Za-z0-9]{30,}`, 'g')],
]
// NAME=value, "name": "value", name: value — the name holding key, token, secret or password.
const ASSIGNED = /(["']?)([A-Za-z0-9_.-]*(?:key|token|secret|passw(?:or)?d)[A-Za-z0-9_.-]*)\1(\s*)([=:])(\s*)(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"'`,;&|(){}[\]<>]+))/gi
// --api-key value, -token value (the = form is ASSIGNED's).
const FLAG = /(\s|^)(--?[A-Za-z0-9_-]*(?:key|token|secret|passw(?:or)?d)[A-Za-z0-9_-]*)(\s+)(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"'`;&|(){}[\]<>]+))/gi

const harmless = (v) => v === '' || v.startsWith('[REDACTED') || /^-?\d+(?:\.\d+)?$/.test(v) || /^(?:true|false|null|undefined|none)$/i.test(v)

// After a ':' the text may be prose ("token: the agent…"), so a value redacts only when it looks like one.
function secretAfterColon(name, value, quoted) {
  return (/^[A-Z0-9_.-]+$/.test(name) && /[A-Z]/.test(name)) || quoted || /\d/.test(value) || value.length >= 8
}

/** One string with every secret it holds replaced by [REDACTED:<kind>]. */
export function redactText(s) {
  let out = s
    .replace(/-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g, mark('private-key'))
    .replace(/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, mark('jwt'))
    .replace(/\b(Bearer)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, (_, w, sp) => `${w}${sp}${mark('bearer')}`)
    .replace(/\b(Authorization["']?\s*[:=]\s*["']?Basic)(\s+)[A-Za-z0-9+/=]{8,}/gi, (_, w, sp) => `${w}${sp}${mark('basic-auth')}`)
  for (const [kind, re] of TOKENS) out = out.replace(re, mark(kind))
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)@/gi, (_, head) => `${head}${mark('url-password')}@`)
  out = out.replace(ASSIGNED, (all, q, name, sp1, sep, sp2, dq, sq, bare) => {
    const value = dq ?? sq ?? bare ?? ''
    const quoted = dq !== undefined || sq !== undefined
    if (harmless(value)) return all
    if (sep === ':' && !secretAfterColon(name, value, quoted)) return all
    const v = quoted ? `${dq !== undefined ? '"' : "'"}${mark('named-secret')}${dq !== undefined ? '"' : "'"}` : mark('named-secret')
    return `${q}${name}${q}${sp1}${sep}${sp2}${v}`
  })
  out = out.replace(FLAG, (all, lead, name, sp, dq, sq, bare) => {
    const value = dq ?? sq ?? bare ?? ''
    if (harmless(value) || value.startsWith('-')) return all
    return `${lead}${name}${sp}${mark('named-secret')}`
  })
  return out
}

/** Any JSON value, redacted: every string, and whole the string value of a key named like a secret. */
export function redact(value, key = '') {
  if (typeof value === 'string') {
    if (key && SECRET_NAME.test(key) && !harmless(value)) return mark('named-secret')
    return redactText(value)
  }
  if (Array.isArray(value)) return value.map((v) => redact(v))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]))
  return value
}

/** Strings over MAX_STRING cut, with the cut said. Runs after redact(), so a cut never splits a secret open. */
function truncate(value) {
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}[TRUNCATED ${value.length - MAX_STRING} chars]` : value
  if (Array.isArray(value)) return value.map(truncate)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncate(v)]))
  return value
}

/* ── transcripts ─────────────────────────────────────────────────────── */

const claudeHome = () => join(HOME, '.claude')
const codexHome = () => (process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(HOME, '.codex'))

function detectHarness() {
  if (process.env.CLAUDECODE === '1') return 'claude'
  if (process.env.CODEX_THREAD_ID) return 'codex'
  return null
}

function walkJsonl(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walkJsonl(p, out)
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

function firstLine(file) {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(1 << 20)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const text = buf.subarray(0, n).toString('utf8')
    const at = text.indexOf('\n')
    return at < 0 ? text : text.slice(0, at)
  } finally { closeSync(fd) }
}

/** This session's transcript: { path, how } or { path: null, how: null }. */
function autoTranscript(harness) {
  if (harness === 'claude' && process.env.CLAUDE_CODE_SESSION_ID) {
    const id = process.env.CLAUDE_CODE_SESSION_ID
    let dirs = []
    try { dirs = readdirSync(join(claudeHome(), 'projects')) } catch {}
    for (const d of dirs) {
      const p = join(claudeHome(), 'projects', d, `${id}.jsonl`)
      if (existsSync(p)) return { path: p, how: 'session-id' }
    }
  }
  if (harness === 'codex') {
    const files = walkJsonl(join(codexHome(), 'sessions')).filter((f) => basename(f).startsWith('rollout-'))
    const id = process.env.CODEX_THREAD_ID
    if (id) {
      const hit = files.find((f) => basename(f).endsWith(`-${id}.jsonl`))
      if (hit) return { path: hit, how: 'session-id' }
    }
    const cwd = process.cwd()
    const newest = files.map((f) => ({ f, t: statSync(f).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 50)
    for (const { f } of newest) {
      try {
        const meta = JSON.parse(firstLine(f))
        if (meta.type === 'session_meta' && meta.payload?.cwd === cwd) return { path: f, how: 'newest-in-cwd' }
      } catch {}
    }
  }
  return { path: null, how: null }
}

function resolveTranscript(given, harness) {
  if (!given) return { path: null, how: null }
  const t = given === 'auto' ? autoTranscript(harness) : { path: resolve(given), how: 'given' }
  if (!t.path) return t
  let real
  try { real = realpathSync(t.path) } catch { refuse(`transcript ${t.path} does not exist`) }
  if (!real.endsWith('.jsonl') || CREDENTIAL_FILE.test(basename(real)) || CREDENTIAL_FILE.test(basename(t.path))) refuse(`transcript ${t.path} is not a session .jsonl file; only a session transcript is read`)
  return { path: real, how: t.how }
}

function readTranscript(file) {
  const lines = readFileSync(file, 'utf8').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((text, i) => {
    let entry = null
    try { entry = text.trim() ? JSON.parse(text) : null } catch {}
    return { line: i + 1, text, entry }
  })
}

/** The tool ids a transcript line carries: Claude tool_use / tool_result, Codex call_id. */
function toolIdsOf(entry) {
  const ids = []
  const content = entry?.message?.content
  if (Array.isArray(content)) for (const c of content) {
    if (c?.type === 'tool_use' && c.id) ids.push(c.id)
    if (c?.type === 'tool_result' && c.tool_use_id) ids.push(c.tool_use_id)
  }
  if (entry?.payload?.call_id) ids.push(entry.payload.call_id)
  return ids
}

function toolNameOf(entry) {
  const use = Array.isArray(entry?.message?.content) && entry.message.content.find((c) => c?.type === 'tool_use')
  if (use) return use.name
  const p = entry?.payload
  if (p && /(?:^|_)call$/.test(p.type || '')) return p.name || null
  return null
}

function modelOf(lines) {
  let model = null
  for (const { entry } of lines) {
    const m = entry?.message?.role === 'assistant' ? entry.message.model
      : entry?.type === 'turn_context' ? entry.payload?.model || entry.payload?.collaboration_mode?.model
      : entry?.type === 'world_state' ? entry.payload?.state?.collaboration_mode?.model : null
    if (typeof m === 'string' && m && !m.startsWith('<')) model = m
  }
  return model
}

function parseRanges(list, max) {
  const out = new Set()
  for (const raw of list) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(String(raw))
    if (!m) refuse(`excerpts.lines: "${raw}" is not a line or a range like 120-140`)
    const a = Number(m[1]), b = Number(m[2] ?? m[1])
    if (a < 1 || b < a) refuse(`excerpts.lines: "${raw}" is not a valid range`)
    if (b > max) refuse(`excerpts.lines: "${raw}" is past the end of the transcript (${max} lines)`)
    for (let i = a; i <= b; i++) out.add(i)
  }
  return out
}

function excerpt(lines, { lines: ranges = [], toolIds = [] } = {}) {
  if (!Array.isArray(ranges) || !Array.isArray(toolIds)) refuse('excerpts.lines and excerpts.toolIds must be lists')
  const want = parseRanges(ranges, lines.length)
  for (const id of toolIds) {
    const hits = lines.filter((l) => toolIdsOf(l.entry).includes(id))
    if (!hits.length) refuse(`excerpts.toolIds: ${id} is not in the transcript`)
    for (const h of hits) want.add(h.line)
  }
  if (want.size > MAX_EXCERPT) refuse(`the excerpts come to ${want.size} lines; keep it to ${MAX_EXCERPT} — narrow the ranges`)
  return [...want].sort((a, b) => a - b).map((n) => {
    const l = lines[n - 1]
    return { source: 'transcript', line: n, entry: l.entry ?? l.text }
  })
}

/* ── the report ──────────────────────────────────────────────────────── */

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  return r.status === 0 ? r.stdout.trim() : ''
}

function project() {
  const root = git(['rev-parse', '--show-toplevel']) || process.cwd()
  return { path: root, name: basename(root) }
}

const pad = (n) => String(n).padStart(2, '0')
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function slugOf(what) {
  const words = what.toLowerCase().replace(/\[redacted:[a-z-]+\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  return words.slice(0, 6).join('-').slice(0, 40).replace(/-+$/, '') || 'report'
}

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])
const optText = (v, name) => {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') refuse(`${name} must be text`)
  return v
}

/** The report for `input`, redacted, not yet written. */
export function buildReport(input, now = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse('the input must be one JSON object')
  const unknown = Object.keys(input).filter((k) => !INPUT_KEYS.includes(k))
  if (unknown.length) refuse(`unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')} (fields: ${INPUT_KEYS.join(', ')})`)
  if (typeof input.what !== 'string' || !input.what.trim()) refuse('what is required: what happened')
  if (!SEVERITIES.includes(input.severity)) refuse(`severity must be one of ${SEVERITIES.join(', ')}`)
  const harness = input.harness ?? detectHarness()
  if (!HARNESSES.includes(harness)) refuse(`harness must be one of ${HARNESSES.join(', ')}`)
  const transcript = resolveTranscript(optText(input.transcript, 'transcript'), harness)
  const lines = transcript.path ? readTranscript(transcript.path) : null
  if (input.excerpts !== undefined && !lines) refuse('excerpts need a transcript (a path, or "auto")')
  const quoted = asList(input.toolCalls).map((c) => (typeof c === 'string' ? { source: 'agent', quote: c } : { source: 'agent', ...c }))
  const report = {
    id: null,
    ts: now.toISOString(),
    project: project(),
    branch: git(['branch', '--show-current']) || null,
    harness,
    model: optText(input.model, 'model') || (lines && modelOf(lines)) || null,
    severity: input.severity,
    what: input.what,
    expected: optText(input.expected, 'expected'),
    rulesInForce: asList(input.rulesInForce),
    toolCalls: [...quoted, ...(lines && input.excerpts ? excerpt(lines, input.excerpts) : [])],
    agentTake: optText(input.agentTake, 'agentTake'),
    transcript: transcript.path,
    transcriptHow: transcript.how,
  }
  const clean = truncate(redact(report))
  clean.id = `${localDate(now)}-${slugOf(clean.what)}-${randomBytes(3).toString('hex')}`
  return clean
}

export function writeReport(report, dir = REPORTS) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    const file = join(dir, `${report.id}.json`)
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    chmodSync(file, 0o600)
    return file
  } catch (e) {
    if (['EPERM', 'EACCES', 'EROFS'].includes(e.code)) {
      const err = new Refusal(`the sandbox refused writing ${dir} (${e.code}) — rerun this same command with permission to write there`)
      err.exit = 3
      throw err
    }
    throw e
  }
}

/* ── reading reports back ────────────────────────────────────────────── */

export function parseSince(s, now = Date.now()) {
  const rel = /^(\d+)([dh])$/.exec(s)
  if (rel) return new Date(now - Number(rel[1]) * (rel[2] === 'd' ? 86400000 : 3600000))
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s)
  if (Number.isNaN(t)) refuse(`--since ${s}: give a date (2026-11-01), a time, or 7d / 24h`)
  return new Date(t)
}

export function listReports({ since, project: proj } = {}, dir = REPORTS) {
  let names = []
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')) } catch (e) { if (e.code !== 'ENOENT') throw e }
  const out = []
  for (const n of names) {
    try { out.push(JSON.parse(readFileSync(join(dir, n), 'utf8'))) } catch (e) { process.stderr.write(`flag: skipped ${n}: ${e.message}\n`) }
  }
  return out
    .filter((r) => !since || Date.parse(r.ts) >= since.getTime())
    .filter((r) => !proj || r.project?.name === proj || r.project?.path === proj || r.project?.path === resolve(proj))
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)) || String(b.id).localeCompare(String(a.id)))
}

/* ── the command line ────────────────────────────────────────────────── */

function args(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (/^--(since|project|transcript|text|harness)$/.test(a)) {
      if (i + 1 >= argv.length) refuse(`${a} needs a value`)
      out[a.slice(2)] = argv[++i]
    } else if (a.startsWith('-')) refuse(`unknown option ${a}`)
    else out._.push(a)
  }
  return out
}

const oneLine = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

function main(argv) {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === '--help' || cmd === 'help') {
    process.stdout.write(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''))
    return 0
  }
  const opt = args(rest)
  if (cmd === 'write') {
    let input
    try { input = JSON.parse(readFileSync(0, 'utf8')) } catch (e) { refuse(`stdin is not JSON: ${e.message}`) }
    const report = buildReport(input)
    let file
    try { file = writeReport(report) } catch (e) {
      // Not written: the redacted report goes to stdout, so the evidence is not lost with it.
      if (e.exit === 3) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      throw e
    }
    process.stdout.write(`flagged ${report.id}\n${file}\n`)
    return 0
  }
  if (cmd === 'find') {
    if (!opt.text) refuse('find needs --text <what to look for>')
    const harness = opt.harness ?? detectHarness()
    const t = resolveTranscript(opt.transcript || 'auto', harness)
    if (!t.path) refuse('no transcript found for this session; pass --transcript <path>')
    process.stdout.write(`${t.path} (${t.how})\n`)
    for (const l of readTranscript(t.path)) {
      if (!l.text.includes(opt.text)) continue
      const ids = toolIdsOf(l.entry), name = toolNameOf(l.entry)
      const at = l.text.indexOf(opt.text)
      const preview = oneLine(redactText(l.text.slice(Math.max(0, at - 60), at + 100)), 160)
      process.stdout.write(`${l.line}\t${ids.join(',') || '-'}\t${name || '-'}\t${preview}\n`)
    }
    return 0
  }
  if (cmd === 'list') {
    const reports = listReports({ since: opt.since ? parseSince(opt.since) : null, project: opt.project })
    if (opt.json) process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`)
    else if (!reports.length) process.stdout.write('no field reports\n')
    else for (const r of reports) process.stdout.write(`${r.id}\t${r.ts}\t${r.severity}\t${r.project?.name || '-'}\t${r.branch || '-'}\t${oneLine(r.what, 100)}\n`)
    return 0
  }
  if (cmd === 'show') {
    const id = opt._[0]
    if (!id || !/^[\w.-]+$/.test(id)) refuse('show needs a report id')
    const file = join(REPORTS, `${id}.json`)
    if (!existsSync(file)) refuse(`no report ${id}`)
    process.stdout.write(readFileSync(file, 'utf8'))
    return 0
  }
  refuse(`unknown command ${cmd} (write | find | list | show)`)
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    if (!(e instanceof Refusal)) throw e
    process.stderr.write(`flag: ${e.message}\n`)
    process.exitCode = e.exit || 1
  }
}
