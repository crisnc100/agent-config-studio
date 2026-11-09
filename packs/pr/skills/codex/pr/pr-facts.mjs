#!/usr/bin/env node
/**
 * pr-facts.mjs — the facts a PR description is written from, and a check of the written description.
 *
 * The /pr skill writes the description; this helper only gathers what is true about the branch, so the
 * description never says more than the repo, the plan and the review log do. It runs no model and writes
 * nothing, except the style file the first time it runs (copied from style.example.json next to it).
 *
 * USAGE
 *   node pr-facts.mjs [--base <ref>] [--plan <path>]          # one JSON object: the facts
 *   node pr-facts.mjs --check <file> [--base <ref>] [--plan <path>]   # { ok, problems, warnings }; exit 1 on a problem
 *   --docs-table <path> names the context pass's docs table; by default it is docs-table.json beside the plan, else a
 *   changed builds/<slug>/docs-table.json, else builds/<branch>/docs-table.json.
 *
 * Base: --base, else the open PR's base (gh pr view), else the tracking branch when it is not the branch's own
 * remote copy, else origin/HEAD, else a local main or master.
 * Diffs are three-dot from that base and commits leave merges out, so a stacked branch or a merge of the
 * base into the branch reports only the branch's own changes.
 *
 * Files by purpose (first match wins): builds = builds/; tests = a tests/test/__tests__/spec/fixtures folder or
 * a *.test.* / *.spec.* / *_test.* / test_* name; docs = *.md, *.mdx, *.txt or docs/; static = images, fonts,
 * css; config = json, yaml, toml, lock and dotfiles; code = everything else.
 *
 * Review: the review gate's review.mjs (the repo's scripts/review.mjs, else ~/.agent-config-studio/review-gate/
 * review.mjs). Not there: state "absent". There but HEAD not closed: state "in-progress" with the gate's reason.
 * Closed: state "closed", with the --summary text, the --tier-json data and the summary's lines split out, plus each
 * finding (id, severity, score, status, one-line issue) and counts by severity, read from the review log --tier-json names.
 *
 * Docs table: the rows the context pass wrote, one per changed behavior, each naming its changed files and either the
 * docs that describe it, every claim with the file:line that backs it, or the reason no doc is needed. --check fails a
 * changed code file no row covers, a row that is incomplete, and a claim whose file:line is not in the repo at HEAD.
 * It checks the table's rows and their completeness, never whether a claim is true: the docs-focus review does that.
 *
 * Style: ~/.agent-config-studio/pr/style.json. Unknown keys and bad values are warned about (in the JSON) and
 * ignored. "Deferred findings" keeps its title, and stays on whenever a review exists.
 *
 * Exit: 0 done · 1 a --check problem, or bad input
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = process.env.HOME || ''
const HERE = dirname(fileURLToPath(import.meta.url))
export const STYLE_PATH = join(HOME, '.agent-config-studio', 'pr', 'style.json')
const EXAMPLE = join(HERE, 'style.example.json')
const GATE_SCRIPT = join(HOME, '.agent-config-studio', 'review-gate', 'review.mjs')

export const DEFAULT_SECTIONS = [
  { id: 'gif', title: 'GIF', on: false, urls: [] },
  { id: 'summary', title: 'What this does', on: true },
  { id: 'goal', title: 'Did it match the goal?', on: true },
  { id: 'changes', title: 'What changed', on: true },
  { id: 'try', title: 'How to try it', on: true },
  { id: 'review', title: 'Review highlights', on: true },
  { id: 'deferred', title: 'Deferred findings', on: true },
  { id: 'docs', title: 'Docs and context', on: true },
  { id: 'agent', title: 'What the agent did', on: true },
  { id: 'quote', title: "Agent's take", on: true },
  { id: 'record', title: 'Review record', on: false },
]
export const DEFAULT_STYLE = { sections: DEFAULT_SECTIONS, tone: 'plain', emoji: true }
const STYLE_KEYS = ['sections', 'tone', 'emoji']
const SECTION_KEYS = { gif: ['id', 'title', 'on', 'urls'], other: ['id', 'title', 'on'] }
const TONES = ['plain', 'technical']
const DEFERRED_TITLE = 'Deferred findings'
// A review exists, closed or still in progress: Deferred findings is then required.
const REVIEWED = ['closed', 'in-progress']
export const KINDS = ['code', 'tests', 'docs', 'config', 'static', 'builds']

class Refusal extends Error {}
const refuse = (msg) => { throw new Refusal(msg) }
const clone = (v) => JSON.parse(JSON.stringify(v))

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { code: r.error ? null : r.status, out: (r.stdout || '').trimEnd(), err: (r.stderr || '').trim(), missing: r.error?.code === 'ENOENT' }
}
const git = (cwd, ...args) => run('git', args, cwd)
const gitOk = (cwd, ...args) => {
  const r = git(cwd, ...args)
  if (r.code !== 0) refuse(`git ${args.join(' ')}: ${r.err || 'failed'}`)
  return r.out
}

/* ── files by purpose ────────────────────────────────────────────────── */

const STATIC = /\.(png|jpe?g|gif|svg|webp|ico|avif|bmp|woff2?|ttf|otf|eot|css|scss|sass|less)$/i
const CONFIG = /\.(json|jsonc|ya?ml|toml|lock)$/i
const DOCS = /\.(md|mdx|txt)$/i

export function classify(path) {
  const parts = path.split('/'), name = parts.at(-1)
  if (parts[0] === 'builds') return 'builds'
  if (parts.slice(0, -1).some((d) => ['test', 'tests', '__tests__', 'spec', 'fixtures'].includes(d)) ||
    /\.(test|spec)\.[^/]+$|_test\.[^/]+$|^test_/.test(name)) return 'tests'
  if (DOCS.test(name) || parts.slice(0, -1).includes('docs')) return 'docs'
  if (STATIC.test(name)) return 'static'
  if (CONFIG.test(name) || name.startsWith('.')) return 'config'
  return 'code'
}

/* ── the base ────────────────────────────────────────────────────────── */

function openPr(cwd) {
  const r = run('gh', ['pr', 'view', '--json', 'number,url,baseRefName,state'], cwd)
  if (r.missing) return { gh: false, pr: null }
  if (r.code !== 0) return { gh: true, pr: null }
  try {
    const pr = JSON.parse(r.out)
    return { gh: true, pr: pr.state === 'OPEN' ? { number: pr.number, url: pr.url, base: pr.baseRefName } : null }
  } catch {
    return { gh: true, pr: null }
  }
}
const refExists = (cwd, ref) => git(cwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`).code === 0

// The branch's upstream when it is another branch (a stacked branch tracking its base); never the branch's own
// remote copy (origin/<same name>), which is where it is pushed, not what it is based on.
function trackingBase(cwd, branch) {
  const merge = git(cwd, 'config', `branch.${branch}.merge`).out.replace(/^refs\/heads\//, '')
  const remote = git(cwd, 'config', `branch.${branch}.remote`).out
  if (!merge || !remote || merge === branch) return null
  const ref = remote === '.' ? merge : `${remote}/${merge}`
  return refExists(cwd, ref) ? ref : null
}

function findBase(cwd, flag, pr, branch) {
  if (flag) {
    if (!refExists(cwd, flag)) refuse(`--base ${flag}: no such branch or commit`)
    return { ref: flag, from: '--base' }
  }
  if (pr?.base) {
    for (const ref of [`origin/${pr.base}`, pr.base]) if (refExists(cwd, ref)) return { ref, from: 'the open PR' }
  }
  const tracking = trackingBase(cwd, branch)
  if (tracking) return { ref: tracking, from: 'the tracking branch' }
  const head = git(cwd, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD')
  if (head.code === 0 && head.out) return { ref: head.out.replace(/^refs\/remotes\//, ''), from: 'origin/HEAD' }
  for (const ref of ['main', 'master']) if (refExists(cwd, ref)) return { ref, from: 'a local default branch' }
  refuse('no base found: pass --base <branch>')
}

/* ── the plan and the build log ──────────────────────────────────────── */

// The text under a heading (any level) up to the next heading of the same or a higher level.
export function sectionOf(markdown, name) {
  const lines = markdown.split('\n')
  const at = lines.findIndex((l) => new RegExp(`^#{1,6}\\s+${name}\\s*$`, 'i').test(l))
  if (at < 0) return null
  const level = lines[at].match(/^#+/)[0].length
  const end = lines.findIndex((l, i) => i > at && /^#{1,6}\s/.test(l) && l.match(/^#+/)[0].length <= level)
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n').trim()
}

function findPlan(cwd, flag, changed, branch) {
  const candidates = flag ? [flag] : [
    ...changed.filter((p) => /^builds\/[^/]+\/plan\.md$/.test(p)),
    `builds/${branch}/plan.md`,
  ]
  const path = candidates.find((p) => existsSync(join(cwd, p)))
  if (!path) {
    if (flag) refuse(`--plan ${flag}: no such file`)
    return null
  }
  const text = readFileSync(join(cwd, path), 'utf8')
  return { path, outcome: sectionOf(text, 'Outcome'), outOfScope: sectionOf(text, 'Out of scope') }
}

const LOG_LIMIT = 6000
function findBuildLog(cwd, plan) {
  const path = plan ? join(dirname(plan.path), 'log.md') : null
  if (!path || !existsSync(join(cwd, path))) return null
  const text = readFileSync(join(cwd, path), 'utf8')
  return { path, text: text.length > LOG_LIMIT ? `${text.slice(0, LOG_LIMIT)}\n…(cut at ${LOG_LIMIT} characters)` : text }
}

/* ── the docs table ──────────────────────────────────────────────────── */

const textOk = (v) => typeof v === 'string' && v.trim().length > 0
// The table and what is wrong with it: { path, rows, uncovered, problems }, or null when there is none. Found by
// --docs-table, else beside the plan, else as a changed builds/<slug>/docs-table.json, else in builds/<branch>/.
function docsTable(root, flag, plan, codeFiles, changed, branch) {
  const found = [plan && join(dirname(plan.path), 'docs-table.json'), ...changed.filter((p) => /^builds\/[^/]+\/docs-table\.json$/.test(p)),
    `builds/${branch}/docs-table.json`].filter(Boolean).find((p) => existsSync(join(root, p)))
  const path = flag || found
  if (!path) return null
  if (!existsSync(join(root, path))) {
    if (flag) refuse(`--docs-table ${flag}: no such file`)
    return null
  }
  let doc
  try { doc = JSON.parse(readFileSync(join(root, path), 'utf8')) } catch (e) {
    return { path, rows: [], uncovered: codeFiles, problems: [`docs table: ${path} is not valid JSON (${e.message})`] }
  }
  const rows = Array.isArray(doc?.rows) ? doc.rows : null
  if (!rows) return { path, rows: [], uncovered: codeFiles, problems: [`docs table: ${path} must be { "rows": [ … ] }`] }
  const problems = []
  const lineCount = new Map()
  const linesAt = (file) => {
    if (!lineCount.has(file)) {
      const r = git(root, 'show', `HEAD:${file}`)
      lineCount.set(file, r.code === 0 ? r.out.replace(/\n$/, '').split('\n').length : null)
    }
    return lineCount.get(file)
  }
  rows.forEach((row, i) => {
    const at = `docs table row ${i + 1}${row && textOk(row.behavior) ? ` (${row.behavior})` : ''}`
    if (!row || typeof row !== 'object' || Array.isArray(row)) return problems.push(`${at}: must be { behavior, files, docs | none }`)
    if (!textOk(row.behavior)) problems.push(`${at}: behavior is empty`)
    if (!Array.isArray(row.files) || !row.files.length || !row.files.every(textOk)) problems.push(`${at}: files must list the changed files it covers`)
    const docs = Array.isArray(row.docs) ? row.docs : []
    if (!docs.length && !textOk(row.none)) problems.push(`${at}: needs docs with claims, or a reason no doc is needed ("none")`)
    for (const d of docs) {
      if (!d || !textOk(d.path)) { problems.push(`${at}: a doc without a path`); continue }
      if (linesAt(d.path) === null) problems.push(`${at}: ${d.path} is not in the repo at HEAD`)
      const claims = Array.isArray(d.claims) ? d.claims : []
      if (!claims.length) problems.push(`${at}: ${d.path} lists no claims`)
      for (const c of claims) {
        const name = c && textOk(c.claim) ? c.claim : '(unnamed)'
        const m = typeof c?.at === 'string' && c.at.match(/^(.+):(\d+)$/)
        if (!m) { problems.push(`${at}: claim "${name}" has no file:line ("at")`); continue }
        const n = linesAt(m[1])
        if (n === null) problems.push(`${at}: claim "${name}" points at ${c.at}, which is not in the repo at HEAD`)
        else if (Number(m[2]) < 1 || Number(m[2]) > n) problems.push(`${at}: claim "${name}" points at ${c.at}, but ${m[1]} has ${n} line(s)`)
      }
    }
  })
  const covered = new Set(rows.flatMap((r) => (Array.isArray(r?.files) ? r.files : [])))
  const uncovered = codeFiles.filter((p) => !covered.has(p))
  for (const p of uncovered) problems.push(`docs table: ${p} changed, but no row covers it`)
  return { path, rows, uncovered, problems }
}

/* ── the review gate ─────────────────────────────────────────────────── */

export function splitSummary(text) {
  const lines = text.split('\n')
  const at = lines.indexOf(DEFERRED_TITLE)
  const deferred = []
  if (at >= 0) for (const l of lines.slice(at + 1)) {
    if (/^(No tests:|Coverage exempt)/.test(l)) break
    if (l.trim() && l.trim() !== 'none') deferred.push(l)
  }
  return {
    criteria: lines.filter((l) => /^\S+ criterion \S+ not met: /.test(l)),
    deferred,
    deferredHigh: deferred.filter((l) => /^\S+ HIGH\b/.test(l)),
    fixed: lines.filter((l) => /^\S+ \S+ .*: fixed; test: /.test(l)),
    reviewer: lines.filter((l) => l.startsWith('Reviewer: ')),
    security: lines.filter((l) => l.startsWith('Security: ')),
    counts: lines.filter((l) => l.startsWith('Counts: ')),
    tierLine: lines.find((l) => l.startsWith('Merge tier: ')) || null,
    noTests: lines.find((l) => l.startsWith('No tests: ')) || null,
  }
}

// Each finding of the closes behind the summary, read from the review log (read-only): the review, its fix check and
// its recheck, with the close's status for each. The summary names the reviews it covers.
const STATUSES = ['fixed', 'deferred', 'rejected', 'filed', 'open']
const scoreOf = (f) => {
  const band = String(f.severity || '?').toUpperCase()
  if ([f.likelihood, f.impact, f.risk].every(Number.isInteger)) return `${band} ${f.risk}/100 (likelihood ${f.likelihood}/10 × impact ${f.impact}/10)`
  return Number.isInteger(f.risk) ? `${band} ${f.risk}/100` : `${band} unscored`
}
export function reviewFindings(summary, logPath) {
  const none = (note) => ({ findings: null, bySeverity: null, findingsNote: note })
  if (!logPath || !existsSync(logPath)) return none('the review log was not found, so only the summary lines are here')
  const entries = readFileSync(logPath, 'utf8').split('\n').flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : [] } catch { return [] } })
  const ids = [...new Set(summary.split('\n').flatMap((l) => {
    const m = l.match(/^Review: (\S+)$/) || l.match(/^Close \d+ of \d+: review (\S+) /) || l.match(/^Fix check \d+ of \d+: \S+ of review (\S+),/)
    return m ? [m[1]] : []
  }))]
  const findings = []
  for (const id of ids) {
    const close = entries.filter((e) => e.type === 'close' && e.review === id).at(-1)
    const records = [id, close?.recheck, close?.fixCheck].filter(Boolean).map((rid) => entries.find((e) => e.type === 'review' && e.id === rid)).filter(Boolean)
    for (const r of records) for (const f of r.findingDetails || []) {
      const status = close?.statuses?.[f.id]?.status || (f.filed === true ? 'filed' : 'open')
      findings.push({
        id: f.id, review: r.id, kind: f.criterionId ? 'criterion' : /^s\d/.test(f.id) ? 'security' : 'code',
        severity: String(f.severity || '').toLowerCase() || null, likelihood: f.likelihood ?? null, impact: f.impact ?? null, risk: f.risk ?? null,
        score: scoreOf(f), status: STATUSES.includes(status) ? status : 'open',
        issue: String(f.issue || f.criterion || '').split('\n')[0], file: f.file ?? null, line: f.line ?? null,
      })
    }
  }
  if (!ids.length) return none('the summary names no review, so the findings could not be read from the log')
  const bySeverity = Object.fromEntries(['high', 'medium', 'low'].map((sev) => {
    const of = findings.filter((f) => f.severity === sev)
    return [sev, { total: of.length, ...Object.fromEntries(STATUSES.map((st) => [st, of.filter((f) => f.status === st).length])) }]
  }))
  return { findings, bySeverity }
}

function review(cwd) {
  const repoScript = join(cwd, 'scripts', 'review.mjs')
  const script = existsSync(repoScript) ? repoScript : existsSync(GATE_SCRIPT) ? GATE_SCRIPT : null
  if (!script) return { state: 'absent', note: 'not reviewed (no review gate)' }
  const tier = run(process.execPath, [script, '--tier-json'], cwd)
  let data = null
  try { data = JSON.parse(tier.out.split('\n').filter(Boolean).at(-1)) } catch {}
  if (tier.code === 3 && data && data.covered === false)
    return { state: 'in-progress', note: 'review in progress — not closed at this commit', reason: data.reason, script }
  if (tier.code !== 0 || !data) return { state: 'error', note: 'the review gate could not be read', reason: tier.err || tier.out, script }
  const summary = run(process.execPath, [script, '--summary'], cwd)
  if (summary.code !== 0) return { state: 'error', note: 'the review gate could not be read', reason: summary.err || summary.out, script }
  return { state: 'closed', note: 'reviewed and closed at this commit', script, summary: summary.out, tier: data, ...splitSummary(summary.out),
    ...reviewFindings(summary.out, data.logPath) }
}

/* ── the style ───────────────────────────────────────────────────────── */

// The style as written, made safe: unknown keys and bad values are warned about and replaced by defaults.
export function resolveStyle(raw, { reviewed = false } = {}) {
  const warnings = []
  const style = clone(DEFAULT_STYLE)
  if (raw === null || raw === undefined) return { style, warnings }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { style, warnings: ['the style file is not a JSON object: using the defaults'] }
  for (const k of Object.keys(raw)) if (!STYLE_KEYS.includes(k)) warnings.push(`unknown key "${k}" ignored`)
  if ('tone' in raw) {
    if (TONES.includes(raw.tone)) style.tone = raw.tone
    else warnings.push(`tone "${raw.tone}" is not ${TONES.join(' or ')}: using plain`)
  }
  if ('emoji' in raw) {
    if (typeof raw.emoji === 'boolean') style.emoji = raw.emoji
    else warnings.push('emoji must be true or false: using true')
  }
  if ('sections' in raw) {
    if (!Array.isArray(raw.sections)) warnings.push('sections must be a list: using the default sections')
    else style.sections = resolveSections(raw.sections, warnings)
  }
  const deferred = style.sections.find((s) => s.id === 'deferred')
  if (reviewed && !deferred.on) {
    deferred.on = true
    warnings.push('"Deferred findings" stays on while a review exists (the review gate requires that section)')
  }
  return { style, warnings }
}

function resolveSections(list, warnings) {
  const byId = Object.fromEntries(DEFAULT_SECTIONS.map((s) => [s.id, s]))
  const out = [], seen = new Set()
  for (const item of list) {
    if (!item || typeof item !== 'object' || !byId[item.id]) {
      warnings.push(`unknown section ${JSON.stringify(item?.id ?? item)} ignored`)
      continue
    }
    if (seen.has(item.id)) { warnings.push(`section "${item.id}" is listed twice: the first one counts`); continue }
    seen.add(item.id)
    const s = clone(byId[item.id])
    for (const k of Object.keys(item)) if (!SECTION_KEYS[s.id === 'gif' ? 'gif' : 'other'].includes(k)) warnings.push(`section "${s.id}": unknown key "${k}" ignored`)
    if ('on' in item) {
      if (typeof item.on === 'boolean') s.on = item.on
      else warnings.push(`section "${s.id}": on must be true or false`)
    }
    if ('title' in item) {
      if (s.id === 'deferred') { if (item.title !== DEFERRED_TITLE) warnings.push(`section "deferred": the title stays "${DEFERRED_TITLE}" (the review gate and searches rely on it)`) }
      else if (typeof item.title === 'string' && item.title.trim() && !item.title.includes('\n')) s.title = item.title.trim()
      else warnings.push(`section "${s.id}": title must be one line of text`)
    }
    if (s.id === 'gif' && 'urls' in item) {
      if (!Array.isArray(item.urls)) warnings.push('section "gif": urls must be a list')
      else for (const u of item.urls) {
        if (typeof u === 'string' && /^https?:\/\/\S+$/.test(u)) s.urls.push(u)
        else warnings.push(`section "gif": ${JSON.stringify(u)} is not an http(s) URL, ignored`)
      }
    }
    out.push(s)
  }
  const missing = DEFAULT_SECTIONS.filter((s) => !seen.has(s.id))
  if (missing.length) warnings.push(`sections not in your list, added at the end and off: ${missing.map((s) => s.id).join(', ')}`)
  for (const s of missing) out.push({ ...clone(s), on: s.id === 'deferred' })
  // No two headings alike: "Deferred findings" is reserved, the first section keeps a title, a later one falls back
  // to its default title, else to that title with its id, else with a number.
  const taken = new Set([DEFERRED_TITLE])
  for (const s of out) {
    if (s.id === 'gif' || s.id === 'deferred') continue
    if (taken.has(s.title)) {
      const def = byId[s.id].title
      const fallback = [def, `${def} (${s.id})`, ...Array.from({ length: 50 }, (_, i) => `${def} (${s.id} ${i + 2})`)].find((t) => !taken.has(t))
      warnings.push(`section "${s.id}": title "${s.title}" is already used: using "${fallback}"`)
      s.title = fallback
    }
    taken.add(s.title)
  }
  return out
}

// Reads the style file, creating it from the example the first time. A write the sandbox refuses is not an
// error: the defaults are used and the note says so.
export function loadStyle({ reviewed = false } = {}) {
  let created = false, note = null
  if (!existsSync(STYLE_PATH)) {
    try {
      mkdirSync(dirname(STYLE_PATH), { recursive: true })
      if (existsSync(EXAMPLE)) copyFileSync(EXAMPLE, STYLE_PATH)
      created = existsSync(STYLE_PATH)
    } catch (e) {
      note = `could not create ${STYLE_PATH} (${e.code || e.message}): using the defaults`
    }
  }
  let raw = null
  const warnings = []
  if (existsSync(STYLE_PATH)) {
    try { raw = JSON.parse(readFileSync(STYLE_PATH, 'utf8')) } catch (e) { warnings.push(`the style file is not valid JSON (${e.message}): using the defaults`) }
  }
  const resolved = resolveStyle(raw, { reviewed })
  return { style: { ...resolved.style, path: STYLE_PATH, created, ...(note && { note }) }, warnings: [...warnings, ...resolved.warnings] }
}

// One URL from the list, picked by the branch name, so a rerun picks the same one.
export function pickGif(section, branch) {
  if (!section?.on) return { url: null }
  if (!section.urls.length) return { url: null, note: 'the gif section is on but its list of URLs is empty' }
  const n = parseInt(createHash('sha256').update(branch).digest('hex').slice(0, 8), 16)
  return { url: section.urls[n % section.urls.length] }
}

/* ── the facts ───────────────────────────────────────────────────────── */

export function facts({ cwd = process.cwd(), base: baseFlag, plan: planFlag, docsTable: tableFlag } = {}) {
  const top = git(cwd, 'rev-parse', '--show-toplevel')
  if (top.code !== 0) refuse('not inside a git repository')
  const root = top.out
  const branch = gitOk(root, 'rev-parse', '--abbrev-ref', 'HEAD')
  const head = gitOk(root, 'rev-parse', 'HEAD')
  const { gh, pr } = openPr(root)
  const found = findBase(root, baseFlag, pr, branch)
  const baseSha = gitOk(root, 'rev-parse', `${found.ref}^{commit}`)
  const mergeBase = gitOk(root, 'merge-base', found.ref, 'HEAD')
  const commits = gitOk(root, 'log', '--no-merges', '--format=%H%x09%s', `${found.ref}..HEAD`).split('\n').filter(Boolean)
    .map((l) => { const [sha, ...s] = l.split('\t'); return { sha, subject: s.join('\t') } })
  const files = Object.fromEntries(KINDS.map((k) => [k, []]))
  // -z: each record is "added<TAB>removed<TAB>path<NUL>", the path raw (never quoted or escaped).
  for (const l of gitOk(root, 'diff', '--numstat', '-z', '--no-renames', `${found.ref}...HEAD`).split('\0').filter((x) => x.trim())) {
    const [a, r, ...p] = l.replace(/^\n/, '').split('\t')
    const path = p.join('\t')
    files[classify(path)].push({ path, added: a === '-' ? 0 : Number(a), removed: r === '-' ? 0 : Number(r), ...(a === '-' && { binary: true }) })
  }
  const counts = Object.fromEntries(KINDS.map((k) => [k, {
    files: files[k].length, added: files[k].reduce((n, f) => n + f.added, 0), removed: files[k].reduce((n, f) => n + f.removed, 0),
  }]))
  const changed = KINDS.flatMap((k) => files[k].map((f) => f.path))
  const plan = findPlan(root, planFlag, changed, branch)
  const rev = review(root)
  const { style, warnings } = loadStyle({ reviewed: REVIEWED.includes(rev.state) })
  const agentFile = /(^|\/)(CLAUDE|AGENTS)\.md$/
  return {
    branch, head,
    base: { ref: found.ref, sha: baseSha, mergeBase, from: found.from },
    gh, pr,
    commits, files, counts,
    plan,
    buildLog: findBuildLog(root, plan),
    review: rev,
    docs: {
      changed: files.docs.map((f) => f.path),
      agentFiles: changed.filter((p) => agentFile.test(p)),
      codeWithoutDocs: files.docs.length ? [] : files.code.map((f) => f.path),
    },
    docsTable: docsTable(root, tableFlag, plan, files.code.map((x) => x.path), changed, branch),
    style,
    gif: pickGif(style.sections.find((s) => s.id === 'gif'), branch),
    warnings,
  }
}

/* ── the check ───────────────────────────────────────────────────────── */

// Character ranges a reader does not see at once: <details>…</details> folds and <!-- … --> comments (an unclosed
// one runs to the end), and the text with such ranges blanked out, every offset kept.
function ranges(body, re) {
  const out = []
  for (let m; (m = re.exec(body));) out.push([m.index, m.index + m[0].length])
  return out
}
const folds = (body) => ranges(body, /<details\b[^>]*>[\s\S]*?<\/details>/gi)
const comments = (body) => ranges(body, /<!--[\s\S]*?(?:-->|$)/g)
const blank = (body, spans) => spans.reduce((t, [a, b]) => t.slice(0, a) + t.slice(a, b).replace(/[^\n]/g, ' ') + t.slice(b), body)
const inside = (ranges, i) => ranges.some(([a, b]) => i >= a && i < b)
const lineAt = (body, i) => body.slice(0, i).split('\n').length

function headings(body) {
  const out = []
  let fence = false, at = 0
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    const m = !fence && line.match(/^##\s+(.+?)\s*#*\s*$/)
    if (m) out.push({ title: m[1], at })
    at += line.length + 1
  }
  return out
}

const URL_RE = /https?:\/\/[^\s)>\]"']+/g
const SHA_RE = /\b[0-9a-f]{7,40}\b/g
const RUN_ID_RE = /\b(?:review|fix|grade|recheck|security)-\d{10,}-[0-9a-f]{4,}\b/g
// A finding id where one goes: at the start of a list item (bold or code allowed), or before a severity word.
// Elsewhere ("speed x2", "s3 buckets") it is prose, not an id.
const FINDING_ID = '[fxscr]\\d{1,3}'
const FINDING_RES = [
  new RegExp(`^[ \\t]*(?:[-*+]|\\d+[.)])[ \\t]+(?:\\*\\*|\`)?(${FINDING_ID})\\b`, 'gm'),
  new RegExp(`\\b(${FINDING_ID})(?:\\*\\*|\`)?[ \\t]+(?:HIGH|MEDIUM|LOW)\\b`, 'gi'),
]
FINDING_RES.push(new RegExp(`\\b(${FINDING_ID})(?:\\*\\*|\`)?[ \\t]+(?:(?:is|was|were|got|has been|now|stays|remains|stayed|remained)[ \\t]+)?(?:fixed|deferred|rejected|filed|waived)\\b`, 'gi'))
const findingIdsIn = (text) => new Set(FINDING_RES.flatMap((re) => [...text.matchAll(re)].map((m) => m[1])))
const PATH_RE = /(?<![\w./~$:@-])(?:[\w-][\w.-]*\/)+[\w-][\w.-]*\.[A-Za-z0-9]+(?![\w/])/g
// A hex run is a sha when it reads as one in prose (letters and digits), or sits beside "commit"/"sha", or is a code span.
const SHA_CONTEXT_RES = [/\b(?:commits?|shas?)\b[ \t]*[:#]?[ \t]*`?([0-9a-f]{7,40})\b/gi, /`([0-9a-f]{7,40})`/gi]
// File names in code spans and at the start of list items: paths (with or without an extension), names with a known
// file extension, dotfiles and the usual extensionless root files.
const FILE_EXT = new Set(('js mjs cjs jsx ts tsx mts cts json jsonc json5 md mdx txt rst yml yaml toml lock css scss sass less html htm ' +
  'py rb go rs java kt kts swift c h cc cpp hpp cs php sh zsh bash fish sql png jpg jpeg gif svg webp ico avif woff woff2 ttf otf ' +
  'env ini cfg conf xml csv tsv vue svelte astro lua pl dart ex exs erl hs ml scala gradle tf proto graphql gql ipynb pdf wasm').split(' '))
const ROOT_FILES = new Set(('Dockerfile Containerfile Makefile GNUmakefile Procfile Gemfile Rakefile Jenkinsfile Vagrantfile Brewfile ' +
  'Justfile Taskfile Podfile LICENSE LICENCE NOTICE CODEOWNERS CHANGELOG AUTHORS').split(' '))
export function fileLike(raw) {
  const t = raw.replace(/^[("'*]+|[)"'*,.;:!?]+$/g, '').replace(/:\d+(?::\d+)?$/, '')
  if (!t || /^[~$@-]/.test(t) || /[:\\]|\/\//.test(t) || !/[A-Za-z]/.test(t)) return null
  if (ROOT_FILES.has(t)) return t
  if (/^[\w.@-]+(?:\/[\w.@-]+)*\/?$/.test(t) && t.includes('/') && t !== '/') return t
  if (/^\.[A-Za-z][\w.-]*$/.test(t)) return t
  const ext = t.match(/^[\w-][\w.-]*\.([A-Za-z0-9]+)$/)?.[1]
  return ext && FILE_EXT.has(ext.toLowerCase()) ? t : null
}
function filesNamed(text) {
  const out = new Set(text.match(PATH_RE) || [])
  for (const [, span] of text.matchAll(/`([^`\n]+)`/g)) for (const w of span.split(/\s+/)) { const t = fileLike(w); if (t) out.add(t) }
  for (const [, w] of text.matchAll(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\*\*|`)?([^\s`]+)/gm)) { const t = fileLike(w); if (t) out.add(t) }
  return out
}

export function check(body, f) {
  const problems = [...(f.docsTable?.problems || [])], warnings = [...f.warnings]
  const closed = f.review.state === 'closed'
  const uncommented = blank(body, comments(body))
  const fold = folds(uncommented)
  const heads = headings(uncommented)
  const visible = blank(uncommented, fold)
  const sections = f.style.sections.filter((s) => s.id !== 'gif')
  const byTitle = new Map(sections.map((s) => [s.title, s]))

  // Where each configured section sits: its ## heading, or for the record its <summary> inside <details>.
  const marks = []
  for (const h of heads) {
    const s = byTitle.get(h.title)
    if (!s) { warnings.push(`"## ${h.title}" is not a section in your style`); continue }
    if (s.id === 'record') { problems.push(`the review record goes in <details>, not under a "## ${h.title}" heading`); continue }
    if (!s.on) problems.push(`"## ${h.title}" is turned off in your style`)
    if (inside(fold, h.at)) problems.push(`"## ${h.title}" (line ${lineAt(body, h.at)}) is inside <details>; sections stay outside the fold`)
    marks.push({ s, at: h.at })
  }
  const record = sections.find((s) => s.id === 'record')
  const recordAt = uncommented.indexOf(`<summary>${record.title}</summary>`)
  if (record.on && closed) {
    if (recordAt < 0 || !inside(fold, recordAt)) problems.push(`the review record is on: fold it as <details><summary>${record.title}</summary> … </details>`)
    else marks.push({ s: record, at: recordAt })
  }
  if (!record.on && closed) {
    const raw = f.review.summary.split('\n').find((l) => l.startsWith('Review: '))
    const folded = fold.some(([a, b]) => { const t = uncommented.slice(a, b); return t.includes(`<summary>${record.title}</summary>`) || (raw && t.includes(raw)) })
    if (folded) problems.push('the review record is off in your style: leave it out, folded or not')
  }
  marks.sort((a, b) => a.at - b.at)

  for (const s of sections) {
    if (!s.on || s.id === 'record') continue
    if (s.id === 'deferred' && !REVIEWED.includes(f.review.state)) continue
    if (!marks.some((m) => m.s === s)) problems.push(`missing section "## ${s.title}"`)
  }
  const rank = new Map(sections.map((s, i) => [s, i]))
  for (let i = 1; i < marks.length; i++) {
    const prev = marks[i - 1].s, cur = marks[i].s
    if (rank.get(cur) < rank.get(prev)) problems.push(`"${cur.title}" comes after "${prev.title}", but your style puts it first`)
  }

  if (closed) {
    const head = heads.find((h) => h.title === DEFERRED_TITLE)
    if (head) {
      const next = heads.find((h) => h.at > head.at)
      const text = visible.slice(head.at, next ? next.at : body.length)
      for (const line of f.review.deferred) if (!text.includes(line)) problems.push(`"Deferred findings" is missing this line, copied verbatim from the review summary: ${line}`)
    }
    const first = heads.length ? heads[0].at : body.length
    for (const line of [...f.review.criteria, ...f.review.deferredHigh]) {
      const at = visible.indexOf(line)
      if (at < 0 || at > first) problems.push(`this goes first, above every section, verbatim: ${line}`)
    }
    const raw = f.review.summary.split('\n').find((l) => l.startsWith('Review: '))
    if (raw) for (let i = body.indexOf(raw); i >= 0; i = body.indexOf(raw, i + 1)) {
      if (!inside(fold, i)) { problems.push(`the raw review record ("${raw}") is outside <details>`); break }
    }
  }

  // No invented facts: shas, review run ids, finding ids (in finding-id positions) and file paths must come from the facts.
  const text = body.replace(URL_RE, ' ')
  const known = [f.head, f.base.sha, f.base.mergeBase, ...f.commits.map((c) => c.sha)]
  const reviewText = closed ? `${f.review.summary}\n${JSON.stringify(f.review.tier)}` : ''
  const shas = new Set([...(text.match(SHA_RE) || []).filter((m) => /[a-f]/.test(m) && /\d/.test(m)),
    ...SHA_CONTEXT_RES.flatMap((re) => [...text.matchAll(re)].map((m) => m[1].toLowerCase()))])
  for (const m of shas) if (!known.some((k) => k.startsWith(m)) && !reviewText.includes(m)) problems.push(`sha ${m} is not in the facts`)
  for (const m of new Set(text.match(RUN_ID_RE) || [])) if (!reviewText.includes(m)) problems.push(`review id ${m} is not in the facts`)
  const findingIds = new Set(closed ? [...f.review.summary.split('\n').map((l) => l.match(/^([fxscr]\d{1,3}) /)?.[1]).filter(Boolean),
    ...(f.review.findings || []).map((x) => x.id)] : [])
  for (const m of findingIdsIn(text.replace(RUN_ID_RE, ' '))) if (!findingIds.has(m)) problems.push(`finding id ${m} is not in the facts`)
  // Known: a changed file, the plan, the build log, a folder holding one of those, or a name the facts' own text uses.
  const paths = [...KINDS.flatMap((k) => f.files[k].map((x) => x.path)), f.plan?.path, f.buildLog?.path].filter(Boolean)
  const factsText = [reviewText, f.plan?.outcome, f.plan?.outOfScope, f.buildLog?.text, ...f.commits.map((c) => c.subject)].filter(Boolean).join('\n')
  const knownFile = (t) => paths.includes(t) || paths.some((p) => p.startsWith(t.endsWith('/') ? t : `${t}/`)) || factsText.includes(t)
  for (const m of filesNamed(text)) if (!knownFile(m)) problems.push(`file ${m} is not in the facts`)

  if (f.gif.url && !body.includes(f.gif.url)) warnings.push(`the gif section is on: ${f.gif.url} goes at the top`)
  return { ok: problems.length === 0, problems, warnings }
}

/* ── the command line ────────────────────────────────────────────────── */

function option(args, name) {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const v = args[i + 1]
  if (!v || v.startsWith('--')) refuse(`${name} needs a value`)
  return v
}

export function main(args = process.argv.slice(2)) {
  try {
    if (args.includes('--help') || args.includes('-h')) {
      process.stdout.write(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''))
      return 0
    }
    for (const a of args) if (a.startsWith('--') && !['--base', '--plan', '--check', '--docs-table'].includes(a)) refuse(`unknown option ${a}`)
    const opts = { base: option(args, '--base'), plan: option(args, '--plan'), docsTable: option(args, '--docs-table') }
    const file = option(args, '--check')
    const root = git(process.cwd(), 'rev-parse', '--show-toplevel').out
    const f = { ...facts(opts), root }
    if (file === undefined) {
      delete f.root
      console.log(JSON.stringify(f, null, 2))
      return 0
    }
    if (!existsSync(file)) refuse(`--check ${file}: no such file`)
    const result = check(readFileSync(file, 'utf8'), f)
    console.log(JSON.stringify(result, null, 2))
    return result.ok ? 0 : 1
  } catch (e) {
    if (!(e instanceof Refusal)) throw e
    console.log(JSON.stringify({ error: e.message }))
    return 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main()
