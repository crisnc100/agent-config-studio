#!/bin/sh
exec node --input-type=module - "$0" "$@" <<'NODE'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'

try {
  const [script, repo, ...extra] = process.argv.slice(2)
  if (!repo || extra.length) throw new Error('Usage: install-hook.sh <repo>')
  const cwd = resolve(repo)
  const git = (args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  const configured = git(['config', '--get', 'core.hooksPath'])
  if (configured.error || ![0, 1].includes(configured.status)) throw new Error(configured.error?.message || configured.stderr)
  if (configured.status === 0) throw new Error('Refusing: core.hooksPath is set; leave the existing hook configuration intact.')
  const located = git(['rev-parse', '--git-path', 'hooks'])
  if (located.error || located.status !== 0) throw new Error(located.error?.message || located.stderr)
  const hooks = resolve(cwd, located.stdout.trim())
  const target = join(hooks, 'pre-push')
  // lstat also refuses a dangling symlink, which existsSync alone would miss.
  let present = existsSync(target)
  try { lstatSync(target); present = true } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (present) throw new Error(`Refusing: pre-push already exists at ${target}`)
  mkdirSync(hooks, { recursive: true })
  copyFileSync(join(dirname(resolve(script)), 'pre-push'), target)
  chmodSync(target, 0o755)
  console.log(`Installed ${target}`)
} catch (e) {
  console.error(e.message)
  process.exitCode = 1
}
NODE
