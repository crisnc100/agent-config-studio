import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { locateBinary } from '../harness.js';
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

/**
 * Logins, keyed by seat id, so a second click does not start a second server.
 * An entry is reserved synchronously, before the first await, so two requests
 * racing in the same tick share one child. A finished, failed or cancelled
 * entry stays only so a poll can read the outcome; it is never handed back as
 * a login in progress.
 */
const inFlight = new Map();

// Located, not version-probed: a sign-in needs the path, and a --version run
// here would hold the server for as long as the CLI takes to answer.
const codexBinary = () => locateBinary('codex');

/**
 * A test seam for the conflict check, so a suite can stand in for a machine
 * with no lsof (the `unchecked` warning). Nothing in the app sets it.
 */
let processCheck = codexProcessesUsingHome;
export function _setProcessCheck(fn) { processCheck = fn || codexProcessesUsingHome; }

/** Drop `entry` for this seat, unless a newer attempt has replaced it. */
const forget = (seatId, entry) => { if (inFlight.get(seatId) === entry) inFlight.delete(seatId); };

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
 *
 * A second call while one is starting joins it; one while it is waiting in the
 * browser gets the same URL. Anything that has ended starts afresh. When the
 * conflict check could not run, `unchecked` says so — the person decides with
 * that in front of them, not buried in a log.
 */
export function startLogin({ seatId, home, reauth = false, force = false }) {
  const existing = inFlight.get(seatId);
  if (existing && !existing.finished) {
    if (existing.url) return Promise.resolve({ url: existing.url, alreadyRunning: true, ...withWarning(existing) });
    return existing.pending;
  }
  const entry = { child: null, url: null, startedAt: Date.now(), finished: false, cancelled: false, unchecked: null, signedIn: false };
  inFlight.set(seatId, entry);
  // An unexpected throw is an ended attempt too, never one left to join forever.
  entry.pending = begin(seatId, entry, { home, reauth, force }).catch((e) => ({ error: `could not start the sign-in: ${e.message}` })).then((result) => {
    // Nothing is waiting in a browser: the next attempt must not join this one.
    if (!result.url) { entry.finished = true; if (!entry.child) forget(seatId, entry); }
    return result;
  });
  return entry.pending;
}

const withWarning = (entry) => (entry.unchecked ? { unchecked: entry.unchecked } : {});

async function begin(seatId, entry, { home, reauth, force }) {
  // Cheap, certain checks first: a home that does not exist has nothing using
  // it, and reporting a scan failure for one would name the wrong problem.
  const found = codexBinary();
  if (!found.installed) return { error: 'the codex CLI is not installed on this machine' };
  if (!fs.existsSync(home)) return { error: `seat home ${home} no longer exists` };

  // Refuse to sign in while something else is attached to this home.
  //
  // A running Codex process holds the credentials it started with and refreshes
  // them back into its home on its own schedule, so a login completed now gets
  // overwritten minutes later — silently, and long after the user has stopped
  // watching. Failing loudly BEFORE the browser opens is the only honest
  // moment: afterwards the seat looks connected and is not.
  if (!force) {
    let busy;
    try { busy = await processCheck(home); }
    catch (e) {
      if (e.unsupported) {
        // The platform cannot tell us. Refusing every sign-in to guard against
        // a hazard we cannot even observe would make the app unusable here, so
        // proceed and say the check did not run.
        busy = [];
        entry.unchecked = `${e.message} — quit any Codex session using this seat before signing in, or it may undo the sign-in`;
      } else {
        // The scan FAILED, which is different: proceeding would be a guess with
        // a silent, delayed failure mode.
        return { error: `${e.message} — close any Codex sessions using this seat, then try again` };
      }
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
  // Every await above is a moment this attempt may have been cancelled or
  // replaced. A stale attempt must never sign out or log in: its logout
  // would undo the sign-in that replaced it.
  const stale = () => entry.cancelled || inFlight.get(seatId) !== entry;
  if (stale()) return { error: 'the sign-in was cancelled' };
  // Re-auth signs out first; codex login on an already-authenticated home is a
  // no-op, so without this the seat keeps the account you are trying to change.
  if (reauth) {
    const r = await signOut({ home });
    if (r.error) return { error: r.error };
  }
  if (stale()) return { error: 'the sign-in was cancelled' };

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
    entry.child = child;

    let settled = false;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
    const end = () => { entry.finished = true; };

    // The whole flow is capped, so a login the user abandons in the browser
    // cannot leave a callback server listening for the life of the studio.
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      end(); forget(seatId, entry);
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
      settle({ url: entry.url, ...withWarning(entry) });
    };
    child.stderr.on('data', scan('err'));
    child.stdout.on('data', scan('out'));

    child.on('error', (e) => {
      clearTimeout(timer); end(); forget(seatId, entry);
      settle({ error: `could not start codex login: ${e.message}` });
    });
    child.on('close', () => {
      clearTimeout(timer);
      end();
      entry.signedIn = isSignedIn(home);
      // Kept briefly so a poll right after completion sees the result.
      setTimeout(() => forget(seatId, entry), 30_000).unref?.();
      settle({ error: entry.url ? null : 'codex login exited before printing a sign-in URL' });
    });
  });
}

/** Where a seat's login has got to. Cheap enough to poll. */
export function loginState({ seatId, home }) {
  const entry = inFlight.get(seatId);
  const running = Boolean(entry && !entry.finished);
  return {
    signedIn: isSignedIn(home),
    running,
    // A finished login's URL leads to a callback server that is gone.
    url: running ? entry.url : null,
    ...(entry ? withWarning(entry) : {}),
  };
}

/** Abandon an in-flight login and stop its callback server. */
export function cancelLogin({ seatId }) {
  const entry = inFlight.get(seatId);
  if (!entry) return { cancelled: false };
  entry.cancelled = true;
  entry.finished = true;
  try { entry.child?.kill('SIGKILL'); } catch {}
  inFlight.delete(seatId);
  return { cancelled: true };
}
