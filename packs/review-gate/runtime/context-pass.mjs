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
 * and in any other file a changed line that is not comment or blank. Both modes refuse outright, naming the command,
 * when a git command they rely on fails; only rev-parse's "no such commit" (exit 1) is read as an answer.
 *
 * The code-line check is an accident barrier for the writer, never a proof: the review gate never trusts it, and the
 * --focus docs fix check that follows reviews the commit as code. So it fails closed. An unknown language, a regex
 * literal that could hide a comment or quote, a string (other than a JS or TS template literal) that runs past a line
 * end, a heredoc, a YAML block scalar, a line continuation, a mode change, a new or deleted file, a line put above a
 * hashbang, a bare CR (or, in JS and TS, U+2028 or U+2029), a change git shows with no changed lines (a binary diff),
 * and any changed line with a block-comment delimiter all count as code. In JS and TS a template literal may run across
 * lines and its ${…} substitutions are read as code; every line of template text counts as code, even a blank one. A
 * '/' opens a regex literal only where it cannot divide (after ( , = : [ & | ; { or =>, a unary !, or return, typeof
 * and the other reserved words an expression follows), and only when it closes on its line. A '/' divides when no regex
 * could close on its line, or when a name that is not a keyword, a number, ] or a string comes before it on the same
 * line. Any other '/' followed on its line by a comment marker or quote, or by a brace inside a substitution, makes the
 * whole file count as code, as does a '\' or an HTML-like comment (<!-- or -->) outside strings and comments. .jsx and
 * .tsx files are code only: JSX text can read as a comment. Files are known by extension, and .env-style files (.env,
 * .env.example) by name. builds/<slug>/docs-table.json, the skill's own output, passes. Changed lines come from git
 * diff, so a file's length never decides the answer.
 *
 * Output: one JSON object. Exit 0 ok · 1 a problem or bad input.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FIELDS = {
  pr: ['mode', 'purpose', 'mechanism', 'decisions', 'readers', 'base', 'docMap', 'untouchable'],
  standalone: ['mode', 'purpose', 'readers', 'paths'],
}
// Not .mdx: its JSX and imports run when the page builds, so it is checked as code (and any change to it fails).
const DOCS = /\.(md|rst|adoc)$|(^|\/)docs\/[^/]+\.txt$/i
const TESTS = /(^|\/)(tests?|__tests__|spec|fixtures)\/|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+$|_test\.[^/]+$/
// The docs table the context-pass skill writes beside its brief: the skill's own output, never program input.
const DOCS_TABLE = /^builds\/[^/]+\/docs-table\.json$/
const AGENT = /(^|\/)(SKILL|CLAUDE|AGENTS|GEMINI)(\.[\w-]+)?\.md$|(^|\/)\.github\/copilot-instructions\.md$|(^|\/)\.github\/instructions\/|(^|\/)\.(cursor|windsurf)\/rules\/|(^|\/)packs\/[^/]+\/instructions\/|(^|\/)\.(claude|codex|agents|gemini)\//i
// A doc line short enough to recur by chance ("## Usage") is not treated as pinned.
const PINNED_MIN = 12

class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message) }
// Any git failure (an exit code the caller does not take as an answer, a signal, git missing, output past the buffer)
// refuses the whole check by naming the command: an empty result never stands in for one git could not give.
function gitRun(args, answers) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.status === 0 && !r.error) return r.stdout
  if (!r.error && answers.includes(r.status)) return null
  const why = r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : `exit ${r.status}${r.stderr.trim() ? `: ${r.stderr.trim().split('\n')[0]}` : ''}`
  refuse(`git ${args.join(' ')} failed (${why})`)
}
const git = (...args) => gitRun(args, [])
// The full sha of the commit spec names, or null when it names none: rev-parse --verify --quiet exits 1 for that alone.
const commitOf = (spec) => gitRun(['rev-parse', '--verify', '--quiet', '--end-of-options', `${spec}^{commit}`], [1])?.trim() || null
// A path's text at a commit, or null when the commit has no such path. ls-tree tells that apart from a failure (exit 0
// with no entry); git show cannot (exit 128 for both).
const textAt = (commit, path) => (git('ls-tree', commit, '--', path) ? git('show', `${commit}:${path}`) : null)
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
    if (typeof doc.base !== 'string' || commitOf(doc.base) === null)
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
  const sha = commitOf(commit)
  if (!sha) refuse(`${commit} does not name a commit`)
  const parent = commitOf(`${sha}^1`)
  if (!parent) refuse(`${commit} has no parent to compare with`)
  const files = git('diff', '--name-only', '--no-renames', '-z', parent, sha).split('\0').filter(Boolean).sort()
  const listed = (brief?.untouchable || []).map((g) => [g, globRe(g)])
  // Blobs only: a submodule under tests/ has no text to read.
  const testFiles = git('ls-tree', '-r', '-z', sha).split('\0').filter(Boolean).flatMap((entry) => {
    const tab = entry.indexOf('\t'), path = entry.slice(tab + 1)
    return entry.slice(0, tab).split(' ')[1] === 'blob' && TESTS.test(path) ? [path] : []
  })
  let testText = null
  const pinned = (line) => {
    testText ??= testFiles.map((p) => git('show', `${sha}:${p}`)).join('\n')
    return testText.includes(line)
  }
  const problems = [], code = []
  for (const p of files) {
    if (TESTS.test(p)) { problems.push(`${p}: a test file (untouchable)`); continue }
    if (AGENT.test(p)) { problems.push(`${p}: an agent-instruction file (untouchable; propose the change in the report)`); continue }
    const hit = listed.find(([, re]) => re.test(p))
    if (hit) { problems.push(`${p}: listed untouchable in the brief (${hit[0]})`); continue }
    if (DOCS_TABLE.test(p)) continue
    if (!DOCS.test(p)) { code.push(p); continue }
    const before = textAt(parent, p), after = textAt(sha, p)
    const was = blocks(before), now = blocks(after)
    for (const name of new Set([...was.keys(), ...now.keys()]))
      if (was.get(name) !== now.get(name)) problems.push(`${p}: inside the generated block ${name} (untouchable)`)
    const kept = new Set(String(after ?? '').split('\n'))
    for (const line of String(before ?? '').split('\n')) {
      const t = line.trim()
      if (t.length >= PINNED_MIN && !kept.has(line) && pinned(t)) problems.push(`${p}: a line a test pins: "${t}" (untouchable)`)
    }
  }
  for (const p of code) if (!commentOnly(parent, sha, p)) problems.push(`${p}: a code line changed (only comments may change in code)`)
  return { ok: problems.length === 0, commit: sha, problems, files }
}

/* ── the code-line check ─────────────────────────────────────────────── */

// Not .jsx or .tsx: a line of JSX text can read as a comment, so any change to one fails.
const STYLES = [
  { exts: ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'], line: '//', block: ['/*', '*/'], quotes: ['"', "'", '`'], regex: true, regexLiterals: true },
  { exts: ['c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'java', 'kt', 'kts', 'swift', 'go', 'rs', 'scala', 'dart', 'php', 'css', 'scss', 'less'],
    line: '//', block: ['/*', '*/'], quotes: ['"', "'", '`'], regex: true },
  { exts: ['sh', 'bash', 'zsh', 'fish'], line: '#', block: null, quotes: ['"', "'"], heredoc: true },
  { exts: ['yaml', 'yml'], line: '#', block: null, quotes: ['"', "'"], blockScalar: true },
  { exts: ['py', 'rb', 'pl', 'toml', 'r', 'ex', 'exs', 'tf'], line: '#', block: null, quotes: ['"', "'"] },
  { exts: ['sql', 'lua', 'hs'], line: '--', block: null, quotes: ['"', "'"] },
]
// Known by name, not extension: .env, .env.example, .env.sample and the like (KEY=value lines, # comments).
const ENV_STYLE = { line: '#', block: null, quotes: ['"', "'"] }
const ENV_NAME = /(^|\/)\.env(\.[\w-]+)*$/
// In JS and TS, a '/' after one of these (or after =>) can only open a regex literal, never divide. Not after } ! or ?:
// an object literal, a non-null assertion or an optional chain can end an operand.
const REGEX_AFTER = /[(,=:[&|{;]/
// Reserved words an expression follows, so a '/' after one opens a regex (return /x/). Not await, yield or of: a script
// may use them as names.
const EXPR_WORDS = new Set(['return', 'typeof', 'void', 'delete', 'throw', 'case', 'do', 'else', 'in', 'instanceof', 'new', 'extends'])
// Every word that is a keyword somewhere in JS or TS: after one, a '/' is never taken for a sure division.
const KEYWORDS = new Set([...EXPR_WORDS, 'await', 'yield', 'of', 'let', 'async', 'get', 'set', 'static', 'as', 'satisfies', 'break',
  'continue', 'if', 'while', 'for', 'with', 'switch', 'catch', 'try', 'finally', 'var', 'const', 'class', 'function', 'import', 'export',
  'default', 'debugger', 'enum', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'from', 'type', 'keyof', 'infer',
  'is', 'declare', 'abstract', 'readonly', 'asserts', 'unique', 'out', 'accessor', 'using', 'module', 'namespace', 'global', 'override'])
// What may stand before an EXPR_WORDS word for it to be that keyword: not part of a longer name (éreturn), a member
// (a.return) or a private name (#return).
const WORD_START = /^$|[(){}[\];,:=&|!?+\-*%<>~^]/
// What a '/' that might open a regex could hide from the rest of its line; inside a substitution a brace too, since a
// hidden } would end it early.
const HIDES = /\/\*|\*\/|\/\/|["'`]/, HIDES_IN_SUB = /\/\*|\*\/|\/\/|["'`{}]/
const DIRECTIVE = /^\s*(?:#!|\/\/\/|\/\/!|\/\/\s*go:|\/\/\s*\+build|\/\/\s*Output:)|@ts-|eslint|prettier-ignore|istanbul |\bc8 |biome-ignore|deno-lint|jshint|@flow\b|@jsx|@vite-ignore|webpack[A-Z]|#__PURE__|\bnoqa\b|#\s*type:|pylint:|mypy:|pyright:|rubocop:|nolint|fmt:\s*(?:off|on)|isort:|-\*-.*-\*-|swiftlint:|NOSONAR|pragma/
const styleOf = (path) => {
  if (ENV_NAME.test(path)) return ENV_STYLE
  const ext = path.includes('.') ? path.split('.').pop().toLowerCase() : ''
  return STYLES.find((st) => st.exts.includes(ext)) || null
}
// Per line, whether every non-blank character on it is comment; null when the text has anything this scanner cannot
// read for sure.
function commentMap(text, style) {
  // Lines here end at LF, as git diff's do. A bare CR also ends a line in JS, Python and YAML, and U+2028 and U+2029 do
  // in JS, so a file holding one cannot be read line by line.
  if (/\r(?!\n)/.test(text) || (style.regexLiterals && /[\u2028\u2029]/.test(text))) return null
  const out = []
  const js = !!style.regexLiterals
  // prev: the last code character, carried across lines, so a regex literal that starts a line after || is still known.
  // word: the name or keyword that ends at prev ('' after anything else); beforeWord: the code character before it.
  let state = 'code', quote = null, code = false, prev = '', word = '', beforeWord = ''
  // The brace depth each open ${ started at, innermost last: the } that brings depth back to it resumes template text.
  const subs = []
  let depth = 0
  const lines = text.split('\n')
  for (const line of lines) {
    if (style.blockScalar && /(^|[:\s-])[|>][+-]?\d*\s*(#.*)?$/.test(line) && state === 'code') return null
    // A line that starts inside template text is part of the string, even when blank.
    if (state === 'string') code = true
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (state === 'block') {
        if (line.startsWith(style.block[1], i)) { state = 'code'; i += style.block[1].length - 1 }
        continue
      }
      if (state === 'string') {
        code = true
        if (c === '\\') i++
        else if (c === quote) { state = 'code'; prev = quote; word = '' }
        else if (js && quote === '`' && c === '$' && line[i + 1] === '{') { subs.push(depth++); state = 'code'; prev = '{'; word = ''; i++ }
        continue
      }
      if (/\s/.test(c)) continue
      if (style.block && line.startsWith(style.block[0], i)) { state = 'block'; i += style.block[0].length - 1; continue }
      if (line.startsWith(style.line, i) && (style.line !== '#' || i === 0 || /\s/.test(line[i - 1]))) break
      if (style.heredoc && line.startsWith('<<', i)) return null
      // A name spelled with an escape (\u0072eturn) and a script's HTML-like comments change how the rest reads.
      if (js && (c === '\\' || line.startsWith('<!--', i) || line.startsWith('-->', i))) return null
      const exprStart = js && (REGEX_AFTER.test(prev) || (EXPR_WORDS.has(word) && WORD_START.test(beforeWord)))
      if (c === '/' && exprStart) {
        const end = regexEnd(line, i)
        if (end < 0) return null
        i = end; code = true; prev = 'a'; word = ''
        continue
      }
      if (style.regex && c === '/') {
        // Sure to divide: no regex could close on this line, or an operand came before it on this same line, where no
        // semicolon can be inserted. prev 'a' with no word is the end of a regex literal.
        const operand = word ? !KEYWORDS.has(word) : /^[a\]"'`]$/.test(prev)
        const divides = js && ((code && operand) || regexEnd(line, i) < 0)
        if (!divides && (subs.length ? HIDES_IN_SUB : HIDES).test(line.slice(i + 1))) return null
      }
      code = true
      if (style.quotes.includes(c)) { state = 'string'; quote = c; prev = c; word = ''; continue }
      if (js && /[\w$]/.test(c)) {
        let j = i
        while (j + 1 < line.length && /[\w$]/.test(line[j + 1])) j++
        beforeWord = prev; word = line.slice(i, j + 1); prev = line[j]; i = j
        continue
      }
      word = ''
      if (js && c === '{') depth++
      if (js && c === '}' && --depth === subs.at(-1)) { subs.pop(); state = 'string'; quote = '`'; continue }
      if (c === '!' && exprStart) { prev = '('; continue }
      prev = c === '>' && prev === '=' ? '(' : c
    }
    if (state === 'string' && !(js && quote === '`')) return null
    if (state === 'code' && /\\\s*$/.test(line)) return null
    out.push(!code)
    code = false
  }
  return out
}
// Where the regex literal opened at i closes (after its flags), or -1 when it does not close on this line.
function regexEnd(line, i) {
  for (let j = i + 1, inClass = false; j < line.length; j++) {
    const c = line[j]
    if (c === '\\') { j++; continue }
    if (inClass) { if (c === ']') inClass = false; continue }
    if (c === '[') inClass = true
    else if (c === '/') {
      while (/[a-z]/i.test(line[j + 1] || '')) j++
      return j
    }
  }
  return -1
}
// The line numbers git diff -U0 says changed: { old: [n…], now: [n…] }.
function changedLines(parent, sha, path) {
  const diff = git('diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', parent, sha, '--', path)
  const old = [], now = []
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const [a, b, c, d] = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]
    for (let k = 0; k < b; k++) old.push(a + k)
    for (let k = 0; k < d; k++) now.push(c + k)
  }
  return { old, now }
}
const HASHBANG = /^\uFEFF?#!/
const modeOf = (commit, path) => git('ls-tree', commit, '--', path).split(' ')[0] || null
function commentOnly(parent, sha, path) {
  const style = styleOf(path)
  if (!style) return false
  const before = textAt(parent, path), after = textAt(sha, path)
  if (before === null || after === null || modeOf(parent, path) !== modeOf(sha, path)) return false
  // A hashbang works only on the first line, so a line put above one changes how the file runs.
  const first = (t) => t.split('\n', 1)[0]
  if ((HASHBANG.test(before) || HASHBANG.test(after)) && first(before) !== first(after)) return false
  const was = commentMap(before, style), now = commentMap(after, style), changed = changedLines(parent, sha, path)
  // A changed file whose diff names no line (git shows it as binary, say) is one whose change was never read.
  if (!was || !now || (!changed.old.length && !changed.now.length)) return false
  const ok = (map, lines, n) => map[n - 1] === true && !DIRECTIVE.test(lines[n - 1]) && !(style.block && /\/\*|\*\//.test(lines[n - 1]))
  const a = before.split('\n'), b = after.split('\n')
  return changed.old.every((n) => ok(was, a, n)) && changed.now.every((n) => ok(now, b, n))
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
