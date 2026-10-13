import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as history from './history.js';
import { tilde } from './paths.js';
import { EFFORTS, ID_RE, homeDir, loadRegistry } from './models.js';
import {
  FLAVOR_FIELDS, LIMITS, ROLE_FIELDS, ROLE_RE, checkRoles, loadRoles, readUserRoles, rolesUserPath,
} from './roles.js';
import { insertMember, member, removeMember, replaceValue, scan } from './jsontext.js';

/**
 * The Models panel's roles and flavor: the view, and every write to
 * roles.json — a direct edit, a reset, or an accepted Describe proposal.
 *
 * One write path, writeRoles, and it is a boundary rather than a helper:
 * the file is written only at its fixed path in the studio folder, never
 * through a symlink (it or its folder), from a temp file created
 * exclusively, and only while the file still has the bytes the edit was
 * based on (`base`, its sha256). Anything else refuses and writes nothing.
 * A history failure is reported as a warning, never swallowed.
 */

const bad = (status, message) => Object.assign(new Error(message), { status });

/** The base an edit names: the sha256 of the bytes it was made against. */
export const hashOf = (text) => (text === null ? 'absent' : `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`);

const STALE = 'roles.json changed since this was shown (another tab, an editor, or an accepted proposal). Reload and try again.';

/** The defaults and families to check against, or a 500 when the shipped file itself is broken. */
function shipped(home) {
  const loaded = loadRoles({ home });
  if (!loaded.source) throw bad(500, `The shipped roles are invalid: ${loaded.error}`);
  return loaded;
}

/** The whole text checked as a user roles.json; the parsed document, or a 400 naming what failed. */
export function validateRoles(text, home = homeDir()) {
  const { defaults, families } = shipped(home);
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw bad(400, `roles.json: not valid JSON (${e.message})`); }
  try { checkRoles(doc, 'roles.json', { families, shipped: defaults }); } catch (e) { throw bad(400, e.message); }
  return doc;
}

/** Refuse a symlink at the file or its folder, and anything that is not a plain file or folder. */
function checkBoundary(file) {
  const dir = path.dirname(file);
  for (const [p, kind] of [[dir, 'folder'], [file, 'file']]) {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (st.isSymbolicLink()) throw bad(409, `${tilde(p)} is a symlink; roles.json is written only at its own path, never through a link.`);
    if (kind === 'folder' ? !st.isDirectory() : !st.isFile()) throw bad(409, `${tilde(p)} is not a plain ${kind}.`);
  }
}

export async function writeRoles({ text, base, message, home = homeDir(), hist = history }) {
  const file = rolesUserPath(home);
  validateRoles(text, home);
  checkBoundary(file);
  const current = readUserRoles(home);
  if (typeof base !== 'string' || hashOf(current) !== base) throw bad(409, STALE);
  if (current === text) return { saved: false, unchanged: true, base };

  const warnings = [];
  if (current !== null) {
    try { await hist.recordBaseline(file, `state of ${tilde(file)} before edit`); }
    catch (e) { warnings.push(`The previous roles.json was not versioned first: ${e.message}`); }
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  checkBoundary(file);
  let mode = 0o644;
  try { mode = fs.statSync(file).mode & 0o777; } catch {}
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const fh = await fsp.open(tmp, 'wx', mode);
  try { await fh.writeFile(text); } finally { await fh.close(); }
  try {
    // Re-proved at the last moment: the awaits above are a window.
    checkBoundary(file);
    if (hashOf(readUserRoles(home)) !== base) throw bad(409, STALE);
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  let sha = null;
  try { sha = await hist.record(file, message); }
  catch (e) { warnings.push(`roles.json was written, but not versioned in history: ${e.message}`); }
  return { saved: true, sha, base: hashOf(text), warnings, historyError: warnings.length ? warnings.join(' ') : null };
}

/* ── direct edits: one role or one family's flavor at a time ─────────── */

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const asList = (v) => (typeof v === 'string' ? [v] : v);

/** A form value: '' / [] / undefined mean "not set". */
const given = (v) => !(v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length));

/**
 * What the user file must hold for an entry to end up as `want`: fields
 * equal to the default are left out, a default the user emptied becomes
 * null (cleared), and anything else is stored as given.
 */
function override(want, dflt, fields) {
  const out = {};
  for (const k of fields) {
    const w = want[k];
    const d = dflt?.[k];
    if (!given(w)) { if (d !== undefined) out[k] = null; continue; }
    const norm = k === 'use' ? asList(w) : w;
    if (d !== undefined && same(norm, k === 'use' ? asList(d) : d)) continue;
    out[k] = norm;
  }
  return out;
}

/** The user text with `section.key` set to `value` (or removed when null), every other byte kept. */
function withEntry(text, section, key, value) {
  if (text === null) {
    if (value === null) return null;
    return `${JSON.stringify({ version: 1, [section]: { [key]: value } }, null, 2)}\n`;
  }
  let root = scan(text);
  let sec = member(root, section);
  if (!sec || sec.value.type !== 'object') {
    if (value === null) return text;
    if (sec) throw bad(409, `roles.json: "${section}" is not an object; fix the file first.`);
    text = insertMember(text, root, section, '{}');
    root = scan(text);
    sec = member(root, section);
  }
  const m = member(sec.value, key);
  if (value === null) return m ? removeMember(text, sec.value, m) : text;
  const raw = JSON.stringify(value);
  return m ? replaceValue(text, m, raw) : insertMember(text, sec.value, key, raw);
}

/** Edits need a readable user file: an invalid one is fixed by hand or replaced by an accepted proposal. */
function editableText(home) {
  const loaded = loadRoles({ home });
  if (loaded.error && loaded.source) throw bad(409, `roles.json is invalid, so edits are refused until it is fixed: ${loaded.error}`);
  if (!loaded.source) throw bad(500, `The shipped roles are invalid: ${loaded.error}`);
  return { loaded, text: readUserRoles(home) };
}

async function editEntry({ section, key, value, base, message, home }) {
  const { text } = editableText(home);
  const next = withEntry(text, section, key, value);
  if (next === null || next === text) return { saved: false, unchanged: true, base: hashOf(text) };
  return writeRoles({ text: next, base, message, home });
}

const roleName = (name) => {
  if (typeof name !== 'string' || !ROLE_RE.test(name)) throw bad(400, `role name ${JSON.stringify(name)} must match [a-z][a-z0-9-]{0,31}`);
  return name;
};
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export async function setRole({ name, fields, base, home = homeDir() }) {
  roleName(name);
  if (!isObj(fields)) throw bad(400, 'fields must be an object');
  const { loaded } = editableText(home);
  const dflt = loaded.defaults.roles[name];
  if (!dflt && !given(fields.use)) throw bad(400, `role "${name}": a new role needs at least one family in "use"`);
  const value = override(fields, dflt, ROLE_FIELDS);
  return editEntry({ section: 'roles', key: name, value: Object.keys(value).length ? value : null, base, message: `roles: ${name} edited`, home });
}

export async function resetRole({ name, base, home = homeDir() }) {
  roleName(name);
  const { loaded } = editableText(home);
  if (!Object.hasOwn(loaded.defaults.roles, name)) throw bad(400, `"${name}" is your own role, with no default to reset to — delete it instead.`);
  return editEntry({ section: 'roles', key: name, value: null, base, message: `roles: ${name} reset to default`, home });
}

export async function deleteRole({ name, base, home = homeDir() }) {
  roleName(name);
  const { loaded } = editableText(home);
  if (Object.hasOwn(loaded.defaults.roles, name)) throw bad(400, `"${name}" is a default role; reset it instead of deleting it.`);
  if (!Object.hasOwn(loaded.roles, name)) throw bad(404, `there is no role "${name}"`);
  return editEntry({ section: 'roles', key: name, value: null, base, message: `roles: ${name} deleted`, home });
}

function knownFamily(family, loaded) {
  if (typeof family !== 'string' || !loaded.families.includes(family)) throw bad(400, `unknown model family "${family}"`);
  return family;
}

export async function setFlavor({ family, fields, base, home = homeDir() }) {
  if (!isObj(fields)) throw bad(400, 'fields must be an object');
  const { loaded } = editableText(home);
  knownFamily(family, loaded);
  const value = override(fields, loaded.defaults.flavor[family], FLAVOR_FIELDS);
  return editEntry({ section: 'flavor', key: family, value: Object.keys(value).length ? value : null, base, message: `roles: ${family} flavor edited`, home });
}

export async function resetFlavor({ family, base, home = homeDir() }) {
  const { loaded } = editableText(home);
  knownFamily(family, loaded);
  return editEntry({ section: 'flavor', key: family, value: null, base, message: `roles: ${family} flavor reset to default`, home });
}

/* ── the view ──────────────────────────────────────────────────────────── */

/**
 * Why a family needs a second look before a role leans on it: its id is
 * malformed, or the catalog says it is retiring or gone. A warning only:
 * resolution never substitutes another family, and track=false changes
 * nothing here.
 */
function familyWarnings(family, models, rows) {
  const id = models[family];
  const out = [];
  if (typeof id !== 'string' || !ID_RE.test(id)) out.push(`${family} resolves to ${JSON.stringify(id)}, which is not a valid model id.`);
  for (const a of rows.find((r) => r.family === family)?.alerts || []) {
    if (a.kind === 'retiring') out.push(`${family} (${id}) is retiring${a.date ? ` on ${String(a.date).slice(0, 10)}` : ''}.`);
    if (a.kind === 'vanished') out.push(`${family} (${id}) is no longer in its CLI's catalog.`);
  }
  return out;
}

export function rolesView({ home = homeDir(), modelRows = [] } = {}) {
  const loaded = loadRoles({ home });
  const { registry } = loadRegistry({ home });
  let text = null, readError = null;
  try { text = readUserRoles(home); } catch (e) { readError = e.message; }
  const effortOf = (role, f) => role.effort ?? loaded.flavor[f]?.effort ?? '';
  const roles = Object.keys(loaded.roles).sort().map((name) => {
    const r = loaded.roles[name];
    const warnings = [...new Set([...r.use, ...(r.alt ? [r.alt] : [])].flatMap((f) => familyWarnings(f, registry.models, modelRows)))];
    return {
      name,
      use: r.use,
      ids: r.use.map((f) => registry.models[f] ?? null),
      effort: r.effort ?? '',
      resolvedEffort: effortOf(r, r.use[0]),
      alt: r.alt ?? '',
      altId: r.alt ? registry.models[r.alt] ?? null : '',
      note: r.note ?? '',
      custom: loaded.custom.includes(name),
      provenance: loaded.provenance.roles[name],
      defaults: loaded.defaults.roles[name] ?? null,
      warnings,
    };
  });
  const flavor = loaded.families.map((family) => ({
    family,
    flavor: loaded.flavor[family] || {},
    provenance: loaded.provenance.flavor[family] || {},
    defaults: loaded.defaults.flavor?.[family] ?? null,
  }));
  return {
    roles,
    flavor,
    families: loaded.families,
    efforts: [...EFFORTS],
    limits: LIMITS,
    base: hashOf(text),
    userText: text,
    error: loaded.error || readError,
    userFile: tilde(rolesUserPath(home)),
  };
}
