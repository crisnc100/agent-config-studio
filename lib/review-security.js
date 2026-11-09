/**
 * The review gate's security switch (Packs → Review gate): security.run in
 * the home review config, as a preview then a write. The file is the one the
 * review script reads first: the first of ~/.agent-config-studio/review-gate/
 * config.json and ~/.claude/review-config.json that exists, or the first when
 * neither does. Every other key in it is kept as it is.
 *
 * Apply takes the preview's signature and refuses (409) unless the file still
 * reads as it did then; the old file is copied into the backups folder and
 * read back before the new one is written.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lineDiff } from './describe.js';
import { realFile, saveBackup, snapshot, writeAtomic } from './packs-files.js';

export const SECURITY_LEVELS = ['off', 'required', 'always'];
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const tilde = (m, p) => (p === m.home || p.startsWith(`${m.home}/`) ? `~${p.slice(m.home.length)}` : p);

export const securityFiles = (m) => [path.join(m.runtime, 'config.json'), path.join(m.claudeHome, 'review-config.json')];
export const securityFile = (m) => securityFiles(m).find((f) => fs.existsSync(f)) ?? securityFiles(m)[0];

/** The file now and as it would be with run set to `level`; refuses a file that is not a JSON object. */
function read(level, m) {
  if (!SECURITY_LEVELS.includes(level)) throw bad(`level must be one of ${SECURITY_LEVELS.join(', ')}`);
  const file = securityFile(m);
  const snap = snapshot(file);
  if (snap && snap.type !== 'file') throw bad(`${tilde(m, file)} is not a plain file`);
  const current = snap ? snap.bytes.toString('utf8') : '';
  let doc = {};
  if (current.trim()) {
    try { doc = JSON.parse(current); } catch (e) { throw bad(`${tilde(m, file)} is not valid JSON (${e.message}) — fix it first; nothing was changed`, 409); }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw bad(`${tilde(m, file)} is not a JSON object — fix it first; nothing was changed`, 409);
  }
  const security = doc.security && typeof doc.security === 'object' && !Array.isArray(doc.security) ? doc.security : {};
  // A file that already says this level is left byte for byte, however it is formatted.
  const next = security.run === level ? current : `${JSON.stringify({ ...doc, security: { ...security, run: level } }, null, 2)}\n`;
  const was = SECURITY_LEVELS.includes(security.run) ? security.run : 'off';
  const signature = crypto.createHash('sha256').update(`${file}\0${current}\0${next}`).digest('hex');
  return { file, snap, current, next, was, signature };
}

/** What setting `level` would change: the file, a line diff, and the signature apply needs back. */
export function securityPlan(level, m) {
  const r = read(level, m);
  return {
    level, was: r.was, file: tilde(m, r.file), exists: !!r.snap,
    current: r.current, next: r.next, changes: r.current !== r.next, diff: lineDiff(r.current, r.next), signature: r.signature,
  };
}

/** Write the previewed change: refused unless the file is unchanged since the preview; the old file is backed up first. */
export function securityApply(level, signature, m) {
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) throw bad('signature must be the preview\'s signature (preview first)');
  const r = read(level, m);
  if (r.signature !== signature) throw bad('the review config changed since the preview — preview it again', 409);
  if (r.current === r.next) return { level, file: tilde(m, r.file), changed: false, backup: null };
  let backup = null;
  if (r.snap) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let dir = path.join(m.backups, `${stamp}-review-security`), n = 0;
    while (fs.existsSync(dir)) dir = path.join(m.backups, `${stamp}-review-security-${++n}`);
    backup = saveBackup(dir, 0, realFile(r.file), r.snap);
  }
  writeAtomic(r.file, r.next, r.snap?.mode ?? 0o644);
  return { level, file: tilde(m, r.file), changed: true, backup: backup ? tilde(m, backup) : null };
}
