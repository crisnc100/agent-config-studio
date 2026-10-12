import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupPath } from './roots.js';

/**
 * `~/.agent-config-studio/setup.json`: whether this machine has been through
 * the setup screen. Absent means it has not, and the page opens #setup.
 *
 * Read on every call and never cached. A file that cannot be read or parsed is
 * `error`, never `none`: treating it as absent would send the page back into
 * setup on every load, and the person could never get out.
 */

export const COMPLETED = new Set(['done', 'skipped', 'migrated']);

export function readSetup({ home = os.homedir() } = {}) {
  const file = setupPath(home);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { state: 'none' };
    return { state: 'error', error: `setup.json could not be read: ${e.code || e.message}` };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !COMPLETED.has(parsed.completed)) {
      throw new Error('it has no recognised "completed" value');
    }
    return { state: parsed.completed, at: typeof parsed.at === 'string' ? parsed.at : null };
  } catch (e) {
    return { state: 'error', error: `setup.json is not valid: ${e.message}` };
  }
}

/** Write `{completed, at}` atomically. `completed` is 'done' or 'skipped'; the route checks it. */
export function writeSetup(completed, { home = os.homedir() } = {}) {
  if (completed !== 'done' && completed !== 'skipped') throw new Error('completed must be "done" or "skipped"');
  const file = setupPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ completed, at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return readSetup({ home });
}
