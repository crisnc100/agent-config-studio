#!/usr/bin/env node
/**
 * pr.test.mjs — the /pr helper (builds/pr-description/plan.md): the facts it gathers from a fixture repo (files by
 * purpose, the base, the plan, the review gate's three states, the docs check), the style file (lazy creation, the
 * Codex-sandbox fallback, reorder and off, the pinned "Deferred findings", warnings in the JSON), the GIF pick, and
 * --check on good and broken descriptions. One case runs the real review-gate review.mjs against a temp log.
 * Every run is a temp HOME with stub CLIs; gh is a stub or absent; no model is ever called.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HELPER = resolve(HERE, '../skills/claude/pr/pr-facts.mjs')
const EXAMPLE = resolve(HERE, '../skills/claude/pr/style.example.json')
const REVIEW = resolve(HERE, '../../review-gate/runtime/review.mjs')
const roots = []
after(() => { for (const r of roots) { try { chmodSync(join(r, 'home/.agent-config-studio'), 0o700) } catch {} rmSync(r, { recursive: true, force: true }) } })

function box() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pr-test-')))
  roots.push(root)
  const home = join(root, 'home'), repo = join(root, 'repo'), bin = join(root, 'bin'), nodeBin = join(root, 'node-bin')
  for (const d of [home, repo, bin, nodeBin]) mkdirSync(d)
  // Only a `node` link, never Node's own folder: that folder may hold real CLIs (gh, claude, codex) that would leak in.
  symlinkSync(process.execPath, join(nodeBin, 'node'))
  const env = { HOME: home, CODEX_HOME: join(home, '.codex'), PATH: [bin, nodeBin, '/usr/bin', '/bin'].join(':'), LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), TMPDIR: root }
  const sh = (cmd, args, extra = {}) => {
    const r = spawnSync(cmd, args, { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
    return { code: r.status, stdout: r.stdout || '', out: `${r.stdout || ''}\n${r.stderr || ''}` }
  }
  const git = (...args) => { const r = sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args]); assert.equal(r.code, 0, r.out); return r.stdout.trim() }
  const write = (files) => { for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(repo, p)), { recursive: true }); writeFileSync(join(repo, p), t) } }
  const commit = (files, msg = `change ${Object.keys(files).join(' ')}`) => { write(files); git('add', '-A'); git('commit', '-qm', msg); return git('rev-parse', 'HEAD') }
  const helper = (args = [], extra = {}) => sh(process.execPath, [HELPER, ...args], extra)
  const facts = (args = [], extra = {}) => { const r = helper(args, extra); assert.equal(r.code, 0, r.out); return JSON.parse(r.stdout) }
  const stub = (name, body) => { writeFileSync(join(bin, name), `#!${process.execPath}\n${body}`); chmodSync(join(bin, name), 0o755) }
  const style = join(home, '.agent-config-studio/pr/style.json')
  const setStyle = (s) => { mkdirSync(dirname(style), { recursive: true }); writeFileSync(style, JSON.stringify(s)) }
  const gate = join(home, '.agent-config-studio/review-gate/review.mjs')
  const stubGate = ({ summary, tier, code = 0 }) => {
    mkdirSync(dirname(gate), { recursive: true })
    writeFileSync(gate, `const a = process.argv.slice(2)
if (a.includes('--tier-json')) { console.log(${JSON.stringify(JSON.stringify(tier))}); process.exit(${code}) }
if (a.includes('--summary')) { console.log(${JSON.stringify(summary)}); process.exit(0) }
process.exit(2)\n`)
  }
  return { root, home, repo, bin, env, sh, git, write, commit, helper, facts, stub, style, setStyle, gate, stubGate }
}

// main with two files; feat with one file of each purpose, a plan and a build log; then main moves on and is merged in.
function fixture() {
  const b = box()
  b.git('init', '-q', '-b', 'main')
  b.commit({ 'README.md': 'base\n', 'src/one.js': 'export const one = 1\n' }, 'base')
  b.git('checkout', '-qb', 'feat')
  b.commit({
    'src/app.js': 'export const a = 1\nexport const b = 2\nexport const c = 3\n',
    'tests/app.test.js': 'test\n', 'tests/fixtures/data.json': '{}\n', 'lib/thing_test.go': 'package x\n',
    'package.json': '{}\n', '.gitignore': 'node_modules\n', 'conf/app.yaml': 'a: 1\n',
    'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]), 'web/site.css': 'a{}\n',
    'builds/feat/plan.md': '# Plan\n\n## Outcome\nApp gains a, b and c.\n\n## Criteria\nx\n\n## Out of scope\nNo UI.\n',
    'builds/feat/log.md': 'chose three constants because the plan asked\n',
  }, 'add the app')
  b.git('checkout', '-q', 'main')
  b.commit({ 'src/other.js': 'export const other = 1\n' }, 'main moves on')
  b.git('checkout', '-q', 'feat')
  b.git('merge', '-q', '--no-edit', 'main')
  return b
}

const paths = (list) => list.map((f) => f.path).sort()

/* ── C1 the facts ────────────────────────────────────────────────────── */

test('C1 files are grouped by purpose with line counts; a merge of the base adds nothing; merges are left out of commits', () => {
  const b = fixture()
  const f = b.facts()
  assert.equal(f.branch, 'feat')
  assert.deepEqual({ ref: f.base.ref, from: f.base.from }, { ref: 'main', from: 'a local default branch' })
  assert.deepEqual(paths(f.files.code), ['src/app.js'])
  assert.deepEqual(f.files.code[0], { path: 'src/app.js', added: 3, removed: 0 })
  assert.deepEqual(paths(f.files.tests), ['lib/thing_test.go', 'tests/app.test.js', 'tests/fixtures/data.json'])
  assert.deepEqual(paths(f.files.config), ['.gitignore', 'conf/app.yaml', 'package.json'])
  assert.deepEqual(paths(f.files.static), ['assets/logo.png', 'web/site.css'])
  assert.deepEqual(paths(f.files.builds), ['builds/feat/log.md', 'builds/feat/plan.md'])
  assert.deepEqual(f.files.docs, [])
  assert.equal(f.files.static.find((x) => x.path === 'assets/logo.png').binary, true)
  assert.deepEqual(f.counts.code, { files: 1, added: 3, removed: 0 })
  assert.equal(f.counts.tests.files, 3)
  assert.ok(!Object.values(f.files).flat().some((x) => x.path === 'src/other.js'), 'main\'s own change is not the branch\'s')
  assert.deepEqual(f.commits.map((c) => c.subject), ['add the app'])
  assert.match(f.commits[0].sha, /^[0-9a-f]{40}$/)
  b.git('checkout', '-q', 'main')
  b.commit({ 'src/later.js': 'export const later = 1\n' }, 'main moves on, not merged')
  b.git('checkout', '-q', 'feat')
  const g = b.facts()
  assert.deepEqual(paths(Object.values(g.files).flat()), paths(Object.values(f.files).flat()), 'a base that moved on since adds nothing (three-dot diff)')
})

test('C1 the plan\'s Outcome and Out of scope are extracted, and the build log beside it is read', () => {
  const f = fixture().facts()
  assert.deepEqual(f.plan, { path: 'builds/feat/plan.md', outcome: 'App gains a, b and c.', outOfScope: 'No UI.' })
  assert.equal(f.buildLog.path, 'builds/feat/log.md')
  assert.match(f.buildLog.text, /chose three constants/)
})

test('C1 the docs check lists a changed code file when no docs file changed, and clears when one did', () => {
  const b = fixture()
  assert.deepEqual(b.facts().docs, { changed: [], agentFiles: [], codeWithoutDocs: ['src/app.js'] })
  b.commit({ 'docs/app.md': '# App\n', 'AGENTS.md': 'rules\n' })
  const d = b.facts().docs
  assert.deepEqual(d.codeWithoutDocs, [])
  assert.deepEqual(d.changed.sort(), ['AGENTS.md', 'docs/app.md'])
  assert.deepEqual(d.agentFiles, ['AGENTS.md'])
})

test('C1 the base: --base wins, then the open PR\'s base from gh, then a local default; gh absent is said', () => {
  const b = fixture()
  assert.equal(b.facts().gh, false)
  b.git('branch', 'stack', 'main')
  b.stub('gh', `const a = process.argv.slice(2)
if (a[0] === 'pr' && a[1] === 'view') { console.log(JSON.stringify({ number: 7, url: 'https://example.test/pr/7', baseRefName: 'stack', state: 'OPEN' })); process.exit(0) }
process.exit(1)\n`)
  const f = b.facts()
  assert.deepEqual({ ref: f.base.ref, from: f.base.from, gh: f.gh, pr: f.pr }, { ref: 'stack', from: 'the open PR', gh: true, pr: { number: 7, url: 'https://example.test/pr/7', base: 'stack' } })
  const g = b.facts(['--base', 'main'])
  assert.deepEqual({ ref: g.base.ref, from: g.base.from }, { ref: 'main', from: '--base' })
  b.stub('gh', 'console.error("no pull requests found"); process.exit(1)\n')
  const h = b.facts()
  assert.deepEqual({ ref: h.base.ref, gh: h.gh, pr: h.pr }, { ref: 'main', gh: true, pr: null })
  const bad = b.helper(['--base', 'nope'])
  assert.equal(bad.code, 1)
  assert.match(JSON.parse(bad.stdout).error, /--base nope: no such branch/)
})

test('C1 a non-ASCII path is read whole (numstat -z), so docs/é.md counts as docs', () => {
  const b = fixture()
  b.commit({ 'docs/é.md': '# Café\n', 'src/naïve.js': 'export const n = 1\n' })
  const f = b.facts()
  assert.ok(f.files.docs.some((x) => x.path === 'docs/é.md'), JSON.stringify(f.files))
  assert.ok(f.files.code.some((x) => x.path === 'src/naïve.js' && x.added === 1), JSON.stringify(f.files.code))
  assert.ok(!Object.values(f.files).flat().some((x) => x.path.includes('"') || x.path.includes('\\')), 'no quoted or escaped paths')
})

test('C1 the base falls back to the tracking branch, unless it is the branch\'s own remote copy', () => {
  const b = fixture()
  b.git('branch', 'stack', 'main')
  b.git('branch', '--set-upstream-to=stack', 'feat')
  const f = b.facts()
  assert.deepEqual({ ref: f.base.ref, from: f.base.from }, { ref: 'stack', from: 'the tracking branch' })
  const c = fixture()
  c.git('init', '-q', '--bare', join(c.root, 'remote.git'))
  c.git('remote', 'add', 'origin', join(c.root, 'remote.git'))
  c.git('push', '-q', '-u', 'origin', 'feat')
  const g = c.facts()
  assert.notEqual(g.base.from, 'the tracking branch')
  assert.equal(g.base.ref, 'main', 'origin/feat is the branch itself, not its base')
})

const SUMMARY = [
  'Acceptance criteria not met',
  'c1 criterion C2 not met: the app logs; recheck: no log line; Deferred: later',
  'Reviewer: fam (model-x)',
  'Security: fam2 (model-y) — ran, 0 findings',
  'Review: review-1762300000000-abc123',
  'HEAD: HEADSHA',
  'Counts: 3 findings; 1 fixed; 0 rejected; 2 deferred',
  'f1 HIGH app breaks: fixed; test: tests/app.test.js',
  'Merge tier: HIGH (deferred HIGH x1). Policy auto: needs a human',
  'Deferred findings',
  'x1 HIGH 81/100 (likelihood 9/10 × impact 9/10) src/app.js:2 — b leaks; Trigger: calling b; Deferred: later; Fix idea: guard b',
  'f2 LOW 6/100 (likelihood 2/10 × impact 3/10) src/app.js:1 — a is terse; Trigger: reading; Deferred: style',
].join('\n')
const closedGate = (b, summary = SUMMARY) => {
  const head = b.git('rev-parse', 'HEAD')
  b.stubGate({ summary: summary.replace('HEADSHA', head), tier: { tip: head, covered: true, tier: 'high', deferred: ['x1', 'f2'] } })
}

test('C1 review: absent, in progress and closed are three different states', () => {
  const b = fixture()
  assert.deepEqual(b.facts().review, { state: 'absent', note: 'not reviewed (no review gate)' })
  b.stubGate({ tier: { tip: 'x', covered: false, reason: 'No complete close covers HEAD' }, code: 3, summary: '' })
  const p = b.facts().review
  assert.equal(p.state, 'in-progress')
  assert.equal(p.note, 'review in progress — not closed at this commit')
  assert.equal(p.reason, 'No complete close covers HEAD')
  closedGate(b)
  const c = b.facts().review
  assert.equal(c.state, 'closed')
  assert.equal(c.tier.tier, 'high')
  assert.match(c.summary, /^Acceptance criteria not met\n/)
  assert.deepEqual(c.deferred, [SUMMARY.split('\n')[10], SUMMARY.split('\n')[11]])
  assert.deepEqual(c.deferredHigh, [SUMMARY.split('\n')[10]])
  assert.deepEqual(c.criteria, [SUMMARY.split('\n')[1]])
  assert.deepEqual(c.fixed, ['f1 HIGH app breaks: fixed; test: tests/app.test.js'])
  assert.deepEqual(c.reviewer, ['Reviewer: fam (model-x)'])
  assert.deepEqual(c.security, ['Security: fam2 (model-y) — ran, 0 findings'])
  assert.match(c.tierLine, /^Merge tier: HIGH/)
  b.write({ 'scripts/review.mjs': 'console.log(JSON.stringify({ covered: false, reason: "repo copy" })); process.exit(3)\n' })
  assert.equal(b.facts().review.reason, 'repo copy', 'the repo\'s own scripts/review.mjs comes first')
})

/* ── C2 the style ────────────────────────────────────────────────────── */

const DEFAULT_IDS = ['gif', 'summary', 'goal', 'changes', 'try', 'review', 'deferred', 'docs', 'agent', 'quote', 'record']

test('C2 no style file: the first run creates it from the example, and the defaults are the final format', () => {
  const b = fixture()
  assert.ok(!existsSync(b.style))
  const f = b.facts()
  assert.equal(f.style.created, true)
  assert.equal(readFileSync(b.style, 'utf8'), readFileSync(EXAMPLE, 'utf8'))
  assert.deepEqual(f.style.sections.map((s) => s.id), DEFAULT_IDS)
  assert.deepEqual(f.style.sections.filter((s) => !s.on).map((s) => s.id), ['gif', 'agent', 'record'], 'gif, the agent notes and the raw record are off')
  assert.equal(f.style.sections.find((s) => s.id === 'deferred').title, 'Deferred findings')
  assert.equal(f.style.sections.find((s) => s.id === 'summary').title, 'What this does and why')
  assert.equal(f.style.sections.find((s) => s.id === 'changes').title, 'Files changed')
  assert.equal(f.style.sections.find((s) => s.id === 'quote').title, "Agent's take")
  assert.deepEqual(f.style.sections.find((s) => s.id === 'gif').urls, [], 'gif urls ship empty')
  assert.deepEqual({ tone: f.style.tone, emoji: f.style.emoji }, { tone: 'plain', emoji: true })
  assert.deepEqual(f.warnings, [])
  assert.equal(b.facts().style.created, false, 'a second run leaves it as it is')
  writeFileSync(b.style, '{"tone":"technical"}')
  b.facts()
  assert.equal(readFileSync(b.style, 'utf8'), '{"tone":"technical"}', 'never overwritten')
})

test('C2 a sandbox that refuses the write: the defaults are used and the JSON says so', () => {
  const b = fixture()
  mkdirSync(join(b.home, '.agent-config-studio'))
  chmodSync(join(b.home, '.agent-config-studio'), 0o500)
  const f = b.facts()
  chmodSync(join(b.home, '.agent-config-studio'), 0o700)
  assert.equal(f.style.created, false)
  assert.match(f.style.note, /could not create .*style\.json \(EACCES\): using the defaults/)
  assert.deepEqual(f.style.sections.map((s) => s.id), DEFAULT_IDS)
})

test('C2 sections reordered, retitled and turned off are respected; unknown keys and bad values are warned and ignored', () => {
  const b = fixture()
  b.setStyle({
    sections: [{ id: 'changes', title: 'Files' }, { id: 'summary', on: true }, { id: 'quote', on: false }, { id: 'nope' }, { id: 'goal', colour: 'red' },
      { id: 'summary' }, { id: 'gif', on: true, urls: ['https://example.test/a.gif', 'not a url'] }],
    tone: 'loud', emoji: false, footer: 'x',
  })
  const f = b.facts()
  assert.deepEqual(f.style.sections.slice(0, 5).map((s) => [s.id, s.title, s.on]),
    [['changes', 'Files', true], ['summary', 'What this does and why', true], ['quote', "Agent's take", false], ['goal', 'Did it match the goal?', true], ['gif', 'GIF', true]])
  assert.deepEqual(f.style.sections.slice(5).map((s) => [s.id, s.on]), [['try', false], ['review', false], ['deferred', true], ['docs', false], ['agent', false], ['record', false]],
    'missing sections come after, off, except Deferred findings')
  assert.deepEqual(f.style.sections.find((s) => s.id === 'gif').urls, ['https://example.test/a.gif'])
  assert.deepEqual({ tone: f.style.tone, emoji: f.style.emoji }, { tone: 'plain', emoji: false })
  for (const w of [/unknown key "footer" ignored/, /unknown section "nope" ignored/, /section "goal": unknown key "colour" ignored/, /"summary" is listed twice/,
    /"not a url" is not an http\(s\) URL/, /tone "loud"/, /sections not in your list, added at the end and off: try, review, deferred, docs, agent, record/])
    assert.ok(f.warnings.some((x) => w.test(x)), `${w} in ${JSON.stringify(f.warnings)}`)
})

test('C2 "Deferred findings" keeps its title, and stays on while a review exists (warning, kept on)', () => {
  const b = fixture()
  const sections = DEFAULT_IDS.map((id) => ({ id, ...(id === 'deferred' && { on: false, title: 'Later' }) }))
  b.setStyle({ sections })
  const open = b.facts()
  const d = open.style.sections.find((s) => s.id === 'deferred')
  assert.deepEqual([d.title, d.on], ['Deferred findings', false], 'no review: off is allowed, the title is not')
  assert.ok(open.warnings.some((w) => /the title stays "Deferred findings"/.test(w)), JSON.stringify(open.warnings))
  closedGate(b)
  const f = b.facts()
  assert.equal(f.style.sections.find((s) => s.id === 'deferred').on, true)
  assert.ok(f.warnings.some((w) => /"Deferred findings" stays on while a review exists/.test(w)), JSON.stringify(f.warnings))
})

test('C2 two sections never share a title: a collision gives the later one a unique fallback title, with a warning', () => {
  const b = fixture()
  b.setStyle({ sections: [{ id: 'summary', title: 'Files changed' }, { id: 'goal', title: 'Files changed (changes)' }, { id: 'changes' }, { id: 'try', title: 'Files changed' },
    { id: 'review', title: 'Deferred findings' }, ...DEFAULT_IDS.filter((id) => !['summary', 'changes', 'try', 'review', 'goal'].includes(id)).map((id) => ({ id }))] })
  const f = b.facts()
  const titles = f.style.sections.filter((s) => s.id !== 'gif').map((s) => s.title)
  assert.equal(new Set(titles).size, titles.length, titles.join(' | '))
  const title = (id) => f.style.sections.find((s) => s.id === id).title
  assert.equal(title('summary'), 'Files changed', 'the first one keeps its title')
  assert.equal(title('goal'), 'Files changed (changes)')
  assert.equal(title('try'), 'How to try it')
  assert.equal(title('review'), 'Review highlights')
  assert.equal(title('deferred'), 'Deferred findings')
  assert.ok(!['Files changed', 'Files changed (changes)'].includes(title('changes')), title('changes'))
  for (const id of ['changes', 'try', 'review'])
    assert.ok(f.warnings.some((w) => w.startsWith(`section "${id}": title`) && w.includes('already used')), `${id}: ${JSON.stringify(f.warnings)}`)
})

test('C2 "Deferred findings" stays on while a review is in progress too, and --check then requires it', () => {
  const b = fixture()
  b.setStyle({ sections: DEFAULT_IDS.map((id) => ({ id, ...(id === 'deferred' && { on: false }) })) })
  b.stubGate({ tier: { tip: 'x', covered: false, reason: 'No complete close covers HEAD' }, code: 3, summary: '' })
  const f = b.facts()
  assert.equal(f.review.state, 'in-progress')
  assert.equal(f.style.sections.find((s) => s.id === 'deferred').on, true)
  assert.ok(f.warnings.some((w) => /"Deferred findings" stays on while a review exists/.test(w)), JSON.stringify(f.warnings))
  const empty = { criteria: [], deferredHigh: [], deferred: [], reviewer: ['review in progress — not closed at this commit'], fixed: [''] }
  const body = good({ ...f, review: empty })
  assert.deepEqual(checked(b, body).problems, [])
  assert.deepEqual(checked(b, body.replace('## Deferred findings\n\n', '')).problems, ['missing section "## Deferred findings"'])
})

/* ── C4 the GIF ──────────────────────────────────────────────────────── */

test('C4 GIF: off gives none; on picks the same URL for the same branch every run; on with an empty list gives none, with a note', () => {
  const b = fixture()
  assert.deepEqual(b.facts().gif, { url: null })
  const urls = ['https://example.test/1.gif', 'https://example.test/2.gif', 'https://example.test/3.gif']
  b.setStyle({ sections: DEFAULT_IDS.map((id) => ({ id, ...(id === 'gif' && { on: true, urls }) })) })
  const one = b.facts().gif.url
  assert.ok(urls.includes(one), one)
  for (let i = 0; i < 3; i++) assert.equal(b.facts().gif.url, one)
  const picks = new Set()
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) { b.git('checkout', '-qb', name); picks.add(b.facts().gif.url) }
  assert.ok(picks.size > 1, 'the pick depends on the branch')
  b.setStyle({ sections: DEFAULT_IDS.map((id) => ({ id, ...(id === 'gif' && { on: true, urls: [] }) })) })
  assert.deepEqual(b.facts().gif, { url: null, note: 'the gif section is on but its list of URLs is empty' })
})

/* ── C3 --check ──────────────────────────────────────────────────────── */

// One plain-words entry per deferred finding: the id and the score as the summary gives them, then what could go wrong
// and why it waited, never the reviewer's raw line.
const entry = (d) => d.kind === 'criterion' ? `- ${d.id}: criterion ${d.criterionId} is not met yet. Deferred: ${d.reason}.`
  : `- ${d.id} ${d.score}: something could go wrong in ${d.location.split(':')[0]}. Deferred: ${d.reason}.`
// A description that follows the default style for the closed fixture, from its facts.
function good(f, { record = false } = {}) {
  const r = f.review
  const unmet = r.criteria.map((l) => `❌ ${l.split(' ')[2]} not done: the app does not log yet.`)
  return [
    '## What this does and why', `Adds three constants to the app (${f.commits[0].sha.slice(0, 7)}), so callers stop repeating the numbers.`, '',
    '## Did it match the goal?', '✅ App gains a, b and c.', ...unmet, '',
    '## Files changed', '- `src/app.js` — the constants', '- `tests/app.test.js` — a test', '',
    '## How to try it', '`node src/app.js`', '',
    '## Review highlights', ...r.reviewer, `${r.fixed[0]}`, '',
    '## Deferred findings', ...(r.deferredItems || []).filter((d) => d.kind !== 'unknown').map(entry), '',
    '## Docs and context', '❌ no docs changed for src/app.js', '',
    "## Agent's take", 'I kept it small.', '',
    ...(record ? ['<details><summary>Review record</summary>', '', '```', r.summary, '```', '</details>', ''] : []),
  ].join('\n')
}
function checked(b, body) {
  writeFileSync(join(b.root, 'body.md'), body)
  const r = b.helper(['--check', join(b.root, 'body.md')])
  return { code: r.code, ...JSON.parse(r.stdout) }
}

test('C3 --check passes a description that matches the style', () => {
  const b = fixture()
  closedGate(b)
  const f = b.facts()
  const r = checked(b, good(f))
  assert.deepEqual({ code: r.code, ok: r.ok, problems: r.problems }, { code: 0, ok: true, problems: [] })
  const sections = DEFAULT_IDS.map((id) => ({ id, ...(id === 'record' && { on: true }) }))
  b.setStyle({ sections })
  const withRecord = checked(b, good(f, { record: true }))
  assert.deepEqual(withRecord.problems, [])
})

test('C3 --check fails naming each problem: missing, out of order, turned off, folded sections', () => {
  const b = fixture()
  closedGate(b)
  const f = b.facts()
  const body = good(f)
  const missing = checked(b, body.replace('## How to try it\n`node src/app.js`\n', ''))
  assert.equal(missing.code, 1)
  assert.deepEqual(missing.problems, ['missing section "## How to try it"'])
  const swapped = checked(b, body.replace('## What this does and why', '## TEMP').replace('## Did it match the goal?', '## What this does and why').replace('## TEMP', '## Did it match the goal?'))
  assert.deepEqual(swapped.problems, ['"What this does and why" comes after "Did it match the goal?", but your style puts it first',
    `"Did it match the goal?" is missing unmet criterion C2, as a not-done line: ${f.review.criteria[0]}`], 'headings swapped, the goal heading now holds the summary text')
  const off = checked(b, `${body}\n## Review record\nx\n`)
  assert.ok(off.problems.some((p) => /the review record goes in <details>, not under a "## Review record" heading/.test(p)), JSON.stringify(off.problems))
  b.setStyle({ sections: DEFAULT_IDS.map((id) => ({ id, ...(id === 'quote' && { on: false }) })) })
  const turnedOff = checked(b, body)
  assert.deepEqual(turnedOff.problems, ['"## Agent\'s take" is turned off in your style'])
  b.setStyle({ sections: DEFAULT_IDS.map((id) => ({ id })) })
  const folded = checked(b, body.replace('## Docs and context', '<details>\n\n## Docs and context').replace("## Agent's take", "</details>\n\n## Agent's take"))
  assert.ok(folded.problems.some((p) => /"## Docs and context" \(line \d+\) is inside <details>/.test(p)), JSON.stringify(folded.problems))
  const extra = checked(b, `${body}\n## Notes\nmore\n`)
  assert.deepEqual(extra.problems, [])
  assert.ok(extra.warnings.includes('"## Notes" is not a section in your style'))
})

test('C3 --check: Deferred findings present, each id with its exact score; unmet criteria in the goal section; the record folded', () => {
  const b = fixture()
  closedGate(b)
  const f = b.facts()
  const body = good(f)
  const [, low] = f.review.deferredItems
  const gone = checked(b, body.replace('## Deferred findings', '## Deferred'))
  assert.ok(gone.problems.includes('missing section "## Deferred findings"'), JSON.stringify(gone.problems))
  const reworded = checked(b, body.replace(entry(low), '- f2 a small style nit'))
  assert.deepEqual(reworded.problems, [`"Deferred findings" is missing f2 with its score as the summary gives it: f2 ${low.score}`])
  const unmet = checked(b, body.replace('❌ C2 not done: the app does not log yet.\n', ''))
  assert.deepEqual(unmet.problems, [`"Did it match the goal?" is missing unmet criterion C2, as a not-done line: ${f.review.criteria[0]}`])
  b.setStyle({ sections: DEFAULT_IDS.map((id) => ({ id, ...(id === 'record' && { on: true }) })) })
  const unfoldedRecord = checked(b, `${body}\n<summary>Review record</summary>\n${f.review.summary}\n`)
  assert.ok(unfoldedRecord.problems.some((p) => /the review record is on: fold it as <details><summary>Review record<\/summary>/.test(p)), JSON.stringify(unfoldedRecord.problems))
  assert.ok(unfoldedRecord.problems.some((p) => /the raw review record \("Review: review-1762300000000-abc123"\) is outside <details>/.test(p)), JSON.stringify(unfoldedRecord.problems))
  b.setStyle({ sections: DEFAULT_IDS.map((id) => ({ id })) })
  const rawOff = checked(b, `${body}\nReview: review-1762300000000-abc123\n`)
  assert.deepEqual(rawOff.problems, ['the raw review record ("Review: review-1762300000000-abc123") is outside <details>'])
})

test('C3 --check: no sha, review id, finding id or file path that is not in the facts', () => {
  const b = fixture()
  closedGate(b)
  const f = b.facts()
  const body = good(f)
  const invented = checked(b, body.replace('I kept it small.', 'I kept it small; see deadbee1, review-1762300000999-ffffff, x9 is deferred and src/ghost.js.'))
  assert.deepEqual(invented.problems.sort(), ['file src/ghost.js is not in the facts', 'finding id x9 is not in the facts',
    'review id review-1762300000999-ffffff is not in the facts', 'sha deadbee1 is not in the facts'].sort())
  const real = checked(b, body.replace('I kept it small.', `I kept it small (${f.head.slice(0, 10)}, ${f.base.sha.slice(0, 7)}, https://example.test/x/abc1234/y.js).`))
  assert.deepEqual(real.problems, [], 'the head, the base and a URL are fine')
  const tracked = checked(b, body.replace('I kept it small.', 'I kept it small (src/one.js).'))
  assert.deepEqual(tracked.problems, ['file src/one.js is not in the facts'], 'a file tracked at HEAD but not in the facts is not a free pass')
})

test('C3 --check flags a finding id only where a finding id goes: at the start of a list item, or before HIGH, MEDIUM or LOW', () => {
  const b = fixture()
  closedGate(b)
  const body = good(b.facts())
  const prose = checked(b, body.replace('I kept it small.', 'It runs at speed x2, keeps s3 and r2 buckets, and f9 is a key on the keyboard.'))
  assert.deepEqual(prose.problems, [], 'ids in prose are not finding ids')
  const listed = checked(b, body.replace('I kept it small.', 'I kept it small.\n- x9 MEDIUM 20/100 (likelihood 4/10 × impact 5/10) a made-up finding'))
  assert.deepEqual(listed.problems, ['finding id x9 is not in the facts'])
  const bullet = checked(b, body.replace('I kept it small.', 'I kept it small.\n* **s7** — a made-up security finding\n1. c4 was not met'))
  assert.deepEqual(bullet.problems.sort(), ['finding id c4 is not in the facts', 'finding id s7 is not in the facts'])
  const inline = checked(b, body.replace('I kept it small.', 'I kept it small; r5 HIGH was waived and f8 low was dropped.'))
  assert.deepEqual(inline.problems.sort(), ['finding id f8 is not in the facts', 'finding id r5 is not in the facts'])
  const real = checked(b, body.replace('I kept it small.', 'I kept it small.\n- x1 HIGH stays deferred; f2 LOW too.'))
  assert.deepEqual(real.problems, [], 'ids from the summary are fine in those positions')
})

test('C3 --check: deferred entries and unmet criteria must be visible, not in <details> or an HTML comment; a folded record only when the record is on', () => {
  const b = fixture()
  closedGate(b)
  const f = b.facts()
  const body = good(f)
  const lines = f.review.deferredItems.map(entry).join('\n')
  const missing = f.review.deferredItems.map((d) => `"Deferred findings" is missing ${d.id} with its score as the summary gives it: ${d.id} ${d.score}`)
  const inDetails = checked(b, body.replace(`## Deferred findings\n${lines}\n`, `## Deferred findings\n<details><summary>the list</summary>\n\n${lines}\n</details>\n`))
  assert.deepEqual(inDetails.problems, missing)
  const inComment = checked(b, body.replace(`## Deferred findings\n${lines}\n`, `## Deferred findings\n<!--\n${lines}\n-->\n`))
  assert.deepEqual(inComment.problems, missing)
  const notDone = '❌ C2 not done: the app does not log yet.'
  const hidden = checked(b, body.replace(notDone, `<!-- ${notDone} -->`))
  assert.deepEqual(hidden.problems, [`"Did it match the goal?" is missing unmet criterion C2, as a not-done line: ${f.review.criteria[0]}`])
  const foldedOff = checked(b, `${body}\n<details><summary>Review record</summary>\n\n\`\`\`\n${f.review.summary}\n\`\`\`\n</details>\n`)
  assert.deepEqual(foldedOff.problems, ['the review record is off in your style: leave it out, folded or not'])
  const foldedOther = checked(b, `${body}\n<details><summary>raw</summary>\n\n${f.review.summary}\n</details>\n`)
  assert.deepEqual(foldedOther.problems, ['the review record is off in your style: leave it out, folded or not'])
})

test('C3 --check: file names in code spans and list items must come from the facts, root and extensionless names included', () => {
  const b = fixture()
  closedGate(b)
  const f = b.facts()
  const body = good(f)
  const add = (text) => checked(b, body.replace('I kept it small.', text)).problems.sort()
  assert.deepEqual(add('Touched `Dockerfile` and `ghost-package.json` and `src/ghost`.'),
    ['file Dockerfile is not in the facts', 'file ghost-package.json is not in the facts', 'file src/ghost is not in the facts'])
  assert.deepEqual(add('I kept it small.\n- src/ghost — gone\n- Makefile: build\n- **lib/ghost.ts** — new'),
    ['file Makefile is not in the facts', 'file lib/ghost.ts is not in the facts', 'file src/ghost is not in the facts'])
  assert.deepEqual(add('Calls `JSON.parse` and `node --test`, version `v1.2`, and/or more; see `src/`, `builds/feat/plan.md`, `.gitignore` and `node src/app.js --x`.'), [],
    'code that is not a file name, a folder of changed files, and changed files pass')
  assert.deepEqual(add('I kept it small.\n- and then some'), [])
})

test('C3 --check: a hex token beside "commit" or "sha", or in backticks, must be a known commit, letters-only or digits-only included', () => {
  const b = fixture()
  closedGate(b)
  const f = b.facts()
  const body = good(f)
  const add = (text) => checked(b, body.replace('I kept it small.', text)).problems.sort()
  assert.deepEqual(add('See commit 1234567, `deadbeef` and sha abcdefa.'),
    ['sha 1234567 is not in the facts', 'sha abcdefa is not in the facts', 'sha deadbeef is not in the facts'])
  assert.deepEqual(add('The deadbeef cafe sold 1234567 coffees.'), [], 'plain prose words are not shas')
  assert.deepEqual(add(`See commit ${f.head.slice(0, 7)} and \`${f.commits[0].sha.slice(0, 9)}\`.`), [])
})

test('C3 --check: a finding claim in prose ("f1 is fixed", "s4 was rejected") must name a known finding', () => {
  const b = fixture()
  closedGate(b)
  const body = good(b.facts())
  const add = (text) => checked(b, body.replace('I kept it small.', text)).problems.sort()
  assert.deepEqual(add('Here s4 was rejected, c2 filed, and f7 deferred.'),
    ['finding id c2 is not in the facts', 'finding id f7 is not in the facts', 'finding id s4 is not in the facts'])
  assert.deepEqual(add('Here x1 is deferred and f1 was fixed.'), [])
})

test('C3 --check with no review: Deferred findings is not required, and a finding id is invented', () => {
  const b = fixture()
  const f = b.facts()
  const body = good({ ...f, review: { criteria: [], deferredHigh: [], deferred: [], reviewer: ['not reviewed (no review gate)'], fixed: [''] } })
    .replace('## Deferred findings\n\n', '')
  assert.deepEqual(checked(b, body).problems, [])
  assert.deepEqual(checked(b, body.replace('I kept it small.', 'f1 is fixed.')).problems, ['finding id f1 is not in the facts'])
})

test('the helper refuses unknown options and a missing --check file, with JSON on stdout', () => {
  const b = fixture()
  for (const [args, re] of [[['--nope'], /unknown option --nope/], [['--check', join(b.root, 'none.md')], /no such file/], [['--base'], /--base needs a value/]]) {
    const r = b.helper(args)
    assert.equal(r.code, 1, r.out)
    assert.match(JSON.parse(r.stdout).error, re)
  }
  const outside = spawnSync(process.execPath, [HELPER], { cwd: b.root, env: b.env, encoding: 'utf8' })
  assert.equal(outside.status, 1)
  assert.match(JSON.parse(outside.stdout).error, /not inside a git repository/)
})

/* ── the real review gate ────────────────────────────────────────────── */

test('the real review.mjs against a temp log: absent, then in progress, then closed with its summary and tier', () => {
  const b = box()
  // Stub model CLIs: every review finds nothing. Same shape as the review gate's own tests.
  b.stub('model-id', `const a=process.argv.slice(2); console.log(a[0]==='--role' ? JSON.stringify({use:['stubfam'],ids:['gpt-stub']}) : a[0]==='--flavor' ? JSON.stringify({flavor:{effort:'high'}}) : 'gpt-stub')`)
  const model = `
const fs = require('node:fs')
const a = process.argv.slice(2)
if (a[0] === 'mcp') { console.log('[]'); process.exit(0) }
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8') : a[a.indexOf('--json-schema')+1]
const reply = schema.includes('"scores"') ? '{"scores":[]}' : schema.includes('"verdicts"') ? '{"verdicts":[]}' : '{"findings":[]}'
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1], reply)
else console.log(JSON.stringify({structured_output:JSON.parse(reply),structuredOutput:JSON.parse(reply),modelUsage:{'stub':{}}}))
`
  for (const n of ['codex', 'claude', 'grok']) b.stub(n, model)
  const extra = { REVIEW_BASE: 'main', REVIEW_REVIEWER: 'stubfam' }
  mkdirSync(join(b.home, '.agent-config-studio/review-log'), { recursive: true })
  b.git('init', '-q', '-b', 'main')
  b.commit({ 'README.md': 'base\n', 'src/one.js': 'export const one = 1\n' })
  b.git('checkout', '-qb', 'feat')
  b.commit({ 'docs/guide.md': '# Guide\ntext\n' })
  assert.equal(b.facts([], extra).review.state, 'absent')
  mkdirSync(dirname(b.gate), { recursive: true })
  copyFileSync(REVIEW, b.gate)
  const progress = b.facts([], extra).review
  assert.equal(progress.state, 'in-progress', JSON.stringify(progress))
  assert.match(progress.reason, /No complete close covers HEAD/)
  const rv = b.sh(process.execPath, [b.gate], extra)
  assert.equal(rv.code, 0, rv.out)
  const log = readFileSync(join(b.home, '.agent-config-studio/review-log/review-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  const id = log.filter((e) => e.type === 'review').at(-1).id
  writeFileSync(join(b.root, 'statuses.json'), '{}')
  const cl = b.sh(process.execPath, [b.gate, '--close', id, '--status', join(b.root, 'statuses.json'), '--test-cmd', 'true'], extra)
  assert.equal(cl.code, 0, cl.out)
  const f = b.facts([], extra)
  assert.equal(f.review.state, 'closed', JSON.stringify(f.review))
  assert.match(f.review.summary, new RegExp(`^HEAD: ${f.head}$`, 'm'))
  assert.match(f.review.summary, /^Deferred findings\nnone$/m)
  assert.deepEqual(f.review.deferred, [])
  assert.equal(f.review.tier.covered, true)
  assert.equal(f.review.tier.tip, f.head)
  assert.ok(f.review.tierLine?.startsWith('Merge tier: '), f.review.summary)
  assert.equal(f.review.reviewer.length, 1)
  const body = [
    '## What this does and why', 'A guide, so readers can start.', '', '## Did it match the goal?', 'No plan.', '', '## Files changed', '- `docs/guide.md`', '',
    '## How to try it', 'Read it.', '', '## Review highlights', ...f.review.reviewer, '', '## Deferred findings', 'none', '',
    '## Docs and context', '✅', '', "## Agent's take", 'Small.', '',
  ].join('\n')
  writeFileSync(join(b.root, 'body.md'), body)
  const c = b.helper(['--check', join(b.root, 'body.md')], extra)
  assert.equal(c.code, 0, c.out)
})

test('the real review.mjs: the facts carry each finding (id, severity, score, status, issue) and counts by severity, read from the review log', () => {
  const b = box()
  b.stub('model-id', `const a=process.argv.slice(2); console.log(a[0]==='--role' ? JSON.stringify({use:['stubfam'],ids:['gpt-stub']}) : a[0]==='--flavor' ? JSON.stringify({flavor:{effort:'high'}}) : 'gpt-stub')`)
  const model = `
const fs = require('node:fs')
const a = process.argv.slice(2)
if (a[0] === 'mcp') { console.log('[]'); process.exit(0) }
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8') : a[a.indexOf('--json-schema')+1]
const reply = schema.includes('"scores"') ? '{"scores":[]}' : schema.includes('"verdicts"') ? '{"verdicts":[]}' : (process.env.STUB_FINDINGS || '{"findings":[]}')
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1], reply)
else console.log(JSON.stringify({structured_output:JSON.parse(reply),structuredOutput:JSON.parse(reply),modelUsage:{'stub':{}}}))
`
  for (const n of ['codex', 'claude', 'grok']) b.stub(n, model)
  const extra = { REVIEW_BASE: 'main', REVIEW_REVIEWER: 'stubfam' }
  mkdirSync(join(b.home, '.agent-config-studio/review-log'), { recursive: true })
  mkdirSync(dirname(b.gate), { recursive: true })
  copyFileSync(REVIEW, b.gate)
  b.git('init', '-q', '-b', 'main')
  b.commit({ 'README.md': 'base\n', 'src/one.js': 'export const one = 1\n' })
  b.git('checkout', '-qb', 'feat')
  b.commit({ 'web/App.tsx': 'export const A = 1\nexport const B = 2\n' })
  const scored = (over = {}) => ({ issue: 'a is wrong', file: 'web/App.tsx', line: '1', quote: 'export const A = 1', suggestion: 'fix a',
    likelihood: 5, impact: 5, protected: false, trigger: 'rendering App', ...over })
  const rv = b.sh(process.execPath, [b.gate], { ...extra, STUB_FINDINGS: JSON.stringify({ findings: [scored()] }) })
  assert.equal(rv.code, 0, rv.out)
  const log = () => readFileSync(join(b.home, '.agent-config-studio/review-log/review-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  const id = log().filter((e) => e.type === 'review').at(-1).id
  b.commit({ 'web/App.tsx': 'export const A = 10\nexport const B = 2\n' })
  const fc = b.sh(process.execPath, [b.gate, '--fix-check', id], { ...extra, STUB_FINDINGS: JSON.stringify({ findings: [scored({ issue: 'b leaks', line: '2', quote: 'export const B = 2', likelihood: 9, impact: 9 })] }) })
  assert.equal(fc.code, 0, fc.out)
  writeFileSync(join(b.root, 'statuses.json'), JSON.stringify({ f1: { status: 'fixed' }, x1: { status: 'deferred', reason: 'later' } }))
  const cl = b.sh(process.execPath, [b.gate, '--close', id, '--status', join(b.root, 'statuses.json'), '--test-cmd', 'true'], extra)
  assert.equal(cl.code, 0, cl.out)
  const r = b.facts([], extra).review
  assert.equal(r.state, 'closed', JSON.stringify(r))
  const pick = (x) => ({ id: x.id, severity: x.severity, likelihood: x.likelihood, impact: x.impact, status: x.status, issue: x.issue })
  assert.deepEqual(r.findings.map(pick), [
    { id: 'f1', severity: 'medium', likelihood: 5, impact: 5, status: 'fixed', issue: 'a is wrong' },
    { id: 'x1', severity: 'high', likelihood: 9, impact: 9, status: 'deferred', issue: 'b leaks' },
  ])
  assert.match(r.findings[1].score, /^HIGH 81\/100 \(likelihood 9\/10 × impact 9\/10\)$/)
  assert.match(r.findings[0].score, /^MEDIUM \d+\/100 \(likelihood 5\/10 × impact 5\/10\)$/)
  assert.equal(r.findings[0].review, id)
  assert.deepEqual(r.bySeverity, {
    high: { total: 1, fixed: 0, deferred: 1, rejected: 0, filed: 0, open: 0 },
    medium: { total: 1, fixed: 1, deferred: 0, rejected: 0, filed: 0, open: 0 },
    low: { total: 0, fixed: 0, deferred: 0, rejected: 0, filed: 0, open: 0 },
  })
  assert.equal(r.deferredHigh.length, 1)
  assert.match(r.deferredHigh[0], /^x1 HIGH 81\/100/)
})

test('a review gate that gives no log path: the summary facts stay, the findings list is null with a note', () => {
  const b = fixture()
  closedGate(b)
  const r = b.facts().review
  assert.equal(r.findings, null)
  assert.match(r.findingsNote, /review log/)
  assert.equal(r.bySeverity, null)
})

/* ── deferred findings, structured ───────────────────────────────────── */

test('splitSummary: each deferred line becomes a structured item, the raw lines kept beside them', async () => {
  const { splitSummary } = await import(HELPER)
  const x1 = 'x1 HIGH 18/100 (likelihood 2/10 × impact 9/10) packs/gate/review.mjs:4429 — The base is decided from local refs; an agent can delete them. Traced by reading.; ' +
    'Trigger: delete refs/remotes/*, then `git push origin feature`; also at packs/gate/review.mjs:1546, packs/gate/review.mjs:1540; ' +
    'Deferred: Needs a remote-truth check at push time. Tracked with issue #61 (see https://example.test/issues/61).; Fix idea: run `git ls-remote --heads`'
  const f2 = 'f2 LOW 6/100 src/app.js:1 — a is terse; Trigger: reading; Deferred: style'
  const odd = 'r3 MEDIUM unscored ?:? — no file; Trigger: trigger not recorded'
  const crit = 'c1 criterion C2 not met: the app logs; recheck: no log line; Deferred: later; Fix idea: add a log'
  const s = splitSummary(['Reviewer: fam', 'Deferred findings', x1, f2, odd, crit, 'No tests: none'].join('\n'))
  assert.deepEqual(s.deferred, [x1, f2, odd, crit], 'the raw lines stay, for the record and older readers')
  assert.deepEqual(s.deferredItems[0], {
    id: 'x1', kind: 'code', severity: 'high', score: 'HIGH 18/100 (likelihood 2/10 × impact 9/10)', location: 'packs/gate/review.mjs:4429',
    alsoAt: ['packs/gate/review.mjs:1546', 'packs/gate/review.mjs:1540'],
    issue: 'The base is decided from local refs; an agent can delete them. Traced by reading.',
    trigger: 'delete refs/remotes/*, then `git push origin feature`',
    reason: 'Needs a remote-truth check at push time. Tracked with issue #61 (see https://example.test/issues/61).',
    fixIdea: 'run `git ls-remote --heads`', trackedIn: ['#61', 'https://example.test/issues/61'], preExisting: false, line: x1,
  })
  assert.deepEqual(s.deferredItems[1], { id: 'f2', kind: 'code', severity: 'low', score: 'LOW 6/100', location: 'src/app.js:1', alsoAt: [],
    issue: 'a is terse', trigger: 'reading', reason: 'style', fixIdea: null, trackedIn: [], preExisting: false, line: f2 })
  assert.deepEqual(s.deferredItems[2], { id: 'r3', kind: 'code', severity: 'medium', score: 'MEDIUM unscored', location: '?:?', alsoAt: [],
    issue: 'no file', trigger: 'trigger not recorded', reason: null, fixIdea: null, trackedIn: [], preExisting: false, line: odd })
  assert.deepEqual(s.deferredItems[3], { id: 'c1', kind: 'criterion', severity: null, score: null, location: null, alsoAt: [],
    criterionId: 'C2', criterion: 'the app logs', recheck: 'no log line', reason: 'later', fixIdea: 'add a log', trackedIn: [], preExisting: false, line: crit })
  const raw = splitSummary('Deferred findings\nz9 something the parser does not know').deferredItems
  assert.deepEqual(raw, [{ id: 'z9', kind: 'unknown', severity: null, score: null, location: null, alsoAt: [], reason: null, fixIdea: null, trackedIn: [],
    preExisting: false, line: 'z9 something the parser does not know' }], 'an unknown line keeps its id and raw text')
  assert.deepEqual(splitSummary('Deferred findings\nnone').deferredItems, [])
})

test('the facts carry review.deferredItems beside review.deferred for a closed review', () => {
  const b = fixture()
  closedGate(b)
  const r = b.facts().review
  assert.deepEqual(r.deferredItems.map((d) => [d.id, d.severity, d.score, d.location, d.reason]), [
    ['x1', 'high', 'HIGH 81/100 (likelihood 9/10 × impact 9/10)', 'src/app.js:2', 'later'],
    ['f2', 'low', 'LOW 6/100 (likelihood 2/10 × impact 3/10)', 'src/app.js:1', 'style'],
  ])
  assert.equal(r.deferred.length, 2)
})

test('C3 --check: plain entries pass with no verbatim line; a changed score, a missing id, or a finding above the first section fail', () => {
  const b = fixture()
  closedGate(b)
  const f = b.facts()
  const body = good(f)
  for (const l of f.review.deferred) assert.ok(!body.includes(l), 'the sample body holds no raw deferred line')
  assert.deepEqual(checked(b, body).problems, [])
  const [high] = f.review.deferredItems
  const softened = checked(b, body.replace(high.score, 'HIGH 18/100 (likelihood 2/10 × impact 9/10)'))
  assert.deepEqual(softened.problems, [`"Deferred findings" is missing x1 with its score as the summary gives it: x1 ${high.score}`])
  const split = checked(b, body.replace(`- x1 ${high.score}`, `- x1 is deferred.\n- the score is ${high.score}`))
  assert.deepEqual(split.problems, [`"Deferred findings" is missing x1 with its score as the summary gives it: x1 ${high.score}`], 'the id and its score sit on one line')
  const bold = checked(b, body.replace(`- x1 ${high.score}`, `- **x1** ${high.score}`))
  assert.deepEqual(bold.problems, [], 'markdown around the id is fine')
  const onTop = checked(b, `${high.line}\n\n${body}`)
  assert.deepEqual(onTop.problems, ['deferred findings go under "## Deferred findings", never above the first section: x1'])
  const plainOnTop = checked(b, `**Deferred HIGH:** x1 ${high.score}\n\n${body}`)
  assert.deepEqual(plainOnTop.problems, ['deferred findings go under "## Deferred findings", never above the first section: x1'])
  const critOnTop = checked(b, `${f.review.criteria[0]}\n\n${body}`)
  assert.deepEqual(critOnTop.problems, ['unmet criteria go in "Did it match the goal?", never above the first section: C2'])
})

test('C3 --check: a deferred criterion in Deferred findings needs its id; the goal section off asks nothing of criteria', () => {
  const b = fixture()
  const crit = 'c1 criterion C2 not met: the app logs; recheck: no log line; Deferred: later'
  closedGate(b, SUMMARY.replace('Deferred findings\n', `Deferred findings\n${crit}\n`))
  const f = b.facts()
  assert.equal(f.review.deferredItems[0].kind, 'criterion')
  const body = good(f)
  assert.deepEqual(checked(b, body).problems, [])
  const dropped = checked(b, body.replace(entry(f.review.deferredItems[0]), ''))
  assert.deepEqual(dropped.problems, ['"Deferred findings" is missing c1 (criterion C2 not met)'])
  b.setStyle({ sections: DEFAULT_IDS.map((id) => ({ id, ...(id === 'goal' && { on: false }) })) })
  const noGoal = checked(b, body.replace(/## Did it match the goal\?\n[^#]*/, ''))
  assert.deepEqual(noGoal.problems, [])
})

/* ── deferred findings: the check fails closed ───────────────────────── */

const X1_SCORE = 'HIGH 81/100 (likelihood 9/10 × impact 9/10)', F2_SCORE = 'LOW 6/100 (likelihood 2/10 × impact 3/10)'
const PRE = 'Pre-existing HIGH x3 HIGH 72/100 (likelihood 8/10 × impact 9/10) src/old file.js:4 — old leak; Trigger: loading old'
const withDeferred = (...extra) => SUMMARY.replace(/^(f2 LOW .*)$/m, `$1\n${extra.join('\n')}`)

test('splitSummary: pre-existing lines keep their id and score, the pre-existing title is not an item, spaced paths parse, a blank id is null', async () => {
  const { splitSummary } = await import(HELPER)
  const spaced = 'f4 MEDIUM 20/100 src/foo bar.js:5 — spaced path; Trigger: opening it'
  const s = splitSummary(['Deferred findings', 'f2 LOW 6/100 src/a.js:1 — a; Trigger: t', 'Pre-existing (not introduced here)', PRE, spaced, ' leading space text'].join('\n'))
  assert.ok(s.deferred.includes('Pre-existing (not introduced here)'), 'the raw lines stay as the summary gives them')
  assert.deepEqual(s.deferredItems.map((d) => d.id), ['f2', 'x3', 'f4', null], 'the pre-existing title is not an item')
  const pre = s.deferredItems[1]
  assert.deepEqual([pre.kind, pre.severity, pre.score, pre.location, pre.issue, pre.preExisting, pre.line],
    ['code', 'high', 'HIGH 72/100 (likelihood 8/10 × impact 9/10)', 'src/old file.js:4', 'old leak', true, PRE])
  assert.deepEqual([s.deferredItems[2].score, s.deferredItems[2].location, s.deferredItems[2].issue], ['MEDIUM 20/100', 'src/foo bar.js:5', 'spaced path'])
  assert.deepEqual([s.deferredItems[3].kind, s.deferredItems[3].id, s.deferredItems[3].score], ['unknown', null, null])
})

test('C3 --check: a pre-existing HIGH is held to its own id and score; the title word alone satisfies nothing', () => {
  const b = fixture()
  closedGate(b, withDeferred('Pre-existing (not introduced here)', PRE))
  const f = b.facts()
  const body = good(f)
  assert.deepEqual(checked(b, body).problems, [])
  const dropped = checked(b, body.replace(/^- x3 .*$/m, '- Pre-existing (not introduced here)'))
  assert.deepEqual(dropped.problems, ['"Deferred findings" is missing x3 with its score as the summary gives it: x3 HIGH 72/100 (likelihood 8/10 × impact 9/10)'])
})

test('C3 --check: an unknown deferred line must appear verbatim; a line with no id is never matched by its first word', () => {
  const b = fixture()
  const odd = 'z9 something the parser does not know'
  closedGate(b, withDeferred(odd, ' leading space text'))
  const f = b.facts()
  const body = good(f)
  assert.deepEqual(checked(b, body).problems.sort(), [
    `"Deferred findings" is missing this line, copied verbatim from the review summary: ${odd}`,
    '"Deferred findings" is missing this line, copied verbatim from the review summary:  leading space text',
  ].sort())
  const kept = body.replace('## Docs and context', `- ${odd}\n-  leading space text\n\n## Docs and context`)
  assert.deepEqual(checked(b, kept).problems, [])
  const reworded = body.replace('## Docs and context', `- z9 something else\n- leading text\n\n## Docs and context`)
  assert.equal(checked(b, reworded).problems.length, 2)
})

test('C3 --check: each id is tied to its own score; swapped scores on one line fail both', () => {
  const b = fixture()
  closedGate(b)
  const body = good(b.facts())
  const swapped = body.replace(/^- x1 .*\n- f2 .*$/m, `- x1 ${F2_SCORE} and f2 ${X1_SCORE}: both fine.`)
  assert.deepEqual(checked(b, swapped).problems, [
    `"Deferred findings" is missing x1 with its score as the summary gives it: x1 ${X1_SCORE}`,
    `"Deferred findings" is missing f2 with its score as the summary gives it: f2 ${F2_SCORE}`,
  ])
  const crossed = body.replace(/^- x1 .*\n- f2 .*$/m, `- x1 and f2 are deferred (${F2_SCORE}; ${X1_SCORE}).`)
  assert.equal(checked(b, crossed).problems.length, 2, 'an id with some score somewhere on the line is not enough')
})

test('C3 --check: distinct deferred items need distinct entries', () => {
  const b = fixture()
  const twin = `x1 ${X1_SCORE} src/other.js:9 — a second x1 from another slice; Trigger: slicing; Deferred: later`
  closedGate(b, withDeferred(twin))
  const f = b.facts()
  const body = good(f)
  assert.deepEqual(checked(b, body).problems, [])
  const one = body.replace(/^- x1 .*src\/other\.js.*\n/m, '')
  assert.deepEqual(checked(b, one).problems, [`"Deferred findings" is missing x1 with its score as the summary gives it: x1 ${X1_SCORE}`])
  closedGate(b)
  const both = good(b.facts()).replace(/^- x1 .*\n- f2 .*$/m, `- x1 ${X1_SCORE} leaks, and f2 ${F2_SCORE} is a style nit.`)
  assert.deepEqual(checked(b, both).problems, [`"Deferred findings" is missing f2 with its score as the summary gives it: f2 ${F2_SCORE}`], 'one entry stands for one finding')
})

test('C3 --check: any deferred id above the first section fails, with or without its score', () => {
  const b = fixture()
  closedGate(b)
  const body = good(b.facts())
  assert.deepEqual(checked(b, `Deferred HIGH: x1 can leak when called.\n\n${body}`).problems,
    ['deferred findings go under "## Deferred findings", never above the first section: x1'])
})

test('C3 --check: unmet criteria must be marked not met; with the goal section off they go in Deferred findings', () => {
  const b = fixture()
  closedGate(b)
  const f = b.facts()
  const crit = f.review.criteria[0]
  const body = good(f)
  const notDone = '❌ C2 not done: the app does not log yet.'
  const shownDone = checked(b, body.replace(notDone, '✅ C2 done: the app logs.'))
  assert.deepEqual(shownDone.problems, [
    `"Did it match the goal?" is missing unmet criterion C2, as a not-done line: ${crit}`,
    `"Did it match the goal?" shows unmet criterion C2 as done (✅), but the review recorded it not met: ${crit}`,
  ])
  const bare = checked(b, body.replace(notDone, 'C2 the app logs.'))
  assert.deepEqual(bare.problems, [`"Did it match the goal?" is missing unmet criterion C2, as a not-done line: ${crit}`])
  const words = checked(b, body.replace(notDone, 'C2 is not met: the app does not log yet.'))
  assert.deepEqual(words.problems, [], '"not met" in words is enough without emoji')
  b.setStyle({ sections: DEFAULT_IDS.map((id) => ({ id, ...(id === 'goal' && { on: false }) })) })
  const noGoal = body.replace(/## Did it match the goal\?\n[^#]*/, '')
  assert.deepEqual(checked(b, noGoal).problems, [`"Deferred findings" is missing unmet criterion C2, as a not-done line: ${crit}`])
  assert.deepEqual(checked(b, noGoal.replace('## Docs and context', `- ${notDone}\n\n## Docs and context`)).problems, [])
})

/* ── follow-ups: multi-paragraph findings, mixed criterion lines, a bold id with a colon ── */

test('the real review.mjs: a deferred finding whose text runs to four paragraphs is one item, and a plain-words entry passes', () => {
  const b = box()
  b.stub('model-id', `const a=process.argv.slice(2); console.log(a[0]==='--role' ? JSON.stringify({use:['stubfam'],ids:['gpt-stub']}) : a[0]==='--flavor' ? JSON.stringify({flavor:{effort:'high'}}) : 'gpt-stub')`)
  const model = `
const fs = require('node:fs')
const a = process.argv.slice(2)
if (a[0] === 'mcp') { console.log('[]'); process.exit(0) }
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8') : a[a.indexOf('--json-schema')+1]
const reply = schema.includes('"scores"') ? '{"scores":[]}' : schema.includes('"verdicts"') ? '{"verdicts":[]}' : (process.env.STUB_FINDINGS || '{"findings":[]}')
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1], reply)
else console.log(JSON.stringify({structured_output:JSON.parse(reply),structuredOutput:JSON.parse(reply),modelUsage:{'stub':{}}}))
`
  for (const n of ['codex', 'claude', 'grok']) b.stub(n, model)
  const extra = { REVIEW_BASE: 'main', REVIEW_REVIEWER: 'stubfam' }
  mkdirSync(join(b.home, '.agent-config-studio/review-log'), { recursive: true })
  mkdirSync(dirname(b.gate), { recursive: true })
  copyFileSync(REVIEW, b.gate)
  b.git('init', '-q', '-b', 'main')
  b.commit({ 'README.md': 'base\n', 'src/one.js': 'export const one = 1\n' })
  b.git('checkout', '-qb', 'feat')
  b.commit({ 'web/App.tsx': 'export const A = 1\nexport const B = 2\n' })
  const scored = (over = {}) => ({ issue: 'a is wrong', file: 'web/App.tsx', line: '1', quote: 'export const A = 1', suggestion: 'fix a',
    likelihood: 5, impact: 5, protected: false, trigger: 'rendering App', ...over })
  assert.equal(b.sh(process.execPath, [b.gate], { ...extra, STUB_FINDINGS: JSON.stringify({ findings: [scored()] }) }).code, 0)
  const id = readFileSync(join(b.home, '.agent-config-studio/review-log/review-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.type === 'review').at(-1).id
  b.commit({ 'web/App.tsx': 'export const A = 10\nexport const B = 2\n' })
  const issue = 'Two threads can share one file.\n\nThe nearest folder is shared by every session.\nIt takes over the first file.\n\nThe first pointer still points there.\n\nOld items keep dragging along.'
  const x1 = scored({ issue, line: '2', quote: 'export const B = 2', likelihood: 9, impact: 9, trigger: 'two sessions\nin one folder' })
  assert.equal(b.sh(process.execPath, [b.gate, '--fix-check', id], { ...extra, STUB_FINDINGS: JSON.stringify({ findings: [x1] }) }).code, 0)
  writeFileSync(join(b.root, 'statuses.json'), JSON.stringify({ f1: { status: 'fixed' }, x1: { status: 'deferred', reason: 'later' } }))
  const cl = b.sh(process.execPath, [b.gate, '--close', id, '--status', join(b.root, 'statuses.json'), '--test-cmd', 'true'], extra)
  assert.equal(cl.code, 0, cl.out)
  const r = b.facts([], extra).review
  assert.equal(r.state, 'closed', JSON.stringify(r))
  assert.equal(r.deferred.length, 1, `one finding, one summary line: ${JSON.stringify(r.deferred)}`)
  assert.equal(r.deferredItems.length, 1, JSON.stringify(r.deferredItems))
  const [item] = r.deferredItems
  assert.deepEqual([item.id, item.kind, item.score, item.location, item.trigger, item.reason],
    ['x1', 'code', 'HIGH 81/100 (likelihood 9/10 × impact 9/10)', 'web/App.tsx:2', 'two sessions in one folder', 'later'])
  assert.equal(item.issue, 'Two threads can share one file. The nearest folder is shared by every session. It takes over the first file. The first pointer still points there. Old items keep dragging along.')
  const body = [
    '## What this does and why', 'Changes A, so the app reads ten.', '', '## Did it match the goal?', 'No plan.', '', '## Files changed', '- `web/App.tsx`', '',
    '## How to try it', 'Render it.', '', '## Review highlights', ...r.reviewer, '',
    '## Deferred findings', `- **x1 ${item.score}:** two sessions in one folder could share one handoff file. Deferred: later.`, '',
    '## Docs and context', '✅', '', "## Agent's take", 'Small.', '',
  ].join('\n')
  writeFileSync(join(b.root, 'body.md'), body)
  const c = b.helper(['--check', join(b.root, 'body.md')], extra)
  assert.equal(c.code, 0, c.out)
})

test('C3 --check: a not-met marker counts only on a line naming that one criterion; a line naming two is ambiguous', () => {
  const b = fixture()
  closedGate(b)
  const f = b.facts()
  const crit = f.review.criteria[0]
  const body = good(f)
  const notDone = '❌ C2 not done: the app does not log yet.'
  const missing = [`"Did it match the goal?" is missing unmet criterion C2, as a not-done line: ${crit}`]
  assert.deepEqual(checked(b, body.replace(notDone, 'C2 is met; C3 is not met.')).problems, missing, 'the "not met" belongs to C3, not C2')
  assert.deepEqual(checked(b, body.replace(notDone, 'C3 is met; C2 is not met.')).problems, missing, 'a line naming two criteria is ambiguous')
  assert.deepEqual(checked(b, body.replace(notDone, 'C2 and C3 are not met.')).problems, missing, 'one marker never stands for two criteria')
  assert.deepEqual(checked(b, body.replace(notDone, 'C2 is met; C3.1 is not met.')).problems, missing, 'another numbering depth is another criterion')
  assert.deepEqual(checked(b, body.replace(notDone, 'C2 is met; R3 is not met.')).problems, missing, 'another prefix is another criterion')
  assert.deepEqual(checked(b, body.replace(notDone, 'C2 is met; 4.2 is not met.')).problems, missing, 'a dotted number is a criterion too')
  assert.deepEqual(checked(b, body.replace(notDone, `${notDone}\nC3 met.`)).problems, [], 'a met criterion on its own line asks nothing')
  assert.deepEqual(checked(b, body.replace(notDone, `${notDone}\n✅ C3 and C2 done.`)).problems,
    [`"Did it match the goal?" shows unmet criterion C2 as done (✅), but the review recorded it not met: ${crit}`], 'a ✅ on a line naming it still counts against it')
})

test('C3 --check: a line naming two criteria is ambiguous whatever the ids look like (2, AC-1, c1)', () => {
  const unmet = (...ids) => ids.map((id) => `c${id.replace(/\D/g, '')} criterion ${id} not met: the app logs; recheck: no log line; Deferred: later`)
  const missing = (crits) => crits.map((l) => `"Did it match the goal?" is missing unmet criterion ${l.split(' ')[2]}, as a not-done line: ${l}`)
  const goalLines = (crits) => crits.map((l) => `❌ ${l.split(' ')[2]} not done: the app does not log yet.`).join('\n')
  for (const ids of [['2', '3'], ['AC-1', 'AC-2']]) {
    const b = fixture()
    const crits = unmet(...ids)
    closedGate(b, SUMMARY.replace(/^c1 criterion C2 .*$/m, crits.join('\n')))
    const body = good(b.facts())
    assert.deepEqual(checked(b, body).problems, [], `one criterion per line passes: ${ids}`)
    const mixed = `${ids[0]} is met; ${ids[1]} is not met.`
    assert.deepEqual(checked(b, body.replace(goalLines(crits), mixed)).problems, missing(crits), `"${mixed}" holds neither criterion`)
    assert.deepEqual(checked(b, body.replace(goalLines(crits), `${ids[1]} is not met.\n${ids[0]} is not met.`)).problems, [], `a single-criterion line still passes: ${ids}`)
  }
  const b = fixture()
  const deferred = ['c1 criterion C2 not met: the app logs; Deferred: later', 'c2 criterion C3 not met: the app warns; Deferred: later']
  closedGate(b, SUMMARY.replace('Deferred findings\n', `Deferred findings\n${deferred.join('\n')}\n`))
  const f = b.facts()
  const body = good(f)
  assert.deepEqual(checked(b, body).problems, [])
  assert.deepEqual(checked(b, body.replace(entry(f.review.deferredItems[0]), '- c1 is met; c2 is not met.')).problems,
    ['"Deferred findings" is missing c1 (criterion C2 not met)'], 'a lowercase deferred id beside the line\'s own is another item')
})

test('C3 --check: a criterion and its sub-criterion both unmet (C3, C3.1), each on its own line, pass', () => {
  const b = fixture()
  const crits = ['c1 criterion C3 not met: the app logs; Deferred: later', 'c2 criterion C3.1 not met: the app warns; Deferred: later']
  closedGate(b, SUMMARY.replace(/^c1 criterion C2 .*$/m, crits.join('\n')))
  assert.deepEqual(checked(b, good(b.facts())).problems, [], 'C3 inside C3.1 is not C3')
  const b2 = fixture()
  closedGate(b2, SUMMARY.replace('Deferred findings\n', `Deferred findings\n${crits.join('\n')}\n`).replace(/^c1 criterion C2 .*\n/m, ''))
  assert.deepEqual(checked(b2, good(b2.facts())).problems, [], 'nor in Deferred findings')
})

test('C3 --check: a bold id followed by a colon (**x1:**) is held to its score like any other', () => {
  const b = fixture()
  closedGate(b)
  const f = b.facts()
  const body = good(f)
  const [high] = f.review.deferredItems
  assert.deepEqual(checked(b, body.replace(`- x1 ${high.score}:`, `- **x1:** ${high.score}:`)).problems, [])
  assert.deepEqual(checked(b, body.replace(`- x1 ${high.score}:`, `- **x1:** ${F2_SCORE}:`)).problems,
    [`"Deferred findings" is missing x1 with its score as the summary gives it: x1 ${high.score}`], 'the colon form still ties the id to its own score')
})
