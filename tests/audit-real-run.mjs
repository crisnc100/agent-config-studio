/**
 * The audit against the REAL home and the real roots (builds/skills-audit
 * A7) — read-only, and proving it. Not part of ./verify.sh: run it by hand.
 *
 *   node tests/audit-real-run.mjs [--vendor] [--clean <word>,<word>…]
 *
 * Before anything runs, this script builds its OWN manifest of every
 * candidate file — the global instruction files, every file under the skills
 * homes and the plugin cache's skills, and every CLAUDE.md / AGENTS.md and
 * project skill file under every root (linked worktrees included) — without
 * the audit's walk, and hashes it. Two deterministic passes follow. Before the
 * first, the clock is noted; after it, every file the audit read must have a
 * ctime older than that (any write or chmod moves ctime). Then every scanned
 * file is hashed, the second pass runs, and every file is hashed again: the
 * lists and the hashes must match. After the last pass the manifest is hashed
 * again: zero bytes changed, and every file the audit read is in it. The
 * audit's dismissed list must be untouched too. It prints both passes' cut
 * notices and the linked-worktree counts.
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
const { currentRoots } = await import('../lib/paths.js');
const quiet = { recordBaseline: async () => { throw new Error('read-only run'); }, record: async () => { throw new Error('read-only run'); } };
const dismissed = path.join(os.homedir(), '.agent-config-studio', 'audit-dismissed.json');
const hashOf = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch (e) { return `unreadable:${e.code}`; } };
const statOf = (f) => { try { return fs.statSync(f); } catch { return null; } };
let failed = 0;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `\n      ${detail}` : ''}`); if (!cond) failed++; };

/** Every candidate file, found by this script alone: regular files, through links, depth-bounded. */
function manifest() {
  const H = os.homedir();
  const out = new Set();
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.cache', 'target', 'coverage']);
  const add = (f) => { try { const r = fs.realpathSync(f); if (fs.statSync(r).isFile()) out.add(r); } catch {} };
  const every = (dir, depth = 0, seen = new Set()) => {
    if (depth > 10) return;
    let real; try { real = fs.realpathSync(dir); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    let ents; try { ents = fs.readdirSync(real, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      const abs = path.join(real, d.name);
      let st; try { st = fs.statSync(abs); } catch { continue; }
      if (st.isDirectory()) { if (!SKIP.has(d.name)) every(abs, depth + 1, seen); } else if (st.isFile()) add(abs);
    }
  };
  for (const f of [path.join(H, '.claude', 'CLAUDE.md'), path.join(H, '.codex', 'AGENTS.md'), path.join(H, '.grok', 'AGENTS.md')]) add(f);
  for (const d of [path.join(H, '.claude', 'skills'), path.join(H, '.codex', 'skills'), path.join(H, '.agents', 'skills')]) every(d);
  // Plugin skills: every `skills` folder in the cache.
  const cache = path.join(H, '.claude', 'plugins', 'cache');
  const plugins = (dir, depth = 0) => {
    if (depth > 6) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) if (d.isDirectory()) { const abs = path.join(dir, d.name); if (d.name === 'skills') every(abs); else plugins(abs, depth + 1); }
  };
  plugins(cache);
  const tree = (dir, depth = 0) => {
    if (depth > 8) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (SKIP.has(d.name)) continue;
        if (['.claude', '.codex', '.agents'].includes(d.name)) every(path.join(abs, 'skills'), depth + 2);
        else tree(abs, depth + 1);
      } else if (d.name === 'CLAUDE.md' || d.name === 'AGENTS.md') add(abs);
    }
  };
  for (const r of currentRoots().active) tree(r.real);
  return [...out].sort();
}
const manifestFiles = manifest();
const manifestBefore = new Map(manifestFiles.map((f) => [f, hashOf(f)]));
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
const manifestChanged = manifestFiles.filter((f) => manifestBefore.get(f) !== hashOf(f));
const inManifest = new Set(manifestFiles);
const unlisted = list2.filter((f) => !inManifest.has(f));
const cuts = (r) => (r.partial ? r.partialReasons.join('; ') : 'none');

console.log('\naudit real run — read-only\n');
console.log(`scanned ${first.counts.files} files (${(list1.reduce((n, f) => n + (statOf(f)?.size || 0), 0) / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  by class: ${Object.entries(first.counts.byClass).map(([c, v]) => `${c} ${v.files} files / ${v.findings} findings / ${v.fixable} fixable`).join('; ')}`);
console.log(`  skipped: ${first.counts.skipped.tooLarge} over 1 MB, ${first.counts.skipped.binary} binary, ${first.counts.skipped.backup} backups; refused: ${first.counts.refused}`);
console.log(`  manifest (built before the first pass, by this script): ${manifestFiles.length} candidate files`);
console.log(`  cut notices, first pass: ${cuts(first)}`);
console.log(`  cut notices, last pass:  ${cuts(second)}`);
const wtCards = first.files.filter((f) => f.worktree);
console.log(`  linked worktrees: ${(first.worktrees || []).length} repositories, ${(first.worktrees || []).reduce((n, w) => n + w.files, 0)} files read, ${wtCards.length} cards with findings`);
for (const w of first.worktrees || []) console.log(`    ${w.label}: ${w.files} files, ${wtCards.filter((f) => f.worktree.repo === w.repo).reduce((n, f) => n + f.findings.filter((x) => !x.dismissed).length, 0)} findings`);
console.log(`  policy: ${first.policyError || 'registry and roles valid'}`);
for (const r of first.refusals.slice(0, 20)) console.log(`  refused  ${r.path} — ${r.reason}`);
console.log('');
check('nothing the audit read was written during the first pass (ctime)', touched.length === 0, touched.slice(0, 10).join(', '));
check(`the second pass read the same ${list1.length} files`, JSON.stringify(list1) === JSON.stringify(list2));
check('every scanned file hashes the same before and after the second pass', changed.length === 0, changed.slice(0, 10).join(', '));
check(`the manifest's ${manifestFiles.length} files hash the same before the first pass and after the last: zero bytes changed`, manifestChanged.length === 0, manifestChanged.slice(0, 10).join(', '));
check('every file the audit read is in the independent manifest', unlisted.length === 0, unlisted.slice(0, 10).join(', '));
check('the dismissed list is untouched', hashOf(dismissed) === dismissedBefore);
check('the two passes agree on every finding', JSON.stringify(first.files) === JSON.stringify(second.files));

console.log('\nfindings (vendor hidden unless --vendor):');
let hidden = 0;
for (const f of first.files) {
  if (f.cls === 'vendor' && !showVendor) { hidden += f.findings.length; continue; }
  console.log(`\n  ${f.display}  [${f.cls}]${f.worktree ? `  (worktree of ${f.worktree.label})` : ''}${f.copies.length ? `  (+${f.copies.length} identical ${f.copies.length === 1 ? 'copy' : 'copies'})` : ''}${f.aliases ? `  (${f.aliases} link${f.aliases === 1 ? '' : 's'} to it)` : ''}`);
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
