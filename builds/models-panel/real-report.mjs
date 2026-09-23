/**
 * Criterion 3: the detector, read-only, against this machine's real catalogs.
 * Prints the full alert list and each catalog's state. Writes nothing.
 *
 *   node builds/models-panel/real-report.mjs
 */
import { detectHarnesses } from '../../lib/harness.js';
import { loadRegistry } from '../../lib/models.js';
import { detect, readCatalogs } from '../../lib/models-catalog.js';
import { readDismissed, userOverrides } from '../../lib/models-panel.js';
import { loadSeats } from '../../lib/usage/seats.js';

const codexHomes = loadSeats().seats.filter((s) => s.vendor === 'codex' && s.home).map((s) => s.home);
const claudeVersion = (await detectHarnesses()).find((h) => h.id === 'claude')?.version ?? null;
const catalogs = readCatalogs({ codexHomes });
const reg = loadRegistry();
const { rows, pending } = detect({
  registry: reg.registry, defaults: reg.defaults, catalogs, overrides: reg.error ? [] : userOverrides(),
  claudeVersion, dismissed: readDismissed(),
});

console.log(`registry error: ${reg.error ?? 'none'}`);
console.log(`claude code: ${claudeVersion}`);
for (const c of Object.values(catalogs)) {
  console.log(`catalog ${c.vendor}: ok=${c.ok} models=${c.models.length} fetched=${c.fetchedAt ? new Date(c.fetchedAt).toISOString() : '-'} note=${c.note ?? '-'}${c.disagree ? ` disagree=${c.disagree}` : ''}`);
}
for (const r of rows) {
  const a = r.alerts.map((x) => `${x.kind}${x.candidate ? `→${x.candidate}` : ''}${x.acceptable === false ? ' (not acceptable)' : ''}${x.dismissed ? ' (dismissed)' : ''}`);
  console.log(`${r.family.padEnd(10)} ${r.id.padEnd(28)} ${r.source.padEnd(8)} track=${r.track} in-catalog=${r.displayName ? 'yes' : 'NO'}  alerts: ${a.join(', ') || 'none'}`);
}
console.log(`pending alerts: ${pending}`);
