import fs from 'node:fs';
import path from 'node:path';
import { numericPercent } from './percent.js';
import os from 'node:os';

/**
 * Reads subscription headroom for a Codex seat off its own rollout logs.
 *
 * Codex stamps the server's rate-limit state onto every turn it writes, so the
 * newest rollout that carries one IS the live quota reading — no network call,
 * no credential, no account page. That makes Codex the reliable core of the
 * tracker while the other vendors are best-effort.
 *
 * Read-only, and confined to the seat's own home. Nothing here touches
 * auth.json; the seat is identified by which home it lives in, never by
 * inspecting a token.
 */

/** ~/.codex unless a seat declares its own CODEX_HOME. */
export const defaultCodexHome = () =>
  process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

/**
 * Window labels come from `window_minutes`, NEVER from the `primary` /
 * `secondary` key. Those keys have already swapped meaning once: rollouts
 * before ~2026-08 put the 5h window in `primary` and the weekly in `secondary`,
 * and current ones put the weekly in `primary` with `secondary` null. Keying on
 * position would silently mislabel every historical reading.
 */


export function labelForWindow(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'Unknown window';
  if (minutes % 10080 === 0) {
    const w = minutes / 10080;
    return w === 1 ? 'Weekly' : `Every ${w} weeks`;
  }
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return d === 1 ? 'Daily' : `Every ${d} days`;
  }
  if (minutes % 60 === 0) return `${minutes / 60}h rolling`;
  return `${minutes}m rolling`;
}

/** One `{primary|secondary}` entry -> the tracker's shared window shape. */
function toWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // Number(null) is 0, and a 0 here reads as "plenty left" — the exact opposite
  // of "we do not know". An absent or non-numeric percent is not a window.
  const used = numericPercent(raw.used_percent);
  const minutes = Number(raw.window_minutes);
  if (used === null) return null;
  return {
    label: labelForWindow(minutes),
    usedPercent: used,
    windowMinutes: Number.isFinite(minutes) ? minutes : null,
    // Codex writes resets_at as epoch SECONDS; the tracker speaks millis.
    resetsAt: Number.isFinite(Number(raw.resets_at)) ? Number(raw.resets_at) * 1000 : null,
  };
}

/**
 * Candidate rollout files, most-recently-written first.
 *
 * Ranked by mtime, NOT by the timestamp in the filename. Resuming an old
 * session appends to its original file, so its name stays old while its
 * contents become the newest usage on the machine. Ranking by name hides that
 * session entirely and reports an older reading as current — which would point
 * you at a seat that is actually nearly exhausted.
 *
 * mtime only chooses which files to look at; which reading WINS is decided by
 * the timestamp on the quota event itself, in readCodexUsage.
 */
export function listRollouts(codexHome, limit = 200) {
  const root = path.join(codexHome, 'sessions');
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(full, depth + 1); }
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) found.push(full);
    }
  };
  walk(root, 0);
  const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  return found
    .map((f) => ({ f, m: mtime(f) }))
    .sort((a, b) => b.m - a.m)
    .slice(0, limit)
    .map((x) => x.f);
}

/**
 * Last `rate_limits` object in one rollout, or null.
 *
 * Scans backwards from the end of the file: the freshest reading is the last
 * one written, and a long session's early turns are worthless here. Reads a
 * tail slice rather than the whole file — rollouts reach tens of MB.
 */
export function lastRateLimits(file, tailBytes = 256 * 1024) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // A partial first line is expected when the tail cut mid-record; drop it.
    const lines = text.split('\n');
    if (start > 0) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || !line.includes('"rate_limits"')) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const rl = findRateLimits(ev);
      // The event's own timestamp, not the file's — that is what makes two
      // readings from different sessions comparable.
      if (rl) return { limits: rl, at: Date.parse(ev.timestamp) || null };
    }
    return null;
  } finally { fs.closeSync(fd); }
}

/** `rate_limits` is nested differently across cli versions — find it anywhere. */
function findRateLimits(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (node.rate_limits && typeof node.rate_limits === 'object') return node.rate_limits;
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') {
      const hit = findRateLimits(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Live headroom for one Codex seat.
 *
 * Never invents a reading. A seat with no rollouts, or whose rollouts predate
 * rate-limit reporting, comes back `ok: false` with a reason — the UI shows
 * "not connected", never a fake zero that would read as "plenty left".
 */
/**
 * How old a Codex reading may be before it stops being evidence.
 *
 * Codex writes quota only when a turn runs, so a seat you have not used since
 * yesterday reports yesterday's numbers. Worse, window anchors move: a weekly
 * reading can be from a window that has already been replaced while its stored
 * resets_at is still in the future, so expiry alone does not catch it. Past this
 * age the reading is shown but never ranked — the gauge must not route on it.
 */
export const STALE_AFTER_MS = 60 * 60_000;

/**
 * A complete Codex seat: the LIVE quota, falling back to the rollout logs.
 *
 * The live read is primary because the logs have a hard ceiling — they only
 * change when a turn runs, so refreshing them can never produce a number
 * newer than the last turn, and a fresh seat has no number at all. When the
 * CLI cannot answer (not installed, old version without the method, offline,
 * signed out) the logs still carry the last real reading, so the seat degrades
 * to an honest older number rather than to an error.
 *
 * Credential-requiring, so this runs in the acs-usage CLI, never the studio.
 */
export async function readCodexSeat(opts = {}) {
  const codexHome = opts.codexHome || defaultCodexHome();
  const fromLogs = readCodexUsage(opts);

  // Nothing to ask on behalf of a seat that is not signed in, and asking would
  // spawn a process to be told so.
  if (!fromLogs.signedIn) return fromLogs;

  let live;
  try {
    const { readCodexLimits } = await import('./codex-limits.js');
    live = await readCodexLimits({ codexHome });
  } catch (e) {
    live = { ok: false, reason: `could not read the codex quota: ${e.message}` };
  }

  if (!live.ok) {
    // Keep whatever the logs know, and say why there is no live number. A seat
    // with no log reading keeps its own reason rather than being overwritten.
    return { ...fromLogs, liveReason: live.reason };
  }

  return {
    ...fromLogs,
    ok: true,
    planType: live.planType ?? fromLogs.planType ?? null,
    accountId: live.accountId ?? null,
    windows: live.windows,
    credits: live.credits,
    // Asked of the service just now, so it describes this instant. The staleness
    // machinery below exists only for the log fallback and must not mark a live
    // reading old — that is what made Refresh look broken.
    observedAt: Date.now(),
    live: true,
    stale: false,
    expiredWindows: undefined,
    windowRolledOver: undefined,
    reason: null,
  };
}

export function readCodexUsage({
  codexHome = defaultCodexHome(), scanLimit = 200, now = Date.now(), signedInAt: signedInAtOverride,
} = {}) {
  // Existence only — auth.json is never opened. Knowing whether a seat is
  // logged in is the difference between "you still need to connect this" and
  // "it is connected, it just has not been used yet", and reporting the second
  // as the first sends someone to re-run a login that already worked.
  const authFile = path.join(codexHome, 'auth.json');
  const signedIn = fs.existsSync(authFile);
  const base = { vendor: 'codex', home: codexHome, windows: [], observedAt: null, signedIn };

  // When the seat last signed in. Rollouts carry no account identity, so a
  // reading written BEFORE the current login may belong to a different
  // subscription entirely — which is exactly what happens after re-authing a
  // seat to a second account: the previous account's percentages would be
  // reported under the new one. Anything older than this login is not ours.
  //
  // Prefer a caller-supplied moment, which accounts.js derives from when the
  // seat's ACCOUNT FINGERPRINT last changed. auth.json's mtime is only a
  // fallback for a standalone read, because Codex rewrites that file on every
  // token refresh — so mtime drifts forward with no login at all, and a seat
  // nobody touched would blank itself to "no turn since signing in".
  let signedInAt = Number.isFinite(signedInAtOverride) ? signedInAtOverride : null;
  if (signedInAt === null) {
    try { signedInAt = fs.statSync(authFile).mtimeMs; } catch { /* not signed in */ }
  }

  const noUsageYet = signedIn
    ? 'signed in, but no turn has run on this seat yet — Codex records quota only when it runs'
    : 'not signed in — run the login command for this seat';

  if (!fs.existsSync(path.join(codexHome, 'sessions'))) {
    return { ...base, ok: false, reason: noUsageYet };
  }

  const files = listRollouts(codexHome, scanLimit);
  if (files.length === 0) return { ...base, ok: false, reason: noUsageYet };

  // A session holds the credentials it started with. One that BEGAN before the
  // current login keeps billing the previous account however fresh its events
  // are — an interactive session left open across a re-auth writes the old
  // account's quota into this home indefinitely. Its start time is in the
  // filename, so exclude the whole session, not just its early events.
  const sessionStart = (file) => {
    const m = /rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(path.basename(file));
    if (!m) return null;
    const [, y, mo, d, h, mi, sec] = m;
    const t = new Date(`${y}-${mo}-${d}T${h}:${mi}:${sec}`).getTime();
    return Number.isFinite(t) ? t : null;
  };

  // Read every candidate and keep the reading with the newest event timestamp.
  // Stopping at the first file with a reading would let a session created later
  // but idle since outrank a resumed older session that is genuinely current.
  let best = null;
  for (const file of files) {
    if (signedInAt !== null) {
      const started = sessionStart(file);
      if (started !== null && started < signedInAt) continue;
    }
    const hit = lastRateLimits(file);
    if (!hit) continue;
    const windows = [toWindow(hit.limits.primary), toWindow(hit.limits.secondary)].filter(Boolean);
    if (windows.length === 0) continue;
    // A reading with no parseable timestamp still counts, but never beats one
    // that has a real time behind it.
    const at = hit.at ?? 0;
    // Readings from before this login belong to whoever was signed in then.
    if (signedInAt !== null && at > 0 && at < signedInAt) continue;
    if (!best || at > best.at) best = { at, file, rl: hit.limits, windows };
  }

  if (best) {
    const { rl, windows, file } = best;

    // A percentage only describes the window it was measured in. Codex records
    // quota when a turn runs, so an idle seat's reading ages — and once its
    // window has rolled over, the number is not merely old, it is about a
    // window that no longer exists. Reporting it as current is how the panel
    // claimed 100% of a 5h limit that had reset hours earlier and was really 8%.
    const expired = (w) => {
      if (w.resetsAt && w.resetsAt <= now) return true;
      // Even without a reset time: a reading older than the window itself must
      // span at least one rollover.
      if (w.windowMinutes && best.at && (now - best.at) >= w.windowMinutes * 60_000) return true;
      return false;
    };
    const live = windows.filter((w) => !expired(w));
    const expiredCount = windows.length - live.length;

    if (live.length === 0) {
      return {
        ...base, ok: false,
        planType: rl.plan_type ?? null,
        observedAt: best.at || null,
        source: file,
        // Stated, not inferred. "This seat has usage we can no longer trust" and
        // "this seat has never run a turn" are different things to tell someone
        // — the first needs a refresh, the second needs a first use — and the UI
        // was collapsing them into one badge that contradicted its own reason
        // line. Reconstructing the difference from which fields happen to be
        // null is how that drifts back.
        windowRolledOver: true,
        reason: 'the last reading is older than its quota window, so it no longer describes ' +
                'current usage — run a turn on this seat to refresh it',
      };
    }

    // Two windows of the same length are one window reported twice.
    const seen = new Set();
    const unique = live.filter((w) => {
      const k = `${w.windowMinutes}:${w.resetsAt}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    return {
      ...base,
      ok: true,
      planType: rl.plan_type ?? null,
      windows: unique.sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0)),
      // Some windows were dropped as expired, so what remains is a partial view.
      expiredWindows: expiredCount || undefined,
      // Old enough that the window anchors may have moved underneath it.
      stale: best.at ? (now - best.at) > STALE_AFTER_MS : false,
      credits: rl.credits
        ? {
            hasCredits: rl.credits.has_credits === true,
            unlimited: rl.credits.unlimited === true,
            balance: rl.credits.balance ?? null,
          }
        : null,
      // When the reading was taken, from the event itself — falling back to the
      // file only when the event carried no parseable timestamp. A stale
      // reading is still true about the past; the UI has to be able to say how old.
      observedAt: best.at || (() => { try { return fs.statSync(file).mtimeMs; } catch { return null; } })(),
      source: file,
    };
  }

  return {
    ...base,
    ok: false,
    reason: signedIn
      ? 'signed in, but no turn has run on this seat since it last signed in — Codex records ' +
        'quota only when it runs'
      : 'not signed in — run the login command for this seat',
  };
}
