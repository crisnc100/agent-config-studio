import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Which account a seat is signed into — as a fingerprint, never as an identity.
 *
 * Codex records no account identity in its rollout logs, so two seats signed
 * into the SAME ChatGPT account look like two subscriptions and get ranked
 * against each other. That is not cosmetic: the staler of the two reports a
 * lower percentage and wins the routing line, sending work to a pool that is
 * actually exhausted.
 *
 * The only reliable discriminator is `tokens.account_id` in the seat's
 * auth.json. This module therefore opens auth.json — the one place in the
 * codebase that does — and returns ONLY a truncated SHA-256 of that id. The raw
 * id, the tokens and everything else in the file are never returned, logged, or
 * persisted; a fingerprint answers "same or different" and nothing else.
 *
 * CLI-SIDE ONLY. It is imported dynamically by snapshot() so the studio process,
 * which renders a stored snapshot, never loads or executes it.
 */

export function codexAccountFingerprint(codexHome) {
  try {
    const raw = fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8');
    const id = JSON.parse(raw)?.tokens?.account_id;
    if (!id || typeof id !== 'string') return null;
    return crypto.createHash('sha256').update(id).digest('hex').slice(0, 12);
  } catch { return null; }
}

export function grokAccountFingerprint(grokHome) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(grokHome, 'auth.json'), 'utf8'));
    // Keyed by issuer::client-id; the user_id inside is the account.
    for (const v of Object.values(raw)) {
      const id = v?.user_id;
      if (id) return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 12);
    }
    return null;
  } catch { return null; }
}

export function fingerprintFor(seat) {
  if (!seat?.home) return null;
  if (seat.vendor === 'codex') return codexAccountFingerprint(seat.home);
  if (seat.vendor === 'grok') return grokAccountFingerprint(seat.home);
  return null;
}

/**
 * Mark seats that share an account.
 *
 * The freshest reading in a group keeps `ok`; the others are demoted so they
 * cannot win the routing line while showing a stale view of the same pool.
 */
export function markDuplicates(seats) {
  const groups = new Map();
  for (const s of seats) {
    if (!s.accountFingerprint) continue;
    const key = `${s.vendor}:${s.accountFingerprint}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ranked = [...group].sort((a, b) => (b.observedAt ?? 0) - (a.observedAt ?? 0));
    const [freshest, ...rest] = ranked;
    freshest.duplicateOf = null;
    freshest.duplicateSiblings = rest.map((s) => s.label);
    for (const s of rest) {
      s.duplicateOf = freshest.label;
      // Demoted, not hidden: it must not rank, but the user has to see it to
      // fix it — that is the whole point of surfacing this.
      s.ok = false;
      s.windows = [];
      s.reason = `this is the same account as "${freshest.label}" — sign it in to a different ` +
                 `subscription, or stop tracking it`;
    }
  }
  return seats;
}
