#!/bin/sh
exec node --input-type=module - "$0" "$@" <<'NODE'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

try {
  const [script, command, ...extra] = process.argv.slice(2)
  const usage = 'Usage: install-global.sh install | uninstall | status [--root <dir>]...'
  if (!['install', 'uninstall', 'status'].includes(command)) throw new Error(usage)
  const rootArgs = []
  for (let i = 0; i < extra.length; i += 2) {
    if (extra[i] !== '--root' || !extra[i + 1] || extra[i + 1].startsWith('--')) throw new Error(usage)
    rootArgs.push(resolve(extra[i + 1]))
  }
  const home = homedir(), hooks = realpathSync(join(dirname(resolve(script)), 'global'))
  const statePath = join(home, '.agent-config-studio/review-gate-global-hook.json')
  const git = (args, allowed = [0]) => {
    const result = spawnSync('git', args, { encoding: 'utf8' })
    if (result.error || !allowed.includes(result.status)) throw new Error(result.error?.message || result.stderr || `git exited ${result.status}`)
    return result
  }
  const values = (args, repo) => {
    const result = git([...(repo ? ['-C', repo] : []), 'config', ...args, '--null', '--get-all', 'core.hooksPath'], [0, 1])
    return result.status === 1 ? [] : result.stdout.split('\0').slice(0, -1)
  }
  const globalValues = () => values(['--global', '--includes'])
  const configPath = resolve(process.env.GIT_CONFIG_GLOBAL ||
    (!existsSync(join(home, '.gitconfig')) && existsSync(join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'git/config'))
      ? join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'git/config') : join(home, '.gitconfig')))
  const snapshot = () => {
    if (!existsSync(configPath)) return null
    const stat = lstatSync(configPath)
    return { bytes: readFileSync(configPath).toString('base64'), mode: stat.mode & 0o777,
      ...(stat.isSymbolicLink() && { link: readlinkSync(configPath), target: realpathSync(configPath) }) }
  }
  const restore = (path, before) => {
    if (!before) { rmSync(path, { force: true }); return }
    if (before.link) {
      writeFileSync(before.target, Buffer.from(before.bytes, 'base64'))
      rmSync(path, { force: true }); symlinkSync(before.link, path)
    } else {
      writeFileSync(path, Buffer.from(before.bytes, 'base64')); chmodSync(path, before.mode)
    }
  }
  // The folders to scan for repos: --root when given, else ACS's project roots (roots.json).
  // With neither, nothing is scanned.
  const projectRoots = () => {
    if (rootArgs.length) return rootArgs
    const file = join(home, '.agent-config-studio/roots.json')
    if (!existsSync(file)) return []
    try {
      const roots = JSON.parse(readFileSync(file, 'utf8'))?.roots
      return Array.isArray(roots) ? roots.flatMap((r) => typeof r?.path === 'string' && r.path ? [r.path] : []) : []
    } catch (e) {
      console.error(`Warning: cannot read ${file}: ${e.message}; no project roots scanned`)
      return []
    }
  }
  const inspectProjects = (showOverrides) => {
    const seen = new Set()
    const walk = (path, depth = 0) => {
      let real
      try { real = realpathSync(path) } catch { return }
      if (seen.has(real)) return
      seen.add(real)
      let files
      try { files = readdirSync(path, { withFileTypes: true }) }
      catch (e) { console.error(`Warning: cannot inspect ${path}: ${e.message}`); return }
      if (files.some((file) => file.name === '.git') || files.some((file) => file.name === 'HEAD') && existsSync(join(path, 'objects'))) {
        if (showOverrides) {
          const local = values(['--local'], path)
          if (local.length) console.log(`${path}: ${local.map((value) => JSON.stringify(value)).join(', ')}`)
        }
        const common = git(['-C', path, 'rev-parse', '--git-common-dir'], [0, 128])
        if (common.status === 0) {
          const own = resolve(path, common.stdout.trim(), 'hooks/push-to-checkout')
          if (existsSync(own)) console.error(`Warning: ${path}: own push-to-checkout hook ${own} will not run while the global core.hooksPath is in use.`)
        } else console.error(`Warning: ${path}: could not inspect its own push-to-checkout hook: ${common.stderr.trim()}`)
        return
      }
      if (depth === 4) return
      for (const file of files)
        if (file.isDirectory() && file.name !== 'node_modules' && !file.name.startsWith('.'))
          walk(join(path, file.name), depth + 1)
    }
    const roots = projectRoots()
    if (!roots.length) console.error('No project roots to scan: ACS has no roots.json here, and no --root was given.')
    for (const root of roots) if (existsSync(root)) walk(root)
  }
  if (command === 'install') {
    const current = globalValues()
    if (current.some((value) => value !== hooks)) throw new Error(`Refusing: a different global core.hooksPath is set: ${current.join(', ')}`)
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, 'utf8'))
      if (state.hooks === hooks && current.length && current.every((value) => value === hooks)) {
        console.log(`Already installed: ${hooks}`)
      } else throw new Error('Refusing: saved global-hook installation state does not match the current configuration')
    } else {
      const before = snapshot()
      git(['config', '--global', 'core.hooksPath', hooks])
      try {
        const state = { hooks, configPath, before, after: snapshot(), previousValues: current }
        mkdirSync(dirname(statePath), { recursive: true })
        // The snapshot holds the global gitconfig's bytes, which can carry tokens: owner-only, even over a stale .tmp.
        writeFileSync(`${statePath}.tmp`, JSON.stringify(state) + '\n', { mode: 0o600 })
        renameSync(`${statePath}.tmp`, statePath)
        chmodSync(statePath, 0o600)
      } catch (e) { restore(configPath, before); throw e }
      console.log(`Installed global hooks: ${hooks}`)
    }
    inspectProjects(false)
  } else if (command === 'uninstall') {
    if (!existsSync(statePath)) console.log('Global review hooks have no saved installation; nothing changed.')
    else {
      const state = JSON.parse(readFileSync(statePath, 'utf8'))
      if (state.configPath !== configPath) throw new Error('Refusing: global config file differs from the saved installation')
      const current = globalValues()
      if (current.some((value) => value !== state.hooks)) throw new Error('Refusing: global core.hooksPath changed since installation')
      if (JSON.stringify(snapshot()) === JSON.stringify(state.after)) restore(configPath, state.before)
      else {
        git(['config', '--global', '--unset-all', 'core.hooksPath'], [0, 5])
        for (const value of state.previousValues) git(['config', '--global', '--add', 'core.hooksPath', value])
      }
      rmSync(statePath)
      console.log('Global review hooks uninstalled; previous configuration restored.')
    }
  } else {
    console.log(`Global core.hooksPath: ${globalValues().join(', ') || '(unset)'}`)
    console.log('Repositories with their own local core.hooksPath (override the global hooks):')
    inspectProjects(true)
  }
} catch (e) {
  console.error(e.message)
  process.exitCode = 1
}
NODE
