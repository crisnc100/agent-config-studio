#!/usr/bin/env node
/**
 * review.packs.test.mjs — the content of packs/: every manifest explains itself, every listed file exists,
 * and nothing personal or model-specific ships. Offline; reads files only.
 */
import assert from 'node:assert/strict'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PACKS = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PACKAGE = resolve(PACKS, '..')
const IDS = ['review-gate', 'build', 'advisor', 'second-opinion', 'handoff', 'worktree']
const KINDS = ['skill', 'instructions', 'guard', 'push-gate', 'codex-log-access', 'worktree']
const HARNESSES = ['claude', 'codex']
const manifest = (id) => JSON.parse(readFileSync(join(PACKS, id, 'pack.json'), 'utf8'))
const text = (value) => typeof value === 'string' && value.trim().length > 0
const list = (value) => Array.isArray(value) && value.length > 0 && value.every(text)

// Every file that ships: everything under packs/ except each pack's tests/ folder.
function shipped(dir = PACKS) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (lstatSync(path).isDirectory()) return name === 'tests' && dirname(dir) === PACKS ? [] : shipped(path)
    return [path]
  })
}

test('the six packs exist, each with a pack.json whose id matches its folder', () => {
  const folders = readdirSync(PACKS).filter((name) => existsSync(join(PACKS, name, 'pack.json'))).sort()
  assert.deepEqual(folders, [...IDS].sort())
  for (const id of IDS) assert.equal(manifest(id).id, id)
})

test('every pack.json has exactly the plan fields, a non-empty summary and a full explain', () => {
  for (const id of IDS) {
    const pack = manifest(id)
    assert.deepEqual(Object.keys(pack).sort(), ['explain', 'id', 'parts', 'requires', 'summary', 'title', 'version'], id)
    assert.ok(text(pack.title), `${id}: title`)
    assert.equal(pack.version, '1.0.0', `${id}: version`)
    assert.ok(text(pack.summary), `${id}: summary`)
    assert.deepEqual(Object.keys(pack.explain).sort(), ['changes', 'does', 'undo', 'what'], `${id}: explain fields`)
    for (const key of ['what', 'does', 'undo']) assert.ok(text(pack.explain[key]), `${id}: explain.${key}`)
    assert.ok(list(pack.explain.changes), `${id}: explain.changes`)
  }
})

test('every pack.json requires {node, git, modelId, clis: {anyOf}, packs}; build requires review-gate', () => {
  for (const id of IDS) {
    const { requires } = manifest(id)
    assert.deepEqual(Object.keys(requires).sort(), ['clis', 'git', 'modelId', 'node', 'packs'], id)
    assert.equal(requires.node, '>=20', id)
    assert.equal(typeof requires.git, 'boolean', id)
    assert.equal(typeof requires.modelId, 'boolean', id)
    assert.deepEqual(Object.keys(requires.clis), ['anyOf'], id)
    assert.ok(requires.clis.anyOf.every((cli) => ['claude', 'codex', 'grok'].includes(cli)), id)
    assert.ok(Array.isArray(requires.packs) && requires.packs.every((p) => IDS.includes(p) && p !== id), id)
  }
  assert.deepEqual(manifest('build').requires.packs, ['review-gate'])
  for (const id of ['review-gate', 'build', 'advisor', 'second-opinion']) assert.equal(manifest(id).requires.modelId, true, id)
})

test('every part has its fields, a known kind, existing files and its own non-empty changes', () => {
  for (const id of IDS) {
    const { parts } = manifest(id)
    assert.ok(Array.isArray(parts) && parts.length > 0, id)
    assert.equal(new Set(parts.map((p) => p.id)).size, parts.length, `${id}: part ids are unique`)
    for (const part of parts) {
      const where = `${id}/${part.id}`
      assert.deepEqual(Object.keys(part).sort(), ['default', 'explain', 'files', 'harnesses', 'id', 'kind', 'title'], where)
      assert.ok(text(part.id) && text(part.title), where)
      assert.equal(typeof part.default, 'boolean', where)
      assert.ok(KINDS.includes(part.kind), `${where}: kind ${part.kind}`)
      assert.ok(Array.isArray(part.harnesses) && part.harnesses.every((h) => HARNESSES.includes(h)), where)
      assert.ok(Array.isArray(part.files), where)
      for (const file of part.files) assert.ok(existsSync(join(PACKAGE, file)) || lstatSync(join(PACKAGE, file)).isSymbolicLink(), `${where}: ${file}`)
      assert.ok(Object.keys(part.explain).every((key) => ['what', 'does', 'changes', 'undo'].includes(key)), where)
      for (const key of ['what', 'does', 'undo']) if (Object.hasOwn(part.explain, key)) assert.ok(text(part.explain[key]), `${where}: explain.${key}`)
      assert.ok(list(part.explain.changes), `${where}: explain.changes`)
    }
  }
})

test('skills are on by default; machine-wide parts and instruction files are opt-in', () => {
  for (const id of IDS) for (const part of manifest(id).parts) {
    if (part.kind === 'skill') assert.equal(part.default, true, `${id}/${part.id}`)
    if (['guard', 'push-gate', 'codex-log-access', 'instructions'].includes(part.kind)) assert.equal(part.default, false, `${id}/${part.id}`)
  }
})

test('every shipped file under packs/<id>/ is listed by a part, and every skill ships for both harnesses', () => {
  for (const id of IDS) {
    const listed = new Set(manifest(id).parts.flatMap((p) => p.files))
    for (const path of shipped(join(PACKS, id))) {
      const rel = relative(PACKAGE, path)
      if (rel === `packs/${id}/pack.json`) continue
      assert.ok(listed.has(rel), `${rel} ships but no part lists it`)
    }
    for (const part of manifest(id).parts.filter((p) => p.kind === 'skill'))
      for (const harness of part.harnesses)
        assert.ok(part.files.some((f) => f.startsWith(`packs/${id}/skills/${harness}/`) && f.endsWith('/SKILL.md')), `${id}/${part.id}: ${harness} SKILL.md`)
  }
})

test('the push-gate explain says what the global core.hooksPath does and that only opted-in repos are checked', () => {
  const part = manifest('review-gate').parts.find((p) => p.id === 'push-gate')
  const words = `${part.explain.what} ${part.explain.does}`
  assert.match(words, /global git core\.hooksPath/)
  assert.match(words, /every repo's git hooks go through a pass-through/)
  assert.match(words, /A repo's own \.git\/hooks still run/)
  assert.match(words, /its own core\.hooksPath \(Husky and similar tools\) bypasses the pass-through/)
  assert.match(words, /applies only to repos you opt in with git config reviewgate\.enabled true/)
  assert.ok(part.explain.changes.some((c) => /core\.hooksPath/.test(c)))
  assert.ok(part.explain.changes.some((c) => /reviewgate\.enabled/.test(c)))
  const worktreeProjects = manifest('review-gate').parts.find((p) => p.id === 'push-gate-worktree-projects')
  assert.ok(worktreeProjects.explain.changes.some((c) => /reviewgate\.worktreeProjects = true/.test(c)))
})

test('the worktree pack explains the trunk, the worktrees beside it, wnew/wls, env files, zsh only and the .zshrc stanza', () => {
  const pack = manifest('worktree')
  const words = `${pack.explain.what} ${pack.explain.does} ${pack.explain.changes.join(' ')} ${pack.explain.undo}`
  for (const re of [/trunk: a checkout parked on its base branch/, /beside the trunk/, /\bwnew\b/, /\bwls\b/,
    /env files/, /zsh only/, /\.zshrc/, /# >>> agent-config-studio worktree tools >>>/, /your shell is not zsh/])
    assert.match(words, re)
  assert.deepEqual(pack.parts[0].files, ['bin/install-worktree.mjs', 'tools/worktree/wt.zsh', 'tools/worktree/defaults.conf'])
  assert.ok(!existsSync(join(PACKS, 'worktree', 'tools')) && !existsSync(join(PACKS, 'worktree', 'bin')), 'points at the toolkit, does not copy it')
})

// The sweep. No exceptions: a hit anywhere outside packs/*/tests/ fails.
const PERSONAL = /cris|cristian|cortega|crisnc100|ortega|\/Users\/|Documents\/Projects|codex-seats|atlas|\bjev\b/i
test('the sweep finds planted personal text (it cannot pass vacuously)', () => {
  for (const planted of ['ask Cris', 'CRISTIAN', '/Users/someone', '~/Documents/Projects/x', '~/.codex-seats/a', 'the Atlas lane', 'run jev', 'Jev picks', 'crisnc100'])
    assert.match(planted, PERSONAL, planted)
  for (const clean of ['askClassifier', 'operator', 'Documents', 'Projects'])
    assert.doesNotMatch(clean, PERSONAL, clean)
})
test('nothing personal ships: a case-insensitive sweep of packs/ (except packs/*/tests/) finds nothing', () => {
  const files = shipped()
  assert.ok(files.length > 20, `${files.length} shipped files`)
  assert.ok(!files.some((f) => relative(PACKS, f).split('/')[1] === 'tests'), 'tests never ship')
  const hits = files.flatMap((path) =>
    readFileSync(path, 'utf8').split('\n').flatMap((line, i) => (PERSONAL.test(line) ? [`${relative(PACKS, path)}:${i + 1}: ${line.trim().slice(0, 120)}`] : [])))
  assert.deepEqual(hits, [])
})

test('no shipped file names a model: no registry family name and no model id', () => {
  const { models } = JSON.parse(readFileSync(join(PACKAGE, 'models.default.json'), 'utf8'))
  const families = Object.keys(models), ids = Object.values(models)
  assert.ok(families.length > 3, 'the registry lists families')
  const familyWord = new RegExp(`\\b(${families.map((f) => f.replace(/[-]/g, '\\-')).join('|')})\\b(?![-./])`, 'i')
  for (const family of families.filter((f) => f !== 'grok')) assert.match(`review with ${family} today`, familyWord, `planted ${family}`)
  const hits = []
  for (const path of shipped()) {
    const rel = relative(PACKS, path)
    readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
      // `grok` is also a vendor and a CLI; only the bare family as a model choice would count, and ids are caught below.
      const scrubbed = line.replace(/\bgrok\b/gi, '')
      if (familyWord.test(scrubbed)) hits.push(`${rel}:${i + 1} names a family: ${line.trim().slice(0, 100)}`)
      for (const id of ids) if (line.includes(id)) hits.push(`${rel}:${i + 1} names ${id}`)
      if (/\b(?:claude|gpt|grok)-\d/.test(line)) hits.push(`${rel}:${i + 1} names a versioned id: ${line.trim().slice(0, 100)}`)
    })
  }
  assert.deepEqual(hits, [])
})

test('skills that run models name roles through model-id, and point at the shared review runtime', () => {
  const skill = (id, harness, name) => readFileSync(join(PACKS, id, 'skills', harness, name, 'SKILL.md'), 'utf8')
  for (const harness of HARNESSES) {
    for (const [id, name, role] of [['review-gate', 'code-review', 'reviewer'], ['build', 'build', 'advisor'], ['build', 'build', 'judge'], ['advisor', 'advisor', 'advisor'], ['second-opinion', 'second-opinion', 'reviewer']])
      assert.match(skill(id, harness, name), new RegExp(`model-id --role ${role}`), `${id}/${harness}: ${role}`)
    for (const [id, name] of [['review-gate', 'code-review'], ['build', 'build']]) {
      const body = skill(id, harness, name)
      assert.match(body, /\$HOME\/\.agent-config-studio\/review-gate\/review\.mjs/, `${id}/${harness}`)
      assert.match(body, /=scripts\/review\.mjs\n\[ -f "\$[A-Z_]+" \] \|\| [A-Z_]+="\$HOME\/\.agent-config-studio\/review-gate\/review\.mjs"/, `${id}/${harness}: repo copy first`)
      assert.doesNotMatch(body, /\.claude\/skills\/code-review\/review\.mjs/, `${id}/${harness}`)
    }
  }
})

test('the runtime script names no reviewer family and keeps the vendor rule to the id prefix', () => {
  const script = readFileSync(join(PACKS, 'review-gate/runtime/review.mjs'), 'utf8')
  assert.doesNotMatch(script, /\bconst VENDOR = \{/)
  assert.match(script, /if \(s\.startsWith\('claude-'\)\) return 'claude'\n  if \(s\.startsWith\('gpt-'\)\) return 'codex'\n  if \(s\.startsWith\('grok-'\)\) return 'grok'/)
  assert.match(script, /function operatorOnly\(reason\)/)
  assert.doesNotMatch(script, /crisOnly/)
})
