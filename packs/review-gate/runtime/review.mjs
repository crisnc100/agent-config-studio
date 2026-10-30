#!/usr/bin/env node
/**
 * review.mjs — single-pass code reviewer.
 *
 * A reviewer from the `reviewer` role in the model registry (`model-id --role reviewer`)
 * reviews the committed diff vs a base and emits STRUCTURED findings, each family at its
 * own flavor effort. Families whose CLI is not on PATH are skipped (one line names them);
 * no usable reviewer is a hard stop that names the fix, never a fallback to another vendor.
 * It is READ-ONLY: it does not fix, commit, or loop. The agent
 * that runs it reads the findings, shows them to the human, and applies whatever
 * fixes the human confirms — fixing happens in-context, not by re-spawning a model.
 *
 * Why no loop: the loop's cost is re-reviewing the whole diff after every fix and
 * re-spawning a fixer each round — that compounds to many minutes on a big diff.
 * One review + human-confirmed in-context fixes is ~one review's worth of time.
 *
 * USAGE
 *   node scripts/review.mjs ["what this branch was supposed to do"]   # reviewer picked from the pool
 *   REVIEW_REVIEWER=claude node scripts/review.mjs           # the Claude multi-agent team
 *   REVIEW_REVIEWER=grok node scripts/review.mjs             # a vendor (codex|claude|grok) or any registry family
 *   REVIEW_AUTHOR=<family|vendor> REVIEW_PICK=rotate node scripts/review.mjs
 *   REVIEW_EFFORT=xhigh node scripts/review.mjs               # raise codex reasoning for one run
 *   node scripts/review.mjs --show-config                     # resolved pool, pick and counts
 *   node scripts/review.mjs --log-outcome <reviews-ts> <confirmed> <rejected>
 *
 *   REVIEW_PICK=<classifier command> node scripts/review.mjs  # an optional local classifier picks on diff stats
 *   REVIEW_VERIFY=second-opinion node scripts/review.mjs      # another family CONFIRMs/REFUTEs HIGH+MEDIUM
 *
 * Every finding must quote the code it is about; a deterministic check confirms the quote is in
 * the file near the cited line, and findings that fail it are listed apart, never as findings.
 *
 * Every review appends a line to the review log (see logPath()); --log-outcome records which
 * findings held up, so the unranked pool can earn a ranking.
 *
 * OUTPUT: writes reviews/<ts>/code-review.md (human-readable) and prints the findings
 * as JSON after a `===FINDINGS_JSON===` marker for the calling agent to parse.
 * Reviews report findings; recording and close failures exit non-zero.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const COPY_PATH = fileURLToPath(import.meta.url)
console.error(`review.mjs · ${COPY_PATH} · head-aware copy`)
const args = process.argv.slice(2)
const option = (flag) => {
  const at = args.indexOf(flag)
  if (at === -1) return null
  const value = args[at + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

// ── User-configurable defaults (change the model WITHOUT editing this script) ──
// Resolution: env var > project .claude/review-config.json > ~/.agent-config-studio/review-gate/config.json
// > the older ~/.claude/review-config.json > built-in.
// Edit that one small JSON file to switch reviewer/model/effort — see review-config.example.json.
let gateConfigError
function loadConfig() {
  const paths = [
    process.env.REVIEW_CONFIG,
    join('.claude', 'review-config.json'),
    join(homedir(), '.agent-config-studio', 'review-gate', 'config.json'),
    join(homedir(), '.claude', 'review-config.json'),
  ].filter(Boolean)
  for (const p of paths) {
    try {
      if (existsSync(p)) return { ...JSON.parse(readFileSync(p, 'utf8')), _source: p }
    } catch (e) {
      if (args.includes('--gate')) {
        // Defer to pushGate so a real operator override can still be checked and logged.
        gateConfigError = new Error(`Malformed review config at ${p}: ${e.message}`)
        return {}
      }
      console.warn(`⚠ Ignoring malformed review config at ${p}`)
    }
  }
  return {}
}
const CONFIG = loadConfig()
const cfg = (envName, key, dflt) => process.env[envName] ?? CONFIG[key] ?? dflt
// A family name resolves through the model registry (`model-id --table`);
// a raw id passes through. On failure model-id prints MODEL-ID-UNRESOLVED-<name>, which the CLI
// rejects loudly — never an empty string that would fall through to the CLI's own default.
// When model-id itself can't run, a raw id (anything that isn't a bare family name like `name`
// or `name-prev`) is already an id and passes through; a family name gets the loud
// MODEL-ID-UNRESOLVED-<family> placeholder. No model ids are hard-coded here.
const FAMILY_NAME = /^[a-z]+(-prev)?$/
function modelId(name) {
  const r = spawnSync('model-id', [String(name)], { encoding: 'utf8' })
  const id = (r.stdout || '').trim()
  if (r.error || r.status !== 0 || !id || id.startsWith('MODEL-ID-UNRESOLVED')) {
    const why = r.error?.message || (r.stderr || '').trim() || 'no id printed'
    if (r.error && !FAMILY_NAME.test(String(name))) return String(name) // model-id not runnable: a raw id is already an id
    console.warn(`⚠ model-id could not resolve "${name}": ${why} — run: acs install-model-id`)
    return id || `MODEL-ID-UNRESOLVED-${name}`
  }
  return id
}

function modelIdJson(args) {
  const r = spawnSync('model-id', args, { encoding: 'utf8' })
  if (r.error || r.status !== 0)
    return { error: r.error?.message || (r.stderr || '').trim() || `exit ${r.status}`, missing: r.error?.code === 'ENOENT' }
  try {
    return { data: JSON.parse(r.stdout) }
  } catch {
    return { error: `unparseable output: ${String(r.stdout).slice(0, 200)}` }
  }
}

// Which CLI runs a model: its id's prefix, the rule ACS uses (lib/models-catalog.js vendorOf),
// copied so this script stays standalone. An id with any other prefix has no known CLI.
function vendorOf(id) {
  const s = String(id ?? '')
  if (s.startsWith('claude-')) return 'claude'
  if (s.startsWith('gpt-')) return 'codex'
  if (s.startsWith('grok-')) return 'grok'
  return null
}
const VENDORS = ['codex', 'claude', 'grok']
const isExecutable = (p) => {
  try {
    accessSync(p, constants.X_OK)
    return statSync(p).isFile()
  } catch {
    return false
  }
}
// Found on PATH without running it.
const onPath = (command) =>
  String(command).includes('/')
    ? isExecutable(command)
    : String(process.env.PATH || '').split(':').some((dir) => dir && isExecutable(join(dir, command)))

// A hard stop names what is wrong and how to fix it; it never tries another vendor instead.
function stop(message) {
  console.error(`\n✖ ${message}\n`)
  process.exit(1)
}

// Each family reviews at its own flavor effort; the role-level effort is cleared on purpose.
// likes/quirks are what an optional local classifier weighs when pick names one.
function flavorOf(family) {
  const r = modelIdJson(['--flavor', family, '--json'])
  if (r.error) console.warn(`⚠ model-id --flavor ${family} failed (${r.error}) — using effort high`)
  const f = r.data?.flavor || {}
  return {
    effort: f.effort || 'high',
    likes: Array.isArray(f.likes) ? f.likes : [],
    quirks: Array.isArray(f.quirks) ? f.quirks : [],
  }
}
const flavorEffort = (family) => flavorOf(family).effort

// The unranked reviewer pool: the `reviewer` role (ACS → Models → Roles), each member's CLI taken
// from its id's prefix, filtered to the CLIs on PATH. One line names the families skipped.
// Returns { pool } or { error, missing } — callers stop loudly (poolOrStop), never fall back.
let skipsNoted = false
function loadPool() {
  const r = modelIdJson(['--role', 'reviewer', '--json'])
  if (r.error) return { error: r.error, missing: r.missing }
  const use = Array.isArray(r.data?.use) ? r.data.use : []
  const ids = Array.isArray(r.data?.ids) ? r.data.ids : []
  // Effort per member: the model's effort in this job → the job's effort → the model's default.
  // `members` (present only when a member effort is set) carries that resolved per member;
  // otherwise a job-level effort applies to everyone, else each family's flavor effort.
  const members = Array.isArray(r.data?.members) ? r.data.members : null
  const roleSet = ['default', 'user'].includes(r.data?.provenance?.effort) && r.data?.effort
  const pool = []
  const skipped = []
  // Role families left out, kept so a pick that names one stops instead of reviewing on another.
  const unusable = []
  use.forEach((f, i) => {
    const family = String(f).toLowerCase()
    const id = ids[i] || modelId(family)
    const vendor = vendorOf(id)
    if (!vendor) {
      console.warn(`⚠ reviewer role family "${family}" has id "${id}", whose prefix names no known CLI (claude-, gpt-, grok-) — skipped`)
      unusable.push({ family, vendor, id })
      return
    }
    if (!onPath(vendor)) {
      skipped.push(`${family} (${vendor} CLI not on PATH)`)
      unusable.push({ family, vendor, id })
      return
    }
    const fl = flavorOf(family)
    const effort = members?.[i]?.effort || (roleSet ? r.data.effort : '') || fl.effort
    pool.push({ family, vendor, id, ...fl, effort })
  })
  if (skipped.length && !skipsNoted) {
    skipsNoted = true
    console.warn(`ℹ reviewer role: skipped ${skipped.join(', ')}`)
  }
  if (pool.length) return { pool, unusable }
  return {
    error: use.length
      ? `none of the reviewer role's families (${use.join(', ')}) has its CLI on PATH`
      : 'the reviewer role lists no families',
    empty: true,
    unusable,
  }
}
function poolOrStop({ pool, error, missing, empty }) {
  if (pool) return pool
  if (missing)
    stop(
      `model-id could not resolve the reviewer role: model-id is not installed (${error}).\n` +
        `  Fix — run: acs install-model-id, then check the reviewer role in ACS → Models → Roles.`,
    )
  if (empty)
    stop(
      `No reviewer can run: ${error}.\n` +
        `  Fix: install the CLI of a family in the reviewer role, or set the reviewer role to families\n` +
        `  whose CLI you have in ACS → Models → Roles.`,
    )
  stop(
    `model-id could not resolve the reviewer role (${error}).\n` +
      `  Fix: set the reviewer role in ACS → Models → Roles, then check \`model-id --role reviewer --json\`.`,
  )
}
// A reviewer someone named, whose CLI is missing: stop rather than review with anything else.
function requireCli(m, named) {
  if (!onPath(m.vendor))
    stop(
      `${named} needs the ${m.vendor} CLI, which is not on PATH.\n` +
        `  Fix: install it, or name another reviewer (the reviewer role is in ACS → Models → Roles).`,
    )
  return m
}

// ── Outcome log (one JSON line per review, plus outcome lines from --log-outcome) ──
// Where the log lives, decided here only: the ACS folder when it exists; else an existing
// ~/.claude/review-log/ folder; else an existing older ~/.claude/review-log.jsonl; else the ACS
// folder, created by the first write.
function logPath(home = homedir()) {
  const isDir = (p) => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  }
  const acs = join(home, '.agent-config-studio', 'review-log')
  if (isDir(acs)) return join(acs, 'review-log.jsonl')
  const claudeDir = join(home, '.claude', 'review-log')
  if (isDir(claudeDir)) return join(claudeDir, 'review-log.jsonl')
  const legacy = join(home, '.claude', 'review-log.jsonl')
  if (existsSync(legacy)) return legacy
  return join(acs, 'review-log.jsonl')
}
const LOG_PATH = logPath()
function readLog({ strict = false } = {}) {
  if (!existsSync(LOG_PATH)) {
    if (strict) throw new Error(`No review log: ${LOG_PATH}`)
    return []
  }
  let unreadable = 0
  const entries = readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      const entry = JSON.parse(line)
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('not a record')
      return [entry]
    } catch {
      unreadable++
      return []
    }
  })
  if (unreadable) {
    const message = `${LOG_PATH}: ${unreadable} unreadable log line(s)`
    if (strict) throw new Error(message)
    console.error(`⚠ ${message}`)
  }
  return entries
}
function appendLog(entry) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`)
  } catch (e) {
    throw new Error(`Could not append to ${LOG_PATH}: ${e.message}`)
  }
}
function reviewCounts() {
  const counts = {}
  for (const e of readLog()) if (e.type === 'review') counts[e.family] = (counts[e.family] || 0) + 1
  return counts
}
function repoName() {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  return basename((top.status === 0 && top.stdout.trim()) || process.cwd())
}

const outcomeAt = process.argv.indexOf('--log-outcome')
if (outcomeAt !== -1) {
  const [ref, confirmedArg, rejectedArg] = process.argv.slice(outcomeAt + 1)
  const confirmed = Number(confirmedArg)
  const rejected = Number(rejectedArg)
  if (!ref || !Number.isInteger(confirmed) || !Number.isInteger(rejected) || confirmed < 0 || rejected < 0) {
    console.error('✖ usage: node review.mjs --log-outcome <review-id | reviews/<id> | report path> <confirmed> <rejected>')
    process.exit(1)
  }
  // The ref is a review id, its reviews/<id> folder, or the report path. A path names its repo
  // (the folder above reviews/; the current repo for a relative one), which settles a tie.
  const parts = String(ref).replace(/\/code-review\.md$/, '').replace(/\/+$/, '').split('/')
  const ts = parts.at(-1)
  const at = parts.lastIndexOf('reviews')
  const repoHint = at > 0 ? parts[at - 1] : at === 0 ? repoName() : null
  let matches = readLog().filter((e) => e.type === 'review' && (e.id === ts || basename(e.dir || '') === ts))
  if (matches.length > 1 && repoHint) matches = matches.filter((e) => e.repo === repoHint)
  if (matches.length > 1) {
    console.error(
      `✖ "${ref}" matches ${matches.length} logged reviews (${matches.map((e) => `${e.repo}/${e.dir}`).join(', ')}) — ` +
        'pass the full report path to pick one',
    )
    process.exit(1)
  }
  const [review] = matches
  if (!review) {
    console.error(`✖ No logged review matches "${ts}"`)
    process.exit(1)
  }
  const entry = {
    type: 'outcome',
    ts: new Date().toISOString(),
    review: review?.id ?? ts,
    repo: review?.repo ?? repoName(),
    family: review?.family ?? null,
    model: review?.model ?? null,
    vendor: review?.vendor ?? null,
    confirmed,
    rejected,
  }
  appendLog(entry)
  console.log(`✓ outcome logged — ${ts}: ${confirmed} confirmed, ${rejected} rejected (${entry.family ?? 'unknown reviewer'})`)
  process.exit(0)
}

// reviewer=claude runs the multi-agent team unless claudeModel names one family or id ("team" or
// unset = the team), which then runs as one comprehensive agent.
const CLAUDE_MODEL = String(cfg('REVIEW_CLAUDE_MODEL', 'claudeModel', '')).trim() || 'team'
// Effort: every reviewer runs at its family's flavor effort (or the role's); the team lenses run
// at TEAM_EFFORT. The per-vendor knobs below override that for one vendor.
const TEAM_EFFORT = cfg('REVIEW_TEAM_EFFORT', 'teamEffort', 'xhigh')
const GROK_MAX_TURNS = cfg('REVIEW_GROK_MAX_TURNS', 'grokMaxTurns', 40)
// The base defaults to whatever the remote calls its default branch — reviewing against the
// wrong base produces a wrong diff that still looks like a successful run, so this is worth
// resolving rather than assuming. `origin/HEAD` is frequently unset (a plain `git remote add`
// never writes it), so try to populate it once before giving up, and make the fallback loud.
function detectDefaultBase() {
  if (!existsSync('.git')) return 'origin/main' // getDiff() reports the real problem
  const readHead = () =>
    spawnSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' })
  let r = readHead()
  if (r.status !== 0) {
    spawnSync('git', ['remote', 'set-head', 'origin', '--auto'], { encoding: 'utf8' })
    r = readHead()
  }
  const ref = (r.stdout || '').trim()
  if (r.status === 0 && ref) return ref
  console.warn(
    `⚠ Could not resolve origin/HEAD — falling back to origin/main. If this repo's default branch\n` +
      `  is not "main", pass REVIEW_BASE=origin/<branch> or set "base" in review-config.json.`,
  )
  return 'origin/main'
}
// `||` not `??` so an empty string in review-config.json still means "auto-detect".
const BASE = cfg('REVIEW_BASE', 'base', '') || (['--gate', '--deferred', '--rubric', '--calibrate'].some((flag) => args.includes(flag)) ? '' : detectDefaultBase())
// Optional per-repo gate (config `verifyCmd`, e.g. "npm run type-check"). Its result is CONTEXT
// for the reviewer, never a gate: a failing build is something to explain, not a reason to skip
// the review. Unset = unchanged behavior.
const VERIFY_CMD = cfg('REVIEW_VERIFY_CMD', 'verifyCmd', '')
let VERIFY_RESULT = null
const DIFF_CAP = 120_000 // chars of diff inlined into the review prompt
// REVIEW_PATHS / config "paths": git pathspecs (comma- or newline-separated, or a config array) that
// slice a review to `git diff <base>...HEAD -- <paths>`. Each slice has its own record and close; the
// push gate accepts slices only when, together, they cover every file of the diff.
function normalisePaths(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,\n]/)
  return [...new Set(list.map((p) => String(p).trim().replace(/^(?:\.\/)+(?=.)/, '')).filter(Boolean))].sort()
}
const PATHS = normalisePaths(cfg('REVIEW_PATHS', 'paths', ''))
// The slice in force: REVIEW_PATHS for a review, the original's stored paths for its fix check.
let SLICE = PATHS.length ? PATHS : null
const sliceOf = (record) => (Array.isArray(record?.paths) && record.paths.length ? record.paths : null)
const pathspec = (paths) => (paths ? ['--', ...paths] : [])
const sliceSuffix = (paths) => (paths ? ` -- ${paths.join(' ')}` : '')
const FILE_AT_OR_BELOW = 10
const HIGH_AT_OR_ABOVE = 40
const RUBRIC_VERSION = '2026-10-29.2'
const RUBRIC = `Score every finding; the script derives its severity from your scores.
trigger: the concrete input, command or call path in this project's normal use that reaches the defect. If none exists, say so and give likelihood 1. No real trigger means likelihood 1.
likelihood (1–10): how often this project's normal use reaches it, counting how often its prerequisites occur.
- 1: no path in normal use reaches it (no real trigger).
- 3: a named, uncommon but supported path, a few in 100 uses.
- 5: a regular optional path, about 1 in 10 uses.
- 7: most uses of that feature.
- 10: every use, deterministic.
impact (1–10):
- 1: cosmetic.
- 3: friction (minutes lost, a misleading message), with the result still correct.
- 5: one visible failed or wrong run, redone.
- 7: silently wrong, a safeguard doesn't apply, or the main workflow is blocked.
- 10: can't be undone (data lost without ordinary undo, an exploitable hole, wrong money).
A failure nobody would notice scores one band higher.
protected: true only when you can demonstrate one of these four cases:
- a reachable, exploitable security hole;
- stored data destroyed or overwritten beyond ordinary undo (if revert, reflog, trash or a re-run restores it, it is not protected);
- wrong money;
- a way around the review gate in the gate's own logic: the push check, the close, a dispute or a
  waiver accepting work it should refuse. A command phrasing the agent guard (agent-guard) doesn't
  recognize is not protected: score it by likelihood × impact like any other bug, because the guard
  is an accident barrier.
Protected findings are HIGH however rare, and never filed.
risk = likelihood × impact:
- HIGH when protected, or risk >= ${HIGH_AT_OR_ABOVE};
- LOW when risk <= ${FILE_AT_OR_BELOW} and not protected; LOW is filed, not fixed unless the operator picks it;
- MEDIUM otherwise.
Fix HIGH first, then MEDIUM. Both block until fixed, REFUTED or waived by the operator.
Missing or invalid scores are asked for again once. A finding still unscored blocks as MEDIUM (HIGH if protected is exactly true).`
const VALUE_FLAGS = ['--plan', '--close', '--status', '--test-cmd', '--no-tests', '--fix-check', '--dispute', '--reason', '--evidence', '--waive', '--log-grade', '--recheck-of']
const INTENT = args.includes('--dispute') || args.includes('--waive') || args.includes('--log-grade')
  ? ''
  : args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(args[i - 1])).join(' ').trim()
const PLAN_PATH = option('--plan') ?? process.env.REVIEW_PLAN
let CONTEXT = ''
let DIFF_BASE = BASE
// verify: "second-opinion" sends surviving HIGH/MEDIUM findings to one other pool family.
const SECOND_OPINION = String(cfg('REVIEW_VERIFY', 'verify', 'off')).trim().toLowerCase() === 'second-opinion'
const QUOTE_WINDOW = 5 // a quote must start within ±this many lines of the cited line
// An optional local classifier: any command that answers the choice protocol in askClassifier().
// None ships or is assumed. `pick` may name one; `classifier` names the one disputes may ask.
const CLASSIFIER = String(cfg('REVIEW_CLASSIFIER', 'classifier', '')).trim()
const CLASSIFIER_ACT = 0.7 // act on its choice at confidence ≥ 0.7; below is the middle band
// Path patterns are case-insensitive globs: `**` spans directories, `*` and `?` stay inside one.
// Like .gitignore, a pattern with no `/` is matched against every path segment ("*auth*").
const RISK_PATHS = Array.isArray(CONFIG.riskPaths)
  ? CONFIG.riskPaths
  : ['*payment*', '*billing*', '*checkout*', '*auth*', '*migration*', '*security*', '*money*']
// force: [{ "paths": ["**/auth/**", …] | "risk", "family": "<family>" }] — first match wins, before any pick.
const FORCE = Array.isArray(CONFIG.force) ? CONFIG.force : []

function globRe(p) {
  let re = ''
  const g = String(p)
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') {
      i++
      if (g[i + 1] === '/') {
        i++
        re += '(?:.*/)?'
      } else re += '.*'
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'i')
}
const matchesAny = (path, patterns) =>
  patterns.some((p) =>
    String(p).includes('/') ? globRe(p).test(path) : path.split('/').some((seg) => globRe(p).test(seg)),
  )

const LANGS = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', sql: 'sql',
  sh: 'shell', css: 'css', scss: 'css', html: 'html', md: 'markdown', json: 'json', yml: 'yaml', yaml: 'yaml',
}
// A renamed file is judged by both names, so moving code into auth/ can't dodge an auth rule.
const pathsOf = (f) => (f.from ? [f.path, f.from] : [f.path])
// Paths and line counts only — this is everything a classifier and the force rules ever see of the diff.
function diffStats(range = `${BASE}...HEAD`, paths = null) {
  // -z keeps paths unquoted; a rename is `added\tremoved\t` then NUL-separated source and destination.
  // Pathspecs resolve from the top of the work tree.
  const r = spawnSync('git', [...(paths ? ['-C', TOP] : []), 'diff', '--numstat', '-z', '-M', range, ...pathspec(paths)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.status !== 0) return null
  const toks = r.stdout.split('\0')
  const files = []
  for (let i = 0; i < toks.length; i++) {
    const m = toks[i].match(/^([-\d]+)\t([-\d]+)\t([\s\S]*)$/)
    if (!m) continue
    const stat = { added: Number(m[1]) || 0, removed: Number(m[2]) || 0 }
    if (m[3]) files.push({ path: m[3], ...stat })
    else {
      files.push({ path: toks[i + 2], from: toks[i + 1], ...stat })
      i += 2
    }
  }
  const languages = {}
  for (const f of files) {
    const ext = f.path.includes('.') ? f.path.split('.').pop().toLowerCase() : '(none)'
    const lang = LANGS[ext] || ext
    languages[lang] = (languages[lang] || 0) + 1
  }
  const riskFiles = files.flatMap((f) => pathsOf(f).filter((p) => matchesAny(p, RISK_PATHS)))
  return {
    files,
    filesChanged: files.length,
    linesAdded: files.reduce((n, f) => n + f.added, 0),
    linesRemoved: files.reduce((n, f) => n + f.removed, 0),
    languages,
    riskFiles,
  }
}

// One choice among the candidates from the classifier `command` (JSON on stdin, JSON answer on
// stdout). Returns { choice, confidence, probabilities } or { error }.
function askClassifier(command, candidates, stats) {
  const criteria = Object.fromEntries(
    candidates.map((m) => [
      m.family,
      `Good at: ${m.likes.join('; ') || 'not described'}. Watch for: ${m.quirks.join('; ') || 'not described'}.`,
    ]),
  )
  criteria.unsure = 'No candidate clearly fits this diff better than the others'
  const payload = {
    state: {
      task: 'Choose which model family should code-review this diff, from the diff summary and each family’s strengths and weaknesses.',
      diff: {
        files_changed: stats.filesChanged,
        lines_added: stats.linesAdded,
        lines_removed: stats.linesRemoved,
        languages: stats.languages,
        touches_risk_paths: stats.riskFiles.length > 0,
        risk_files: stats.riskFiles.slice(0, 20),
        paths: stats.files.slice(0, 40).flatMap(pathsOf),
      },
    },
    questions: {
      reviewer: {
        type: 'choice',
        instructions: 'Which reviewer family is the best fit to find real defects in this diff?',
        criteria,
      },
    },
  }
  const r = spawnSync(command, ['--json-out'], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 30_000 })
  if (r.error || r.status !== 0)
    return { error: r.error?.message || (r.stderr || '').trim().split('\n')[0] || `exit ${r.status}` }
  try {
    const ans = JSON.parse(r.stdout)?.answers?.reviewer
    if (ans?.type !== 'choice' || !ans.choice) return { error: `no choice answer in ${r.stdout.slice(0, 200)}` }
    return { choice: ans.choice, confidence: Number(ans.confidence), probabilities: ans.probabilities || {} }
  } catch {
    return { error: `unparseable classifier output: ${String(r.stdout).slice(0, 200)}` }
  }
}
// The log keeps a classifier's answer under that classifier's own command name.
const classifierRecord = (command, answer) => (command && answer ? { [basename(command)]: answer } : {})

// ── Reviewer selection ───────────────────────────────────────────────────────
// An explicit reviewer (REVIEW_REVIEWER / config "reviewer", or a pinned codex model) wins.
// Otherwise the pool from the registry, narrowed by crossFamily, then chosen by `pick`.
// The per-vendor effort knobs override a family's flavor effort for that vendor; unset, each
// family runs at its own effort.
function effortFor(m) {
  if (m.vendor === 'codex') return cfg('REVIEW_EFFORT', 'effort', '') || m.effort
  if (m.vendor === 'grok') return cfg('REVIEW_GROK_EFFORT', 'grokEffort', '') || m.effort
  if (m.vendor === 'claude') return cfg('REVIEW_CLAUDE_EFFORT', 'claudeEffort', '') || m.effort
  return m.effort
}
// A family outside the pool resolves through model-id; its CLI follows its id's prefix.
const poolMember = (family, pool) => {
  const known = pool?.find((m) => m.family === family)
  if (known) return known
  const id = modelId(family)
  return { family, vendor: vendorOf(id), id, ...flavorOf(family) }
}
// A vendor name, a pool family, a raw id, or a family model-id can resolve; else null.
function vendorOfName(name, pool) {
  if (VENDORS.includes(name)) return name
  const known = pool?.find((m) => m.family === name)
  if (known) return known.vendor
  if (!FAMILY_NAME.test(name)) return vendorOf(name)
  const r = spawnSync('model-id', [name], { encoding: 'utf8' })
  return r.status === 0 ? vendorOf((r.stdout || '').trim()) : null
}
const source = (env, key) => (process.env[env] != null ? env : `config "${key}"`)

// The multi-agent team: parallel Claude reviewers, each a distinct lens, merged + deduped.
const LENSES = [
  { key: 'correctness', focus: 'logic errors, wrong conditions, off-by-one, cases the stated behavior misses' },
  { key: 'regressions', focus: 'error handling, race conditions, breaking existing callers, data-flow/type mistakes' },
  {
    key: 'inputs-and-edges',
    focus: 'null/empty/unexpected input, boundary values, and misuse of the new code by existing callers',
  },
]
// Lens models come from the reviewer role's Claude families in role order; the first is reused
// when there are fewer families than lenses. No Claude family means no team.
function teamLenses(pool) {
  const claude = pool.filter((m) => m.vendor === 'claude')
  if (!claude.length)
    stop(
      `The Claude multi-agent team has no Claude family to run on: the reviewer role's usable families are ` +
        `${pool.map((m) => m.family).join(', ')}.\n` +
        `  Fix: add a Claude family to the reviewer role in ACS → Models → Roles, or name another reviewer.`,
    )
  return LENSES.map((lens, i) => {
    const m = claude[i] || claude[0]
    return { ...lens, family: m.family, model: m.id }
  })
}

// A family name that did not resolve: model-id is missing, or the registry has no such family.
function unresolved(name, label, loaded) {
  if (loaded.missing) poolOrStop(loaded)
  stop(`${label} names "${name}", which model-id could not resolve to a model id.\n  Fix: check \`model-id ${name}\` and the families in ACS → Models.`)
}

// stats = diffStats() (null when unknown); dryRun (--show-config) never runs a classifier.
function selectReviewer(stats, { dryRun = false } = {}) {
  const notes = []
  const loaded = loadPool()
  const { pool, error } = loaded
  const explicit = String(cfg('REVIEW_REVIEWER', 'reviewer', '')).trim().toLowerCase()
  const pinnedModel = String(cfg('REVIEW_MODEL', 'model', '')).trim()
  const base = { notes, pool, poolError: error, pick: null, crossFamily: null, author: null }
  const named = `${source('REVIEW_REVIEWER', 'reviewer')}=${explicit}`

  if (explicit === 'claude') {
    requireCli({ vendor: 'claude' }, named)
    if (CLAUDE_MODEL === 'team') {
      const lenses = teamLenses(poolOrStop(loaded))
      return {
        ...base,
        sel: { family: 'claude-team', vendor: 'claude', team: true, lenses, id: lenses.map((l) => l.family).join('+'), effort: TEAM_EFFORT },
        why: `${named} (explicit) — the multi-agent team`,
      }
    }
    const asFamily = FAMILY_NAME.test(CLAUDE_MODEL.toLowerCase())
    const member = asFamily ? pool?.find((m) => m.family === CLAUDE_MODEL.toLowerCase()) : null
    const id = member?.id || modelId(CLAUDE_MODEL)
    if (!vendorOf(id) && asFamily) unresolved(CLAUDE_MODEL, `${source('REVIEW_CLAUDE_MODEL', 'claudeModel')}`, loaded)
    if (vendorOf(id) !== 'claude')
      stop(`${source('REVIEW_CLAUDE_MODEL', 'claudeModel')}=${CLAUDE_MODEL} resolves to "${id}", which is not a Claude model.`)
    const family = member?.family || (asFamily ? CLAUDE_MODEL.toLowerCase() : pool?.find((m) => m.id === id)?.family || id)
    const m = { family, vendor: 'claude', id, effort: member?.effort || (asFamily ? flavorEffort(family) : TEAM_EFFORT) }
    return {
      ...base,
      sel: { ...m, effort: effortFor(m) },
      why: `${named} with claudeModel=${CLAUDE_MODEL} (explicit) — one agent`,
    }
  }

  if (explicit === 'codex' || (!explicit && pinnedModel)) {
    requireCli({ vendor: 'codex' }, explicit ? named : `${source('REVIEW_MODEL', 'model')}=${pinnedModel}`)
    let m
    let why
    if (pinnedModel) {
      // A raw id passes through as given; a family name must resolve.
      const id = modelId(pinnedModel)
      const familyName = pinnedModel.toLowerCase()
      const asFamily = FAMILY_NAME.test(familyName)
      if (asFamily && !vendorOf(id)) unresolved(pinnedModel, source('REVIEW_MODEL', 'model'), loaded)
      const family = asFamily ? familyName : pool?.find((p) => p.id === id)?.family || pinnedModel
      const known = pool?.find((p) => p.family === family)
      m = { family, vendor: 'codex', id, effort: known?.effort || (asFamily ? flavorEffort(family) : 'high') }
      why = `${explicit ? `${named}, ` : ''}${source('REVIEW_MODEL', 'model')}=${pinnedModel} (codex model pinned)`
    } else {
      m = poolOrStop(loaded).find((p) => p.vendor === 'codex')
      if (!m)
        stop(
          `${named} needs a codex family in the reviewer role, and it has none.\n` +
            `  Fix: add one to the reviewer role in ACS → Models → Roles, or pin one with REVIEW_MODEL / config "model".`,
        )
      why = `${named} — first codex family in the reviewer role`
    }
    return { ...base, sel: { ...m, effort: effortFor(m) }, why }
  }

  if (explicit) {
    // A named family (or the grok vendor) needs model-id to know which CLI runs it.
    if (loaded.missing) poolOrStop(loaded)
    const m =
      pool?.find((p) => p.family === explicit) ||
      (VENDORS.includes(explicit) && pool?.find((p) => p.vendor === explicit)) ||
      poolMember(explicit, pool)
    if (!m.vendor) {
      console.error(
        `✖ REVIEW_REVIEWER / config "reviewer" must be codex, claude, grok, or a reviewer family ` +
          `(${(pool || []).map((p) => p.family).join(', ')}) — got "${explicit}"`,
      )
      process.exit(1)
    }
    requireCli(m, named)
    return { ...base, sel: { ...m, effort: effortFor(m) }, why: `${named} (explicit)` }
  }

  const members = poolOrStop(loaded)
  const pick = String(cfg('REVIEW_PICK', 'pick', 'first')).trim().toLowerCase() || 'first'
  // A pick naming a role family that cannot run stops; it never becomes another reviewer.
  const unusablePick = !members.some((m) => m.family === pick) && loaded.unusable?.find((m) => m.family === pick)
  if (unusablePick) {
    const named = `${source('REVIEW_PICK', 'pick')}=${pick}`
    if (!unusablePick.vendor)
      stop(`${named} names a reviewer role family whose id "${unusablePick.id}" has no known CLI prefix (claude-, gpt-, grok-).\n` +
        `  Fix: check \`model-id ${pick}\` and the families in ACS → Models, or pick another family.`)
    requireCli(unusablePick, named)
  }
  let crossFamily = String(cfg('REVIEW_CROSS_FAMILY', 'crossFamily', 'prefer')).trim().toLowerCase() || 'prefer'
  if (crossFamily !== 'prefer' && crossFamily !== 'off') {
    notes.push(`⚠ crossFamily "${crossFamily}" is not prefer|off — using prefer`)
    crossFamily = 'prefer'
  }
  const author = String(cfg('REVIEW_AUTHOR', 'author', '')).trim().toLowerCase()
  const authorVendor = author ? vendorOfName(author, members) : null
  if (author && !authorVendor) notes.push(`⚠ author "${author}" is not a known family or vendor — treated as unknown`)

  let candidates = members
  let crossWhy = ''
  if (crossFamily === 'prefer') {
    if (!authorVendor) notes.push('ℹ author unknown — crossFamily not applied (set REVIEW_AUTHOR=<family|vendor>)')
    else {
      const others = members.filter((m) => m.vendor !== authorVendor)
      if (others.length) {
        candidates = others
        crossWhy = `crossFamily=prefer skipped ${authorVendor} (author ${author})`
      } else crossWhy = `every pool member is ${authorVendor}, the author's vendor — not filtered`
    }
  }

  // Hard rules before any pick: the first force rule whose paths match decides.
  const forced = FORCE.map((r) => {
    const family = String(r?.family).toLowerCase()
    const m = FAMILY_NAME.test(family) ? poolMember(family, members) : null
    return { rule: r, m: m?.vendor ? m : null }
  })
  const hit = forced.find(({ rule: r, m }) => {
    if (!stats || !m) return false
    const paths = r.paths ?? r.when // `when` is the earlier spelling
    return paths === 'risk'
      ? stats.riskFiles.length > 0
      : Array.isArray(paths) && stats.files.some((f) => pathsOf(f).some((p) => matchesAny(p, paths)))
  })
  if (forced.some(({ m }) => !m))
    notes.push(`⚠ a force rule names an unknown family — ignored (${FORCE.map((r) => r?.family).join(', ')})`)

  let m
  let pickWhy
  let classifier = null
  const classifierPick =
    !['first', 'rotate'].includes(pick) && !members.some((p) => p.family === pick) && (pick === CLASSIFIER || onPath(pick))
  if (hit) {
    m = requireCli(hit.m, `force rule → ${hit.m.family}`)
    const paths = hit.rule.paths ?? hit.rule.when
    const hits = paths === 'risk' ? stats.riskFiles : stats.files.flatMap(pathsOf).filter((p) => matchesAny(p, paths))
    pickWhy = `force: ${paths === 'risk' ? 'risk paths' : `paths ${paths.join(', ')}`} (${hits.slice(0, 3).join(', ')}) → ${m.family}`
    crossWhy = authorVendor && crossFamily === 'prefer' && m.vendor === authorVendor
      ? `force rule overrides crossFamily (author is also ${authorVendor})`
      : ''
  } else if (classifierPick) {
    m = candidates[0]
    if (dryRun) pickWhy = `pick=${pick}: decided at review time (fallback shown: ${m.family})`
    else if (!stats) {
      notes.push(`⚠ pick=${pick}: no diff stats — using the first family`)
      pickWhy = `pick=${pick} fell back to first (${m.family})`
    } else {
      const answer = askClassifier(pick, candidates, stats)
      classifier = { command: pick, answer }
      const dist = answer.probabilities && Object.entries(answer.probabilities).map(([k, v]) => `${k}=${v}`).join(' ')
      const chosen = candidates.find((c) => c.family === answer.choice)
      if (answer.error) {
        notes.push(`⚠ pick=${pick}: ${pick} failed (${answer.error}) — using the first family`)
        pickWhy = `pick=${pick} fell back to first (${m.family})`
      } else if (!chosen || !(answer.confidence >= CLASSIFIER_ACT)) {
        pickWhy = `pick=${pick}: ${answer.choice} at conf ${answer.confidence} is ${chosen ? 'in the middle band' : 'not a candidate'} — first (${m.family}) · ${dist}`
      } else {
        m = chosen
        pickWhy = `pick=${pick}: ${m.family} at conf ${answer.confidence} · ${dist}`
      }
    }
  } else if (pick === 'rotate') {
    const counts = reviewCounts()
    m = candidates.reduce((best, c) => ((counts[c.family] || 0) < (counts[best.family] || 0) ? c : best))
    pickWhy = `pick=rotate: fewest logged reviews (${counts[m.family] || 0})`
  } else if (pick !== 'first' && members.some((p) => p.family === pick)) {
    m = members.find((p) => p.family === pick)
    pickWhy = `pick=${pick} (named)`
    crossWhy = authorVendor && crossFamily === 'prefer' && m.vendor === authorVendor
      ? `named pick overrides crossFamily (author is also ${authorVendor})`
      : ''
  } else {
    if (pick !== 'first')
      notes.push(
        `⚠ pick "${pick}" is not first, rotate, a pool family (${members.map((p) => p.family).join(', ')}) ` +
          `or a classifier command on PATH — using first`,
      )
    m = candidates[0]
    pickWhy = 'pick=first: first in pool order'
  }
  return {
    ...base,
    pool: members,
    pick,
    crossFamily,
    author: author || null,
    classifier,
    sel: { ...m, effort: effortFor(m) },
    why: [pickWhy, crossWhy].filter(Boolean).join('; '),
  }
}

// Selected in main() once the diff is fetched (force rules and a classifier need its stats).
let SELECTION
let SEL

if (process.argv.includes('--show-config')) {
  const stats = existsSync('.git') ? diffStats() : null
  SELECTION = selectReviewer(stats, { dryRun: true })
  SEL = SELECTION.sel
  const counts = reviewCounts()
  console.log(
    JSON.stringify(
      {
        selected: { family: SEL.family, vendor: SEL.vendor, model: SEL.id, effort: SEL.effort },
        why: SELECTION.why,
        notes: SELECTION.notes,
        reviewer: cfg('REVIEW_REVIEWER', 'reviewer', '') || '(pool)',
        pool:
          SELECTION.pool?.map((m) => ({ family: m.family, vendor: m.vendor, model: m.id, effort: m.effort })) ??
          `(unresolved: ${SELECTION.poolError})`,
        pick: SELECTION.pick ?? '(explicit reviewer — not used)',
        crossFamily: SELECTION.crossFamily ?? '(explicit reviewer — not used)',
        author: SELECTION.author ?? '(unknown)',
        reviewCounts: Object.fromEntries(
          [...new Set([...(SELECTION.pool || []).map((m) => m.family), ...Object.keys(counts)])].map((f) => [
            f,
            counts[f] || 0,
          ]),
        ),
        claudeModel: CLAUDE_MODEL,
        base: BASE,
        baseSource: cfg('REVIEW_BASE', 'base', '') ? 'configured' : 'auto-detected',
        force: FORCE.length ? FORCE : '(none)',
        riskFiles: stats ? stats.riskFiles : '(no diff stats)',
        verify: SECOND_OPINION ? 'second-opinion' : 'quote check only',
        verifyCmd: VERIFY_CMD || '(none)',
        source: CONFIG._source || '(built-in defaults / env only)',
        log: LOG_PATH,
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

// OpenAI strict mode (Codex) requires every property in `required`; "optional" fields are nullable.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['issue', 'file', 'line', 'quote', 'suggestion', 'likelihood', 'impact', 'protected', 'trigger'],
        properties: {
          issue: { type: 'string' },
          file: { type: ['string', 'null'] },
          line: { type: ['string', 'null'] },
          quote: { type: 'string' },
          suggestion: { type: ['string', 'null'] },
          likelihood: { type: 'integer', minimum: 1, maximum: 10 },
          impact: { type: 'integer', minimum: 1, maximum: 10 },
          protected: { type: 'boolean' },
          trigger: { type: 'string' },
        },
      },
    },
  },
}
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'verdict', 'evidence'],
        properties: {
          index: { type: 'integer' },
          verdict: { type: 'string', enum: ['CONFIRMED', 'REFUTED'] },
          evidence: { type: 'string' },
        },
      },
    },
  },
}

function sh(cmd, args, { allowFailure = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (!allowFailure && (r.error || r.status !== 0))
    throw new Error(`${cmd} ${args.join(' ')} failed: ${r.error?.message || r.stderr}`)
  return (r.stdout || '').trim()
}

function requireClean() {
  if (sh('git', ['status', '--porcelain', '--untracked-files=no']))
    throw new Error('Tracked working tree changes present — commit them before review, fix check or close.')
}
const hasVerdict = (verdict) => ['CONFIRMED', 'REFUTED'].includes(verdict)
const isFiled = (finding) => !finding.criterionId && finding.filed === true
const SCORE_FIELDS = ['likelihood', 'impact', 'protected', 'trigger']
const isLegacy = (f) => !SCORE_FIELDS.some((key) => Object.hasOwn(f, key))
const validScores = (f) => ['likelihood', 'impact'].every((k) => Number.isInteger(f[k]) && f[k] >= 1 && f[k] <= 10) &&
  typeof f.protected === 'boolean' && typeof f.trigger === 'string' && !!f.trigger.trim()
const derivedSeverity = (f) => f.protected || f.likelihood * f.impact >= HIGH_AT_OR_ABOVE ? 'high' :
  f.likelihood * f.impact <= FILE_AT_OR_BELOW ? 'low' : 'medium'
const blocking = (f) => !isFiled(f) && (f.severity !== 'low' || f.unscored === true)
function resolutionRules(record, finding) {
  if (Object.hasOwn(record, 'rubricVersion')) {
    const required = blocking(finding)
    return { status: required, refutation: required }
  }
  return { status: !isFiled(finding), refutation: !isFiled(finding) && finding.severity !== 'low' }
}
function scoreFinding(finding, legacyAllowed = true) {
  const { severity, reviewerSeverity, unscored, risk, filed, ...plain } = finding
  const comparison = Object.hasOwn(finding, 'severity') ? { reviewerSeverity: severity } : {}
  // Real reviewers require scores in the schema; only old stubs use this compatibility path.
  if (legacyAllowed && isLegacy(finding)) {
    const label = String(severity || '').toLowerCase()
    return { ...plain, severity: ['high', 'medium', 'low'].includes(label) ? label : 'high', unscored: true, ...comparison }
  }
  if (!validScores(finding)) return { ...plain, ...comparison, severity: finding.protected === true ? 'high' : 'medium', risk: null, filed: false, unscored: true }
  const band = derivedSeverity(finding)
  return { ...plain, ...comparison, risk: finding.likelihood * finding.impact, severity: band, filed: band === 'low' }
}
function publicFinding(f) {
  if (!isLegacy(f)) return f
  const { unscored, reviewerSeverity, ...legacy } = f
  return legacy
}
const SCORE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['scores'], properties: {
    scores: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['index', ...SCORE_FIELDS], properties: { index: { type: 'integer' },
        ...Object.fromEntries(SCORE_FIELDS.map((key) => [key, SCHEMA.properties.findings.items.properties[key]])) } } },
  },
}
async function scoredFindings(raw, selection) {
  const asked = raw.map((f, index) => ({ ...f, index })).filter((f) => !isLegacy(f) && !validScores(f))
  let scored = 0
  if (asked.length) {
    const lead = selection.team && selection.lenses[0]
    const reviewer = lead ? { ...selection, team: false, family: lead.family, id: lead.model, effort: TEAM_EFFORT } : selection
    const prompt = `Supply scores only for these findings, keyed by their index. Do not change the finding text.\n${RUBRIC}\n` +
      JSON.stringify(asked.map((f) => ({ index: f.index, file: f.file, line: f.line, issue: f.issue, quote: f.quote })))
    try {
      const { result } = await runModel(reviewer, prompt, SCORE_SCHEMA, 'score missing findings')
      for (const f of asked) {
        const answers = (Array.isArray(result?.scores) ? result.scores : []).filter((a) => a?.index === f.index)
        if (answers.length !== 1 || !validScores(answers[0])) continue
        Object.assign(raw[f.index], Object.fromEntries(SCORE_FIELDS.map((key) => [key, answers[0][key]])))
        scored++
      }
    } catch (e) { console.warn(`⚠ Score follow-up failed; unscored findings block: ${e.message}`) }
  }
  return { findings: raw.map((f) => scoreFinding(f)), rescored: { asked: asked.length, scored } }
}

function reviewContext(branch) {
  let context = ''
  if (PLAN_PATH) {
    const plan = resolve(PLAN_PATH)
    if (!existsSync(plan)) throw new Error(`Missing plan file: ${plan}`)
    context += `Plan (intent, pass/fail criteria and decisions):\n${readFileSync(plan, 'utf8')}\n`
    const log = join(dirname(plan), 'log.md')
    if (existsSync(log)) context += `Build log:\n${readFileSync(log, 'utf8')}\n`
  }
  const repoId = repoIdentity()
  const entries = readLog()
  const decided = entries.filter((e) => e.type === 'close').flatMap((close) => {
    const review = entries.find((e) => e.type === 'review' && e.id === close.review && e.branch === branch && e.repoId === repoId)
    return review ? Object.entries(close.statuses || {}).filter(([, s]) => s.status === 'rejected').map(([id, status]) => {
      const owner = [review, entries.find((e) => e.id === close.recheck && e.type === 'review'), entries.find((e) => e.id === close.fixCheck && e.type === 'review')].filter(Boolean).find((r) => r.findingDetails?.some((f) => f.id === id)) || review
      const finding = owner.findingDetails?.find((f) => f.id === id)
      const reference = status.refutedBy || { review: owner.id, finding: id }
      const verdict = entries.find((e) => e.type === 'dispute' && e.review === reference.review && e.finding === reference.finding && hasVerdict(e.verdict))
      return { review: owner.id, finding: id, ...finding, ...status, verdict: verdict?.verdict || finding?.secondOpinion?.verdict || 'waived', verdictEvidence: verdict?.verdictEvidence || finding?.secondOpinion?.evidence }
    }) : []
  })
  for (const review of entries.filter((e) => e.type === 'review' && e.branch === branch && e.repoId === repoId))
    for (const finding of (review.findingDetails || []).filter(isFiled))
      decided.push({ ...finding, review: review.id, finding: finding.id, decision: 'filed' })
  if (decided.length) context += `Already decided; don't re-raise without new evidence:\n${JSON.stringify(decided)}\n`
  return context
}
function getDiff() {
  if (!existsSync('.git')) die('Not a git repository.')
  const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  requireClean()
  const slash = BASE.indexOf('/')
  if (slash > 0) {
    const f = spawnSync('git', ['fetch', BASE.slice(0, slash), BASE.slice(slash + 1)], {
      encoding: 'utf8',
    })
    if (f.error || f.status !== 0)
      console.warn(`⚠ Could not fetch ${BASE} — reviewing against a possibly-stale local base.`)
  }
  const head = sh('git', ['rev-parse', 'HEAD'])
  const baseSha = sh('git', ['merge-base', BASE, head])
  if (SLICE && !filesBetween(baseSha, head, SLICE).length)
    die(`REVIEW_PATHS (${SLICE.join(', ')}) matches no file changed between ${BASE} and HEAD; nothing was reviewed.\n` +
      `  Check the pathspecs against: git diff --name-only ${baseSha}...HEAD`)
  const diff = sh('git', [...(SLICE ? ['-C', TOP] : []), 'diff', `${baseSha}...${head}`, ...pathspec(SLICE)])
  return { branch, diff, head, baseSha }
}

const die = (m) => {
  console.error(`\n✖ ${m}\n`)
  process.exit(1)
}

// Portability: if the repo doesn't already ignore reviews/, add it to .git/info/exclude so the report
// never appears as an untracked file (some repos ignore it via .gitignore; others may not).
function ensureReviewsIgnored() {
  if (spawnSync('git', ['check-ignore', '-q', 'reviews']).status === 0) return
  try {
    const exclude = '.git/info/exclude'
    const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
    if (!cur.split('\n').includes('reviews/'))
      writeFileSync(exclude, `${cur}${!cur || cur.endsWith('\n') ? '' : '\n'}reviews/\n`)
  } catch {
    /* best-effort */
  }
}

const clip = (diff) =>
  diff.length > DIFF_CAP ? `${diff.slice(0, DIFF_CAP)}\n…[diff truncated; read files for the rest]` : diff
// For an unsliced diff over DIFF_CAP: how to slice it, naming the top-level folders with the most changed lines.
function sliceHint(stats) {
  const lines = {}
  for (const f of stats?.files || []) {
    if (!f.path.includes('/')) continue
    const top = `${f.path.split('/')[0]}/`
    lines[top] = (lines[top] || 0) + f.added + f.removed
  }
  const largest = Object.entries(lines).sort((a, b) => b[1] - a[1]).slice(0, 5)
  return `  Slice it instead: review each path group with REVIEW_PATHS=<pathspec>,<pathspec>, close every slice at\n` +
    `  the same HEAD, and make the slices together cover the whole diff (the push gate checks that).\n` +
    (largest.length ? `  Largest top-level folders: ${largest.map(([top, n]) => `${top} (${n} changed lines)`).join(', ')}\n` : '')
}

function toolNotes(vendor) {
  // Codex gets a sandboxed shell that can't open /dev/fd, so `diff <(cmd) <(cmd)` dies before it
  // runs — one sentence here saves a wasted verification round trip. The Claude lenses have no
  // Bash at all (Read/Grep/Glob only), so the same note would be advice they can't act on.
  if (vendor === 'codex')
    return [
      `Your shell is sandboxed read-only and cannot use bash process substitution — ` +
        `\`<(...)\` fails with "Operation not permitted". Use node one-liners or write ` +
        `intermediate output to files instead.`,
    ]
  if (vendor === 'grok')
    return [
      `Your only tools are read_file, list_dir and grep — there is no shell. This is a read-only ` +
        `review: never try to modify files.`,
    ]
  return []
}

function reviewPrompt(diff) {
  const clipped = clip(diff)
  const notes = toolNotes(SEL.vendor)
  notes.push(
    `Every finding MUST carry \`quote\`: one to three lines copied character-for-character from \`file\` ` +
      `as it is at HEAD, starting at or within ${QUOTE_WINDOW} lines of \`line\` (a single line number). ` +
      `Open the file and copy it — never paraphrase or reconstruct it from memory. A script checks every ` +
      `quote against the file; a finding whose quote is not there is discarded as unlocatable.`,
  )
  notes.push(RUBRIC)
  if (VERIFY_RESULT)
    notes.push(
      `This repo's verification command \`${VERIFY_RESULT.cmd}\` ` +
        `${VERIFY_RESULT.passed ? 'PASSED before this review.' : `FAILED (${VERIFY_RESULT.exit}). Output tail:\n${VERIFY_RESULT.tail}`}` +
        `\nTreat that as context, not as a finding in itself.`,
    )
  if (SLICE)
    notes.push(
      `This review is one slice of the branch: it covers only the paths ${SLICE.join(', ')}. ` +
        `Other slices review the rest, so report defects in these paths (open other files only for context).`,
    )
  return (
    `Review the branch diff below for CODE CORRECTNESS only — bugs, regressions, broken edge cases, ` +
    `bad error handling, data-integrity issues — judged against what the branch was supposed to do` +
    `${INTENT ? `: ${INTENT}` : ' (infer from the diff)'}. Inspect the diff (open files as needed) BEFORE answering. ` +
    `Do NOT comment on product direction, scope, or style preference.\n\n` +
    `${CONTEXT ? `${CONTEXT}\n` : ''}` +
    `${notes.length ? `${notes.join('\n\n')}\n\n` : ''}` +
    `Diff (git diff ${DIFF_BASE}...HEAD${sliceSuffix(SLICE)}):\n${clipped}`
  )
}

function verifierPrompt(diff, findings, vendor, range = `${DIFF_BASE}...HEAD${sliceSuffix(SLICE)}`) {
  const list = findings
    .map(
      (f, i) =>
        `[${i}] ${f.severity.toUpperCase()} ${f.file}:${f.line} — ${f.issue}\n    quoted code: ${f.quote}`,
    )
    .join('\n')
  return (
    `Another reviewer reported the findings below on this branch` +
    `${INTENT ? ` (intent: ${INTENT})` : ''}. Check each one against the actual code — open the file ` +
    `at the cited line and trace the call path. Answer CONFIRMED if the defect is real as described, ` +
    `REFUTED if it is not (the code does not do that, the scenario cannot occur, or the behavior is ` +
    `intended). Give one line of evidence naming file:line and what the code there shows. Return ` +
    `exactly one verdict per finding, keyed by its [index].\n\n` +
    `${toolNotes(vendor).join('\n\n')}\n\nFindings:\n${list}\n\nDiff (git diff ${range}):\n${clip(diff)}`
  )
}

// Runs the repo's own gate (if configured) before the reviewer, so the model spends its
// reasoning on judgment rather than re-deriving whether the branch compiles.
function runVerify() {
  if (!VERIFY_CMD) return null
  console.log(`▶ verify · ${VERIFY_CMD}`)
  const r = spawnSync(VERIFY_CMD, { shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const output = `${r.stdout || ''}\n${r.stderr || ''}`.trim()
  const passed = !r.error && r.status === 0
  // r.status is null when the shell itself couldn't be spawned — say that, not "exit null".
  const exit = r.error ? `spawn error: ${r.error.message}` : `exit ${r.status}`
  console.log(passed ? '  ✓ passed\n' : `  ✖ failed (${exit}) — fed to the reviewer as context\n`)
  return { cmd: VERIFY_CMD, passed, exit, tail: output.slice(-4000) }
}

// ── Backends: one read-only, structured-output call per vendor ──────────────
// Each returns { result, modelUsed? } where result is the schema-shaped object.
function runCodex(m, prompt, schema) {
  const tmp = mkdtempSync(join(tmpdir(), 'review-'))
  try {
    const schemaPath = join(tmp, 'schema.json')
    const outPath = join(tmp, 'out.json')
    writeFileSync(schemaPath, JSON.stringify(schema))
    const r = spawnSync(
      'codex',
      [
        'exec',
        '-c',
        `model=${m.id}`,
        '-c',
        `model_reasoning_effort=${m.effort}`,
        '-s',
        'read-only',
        '--output-schema',
        schemaPath,
        '-o',
        outPath,
        prompt,
      ],
      { stdio: ['ignore', 'inherit', 'inherit'], maxBuffer: 64 * 1024 * 1024 },
    )
    if (r.error || r.status !== 0) throw new Error(`codex review failed (exit ${r.status})`)
    return { result: JSON.parse(readFileSync(outPath, 'utf8')) }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// Grok is read-only ONLY because of the --tools allowlist: --permission-mode plan
// and --disallowed-tools Write,Edit,Bash were both observed to still write files.
// --tools also leaves the MCP meta-tools (search_tool, use_tool) in place, so any configured MCP
// server stays callable; --disallowed-tools removes them (it wins over --tools) and --deny MCPTool
// refuses any MCP call that still gets through. Both observed: a stub MCP server that writes a
// file was reached with --tools alone, and not with these flags.
const GROK_TOOLS = 'read_file,list_dir,grep'
const GROK_NO_MCP = ['--disallowed-tools', 'search_tool,use_tool', '--deny', 'MCPTool']
function grokArgs(m, prompt, schema) {
  return [
    '-p',
    prompt,
    '-m',
    m.id,
    '--cwd',
    process.cwd(),
    '--tools',
    GROK_TOOLS,
    ...GROK_NO_MCP,
    '--disable-web-search',
    '--no-subagents',
    '--reasoning-effort',
    String(m.effort),
    '--max-turns',
    String(GROK_MAX_TURNS),
    '--json-schema',
    JSON.stringify(schema),
  ]
}

function parseGrok(stdout) {
  let out
  try {
    out = JSON.parse(stdout)
  } catch {
    throw new Error(`grok review: output is not JSON: ${String(stdout).slice(0, 300)}`)
  }
  // A wrong or silently substituted model must not pass as a grok review.
  const used = Object.keys(out?.modelUsage || {})
  if (!used.some((k) => /grok/i.test(k)))
    throw new Error(`grok review: modelUsage names no grok model (got ${used.length ? used.join(', ') : 'none'})`)
  const result = typeof out.structuredOutput === 'string' ? JSON.parse(out.structuredOutput) : out.structuredOutput
  if (!result || typeof result !== 'object')
    throw new Error(`grok review: no structuredOutput in output: ${String(stdout).slice(0, 300)}`)
  return { result, modelUsed: used.join(',') }
}

function runGrok(m, prompt, schema) {
  const r = spawnSync('grok', grokArgs(m, prompt, schema), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.error || r.status !== 0)
    throw new Error(`grok review failed (exit ${r.status}): ${r.error?.message || String(r.stdout).slice(0, 300)}`)
  return parseGrok(r.stdout)
}

function spawnAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { maxBuffer: 64 * 1024 * 1024 })
    let out = ''
    let err = ''
    c.stdout.on('data', (d) => {
      out += d
    })
    c.stderr.on('data', (d) => {
      err += d
    })
    c.on('error', reject)
    c.on('close', (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`${cmd} exited ${code}: ${String(err).slice(0, 300)}`)),
    )
  })
}

// With --json-schema the CLI puts the object in `structured_output`; `result` is the text reply,
// which has been the same JSON but is not guaranteed to be — it is only the fallback.
function parseClaude(stdout) {
  const wrap = JSON.parse(stdout)
  if (wrap.is_error) throw new Error(`claude review errored: ${String(wrap.result).slice(0, 300)}`)
  if (wrap.structured_output && typeof wrap.structured_output === 'object') return wrap.structured_output
  if (typeof wrap.result !== 'string') return wrap.result
  try {
    return JSON.parse(wrap.result)
  } catch {
    throw new Error(`claude review: no structured_output and result is not JSON: ${wrap.result.slice(0, 300)}`)
  }
}

async function runClaude(m, prompt, schema, role) {
  const out = await spawnAsync('claude', [
    '-p',
    prompt,
    '--model',
    m.id,
    '--effort',
    String(m.effort),
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    // --tools decides which tools EXIST (--allowedTools only pre-approves, so a user's
    // acceptEdits or Bash(*) setting could still let a reviewer write); --strict-mcp-config with
    // no --mcp-config loads no MCP servers.
    '--tools',
    'Read,Grep,Glob',
    '--strict-mcp-config',
    '--append-system-prompt',
    `You are a precise ${role}. Report only real defects; do not invent issues.`,
  ])
  return { result: parseClaude(out) }
}

async function runModel(m, prompt, schema, role) {
  if (m.vendor === 'claude') return runClaude(m, prompt, schema, role)
  if (m.vendor === 'grok') return runGrok(m, prompt, schema)
  return runCodex(m, prompt, schema)
}

// Claude MULTI-AGENT single pass: parallel reviewers, each a distinct lens (LENSES, teamLenses()),
// merged + deduped. Still one pass (no loop) — just several agents looking at once.
async function review(diff) {
  // Anything but the team runs as ONE agent, one comprehensive pass; a Claude reviewer gets
  // every lens's focus in that one pass.
  if (!SEL.team) {
    const focus = SEL.vendor === 'claude' ? `\n\nFocus especially on: ${LENSES.map((l) => l.focus).join('; ')}.` : ''
    const { result, modelUsed } = await runModel(SEL, `${reviewPrompt(diff)}${focus}`, SCHEMA, 'comprehensive code reviewer')
    if (modelUsed) SEL.modelUsed = modelUsed
    return result?.findings || []
  }
  const perLens = await Promise.all(
    SEL.lenses.map(async (lens) => {
      const prompt = `${reviewPrompt(diff)}\n\nFocus especially on: ${lens.focus}.`
      const { result } = await runClaude(
        { id: lens.model, effort: TEAM_EFFORT },
        prompt,
        SCHEMA,
        `${lens.key} code reviewer`,
      )
      return result?.findings || []
    }),
  )
  // Merge + dedup across lenses. Same file:line from two lenses is the same
  // defect worded differently — keep the first. Location-less findings fall
  // back to an issue-prefix key so they don't all collapse into one.
  const seen = new Set()
  const merged = []
  for (const f of perLens.flat()) {
    const k =
      f.file || f.line
        ? `${f.file || ''}:${f.line || ''}`
        : `noloc:${(f.issue || '').slice(0, 80).toLowerCase()}`
    if (seen.has(k)) continue
    seen.add(k)
    merged.push(f)
  }
  return merged
}

// ── Deterministic quote check ────────────────────────────────────────────────
// A finding is located when its quote appears in the file (at HEAD, else at the base for
// deleted code) starting within ±QUOTE_WINDOW lines of the cited line. Only whitespace is
// normalized (runs collapse to one space, ends trimmed); every other character must match.
const TOP = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout?.trim() || process.cwd()
function fileAt(rev, path) {
  const r = spawnSync('git', ['show', `${rev}:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return r.status === 0 ? r.stdout : null
}
function quoteProblem(f) {
  if (!String(f.quote ?? '').trim()) return 'no quote'
  if (!f.file) return 'no file'
  // One line number, or a range "12-15" read as its start. Anything else is not a citation.
  const cited = String(f.line ?? '').trim()
  const lineMatch = cited.match(/^(\d+)(?:\s*[-–]\s*\d+)?$/)
  if (!lineMatch) return `line "${cited.slice(0, 40)}" is not a line number`
  let path = String(f.file).trim()
  if (path.startsWith(`${TOP}/`)) path = path.slice(TOP.length + 1)
  path = path.replace(/^\.\//, '')
  const text = fileAt('HEAD', path) ?? fileAt(DIFF_BASE, path) ?? fileAt('HEAD', path.replace(/^[ab]\//, ''))
  if (text == null) return `file not found: ${path}`
  const count = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
  const line = Number(lineMatch[1])
  // Also bounds the search loop: an unsafe integer (2^53, a 310-digit Infinity) never terminates s++.
  if (!Number.isSafeInteger(line) || line < 1 || line > count)
    return `line ${lineMatch[1].length > 20 ? `${lineMatch[1].slice(0, 20)}…` : lineMatch[1]} is outside ${path} (1–${count})`
  const norm = (l) => l.replace(/\s+/g, ' ').trim()
  const lines = text.split('\n').map(norm)
  const q = String(f.quote).split('\n').map(norm)
  while (q.length && !q[0]) q.shift()
  while (q.length && !q.at(-1)) q.pop()
  const needle = q.join('\n')
  for (let s = Math.max(1, line - QUOTE_WINDOW); s <= line + QUOTE_WINDOW; s++)
    if (lines.slice(s - 1, s - 1 + q.length).join('\n').includes(needle)) return null
  return `quote not found within ±${QUOTE_WINDOW} lines of ${path}:${line}`
}

// ── Optional second opinion: another family CONFIRMs or REFUTEs each HIGH/MEDIUM ──
// The families whose findings these are: a team's lens families, else the one reviewer family. A team
// record logged before `families` existed names its lens families in `model` (a+b+c).
function reviewingFamilies(review) {
  if (Array.isArray(review.families) && review.families.length) return review.families
  if (review.lenses) return [...new Set(review.lenses.map((l) => l.family))]
  if (review.family === 'claude-team') return [...new Set(String(review.model || '').split('+').filter(Boolean))]
  return [review.family].filter(Boolean)
}
// Never a family that reviewed: a different vendor from the reviewer when the pool has one; else the
// next family in pool order; else none, and the operator waiver is the only way to reject.
function pickVerifier() {
  const own = reviewingFamilies(SEL)
  const others = (SELECTION.pool || []).filter((m) => !own.includes(m.family))
  const m = others.find((o) => o.vendor !== SEL.vendor) || others[0]
  return m && { ...m, effort: effortFor(m) }
}

async function secondOpinion(diff, targets) {
  const v = pickVerifier()
  if (!v) {
    console.warn(`⚠ verify=second-opinion: no family in the reviewer pool besides the reviewing ${reviewingFamilies(SEL).join(', ')} — skipped`)
    return { verifier: null, error: 'no other pool family' }
  }
  console.log(`▶ second opinion · ${v.family} (${v.vendor} · ${v.id} · ${v.effort}) on ${targets.length} HIGH/MEDIUM finding(s)`)
  try {
    const { result } = await runModel(v, verifierPrompt(diff, targets, v.vendor), VERDICT_SCHEMA, 'code-review verifier')
    const byIndex = new Map((result?.verdicts || []).map((x) => [Number(x.index), x]))
    targets.forEach((f, i) => {
      const x = byIndex.get(i)
      f.secondOpinion = x
        ? { family: v.family, verdict: x.verdict, evidence: x.evidence }
        : { family: v.family, verdict: 'NO-VERDICT', evidence: 'the verifier returned no verdict for this finding' }
    })
    return { verifier: v }
  } catch (e) {
    // Never drop findings because the verifier broke — they stay, unverified by a second model.
    console.warn(`⚠ second opinion (${v.family}) failed: ${e.message} — findings kept as-is`)
    return { verifier: v, error: e.message }
  }
}

function writeReport(branch, reviewer, { findings, unlocated, disputed }, diffTruncated, verifier) {
  ensureReviewsIgnored()
  // A random suffix keeps two reviews in the same second (any repo) apart in the folder and the log.
  const ts = `${new Date().toISOString().slice(0, 19).replaceAll(':', '-').replace('T', '-')}-${randomBytes(3).toString('hex')}`
  const dir = `reviews/${ts}`
  mkdirSync(dir, { recursive: true })
  const head = sh('git', ['rev-parse', 'HEAD'])
  const item = (f, extra = '') =>
    `- [${f.file || '?'}:${f.line || '?'}] ${String(f.issue).replace(/\r?\n|$/, (end) => ` (id ${f.id})${end}`)}` +
    `${f.quote ? `\n  > ${String(f.quote).split('\n').join('\n  > ')}` : ''}` +
    `${f.suggestion ? `\n  → ${f.suggestion}` : ''}${isFiled(f) ? `\n  Filed: risk ${f.risk}` : ''}${extra}`
  const bySev = (s) =>
    findings
      .filter((f) => f.severity === s)
      .map((f) => item(f, f.secondOpinion ? `\n  ✓ ${f.secondOpinion.family}: ${f.secondOpinion.verdict} — ${f.secondOpinion.evidence}` : ''))
      .join('\n') || '- none'
  const md =
    `Review ID: ${ts}\nReviewer: ${reviewer}\nBranch: ${branch} → ${BASE}\nHEAD: ${head}\n` +
    (SLICE ? `Paths: ${SLICE.join(', ')} (one slice; other slices cover the rest of the diff)\n` : '') +
    `Reviewed against: ${INTENT || '(inferred from diff)'}\n` +
    (VERIFY_RESULT ? `Verify (${VERIFY_RESULT.cmd}): ${VERIFY_RESULT.passed ? 'passed' : 'FAILED'}\n` : '') +
    (verifier ? `Second opinion: ${verifier.family} (${verifier.id})\n` : '') +
    (diffTruncated ? `⚠ Diff exceeded ${DIFF_CAP} chars — only the first ${DIFF_CAP} were inlined.\n` : '') +
    `Findings: ${findings.length} (plus ${disputed.length} disputed, ${unlocated.length} could not be located)\n\n` +
    `## HIGH\n${bySev('high')}\n\n## MEDIUM\n${bySev('medium')}\n\n## LOW / Info\n${bySev('low')}\n` +
    (disputed.length
      ? `\n## Disputed by second opinion\n${disputed
          .map((f) => item(f, `\n  ✖ ${f.secondOpinion.family}: REFUTED — ${f.secondOpinion.evidence}`))
          .join('\n')}\n`
      : '') +
    (unlocated.length
      ? `\n## Could not be located in the code (unverified-quote)\n${unlocated
          .map((f) => item(f, `\n  ? ${f.quoteCheck}`))
          .join('\n')}\n`
      : '')
  writeFileSync(`${dir}/code-review.md`, md)
  sh('ln', ['-sfn', ts, 'reviews/latest'])
  return dir
}
function loggedReview(entries, id) {
  const review = entries.find((e) => e.type === 'review' && e.id === id)
  if (!review) throw new Error(`No logged review matches "${id}"`)
  if (!review.head) throw new Error(`Review ${id} came from an old script copy that did not log head`)
  if (!Array.isArray(review.findingDetails)) throw new Error(`Review ${id} has no identified finding details`)
  return review
}
const headNow = () => sh('git', ['rev-parse', 'HEAD'])
const repoIdentity = () => realpathSync(resolve(sh('git', ['rev-parse', '--git-common-dir'])))
const isAncestor = (a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b]).status === 0
const changedFiles = (a, b) => sh('git', ['diff', '--name-only', '--no-renames', '-z', a, b]).split('\0').filter(Boolean)
// Files changed between two commits, limited to pathspecs that resolve from the top of the work tree.
// Untrimmed, so a leading-space name stays distinct.
function filesBetween(a, b, paths = null) {
  const r = spawnSync('git', ['-C', TOP, 'diff', '--name-only', '--no-renames', '-z', a, b, ...pathspec(paths)],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error || r.status !== 0) throw new Error(`git diff --name-only ${a} ${b}${sliceSuffix(paths)} failed: ${r.error?.message || r.stderr}`)
  return r.stdout.split('\0').filter(Boolean)
}
const isTestFile = (p) => /(^|\/)(test|tests|__tests__|__snapshots__)\//.test(p) || /\.(test|spec)\.[^/]+$|\.snap$/.test(p) || /(^|\/)(vitest|jest|playwright)\.config\.[^/]+$/.test(p)
const cleanPath = (p) => String(p || '').replace(`${TOP}/`, '').replace(/^(?:\.\/|[ab]\/)/, '')
function gradeObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown ${label} key: ${key}`)
}
function gradeText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`)
}
function readGrade(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'))
  gradeObject(value, ['family', 'model', 'vendor', 'effort', 'criteria', 'findings'], 'Grade')
  gradeText(value.family, 'Grade family')
  gradeText(value.model, 'Grade model')
  if (Object.hasOwn(value, 'vendor') && !VENDORS.includes(value.vendor)) throw new Error('Unknown Grade vendor')
  if (Object.hasOwn(value, 'effort')) gradeText(value.effort, 'Grade effort')
  if (!Array.isArray(value.criteria) || !value.criteria.length) throw new Error('Grade criteria must be a nonempty array')
  const ids = new Set()
  for (const criterion of value.criteria) {
    gradeObject(criterion, ['id', 'criterion', 'verdict', 'evidence'], 'criterion')
    for (const key of ['id', 'criterion', 'evidence']) gradeText(criterion[key], `Criterion ${key}`)
    if (!['PASS', 'FAIL'].includes(criterion.verdict)) throw new Error('Criterion verdict must be PASS or FAIL')
    if (ids.has(criterion.id)) throw new Error(`Duplicate criterion id: ${criterion.id}`)
    ids.add(criterion.id)
  }
  if (Object.hasOwn(value, 'findings') && !Array.isArray(value.findings)) throw new Error('Grade findings must be an array')
  for (const finding of value.findings || []) {
    gradeObject(finding, ['severity', 'issue', 'file', 'line', 'evidence', ...SCORE_FIELDS], 'Grade finding')
    if (Object.hasOwn(finding, 'severity') && typeof finding.severity !== 'string') throw new Error('Grade finding severity must be text when supplied')
    gradeText(finding.issue, 'Grade finding issue')
    gradeText(finding.evidence, 'Grade finding evidence')
    if (Object.hasOwn(finding, 'file')) gradeText(finding.file, 'Grade finding file')
    if (Object.hasOwn(finding, 'line') && !(typeof finding.line === 'string' && finding.line.trim()) &&
      !(Number.isSafeInteger(finding.line) && finding.line > 0)) throw new Error('Invalid Grade finding line')
  }
  return value
}
function logGrade(path) {
  requireClean()
  const head = headNow()
  const value = readGrade(path)
  const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  const repoId = repoIdentity()
  const recheckOf = option('--recheck-of')
  const entries = recheckOf ? readLog() : []
  const original = recheckOf ? loggedReview(entries, recheckOf) : null
  if (original) {
    if (original.kind !== 'grade') throw new Error('A recheck must target an original Grade')
    if (original.repoId !== repoId || original.branch !== branch) throw new Error('A recheck must belong to the same repository and branch')
    if (!isAncestor(original.head, head)) throw new Error('Recheck HEAD must descend from the Grade head')
    if (entries.some((e) => e.type === 'review' && e.kind === 'recheck' && e.review === recheckOf))
      throw new Error('Only one recheck per Grade is allowed')
    for (const criterion of value.criteria) {
      const prior = original.criteria?.find((c) => c.id === criterion.id && c.verdict === 'FAIL')
      if (!prior || prior.criterion !== criterion.criterion) throw new Error(`Recheck criterion ${criterion.id} must match an original FAIL`)
    }
  }
  const vendor = value.vendor || vendorOf(value.model) || loadPool().pool?.find((m) => m.family === value.family)?.vendor
  if (!vendor) throw new Error(`Cannot derive Grade vendor from its model id or the pool for ${value.family}; supply vendor`)
  const failed = original ? [] : value.criteria.filter((c) => c.verdict === 'FAIL')
  const findingDetails = [
    ...failed.map((c, i) => ({ id: `c${i + 1}`, criterionId: c.id, criterion: c.criterion, severity: 'high', issue: `FAIL: ${c.criterion}`, evidence: c.evidence, status: 'grade-finding' })),
    ...(value.findings || []).map((f, i) => ({ ...scoreFinding(f, false), id: `${original ? 'r' : 'f'}${failed.length + i + 1}`, status: 'grade-finding' })),
  ]
  const kind = original ? 'recheck' : 'grade'
  const id = `${kind}-${Date.now()}-${randomBytes(3).toString('hex')}`
  const entry = { type: 'review', kind, rubricVersion: RUBRIC_VERSION, id, ts: new Date().toISOString(), head, branch, ...(original && { review: original.id }),
    base: original?.head || BASE, baseSha: original?.head || sh('git', ['merge-base', BASE, head]), repo: repoName(), repoId, copy: COPY_PATH,
    family: value.family, model: value.model, vendor, ...(value.effort && { effort: value.effort }),
    criteria: value.criteria, findings: findingDetails.length, findingDetails }
  requireClean()
  if (headNow() !== head) throw new Error('HEAD changed during Grade logging')
  appendLog(entry)
  console.log(`Review ID: ${id}\n===FINDINGS_JSON===`)
  console.log(JSON.stringify({ schemaVersion: 1, reviewId: id, kind: entry.kind, head, branch, criteria: entry.criteria,
    findings: findingDetails, disputed: [], unverified: [] }, null, 2))
}
function needsFixCheck(files, command) {
  return files.some((p) => isTestFile(p) || matchesAny(p, RISK_PATHS) || /(^|\/)verify(?:[.\/-]|$)/i.test(p) ||
    String(command).split(/[\s'";&|()]+/).some((token) => token.replace(/^\.\//, '') === p))
}
function operatorOnly(reason) {
  const markers = ['CLAUDECODE', 'CODEX_CI', 'CODEX_SANDBOX', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'GROK_AGENT', 'GROK_SESSION_ID']
  if (!String(reason || '').trim() || !process.stderr.isTTY || markers.some((key) => Object.hasOwn(process.env, key)))
    throw new Error('Operator-only action requires a nonempty reason, a real terminal on stderr, and no runtime agent markers')
}
function findingOf(review, id) {
  const finding = review.findingDetails.find((f) => f.id === id)
  if (!finding) throw new Error(`Unknown finding ${id} in review ${review.id}`)
  return finding
}
// A REFUTED counts only from a family that did not review: a family cannot refute its own finding.
function refuted(entries, review, finding, reference) {
  const own = reviewingFamilies(review)
  if (reference === undefined && finding.secondOpinion?.verdict === 'REFUTED' && !own.includes(finding.secondOpinion.family)) return true
  const target = reference === undefined ? { review: review.id, finding: finding.id } : reference
  if (!target || Object.keys(target).some((key) => !['review', 'finding'].includes(key)) || !target.review || !target.finding)
    throw new Error(`Invalid refutedBy reference for ${finding.id}`)
  const prior = entries.find((e) => e.type === 'review' && e.id === target.review && e.branch === review.branch &&
    (target.review === review.id || review.repoId && e.repoId === review.repoId))
  const barred = prior ? [...own, ...reviewingFamilies(prior)] : own
  return !!prior && entries.some((e) => e.type === 'dispute' && e.review === target.review && e.finding === target.finding && e.verdict === 'REFUTED' &&
    !barred.includes(e.verifier))
}
// The reviewing families whose own REFUTED was offered for a finding and does not count.
function selfRefuters(entries, review, finding) {
  const own = reviewingFamilies(review)
  const verdicts = [finding.secondOpinion?.verdict === 'REFUTED' && finding.secondOpinion.family,
    ...entries.filter((e) => e.type === 'dispute' && e.review === review.id && e.finding === finding.id && e.verdict === 'REFUTED').map((e) => e.verifier)]
  return [...new Set(verdicts.filter((family) => family && own.includes(family)))]
}
function validateStatuses(entries, review, statuses) {
  for (const f of review.findingDetails) {
    const status = statuses[f.id]
    const rules = resolutionRules(review, f)
    if (!status && !rules.status) continue
    if (!status || !['fixed', 'rejected'].includes(status.status)) throw new Error(`Finding ${f.id} needs a fixed or rejected status`)
    if (Object.keys(status).some((key) => !['status', 'reason', 'evidence', 'refutedBy'].includes(key)))
      throw new Error(`Unknown status field for ${f.id}; reviewer severity cannot be changed`)
    if (Object.hasOwn(status, 'refutedBy') && !refuted(entries, review, f, status.refutedBy))
      throw new Error(`refutedBy for ${f.id} must reference a REFUTED dispute on the same branch in the same repository`)
    if (review.kind === 'grade' && f.criterionId && status.status === 'fixed') {
      const recheck = entries.find((e) => e.type === 'review' && e.kind === 'recheck' && e.review === review.id)
      const criterion = recheck?.criteria?.find((c) => c.id === f.criterionId)
      if (criterion?.verdict !== 'PASS') throw new Error(`Fixed criterion ${f.id} requires a PASS in the single recheck; otherwise dispute or waive it`)
      status.evidence = criterion.evidence
    }
    if (status.status === 'rejected') {
      if (!String(status.reason || '').trim() || !String(status.evidence || '').trim())
        throw new Error(`Rejection ${f.id} requires a reason and evidence (file:line or test)`)
      const waiver = entries.some((e) => e.type === 'override' && e.action === 'waive' && e.review === review.id && e.finding === f.id && String(e.reason || '').trim())
      if (rules.refutation && !refuted(entries, review, f, status.refutedBy) && !waiver) {
        const self = selfRefuters(entries, review, f)
        throw new Error(`Rejected ${f.id} requires a REFUTED verdict or an operator waiver; when no second reviewer family can ` +
          `give a verdict, the operator waiver is the path: --waive ${review.id} ${f.id} --reason "<why>" from a real terminal` +
          (self.length ? `. The REFUTED from ${self.join(', ')} does not count: a family that reviewed this cannot refute its own finding` : ''))
      }
    }
  }
}
function closeReview(id) {
  requireClean()
  const entries = readLog()
  const review = loggedReview(entries, id)
  if (review.kind === 'fix-check' || review.kind === 'recheck') throw new Error('Close the original review, including its fix-check or recheck statuses')
  const head = headNow()
  if (!isAncestor(review.head, head)) throw new Error('HEAD is neither the reviewed commit nor a descendant')
  const statusPath = option('--status')
  if (!statusPath) throw new Error('--close requires --status <file.json>')
  const statuses = JSON.parse(readFileSync(statusPath, 'utf8'))
  if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) throw new Error('Statuses must be an object keyed by finding id')
  // A sliced review answers for its own paths only; changes outside them belong to other slices.
  const paths = sliceOf(review)
  const files = paths ? filesBetween(review.head, head, paths) : changedFiles(review.head, head)
  const command = option('--test-cmd') || VERIFY_CMD
  const noTests = option('--no-tests')
  if (noTests !== null && !noTests.trim()) throw new Error('--no-tests requires a nonempty reason')
  if (command && noTests !== null) throw new Error('Use a test command or --no-tests, not both')
  if (!command && noTests === null) throw new Error('No test command configured; use --test-cmd or --no-tests "reason"')
  const check = entries.find((e) => e.type === 'review' && e.kind === 'fix-check' && e.review === id)
  const recheck = entries.find((e) => e.type === 'review' && e.kind === 'recheck' && e.review === id)
  if (recheck && !isAncestor(recheck.head, head)) throw new Error('Closing HEAD must include the recheck head')
  if (check && check.head !== head) throw new Error('Fix check head must equal closing HEAD; unresolved work goes to the operator, no third model pass')
  if (needsFixCheck(files, [command, VERIFY_CMD].filter(Boolean).join(' ')) && !check) throw new Error('Fix changes tests, verify scripts or risk paths; run --fix-check first')
  const reviews = [review, ...(recheck ? [recheck] : []), ...(check ? [check] : [])]
  const ids = new Set(reviews.flatMap((r) => r.findingDetails.map((f) => f.id)))
  for (const key of Object.keys(statuses)) if (!ids.has(key)) throw new Error(`Unknown finding status key: ${key}`)
  for (const r of reviews) validateStatuses(entries, r, statuses)
  const fixedFiles = new Set(reviews.flatMap((r) => r.findingDetails.filter((f) => statuses[f.id]?.status === 'fixed').map((f) => cleanPath(f.file))))
  if (review.kind === 'grade' && recheck && review.findingDetails.some((f) => f.criterionId && statuses[f.id]?.status === 'fixed' &&
    recheck.criteria.some((c) => c.id === f.criterionId && c.verdict === 'PASS'))) {
    for (const path of changedFiles(review.head, recheck.head)) fixedFiles.add(path)
  }
  const outOfScope = files.filter((p) => !fixedFiles.has(p) && !isTestFile(p) && !p.startsWith('builds/'))
  let tests = null
  if (command) {
    const r = spawnSync(command, { shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (r.error || r.status !== 0) throw new Error(`Tests failed at HEAD: ${r.error?.message || r.stderr || r.stdout || `exit ${r.status}`}`)
    tests = { cmd: command, passed: true }
  }
  requireClean()
  if (headNow() !== head) throw new Error('HEAD changed while tests ran')
  appendLog({ type: 'close', ts: new Date().toISOString(), review: id, closeHead: head, statuses, outOfScope,
    status: outOfScope.length ? 'partial' : 'complete', tests, ...(noTests !== null && { noTests }), ...(check && { fixCheck: check.id }), ...(recheck && { recheck: recheck.id }) })
  console.log(`✓ Review ${id} closed (${outOfScope.length ? 'partial' : 'complete'}) at ${head}${paths ? ` for paths ${paths.join(', ')}` : ''}`)
}
async function disputeFinding(id, findingId) {
  const entries = readLog()
  const review = loggedReview(entries, id)
  const finding = findingOf(review, findingId)
  const reason = option('--reason')
  const evidence = option('--evidence')
  if (!reason?.trim() || !evidence?.trim()) throw new Error('--dispute requires a reason and evidence')
  if (entries.some((e) => e.type === 'dispute' && e.review === id && e.finding === findingId && hasVerdict(e.verdict)) || hasVerdict(finding.secondOpinion?.verdict))
    throw new Error('One verdict per finding; no back-and-forth')
  const pool = poolOrStop(loadPool())
  SELECTION = { pool }
  SEL = { family: review.family, vendor: review.vendor, families: reviewingFamilies(review) }
  const others = pool.filter((m) => !SEL.families.includes(m.family))
  // An optional local classifier (config "classifier", or a pick that names one) may choose the
  // verifier; otherwise another vendor first (pickVerifier).
  const pickSetting = String(cfg('REVIEW_PICK', 'pick', '')).trim().toLowerCase()
  const command = CLASSIFIER || (pickSetting && !['first', 'rotate'].includes(pickSetting) &&
    !pool.some((m) => m.family === pickSetting) && onPath(pickSetting) ? pickSetting : '')
  const answer = command && others.length
    ? askClassifier(command, others, diffStats() || { files: [], filesChanged: 0, linesAdded: 0, linesRemoved: 0, languages: {}, riskFiles: [] })
    : null
  const picked = answer && !answer.error && answer.confidence >= CLASSIFIER_ACT && others.find((m) => m.family === answer.choice)
  const verifier = picked ? { ...picked, effort: effortFor(picked) } : pickVerifier()
  let verdict = 'NO-VERDICT'
  let verdictEvidence = 'No second reviewer family can give a verdict, so the finding stands. The operator waiver is the ' +
    `path: --waive ${id} ${findingId} --reason "<why>" from a real terminal. A family that reviewed this ` +
    `(${SEL.families.join(', ')}) cannot judge its own finding`
  const temp = mkdtempSync(join(tmpdir(), 'review-dispute-'))
  const cwd = process.cwd()
  try {
    if (verifier) {
      const baseSha = review.kind === 'fix-check'
        ? loggedReview(entries, review.review).head
        : review.baseSha || sh('git', ['merge-base', review.base || BASE, review.head])
      const range = `${baseSha}${review.kind === 'fix-check' ? '..' : '...'}${review.head}`
      const paths = sliceOf(review)
      const diff = sh('git', [...(paths ? ['-C', TOP] : []), 'diff', range, ...pathspec(paths)])
      const snapshot = join(temp, 'snapshot')
      sh('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', TOP, snapshot])
      process.chdir(snapshot)
      sh('git', ['checkout', '--quiet', '--detach', review.head])
      const prompt = `Judge this dispute against the reviewed snapshot ${review.head}, never the current branch.\n` +
        `Reason: ${reason}\nEvidence: ${evidence}\n` +
        (finding.criterion ? `Grade criterion: ${finding.criterion}\nCriterion evidence: ${finding.evidence || ''}\n` : '') +
        verifierPrompt(diff, [finding], verifier.vendor, `${range}${sliceSuffix(paths)}`)
      const { result } = await runModel(verifier, prompt, VERDICT_SCHEMA, 'code-review dispute verifier')
      const answer = result?.verdicts?.find((v) => v.index === 0)
      if (answer && ['CONFIRMED', 'REFUTED'].includes(answer.verdict) && String(answer.evidence || '').trim()) {
        verdict = answer.verdict
        verdictEvidence = answer.evidence
      } else verdictEvidence = 'The verifier returned no valid verdict; finding stands'
    }
  } catch (e) {
    verdictEvidence = `Verifier failed: ${e.message}; finding stands`
  } finally {
    process.chdir(cwd)
    rmSync(temp, { recursive: true, force: true })
  }
  appendLog({ type: 'dispute', ts: new Date().toISOString(), review: id, finding: findingId, head: review.head,
    verdict, reason, evidence, verdictEvidence, family: review.family, verifier: verifier?.family || null, ...classifierRecord(command, answer) })
  console.log(`${verdict}: ${verdictEvidence}`)
}
async function fixCheck(id) {
  requireClean()
  const entries = readLog()
  const original = loggedReview(entries, id)
  if (original.kind === 'fix-check' || original.kind === 'recheck') throw new Error('No third model pass; fix checks target the original review')
  if (entries.some((e) => e.type === 'review' && e.kind === 'fix-check' && e.review === id))
    throw new Error('One fix check per review; unresolved findings go to the operator, no third model pass')
  const head = headNow()
  if (!isAncestor(original.head, head)) throw new Error('HEAD is neither the reviewed commit nor a descendant')
  // A sliced review's fix check reviews only the fix diff inside its paths.
  SLICE = sliceOf(original)
  const diff = sh('git', [...(SLICE ? ['-C', TOP] : []), 'diff', `${original.head}..${head}`, ...pathspec(SLICE)])
  if (!diff) throw new Error('No fix diff to check')
  DIFF_BASE = original.head
  const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  CONTEXT = reviewContext(branch)
  SELECTION = selectReviewer(diffStats(`${original.head}..${head}`, SLICE))
  SEL = SELECTION.sel
  if (SEL.team) throw new Error('A fix check requires one reviewer family, not the multi-agent team')
  const { result } = await runModel(SEL, `Fix check: review only this fix diff, not the original branch diff.\n${reviewPrompt(diff)}`, SCHEMA, 'fix-check reviewer')
  const scored = await scoredFindings(result?.findings || [], SEL)
  const findingDetails = scored.findings.map((f, i) => {
    const problem = quoteProblem(f)
    return { ...f, id: `x${i + 1}`, status: problem ? 'unverified-quote' : 'verified-quote', ...(problem && { quoteCheck: problem }) }
  })
  requireClean()
  if (headNow() !== head) throw new Error('HEAD changed during fix check')
  const checkId = `fix-${Date.now()}-${randomBytes(3).toString('hex')}`
  appendLog({ type: 'review', kind: 'fix-check', rubricVersion: RUBRIC_VERSION, rescored: scored.rescored, id: checkId, review: id, ts: new Date().toISOString(), head, branch,
    repo: repoName(), repoId: repoIdentity(), base: original.head, baseSha: original.head, family: SEL.family, model: SEL.id, vendor: SEL.vendor, copy: COPY_PATH,
    ...(SLICE && { paths: SLICE }), findings: findingDetails.length, findingDetails })
  console.log(`✓ Fix check ${checkId} recorded at ${head}: ${findingDetails.length} finding(s)`)
}
function waiveFinding(id, findingId) {
  const reason = option('--reason')
  operatorOnly(reason)
  const review = loggedReview(readLog(), id)
  findingOf(review, findingId)
  appendLog({ type: 'override', action: 'waive', ts: new Date().toISOString(), review: id, finding: findingId, reason })
  console.log(`✓ Waiver recorded for ${id}/${findingId}: ${reason}`)
}
function closeSummary(entries, close, head) {
  const { review, lines } = closeLines(entries, close, head)
  lines.push('Deferred findings', ...deferredLines(entries, review))
  if (close.noTests) lines.push(`No tests: ${close.noTests}`)
  return lines.join('\n')
}
// One summary for the slices that cover HEAD together, then the branch-wide deferred findings.
function slicedSummary(entries, { slices, baseSha, closeHead }, head) {
  const lines = [`Sliced review: ${slices.length} slice(s) together cover every file changed from ${baseSha} to ${closeHead}`]
  slices.forEach(({ close, paths }, i) => {
    lines.push(`Slice ${i + 1} of ${slices.length}: ${paths.join(', ')}`, ...closeLines(entries, close, head).lines)
    if (close.noTests) lines.push(`No tests: ${close.noTests}`)
  })
  lines.push('Deferred findings', ...deferredLines(entries, slices[0].review))
  return lines.join('\n')
}
function closeLines(entries, close, head) {
  const review = loggedReview(entries, close.review)
  const check = close.fixCheck && loggedReview(entries, close.fixCheck)
  const recheck = close.recheck && loggedReview(entries, close.recheck)
  const findings = [review, ...(recheck ? [recheck] : []), ...(check ? [check] : [])].flatMap((r) => r.findingDetails.map((f) => ({ ...f, review: r.id, owner: r })))
  const lines = [`Reviewer: ${review.family} (${review.model})`, `Review: ${review.id}`, `HEAD: ${head}`,
    `Counts: ${findings.length} findings; ${Object.values(close.statuses).filter((s) => s.status === 'fixed').length} fixed; ${Object.values(close.statuses).filter((s) => s.status === 'rejected').length} rejected`]
  for (const f of findings) {
    const status = close.statuses[f.id]
    const waiver = entries.find((e) => e.type === 'override' && e.action === 'waive' && e.review === f.review && e.finding === f.id)
    if (resolutionRules(f.owner, f).refutation && (status?.status === 'rejected' || waiver))
      lines.push(`${f.id} ${f.severity.toUpperCase()} ${f.issue}: ${status?.reason || ''}${waiver ? `; waived: ${waiver.reason}` : ''}`)
    if (f.status === 'unverified-quote') lines.push(`Carried unlocated ${f.id} ${f.severity.toUpperCase()} ${f.issue}: ${f.quoteCheck}`)
  }
  return { review, lines }
}
function deferredLines(entries, review) {
  const deferred = entries.filter((r) => r.type === 'review' && r.repoId === review.repoId && r.branch === review.branch)
    .flatMap((r) => deferredFindings(entries, r).map(deferredLine))
  return deferred.length ? deferred : ['none']
}
function deferredLine(finding) {
  return `${finding.id} risk ${finding.risk} ${finding.severity.toUpperCase()} ${finding.file || '?'}:${finding.line || '?'} — ${finding.issue}; Trigger: ${finding.trigger || 'trigger not recorded'}`
}
function deferredFindings(entries, review) {
  const close = entries.filter((e) => e.type === 'close' && (e.review === review.id || e.fixCheck === review.id || e.recheck === review.id)).at(-1)
  return (review.findingDetails || []).filter((f) => isFiled(f) && close?.statuses?.[f.id]?.status !== 'fixed')
}
function printDeferred() {
  const entries = readLog(), repoId = args.includes('--all') ? null : repoIdentity()
  const reviews = entries.filter((e) => e.type === 'review' && (!repoId || e.repoId === repoId))
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
  console.log('Deferred findings')
  for (const review of reviews) {
    for (const finding of deferredFindings(entries, review))
      console.log(`${review.id} ${review.ts || '(date unknown)'} ${deferredLine(finding)}`)
  }
}
function calibrate() {
  const at = args.indexOf('--calibrate'), candidate = args[at + 1]
  const path = candidate && !candidate.startsWith('--') ? candidate : join(dirname(COPY_PATH), 'calibration.md')
  const text = readFileSync(path, 'utf8')
  const versions = [...text.matchAll(/^Rubric version:[ \t]*([^\s]+)[ \t]*$/gm)]
  if (versions.length !== 1 || versions[0][1] !== RUBRIC_VERSION) throw new Error(`Calibration rubric version must be ${RUBRIC_VERSION}`)
  const rows = text.split('\n').filter((line) => /^\|\s*\d+\s*\|/.test(line))
  if (!rows.length) throw new Error('Calibration has no finding rows')
  let failed = false
  for (const row of rows) {
    const [id, issue, likelihood, impact, protectedBug, risk, expected] = row.split('|').slice(1).map((cell) => cell.trim())
    const f = { likelihood: Number(likelihood), impact: Number(impact), protected: protectedBug === 'yes' ? true : protectedBug === 'no' ? false : null, trigger: issue }
    const band = validScores(f) ? derivedSeverity(f).toUpperCase() : 'INVALID'
    const matches = band === expected && Number(risk) === f.likelihood * f.impact
    console.log(`${id}: derived ${band}, expected ${expected}${matches ? '' : ' — MISMATCH'}`)
    if (!matches) failed = true
  }
  if (failed) throw new Error('Calibration mismatch')
}
const fullObjectId = (sha) => typeof sha === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)
const zeroObjectId = (sha) => fullObjectId(sha) && /^0+$/.test(sha)
const commitsIn = (range) => sh('git', ['rev-list', '--reverse', '--topo-order', ...range]).split('\n').filter(Boolean)
function commitPaths(commit) {
  const result = spawnSync('git', ['diff-tree', '--root', '-r', '-m', '--no-commit-id', '--name-only', '--no-renames', '-z', commit], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr)
  return result.stdout.split('\0').filter(Boolean)
}
function completeCloses(entries, tip) {
  return entries.filter((e) => {
    if (e.type !== 'close' || e.status !== 'complete' || !fullObjectId(e.closeHead)) return false
    // The log is global: commits from other repositories need not exist here.
    const object = spawnSync('git', ['cat-file', '-e', `${e.closeHead}^{commit}`], { encoding: 'utf8' })
    if (object.error) throw object.error
    if (object.status !== 0) return false
    const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', e.closeHead, tip], { encoding: 'utf8' })
    if (ancestry.error || ![0, 1].includes(ancestry.status))
      throw new Error(ancestry.error?.message || ancestry.stderr || 'git merge-base failed')
    return ancestry.status === 0
  }).reverse().sort((a, b) => Number(b.closeHead === tip) - Number(a.closeHead === tip))
}
const buildsOnlySince = (closeHead, tip) => closeHead === tip || commitsIn([`${closeHead}..${tip}`])
  .every((commit) => commitPaths(commit).every((path) => path.startsWith('builds/')))
// One unsliced close that covers the tip. A sliced close covers only its paths, so it never counts here.
function coveringClose(entries, tip, reviewOnly = false) {
  return completeCloses(entries, tip).find((close) => {
    const review = loggedReview(entries, close.review)
    if (sliceOf(review)) return false
    if (reviewOnly && review.kind !== 'review') return false
    return buildsOnlySince(close.closeHead, tip)
  })
}
// Sliced reviews cover a tip together: complete closes of sliced reviews with one repoId, branch, baseSha
// and closeHead (the tip, or an ancestor followed only by builds/ commits) whose paths cover every file
// in `git diff <baseSha> <closeHead>`. Slices may overlap. A riskPaths file, and every file when the
// pushed commits touch riskPaths, counts only in a slice of kind review.
// Returns null when no sliced close applies, else the covering group or the closest one's uncovered files.
function slicedCover(entries, tip, risk = false) {
  const groups = new Map(), eligible = new Map()
  for (const close of completeCloses(entries, tip)) {
    const review = loggedReview(entries, close.review), paths = sliceOf(review)
    if (!paths || !fullObjectId(review.baseSha) || !review.repoId || !review.branch) continue
    if (!eligible.has(close.closeHead)) eligible.set(close.closeHead, buildsOnlySince(close.closeHead, tip))
    if (!eligible.get(close.closeHead)) continue
    const key = JSON.stringify([review.repoId, review.branch, review.baseSha, close.closeHead])
    if (!groups.has(key)) groups.set(key, { baseSha: review.baseSha, closeHead: close.closeHead, slices: [] })
    const group = groups.get(key)
    // completeCloses lists the latest close first; one close per review.
    if (!group.slices.some((s) => s.review.id === review.id)) group.slices.push({ close, review, paths })
  }
  let closest = null
  for (const group of groups.values()) {
    for (const slice of group.slices) slice.files = new Set(filesBetween(group.baseSha, group.closeHead, slice.paths))
    const uncovered = filesBetween(group.baseSha, group.closeHead).filter((file) => !group.slices.some((s) =>
      s.files.has(file) && (s.review.kind === 'review' || (!risk && !matchesAny(file, RISK_PATHS)))))
    group.slices.sort((a, b) => a.paths.join('\n').localeCompare(b.paths.join('\n')))
    if (!uncovered.length) return { ...group, covered: true, uncovered }
    if (!closest || uncovered.length < closest.uncovered.length) closest = { ...group, covered: false, uncovered }
  }
  return closest
}
function uncoveredNote(sliced) {
  if (!sliced || sliced.covered) return ''
  const shown = sliced.uncovered.slice(0, 20).join(', ')
  const more = sliced.uncovered.length > 20 ? ` and ${sliced.uncovered.length - 20} more` : ''
  return `; the complete slice closes at ${sliced.closeHead} leave ${sliced.uncovered.length} file(s) uncovered: ${shown}${more}` +
    ' — review and close them as another slice (REVIEW_PATHS) at the same HEAD'
}
function legacyNote(entries) {
  return entries.some((e) => e.type === 'review' && !e.head && e.repo === repoName())
    ? '; found a review from an old script copy that did not log head' : ''
}
function printSummary() {
  const entries = readLog()
  const head = headNow()
  const close = coveringClose(entries, head)
  if (close) return console.log(closeSummary(entries, close, head))
  const sliced = slicedCover(entries, head)
  if (!sliced?.covered) throw new Error(`No complete close covers HEAD${legacyNote(entries)}${uncoveredNote(sliced)}`)
  console.log(slicedSummary(entries, sliced, head))
}
function pushRefs(input) {
  const lines = input.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((line) => {
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 4 || !fullObjectId(fields[1]) || !fullObjectId(fields[3]))
      throw new Error(`Malformed pre-push ref line: ${line}`)
    const [localRef, localSha, remoteRef, remoteSha] = fields
    const format = spawnSync('git', ['check-ref-format', remoteRef], { encoding: 'utf8' })
    if (format.error) throw format.error
    if (format.status !== 0) throw new Error(`Malformed pre-push ref line: ${line}`)
    return { localRef, localSha, remoteRef, remoteSha }
  })
}
const exemptRef = (ref) => zeroObjectId(ref.localSha) || ref.remoteRef.startsWith('refs/tags/')
const pushedRange = (ref) => zeroObjectId(ref.remoteSha) ? [ref.localSha, '--not', '--remotes'] : [`${ref.remoteSha}..${ref.localSha}`]
function pushGate() {
  let input = '', refs = [], entries = [], failure
  const summaries = [], uncovered = []
  try {
    input = readFileSync(0, 'utf8')
    refs = pushRefs(input)
    if (gateConfigError) throw gateConfigError
    const checked = refs.filter((ref) => !exemptRef(ref))
    if (checked.length) {
      try { entries = readLog({ strict: true }) }
      catch (e) {
        if (!existsSync(LOG_PATH)) uncovered.push(...checked)
        throw e
      }
    }
    for (const ref of checked) {
      try {
        const tip = sh('git', ['rev-parse', '--verify', `${ref.localSha}^{commit}`])
        if (tip !== ref.localSha) throw new Error(`Pushed tip is not a full commit: ${ref.localSha}`)
        const risk = commitsIn(pushedRange(ref)).some((commit) => commitPaths(commit).some((path) => matchesAny(path, RISK_PATHS)))
        const close = coveringClose(entries, tip, risk)
        const sliced = close ? null : slicedCover(entries, tip, risk)
        if (!close && !sliced?.covered) {
          uncovered.push(ref)
          throw new Error(`No complete ${risk ? 'code-review ' : ''}close covers tip ${tip}${legacyNote(entries)}${risk ? '; pushed commits touch riskPaths' : ''}${uncoveredNote(sliced)}`)
        }
        summaries.push(close ? closeSummary(entries, close, tip) : slicedSummary(entries, sliced, tip))
      } catch (e) { failure ||= e.message }
    }
  } catch (e) { failure = e.message }

  const reason = process.env.REVIEW_GATE_OVERRIDE
  let refused = false
  if (String(reason || '').trim()) {
    try { operatorOnly(reason) }
    catch { refused = true }
    if (!refused) {
      try {
        appendLog({ type: 'override', action: 'push', ts: new Date().toISOString(), reason, refs,
          tips: refs.map((ref) => ref.localSha), repoId: repoIdentity(), ...(failure && { gateError: failure, input }) })
        return
      } catch (e) { failure = e.message }
    }
  }
  if (refused && !failure) {
    console.error('override refused')
    process.exitCode = 1
    return
  }
  if (failure) {
    console.error(`Push blocked: ${failure}`)
    for (const ref of uncovered) {
      console.error(`Uncovered tip: ${ref.localSha} (${ref.remoteRef})`)
      try {
        const last = completeCloses(entries, ref.localSha)[0]
        const commits = commitsIn(last ? [`${last.closeHead}..${ref.localSha}`] : pushedRange(ref))
        console.error(`First commits ${last ? `after complete close ${last.closeHead}` : 'without a complete close'}:`)
        for (const commit of commits.slice(0, 5)) console.error(sh('git', ['show', '-s', '--format=%H %s', commit]))
        if (!commits.length) console.error(ref.localSha)
      } catch (e) { console.error(`Could not list commits: ${e.message}`) }
    }
    console.error('Run /code-review and close the review before pushing.')
    if (refused) console.error('override refused')
    process.exitCode = 1
    return
  }
  for (const summary of summaries) console.error(summary)
}
// ── main ─────────────────────────────────────────────────────────────────────
;(async function main() {
  if (args.includes('--rubric')) return console.log(`Rubric version: ${RUBRIC_VERSION}\n${RUBRIC}`)
  if (args.includes('--calibrate')) return calibrate()
  if (args.includes('--gate')) return pushGate()
  if (args.includes('--log-grade')) return logGrade(option('--log-grade'))
  if (args.includes('--recheck-of')) throw new Error('--recheck-of requires --log-grade <verdict.json>')
  if (args.includes('--close')) return closeReview(option('--close'))
  if (args.includes('--dispute')) return disputeFinding(option('--dispute'), args[args.indexOf('--dispute') + 2])
  if (args.includes('--waive')) return waiveFinding(option('--waive'), args[args.indexOf('--waive') + 2])
  if (args.includes('--summary')) return printSummary()
  if (args.includes('--deferred')) return printDeferred()
  if (args.includes('--fix-check')) return fixCheck(option('--fix-check'))
  const { branch, diff, head: reviewedHead, baseSha } = getDiff()
  CONTEXT = reviewContext(branch)
  if (!diff) {
    console.log(`Nothing to review — no diff against ${BASE}.`)
    process.exit(0)
  }
  const stats = diffStats(undefined, SLICE)
  SELECTION = selectReviewer(stats)
  SEL = SELECTION.sel
  const reviewer =
    SEL.vendor === 'claude'
      ? SEL.team
        ? `claude-team(${SEL.id})`
        : `claude-solo(${SEL.id})`
      : `${SEL.vendor}-${SEL.id}-${SEL.effort}`
  for (const n of SELECTION.notes) console.log(n)
  console.log(`▶ reviewer · ${SEL.family} (${SEL.vendor} · ${SEL.id} · ${SEL.effort}) — ${SELECTION.why}`)
  console.log(`▶ review · ${reviewer} · ${branch} vs ${BASE}${SLICE ? ` · paths ${SLICE.join(', ')}` : ''} · single pass (no fix, no loop)\n`)

  // A silently clipped diff looks identical to a fully-reviewed one — say so in the console,
  // the report, and the JSON, not just inside the prompt where only the model sees it.
  const diffTruncated = diff.length > DIFF_CAP
  if (diffTruncated)
    console.warn(
      `⚠ Diff is ${diff.length} chars — only the first ${DIFF_CAP} were inlined in the prompt.\n` +
        `  The reviewer was told to open files for the rest; findings may under-cover this branch.\n` +
        (SLICE ? '' : sliceHint(stats)),
    )

  VERIFY_RESULT = runVerify()

  const started = Date.now()
  const scored = await scoredFindings(await review(diff), SEL)
  const raw = scored.findings
  const durationMs = Date.now() - started
  // A finding that can't point at real code is not a finding — list it apart, never drop it.
  const located = []
  const unlocated = []
  for (const f of raw) {
    const problem = quoteProblem(f)
    if (problem) unlocated.push({ ...f, status: 'unverified-quote', quoteCheck: problem })
    else located.push({ ...f, status: 'verified-quote' })
  }
  if (unlocated.length)
    console.warn(`⚠ ${unlocated.length} finding(s) quote code that isn't at the cited place — listed under "could not be located"`)

  let opinion = { verifier: null }
  if (SECOND_OPINION) {
    const targets = located.filter((f) => !isFiled(f) && !(isLegacy(f) && f.severity === 'low'))
    if (targets.length) opinion = await secondOpinion(diff, targets)
  }
  const disputed = located.filter((f) => f.secondOpinion?.verdict === 'REFUTED').map((f) => ({ ...f, status: 'disputed' }))
  const findings = located.filter((f) => f.secondOpinion?.verdict !== 'REFUTED')

  requireClean()
  if (headNow() !== reviewedHead) throw new Error('HEAD changed during review')
  const findingDetails = [...findings, ...disputed, ...unlocated]
  findingDetails.forEach((finding, i) => { finding.id = `f${i + 1}` })
  const dir = writeReport(branch, reviewer, { findings, unlocated, disputed }, diffTruncated, opinion.verifier)
  const reviewId = basename(dir)
  appendLog({
    type: 'review',
    kind: 'review',
    rubricVersion: RUBRIC_VERSION,
    rescored: scored.rescored,
    head: reviewedHead,
    branch,
    remote: sh('git', ['remote', 'get-url', 'origin'], { allowFailure: true }) || null,
    copy: COPY_PATH,
    findingDetails,
    id: reviewId,
    ts: new Date().toISOString(),
    repo: repoName(),
    base: BASE,
    baseSha,
    repoId: repoIdentity(),
    ...(SLICE && { paths: SLICE }),
    family: SEL.family,
    families: reviewingFamilies(SEL),
    model: SEL.id,
    ...(SEL.modelUsed && { modelUsed: SEL.modelUsed }),
    effort: SEL.effort,
    vendor: SEL.vendor,
    findings: findings.length,
    raw: raw.length,
    unverified: unlocated.length,
    disputed: disputed.length,
    ...(SELECTION.classifier && classifierRecord(SELECTION.classifier.command, SELECTION.classifier.answer)),
    ...(SECOND_OPINION && {
      secondOpinion: opinion.verifier
        ? { family: opinion.verifier.family, model: opinion.verifier.id, ...(opinion.error && { error: opinion.error }) }
        : { error: opinion.error || 'no HIGH/MEDIUM findings' },
    }),
    durationMs,
    dir,
  })
  const counts = ['high', 'medium', 'low']
    .map((s) => `${findings.filter((f) => f.severity === s).length} ${s}`)
    .join(', ')
  console.log(
    `\n✓ Review complete — ${findings.length} finding(s) (${counts}); ${disputed.length} disputed, ` +
      `${unlocated.length} could not be located. Report: ${dir}/code-review.md`,
  )
  const head = sh('git', ['rev-parse', 'HEAD'])
  console.log(`Review ID: ${reviewId}`)
  console.log('\n===FINDINGS_JSON===')
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      reviewId,
      reviewer,
      family: SEL.family,
      base: BASE,
      branch,
      head,
      ...(SLICE && { paths: SLICE }),
      reportPath: `${dir}/code-review.md`,
      diffTruncated,
      verify: VERIFY_RESULT && { cmd: VERIFY_RESULT.cmd, passed: VERIFY_RESULT.passed },
      secondOpinion: opinion.verifier && { family: opinion.verifier.family, model: opinion.verifier.id },
      findings: findings.map(publicFinding),
      disputed: disputed.map(publicFinding),
      unverified: unlocated.map(publicFinding),
    }, null, 2),
  )
  process.exit(0)
})().catch((e) => die(e.message))
