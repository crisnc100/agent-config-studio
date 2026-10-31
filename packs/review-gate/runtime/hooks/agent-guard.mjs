#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const sensitive = (text) => /no-veri|hookspath|GIT_CONFIG|reviewgate/i.test(text)
// The gate's own settings: an agent turning reviewgate.enabled off would open the gate from inside.
const gateKey = (key) => /^core\.hookspath$|^reviewgate\./i.test(key)
const configVariable = (name) => /^(?:GIT_CONFIG(?:_GLOBAL|_SYSTEM|_NOSYSTEM|_COUNT|_KEY_.*|_VALUE_.*|_PARAMETERS)?|HOME|XDG_CONFIG_HOME)$/.test(name)
const assignment = (word) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(word)

function ansiWord(text, start) {
  let value = ''
  const escapes = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === "'") return { value, end: i }
    if (c !== '\\') { value += c; continue }
    const escape = text[++i]
    if (Object.hasOwn(escapes, escape)) value += escapes[escape]
    else if (escape === 'c' && text[i + 1] !== undefined) {
      const control = text[++i].toUpperCase().charCodeAt(0)
      value += String.fromCharCode(control === 63 ? 127 : control & 31)
    } else {
      const pattern = /[0-7]/.test(escape || '') ? /^[0-7]{1,3}/ : escape === 'x' ? /^[0-9a-fA-F]{1,2}/ : escape === 'u' ? /^[0-9a-fA-F]{1,4}/ : escape === 'U' ? /^[0-9a-fA-F]{1,8}/ : null
      const offset = /[0-7]/.test(escape || '') ? i : i + 1
      const digits = pattern?.exec(text.slice(offset))?.[0]
      if (digits) { value += String.fromCodePoint(parseInt(digits, offset === i ? 8 : 16)); i = offset + digits.length - 1 }
      else value += '\\' + (escape || '')
    }
  }
  throw new Error('unterminated ANSI-C quote')
}

function heredocAt(text, start) {
  if (!text.startsWith('<<', start) || text.startsWith('<<<', start)) return null
  let i = start + 2, delimiter = '', q = null, started = false, quoted = false
  const stripTabs = text[i] === '-'
  if (stripTabs) i++
  while (/[ \t]/.test(text[i] || '')) i++
  for (; i < text.length; i++) {
    const c = text[i]
    if (!q && /[\s;&|<>(){}]/.test(c)) break
    started = true
    if (c === '\\' && q !== "'") { quoted = true; delimiter += text[++i] || ''; continue }
    if (q) { if (c === q) q = null; else delimiter += c; continue }
    if (c === "'" || c === '"') { quoted = true; q = c; continue }
    delimiter += c
  }
  if (!started || q) throw new Error('invalid heredoc delimiter')
  return { delimiter, stripTabs, quoted, end: i - 1 }
}

// Quoted arguments remain words; executable substitutions are scanned independently.
function tokenize(text, dataOnly = false) {
  const commands = [], pending = []
  const command = () => ({ words: [], substitutions: [], inputs: [], pipeToNext: false })
  let current = command(), substitutionId = 0
  const bodies = (start, queue) => {
    let cursor = start
    for (const here of queue.splice(0)) {
      const bodyStart = cursor
      let found = false
      while (cursor < text.length) {
        const newline = text.indexOf('\n', cursor), end = newline < 0 ? text.length : newline
        const line = text.slice(cursor, end), next = newline < 0 ? end : end + 1
        if ((here.stripTabs ? line.replace(/^\t+/, '') : line) === here.delimiter) {
          if (here.input) here.input.body = text.slice(bodyStart, cursor)
          cursor = next; found = true; break
        }
        cursor = next
      }
      if (!found) throw new Error('unterminated heredoc')
    }
    return cursor
  }
  let words = [], word = null, quote = null, quotedWord = false, redirectTarget = false
  const flush = () => {
    if (word !== null) {
      if (redirectTarget === '<<<') current.inputs.push({ kind: 'string', body: word })
      else if (!redirectTarget) words.push(word)
      redirectTarget = false
    }
    word = null; quotedWord = false
  }
  const split = (pipe = false) => {
    flush()
    if (redirectTarget) throw new Error('missing redirection target')
    if (words.length || current.inputs.length || current.substitutions.length) {
      current.words = words; current.pipeToNext = pipe; commands.push(current); current = command()
    } else if (pipe && commands.length) commands.at(-1).pipeToNext = true
    words = []
  }
  const parameter = (start) => {
    let depth = 1, q = null, value = '${'
    const substitutions = []
    for (let i = start; i < text.length; i++) {
      const c = text[i]
      if (c === '\\' && q !== "'") {
        if (text[i + 1] === undefined) throw new Error('trailing parameter escape')
        value += c + text[++i]; continue
      }
      if (q !== "'" && (c === '`' || c === '$' && text[i + 1] === '(')) {
        const sub = substitution(i + (c === '`' ? 1 : 2), c === '`')
        const marker = `$SUBSTITUTION_${substitutionId++}`
        substitutions.push({ content: sub.content, marker }); value += marker; i = sub.end; continue
      }
      if (!q && c === '$' && text[i + 1] === "'") {
        const ansi = ansiWord(text, i + 2)
        value += text.slice(i, ansi.end + 1); i = ansi.end; continue
      }
      if (q) { if (c === q) q = null; value += c; continue }
      if (c === "'" || c === '"') { q = c; value += c; continue }
      if (c === '{') depth++
      if (c === '}' && --depth === 0) return { value: value + c, substitutions, end: i }
      value += c
    }
    throw new Error('unterminated parameter expansion')
  }
  const substitution = (start, backtick) => {
    let depth = 1, q = null, content = ''
    const pending = []
    for (let i = start; i < text.length; i++) {
      const c = text[i]
      if (c === '\\' && q !== "'") { content += c + (text[++i] || ''); continue }
      if (backtick && c === '`' && q !== "'") return { content, end: i }
      if (q !== "'" && c === '$' && text[i + 1] === '{') {
        const expansion = parameter(i + 2)
        content += text.slice(i, expansion.end + 1); i = expansion.end; continue
      }
      if (q !== "'" && (c === '`' || c === '$' && text[i + 1] === '(')) {
        const nested = substitution(i + (c === '`' ? 1 : 2), c === '`')
        content += text.slice(i, nested.end + 1); i = nested.end; continue
      }
      if (!q && c === '$' && text[i + 1] === "'") {
        const ansi = ansiWord(text, i + 2)
        content += text.slice(i, ansi.end + 1); i = ansi.end; continue
      }
      if (!q && c === '#' && (i === start || /\s/.test(text[i - 1]))) {
        const newline = text.indexOf('\n', i), end = newline < 0 ? text.length : newline
        content += text.slice(i, end); i = end - 1; continue
      }
      if (!q && c === '\n' && pending.length) {
        const end = bodies(i + 1, pending)
        content += text.slice(i, end); i = end - 1; continue
      }
      if (!q && text.startsWith('<<<', i)) { content += '<<<'; i += 2; continue }
      const here = !q && heredocAt(text, i)
      if (here) { pending.push(here); content += text.slice(i, here.end + 1); i = here.end; continue }
      if (q) { if (c === q) q = null; content += c; continue }
      if (c === "'" || c === '"') { q = c; content += c; continue }
      if (!backtick) {
        if (c === '(') depth++
        if (c === ')' && --depth === 0) {
          if (pending.length) throw new Error('unterminated heredoc')
          return { content, end: i }
        }
      }
      content += c
    }
    throw new Error('unterminated command substitution')
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (dataOnly) {
      // Unquoted heredoc data expands substitutions, but its other quotes are literal.
      if (c === '\\' && ['\\', '$', '`', '\n'].includes(text[i + 1])) { i++; continue }
      if (c === '`' || c === '$' && text[i + 1] === '(') {
        const sub = substitution(i + (c === '`' ? 1 : 2), c === '`')
        current.substitutions.push({ content: sub.content, marker: `$SUBSTITUTION_${substitutionId++}` })
        i = sub.end
      }
      continue
    }
    if (!quote && c === '$' && text[i + 1] === "'") {
      const ansi = ansiWord(text, i + 2)
      word = (word ?? '') + ansi.value; quotedWord = true; i = ansi.end; continue
    }
    if (c === '\\' && quote !== "'") {
      const next = text[++i]
      if (next === undefined) throw new Error('trailing shell escape')
      if (next !== '\n') { word = (word ?? '') + next; quotedWord = true }
      continue
    }
    if (quote !== "'" && c === '$' && text[i + 1] === '{') {
      const expansion = parameter(i + 2)
      current.substitutions.push(...expansion.substitutions)
      word = (word ?? '') + expansion.value; i = expansion.end; continue
    }
    if (quote !== "'" && (c === '`' || c === '$' && text[i + 1] === '(')) {
      const sub = substitution(i + (c === '`' ? 1 : 2), c === '`')
      const marker = `$SUBSTITUTION_${substitutionId++}`
      current.substitutions.push({ content: sub.content, marker })
      word = (word ?? '') + marker; i = sub.end; continue
    }
    if (quote) { if (c === quote) quote = null; else word = (word ?? '') + c; continue }
    if (c === "'" || c === '"') { quote = c; quotedWord = true; word ??= ''; continue }
    if (c === '#' && word === null) { while (i < text.length && text[i] !== '\n') i++; i--; continue }
    if (c === '\n') {
      split()
      if (pending.length) i = bodies(i + 1, pending) - 1
      continue
    }
    const here = heredocAt(text, i)
    if (here) {
      if (!quotedWord && /^\d+$/.test(word || '')) word = null
      flush()
      if (redirectTarget) throw new Error('missing redirection target')
      const input = { kind: 'heredoc', body: '', quoted: here.quoted }
      current.inputs.push(input); pending.push({ ...here, input }); i = here.end; continue
    }
    const redirect = /^(?:<<<|&>>|&>|>>|>\||<&|>&|>|<(?!<))/.exec(text.slice(i))
    if (redirect) {
      if (!quotedWord && /^\d+$/.test(word || '')) word = null
      flush()
      if (redirectTarget) throw new Error('missing redirection target')
      redirectTarget = redirect[0]; i += redirect[0].length - 1; continue
    }
    if (c === '|') {
      const next = text[i + 1]
      split(next !== '|')
      if (next === '|' || next === '&') i++
      continue
    }
    if ('{}'.includes(c) && word === null && words.length === 0 && (i + 1 === text.length || /[\s;&|()]/.test(text[i + 1]))) { split(); continue }
    if (';&|\n()'.includes(c)) { split(); continue }
    if (/\s/.test(c)) { flush(); continue }
    word = (word ?? '') + c
  }
  if (quote) throw new Error('unterminated shell quote')
  if (pending.length) throw new Error('unterminated heredoc')
  split()
  return commands
}

const globalValues = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'])
const wrappers = new Set(['env', 'command', 'exec', 'nohup', 'time', 'sudo'])
const wrapperValues = new Set(['-u', '--unset', '-C', '--chdir', '-a', '-f', '--format', '-o', '--output', '-g', '--group', '--user', '-h', '--host', '-p', '--prompt', '-R', '--chroot', '-D', '--chdir', '-r', '--role', '-t', '--type', '-T', '--command-timeout'])
function invocation(words) {
  let i = 0
  const variables = new Set()
  const takeAssignments = () => { while (assignment(words[i] || '')) { variables.add(assignment(words[i])[1]); i++ } }
  takeAssignments()
  while (wrappers.has(basename(words[i] || ''))) {
    const wrapper = basename(words[i++])
    while (words[i]?.startsWith('-')) {
      const opt = words[i++]
      if (opt === '--') break
      if (wrapper === 'command' && ['-v', '-V'].includes(opt)) return { program: '', args: [], variables }
      if (wrapperValues.has(opt) && !(wrapper === 'time' && opt === '-p')) i++
    }
    takeAssignments()
  }
  return { program: basename(words[i] || ''), args: words.slice(i + 1), variables, assignmentOnly: i === words.length }
}
function configWrite(args) {
  const values = []
  for (let i = 0; i < args.length; i++) {
    if (['--file', '-f', '--type', '-t', '--default', '--blob'].includes(args[i])) { i++; continue }
    if (!args[i].startsWith('-')) values.push(args[i])
  }
  const sectionFlag = args.includes('--remove-section') ? 'remove-section' : args.includes('--rename-section') ? 'rename-section' : null
  const sectionCommand = sectionFlag || (['remove-section', 'rename-section'].includes(values[0]) ? values[0] : null)
  if (sectionCommand) {
    const sections = sectionFlag ? values : values.slice(1)
    return sections.slice(0, sectionCommand === 'remove-section' ? 1 : 2).some((section) => /^(?:core|reviewgate)$/i.test(section))
  }
  if (args.some((a) => ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', 'get', 'list'].includes(a))) return false
  const writes = args.some((a) => ['--add', '--replace-all', '--unset', '--unset-all', 'set', 'unset'].includes(a))
  const key = values.findIndex((v) => gateKey(v) || /^alias\./i.test(v))
  if (key < 0 || !writes && values.length <= key + 1) return false
  return gateKey(values[key]) || values.slice(key + 1).some((value) => /--no-veri|hookspath|reviewgate/i.test(value))
}
function gitReason(program, words, variables) {
  let command, args, hooksOverride = false
  if (['git-push', 'git-commit', 'git-send-pack'].includes(program)) { command = program.slice(4); args = words }
  else if (program === 'git') {
    let i = 0
    while (words[i]?.startsWith('-')) {
      const opt = words[i++]
      let value
      if (globalValues.has(opt)) value = words[i++]
      else if (/^-c.+/.test(opt)) value = opt.slice(2)
      else if (opt.startsWith('--config-env=')) value = opt.slice('--config-env='.length)
      if ((opt === '-c' || opt.startsWith('-c') || opt.startsWith('--config-env')) && gateKey(String(value || '').split('=')[0])) hooksOverride = true
    }
    command = words[i]; args = words.slice(i + 1)
  } else return null
  if (command === 'config') return configWrite(args) ? 'agents may not write review-gate bypass configuration' : null
  if (command === 'send-pack') return 'agents may not run git send-pack; use git push through the review gate instead'
  if (!['push', 'commit'].includes(command)) return null
  if (hooksOverride || [...variables].some(configVariable)) return 'agents may not override Git hook configuration on push or commit'
  const longValues = command === 'commit'
    ? new Set(['--message', '--file', '--reuse-message', '--reedit-message', '--template', '--author', '--date', '--fixup', '--squash', '--trailer', '--pathspec-from-file', '--cleanup'])
    : new Set(['--repo', '--receive-pack', '--exec', '--push-option'])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') break
    if (/^--no-veri(?:f(?:y)?)?$/.test(arg)) return `agents may not run git ${command} --no-verify; get the change through review instead`
    if (longValues.has(arg)) { i++; continue }
    if (command === 'push') { if (arg === '-o') i++; continue }
    if (/^-[^-]/.test(arg)) for (let j = 1; j < arg.length; j++) {
      const ch = arg[j]
      if (ch === 'n') return 'agents may not run git commit -n; get the change through review instead'
      if ('mFcCt'.includes(ch)) { if (j === arg.length - 1) i++; break }
      if ('uS'.includes(ch)) break
    }
  }
  return null
}
function inspectWords(words, inherited, depth) {
  const preceding = new Set(inherited)
  for (let i = 0; i < words.length; i++) {
    const assigned = assignment(words[i])
    if (assigned) preceding.add(assigned[1])
    if (['git', 'git-push', 'git-commit', 'git-send-pack'].includes(basename(words[i]))) {
      const reason = gitReason(basename(words[i]), words.slice(i + 1), preceding)
      if (reason) return reason
    }
  }
  const call = invocation(words)
  if (words[0] === 'export') {
    for (const word of words.slice(1)) if (assignment(word)) inherited.add(assignment(word)[1])
    return null
  }
  if (call.assignmentOnly) { for (const name of call.variables) inherited.add(name); return null }
  const variables = new Set([...inherited, ...call.variables])
  if (/^(?:sh|bash|zsh|dash|ksh)$/.test(call.program)) {
    const at = call.args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
    if (at >= 0 && call.args[at + 1] !== undefined) return inspectShell(call.args[at + 1], variables, depth + 1)
  }
  if (call.program === 'eval') return inspectShell(call.args.join(' '), variables, depth + 1)
  return gitReason(call.program, call.args, variables)
}
const shell = (program) => /^(?:sh|bash|zsh|dash|ksh)$/.test(program)
const scriptAt = (args) => args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg))
// Like Git matching, literal interpreter words are considered even behind unfamiliar wrappers.
function interpreterCalls(words) {
  return words.flatMap((word, i) => {
    const program = basename(word)
    return shell(program) || ['eval', 'source', '.'].includes(program)
      ? [{ program, args: words.slice(i + 1) }] : []
  })
}
function stdinInterpreter(words) {
  return interpreterCalls(words).some(({ program, args }) => !shell(program) || scriptAt(args) < 0 || args.some((arg) => /^-[a-zA-Z]*s[a-zA-Z]*$/.test(arg)))
}
function substitutionAsCode(words, marker) {
  return interpreterCalls(words).some(({ program, args }) => program === 'eval'
    ? args.some((arg) => arg.includes(marker))
    : shell(program) && scriptAt(args) >= 0 && args[scriptAt(args) + 1]?.includes(marker))
}
function inspectShell(text, inherited = new Set(), depth = 0, outputAsCode = false, dataOnly = false) {
  if (depth > 32) throw new Error('shell nesting limit')
  const commands = tokenize(text, dataOnly)
  for (let i = 0; i < commands.length; i++) {
    const { words, inputs, substitutions } = commands[i]
    const reason = inspectWords(words, inherited, depth)
    if (reason) return reason
    let downstream = false
    for (let j = i; commands[j]?.pipeToNext && commands[j + 1]; j++)
      if (stdinInterpreter(commands[j + 1].words)) downstream = true
    const stdinCode = stdinInterpreter(words) || downstream
    const variables = new Set([...inherited, ...words.flatMap((word) => assignment(word)?.[1] || [])])
    for (const input of inputs) {
      input.executable = outputAsCode || stdinCode
      if (!input.executable && (input.kind !== 'heredoc' || input.quoted)) continue
      const reason = inspectShell(input.body, new Set(variables), depth + 1, outputAsCode, !input.executable)
      if (reason) return reason
    }
    for (const sub of substitutions) {
      const code = outputAsCode || substitutionAsCode(words, sub.marker) || inputs.some((input) => input.executable && input.body.includes(sub.marker))
      const reason = inspectShell(sub.content, new Set(variables), depth + 1, code)
      if (reason) return reason
    }
  }
  return null
}
let raw = ''
try {
  raw = readFileSync(0, 'utf8')
  const payload = JSON.parse(raw), tool = payload.tool_name ?? payload.toolName
  if (tool && !['Bash', 'Monitor', 'run_terminal_command'].includes(tool)) process.exit(0)
  const command = payload.tool_input?.command ?? payload.toolInput?.command
  let reason
  if (typeof command === 'string') reason = inspectShell(command)
  else if (Array.isArray(command) && command.every((word) => typeof word === 'string')) reason = inspectWords(command, new Set(), 0)
  if (reason) { console.error(`review gate: ${reason}`); process.exitCode = 2 }
} catch (error) {
  const blocked = sensitive(raw)
  console.error(`review gate: ${blocked ? '' : 'warning: '}guard error: ${String(error.message).replace(/[\r\n]/g, ' ')}`)
  process.exitCode = blocked ? 2 : 0
}
