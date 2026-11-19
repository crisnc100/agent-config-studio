import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// The prompt manifest: every code and security pass of a review and of a fix check records the [path, base state, head
// state] of each file section it inlined whole, and which files it did not inline and why. The checks here hold the record
// against the prompt the stub reviewer actually received, byte for byte. Stub CLIs record every model call; temporary
// HOME and Git config; no real model.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'review.mjs')
const ROOT = mkdtempSync(join(tmpdir(), 'review-manifest-test-'))
const HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo'), BIN = join(ROOT, 'bin'), CALLS = join(ROOT, 'calls.jsonl')
const LOG = join(HOME, '.agent-config-studio/review-log/review-log.jsonl')
const HOME_CONFIG = join(HOME, '.agent-config-studio/review-gate/config.json')
const USER_GITCONFIG = join(HOME, 'isolated.gitconfig')
const MARKER = 'SECURITY REVIEW ONLY.'
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
mkdirSync(BIN)
const stub = (name, body) => {
  writeFileSync(join(BIN, name), `#!${process.execPath}\n${body}`)
  chmodSync(join(BIN, name), 0o755)
}
stub('model-id', `
const a = process.argv.slice(2), ids = { sol: 'gpt-stub-sol', opus: 'claude-stub-opus' }
const roles = { reviewer: 'sol,opus', security: 'opus,sol' }
if (a[0] === '--role') { const use = (roles[a[1]] || 'sol').split(','); console.log(JSON.stringify({ use, ids: use.map((f) => ids[f]) })) }
else if (a[0] === '--flavor') console.log(JSON.stringify({ flavor: { effort: 'high' } }))
else console.log(ids[a[0]] || 'stub-' + a[0])
`)
// STUB_FINDINGS / STUB_SEC_FINDINGS: the code and security replies, as JSON text (default: no findings).
const modelBody = `
const fs = require('node:fs')
const a = process.argv.slice(2), cli = require('node:path').basename(process.argv[1])
if (a[0] === 'mcp') { console.log('[]'); process.exit(0) }
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8') : a[a.indexOf('--json-schema')+1]
const prompt = cli === 'codex' ? a.at(-1) : a[a.indexOf('-p')+1]
const kind = schema.includes('"scores"') ? 'scores' : schema.includes('"verdicts"') ? 'verdicts' : prompt.includes(${JSON.stringify(MARKER)}) ? 'security' : 'code'
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ cli, kind, prompt }) + '\\n')
const reply = kind === 'scores' ? '{"scores":[]}' : kind === 'verdicts' ? '{"verdicts":[]}'
  : kind === 'security' ? (process.env.STUB_SEC_FINDINGS || '{"findings":[]}') : (process.env.STUB_FINDINGS || '{"findings":[]}')
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o')+1], reply)
else console.log(JSON.stringify({ structured_output: JSON.parse(reply), structuredOutput: JSON.parse(reply) }))
`
for (const name of ['codex', 'claude']) stub(name, modelBody)
after(() => rmSync(ROOT, { recursive: true, force: true }))

const env = (extra = {}, home = HOME) => ({ HOME: home, CODEX_HOME: join(home, '.codex'), GROK_HOME: join(home, '.grok'), GIT_CONFIG_GLOBAL: join(home, 'isolated.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1', PATH: [BIN, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: ROOT, REVIEW_BASE: 'main', REVIEW_REVIEWER: 'sol', ...extra })
function run(command, args, { extra = {}, cwd = REPO, home = HOME, encoding = 'utf8', input } = {}) {
  const r = spawnSync(command, args, { cwd, env: env(extra, home), encoding, input, timeout: 120000, maxBuffer: 256 * 1024 * 1024 })
  return encoding ? { ...r, out: `${r.stdout || ''}\n${r.stderr || ''}` } : r
}
const script = (args, extra = {}, cwd = REPO, home = HOME) => run(process.execPath, [SCRIPT, ...args], { extra, cwd, home })
function git(...args) {
  const r = run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  assert.equal(r.status, 0, r.out)
  return r.stdout.trim()
}
const gitIn = (cwd, home) => (...args) => {
  const r = run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, home })
  assert.equal(r.status, 0, r.out)
  return r.stdout.trim()
}
function commit(files, message = 'change') {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) { git('rm', '-q', '--', path); continue }
    mkdirSync(dirname(join(REPO, path)), { recursive: true })
    writeFileSync(join(REPO, path), text)
    git('add', '--', path)
  }
  git('commit', '-qm', message)
  return git('rev-parse', 'HEAD')
}
const lines = (path) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const calls = (path = CALLS) => lines(path)
const allowed = (r) => assert.equal(r.status, 0, r.out)
const refused = (r, pattern) => { assert.notEqual(r.status, 0, r.out); if (pattern) assert.match(r.out, pattern) }
const findingsJson = (r) => JSON.parse(r.stdout.slice(r.stdout.indexOf('===FINDINGS_JSON===') + 19))
const homeConfig = (config, home = HOME) => {
  const file = join(home, '.agent-config-studio/review-gate/config.json')
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(config))
}
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const APP = 'export const one = 1\nexport const two = 2\nexport const three = 3\n'

// The per-file command the design names for a reviewer section: fixed flags, so no user git config can change it.
function section(cwd, home, base, head, path) {
  const r = run('git', ['-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color',
    '--src-prefix=a/', '--dst-prefix=b/', '--no-renames', '--no-relative', '--ignore-submodules=none', '--submodule=short', base, head, '--', `:(top,literal)${path}`], { cwd, home })
  assert.equal(r.status, 0, r.out)
  return r.stdout
}
// "mode blob" by path for every file in a commit (or tree), as git ls-tree prints it.
function lsTree(cwd, home, rev) {
  const r = run('git', ['ls-tree', '-r', '-z', '--full-tree', rev], { cwd, home, encoding: null })
  assert.equal(r.status, 0, String(r.stderr))
  const states = new Map()
  for (const entry of r.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t'), [mode, , object] = entry.slice(0, tab).split(' ')
    states.set(entry.slice(tab + 1), `${mode} ${object}`)
  }
  return states
}
const headerOf = (path) => `diff --git a/${path} b/${path}`
// Checks one manifest against the one prompt it was sent in: (a) each read section is in the prompt byte for byte, the
// sections sit together in one block whose hash is promptSha256, and the states match ls-tree; (c) no unread path has a
// section there.
function checkManifest(m, prompt, { cwd = REPO, home = HOME } = {}) {
  assert.equal(m.v, 1)
  assert.match(m.base, /^[0-9a-f]{40}$/); assert.match(m.head, /^[0-9a-f]{40}$/)
  assert.equal(typeof m.cap, 'number')
  const paths = m.read.map(([p]) => p)
  assert.deepEqual(paths, [...paths].sort(), 'read is sorted by path')
  assert.equal(new Set(paths).size, paths.length)
  const atBase = lsTree(cwd, home, m.base), atHead = lsTree(cwd, home, m.head)
  const placed = m.read.map(([p, s0, s1]) => {
    assert.equal(s0, atBase.get(p) ?? null, `${p}: base state`)
    assert.equal(s1, atHead.get(p) ?? null, `${p}: head state`)
    assert.notEqual(s0, s1, `${p}: a read path changed`)
    const text = section(cwd, home, m.base, m.head, p)
    assert.ok(text.length > 0, p)
    const at = prompt.indexOf(text)
    assert.ok(at !== -1, `${p}: its section is in the prompt byte for byte`)
    return { at, text }
  }).sort((a, b) => a.at - b.at)
  const block = placed.map((s) => s.text).join('')
  if (placed.length) assert.equal(prompt.slice(placed[0].at, placed[0].at + block.length), block, 'the read sections form one block')
  assert.equal(m.promptSha256, sha256(block), 'promptSha256 is the hash of exactly the inlined sections')
  assert.ok(block.length <= m.cap, 'the block fits the cap')
  for (const [p, why] of m.unread) {
    assert.ok(['binary', 'oversize', 'capped', 'submodule', 'submodule-change', 'encoding'].includes(why), `${p}: ${why}`)
    assert.ok(!paths.includes(p), `${p} is read and unread`)
    assert.ok(!`\n${prompt}`.includes(`\n${headerOf(p)}\n`), `${p} (${why}) has no section in the prompt`)
    assert.ok(prompt.includes(JSON.stringify(p)), `${p}: the prompt names what it was not shown`)
  }
}
const record = (id) => lines(LOG).find((e) => e.id === id)
function reviewed(extra = {}, args = []) {
  const r = script(args, extra)
  allowed(r)
  return record(findingsJson(r).reviewId)
}
function fixChecked(id, extra = {}, args = []) {
  allowed(script(['--fix-check', id, ...args], extra))
  const check = lines(LOG).at(-1)
  assert.equal(check.kind, 'fix-check')
  return check
}
const promptOf = (kind, pred = () => true) => {
  const found = calls().filter((c) => c.kind === kind && pred(c.prompt))
  assert.equal(found.length, 1, `one ${kind} prompt`)
  return found[0].prompt
}

beforeEach(() => {
  for (const path of [HOME, REPO, CALLS]) rmSync(path, { recursive: true, force: true })
  mkdirSync(HOME); mkdirSync(REPO)
  git('init', '-q', '-b', 'main')
  commit({ 'README.md': 'base\n', 'src/app.js': APP })
  git('checkout', '-qb', 'feat')
  commit({ 'src/app.js': APP.replace('three = 3', 'three = 33'), 'README.md': 'base\nThe app exports three numbers.\n' })
})

test('M1 a review records the code and security manifests: base, head, the triples it inlined, the hash and the cap', () => {
  homeConfig({ security: { run: 'always' } })
  const r = reviewed()
  const head = git('rev-parse', 'HEAD'), base = git('merge-base', 'main', 'HEAD')
  for (const [m, role] of [[r.manifest, 'code'], [r.security.manifest, 'security']]) {
    assert.equal(m.role, role)
    assert.equal(m.base, base); assert.equal(m.head, head)
    assert.equal(m.cap, 120000)
    assert.deepEqual(m.read, [
      ['README.md', `100644 ${git('rev-parse', `${base}:README.md`)}`, `100644 ${git('rev-parse', `${head}:README.md`)}`],
      ['src/app.js', `100644 ${git('rev-parse', `${base}:src/app.js`)}`, `100644 ${git('rev-parse', `${head}:src/app.js`)}`],
    ])
    assert.deepEqual(m.unread, [])
  }
  checkManifest(r.manifest, promptOf('code'))
  checkManifest(r.security.manifest, promptOf('security'))
  // The riskiest kind leads: the logic file's section comes before the docs file's.
  const prompt = promptOf('code')
  assert.ok(prompt.indexOf(headerOf('src/app.js')) < prompt.indexOf(headerOf('README.md')))
  const manifest = script(['--manifest', r.id])
  allowed(manifest)
  const printed = JSON.parse(manifest.stdout)
  assert.deepEqual(printed.manifest, r.manifest)
  assert.deepEqual(printed.security, r.security.manifest)
  refused(script(['--manifest', 'no-such-review']), /No logged review matches/)
})

test('M2 a fix check records its manifests and the findings it asked about; the code pass reads every file changed since the review, and the cited one, from the base', () => {
  homeConfig({ security: { run: 'always' } })
  const f1 = { issue: 'three is wrong', file: 'src/app.js', line: '3', quote: 'export const three = 33', suggestion: 'fix it',
    likelihood: 5, impact: 5, protected: false, trigger: 'importing three' }
  const r = reviewed({ STUB_FINDINGS: JSON.stringify({ findings: [f1] }) })
  commit({ 'src/app.js': APP.replace('three = 3', 'three = 34'), 'src/new.js': 'export const added = 1\n' })
  rmSync(CALLS, { force: true })
  const check = fixChecked(r.id)
  const head = git('rev-parse', 'HEAD')
  assert.deepEqual(check.asked, ['f1'])
  assert.equal(check.manifest.role, 'code')
  assert.equal(check.manifest.base, git('merge-base', 'main', 'HEAD'), 'the coverage base, not the review head'); assert.equal(check.manifest.head, head)
  assert.deepEqual(check.manifest.read.map(([p]) => p), ['src/app.js', 'src/new.js'])
  checkManifest(check.manifest, promptOf('code'))
  assert.equal(check.security.status, 'ran')
  assert.equal(check.security.manifest.role, 'security')
  assert.equal(check.security.manifest.head, head)
  checkManifest(check.security.manifest, promptOf('security'))
  const printed = JSON.parse(script(['--manifest', check.id]).stdout)
  assert.deepEqual(printed.manifest, check.manifest)
})

test('M3 a security pass that fails or times out records no manifest; the code manifest stays', () => {
  homeConfig({ security: { run: 'always', timeoutMs: 3000 } })
  for (const fault of ['exit', 'late']) {
    const r = reviewed({ REVIEW_SECURITY_TEST_FAULT: fault })
    assert.equal(r.security.status, 'failed', fault)
    assert.equal(Object.hasOwn(r.security, 'manifest'), false, fault)
    assert.equal(r.manifest.role, 'code')
  }
  const r = reviewed({}, ['--code-only'])
  assert.equal(r.security.status, 'not-asked')
  assert.equal(Object.hasOwn(r.security, 'manifest'), false)
  commit({ 'src/app.js': APP.replace('three = 3', 'three = 34') })
  const check = fixChecked(r.id, { REVIEW_SECURITY_TEST_FAULT: 'exit' })
  assert.equal(check.security.status, 'failed')
  assert.equal(Object.hasOwn(check.security, 'manifest'), false)
  assert.equal(check.manifest.role, 'code')
})

test('M4 a code reviewer answer with no findings array fails the pass: no record and no manifest, in a review and a fix check', () => {
  for (const reply of ['{}', '{"findings":null}', '{"findings":{"0":1}}']) {
    const before = lines(LOG).length
    refused(script([], { STUB_FINDINGS: reply }), /no findings list/)
    assert.equal(lines(LOG).length, before, reply)
  }
  // The multi-agent team: one lens with no list fails the whole pass.
  const before = lines(LOG).length
  refused(script([], { REVIEW_REVIEWER: 'claude', STUB_FINDINGS: '{}' }), /no findings list/)
  assert.equal(lines(LOG).length, before)
  const r = reviewed()
  commit({ 'src/app.js': APP })
  const count = lines(LOG).length
  refused(script(['--fix-check', r.id], { STUB_FINDINGS: '{}' }), /no findings list/)
  assert.equal(lines(LOG).length, count)
})

test('M5 binary, oversize, capped and submodule changes are unread with their reason, never sections in the prompt', () => {
  homeConfig({ security: { run: 'always' } })
  const root = git('rev-parse', 'main')
  const pad = (name, n) => Array.from({ length: n }, (_, i) => `export const ${name}${i} = ${i}`).join('\n') + '\n'
  commit({ 'src/blob.js': 'export const x = 1\u0000\n', 'img/logo.png': '\u0089PNG\u0000\u0001', 'src/huge.js': pad('h', 400),
    'tests/fill.test.js': pad('t', 120), 'docs/fill.md': pad('d', 100) })
  // An uninitialised submodule: the gitlink, with an empty folder so the work tree is clean.
  mkdirSync(join(REPO, 'vendor/sub'), { recursive: true })
  git('update-index', '--add', '--cacheinfo', `160000,${root},vendor/sub`); git('commit', '-qm', 'submodule')
  const r = reviewed({ REVIEW_TEST_DIFF_CAP: '5000' })
  const unread = Object.fromEntries(r.manifest.unread)
  assert.equal(unread['src/blob.js'], 'binary')
  assert.equal(unread['img/logo.png'], 'binary')
  assert.equal(unread['src/huge.js'], 'oversize')
  assert.equal(unread['vendor/sub'], 'submodule')
  // Priority order: the logic file fits, the tests file fits after it, the docs file is what the cap leaves out.
  assert.equal(unread['docs/fill.md'], 'capped')
  assert.ok(r.manifest.read.some(([p]) => p === 'src/app.js'))
  assert.ok(r.manifest.read.some(([p]) => p === 'tests/fill.test.js'))
  assert.equal(r.manifest.cap, 5000)
  checkManifest(r.manifest, promptOf('code'))
  checkManifest(r.security.manifest, promptOf('security'))
  assert.deepEqual(r.security.manifest.unread, r.manifest.unread)
  // Nothing unread is in either read list: the image and the gitlink included.
  for (const m of [r.manifest, r.security.manifest])
    assert.ok(!m.read.some(([p]) => ['docs/fill.md', 'src/blob.js', 'src/huge.js', 'img/logo.png', 'vendor/sub'].includes(p)), JSON.stringify(m.read))
  // The cap seam only lowers the cap.
  const high = reviewed({ REVIEW_TEST_DIFF_CAP: '999999999' })
  assert.equal(high.manifest.cap, 120000)
})

test('M6 renames are two paths, a deletion and an addition; a type change is one unit, read whole or unread whole', () => {
  git('checkout', '-q', 'main')
  commit({ 'src/old.js': Array.from({ length: 20 }, (_, i) => `export const o${i} = ${i}`).join('\n') + '\n' })
  symlinkSync('target', join(REPO, 'link.js')); symlinkSync('target', join(REPO, 'bin.js')); git('add', 'link.js', 'bin.js'); git('commit', '-qm', 'links')
  git('checkout', '-q', 'feat'); git('merge', '-q', '--no-edit', 'main')
  git('mv', 'src/old.js', 'src/moved.js'); git('commit', '-qm', 'move')
  git('rm', '-q', 'link.js', 'bin.js')
  commit({ 'link.js': 'export const now = "a file"\n', 'bin.js': 'export const x = 1\u0000\n' })
  const r = reviewed()
  const read = new Map(r.manifest.read.map(([p, s0, s1]) => [p, [s0, s1]]))
  assert.equal(read.get('src/old.js')[1], null, 'the source is a deletion')
  assert.equal(read.get('src/moved.js')[0], null, 'the destination is an addition')
  assert.match(read.get('link.js')[0], /^120000 /); assert.match(read.get('link.js')[1], /^100644 /)
  const prompt = promptOf('code')
  const link = section(REPO, HOME, r.manifest.base, r.manifest.head, 'link.js')
  assert.equal(link.split(`${headerOf('link.js')}\n`).length - 1, 2, 'a type change is two sections in one unit')
  assert.ok(prompt.includes(link))
  assert.deepEqual(r.manifest.unread, [['bin.js', 'binary']])
  checkManifest(r.manifest, prompt)
})

test('M7 quoted and non-ASCII paths are recorded by their exact names and inlined byte for byte', () => {
  const names = ['src/q"t.js', 'src/tëxt.js', 'src/tab\tname.js', 'src/a b.js', 'src/back\\slash.js']
  commit(Object.fromEntries(names.map((p, i) => [p, `export const n${i} = ${i}\n`])))
  const r = reviewed()
  for (const p of names) assert.ok(r.manifest.read.some(([q]) => q === p), p)
  checkManifest(r.manifest, promptOf('code'))
})

test('M8 user git config cannot change the sections: noprefix, mnemonicPrefix, an external diff, textconv, color, relative, quotePath', () => {
  commit({ '.gitattributes': 'src/hidden.js diff=hide\n', 'src/hidden.js': 'export const hidden = 1\n', 'src/tëxt.js': 'export const e = 1\n' })
  const plain = reviewed()
  const plainPrompt = promptOf('code')
  writeFileSync(USER_GITCONFIG, '[diff]\n\tnoprefix = true\n\tmnemonicPrefix = true\n\texternal = /bin/false\n\trelative = true\n\trenames = copies\n' +
    '[diff "hide"]\n\ttextconv = /usr/bin/true\n[color]\n\tdiff = always\n\tui = always\n[core]\n\tquotePath = true\n')
  rmSync(CALLS, { force: true })
  const r = reviewed()
  const prompt = promptOf('code')
  assert.deepEqual(r.manifest.read, plain.manifest.read)
  assert.equal(r.manifest.promptSha256, plain.manifest.promptSha256)
  assert.ok(prompt.includes('diff --git a/src/app.js b/src/app.js'))
  assert.ok(prompt.includes('+export const hidden = 1'), 'the real content, not the textconv output')
  assert.ok(prompt.includes('diff --git a/src/tëxt.js b/src/tëxt.js'), 'non-ASCII names stay as they are')
  assert.ok(!prompt.includes('\u001b['), 'no color codes')
  assert.ok(plainPrompt.includes('+export const hidden = 1'))
  rmSync(USER_GITCONFIG, { force: true })
})

test('M11 a section that is not valid UTF-8 is never sent lossily: it is unread for its encoding, by both passes', () => {
  homeConfig({ security: { run: 'always' } })
  writeFileSync(join(REPO, 'src/latin.js'), Buffer.from('export const allow = ["caf\xe9", "caf\xe8"]\n', 'latin1'))
  git('add', 'src/latin.js'); git('commit', '-qm', 'latin-1')
  const r = reviewed()
  assert.deepEqual(r.manifest.unread, [['src/latin.js', 'encoding']])
  assert.ok(!r.manifest.read.some(([p]) => p === 'src/latin.js'))
  assert.ok(!promptOf('code').includes('\ufffd'), 'no replacement character reaches the reviewer')
  checkManifest(r.manifest, promptOf('code'))
  assert.deepEqual(r.security.manifest.unread, [['src/latin.js', 'encoding']])
})

test('M12 a submodule replaced by a file is read only when the file side is inlined; a binary replacement is unread', () => {
  homeConfig({ security: { run: 'always' } })
  git('checkout', '-q', 'main')
  const root = git('rev-parse', 'HEAD')
  for (const p of ['vendor/text', 'vendor/bin']) mkdirSync(join(REPO, p), { recursive: true })
  git('update-index', '--add', '--cacheinfo', `160000,${root},vendor/text`, '--cacheinfo', `160000,${root},vendor/bin`); git('commit', '-qm', 'gitlinks')
  git('checkout', '-q', 'feat'); git('merge', '-q', '--no-edit', 'main')
  git('rm', '-q', '--cached', 'vendor/text', 'vendor/bin')
  rmSync(join(REPO, 'vendor'), { recursive: true, force: true }); mkdirSync(join(REPO, 'vendor'))
  writeFileSync(join(REPO, 'vendor/text'), 'export const replaced = 1\n'); writeFileSync(join(REPO, 'vendor/bin'), 'export const b = 1\u0000\n')
  git('add', 'vendor/text', 'vendor/bin'); git('commit', '-qm', 'replace the submodules')
  const r = reviewed()
  const text = r.manifest.read.find(([p]) => p === 'vendor/text')
  assert.ok(text, JSON.stringify(r.manifest))
  assert.match(text[1], /^160000 /); assert.match(text[2], /^100644 /)
  assert.ok(promptOf('code').includes('+export const replaced = 1'), 'the file side is in the prompt')
  assert.deepEqual(r.manifest.unread, [['vendor/bin', 'submodule-change']])
  checkManifest(r.manifest, promptOf('code'))
  assert.ok(!r.security.manifest.read.some(([p]) => p === 'vendor/bin'))
  assert.ok(r.security.manifest.read.some(([p]) => p === 'vendor/text'))
  // A replacement over the cap is unread too.
  const capped = reviewed({ REVIEW_TEST_DIFF_CAP: '50' })
  assert.ok(capped.manifest.unread.some(([p, why]) => p === 'vendor/text' && why === 'oversize'), JSON.stringify(capped.manifest.unread))
})

test('M13 a fix check reads only what changed from the base: files restored to the base have no section, so nothing is read and no security pass is owed', () => {
  homeConfig({ security: { run: 'always' } })
  const r = reviewed()
  commit({ 'src/app.js': APP, 'README.md': 'base\n' }, 'restore both files to the base')
  const check = fixChecked(r.id)
  assert.deepEqual(check.manifest.read, [])
  assert.equal(check.security.status, 'not-required')
  assert.equal(Object.hasOwn(check.security, 'manifest'), false)
})

test('M9 an empty-tree base records the empty tree as its base', () => {
  rmSync(REPO, { recursive: true, force: true }); mkdirSync(REPO)
  git('init', '-q', '-b', 'feat')
  commit({ 'src/app.js': APP })
  const r = reviewed()
  assert.equal(r.manifest.base, EMPTY_TREE)
  assert.deepEqual(r.manifest.read.map(([p, s0]) => [p, s0]), [['src/app.js', null]])
  checkManifest(r.manifest, promptOf('code'))
})

// ── the property test: seeded random branches ────────────────────────────────
// A small seeded generator (mulberry32), so a failing seed reproduces with PROPERTY_SEED=<n>.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const SEEDS = process.env.PROPERTY_SEED ? [Number(process.env.PROPERTY_SEED)] : Array.from({ length: Number(process.env.PROPERTY_SEEDS || 50) }, (_, i) => i + 1)
function propertyRun(seed) {
  const rand = rng(seed), pick = (list) => list[Math.floor(rand() * list.length)], chance = (p) => rand() < p
  const dir = mkdtempSync(join(ROOT, `seed-${seed}-`)), repo = join(dir, 'repo'), home = join(dir, 'home')
  mkdirSync(repo); mkdirSync(home)
  writeFileSync(join(home, 'isolated.gitconfig'), '[diff "conv"]\n\ttextconv = /usr/bin/true\n')
  homeConfig({ security: { run: pick(['required', 'always']) } }, home)
  const g = gitIn(repo, home)
  const body = (n, tag) => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${Math.floor(rand() * 1000)}`).join('\n') + '\n'
  const write = (files) => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) { g('rm', '-q', '--', path); continue }
      mkdirSync(dirname(join(repo, path)), { recursive: true })
      writeFileSync(join(repo, path), text)
      g('add', '--', path)
    }
  }
  const step = (files, message) => { write(files); g('commit', '-qm', message) }
  g('init', '-q', '-b', 'main')
  const plain = Array.from({ length: 3 + Math.floor(rand() * 6) }, (_, i) => `${pick(['src', 'lib', 'docs', 'tests'])}/f${i}.${pick(['js', 'md', 'test.js', 'css'])}`)
  step({ ...Object.fromEntries(plain.map((p, i) => [p, body(5 + Math.floor(rand() * 40), `v${i}`)])),
    'src/rename-me.js': body(30, 'r'), 'src/shared.js': body(40, 's'), 'src/main-only.js': body(5, 'm'), 'src/conv.js': body(5, 'c') }, 'base')
  symlinkSync('target', join(repo, 'src/kind.js')); g('add', 'src/kind.js'); g('commit', '-qm', 'link')
  const root = g('rev-parse', 'HEAD')
  g('checkout', '-qb', 'feat')
  const edits = {}
  for (const p of plain) {
    const roll = rand()
    if (roll < 0.45) edits[p] = body(5 + Math.floor(rand() * 60), 'e')
    else if (roll < 0.6) edits[p] = null
  }
  step({ ...edits, 'src/shared.js': `export const top = ${seed}\n${readFileSync(join(repo, 'src/shared.js'), 'utf8').split('\n').slice(1).join('\n')}`,
    'src/blob.js': `export const b = ${seed}\u0000\n`, 'src/huge.js': body(200 + Math.floor(rand() * 200), 'h'),
    'src/ñame.js': body(3, 'n'), 'src/q"t.js': body(3, 'q'), '.gitattributes': 'src/hidden.js -diff\nsrc/conv.js diff=conv\n',
    'src/hidden.js': body(4, 'x'), 'src/conv.js': body(6, 'c') }, 'branch')
  if (chance(0.5)) {
    writeFileSync(join(repo, 'src/latin.js'), Buffer.from(`export const s = "caf\xe9 ${seed}"\n`, 'latin1')); g('add', 'src/latin.js'); g('commit', '-qm', 'latin-1')
  }
  g('mv', 'src/rename-me.js', 'src/renamed.js'); g('commit', '-qm', 'rename')
  g('rm', '-q', 'src/kind.js'); step({ 'src/kind.js': pick([body(3, 'k'), `export const k = 1\u0000\n`]) }, 'type change')
  mkdirSync(join(repo, 'vendor/sub'), { recursive: true })
  g('update-index', '--add', '--cacheinfo', `160000,${root},vendor/sub`); g('commit', '-qm', 'gitlink')
  if (chance(0.5)) {
    g('checkout', '-q', 'main')
    const shared = readFileSync(join(repo, 'src/shared.js'), 'utf8').split('\n')
    step({ 'src/shared.js': [...shared.slice(0, -2), `export const bottom = ${seed}`, ''].join('\n'), 'src/main-only.js': body(6, 'mm') }, 'main moves')
    g('checkout', '-q', 'feat'); g('merge', '-q', '--no-edit', 'main')
  }
  const cap = String(3000 + Math.floor(rand() * 5000))
  const extra = { REVIEW_TEST_DIFF_CAP: cap }
  const pass = (args, more = {}) => {
    rmSync(CALLS, { force: true })
    const r = run(process.execPath, [SCRIPT, ...args], { extra: { ...extra, ...more }, cwd: repo, home })
    allowed(r)
    return r
  }
  const log = join(home, '.agent-config-studio/review-log/review-log.jsonl')
  const records = () => lines(log)
  const check = (m, kind, pred = () => true) => {
    const found = calls().filter((c) => c.kind === kind && pred(c.prompt))
    assert.equal(found.length, 1, `seed ${seed}: one ${kind} prompt`)
    checkManifest(m, found[0].prompt, { cwd: repo, home })
  }
  const id = findingsJson(pass([])).reviewId
  const review = records().find((e) => e.id === id)
  check(review.manifest, 'code')
  if (review.security.status === 'ran') check(review.security.manifest, 'security')
  // The fix round: a change to one read file and one new file, then the one fix check.
  const target = pick(review.manifest.read.filter(([, , s1]) => s1?.startsWith('100644')).map(([p]) => p))
  step({ ...(target && { [target]: `${readFileSync(join(repo, target), 'utf8')}export const fixed = ${seed}\n` }), 'src/fix.js': body(3, 'f') }, 'fix')
  pass(['--fix-check', id])
  const fix = records().at(-1)
  assert.equal(fix.kind, 'fix-check')
  check(fix.manifest, 'code')
  if (fix.security?.status === 'ran') check(fix.security.manifest, 'security')
  const statuses = join(dir, 'statuses.json'); writeFileSync(statuses, '{}')
  pass(['--close', id, '--status', statuses, '--test-cmd', 'true'])
  let close = records().at(-1)
  assert.equal(close.type, 'close')
  const manifests = [review.manifest, fix.manifest]
  // What no pass read is unseen; slices of exactly those files at the tip read them, until nothing is left.
  for (let round = 0; close.unseen.length; round++) {
    assert.ok(round < 4, `seed ${seed}: still unseen after ${round} slice rounds: ${close.unseen.join(', ')}`)
    const slice = records().find((e) => e.id === findingsJson(pass([], { REVIEW_PATHS: close.unseen.join(',') })).reviewId)
    check(slice.manifest, 'code')
    manifests.push(slice.manifest)
    pass(['--close', slice.id, '--status', statuses, '--test-cmd', 'true'])
    close = records().at(-1)
  }
  const tip = g('rev-parse', 'HEAD')
  const gate = run(process.execPath, [SCRIPT, '--gate'], { extra, cwd: repo, home, input: `refs/heads/feat ${tip} refs/heads/feat ${'0'.repeat(40)}\n` })
  allowed(gate)
  // (b) Every changed file the push gate let through is either in a code manifest's read list at its exact
  // [path, base state, tip state], or named unread as unreadable in one, and then the tier names it. Nothing else.
  const atBase = lsTree(repo, home, review.baseSha), atTip = lsTree(repo, home, tip)
  const changed = [...new Set([...atBase.keys(), ...atTip.keys()])].filter((p) => (atBase.get(p) ?? null) !== (atTip.get(p) ?? null) && !p.startsWith('builds/'))
  const unreadable = []
  for (const p of changed) {
    const triple = JSON.stringify([p, atBase.get(p) ?? null, atTip.get(p) ?? null])
    if (manifests.some((m) => m.read.some((t) => JSON.stringify(t) === triple))) continue
    assert.ok(manifests.some((m) => m.unread.some(([q, why]) => q === p && ['binary', 'oversize', 'submodule', 'submodule-change', 'encoding'].includes(why))),
      `seed ${seed}: ${p} passed the gate with no manifest read at its tip triple`)
    unreadable.push(p)
  }
  if (unreadable.length) assert.match(gate.stderr, /not read by any reviewer: /, `seed ${seed}`)
  rmSync(dir, { recursive: true, force: true })
}
test(`M10 property: on ${SEEDS.length} seeded random branches every manifest matches its prompt byte for byte and the push gate lets through only what a manifest read, or names as unreadable`, () => {
  for (const seed of SEEDS) {
    rmSync(CALLS, { force: true })
    propertyRun(seed)
  }
})
