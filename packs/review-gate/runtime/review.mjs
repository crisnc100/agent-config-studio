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
import { spawn as spawnFile, spawnSync as spawnFileSync } from 'node:child_process'
import {
  accessSync,
  appendFileSync,
  constants,
  cpSync,
  existsSync,
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { homedir, tmpdir, userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const COPY_PATH = fileURLToPath(import.meta.url)
console.error(`review.mjs · ${COPY_PATH} · head-aware copy`)

// Every helper named by its bare name (git, model-id, codex, claude, grok, ln, a classifier) runs from an
// absolute PATH entry only, so a `.` or empty entry never picks a repository's ./git or ./model-id. This is
// tools/ask-model.mjs which(), copied to keep the runtime standalone; with PATH unset, the spawn's own
// default. A helper that is not found fails the way a missing command does (ENOENT). Paths and shell
// strings pass through.
const isExecutable = (p) => {
  try {
    accessSync(p, constants.X_OK)
    return statSync(p).isFile()
  } catch {
    return false
  }
}
function which(name) {
  for (const dir of String(process.env.PATH ?? '/usr/bin:/bin').split(':'))
    if (isAbsolute(dir) && isExecutable(join(dir, name))) return join(dir, name)
  return null
}
const notFound = (name) =>
  Object.assign(new Error(`spawnSync ${name} ENOENT`), { errno: -2, code: 'ENOENT', syscall: `spawnSync ${name}`, path: name })
function spawnSync(command, args, options) {
  if ((Array.isArray(args) ? options : args)?.shell || String(command).includes('/')) return spawnFileSync(command, args, options)
  const bin = which(command)
  if (bin) return spawnFileSync(bin, args, options)
  return { error: notFound(command), status: null, signal: null, output: null, pid: 0, stdout: undefined, stderr: undefined }
}
function spawn(command, args, options) {
  const bin = String(command).includes('/') ? command : which(command)
  if (!bin) throw notFound(command)
  return spawnFile(bin, args, options)
}
const args = process.argv.slice(2)
const option = (flag) => {
  const at = args.indexOf(flag)
  if (at === -1) return null
  const value = args[at + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}
// Eval mode (REVIEW_EVAL, which --eval sets on each case review it runs): no security pass, verify command or second
// opinion; the review logs to its own folder, and nothing that reads or writes the review gate's own records runs.
const EVAL_MODE = !!String(process.env.REVIEW_EVAL ?? '').trim()
const EVAL_REFUSED = ['--gate', '--close', '--summary', '--tier-json', '--deferred', '--fix-check', '--dispute', '--waive', '--log-grade',
  '--recheck-of', '--log-outcome', '--slices', '--eval', '--security-worker', '--calibrate', '--noise-report', '--security-only', '--security-findings']
// Git variables that move the repo, work tree or index away from the working directory: eval mode refuses them.
const GIT_LOCATION_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM']
// The shadow reviewers and pickers were removed: their commands are unknown flags, a plain error and never a review.
const REMOVED_FLAGS = ['--shadow-run', '--shadow-report', '--pick-shadow-run', '--pick-report']
const removedFlag = args.find((a) => REMOVED_FLAGS.includes(a))
if (removedFlag) stop(`unknown flag ${removedFlag}`)
// --eval takes only its own flags: with --gate (or any other command) it would run instead of that command.
const EVAL_FLAGS = ['--eval', '--family', '--cases', '--timeout', '--repeat', '--yes']
if (args.includes('--eval')) {
  const others = args.filter((a) => a.startsWith('--') && !EVAL_FLAGS.includes(a))
  if (others.length) stop(`--eval runs alone: it cannot be combined with ${others.join(', ')} (its flags: ${EVAL_FLAGS.slice(1).join(', ')}).`)
}

// --security-only takes only --plan and an intent: with --close, --gate or any other command, that command would run.
if (args.includes('--security-only')) {
  const others = args.filter((a, i) => a.startsWith('--') && !['--security-only', '--plan'].includes(a) && args[i - 1] !== '--plan')
  if (others.length) stop(`--security-only runs alone: it cannot be combined with ${others.join(', ')} (it takes --plan and an intent).`)
}

// ── User-configurable defaults (change the model WITHOUT editing this script) ──
// Resolution: env var > project .claude/review-config.json > ~/.agent-config-studio/review-gate/config.json
// > the older ~/.claude/review-config.json > built-in.
// Edit that one small JSON file to switch reviewer/model/effort — see review-config.example.json.
// The repo file can come from the repository itself (committed, or added by a branch you check out), so
// the keys that run a command or reach git as an argument, and coverageExempt and coverageExemptDefaults (they would
// let a branch exempt its own code from review), count there only while git doesn't track it and no symlink leads to it: a clone or checkout only
// ever adds tracked files and links. Env and the home configs always count.
let gateConfigError
const COMMAND_KEYS = ['verifyCmd', 'classifier', 'base']
const OWN_FILE_KEYS = [...COMMAND_KEYS, 'coverageExempt', 'coverageExemptDefaults', 'grokMcpAllow']
// Set when the repo file failed that check: its `pick` may name a family, never a command to run.
let REPO_PICK_UNTRUSTED = false
const sameFile = (a, b) => {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}
// The path as named must have no symlink on it: a tracked `.claude -> cfg` link serves a tracked file under a
// name git does not track. The real path, spelled as the disk stores it (a tracked `.CLAUDE/` answers for
// `.claude/` on a case-insensitive disk), and every folder above it in the work tree must not be tracked either.
function repoFileIsOwn(p, homes) {
  if (homes.some((home) => sameFile(p, home))) return true // a dotfiles repo at HOME: this is the home config
  const parts = p.split(sep)
  try {
    if (parts.some((_, i) => lstatSync(parts.slice(0, i + 1).join(sep)).isSymbolicLink())) return false
  } catch {
    return false
  }
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', p], { stdio: 'ignore' })
  if (tracked.error || tracked.status !== 1) return false // 1: inside a work tree, and git doesn't track it
  let rel, top
  try {
    const t = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
    if (t.error || t.status !== 0) return false
    top = realpathSync.native(t.stdout.trim())
    rel = relative(top, realpathSync.native(p))
  } catch {
    return false
  }
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return false
  const steps = rel.split(sep)
  const real = steps.map((_, i) => steps.slice(0, i + 1).join('/'))
  const listed = spawnSync('git', ['-C', top, 'ls-files', '-z', '--full-name', '--', ...real.map((r) => `:(literal)${r}`)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (listed.error || listed.status !== 0) return false
  const entries = new Set(listed.stdout.split('\0'))
  return !real.some((r) => entries.has(r))
}
function withoutRepoCommands(config, p, homes) {
  // A key that is present counts, whatever its value: a blank verifyCmd still runs a shell that passes.
  const keys = OWN_FILE_KEYS.filter((k) => Object.hasOwn(config, k))
  const pick = String(config.pick ?? '').trim().toLowerCase()
  const pickMayRun = pick !== '' && pick !== 'first' && pick !== 'rotate'
  const hasMerge = Object.hasOwn(config, 'merge')
  const hasSecurity = Object.hasOwn(config, 'security')
  if ((!keys.length && !pickMayRun && !hasMerge && !hasSecurity) || repoFileIsOwn(p, homes)) return config
  if (hasMerge) config.merge = stricterMerge(config.merge, homeMerge(homes), p)
  if (hasSecurity) config.security = stricterSecurity(config.security, homeKey(homes, 'security'), p)
  for (const k of keys) delete config[k]
  REPO_PICK_UNTRUSTED = pickMayRun
  if (keys.length && !args.includes('--gate'))
    console.warn(`⚠ Ignoring ${keys.join(', ')} in ${p}: git tracks it (or a symlink leads to it), so the repository can set it. ` +
      `Put them in ~/.agent-config-studio/review-gate/config.json or the environment, or keep the file untracked.`)
  return config
}
// merge (the merge tier's policy, report only): off > strict > standard > always, strictest first. A tracked repo
// config may only make the policy stricter than the home config's, raise the threshold and add alwaysHuman globs;
// its classifier is ignored like `classifier`. A repo config without `merge` leaves the home config's in force.
const MERGE_POLICIES = ['off', 'strict', 'standard', 'always']
const MERGE_THRESHOLD = 0.8
// merge.mjs's keys: onHuman (comment | none) a tracked repo config may set; humanComment never; requireChecks only to
// true and allowBehind only to false (tighter).
const ON_HUMAN = ['comment', 'none']
const HUMAN_COMMENT = 'Needs human approval before merging.'
function mergeSettings(raw) {
  const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const policy = String(m.policy ?? 'off').trim().toLowerCase()
  if (!MERGE_POLICIES.includes(policy) && !args.includes('--gate'))
    console.warn(`⚠ Unknown merge.policy ${JSON.stringify(m.policy)}; using "off" (${MERGE_POLICIES.join(' | ')})`)
  const threshold = Number(m.threshold)
  return {
    policy: MERGE_POLICIES.includes(policy) ? policy : 'off',
    classifier: typeof m.classifier === 'string' && m.classifier.trim() ? m.classifier.trim() : null,
    threshold: m.threshold != null && threshold > 0 && threshold <= 1 ? threshold : MERGE_THRESHOLD,
    alwaysHuman: Array.isArray(m.alwaysHuman) ? m.alwaysHuman.filter((g) => typeof g === 'string' && g.trim()) : [],
    onHuman: ON_HUMAN.includes(String(m.onHuman ?? '').trim().toLowerCase()) ? String(m.onHuman).trim().toLowerCase() : 'comment',
    humanComment: typeof m.humanComment === 'string' && m.humanComment.trim() ? m.humanComment.trim() : HUMAN_COMMENT,
    requireChecks: m.requireChecks !== false,
    allowBehind: m.allowBehind === true,
  }
}
function homeMerge(homes) {
  return homeKey(homes, 'merge')
}
// The home config in force: the primary one when it exists, else the older ~/.claude one. Its security is the floor.
const homeSource = (homes) => homes.find((p) => existsSync(p)) ?? null
function homeKey(homes, key) {
  for (const p of homes) {
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'))[key]
    } catch { return undefined }
  }
  return undefined
}
// security (the security review pass): run "off" (the default) | "required" | "always", and timeoutMs. A config the
// repository can set (a tracked repo file) or an agent can point at (REVIEW_CONFIG) may only raise run above the home
// config's, and never sets timeoutMs; REVIEW_SECURITY may only raise it for one run.
const SECURITY_RUNS = ['off', 'required', 'always']
const SECURITY_TIMEOUT_MS = 15 * 60_000
function securityLevel(value, where) {
  const run = String(value ?? 'off').trim().toLowerCase()
  if (SECURITY_RUNS.includes(run)) return run
  if (!args.includes('--gate')) console.warn(`⚠ Unknown security.run ${JSON.stringify(value)}${where ? ` in ${where}` : ''}; using "off" (${SECURITY_RUNS.join(' | ')})`)
  return 'off'
}
function securitySettings(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const timeout = Number(s.timeoutMs)
  return { run: securityLevel(s.run), timeoutMs: Number.isSafeInteger(timeout) && timeout > 0 ? Math.min(timeout, 2 ** 31 - 1) : SECURITY_TIMEOUT_MS }
}
function stricterSecurity(repo, home, p) {
  const base = securitySettings(home), own = repo && typeof repo === 'object' && !Array.isArray(repo) ? repo : {}
  const run = String(own.run ?? base.run).trim().toLowerCase()
  let chosen = base.run
  if (SECURITY_RUNS.includes(run) && SECURITY_RUNS.indexOf(run) >= SECURITY_RUNS.indexOf(base.run)) chosen = run
  else if (Object.hasOwn(own, 'run') && !args.includes('--gate'))
    console.warn(`⚠ Ignoring security.run ${JSON.stringify(own.run)} in ${p}: the repository or an agent can set that file, so it may only ` +
      `raise the security pass above "${base.run}" (${SECURITY_RUNS.join(' < ')})`)
  return { run: chosen, timeoutMs: base.timeoutMs }
}
function stricterMerge(repo, home, p, why = 'git tracks it (or a symlink leads to it), so the repository can set it') {
  const base = mergeSettings(home), own = repo && typeof repo === 'object' && !Array.isArray(repo) ? repo : {}
  const warn = (key, extra = '') => { if (!args.includes('--gate')) console.warn(`⚠ Ignoring ${key} in ${p}: ${why}${extra}.`) }
  const policy = String(own.policy ?? base.policy).trim().toLowerCase()
  let chosen = base.policy
  if (MERGE_POLICIES.includes(policy) && MERGE_POLICIES.indexOf(policy) <= MERGE_POLICIES.indexOf(base.policy)) chosen = policy
  else if (Object.hasOwn(own, 'policy'))
    warn(`merge.policy ${JSON.stringify(own.policy)}`, `; it may only make the policy stricter than "${base.policy}" (${MERGE_POLICIES.join(' > ')}, strictest first)`)
  if (own.classifier != null && own.classifier !== '') warn('merge.classifier')
  const threshold = Number(own.threshold)
  if (Object.hasOwn(own, 'humanComment')) warn('merge.humanComment')
  if (Object.hasOwn(own, 'requireChecks') && own.requireChecks !== true) warn('merge.requireChecks', '; it may only be true')
  if (Object.hasOwn(own, 'allowBehind') && own.allowBehind !== false) warn('merge.allowBehind', '; it may only be false')
  return {
    policy: chosen,
    classifier: base.classifier,
    threshold: own.threshold != null && threshold > base.threshold && threshold <= 1 ? threshold : base.threshold,
    alwaysHuman: [...base.alwaysHuman, ...mergeSettings({ alwaysHuman: own.alwaysHuman }).alwaysHuman],
    onHuman: Object.hasOwn(own, 'onHuman') ? mergeSettings({ onHuman: own.onHuman }).onHuman : base.onHuman,
    humanComment: base.humanComment,
    requireChecks: base.requireChecks || own.requireChecks === true,
    allowBehind: base.allowBehind && own.allowBehind !== false,
  }
}
function loadConfig() {
  const homes = [join(homedir(), '.agent-config-studio', 'review-gate', 'config.json'), join(homedir(), '.claude', 'review-config.json')]
  const paths = [
    { p: process.env.REVIEW_CONFIG, env: true },
    { p: join('.claude', 'review-config.json'), repo: true },
    ...homes.map((p) => ({ p })),
  ].filter(({ p }) => p)
  for (const { p, repo, env } of paths) {
    let config = null
    try {
      if (existsSync(p)) config = { ...JSON.parse(readFileSync(p, 'utf8')), _source: p }
    } catch (e) {
      if (args.includes('--gate')) {
        // Defer to pushGate so a real operator override can still be checked and logged.
        gateConfigError = new Error(`Malformed review config at ${p}: ${e.message}`)
        return {}
      }
      console.warn(`⚠ Ignoring malformed review config at ${p}`)
    }
    if (config) {
      // REVIEW_CONFIG, or a repo file that is the older home config while the primary one exists, never goes below the floor.
      const floorFile = homeSource(homes)
      if ((env || repo && homes.some((home) => sameFile(p, home))) && !(floorFile && sameFile(p, floorFile))) {
        config.security = Object.hasOwn(config, 'security') ? stricterSecurity(config.security, homeKey(homes, 'security'), p) : homeKey(homes, 'security')
        // The same floor for merge: such a file may only tighten the home config's merge settings.
        config.merge = Object.hasOwn(config, 'merge') ? stricterMerge(config.merge, homeMerge(homes), p, 'the repository or an agent can set that file') : homeMerge(homes)
      }
      if (!repo) return config
      const ownMerge = Object.hasOwn(config, 'merge'), ownSecurity = Object.hasOwn(config, 'security')
      const checked = withoutRepoCommands(config, p, homes)
      if (!ownMerge) checked.merge = homeMerge(homes)
      if (!ownSecurity) checked.security = homeKey(homes, 'security')
      return checked
    }
  }
  return {}
}
const CONFIG = loadConfig()
// An old config (or env) may still set the removed shadow keys: they are ignored with one note, never an error.
const OLD_SHADOW_KEYS = [...['shadow', 'pickShadow'].filter((k) => Object.hasOwn(CONFIG, k)),
  ...['REVIEW_SHADOW', 'REVIEW_PICK_SHADOW'].filter((k) => String(process.env[k] ?? '').trim())]
if (OLD_SHADOW_KEYS.length && !args.includes('--gate')) console.warn(`ℹ ${OLD_SHADOW_KEYS.join(', ')} ignored: shadow pickers were removed`)
const MERGE = mergeSettings(CONFIG.merge)
// The security pass in force: the config's, raised (never lowered) by REVIEW_SECURITY for one run.
const SECURITY = (() => {
  const settings = securitySettings(CONFIG.security)
  if (EVAL_MODE) return { ...settings, run: 'off' }
  const asked = process.env.REVIEW_SECURITY
  if (asked == null || !String(asked).trim()) return settings
  const run = securityLevel(asked, 'REVIEW_SECURITY')
  if (SECURITY_RUNS.indexOf(run) > SECURITY_RUNS.indexOf(settings.run)) return { ...settings, run, raisedBy: 'REVIEW_SECURITY' }
  if (run !== settings.run && !args.includes('--gate'))
    console.warn(`⚠ Ignoring REVIEW_SECURITY=${asked}: it may only raise the security pass above "${settings.run}", never lower it`)
  return settings
})()
const cfg = (envName, key, dflt) => process.env[envName] ?? CONFIG[key] ?? dflt
// fixCheck: "risk" (the default: a fix touching tests, verify scripts or riskPaths needs a fix check before close) |
// "always" (any code fix after the review needs one; docs, static, coverage-exempt and builds/ files never do). Every
// source may only raise it: the home config is the floor, and REVIEW_FIX_CHECK, REVIEW_CONFIG or a repo file can't lower it.
const FIX_CHECK_MODES = ['risk', 'always']
const FIX_CHECK = (() => {
  const homes = [join(homedir(), '.agent-config-studio', 'review-gate', 'config.json'), join(homedir(), '.claude', 'review-config.json')]
  let mode = 'risk'
  // The loaded config is read once: when it is the home config itself, it is not read again under its own name.
  const home = homeSource(homes), loadedIsHome = !!home && !!CONFIG._source && sameFile(CONFIG._source, home)
  for (const [value, where] of [[homeKey(homes, 'fixCheck'), home], ...(loadedIsHome ? [] : [[CONFIG.fixCheck, CONFIG._source]]), [process.env.REVIEW_FIX_CHECK, 'REVIEW_FIX_CHECK']]) {
    if (value == null || value === '') continue
    const asked = String(value).trim().toLowerCase()
    if (!FIX_CHECK_MODES.includes(asked)) {
      if (!args.includes('--gate')) console.warn(`⚠ Unknown fixCheck ${JSON.stringify(value)} in ${where}; using the others (${FIX_CHECK_MODES.join(' | ')})`)
    } else if (asked === 'always') mode = 'always'
  }
  return mode
})()
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
// Found on PATH without running it, the way spawnSync will find it.
const onPath = (command) => (String(command).includes('/') ? isExecutable(command) : which(command) !== null)

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
const skipsNoted = new Set()
function loadPool(role = 'reviewer') {
  const r = modelIdJson(['--role', role, '--json'])
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
      console.warn(`⚠ ${role} role family "${family}" has id "${id}", whose prefix names no known CLI (claude-, gpt-, grok-) — skipped`)
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
  if (skipped.length && !skipsNoted.has(role)) {
    skipsNoted.add(role)
    console.warn(`ℹ ${role} role: skipped ${skipped.join(', ')}`)
  }
  if (pool.length) return { pool, unusable }
  return {
    error: use.length
      ? `none of the ${role} role's families (${use.join(', ')}) has its CLI on PATH`
      : `the ${role} role lists no families`,
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
// Eval mode: the review logs only to REVIEW_EVAL_LOG_DIR, an override honoured with the marker alone.
if (EVAL_MODE) evalModeChecks()
else if (process.env.REVIEW_EVAL_LOG_DIR && !args.includes('--gate'))
  console.warn('⚠ Ignoring REVIEW_EVAL_LOG_DIR: it is honoured only in eval mode (REVIEW_EVAL), which review.mjs --eval sets')
const LOG_PATH = EVAL_MODE ? join(process.env.REVIEW_EVAL_LOG_DIR, 'review-log.jsonl') : logPath()
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
      // A standalone security check's record is never a review, whichever log it turns up in.
      return entry.eval === true || entry.securityOnly === true ? [] : [entry]
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
// Parallel slices append at once, and a write() to a regular file is not atomic for lines this long (findings and
// coverage reach hundreds of KB), so each append holds an exclusive lock: `pid token`, written to a temp file first and
// hard-linked to the lock path, so a lock is never seen empty (link fails if the path exists). A lock whose process is
// gone, or older than LOCK_STALE_MS, is stale; an empty or malformed one is stale only by age.
const LOCK_WAIT_MS = 10_000, LOCK_STALE_MS = 30_000
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
// The stale lock's text, or null while it is live or gone.
function staleLock(lock) {
  let text, age
  try {
    text = readFileSync(lock, 'utf8')
    age = Date.now() - statSync(lock).mtimeMs
  } catch {
    return null
  }
  if (age > LOCK_STALE_MS) return text
  const pid = Number(text.split(' ')[0])
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return null
  } catch (e) {
    return e.code === 'ESRCH' ? text : null
  }
}
// Reclaims a lock judged stale: rename it to a tombstone (atomic, so one reclaimer wins), then check the tombstone is
// the lock judged stale. If another run took the lock in between, it goes back while the path is free; if a third run
// already took the path, this one keeps waiting.
function reclaimLock(lock, stale) {
  const gate = process.env.REVIEW_LOCK_TEST_GATE // tests only: hold here, between the judgment and the reclaim
  if (gate) {
    writeFileSync(`${gate}.judged`, '')
    for (const until = Date.now() + 5000; !existsSync(gate) && Date.now() < until;) pause(10)
  }
  const tomb = `${lock}.stale-${randomBytes(6).toString('hex')}`
  try {
    renameSync(lock, tomb)
  } catch (e) {
    if (e.code === 'ENOENT') return
    throw e
  }
  try {
    if (readFileSync(tomb, 'utf8') !== stale) linkSync(tomb, lock)
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
  } finally {
    rmSync(tomb, { force: true })
  }
}
function withLogLock(fn, file = LOG_PATH) {
  const lock = `${file}.lock`, token = `${process.pid} ${randomBytes(6).toString('hex')}`, deadline = Date.now() + LOCK_WAIT_MS
  const temp = `${lock}.${randomBytes(6).toString('hex')}`
  writeFileSync(temp, token)
  try {
    for (;;) {
      try {
        linkSync(temp, lock)
        break
      } catch (e) {
        if (e.code !== 'EEXIST') throw e
      }
      const stale = staleLock(lock)
      if (stale !== null) reclaimLock(lock, stale)
      if (Date.now() > deadline) throw new Error(`${lock} has been held for over ${LOCK_WAIT_MS / 1000}s by another review run`)
      if (stale === null) pause(20)
    }
  } finally {
    rmSync(temp, { force: true })
  }
  try {
    return fn()
  } finally {
    try {
      if (readFileSync(lock, 'utf8') === token) unlinkSync(lock)
    } catch { /* taken over as stale */ }
  }
}
function appendLog(entry) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    // A record written in eval mode is tagged, and readLog() skips tagged records: nothing counts it as a review.
    const line = `${JSON.stringify(EVAL_MODE ? { ...entry, eval: true } : entry)}\n`
    withLogLock(() => appendFileSync(LOG_PATH, line))
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
// never writes it); this never writes it either (origin/HEAD decides what the push gate trusts as the default
// branch, so only the operator sets it), and the fallback is loud.
function detectDefaultBase() {
  if (!existsSync('.git')) return 'origin/main' // getDiff() reports the real problem
  const r = spawnSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' })
  const ref = (r.stdout || '').trim()
  if (r.status === 0 && ref) return ref
  console.warn(
    `⚠ Could not resolve origin/HEAD — falling back to origin/main. If this repo's default branch\n` +
      `  is not "main", pass REVIEW_BASE=origin/<branch> or set "base" in review-config.json, or run\n` +
      `  git remote set-head origin --auto once.`,
  )
  return 'origin/main'
}
// origin/HEAD as this run found it, read once: the default branch counts as reviewed only through it (defaultTip).
const ORIGIN_HEAD = (() => {
  const r = spawnSync('git', ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' })
  return !r.error && r.status === 0 ? r.stdout.trim() : ''
})()
// `||` not `??` so an empty string in review-config.json still means "auto-detect".
const BASE = cfg('REVIEW_BASE', 'base', '') || (['--gate', '--deferred', '--rubric', '--calibrate', '--noise-report', '--eval'].some((flag) => args.includes(flag)) ? '' : detectDefaultBase())
// The base reaches git as a revision and as `git fetch <remote> <ref>`, so it is never an option, a
// refspec or a URL: no leading - or + on any part, no colon, no space. The push gate never uses it.
const BASE_RE = /^(?!.*\/[-+])[A-Za-z0-9_@][A-Za-z0-9._/~^@{}-]*$/
if (BASE && !args.includes('--gate') && !BASE_RE.test(BASE))
  stop(`${process.env.REVIEW_BASE != null ? 'REVIEW_BASE' : 'config "base"'} must be a branch, tag or commit like origin/main; got ${JSON.stringify(BASE)}.`)
// Optional per-repo gate (config `verifyCmd`, e.g. "npm run type-check"). Its result is CONTEXT
// for the reviewer, never a gate: a failing build is something to explain, not a reason to skip
// the review. Unset = unchanged behavior.
// A whitespace-only command (here or in --test-cmd) is no command: `sh -c " "` runs nothing and exits 0.
const blankCommand = (value) => value == null || !String(value).trim()
const VERIFY_CMD = EVAL_MODE || blankCommand(cfg('REVIEW_VERIFY_CMD', 'verifyCmd', '')) ? '' : cfg('REVIEW_VERIFY_CMD', 'verifyCmd', '')
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
// The changed files a sliced review actually covered, recorded at review time. Coverage uses only this
// list, never the pathspecs: their expansion can change later (attributes, config) with no new review.
const sliceFiles = (record) => (Array.isArray(record?.files) ? record.files.filter((f) => typeof f === 'string') : [])
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
const VALUE_FLAGS = ['--security-worker', '--since', '--slices', '--jobs', '--plan', '--close', '--status', '--test-cmd', '--no-tests', '--fix-check', '--dispute', '--reason', '--evidence', '--waive', '--log-grade', '--recheck-of', '--remote', '--family', '--cases', '--timeout', '--repeat']
const INTENT = args.includes('--dispute') || args.includes('--waive') || args.includes('--log-grade')
  ? ''
  : args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(args[i - 1])).join(' ').trim()
const PLAN_PATH = option('--plan') ?? process.env.REVIEW_PLAN
let CONTEXT = ''
let DIFF_BASE = BASE
let FIX_CHECK_RUN = false
// verify: "second-opinion" sends surviving HIGH/MEDIUM findings to one other pool family.
const SECOND_OPINION = !EVAL_MODE && String(cfg('REVIEW_VERIFY', 'verify', 'off')).trim().toLowerCase() === 'second-opinion'
const QUOTE_WINDOW = 5 // a quote must start within ±this many lines of the cited line
// An optional local classifier: any command that answers the choice protocol in askClassifier().
// None ships or is assumed. `pick` may name one; `classifier` names the one disputes may ask.
const CLASSIFIER = String(cfg('REVIEW_CLASSIFIER', 'classifier', '')).trim()
const CLASSIFIER_ACT = 0.7 // act on its choice at confidence ≥ 0.7; below is the middle band
// A pick read from a repo file that failed the own-file check (REVIEW_PICK always wins over it).
const pickFromRepo = () => process.env.REVIEW_PICK == null && REPO_PICK_UNTRUSTED
const untrustedPickNote = (pick) =>
  `⚠ Ignoring pick "${pick}" in ${CONFIG._source}: it names a command, and git tracks that file (or a symlink leads to it), so the repository can set it.`
// Path patterns are case-insensitive globs: `**` spans directories, `*` and `?` stay inside one.
// Like .gitignore, a pattern with no `/` is matched against every path segment ("*auth*").
const RISK_PATHS = Array.isArray(CONFIG.riskPaths)
  ? CONFIG.riskPaths
  : ['*payment*', '*billing*', '*checkout*', '*auth*', '*migration*', '*security*', '*money*']
// coverageExempt (REVIEW_COVERAGE_EXEMPT, comma- or newline-separated): path patterns, same globs, that the push gate
// does not ask coverage for, on top of DEFAULT_EXEMPT. The refusal and the summary name every exempt file as not reviewed.
const COVERAGE_EXEMPT = exemptPatterns(cfg('REVIEW_COVERAGE_EXEMPT', 'coverageExempt', ''))
// Generated dependency lockfiles: a routine change whose diff alone can pass the size cap. Exempt by default, by exact
// file name in any folder, never a pattern; "coverageExemptDefaults": false turns them off.
const DEFAULT_EXEMPT = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'Cargo.lock',
  'poetry.lock', 'uv.lock', 'Pipfile.lock', 'composer.lock', 'Gemfile.lock', 'go.sum', 'mix.lock', 'pubspec.lock', 'Podfile.lock', 'flake.lock']
const EXEMPT_DEFAULTS = exemptDefaults(CONFIG.coverageExemptDefaults)
const coverageExempt = (path) => matchesAny(path, COVERAGE_EXEMPT) || EXEMPT_DEFAULTS && DEFAULT_EXEMPT.includes(path.split('/').at(-1))
function exemptDefaults(value) {
  if (value === undefined || typeof value === 'boolean') return value !== false
  const message = `coverageExemptDefaults must be true or false; got ${JSON.stringify(value)}`
  if (!args.includes('--gate')) stop(message)
  gateConfigError ||= new Error(message)
  return true
}
// A list that isn't text or non-empty strings fails loudly; at the gate it blocks the push, never guesses.
function exemptPatterns(value) {
  if (typeof value === 'string' || Array.isArray(value) && value.every((p) => typeof p === 'string' && p.trim())) return normalisePaths(value)
  const message = `coverageExempt must be a list of non-empty path patterns; got ${JSON.stringify(value)}`
  if (!args.includes('--gate')) stop(message)
  gateConfigError ||= new Error(message)
  return []
}
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
// The work tree's top; diffStats runs from it (first use is at load, so it is defined here).
const TOP = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout?.trim() || process.cwd()
// Paths and line counts only — this is everything a classifier and the force rules ever see of the diff.
function diffStats(range = `${BASE}...HEAD`, paths = null) {
  // -z keeps paths unquoted; a rename is `added\tremoved\t` then NUL-separated source and destination.
  // Pathspecs resolve from the top of the work tree, and every path is repository-relative whatever the cwd or diff.relative.
  const r = spawnSync('git', ['-C', TOP, 'diff', '--no-relative', '--numstat', '-z', '-M', '--end-of-options', range, ...pathspec(paths)], {
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
// The record's `stats`: what a review or fix check saw, for calibrating routing later. Files count per kind;
// logicLines = lines added + removed in logic files. Lockfiles and coverage-exempt paths are never logic.
const STATIC_EXTS = new Set(['css', 'scss', 'sass', 'less', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'woff', 'woff2', 'ttf', 'otf'])
const DOC_EXTS = new Set(['md', 'mdx', 'txt', 'rst'])
const LOGIC_EXTS = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts',
  'swift', 'scala', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sql', 'sh', 'bash', 'zsh', 'vue', 'svelte', 'lua', 'ex', 'exs', 'dart'])
function fileKind(path) {
  if (isTestFile(path)) return 'tests'
  if (coverageExempt(path)) return 'other'
  return extKind(path)
}
function extKind(path) {
  const name = path.split('/').at(-1)
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  return STATIC_EXTS.has(ext) ? 'static' : DOC_EXTS.has(ext) ? 'docs' : LOGIC_EXTS.has(ext) ? 'logic' : 'other'
}
function recordStats(stats) {
  if (!stats) return null
  const kinds = { static: 0, docs: 0, tests: 0, logic: 0, other: 0 }
  let logicLines = 0
  for (const f of stats.files) {
    const kind = fileKind(f.path)
    kinds[kind]++
    if (kind === 'logic') logicLines += f.added + f.removed
  }
  return { files: stats.filesChanged, linesAdded: stats.linesAdded, linesRemoved: stats.linesRemoved, kinds, logicLines }
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
  // A pick, from REVIEW_PICK or config, is an explicit override; with none, configured routing decides.
  const pickSet = String(process.env.REVIEW_PICK ?? CONFIG.pick ?? '').trim() !== ''
  const routing = routingRules()
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
  let route = null
  const commandPick =
    !['first', 'rotate'].includes(pick) && !members.some((p) => p.family === pick) && (pick === CLASSIFIER || onPath(pick))
  // From a repo file the repository can ship, a pick may name a family or your own classifier, never another command.
  const classifierPick = commandPick && (!pickFromRepo() || (CLASSIFIER && pick === CLASSIFIER))
  if (commandPick && !classifierPick) notes.push(untrustedPickNote(pick))
  if (hit) {
    m = requireCli(hit.m, `force rule → ${hit.m.family}`)
    const paths = hit.rule.paths ?? hit.rule.when
    const hits = paths === 'risk' ? stats.riskFiles : stats.files.flatMap(pathsOf).filter((p) => matchesAny(p, paths))
    pickWhy = `force: ${paths === 'risk' ? 'risk paths' : `paths ${paths.join(', ')}`} (${hits.slice(0, 3).join(', ')}) → ${m.family}`
    crossWhy = authorVendor && crossFamily === 'prefer' && m.vendor === authorVendor
      ? `force rule overrides crossFamily (author is also ${authorVendor})`
      : ''
  } else if (!pickSet && routing) {
    route = routeFor(routing, stats)
    const member = members.find((p) => p.family === route.family) || loaded.unusable?.find((p) => p.family === route.family)
    if (!member)
      stop(`routing names ${route.family}, which is not in the reviewer role (${members.map((p) => p.family).join(', ')}).\n` +
        '  Fix: add it to the reviewer role in ACS → Models → Roles, or change "routing" in the review config.')
    m = requireCli(member, `routing → ${route.family}`)
    pickWhy = route.why
    // Routing ignores crossFamily: a small diff goes to its family even when the builder shares its vendor.
    crossWhy = ''
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
    if (pick !== 'first' && !commandPick)
      notes.push(
        `⚠ pick "${pick}" is not first, rotate, a pool family (${members.map((p) => p.family).join(', ')}) ` +
          `or a classifier command on PATH — using first`,
      )
    m = candidates[0]
    pickWhy = 'pick=first: first in pool order'
  }
  if (pickSet && routing && !hit) notes.push(`ℹ ${source('REVIEW_PICK', 'pick')}=${pick} overrides routing${process.env.REVIEW_PICK == null ? ' — remove it to route reviews by size' : ' for this run'}`)
  return {
    ...base,
    pool: members,
    pick: pickSet ? pick : null,
    route,
    crossFamily,
    author: author || null,
    classifier,
    sel: { ...m, effort: effortFor(m) },
    why: [pickWhy, crossWhy].filter(Boolean).join('; '),
  }
}

// routing (config only; it names families, so it has no built-in default): [{ "maxLines": <lines>, "family": "<f>" },
// { "family": "<f>" }]. The first entry whose maxLines the diff's changed lines (added + removed) are under decides; an
// entry without maxLines takes the rest. A diff touching riskPaths skips every maxLines entry: it is never a small diff.
// Unset, pick decides as before. Read only when a review picks its reviewer.
function routingRules() {
  const value = CONFIG.routing
  if (value === undefined) return null
  const entry = (e) => e && typeof e === 'object' && !Array.isArray(e) && Object.keys(e).every((k) => ['maxLines', 'family'].includes(k)) &&
    typeof e.family === 'string' && FAMILY_NAME.test(e.family) && (e.maxLines === undefined || Number.isSafeInteger(e.maxLines) && e.maxLines > 0)
  if (!Array.isArray(value) || !value.length || !value.every(entry) || !value.some((e) => e.maxLines === undefined))
    stop(`config "routing" must be a list of { "maxLines": <lines>, "family": "<family>" } entries with one that has no maxLines; got ${JSON.stringify(value)}`)
  return value
}
function routeFor(rules, stats) {
  const lines = stats ? stats.linesAdded + stats.linesRemoved : null
  const risky = !!stats?.riskFiles?.length
  const rule = rules.find((e) => e.maxLines === undefined || (lines !== null && !risky && lines < e.maxLines))
  const size = lines === null ? 'no diff stats' : `${lines} changed line(s)${risky ? ', riskPaths touched' : ''}`
  const why = rule.maxLines === undefined
    ? `route: ${size} → ${rule.family}${rules.length > 1 ? ' (the catch-all)' : ''}`
    : `route: ${size}, under ${rule.maxLines} → ${rule.family}`
  return { family: rule.family, why, lines, risky }
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
        pick: SELECTION.pick ?? (SELECTION.route ? '(none — routing decides)' : '(explicit reviewer — not used)'),
        route: SELECTION.route ? SELECTION.why : routingRules() ? '(not used: a reviewer, force rule or pick decided)' : '(no routing configured)',
        routing: routingRules() ?? '(none)',
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
        fixCheck: FIX_CHECK,
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
        required: ['issue', 'file', 'line', 'quote', 'suggestion', 'likelihood', 'impact', 'protected', 'trigger', 'preExisting', 'instances'],
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
          preExisting: { type: ['boolean', 'null'] },
          instances: {
            type: ['array', 'null'],
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file', 'line', 'quote'],
              properties: { file: { type: 'string' }, line: { type: 'string' }, quote: { type: 'string' } },
            },
          },
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
// Pre-existing: the reviewer says the defect is at the base and this branch neither introduced it nor made it newly
// reachable, and the script found every located place of it outside the review diff (inDiff false, set only by the script).
// It never blocks and needs no status; a review or security finding only (a fix check's never carries inDiff).
const isPreExisting = (finding) => !finding.criterionId && finding.preExisting === true && finding.inDiff === false
const blocking = (f) => !isFiled(f) && !isPreExisting(f) && (f.severity !== 'low' || f.unscored === true)
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
// Every finding shown to the owner carries its numbers, never the bare word: "LOW 6/100 (likelihood 2/10 × impact 3/10)".
function scoreText(f) {
  const band = String(f.severity || '?').toUpperCase()
  if (Number.isInteger(f.likelihood) && Number.isInteger(f.impact) && Number.isInteger(f.risk))
    return `${band} ${f.risk}/100 (likelihood ${f.likelihood}/10 × impact ${f.impact}/10)`
  return Number.isInteger(f.risk) ? `${band} ${f.risk}/100` : `${band} unscored`
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
    for (const finding of (review.findingDetails || []).filter((f) => isFiled(f) || isPreExisting(f)))
      decided.push({ ...finding, review: review.id, finding: finding.id, decision: isPreExisting(finding) ? 'pre-existing' : 'filed' })
  if (decided.length) context += `Already decided; don't re-raise without new evidence:\n${JSON.stringify(decided)}\n`
  return context
}
function fetchBase() {
  const slash = BASE.indexOf('/')
  if (slash <= 0) return
  const f = spawnSync('git', ['fetch', '--', BASE.slice(0, slash), BASE.slice(slash + 1)], { encoding: 'utf8' })
  if (f.error || f.status !== 0)
    console.warn(`⚠ Could not fetch ${BASE} — reviewing against a possibly-stale local base.`)
}
function getDiff() {
  if (!existsSync('.git')) die('Not a git repository.')
  // Magic pathspecs (:(attr:…), :(glob), :!, :/ …) can match differently later with no new commit.
  const magic = (SLICE || []).filter((p) => p.startsWith(':'))
  if (magic.length)
    die(`REVIEW_PATHS refuses pathspec magic: ${magic.join(', ')}. Use plain paths or simple globs (src/, lib/*.js).`)
  const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  requireClean()
  // The slice runner fetched the base once for all its slices: concurrent fetches fight over ref locks.
  if (process.env.REVIEW_BASE_FETCHED !== BASE) fetchBase()
  const head = sh('git', ['rev-parse', 'HEAD'])
  const baseSha = sh('git', ['merge-base', '--end-of-options', BASE, head])
  const files = SLICE ? filesBetween(baseSha, head, SLICE).sort() : null
  if (SLICE && !files.length)
    die(`REVIEW_PATHS (${SLICE.join(', ')}) matches no file changed between ${BASE} and HEAD; nothing was reviewed.\n` +
      `  Check the pathspecs against: git diff --name-only ${baseSha}...HEAD`)
  const diff = sh('git', [...(SLICE ? ['-C', TOP] : []), 'diff', `${baseSha}...${head}`, ...pathspec(SLICE)])
  return { branch, diff, head, baseSha, files }
}

const die = (m) => {
  console.error(`\n✖ ${m}\n`)
  process.exit(1)
}

// Portability: if the repo doesn't already ignore reviews/, add it to the repo's info/exclude so the report
// never appears as an untracked file (some repos ignore it via .gitignore; others may not). Git names the
// path: in a linked worktree `.git` is a file and info/exclude lives in the common dir.
function ensureReviewsIgnored() {
  if (spawnSync('git', ['check-ignore', '-q', 'reviews']).status === 0) return
  try {
    const exclude = sh('git', ['rev-parse', '--git-path', 'info/exclude'])
    if (!exclude) return
    mkdirSync(dirname(exclude), { recursive: true })
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

// What every reviewer prompt carries after its instruction: the tool notes, the quote rule, the rubric, the verify
// result and the slice.
function promptNotes(vendor) {
  const notes = toolNotes(vendor)
  notes.push(
    `Every finding MUST carry \`quote\`: one to three lines copied character-for-character from \`file\` ` +
      `as it is at HEAD, starting at or within ${QUOTE_WINDOW} lines of \`line\` (a single line number). ` +
      `Open the file and copy it — never paraphrase or reconstruct it from memory. A script checks every ` +
      `quote against the file; a finding whose quote is not there is discarded as unlocatable.`,
  )
  notes.push(
    `If the same defect pattern appears in several places, report it once and list every place in \`instances\` ` +
      `(file, line and quote each, quoted exactly like the main location, which is one of them); otherwise instances is null.`,
  )
  if (!FIX_CHECK_RUN)
    notes.push(
      `\`preExisting\`: true when the defect exists at the base and this branch neither introduced it nor made it newly ` +
        `reachable; otherwise false. A script checks the claim against the diff: a finding near a line the branch changed counts as the branch's.`,
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
  return notes
}
function reviewPrompt(diff) {
  const clipped = clip(diff)
  const notes = promptNotes(SEL.vendor)
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

// The security pass's prompt: the same diff, context, notes and schema as the code review, a security-only instruction.
// SECURITY_MARKER names it (tests find the security call by it).
const SECURITY_MARKER = 'SECURITY REVIEW ONLY.'
// Attack-class checklists, each added to the security prompt only when a changed file is of its class (by path). Agent
// instruction files count only as AI/agent tools; other docs never count, apart from supply-chain names such as
// requirements.txt. Borrowed from Cloudflare's security-audit-skill.
const AGENT_FILES = /(^|\/)(SKILL|AGENTS|CLAUDE|GEMINI)\.md$/i
const plainFile = (p) => !AGENT_FILES.test(p) && extKind(p) !== 'docs'
const SECURITY_CLASSES = [
  {
    test: (p) => AGENT_FILES.test(p) || plainFile(p) && /(^|[/._-])(agents?|prompts?|skills?|mcp|llm|ai|tool-?use|tool-?calls?|ask-model|claude|codex|grok|openai|anthropic)([/._-]|$)/i.test(p),
    list: 'Checklist: AI and agent tools. Prompt injection through tool output (files, web pages, command output or model replies that ' +
      'reach a model and steer what it does next); tool permissions (what each tool may read, write or run, and who grants that); ' +
      'commands a model chooses (commands, paths or URLs picked by a model that run without a fixed allowlist or a human check).',
  },
  {
    test: (p) => !AGENT_FILES.test(p) && /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb?|\.npmrc|\.yarnrc(\.yml)?|requirements[^/]*\.txt|Pipfile(\.lock)?|poetry\.lock|pyproject\.toml|setup\.py|setup\.cfg|Gemfile(\.lock)?|[^/]+\.gemspec|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|composer\.json|composer\.lock|Dockerfile)$/i.test(p) ||
      /(^|\/)\.github\/workflows\//.test(p) || /(^|\/)(pre|post)?(install|setup|bootstrap|update|upgrade)[^/]*\.(sh|bash|zsh|ps1|mjs|cjs|js|py)$/i.test(p),
    list: 'Checklist: supply chain. Install scripts (install, postinstall, setup and update scripts, CI workflows, and what they run); ' +
      'lockfile or registry changes (a new or moved dependency, a changed resolved URL or integrity hash, a new registry or package ' +
      'source); fetched code (anything downloaded and run at build, install or run time, such as curl | sh or an import from a URL, ' +
      'without a pinned version or checksum).',
  },
  {
    test: (p) => plainFile(p) && /(^|[/._-])(servers?|ipc|sockets?|daemon|websockets?|ws|rpc|https?|listeners?|localhost|bridge|proxy|pipes?)([/._-]|$)/i.test(p),
    list: 'Checklist: local IPC. localhost servers (who else on this machine can connect, and what a web page can make the browser ' +
      'send them); Host and Origin checks (against DNS rebinding and cross-site requests); sockets and named pipes (who may connect, ' +
      'their file permissions and where they live); file-permission races (check-then-use on temp files, sockets, locks and config ' +
      'files another local user or process could swap).',
  },
]
// The lists for these changed paths, in class order; each class decides which files count for it.
function securityClassLists(paths = []) {
  const named = paths.filter((p) => typeof p === 'string')
  return SECURITY_CLASSES.filter((c) => named.some(c.test)).map((c) => c.list)
}
function securityPrompt(diff, vendor, intent, paths = []) {
  const lists = securityClassLists(paths)
  return (
    `${SECURITY_MARKER} Review the branch diff below for security defects, judged against what the branch was supposed to do` +
    `${intent ? `: ${intent}` : ' (infer from the diff)'}. Look for: trust boundaries crossed without a check; untrusted input ` +
    `reaching a shell, SQL, file paths, eval or HTML; authentication and authorization gaps; secrets in code, logs or output; ` +
    `command execution; path traversal; unsafe deserialization; server-side request forgery (SSRF); and changes to ` +
    `dependencies, install or update scripts and CI workflows. You are not reviewing correctness, style or performance: ` +
    `report a defect only when it is a security issue. Inspect the diff (open files as needed) BEFORE answering.\n\n` +
    `${lists.length ? `This diff touches these attack classes; check each item:\n${lists.map((l) => `- ${l}`).join('\n')}\n\n` : ''}` +
    `A missing extra layer of defense is a hardening note (LOW), not a vulnerability. ` +
    `Do not report a vulnerability without a concrete harmed principal: who is harmed, and how an attacker reaches them.\n\n` +
    `${CONTEXT ? `${CONTEXT}\n` : ''}` +
    `${promptNotes(vendor).join('\n\n')}\n\n` +
    `Diff (git diff ${DIFF_BASE}...HEAD${sliceSuffix(SLICE)}):\n${clip(diff)}`
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
// Codex has no strict-MCP flag, and `-c mcp_servers={}` is merged into the table rather than replacing it. So each
// server `codex mcp list` reports for this folder is switched off with one inline table; when that override is
// refused (a server a plugin provides has no transport), plugins go off as a whole and the override covers the
// servers left. A last `mcp list` under the final overrides must show every server disabled, or codex is not run.
// tools/ask-model.mjs codexMcpOff, copied to keep the runtime standalone. None of these calls reaches a model.
const tail = (text) => String(text || '').trim().slice(-500) || '(no output)'
function codexMcpOff(bin, cwd) {
  const list = (extra) => {
    const r = spawnSync(bin, ['mcp', 'list', '--json', ...extra], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
    if (r.error || r.status !== 0) return { error: `codex mcp list failed: ${tail(r.error?.message || r.stderr || r.stdout)}` }
    try {
      const servers = JSON.parse(r.stdout)
      if (Array.isArray(servers)) return { servers }
    } catch {}
    return { error: `codex mcp list printed no server list: ${tail(r.stdout)}` }
  }
  const names = (servers) => servers.map((s) => s?.name).filter((n) => typeof n === 'string')
  // JSON's string escapes are valid TOML basic-string escapes.
  const off = (servers) => ['-c', `mcp_servers={${names(servers).map((n) => `${JSON.stringify(n)}={enabled=false}`).join(',')}}`]
  const allOff = (args, check) => {
    const on = check.servers.filter((s) => s?.enabled !== false).map((s) => s?.name ?? '(unnamed)')
    return on.length ? { error: `codex MCP servers still enabled under the override: ${on.join(', ')}` } : { args }
  }
  const found = list([])
  if (found.error) return found
  if (!found.servers.length) return { args: [] }
  const check = list(off(found.servers))
  if (!check.error) return allOff(off(found.servers), check)
  const PLUGINS_OFF = ['-c', 'features.plugins=false']
  const rest = list(PLUGINS_OFF)
  if (rest.error) return check
  const left = new Set(names(rest.servers))
  const fromPlugins = names(found.servers).filter((n) => !left.has(n))
  if (!fromPlugins.length) return check
  const args = [...PLUGINS_OFF, ...(rest.servers.length ? off(rest.servers) : [])]
  const final = list(args)
  if (final.error) return { error: `${final.error} (with plugins off for ${fromPlugins.join(', ')})` }
  return allOff(args, final)
}
// A deadline (epoch ms) every model call must finish by: set only in a security worker, which enforces its own timeout
// because its parent may be blocked in a synchronous model call of its own. Unset, calls run unbounded as before.
let MODEL_DEADLINE = null
const deadlineOptions = () => (MODEL_DEADLINE ? { timeout: Math.max(1, MODEL_DEADLINE - Date.now()), killSignal: 'SIGKILL' } : {})
function runCodex(m, prompt, schema) {
  const bin = which('codex')
  if (!bin) throw new Error('codex review failed: codex is not on PATH')
  // The reviewer reads a hostile diff: no MCP server it could drive stays on.
  const mcp = codexMcpOff(bin, process.cwd())
  if (mcp.error) throw new Error(`${mcp.error} — codex was not run`)
  const tmp = mkdtempSync(join(tmpdir(), 'review-'))
  try {
    const schemaPath = join(tmp, 'schema.json')
    const outPath = join(tmp, 'out.json')
    writeFileSync(schemaPath, JSON.stringify(schema))
    const r = spawnSync(
      bin,
      [
        'exec',
        ...mcp.args,
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
      { stdio: ['ignore', 'inherit', 'inherit'], maxBuffer: 64 * 1024 * 1024, ...deadlineOptions() },
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

// Grok runs a trusted folder's own hooks on every call. The Claude and Cursor hook files it reads are switched
// off here. Its own .grok/hooks/*.json have no switch except turning folder trust off, which lets project hooks
// run untrusted instead (GROK_FOLDER_TRUST=0, never used). So a tree holding any .grok/hooks entry, from the
// working folder up to the top of its repository, is never reviewed by grok.
const GROK_HOOKS_OFF = { GROK_CLAUDE_HOOKS_ENABLED: '0', GROK_CURSOR_HOOKS_ENABLED: '0' }
// GROK_HOME made absolute once, at load: a command run from another folder (runBounded) would read a relative one there.
const GROK_HOME = resolve(process.env.GROK_HOME || join(homedir(), '.grok'))
// Grok's environment for one call (ask-model's grokCallEnv): an empty temporary HOME, so what grok borrows from
// ~/.claude and ~/.cursor (plugin MCP servers and hooks, ~/.claude.json) finds nothing; the real GROK_HOME, so the
// login, its in-place refresh and folder trust are a normal session's; hooks and the Claude/Cursor MCP sources off.
// done() removes the temporary HOME. The same env serves the check and the call.
function grokRunEnv() {
  const grokHome = GROK_HOME
  const home = mkdtempSync(join(tmpdir(), 'review-grok-home-'))
  return { env: { ...process.env, ...GROK_HOOKS_OFF, GROK_CLAUDE_MCPS_ENABLED: '0', GROK_CURSOR_MCPS_ENABLED: '0', HOME: home, GROK_HOME: grokHome },
    grokHome, done: () => rmSync(home, { recursive: true, force: true }) }
}
// grokMcpAllow (REVIEW_GROK_MCP_ALLOW, comma-separated): grok-native MCP server names allowed to start, empty by default.
// An own-file key, so a tracked repo config cannot set it. Not a list of names: an error, which refuses grok.
function grokMcpAllow() {
  const value = cfg('REVIEW_GROK_MCP_ALLOW', 'grokMcpAllow', [])
  const list = typeof value === 'string' ? value.split(',').map((n) => n.trim()).filter(Boolean) : value
  if (!Array.isArray(list) || list.some((n) => typeof n !== 'string' || !n.trim())) return { error: `grokMcpAllow must be a list of server names; got ${JSON.stringify(value)}` }
  return { names: list.map((n) => n.trim()) }
}
/**
 * What one grok TOML file sets cli.use_leader to: { value } (true, false, or undefined when unset), or { unclear }.
 * A small TOML reader, not a whole one: bare, quoted and dotted keys, [cli] headers and inline tables, comments and
 * every string form, so `"use_leader" = true # on` and `cli.use_leader = true` both count. What it can't read is
 * unclear, which refuses grok.
 */
function tomlUseLeader(source) {
  const text = source.replace(/^﻿/, '')
  let i = 0, found
  const fail = (why) => { throw new Error(`${why} (line ${text.slice(0, i).split('\n').length})`); }
  const ws = () => { while (text[i] === ' ' || text[i] === '\t') i++; }
  const blank = () => { // spaces, comments and line ends
    for (;;) {
      ws()
      if (text[i] === '#') while (i < text.length && text[i] !== '\n') i++
      if (text[i] === '\n' || text[i] === '\r') i++; else return
    }
  }
  const endLine = () => {
    ws()
    if (text[i] === '#') while (i < text.length && text[i] !== '\n') i++
    if (text[i] === '\r') i++
    if (i < text.length && text[i] !== '\n') fail('more on a line than one key and value')
    i++
  }
  const ESC = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' }
  const str = () => {
    const q = text[i], multi = text.startsWith(q.repeat(3), i)
    i += multi ? 3 : 1
    if (multi && text[i] === '\n') i++
    else if (multi && text.startsWith('\r\n', i)) i += 2
    let out = ''
    for (;;) {
      if (i >= text.length) fail('a string that never closes')
      if (multi ? text.startsWith(q.repeat(3), i) : text[i] === q) {
        if (multi) for (let k = 0; k < 2 && text[i + 3] === q; k++) { out += q; i++; }
        i += multi ? 3 : 1
        return out
      }
      const c = text[i]
      if (!multi && (c === '\n' || c === '\r')) fail('a string that runs past its line')
      if (q === '"' && c === '\\') {
        const n = text[i + 1]
        if (multi && /[ \t\r\n]/.test(n)) {
          let j = i + 1
          while (text[j] === ' ' || text[j] === '\t') j++
          if (text[j] === '\r') j++
          if (text[j] !== '\n') fail('a backslash that is not an escape')
          i = j
          while (/[ \t\r\n]/.test(text[i] || '')) i++
          continue
        }
        if (ESC[n] !== undefined) { out += ESC[n]; i += 2; continue; }
        const hex = { x: 2, u: 4, U: 8 }[n] || 0, digits = text.slice(i + 2, i + 2 + hex)
        if (!hex || !/^[0-9a-fA-F]+$/.test(digits) || digits.length !== hex) fail('an escape it does not know')
        out += String.fromCodePoint(parseInt(digits, 16))
        i += 2 + hex
        continue
      }
      out += c
      i++
    }
  }
  const key = () => {
    const parts = []
    for (;;) {
      ws()
      if (text[i] === '"' || text[i] === "'") {
        if (text.startsWith(text[i].repeat(3), i)) fail('a multi-line string as a key')
        parts.push(str())
      } else {
        const m = /[A-Za-z0-9_-]+/y
        m.lastIndex = i
        const bare = m.exec(text)
        if (!bare) fail('a key it cannot read')
        parts.push(bare[0])
        i = m.lastIndex
      }
      ws()
      if (text[i] !== '.') return parts
      i++
    }
  }
  // `at` is the value's full key, or null inside an array, where nothing can be cli.use_leader.
  const set = (at, v) => {
    if (!at || at[0] !== 'cli' || at[1] !== 'use_leader') return
    if (at.length > 2 || typeof v !== 'boolean') fail('cli.use_leader set to something other than true or false')
    if (found !== undefined) fail('cli.use_leader set twice')
    found = v
  }
  const value = (at) => {
    ws()
    const c = text[i]
    if (c === '"' || c === "'") { str(); return set(at, 'a string'); }
    if (c === '[') {
      i++
      for (;;) {
        blank()
        if (text[i] === ']') { i++; return set(at, 'an array'); }
        value(null)
        blank()
        if (text[i] === ',') i++
        else if (text[i] !== ']') fail('an array it cannot read')
      }
    }
    if (c === '{') {
      i++
      set(at && at.length >= 2 ? at : null, 'a table')
      for (;;) {
        blank()
        if (text[i] === '}') { i++; return; }
        const k = key()
        ws()
        if (text[i] !== '=') fail('an inline table it cannot read')
        i++
        value(at && [...at, ...k])
        blank()
        if (text[i] === ',') i++
        else if (text[i] !== '}') fail('an inline table it cannot read')
      }
    }
    const m = /[A-Za-z0-9_+\-.:]+(?: [0-9]{2}:[A-Za-z0-9_+\-.:]+)?/y
    m.lastIndex = i
    const scalar = m.exec(text)
    if (!scalar) fail('a value it cannot read')
    i = m.lastIndex
    return set(at, scalar[0] === 'true' ? true : scalar[0] === 'false' ? false : 'a non-boolean')
  }
  try {
    let table = []
    for (;;) {
      blank()
      if (i >= text.length) return { value: found }
      if (text[i] === '[') {
        const many = text[i + 1] === '['
        i += many ? 2 : 1
        table = key()
        if (!text.startsWith(many ? ']]' : ']', i)) fail('a table header it cannot read')
        i += many ? 2 : 1
        if (table[0] === 'cli' && table[1] === 'use_leader') fail('cli.use_leader as a table')
      } else {
        const k = key()
        if (text[i] !== '=') fail('a line that is not a key and value')
        i++
        value([...table, ...k])
      }
      endLine()
    }
  } catch (e) {
    return { unclear: e.message }
  }
}

/**
 * The requirements.toml macOS device management hands grok: the requirements_toml_base64 string in a forced ai.x.grok
 * preference. { text }, null when there is none, or { unclear }. GROK_TEST_MANAGED_PREFS adds a folder to look in
 * (the tests'); it never replaces the system one.
 */
function grokMdmRequirements() {
  let user = process.env.USER
  try { user = userInfo().username; } catch { /* USER stands */ }
  const dirs = ['/Library/Managed Preferences', ...(process.env.GROK_TEST_MANAGED_PREFS ? [process.env.GROK_TEST_MANAGED_PREFS] : [])]
  const out = []
  for (const file of dirs.flatMap((d) => [...(user ? [join(d, user, 'ai.x.grok.plist')] : []), join(d, 'ai.x.grok.plist')])) {
    try { statSync(file); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue; out.push({ file, unclear: `unreadable (${e.code || e.message})` }); continue; }
    const plutil = (args) => spawnSync('/usr/bin/plutil', [...args, '-o', '-', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 })
    let doc = null, v
    const all = plutil(['-convert', 'json'])
    if (!all.error && all.status === 0) try { doc = JSON.parse(all.stdout); } catch { doc = null; }
    if (doc !== null && typeof doc === 'object' && !Array.isArray(doc)) v = doc.requirements_toml_base64
    else {
      // A plist JSON can't hold (a date or data value) still gives up the one key.
      const one = plutil(['-extract', 'requirements_toml_base64', 'json'])
      try { if (one.error || one.status !== 0) throw new Error(); v = JSON.parse(one.stdout); } catch { out.push({ file, unclear: 'plutil could not read it' }); continue; }
    }
    if (v === undefined) continue
    const where = `${file} (requirements_toml_base64)`
    if (typeof v !== 'string' || !/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(v)) { out.push({ file: where, unclear: 'not a base64 string' }); continue; }
    try { out.push({ file: where, text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(v, 'base64')) }); } catch { out.push({ file: where, unclear: 'not UTF-8' }); }
  }
  return out
}

/**
 * Whether grok's leader mode is on: { file } for the layer setting cli.use_leader = true, { file, unclear } for one
 * that can't be read far enough to tell, or null. A leader session runs with the leader's own HOME, so the borrowed
 * servers a temporary HOME keeps out could start where inspect does not look. `cli.use_leader` is a pin: the user,
 * managed and requirements files and the macOS device-management payload all count.
 */
// ask-model's grokLeader, carried here because this runtime is installed alone.
function grokLeader(grokHome) {
  const files = ['config.toml', 'managed_config.toml', 'requirements.toml'].map((f) => join(grokHome, f))
    .concat(['/etc/grok/managed_config.toml', '/etc/grok/requirements.toml'])
  const layers = []
  for (const file of files) {
    try { layers.push({ file, text: readFileSync(file, 'utf8') }); } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') layers.push({ file, unclear: `unreadable (${e.code || e.message})` })
    }
  }
  for (const layer of [...layers, ...grokMdmRequirements()]) {
    if (layer.unclear) return layer
    const r = tomlUseLeader(layer.text)
    if (r.unclear) return { file: layer.file, unclear: r.unclear }
    if (r.value === true) return { file: layer.file }
  }
  return null
}
/**
 * Why grok must not run here, or null: leader mode, or the MCP servers and project hooks `grok inspect --json` says
 * would start under that call's env (--deny MCPTool keeps calls out, but the servers still start). A server named in
 * grokMcpAllow may start only from grok's own config.toml. ask-model's check (tools/ask-model.mjs grokMcpLeft),
 * carried here because this runtime is installed alone. Anything it can't read counts as a refusal.
 */
function grokRefusal(cwd, call) {
  const leader = grokLeader(call.grokHome)
  if (leader) return `${leader.unclear ? `grok's leader mode could not be ruled out (${leader.file}: ${leader.unclear})` : `grok's leader mode is on (use_leader in ${leader.file})`}: a leader session runs with its own HOME, where MCP servers this check cannot see may start, so grok was not run`
  const allow = grokMcpAllow()
  if (allow.error) return `${allow.error}, so grok was not run`
  const r = spawnSync('grok', ['inspect', '--json'], { cwd, env: call.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 })
  if (r.error || r.status !== 0) return `grok inspect failed: ${String(r.error?.message || r.stderr || `exit ${r.status}`).trim().slice(-300)}`
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  let doc
  try { doc = JSON.parse(r.stdout) } catch { return 'grok inspect --json printed no JSON' }
  if (!isObj(doc) || !Array.isArray(doc.mcpServers) || !Array.isArray(doc.plugins)) return 'grok inspect --json has no mcpServers and plugins lists'
  const left = []
  for (const s of doc.mcpServers) {
    if (!isObj(s) || typeof s.name !== 'string' || !s.name) return 'grok inspect --json: an mcpServers entry has no name'
    if (s.compatibilityStatus === 'disabled' || s.enabled === false) continue
    // A listed server may start only from grok's own config.toml: the same name from a project file still refuses.
    if (allow.names.includes(s.name) && isObj(s.source) && s.source.type === 'configToml' && typeof s.source.path === 'string'
      && samePath(s.source.path, join(call.grokHome, 'config.toml'))) continue
    left.push(s.name)
  }
  for (const pl of doc.plugins) {
    if (!isObj(pl) || typeof pl.name !== 'string' || !pl.name) return 'grok inspect --json: a plugins entry has no name'
    const n = isObj(pl.provides) ? pl.provides.mcpServers : undefined
    if (!(Number.isInteger(n) && n >= 0)) return `grok inspect --json: plugin ${pl.name}: provides.mcpServers is not a whole number`
    if (pl.enabled !== false && n > 0) left.push(`${pl.name} (plugin)`)
  }
  if (left.length) return `grok would start MCP servers no flag keeps out of a run (${left.join(', ')}), so grok was not run. ` +
    'Turn them off for grok (`grok mcp disable <name>`, `grok plugin disable <name>`), or list a server grok\'s own config.toml ' +
    'defines in grokMcpAllow to let it start; its tools stay denied.'
  const hooks = (Array.isArray(doc.hooks) ? doc.hooks : []).filter((h) => isObj(h) && isObj(h.source) && h.source.type === 'project' && h.disabled !== true && h.compatibilityStatus !== 'disabled')
  return hooks.length ? `grok would run this project's hooks (${hooks.map((h) => h.source.path ?? '(project)').join(', ')}), so grok was not run` : null
}
const samePath = (a, b) => {
  const real = (p) => { try { return realpathSync(p) } catch { return resolve(p) } }
  return real(a) === real(b)
}
function grokHookFolders(cwd) {
  const real = (p) => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  const top = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  const inRepo = top.status === 0 && !!top.stdout.trim()
  const root = inRepo ? real(top.stdout.trim()) : real(cwd)
  // Outside a repository ~/.grok/hooks are your own hooks. Inside one (a repository at HOME, or one holding it)
  // they are the checkout's, like any other folder on the way up.
  const home = real(homedir())
  const found = []
  for (let dir = real(cwd); ; dir = dirname(dir)) {
    const hooks = join(dir, '.grok', 'hooks')
    if (inRepo || dir !== home) {
      try {
        if (!statSync(hooks).isDirectory() || readdirSync(hooks).length) found.push(hooks)
      } catch (e) {
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') found.push(hooks) // unreadable: assume it holds hooks
      }
    }
    if (dir === root || dirname(dir) === dir) break
  }
  return found
}
function runGrok(m, prompt, schema) {
  const hooks = grokHookFolders(process.cwd())
  if (hooks.length)
    throw new Error(
      `grok review refused: ${hooks.join(', ')} holds Grok hooks, which grok runs on every call in a trusted ` +
        `folder and no flag turns off. Review with another family, or remove that folder from the branch.`,
    )
  // --deny MCPTool keeps MCP calls out, but grok still starts the servers: refuse, as ask-model does, under the very
  // env the call then gets.
  const call = grokRunEnv()
  let r
  try {
    const refusal = grokRefusal(process.cwd(), call)
    if (refusal) throw new Error(`grok review refused: ${refusal}`)
    r = spawnSync('grok', grokArgs(m, prompt, schema), {
      env: call.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 64 * 1024 * 1024,
      ...deadlineOptions(),
    })
  } finally {
    call.done()
  }
  if (r.error || r.status !== 0)
    throw new Error(`grok review failed (exit ${r.status}): ${r.error?.message || String(r.stdout).slice(0, 300)}`)
  return parseGrok(r.stdout)
}

function spawnAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { maxBuffer: 64 * 1024 * 1024 })
    let out = ''
    let err = ''
    if (MODEL_DEADLINE) {
      const timer = setTimeout(() => { try { c.kill('SIGKILL') } catch { /* gone */ } }, Math.max(1, MODEL_DEADLINE - Date.now()))
      c.on('close', () => clearTimeout(timer))
    }
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
    // no --mcp-config loads no MCP servers. A headless run honours the repo's .claude settings, hooks
    // included, so a branch under review could run a command: --setting-sources user loads only your own
    // settings (your login is not a settings file and is still read).
    '--tools',
    'Read,Grep,Glob',
    '--strict-mcp-config',
    '--setting-sources',
    'user',
    '--append-system-prompt',
    `You are a precise ${role}. Report only real defects; do not invent issues.`,
  ])
  const result = parseClaude(out)
  // The model Claude reports it ran as: kept for eval records only.
  if (!EVAL_MODE) return { result }
  let used = []
  try { used = Object.keys(JSON.parse(out)?.modelUsage || {}) } catch { /* parseClaude read it */ }
  return { result, ...(used.length && { modelUsed: used.join(',') }) }
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
      const { result, modelUsed } = await runClaude(
        { id: lens.model, effort: TEAM_EFFORT },
        prompt,
        SCHEMA,
        `${lens.key} code reviewer`,
      )
      if (modelUsed) lens.modelUsed = modelUsed
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
function fileAt(rev, path) {
  const r = spawnSync('git', ['show', `${rev}:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return r.status === 0 ? r.stdout : null
}
// The quote check also settles, once, which repo path a finding means: the path as written (never trimmed),
// else, for a leading a/ or b/ diff prefix, the stripped path. The first candidate that exists decides located
// or not, as before. A located finding yields the candidate that held the quote and the commit it held in; when
// the written and the stripped path both hold it, the finding is ambiguous and yields no path.
function locateQuote(f) {
  if (!String(f.quote ?? '').trim()) return { problem: 'no quote' }
  if (!f.file) return { problem: 'no file' }
  // One line number, or a range "12-15" read as its start. Anything else is not a citation.
  const cited = String(f.line ?? '').trim()
  const lineMatch = cited.match(/^(\d+)(?:\s*[-–]\s*\d+)?$/)
  if (!lineMatch) return { problem: `line "${cited.slice(0, 40)}" is not a line number` }
  let path = String(f.file)
  if (path.startsWith(`${TOP}/`)) path = path.slice(TOP.length + 1)
  path = path.replace(/^\.\//, '')
  const stripped = /^[ab]\//.test(path) ? path.slice(2) : null
  const at = (rev, p) => { const text = fileAt(rev, p); return text == null ? null : { path: p, rev, text } }
  const written = at('HEAD', path) ?? at(DIFF_BASE, path)
  const prefixed = stripped === null ? null : at('HEAD', stripped)
  const decider = written ?? prefixed
  if (!decider) return { problem: `file not found: ${path}` }
  const line = Number(lineMatch[1])
  const norm = (l) => l.replace(/\s+/g, ' ').trim()
  const q = String(f.quote).split('\n').map(norm)
  while (q.length && !q[0]) q.shift()
  while (q.length && !q.at(-1)) q.pop()
  const needle = q.join('\n')
  const starts = []
  const problemIn = ({ text }, keep = false) => {
    const count = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
    // Also bounds the search loop: an unsafe integer (2^53, a 310-digit Infinity) never terminates s++.
    if (!Number.isSafeInteger(line) || line < 1 || line > count)
      return `line ${lineMatch[1].length > 20 ? `${lineMatch[1].slice(0, 20)}…` : lineMatch[1]} is outside ${path} (1–${count})`
    const lines = text.split('\n').map(norm)
    // Every start in the window that holds the quote, so inDiff can judge each place it could mean.
    let found = false
    for (let s = Math.max(1, line - QUOTE_WINDOW); s <= line + QUOTE_WINDOW; s++)
      if (lines.slice(s - 1, s - 1 + q.length).join('\n').includes(needle)) {
        found = true
        if (!keep) break
        starts.push(s)
      }
    return found ? null : `quote not found within ±${QUOTE_WINDOW} lines of ${path}:${line}`
  }
  const problem = problemIn(decider, true)
  if (problem) return { problem }
  if (written && prefixed && !problemIn(prefixed)) return { problem: null, ambiguous: [written.path, prefixed.path] }
  // Every place in the window the quote matched (its lines, and whether in the HEAD or the base file), for inDiff; the cited
  // line itself when none is recorded.
  const spans = (starts.length ? starts : [line]).map((s) => [s, s + q.length - 1])
  return { problem: null, path: decider.path, commit: sh('git', ['rev-parse', '--verify', `${decider.rev}^{commit}`]),
    spans, side: decider.rev === 'HEAD' ? 'head' : 'base' }
}
// The location rides on a Symbol key until the record is written: JSON never carries it, so reviewer JSON
// cannot set it, and the logged finding and FINDINGS_JSON keep their shape. Reviewer keys that look like the
// record's (resolved…) are dropped.
const WHERE = Symbol('where')
function locatedFinding(f) {
  // source marks a security finding; it is this script's to set, never the reviewer's.
  // inDiff is the script's too: set only when a review finding claims preExisting.
  const finding = Object.fromEntries(Object.entries(f).filter(([key]) => !/^resolved/i.test(key) && !['source', 'inDiff'].includes(key)))
  if (finding.preExisting == null) delete finding.preExisting // a strict schema writes "absent" as null
  const given = finding.instances
  delete finding.instances
  delete finding.instancesDropped
  const where = locateQuote(finding)
  if (where.problem) return { ...finding, status: 'unverified-quote', quoteCheck: where.problem }
  // The other places of a grouped finding, each quote-checked like the main one: a located one is kept (its path rides on
  // WHERE like the main one's), an unlocated one is dropped with its problem noted. Only file, line and quote are kept.
  const instances = [], dropped = [], places = []
  for (const raw of Array.isArray(given) ? given : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const place = { file: String(raw.file ?? ''), line: String(raw.line ?? ''), quote: String(raw.quote ?? '') }
    const at = locateQuote(place)
    if (at.problem) dropped.push({ file: place.file, line: place.line, quoteCheck: at.problem })
    else { instances.push(place); places.push(at) }
  }
  return { ...finding, ...(instances.length && { instances }), ...(dropped.length && { instancesDropped: dropped }), status: 'verified-quote',
    [WHERE]: { ...where, instances: places } }
}
// Where a grouped finding also is, for the report, the fix-check note and the summary: "; also at a:1, b:2", or ''.
const alsoAt = (f) => Array.isArray(f.instances) && f.instances.length ? `; also at ${f.instances.map((i) => `${i.file}:${i.line}`).join(', ')}` : ''
function warnDropped(findings) {
  for (const f of findings.filter((f) => f.instancesDropped?.length))
    console.warn(`⚠ ${f.id}: ${f.instancesDropped.length} instance(s) could not be located and were dropped: ${f.instancesDropped.map((d) => `${d.file}:${d.line} (${d.quoteCheck})`).join(', ')}`)
}
// The review and fix-check record fields: resolvedPaths { id: { path, commit } } for located findings,
// ambiguousPaths { id: [paths] }, and instancePaths { id: [paths] } for a grouped finding's located, unambiguous
// instances. Close authorizes a changed file only when it equals a fixed finding's path or one of its instance paths.
function recordedLocations(findings) {
  const resolvedPaths = {}, ambiguousPaths = {}, instancePaths = {}, instanceResolved = {}
  for (const f of findings) {
    if (f[WHERE]?.ambiguous) ambiguousPaths[f.id] = f[WHERE].ambiguous
    else if (f[WHERE]?.path) resolvedPaths[f.id] = { path: f[WHERE].path, commit: f[WHERE].commit }
    const places = f[WHERE]?.instances || []
    const paths = places.map((at) => at.path).filter(Boolean)
    if (paths.length) instancePaths[f.id] = paths
    // Aligned with the finding's instances: { path, commit } like resolvedPaths, or null for an ambiguous one.
    if (places.length) instanceResolved[f.id] = places.map((at) => at.path ? { path: at.path, commit: at.commit } : null)
  }
  return { resolvedPaths, ...(Object.keys(ambiguousPaths).length && { ambiguousPaths }), ...(Object.keys(instancePaths).length && { instancePaths }),
    ...(Object.keys(instanceResolved).length && { instanceResolved }) }
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

// A branch can track `reviews` as a symlink to anywhere; the report and its `latest` link would land there.
function refuseLinkedReviews() {
  let stat
  try {
    stat = lstatSync('reviews')
  } catch (e) {
    if (e.code === 'ENOENT') return
    throw e
  }
  if (stat.isSymbolicLink())
    die('reviews is a symlink, so the report would be written wherever it points. Remove it (git rm reviews) and review again.')
  if (!stat.isDirectory()) die('reviews is not a folder. Remove it and review again.')
}
function writeReport(branch, reviewer, { findings, unlocated, disputed }, diffTruncated, verifier, security = null) {
  if (EVAL_MODE) evalOwnRepo() // the report and the info/exclude edit stay in the eval run's temp repo
  refuseLinkedReviews()
  ensureReviewsIgnored()
  // A random suffix keeps two reviews in the same second (any repo) apart in the folder and the log; the folder is
  // created exclusively, so parallel slices never share one, or a review id.
  mkdirSync('reviews', { recursive: true })
  let ts, dir
  for (;;) {
    ts = `${new Date().toISOString().slice(0, 19).replaceAll(':', '-').replace('T', '-')}-${randomBytes(3).toString('hex')}`
    dir = `reviews/${ts}`
    try {
      mkdirSync(dir)
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
  }
  const head = sh('git', ['rev-parse', 'HEAD'])
  const item = (f, extra = '') =>
    `- [${f.file || '?'}:${f.line || '?'}] ${String(f.issue).replace(/\r?\n|$/, (end) => ` (id ${f.id})${end}`)}` +
    `\n  Score: ${scoreText(f)}${isPreExisting(f) ? ' — pre-existing (not introduced here), no close status needed' : isFiled(f) ? ' — filed, no close status needed' : ''}` +
    `${f.quote ? `\n  > ${String(f.quote).split('\n').join('\n  > ')}` : ''}` +
    `${alsoAt(f) ? `\n  Also at: ${alsoAt(f).slice('; also at '.length)}` : ''}` +
    `${f.suggestion ? `\n  → ${f.suggestion}` : ''}` +
    `${f[WHERE]?.ambiguous ? `\n  Path ambiguous: the quote is in both ${f[WHERE].ambiguous.join(' and ')}, so this finding authorizes no file at close` : ''}${extra}`
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
    (security && security.status !== 'off' ? `${securityLine(security)}\n` : '') +
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
  // A temp link renamed over reviews/latest swaps it atomically; parallel runs race only over which one it names.
  const link = `reviews/.latest-${randomBytes(4).toString('hex')}`
  try {
    symlinkSync(ts, link)
    renameSync(link, 'reviews/latest')
  } catch (e) {
    rmSync(link, { force: true })
    console.warn(`⚠ Could not point reviews/latest at ${ts}: ${e.message}`)
  }
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
// A commit's tree id, or '' when the commit is not in this repository.
const treeOf = (rev) => sh('git', ['rev-parse', '--verify', '--quiet', `${rev}^{tree}`], { allowFailure: true })
// Tree ids for many full commit ids in one git call; a commit missing here maps to nothing.
function treesOf(shas) {
  const unique = [...new Set(shas.filter(fullObjectId))]
  if (!unique.length) return new Map()
  const r = spawnSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: unique.map((sha) => `${sha}^{tree}\n`).join(''), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error || r.status !== 0) throw new Error(`git cat-file --batch-check failed: ${r.error?.message || r.stderr}`)
  const lines = r.stdout.split('\n')
  return new Map(unique.flatMap((sha, i) => {
    const [id, type] = (lines[i] || '').split(' ')
    return type === 'tree' ? [[sha, id]] : []
  }))
}
// Names from git's -z output, byte for byte: never trimmed, and a name whose bytes don't round-trip through
// UTF-8 refuses, since decoding would make it equal to another name (a 0xff byte and U+FFFD both read as U+FFFD).
function nulNames(out, what) {
  const names = []
  for (let start = 0, end; start < out.length; start = end + 1) {
    end = out.indexOf(0, start)
    if (end === -1) end = out.length
    if (end === start) continue
    const bytes = out.subarray(start, end), name = bytes.toString('utf8')
    if (!Buffer.from(name, 'utf8').equals(bytes))
      throw new Error(`${what} lists a file name that is not valid UTF-8 (bytes ${bytes.toString('hex')}); the gate compares exact names, so it refuses. Rename the file to valid UTF-8.`)
    names.push(name)
  }
  return names
}
// Files changed between two commits (the net diff), limited to pathspecs that resolve from the top of the work tree.
function filesBetween(a, b, paths = null) {
  const r = spawnSync('git', ['-C', TOP, 'diff', '--name-only', '--no-renames', '-z', a, b, ...pathspec(paths)], { maxBuffer: 64 * 1024 * 1024 })
  if (r.error || r.status !== 0) throw new Error(`git diff --name-only ${a} ${b}${sliceSuffix(paths)} failed: ${r.error?.message || r.stderr}`)
  return nulNames(r.stdout, `git diff --name-only ${a} ${b}`)
}
// Every path some commit in a..b touched, merge-parent diffs included, so a change reverted later still counts.
// Commits on the default branch don't count, and a merge of it counts only for its branch-side files (branchPaths).
// `based` false (a review not based on the default branch): the old rule, every commit and every merge-parent diff.
const touchedBetween = (a, b, paths = null, based = true) => [...new Set((based ? branchCommits : commitsIn)([`${a}..${b}`])
  .flatMap((commit) => based ? branchPaths(commit, paths) : commitPaths(commit, paths)))].sort()
const isTestFile = (p) => /(^|\/)(test|tests|__tests__|__snapshots__)\//.test(p) || /\.(test|spec)\.[^/]+$|\.snap$/.test(p) || /(^|\/)(vitest|jest|playwright)\.config\.[^/]+$/.test(p)
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
    // A strict structured-output schema (codex) writes an optional field as null: null file, line or severity is absent.
    if (finding && typeof finding === 'object') for (const key of ['file', 'line', 'severity']) if (finding[key] === null) delete finding[key]
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
    base: original?.head || BASE, baseSha: original?.head || sh('git', ['merge-base', '--end-of-options', BASE, head]), repo: repoName(), repoId, copy: COPY_PATH,
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
// The files that make a fix check due under fixCheck "always": anything but builds/, docs, static and coverage-exempt files.
const codeFixFiles = (files) => files.filter((p) => !p.startsWith('builds/') && !['docs', 'static'].includes(fileKind(p)) && !coverageExempt(p))
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
// Deferral files what the one fix check or the one recheck left: only that check's own findings (x…, r…), or a Grade
// criterion still failing in its recheck. It needs a reason, keeps the reviewer's score, and an original finding
// can't be deferred.
function validateDeferral(entries, review, f, status) {
  const later = review.kind === 'fix-check' || review.kind === 'recheck'
  if (!later && !(review.kind === 'grade' && f.criterionId))
    throw new Error(`Finding ${f.id} is from the original ${review.kind === 'grade' ? 'Grade' : 'review'}; only findings a fix check or recheck raised, or a criterion still failing after its recheck, may be deferred`)
  if (Object.keys(status).some((key) => !['status', 'reason', 'fix'].includes(key)))
    throw new Error(`Unknown status field for ${f.id}; reviewer severity cannot be changed`)
  if (typeof status.reason !== 'string' || !status.reason.trim()) throw new Error(`Deferred ${f.id} requires a nonempty reason`)
  if (Object.hasOwn(status, 'fix') && (typeof status.fix !== 'string' || !status.fix.trim())) throw new Error(`Deferred ${f.id} fix idea must be nonempty text when given`)
  if (later) return
  const recheck = entries.find((e) => e.type === 'review' && e.kind === 'recheck' && e.review === review.id)
  const criterion = recheck?.criteria?.find((c) => c.id === f.criterionId)
  if (!criterion) throw new Error(`Deferred criterion ${f.id} needs its one recheck first`)
  if (criterion.verdict !== 'FAIL') throw new Error(`Criterion ${f.id} passed its recheck; mark it fixed rather than deferred`)
}
// A fixed status's optional `test`: a nonempty relative path that stays inside the repository.
const repoRelativePath = (p) => typeof p === 'string' && !!p.trim() && p === p.trim() && !p.startsWith('/') && !/^[a-z]:/i.test(p) &&
  !/[\0\n\r]/.test(p) && !p.split(/[\\/]/).includes('..')
// Response labels on a close status: fixed → real | unimportant (fixed though not worth it); rejected → wrong | intentional.
const RESPONSES = { fixed: ['real', 'unimportant'], rejected: ['wrong', 'intentional'] }
const RESPONSE_REQUIRED = true
function validateStatuses(entries, review, statuses) {
  for (const f of review.findingDetails) {
    const status = statuses[f.id]
    const rules = resolutionRules(review, f)
    if (!status && !rules.status) continue
    if (status?.status === 'deferred') {
      validateDeferral(entries, review, f, status)
      continue
    }
    if (!status || !['fixed', 'rejected'].includes(status.status))
      throw new Error(`Finding ${f.id} needs a fixed or rejected status${review.kind === 'fix-check' || review.kind === 'recheck' ? ', or deferred with a reason' : ''}`)
    if (Object.keys(status).some((key) => !['status', 'reason', 'evidence', 'refutedBy', 'response', ...(status.status === 'fixed' ? ['test'] : [])].includes(key)))
      throw new Error(`Unknown status field for ${f.id}; reviewer severity cannot be changed`)
    // What the finding turned out to be, for --noise-report. A label only: a rejection still needs its REFUTED or waiver.
    const labels = RESPONSES[status.status]
    if (Object.hasOwn(status, 'response') && !labels.includes(status.response))
      throw new Error(`${status.status === 'fixed' ? 'Fixed' : 'Rejected'} ${f.id} response must be ${labels.join(' or ')}`)
    if (RESPONSE_REQUIRED && status.status === 'rejected' && !Object.hasOwn(status, 'response'))
      throw new Error(`Rejected ${f.id} needs a response: wrong (not a defect) or intentional (the behavior is meant)`)
    if (Object.hasOwn(status, 'test') && !repoRelativePath(status.test))
      throw new Error(`Fixed ${f.id} test must be a repo-relative path to the test that reproduces it`)
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
// The exact paths fixed findings recorded when their quotes were checked. A finding without one (legacy,
// unlocated, ambiguous, or a Grade finding, which has no quote) authorizes no file.
const recordedPaths = (reviews, statuses) => new Set(reviews.flatMap((r) => r.findingDetails
  .filter((f) => statuses[f.id]?.status === 'fixed')
  .flatMap((f) => [r.resolvedPaths && Object.hasOwn(r.resolvedPaths, f.id) ? r.resolvedPaths[f.id]?.path : null,
    ...(r.instancePaths && Object.hasOwn(r.instancePaths, f.id) && Array.isArray(r.instancePaths[f.id]) ? r.instancePaths[f.id] : [])])
  .filter((path) => typeof path === 'string' && path)))
function slicedScope(review, matched, changed) {
  const scope = new Set([...matched, ...sliceFiles(review)])
  return changed.filter((p) => scope.has(p))
}
// What the review saw the size cap cut. A record from before `truncated` was logged has its diff measured again:
// over the cap, nothing it saw counts (null). A Grade inlines no diff.
function reviewTruncated(review) {
  if (Array.isArray(review.truncated)) return new Set(review.truncated)
  if (review.kind === 'grade') return new Set()
  const paths = sliceOf(review)
  const r = spawnSync('git', [...(paths ? ['-C', TOP] : []), 'diff', `${review.baseSha}...${review.head}`, ...pathspec(paths)], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return r.error || r.status !== 0 || r.stdout.trim().length > DIFF_CAP ? null : new Set()
}
// A fix check logged before `noRenames` saw a moved or copied file as a short rename section, not its content: those
// destinations count as cut. Needs the check's baseSha (its original's head).
function renamedInCheck(check) {
  if (check.noRenames === true) return []
  const paths = sliceOf(check)
  const r = spawnSync('git', [...(paths ? ['-C', TOP] : []), 'diff', '-M', '-C', '--name-status', '-z', `${check.baseSha}..${check.head}`, ...pathspec(paths)], { maxBuffer: 64 * 1024 * 1024 })
  if (r.error || r.status !== 0) throw new Error(`git diff --name-status ${check.baseSha}..${check.head} failed: ${r.error?.message || r.stderr}`)
  const fields = nulNames(r.stdout, `git diff --name-status ${check.baseSha}..${check.head}`), moved = []
  for (let i = 0; i < fields.length;) {
    const status = fields[i]
    if (/^[RC]/.test(status)) { moved.push(fields[i + 2]); i += 3 } else i += 2
  }
  return moved
}
// What a fix check saw in full: its fix diff's files minus the ones the cap cut (`cut`, every fix-diff file when that
// can't be told). A file it saw is in scope at close; seeing a later change never covers a part the review missed.
function fixCheckSeen(check) {
  if (!check) return { seen: new Set(), cut: new Set(), left: new Set() }
  const all = fullObjectId(check.baseSha) && treeOf(check.baseSha) ? filesBetween(check.baseSha, check.head, sliceOf(check)) : null
  // A fix check at a merge of the default branch saw only its branch-side files.
  const files = all && Array.isArray(check.onlyFiles) ? all.filter((p) => check.onlyFiles.includes(p)) : all
  const left = new Set(all && Array.isArray(check.onlyFiles) ? all.filter((p) => !check.onlyFiles.includes(p)) : [])
  const measured = files && reviewTruncated(check)
  const cut = measured && new Set([...measured, ...renamedInCheck(check)])
  return cut ? { seen: new Set(files.filter((p) => !cut.has(p))), cut, left } : { seen: new Set(), cut: files ? new Set(files) : null, left }
}
// A complete close vouches for the state at its head of the review's files (the slice's recorded files, or the net diff
// from baseSha) and of every file it accepted since, minus any file the cap cut in the review or in the fix check.
// Coverage the close can't establish is [] (a slice without files, an over-cap legacy diff, a fix check whose cut is
// unknown and that changed files since). Only a review from before baseSha was logged gives null: no field, the old rule.
function closeCoverage(review, since, check, head, recheck = null, held = new Set()) {
  const paths = sliceOf(review)
  if (!paths && !fullObjectId(review.baseSha)) return null
  if (paths ? !Array.isArray(review.files) : !treeOf(review.baseSha)) return []
  const truncated = reviewTruncated(review), { cut, left, seen } = fixCheckSeen(check)
  if (!truncated || !cut && since.length) return []
  const reviewed = paths ? sliceFiles(review) : filesBetween(review.baseSha, review.head)
  // Never a file a merge of the default branch changed on the branch's side unless a record after that merge saw it
  // (`held`), never what a merge-tip fix check left out, nor a file whose state at HEAD is the default branch's unless a record saw
  // that very state (the review, the fix check or the Grade's recheck): a fixed status alone vouches for no merge
  // content, and a push to origin needs no coverage for it while any other push still does.
  const base = coverBase(review, head), stateAt = (commit, p) => treeStates(commit).get(p) ?? null
  const reviewedSet = new Set(reviewed)
  const sawAt = (record, files, p) => !!record && files.has(p) && stateAt(record.head, p) === stateAt(head, p)
  const saw = (p) => sawAt(review, reviewedSet, p) || sawAt(check, seen, p) || sawAt(recheck?.record, recheck?.files || new Set(), p)
  const onMain = (p) => base !== review.baseSha && stateAt(base, p) === stateAt(head, p) && !saw(p)
  return coverageOf(head, [...reviewed, ...since].filter((p) => !truncated.has(p) && !cut?.has(p) && !left.has(p) && !held.has(p) && !onMain(p)))
}
// ── merge tier (report only: nothing merges, comments or labels) ────────────
// Rules first: HIGH on a riskPaths or always-human file, a deferred HIGH or protected finding, a partial close or
// --no-tests; LOW when nothing is deferred (filed findings left unfixed count) and no logic or other-kind file changed;
// MEDIUM otherwise. merge.classifier may move a MEDIUM, and only a MEDIUM, to LOW at confidence ≥ merge.threshold.
const ALWAYS_HUMAN = ['.github/workflows/**', 'package.json']
const TIER_RANK = { low: 0, medium: 1, high: 2 }
const listed = (paths) => `${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ` and ${paths.length - 5} more` : ''}`
// The tier's stats: recordStats, except that a rename counts as the worse kind of its two names, so logic moved under
// tests/ or docs/ is still logic. Review records keep recordStats.
const KIND_RANK = ['tests', 'docs', 'static', 'other', 'logic']
const worseKind = (f) => pathsOf(f).map(fileKind).reduce((a, b) => KIND_RANK.indexOf(b) > KIND_RANK.indexOf(a) ? b : a)
function tierStats(diff) {
  if (!diff) return null
  const kinds = { static: 0, docs: 0, tests: 0, logic: 0, other: 0 }
  let logicLines = 0
  for (const f of diff.files) {
    const kind = worseKind(f)
    kinds[kind]++
    if (kind === 'logic') logicLines += f.added + f.removed
  }
  return { files: diff.filesChanged, linesAdded: diff.linesAdded, linesRemoved: diff.linesRemoved, kinds, logicLines }
}
// HIGH by path: riskPaths and always-human, on both names of a rename.
function pathReasons(diff) {
  const paths = [...new Set(diff.files.flatMap(pathsOf))]
  const reasons = []
  const risky = paths.filter((p) => matchesAny(p, RISK_PATHS))
  if (risky.length) reasons.push(`riskPaths: ${listed(risky)}`)
  const human = paths.filter((p) => matchesAny(p, [...ALWAYS_HUMAN, ...MERGE.alwaysHuman]))
  if (human.length) reasons.push(`always human: ${listed(human)}`)
  return reasons
}
// HIGH by the security pass: required and it did not run (failed or skipped), or it was off or not required at review
// while the security pass is on now and the close diff (base to the closing HEAD) would require it.
// A pass that ran covers only the file states it saw: a logic, other-kind or riskPaths file whose state at the closing HEAD
// differs (changed by fix commits, say) is HIGH. A fix check is not a security pass and covers nothing here.
function securityReasons(review, diff, head) {
  const sec = review.security
  if (sec?.status === 'failed' || sec?.status === 'skipped') return [`security pass ${sec.status}${sec.reason ? `: ${sec.reason}` : ''}`]
  if (SECURITY.run === 'off' || !diff) return []
  if (sec?.status === 'ran') {
    const saw = new Map(Array.isArray(sec.saw) ? sec.saw.filter((e) => Array.isArray(e) && typeof e[0] === 'string') : [])
    const states = treeStates(head)
    const unseen = diff.files.filter((f) => pathsOf(f).some(securityRelevant)).map((f) => f.path)
      .filter((p) => !saw.has(p) || saw.get(p) !== (states.get(p) ?? null))
    return unseen.length ? [`security pass did not see ${listed(unseen)} (changed after review)`] : []
  }
  const need = securityNeed(diff)
  if (!need.required) return []
  if (review.kind === 'grade') return ['no security pass ran (Grade-only close; run /pr-review for the security pass)']
  return [`security pass did not cover logic changed after review (${sec?.status ?? 'not recorded'} at review; ${need.why})`]
}
// HIGH and not-LOW by deferred findings: a deferred HIGH (a deferred criterion is HIGH) or protected one is HIGH.
function deferredReasons(deferred) {
  const high = [], ids = (list) => list.map((f) => f.id).join(', ')
  const deferredHigh = deferred.filter((f) => f.severity === 'high')
  if (deferredHigh.length) high.push(`deferred HIGH: ${ids(deferredHigh)}`)
  const deferredProtected = deferred.filter((f) => f.protected === true)
  if (deferredProtected.length) high.push(`deferred protected: ${ids(deferredProtected)}`)
  return { high, medium: deferred.length ? [`deferred: ${ids(deferred)}`] : [] }
}
function closeTier({ review, reviews, statuses, files, outOfScope, noTests, head }) {
  const base = fullObjectId(review.baseSha) ? coverBase(review, head) : review.base || BASE
  const diff = diffStats(`${base}...${head}`, sliceOf(review))
  const stats = tierStats(diff)
  const findings = reviews.flatMap((r) => r.findingDetails || [])
  const deferred = findings.filter((f) => statuses[f.id]?.status === 'deferred' || isFiled(f) && !isPreExisting(f) && statuses[f.id]?.status !== 'fixed')
  const high = []
  if (!diff) high.push('the diff could not be read, so its paths are unchecked')
  if (diff) high.push(...pathReasons(diff))
  high.push(...securityReasons(review, diff, head))
  high.push(...deferredReasons(deferred).high)
  // A known exploit the branch did not introduce never blocks the close, but no agent merges past it.
  const preProtected = findings.filter((f) => isPreExisting(f) && f.protected === true && statuses[f.id]?.status !== 'fixed')
  if (preProtected.length) high.push(`pre-existing protected: ${preProtected.map((f) => f.id).join(', ')}`)
  if (outOfScope.length) high.push(`close partial: ${outOfScope.length} file(s) out of scope`)
  if (noTests !== null) high.push(`tests did not run (--no-tests: ${noTests})`)
  const facts = { paths: diff ? diff.files.map((f) => f.path) : [], files, stats, deferred }
  if (high.length) return { tier: 'high', reasons: high, stats, facts }
  const { kinds, logicLines } = stats
  if (!kinds.logic && !kinds.other && !deferred.length)
    return { tier: 'low', stats, facts, reasons: [`no logic or other files changed (docs ${kinds.docs}, tests ${kinds.tests}, static ${kinds.static})`, 'nothing deferred', 'complete close, tests passed'] }
  const medium = []
  if (kinds.logic) medium.push(`logic changed: ${logicLines} line(s) in ${kinds.logic} file(s)`)
  if (kinds.other) medium.push(`${kinds.other} other file(s) changed (config, lockfiles or unknown kinds)`)
  medium.push(...deferredReasons(deferred).medium)
  return { tier: 'medium', reasons: medium, stats, facts }
}
// The optional tier classifier: the command contract of `classifier` (--json-out, a JSON payload on stdin, one choice
// answer). Any failure is { error }, and the rules' tier stands.
async function tierClassifier(command, { stats, facts }, review) {
  const name = basename(command)
  const payload = {
    state: {
      task: 'Decide the merge tier of a reviewed and closed change. Rules already ruled out HIGH; answer whether it is LOW or stays MEDIUM.',
      rules: {
        high: 'Any changed file on riskPaths or always-human paths, any deferred HIGH or protected finding, a partial close, or tests that did not run. Already excluded here.',
        low: 'Nothing deferred and no logic changed: docs, tests and static files only. A human review adds little.',
        medium: 'Anything else: logic or config changed, or findings were deferred. A human should look before merging.',
      },
      facts: {
        paths: facts.paths, kinds: stats.kinds, stats,
        findings: facts.findings, deferred: facts.deferred.map((f) => f.id),
        intent: Object.hasOwn(review, 'intent') ? review.intent : INTENT || null, plan: review.plan ?? null,
      },
    },
    questions: {
      tier: {
        type: 'choice',
        instructions: 'Is this change LOW risk to merge (as safe as a docs-only change), or does it stay MEDIUM?',
        criteria: {
          low: 'The change cannot plausibly break behavior: no deferred findings, and the logic it touches is trivial, mechanical or unreachable in normal use',
          medium: 'The change could plausibly break behavior, or something about it needs a human to judge',
        },
      },
    },
  }
  // REVIEW_TEST_CLASSIFIER_TIMEOUT_MS: a test seam for this call only, so the timeout path can run in seconds.
  const testTimeout = Number(process.env.REVIEW_TEST_CLASSIFIER_TIMEOUT_MS)
  const r = await runBounded(command, ['--json-out'], { input: JSON.stringify(payload), ...(testTimeout > 0 && { timeoutMs: testTimeout }) })
  if (r.error) return { name, error: r.error }
  if (r.code !== 0) return { name, error: (r.stderr || '').trim().split('\n')[0] || `${name} exited ${r.code ?? r.signal}` }
  let answer
  try { answer = JSON.parse(r.stdout)?.answers?.tier } catch { return { name, error: `unparseable ${name} output: ${String(r.stdout).slice(0, 200)}` } }
  const confidence = Number(answer?.confidence)
  if (answer?.type !== 'choice' || !answer.choice) return { name, error: `no tier choice in ${String(r.stdout).slice(0, 200)}` }
  const probabilities = answer.probabilities && typeof answer.probabilities === 'object' && !Array.isArray(answer.probabilities) ? answer.probabilities : {}
  const choice = String(answer.choice).toLowerCase()
  if (!['low', 'medium'].includes(choice)) return { name, error: `choice ${JSON.stringify(answer.choice)} is not low|medium`, probabilities }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return { name, error: `confidence ${JSON.stringify(answer.confidence)} is not a number from 0 to 1`, probabilities }
  return { name, choice, confidence, probabilities }
}
async function mergeTier(input) {
  const result = closeTier(input)
  result.facts.findings = input.reviews.flatMap((r) => (r.findingDetails || []).map((f) => ({ id: f.id, severity: f.severity ?? null, risk: f.risk ?? null,
    likelihood: f.likelihood ?? null, impact: f.impact ?? null, protected: f.protected ?? null, filed: f.filed === true, status: input.statuses[f.id]?.status ?? null })))
  const out = { stats: result.stats, tier: result.tier, tierReasons: result.reasons, tierBy: 'rules' }
  // LOW means nothing deferred: with anything deferred the classifier is not asked and MEDIUM stands.
  if (result.tier !== 'medium' || !MERGE.classifier || result.facts.deferred.length) return out
  const asked = await tierClassifier(MERGE.classifier, result, input.review)
  out.tierClassifier = asked
  if (!asked.error && asked.choice === 'low' && asked.confidence >= MERGE.threshold) {
    out.tier = 'low'
    out.tierBy = 'classifier'
    out.tierReasons = [...result.reasons, `classifier ${asked.name}: low at ${asked.confidence} (threshold ${MERGE.threshold})`]
  }
  return out
}
// The summary's tier line: the worst tier of the closes that cover the tip, then the summary's own rules, which see the
// whole branch: riskPaths and always-human on every file the tip changes against base (a file covered only by a clean
// fix check included), and every deferred finding the summary lists (earlier closes' included). Their reasons replace
// the closes' reasons of the same kind. A close logged before tiers counts as HIGH beside tiered ones; when none has a
// tier the summary prints no line, exactly as before.
const BRANCH_REASON = /^(riskPaths|always human|deferred( HIGH| protected)?|pre-existing protected): |^nothing deferred$/
// Files the tip changes that no close's own diff judged (covered by a clean fix check, say): their kinds count here,
// so logic or another kind keeps the summary from LOW and anything but docs or tests fails strict. A close's own files
// keep its tier, so a classifier's LOW stands, but only while the file's state at the tip (mode and blob, or absent) is
// the state at the close's head: a later edit is unjudged. builds/ is skipped, as in contentCover.
function unjudgedStats(entries, closes, diff, tip) {
  const files = diff.files.filter((f) => !pathsOf(f).every((p) => p.startsWith('builds/')))
  const unjudged = (list) => ({ ...tierStats({ ...diff, files: list }), paths: list.map((f) => f.path) })
  const judged = new Set(), now = treeStates(tip)
  for (const close of closes) {
    const review = entries.find((e) => e.type === 'review' && e.id === close.review)
    const base = review && fullObjectId(review.baseSha) && coverBase(review, close.closeHead)
    const own = base && diffStats(`${base}...${close.closeHead}`, sliceOf(review))
    if (!own) return unjudged(files) // a close whose diff can't be read judged nothing for sure
    const then = treeStates(close.closeHead), before = treeStates(base)
    // A path absent at the close's head and at the tip matches only as a deletion: present at the review's base.
    const same = (p) => then.has(p) || now.has(p) ? then.get(p) === now.get(p) : before.has(p)
    for (const f of own.files) for (const p of pathsOf(f)) if (same(p)) judged.add(p)
  }
  return unjudged(files.filter((f) => pathsOf(f).some((p) => !judged.has(p))))
}
// The tip's tier as data: { tier, reasons, policy, merges, docsTestsOnly }. tier is null when no close has one (then
// the summary prints no tier line, and nothing merges).
// preExisting: the branch-wide unfixed pre-existing findings the summary lists; a protected one keeps the tip HIGH whichever
// closes still cover it.
function tipTier(closes, { entries, base, tip, deferred, preExisting = [] }) {
  if (!closes.some((c) => c.tier))
    return { tier: null, reasons: closes.map((c) => `the close of review ${c.review} has no merge tier (logged before tiers)`), policy: MERGE.policy, merges: false, docsTestsOnly: false }
  const tiers = closes.map((c) => c.tier ? c : { tier: 'high', tierReasons: [`the close of review ${c.review} has no merge tier (logged before tiers)`] })
  const closesWorst = tiers.reduce((w, c) => TIER_RANK[c.tier] > TIER_RANK[w] ? c.tier : w, 'low')
  const diff = base ? diffStats(`${base}...${tip}`) : null
  const { high, medium } = deferredReasons(deferred)
  const preProtected = preExisting.filter((f) => f.protected === true)
  if (preProtected.length) high.push(`pre-existing protected: ${preProtected.map((f) => f.id).join(', ')}`)
  high.unshift(...(diff ? pathReasons(diff) : ['the diff from base could not be read, so its paths are unchecked']))
  const unjudged = diff && unjudgedStats(entries, closes, diff, tip)
  if (unjudged?.kinds.logic || unjudged?.kinds.other) {
    const shown = unjudged.paths.filter((p) => ['logic', 'other'].includes(fileKind(p)))
    medium.unshift(`changed outside the closes' own diffs (logic ${unjudged.kinds.logic}, other ${unjudged.kinds.other}): ${listed(shown.length ? shown : unjudged.paths)}`)
  }
  const branchTier = high.length ? 'high' : medium.length ? 'medium' : 'low'
  const worst = TIER_RANK[branchTier] > TIER_RANK[closesWorst] ? branchTier : closesWorst
  const own = TIER_RANK[closesWorst] === TIER_RANK[worst] ? [...new Set(tiers.filter((c) => c.tier === worst).flatMap((c) => c.tierReasons || []))] : []
  const kept = own.filter((r) => !BRANCH_REASON.test(r))
  const branch = worst === 'high' ? [...high, ...medium] : medium
  let reasons = [...kept, ...branch]
  if (worst === 'low') reasons = own
  else if (!reasons.length) reasons = own
  const docsTestsOnly = closes.every((c) => c.stats?.kinds && !c.stats.kinds.logic && !c.stats.kinds.other && !c.stats.kinds.static) &&
    !!unjudged && !unjudged.kinds.logic && !unjudged.kinds.other && !unjudged.kinds.static
  const merges = { off: false, strict: worst === 'low' && docsTestsOnly, standard: worst === 'low', always: worst !== 'high' }[MERGE.policy]
  return { tier: worst, reasons, policy: MERGE.policy, merges, docsTestsOnly }
}
const tierLines = (t) => t.tier ? [`Merge tier: ${t.tier.toUpperCase()} (${t.reasons.join('; ')}). Policy ${t.policy}: ${t.merges ? 'would merge' : 'needs a human'}`] : []
// A summary: the PR-body text and the tip's tier it prints, with the base and the deferred finding ids it counts.
const summaryOf = (text, tier, base, items, review) => ({ text, tier, base, baseRef: review.base ?? null, deferred: items.map((f) => f.id) })
async function closeReview(id) {
  requireClean()
  const entries = readLog()
  const review = loggedReview(entries, id)
  if (review.kind === 'fix-check' || review.kind === 'recheck') throw new Error('Close the original review, including its fix-check or recheck statuses')
  const head = headNow()
  const check = entries.find((e) => e.type === 'review' && e.kind === 'fix-check' && e.review === id)
  const recheck = entries.find((e) => e.type === 'review' && e.kind === 'recheck' && e.review === id)
  // A history rewrite (squash, split, rebase) keeps the review, fix check and recheck when HEAD has the exact tree of
  // their heads: HEAD and any of those heads with its tree are equivalent. Each check is held to the first equivalent
  // that descends from its head (HEAD's own history first), and one other than HEAD is logged as carried.
  const logged = [check, recheck, review].filter(Boolean)
  const behind = logged.filter((r) => !isAncestor(r.head, head))
  const tree = behind.length ? treeOf(head) : ''
  const equivalents = [head, ...new Set(behind.map((r) => r.head).filter((h) => treeOf(h) === tree))]
  const reach = (from) => equivalents.find((e) => isAncestor(from, e)) || null
  const at = reach(review.head), checkAt = check && reach(check.head), recheckAt = recheck && reach(recheck.head)
  const [carried, ...carriedAlso] = [...new Set([at, recheckAt, checkAt].filter((e) => e && e !== head))].map((e) => {
    const source = logged.find((r) => r.head === e)
    return { from: e, kind: source.kind || 'review', record: source.id, tree }
  })
  if (!at) throw new Error('HEAD is neither the reviewed commit nor a descendant, and its tree is not the exact tree of the review, fix-check or recheck head; a rewritten branch with any other tree needs a fresh review')
  const statusPath = option('--status')
  if (!statusPath) throw new Error('--close requires --status <file.json>')
  const statuses = JSON.parse(readFileSync(statusPath, 'utf8'))
  if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) throw new Error('Statuses must be an object keyed by finding id')
  // A sliced review answers for the files it recorded, plus anything its paths match now (stricter only);
  // changes outside both belong to other slices, and a new file in no slice's list blocks at the gate.
  const paths = sliceOf(review), based = defaultBased(review)
  const files = paths ? slicedScope(review, touchedBetween(review.head, at, paths, based), touchedBetween(review.head, at, null, based))
    : touchedBetween(review.head, at, null, based)
  // After a merge of the default branch, a file whose state at HEAD is the merge base's is the default branch's own content.
  const mergeBase = coverBase(review, head), stateAt = (commit, p) => treeStates(commit).get(p) ?? null
  const mainContent = (p) => mergeBase !== review.baseSha && stateAt(mergeBase, p) === stateAt(head, p)
  // Brought back to main's existing content by a merge of the default branch in from..to, with no branch commit after
  // that merge touching it: a deletion, or a later commit restoring main's version, never qualifies.
  // `deletions` true also accepts a file main's merge deleted (scope only; never for skipping a fix check).
  const mergedToMain = (from, to, deletions = false) => {
    if (!based || mergeBase === review.baseSha) return () => false
    const { mergedLast } = rangeTouch(from, to)
    return (p) => mergedLast(p) && (deletions || stateAt(mergeBase, p) !== null) && mainContent(p)
  }
  const command = blankCommand(option('--test-cmd')) ? VERIFY_CMD : option('--test-cmd')
  const noTests = option('--no-tests')
  if (noTests !== null && !noTests.trim()) throw new Error('--no-tests requires a nonempty reason')
  if (command && noTests !== null) throw new Error('Use a test command or --no-tests, not both')
  if (!command && noTests === null) throw new Error('No test command configured; use --test-cmd or --no-tests "reason"')
  if (recheck && !recheckAt) throw new Error('Closing HEAD must include the recheck head')
  // Fixes land before the fix check: after it, commits may touch only builds/ and test files (in the slice, when
  // sliced), and the full tests run below. Nothing re-runs a model.
  if (check && check.head !== checkAt) {
    if (!checkAt)
      throw new Error(`Fix check head ${check.head} is not an ancestor of closing HEAD (the branch was rewritten after it). Unresolved work goes to the operator, no third model pass`)
    const since = paths ? slicedScope(review, touchedBetween(check.head, checkAt, paths, based), touchedBetween(check.head, checkAt, null, based))
      : touchedBetween(check.head, checkAt, null, based)
    const toMain = mergedToMain(check.head, checkAt)
    const code = since.filter((p) => !isTestFile(p) && !p.startsWith('builds/') && !toMain(p))
    const sides = code.length && based ? baseMergeSides([`${check.head}..${checkAt}`]) : new Set()
    if (code.length && code.every((p) => sides.has(p)))
      throw new Error(`The merge of the default branch after the fix check left ${code.join(', ')} for review: ${sidesNote(code, id)}. No third model pass`)
    if (code.length) throw new Error(`Fix check head must equal closing HEAD, or the commits after it may touch only builds/ and test files: ${code.join(', ')}. ` +
      'Fixes land before the fix check; close at its head, then review the later files as a slice (REVIEW_PATHS) and close that at the tip. No third model pass')
  }
  // "risk": tests, verify scripts and riskPaths files need a fix check (no exclusions). "always" adds every other file but
  // builds/, docs, static and coverage-exempt ones, so it is never looser; under it a Grade's one recheck counts as the
  // check only when nothing the rules count changed after the recheck's head. What a merge brought back to the default
  // branch's own content is not the fix: it never asks for a fix check (which would leave it out anyway).
  const ruleCommand = [command, VERIFY_CMD].filter(Boolean).join(' ')
  const due = (list) => FIX_CHECK === 'always' ? { risk: needsFixCheck(list, ruleCommand), code: codeFixFiles(list) } : { risk: needsFixCheck(list, ruleCommand), code: [] }
  const toMain = mergedToMain(review.head, at)
  const need = due(files.filter((p) => !toMain(p)))
  const recheckToMain = FIX_CHECK === 'always' && review.kind === 'grade' && recheck ? mergedToMain(recheck.head, recheckAt) : null
  const after = recheckToMain ? due(touchedBetween(recheck.head, recheckAt, null, based).filter((p) => !recheckToMain(p))) : null
  const recheckCovers = !!after && !after.risk && !after.code.length
  if (!check && !recheckCovers && need.code.length)
    throw new Error(`Fix changes code after the review and fixCheck is "always": ${listed(need.code)}; run --fix-check first ` +
      '(docs, static, coverage-exempt and builds/ files never need one)')
  if (!check && !recheckCovers && need.risk) throw new Error('Fix changes tests, verify scripts or risk paths; run --fix-check first')
  const reviews = [review, ...(recheck ? [recheck] : []), ...(check ? [check] : [])]
  const ids = new Set(reviews.flatMap((r) => r.findingDetails.map((f) => f.id)))
  for (const key of Object.keys(statuses)) if (!ids.has(key)) throw new Error(`Unknown finding status key: ${key}`)
  for (const r of reviews) validateStatuses(entries, r, statuses)
  // A fix logged without a label was real; only closes logged before labels existed count as unlabeled.
  for (const status of Object.values(statuses)) if (status?.status === 'fixed' && !Object.hasOwn(status, 'response')) status.response = 'real'
  const fixedFiles = recordedPaths(reviews, statuses)
  // The single recheck graded the fix round's files: a criterion fixed on its PASS, or deferred after its FAIL, covers them.
  const rechecked = (f, verdict) => recheck.criteria.some((c) => c.id === f.criterionId && c.verdict === verdict)
  const recheckSaw = new Set(review.kind === 'grade' && recheck && review.findingDetails.some((f) => f.criterionId &&
    (statuses[f.id]?.status === 'fixed' && rechecked(f, 'PASS') || statuses[f.id]?.status === 'deferred' && rechecked(f, 'FAIL')))
    ? filesBetween(review.head, recheck.head) : [])
  for (const path of recheckSaw) fixedFiles.add(path)
  // A file the fix check saw in full was reviewed, so a fix to a sibling file it saw is in scope.
  const { seen } = fixCheckSeen(check)
  // What a merge of the default branch changed on the branch's side (both sides, or an edit in the merge commit) is in
  // scope only as the default branch's own content (its state at HEAD is the merge base's), or when a fix check after
  // the merge (or the Grade's recheck after it) saw its state at HEAD. A fixed status, a pre-merge fix check or the
  // test-file rule never covers it.
  const merges = based ? branchCommits(['--merges', `${review.head}..${at}`]).filter((m) => baseMergeParents(m)) : []
  const byMerge = new Map(merges.map((m) => [m, new Set(branchPaths(m))]))
  const touchingOf = (p) => merges.filter((m) => byMerge.get(m).has(p))
  // Seen after every merge that touched it, at its state at HEAD, by the fix check or the Grade's recheck.
  const sawAfterMerge = (p) => [[check, seen], [recheck, recheckSaw]].some(([record, saw]) => !!record && saw.has(p) &&
    touchingOf(p).every((m) => isAncestor(m, record.head)) && stateAt(record.head, p) === stateAt(head, p))
  // Main content counts only when a merge alone brought it; a later branch commit restoring main's version needs a record.
  const mergedOnly = mergedToMain(review.head, at, true)
  const mergeScope = (p) => !touchingOf(p).length ? null : mergedOnly(p) || sawAfterMerge(p)
  // Such a file is stamped only by a record after the merge, even when a pre-merge record saw the same state.
  const held = new Set(files.filter((p) => touchingOf(p).length && !sawAfterMerge(p)))
  const outOfScope = files.filter((p) => {
    const merged = mergeScope(p)
    if (merged !== null) return !merged && !p.startsWith('builds/')
    return !fixedFiles.has(p) && !seen.has(p) && !isTestFile(p) && !p.startsWith('builds/')
  })
  const coverage = outOfScope.length ? null : closeCoverage(review, files, check, head, recheck && { record: recheck, files: recheckSaw }, held)
  let tests = null
  if (command) {
    const r = spawnSync(command, { shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (r.error || r.status !== 0) throw new Error(`Tests failed at HEAD: ${r.error?.message || r.stderr || r.stdout || `exit ${r.status}`}`)
    tests = { cmd: command, passed: true }
  }
  const tier = await mergeTier({ review, reviews, statuses, files, outOfScope, noTests, head })
  requireClean()
  if (headNow() !== head) throw new Error('HEAD changed while tests ran')
  appendLog({ type: 'close', ts: new Date().toISOString(), review: id, closeHead: head, repoId: repoIdentity(), statuses, outOfScope,
    status: outOfScope.length ? 'partial' : 'complete', ...(coverage && { coverage }), tests, ...(noTests !== null && { noTests }), ...(check && { fixCheck: check.id }), ...(recheck && { recheck: recheck.id }),
    ...(carried && { carried }), ...(carriedAlso.length && { carriedAlso }), ...tier })
  console.log(`✓ Review ${id} closed (${outOfScope.length ? 'partial' : 'complete'}) at ${head}${paths ? ` for paths ${paths.join(', ')}` : ''}` +
    (carried ? `, carried from the ${carried.kind} head ${carried.from} (identical tree ${carried.tree})` : ''))
  if (outOfScope.length && based && outOfScope.every((p) => baseMergeSides([`${review.head}..${at}`]).has(p)))
    console.log(`Out of scope: ${outOfScope.join(', ')} — ${sidesNote(outOfScope, id)}.`)
}
// ── security pass ───────────────────────────────────────────────────────────
// Config security.run (see securitySettings): when it is on and the change needs it, a reviewer from the `security` role
// reviews the same diff with a security-only prompt, in a detached worker (review.mjs --security-worker <job>) that
// runs beside the code reviewer. The worker only calls the model and writes the raw findings to a result file: no
// record, no report, no reviews/latest. This run scores, quote-checks and records them (s1…) in the one review record.
// Required: run "always", or run "required" and some changed file (either name of a rename) is logic or other kind
// (a coverage-exempt file never on its own) or matches riskPaths.
function securityNeed(stats, run = SECURITY.run) {
  if (run === 'off') return { required: false, status: 'off', reason: 'security.run is off' }
  if (run === 'always') return { required: true, why: 'security.run is always' }
  if (!stats) return { required: true, why: 'the diff stats could not be read' }
  const paths = [...new Set(stats.files.flatMap(pathsOf))]
  const code = paths.filter(securityCode)
  const risky = paths.filter((p) => matchesAny(p, RISK_PATHS))
  if (code.length || risky.length)
    return { required: true, why: [code.length && `logic or other files: ${listed(code)}`, risky.length && `riskPaths: ${listed(risky)}`].filter(Boolean).join('; ') }
  return { required: false, status: 'not-required', reason: 'only docs, tests, static or lockfiles changed, none on riskPaths' }
}
// A logic or other-kind file for the security pass. Only the built-in lockfile names exempt a file: coverageExempt from the
// environment or a config never does, so an agent cannot exempt the code it changed.
const securityCode = (p) => !isTestFile(p) && !DEFAULT_EXEMPT.includes(p.split('/').at(-1)) && ['logic', 'other'].includes(extKind(p))
const securityRelevant = (p) => securityCode(p) || matchesAny(p, RISK_PATHS)
// The report's and the summary's line: "Security: <family> (<model>) — <status>, N findings", with the reason.
function securityLine(sec) {
  if (!sec) return 'Security: off (not recorded)'
  const who = sec.family ? `${sec.family} (${sec.model})` : 'no reviewer'
  return `Security: ${who} — ${sec.status}${sec.status === 'ran' ? `, ${sec.findings ?? 0} findings` : ''}${sec.reason ? ` (${sec.reason})` : ''}`
}
// Who runs it: REVIEW_SECURITY_REVIEWER pins one family; else the security role's members whose CLI is on PATH, each at
// its own effort, another vendor than the code reviewer's first. The code review's reviewer, model, pick, routing, force
// and team settings never apply here, and a Claude family runs as one agent. { members, why } or { error }.
function securityMembers(codeSel) {
  const pinned = String(process.env.REVIEW_SECURITY_REVIEWER ?? '').trim().toLowerCase()
  const loaded = loadPool('security')
  if (pinned) {
    if (!FAMILY_NAME.test(pinned)) return { error: `REVIEW_SECURITY_REVIEWER=${pinned} is not a family name` }
    const known = loaded.pool?.find((m) => m.family === pinned) || loaded.unusable?.find((m) => m.family === pinned)
    let m = known
    if (!m) {
      const id = modelId(pinned)
      m = { family: pinned, vendor: vendorOf(id), id, effort: vendorOf(id) ? flavorEffort(pinned) : 'high' }
    } else if (!m.effort) m = { ...m, effort: flavorEffort(pinned) }
    if (!m.vendor) return { error: `REVIEW_SECURITY_REVIEWER=${pinned} does not resolve to a model with a known CLI (claude-, gpt-, grok-)` }
    if (!onPath(m.vendor)) return { error: `REVIEW_SECURITY_REVIEWER=${pinned} needs the ${m.vendor} CLI, which is not on PATH` }
    return { members: [m], why: `REVIEW_SECURITY_REVIEWER=${pinned} (pinned)` }
  }
  if (!loaded.pool) return { error: `security role: ${loaded.error}` }
  const other = loaded.pool.filter((m) => m.vendor !== codeSel.vendor)
  const same = loaded.pool.filter((m) => m.vendor === codeSel.vendor)
  return {
    members: [...other, ...same],
    why: other.length ? `security role, a vendor other than the code reviewer's (${codeSel.vendor}) first` : `security role (every member is ${codeSel.vendor}, the code reviewer's vendor)`,
  }
}
// Workers still running when this process exits (a thrown error, say) are killed with it: none is left orphaned.
const SECURITY_WORKERS = new Set()
process.on('exit', () => {
  for (const pid of SECURITY_WORKERS) try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ }
})
function startSecurityWorker(job, member) {
  const dir = mkdtempSync(join(tmpdir(), 'review-security-'))
  const file = join(dir, 'job.json'), result = join(dir, 'result.json'), log = join(dir, 'worker.log')
  const deadline = Date.now() + SECURITY.timeoutMs
  writeFileSync(file, JSON.stringify({ ...job, member, result, deadline, timeoutMs: SECURITY.timeoutMs }), { mode: 0o600 })
  const out = openSync(log, 'a', 0o600)
  let child
  try {
    child = spawnFile(process.execPath, [COPY_PATH, '--security-worker', file],
      { detached: true, stdio: ['ignore', out, out], env: { ...process.env, REVIEW_BASE: BASE, REVIEW_BASE_FETCHED: BASE, GROK_HOME } })
  } finally {
    closeSync(out)
  }
  const started = Date.now()
  if (child.pid) SECURITY_WORKERS.add(child.pid)
  const done = new Promise((finish) => {
    let timedOut = false
    // A worker that wrote its result is finishing; one that has not by the timeout is killed with its model CLI.
    const timer = setTimeout(() => {
      if (existsSync(result)) return
      timedOut = true
      try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* gone */ } }
    }, Math.max(1, deadline - Date.now()))
    child.on('error', (e) => { clearTimeout(timer); SECURITY_WORKERS.delete(child.pid); finish({ error: `could not start: ${e.message}` }) })
    child.on('exit', (code, signal) => { clearTimeout(timer); SECURITY_WORKERS.delete(child.pid); finish({ code, signal, timedOut }) })
  })
  console.log(`▶ security · ${member.family} (${member.vendor} · ${member.id} · ${member.effort}) started beside the code reviewer`)
  return { member, dir, result, log, started, deadline, done }
}
// One worker's outcome: { data } with the raw findings, or { reason } it failed for.
async function securityOutcome(w) {
  const end = await w.done
  const durationMs = Date.now() - w.started
  let data = null, reason = null
  try {
    if (end.error) reason = end.error
    else if (end.timedOut) reason = `timed out after ${SECURITY.timeoutMs} ms`
    else {
      if (existsSync(w.result)) {
        try { data = JSON.parse(readFileSync(w.result, 'utf8')) } catch (e) { reason = `its result is malformed: ${e.message}` }
      } else reason = end.code === 0 ? 'it wrote no result' : null
      // A result written after the deadline is a timeout, whatever it says: the worker ran past its time.
      if (!reason && data && !(Number(data.finishedAt) <= w.deadline)) reason = `timed out after ${SECURITY.timeoutMs} ms`
      if (!reason && data && data.ok !== true) reason = typeof data?.error === 'string' && data.error ? data.error : 'its result is malformed: not ok'
      if (!reason && data && (!Array.isArray(data.findings) || data.findings.some((f) => !f || typeof f !== 'object' || Array.isArray(f))))
        reason = 'its result is malformed: no findings list'
      if (!reason && end.code !== 0) reason = `the security worker exited ${end.code ?? end.signal}`
      if (!reason && !data) {
        let tailText = ''
        try { tailText = tail(readFileSync(w.log, 'utf8')).split('\n').at(-1) } catch { /* no log */ }
        reason = `the security worker exited ${end.code ?? end.signal} with no result${tailText ? `: ${tailText}` : ''}`
      }
    }
  } finally {
    rmSync(w.dir, { recursive: true, force: true })
  }
  return reason ? { reason, durationMs } : { data, durationMs }
}
// Starts the pass, if any, once the diff, context and verify result are known. Returns what finishSecurity waits on.
function beginSecurity({ stats, diff }) {
  const need = securityNeed(stats)
  const base = { run: SECURITY.run, ...(SECURITY.raisedBy && { raisedBy: SECURITY.raisedBy }) }
  if (!need.required) {
    console.log(`ℹ security pass: ${need.status} (${need.reason})`)
    return { record: { ...base, status: need.status, reason: need.reason } }
  }
  const chosen = securityMembers(SEL)
  if (chosen.error) {
    console.warn(`⚠ security pass required (${need.why}) but skipped: ${chosen.error} — the merge tier will be HIGH`)
    return { record: { ...base, required: need.why, status: 'skipped', reason: chosen.error } }
  }
  const job = { diff, context: CONTEXT, verify: VERIFY_RESULT, slice: SLICE, diffBase: DIFF_BASE, intent: INTENT || null,
    paths: [...new Set((stats?.files || []).flatMap(pathsOf))] }
  try {
    return { base: { ...base, required: need.why, why: chosen.why }, job, members: chosen.members, worker: startSecurityWorker(job, chosen.members[0]) }
  } catch (e) {
    const reason = `${chosen.members[0].family}: could not start: ${e.message}`
    return { record: { ...base, required: need.why, status: 'failed', reason } }
  }
}
// Waits for the pass, trying the next member once each after a failure. { record, raw, member }.
async function finishSecurity(plan) {
  if (plan.record) return { record: plan.record, raw: [] }
  const attempts = []
  let w = plan.worker
  for (let i = 0; ; i++) {
    const r = await securityOutcome(w)
    const m = w.member
    attempts.push({ family: m.family, durationMs: r.durationMs, ...(r.reason ? { error: r.reason } : { ok: true }) })
    if (!r.reason) {
      const record = { ...plan.base, status: 'ran', family: m.family, model: m.id, ...(r.data.modelUsed && { modelUsed: r.data.modelUsed }), effort: m.effort,
        vendor: m.vendor, durationMs: attempts.reduce((n, a) => n + a.durationMs, 0), ...(attempts.length > 1 && { attempts }),
        ...(r.data.rescored && { rescored: r.data.rescored }) }
      return { record, raw: r.data.findings, member: m }
    }
    const next = plan.members[i + 1]
    console.warn(`⚠ security pass: ${m.family} failed (${r.reason})${next ? ` — trying ${next.family}` : ''}`)
    if (!next) {
      const reason = attempts.map((a) => `${a.family}: ${a.error}`).join('; ')
      console.warn(`⚠ security pass failed: ${reason} — the merge tier will be HIGH`)
      return { record: { ...plan.base, status: 'failed', reason, durationMs: attempts.reduce((n, a) => n + a.durationMs, 0), attempts }, raw: [] }
    }
    try {
      w = startSecurityWorker(plan.job, next)
    } catch (e) {
      attempts.push({ family: next.family, durationMs: 0, error: `could not start: ${e.message}` })
      const reason = attempts.map((a) => `${a.family}: ${a.error}`).join('; ')
      return { record: { ...plan.base, status: 'failed', reason, attempts }, raw: [] }
    }
  }
}
// --security-worker <job>: the detached half. It builds the security prompt, calls the one member, asks it once for
// missing scores, and writes { ok, findings, rescored } (or { ok: false, error }) to the job's result file.
async function securityWorker(jobFile) {
  const job = JSON.parse(readFileSync(jobFile, 'utf8'))
  const late = () => Number.isFinite(job.deadline) && Date.now() >= job.deadline
  const timedOut = () => ({ ok: false, error: `timed out after ${job.timeoutMs} ms` })
  const finish = (fields, code) => {
    try {
      const temp = `${job.result}.${randomBytes(4).toString('hex')}`
      writeFileSync(temp, JSON.stringify({ ...fields, finishedAt: Date.now() }), { mode: 0o600 })
      renameSync(temp, job.result)
    } catch { /* the parent reports a missing result */ }
    process.exit(code)
  }
  // Tests only: a worker that dies, says nothing or writes a broken result. Each can only make the pass fail.
  const fault = process.env.REVIEW_SECURITY_TEST_FAULT
  if (fault === 'exit') process.exit(3)
  if (fault === 'empty') process.exit(0)
  if (fault === 'malformed') { writeFileSync(job.result, '{"ok":true,"findings":'); process.exit(0) }
  if (fault === 'late') { pause(Math.max(0, job.deadline + 500 - Date.now())); finish({ ok: true, findings: [] }, 0) }
  // Its own timeout: every model call is killed at the deadline (MODEL_DEADLINE), and the result then says timed out.
  if (Number.isFinite(job.deadline)) MODEL_DEADLINE = job.deadline
  try {
    CONTEXT = job.context || ''
    VERIFY_RESULT = job.verify ?? null
    SLICE = Array.isArray(job.slice) && job.slice.length ? job.slice : null
    DIFF_BASE = job.diffBase || DIFF_BASE
    const m = job.member
    const { result, modelUsed } = await runModel(m, securityPrompt(String(job.diff ?? ''), m.vendor, job.intent, Array.isArray(job.paths) ? job.paths : []), SCHEMA, 'security reviewer')
    const raw = result?.findings
    if (!Array.isArray(raw) || raw.some((f) => !f || typeof f !== 'object' || Array.isArray(f))) throw new Error('its answer has no findings list')
    const { rescored } = await scoredFindings(raw, m)
    if (late()) finish(timedOut(), 1)
    finish({ ok: true, findings: raw, rescored, ...(modelUsed && { modelUsed }) }, 0)
  } catch (e) {
    finish(late() ? timedOut() : { ok: false, error: e.message }, 1)
  }
}
// ── standalone security check (--security-only) ──────────────────────────────
// The security reviewer alone, on demand, whatever security.run says. Its record goes to security-log.jsonl beside the
// review log, with type "security-check", and readLog() drops any record marked securityOnly: so it is never a review to
// close, fix-check, cover a push, count toward rotation or feed "already decided" forward. Its report lives under
// reviews/security/, so reviews/latest keeps naming the last real review.
const SECURITY_LOG = join(dirname(LOG_PATH), 'security-log.jsonl')
function readSecurityLog() {
  if (!existsSync(SECURITY_LOG)) return []
  return readFileSync(SECURITY_LOG, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      const e = JSON.parse(line)
      return e?.type === 'security-check' ? [e] : []
    } catch { return [] }
  })
}
function writeSecurityReport(id, branch, member, findings, unlocated, diffTruncated) {
  refuseLinkedReviews()
  ensureReviewsIgnored()
  const dir = `reviews/security/${id}`
  mkdirSync(dir, { recursive: true })
  const item = (f) => `- [${f.file || '?'}:${f.line || '?'}] ${f.issue} (id ${f.id})\n  Score: ${scoreText(f)}${isFiled(f) ? ' — filed' : ''}` +
    `${f.quote ? `\n  > ${String(f.quote).split('\n').join('\n  > ')}` : ''}${f.suggestion ? `\n  → ${f.suggestion}` : ''}`
  const bySev = (s) => findings.filter((f) => f.severity === s).map(item).join('\n') || '- none'
  const md = `Security check: ${id}\nReviewer: ${member ? `${member.family} (${member.id})` : 'none'}\nBranch: ${branch} → ${BASE}\nHEAD: ${headNow()}\n` +
    (SLICE ? `Paths: ${SLICE.join(', ')}\n` : '') +
    `Reviewed against: ${INTENT || '(inferred from diff)'}\n` +
    (diffTruncated ? `⚠ Diff exceeded ${DIFF_CAP} chars — only the first ${DIFF_CAP} were inlined.\n` : '') +
    `This is a standalone security check: it closes nothing and covers no push.\n` +
    `Findings: ${findings.length} (plus ${unlocated.length} could not be located)\n\n` +
    `## HIGH\n${bySev('high')}\n\n## MEDIUM\n${bySev('medium')}\n\n## LOW / Info\n${bySev('low')}\n` +
    (unlocated.length ? `\n## Could not be located in the code (unverified-quote)\n${unlocated.map((f) => `${item(f)}\n  ? ${f.quoteCheck}`).join('\n')}\n` : '')
  writeFileSync(`${dir}/security-check.md`, md)
  return dir
}
async function runSecurityOnly() {
  const { branch, diff, head: reviewedHead, baseSha, files: sliceFileList } = getDiff()
  refuseLinkedReviews()
  CONTEXT = reviewContext(branch)
  if (!diff) {
    console.log(`Nothing to check — no diff against ${BASE}.`)
    process.exit(0)
  }
  const stats = diffStats(undefined, SLICE)
  const diffTruncated = diff.length > DIFF_CAP
  if (diffTruncated) console.warn(`⚠ Diff is ${diff.length} chars — only the first ${DIFF_CAP} were inlined in the prompt.`)
  // No code reviewer runs here, so "another vendor" means another than the branch's author, when it is known.
  const author = String(cfg('REVIEW_AUTHOR', 'author', '')).trim().toLowerCase()
  const authorVendor = author ? vendorOfName(author, null) : null
  const chosen = securityMembers({ vendor: authorVendor })
  if (chosen.error) stop(`security check: ${chosen.error}\n  Fix: choose the security role in ACS → Models → Roles, or pin one with REVIEW_SECURITY_REVIEWER=<family>.`)
  const job = { diff, context: CONTEXT, verify: null, slice: SLICE, diffBase: DIFF_BASE, intent: INTENT || null,
    paths: [...new Set((stats?.files || []).flatMap(pathsOf))] }
  const base = { run: 'standalone', why: authorVendor || chosen.why.startsWith('REVIEW_SECURITY_REVIEWER') ? chosen.why.replaceAll('the code reviewer', 'the author') : 'security role' }
  const security = await finishSecurity({ base, job, members: chosen.members, worker: startSecurityWorker(job, chosen.members[0]) })
  if (security.record.status !== 'ran') stop(`security check failed: ${security.record.reason}`)
  const located = [], unlocated = []
  for (const f of security.raw) {
    const finding = { ...locatedFinding(scoreFinding(f)), source: 'security' }
    if (finding.status === 'unverified-quote') unlocated.push(finding)
    else located.push(finding)
  }
  requireClean()
  if (headNow() !== reviewedHead) throw new Error('HEAD changed during the security check')
  const findingDetails = [...located, ...unlocated]
  findingDetails.forEach((finding, i) => { finding.id = `s${i + 1}` })
  markPreExisting(findingDetails, baseSha, reviewedHead)
  const id = `sec-${new Date().toISOString().slice(0, 19).replaceAll(':', '-').replace('T', '-')}-${randomBytes(3).toString('hex')}`
  const dir = writeSecurityReport(id, branch, security.member, located, unlocated, diffTruncated)
  const record = { type: 'security-check', kind: 'security-only', securityOnly: true, id, ts: new Date().toISOString(), head: reviewedHead, branch,
    base: BASE, baseSha, repoId: repoIdentity(), repo: repoName(), ...(SLICE && { paths: SLICE, files: sliceFileList }), plan: PLAN_PATH ?? null,
    intent: INTENT || null, rubricVersion: RUBRIC_VERSION, findingDetails, ...recordedLocations(findingDetails), findings: located.length,
    unverified: unlocated.length, security: { ...security.record, findings: located.length }, dir }
  try {
    mkdirSync(dirname(SECURITY_LOG), { recursive: true })
    appendFileSync(SECURITY_LOG, `${JSON.stringify(record)}\n`)
  } catch (e) { throw new Error(`Could not append to ${SECURITY_LOG}: ${e.message}`) }
  const counts = ['high', 'medium', 'low'].map((s) => `${located.filter((f) => f.severity === s).length} ${s}`).join(', ')
  console.log(`\n✓ Security check complete — ${located.length} finding(s) (${counts}); ${unlocated.length} could not be located. Report: ${dir}/security-check.md`)
  for (const f of located.filter((f) => f.severity === 'high')) console.log(`HIGH ${f.id} ${f.file}:${f.line} — ${f.issue} (${scoreText(f)})`)
  console.log('This check closes nothing and covers no push: a PR still needs /code-review (or /pr-review) and its close.')
  console.log(`Security check ID: ${id}`)
  console.log('\n===FINDINGS_JSON===')
  console.log(JSON.stringify({ schemaVersion: 1, securityCheckId: id, standalone: true, family: security.record.family, base: BASE, branch, head: reviewedHead,
    ...(SLICE && { paths: SLICE }), reportPath: `${dir}/security-check.md`, diffTruncated, findings: located.map(publicFinding),
    unverified: unlocated.map(publicFinding), security: record.security, logPath: SECURITY_LOG }, null, 2))
  await Promise.all([process.stdout, process.stderr].map((stream) => new Promise((done) => stream.write('', done))))
  process.exit(0)
}
// --security-findings: the open findings of this branch's standalone checks (this repository), as text a PR review is
// handed as context. Open: not filed, and its quote still sits at its place at HEAD. They are never "already decided".
function printSecurityFindings() {
  const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']), repoId = repoIdentity()
  const seen = new Set(), open = []
  for (const check of readSecurityLog().filter((e) => e.branch === branch && e.repoId === repoId).reverse()) {
    for (const f of check.findingDetails || []) {
      if (f.status === 'unverified-quote' || isFiled(f) || isPreExisting(f)) continue
      const key = `${f.file}\0${String(f.quote ?? '').replace(/\s+/g, ' ').trim()}\0${f.issue}`
      if (seen.has(key)) continue
      seen.add(key)
      if (locateQuote(f).problem) continue
      open.push({ check: check.id, ...f })
    }
  }
  if (!open.length) return console.log(`No open standalone security findings on ${branch}.`)
  console.log(`Standalone security findings on ${branch} (from /security-check). They are not decided: check whether each still holds.`)
  for (const f of open) console.log(`- ${scoreText(f)} ${f.file}:${f.line} — ${f.issue} (check ${f.check}, ${f.id})\n  > ${String(f.quote ?? '').split('\n').join('\n  > ')}`)
}
const CLASSIFIER_TIMEOUT_MS = 5 * 60_000
// Run a command detached in its own process group with stdin given, killed (group and all) at the timeout.
function runBounded(command, argv, { input = '', cwd, timeoutMs = CLASSIFIER_TIMEOUT_MS } = {}) {
  return new Promise((done) => {
    let child
    // GROK_HOME is the one made absolute at load: a relative one would name a folder under the temporary cwd.
    try { child = spawn(command, argv, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GROK_HOME } }) } catch (e) { return done({ error: e.message }) }
    let stdout = '', stderr = '', timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* gone */ } }
    }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.stdin.on('error', () => {})
    child.on('error', (e) => { clearTimeout(timer); done({ error: e.message }) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      done(timedOut ? { error: `timed out after ${timeoutMs} ms` } : { code, signal, stdout, stderr })
    })
    child.stdin.end(input)
  })
}
// --slices "<group>;<group>" [--jobs N]: one review per group (each a REVIEW_PATHS value), at most N at a time, all in
// this checkout. Every slice is an ordinary run, with its own record, report, HEAD checks and close. Each one's output
// prints under a header as it finishes; then ===SLICES_JSON=== lists { paths, exit, reviewId, result } per slice, result
// being its FINDINGS_JSON object. The base is fetched once here, not by every slice.
async function runSlices() {
  if (PATHS.length) throw new Error('Use --slices or REVIEW_PATHS (or config "paths"), not both')
  const groups = option('--slices').split(/[;\n]/).map((g) => g.trim()).filter(Boolean)
  if (!groups.length) throw new Error('--slices needs at least one group of pathspecs')
  const jobs = Number(option('--jobs') ?? 4)
  if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error('--jobs must be a whole number of 1 or more')
  requireClean()
  fetchBase()
  const passed = args.filter((a, i) => !['--slices', '--jobs'].includes(a) && !['--slices', '--jobs'].includes(args[i - 1]))
  const env = { ...process.env, REVIEW_PATHS: '', REVIEW_BASE: BASE, REVIEW_BASE_FETCHED: BASE }
  const results = []
  const one = (i) => new Promise((done) => {
    let out = '', err = ''
    const child = spawnFile(process.execPath, [COPY_PATH, ...passed], { env: { ...env, REVIEW_PATHS: groups[i] }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { err += `\n${e.message}` })
    child.on('close', (code) => {
      const at = out.indexOf('===FINDINGS_JSON===')
      let result = null, error = null
      try { result = at === -1 ? null : JSON.parse(out.slice(at + 19)) } catch (e) { error = `its FINDINGS_JSON is malformed: ${e.message}` }
      // A slice that exits 0 without whole findings failed: its review may be logged, but nothing here shows it.
      if (code === 0 && !result?.reviewId) error ||= 'it printed no FINDINGS_JSON'
      const exit = error ? 1 : code ?? 1
      results[i] = { paths: groups[i], exit, reviewId: result?.reviewId ?? null, result, ...(error && { error }) }
      console.log(`=== slice ${i + 1}/${groups.length}: ${groups[i]} (exit ${exit}${error ? `: ${error}` : ''}) ===\n${err.trim()}\n${out.trim()}\n`)
      done()
    })
  })
  let next = 0
  const worker = async () => { while (next < groups.length) await one(next++) }
  await Promise.all(Array.from({ length: Math.min(jobs, groups.length) }, worker))
  console.log(`===SLICES_JSON===\n${JSON.stringify(results, null, 2)}`)
  if (results.some((r) => r.exit !== 0)) process.exitCode = 1
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
  const pickCommand = pickSetting && !['first', 'rotate'].includes(pickSetting) &&
    !pool.some((m) => m.family === pickSetting) && onPath(pickSetting)
  if (!CLASSIFIER && pickCommand && pickFromRepo()) console.warn(untrustedPickNote(pickSetting))
  const command = CLASSIFIER || (pickCommand && !pickFromRepo() ? pickSetting : '')
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
        : review.baseSha || sh('git', ['merge-base', '--end-of-options', review.base || BASE, review.head])
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
  FIX_CHECK_RUN = true
  if (entries.some((e) => e.type === 'review' && e.kind === 'fix-check' && e.review === id))
    throw new Error('One fix check per review; unresolved findings go to the operator, no third model pass')
  const head = headNow()
  if (!isAncestor(original.head, head)) throw new Error('HEAD is neither the reviewed commit nor a descendant')
  // A sliced review's fix check reviews only the fix diff inside its paths. No rename detection: a moved file shows
  // whole and meets the size cap like any other, so content the review cut can't pass as a short rename.
  SLICE = sliceOf(original)
  // After a merge of the default branch, only branch-side content: the fix diff's files whose state at HEAD differs
  // from the merge base's, plus any a commit other than a merge of main touched (a deletion, or a restore to main's
  // version, is the branch's change). Only what the default branch alone brought is never sent to the model.
  const mergeBase = coverBase(original, head)
  let onlyFiles = null
  if (mergeBase !== original.baseSha) {
    const branchSide = new Set(filesBetween(mergeBase, head)), all = filesBetween(original.head, head, SLICE)
    const { other, reverted } = rangeTouch(original.head, head)
    const kept = all.filter((p) => branchSide.has(p) || other.has(p) || reverted.has(p))
    if (kept.length < all.length) onlyFiles = kept
  }
  if (onlyFiles && !onlyFiles.length) throw new Error('No fix diff to check')
  const scope = onlyFiles ? onlyFiles.map((p) => `:(top,literal)${p}`) : SLICE
  const diff = sh('git', [...(scope ? ['-C', TOP] : []), 'diff', '--no-renames', `${original.head}..${head}`, ...pathspec(scope)])
  if (!diff) throw new Error('No fix diff to check')
  DIFF_BASE = original.head
  const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  CONTEXT = reviewContext(branch)
  const fixStats = diffStats(`${original.head}..${head}`, scope)
  SELECTION = selectReviewer(fixStats)
  SEL = SELECTION.sel
  if (SEL.team) throw new Error('A fix check requires one reviewer family, not the multi-agent team')
  const started = Date.now()
  const { result } = await runModel(SEL, `Fix check: review only this fix diff, not the original branch diff.\n${originalFindingsNote(original)}${reviewPrompt(diff)}`, SCHEMA, 'fix-check reviewer')
  const scored = await scoredFindings(result?.findings || [], SEL)
  const durationMs = Date.now() - started
  // inFix: any place of the finding (main or instance) near a line the fix changed, judged as inDiff is (inDiffOf).
  const changed = changedSides(original.head, head, scope)
  const findingDetails = scored.findings.map((f, i) => {
    const finding = { ...locatedFinding(f), id: `x${i + 1}` }
    return { ...finding, inFix: inDiffOf(finding, changed, original.head) }
  })
  requireClean()
  if (headNow() !== head) throw new Error('HEAD changed during fix check')
  // What it covers: the fix diff's files at its head, minus any the cap cut here or in the original review (it read
  // only the later change); nothing when the original's cut is unknown.
  const files = filesBetween(original.head, head, scope), truncated = truncatedFiles(diff, files)
  const missed = original.kind === 'grade' || fullObjectId(original.baseSha) ? reviewTruncated(original) : null
  const checkId = `fix-${Date.now()}-${randomBytes(3).toString('hex')}`
  appendLog({ type: 'review', kind: 'fix-check', rubricVersion: RUBRIC_VERSION, rescored: scored.rescored, id: checkId, review: id, ts: new Date().toISOString(), head, branch,
    repo: repoName(), repoId: repoIdentity(), base: original.head, baseSha: original.head, family: SEL.family, model: SEL.id, vendor: SEL.vendor, copy: COPY_PATH,
    ...(SLICE && { paths: SLICE }), ...(onlyFiles && { onlyFiles }), findings: findingDetails.length, findingDetails, ...recordedLocations(findingDetails),
    truncated, coverage: missed ? coverageOf(head, files.filter((p) => !truncated.includes(p) && !missed.has(p))) : [], noRenames: true,
    stats: recordStats(fixStats), plan: PLAN_PATH ?? null, durationMs })
  console.log(`✓ Fix check ${checkId} recorded at ${head}: ${findingDetails.length} finding(s)`)
  warnDropped(findingDetails)
  for (const f of findingDetails.filter((f) => f[WHERE]?.ambiguous))
    console.warn(`⚠ ${f.id}: path ambiguous, the quote is in both ${f[WHERE].ambiguous.join(' and ')}; it authorizes no file at close`)
}
// A review or security finding that claims preExisting gets inDiff: true when its main location or any located instance is
// within 3 lines of a line the review diff (merge base to head) added or changed, false when every place is resolved and
// outside it, null when that can't be told (unlocated, ambiguous, git failed). Only false files it as pre-existing.
// Each place is judged by every span its quote matched near the cited line, on the side it matched: a HEAD quote against the lines the branch
// added or changed, a base quote (a deleted file) against the lines it removed or changed, and only when that base is the
// merge base. Any place that can't be judged (unlocated, ambiguous, another base, git failed) is null.
function placeInDiff(where, changed, baseSha) {
  if (!changed || !where?.path || !Array.isArray(where.spans) || !where.spans.length) return null
  if (where.side === 'base' && where.commit !== baseSha) return null
  // Any place the quote matched near the cited line that touches the diff makes it the branch's.
  const hunks = (where.side === 'base' ? changed.base : changed.head).get(where.path) || []
  return where.spans.some(([from, to]) => hunks.some(([a, b]) => from <= b + 3 && to >= a - 3))
}
function inDiffOf(finding, changed, baseSha) {
  const places = [finding[WHERE], ...(finding.instances || []).map((_, i) => finding[WHERE]?.instances?.[i])]
  const each = places.map((where) => placeInDiff(where, changed, baseSha))
  return each.includes(true) ? true : each.every((v) => v === false) ? false : null
}
function markPreExisting(findings, baseSha, head) {
  const claimed = findings.filter((f) => f.preExisting === true)
  if (!claimed.length) return
  // The whole branch diff, never a slice's paths: a place outside the slice that the branch changed is still the branch's.
  const changed = changedSides(baseSha, head)
  for (const f of claimed) {
    f.inDiff = inDiffOf(f, changed, baseSha)
    if (f.inDiff === true) console.warn(`⚠ ${f.id}: marked pre-existing, but it is within 3 lines of a line this branch changed; it counts as the branch's`)
    if (f.inDiff === null) console.warn(`⚠ ${f.id}: marked pre-existing, but whether it is in the diff can't be told; it counts as the branch's`)
  }
}
// The original findings a fix check's fix is meant to repair (every one not filed), so the reviewer can tell an
// incomplete repair from a new regression. Empty when there are none.
function originalFindingsNote(original) {
  const targets = (original.findingDetails || []).filter((f) => !isFiled(f) && !isPreExisting(f))
  if (!targets.length) return ''
  const list = targets.map((f) => `- ${f.id} ${String(f.severity || '?').toUpperCase()} ${f.file || '?'}:${f.line || '?'} — ${f.issue || f.criterion || ''}; ` +
    `Trigger: ${f.trigger || 'trigger not recorded'}${alsoAt(f)}`).join('\n')
  return `The fix is meant to repair these findings from review ${original.id}. Use them to tell an incomplete repair ` +
    `from a new regression the fix introduced; report defects in the fix diff as usual.\n${list}\n\n`
}
// Both sides of the -U0 diff (a pure deletion marks the head line it follows). Names come NUL-separated from filesBetween,
// never from patch headers (a space adds a tab there, odd names are C-quoted); each file's own diff is read for its hunk
// lines only: head (lines added or changed, by file at `to`) and base (lines removed or changed, by file at
// `from`; a pure addition marks the base line it follows). null when any name or diff can't be read.
function changedSides(from, to, paths = null) {
  let names
  try { names = filesBetween(from, to, paths) } catch { return null }
  const changed = new Map(), removed = new Map()
  for (const name of names) {
    const r = spawnSync('git', ['-C', TOP, 'diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', from, to, '--', `:(literal)${name}`],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    if (r.error || r.status !== 0) return null
    const lines = [], old = []
    for (const line of r.stdout.split('\n')) {
      const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
      if (!hunk) continue
      const span = (s, c) => c ? [s, s + c - 1] : [Math.max(s, 1), Math.max(s, 1)]
      lines.push(span(Number(hunk[3]), hunk[4] == null ? 1 : Number(hunk[4])))
      old.push(span(Number(hunk[1]), hunk[2] == null ? 1 : Number(hunk[2])))
    }
    changed.set(name, lines)
    removed.set(name, old)
  }
  return { head: changed, base: removed }
}
function waiveFinding(id, findingId) {
  const reason = option('--reason')
  operatorOnly(reason)
  const review = loggedReview(readLog(), id)
  findingOf(review, findingId)
  appendLog({ type: 'override', action: 'waive', ts: new Date().toISOString(), review: id, finding: findingId, reason })
  console.log(`✓ Waiver recorded for ${id}/${findingId}: ${reason}`)
}
// The PR body: Grade criteria deferred as not met go on top, then the close lines, then the Deferred findings
// section, deferred HIGHs first. A tip carried over a rewrite says so.
function closeSummary(entries, close, head, carry = null) {
  const { review, lines } = closeLines(entries, close, head, carry)
  const { items, criteria, findings, preExisting, preExistingItems } = deferredLines(entries, review, coverOf([close], head, carry))
  const base = fullObjectId(review.baseSha) ? coverBase(review, head) : review.base
  const tier = tipTier([close], { entries, base, tip: head, deferred: items, preExisting: preExistingItems })
  lines.push(...tierLines(tier), 'Deferred findings', ...findings, ...preExisting)
  if (close.noTests) lines.push(`No tests: ${close.noTests}`)
  return summaryOf([...criteria, ...lines].join('\n'), tier, base, items, review)
}
// One summary for the slices that cover HEAD together, then the branch-wide deferred findings.
function slicedSummary(entries, { slices, baseSha, closeHead }, head, carry = null) {
  const lines = [`Sliced review: ${slices.length} slice(s) together cover every file changed from ${baseSha} to ${closeHead}`]
  if (carry) lines.push(carriedLine(carry, head))
  slices.forEach(({ close, paths }, i) => {
    lines.push(`Slice ${i + 1} of ${slices.length}: ${paths.join(', ')}`, ...closeLines(entries, close, head).lines)
    if (close.noTests) lines.push(`No tests: ${close.noTests}`)
  })
  const { items, criteria, findings, preExisting, preExistingItems } = deferredLines(entries, slices[0].review, coverOf(slices.map((s) => s.close), head, carry))
  const tier = tipTier(slices.map((s) => s.close), { entries, base: baseSha, tip: head, deferred: items, preExisting: preExistingItems })
  lines.push(...tierLines(tier), 'Deferred findings', ...findings, ...preExisting)
  return summaryOf([...criteria, ...lines].join('\n'), tier, baseSha, items, slices[0].review)
}
const carriedLine = (carry, head) => `Carried: ${head} has the exact tree of ${carry.from} (${carry.tree}), which the close below covers; the history was rewritten after it`
function closeLines(entries, close, head, carry = null) {
  const review = loggedReview(entries, close.review)
  const check = close.fixCheck && loggedReview(entries, close.fixCheck)
  const recheck = close.recheck && loggedReview(entries, close.recheck)
  const findings = [review, ...(recheck ? [recheck] : []), ...(check ? [check] : [])].flatMap((r) => r.findingDetails.map((f) => ({ ...f, review: r.id, owner: r })))
  const count = (status) => Object.values(close.statuses).filter((s) => s?.status === status).length
  const lines = [`Reviewer: ${review.family} (${review.model})`, ...(review.security && review.security.status !== 'off' ? [securityLine(review.security)] : []),
    `Review: ${review.id}`, `HEAD: ${head}`,
    `Counts: ${findings.length} findings; ${count('fixed')} fixed; ${count('rejected')} rejected${count('deferred') ? `; ${count('deferred')} deferred` : ''}`]
  if (carry) lines.push(carriedLine(carry, head))
  for (const c of [close.carried, ...(close.carriedAlso || [])].filter(Boolean))
    lines.push(`Carried at close: ${close.closeHead} has the exact tree of the ${c.kind} head ${c.from}`)
  for (const f of findings) {
    const status = close.statuses[f.id]
    const waiver = entries.find((e) => e.type === 'override' && e.action === 'waive' && e.review === f.review && e.finding === f.id)
    if (resolutionRules(f.owner, f).refutation && (status?.status === 'rejected' || waiver))
      lines.push(`${f.id} ${f.severity.toUpperCase()} ${f.issue}: ${status?.reason || ''}${waiver ? `; waived: ${waiver.reason}` : ''}${f.criterionId ? '' : ` — ${scoreText(f)}`}`)
    if (status?.status === 'fixed' && status.test) lines.push(`${f.id} ${String(f.severity || '?').toUpperCase()} ${f.issue || f.criterion || ''}: fixed; test: ${status.test}`)
    if (f.status === 'unverified-quote') lines.push(`Carried unlocated ${f.id} ${f.severity.toUpperCase()} ${f.issue}: ${f.quoteCheck} — ${scoreText(f)}`)
  }
  return { review, lines }
}
// What a summary covers: the closes that cover the tip, and the commits whose history counts (the tip, and the
// commit a rewritten tip stands in for).
const coverOf = (closes, tip, carry) => ({ closes, bases: [tip, ...(carry ? [carry.from] : [])] })
// The branch's deferred items, split for the PR body: criteria not met, and every other deferred or filed finding.
// The covering closes' own fix-check and recheck records count whatever branch name they were logged under.
function deferredLines(entries, review, cover) {
  const linked = new Set([...cover.closes.flatMap((c) => [c.review, c.fixCheck, c.recheck]), ...(cover.linked || [])].filter(Boolean))
  const records = entries.filter((r) => r.type === 'review' && (r.repoId === review.repoId && r.branch === review.branch || linked.has(r.id)))
  const items = deferredOrder(records.flatMap((r) => deferredFindings(entries, r, cover)))
  const criteria = items.filter((f) => f.criterionId).map(deferredLine)
  const findings = items.filter((f) => !f.criterionId).map(deferredLine)
  // Pre-existing findings left unfixed, apart from the deferred ones: protected first, as "Pre-existing HIGH". Only when any.
  const old = deferredOrder(records.flatMap((r) => preExistingFindings(entries, r, cover)))
  const preExisting = [...old.filter((f) => f.protected === true).map((f) => `Pre-existing HIGH ${deferredLine(f)}`),
    ...old.filter((f) => f.protected !== true).map(deferredLine)]
  return { items, criteria: criteria.length ? ['Acceptance criteria not met', ...criteria] : [], findings: findings.length ? findings : ['none'],
    preExisting: preExisting.length ? ['Pre-existing (not introduced here)', ...preExisting] : [], preExistingItems: old }
}
// One review record's pre-existing findings its close did not fix.
function preExistingFindings(entries, review, cover = null) {
  const close = statusClose(entries, review, cover)
  return (review.findingDetails || []).filter((f) => isPreExisting(f) && close?.statuses?.[f.id]?.status !== 'fixed')
}
// PR-body order: criteria not met, then HIGH, then MEDIUM and LOW; ties keep log order.
const DEFERRED_RANK = { high: 1, medium: 2, low: 3 }
const deferredOrder = (items) => [...items].sort((a, b) => deferredRank(a) - deferredRank(b))
const deferredRank = (f) => f.criterionId ? 0 : DEFERRED_RANK[f.severity] ?? 2
function deferredLine(finding) {
  const { deferral } = finding
  const fix = deferral && (deferral.fix || finding.suggestion)
  const decision = deferral ? `; Deferred: ${deferral.reason}${fix ? `; Fix idea: ${fix}` : ''}` : ''
  if (finding.criterionId)
    return `${finding.id} criterion ${finding.criterionId} not met: ${finding.criterion}; recheck: ${finding.recheckEvidence || 'evidence not recorded'}${decision}`
  return `${finding.id} ${scoreText(finding)} ${finding.file || '?'}:${finding.line || '?'} — ${finding.issue}; Trigger: ${finding.trigger || 'trigger not recorded'}${alsoAt(finding)}${decision}`
}
// The close whose statuses count for one review record. In a summary: the covering close that links it, else the
// latest close that links it and is not at a commit outside the tip's history. Without a tip (--deferred): the latest.
function statusClose(entries, review, cover) {
  const links = (e) => e.type === 'close' && (e.review === review.id || e.fixCheck === review.id || e.recheck === review.id)
  if (!cover) return entries.filter(links).at(-1)
  const own = cover.closes.filter(links).at(-1)
  if (own) return own
  const outside = (sha) => fullObjectId(sha) && spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`]).status === 0 &&
    !cover.bases.some((base) => isAncestor(sha, base))
  return entries.filter((e) => links(e) && !outside(e.closeHead)).at(-1)
}
// One review record's deferred items under its close: findings and criteria the close deferred, and filed findings
// it did not fix.
function deferredFindings(entries, review, cover = null) {
  const close = statusClose(entries, review, cover)
  return (review.findingDetails || []).flatMap((f) => {
    const status = close?.statuses?.[f.id]
    if (status?.status === 'deferred') {
      const recheck = f.criterionId && close.recheck && entries.find((e) => e.type === 'review' && e.id === close.recheck)
      const evidence = recheck && recheck.criteria?.find((c) => c.id === f.criterionId)?.evidence
      return [{ ...f, deferral: status, ...(evidence && { recheckEvidence: evidence }) }]
    }
    return isFiled(f) && !isPreExisting(f) && status?.status !== 'fixed' ? [f] : []
  })
}
// --noise-report [--since <date>] [--all]: what findings turned out to be, per reviewing family and severity band, from
// each review's latest close (in this repository unless --all; --since filters the close's timestamp). A finding counts
// for the family that raised it: a security finding for the security family, a fix check's or recheck's for its own
// record's family, a team's for each lens family. Unlabeled fixed or rejected statuses (legacy closes) count as
// unlabeled, never as real; a finding without a status counts as filed or pre-existing when it is one.
const NOISE_KINDS = ['real', 'unimportant', 'wrong', 'intentional', 'unlabeled', 'deferred', 'filed', 'pre-existing']
function noiseReport() {
  const since = option('--since')
  const from = since === null ? null : Date.parse(since)
  if (since !== null && !Number.isFinite(from)) throw new Error(`--since needs a date such as 2026-11-01; got ${since}`)
  const all = args.includes('--all'), repoId = all ? null : repoIdentity()
  const entries = readLog()
  const latest = new Map()
  for (const close of entries.filter((e) => e.type === 'close' && (all || e.repoId === repoId) && (from === null || Date.parse(e.ts) >= from)))
    latest.set(close.review, close)
  const counts = new Map()
  const add = (family, band, kind) => {
    const key = `${family}\0${band}`
    if (!counts.has(key)) counts.set(key, { family, band, ...Object.fromEntries(NOISE_KINDS.map((k) => [k, 0])) })
    counts.get(key)[kind]++
  }
  let closed = 0
  for (const close of latest.values()) {
    const review = entries.find((e) => e.type === 'review' && e.id === close.review)
    if (!review) continue
    closed++
    const security = review.security?.status === 'ran' ? review.security.family : null
    // Code findings belong to the code reviewer: each lens family of a team (its model names them), else the one family.
    const team = review.family === 'claude-team'
    const code = team && review.model ? reviewingFamilies({ family: review.family, model: review.model })
      : review.family && !team ? [review.family] : reviewingFamilies(review).filter((family) => family !== security)
    const records = [review, ...[close.recheck, close.fixCheck].filter(Boolean).map((id) => entries.find((e) => e.type === 'review' && e.id === id)).filter(Boolean)]
    for (const record of records) for (const f of record.findingDetails || []) {
      const status = close.statuses?.[f.id]?.status, response = close.statuses?.[f.id]?.response
      const kind = status === 'fixed' || status === 'rejected' ? (RESPONSES[status].includes(response) ? response : 'unlabeled')
        : status === 'deferred' ? 'deferred' : isPreExisting(f) ? 'pre-existing' : isFiled(f) ? 'filed' : null
      if (!kind) continue
      const families = record !== review ? [record.family] : f.source === 'security' && security ? [security] : code
      for (const family of families.length ? families : ['(unknown)']) add(family || '(unknown)', String(f.severity || 'unscored').toUpperCase(), kind)
    }
  }
  console.log(`Noise report (${all ? 'all repositories' : 'this repository'}${since !== null ? `, closes since ${since}` : ''}): ${closed} review(s) closed`)
  if (!closed) return console.log('no closes')
  const bands = ['HIGH', 'MEDIUM', 'LOW']
  const rank = (band) => bands.includes(band) ? bands.indexOf(band) : bands.length
  for (const t of [...counts.values()].sort((a, b) => a.family.localeCompare(b.family) || rank(a.band) - rank(b.band)))
    console.log(`${t.family} ${t.band}: ${NOISE_KINDS.map((k) => `${k} ${t[k]}`).join(', ')}`)
}
function printDeferred() {
  const entries = readLog(), repoId = args.includes('--all') ? null : repoIdentity()
  const reviews = entries.filter((e) => e.type === 'review' && (!repoId || e.repoId === repoId))
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
  console.log('Deferred findings')
  for (const review of reviews) {
    for (const finding of deferredOrder(deferredFindings(entries, review)))
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
function commitPaths(commit, paths = null) {
  const result = spawnSync('git', [...(paths ? ['-C', TOP] : []), 'diff-tree', '--root', '-r', '-m', '--no-commit-id', '--name-only', '--no-renames', '-z', commit, ...pathspec(paths)], { maxBuffer: 64 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(result.error?.message || String(result.stderr))
  return nulNames(result.stdout, `git diff-tree ${commit}`)
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
// Every file's state in a commit's tree, "mode blob" by path, read once per commit.
const TREES = new Map()
function treeStates(commit) {
  if (TREES.has(commit)) return TREES.get(commit)
  const r = spawnSync('git', ['ls-tree', '-r', '-z', '--full-tree', commit], { maxBuffer: 1024 * 1024 * 1024 })
  if (r.error || r.status !== 0) throw new Error(`git ls-tree ${commit} failed: ${r.error?.message || r.stderr}`)
  const states = new Map()
  for (let start = 0, end; start < r.stdout.length; start = end + 1) {
    end = r.stdout.indexOf(0, start)
    if (end === -1) end = r.stdout.length
    const tab = r.stdout.indexOf(9, start)
    if (tab === -1 || tab > end) continue
    const [mode, , object] = r.stdout.subarray(start, tab).toString('latin1').split(' ')
    const bytes = r.stdout.subarray(tab + 1, end), name = bytes.toString('utf8')
    // A name that is not valid UTF-8 never equals a compared path: nulNames refuses those.
    if (Buffer.from(name, 'utf8').equals(bytes)) states.set(name, `${mode} ${object}`)
  }
  TREES.set(commit, states)
  return states
}
// [path, state] pairs at a commit, sorted; an absent file's state is null, so a deletion is a state too.
const coverageOf = (commit, paths) => [...new Set(paths)].sort().map((path) => [path, treeStates(commit).get(path) ?? null])
const coverageMap = (record) => Array.isArray(record?.coverage) &&
  record.coverage.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && (e[1] === null || typeof e[1] === 'string'))
  ? new Map(record.coverage) : null
// Files whose diff section the size cap cut. A section counts as seen only when its exact header line and the next
// section's header both fall inside the inlined part; diff lines carry a +, - or space prefix, so a header line can't
// be forged by file content. A quoted or renamed header never matches, so over the cap such a file counts as cut.
function truncatedFiles(diff, files) {
  if (diff.length <= DIFF_CAP) return []
  const shown = diff.slice(0, DIFF_CAP)
  return files.filter((path) => {
    const header = `diff --git a/${path} b/${path}\n`
    const at = shown.startsWith(header) ? 0 : shown.indexOf(`\n${header}`)
    return at === -1 || shown.indexOf('\ndiff --git ', at + 1) === -1
  })
}
// A merge's paths changed on two or more sides since their merge base; null when the sides share no history.
const SIDES = new Map()
function bothSides(merge) {
  if (SIDES.has(merge)) return SIDES.get(merge)
  const parents = sh('git', ['rev-list', '--parents', '-n', '1', merge]).split(' ').slice(1)
  const base = sh('git', ['merge-base', '--octopus', ...parents], { allowFailure: true })
  let both = null
  if (base) {
    const counts = new Map()
    for (const parent of parents) for (const path of filesBetween(base, parent)) counts.set(path, (counts.get(path) || 0) + 1)
    both = new Set([...counts].filter(([, n]) => n > 1).map(([path]) => path))
  }
  SIDES.set(merge, both)
  return both
}
// The default branch's commit, whose content counts as reviewed: only a symbolic refs/remotes/origin/HEAD naming an
// existing ref under refs/remotes/origin/. It never reads REVIEW_BASE or config "base" and never runs `remote set-head`;
// the push gate trusts it only for a push to origin (the hook passes the remote as --remote). It uses ORIGIN_HEAD, the
// ref as this run found it. null keeps the old rule.
let DEFAULT_TIP
function defaultTip() {
  if (DEFAULT_TIP !== undefined) return DEFAULT_TIP
  DEFAULT_TIP = null
  const remote = args.indexOf('--remote')
  if (args.includes('--gate') && (remote === -1 || args[remote + 1] !== 'origin')) return null
  const target = ORIGIN_HEAD
  if (!/^refs\/remotes\/origin\/[^\s]+$/.test(target) || target === 'refs/remotes/origin/HEAD') return null
  // The exact ref only: a short-name lookup would also find refs/tags/<target>.
  const ref = sh('git', ['show-ref', '--verify', '--hash', '--', target], { allowFailure: true })
  const sha = fullObjectId(ref) ? sh('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true }) : ''
  if (fullObjectId(sha)) DEFAULT_TIP = sha
  return DEFAULT_TIP
}
// A review based on the default branch: its baseSha is on the default tip and its base names that branch. Only such a
// review gets the base-merge rules; one based on any other branch (a release branch, a sha) keeps the old rule in full.
function defaultBased(review) {
  const def = defaultTip()
  if (!def || !review || !fullObjectId(review.baseSha) || !isAncestor(review.baseSha, def)) return false
  const name = (ref) => String(ref ?? '').replace(/^refs\/remotes\/origin\/|^refs\/heads\/|^origin\//, '')
  return name(review.base) === name(ORIGIN_HEAD)
}
// The base to measure a review's branch from at a tip: for a review based on the default branch, the tip's merge base
// with it when that descends from the review's baseSha (the branch merged the default branch in since); else baseSha.
function coverBase(review, tip) {
  const def = defaultTip(), baseSha = review.baseSha
  if (!def || !fullObjectId(baseSha) || !defaultBased(review)) return baseSha
  const mb = sh('git', ['merge-base', tip, def], { allowFailure: true })
  return fullObjectId(mb) && mb !== baseSha && isAncestor(baseSha, mb) ? mb : baseSha
}
// Commits in a rev-list range minus those on the default branch: its own commits are never the branch's change.
const branchCommits = (range) => { const def = defaultTip(); return commitsIn(def ? [`^${def}`, ...range] : range) }
// A merge of the default branch into the branch: every parent but the first is on the default branch. Its parents, else null.
function baseMergeParents(commit) {
  const def = defaultTip()
  if (!def) return null
  const parents = sh('git', ['rev-list', '--parents', '-n', '1', commit]).split(' ').slice(1)
  return parents.length > 1 && parents.slice(1).every((p) => isAncestor(p, def)) ? parents : null
}
// What a merge of the default branch changed on the branch's side: every file both sides changed since their merge
// base (a conflict or an auto-merge), plus every file whose state differs from every parent's (an edit made in the
// merge commit itself is never hidden). Any other commit: every path it touched, merge-parent diffs included.
function branchPaths(commit, paths = null) {
  const parents = baseMergeParents(commit)
  const base = parents && sh('git', ['merge-base', '--octopus', ...parents], { allowFailure: true })
  if (!base) return commitPaths(commit, paths)
  return [...new Set([...mergeReverts(commit, paths, parents, base), ...(() => {
    const counts = new Map()
    for (const parent of parents) for (const path of filesBetween(base, parent, paths)) counts.set(path, (counts.get(path) || 0) + 1)
    const changed = parents.map((parent) => new Set(filesBetween(parent, commit, paths)))
    return [...[...counts].filter(([, n]) => n > 1).map(([path]) => path), ...[...changed[0]].filter((p) => changed.every((c) => c.has(p)))]
  })()])]
}
// Files only the branch changed (since the merge base) whose state a merge of the default branch changed from its
// first parent: a deletion, or a restore of main's copy, made inside the merge commit. Their result can equal main's,
// so neither the both-sides rule nor the evil-edit rule sees them; they are still the branch's own change.
function mergeReverts(merge, paths = null, parents = baseMergeParents(merge), base = parents && sh('git', ['merge-base', '--octopus', ...parents], { allowFailure: true })) {
  if (!parents || !base) return new Set()
  const both = bothSides(merge) || new Set(), branchSide = new Set(filesBetween(base, parents[0], paths))
  return new Set(filesBetween(parents[0], merge, paths).filter((p) => branchSide.has(p) && !both.has(p)))
}
// The commits of a range's branch side that touch each path: `merged` by merges of the default branch (their
// branchPaths), `other` by every other commit. `mergedLast(p)`: a merge touched p and every other commit touching it
// is an ancestor of such a merge, so p's state comes from a merge of main, not from a branch commit after it.
// `reverted`: files a merge changed back on the branch's side (mergeReverts); never main's content, so never mergedLast.
function rangeTouch(from, to) {
  const merged = new Map(), other = new Map(), reverted = new Set()
  for (const commit of branchCommits([`${from}..${to}`])) {
    const viaMerge = !!baseMergeParents(commit), into = viaMerge ? merged : other
    for (const p of viaMerge ? branchPaths(commit) : commitPaths(commit)) into.set(p, [...(into.get(p) || []), commit])
    if (viaMerge) for (const p of mergeReverts(commit)) reverted.add(p)
  }
  const mergedLast = (p) => merged.has(p) && !reverted.has(p) && (other.get(p) || []).every((c) => merged.get(p).some((m) => isAncestor(c, m)))
  return { merged, other, reverted, mergedLast }
}
// The files changed on both sides of the merges of the default branch in a rev-list range.
const baseMergeSides = (range) => new Set(branchCommits(['--merges', ...range]).flatMap((merge) => baseMergeParents(merge) ? [...(bothSides(merge) || [])] : []))
const sidesNote = (files, id) => `${files.length === 1 ? 'it' : 'they'} changed on both sides of a merge of the default branch: ${files.join(', ')}; ` +
  `slice-review just ${files.length === 1 ? 'that file' : 'those files'} at the tip (REVIEW_PATHS=${files.join(',')}) and close that slice; ` +
  `review ${id} keeps covering every other file, so nothing else needs a new review`
const buildsOnlySince = (closeHead, tip) => closeHead === tip || commitsIn([`${closeHead}..${tip}`])
  .every((commit) => commitPaths(commit).every((path) => path.startsWith('builds/')))
// A fix check is clean when no finding of its own needs a status.
const cleanCheck = (check) => Array.isArray(check.findingDetails) && check.findingDetails.every((f) => !resolutionRules(check, f).status)
// Content coverage. The tip needs one complete close at it (or followed only by builds/ commits), so the tests ran
// there; that close's review baseSha is the base. Every file changed from the base to the tip, builds/ aside, is
// covered when its exact state at the tip (mode and blob, or absent) is the state a complete close or a clean fix check
// logged, and that record and its review were logged in this repository, at a head that is an ancestor of the tip.
// A riskPaths file, and every file when the pushed commits touch riskPaths, counts only from a record whose review
// is of kind review. A file changed on two sides of a merge after the record's head needs a record that saw the merge.
// Only records with logged coverage count; a coverageExempt file is listed, never checked. Returns null when no
// complete close with coverage gives a base, else { covered, base, tipClose, used, uncovered, exempt }.
function contentCover(entries, tip, risk = false) {
  const repoId = repoIdentity()
  const reviewOf = (id) => entries.find((e) => e.type === 'review' && e.id === id)
  const records = []
  // completeCloses lists closes at the tip first, then the latest first; a review's latest close at a head stands.
  for (const close of completeCloses(entries, tip)) {
    const map = coverageMap(close), review = reviewOf(close.review)
    if (map && review && close.repoId === repoId && review.repoId === repoId &&
      !records.some((r) => r.review.id === review.id && r.head === close.closeHead)) records.push({ close, review, head: close.closeHead, map })
  }
  for (const check of [...entries].reverse()) {
    if (check.type !== 'review' || check.kind !== 'fix-check' || check.repoId !== repoId || !fullObjectId(check.head)) continue
    const map = coverageMap(check), review = reviewOf(check.review)
    if (map && review && review.repoId === repoId && cleanCheck(check) && isAncestor(check.head, tip) && (check.noRenames === true || fullObjectId(check.baseSha))) {
      for (const path of renamedInCheck(check)) map.delete(path)
      records.push({ check, review, head: check.head, map })
    }
  }
  const based = (r) => fullObjectId(r.review.baseSha) && isAncestor(r.review.baseSha, tip)
  const near = new Map(), atTip = (r) => near.has(r.head) ? near.get(r.head) : near.set(r.head, buildsOnlySince(r.head, tip)).get(r.head)
  const tipClose = records.find((r) => r.close && based(r) && atTip(r)) || null
  // Without one, the latest complete close still gives a base, only to name the uncovered files.
  const anchor = tipClose || records.find((r) => r.close && based(r))
  if (!anchor) return null
  // After a merge of the default branch, content it brought (the tip's state equals the merge base's) needs no coverage.
  const base = coverBase(anchor.review, tip), states = treeStates(tip), merges = new Map()
  const blind = (r, path) => {
    if (!merges.has(r.head)) merges.set(r.head, commitsIn(['--merges', tip, `^${r.head}`, `^${base}`]))
    return merges.get(r.head).some((merge) => bothSides(merge)?.has(path) ?? true)
  }
  // Every close at the tip close's head is listed, one per review, whether or not a file still needs it.
  const used = new Map(), uncovered = [], exempt = []
  for (const r of records) if (tipClose && r.close && r.head === tipClose.head) used.set(r, [])
  // A file a merge of main changed back on the branch's side (mergeReverts) can equal main's at the tip, so the diff from
  // the new base omits it; it still needs a record, unless a complete whole-branch (unsliced) code review counted for
  // the tip was made after that merge: measured from main, the file's absence or main's copy is no change there.
  const wholeReviews = records.filter((r) => r.close && r.review.kind === 'review' && !sliceOf(r.review)).map((r) => r.review.head)
  const reverts = new Set(commitsIn(['--merges', tip, `^${base}`])
    .filter((merge) => baseMergeParents(merge) && !wholeReviews.some((h) => isAncestor(merge, h))).flatMap((merge) => [...mergeReverts(merge)]))
  for (const path of [...new Set([...filesBetween(base, tip), ...reverts])]) {
    if (path.startsWith('builds/')) continue
    if (coverageExempt(path)) { exempt.push(path); continue }
    const state = states.get(path) ?? null
    const record = records.find((r) => r.map.has(path) && r.map.get(path) === state &&
      (r.review.kind === 'review' || (!risk && !matchesAny(path, RISK_PATHS))) && !blind(r, path))
    if (!record) uncovered.push(path)
    else used.set(record, [...(used.get(record) || []), path])
  }
  const baseMerge = base !== anchor.review.baseSha
  const sides = baseMerge && uncovered.length ? baseMergeSides([tip, `^${base}`]) : new Set()
  return { covered: !!tipClose && !uncovered.length, base, tipClose, anchor, uncovered, exempt, used: [...used].map(([r, files]) => ({ ...r, files })),
    // Only a revert whose tip state is main's (or still deleted) is invisible to a slice review; other merge edits are not.
    baseMerge, sidesOnly: !!uncovered.length && uncovered.every((p) => sides.has(p)),
    reverts: uncovered.filter((p) => reverts.has(p) && (states.get(p) ?? null) === (treeStates(base).get(p) ?? null)) }
}
// The legacy rule, for closes logged without coverage only: one unsliced complete close at the tip, then builds/
// commits only. A sliced close covers only its paths, so it never counts here.
function legacyClose(entries, tip, reviewOnly = false) {
  return completeCloses(entries, tip).find((close) => {
    if (coverageMap(close)) return false
    const review = loggedReview(entries, close.review)
    if (sliceOf(review)) return false
    if (reviewOnly && review.kind !== 'review') return false
    return buildsOnlySince(close.closeHead, tip)
  })
}
// The PR body for a covered tip: one unsliced close keeps the single-close summary, slices closed together at one head
// keep the sliced one, and anything else lists every close and clean fix check that covers a file.
function coverSummary(entries, result, tip, carry = null) {
  const summary = coveredBy(entries, result, tip, carry)
  return { ...summary, text: [summary.text, ...(result.exempt.length ? [exemptLine(result.exempt)] : [])].join('\n') }
}
const exemptLine = (files) => `Coverage exempt (not reviewed): ${files.join(', ')}`
function coveredBy(entries, result, tip, carry) {
  const { used, base, tipClose } = result, closes = used.filter((r) => r.close)
  if (used.length === 1 && !sliceOf(tipClose.review)) return closeSummary(entries, tipClose.close, tip, carry)
  if (closes.length === used.length && closes.every((r) => sliceOf(r.review) && r.review.baseSha === base && r.head === tipClose.head)) {
    const slices = closes.map((r) => ({ close: r.close, review: r.review, paths: sliceOf(r.review) }))
      .sort((a, b) => a.paths.join('\n').localeCompare(b.paths.join('\n')))
    return slicedSummary(entries, { slices, baseSha: base, closeHead: tipClose.head }, tip, carry)
  }
  const lines = [`Content coverage: ${used.length} record(s) together cover every file changed from ${base} to ${tip}`]
  if (carry) lines.push(carriedLine(carry, tip))
  used.forEach((r, i) => {
    const paths = sliceOf(r.review)
    if (!r.close) return lines.push(`Fix check ${i + 1} of ${used.length}: ${r.check.id} of review ${r.review.id}, clean at ${r.head}; covers ${r.files.length} file(s)`,
      `Reviewer: ${r.check.family} (${r.check.model})`)
    lines.push(`Close ${i + 1} of ${used.length}: review ${r.review.id} at ${r.head}${paths ? ` for paths ${paths.join(', ')}` : ''}; covers ${r.files.length} file(s)` +
      (r === used[0] ? ', and the tests ran at the tip' : ''), ...closeLines(entries, r.close, tip).lines)
    if (r.close.noTests) lines.push(`No tests: ${r.close.noTests}`)
  })
  const cover = { ...coverOf(closes.map((r) => r.close), tip, carry), linked: used.filter((r) => r.check).map((r) => r.check.id) }
  const { items, criteria, findings, preExisting, preExistingItems } = deferredLines(entries, tipClose.review, cover)
  const tier = tipTier(closes.map((r) => r.close), { entries, base, tip, deferred: items, preExisting: preExistingItems })
  lines.push(...tierLines(tier), 'Deferred findings', ...findings, ...preExisting)
  return summaryOf([...criteria, ...lines].join('\n'), tier, base, items, tipClose.review)
}
// A rewritten tip (squash, split, rebase) is covered when it does not descend from a logged head (a close, review,
// Grade, fix-check or recheck head) whose tree is exactly its own, and that head is covered: the review carries over.
// Only an identical tree carries; any other rewrite needs a fresh review.
function carriedCover(entries, tip, risk = false) {
  const heads = entries.flatMap((e) => e.type === 'close' && e.status === 'complete' ? [e.closeHead] : e.type === 'review' ? [e.head] : []).reverse()
  const trees = treesOf(heads), tree = treeOf(tip)
  for (const [from, own] of trees) {
    if (own !== tree || from === tip || isAncestor(from, tip)) continue
    const result = contentCover(entries, from, risk)
    if (result?.covered) return { from, tree, result }
    const close = legacyClose(entries, from, risk)
    if (close) return { from, tree, close }
  }
  return null
}
const carriedSummary = (entries, carry, tip) => carry.close ? closeSummary(entries, carry.close, tip, carry) : coverSummary(entries, carry.result, tip, carry)
// Names the uncovered files, so the agent reviews just those as a slice.
function uncoveredNote(result) {
  if (!result || result.covered) return ''
  const { uncovered, tipClose } = result
  const exempt = result.exempt.length ? `; exempt (not reviewed): ${result.exempt.join(', ')}` : ''
  if (!uncovered.length && result.baseMerge)
    return `; every changed file is covered, but no complete close is at the tip: re-close the existing review ${result.anchor.review.id} at the tip so the tests run there (no new review: the merge of the default branch changed nothing on the branch's side)${exempt}`
  if (!uncovered.length)
    return `; every changed file is covered, but no complete close is at the tip: close a review at the tip so the tests run there${exempt}`
  const shown = uncovered.slice(0, 20).join(', ')
  const more = uncovered.length > 20 ? ` and ${uncovered.length - 20} more` : ''
  const where = tipClose ? `the complete ${sliceOf(tipClose.review) ? 'slice ' : ''}closes at ${tipClose.head} leave` : 'no complete close or clean fix check saw the tip state of'
  if (result.reverts?.length) {
    const rest = uncovered.filter((p) => !result.reverts.includes(p))
    return `; ${where} ${uncovered.length} file(s) uncovered: ${shown}${more} — ${result.reverts.join(', ')} changed back to main's copy inside a merge ` +
      `of the default branch, which a slice review can't see (no diff from main): run the review's fix check (it sees them), or review the whole branch afresh` +
      (rest.length ? `; review ${rest.join(', ')} as a slice (REVIEW_PATHS=${rest.join(',')}) and close it at the tip` : '') + exempt
  }
  if (result.sidesOnly) return `; ${where} ${uncovered.length} file(s) uncovered: ${shown}${more} — ${sidesNote(uncovered, result.anchor.review.id)}${exempt}`
  return `; ${where} ${uncovered.length} file(s) uncovered: ${shown}${more}` +
    ` — review them as a slice (REVIEW_PATHS=${uncovered.join(',')}) and close it at the tip${exempt}`
}
function legacyNote(entries) {
  return entries.some((e) => e.type === 'review' && !e.head && e.repo === repoName())
    ? '; found a review from an old script copy that did not log head' : ''
}
// The summary for HEAD: content coverage, then the legacy close, then a carried tip. { summary } or, uncovered, { reason }.
function headSummary(entries, head) {
  const result = contentCover(entries, head)
  if (result?.covered) return { summary: coverSummary(entries, result, head) }
  const close = legacyClose(entries, head)
  if (close) return { summary: closeSummary(entries, close, head) }
  const carry = carriedCover(entries, head)
  if (!carry) return { reason: `No complete close covers HEAD${legacyNote(entries)}${uncoveredNote(result)}` }
  return { summary: carriedSummary(entries, carry, head) }
}
function printSummary() {
  const { summary, reason } = headSummary(readLog(), headNow())
  if (!summary) throw new Error(reason)
  console.log(summary.text)
}
// --tier-json: the tier the summary prints, as one JSON line, from the same lookup. Uncovered: covered false, exit 3.
function printTierJson() {
  const head = headNow()
  const { summary, reason } = headSummary(readLog(), head)
  if (!summary) {
    console.log(JSON.stringify({ tip: head, covered: false, reason, logPath: LOG_PATH }))
    process.exitCode = 3
    return
  }
  const { onHuman, humanComment, requireChecks, allowBehind } = MERGE
  console.log(JSON.stringify({ tip: head, covered: true, base: summary.base, baseRef: summary.baseRef, ...summary.tier, deferred: summary.deferred,
    merge: { onHuman, humanComment, requireChecks, allowBehind }, logPath: LOG_PATH }))
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
  const summaries = [], uncovered = [], carries = []
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
        const risk = branchCommits(pushedRange(ref)).some((commit) => branchPaths(commit).some((path) => matchesAny(path, RISK_PATHS)))
        const result = contentCover(entries, tip, risk)
        const close = result?.covered ? null : legacyClose(entries, tip, risk)
        const carry = result?.covered || close ? null : carriedCover(entries, tip, risk)
        if (!result?.covered && !close && !carry) {
          uncovered.push(ref)
          throw new Error(`No complete ${risk ? 'code-review ' : ''}close covers tip ${tip}${legacyNote(entries)}${risk ? '; pushed commits touch riskPaths' : ''}${uncoveredNote(result)}`)
        }
        if (carry) carries.push({ type: 'carried', ts: new Date().toISOString(), repoId: repoIdentity(), ref: ref.remoteRef, tip, from: carry.from, tree: carry.tree,
          reviews: carry.close ? [carry.close.review] : carry.result.used.map((r) => r.check ? r.check.id : r.review.id) })
        summaries.push((carry ? carriedSummary(entries, carry, tip) : close ? closeSummary(entries, close, tip) : coverSummary(entries, result, tip)).text)
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
  // A carried tip counts only once the carry-over is logged.
  try { for (const entry of carries) appendLog(entry) }
  catch (e) {
    console.error(`Push blocked: ${e.message}`)
    process.exitCode = 1
    return
  }
  for (const summary of summaries) console.error(summary)
}
// ── eval: reviewer families against known cases ──────────────────────────────
// --eval [--family <f>,…] [--cases <dir>] [--repeat N] [--timeout 15m] [--yes]: every family reviews every case folder
// (case.json, base/ and head/ trees) in a throwaway repo of its own, base commit on main and head commit on a branch,
// through a child review in eval mode. Each case is scored from that child's own record; one record per family per run
// is appended to eval-log.jsonl beside the review log. Nothing reaches the review log, a close or the push gate.
const EVAL_CASES = join(homedir(), '.agent-config-studio', 'review-gate', 'eval', 'cases')
const EVAL_GUARD = 10 // more reviews than this need --yes
const EVAL_SLACK = 3 // a finding's lines may sit this far outside an expected range and still match it
const EVAL_TIMEOUT_MS = 15 * 60_000
const EVAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const EVAL_KEYS = ['id', 'kind', 'intent', 'expect', 'allow', 'notes']
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
function evalModeChecks() {
  const refused = EVAL_REFUSED.filter((flag) => args.includes(flag))
  if (refused.length)
    stop(`${refused.join(', ')} refuses to run in eval mode (REVIEW_EVAL is set): an eval review never reaches the review log, a close, ` +
      'the summary or the push gate.\n  Fix: unset REVIEW_EVAL; only review.mjs --eval sets it, on the case reviews it runs.')
  const dir = String(process.env.REVIEW_EVAL_LOG_DIR ?? '')
  if (!dir || !isAbsolute(dir))
    stop('Eval mode (REVIEW_EVAL) needs REVIEW_EVAL_LOG_DIR, an absolute folder for this eval run\'s own log, so nothing reaches the review log.\n' +
      '  Fix: run review.mjs --eval, which sets both.')
  // Never the review log's own folders: a record there would sit where the gate reads.
  const home = homedir(), logDir = realish(dir)
  const realLogs = [join(home, '.agent-config-studio', 'review-log'), join(home, '.claude', 'review-log')].map(realish)
  if (realLogs.some((l) => within(logDir, l)) || [join(home, '.claude'), dirname(logPath())].map(realish).includes(logDir))
    stop(`REVIEW_EVAL_LOG_DIR (${dir}) is, or sits inside, a real review-log folder; eval mode logs only inside the eval run's temp folder.`)
  // The run's temp folder, as --eval made it: a review-eval- folder in the temp folder. The log, the working directory and
  // the repo (work tree and git dirs) are all inside it, so reviews/ and info/exclude are only ever written there.
  const rootValue = String(process.env.REVIEW_EVAL_ROOT ?? '')
  const root = rootValue && isAbsolute(rootValue) ? realish(rootValue) : null
  if (!root || dirname(root) !== realish(tmpdir()) || !basename(root).startsWith('review-eval-') || !isFolderPath(root))
    stop(`Eval mode (REVIEW_EVAL) needs REVIEW_EVAL_ROOT, the eval run's review-eval- folder in ${tmpdir()}; got ${JSON.stringify(rootValue)}.\n` +
      '  Fix: run review.mjs --eval, which sets it.')
  if (!within(logDir, root)) stop(`REVIEW_EVAL_LOG_DIR (${dir}) is outside the eval run's temp folder ${root}.`)
  const gitVars = GIT_LOCATION_VARS.filter((k) => process.env[k] != null)
  if (gitVars.length) stop(`Eval mode (REVIEW_EVAL) refuses ${gitVars.join(', ')}: git must find the case repo from the working directory alone.`)
  evalOwnRepo(root)
  if (!String(process.env.REVIEW_BASE ?? '').trim()) stop('Eval mode (REVIEW_EVAL) needs REVIEW_BASE: it never detects a base.')
}
// A path with every existing part resolved through symlinks (the rest appended as written).
function realish(p) {
  let cur = resolve(p)
  const rest = []
  for (;;) {
    try { return join(realpathSync.native(cur), ...rest.reverse()) } catch { /* not there yet */ }
    const up = dirname(cur)
    if (up === cur) return resolve(p)
    rest.push(basename(cur))
    cur = up
  }
}
function within(p, dir) {
  return p === dir || p.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`)
}
function isFolderPath(p) {
  try { return statSync(p).isDirectory() } catch { return false }
}
// In eval mode: the working directory, its work tree and its git dirs all sit inside the eval run's temp folder.
function evalOwnRepo(root = realish(String(process.env.REVIEW_EVAL_ROOT ?? ''))) {
  const outside = (what) => stop(`Eval mode (REVIEW_EVAL): ${what} is outside the eval run's temp folder ${root}; a case review runs only in a repo --eval built there.`)
  if (!within(realish(process.cwd()), root)) outside(`the working directory ${process.cwd()}`)
  const r = spawnFileSync(which('git') || 'git', ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], { encoding: 'utf8' })
  if (r.error || r.status !== 0) stop(`Eval mode (REVIEW_EVAL): ${process.cwd()} is not a git repo.`)
  for (const p of r.stdout.trim().split('\n')) if (!within(realish(resolve(p)), root)) outside(p)
}
const evalDuration = (ms) => (ms % 60_000 === 0 ? `${ms / 60_000}m` : ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`)
function evalTimeout(value) {
  if (value == null) return EVAL_TIMEOUT_MS
  const m = String(value).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/)
  const ms = m ? Math.round(Number(m[1]) * { ms: 1, s: 1000, m: 60_000 }[m[2] || 'm']) : NaN
  if (!(ms >= 1 && ms <= 2 ** 31 - 1)) throw new Error(`--timeout must be a duration like 15m, 90s or 500ms (a bare number is minutes); got ${JSON.stringify(value)}`)
  return ms
}
// A case tree: plain files only (no link, no .git, no review config of its own), as { path: bytes } in path order.
function evalTree(dir, side) {
  const files = new Map()
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.name === '.git') throw new Error(`${side}/${r}: a case tree holds no .git`)
      if (e.isSymbolicLink()) throw new Error(`${side}/${r} is a symlink; a case tree holds plain files only`)
      if (e.isDirectory()) walk(join(d, e.name), r)
      else if (e.isFile()) files.set(r, readFileSync(join(d, e.name)))
      else throw new Error(`${side}/${r} is not a plain file`)
    }
  }
  walk(dir, '')
  if (files.has('.claude/review-config.json')) throw new Error(`${side}/.claude/review-config.json: a case tree may not carry a review config`)
  return files
}
const isFolder = (p) => { try { return statSync(p).isDirectory() } catch { return false } }
const textLines = (bytes) => { const t = bytes.toString('utf8'); return t.endsWith('\n') ? t.split('\n').length - 1 : t.split('\n').length }
// One case folder, validated before anything runs; a problem throws the message the run prints as "skipped".
function readEvalCase(where) {
  const file = join(where, 'case.json')
  if (!existsSync(file)) throw new Error('no case.json')
  let json
  try { json = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { throw new Error(`case.json is not valid JSON: ${e.message}`) }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('case.json must hold an object')
  const unknown = Object.keys(json).filter((k) => !EVAL_KEYS.includes(k))
  if (unknown.length) throw new Error(`case.json has unknown keys ${unknown.join(', ')} (known: ${EVAL_KEYS.join(', ')})`)
  const { id, kind, intent } = json
  if (typeof id !== 'string' || !EVAL_ID.test(id)) throw new Error(`id must be letters, digits, dot, dash or underscore; got ${JSON.stringify(id)}`)
  if (!['bug', 'clean'].includes(kind)) throw new Error(`kind must be "bug" or "clean"; got ${JSON.stringify(kind)}`)
  if (typeof intent !== 'string' || !intent.trim() || intent.trim().startsWith('-'))
    throw new Error('intent must be a sentence saying what the change was supposed to do')
  for (const side of ['base', 'head']) if (!isFolder(join(where, side))) throw new Error(`no ${side}/ folder`)
  const base = evalTree(join(where, 'base'), 'base'), head = evalTree(join(where, 'head'), 'head')
  if (base.size === head.size && [...base].every(([p, bytes]) => head.get(p)?.equals(bytes))) throw new Error('head/ is the same as base/: there is no change to review')
  const lines = (value, label) => {
    if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => Number.isSafeInteger(n) && n >= 1) || value[0] > value[1])
      throw new Error(`${label}.lines must be [from, to], line numbers with from <= to`)
    return [value[0], value[1]]
  }
  const located = (entry, i, list, sides) => {
    const label = `${list}[${i}]`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${label} must be an object`)
    const side = entry.side ?? 'head'
    if (!sides.includes(side)) throw new Error(`${label}.side must be ${sides.map((s) => `"${s}"`).join(' or ')}`)
    if (typeof entry.file !== 'string' || !entry.file) throw new Error(`${label}.file must name a file`)
    const span = lines(entry.lines, label)
    const tree = side === 'head' ? head : base
    if (!tree.has(entry.file)) throw new Error(`${label}: ${entry.file} is not in ${side}/`)
    const count = textLines(tree.get(entry.file))
    if (span[1] > count) throw new Error(`${label}: lines ${span[0]}-${span[1]} run past the end of ${side}/${entry.file} (${count} lines)`)
    return { file: entry.file, side, lines: span }
  }
  let expect = [], allow = []
  if (kind === 'bug') {
    if (!Array.isArray(json.expect) || !json.expect.length) throw new Error('a bug case needs a non-empty expect list (every entry must be caught)')
    if (json.allow !== undefined) throw new Error('allow is for clean cases only')
    expect = json.expect.map((e, i) => {
      const where = located(e, i, 'expect', ['head', 'base'])
      if (typeof e.what !== 'string' || !e.what.trim()) throw new Error(`expect[${i}].what must say what the bug is`)
      return { ...where, what: e.what }
    })
  } else {
    if (json.expect !== undefined) throw new Error('a clean case has no expect (it expects no finding); list tolerated findings under allow')
    if (json.allow !== undefined && !Array.isArray(json.allow)) throw new Error('allow must be a list')
    allow = (json.allow ?? []).map((e, i) => located(e, i, 'allow', ['head']))
  }
  const hash = createHash('sha256').update(readFileSync(file))
  for (const [side, tree] of [['base', base], ['head', head]]) for (const [p, bytes] of tree) hash.update(`\0${side}/${p}\0`).update(bytes)
  return { id, kind, intent: intent.trim(), expect, allow, base, head, hash: hash.digest('hex') }
}
function loadEvalCases(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    throw new Error(`No cases folder at ${dir} (${e.code || e.message}). Make one, one folder per case (eval/examples/ beside review.mjs ` +
      'holds two to copy), or pass --cases <dir>.')
  }
  const valid = [], skipped = []
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.startsWith('.')) continue
    try {
      if (!e.isDirectory()) throw new Error('not a folder')
      valid.push({ ...readEvalCase(join(dir, e.name)), folder: e.name })
    } catch (err) { skipped.push({ name: e.name, error: err.message }) }
  }
  const folders = new Map()
  for (const c of valid) folders.set(c.id, [...(folders.get(c.id) || []), c.folder])
  for (const c of valid.filter((v) => folders.get(v.id).length > 1))
    skipped.push({ name: c.folder, error: `duplicate id "${c.id}" (folders ${folders.get(c.id).join(', ')})` })
  return { cases: valid.filter((c) => folders.get(c.id).length === 1).sort((a, b) => (a.id < b.id ? -1 : 1)), skipped }
}
// The families to evaluate, as the child review will resolve them (REVIEW_REVIEWER=<family>, no REVIEW_* settings, a repo
// with no review config of its own): one whose CLI is missing is reported once, here, and left out before anything is counted.
function evalFamilies(list) {
  skipsNoted.add('reviewer') // loadPool's own "skipped" line would name a missing family a second time
  const loaded = loadPool()
  if (list == null && !loaded.pool && !loaded.unusable?.length) poolOrStop(loaded)
  const names = list == null ? [...(loaded.pool || []), ...(loaded.unusable || [])].map((m) => m.family) : list.split(',').map((f) => f.trim().toLowerCase()).filter(Boolean)
  if (!names.length) throw new Error('--family needs at least one family')
  // The child sees only the home config: claudeModel there decides team or one agent, whatever this shell or repo sets.
  const homes = [join(homedir(), '.agent-config-studio', 'review-gate', 'config.json'), join(homedir(), '.claude', 'review-config.json')]
  const team = (String(homeKey(homes, 'claudeModel') ?? '').trim() || 'team') === 'team'
  const families = [], skipped = []
  for (const family of [...new Set(names)]) {
    let m
    if (!FAMILY_NAME.test(family)) { skipped.push(`${family}: not a family name`); continue }
    if (family === 'claude') m = { family, vendor: 'claude', team, calls: team ? LENSES.length : 1 }
    else if (family === 'codex') m = { family, vendor: 'codex' }
    else {
      if (loaded.missing) poolOrStop(loaded)
      m = loaded.pool?.find((p) => p.family === family) || loaded.unusable?.find((p) => p.family === family) || poolMember(family, loaded.pool)
    }
    if (!m.vendor) {
      // A role family with no CLI prefix was already named by loadPool's warning.
      if (!loaded.unusable?.some((u) => u.family === family)) skipped.push(`${family}: model-id gives "${m.id}", whose prefix names no known CLI`)
      continue
    }
    if (!onPath(m.vendor)) { skipped.push(`${family}: the ${m.vendor} CLI is not on PATH`); continue }
    families.push({ calls: 1, ...m, effort: m.effort ? effortFor(m) : null })
  }
  return { families, skipped }
}
// The review prompt this family's vendor gets, with no diff, intent context or slice: a change here is a prompt change.
function evalPromptHash(m) {
  const saved = { SEL, SLICE, DIFF_BASE }
  try {
    SEL = { vendor: m.vendor }
    SLICE = null
    DIFF_BASE = 'main'
    return sha256(`${reviewPrompt('')}${m.vendor === 'claude' ? JSON.stringify(LENSES) : ''}`)
  } finally {
    ;({ SEL, SLICE, DIFF_BASE } = saved)
  }
}
// This run's environment without any GIT_* variable (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE… would point git at another
// repo) and without REVIEW_* settings: what the case repos and the case reviews run with.
function evalEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && !k.startsWith('REVIEW_')))
}
function evalGit(cwd, argv) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false',
    '-c', 'user.name=review eval', '-c', 'user.email=review-eval@localhost', ...argv], { cwd, encoding: 'utf8', env: evalEnv() })
  if (r.error || r.status !== 0) throw new Error(`git ${argv.join(' ')} failed: ${r.error?.message || r.stderr}`)
}
function writeEvalTree(repo, tree) {
  for (const [p, bytes] of tree) {
    mkdirSync(dirname(join(repo, p)), { recursive: true })
    writeFileSync(join(repo, p), bytes)
  }
}
// A throwaway repo: the base tree committed on main, the head tree committed on a branch. No remote, no hooks.
function evalRepo(c, dir) {
  const repo = join(dir, 'repo')
  mkdirSync(repo, { recursive: true })
  evalGit(repo, ['init', '-q', '-b', 'main'])
  writeEvalTree(repo, c.base)
  evalGit(repo, ['add', '-A', '-f'])
  evalGit(repo, ['commit', '-q', '--no-verify', '--allow-empty', '-m', `base: ${c.id}`])
  evalGit(repo, ['checkout', '-q', '-b', 'eval-case'])
  evalGit(repo, ['rm', '-r', '-q', '--ignore-unmatch', '.'])
  writeEvalTree(repo, c.head)
  evalGit(repo, ['add', '-A', '-f'])
  evalGit(repo, ['commit', '-q', '--no-verify', '--allow-empty', '-m', `head: ${c.id}`])
  return repo
}
const EVAL_CHILDREN = new Set()
// One case review: a child review.mjs in the case's repo, in eval mode, with nothing of this run's REVIEW_* settings.
function evalChild(m, c, repo, logDir, root, timeoutMs) {
  const env = { ...evalEnv(), REVIEW_EVAL: '1', REVIEW_EVAL_ROOT: root, REVIEW_EVAL_LOG_DIR: logDir, REVIEW_BASE: 'main', REVIEW_REVIEWER: m.family, REVIEW_PATHS: '' }
  return new Promise((done) => {
    let out = '', err = '', timedOut = false
    const child = spawnFile(process.execPath, [COPY_PATH, c.intent], { cwd: repo, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    EVAL_CHILDREN.add(child)
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } }
    const timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { err += `\n${e.message}` })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      EVAL_CHILDREN.delete(child)
      kill() // anything the review left running in its group
      done({ code, signal, out, err, timedOut })
    })
  })
}
const evalSpan = (line) => {
  const m = String(line ?? '').trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/)
  if (!m) return null
  const a = Number(m[1]), b = m[2] ? Number(m[2]) : a
  return [Math.min(a, b), Math.max(a, b)]
}
const EVAL_RANK = { high: 3, medium: 2, low: 1 }
// The paths a finding may name: the resolved one when the quote check located it; else the path as cited, with the case
// repo's own folder (as given, or through symlinks) stripped from an absolute path, ./ dropped, and the a/ or b/ diff
// prefix as a second reading.
function evalFindingPaths(place, repo) {
  const resolved = place.where?.path
  if (resolved) return [resolved]
  let p = String(place.file ?? '')
  for (const top of repo ? [repo, realish(repo)] : []) if (p.startsWith(`${top}/`)) { p = p.slice(top.length + 1); break }
  p = p.replace(/^\.\//, '')
  return /^[ab]\//.test(p) ? [p, p.slice(2)] : [p]
}
// A base-side catch: the finding names the expect's file, its cited line is within the expected lines ± EVAL_SLACK, and
// its quote is in the base tree near that cited line, at lines that also overlap the expected ones ± EVAL_SLACK
// (whitespace runs collapsed, as the quote check does). An identical snippet elsewhere in the file does not count.
function quotedInBase(c, e, f, repo) {
  const bytes = c.base.get(e.file), span = evalSpan(f.line)
  if (!bytes || !span || !evalFindingPaths(f, repo).includes(e.file)) return false
  const from = e.lines[0] - EVAL_SLACK, to = e.lines[1] + EVAL_SLACK
  if (span[0] > to || span[1] < from) return false
  const norm = (l) => l.replace(/\s+/g, ' ').trim()
  const q = String(f.quote ?? '').split('\n').map(norm)
  while (q.length && !q[0]) q.shift()
  while (q.length && !q.at(-1)) q.pop()
  if (!q.length) return false
  const lines = bytes.toString('utf8').split('\n').map(norm), needle = q.join('\n')
  for (let s = Math.max(1, span[0] - EVAL_SLACK); s <= span[1] + EVAL_SLACK; s++)
    if (s <= to && s + q.length - 1 >= from && lines.slice(s - 1, s - 1 + q.length).join('\n').includes(needle)) return true
  return false
}
// A finding's places: its main location and every instance, each with its file, line, quote and resolved { path, commit }.
const evalPlaces = (f, record) => [{ file: f.file, line: f.line, quote: f.quote, where: record.resolvedPaths?.[f.id] },
  ...(Array.isArray(f.instances) ? f.instances : []).map((inst, i) => ({ file: inst?.file, line: inst?.line, quote: inst?.quote, where: record.instanceResolved?.[f.id]?.[i] ?? null }))]
function scoreEvalCase(c, record, repo = null) {
  // One entry per located place: a grouped finding catches at any of its places and is tolerated only when all are allowed.
  const located = [], unlocated = []
  for (const f of record.findingDetails || []) {
    const [main] = evalPlaces(f, record)
    if (f.status === 'unverified-quote' || !main.where?.path || !evalSpan(main.line)) { unlocated.push(f); continue }
    for (const place of evalPlaces(f, record)) {
      const where = place.where, span = evalSpan(place.line)
      if (where?.path && span)
        located.push({ f, path: where.path, side: where.commit === record.head ? 'head' : where.commit === record.baseSha ? 'base' : null, span, line: place.line })
    }
  }
  // One entry per finding, its first place in the list.
  const findingsOf = (list) => list.filter((l, i) => list.findIndex((o) => o.f.id === l.f.id) === i)
  const near = (target, side) => located.filter((l) => l.path === target.file && l.side === side &&
    l.span[0] <= target.lines[1] + EVAL_SLACK && l.span[1] >= target.lines[0] - EVAL_SLACK)
  const strongest = (list) => [...list].sort((a, b) => (EVAL_RANK[b.f.severity] || 0) - (EVAL_RANK[a.f.severity] || 0))[0]
  if (c.kind === 'bug') {
    const used = new Set()
    const expects = c.expect.map((e) => {
      // Removed code has no line at HEAD when its file survives, so the quote check leaves such a finding unlocated (or
      // locates it at HEAD): a base-side expect also takes any finding on that file whose quote is in the base tree there.
      const hits = [...near(e, e.side), ...(e.side === 'base' ? (record.findingDetails || [])
        .filter((f) => evalPlaces(f, record).some((place) => quotedInBase(c, e, place, repo))).map((f) => ({ f })) : [])]
      hits.forEach((l) => used.add(l.f.id))
      const best = strongest(hits)
      return { file: e.file, side: e.side, lines: e.lines, caught: !!best, ...(best && { by: best.f.id, severity: best.f.severity }) }
    })
    const caught = expects.every((e) => e.caught)
    const weakest = caught ? expects.map((e) => e.severity).sort((a, b) => (EVAL_RANK[a] || 0) - (EVAL_RANK[b] || 0))[0] : null
    return { outcome: caught ? 'caught' : 'missed', severity: weakest, expects, extra: findingsOf(located.filter((l) => !used.has(l.f.id))).length,
      unlocated: unlocated.filter((f) => !used.has(f.id)).length }
  }
  const tolerated = new Set(c.allow.flatMap((a) => near(a, 'head')))
  // A finding is outside the allow list when any of its places is (shown at its first such place).
  const outside = findingsOf(located.filter((l) => !tolerated.has(l)))
  const alarms = outside.filter((l) => blocking(l.f))
  const outsideIds = new Set(outside.map((l) => l.f.id))
  return {
    outcome: alarms.length ? 'false-alarm' : 'clean',
    falseAlarms: alarms.length,
    alarms: alarms.map((l) => ({ id: l.f.id, file: l.path, line: l.line, severity: l.f.severity, ...(l.f.unscored && { unscored: true }) })),
    lows: outside.length - alarms.length,
    allowed: findingsOf(located.filter((l) => !outsideIds.has(l.f.id))).length,
    unlocated: unlocated.length,
  }
}
async function evalOne(m, c, run, root, timeoutMs) {
  const dir = join(root, `${m.family}-${c.id}-${run}`), logDir = join(dir, 'log')
  const started = Date.now()
  const base = { id: c.id, kind: c.kind, run, caseHash: c.hash }
  let error = null, record = null, repo = null
  try {
    repo = evalRepo(c, dir)
    const r = await evalChild(m, c, repo, logDir, root, timeoutMs)
    if (r.timedOut) error = `timed out after ${evalDuration(timeoutMs)}`
    else if (r.code !== 0) error = `the review exited ${r.code ?? r.signal}: ${tail(r.err || r.out)}`
    else {
      // The result is the review record in this case's own eval log (it logs one review), never stdout: a CLI can
      // echo its answer there, and a finding may quote the FINDINGS_JSON delimiter.
      const logFile = join(logDir, 'review-log.jsonl')
      const reviews = (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n') : []).flatMap((line) => {
        try { const e = JSON.parse(line); return e?.type === 'review' && e.kind === 'review' ? [e] : [] } catch { return [] }
      })
      if (reviews.length === 1) record = reviews[0]
      else error = reviews.length ? `its eval log holds ${reviews.length} review records, not one` : 'the review logged no record (nothing reviewed?)'
    }
  } catch (e) { error = e.message }
  const durationMs = Date.now() - started
  if (error) return { ...base, outcome: 'errored', error, durationMs, kept: dir }
  rmSync(dir, { recursive: true, force: true })
  return {
    ...base, ...scoreEvalCase(c, record, repo), durationMs, reviewId: record.id, model: record.model ?? null,
    ...(record.modelUsed && { modelUsed: record.modelUsed }), ...(record.lenses && { lenses: record.lenses }), effort: record.effort ?? null,
    security: record.security?.status ?? null,
  }
}
function evalTotals(cases) {
  const done = cases.filter((c) => c.outcome !== 'errored'), bugs = done.filter((c) => c.kind === 'bug'), clean = done.filter((c) => c.kind === 'clean')
  const sum = (list, key) => list.reduce((n, c) => n + (c[key] || 0), 0)
  return {
    bugs: bugs.length, caught: bugs.filter((c) => c.outcome === 'caught').length, missed: bugs.filter((c) => c.outcome === 'missed').length,
    clean: clean.length, cleanWithAlarms: clean.filter((c) => c.outcome === 'false-alarm').length, falseAlarms: sum(clean, 'falseAlarms'),
    extra: sum(bugs, 'extra'), unlocated: sum(done, 'unlocated'), errored: cases.length - done.length, durationMs: sum(cases, 'durationMs'),
  }
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const evalCaseLine = (c, repeat) => {
  const detail = c.outcome === 'caught' ? ` (${c.severity}, ${c.expects.map((e) => e.by).join(', ')})`
    : c.outcome === 'false-alarm' ? ` (${c.alarms.map((a) => `${a.severity} ${a.file}:${a.line}`).join(', ')})`
    : c.outcome === 'errored' ? `: ${c.error.split('\n').at(-1) || c.error}` : ''
  const counts = [c.extra && `${c.extra} extra`, c.lows && `${c.lows} low`, c.unlocated && `${c.unlocated} unlocated`].filter(Boolean)
  return `  ${c.id} [${c.kind}] ${c.outcome}${detail}${counts.length ? ` · ${counts.join(', ')}` : ''}${repeat > 1 ? ` · run ${c.run}` : ''} · ${(c.durationMs / 1000).toFixed(1)}s`
}
async function runEval() {
  const casesDir = resolve(option('--cases') ?? EVAL_CASES)
  const repeat = Number(option('--repeat') ?? 1)
  if (!Number.isSafeInteger(repeat) || repeat < 1) throw new Error('--repeat must be a whole number of 1 or more')
  const timeoutMs = evalTimeout(option('--timeout'))
  const { cases, skipped } = loadEvalCases(casesDir)
  for (const s of skipped) console.warn(`⚠ skipped ${s.name}: ${s.error}`)
  if (!cases.length) throw new Error(`No valid case in ${casesDir}${skipped.length ? ' (every entry was skipped above)' : ''}`)
  const { families, skipped: missing } = evalFamilies(option('--family'))
  for (const s of missing) console.warn(`⚠ ${s} — skipped`)
  if (!families.length) throw new Error('No family to evaluate can run here')
  const reviews = families.length * cases.length * repeat
  const calls = families.reduce((n, m) => n + m.calls, 0) * cases.length * repeat
  console.log(`▶ eval · ${plural(families.length, 'family', 'families')} (${families.map((m) => m.family).join(', ')}) × ${plural(cases.length, 'case')} × ` +
    `${plural(repeat, 'run')} = ${plural(reviews, 'review')}${calls !== reviews ? ` (${calls} model calls)` : ''} · cases ${casesDir}`)
  for (const m of families.filter((f) => f.team)) console.log(`ℹ ${m.family} runs as the multi-agent team: ${m.calls} model calls per review`)
  console.log('ℹ a finding with missing scores adds one model call to its review; each review times out after ' + evalDuration(timeoutMs))
  if (reviews > EVAL_GUARD && !args.includes('--yes')) {
    console.error(`✖ That is ${plural(reviews, 'review')}, more than ${EVAL_GUARD}: pass --yes to run them.`)
    process.exitCode = 1
    return
  }
  const stopChildren = () => { for (const child of EVAL_CHILDREN) try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } process.exit(130) }
  process.once('SIGINT', stopChildren)
  process.once('SIGTERM', stopChildren)
  const runtimeHash = sha256(readFileSync(COPY_PATH)), runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`
  const root = mkdtempSync(join(tmpdir(), 'review-eval-'))
  const records = []
  for (const m of families) {
    console.log(`\n▶ ${m.family} (${m.vendor}${m.id ? ` · ${m.id}` : ''})`)
    const results = []
    for (const c of cases)
      for (let run = 1; run <= repeat; run++) {
        const result = await evalOne(m, c, run, root, timeoutMs)
        results.push(result)
        console.log(evalCaseLine(result, repeat))
      }
    const ran = results.find((r) => r.outcome !== 'errored')
    const modelUsed = [...new Set(results.map((r) => r.modelUsed).filter(Boolean))]
    records.push({
      type: 'eval', ts: new Date().toISOString(), runId, family: m.family, vendor: m.vendor, model: ran?.model ?? m.id ?? null,
      effort: ran?.effort ?? m.effort ?? null, ...(modelUsed.length && { modelUsed }), rubricVersion: RUBRIC_VERSION, runtimeHash,
      promptHash: evalPromptHash(m), casesDir, caseIds: cases.map((c) => c.id), repeat, timeoutMs, totals: evalTotals(results), cases: results,
    })
  }
  const evalLog = join(dirname(LOG_PATH), 'eval-log.jsonl')
  mkdirSync(dirname(evalLog), { recursive: true })
  withLogLock(() => appendFileSync(evalLog, records.map((r) => `${JSON.stringify(r)}\n`).join('')), evalLog)
  console.log('')
  for (const r of records) {
    const t = r.totals
    console.log(`${r.family} (${r.model} · ${r.effort}) · bugs caught ${t.caught}/${t.bugs} · missed ${t.missed} · false alarms ${t.falseAlarms} ` +
      `(${t.cleanWithAlarms}/${t.clean} clean cases) · extra ${t.extra} · unlocated ${t.unlocated} · errored ${t.errored} · n=${r.repeat} · ${(t.durationMs / 1000).toFixed(1)}s`)
  }
  if (readdirSync(root).length) console.log(`ℹ kept for inspection: ${root} (the repos and logs of the reviews that errored)`)
  else rmSync(root, { recursive: true, force: true })
  console.log(`ℹ logged ${plural(records.length, 'record')} to ${evalLog}`)
  console.log(`\n===EVAL_JSON===\n${JSON.stringify(records, null, 2)}`)
}
// ── main ─────────────────────────────────────────────────────────────────────
;(async function main() {
  if (args.includes('--rubric')) return console.log(`Rubric version: ${RUBRIC_VERSION}\n${RUBRIC}`)
  if (args.includes('--calibrate')) return calibrate()
  if (args.includes('--eval')) return runEval()
  if (args.includes('--gate')) return pushGate()
  if (args.includes('--log-grade')) return logGrade(option('--log-grade'))
  if (args.includes('--recheck-of')) throw new Error('--recheck-of requires --log-grade <verdict.json>')
  if (args.includes('--close')) return closeReview(option('--close'))
  if (args.includes('--dispute')) return disputeFinding(option('--dispute'), args[args.indexOf('--dispute') + 2])
  if (args.includes('--waive')) return waiveFinding(option('--waive'), args[args.indexOf('--waive') + 2])
  if (args.includes('--summary')) return printSummary()
  if (args.includes('--tier-json')) return printTierJson()
  if (args.includes('--deferred')) return printDeferred()
  if (args.includes('--noise-report')) return noiseReport()
  if (args.includes('--fix-check')) return fixCheck(option('--fix-check'))
  if (args.includes('--slices')) return runSlices()
  if (args.includes('--security-worker')) return securityWorker(option('--security-worker'))
  if (args.includes('--security-only')) return runSecurityOnly()
  if (args.includes('--security-findings')) return printSecurityFindings()
  const { branch, diff, head: reviewedHead, baseSha, files: sliceFileList } = getDiff()
  refuseLinkedReviews()
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

  // The security pass, when required, starts now (the diff, context and verify result are known) and runs beside the
  // code reviewer; its findings join this record once both are done.
  // --code-only (the /code-review skill): no security pass, recorded as not asked, so the merge tier still says when a
  // security.run that is on needed one.
  const securityPlan = args.includes('--code-only') && SECURITY.run !== 'off'
    ? { record: { run: SECURITY.run, status: 'not-asked', reason: 'code-only run' } }
    : beginSecurity({ stats, diff })
  const started = Date.now()
  const scored = await scoredFindings(await review(diff), SEL)
  const raw = scored.findings
  const durationMs = Date.now() - started
  // A finding that can't point at real code is not a finding — list it apart, never drop it.
  const located = []
  const unlocated = []
  for (const f of raw) {
    const finding = locatedFinding(f)
    if (finding.status === 'unverified-quote') unlocated.push(finding)
    else located.push(finding)
  }
  if (unlocated.length)
    console.warn(`⚠ ${unlocated.length} finding(s) quote code that isn't at the cited place — listed under "could not be located"`)
  const ambiguous = located.filter((f) => f[WHERE]?.ambiguous).length
  if (ambiguous) console.warn(`⚠ ${ambiguous} finding(s) quote code found at two paths (a/ or b/ and without); they authorize no file at close`)

  let opinion = { verifier: null }
  if (SECOND_OPINION) {
    const targets = located.filter((f) => !isFiled(f) && !(isLegacy(f) && f.severity === 'low'))
    if (targets.length) opinion = await secondOpinion(diff, targets)
  }
  const disputed = located.filter((f) => f.secondOpinion?.verdict === 'REFUTED').map((f) => ({ ...f, status: 'disputed' }))
  const findings = located.filter((f) => f.secondOpinion?.verdict !== 'REFUTED')

  const security = await finishSecurity(securityPlan)
  const securityLocated = [], securityUnlocated = []
  for (const f of security.raw) {
    const finding = { ...locatedFinding(scoreFinding(f)), source: 'security' }
    if (finding.status === 'unverified-quote') securityUnlocated.push(finding)
    else securityLocated.push(finding)
  }
  if (security.record.status === 'ran') {
    security.record.findings = securityLocated.length
    console.log(`▶ security pass · ${security.record.family}: ${securityLocated.length} finding(s), ${securityUnlocated.length} could not be located`)
  }

  requireClean()
  if (headNow() !== reviewedHead) throw new Error('HEAD changed during review')
  const findingDetails = [...findings, ...disputed, ...unlocated]
  findingDetails.forEach((finding, i) => { finding.id = `f${i + 1}` })
  const securityDetails = [...securityLocated, ...securityUnlocated]
  securityDetails.forEach((finding, i) => { finding.id = `s${i + 1}` })
  findingDetails.push(...securityDetails)
  markPreExisting(findingDetails, baseSha, reviewedHead)
  warnDropped(findingDetails)
  const allFindings = [...findings, ...securityLocated], allUnlocated = [...unlocated, ...securityUnlocated]
  const reviewedFiles = sliceFileList || filesBetween(baseSha, reviewedHead)
  const truncated = truncatedFiles(diff, reviewedFiles)
  // The file states the security pass saw (the same diff as the code review, minus what the size cap cut): close checks
  // the closing HEAD against them.
  if (security.record.status === 'ran') security.record.saw = coverageOf(reviewedHead, reviewedFiles.filter((p) => !truncated.includes(p)))
  const dir = writeReport(branch, reviewer, { findings: allFindings, unlocated: allUnlocated, disputed }, diffTruncated, opinion.verifier, security.record)
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
    ...recordedLocations(findingDetails),
    id: reviewId,
    ts: new Date().toISOString(),
    repo: repoName(),
    base: BASE,
    baseSha,
    repoId: repoIdentity(),
    ...(SLICE && { paths: SLICE, files: sliceFileList }),
    truncated,
    stats: recordStats(stats),
    plan: PLAN_PATH ?? null,
    intent: INTENT || null,
    family: SEL.family,
    families: [...new Set([...reviewingFamilies(SEL), ...(security.record.status === 'ran' ? [security.record.family] : [])])],
    model: SEL.id,
    ...(SEL.modelUsed && { modelUsed: SEL.modelUsed }),
    effort: SEL.effort,
    vendor: SEL.vendor,
    findings: allFindings.length,
    raw: raw.length + security.raw.length,
    unverified: allUnlocated.length,
    disputed: disputed.length,
    ...(SELECTION.classifier && classifierRecord(SELECTION.classifier.command, SELECTION.classifier.answer)),
    ...(SECOND_OPINION && {
      secondOpinion: opinion.verifier
        ? { family: opinion.verifier.family, model: opinion.verifier.id, ...(opinion.error && { error: opinion.error }) }
        : { error: opinion.error || 'no HIGH/MEDIUM findings' },
    }),
    durationMs,
    security: security.record,
    ...(EVAL_MODE && SEL.team && { lenses: SEL.lenses.map(({ key, family, model, modelUsed }) => ({ key, family, model, ...(modelUsed && { modelUsed }) })) }),
    dir,
  })
  const counts = ['high', 'medium', 'low']
    .map((s) => `${allFindings.filter((f) => f.severity === s).length} ${s}`)
    .join(', ')
  console.log(
    `\n✓ Review complete — ${allFindings.length} finding(s) (${counts}); ${disputed.length} disputed, ` +
      `${allUnlocated.length} could not be located. Report: ${dir}/code-review.md`,
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
      findings: allFindings.map(publicFinding),
      disputed: disputed.map(publicFinding),
      unverified: allUnlocated.map(publicFinding),
      security: security.record,
    }, null, 2),
  )
  // Piped (the slice runner reads it), stdout may still be queued: exit only once it has drained.
  await Promise.all([process.stdout, process.stderr].map((stream) => new Promise((done) => stream.write('', done))))
  process.exit(0)
})().catch((e) => die(e.message))
