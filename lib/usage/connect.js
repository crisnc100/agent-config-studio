import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findBinary } from '../harness.js';
import { codexProcessesUsingHome } from './processes.js';

/**
 * Codex sign-in, driven from the studio.
 *
 * `codex login` starts a local callback server and prints an OAuth URL. The
 * studio captures that URL and hands it to the browser the user is already in,
 * so connecting a seat never requires a terminal.
 *
 * WHY THIS IS ALLOWED TO SPAWN A HARNESS BINARY. tests/guards.mjs otherwise
 * bans that outside lib/harness.js, because an uncontained spawn could run a
 * model turn that writes files — the bug this repo was hardened against. A
 * login cannot:
 *   - argv is pinned to ['login'] or ['login','status'] — never a prompt,
 *     never `exec`, never a tool flag, and nothing from a request reaches it;
 *   - the binary is resolved to an absolute real path past wrapper shims, so a
 *     PATH entry cannot substitute a different program;
 *   - the credential lands in the seat's own auth.json. The studio never reads
 *     it, and this module never reads or logs its output beyond the URL.
 * The guard enforces all of that statically.
 */

const LOGIN_TIMEOUT_MS = 5 * 60_000;

/** In-flight logins, keyed by seat id, so a second click does not start a second server. */
const inFlight = new Map();

const codexBinary = () => findBinary('codex');

/**
 * Sign a seat OUT, so it can be signed into a different account.
 *
 * Needed because two seats signed into the same subscription look like two
 * pools and the staler one wins the routing line. Only auth.json is cleared;
 * the seat's sessions and shared config stay.
 */
export function signOut({ home }) {
  const found = codexBinary();
  if (!found.installed) return Promise.resolve({ error: 'the codex CLI is not installed on this machine' });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(found.binary, ['logout'], {
        cwd: home, env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch (e) { return resolve({ error: `could not run codex logout: ${e.message}` }); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve({ error: 'codex logout timed out' }); }, 30_000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ error: `codex logout failed: ${e.message}` }); });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ signedOut: !isSignedIn(home) });
    });
  });
}

/** The OAuth URL codex prints on stderr. */
const URL_RE = /(https:\/\/auth\.openai\.com\/oauth\/authorize\?[^\s]+)/;

export function isSignedIn(home) {
  try { return fs.statSync(path.join(home, 'auth.json')).size > 0; } catch { return false; }
}

/**
 * Begin a login for one seat and resolve once the URL is known.
 *
 * Resolving on the URL rather than on completion is deliberate: the user has to
 * visit it before anything else can happen, so the studio should render it the
 * moment it exists rather than holding the request open for the whole flow.
 */
export async function startLogin({ seatId, home, reauth = false, force = false }) {
  const existing = inFlight.get(seatId);
  if (existing && existing.url) return { url: existing.url, alreadyRunning: true };

  // Refuse to sign in while something else is attached to this home.
  //
  // A running Codex process holds the credentials it started with and refreshes
  // them back into its home on its own schedule, so a login completed now gets
  // overwritten minutes later — silently, and long after the user has stopped
  // watching. Failing loudly BEFORE the browser opens is the only honest
  // moment: afterwards the seat looks connected and is not.
  if (!force) {
    let busy;
    try { busy = await codexProcessesUsingHome(home); }
    catch (e) {
      // We could not find out. Proceeding would be a guess with a silent,
      // delayed failure mode — the seat looks connected and is overwritten
      // minutes later — so stop and say so.
      return { error: `${e.message} — close any Codex sessions using this seat, then try again` };
    }
    if (busy.length) {
      return {
        conflicts: busy.map((p) => ({ pid: p.pid, command: p.command })),
        error: busy.length === 1
          ? 'a Codex session is using this seat right now — signing in would be undone when it next refreshes its token'
          : `${busy.length} Codex processes are using this seat right now — signing in would be undone when one of them next refreshes its token`,
      };
    }
  }
  // Re-auth signs out first; codex login on an already-authenticated home is a
  // no-op, so without this the seat keeps the account you are trying to change.
  if (reauth) {
    const r = await signOut({ home });
    return r.error ? { error: r.error } : startLogin({ seatId, home, reauth: false, force: true });
  }

  const found = codexBinary();
  if (!found.installed) return { error: 'the codex CLI is not installed on this machine' };
  if (!fs.existsSync(home)) return { error: `seat home ${home} no longer exists` };

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(found.binary, ['login'], {
        cwd: home,
        env: { ...process.env, CODEX_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ error: `could not start codex login: ${e.message}` });
    }

    const entry = { child, url: null, startedAt: Date.now(), error: null };
    inFlight.set(seatId, entry);

    let settled = false;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };

    // The whole flow is capped, so a login the user abandons in the browser
    // cannot leave a callback server listening for the life of the studio.
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      inFlight.delete(seatId);
      settle({ error: 'timed out waiting for the sign-in to start' });
    }, LOGIN_TIMEOUT_MS);

    // Buffer per stream and only accept a URL that is terminated by
    // whitespace. Matching a raw chunk returns whatever happened to arrive —
    // a URL split mid-query yields a truncated link missing state and
    // code_challenge, which fails the OAuth exchange with no visible cause.
    const buffers = { out: '', err: '' };
    const scan = (key) => (chunk) => {
      if (entry.url) return;
      buffers[key] += String(chunk);
      const m = URL_RE.exec(buffers[key]);
      if (!m) return;
      const after = buffers[key].slice(m.index + m[1].length);
      if (!/[\s]/.test(after)) return;   // still arriving; wait for the terminator
      entry.url = m[1];
      settle({ url: entry.url });
    };
    child.stderr.on('data', scan('err'));
    child.stdout.on('data', scan('out'));

    child.on('error', (e) => {
      clearTimeout(timer); inFlight.delete(seatId);
      settle({ error: `could not start codex login: ${e.message}` });
    });
    child.on('close', () => {
      clearTimeout(timer);
      entry.finished = true;
      entry.signedIn = isSignedIn(home);
      // Keep the entry briefly so a poll right after completion sees the result.
      setTimeout(() => inFlight.delete(seatId), 30_000);
      settle({ error: entry.url ? null : 'codex login exited before printing a sign-in URL' });
    });
  });
}

/** Where a seat's login has got to. Cheap enough to poll. */
export function loginState({ seatId, home }) {
  const entry = inFlight.get(seatId);
  return {
    signedIn: isSignedIn(home),
    running: Boolean(entry && !entry.finished),
    url: entry?.url ?? null,
  };
}

/** Abandon an in-flight login and stop its callback server. */
export function cancelLogin({ seatId }) {
  const entry = inFlight.get(seatId);
  if (!entry) return { cancelled: false };
  try { entry.child.kill('SIGKILL'); } catch {}
  inFlight.delete(seatId);
  return { cancelled: true };
}
