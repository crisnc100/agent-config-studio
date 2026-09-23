import fs from 'node:fs';
import path from 'node:path';
import { homeDir, tracks } from './models.js';

/**
 * What each CLI says it offers, read from the catalog it already caches on
 * disk — no spawn, no network, no credential — and what that means for the
 * registry: a newer id in a family, a pinned id being retired, or one no
 * longer offered.
 *
 * The catalogs sit beside login state. Only the projected fields below ever
 * leave this module: no file path, filename, identity, auth_method, origin,
 * etag, model_messages or any other field does.
 */

export const STALE_MS = 7 * 24 * 3600 * 1000;

const VENDORS = ['claude', 'codex', 'grok'];
const CLI = { claude: 'claude', codex: 'codex', grok: 'grok' };
const LABEL = { claude: 'Claude', codex: 'Codex', grok: 'Grok' };

/** A family's vendor is its current id's prefix. */
export function vendorOf(id) {
  if (typeof id !== 'string') return null;
  if (id.startsWith('claude-')) return 'claude';
  if (id.startsWith('gpt-')) return 'codex';
  if (id.startsWith('grok-')) return 'grok';
  return null;
}

/**
 * The id's numeric segments, compared numerically so 10 beats 9. A segment
 * that mixes letters and digits makes the id unparseable, and an unparseable
 * id is never proposed.
 */
export function parseVersion(id) {
  if (typeof id !== 'string') return null;
  const nums = [];
  for (const seg of id.split(/[-.]/)) {
    if (/^\d+$/.test(seg)) nums.push(Number(seg));
    else if (/\d/.test(seg)) return null;
  }
  return nums.length ? nums : null;
}

/** An 8-digit date segment marks a dated snapshot of a model, not a newer release. */
export const isDated = (id) => /(?:^|[-.])\d{8}(?:$|[-.])/.test(id);

export function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? -1, y = b[i] ?? -1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export const semver = (s) => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s ?? ''));
  return m ? m.slice(1).map(Number) : null;
};

const time = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null);

function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { missing: true }; }
  // The parser's message can quote the file's contents, so it is not passed on.
  try { return { doc: JSON.parse(text) }; } catch { return { error: 'catalog is not valid JSON' }; }
}

/* ── per-vendor readers: file → projected models ───────────────────────── */

function claudeFamily(m) {
  return typeof m.short_name === 'string' && /^[A-Za-z]+$/.test(m.short_name) ? m.short_name.toLowerCase() : null;
}

function codexFamily(slug, hidden) {
  if (hidden || slug.endsWith('-latest') || slug.startsWith('codex-')) return null;
  const last = slug.split('-').pop();
  return /^[a-z]+$/.test(last) ? last : null;
}

function grokFamily(id, hidden) {
  if (hidden) return null;
  return /^grok-\d+(?:\.\d+)*$/.test(id) ? 'grok' : null;
}

function project(vendor, fields, fetchedAt) {
  return {
    vendor,
    id: fields.id,
    displayName: str(fields.displayName),
    family: fields.family ?? null,
    hidden: fields.hidden === true,
    minCliVersion: str(fields.minCliVersion, 32),
    upgrade: fields.upgrade ?? null,
    retirementAt: str(fields.retirementAt, 40),
    fetchedAt,
  };
}

function readClaude(home) {
  const dir = path.join(home, '.claude', 'cache', 'model-catalog');
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('-cc.json')); } catch { names = []; }
  // One file per login; the newest fetch wins.
  let best = null, lastError = null;
  for (const n of names) {
    const r = readJson(path.join(dir, n));
    if (r.error) { lastError = r.error; continue; }
    if (!r.doc) continue;
    const at = time(r.doc.fetchedAt);
    const list = r.doc.catalog?.config?.models;
    if (!Array.isArray(list)) { lastError = 'catalog has no model list'; continue; }
    if (!best || (at ?? 0) > (best.at ?? 0)) best = { at, list };
  }
  if (!best) return lastError ? { error: lastError } : { missing: true };
  const models = best.list
    .filter((m) => m && typeof m.id === 'string')
    .map((m) => project('claude', {
      id: m.id, displayName: m.name, family: claudeFamily(m), minCliVersion: m.min_claude_code_version,
    }, best.at));
  return { fetchedAt: best.at, models };
}

function readCodex(homes, home) {
  // ~/.codex and every seat home, as a UNION. Why one home's list is sometimes
  // shorter is unknown (client version, the login's entitlements, rollout
  // timing), so no single file is trusted: an id is offered if any catalog
  // lists it. Per-id metadata comes from the highest client_version, then the
  // newest fetch — a heuristic, since the same cause is unknown.
  const loaded = [];
  let lastError = null;
  for (const h of homes) {
    const r = readJson(path.join(h, 'models_cache.json'));
    if (r.error) { lastError = r.error; continue; }
    if (!r.doc) continue;
    if (!Array.isArray(r.doc.models)) { lastError = 'catalog has no model list'; continue; }
    loaded.push({
      home: h, at: time(r.doc.fetched_at), version: str(r.doc.client_version, 32),
      client: semver(r.doc.client_version) || [0, 0, 0], list: r.doc.models.filter((m) => m && typeof m.slug === 'string'),
    });
  }
  if (!loaded.length) return lastError ? { error: lastError } : { missing: true };
  loaded.sort((a, b) => compareVersions(b.client, a.client) || (b.at ?? 0) - (a.at ?? 0));
  const newest = Math.max(...loaded.map((c) => c.at ?? 0)) || null;

  const bySlug = new Map();
  for (const c of loaded) for (const m of c.list) if (!bySlug.has(m.slug)) bySlug.set(m.slug, m);
  const models = [...bySlug.values()].map((m) => {
    // No visibility field means listed; only an explicit non-"list" value hides.
    const hidden = typeof m.visibility === 'string' && m.visibility !== 'list';
    const up = m.upgrade && typeof m.upgrade === 'object' ? m.upgrade : null;
    return project('codex', {
      id: m.slug,
      displayName: m.display_name,
      family: codexFamily(m.slug, hidden),
      hidden,
      upgrade: up && typeof up.model === 'string'
        ? { model: up.model, message: str(up.migration_markdown, 2000) }
        : null,
      retirementAt: up?.retirement_at ?? m.retirement_at,
    }, newest);
  });

  // Say so when the lists disagree, naming the home, never the file.
  const shown = (h) => (h.startsWith(home + path.sep) ? `~${h.slice(home.length)}` : h);
  const lacking = loaded
    .map((c) => ({ c, missing: bySlug.size - new Set(c.list.map((m) => m.slug)).size }))
    .filter((x) => x.missing > 0);
  const disagree = lacking.length
    ? `Codex catalogs disagree: ${lacking.map(({ c, missing }) =>
      `${shown(c.home)}'s comes from Codex ${c.version ?? '(unknown version)'} and lacks ${missing} of the ${bySlug.size} models listed across all homes`).join('; ')}. An id listed by any of them counts as offered.`
    : null;
  return { fetchedAt: newest, models, disagree };
}

function readGrok(home) {
  const r = readJson(path.join(home, '.grok', 'models_cache.json'));
  if (!r.doc) return r;
  const at = time(r.doc.renewed_at) ?? time(r.doc.fetched_at);
  const entries = r.doc.models && typeof r.doc.models === 'object' ? Object.entries(r.doc.models) : null;
  if (!entries) return { error: 'catalog has no model list' };
  const models = entries.map(([key, v]) => {
    const info = v?.info || {};
    const id = typeof info.id === 'string' ? info.id : key;
    const hidden = info.hidden === true;
    return project('grok', { id, displayName: info.name, family: grokFamily(id, hidden), hidden }, at);
  });
  return { fetchedAt: at, models };
}

/**
 * Every vendor's catalog, projected. A missing or broken one is a note for
 * that vendor, never an exception.
 */
export function readCatalogs({ home = homeDir(), codexHomes = [], now = Date.now() } = {}) {
  const shared = path.join(home, '.codex');
  const homes = [shared, ...codexHomes.filter((h) => typeof h === 'string' && path.resolve(h) !== shared)];
  const raw = { claude: readClaude(home), codex: readCodex(homes, home), grok: readGrok(home) };
  const out = {};
  for (const v of VENDORS) {
    const r = raw[v];
    const cat = { vendor: v, label: LABEL[v], ok: !!r.models, fetchedAt: r.fetchedAt ?? null, models: r.models || [], note: null, stale: false };
    if (r.missing) cat.note = `No ${LABEL[v]} catalog on this machine — run \`${CLI[v]}\` once to create it.`;
    else if (r.error) cat.note = `${LABEL[v]} catalog could not be read (${r.error}) — run \`${CLI[v]}\` once to refresh it.`;
    else if (cat.fetchedAt == null || now - cat.fetchedAt > STALE_MS) {
      cat.stale = true;
      const days = cat.fetchedAt == null ? null : Math.floor((now - cat.fetchedAt) / 86400000);
      cat.note = `${LABEL[v]} catalog is ${days == null ? 'of unknown age' : `${days} days old`} — run \`${CLI[v]}\` once to refresh it.`;
    }
    cat.disagree = r.disagree ?? null;
    out[v] = cat;
  }
  return out;
}

/* ── detection ─────────────────────────────────────────────────────────── */

export const alertKey = (a) => `${a.kind}:${a.candidate ?? a.id}`;

/**
 * Per registry family: where its id comes from and every alert that applies.
 * `overrides` names the families the user file sets. `dismissed` is
 * `{ family: { id, keys: [] } }`; a dismissal holds only while
 * the family is still on the id it was dismissed against, and only for that
 * exact alert, so a different newer candidate shows again.
 */
export function detect({ registry, defaults, catalogs, overrides = [], claudeVersion = null, dismissed = {} }) {
  const cli = semver(claudeVersion);
  const rows = [];
  for (const [family, id] of Object.entries(registry.models)) {
    const vendor = vendorOf(id);
    const cat = vendor ? catalogs[vendor] : null;
    const entry = cat?.models.find((m) => m.id === id) || null;
    const track = tracks(registry, family);
    const alerts = [];

    if (cat?.ok && track) {
      const mine = parseVersion(id);
      let top = null;
      for (const m of cat.models) {
        if (m.hidden || m.family !== family) continue;
        const v = parseVersion(m.id);
        if (!mine || !v || compareVersions(v, mine) <= 0) continue;
        // A dated snapshot of the same release is never "newer" than the undated alias.
        if (isDated(m.id) && !isDated(id)) continue;
        if (!top || compareVersions(v, top.v) > 0) top = { m, v };
      }
      if (top) {
        const need = semver(top.m.minCliVersion);
        const acceptable = !need || (!!cli && compareVersions(cli, need) >= 0);
        alerts.push({
          kind: 'update', family, id, candidate: top.m.id, displayName: top.m.displayName,
          acceptable,
          reason: acceptable ? null : `needs Claude Code ≥ ${top.m.minCliVersion}${cli ? ` (installed ${cli.join('.')})` : ' (installed version unknown)'}`,
        });
      }
    }
    if (entry && (entry.upgrade || entry.retirementAt)) {
      alerts.push({
        kind: 'retiring', family, id, date: entry.retirementAt,
        message: entry.upgrade?.message ?? null, candidate: entry.upgrade?.model ?? null, acceptable: !!entry.upgrade?.model,
      });
    }
    if (cat?.ok && !entry) alerts.push({ kind: 'vanished', family, id, acceptable: false });

    const d = dismissed[family];
    for (const a of alerts) {
      a.key = alertKey(a);
      a.dismissed = !!(d && d.id === id && Array.isArray(d.keys) && d.keys.includes(a.key));
    }
    rows.push({
      family, id, vendor, track,
      displayName: entry?.displayName ?? null,
      source: overrides.includes(family) ? 'override' : 'default',
      defaultId: defaults.models?.[family] ?? null,
      alerts,
    });
  }
  const pending = rows.reduce((n, r) => n + r.alerts.filter((a) => !a.dismissed).length, 0);
  return { rows, pending };
}
