import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

try {
  const [own, ...args] = process.argv.slice(2)
  const input = readFileSync(0)
  const run = (command, argv, repoHook = false) => {
    const options = { input, stdio: ['pipe', 'inherit', 'inherit'] }
    let result = spawnSync(command, argv, options)
    if (repoHook && result.error?.code === 'ENOEXEC') result = spawnSync('/bin/sh', [command, ...argv], options)
    if (result.signal) process.kill(process.pid, result.signal)
    // A child may deliberately exit before reading the entire pipe. Its exit status
    // still wins over EPIPE; spawn errors without a completed child remain failures.
    if (result.error && !(result.error.code === 'EPIPE' && Number.isInteger(result.status))) throw result.error
    return result.status ?? 1
  }
  const shim = join(dirname(fileURLToPath(import.meta.url)), '../pre-push')
  const gate = run('sh', [shim])
  let legacyShim = false
  if (!gate && own) {
    try { legacyShim = readFileSync(own).equals(readFileSync(shim)) }
    catch { /* If comparison is unavailable, preserve normal repo-hook execution. */ }
  }
  process.exitCode = gate || (own && !legacyShim ? run(own, args, true) : 0)
} catch (e) {
  console.error(`Push blocked: ${e.message}`)
  process.exitCode = 1
}
