#!/usr/bin/env node
// merge.mjs — the agent merge. Run once by the orchestrator after the PR is open:
//   node merge.mjs [--pr <n>] [--dry-run]
// It reads the tip's merge tier and policy (review.mjs --tier-json) and does exactly one thing: merges the PR with a
// merge commit when every safety check passes, labels it needs-human and comments once, or nothing.
// One stdout line, and its exit code: merged 0 | labeled 10 | none 0 (policy off) or 11 (onHuman none) | refused 2.
// Never --auto, --admin, --squash or --rebase. Every run logs an intent record, then an outcome record, to
// merge-log.jsonl beside the review log.
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const PR_ARG = args.includes('--pr') ? args[args.indexOf('--pr') + 1] : null
const LABEL = 'needs-human'
const EXIT = { merged: 0, labeled: 10, refused: 2 }
// DIRTY (conflicts) and a still-UNKNOWN state refuse; BLOCKED (branch protection) needs a human.
const REFUSED_STATES = ['DIRTY', 'UNKNOWN']
// GitHub computes mergeability lazily: an UNKNOWN state is read again up to 3 times, this far apart.
const UNKNOWN_DELAY = ((v) => Number.isFinite(v) && v >= 0 ? v : 5000)(Number(process.env.MERGE_UNKNOWN_DELAY_MS ?? 5000))
const UNKNOWN_REREADS = 3
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const GREEN = ['pass', 'skipping']
const RUN = `${new Date().toISOString()}-${randomBytes(3).toString('hex')}`

const run = (cmd, argv, cwd = undefined) => {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...(cwd && { cwd }) })
  return { code: r.error ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error }
}
const git = (...argv) => run('git', argv)
const firstLine = (r) => (r.error?.message || r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).split('\n')[0]

// The merge log sits beside the review log, in a folder that already exists: merge.mjs never creates one, so it
// can't change where review.mjs looks. --tier-json names the review log; before that, the folder review.mjs would use
// (the ACS folder, else ~/.claude/review-log/, else beside ~/.claude/review-log.jsonl). With none, records go to stderr.
const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }
function existingLogDir(home = homedir()) {
  for (const dir of [join(home, '.agent-config-studio', 'review-log'), join(home, '.claude', 'review-log')]) if (isDir(dir)) return dir
  return existsSync(join(home, '.claude', 'review-log.jsonl')) ? join(home, '.claude') : null
}
let logDir = existingLogDir()
let context = { run: RUN, dryRun: DRY, pr: PR_ARG ? Number(PR_ARG) : null, tip: null, policy: null, tier: null }
// true when the record was appended to the merge log.
function log(entry) {
  const line = JSON.stringify({ type: 'merge', ts: new Date().toISOString(), ...context, ...entry })
  if (!logDir || !isDir(logDir)) { console.error(`merge.mjs: no review log folder${logDir ? ` (${logDir} is missing)` : ''}; record: ${line}`); return false }
  const file = join(logDir, 'merge-log.jsonl')
  try { appendFileSync(file, line + '\n'); return true }
  catch (e) { console.error(`merge.mjs: could not append to ${file}: ${e.message}; record: ${line}`); return false }
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
// From the toplevel, so the repo's .claude/review-config.json counts wherever merge.mjs was started.
const tierRun = run(process.execPath, [script, '--tier-json'], top.stdout.trim())
if (tierRun.stderr) process.stderr.write(tierRun.stderr)
let tier
try { tier = JSON.parse(tierRun.stdout.trim().split('\n').at(-1)) } catch { tier = null }
if (!tier || typeof tier !== 'object' || typeof tier.covered !== 'boolean')
  refuse(`${script} --tier-json gave no tier (exit ${tierRun.code}): ${firstLine(tierRun)}`)
if (typeof tier.logPath === 'string' && tier.logPath) logDir = dirname(tier.logPath)
context = { ...context, tip: tier.tip ?? null, policy: tier.policy ?? null, tier: tier.tier ?? null }
// No durable intent record, no gh call: refused, and nothing more is written.
if (!log({ phase: 'intent' })) {
  console.log(`refused${DRY ? ' (dry run)' : ''}: the intent record could not be written to the merge log (see stderr)`)
  process.exit(EXIT.refused)
}
intentLogged = true

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
function readPr() {
  const viewed = run('gh', ['pr', 'view', ...(PR_ARG ? [PR_ARG] : []), '--json', FIELDS])
  if (viewed.code !== 0) refuse(`gh pr view failed: ${firstLine(viewed)}`)
  let read
  try { read = JSON.parse(viewed.stdout) } catch { read = null }
  if (!read || typeof read !== 'object' || !Number.isInteger(read.number)) refuse(`gh pr view gave unreadable output: ${viewed.stdout.slice(0, 200)}`)
  return read
}
let pr = readPr()
for (let i = 0; i < UNKNOWN_REREADS && pr.mergeStateStatus === 'UNKNOWN'; i++) { sleep(UNKNOWN_DELAY); pr = readPr() }
context.pr = pr.number
const n = String(pr.number)
if (pr.state !== 'OPEN') refuse(`PR #${n} is ${pr.state}, not OPEN`)
if (pr.isDraft) refuse(`PR #${n} is a draft`)
if (pr.headRefOid !== HEAD) refuse(`PR #${n} head ${pr.headRefOid} is not local HEAD ${HEAD}`)
const reviewBase = branchName(tier.baseRef)
if (!reviewBase || pr.baseRefName !== reviewBase)
  refuse(`PR #${n} base ${pr.baseRefName} is not the review's base ${tier.baseRef ?? '(unknown)'}`)
if (REFUSED_STATES.includes(pr.mergeStateStatus))
  refuse(`PR #${n} merge state is ${pr.mergeStateStatus}${pr.mergeStateStatus === 'UNKNOWN' ? ` after ${UNKNOWN_REREADS} re-reads` : ''}`)
if (pr.reviewDecision === 'CHANGES_REQUESTED') refuse(`PR #${n} review decision is CHANGES_REQUESTED`)

// 4. Would merge only when the tier says so and nothing on the PR says otherwise.
const labeled = Array.isArray(pr.labels) && pr.labels.some((l) => l?.name === LABEL)
const tierLine = `Merge tier: ${tier.tier ? tier.tier.toUpperCase() : 'none'} (${(tier.reasons || []).join('; ')}). Policy ${tier.policy}: ${tier.merges ? 'would merge' : 'needs a human'}`
const human = []
if (!tier.merges) human.push(tier.tier ? `tier ${tier.tier.toUpperCase()} under policy ${tier.policy}` : (tier.reasons || []).join('; ') || 'no merge tier')
if (pr.mergeStateStatus === 'BLOCKED') human.push('blocked by branch protection')
if (tier.merges) {
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

// A base with a merge queue never merges here: gh would queue the PR, and --disable-auto can't take it out again.
const [owner, name] = (String(pr.url || '').match(/\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/) || []).slice(1)
if (!human.length) {
  if (!owner || !name) refuse(`could not tell the repository from the PR url ${JSON.stringify(pr.url)} to check for a merge queue`)
  const queue = graphql('query($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) { mergeQueue(branch: $branch) { id } } }',
    ['-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `branch=${pr.baseRefName}`])
  if (!queue.data?.repository) refuse(`could not check the base for a merge queue: ${queue.error}`)
  if (queue.data.repository.mergeQueue) human.push('base uses a merge queue')
}
if (!human.length) {
  if (DRY) finish('merged', `PR #${n} would merge at ${HEAD}`)
  const merged = run('gh', ['pr', 'merge', n, '--merge', '--match-head-commit', HEAD])
  if (merged.code !== 0) refuse(`gh pr merge failed: ${firstLine(merged)}`)
  // Success may only have queued it or set auto-merge: merged means state MERGED now.
  const after = graphql('query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id state isInMergeQueue autoMergeRequest { enabledAt } } } }',
    ['-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${n}`])
  const now = after.data?.repository?.pullRequest
  if (now?.state === 'MERGED') finish('merged', `PR #${n} at ${HEAD}`)
  if (now?.isInMergeQueue) {
    const dequeued = graphql('mutation($id: ID!) { dequeuePullRequest(input: { id: $id }) { clientMutationId } }', ['-f', `id=${now.id}`])
    if (!dequeued.data) refuse(`gh pr merge put PR #${n} in a merge queue and dequeuing it failed, so it may still be queued: ${dequeued.error}`)
    human.push('base uses a merge queue; not merged')
  } else {
    // We never enable auto-merge, so take back whatever the merge call set; nothing set fails harmlessly.
    run('gh', ['pr', 'merge', n, '--disable-auto'])
    if (!now) refuse(`gh pr merge ran, but its result could not be read, so PR #${n} may still be queued (auto-merge disabled if it was on): ${after.error}`)
    human.push('base uses a merge queue or auto-merge; not merged')
  }
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

// gh api graphql: { data } or { error }.
function graphql(query, vars) {
  const r = run('gh', ['api', 'graphql', '-f', `query=${query}`, ...vars])
  let body = null
  try { body = JSON.parse(r.stdout) } catch { /* below */ }
  if (r.code === 0 && body?.data && !body.errors) return { data: body.data }
  return { error: body?.errors?.map((e) => e.message).join('; ') || firstLine(r) }
}
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
