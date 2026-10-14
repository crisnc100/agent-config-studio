import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EFFORTS, ID_RE, homeDir, loadRegistry, resolveName } from './models.js';

/**
 * Roles and flavor: which family does which job, and how to brief each one.
 *
 * A file pair of its own, beside the model registry rather than inside it:
 * lib/roles.default.json ships the defaults (beside this module, so the
 * resolver's copy of lib/ carries it) and ~/.agent-config-studio/roles.json
 * overrides them. models.json and its schema are untouched, so a resolver
 * installed before roles existed keeps working against any data.
 *
 * Merging, per role and per family's flavor, field by field: a user field
 * replaces the default (a list replaces the whole list, never concatenates)
 * and `null` clears it. Resolution never reads a catalog and never
 * substitutes a family: `use` is an ordered preference list, the first entry
 * is the answer, and `alt` is a second opinion a caller asks for by name.
 *
 * Standalone like lib/models.js: bin/model-id --install copies the pair of
 * them, and neither may pull in the studio.
 */

export const ROLES_DEFAULTS_PATH = fileURLToPath(new URL('./roles.default.json', import.meta.url));
export const rolesUserPath = (home = homeDir()) => path.join(home, '.agent-config-studio', 'roles.json');

export const ROLE_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const LIMITS = Object.freeze({ brief: 600, item: 160, items: 12, note: 160, use: 8, avoid: 12 });

const TOP_KEYS = new Set(['version', 'roles', 'flavor']);
const ROLE_KEYS = new Set(['use', 'effort', 'alt', 'note']);
const FLAVOR_KEYS = new Set(['likes', 'quirks', 'brief', 'effort', 'avoid']);
export const ROLE_FIELDS = [...ROLE_KEYS];
export const FLAVOR_FIELDS = [...FLAVOR_KEYS];

/** C0, DEL, C1, line/paragraph separators and bidi overrides: none may hide in a brief. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (where, msg) => { throw new Error(`${where}: ${msg}`); };

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

/** The user file's bytes, or null when there is none. */
export function readUserRoles(home = homeDir()) {
  try { return readText(rolesUserPath(home)); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function text(where, v, max) {
  if (typeof v !== 'string') fail(where, 'must be a string');
  if (!v.trim()) fail(where, 'must not be empty');
  if (v.length > max) fail(where, `is ${v.length} characters; the limit is ${max}`);
  if (CONTROL_RE.test(v)) fail(where, 'contains a control character (newlines included)');
}

function family(where, v, families) {
  if (typeof v !== 'string') fail(where, 'must be a family name');
  if (!families.includes(v)) fail(where, `unknown family "${v}" (known: ${families.join(', ')})`);
}

/** Role names a family should not be given. A name no role has is allowed here: avoidWarnings reports it. */
function roleList(where, v) {
  if (!Array.isArray(v)) fail(where, 'must be a list of role names');
  if (v.length > LIMITS.avoid) fail(where, `has ${v.length} roles; the limit is ${LIMITS.avoid}`);
  v.forEach((s, i) => { if (typeof s !== 'string' || !ROLE_RE.test(s)) fail(`${where}[${i}]`, `role name ${JSON.stringify(s)} must match [a-z][a-z0-9-]{0,31}`); });
  if (new Set(v).size !== v.length) fail(where, 'names a role twice');
}

function list(where, v) {
  if (!Array.isArray(v)) fail(where, 'must be a list of strings');
  if (v.length > LIMITS.items) fail(where, `has ${v.length} items; the limit is ${LIMITS.items}`);
  v.forEach((s, i) => text(`${where}[${i}]`, s, LIMITS.item));
}

/**
 * Structure and values, strictly: an unknown key, family or effort refuses
 * the whole file with the path of the first thing wrong. `shipped` is the
 * defaults document when checking a user file, which may clear a default
 * field with null; the defaults themselves may not.
 */
export function checkRoles(doc, where, { families, shipped = null }) {
  const user = shipped !== null;
  if (!isObj(doc)) fail(where, 'must be a JSON object');
  for (const k of Object.keys(doc)) if (!TOP_KEYS.has(k)) fail(where, `unknown key "${k}" (allowed: ${[...TOP_KEYS].join(', ')})`);
  if (doc.version !== undefined && doc.version !== 1) {
    if (Number.isInteger(doc.version) && doc.version > 1) {
      fail(where, `version ${doc.version} is newer than this resolver understands — run: acs install-model-id`);
    }
    fail(where, `version must be 1, got ${JSON.stringify(doc.version)}`);
  }
  if (doc.roles !== undefined) {
    if (!isObj(doc.roles)) fail(where, '"roles" must be an object');
    for (const [name, r] of Object.entries(doc.roles)) {
      const at = `${where}: roles.${name}`;
      if (!ROLE_RE.test(name)) fail(where, `role name ${JSON.stringify(name)} must match [a-z][a-z0-9-]{0,31}`);
      if (!isObj(r)) fail(at, 'must be an object');
      for (const k of Object.keys(r)) if (!ROLE_KEYS.has(k)) fail(at, `unknown key "${k}" (allowed: ${[...ROLE_KEYS].join(', ')})`);
      const isDefault = user && Object.hasOwn(shipped.roles || {}, name);
      if (r.use === undefined && !isDefault) fail(at, '"use" is required for a role the defaults do not have');
      if (r.use === null) fail(`${at}.use`, 'cannot be cleared; reset the role to go back to its default');
      if (r.use !== undefined) {
        const use = typeof r.use === 'string' ? [r.use] : r.use;
        if (!Array.isArray(use) || !use.length) fail(`${at}.use`, 'must be a family or a non-empty list of families');
        if (use.length > LIMITS.use) fail(`${at}.use`, `has ${use.length} families; the limit is ${LIMITS.use}`);
        use.forEach((f, i) => family(`${at}.use${Array.isArray(r.use) ? `[${i}]` : ''}`, f, families));
        if (new Set(use).size !== use.length) fail(`${at}.use`, 'names a family twice');
      }
      for (const k of ['effort', 'alt', 'note']) {
        if (r[k] === null) { if (!user) fail(`${at}.${k}`, 'null only clears a default, in the user file'); continue; }
        if (r[k] === undefined) continue;
        if (k === 'effort' && !EFFORTS.has(r.effort)) fail(`${at}.effort`, `${JSON.stringify(r.effort)} is not one of ${[...EFFORTS].join('/')}`);
        if (k === 'alt') family(`${at}.alt`, r.alt, families);
        if (k === 'note') text(`${at}.note`, r.note, LIMITS.note);
      }
    }
  }
  if (doc.flavor !== undefined) {
    if (!isObj(doc.flavor)) fail(where, '"flavor" must be an object');
    for (const [f, fl] of Object.entries(doc.flavor)) {
      const at = `${where}: flavor.${f}`;
      if (!families.includes(f)) fail(where, `flavor: unknown family "${f}" (known: ${families.join(', ')})`);
      if (!isObj(fl)) fail(at, 'must be an object');
      for (const k of Object.keys(fl)) if (!FLAVOR_KEYS.has(k)) fail(at, `unknown key "${k}" (allowed: ${[...FLAVOR_KEYS].join(', ')})`);
      for (const k of FLAVOR_FIELDS) {
        if (fl[k] === null) { if (!user) fail(`${at}.${k}`, 'null only clears a default, in the user file'); continue; }
        if (fl[k] === undefined) continue;
        if (k === 'brief') text(`${at}.brief`, fl.brief, LIMITS.brief);
        else if (k === 'effort') { if (!EFFORTS.has(fl.effort)) fail(`${at}.effort`, `${JSON.stringify(fl.effort)} is not one of ${[...EFFORTS].join('/')}`); }
        else if (k === 'avoid') roleList(`${at}.avoid`, fl.avoid);
        else list(`${at}.${k}`, fl[k]);
      }
    }
  }
}

/** Field by field: user over default, null clears, and where each field came from. */
function mergeEntries(shipped = {}, user = {}) {
  const out = {};
  const from = {};
  for (const name of new Set([...Object.keys(shipped), ...Object.keys(user)])) {
    const s = shipped[name] || {};
    const u = user[name] || {};
    const merged = {};
    const prov = {};
    for (const [k, v] of Object.entries(s)) { merged[k] = v; prov[k] = 'default'; }
    for (const [k, v] of Object.entries(u)) {
      if (v === null) { delete merged[k]; prov[k] = 'cleared'; } else { merged[k] = v; prov[k] = 'user'; }
    }
    out[name] = merged;
    from[name] = prov;
  }
  return { out, from };
}

const useList = (use) => (typeof use === 'string' ? [use] : use);

/** Merge a checked defaults document with a checked user document (or none). */
export function mergeRoles(defaults, user = null) {
  const r = mergeEntries(defaults.roles, user?.roles);
  const f = mergeEntries(defaults.flavor, user?.flavor);
  for (const role of Object.values(r.out)) role.use = useList(role.use);
  const custom = Object.keys(r.out).filter((n) => !Object.hasOwn(defaults.roles || {}, n));
  return { roles: r.out, flavor: f.out, provenance: { roles: r.from, flavor: f.from }, custom };
}

function statKey(file) {
  try {
    const st = fs.statSync(file, { bigint: true });
    return `${st.mtimeNs}:${st.ctimeNs}:${st.size}:${st.ino}`;
  } catch { return 'none'; }
}

let cache = null;

/**
 * The merged roles. Never throws: a broken user file yields the defaults plus
 * `error`, for the studio to show and the resolver to refuse on. Families
 * are the shipped registry's (a user models.json cannot add one).
 */
export function loadRoles({ home = homeDir() } = {}) {
  const user = rolesUserPath(home);
  const reg = loadRegistry({ home });
  const key = `${home}\0${statKey(ROLES_DEFAULTS_PATH)}\0${statKey(user)}`;
  if (cache && cache.key === key && cache.reg === reg) return cache.value;

  const families = Object.keys(reg.defaults.models || {});
  const parse = (file, body) => {
    try { return JSON.parse(body); } catch (e) { throw new Error(`${file}: not valid JSON (${e.message})`); }
  };
  let value;
  let defaults;
  try {
    let body;
    try { body = readText(ROLES_DEFAULTS_PATH); }
    catch (e) {
      throw new Error(e.code === 'ENOENT'
        ? `${ROLES_DEFAULTS_PATH} is missing beside this resolver — run: acs install-model-id`
        : `${ROLES_DEFAULTS_PATH}: ${e.message}`);
    }
    defaults = parse(ROLES_DEFAULTS_PATH, body);
    checkRoles(defaults, ROLES_DEFAULTS_PATH, { families });
  } catch (e) {
    const empty = { roles: {}, flavor: {}, provenance: { roles: {}, flavor: {} }, custom: [] };
    value = { ...empty, defaults: { roles: {}, flavor: {} }, user: null, families, error: e.message, source: null };
    cache = { key, reg, value };
    return value;
  }
  value = { ...mergeRoles(defaults), defaults, user: null, families, error: null, source: ROLES_DEFAULTS_PATH };
  let body = null;
  try { body = readUserRoles(home); } catch (e) { value = { ...value, error: `${user}: ${e.message}` }; }
  if (body !== null) {
    try {
      const doc = parse(user, body);
      checkRoles(doc, user, { families, shipped: defaults });
      value = { ...mergeRoles(defaults, doc), defaults, user: doc, families, error: null, source: user };
    } catch (e) {
      value = { ...value, error: e.message };
    }
  }
  cache = { key, reg, value };
  return value;
}

/** A family's id through the model registry, or the reason it has none. */
function idFor(family, models) {
  const id = resolveName(family, models);
  if (id === null) return { error: `unknown model family "${family}"` };
  if (!ID_RE.test(id)) return { error: `"${family}" resolves to ${JSON.stringify(id)}, which is not a valid model id` };
  return { id };
}

/**
 * One role, resolved: the first `use` family and its id, the effort (the
 * role's, else that family's flavor effort, else empty — never guessed),
 * and the alt resolved the same way. Any failure is an error, never a
 * substitute.
 */
export function resolveRole(name, { home = homeDir() } = {}) {
  const loaded = loadRoles({ home });
  if (loaded.error) return { error: `roles are invalid — ${loaded.error}` };
  if (typeof name !== 'string' || !Object.hasOwn(loaded.roles, name)) {
    return { error: `unknown role "${name}" (known: ${Object.keys(loaded.roles).join(', ')})` };
  }
  const { registry, error } = loadRegistry({ home });
  if (error) return { error: `model registry is invalid — ${error}` };
  const role = loaded.roles[name];
  const effortFor = (f) => role.effort ?? loaded.flavor[f]?.effort ?? '';
  const ids = [];
  for (const f of role.use) {
    const r = idFor(f, registry.models);
    if (r.error) return { error: `role "${name}": ${r.error}` };
    ids.push(r.id);
  }
  let altId = '';
  if (role.alt) {
    const r = idFor(role.alt, registry.models);
    if (r.error) return { error: `role "${name}" alt: ${r.error}` };
    altId = r.id;
  }
  return {
    role: name,
    family: role.use[0],
    id: ids[0],
    effort: effortFor(role.use[0]),
    alt: role.alt || '',
    altId,
    altEffort: role.alt ? effortFor(role.alt) : '',
    use: role.use,
    ids,
    note: role.note || '',
    custom: loaded.custom.includes(name),
    provenance: loaded.provenance.roles[name],
    source: loaded.source,
  };
}

/** One family's flavor, merged; `{}` for a known family with none. */
export function resolveFlavor(family, { home = homeDir() } = {}) {
  const loaded = loadRoles({ home });
  if (loaded.error) return { error: `roles are invalid — ${loaded.error}` };
  if (typeof family !== 'string' || !loaded.families.includes(family)) {
    return { error: `unknown model family "${family}" (known: ${loaded.families.join(', ')})` };
  }
  const flavor = loaded.flavor[family] || {};
  return { family, flavor, provenance: loaded.provenance.flavor[family] || {}, text: flavorText(family, flavor), source: loaded.source };
}

/** The guidance a skill pastes into a delegation brief. Empty when nothing is set. */
export function flavorText(family, flavor) {
  const lines = [];
  if (flavor.brief) lines.push(`Briefing ${family}: ${flavor.brief}`);
  if (flavor.likes?.length) lines.push(`Good at: ${flavor.likes.join('; ')}.`);
  if (flavor.quirks?.length) lines.push(`Watch for: ${flavor.quirks.join('; ')}.`);
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * Every role that hands a job to a family marked to avoid it, in role order:
 * `{ role, family, slot }`, slot 'use' or 'alt'. A warning to show, never a
 * refusal — the role still resolves as written.
 */
export function roleConflicts(loaded) {
  const out = [];
  for (const role of Object.keys(loaded.roles).sort()) {
    const r = loaded.roles[role];
    const avoids = (f) => (loaded.flavor[f]?.avoid || []).includes(role);
    for (const f of r.use) if (avoids(f)) out.push({ role, family: f, slot: 'use' });
    if (r.alt && avoids(r.alt)) out.push({ role, family: r.alt, slot: 'alt' });
  }
  return out;
}

/** An avoid list naming a role that does not exist: valid, but likely a typo or a deleted role. */
export function avoidWarnings(loaded) {
  const out = [];
  for (const f of loaded.families) {
    for (const role of loaded.flavor[f]?.avoid || []) {
      if (!Object.hasOwn(loaded.roles, role)) out.push(`flavor.${f}.avoid names "${role}", which is not a role.`);
    }
  }
  return out;
}

/** The guide's limit, and the strings that would break the block that carries it. */
export const GUIDE_MAX_BYTES = 8 * 1024;
const GUIDE_BANNED = ['<!--', '-->', 'acs:model-guide', '\r'];

/**
 * The model guide: every role and every family's flavor as Markdown, for the
 * block Agent Config Studio keeps in each harness's global instruction file.
 * Pure — the same merged roles always give the same bytes — and id-free:
 * families are stable, ids change with every release. A bullet list rather
 * than a table, so a note needs no escaping. Throws, never escapes, when the
 * roles are invalid or the text could break the block's markers.
 */
export function guideText(loaded) {
  if (loaded.error) throw new Error(`roles are invalid — ${loaded.error}`);
  const effortFor = (role, f) => role.effort ?? loaded.flavor[f]?.effort ?? 'default';
  const at = (role, f) => `${f} at ${effortFor(role, f)} effort`;
  const lines = [
    '## Model guide',
    '',
    'Generated by Agent Config Studio from your model roles. Edit roles in ACS, not here. Edits inside this block are overwritten.',
    '',
    '**Roles.** The first family is the answer; the rest are fallbacks, in order. A second opinion is used only when asked for.',
    '',
  ];
  const names = Object.keys(loaded.roles).sort();
  if (!names.length) lines.push('- (no roles are defined)');
  for (const name of names) {
    const role = loaded.roles[name];
    const [first, ...rest] = role.use;
    let line = `- **${name}**: ${at(role, first)}`;
    if (rest.length) line += `; fallbacks: ${rest.map((f) => at(role, f)).join(', ')}`;
    if (role.alt) line += `; second opinion: ${at(role, role.alt)}`;
    if (role.note) line += ` — ${role.note}`;
    lines.push(line);
  }
  const avoid = (f) => loaded.flavor[f]?.avoid || [];
  const briefed = loaded.families.filter((f) => flavorText(f, loaded.flavor[f] || {}) || avoid(f).length);
  if (briefed.length) {
    lines.push('', '**Briefing each family.**', '');
    for (const f of briefed) {
      lines.push(`- **${f}**`);
      const text = flavorText(f, loaded.flavor[f]);
      if (text) for (const l of text.trimEnd().split('\n')) lines.push(`  - ${l}`);
      if (avoid(f).length) lines.push(`  - Avoid for: ${avoid(f).join(', ')}`);
    }
  }
  lines.push('', '`model-id --role <name>` / `model-id --flavor <family>` print these; `model-id <family>` prints the current id.');
  const out = `${lines.join('\n')}\n`;
  const hit = GUIDE_BANNED.find((s) => out.includes(s));
  if (hit) throw new Error(`the model guide would contain ${JSON.stringify(hit)}, which would break its markers; change the role or flavor text that has it`);
  const size = Buffer.byteLength(out);
  if (size > GUIDE_MAX_BYTES) throw new Error(`the model guide is ${size} bytes; the limit is ${GUIDE_MAX_BYTES}. Shorten some notes or briefs.`);
  return out;
}
