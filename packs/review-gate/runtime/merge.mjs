#!/usr/bin/env node
// merge.mjs — the agent merge. Run once by the orchestrator after the PR is open:
//   node merge.mjs [--pr <n>] [--dry-run]
// It reads the tip's merge tier and policy (review.mjs --tier-json) and does exactly one thing: merges the PR with a
// merge commit when every safety check passes, labels it needs-human and comments once, or nothing.
// One stdout line, and its exit code: merged 0 | labeled 10 | none 0 (policy off) or 11 (onHuman none) | refused 2.
// Never --auto, --admin, --squash or --rebase. Every run logs an intent record, then an outcome record, to
// merge-log.jsonl beside the review log.
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const PR_ARG = args.includes('--pr') ? args[args.indexOf('--pr') + 1] : null
const LABEL = 'needs-human'
const EXIT = { merged: 0, labeled: 10, refused: 2 }
const NOT_GREEN_STATES = ['DIRTY', 'BLOCKED', 'UNKNOWN']
const GREEN = ['pass', 'skipping']
const RUN = `${new Date().toISOString()}-${randomBytes(3).toString('hex')}`

const run = (cmd, argv, input) => {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...(input !== undefined && { input }) })
  return { code: r.error ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error }
}
const git = (...argv) => run('git', argv)
const firstLine = (r) => (r.error?.message || r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).split('\n')[0]

// Before --tier-json names the log, the fallback is the review log's default folder.
let logFile = join(homedir(), '.agent-config-studio', 'review-log', 'merge-log.jsonl')
let context = { run: RUN, dryRun: DRY, pr: PR_ARG ? Number(PR_ARG) : null, tip: null, policy: null, tier: null }
function log(entry) {
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    appendFileSync(logFile, JSON.stringify({ type: 'merge', ts: new Date().toISOString(), ...context, ...entry }) + '\n')
  } catch (e) { console.error(`merge.mjs: could not append to ${logFile}: ${e.message}`) }
}
let intentLogged = false
function finish(action, detail, code = EXIT[action]) {
  if (!intentLogged) log({ phase: 'intent' })
  log({ phase: 'outcome', action, reason: detail })
  console.log(`${action}${DRY ? ' (dry run)' : ''}: ${detail}`)
  process.exit(code)
}
const refuse = (reason) => finish('refused', reason)

// 1. The review script: the repo's scripts/review.mjs, else the shared runtime beside this file.
const top = git('rev-parse', '--show-toplevel')
if (top.code !== 0) refuse(`not in a git work tree: ${firstLine(top)}`)
const repoScript = join(top.stdout.trim(), 'scripts', 'review.mjs')
const script = existsSync(repoScript) ? repoScript : join(dirname(fileURLToPath(import.meta.url)), 'review.mjs')
const tierRun = run(process.execPath, [script, '--tier-json'])
if (tierRun.stderr) process.stderr.write(tierRun.stderr)
let tier
try { tier = JSON.parse(tierRun.stdout.trim().split('\n').at(-1)) } catch { tier = null }
if (!tier || typeof tier !== 'object' || typeof tier.covered !== 'boolean')
  refuse(`${script} --tier-json gave no tier (exit ${tierRun.code}): ${firstLine(tierRun)}`)
if (typeof tier.logPath === 'string' && tier.logPath) logFile = join(dirname(tier.logPath), 'merge-log.jsonl')
context = { ...context, tip: tier.tip ?? null, policy: tier.policy ?? null, tier: tier.tier ?? null }
log({ phase: 'intent' }); intentLogged = true

// 2. Covered, then the policy: off does nothing and never calls gh.
if (!tier.covered) refuse(tier.reason || 'the tip is not covered by a complete close')
if (tier.policy === 'off') finish('none', 'merge policy off', 0)
const settings = { onHuman: 'comment', humanComment: 'Needs human approval before merging.', requireChecks: true, allowBehind: false, ...(tier.merge || {}) }

// 3. Local state, then the PR.
const HEAD = git('rev-parse', 'HEAD').stdout.trim()
if (tier.tip !== HEAD) refuse(`the tier's tip ${tier.tip} is not HEAD ${HEAD}`)
const status = git('status', '--porcelain', '--untracked-files=no')
if (status.code !== 0 || status.stdout.trim()) refuse('the working tree has uncommitted tracked changes')
const FIELDS = 'number,state,isDraft,headRefOid,baseRefName,mergeStateStatus,reviewDecision,labels,url'
const viewed = run('gh', ['pr', 'view', ...(PR_ARG ? [PR_ARG] : []), '--json', FIELDS])
if (viewed.code !== 0) refuse(`gh pr view failed: ${firstLine(viewed)}`)
let pr
try { pr = JSON.parse(viewed.stdout) } catch { pr = null }
if (!pr || typeof pr !== 'object' || !Number.isInteger(pr.number)) refuse(`gh pr view gave unreadable output: ${viewed.stdout.slice(0, 200)}`)
context.pr = pr.number
const n = String(pr.number)
if (pr.state !== 'OPEN') refuse(`PR #${n} is ${pr.state}, not OPEN`)
if (pr.isDraft) refuse(`PR #${n} is a draft`)
if (pr.headRefOid !== HEAD) refuse(`PR #${n} head ${pr.headRefOid} is not local HEAD ${HEAD}`)
const reviewBase = branchName(tier.baseRef)
if (!reviewBase || pr.baseRefName !== reviewBase)
  refuse(`PR #${n} base ${pr.baseRefName} is not the review's base ${tier.baseRef ?? '(unknown)'}`)
if (NOT_GREEN_STATES.includes(pr.mergeStateStatus)) refuse(`PR #${n} merge state is ${pr.mergeStateStatus}`)
if (pr.reviewDecision === 'CHANGES_REQUESTED') refuse(`PR #${n} review decision is CHANGES_REQUESTED`)

// 4. Would merge only when the tier says so and nothing on the PR says otherwise.
const labeled = Array.isArray(pr.labels) && pr.labels.some((l) => l?.name === LABEL)
const tierLine = `Merge tier: ${tier.tier ? tier.tier.toUpperCase() : 'none'} (${(tier.reasons || []).join('; ')}). Policy ${tier.policy}: ${tier.merges ? 'would merge' : 'needs a human'}`
const human = []
if (!tier.merges) human.push(tier.tier ? `tier ${tier.tier.toUpperCase()} under policy ${tier.policy}` : (tier.reasons || []).join('; ') || 'no merge tier')
else {
  if (labeled) human.push(`the PR has the ${LABEL} label`)
  if (pr.mergeStateStatus === 'BEHIND' && !settings.allowBehind) human.push('base moved: the base branch has commits the review did not see')
  const checked = run('gh', ['pr', 'checks', n, '--json', 'name,state,bucket'])
  let checks = null
  try { checks = JSON.parse(checked.stdout) } catch { /* below */ }
  if (!Array.isArray(checks)) {
    if (/no checks reported/i.test(checked.stderr)) checks = []
    else refuse(`gh pr checks failed: ${firstLine(checked)}`)
  }
  const notGreen = checks.filter((c) => !GREEN.includes(c?.bucket))
  if (notGreen.length) human.push(`checks not green: ${notGreen.map((c) => `${c?.name} (${c?.bucket})`).join(', ')}`)
  if (!checks.length && settings.requireChecks) human.push('no CI checks')
}

if (!human.length) {
  if (DRY) finish('merged', `PR #${n} would merge at ${HEAD}`)
  const merged = run('gh', ['pr', 'merge', n, '--merge', '--match-head-commit', HEAD])
  if (merged.code !== 0) refuse(`gh pr merge failed: ${firstLine(merged)}`)
  finish('merged', `PR #${n} at ${HEAD}`)
}

// 5. Needs a human.
const why = human.join('; ')
if (settings.onHuman === 'none') finish('none', `PR #${n} needs a human (${why}); onHuman none`, 11)
if (labeled) finish('labeled', `PR #${n} already has ${LABEL} (${why}); no new comment`)
if (DRY) finish('labeled', `PR #${n} would get ${LABEL} and one comment (${why})`)
const listed = run('gh', ['label', 'list', '--search', LABEL, '--json', 'name', '--limit', '100'])
let repoLabels
try { repoLabels = JSON.parse(listed.stdout) } catch { repoLabels = null }
if (listed.code !== 0 || !Array.isArray(repoLabels)) refuse(`gh label list failed: ${firstLine(listed)}`)
if (!repoLabels.some((l) => l?.name === LABEL)) {
  const created = run('gh', ['label', 'create', LABEL, '--color', 'D93F0B', '--description', 'A human approves before this merges'])
  if (created.code !== 0) refuse(`gh label create failed: ${firstLine(created)}`)
}
const added = run('gh', ['pr', 'edit', n, '--add-label', LABEL])
if (added.code !== 0) refuse(`gh pr edit --add-label failed: ${firstLine(added)}`)
const body = `${settings.humanComment}\n\n${tierLine}\n\nWhy a human: ${why}`
const commented = run('gh', ['pr', 'comment', n, '--body', body])
if (commented.code !== 0) refuse(`gh pr comment failed (the label was added): ${firstLine(commented)}`)
finish('labeled', `PR #${n} labeled ${LABEL} (${why})`)

// The review's base as a branch name: refs/heads/x, refs/remotes/<remote>/x and <remote>/x all name x.
function branchName(ref) {
  if (typeof ref !== 'string' || !ref) return null
  let name = ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '')
  const remotes = git('remote').stdout.split('\n').filter(Boolean)
  const remote = remotes.find((r) => name.startsWith(`${r}/`))
  if (remote) name = name.slice(remote.length + 1)
  else if (ref.startsWith('refs/remotes/')) name = name.split('/').slice(1).join('/')
  return name
}
