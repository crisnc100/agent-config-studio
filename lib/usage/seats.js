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
