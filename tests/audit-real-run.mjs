/**
 * The audit against the REAL home and the real roots (builds/skills-audit
 * A7) — read-only, and proving it. Not part of ./verify.sh: run it by hand.
 *
 *   node tests/audit-real-run.mjs [--vendor] [--clean <word>,<word>…]
 *
 * Two deterministic passes. Before the first, the clock is noted; after it,
 * every file the audit read must have a ctime older than that (any write or
 * chmod moves ctime). Then every scanned file — plugin cache included — is
 * hashed, the second pass runs, and every file is hashed again: the lists and
 * the hashes must match. The audit's dismissed list must be untouched too.
 * `--clean` names folders (by a word in their display path) that must have no
 * findings at all; `--vendor` also prints vendor findings, hidden otherwise.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const showVendor = args.includes('--vendor');
const at = args.indexOf('--clean');
const clean = at >= 0 ? (args[at + 1] || '').split(',').filter(Boolean) : [];

const { createAudit } = await import('../lib/audit.js');
const quiet = { recordBaseline: async () => { throw new Error('read-only run'); }, record: async () => { throw new Error('read-only run'); } };
const dismissed = path.join(os.homedir(), '.agent-config-studio', 'audit-dismissed.json');
const hashOf = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch (e) { return `unreadable:${e.code}`; } };
const statOf = (f) => { try { return fs.statSync(f); } catch { return null; } };
let failed = 0;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `\n      ${detail}` : ''}`); if (!cond) failed++; };

const dismissedBefore = hashOf(dismissed);
const t0 = Date.now() - 1000;
const audit = createAudit({ hist: quiet });
const first = await audit.run({ refresh: true });
const list1 = audit.scannedFiles().sort();
const touched = list1.filter((f) => { const st = statOf(f); return !st || st.ctimeMs >= t0; });
const before = new Map(list1.map((f) => [f, hashOf(f)]));
const second = await audit.run({ refresh: true });
const list2 = audit.scannedFiles().sort();
const changed = list2.filter((f) => before.get(f) !== hashOf(f));

console.log('\naudit real run — read-only\n');
console.log(`scanned ${first.counts.files} files (${(list1.reduce((n, f) => n + (statOf(f)?.size || 0), 0) / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  by class: ${Object.entries(first.counts.byClass).map(([c, v]) => `${c} ${v.files} files / ${v.findings} findings / ${v.fixable} fixable`).join('; ')}`);
console.log(`  skipped: ${first.counts.skipped.tooLarge} over 1 MB, ${first.counts.skipped.binary} binary, ${first.counts.skipped.backup} backups; refused: ${first.counts.refused}`);
console.log(`  partial: ${first.partial ? first.partialReasons.join('; ') : 'no'}`);
console.log(`  policy: ${first.policyError || 'registry and roles valid'}`);
for (const r of first.refusals.slice(0, 20)) console.log(`  refused  ${r.path} — ${r.reason}`);
console.log('');
check('nothing the audit read was written during the first pass (ctime)', touched.length === 0, touched.slice(0, 10).join(', '));
check(`the second pass read the same ${list1.length} files`, JSON.stringify(list1) === JSON.stringify(list2));
check('every scanned file hashes the same before and after the second pass', changed.length === 0, changed.slice(0, 10).join(', '));
check('the dismissed list is untouched', hashOf(dismissed) === dismissedBefore);
check('the two passes agree on every finding', JSON.stringify(first.files) === JSON.stringify(second.files));

console.log('\nfindings (vendor hidden unless --vendor):');
let hidden = 0;
for (const f of first.files) {
  if (f.cls === 'vendor' && !showVendor) { hidden += f.findings.length; continue; }
  console.log(`\n  ${f.display}  [${f.cls}]${f.copies.length ? `  (+${f.copies.length} identical ${f.copies.length === 1 ? 'copy' : 'copies'})` : ''}${f.aliases ? `  (${f.aliases} link${f.aliases === 1 ? '' : 's'} to it)` : ''}`);
  for (const x of f.findings) {
    const tag = [x.severity, x.stale ? `stale → ${x.family}` : x.family ? x.family : null, x.fixable ? 'fixable' : null, x.guide ? 'in model guide' : null, x.dismissed ? 'dismissed' : null].filter(Boolean).join(', ');
    console.log(`    ${String(x.line).padStart(4)}  ${x.rule}  ${x.match.slice(0, 60)}  (${tag})`);
  }
}
console.log(`\n${hidden} vendor finding${hidden === 1 ? '' : 's'} hidden`);
for (const word of clean) {
  const hits = first.files.filter((f) => f.display.includes(word) && f.findings.length);
  const read = list1.filter((f) => f.includes(word)).length;
  check(`no findings in the ${read} scanned files under "${word}"`, read > 0 && hits.length === 0, hits.map((f) => `${f.display}: ${f.findings.map((x) => `${x.line} ${x.rule} ${x.match}`).join('; ')}`).join(' | '));
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall read-only checks passed');
process.exit(failed ? 1 : 0);
