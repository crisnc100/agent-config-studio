import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as history from './history.js';
import { readUserText, openUserFile, tilde } from './paths.js';
import { ID_RE, familiesPath, familyEntryProblem, homeDir, lintScope, loadRegistry, userPath } from './models.js';
import { loadRoles, readPaused } from './roles.js';
import {
  agyModelsPath, codexCatalogStamps, codexHomeList, compareVersions, detect, planSync, readCatalogs, semver, shownHome, vendorLabel, vendorOf,
} from './models-catalog.js';
import { insertMember, member, removeMember, replaceValue, scan } from './jsontext.js';

/**
 * The Models panel's writes: one registry key at a time, and the sidecar
 * edits that follow from it. Every write is atomic, goes through the shadow
 * history repo like any other studio edit, and touches only the bytes it
 * names.
 */

const bad = (status, message) => Object.assign(new Error(message), { status });

export const dismissedPath = (home = homeDir()) => path.join(home, '.agent-config-studio', 'models-dismissed.json');

/** Write through a symlink to its target, via temp + rename, so a crash never truncates. */
async function writeAtomic(file, text) {
  let target = file;
  try { target = fs.realpathSync(file); } catch { /* new file */ }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  let mode;
  try { mode = fs.statSync(target).mode & 0o777; } catch { mode = 0o644; }
  await fsp.writeFile(tmp, text, { mode });
  await fsp.rename(tmp, target);
  return fs.statSync(target).mtimeMs;
}

/** Baseline, write, record — the same sequence PUT /api/file uses. */
async function recordedWrite(file, text, message) {
  if (fs.existsSync(file)) {
    await history.recordBaseline(file, `state of ${tilde(file)} before edit`).catch(() => {});
  }
  const mtime = await writeAtomic(file, text);
  let sha = null, historyError = null;
  try { sha = await history.record(file, message); } catch (e) { historyError = e.message; }
  return { mtime, sha, historyError };
}

/** Families the user file names, or none when it is missing or broken. */
export function userOverrides(home = homeDir()) {
  try {
    const doc = JSON.parse(fs.readFileSync(userPath(home), 'utf8'));
    return doc && typeof doc.models === 'object' && doc.models ? Object.keys(doc.models) : [];
  } catch { return []; }
}

export function readDismissed(home = homeDir()) {
  try {
    const doc = JSON.parse(fs.readFileSync(dismissedPath(home), 'utf8'));
    return doc && typeof doc.families === 'object' && doc.families ? doc.families : {};
  } catch { return {}; }
}

export async function dismiss({ family, id, key, home = homeDir() }) {
  const families = readDismissed(home);
  const prev = families[family];
  families[family] = prev && prev.id === id && Array.isArray(prev.keys)
    ? { id, keys: [...new Set([...prev.keys, key])] }
    : { id, keys: [key] };
  await writeAtomic(dismissedPath(home), JSON.stringify({ version: 1, families }, null, 2) + '\n');
  return families[family];
}

const REFRESH_FRESH_MS = 3600 * 1000;

/**
 * Ask Codex to refresh every home's catalog, then say which homes it did not
 * refresh and why, or null when it refreshed them all. A home counts as
 * refreshed when its catalog was re-stamped, or was left alone while already
 * under an hour old and from this CLI's version: Codex skips a catalog it
 * fetched moments ago, and a signed-out home answers without rewriting anything.
 */
async function refreshCodexHomes(homes, refreshCodex, home) {
  const before = codexCatalogStamps(homes);
  let results;
  try { results = await refreshCodex(homes); } catch (e) { results = homes.map(() => ({ ok: false, reason: e.message })); }
  const after = codexCatalogStamps(homes);
  const byReason = new Map();
  homes.forEach((h, i) => {
    const r = results?.[i] || { ok: false, reason: 'no answer from the refresh' };
    let reason = r.ok ? null : r.reason;
    const was = before[i], now = after[i];
    const restamped = !!now && (!was || was.at !== now.at || was.version !== now.version);
    if (r.ok && !restamped) {
      const cli = semver(r.cliVersion), have = semver(now?.version);
      if (!now) reason = 'Codex answered but wrote no catalog — is this home signed in?';
      else if (cli && (!have || compareVersions(have, cli) < 0)) {
        reason = `Codex ${cli.join('.')} answered but left the catalog from Codex ${now.version ?? '(unknown version)'} — is this home signed in?`;
      } else if (now.at == null || Date.now() - now.at > REFRESH_FRESH_MS) {
        reason = 'Codex answered but left a catalog over an hour old — is this home signed in?';
      }
    }
    if (reason) byReason.set(reason, [...(byReason.get(reason) || []), shownHome(h, home)]);
  });
  if (!byReason.size) return null;
  return `Not refreshed: ${[...byReason].map(([reason, hs]) => `${hs.join(', ')} (${reason})`).join('; ')}. ` +
    'Shown as last fetched.';
}

/**
 * Ask agy for its Gemini models and save them as ACS's Antigravity list; the
 * note to show when that did not happen, or null. A failed ask leaves the
 * saved list as it was: an empty or partial answer must not make every
 * Antigravity family look gone.
 */
async function refreshAgyList(readModels, home) {
  const file = agyModelsPath(home);
  const kept = () => (fs.existsSync(file) ? ' Shown as last fetched.' : '');
  let r;
  try { r = await readModels(); } catch (e) { r = { ok: false, reason: e.message }; }
  if (!r?.ok || !Array.isArray(r.models)) return `Not refreshed: ${r?.reason || 'no answer from agy'}.${kept()}`;
  const doc = {
    version: 1,
    fetchedAt: Date.now(),
    agyVersion: typeof r.agyVersion === 'string' ? r.agyVersion : null,
    models: r.models.map(({ id, displayName, efforts }) => ({ id, displayName, efforts })),
  };
  try { await writeAtomic(file, JSON.stringify(doc, null, 2) + '\n'); }
  catch (e) { return `Not saved: ${e.code || e.message}.${kept()}`; }
  return null;
}

/**
 * Catalog state: read at server start and on "Check now", never on a timer.
 * Alerts are derived per request from it, so an edit shows at once. Only
 * "Check now" (`refresh`) first has Codex refresh its catalogs and asks agy
 * for its models, the two side by side.
 */
export function createModelsState({ detectFn, codexHomes, refreshCodex = null, refreshAgy = null, home = homeDir() }) {
  let state = null;
  let pending = null;
  // One refresh at a time: a second "Check now" while one runs (another tab)
  // shares it, so the per-home cap holds across requests.
  let refreshing = null;
  const check = ({ refresh = false } = {}) => {
    if (refresh && refreshing) return refreshing;
    const run = (async () => {
      const seatHomes = codexHomes();
      const [refreshNote, agyNote] = await Promise.all([
        refresh && refreshCodex ? refreshCodexHomes(codexHomeList({ home, codexHomes: seatHomes }), refreshCodex, home) : null,
        refresh && refreshAgy ? refreshAgyList(refreshAgy, home) : null,
      ]);
      let claudeVersion = null;
      try { claudeVersion = (await detectFn()).find((h) => h.id === 'claude')?.version ?? null; } catch {}
      const catalogs = readCatalogs({ home, codexHomes: seatHomes });
      catalogs.codex.refreshNote = refreshNote;
      catalogs.agy.refreshNote = agyNote;
      // Before `state` is set, so no view shows an alert the sync has already settled. A sync that fails must not
      // fail the check: current() would keep handing out the rejection, and the Models page would stay broken.
      let sync;
      try {
        const { historyError: _h, ...done } = await syncFamilies({ catalogs, claudeVersion, home });
        sync = done;
      } catch (e) {
        sync = { at: Date.now(), added: [], moved: [], skipped: [], error: `The sync from the model lists failed: ${e.message}` };
      }
      state = { catalogs, claudeVersion, checkedAt: Date.now(), sync };
      return state;
    })();
    pending = run;
    if (refresh) {
      refreshing = run;
      run.finally(() => { if (refreshing === run) refreshing = null; }).catch(() => {});
    }
    return run;
  };
  const current = () => (state ? Promise.resolve(state) : pending || check());
  const view = async () => {
    const s = await current();
    const reg = loadRegistry({ home });
    const { rows, pending: count } = detect({
      registry: reg.registry, defaults: reg.defaults, catalogs: s.catalogs,
      overrides: reg.error ? [] : userOverrides(home), synced: Object.keys(reg.userFamilies || {}), claudeVersion: s.claudeVersion,
      dismissed: readDismissed(home),
    });
    const held = heldBy(home);
    for (const r of rows) {
      if (r.source !== 'synced') continue;
      const cat = r.vendor ? s.catalogs[r.vendor] : null;
      // Whether its list still offers the word: Remove is offered only when it does not, or the next sync adds it back.
      r.offered = cat?.ok ? cat.models.some((m) => !m.hidden && m.family === r.family) : null;
      r.heldBy = held ? held.get(r.family) || [] : null;
    }
    return {
      rows,
      pending: count,
      registryError: reg.error,
      familiesError: reg.familiesError ?? null,
      familiesHidden: reg.familiesHidden || {},
      sync: s.sync ?? null,
      // Antigravity's names go out too: its list is short, and agy is the one CLI whose list the user sees nowhere else.
      catalogs: Object.values(s.catalogs).map(({ models, ...c }) => ({
        ...c, count: models.length, ...(c.vendor === 'agy' ? { names: models.map((m) => m.displayName || m.id) } : {}),
      })),
      claudeVersion: s.claudeVersion,
      checkedAt: s.checkedAt,
    };
  };
  return { check, current, view };
}

/* ── registry edits ────────────────────────────────────────────────────── */

function editable(home) {
  const reg = loadRegistry({ home });
  if (reg.error) throw bad(409, `The model registry file is invalid, so edits are refused until it is fixed: ${reg.error}`);
  return reg;
}

/** Everything about an id that needs a second look before it is written. */
export function warningsFor({ family, id, old, catalogs, claudeVersion }) {
  const out = [];
  const vendor = vendorOf(id);
  const was = vendorOf(old);
  if (!vendor) out.push(`${id} does not look like a Claude, Codex, Grok or Gemini id.`);
  else if (vendor !== was) out.push(`This moves ${family} from ${was ? vendorLabel(was) : 'its current vendor'} to ${vendorLabel(vendor)}.`);
  const cat = vendor ? catalogs[vendor] : null;
  if (cat && !cat.ok) out.push(`There is no ${vendorLabel(vendor)} catalog to check ${id} against.`);
  else if (cat) {
    const entry = cat.models.find((m) => m.id === id);
    if (!entry) out.push(`${id} is not in the ${vendorLabel(vendor)} catalog.`);
    else if (semver(entry.minCliVersion)) {
      const have = semver(claudeVersion);
      if (!have || compareVersions(have, semver(entry.minCliVersion)) < 0) {
        out.push(`${id} needs Claude Code ≥ ${entry.minCliVersion}${have ? ` (installed ${have.join('.')})` : ''}.`);
      }
    }
  }
  return out;
}

const FRESH = (family, id) => `{\n  "version": 1,\n  "models": {\n    ${JSON.stringify(family)}: ${JSON.stringify(id)}\n  }\n}\n`;

/** The user file with exactly `models.<family>` set, every other byte kept. */
export function withModel(text, family, id) {
  if (text === null) return FRESH(family, id);
  let root = scan(text);
  let models = member(root, 'models');
  if (!models) {
    text = insertMember(text, root, 'models', '{}');
    root = scan(text);
    models = member(root, 'models');
  }
  const m = member(models.value, family);
  return m ? replaceValue(text, m, JSON.stringify(id)) : insertMember(text, models.value, family, JSON.stringify(id));
}

export function withoutModel(text, family) {
  const root = scan(text);
  const models = member(root, 'models');
  const m = models && member(models.value, family);
  return m ? removeMember(text, models.value, m) : null;
}

/** `pin` is for a typed id: on a families.json family it also pins, or the next sync could move it on. Accept never pins. */
export async function setModel({ family, id, confirm = false, pin = false, catalogs, claudeVersion, home = homeDir() }) {
  if (typeof family === 'string' && Object.hasOwn(loadRegistry({ home }).userFamilies || {}, family)) {
    return setAddedModel({ family, id, confirm, pin, catalogs, claudeVersion, home });
  }
  const reg = editable(home);
  if (typeof family !== 'string' || !Object.hasOwn(reg.defaults.models, family)) throw bad(400, `unknown model family "${family}"`);
  if (typeof id !== 'string' || !ID_RE.test(id)) throw bad(400, `${JSON.stringify(id)} is not a valid model id`);
  const old = reg.registry.models[family];
  if (id === old) return { saved: false, unchanged: true, family, id };
  const warnings = warningsFor({ family, id, old, catalogs, claudeVersion });
  if (warnings.length && confirm !== true) return { saved: false, needsConfirm: true, warnings, family, id };

  const file = userPath(home);
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const after = withModel(before, family, id);
  JSON.parse(after);
  const w = await recordedWrite(file, after, `models: ${family} ${old} → ${id}`);
  return { saved: true, family, id, old, ...w, sidecars: sidecarProposals({ from: old, to: id, home }) };
}

export async function resetModel({ family, home = homeDir() }) {
  if (typeof family === 'string' && Object.hasOwn(loadRegistry({ home }).userFamilies || {}, family)) {
    throw bad(400, `${family} lives in families.json, so it has no shipped id to reset to.`);
  }
  const reg = editable(home);
  if (typeof family !== 'string' || !Object.hasOwn(reg.defaults.models, family)) throw bad(400, `unknown model family "${family}"`);
  const file = userPath(home);
  if (!fs.existsSync(file)) return { saved: false, unchanged: true, family };
  const after = withoutModel(fs.readFileSync(file, 'utf8'), family);
  if (after === null) return { saved: false, unchanged: true, family };
  const old = reg.registry.models[family];
  const id = reg.defaults.models[family];
  const w = await recordedWrite(file, after, `models: ${family} reset to default`);
  return { saved: true, family, id, old, ...w, sidecars: old === id ? [] : sidecarProposals({ from: old, to: id, home }) };
}

/* ── families synced from the CLIs' model lists (families.json) ────────── */

// One families.json edit at a time, read to write: two tabs adding at once must not drop either entry.
let familiesQueue = Promise.resolve();
function serialized(fn) {
  const run = familiesQueue.then(fn, fn);
  familiesQueue = run.then(() => {}, () => {});
  return run;
}

function familiesEditable(home) {
  const reg = loadRegistry({ home });
  if (reg.familiesError) throw bad(409, `families.json is invalid, so adding, changing or removing a family is refused until it is fixed: ${reg.familiesError}`);
  return reg;
}

const entryText = (id, addedAt) => `{ "id": ${JSON.stringify(id)}, "addedAt": ${JSON.stringify(addedAt)} }`;

/** families.json with `families.<name>` added, every other byte kept. */
export function withFamily(text, name, id, addedAt) {
  if (text === null) return `{\n  "version": 1,\n  "families": {\n    ${JSON.stringify(name)}: ${entryText(id, addedAt)}\n  }\n}\n`;
  const root = scan(text);
  return insertMember(text, member(root, 'families').value, name, entryText(id, addedAt));
}

/** families.json with `families.<name>.id` replaced. */
export function withFamilyId(text, name, id) {
  const entry = member(member(scan(text), 'families').value, name);
  return replaceValue(text, member(entry.value, 'id'), JSON.stringify(id));
}

/** families.json with the entry pinned (`"track": false`) or not (no `track` key: the default, which follows). */
export function withFamilyPin(text, name, pinned) {
  const entry = member(member(scan(text), 'families').value, name);
  const track = member(entry.value, 'track');
  if (pinned) return track ? replaceValue(text, track, 'false') : insertMember(text, entry.value, 'track', 'false');
  return track ? removeMember(text, entry.value, track) : text;
}

export function withoutFamily(text, name) {
  const families = member(scan(text), 'families').value;
  return removeMember(text, families, member(families, name));
}

/**
 * Edit families.json and write it, once the result parses back to what was meant. A file that names a family twice
 * is edited at its first entry but read at its last, and one changed by hand since it was read may no longer have
 * the entry: either is refused rather than written wrong.
 */
async function writeFamilies(home, edit, check, message) {
  const file = familiesPath(home);
  let after = null;
  let doc = null;
  try {
    after = edit(fs.existsSync(file) ? readUserText(file) : null);
    doc = JSON.parse(after);
  } catch { doc = null; }
  if (!doc || !check(doc.families || {})) {
    throw bad(409, `${tilde(file)} could not be edited safely (it changed since it was read, or names a family twice). Reload, or fix it by hand, then try again.`);
  }
  return recordedWrite(file, after, message);
}

/** Set (or Accept) a families.json family's id. Anything the read side would hide is refused outright, confirm or not. */
function setAddedModel({ family, id, confirm, pin, catalogs, claudeVersion, home }) {
  return serialized(async () => {
    const reg = familiesEditable(home);
    if (typeof id !== 'string' || !ID_RE.test(id)) throw bad(400, `${JSON.stringify(id)} is not a valid model id`);
    const current = reg.userFamilies[family];
    if (!current) throw bad(409, `${family} is no longer in families.json. Reload and try again.`);
    const old = current.id;
    if (id === old) return { saved: false, unchanged: true, family, id };
    const problem = familyEntryProblem(family, { id }, reg.defaults.models);
    if (problem) throw bad(400, `${family} lives in families.json, and ${id} would hide it there: ${problem}.`);
    const warnings = warningsFor({ family, id, old, catalogs, claudeVersion });
    if (warnings.length && confirm !== true) return { saved: false, needsConfirm: true, warnings, family, id };
    const edit = (text) => (pin ? withFamilyPin(withFamilyId(text, family, id), family, true) : withFamilyId(text, family, id));
    const wrote = (f) => f[family]?.id === id && (!pin || f[family].track === false);
    const w = await writeFamilies(home, edit, wrote, `families: ${family} ${old} → ${id}${pin ? ', pinned' : ''}`);
    return { saved: true, family, id, old, pinned: pin, ...w, sidecars: sidecarProposals({ from: old, to: id, home }) };
  });
}

/**
 * Family → where a role, a flavor or a pause names it, for every family at once; null when roles.json or
 * paused.json cannot be read, since then nobody can tell.
 */
export function heldBy(home = homeDir()) {
  const loaded = loadRoles({ home });
  const paused = readPaused({ home });
  if (loaded.error || paused.error) return null;
  const out = new Map();
  const add = (family, where) => { if (!out.has(family)) out.set(family, []); if (!out.get(family).includes(where)) out.get(family).push(where); };
  for (const [role, r] of Object.entries(loaded.roles)) {
    for (const m of r.members) add(m.family, `the ${role} role`);
    if (r.alt !== undefined && !r.members.some((m) => m.family === r.alt)) add(r.alt, `the ${role} role's second opinion`);
  }
  for (const family of Object.keys(loaded.flavor)) add(family, 'its flavor');
  for (const e of paused.entries) add(e.name, 'a pause');
  return out;
}

function namedBy(family, home) {
  const held = heldBy(home);
  return held && (held.get(family) || []);
}

/**
 * Pin a families.json family to its id, or let it follow its list again. A pin is what keeps sync from moving it;
 * an unpinned family nothing names moves at the next check.
 */
export function pinFamily({ family, pinned, home = homeDir() }) {
  return serialized(async () => {
    const reg = familiesEditable(home);
    if (typeof family !== 'string' || !Object.hasOwn(reg.userFamilies || {}, family)) {
      throw bad(400, `${JSON.stringify(family)} is not a family in families.json.`);
    }
    if (typeof pinned !== 'boolean') throw bad(400, 'pinned must be true or false');
    if (reg.userFamilies[family].track === !pinned) return { saved: false, unchanged: true, family, pinned };
    const wrote = (f) => (pinned ? f[family]?.track === false : !!f[family] && f[family].track === undefined);
    const w = await writeFamilies(home, (text) => withFamilyPin(text, family, pinned), wrote, `families: ${pinned ? 'pinned' : 'unpinned'} ${family}`);
    return { saved: true, family, pinned, id: reg.userFamilies[family].id, ...w };
  });
}

/** Remove a families.json family. Only families.json changes; anything still naming the family has to let go of it first. */
export function removeFamily({ family, home = homeDir() }) {
  return serialized(async () => {
    const reg = familiesEditable(home);
    if (typeof family !== 'string' || !Object.hasOwn(reg.userFamilies || {}, family)) {
      throw bad(400, `${JSON.stringify(family)} is not a family in families.json.`);
    }
    const named = namedBy(family, home);
    if (named === null) throw bad(409, `roles.json or paused.json is invalid, so ACS cannot tell whether anything names ${family}. Fix it first.`);
    if (named.length) throw bad(409, `${family} is still named by ${named.join(', ')}. Take it out there first.`);
    const id = reg.userFamilies[family].id;
    const w = await writeFamilies(home, (text) => withoutFamily(text, family), (f) => !Object.hasOwn(f, family), `families: removed ${family} (${id})`);
    return { saved: true, removed: family, id, ...w };
  });
}

const listed = (xs, f) => xs.map(f).join(', ');

/**
 * Bring families.json in line with the catalogs (planSync): add each word no family has, and move each unused,
 * unpinned family forward. One write, and only when something changes, so a restart with nothing new records
 * nothing. Returns what it did and what it left out, for the Models page.
 */
export function syncFamilies({ catalogs, claudeVersion = null, home = homeDir(), now = Date.now() }) {
  return serialized(async () => {
    const out = { at: now, added: [], moved: [], skipped: [], error: null };
    const reg = loadRegistry({ home });
    if (reg.familiesError) return { ...out, error: `families.json is invalid, so nothing was synced: ${reg.familiesError}` };
    const held = heldBy(home);
    const plan = planSync({ catalogs, reg, inUse: held && new Set(held.keys()), cli: semver(claudeVersion) });
    if (!plan.add.length && !plan.move.length) return { ...out, skipped: plan.skipped };
    const addedAt = new Date(now).toISOString();
    const edit = (text) => {
      let t = text;
      for (const a of plan.add) t = withFamily(t, a.family, a.id, addedAt);
      for (const m of plan.move) t = withFamilyId(t, m.family, m.to);
      return t;
    };
    const wrote = (f) => plan.add.every((a) => f[a.family]?.id === a.id) && plan.move.every((m) => f[m.family]?.id === m.to);
    const what = [
      plan.add.length ? `added ${listed(plan.add, (a) => `${a.family} (${a.id})`)}` : null,
      plan.move.length ? `moved ${listed(plan.move, (m) => `${m.family} ${m.from} → ${m.to}`)}` : null,
    ].filter(Boolean).join('; ');
    const w = await writeFamilies(home, edit, wrote, `families: synced — ${what}`);
    return { ...out, added: plan.add, moved: plan.move, skipped: plan.skipped, historyError: w.historyError };
  });
}

/* ── sidecars: computed from one edit (from → to), never a general scan ── */

const settingsPath = (home) => path.join(home, '.claude', 'settings.json');
const tomlPath = (home) => path.join(home, '.codex', 'config.toml');
const mtimeOf = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } };

/**
 * The line of config.toml's top-level `model = "<from>"`: before the first real
 * table header. A line that starts with `[` inside an open multi-line array is
 * a value, not a header.
 */
function tomlModelLine(text, from) {
  const lines = text.split('\n');
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    if (depth === 0 && /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(lines[i])) break;
    if (depth === 0) {
      const m = /^(\s*model\s*=\s*)"([^"]*)"/.exec(lines[i]);
      if (m && m[2] === from) return { i, lines, prefix: m[1] };
    }
    // Brackets outside strings and comments keep the array depth.
    const bare = lines[i].replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '').replace(/#.*/, '');
    for (const ch of bare) { if (ch === '[') depth++; else if (ch === ']') depth = Math.max(0, depth - 1); }
  }
  return null;
}

/** Each sidecar edit as a pure text → text, or null when it does not apply. */
const EDITS = {
  modelSettings: {
    file: settingsPath,
    describe: (from, to) => `Copy modelSettings["${from}"] to "${to}" (the old key stays)`,
    apply(text, from, to) {
      const root = scan(text);
      const ms = member(root, 'modelSettings');
      if (!ms || ms.value.type !== 'object') return null;
      const old = member(ms.value, from);
      if (!old || member(ms.value, to)) return null;
      return insertMember(text, ms.value, to, text.slice(old.value.start, old.value.end), old);
    },
  },
  settingsModel: {
    file: settingsPath,
    describe: (from, to) => `Set the top-level "model" from ${from} to ${to}`,
    apply(text, from, to) {
      const m = member(scan(text), 'model');
      if (!m || m.value.type !== 'string' || m.value.value !== from) return null;
      return replaceValue(text, m, JSON.stringify(to));
    },
  },
  codexModel: {
    file: tomlPath,
    describe: (from, to) => `Set config.toml's top-level model from ${from} to ${to}`,
    apply(text, from, to) {
      const hit = tomlModelLine(text, from);
      if (!hit) return null;
      const line = hit.lines[hit.i];
      hit.lines[hit.i] = hit.prefix + JSON.stringify(to) + line.slice(line.indexOf('"', hit.prefix.length + 1) + 1);
      return hit.lines.join('\n');
    },
  },
};

export function sidecarProposals({ from, to, home = homeDir() }) {
  const out = [];
  for (const [kind, e] of Object.entries(EDITS)) {
    const file = e.file(home);
    let text;
    try { text = readUserText(file); } catch { continue; }
    let next = null;
    try { next = e.apply(text, from, to); } catch { continue; }
    if (next !== null && next !== text) out.push({ kind, file: tilde(file), from, to, what: e.describe(from, to), mtime: mtimeOf(file) });
  }
  return out;
}

export async function applySidecar({ kind, from, to, mtime, home = homeDir() }) {
  const e = Object.hasOwn(EDITS, kind) ? EDITS[kind] : null;
  if (!e) throw bad(400, `unknown sidecar edit "${kind}"`);
  if (typeof from !== 'string' || !ID_RE.test(from) || typeof to !== 'string' || !ID_RE.test(to)) {
    throw bad(400, 'from and to must be valid model ids');
  }
  // Only ever toward an id the registry holds now: this follows an edit, it
  // is not a general-purpose rewrite of a CLI's config.
  if (!Object.values(loadRegistry({ home }).registry.models).includes(to)) {
    throw bad(400, `${to} is not a current registry id`);
  }
  const file = e.file(home);
  const now = mtimeOf(file);
  if (now === null) throw bad(404, `${tilde(file)} no longer exists`);
  if (typeof mtime !== 'number' || Math.abs(now - mtime) > 1) {
    throw bad(409, 'This file changed on disk since the change was proposed. Check again before accepting.');
  }
  const text = readUserText(file);
  let next;
  try { next = e.apply(text, from, to); } catch (err) { throw bad(409, `${tilde(file)}: ${err.message}`); }
  if (next === null || next === text) throw bad(409, 'This change no longer applies.');
  const w = await recordedWrite(file, next, `models: ${kind} ${from} → ${to} in ${tilde(file)}`);
  return { saved: true, kind, file: tilde(file), ...w };
}

/* ── where-used: `model-id <family>` in the lint scope, nothing looser ─── */

/**
 * Direct calls, plus `model-id --role <name>` for every role whose current
 * family (the first `use` entry, what --role prints) is this one: a skill
 * that asks for a role depends on whichever family the role names today.
 */
export function whereUsed(family, { home = homeDir(), limit = 200 } = {}) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const re = new RegExp(`model-id\\s+${esc(family)}(?![\\w.-])`);
  const loaded = loadRoles({ home });
  const roles = loaded.error ? [] : Object.keys(loaded.roles).filter((n) => loaded.roles[n].use[0] === family);
  const roleRe = roles.length ? new RegExp(`model-id\\s+(?:--json\\s+)?--role\\s+(${roles.map(esc).join('|')})(?![\\w.-])`) : null;
  const hits = [];
  for (const file of lintScope(home)) {
    let buf;
    try { buf = openUserFile(file).buf; } catch { continue; }
    if (buf.includes(0)) continue;
    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < lines.length && hits.length < limit; i++) {
      const hit = { file: tilde(file), line: i + 1, text: lines[i].trim().slice(0, 160) };
      if (re.test(lines[i])) hits.push(hit);
      else if (roleRe) { const m = roleRe.exec(lines[i]); if (m) hits.push({ ...hit, role: m[1] }); }
    }
  }
  return { family, hits, roles, truncated: hits.length >= limit };
}
