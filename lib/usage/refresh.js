import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSnapshot } from './seats.js';

/**
 * Take a fresh reading for the seats that need a credential.
 *
 * This is the ONLY spawn outside lib/harness.js's chokepoint, and it exists for
 * a specific reason: Claude's headroom needs an OAuth token, and that token must
 * not enter the studio process. Running the CLI as a child keeps the credential
 * in a process that exits, writing only a snapshot back.
 *
 * It is not a harness spawn and cannot become one:
 *   - the executable is always process.execPath, never a name resolved on PATH,
 *     so no shim can be substituted for it;
 *   - the argv is fixed and derived from this file's own location — nothing from
 *     an HTTP request reaches it;
 *   - stdio is ignored, so the child cannot stream anything back into a reply.
 *
 * tests/guards.mjs enforces all three statically.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', '..', 'bin', 'usage.mjs');

export function refreshSnapshot({ timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [CLI, '--json'], { stdio: 'ignore', env: process.env });
    } catch {
      return resolve(renderSnapshot());
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    // A refresh that cannot run is not fatal: the stored reading is still shown,
    // with its age, which is the honest outcome rather than an error page.
    const finish = () => { clearTimeout(timer); resolve(renderSnapshot()); };
    child.on('close', finish);
    child.on('error', finish);
  });
}
