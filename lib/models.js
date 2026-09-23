import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The model registry: family name → current model id, in one file.
 *
 * models.default.json ships the defaults, so a fresh machine works with no user
 * file. ~/.agent-config-studio/models.json overrides them per key — a file that
 * sets only `opus` keeps every other default. A key the defaults do not know is
 * an error, never a silent no-op: a typo'd family must not look like it worked.
 *
 * Effort is NOT here. It is policy, and it stays a literal at each call site.
 *
 * This module must stay importable on its own: bin/model-id runs it from a
 * copy outside any checkout, and it must never pull in lib/harness.js.
 */

export const DEFAULTS_PATH = fileURLToPath(new URL('../models.default.json', import.meta.url));

/** Every id must pass this before it reaches an argv. */
export const ID_RE = /^[a-z0-9][a-z0-9.\-]{0,63}$/;
export const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const TOP_KEYS = new Set(['version', 'models', 'assist']);
const ASSIST_KEYS = new Set(['default', 'picker', 'retired']);
const ENTRY_KEYS = new Set(['model', 'note', 'effort']);

/** $HOME, not os.userInfo(): a redirected HOME must redirect the registry too. */
export const homeDir = () => process.env.HOME || os.homedir();
export const userPath = (home = homeDir()) => path.join(home, '.agent-config-studio', 'models.json');

/** A raw id passes through resolution unchanged; it looks like `name-<digit>…`. */
export const isRawId = (s) => typeof s === 'string' && ID_RE.test(s) && s.includes('-') && /\d/.test(s);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function fail(where, msg) {
  throw new Error(`${where}: ${msg}`);
}

/**
 * Structure only. Id SHAPE is deliberately not checked here: the resolver
 * rejects a bad id when it is asked for it, and Assist drops a bad entry with a
 * reason, so one bad value never takes the other families down with it.
 */
function checkShape(doc, where, known) {
  if (!isObj(doc)) fail(where, 'must be a JSON object');
  for (const k of Object.keys(doc)) if (!TOP_KEYS.has(k)) fail(where, `unknown key "${k}"`);
  if (doc.version !== undefined && doc.version !== 1) fail(where, `version must be 1, got ${JSON.stringify(doc.version)}`);
  if (doc.models !== undefined) {
    if (!isObj(doc.models)) fail(where, '"models" must be an object');
    for (const [k, v] of Object.entries(doc.models)) {
      if (known && !Object.hasOwn(known.models, k)) {
        fail(where, `unknown family "${k}" (known: ${Object.keys(known.models).join(', ')})`);
      }
      if (typeof v !== 'string') fail(where, `models.${k} must be a string`);
    }
  }
  if (doc.assist !== undefined) {
    if (!isObj(doc.assist)) fail(where, '"assist" must be an object');
    for (const [h, a] of Object.entries(doc.assist)) {
      if (known && !Object.hasOwn(known.assist, h)) fail(where, `unknown assist harness "${h}"`);
      if (!isObj(a)) fail(where, `assist.${h} must be an object`);
      for (const k of Object.keys(a)) if (!ASSIST_KEYS.has(k)) fail(where, `assist.${h}: unknown key "${k}"`);
      if (a.default !== undefined && typeof a.default !== 'string') fail(where, `assist.${h}.default must be a string`);
      if (a.picker !== undefined) {
        if (!Array.isArray(a.picker)) fail(where, `assist.${h}.picker must be an array`);
        a.picker.forEach((e, i) => {
          if (!isObj(e)) fail(where, `assist.${h}.picker[${i}] must be an object`);
          for (const k of Object.keys(e)) if (!ENTRY_KEYS.has(k)) fail(where, `assist.${h}.picker[${i}]: unknown key "${k}"`);
          for (const k of Object.keys(e)) if (typeof e[k] !== 'string') fail(where, `assist.${h}.picker[${i}].${k} must be a string`);
          if (typeof e.model !== 'string') fail(where, `assist.${h}.picker[${i}].model is required`);
        });
      }
      if (a.retired !== undefined) {
        if (!isObj(a.retired)) fail(where, `assist.${h}.retired must be an object`);
        for (const [k, v] of Object.entries(a.retired)) {
          if (typeof v !== 'string') fail(where, `assist.${h}.retired.${k} must be a string`);
        }
      }
    }
  }
}

/**
 * Per field within each harness: a user `picker` replaces the shipped list as a
 * whole (order is the point of a list), `default` replaces the shipped default,
 * and `retired` merges per key — so a file that only reorders the picker keeps
 * the shipped default and every saved-selection migration.
 */
function mergeAssist(shipped, user) {
  const out = { ...shipped };
  for (const [h, u] of Object.entries(user)) {
    const s = shipped[h] || {};
    out[h] = { ...s, ...u, retired: { ...(s.retired || {}), ...(u.retired || {}) } };
  }
  return out;
}

function readJson(file) {
  const text = fs.readFileSync(file, 'utf8');
  try { return JSON.parse(text); } catch (e) { throw new Error(`${file}: not valid JSON (${e.message})`); }
}

function statKey(file) {
  try {
    const st = fs.statSync(file, { bigint: true });
    return `${st.mtimeNs}:${st.ctimeNs}:${st.size}:${st.ino}`;
  } catch { return 'none'; }
}

let cache = null;

/**
 * The merged registry. Never throws: a broken user file yields the shipped
 * defaults plus `error`, so a caller that must keep running (the studio) can,
 * and a caller that must refuse (the resolver) sees the error and refuses.
 *
 * Cached on the files' stat, so it is cheap to call per request and an edit
 * shows up on the next call without a restart.
 */
export function loadRegistry({ home = homeDir() } = {}) {
  const user = userPath(home);
  const key = `${home}\0${statKey(DEFAULTS_PATH)}\0${statKey(user)}`;
  if (cache && cache.key === key) return cache.value;

  let value;
  try {
    const defaults = readJson(DEFAULTS_PATH);
    checkShape(defaults, DEFAULTS_PATH, null);
    value = { registry: defaults, defaults, error: null, source: DEFAULTS_PATH };
    if (fs.existsSync(user)) {
      try {
        const doc = readJson(user);
        checkShape(doc, user, defaults);
        value = {
          registry: {
            version: 1,
            models: { ...defaults.models, ...(doc.models || {}) },
            assist: mergeAssist(defaults.assist, doc.assist || {}),
          },
          defaults,
          error: null,
          source: user,
        };
      } catch (e) {
        value = { registry: defaults, defaults, error: e.message, source: DEFAULTS_PATH };
      }
    }
  } catch (e) {
    const empty = { version: 1, models: {}, assist: {} };
    value = { registry: empty, defaults: empty, error: e.message, source: null };
  }
  cache = { key, value };
  return value;
}

/** Family → id, raw id → itself, anything else → null. */
export function resolveName(name, models) {
  if (typeof name !== 'string') return null;
  if (Object.hasOwn(models, name)) return models[name];
  if (isRawId(name)) return name;
  return null;
}

/**
 * The resolver's contract: an id, or an Error saying why not. A registry
 * value that is not a valid id is a failure too — it must never reach an argv.
 */
export function resolveModel(name, { home = homeDir() } = {}) {
  const { registry, error } = loadRegistry({ home });
  if (error) return { error: `model registry is invalid — ${error}` };
  const id = resolveName(name, registry.models);
  if (id === null) {
    return { error: `unknown model family "${name}" (known: ${Object.keys(registry.models).join(', ')})` };
  }
  if (!ID_RE.test(id)) return { error: `"${name}" resolves to ${JSON.stringify(id)}, which is not a valid model id` };
  return { id };
}

/* ── lint ──────────────────────────────────────────────────────────────── */

export const LINT_PATTERNS = [
  /claude-(?:opus|sonnet|fable|haiku)-\d/,
  /gpt-\d/,
  /grok-\d/,
  /\b(?:Fable|Opus|Sonnet|Haiku) \d/,
  /GPT-\d/,
  /\bGrok \d/,
  // A substitution with no fallback: where model-id is not on PATH (a non-interactive shell that
  // never read .zshrc) it expands to "", and `-m ""` silently becomes the CLI's own default.
  /\$\(\s*model-id\s+[^)|]*\)/,
];

const EXCLUDE_DIRS = new Set(['.git', '.system', 'synced', 'skills_retired', 'node_modules']);

/** Symlinks are not followed: the scope is what lives here, not what it points at. */
function walk(dir, out) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names.sort()) {
    const abs = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(abs); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (!EXCLUDE_DIRS.has(name)) walk(abs, out);
    } else if (st.isFile() && !name.includes('.bak')) {
      out.push(abs);
    }
  }
}

function projectReviewConfigs(dir, out, depth) {
  if (depth > 6) return;
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names.sort()) {
    if (name === 'node_modules' || name === '.git') continue;
    const abs = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(abs); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (name === '.claude') {
      const f = path.join(abs, 'review-config.json');
      if (fs.existsSync(f)) out.push(f);
      continue;
    }
    projectReviewConfigs(abs, out, depth + 1);
  }
}

/** The user-facing lint scope. ACS's own source is held to this by a test instead. */
export function lintScope(home = homeDir()) {
  const out = [];
  walk(path.join(home, '.claude', 'skills'), out);
  walk(path.join(home, '.codex', 'skills'), out);
  for (const f of ['CLAUDE.md', 'advisor-config.json', 'review-config.json', 'investigate-config.json']) {
    const abs = path.join(home, '.claude', f);
    if (fs.existsSync(abs)) out.push(abs);
  }
  projectReviewConfigs(path.join(home, 'Documents', 'Projects'), out, 0);
  return out;
}

export function lint(paths = null, { home = homeDir() } = {}) {
  const files = [];
  if (paths && paths.length) {
    for (const p of paths) {
      const abs = path.resolve(p);
      let st;
      try { st = fs.lstatSync(abs); } catch { files.push(abs); continue; }
      if (st.isDirectory()) walk(abs, files); else files.push(abs);
    }
  } else {
    files.push(...lintScope(home));
  }
  const hits = [];
  for (const file of files) {
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { hits.push({ file, line: 0, match: `unreadable: ${e.message}` }); continue; }
    if (buf.includes(0)) continue;
    buf.toString('utf8').split('\n').forEach((text, i) => {
      for (const re of LINT_PATTERNS) {
        const m = text.match(re);
        if (m) { hits.push({ file, line: i + 1, match: m[0], text: text.trim().slice(0, 160) }); break; }
      }
    });
  }
  return { files: files.length, hits };
}

/* ── sidecars ──────────────────────────────────────────────────────────── */

/**
 * Files the CLIs own, which the registry cannot. Every id there that is not a
 * current registry value is reported — after a bump that is the list of edits
 * still to make by hand. Reported, never rewritten.
 */
export function sidecars({ home = homeDir() } = {}) {
  const { registry } = loadRegistry({ home });
  const current = new Set(Object.values(registry.models));
  const families = new Set(Object.keys(registry.models));
  const stale = (v) => {
    const bare = String(v).replace(/\[[^\]]*\]$/, '');
    return !current.has(bare) && !families.has(bare);
  };
  const out = [];

  const settings = path.join(home, '.claude', 'settings.json');
  if (fs.existsSync(settings)) {
    try {
      const j = JSON.parse(fs.readFileSync(settings, 'utf8'));
      if (typeof j.model === 'string' && stale(j.model)) out.push({ file: settings, where: 'model', value: j.model });
      if (isObj(j.modelSettings)) {
        for (const k of Object.keys(j.modelSettings)) {
          if (stale(k)) out.push({ file: settings, where: `modelSettings[${JSON.stringify(k)}]`, value: k });
        }
      }
    } catch (e) {
      out.push({ file: settings, where: 'parse', value: e.message });
    }
  }

  const toml = path.join(home, '.codex', 'config.toml');
  if (fs.existsSync(toml)) {
    fs.readFileSync(toml, 'utf8').split('\n').forEach((line, i) => {
      const m = line.match(/^\s*model\s*=\s*"([^"]+)"/);
      if (m && stale(m[1])) out.push({ file: toml, where: `line ${i + 1} model`, value: m[1] });
    });
  }
  return out;
}
