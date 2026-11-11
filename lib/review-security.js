/**
 * The review gate's security switch (Packs → Review gate): security.run in
 * the home review config, as a preview then a write, through the same file,
 * signature and backup as the other review settings (lib/review-settings.js).
 */
import { reviewConfigApply, reviewConfigFile, reviewConfigFiles, reviewConfigPlan, securityEdit } from './review-settings.js';

export const SECURITY_LEVELS = ['off', 'required', 'always'];
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

export const securityFiles = reviewConfigFiles;
export const securityFile = reviewConfigFile;

function edit(level) {
  if (!SECURITY_LEVELS.includes(level)) throw bad(`level must be one of ${SECURITY_LEVELS.join(', ')}`);
  return securityEdit(level);
}

/** What setting `level` would change: the file, a line diff, and the signature apply needs back. */
export function securityPlan(level, m) {
  const { doc, ...p } = reviewConfigPlan(m, edit(level));
  const run = doc.security && typeof doc.security === 'object' && !Array.isArray(doc.security) ? doc.security.run : undefined;
  return { level, was: SECURITY_LEVELS.includes(run) ? run : 'off', ...p };
}

/** Write the previewed change: refused unless the file is unchanged since the preview; the old file is backed up first. */
export function securityApply(level, signature, m) {
  return { level, ...reviewConfigApply(m, edit(level), signature, 'review-security') };
}
