import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { homeDir, loadRegistry, vendorOf } from './models.js';
import {
  PAUSED_VERSION, PAUSE_VENDORS, loadRoles, pauseKind, pausedPath, readPaused, resolveRole,
} from './roles.js';
import { resolverStale } from './roles-panel.js';

/**
 * Pausing an account: the one writer of paused.json, shared by the studio's
 * routes and `acs pause` / `acs resume`, and the view of what a pause does
 * to the roles. roles.json is never touched here.
 */

const bad = (status, message) => Object.assign(new Error(message), { status });

export const PAUSE_STALE = 'Your installed model-id is older than this version of ACS and would ignore a pause. Run: acs install-model-id, then pause again.';

const families = (home) => Object.keys(loadRegistry({ home }).defaults?.models || {});

/** What a name covers: a vendor, or a family and the vendor its id belongs to. */
function describe(name, home) {
  const kind = pauseKind(name);
  if (kind === 'vendor') return { name, kind, vendor: name };
  const { registry } = loadRegistry({ home });
  return { name, kind, vendor: vendorOf(registry.models[name]) };
}

/** Every entry with whether it still counts, the file's error, and whether pausing is refused for a stale resolver. */
export function pauseState({ home = homeDir(), now = Date.now() } = {}) {
  const p = readPaused({ home, families: families(home), now });
  const live = new Set(p.active.map((e) => e.name));
  let stale = false;
  try { stale = resolverStale(home); } catch {}
  return {
    entries: p.entries.map((e) => ({ ...describe(e.name, home), until: e.until, active: live.has(e.name) })),
    active: p.active.map((e) => e.name),
    error: p.error,
    resolverStale: stale,
    staleFix: stale ? PAUSE_STALE : null,
    vendors: [...PAUSE_VENDORS],
  };
}

/** The name, checked: a vendor or a known family, or a 400 that lists them. */
function pauseName(name, home) {
  const known = families(home);
  if (typeof name !== 'string' || (!PAUSE_VENDORS.includes(name) && !known.includes(name))) {
    throw bad(400, `${JSON.stringify(name)} is not an account (${PAUSE_VENDORS.join(', ')}) or a model family (${known.join(', ')})`);
  }
  return name;
}

/** null for "until I resume"; otherwise an ISO time that must still be ahead. */
function untilValue(until, now) {
  if (until === null || until === undefined) return null;
  const t = typeof until === 'string' ? Date.parse(until) : NaN;
  if (!Number.isFinite(t)) throw bad(400, `${JSON.stringify(until)} is not a date and time (for example 2026-11-14T15:00:00Z)`);
  if (t <= now) throw bad(400, `${new Date(t).toISOString()} has already passed; pick a later time or pause until you resume`);
  return new Date(t).toISOString();
}

/**
 * The entries the file holds now, for an edit. An unreadable file is the
 * user's to fix: rewriting it would throw away whatever they meant by it.
 */
function current(home) {
  const p = readPaused({ home, families: families(home) });
  if (p.error) throw bad(409, `paused.json is invalid, so nothing is paused and edits are refused until it is fixed or deleted: ${p.error}`);
  return p;
}

/** Never through a link, never over something that is not a plain file. */
function checkBoundary(file) {
  for (const [p, kind] of [[path.dirname(file), 'folder'], [file, 'file']]) {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (st.isSymbolicLink()) throw bad(409, `${p} is a symlink; paused.json is written only at its own path.`);
    if (kind === 'folder' ? !st.isDirectory() : !st.isFile()) throw bad(409, `${p} is not a plain ${kind}.`);
  }
}

const bytesOrNull = (file) => { try { return fs.readFileSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const sameBytes = (a, b) => (a === null ? b === null : b !== null && a.equals(b));

let beforeRename = null;
/** A test seam: runs after the temp write and before the last check. Nothing in the app sets it. */
export function _setBeforeRename(fn) { beforeRename = fn; }

const TRIES = 3;
const CHANGED = 'paused.json changed while it was being saved (another tab or acs pause). Nothing was written; try again.';

/**
 * Read, change, write, as a compare-and-rename: the rename happens only if
 * the file still holds the bytes the change was made from, otherwise the
 * change is made again from the new bytes. The studio and `acs pause` can
 * write at once, and a plain rename would let one silently undo the other.
 * The residual is the syscall gap between the last read and rename(2).
 */
function update(home, change, now) {
  const file = pausedPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < TRIES; i++) {
    checkBoundary(file);
    const base = bytesOrNull(file);
    const p = current(home);
    if (!sameBytes(base, bytesOrNull(file))) continue;
    const body = `${JSON.stringify({ version: PAUSED_VERSION, paused: change(p, now) }, null, 2)}\n`;
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    try {
      fs.writeFileSync(tmp, body, { flag: 'wx', mode: 0o644 });
      if (beforeRename) beforeRename();
      checkBoundary(file);
      if (!sameBytes(base, bytesOrNull(file))) continue;
      fs.renameSync(tmp, file);
      return;
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  throw bad(409, CHANGED);
}

/** Expired entries are dropped on every write, so the file only ever lists pauses that could still apply. */
const kept = (p, now) => p.entries.filter((e) => e.until === null || Date.parse(e.until) > now)
  .map((e) => (e.until === null ? { name: e.name } : { name: e.name, until: e.until }));

export function pause({ name, until = null, home = homeDir(), now = Date.now() }) {
  pauseName(name, home);
  const at = untilValue(until, now);
  // Before anything is written: an older resolver never reads paused.json, so the pause would do nothing.
  if (resolverStale(home)) throw bad(409, PAUSE_STALE);
  update(home, (p) => [...kept(p, now).filter((e) => e.name !== name), at === null ? { name } : { name, until: at }], now);
  return pauseState({ home, now });
}

export function resume({ name, home = homeDir(), now = Date.now() }) {
  pauseName(name, home);
  update(home, (p) => {
    if (!p.entries.some((e) => e.name === name)) throw bad(404, `${name} is not paused`);
    return kept(p, now).filter((e) => e.name !== name);
  }, now);
  return pauseState({ home, now });
}

/**
 * What the pauses do to each role right now: its answer, what it skipped,
 * or that it refuses. `sameVendor` is set when builder and reviewer now
 * answer from one vendor, so its own work is checked by that vendor.
 */
export function pauseEffect({ home = homeDir(), now = Date.now() } = {}) {
  const loaded = loadRoles({ home });
  if (loaded.error) return { roles: [], sameVendor: null };
  const roles = Object.keys(loaded.roles).sort().map((name) => {
    const r = resolveRole(name, { home, now });
    if (r.error) return { name, refuses: Boolean(r.paused), error: r.error, family: '', skipped: r.skipped || [], altSkipped: null };
    return { name, refuses: false, error: null, family: r.family, skipped: r.skipped || [], altSkipped: r.altSkipped || null, alt: r.alt };
  });
  const vendorOfRole = (n) => {
    const r = roles.find((x) => x.name === n && x.family);
    return r ? vendorOf(loadRegistry({ home }).registry.models[r.family]) : null;
  };
  const b = vendorOfRole('builder');
  return { roles, sameVendor: b && b === vendorOfRole('reviewer') ? b : null };
}

/**
 * When a vendor's tightest window resets, from the last stored usage
 * reading: the window with the most used among that vendor's readable
 * accounts. null when no reading says.
 */
export function vendorReset(seats, vendor, now = Date.now()) {
  let best = null;
  for (const s of seats || []) {
    if (s?.vendor !== vendor || !s.ok || !Array.isArray(s.windows)) continue;
    for (const w of s.windows) {
      if (!Number.isFinite(w?.resetsAt) || w.resetsAt <= now || !Number.isFinite(w.usedPercent)) continue;
      if (!best || w.usedPercent > best.usedPercent) best = w;
    }
  }
  return best ? best.resetsAt : null;
}
