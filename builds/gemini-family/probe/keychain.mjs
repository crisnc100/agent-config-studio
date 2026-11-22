// keychain.mjs: whether a keychain save works inside the wall, without agy. agy saves a refreshed Google token by
// running /usr/bin/security, so this runs the same tool under the shipped wall (ask-model's own exports): it adds a
// throwaway generic password, updates it, finds it and deletes it, then checks from outside the wall that the update
// landed and nothing is left. It prints each exit and every file the kernel's sandbox log shows refused to `security`
// meanwhile; a name there is what the wall would have to allow back. Not part of the per-call canary: it writes the
// keychain.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SANDBOX_EXEC, agyWall, agyWallParams } from '../../../tools/ask-model.mjs';

/**
 * The line keychain.mjs prints and whether the run passed, from each command's spawnSync result. It passes only when
 * add, update and delete each exited 0 (a timeout's null status is a failure), the updated value was read back outside
 * the wall, a find after the delete answered "not found" (exit 44), the sandbox log was read and named no refusal.
 * Cleaning up an item the delete left is reported on its own and never makes a run pass.
 */
export function keychainVerdict({ add, update, del, seen, left, cleanup, log, pw }) {
  const exit = (r) => (r.status === null ? `timed out or killed (${r.signal ?? r.error?.code ?? 'no status'})` : String(r.status));
  const zero = (r) => r.status === 0 && !r.error && !r.signal;
  const landed = zero(seen) && seen.stdout.trim() === `${pw}-2`;
  const gone = left.status === 44;
  const logRead = zero(log);
  const refused = [...new Set(String(log?.stdout ?? '').split('\n').filter((l) => /Sandbox: security\(\d+\) deny\(1\)/.test(l))
    .map((l) => l.replace(/^.*deny\(1\) /, '').replace(os.homedir(), '~')))];
  const line = `keychain (security under the wall) · add ${exit(add)}, update ${exit(update)}, delete ${exit(del)}`
    + ` · outside the wall: ${landed ? 'the update landed' : `the update did NOT land (find ${exit(seen)})`}`
    + `, ${gone ? 'nothing left' : left.status === 0 ? 'the item was LEFT' : `removal NOT confirmed (find ${exit(left)})`}`
    + (cleanup ? ` · cleanup of the left item: ${zero(cleanup) ? 'removed' : `FAILED (${exit(cleanup)})`}` : '')
    + ` · sandbox refusals: ${!logRead ? `UNKNOWN (log show ${exit(log)})` : refused.length ? refused.join(', ') : 'none'}`;
  return { line, pass: zero(add) && zero(update) && zero(del) && landed && gone && logRead && refused.length === 0 };
}

async function main() {
  const pad = (n) => String(n).padStart(2, '0');
  const t0 = new Date(Date.now() - 1000);
  const start = `${t0.getFullYear()}-${pad(t0.getMonth() + 1)}-${pad(t0.getDate())} ${pad(t0.getHours())}:${pad(t0.getMinutes())}:${pad(t0.getSeconds())}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-agy-keychain-root-'));
  const callTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-agy-call-'));
  const item = ['-s', 'acs-wall-probe', '-a', 'acs-wall-probe'];
  try {
    const p = agyWallParams({ root, callTmp, logFile: path.join(root, 'keychain.log'), bin: '/usr/bin/security' });
    if (p.error) throw new Error(p.error);
    const walled = (args) => spawnSync(SANDBOX_EXEC, agyWall(p.params, ['/usr/bin/security', ...args]), { encoding: 'utf8', timeout: 30_000 });
    const outside = (args) => spawnSync('/usr/bin/security', args, { encoding: 'utf8', timeout: 30_000 });
    const pw = crypto.randomBytes(8).toString('hex');
    const add = walled(['add-generic-password', '-U', ...item, '-w', pw]);
    const update = walled(['add-generic-password', '-U', ...item, '-w', `${pw}-2`]);
    const seen = outside(['find-generic-password', ...item, '-w']);
    const del = walled(['delete-generic-password', ...item]);
    const left = outside(['find-generic-password', ...item]);
    const cleanup = left.status === 0 ? outside(['delete-generic-password', ...item]) : null;
    await new Promise((r) => setTimeout(r, 3000));
    const log = spawnSync('/usr/bin/log', ['show', '--start', start, '--style', 'compact', '--predicate', 'eventMessage CONTAINS "deny(1)" AND eventMessage CONTAINS "security("'],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    const v = keychainVerdict({ add, update, del, seen, left, cleanup, log, pw });
    console.log(v.line);
    process.exitCode = v.pass ? 0 : 1;
  } catch (e) {
    console.log(`keychain: ${e.message}`);
    process.exitCode = 2;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(callTmp, { recursive: true, force: true });
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) await main();
