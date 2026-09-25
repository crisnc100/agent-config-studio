/* Agent Config Studio — how a Usage seat reads, shared by the Usage panel and Home */

/**
 * Kept pure, and loaded before app.js, so both surfaces rank and label seats
 * the same way and tests/home.mjs can run it in a VM as the browser loads it.
 */

/** A seat's headroom is set by its tightest window — the first one to stop you. */
function seatHeadroom(s) {
  // A stale reading is not headroom, it is a memory — never route on it.
  if (!s.ok || s.stale || !s.windows.length) return null;
  return 100 - Math.max(...s.windows.map((w) => w.usedPercent));
}

/** Most headroom first; unreadable seats sink, because they are not "full". */
function rankSeats(seats) {
  return [...(seats || [])].sort((a, b) => {
    const ha = seatHeadroom(a), hb = seatHeadroom(b);
    if (ha === null && hb === null) return 0;
    if (ha === null) return 1;
    if (hb === null) return -1;
    return hb - ha;
  });
}

/** The seat the next task should go to, or null when none reports usable headroom. */
function routeSeat(ranked) {
  const best = ranked.find((s) => seatHeadroom(s) !== null);
  return best ? { seat: best, left: Math.round(seatHeadroom(best)) } : null;
}

/**
 * What a seat without a reading is. Three states, not two: a signed-in seat
 * with no turns yet is not one that was never connected, and a seat whose
 * vendor publishes no quota is connected and working. A rolled-over window
 * HAS usage — it is just too old to trust. A duplicate is signed in to an
 * account another seat already holds, and needs a different one.
 */
function seatState(s) {
  if (s.ok) return { kind: 'reading', tag: null, tone: null };
  const duplicate = Boolean(s.duplicateOf);
  const noQuota = !duplicate && s.noQuota === true && s.signedIn === true;
  const rolled = !duplicate && !noQuota && s.windowRolledOver === true;
  const waiting = !duplicate && !noQuota && !rolled && s.signedIn === true;
  if (duplicate) return { kind: 'duplicate', tag: 'duplicate account', tone: 'duplicate' };
  if (noQuota) return { kind: 'noQuota', tag: 'connected · no quota published', tone: 'waiting' };
  if (rolled) return { kind: 'rolled', tag: 'signed in · reading out of date', tone: 'waiting' };
  if (waiting) return { kind: 'waiting', tag: 'signed in · no usage yet', tone: 'waiting' };
  return { kind: 'offline', tag: 'not connected', tone: null };
}

/** Everything measures what is LEFT, never what is spent, clamped to 0–100. */
const windowLeft = (w) => Math.min(100, Math.max(0, 100 - w.usedPercent));
/** Tinted by pressure, not vendor, so a colour means the same on every gauge. */
const pressure = (left) => (left <= 10 ? 'high' : left <= 30 ? 'mid' : 'low');

/** The sign-in the Usage panel offers for this seat, if it offers one. */
function seatConnect(s) {
  if (s.ok || s.vendor !== 'codex' || !s.home) return null;
  const st = seatState(s);
  if (st.kind === 'duplicate') return 'reauth';
  if (st.kind === 'waiting') return null;
  return 'signin';
}

function untilText(ts) {
  if (!ts) return '';
  const ms = ts - Date.now();
  if (ms <= 0) return 'resetting';
  const h = Math.floor(ms / 3.6e6), mn = Math.round((ms % 3.6e6) / 6e4);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h ? `${h}h ${mn}m` : `${mn}m`;
}
