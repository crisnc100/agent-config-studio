import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readCodexUsage, defaultCodexHome } from './codex.js';
import { readClaudeUsage } from './claude.js';

/**
 * The seat registry: which subscriptions this machine tracks.
 *
 * A seat is one subscription, not one vendor. Someone may hold two Codex plans
 * and no Grok, or one of each, or none — so nothing here assumes a count or a
 * fixed set. The registry is user-declared and the readers key off it; no
 * vendor is ever tracked implicitly.
 *
 * Two Codex seats can only be live at once if each has its own CODEX_HOME:
 * auth.json is per-home (verified — `codex doctor` under a second CODEX_HOME
 * reports its own auth file and finds no credentials from the first). config.toml
 * and AGENTS.md can be symlinked into the second home and are read normally, so
 * a second seat costs a login, not a duplicated configuration.
 */

export const VENDORS = ['claude', 'codex', 'grok'];

export const registryPath = (studioHome = path.join(os.homedir(), '.agent-config-studio')) =>
  path.join(studioHome, 'seats.json');

/** Stable, readable, and derived from what the user typed — not a random uuid. */
export function slugify(text, fallback = 'seat') {
  const s = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return s || fallback;
}

/**
 * Reject a seat rather than storing one that cannot be read later.
 * Returns a list of problems; empty means valid.
 */
export function validateSeat(seat, existing = []) {
  const problems = [];
  if (!seat || typeof seat !== 'object') return ['seat must be an object'];
  if (!seat.id || !/^[a-z0-9][a-z0-9-]*$/.test(seat.id)) {
    problems.push('id must be lowercase alphanumeric with dashes');
  }
  if (!VENDORS.includes(seat.vendor)) {
    problems.push(`vendor must be one of ${VENDORS.join(', ')}`);
  }
  if (!seat.label || typeof seat.label !== 'string') problems.push('label is required');
  if (existing.some((s) => s.id === seat.id)) problems.push(`id "${seat.id}" is already registered`);

  // A codex seat is defined by its home; two seats sharing one home are one
  // seat reported twice, and would silently double-count.
  if (seat.vendor === 'codex') {
    if (!seat.home) problems.push('a codex seat needs a home (CODEX_HOME)');
    else if (existing.some((s) => s.vendor === 'codex' && s.home && path.resolve(s.home) === path.resolve(seat.home))) {
      problems.push(`home "${seat.home}" is already used by another codex seat`);
    }
  }
  return problems;
}

/** Registry contents, or an empty registry. A missing file is not an error. */
export function loadSeats(file = registryPath()) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { seats: [], path: file, exists: false }; }
  const seats = Array.isArray(parsed?.seats) ? parsed.seats.filter((s) => validateSeat(s, []).length === 0) : [];
  return { seats, path: file, exists: true };
}

export function saveSeats(seats, file = registryPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, seats }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);   // atomic: a crash mid-write never truncates the registry
  return file;
}

export function addSeat(seat, file = registryPath()) {
  const { seats } = loadSeats(file);
  const problems = validateSeat(seat, seats);
  if (problems.length) throw new Error(`invalid seat: ${problems.join('; ')}`);
  const next = [...seats, seat];
  saveSeats(next, file);
  return next;
}

export function removeSeat(id, file = registryPath()) {
  const { seats } = loadSeats(file);
  const next = seats.filter((s) => s.id !== id);
  if (next.length === seats.length) throw new Error(`no seat with id "${id}"`);
  saveSeats(next, file);
  return next;
}

/**
 * Seats inferrable from this machine, for first-run bootstrap.
 *
 * A suggestion, never an auto-registration: guessing wrong about which
 * subscriptions someone holds is worse than asking. Grok is never suggested —
 * it writes no usage ledger of any kind, so a Grok seat could only ever render
 * "not connected".
 */
export function detectSeats({ home = os.homedir(), env = process.env } = {}) {
  const found = [];
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  if (fs.existsSync(path.join(codexHome, 'sessions'))) {
    found.push({ id: 'codex-1', vendor: 'codex', label: 'Codex (primary)', home: codexHome });
  }
  const hasClaude = fs.existsSync(path.join(home, '.claude'));
  if (hasClaude) found.push({ id: 'claude-1', vendor: 'claude', label: 'Claude' });
  return found;
}

/** Read one seat's headroom. Unknown vendors report, never throw. */
export async function readSeat(seat, opts = {}) {
  const stamp = (r) => ({ ...r, seatId: seat.id, label: seat.label, vendor: seat.vendor });
  switch (seat.vendor) {
    case 'codex':
      return stamp(readCodexUsage({ codexHome: seat.home || defaultCodexHome(), ...opts }));
    case 'claude':
      return stamp(await readClaudeUsage(opts));
    case 'grok':
      // Not an oversight: nothing under ~/.grok records quota or token usage.
      // Every total_cost_usd string there belongs to Claude headless output a
      // Grok session captured, not to Grok itself.
      return stamp({ vendor: 'grok', ok: false, windows: [], observedAt: null,
                     reason: 'Grok publishes no local usage ledger' });
    default:
      return stamp({ vendor: seat.vendor, ok: false, windows: [], observedAt: null,
                     reason: `unknown vendor "${seat.vendor}"` });
  }
}

/**
 * Every registered seat, read concurrently.
 *
 * One seat failing never fails the snapshot — a dead Claude endpoint must not
 * hide the Codex numbers, which are the reliable ones.
 */
export async function snapshot({ file = registryPath(), seats, ...opts } = {}) {
  const list = seats ?? loadSeats(file).seats;
  const results = await Promise.all(list.map(async (seat) => {
    try { return await readSeat(seat, opts); }
    catch (e) {
      return { seatId: seat.id, label: seat.label, vendor: seat.vendor,
               ok: false, windows: [], observedAt: null, reason: `reader threw: ${e.message}` };
    }
  }));
  return { takenAt: Date.now(), seats: results };
}

/* ── snapshot persistence ──────────────────────────────────────────────────
 * The studio never reads a credential. Claude's headroom requires an OAuth
 * token, so the CLI takes that reading and writes it here; the web app renders
 * the file and says how old it is. Seats that need no credential (codex reads
 * its own logs) can be refreshed by the app directly.
 */

export const snapshotPath = (studioHome = path.join(os.homedir(), '.agent-config-studio')) =>
  path.join(studioHome, 'usage-snapshot.json');

export function writeSnapshot(snap, file = snapshotPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(snap, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

export function readSnapshot(file = snapshotPath()) {
  try {
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(snap?.seats)) return null;
    return snap;
  } catch { return null; }
}

/** Vendors whose headroom can be read without any credential. */
export const CREDENTIAL_FREE = new Set(['codex', 'grok']);

/**
 * A snapshot for the web app: the stored reading, with credential-free seats
 * re-read live so they are never stale. Claude keeps the CLI's reading and
 * carries its age so the UI can say how old it is rather than implying it is now.
 */
export async function renderSnapshot({ file = registryPath(), snapshotFile = snapshotPath() } = {}) {
  const stored = readSnapshot(snapshotFile);
  const registered = loadSeats(file).seats;
  const byId = new Map((stored?.seats || []).map((s) => [s.seatId, s]));

  const seats = await Promise.all(registered.map(async (seat) => {
    if (CREDENTIAL_FREE.has(seat.vendor)) {
      try { return { ...(await readSeat(seat)), readingAge: 0 }; } catch { /* fall through to stored */ }
    }
    const prior = byId.get(seat.id);
    if (prior) {
      return { ...prior, readingAge: stored?.takenAt ? Date.now() - stored.takenAt : null };
    }
    return {
      seatId: seat.id, label: seat.label, vendor: seat.vendor, ok: false, windows: [],
      observedAt: null, readingAge: null,
      reason: 'no stored reading — run `acs-usage` to take one',
    };
  }));

  return { takenAt: Date.now(), storedAt: stored?.takenAt ?? null, seats };
}

/* ── creating seats ────────────────────────────────────────────────────────
 * Shared by the CLI and the studio so both create seats identically.
 */

/** Homes for additional Codex seats. The first seat keeps ~/.codex. */
export const seatHomeRoot = (home = os.homedir()) => path.join(home, '.codex-seats');

/** An id that does not collide with a registered seat. */
export function uniqueSeatId(base, file = registryPath()) {
  const taken = new Set(loadSeats(file).seats.map((s) => s.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * A second Codex home that shares configuration by symlink.
 *
 * Verified against `codex doctor` under a second CODEX_HOME: a symlinked
 * config.toml is loaded and parsed normally, and auth resolves per-home. So
 * only auth.json and session history diverge — which is exactly what makes it a
 * separate seat — and a new seat costs one login rather than a duplicated setup.
 *
 * The home is always derived from the generated id and never from caller input:
 * this runs behind an HTTP route, and an attacker-chosen path would be a
 * directory-creation primitive.
 */
export function createCodexHome({ label, primary, file = registryPath(), home = os.homedir() }) {
  const id = uniqueSeatId(slugify(label, 'codex'), file);
  const primaryHome = primary || process.env.CODEX_HOME || path.join(home, '.codex');
  const seatHome = path.join(seatHomeRoot(home), id);

  if (fs.existsSync(seatHome)) throw new Error(`${seatHome} already exists`);
  fs.mkdirSync(seatHome, { recursive: true });

  // Shared: configuration and instructions. NOT auth.json, and NOT sessions.
  const linked = [];
  for (const name of ['config.toml', 'AGENTS.md', 'skills', 'rules', 'plugins']) {
    const src = path.join(primaryHome, name);
    if (!fs.existsSync(src)) continue;
    try { fs.symlinkSync(src, path.join(seatHome, name)); linked.push(name); } catch { /* optional */ }
  }

  const seat = { id, vendor: 'codex', label, home: seatHome };
  addSeat(seat, file);
  return { seat, linked, loginCommand: `CODEX_HOME=${seatHome} codex login` };
}

/**
 * Register a seat from a UI request.
 *
 * A codex seat gets a home created for it unless it is the first one, which
 * adopts the existing ~/.codex rather than asking for a second login the user
 * does not need.
 */
export function createSeat({ vendor, label, file = registryPath(), home = os.homedir() }) {
  if (!VENDORS.includes(vendor)) throw new Error(`vendor must be one of ${VENDORS.join(', ')}`);
  const clean = String(label || '').trim().slice(0, 60);
  if (!clean) throw new Error('label is required');

  if (vendor === 'codex') {
    const { seats } = loadSeats(file);
    const primaryHome = process.env.CODEX_HOME || path.join(home, '.codex');
    const primaryTaken = seats.some((s) => s.vendor === 'codex' && s.home &&
      path.resolve(s.home) === path.resolve(primaryHome));
    if (!primaryTaken && fs.existsSync(path.join(primaryHome, 'sessions'))) {
      const seat = { id: uniqueSeatId(slugify(clean, 'codex'), file), vendor, label: clean, home: primaryHome };
      addSeat(seat, file);
      return { seat, linked: [], loginCommand: null, adopted: true };
    }
    return createCodexHome({ label: clean, file, home });
  }

  const seat = { id: uniqueSeatId(slugify(clean, vendor), file), vendor, label: clean };
  addSeat(seat, file);
  return {
    seat, linked: [], adopted: false,
    loginCommand: vendor === 'claude' ? null : null,
    note: vendor === 'grok'
      // Registering it is allowed, but say plainly that it can never report.
      ? 'Grok publishes no local usage ledger, so this seat will always read as not connected.'
      : null,
  };
}
