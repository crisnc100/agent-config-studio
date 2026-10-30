#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BEGIN = '# review-gate agent guard begin', END = '# end'
const launcher = join(dirname(fileURLToPath(import.meta.url)), 'agent-guard')
const command = /^[a-zA-Z0-9_./-]+$/.test(launcher) ? launcher : `'${launcher.replaceAll("'", "'\\''")}'`
const own = (handler) => handler?.type === 'command' && handler.command === command
const snapshot = (path) => existsSync(path) ? { bytes: readFileSync(path).toString('base64'), mode: statSync(path).mode & 0o777 } : null
const textOf = (info) => info ? Buffer.from(info.bytes, 'base64').toString() : ''
function realFile(path) {
  path = resolve(path)
  try { return realpathSync(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  // Resolve missing targets through their existing parents, including dangling file links.
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return realFile(resolve(dirname(path), readlinkSync(path)))
  return join(realFile(dirname(path)), basename(path))
}
function atomic(path, text, mode = 0o600) {
  const target = realFile(path)
  mkdirSync(dirname(target), { recursive: true })
  const temporary = `${target}.review-gate-${process.pid}.tmp`
  try { writeFileSync(temporary, text, { mode }); chmodSync(temporary, mode); renameSync(temporary, target) }
  finally { rmSync(temporary, { force: true }) }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
function jsonFile(info) {
  const value = info.before ? JSON.parse(textOf(info.before)) : {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected a JSON object: ${info.path}`)
  if (value.hooks !== undefined && (!value.hooks || typeof value.hooks !== 'object' || Array.isArray(value.hooks))) throw new Error(`Invalid hooks object: ${info.path}`)
  if (value.hooks?.PreToolUse !== undefined && !Array.isArray(value.hooks.PreToolUse)) throw new Error(`Invalid PreToolUse groups: ${info.path}`)
  for (const group of value.hooks?.PreToolUse || [])
    if (!group || !Array.isArray(group.hooks)) throw new Error(`Invalid hook group: ${info.path}`)
  return value
}
function addHooks(value, matchers, codex = false) {
  let changed = false
  for (const matcher of matchers) {
    if (value.hooks?.PreToolUse?.some((g) => g.matcher === matcher && g.hooks.some(own))) continue
    value.hooks ??= {}; value.hooks.PreToolUse ??= []
    value.hooks.PreToolUse.push({ matcher, hooks: [{ type: 'command', command, ...(codex && { timeout: 30 }) }] })
    changed = true
  }
  return changed
}
function removeHooks(value, matchers = null) {
  if (!value.hooks?.PreToolUse) return value
  value.hooks.PreToolUse = value.hooks.PreToolUse.flatMap((g) => {
    if (matchers && !matchers.includes(g.matcher)) return [g]
    const kept = g.hooks.filter((h) => !own(h))
    return kept.length === g.hooks.length ? [g] : kept.length ? [{ ...g, hooks: kept }] : []
  })
  if (!value.hooks.PreToolUse.length) delete value.hooks.PreToolUse
  if (!Object.keys(value.hooks).length) delete value.hooks
  return value
}
function withoutTrust(text) {
  if (text.includes(BEGIN) && !new RegExp(`${BEGIN}[\\s\\S]*?^${END}\\s*$`, 'm').test(text)) throw new Error('Unterminated agent guard trust block')
  return text.replace(new RegExp(`^${BEGIN}\\r?\\n[\\s\\S]*?^${END}[^\\S\\r\\n]*(?:\\r?\\n|$)`, 'gm'), '')
}
function trustBlock(text) {
  return new RegExp(`^${BEGIN}\\r?\\n([\\s\\S]*?)^${END}[^\\S\\r\\n]*(?:\\r?\\n|$)`, 'm').exec(text)?.[1] || ''
}
function trustSections(text) {
  const headers = [...text.matchAll(/^[ \t]*\[[^\n]*\][^\n]*(?:\n|$)/gm)]
  return headers.flatMap((header, i) => {
    const key = /^[ \t]*\[hooks\.state\.("(?:\\.|[^"\\])*")\][ \t]*(?:#.*)?\r?\n?$/.exec(header[0])
    return key ? [{ key: JSON.parse(key[1]), start: header.index,
      end: headers[i + 1]?.index ?? text.length, text: text.slice(header.index, headers[i + 1]?.index ?? text.length) }] : []
  })
}
function withTrust(text, handlers) {
  let base = withoutTrust(text)
  const prior = [...trustSections(trustBlock(text)), ...trustSections(base)]
  const sections = new Map(trustSections(trustBlock(text)).map((s) => [s.key, s.text]))
  // Codex trust keys contain positional hook indices and may outlive an older handler.
  // Move matching pre-existing sections into our block instead of duplicating TOML keys.
  for (const section of trustSections(base).filter((s) => handlers.some((h) => h.key === s.key)).reverse())
    base = base.slice(0, section.start) + base.slice(section.end)
  for (const h of handlers) {
    const old = prior.find((s) => s.key === h.key)?.text || ''
    const extras = old.split('\n').slice(1).filter((line) => !/^\s*trusted_hash\s*=/.test(line)).join('\n').trimEnd()
    sections.set(h.key, `[hooks.state.${JSON.stringify(h.key)}]\ntrusted_hash = ${JSON.stringify(h.currentHash)}${extras ? '\n' + extras : ''}`)
  }
  return renderTrust(base, sections)
}
function renderTrust(base, sections) {
  if (!sections.size) return base
  return base + (base && !base.endsWith('\n') ? '\n' : '') + `${BEGIN}\n${[...sections.values()].map((s) => s.trimEnd()).join('\n')}\n${END}\n`
}
function removeTrust(text, original, keys) {
  const sections = new Map(trustSections(trustBlock(text)).filter((s) => !keys.has(s.key)).map((s) => [s.key, s.text]))
  let clean = withoutTrust(text)
  for (const section of trustSections(withoutTrust(original)))
    if (keys.has(section.key) && !sections.has(section.key) && !trustSections(clean).some((s) => s.key === section.key))
      clean += (clean && !clean.endsWith('\n') ? '\n' : '') + section.text
  return renderTrust(clean, sections)
}
// Extra Codex homes from the review-gate config (the first config file that exists), e.g. one per
// account: { "codexHomes": ["~/work-codex"] }.
function configuredCodexHomes(home) {
  for (const path of [join(home, '.agent-config-studio/review-gate/config.json'), join(home, '.claude/review-config.json')]) {
    if (!existsSync(path)) continue
    let value
    try { value = JSON.parse(readFileSync(path, 'utf8')) } catch (e) { throw new Error(`Malformed review config at ${path}: ${e.message}`) }
    const list = value?.codexHomes ?? []
    if (!Array.isArray(list) || list.some((p) => typeof p !== 'string' || !p.trim())) throw new Error(`codexHomes in ${path} must be a list of folder paths`)
    return list.map((p) => resolve(home, p.replace(/^~(?=\/|$)/, home)))
  }
  return []
}
async function listHooks(home) {
  return new Promise((done) => {
    const child = spawn('codex', ['app-server'], { env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = '', settled = false
    const finish = (result, error) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      child.stdin.destroy(); child.kill('SIGKILL')
      if (error) console.error(`Warning: Codex ${home} is untrusted: ${error}`)
      done(result)
    }
    const timer = setTimeout(() => finish(null, 'hooks/list timed out after 20 seconds'), 20_000)
    const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
    child.stdin.on('error', (e) => finish(null, e.message))
    child.on('error', (e) => finish(null, e.message))
    child.on('exit', () => finish(null, 'app-server exited before hooks/list'))
    child.stderr.resume()
    child.stdout.on('data', (data) => {
      buffer += data
      try {
        while (buffer.includes('\n')) {
          const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
          if (!line.trim()) continue
          const message = JSON.parse(line)
          if (message.id === 1) {
            if (message.error) return finish(null, 'initialize failed')
            send({ method: 'initialized' }); send({ id: 2, method: 'hooks/list', params: {} })
          } else if (message.id === 2) {
            if (message.error || !Array.isArray(message.result?.data)) return finish(null, 'invalid hooks/list response')
            const handlers = message.result.data.flatMap((g) => g.hooks || []).filter((h) => h.command === command)
            if (!handlers.length || handlers.some((h) => typeof h.key !== 'string' || !h.key || typeof h.currentHash !== 'string' || !h.currentHash)) return finish(null, 'guard handler missing from hooks/list')
            finish(handlers)
          }
        }
      } catch (e) { finish(null, e.message) }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'review-gate-agent-guard', version: '1' } } })
  })
}

try {
  const [action, ...args] = process.argv.slice(2)
  if (!['install', 'uninstall', 'status'].includes(action)) throw new Error('Usage: install-agent-guard.mjs install|uninstall|status [--claude-settings file] [--codex-home dir]... [--grok-config file]')
  const home = homedir(), homes = []
  let settings = null, grok = join(home, '.grok/config.toml')
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1]
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a path`)
    if (flag === '--claude-settings') settings = resolve(value)
    else if (flag === '--codex-home') homes.push(resolve(value))
    else if (flag === '--grok-config') grok = resolve(value)
    else throw new Error(`Unknown option: ${flag}`)
  }
  // Defaults count only when that harness is present (its folder exists); anything named
  // explicitly ($CODEX_HOME, codexHomes in the review-gate config, a flag) is used as given.
  // Absent harnesses are skipped silently.
  if (!settings && existsSync(join(home, '.claude'))) settings = join(home, '.claude/settings.json')
  if (!homes.length) {
    if (existsSync(join(home, '.codex'))) homes.push(join(home, '.codex'))
    if (process.env.CODEX_HOME) homes.push(resolve(process.env.CODEX_HOME))
    for (const extra of configuredCodexHomes(home)) homes.push(extra)
  }
  const codexHomes = [...new Set(homes)]
  const byPath = new Map()
  const fileFor = (path, kind) => {
    path = realFile(path)
    if (!byPath.has(path)) byPath.set(path, { path, kinds: new Set(), before: snapshot(path) })
    const file = byPath.get(path); file.kinds.add(kind)
    return file
  }
  const claude = settings ? fileFor(settings, 'claude') : null
  const routes = codexHomes.map((home) => ({ home, hooks: fileFor(join(home, 'hooks.json'), 'codex'), trust: fileFor(join(home, 'config.toml'), 'trust') }))
  const files = [...byPath.values()]
  // Parse each real file before any backup, RPC or write.
  for (const file of files) {
    if (file.kinds.has('trust')) {
      if (file.kinds.size !== 1) throw new Error(`JSON and TOML cannot share a file: ${file.path}`)
      withoutTrust(textOf(file.before))
    } else file.value = jsonFile(file)
  }
  const statePath = realFile(join(home, '.agent-config-studio/review-gate-agent-guard.json')), stateBefore = snapshot(statePath)
  const originalState = stateBefore ? JSON.parse(textOf(stateBefore)) : { files: {}, homes: {} }
  const state = { ...originalState, files: {}, homes: {} }
  // Older installations keyed snapshots by aliases. Keep one original baseline per real file.
  for (const [path, saved] of Object.entries(originalState.files)) {
    const target = realFile(path)
    if (!state.files[target] || target === path) state.files[target] = saved
  }
  for (const [home, saved] of Object.entries(originalState.homes || {})) state.homes[home] = {
    ...saved, hooks: realFile(saved.hooks), trust: realFile(saved.trust),
  }
  if (!originalState.homes) {
    const priorHomes = new Set(Object.entries(originalState.files).filter(([, f]) => ['codex', 'trust'].includes(f.kind)).map(([path]) => dirname(path)))
    for (const home of priorHomes) {
      const trust = realFile(join(home, 'config.toml'))
      state.homes[home] = { hooks: realFile(join(home, 'hooks.json')), trust,
        keys: trustSections(trustBlock(textOf(snapshot(trust)))).filter((s) => s.key.startsWith(join(home, 'hooks.json') + ':')).map((s) => s.key) }
    }
  }
  const entry = (file, matcher) => file.value.hooks?.PreToolUse?.some((g) => g.matcher === matcher && g.hooks.some(own))
  const blockEntries = (file) => new Map(trustSections(trustBlock(textOf(snapshot(file.path)))).map((s) => [s.key, s.text]))
  const report = (route, handlers, status = false) => {
    const present = entry(route.hooks, '^Bash$'), block = blockEntries(route.trust)
    const keys = handlers?.map((h) => h.key) || state.homes[route.home]?.keys || []
    const included = keys.length > 0 && keys.every((key) => block.has(key))
    const hashes = handlers?.every((h) => block.get(h.key)?.includes(`trusted_hash = ${JSON.stringify(h.currentHash)}`))
    const rpcTrusted = handlers?.every((h) => h.trustStatus === 'trusted')
    const trusted = present && included && hashes && (!status || rpcTrusted)
    console.log(`Codex ${route.home}: entry ${present ? 'present' : 'missing'}, ${trusted ? 'trusted' : 'untrusted'}, trust entry ${included ? 'present' : !handlers && !keys.length ? 'unknown' : 'missing'}${status ? `, app-server ${rpcTrusted ? 'trusted' : 'untrusted'}` : ''}`)
  }
  if (action === 'status') {
    if (claude) for (const matcher of ['Bash', 'Monitor']) console.log(`Claude ${matcher}: ${entry(claude, matcher) ? 'present' : 'missing'}`)
    for (const route of routes) report(route, entry(route.hooks, '^Bash$') ? await listHooks(route.home) : null, true)
  } else {
    let backup
    const changed = new Set()
    const ensureBackup = () => {
      if (backup) return
      backup = join(home, '.agent-config-studio/backups', `review-gate-guard-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${process.pid}`)
      mkdirSync(backup, { recursive: true })
      const distinct = new Map([...files, { path: statePath, before: stateBefore }].map((f) => [f.path, f]))
      for (const [index, f] of [...distinct.values()].entries()) if (f.before) {
        const path = join(backup, String(index), f.path.replace(/^\/+/, ''))
        mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, Buffer.from(f.before.bytes, 'base64'), { mode: f.before.mode })
      }
      console.log(`Backup: ${backup}`)
    }
    const write = (file, text) => {
      if (text === textOf(snapshot(file.path)) && (text !== null || !existsSync(file.path))) return
      ensureBackup(); changed.add(file.path)
      if (text === null) rmSync(file.path, { force: true })
      else atomic(file.path, text, file.before?.mode ?? 0o600)
    }
    const remember = (file) => {
      const saved = state.files[file.path]
      state.files[file.path] = { before: saved ? saved.before : file.before, after: snapshot(file.path),
        kind: file.kinds.has('trust') ? 'trust' : file.kinds.has('codex') ? 'codex' : 'claude',
        modified: !!saved?.modified || !!saved && !same(file.before, saved.after) }
    }
    if (action === 'install') {
      for (const file of files.filter((f) => !f.kinds.has('trust'))) {
        let added = false
        if (file.kinds.has('claude')) added = addHooks(file.value, ['Bash', 'Monitor']) || added
        if (file.kinds.has('codex')) added = addHooks(file.value, ['^Bash$'], true) || added
        if (added) write(file, JSON.stringify(file.value, null, 2) + '\n')
      }
      const collected = new Map(), results = new Map()
      for (const route of routes) {
        const handlers = await listHooks(route.home)
        results.set(route.home, handlers)
        state.homes[route.home] = { hooks: route.hooks.path, trust: route.trust.path,
          keys: handlers ? [...new Set(handlers.map((h) => h.key))] : state.homes[route.home]?.keys || [] }
        if (handlers) collected.set(route.trust, [...collected.get(route.trust) || [], ...handlers])
      }
      for (const [file, handlers] of collected) write(file, withTrust(textOf(file.before), handlers))
      for (const file of files) if (changed.has(file.path)) remember(file)
      for (const route of routes) report(route, results.get(route.home))
      console.log(claude ? `Claude agent guard installed: ${command}` : `Agent guard installed: ${command}`)
    } else {
      const removed = []
      for (const route of routes) {
        let keys = state.homes[route.home]?.keys || []
        if (!keys.length && entry(route.hooks, '^Bash$')) keys = (await listHooks(route.home))?.map((h) => h.key) || []
        if (!keys.length) keys = [...blockEntries(route.trust).keys()].filter((key) => key.startsWith(join(route.home, 'hooks.json') + ':'))
        removed.push({ hooks: route.hooks.path, trust: route.trust.path, keys })
        delete state.homes[route.home]
      }
      const remaining = Object.values(state.homes)
      for (const file of files) {
        const saved = state.files[file.path], current = snapshot(file.path)
        if (!current) { if (!remaining.some((h) => h.hooks === file.path || h.trust === file.path)) delete state.files[file.path]; continue }
        let text, keep
        if (file.kinds.has('trust')) {
          const retainedKeys = new Set(remaining.filter((h) => h.trust === file.path).flatMap((h) => h.keys))
          const keys = new Set(removed.filter((h) => h.trust === file.path).flatMap((h) => h.keys).filter((key) => !retainedKeys.has(key)))
          text = removeTrust(textOf(current), textOf(saved?.before), keys)
          keep = remaining.some((h) => h.trust === file.path) || trustSections(trustBlock(text)).length > 0
        } else {
          const matchers = []
          const keepCodex = remaining.some((h) => h.hooks === file.path), keepClaude = file.kinds.has('claude') && remaining.length > 0
          if (file.kinds.has('codex') && !keepCodex) matchers.push('^Bash$')
          if (file.kinds.has('claude') && !keepClaude) matchers.push('Bash', 'Monitor')
          const clean = removeHooks(jsonFile({ ...file, before: current }), matchers)
          text = same(clean, file.value) ? textOf(current) : JSON.stringify(clean, null, 2) + '\n'
          keep = keepCodex || keepClaude
        }
        if (!keep && saved && !saved.modified && same(current, saved.after)) text = saved.before ? textOf(saved.before) : null
        else if (!keep && saved?.before === null && (file.kinds.has('trust') ? !text.trim() : !Object.keys(JSON.parse(text)).length)) text = null
        if (text !== textOf(current)) write(file, text)
        if (keep) { if (changed.has(file.path)) remember(file) }
        else delete state.files[file.path]
      }
      console.log('Agent guard uninstalled')
    }
    if (!same(originalState, state)) {
      ensureBackup()
      if (Object.keys(state.files).length || Object.keys(state.homes).length) atomic(statePath, JSON.stringify(state, null, 2) + '\n', stateBefore?.mode ?? 0o600)
      else if (stateBefore) rmSync(statePath)
    }
  }
  if (existsSync(grok)) {
    let compat = false
    for (const line of readFileSync(grok, 'utf8').split('\n')) {
      if (/^\s*\[/.test(line)) compat = /^\s*\[compat\.claude\]\s*(?:#.*)?$/.test(line)
      if (compat && /^\s*hooks\s*=\s*false\s*(?:#.*)?$/.test(line)) console.error(`Warning: Grok ${grok} has [compat.claude] hooks = false; Claude hooks are ignored`)
    }
  }
} catch (error) {
  console.error(`Agent guard installer: ${error.message}`)
  process.exitCode = 1
}
