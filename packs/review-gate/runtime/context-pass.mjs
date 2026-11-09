#!/usr/bin/env node
/**
 * context-pass.mjs — the checks around the context pass (the /context-pass skill). It runs no model and writes nothing.
 *
 * USAGE
 *   node context-pass.mjs --check-brief <brief.json>
 *   node context-pass.mjs --check-commit <commit> [--brief <brief.json>]
 *
 * --check-brief: the brief the writer is given. PR mode needs purpose, mechanism, decisions, readers, base, docMap and
 * untouchable; standalone mode needs purpose, readers and paths. A missing, empty or unknown field is refused by name.
 *
 * --check-commit: the writer's commit, against its first parent. It fails on any changed path that is untouchable: a
 * test file, an agent-instruction file (SKILL.md, CLAUDE.md, AGENTS.md, GEMINI.md, .cursor/rules, a pack's
 * instructions/, .claude/, .codex/, .agents/), a path the brief lists as untouchable (program-input .md files, say), a
 * change inside a generated block (<!-- ns:name … --> … <!-- /ns:name -->), a removed doc line that a test file quotes,
 * and in any other file a changed line that is not comment or blank (review.mjs --comment-only, beside this script).
 *
 * Output: one JSON object. Exit 0 ok · 1 a problem or bad input.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REVIEW = join(dirname(fileURLToPath(import.meta.url)), 'review.mjs')
const FIELDS = {
  pr: ['mode', 'purpose', 'mechanism', 'decisions', 'readers', 'base', 'docMap', 'untouchable'],
  standalone: ['mode', 'purpose', 'readers', 'paths'],
}
const DOCS = /\.(md|mdx|rst|adoc)$|(^|\/)docs\/[^/]+\.txt$/i
const TESTS = /(^|\/)(tests?|__tests__|spec|fixtures)\/|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+$|_test\.[^/]+$/
const AGENT = /(^|\/)(SKILL|CLAUDE|AGENTS|GEMINI)\.md$|(^|\/)\.cursor\/rules\/|(^|\/)packs\/[^/]+\/instructions\/|(^|\/)\.(claude|codex|agents)\//
// A doc line short enough to recur by chance ("## Usage") is not treated as pinned.
const PINNED_MIN = 12

class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message) }
function git(...args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return r.status === 0 ? r.stdout : null
}
const empty = (v) => v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length) ||
  (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)
// A glob as the review gate reads riskPaths: ** spans folders, * stays in one, a pattern with no / matches any segment.
function globRe(glob) {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?')
  return new RegExp(glob.includes('/') ? `^${body}(/.*)?$` : `(^|/)${body}(/.*)?$`)
}

function readBrief(file) {
  if (!existsSync(file)) refuse(`${file}: no such file`)
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (e) { refuse(`${file} is not valid JSON (${e.message})`) }
}

export function checkBrief(doc) {
  const problems = []
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, problems: ['the brief must be a JSON object'] }
  const mode = doc.mode
  if (!FIELDS[mode]) return { ok: false, problems: [mode === undefined ? 'mode: missing (pr or standalone)' : 'mode: must be pr or standalone'] }
  for (const k of Object.keys(doc)) if (!FIELDS[mode].includes(k)) problems.push(`${k}: unknown field in a ${mode} brief`)
  for (const k of FIELDS[mode]) {
    if (!Object.hasOwn(doc, k)) { problems.push(`${k}: missing`); continue }
    if (empty(doc[k])) { problems.push(`${k}: empty`); continue }
  }
  const text = (k) => {
    const v = doc[k]
    if (empty(v)) return
    if (typeof v === 'string') return
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) problems.push(`${k}: must be text or a list of text`)
    else if (v.some((x) => !x.trim())) problems.push(`${k}: empty item`)
  }
  text('purpose')
  if (mode === 'pr') { text('mechanism'); text('decisions') }
  if (!empty(doc.readers) && typeof doc.readers !== 'string') {
    if (typeof doc.readers !== 'object' || Array.isArray(doc.readers) || Object.values(doc.readers).some((v) => typeof v !== 'string' || !v.trim()))
      problems.push('readers: must be text, or a map of each surface to who reads it')
  }
  for (const k of mode === 'pr' ? ['untouchable'] : ['paths']) {
    if (empty(doc[k])) continue
    if (!Array.isArray(doc[k]) || doc[k].some((x) => typeof x !== 'string' || !x.trim())) problems.push(`${k}: must be a list of paths`)
  }
  if (mode === 'pr' && !empty(doc.base)) {
    if (typeof doc.base !== 'string' || git('rev-parse', '--verify', '--quiet', '--end-of-options', `${doc.base}^{commit}`) === null)
      problems.push(`base: ${doc.base} does not name a commit here`)
  }
  if (mode === 'pr' && !empty(doc.docMap)) {
    if (!Array.isArray(doc.docMap)) problems.push('docMap: must be a list of { behavior, docs }')
    else doc.docMap.forEach((row, i) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return problems.push(`docMap[${i}]: must be { behavior, docs }`)
      if (!Object.hasOwn(row, 'behavior')) problems.push(`docMap[${i}].behavior: missing`)
      else if (typeof row.behavior !== 'string' || !row.behavior.trim()) problems.push(`docMap[${i}].behavior: empty`)
      if (!Object.hasOwn(row, 'docs')) problems.push(`docMap[${i}].docs: missing`)
      else if (!Array.isArray(row.docs) || row.docs.some((d) => typeof d !== 'string' || !d.trim())) problems.push(`docMap[${i}].docs: must be a list of paths (empty when none describes it yet)`)
    })
  }
  return { ok: problems.length === 0, mode, problems }
}

// Each generated block's text, by name: <!-- ns:name … --> up to <!-- /ns:name -->.
function blocks(text) {
  const out = new Map(), open = []
  for (const line of String(text ?? '').split('\n')) {
    const end = line.match(/^\s*<!--\s*\/([\w-]+:[\w-]+)\s*-->\s*$/)
    if (end && open.length && open.at(-1).name === end[1]) { const b = open.pop(); out.set(b.name, b.lines.join('\n')); continue }
    const start = line.match(/^\s*<!--\s*([\w-]+:[\w-]+)\b[^>]*-->\s*$/)
    if (start) { open.push({ name: start[1], lines: [] }); continue }
    for (const b of open) b.lines.push(line)
  }
  for (const b of open) out.set(b.name, b.lines.join('\n'))
  return out
}

export function checkCommit(commit, brief = null) {
  const sha = git('rev-parse', '--verify', '--quiet', '--end-of-options', `${commit}^{commit}`)?.trim()
  if (!sha) refuse(`${commit} does not name a commit`)
  const parent = git('rev-parse', '--verify', '--quiet', `${sha}^1`)?.trim()
  if (!parent) refuse(`${commit} has no parent to compare with`)
  const files = (git('diff', '--name-only', '--no-renames', '-z', parent, sha) || '').split('\0').filter(Boolean).sort()
  const listed = (brief?.untouchable || []).map((g) => [g, globRe(g)])
  const testFiles = (git('ls-tree', '-r', '-z', '--name-only', sha) || '').split('\0').filter((p) => TESTS.test(p))
  let testText = null
  const pinned = (line) => {
    testText ??= testFiles.map((p) => git('show', `${sha}:${p}`) || '').join('\n')
    return testText.includes(line)
  }
  const problems = [], code = []
  for (const p of files) {
    if (TESTS.test(p)) { problems.push(`${p}: a test file (untouchable)`); continue }
    if (AGENT.test(p)) { problems.push(`${p}: an agent-instruction file (untouchable; propose the change in the report)`); continue }
    const hit = listed.find(([, re]) => re.test(p))
    if (hit) { problems.push(`${p}: listed untouchable in the brief (${hit[0]})`); continue }
    if (!DOCS.test(p)) { code.push(p); continue }
    const before = git('show', `${parent}:${p}`), after = git('show', `${sha}:${p}`)
    const was = blocks(before), now = blocks(after)
    for (const name of new Set([...was.keys(), ...now.keys()]))
      if (was.get(name) !== now.get(name)) problems.push(`${p}: inside the generated block ${name} (untouchable)`)
    const kept = new Set(String(after ?? '').split('\n'))
    for (const line of String(before ?? '').split('\n')) {
      const t = line.trim()
      if (t.length >= PINNED_MIN && !kept.has(line) && pinned(t)) problems.push(`${p}: a line a test pins: "${t}" (untouchable)`)
    }
  }
  if (code.length) {
    const r = spawnSync(process.execPath, [REVIEW, '--comment-only', parent, sha, ...code], { encoding: 'utf8' })
    let out = null
    try { out = JSON.parse(r.stdout) } catch { refuse(`review.mjs --comment-only failed: ${(r.stderr || r.stdout).trim().split('\n').at(-1)}`) }
    for (const p of code) if (out.files[p] !== true) problems.push(`${p}: a code line changed (only comments may change in code)`)
  }
  return { ok: problems.length === 0, commit: sha, problems, files }
}

export function main(args = process.argv.slice(2)) {
  const option = (name) => {
    const i = args.indexOf(name)
    if (i < 0) return undefined
    if (!args[i + 1] || args[i + 1].startsWith('--')) refuse(`${name} needs a value`)
    return args[i + 1]
  }
  try {
    for (const a of args) if (a.startsWith('--') && !['--check-brief', '--check-commit', '--brief'].includes(a)) refuse(`unknown option ${a}`)
    let result
    if (args.includes('--check-brief')) result = checkBrief(readBrief(option('--check-brief')))
    else if (args.includes('--check-commit')) {
      const file = option('--brief')
      result = checkCommit(option('--check-commit'), file === undefined ? null : readBrief(file))
    } else refuse('usage: context-pass.mjs --check-brief <brief.json> | --check-commit <commit> [--brief <brief.json>]')
    console.log(JSON.stringify(result, null, 2))
    return result.ok ? 0 : 1
  } catch (e) {
    if (!(e instanceof Refusal)) throw e
    console.log(JSON.stringify({ ok: false, error: e.message }))
    return 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main()
