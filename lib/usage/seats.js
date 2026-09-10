import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readCodexUsage, defaultCodexHome } from './codex.js';
import { readClaudeUsage } from './claude.js';
import { readGrokUsage, readGrokSeat, defaultGrokHome } from './grok.js';

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

export function removeSeat(id, file = registryPath(), snapshotFile = null) {
  const { seats } = loadSeats(file);
  const next = seats.filter((s) => s.id !== id);
  if (next.length === seats.length) throw new Error(`no seat with id "${id}"`);
  saveSeats(next, file);
  // Drop the stored reading as well, so a later seat that happens to reuse this
  // id cannot inherit it. Belt and braces with the vendor/home match above.
  try {
    const snapFile = snapshotFile ?? snapshotPath(path.dirname(file));
    const snap = readSnapshot(snapFile);
    if (snap?.seats?.some((s) => s.seatId === id)) {
      writeSnapshot({ ...snap, seats: snap.seats.filter((s) => s.seatId !== id) }, snapFile);
    }
  } catch { /* a stale snapshot is not worth failing a removal over */ }
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
  const grokHome = env.GROK_HOME || path.join(home, '.grok');
  if (fs.existsSync(path.join(grokHome, 'sessions'))) {
    found.push({ id: 'grok-1', vendor: 'grok', label: 'Grok', home: grokHome });
  }
  return found;
}

/** Read one seat's headroom. Unknown vendors report, never throw. */
export async function readSeat(seat, opts = {}) {
  const stamp = (r) => ({ ...r, seatId: seat.id, label: seat.label, vendor: seat.vendor });
  switch (seat.vendor) {
    case 'codex':
      return stamp(readCodexUsage({ codexHome: seat.home || defaultCodexHome(), ...opts }));
    case 'claude':
      // A Claude seat reads the credential its own home implies. Ignoring
      // seat.home made every Claude seat report the same account, so a "work"
      // seat would display the personal subscription's quota under a work label.
      return stamp(await readClaudeUsage({ ...opts, home: seat.home ?? null }));
    case 'grok':
      // The weekly quota comes from the CLI over its agent protocol, so this is
      // async and credential-requiring; activity alone would be readGrokUsage.
      return stamp(await readGrokSeat({ grokHome: seat.home || defaultGrokHome(), ...opts }));
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
export async function snapshot({ file = registryPath(), seats, snapshotFile, ...opts } = {}) {
  const list = seats ?? loadSeats(file).seats;

  // The previous snapshot, so a transient failure does not erase a number we
  // already had.
  const stored = readSnapshot(snapshotFile ?? snapshotPath());
  const priorById = new Map((stored?.seats || []).map((s) => [s.seatId, s]));

  const results = await Promise.all(list.map(async (seat) => {
    let fresh;
    try { fresh = await readSeat(seat, opts); }
    catch (e) {
      fresh = { seatId: seat.id, label: seat.label, vendor: seat.vendor,
                ok: false, windows: [], observedAt: null, reason: `reader threw: ${e.message}` };
    }

    const prior = priorById.get(seat.id);
    const sameVendor = prior && prior.vendor === seat.vendor;

    // Carry the last GOOD reading forward, not merely the last one. Latching
    // onto `prior.ok` alone loses the number permanently as soon as one failure
    // overwrites the snapshot — which is exactly why Claude vanished the moment
    // you pressed Refresh while the endpoint was rate limiting.
    if (fresh.ok) return { ...fresh, lastGood: { windows: fresh.windows, observedAt: fresh.observedAt } };

    if (fresh.rateLimited && sameVendor) {
      const lastGood = prior.lastGood
        ?? (prior.ok && prior.windows?.length ? { windows: prior.windows, observedAt: prior.observedAt } : null);
      if (lastGood?.windows?.length) {
        // Carry the descriptive fields too, or a held-over reading loses its
        // plan/tier label and the card reads as a different, lesser seat.
        return { ...fresh, ok: true, windows: lastGood.windows, observedAt: lastGood.observedAt,
                 planType: fresh.planType ?? prior.planType ?? null,
                 subscriptionType: fresh.subscriptionType ?? prior.subscriptionType ?? null,
                 credits: fresh.credits ?? prior.credits ?? null,
                 lastGood, staleReason: fresh.reason };
      }
    }
    return sameVendor && prior?.lastGood ? { ...fresh, lastGood: prior.lastGood } : fresh;
  }));
  // Fingerprint accounts and demote duplicates. Imported dynamically so the
  // studio process — which only ever calls renderSnapshot — never loads the one
  // module that opens auth.json.
  try {
    const { fingerprintFor, markDuplicates } = await import('./identity.js');
    for (let i = 0; i < results.length; i++) {
      results[i].accountFingerprint = fingerprintFor(list[i]);
    }
    markDuplicates(results);
  } catch { /* identity is an enhancement; a snapshot without it is still valid */ }

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

/**
 * Vendors whose headroom can be read without any credential.
 *
 * Grok is NOT here: its weekly quota comes from the CLI over the agent
 * protocol, using credentials the studio must not handle. Its reading is taken
 * by the acs-usage CLI and rendered here from the snapshot, like Claude's.
 */
export const CREDENTIAL_FREE = new Set(['codex']);

/**
 * A snapshot for the web app: the stored reading, with credential-free seats
 * re-read live so they are never stale. Claude keeps the CLI's reading and
 * carries its age so the UI can say how old it is rather than implying it is now.
 */
export async function renderSnapshot({ file = registryPath(), snapshotFile = snapshotPath() } = {}) {
  const stored = readSnapshot(snapshotFile);
  const registered = loadSeats(file).seats;
  const byId = new Map((stored?.seats || []).map((s) => [s.seatId, s]));

  // A seat's home is only recorded once a reader fills it in, so an entry
  // registered without one still refers to the vendor default. Comparing the
  // raw fields makes those look like different accounts and drops the reading.
  const resolvedHome = (vendor, home) => {
    if (home) return path.resolve(home);
    if (vendor === 'codex') return path.resolve(defaultCodexHome());
    if (vendor === 'grok') return path.resolve(defaultGrokHome());
    return null;
  };

  const seats = await Promise.all(registered.map(async (seat) => {
    const priorEntry = byId.get(seat.id);
    // Duplicate marking is computed by the CLI, which is the only thing that
    // can read account identity. A live re-read must not silently drop it, or
    // the demoted seat comes back to life and wins the routing line again.
    const dup = priorEntry && priorEntry.vendor === seat.vendor && priorEntry.duplicateOf
      ? { duplicateOf: priorEntry.duplicateOf, ok: false, windows: [], reason: priorEntry.reason }
      : null;

    if (CREDENTIAL_FREE.has(seat.vendor)) {
      try {
        const live = { ...(await readSeat(seat)), readingAge: 0 };
        return dup ? { ...live, ...dup } : live;
      } catch { /* fall through to stored */ }
    }
    const prior = priorEntry;
    // Match on vendor and home too. Ids are derived from the label, so removing
    // a Claude seat called "Work" and adding a Grok seat called "Work" reuses
    // the id — and matching by id alone would render the old Claude quota under
    // the new Grok seat.
    const sameSeat = prior && prior.vendor === seat.vendor &&
      resolvedHome(prior.vendor, prior.home) === resolvedHome(seat.vendor, seat.home);
    if (sameSeat) {
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
/**
 * Single-quote a path for a shell command.
 *
 * A home under "/Users/Alex Smith" produced a command that silently split on
 * the space, so the instructions handed to the user could not work.
 */
export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * An id that collides with neither a registered seat NOR a seat directory left
 * behind by an earlier removal.
 *
 * Removal deliberately preserves the home, so considering only the registry
 * hands back an id whose directory already exists and createCodexHome throws —
 * making a removed seat permanently unaddable under its own name.
 */
export function uniqueSeatId(base, file = registryPath(), home = os.homedir()) {
  const taken = new Set(loadSeats(file).seats.map((s) => s.id));
  let dirs = [];
  try { dirs = fs.readdirSync(seatHomeRoot(home)); } catch { /* none yet */ }
  const used = (id) => taken.has(id) || dirs.includes(id);
  if (!used(base)) return base;
  let n = 2;
  while (used(`${base}-${n}`)) n++;
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
  const id = uniqueSeatId(slugify(label, 'codex'), file, home);
  const primaryHome = primary || process.env.CODEX_HOME || path.join(home, '.codex');
  const seatHome = path.join(seatHomeRoot(home), id);

  // uniqueSeatId already skips ids whose directory exists, so reaching here
  // with one present means something raced us.
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
  return { seat, linked, loginCommand: `CODEX_HOME=${shellQuote(seatHome)} codex login` };
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
    const anyCodexSeat = seats.some((s) => s.vendor === 'codex');
    // Adopt ~/.codex only on a machine with NO codex seat yet — not merely
    // whenever no seat currently claims it.
    //
    // The stricter rule exists because ~/.codex has writers a seat cannot
    // control: the ChatGPT desktop app runs its own codex against it, and any
    // long-lived process refreshes tokens back into it. Once someone has
    // deliberately moved a subscription into a private home, re-adopting the
    // shared one for the NEXT seat silently undoes that — the seat looks
    // registered, needs no login, and then changes account underneath them.
    // Adopting on a fresh machine is still right: it is the home a plain
    // `codex` uses, so the first seat must be it or the tracked seat stays
    // empty forever.
    if (!anyCodexSeat && fs.existsSync(primaryHome)) {
      const seat = { id: uniqueSeatId(slugify(clean, 'codex'), file, home), vendor, label: clean, home: primaryHome };
      addSeat(seat, file);
      return { seat, linked: [], loginCommand: null, adopted: true };
    }
    return createCodexHome({ label: clean, file, home });
  }

  // Claude resolves one credential per home, and there is exactly one default
  // home, so a second Claude seat without its own home would silently mirror
  // the first one's quota. Refuse it rather than display one account twice.
  if (vendor === 'claude') {
    const existing = loadSeats(file).seats.filter((s2) => s2.vendor === 'claude');
    if (existing.some((s2) => !s2.home)) {
      throw new Error(
        'a Claude seat is already tracked. Tracking a second Claude account needs its own ' +
        'CLAUDE_CONFIG_DIR, which is not supported yet — it would report the first account twice.');
    }
  }
  const seat = { id: uniqueSeatId(slugify(clean, vendor), file, home), vendor, label: clean };
  addSeat(seat, file);
  return {
    seat, linked: [], adopted: false,
    loginCommand: vendor === 'claude' ? null : null,
    note: vendor === 'grok'
      // Registering it is fine; be plain that it can never answer the routing
      // question, so nobody expects a percentage that will not come.
      ? 'Sign in with `grok login` if you have not already — the weekly quota is read through the Grok CLI.'
      : null,
  };
}
