/**
 * The review gate's Settings section (Packs → Review gate): one writer for
 * a short allow-list of keys in the home review config — the first of
 * ~/.agent-config-studio/review-gate/config.json and
 * ~/.claude/review-config.json that exists, or the first when neither does,
 * the file the review script reads first. Every other key is kept as it is.
 *
 * A plan returns the diff and a signature; apply refuses (409) unless the
 * file still reads as it did then, copies the old file into the backups
 * folder once per save, and writes the new one atomically.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lineDiff } from './describe.js';
import { realFile, saveBackup, snapshot, writeAtomic } from './packs-files.js';
import { readUserText } from './paths.js';

// Kept in step with packs/review-gate/runtime/review.mjs (MERGE_POLICIES, SECURITY_RUNS, crossFamily, ALWAYS_HUMAN
// and RISK_PATHS's default); tests/packs-review-settings.mjs reads the script to check the last two.
export const MERGE_POLICIES = ['off', 'strict', 'standard', 'always'];
export const SECURITY_LEVELS = ['off', 'required', 'always'];
export const CROSS_FAMILY = ['prefer', 'off'];
export const BUILT_IN_HUMAN = ['.github/workflows/**', 'package.json'];
export const DEFAULT_RISK_PATHS = ['*payment*', '*billing*', '*checkout*', '*auth*', '*migration*', '*security*', '*money*'];
const MAX_PATHS = 64;
const MAX_PATH_LEN = 200;

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const tilde = (m, p) => (p === m.home || p.startsWith(`${m.home}/`) ? `~${p.slice(m.home.length)}` : p);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const oneOf = (list, what) => (v) => { if (!list.includes(v)) throw bad(`${what} must be one of ${list.join(', ')}`); return v; };

function globList(v) {
  if (!Array.isArray(v) || v.length > MAX_PATHS) throw bad(`merge.alwaysHuman must be a list of at most ${MAX_PATHS} paths`);
  const out = [];
  for (const g of v) {
    if (typeof g !== 'string') throw bad('each path must be text');
    const p = g.trim();
    if (!p || p.length > MAX_PATH_LEN || /[\u0000-\u001f\u007f]/.test(p)) throw bad(`each path must be one line of 1 to ${MAX_PATH_LEN} characters`);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * The keys the section may write: [object, field] in the config, and the check that turns a request's value into
 * the value written. `blankIsDefault` keys add nothing to a file that lacks them when the value is the empty default.
 */
const KEYS = {
  'security.run': { at: ['security', 'run'], check: oneOf(SECURITY_LEVELS, 'security.run') },
  'merge.policy': { at: ['merge', 'policy'], check: oneOf(MERGE_POLICIES, 'merge.policy') },
  'merge.alwaysHuman': { at: ['merge', 'alwaysHuman'], check: globList, blankIsDefault: true },
  crossFamily: { at: [null, 'crossFamily'], check: oneOf(CROSS_FAMILY, 'crossFamily') },
};

export const reviewConfigFiles = (m) => [path.join(m.runtime, 'config.json'), path.join(m.claudeHome, 'review-config.json')];
export const reviewConfigFile = (m) => reviewConfigFiles(m).find((f) => fs.existsSync(f)) ?? reviewConfigFiles(m)[0];

function wanted(changes) {
  if (!isObj(changes)) throw bad('changes must be an object of settings to change');
  const keys = Object.keys(changes);
  if (!keys.length) throw bad('changes is empty: nothing to change');
  const out = [];
  for (const k of keys) {
    if (!Object.hasOwn(KEYS, k)) throw bad(`"${k.slice(0, 64)}" is not a setting this page writes (${Object.keys(KEYS).join(', ')})`);
    out.push([k, KEYS[k].check(changes[k])]);
  }
  return out;
}

/** The doc with every change laid in, or null when the file already says all of them (then it is left byte for byte). */
function edit(doc, want) {
  let next = doc, changed = false;
  for (const [k, value] of want) {
    const { at: [obj, field], blankIsDefault } = KEYS[k];
    const parent = obj === null ? next : isObj(next[obj]) ? next[obj] : {};
    const has = Object.hasOwn(parent, field);
    if (has && JSON.stringify(parent[field]) === JSON.stringify(value)) continue;
    if (!has && blankIsDefault && Array.isArray(value) && !value.length) continue;
    changed = true;
    next = obj === null ? { ...next, [field]: value } : { ...next, [obj]: { ...parent, [field]: value } };
  }
  return changed ? next : null;
}

function read(m, want) {
  const file = reviewConfigFile(m);
  const snap = snapshot(file);
  if (snap && snap.type !== 'file') throw bad(`${tilde(m, file)} is not a plain file`);
  const current = snap ? snap.bytes.toString('utf8') : '';
  let doc = {};
  if (current.trim()) {
    try { doc = JSON.parse(current); } catch (e) { throw bad(`${tilde(m, file)} is not valid JSON (${e.message}) — fix it first; nothing was changed`, 409); }
    if (!isObj(doc)) throw bad(`${tilde(m, file)} is not a JSON object — fix it first; nothing was changed`, 409);
  }
  const out = edit(doc, want);
  const next = out === null ? current : `${JSON.stringify(out, null, 2)}\n`;
  const signature = crypto.createHash('sha256').update(`${file}\0${current}\0${next}`).digest('hex');
  return { file, snap, current, next, doc, signature };
}

/** What `changes` ({ key: value } over the allow-list) would do to the file: a line diff and the signature apply needs. */
export function settingsPlan(changes, m, { withDoc = false } = {}) {
  const want = wanted(changes);
  const r = read(m, want);
  return {
    changesAsked: Object.fromEntries(want), file: tilde(m, r.file), exists: !!r.snap, current: r.current, next: r.next,
    changes: r.current !== r.next, diff: lineDiff(r.current, r.next), signature: r.signature, ...(withDoc ? { doc: r.doc } : {}),
  };
}

/** Write the previewed changes: refused unless the file is unchanged since the preview; the old file is backed up once first. */
export function settingsApply(changes, signature, m, { backupName = 'review-settings' } = {}) {
  const want = wanted(changes);
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) throw bad('signature must be the preview\'s signature (preview first)');
  const r = read(m, want);
  if (r.signature !== signature) throw bad('the review config changed since the preview — preview it again', 409);
  const saved = Object.fromEntries(want);
  if (r.current === r.next) return { saved, file: tilde(m, r.file), changed: false, backup: null };
  let backup = null, dir = null;
  if (r.snap) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    dir = path.join(m.backups, `${stamp}-${backupName}`);
    let n = 0;
    while (fs.existsSync(dir)) dir = path.join(m.backups, `${stamp}-${backupName}-${++n}`);
    backup = saveBackup(dir, 0, realFile(r.file), r.snap);
  }
  writeAtomic(r.file, r.next, r.snap?.mode ?? 0o644);
  // The copy sits under the backup folder at its real path (saveBackup's layout), so the page names the folder.
  return { saved, file: tilde(m, r.file), changed: true, backup: backup ? tilde(m, backup) : null, backupDir: backup ? `${tilde(m, dir)}/` : null };
}

/**
 * The section's values as the home review config sets them, for the page:
 * the review script's defaults where the file says nothing, has an unknown
 * value or does not parse. Paths are shown as written; the file is named
 * with ~ so no absolute home path leaves the server.
 */
export function reviewSettings(m) {
  const file = reviewConfigFile(m);
  let doc = {};
  if (fs.existsSync(file)) {
    try { doc = JSON.parse(readUserText(file)); } catch { doc = {}; }
    if (!isObj(doc)) doc = {};
  }
  const merge = isObj(doc.merge) ? doc.merge : {};
  const policy = String(merge.policy ?? 'off').trim().toLowerCase();
  const cross = String(doc.crossFamily ?? 'prefer').trim().toLowerCase();
  const custom = Array.isArray(doc.riskPaths);
  return {
    merge: {
      policy: MERGE_POLICIES.includes(policy) ? policy : 'off',
      alwaysHuman: Array.isArray(merge.alwaysHuman) ? merge.alwaysHuman.filter((g) => typeof g === 'string' && g.trim()) : [],
      builtIn: BUILT_IN_HUMAN,
      riskPaths: custom ? doc.riskPaths.filter((g) => typeof g === 'string') : DEFAULT_RISK_PATHS,
      riskPathsFrom: custom ? 'config' : 'default',
    },
    crossFamily: CROSS_FAMILY.includes(cross) ? cross : 'prefer',
    reviewConfig: { file: tilde(m, file), exists: fs.existsSync(file) },
  };
}
