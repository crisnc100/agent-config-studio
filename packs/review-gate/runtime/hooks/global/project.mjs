import { spawnSync } from 'node:child_process'
import { accessSync, constants, lstatSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

// git from an absolute PATH entry only, so a `.` or empty entry never runs the repository's own ./git.
const git = (() => {
  for (const dir of String(process.env.PATH ?? '/usr/bin:/bin').split(':')) {
    if (!isAbsolute(dir)) continue
    const path = join(dir, 'git')
    try { accessSync(path, constants.X_OK); if (lstatSync(realpathSync(path)).isFile()) return path } catch {}
  }
  return null
})()

// A repo is gated only when it opts in: reviewgate.enabled is true, or reviewgate.worktreeProjects
// is true (any scope) and one of its worktrees has a .worktrees.conf. Others pass through.
const flag = (key) => {
  if (!git) throw new Error('git is not on PATH')
  const result = spawnSync(git, ['config', '--type=bool', '--get', key], { maxBuffer: 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status === 1) return false
  const value = String(result.stdout).trim()
  if (result.status === 0 && (value === 'true' || value === 'false')) return value === 'true'
  throw new Error(`${key} is not a boolean: ${String(result.stderr || result.stdout).trim()}`)
}

try {
  let project = flag('reviewgate.enabled')
  if (!project && flag('reviewgate.worktreeProjects')) {
    const result = spawnSync(git, ['worktree', 'list', '--porcelain', '-z'], { maxBuffer: 64 * 1024 * 1024 })
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || 'could not list worktrees')
    const prefix = Buffer.from('worktree '), suffix = Buffer.from('/.worktrees.conf')
    for (let start = 0, end; start < result.stdout.length; start = end + 1) {
      end = result.stdout.indexOf(0, start)
      if (end < 0) end = result.stdout.length
      const field = result.stdout.subarray(start, end)
      if (!field.subarray(0, prefix.length).equals(prefix)) continue
      const path = Buffer.concat([field.subarray(prefix.length), suffix])
      try { if (statSync(path).isFile()) project = true }
      catch (e) {
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')
          console.error(`Warning: unreadable worktree marker ${path}: ${e.message}; treating this path as ordinary`)
      }
    }
  }
  console.log(project ? '1' : '0')
} catch (e) {
  console.error(`Push blocked: could not classify this repo for the review gate: ${e.message}`)
  process.exitCode = 1
}
