/**
 * The review gate's settings in Packs → Review gate, each a preview then a
 * write to the home review config: the first of ~/.agent-config-studio/
 * review-gate/config.json and ~/.claude/review-config.json that exists, or
 * the first when neither does — the file the review script reads first.
 * Every other key in it is kept as it is.
 *
 * Apply takes the preview's signature and refuses (409) unless the file still
 * reads as it did then; the old file is copied into the backups folder and
 * read back before the new one is written.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { lineDiff } from './describe.js';
import { realFile, saveBackup, snapshot, writeAtomic } from './packs-files.js';
import { readUserText } from './paths.js';

// The review script's own values (packs/review-gate/runtime/review.mjs MERGE_POLICIES and crossFamily).
export const MERGE_POLICIES = ['off', 'strict', 'standard', 'always'];
export const CROSS_FAMILY = ['prefer', 'off'];
const MAX_PATHS = 64;
const MAX_PATH_LEN = 200;

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const tilde = (m, p) => (p === m.home || p.startsWith(`${m.home}/`) ? `~${p.slice(m.home.length)}` : p);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export const reviewConfigFiles = (m) => [path.join(m.runtime, 'config.json'), path.join(m.claudeHome, 'review-config.json')];
export const reviewConfigFile = (m) => reviewConfigFiles(m).find((f) => fs.existsSync(f)) ?? reviewConfigFiles(m)[0];

/**
 * The file now and as `edit(doc)` would leave it. edit returns the new doc,
 * or null when the file already says it — then it is left byte for byte,
 * however it is formatted. Refuses a file that is not a JSON object.
 */
function read(m, edit) {
  const file = reviewConfigFile(m);
  const snap = snapshot(file);
  if (snap && snap.type !== 'file') throw bad(`${tilde(m, file)} is not a plain file`);
  const current = snap ? snap.bytes.toString('utf8') : '';
  let doc = {};
  if (current.trim()) {
    try { doc = JSON.parse(current); } catch (e) { throw bad(`${tilde(m, file)} is not valid JSON (${e.message}) — fix it first; nothing was changed`, 409); }
    if (!isObj(doc)) throw bad(`${tilde(m, file)} is not a JSON object — fix it first; nothing was changed`, 409);
  }
  const out = edit(doc);
  const next = out === null ? current : `${JSON.stringify(out, null, 2)}\n`;
  const signature = crypto.createHash('sha256').update(`${file}\0${current}\0${next}`).digest('hex');
  return { file, snap, current, next, doc, signature };
}

function plan(m, edit) {
  const r = read(m, edit);
  return { file: tilde(m, r.file), exists: !!r.snap, current: r.current, next: r.next, changes: r.current !== r.next, diff: lineDiff(r.current, r.next), signature: r.signature, doc: r.doc };
}

function apply(m, edit, signature, backupName) {
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) throw bad('signature must be the preview\'s signature (preview first)');
  const r = read(m, edit);
  if (r.signature !== signature) throw bad('the review config changed since the preview — preview it again', 409);
  if (r.current === r.next) return { file: tilde(m, r.file), changed: false, backup: null };
  let backup = null;
  if (r.snap) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let dir = path.join(m.backups, `${stamp}-${backupName}`), n = 0;
    while (fs.existsSync(dir)) dir = path.join(m.backups, `${stamp}-${backupName}-${++n}`);
    backup = saveBackup(dir, 0, realFile(r.file), r.snap);
  }
  writeAtomic(r.file, r.next, r.snap?.mode ?? 0o644);
  return { file: tilde(m, r.file), changed: true, backup: backup ? tilde(m, backup) : null };
}

/** The security switch's edit: security.run, the rest of security kept. */
export function securityEdit(level) {
  return (doc) => {
    const security = isObj(doc.security) ? doc.security : {};
    return security.run === level ? null : { ...doc, security: { ...security, run: level } };
  };
}
export const reviewConfigPlan = plan;
export const reviewConfigApply = apply;

/* ── agent merge: merge.policy and merge.alwaysHuman ─────────────────── */

const mergeNow = (doc) => {
  const merge = isObj(doc.merge) ? doc.merge : {};
  const policy = String(merge.policy ?? 'off').trim().toLowerCase();
  return {
    policy: MERGE_POLICIES.includes(policy) ? policy : 'off',
    alwaysHuman: Array.isArray(merge.alwaysHuman) ? merge.alwaysHuman.filter((g) => typeof g === 'string' && g.trim()) : [],
  };
};

function mergeWant(body) {
  const { policy, alwaysHuman } = body || {};
  if (!MERGE_POLICIES.includes(policy)) throw bad(`policy must be one of ${MERGE_POLICIES.join(', ')}`);
  if (!Array.isArray(alwaysHuman) || alwaysHuman.length > MAX_PATHS) throw bad(`alwaysHuman must be a list of at most ${MAX_PATHS} paths`);
  const paths = [];
  for (const g of alwaysHuman) {
    if (typeof g !== 'string') throw bad('each path must be text');
    const p = g.trim();
    if (!p || p.length > MAX_PATH_LEN || /[\u0000-\u001f\u007f]/.test(p)) throw bad(`each path must be one line of 1 to ${MAX_PATH_LEN} characters`);
    if (!paths.includes(p)) paths.push(p);
  }
  return { policy, alwaysHuman: paths };
}

function mergeEdit(want) {
  return (doc) => {
    const merge = isObj(doc.merge) ? doc.merge : {};
    const next = { ...merge, policy: want.policy };
    // An empty list is the default: no key is added for it, and an existing one is emptied rather than dropped.
    if (want.alwaysHuman.length || Object.hasOwn(merge, 'alwaysHuman')) next.alwaysHuman = want.alwaysHuman;
    return isObj(doc.merge) && isDeepStrictEqual(next, merge) ? null : { ...doc, merge: next };
  };
}

/** What setting merge to `body` ({ policy, alwaysHuman }) would change. */
export function mergePlan(body, m) {
  const want = mergeWant(body);
  const { doc, ...p } = plan(m, mergeEdit(want));
  return { ...want, was: mergeNow(doc), ...p };
}
export function mergeApply(body, signature, m) {
  const want = mergeWant(body);
  return { ...want, ...apply(m, mergeEdit(want), signature, 'review-merge') };
}

/* ── cross-vendor checks: crossFamily ────────────────────────────────── */

const crossNow = (doc) => {
  const v = String(doc.crossFamily ?? 'prefer').trim().toLowerCase();
  return CROSS_FAMILY.includes(v) ? v : 'prefer';
};
function crossEdit(mode) {
  if (!CROSS_FAMILY.includes(mode)) throw bad(`mode must be one of ${CROSS_FAMILY.join(', ')}`);
  return (doc) => (doc.crossFamily === mode ? null : { ...doc, crossFamily: mode });
}
export function crossFamilyPlan(mode, m) {
  const { doc, ...p } = plan(m, crossEdit(mode));
  return { mode, was: crossNow(doc), ...p };
}
export function crossFamilyApply(mode, signature, m) {
  return { mode, ...apply(m, crossEdit(mode), signature, 'review-cross-family') };
}

/**
 * The merge and cross-vendor settings as the home review config sets them,
 * read-only for the page: the defaults when no file, or a file that does
 * not parse.
 */
export function reviewSettings(m) {
  for (const file of reviewConfigFiles(m)) {
    if (!fs.existsSync(file)) continue;
    let doc;
    try { doc = JSON.parse(readUserText(file)); } catch { doc = null; }
    if (!isObj(doc)) doc = {};
    return { merge: mergeNow(doc), crossFamily: crossNow(doc) };
  }
  return { merge: mergeNow({}), crossFamily: 'prefer' };
}
