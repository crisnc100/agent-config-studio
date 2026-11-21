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
import { SANDBOX_EXEC, agyWall, agyWallParams } from '../../../tools/ask-model.mjs';

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
  if (left.status === 0) outside(['delete-generic-password', ...item]);
  await new Promise((r) => setTimeout(r, 3000));
  const log = spawnSync('/usr/bin/log', ['show', '--start', start, '--style', 'compact', '--predicate', 'eventMessage CONTAINS "deny(1)" AND eventMessage CONTAINS "security("'],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  const refused = [...new Set(log.stdout.split('\n').filter((l) => /Sandbox: security\(\d+\) deny\(1\)/.test(l))
    .map((l) => l.replace(/^.*deny\(1\) /, '').replace(os.homedir(), '~')))];
  console.log(`keychain (security under the wall) · add ${add.status}, update ${update.status}, delete ${del.status}`
    + ` · outside the wall: ${seen.status === 0 && seen.stdout.trim() === `${pw}-2` ? 'the update landed' : `the update did NOT land (${seen.status})`}`
    + `, ${left.status === 0 ? 'the item was LEFT (removed now)' : 'nothing left'}`
    + ` · sandbox refusals: ${refused.length ? refused.join(', ') : 'none'}`);
  process.exitCode = add.status || update.status || del.status || refused.length ? 1 : 0;
} catch (e) {
  console.log(`keychain: ${e.message}`);
  process.exitCode = 2;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(callTmp, { recursive: true, force: true });
}
