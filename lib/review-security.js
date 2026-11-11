/**
 * The review gate's security switch (Packs → Review gate): security.run in
 * the home review config, through the Settings section's one writer
 * (lib/review-settings.js): same file and signature as the shared writer;
 * its backups go in their own -review-security folder.
 */
import { SECURITY_LEVELS, reviewConfigFile, reviewConfigFiles, settingsApply, settingsPlan } from './review-settings.js';

export { SECURITY_LEVELS };
export const securityFiles = reviewConfigFiles;
export const securityFile = reviewConfigFile;
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const check = (level) => { if (!SECURITY_LEVELS.includes(level)) throw bad(`level must be one of ${SECURITY_LEVELS.join(', ')}`); return level; };

/** What setting `level` would change: the file, a line diff, and the signature apply needs back. */
export function securityPlan(level, m) {
  const { doc, changesAsked, ...p } = settingsPlan({ 'security.run': check(level) }, m, { withDoc: true });
  const run = doc.security && typeof doc.security === 'object' && !Array.isArray(doc.security) ? doc.security.run : undefined;
  return { level, was: SECURITY_LEVELS.includes(run) ? run : 'off', ...p };
}

/** Write the previewed change: refused unless the file is unchanged since the preview; the old file is backed up first. */
export function securityApply(level, signature, m) {
  const { saved, ...r } = settingsApply({ 'security.run': check(level) }, signature, m, { backupName: 'review-security' });
  return { level, ...r };
}
