import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as history from './history.js';
import { tilde } from './paths.js';
import { ID_RE, homeDir, lintScope, loadRegistry, userPath } from './models.js';
import {
  codexCatalogStamps, codexHomeList, compareVersions, detect, readCatalogs, semver, shownHome, vendorOf,
} from './models-catalog.js';
import { insertMember, member, removeMember, replaceValue, scan } from './jsontext.js';

/**
 * The Models panel's writes: one registry key at a time, and the sidecar
 * edits that follow from it. Every write is atomic, goes through the shadow
 * history repo like any other studio edit, and touches only the bytes it
 * names.
 */

const LABEL = { claude: 'Claude', codex: 'Codex', grok: 'Grok' };

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

/**
 * Ask Codex to refresh every home's catalog, then say which homes it did not
 * refresh and why, or null when it refreshed them all. A home counts as
 * refreshed when its catalog was re-stamped, or already carries this CLI's
 * version: a signed-out home answers without rewriting anything.
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
      }
    }
    if (reason) byReason.set(reason, [...(byReason.get(reason) || []), shownHome(h, home)]);
  });
  if (!byReason.size) return null;
  return `Not refreshed: ${[...byReason].map(([reason, hs]) => `${hs.join(', ')} (${reason})`).join('; ')}. ` +
    'Shown as last fetched.';
}

/**
 * Catalog state: read at server start and on "Check now", never on a timer.
 * Alerts are derived per request from it, so an edit shows at once. Only
 * "Check now" (`refresh`) first has Codex refresh its catalogs.
 */
export function createModelsState({ detectFn, codexHomes, refreshCodex = null, home = homeDir() }) {
  let state = null;
  let pending = null;
  const check = ({ refresh = false } = {}) => {
    pending = (async () => {
      const seatHomes = codexHomes();
      const refreshNote = refresh && refreshCodex
        ? await refreshCodexHomes(codexHomeList({ home, codexHomes: seatHomes }), refreshCodex, home)
        : null;
      let claudeVersion = null;
      try { claudeVersion = (await detectFn()).find((h) => h.id === 'claude')?.version ?? null; } catch {}
      const catalogs = readCatalogs({ home, codexHomes: seatHomes });
      catalogs.codex.refreshNote = refreshNote;
      state = { catalogs, claudeVersion, checkedAt: Date.now() };
      return state;
    })();
    return pending;
  };
  const current = () => (state ? Promise.resolve(state) : pending || check());
  const view = async () => {
    const s = await current();
    const reg = loadRegistry({ home });
    const { rows, pending: count } = detect({
      registry: reg.registry, defaults: reg.defaults, catalogs: s.catalogs,
      overrides: reg.error ? [] : userOverrides(home), claudeVersion: s.claudeVersion,
      dismissed: readDismissed(home),
    });
    return {
      rows,
      pending: count,
      registryError: reg.error,
      catalogs: Object.values(s.catalogs).map(({ models, ...c }) => ({ ...c, count: models.length })),
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
  if (!vendor) out.push(`${id} does not look like a Claude, Codex or Grok id.`);
  else if (vendor !== was) out.push(`This moves ${family} from ${LABEL[was] || 'its current vendor'} to ${LABEL[vendor]}.`);
  const cat = vendor ? catalogs[vendor] : null;
  if (cat && !cat.ok) out.push(`There is no ${LABEL[vendor]} catalog to check ${id} against.`);
  else if (cat) {
    const entry = cat.models.find((m) => m.id === id);
    if (!entry) out.push(`${id} is not in the ${LABEL[vendor]} catalog.`);
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

export async function setModel({ family, id, confirm = false, catalogs, claudeVersion, home = homeDir() }) {
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
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
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
  const text = fs.readFileSync(file, 'utf8');
  let next;
  try { next = e.apply(text, from, to); } catch (err) { throw bad(409, `${tilde(file)}: ${err.message}`); }
  if (next === null || next === text) throw bad(409, 'This change no longer applies.');
  const w = await recordedWrite(file, next, `models: ${kind} ${from} → ${to} in ${tilde(file)}`);
  return { saved: true, kind, file: tilde(file), ...w };
}

/* ── where-used: `model-id <family>` in the lint scope, nothing looser ─── */

export function whereUsed(family, { home = homeDir(), limit = 200 } = {}) {
  const re = new RegExp(`model-id\\s+${family.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?![\\w.-])`);
  const hits = [];
  for (const file of lintScope(home)) {
    let buf;
    try { buf = fs.readFileSync(file); } catch { continue; }
    if (buf.includes(0)) continue;
    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < lines.length && hits.length < limit; i++) {
      if (re.test(lines[i])) hits.push({ file: tilde(file), line: i + 1, text: lines[i].trim().slice(0, 160) });
    }
  }
  return { family, hits, truncated: hits.length >= limit };
}
