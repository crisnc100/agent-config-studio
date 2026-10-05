import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readCodexSeat, defaultCodexHome } from './codex.js';
import { readClaudeUsage } from './claude.js';
import { readGrokUsage, readGrokSeat, defaultGrokHome } from './grok.js';
import { realpathNearest } from '../paths.js';

/** Where a home really is: an alias ($CODEX_HOME through a link) is the same home. */
const sameHome = (a, b) => { try { return realpathNearest(a) === realpathNearest(b); } catch { return path.resolve(a) === path.resolve(b); } };

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

/**
 * The shared Codex home — always ~/.codex literally, never $CODEX_HOME.
 *
 * This is the directory the ChatGPT desktop app and every bare `codex` use, and
 * the question "is this seat parked in the shared one" is about that fixed
 * location. Reading $CODEX_HOME here inverts the answer: the generated shell
 * file exports CODEX_HOME for the default seat, so a studio launched from such
 * a shell would call an already-private home "shared" — offering to move it
 * again, orphaning its credential — while a seat genuinely sitting in ~/.codex
 * would no longer be detected at all.
 */
/** The account-state file beside a given registry. */
const accountsPathFor = (registryFile) =>
  path.join(path.dirname(registryFile), 'accounts.json');

export const sharedCodexHome = (home = os.homedir()) => path.join(home, '.codex');
export const isSharedCodexHome = (dir, home = os.homedir()) => {
  try { return path.resolve(dir) === path.resolve(sharedCodexHome(home)); } catch { return false; }
};

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
    else if (existing.some((s) => s.vendor === 'codex' && s.home && sameHome(s.home, seat.home))) {
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
 * subscriptions someone holds is worse than asking. Evidence is a home with
 * sessions, a non-empty credential file (stat only), or — when the caller
 * passes `binaries` — the CLI being installed at all: on a brand-new machine
 * that is the only evidence there is.
 */
export function detectSeats({ home = os.homedir(), env = process.env, binaries = {} } = {}) {
  const found = [];
  const signedIn = (dir) => { try { return fs.statSync(path.join(dir, 'auth.json')).size > 0; } catch { return false; } };
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  if (fs.existsSync(path.join(codexHome, 'sessions')) || signedIn(codexHome) || binaries.codex) {
    found.push({ id: 'codex-1', vendor: 'codex', label: 'Codex (primary)', home: codexHome });
  }
  const hasClaude = fs.existsSync(path.join(home, '.claude')) || binaries.claude;
  if (hasClaude) found.push({ id: 'claude-1', vendor: 'claude', label: 'Claude' });
  const grokHome = env.GROK_HOME || path.join(home, '.grok');
  if (fs.existsSync(path.join(grokHome, 'sessions')) || signedIn(grokHome) || binaries.grok) {
    found.push({ id: 'grok-1', vendor: 'grok', label: 'Grok', home: grokHome });
  }
  return found;
}

/** The home a seat really reads — its own, or its vendor's default — where it really is. */
const seatHome = (vendor, dir, home) => {
  const at = dir || (vendor === 'codex' ? path.join(home, '.codex') : vendor === 'grok' ? path.join(home, '.grok') : null);
  if (!at) return null;
  try { return realpathNearest(at); } catch { return path.resolve(at); }
};

/**
 * detectSeats for the setup screen: each suggestion keyed by vendor, marked
 * `added` when a registered seat already reads that home. The shared ~/.codex
 * is not offered once this machine has split its Codex seats — the same rule
 * createSeat and `acs-usage detect` keep.
 */
export function suggestSeats({ home = os.homedir(), env = process.env, binaries = {}, file = registryPath() } = {}) {
  const { seats } = loadSeats(file);
  const everSplit = (() => { try { return fs.readdirSync(seatHomeRoot(home)).length > 0; } catch { return false; } })();
  const split = seats.some((x) => x.vendor === 'codex') || everSplit;
  return detectSeats({ home, env, binaries }).map((sg) => {
    const where = seatHome(sg.vendor, sg.home, home);
    const match = seats.find((x) => x.vendor === sg.vendor && (sg.vendor === 'claude' ? !x.home : seatHome(x.vendor, x.home, home) === where));
    return { key: sg.vendor, vendor: sg.vendor, label: sg.label, home: sg.home ?? null, added: Boolean(match), seatId: match?.id ?? null };
  }).filter((sg) => sg.added || !(sg.vendor === 'codex' && split && isSharedCodexHome(sg.home, home)));
}

/**
 * Register exactly the home a suggestion detected — `key` names a suggestion
 * this machine produces now, never a path from the caller. Adding one that is
 * already registered returns that seat and writes nothing. A detected codex
 * home that does not exist yet is created (0700), since signing in needs it.
 */
export function addSuggestedSeat({ key, label, home = os.homedir(), env = process.env, binaries = {}, file = registryPath() }) {
  const sg = suggestSeats({ home, env, binaries, file }).find((x) => x.key === key);
  if (!sg) throw new Error(`nothing to add for "${key}" — it is not a suggestion on this machine`);
  if (sg.added) return { seat: loadSeats(file).seats.find((x) => x.id === sg.seatId), already: true };
  const clean = String(label ?? '').trim().slice(0, 60) || sg.label;
  const seat = { id: uniqueSeatId(slugify(clean, sg.vendor), file, home), vendor: sg.vendor, label: clean };
  if (sg.home) {
    if (sg.vendor === 'codex') fs.mkdirSync(sg.home, { recursive: true, mode: 0o700 });
    seat.home = sg.home;
  }
  addSeat(seat, file);
  return { seat, already: false };
}

/** Read one seat's headroom. Unknown vendors report, never throw. */
export async function readSeat(seat, opts = {}) {
  const stamp = (r) => ({ ...r, seatId: seat.id, label: seat.label, vendor: seat.vendor });
  switch (seat.vendor) {
    case 'codex':
      // The live quota comes from the CLI over its app-server protocol, so this
      // is async and credential-requiring; the logs alone would be readCodexUsage.
      return stamp(await readCodexSeat({ codexHome: seat.home || defaultCodexHome(), ...opts }));
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
export async function snapshot({ file = registryPath(), seats, snapshotFile, accountsFile, ...opts } = {}) {
  const list = seats ?? loadSeats(file).seats;
  // Account state is persisted ONLY for the real registry. A caller that hands
  // in its own seat list is asking "what would these read", not declaring what
  // this machine tracks — and persisting that prunes every fingerprint for the
  // seats it did not mention. That is how the test suite silently reset the
  // user's real account state.
  const persistAccounts = Boolean(accountsFile) || seats === undefined;

  // The previous snapshot, so a transient failure does not erase a number we
  // already had.
  const stored = readSnapshot(snapshotFile ?? snapshotPath(path.dirname(file)));
  const priorById = new Map((stored?.seats || []).map((s) => [s.seatId, s]));

  // Resolve each seat's account BEFORE reading it: a codex reading has to know
  // when this seat's current login began, and the only honest answer is when
  // its account fingerprint last changed. Imported dynamically so the studio
  // process — which only ever calls renderSnapshot — never loads the one module
  // that opens auth.json.
  let accountState = new Map();
  let fingerprints = new Map();
  try {
    const { fingerprintFor } = await import('./identity.js');
    const { reconcile } = await import('./accounts.js');
    for (const seat of list) fingerprints.set(seat.id, fingerprintFor(seat));
    accountState = reconcile(list, fingerprints, {
      // Derived from the registry's own directory, the same way the snapshot
      // file is (line 111). Defaulting to the real ~/.agent-config-studio meant
      // any caller passing an explicit `seats` list — every test that did so —
      // wrote and pruned the user's real account state. A snapshot of seats
      // that are not the registry's must not persist as if they were.
      file: accountsFile ?? accountsPathFor(file),
      persist: persistAccounts,
      // Day one for a seat: no previous account to have moved away from, so
      // auth.json's mtime is the best available baseline — and the only moment
      // it is trustworthy, since nothing has refreshed against it yet.
      fallbackFor: (seat) => {
        if (!seat.home) return null;
        try { return fs.statSync(path.join(seat.home, 'auth.json')).mtimeMs; } catch { return null; }
      },
    });
  } catch { /* identity is an enhancement; a snapshot without it is still valid */ }

  const results = await Promise.all(list.map(async (seat) => {
    let fresh;
    const account = accountState.get(seat.id);
    const seatOpts = Number.isFinite(account?.since) ? { ...opts, signedInAt: account.since } : opts;
    try { fresh = await readSeat(seat, seatOpts); }
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
  // Stamp the fingerprints resolved above and demote seats sharing an account.
  try {
    const { markDuplicates } = await import('./identity.js');
    for (let i = 0; i < results.length; i++) {
      const seat = list[i];
      const account = accountState.get(seat.id);
      results[i].accountFingerprint = fingerprints.get(seat.id) ?? null;
      results[i].signedInAt = account?.since ?? null;
      // Flag a seat still parked in the shared ~/.codex. It is not broken, but
      // its account can be changed by things outside this app, so the panel
      // offers the migration rather than waiting for that to happen.
      if (seat.vendor === 'codex' && seat.home) results[i].sharedHome = isSharedCodexHome(seat.home);
      // A seat whose account changed under it is worth saying out loud: it is
      // either a deliberate re-auth or something else rewriting that home, and
      // the second case is how a subscription gets spent unnoticed.
      if (account?.changed) results[i].accountChanged = true;
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
    // The HOME must match too, not just the vendor: after a move the seat is a
    // different (empty, signed-out) folder, and carrying the old home's
    // duplicate demotion would keep it demoted for an account it no longer has.
    const priorSameHome = priorEntry && priorEntry.vendor === seat.vendor
      && resolvedHome(priorEntry.vendor, priorEntry.home) === resolvedHome(seat.vendor, seat.home);
    const dup = priorSameHome && priorEntry.duplicateOf
      ? { duplicateOf: priorEntry.duplicateOf, ok: false, windows: [], reason: priorEntry.reason }
      : null;

    // Carried from the stored reading because only the CLI can compute them —
    // it is the one process allowed to read account identity. A live re-read
    // that dropped these would undo them entirely in the UI: the seat would
    // fall back to auth.json mtime for its sign-in (the bug this branch
    // removes), and the migration button and account-changed warning could
    // never render at all.
    // ...but ONLY while the credential has not moved since the CLI looked. If
    // auth.json changed after the snapshot was taken, the account may have
    // changed too, and this process cannot tell — it is not allowed to read
    // account identity. Carrying the old sign-in moment then lets the PREVIOUS
    // account's readings pass the filter and be shown under the new one, which
    // is the whole failure this branch exists to prevent. Falling back to mtime
    // may blank the seat until the next CLI run; showing the wrong pool's
    // headroom is the worse of the two, because it is not visibly wrong.
    const credentialMovedSince = (() => {
      if (!seat.home || !stored?.takenAt) return true;
      try { return fs.statSync(path.join(seat.home, 'auth.json')).mtimeMs > stored.takenAt; }
      catch { return false; }          // no credential to have moved
    })();
    const carried = priorSameHome && !credentialMovedSince ? {
      accountFingerprint: priorEntry.accountFingerprint ?? null,
      signedInAt: priorEntry.signedInAt ?? null,
      accountChanged: priorEntry.accountChanged ?? false,
    } : {};
    // Say WHY the reading is being withheld. Falling back to mtime here is the
    // steady state on a shared home — several long-lived processes refresh the
    // credential on their own schedules — so without this the seat renders a
    // bare "no turn has run since signing in", which is both wrong and
    // indistinguishable from a genuinely unused seat.
    if (credentialMovedSince && priorSameHome && seat.vendor === 'codex') {
      carried.staleCredential = true;
    }
    // sharedHome needs no credential, so compute it live rather than carrying a
    // stale answer across a move.
    if (seat.vendor === 'codex' && seat.home) carried.sharedHome = isSharedCodexHome(seat.home);

    if (CREDENTIAL_FREE.has(seat.vendor)) {
      try {
        const live = {
          ...(await readSeat(seat, Number.isFinite(carried.signedInAt)
            ? { signedInAt: carried.signedInAt } : {})),
          readingAge: 0,
        };
        const merged = { ...live, ...carried, ...(dup || {}) };
        if (merged.staleCredential && !merged.ok) {
          merged.reason = 'this seat\'s sign-in changed since the last reading — press Refresh ' +
            'to re-check it (only the usage CLI can tell which account it belongs to)';
        }
        return merged;
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
      return { ...prior, ...carried, readingAge: stored?.takenAt ? Date.now() - stored.takenAt : null };
    }
    return {
      seatId: seat.id, label: seat.label, vendor: seat.vendor, ok: false, windows: [],
      observedAt: null, readingAge: null, ...carried,
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
  const primaryHome = primary || sharedCodexHome(home);
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
 * Move a seat out of the shared ~/.codex into a private home of its own.
 *
 * The migration that was previously a sequence of terminal commands, and the
 * one the user actually needs: ~/.codex has writers a seat cannot control —
 * the ChatGPT desktop app runs its own codex against it, and any long-lived
 * process refreshes tokens back into it — so a subscription parked there gets
 * silently re-pointed at whatever account last wrote. A private home has
 * exactly one writer.
 *
 * Credentials are NOT copied. The new home starts signed out and the user signs
 * it in from the panel; copying auth.json would put a refresh token in a second
 * place on disk to save one click.
 */
export function moveSeatToPrivateHome({ id, file = registryPath(), home = os.homedir() }) {
  const { seats } = loadSeats(file);
  const seat = seats.find((s) => s.id === id);
  if (!seat) throw new Error(`no seat with id "${id}"`);
  if (seat.vendor !== 'codex') throw new Error('only codex seats have a home to move');

  const sharedHome = sharedCodexHome(home);
  if (!seat.home || !isSharedCodexHome(seat.home, home)) {
    throw new Error('this seat already has a private home');
  }

  const dest = path.join(seatHomeRoot(home), uniqueSeatId(`${seat.id}-private`, file, home));
  if (fs.existsSync(dest)) throw new Error(`${dest} already exists`);
  fs.mkdirSync(dest, { recursive: true });

  // Shared: configuration and instructions. NOT auth.json, NOT sessions.
  const linked = [];
  for (const name of ['config.toml', 'AGENTS.md', 'skills', 'rules', 'plugins']) {
    const src = path.join(sharedHome, name);
    if (!fs.existsSync(src)) continue;
    try { fs.symlinkSync(src, path.join(dest, name)); linked.push(name); } catch { /* optional */ }
  }

  // Repoint rather than remove-and-add: removing would leave ~/.codex
  // unclaimed, and an unclaimed shared home is what the next seat adopts.
  saveSeats(seats.map((s) => (s.id === id ? { ...s, home: dest } : s)), file);
  return { seat: { ...seat, home: dest }, linked, movedFrom: sharedHome, needsLogin: true };
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
    // Literal ~/.codex, never $CODEX_HOME: our own generated shell file exports
    // CODEX_HOME, so reading it here would adopt a private seat home.
    const primaryHome = sharedCodexHome(home);
    // "No codex seat" is not the same as "fresh machine". Removing a seat
    // preserves its private home, so someone who split their seats and then
    // removed one to rename it would be dropped straight back into the shared
    // home with no login prompt — the trap this guard exists for. Any existing
    // private home is evidence this machine has already been split.
    const everSplit = (() => {
      try { return fs.readdirSync(seatHomeRoot(home)).length > 0; } catch { return false; }
    })();
    const anyCodexSeat = seats.some((s) => s.vendor === 'codex') || everSplit;
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
