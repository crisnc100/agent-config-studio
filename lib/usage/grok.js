import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Activity for a Grok seat.
 *
 * Grok is the one vendor that publishes no subscription quota locally: nothing
 * under ~/.grok records a percentage, a window, or a reset. It DOES record
 * consumption — every turn writes a usage object — so a Grok seat can honestly
 * report "connected, and here is what you have used", just never "here is how
 * much headroom is left".
 *
 * That distinction is the whole point. The seat stays ok:false with
 * noQuota:true so it can never enter the routing decision, because ranking it
 * against a real percentage would be comparing two different things.
 *
 * Read-only, credential-free. auth.json is stat-ed, never opened.
 */

export const defaultGrokHome = () =>
  process.env.GROK_HOME || path.join(os.homedir(), '.grok');

/**
 * Sessions live under ~/.grok/sessions/<url-encoded cwd>/<session uuid>/, each
 * with a summary.json and an updates.jsonl. summary.json is small and carries
 * the timestamps, so it decides which sessions are worth opening — the panel
 * polls every 60s and there are ~180 sessions.
 */
export function listSessions(grokHome) {
  const root = path.join(grokHome, 'sessions');
  const out = [];
  let projects;
  try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    let sessions;
    try { sessions = fs.readdirSync(path.join(root, proj.name), { withFileTypes: true }); } catch { continue; }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      const dir = path.join(root, proj.name, s.name);
      const summary = path.join(dir, 'summary.json');
      let mtime;
      try { mtime = fs.statSync(summary).mtimeMs; } catch { continue; }
      out.push({ dir, summary, mtime });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Tokens and turns from one session's updates.jsonl. */
export function sessionUsage(dir) {
  const file = path.join(dir, 'updates.jsonl');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }

  let inputTokens = 0, outputTokens = 0, turns = 0, costTicks = 0, lastAt = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const u = findUsage(ev);
    if (!u) continue;
    turns++;
    inputTokens += Number(u.inputTokens) || 0;
    outputTokens += Number(u.outputTokens) || 0;
    // Kept as raw ticks. The ticks-per-dollar scale is NOT verified, and a
    // wrong scale would put a confident wrong dollar figure on screen.
    costTicks += Number(u.costUsdTicks) || 0;
    const at = Date.parse(ev.timestamp);
    if (Number.isFinite(at) && (lastAt === null || at > lastAt)) lastAt = at;
  }
  return turns === 0 ? null : { inputTokens, outputTokens, turns, costTicks, lastAt };
}

function findUsage(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (node.usage && typeof node.usage === 'object' && 'inputTokens' in node.usage) return node.usage;
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') {
      const hit = findUsage(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * A Grok seat's state, WITHOUT the live quota.
 *
 * Activity comes from disk and needs no credential. The weekly quota needs the
 * CLI's credentials, so it is fetched separately by readGrokSeat below, which
 * only the acs-usage CLI calls — the studio renders the snapshot.
 */
export function readGrokUsage({ grokHome = defaultGrokHome(), windowMs = 24 * 3600_000, now = Date.now() } = {}) {
  const base = { vendor: 'grok', home: grokHome, windows: [], observedAt: null, noQuota: true };

  // Existence only. auth.json is never opened — same rule as every other reader.
  const signedIn = (() => {
    try { return fs.statSync(path.join(grokHome, 'auth.json')).size > 0; } catch { return false; }
  })();

  if (!fs.existsSync(path.join(grokHome, 'sessions'))) {
    return { ...base, ok: false, signedIn,
             reason: signedIn
               ? 'xAI publishes no subscription quota, and this seat has no sessions yet'
               : 'not signed in — run `grok login`' };
  }

  const sessions = listSessions(grokHome);
  let inputTokens = 0, outputTokens = 0, turns = 0, costTicks = 0, lastActiveAt = null;

  for (const s of sessions) {
    if (lastActiveAt === null) lastActiveAt = s.mtime;
    // summary.json mtime gates which files get opened, so a 60s poll does not
    // parse every session on the machine.
    if (s.mtime < now - windowMs) continue;
    const u = sessionUsage(s.dir);
    if (!u) continue;
    inputTokens += u.inputTokens;
    outputTokens += u.outputTokens;
    costTicks += u.costTicks;
    turns += u.turns;
    if (u.lastAt && (lastActiveAt === null || u.lastAt > lastActiveAt)) lastActiveAt = u.lastAt;
  }

  return {
    ...base,
    // Deliberately not ok:true. There is no headroom to report, and a seat that
    // cannot answer the routing question must never rank as though it can.
    ok: false,
    signedIn,
    activity: { inputTokens, outputTokens, turns, costTicks, windowMs, sessions: sessions.length },
    lastActiveAt,
    observedAt: now,
    reason: signedIn
      ? 'xAI publishes no subscription quota, so this seat shows activity, not headroom'
      : 'not signed in — run `grok login`',
  };
}

/**
 * A complete Grok seat: activity from disk, plus the live weekly quota.
 *
 * The quota needs the CLI's credentials, so this runs in the acs-usage CLI and
 * never in the studio process. If the quota cannot be fetched the seat still
 * reports its activity and says why there is no bar — degrading to the honest
 * state rather than to an error.
 */
export async function readGrokSeat(opts = {}) {
  const base = readGrokUsage(opts);
  if (!base.signedIn) return base;

  let billing;
  try {
    const { readGrokBilling } = await import('./grok-billing.js');
    billing = await readGrokBilling({ grokHome: opts.grokHome ?? defaultGrokHome() });
  } catch (e) {
    billing = { ok: false, reason: `could not read the grok quota: ${e.message}` };
  }

  if (!billing.ok) {
    return { ...base, quotaReason: billing.reason };
  }
  return {
    ...base,
    ok: true,
    noQuota: false,
    planType: billing.tier,
    windows: billing.windows,
    credits: billing.prepaidBalance
      ? { hasCredits: true, unlimited: false, balance: String(billing.prepaidBalance) }
      : null,
    reason: null,
  };
}
