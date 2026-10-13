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
 *
 * One run at a time: a caller that arrives while one is in flight (Home and
 * Usage, two tabs, a retry after a browser timeout) shares it rather than
 * starting another child. The answer is the stored reading plus whether this
 * run actually refreshed it — `{ fresh, error?, at }` — so a child that could
 * not start, failed or timed out is never reported as a fresh reading.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', '..', 'bin', 'usage.mjs');

let inflight = null;
let spawned = 0;

/** How many children this process has started: what the coalescing test counts. */
export const refreshSpawns = () => spawned;

export function refreshSnapshot({ timeoutMs = 30_000 } = {}) {
  if (inflight) return inflight;
  const run = new Promise((resolve) => {
    // The stored reading is still shown, with its age, whatever happened: the
    // honest outcome rather than an error page — but labelled as not fresh.
    const answer = (error) => resolve(renderSnapshot().then((snap) => ({ ...snap, fresh: !error, ...(error ? { error } : {}), at: Date.now() })));
    let child;
    try {
      child = spawn(process.execPath, [CLI, '--json'], { stdio: 'ignore', env: process.env });
      spawned++;
    } catch (e) {
      return answer(`the usage reader could not start (${e.message})`);
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    let done = false;
    const finish = (error) => { if (done) return; done = true; clearTimeout(timer); answer(error); };
    child.on('close', (code, signal) => {
      if (timedOut) return finish(`the usage reader timed out after ${Math.round(timeoutMs / 1000)}s`);
      if (code !== 0) return finish(`the usage reader exited ${code ?? signal}`);
      finish(null);
    });
    child.on('error', (e) => finish(`the usage reader could not start (${e.message})`));
  });
  inflight = run;
  run.finally(() => { if (inflight === run) inflight = null; });
  return run;
}
