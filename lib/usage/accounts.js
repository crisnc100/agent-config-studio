import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * When each seat last CHANGED ACCOUNT — the honest definition of "signed in".
 *
 * readCodexUsage has to know when a seat's current login began, because
 * rollouts carry no account identity: a reading written before the login may
 * belong to a different subscription entirely, and reporting it under the new
 * one shows the wrong pool's headroom.
 *
 * The obvious source, auth.json's mtime, is WRONG. Codex rewrites that file on
 * every token refresh — verified on this machine: auth.json's own last_refresh
 * field read 2026-09-10T16:12:08Z, matching its mtime to the second, hours
 * after the login it supposedly recorded. Any long-lived codex process (the
 * ChatGPT desktop app runs one that never exits) refreshes on its own schedule.
 * So a seat nobody touched would silently move its own "login" forward and
 * blank itself to "no turn has run since signing in" until it was used again.
 *
 * A change of ACCOUNT is the thing that actually invalidates old readings, and
 * the fingerprint from identity.js detects exactly that. This module remembers
 * the fingerprint per seat and the moment it last changed.
 *
 * Fingerprints only — never an account id, never a token. Same contract as
 * identity.js, whose output this stores.
 */

export const accountsPath = (studioHome = path.join(os.homedir(), '.agent-config-studio')) =>
  path.join(studioHome, 'accounts.json');

export function readAccounts(file = accountsPath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const seats = {};
    for (const [id, v] of Object.entries(raw.seats || {})) {
      // A 12-char hex fingerprint and a millisecond timestamp, or the entry is
      // ignored — a corrupt file must not decide which readings count.
      if (typeof v?.fingerprint === 'string' && /^[0-9a-f]{12}$/.test(v.fingerprint)
          && Number.isFinite(v.since)) {
        seats[id] = { fingerprint: v.fingerprint, since: v.since };
      }
    }
    return seats;
  } catch { return {}; }
}

export function writeAccounts(seats, file = accountsPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, seats }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Fold this run's fingerprints into the stored state.
 *
 * Returns one entry per seat: `since` (when this account began on this seat)
 * and `changed` (it is different from what we last saw).
 *
 * First sight of a seat is NOT a change — there is no previous account to have
 * moved away from. It is baselined at `fallbackFor(seat)`, normally auth.json's
 * mtime, which is the best available answer on day one and the only time that
 * timestamp is trustworthy.
 */
export function reconcile(seats, fingerprints, {
  file = accountsPath(), now = Date.now(), fallbackFor = () => null, persist = true,
} = {}) {
  const stored = readAccounts(file);
  const next = {};
  const out = new Map();

  for (const seat of seats) {
    const fp = fingerprints.get(seat.id) ?? null;
    if (!fp) {
      // Not signed in, or a vendor with no fingerprint. Keep any stored entry
      // so a seat that is briefly unreadable does not lose its history.
      if (stored[seat.id]) next[seat.id] = stored[seat.id];
      out.set(seat.id, { since: stored[seat.id]?.since ?? null, changed: false, fingerprint: null });
      continue;
    }
    const prev = stored[seat.id];
    if (!prev) {
      const since = fallbackFor(seat) ?? now;
      next[seat.id] = { fingerprint: fp, since };
      out.set(seat.id, { since, changed: false, fingerprint: fp });
    } else if (prev.fingerprint !== fp) {
      next[seat.id] = { fingerprint: fp, since: now };
      out.set(seat.id, { since: now, changed: true, fingerprint: fp });
    } else {
      next[seat.id] = prev;
      out.set(seat.id, { since: prev.since, changed: false, fingerprint: fp });
    }
  }

  // Seats no longer tracked drop out, so re-adding an id cannot inherit the
  // previous seat's account history.
  if (persist) {
    try { writeAccounts(next, file); } catch { /* advisory state; never fatal */ }
  }
  return out;
}
