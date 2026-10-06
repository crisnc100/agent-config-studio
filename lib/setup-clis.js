import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { candidatesFor, locateBinary } from './harness.js';
import { probeVersions } from './version-probe.js';
import { readCommands } from './setup-commands.js';
import { tilde } from './paths.js';
import { loadSeats, readSnapshot } from './usage/seats.js';

/**
 * The setup screen's CLI cards: is each agent CLI installed, which version,
 * and what is known about its sign-in — without the studio reading a
 * credential.
 *
 * Sign-in is stated only as strongly as the evidence allows:
 *   present   a codex/grok credential file exists and is non-empty (a stat,
 *             never an open — the file could be stale or malformed)
 *   verified  a usage reading through that sign-in succeeded in the last 10
 *             minutes (rate limiting counts: the credential was accepted)
 *   rejected  the vendor refused the credential in the last 10 minutes
 *   none      no credential file, or the last reading found none
 *   unknown   nothing recent to go on — the card says to refresh
 * Claude keeps its credential in the Keychain, which the studio never
 * touches, so its state comes only from the usage snapshot the acs-usage CLI
 * wrote.
 */

export const CLI_IDS = ['claude', 'codex', 'grok'];
const LABELS = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok' };
export const FRESH_MS = 10 * 60_000;
export const SIGN_IN_LABELS = {
  present: 'credentials present', verified: 'verified', rejected: 'rejected',
  none: 'not signed in', unknown: 'unknown',
};

const nonEmpty = (file) => { try { const st = fs.statSync(file); return st.isFile() && st.size > 0; } catch { return false; } };

const state = (s, detail = null) => ({ state: s, label: s === 'unknown' && detail === 'refresh' ? 'unknown — refresh' : SIGN_IN_LABELS[s], detail: detail === 'refresh' ? null : detail });

/** What one stored reading says about its sign-in, or null if it says nothing fresh. */
export function readingState(entry, storedAt, now = Date.now()) {
  if (!entry) return null;
  const age = Number.isFinite(storedAt) ? now - storedAt : Infinity;
  if (age > FRESH_MS) return state('unknown', 'refresh');
  const reason = String(entry.staleReason || entry.reason || '');
  if (entry.ok && !entry.rateLimited) return state('verified');
  if (entry.rateLimited) {
    // A 429 alone proves nothing about the credential. Only a good reading
    // inside the same window does — the one the snapshot carried over.
    const good = entry.lastGood?.observedAt;
    if (Number.isFinite(good) && now - good <= FRESH_MS) {
      return state('verified', 'the usage endpoint is rate limiting; the last reading, minutes ago, succeeded');
    }
    return { state: 'unknown', label: 'unknown — rate limited', detail: 'the usage endpoint is rate limiting, and there is no recent good reading — try Refresh in a minute' };
  }
  if (/credential rejected|HTTP 40[13]|unauthori[sz]ed|not authenticated/i.test(reason)) return state('rejected', reason);
  if (/no usable Claude credential|not signed in/i.test(reason)) return state('none', reason);
  return state('unknown', reason || 'the last reading did not finish');
}

/** The newest stored reading for a vendor's seats, with the snapshot's age. */
function latestReading(vendor, snap) {
  const seats = (snap?.seats || []).filter((s) => s.vendor === vendor);
  return seats.find((s) => s.ok) || seats[0] || null;
}

export function signInFor(id, { home = os.homedir(), env = process.env, seats = [], snapshot = null, now = Date.now() } = {}) {
  const reading = readingState(latestReading(id, snapshot), snapshot?.takenAt, now);
  if (id === 'claude') {
    if (reading) return reading;
    return state('unknown', seats.some((s) => s.vendor === 'claude')
      ? 'refresh'
      : 'add it under Accounts and refresh to check');
  }
  const homes = id === 'codex'
    ? [env.CODEX_HOME || path.join(home, '.codex'), ...seats.filter((s) => s.vendor === 'codex' && s.home).map((s) => s.home)]
    : [env.GROK_HOME || path.join(home, '.grok'), ...seats.filter((s) => s.vendor === 'grok' && s.home).map((s) => s.home)];
  const present = [...new Set(homes)].filter((h) => nonEmpty(path.join(h, 'auth.json')));
  if (reading && (reading.state === 'verified' || reading.state === 'rejected')) return reading;
  if (present.length) return state('present', `in ${present.map((h) => tilde(h)).join(', ')}`);
  return state('none');
}

/** The fix a card offers: install when missing, sign-in when not verified. Docs when unverified. */
function fixFor(id, installed, signIn, table) {
  const fix = {};
  if (!installed) fix.install = table[`install.${id}`]?.command ?? null;
  else if (signIn.state !== 'verified' && signIn.state !== 'present') fix.signIn = table[`signin.${id}`]?.command ?? null;
  if ((!installed && !fix.install) || (installed && 'signIn' in fix && !fix.signIn)) fix.docs = table[`docs.${id}`]?.command ?? null;
  if (fix.install === null) delete fix.install;
  if (fix.signIn === null) delete fix.signIn;
  if (!fix.docs) delete fix.docs;
  return fix;
}

/**
 * Every card. `pendingDirs`, on Recheck, is a fresh read of the login
 * shell's PATH: the --version probes for what is already found start at
 * once, beside that read, and only a binary the new PATH turns up is probed
 * after it — so the whole answer fits in about 4 s however slow both are.
 * Probes run in parallel off the main thread, each capped.
 */
export async function detectClis({ home = os.homedir(), env = process.env, pendingDirs = null, timeoutMs = 3000, now = Date.now() } = {}) {
  const t0 = Date.now();
  const locate = () => CLI_IDS.map((id) => ({ id, ...locateBinary(id, candidatesFor(id)) }));
  let located = locate();
  const first = probeVersions(located.map((l) => l.binary), timeoutMs);
  let later = Promise.resolve({});
  if (pendingDirs) {
    await pendingDirs;
    const known = new Set(located.map((l) => l.binary).filter(Boolean));
    located = locate();
    const fresh = located.map((l) => l.binary).filter((b) => b && !known.has(b));
    const left = Math.max(300, timeoutMs + 500 - (Date.now() - t0) - 300);
    if (fresh.length) later = probeVersions(fresh, left);
  }
  const versions = { ...(await first), ...(await later) };
  const seats = loadSeats().seats;
  const snapshot = readSnapshot();
  const table = readCommands();
  return located.map(({ id, installed, binary }) => {
    const signIn = installed ? signInFor(id, { home, env, seats, snapshot, now }) : state('none');
    return {
      id, label: LABELS[id], installed,
      binary: binary ? tilde(binary) : null,
      version: binary ? versions[binary] ?? null : null,
      signIn, fix: fixFor(id, installed, signIn, table),
    };
  });
}
