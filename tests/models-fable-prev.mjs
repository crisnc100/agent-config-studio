/**
 * The `fable-prev` family: a pinned previous Fable, shipped like `grok-prev` (its own id, track: false, so detection
 * never proposes moving it). Real child processes of bin/model-id against a temp HOME; the shipped list and the
 * resolver's golden copy are read, never written.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

console.log('\nmodels: fable-prev, a pinned previous Fable');
for (const file of ['models.default.json', 'tests/fixtures/model-id-golden/models.default.json']) {
  const doc = read(file);
  ok(`${file}: fable-prev maps to claude-fable-5-1`, doc.models['fable-prev'] === 'claude-fable-5-1', JSON.stringify(doc.models));
  ok(`${file}: fable-prev is track: false, exactly like grok-prev`, JSON.stringify(doc.families?.['fable-prev']) === '{"track":false}'
    && JSON.stringify(doc.families['fable-prev']) === JSON.stringify(doc.families['grok-prev']), JSON.stringify(doc.families));
}
const home = tempDir('acs-fable-prev-');
const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'model-id.mjs'), 'fable-prev'], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } });
ok('model-id fable-prev resolves to claude-fable-5-1', r.status === 0 && r.stdout.trim() === 'claude-fable-5-1', `${r.status} ${r.stdout} ${r.stderr}`);
const t = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'model-id.mjs'), '--json'], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } });
let table = null;
try { table = JSON.parse(t.stdout); } catch { /* reported below */ }
ok('model-id --json lists fable-prev beside fable', table && JSON.stringify(table).includes('"fable-prev"') && JSON.stringify(table).includes('"fable"'), t.stdout.slice(0, 300));

// An id two families share: the audit names the tracked family, never the pinned one, and keeps its fix.
const { familyIndex } = await import(path.join(ROOT, 'lib', 'audit.js'));
const shipped = read('models.default.json');
const now = familyIndex(shipped)('claude-fable-5-1');
ok('audit: claude-fable-5-1 names fable (tracked), not fable-prev (pinned)', now?.family === 'fable' && now.exact === true && !now.ambiguous, JSON.stringify(now));
const later = familyIndex({ ...shipped, models: { ...shipped.models, fable: 'claude-fable-5-2' } });
ok('audit: once fable moves on, claude-fable-5-1 names fable-prev', later('claude-fable-5-1')?.family === 'fable-prev' && later('claude-fable-5-2')?.family === 'fable',
  JSON.stringify([later('claude-fable-5-1'), later('claude-fable-5-2')]));
const twoTracked = familyIndex({ models: { a: 'x-1', b: 'x-1' } })('x-1');
ok('audit: an id two tracked families share stays ambiguous', JSON.stringify(twoTracked?.ambiguous) === '["a","b"]', JSON.stringify(twoTracked));

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
