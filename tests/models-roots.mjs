/**
 * Review-config discovery follows roots.json (builds/ready-for-strangers
 * criterion 3, B11), through both entry points: lib/models.js as the server
 * imports it, and the INSTALLED resolver (`model-id --install` into a temp
 * HOME, then that copy's `--lint`), which runs with nothing of the checkout
 * beside it.
 *
 * A root anywhere is scanned; ~/Documents/Projects is not, unless it is a
 * root; a missing, invalid or emptied roots.json scans no project folder; a
 * root that is HOME itself is skipped.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { lintScope, projectRoots } from '../lib/models.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realBefore = snapshotRealHomes();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const write = (f, body) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };

console.log('\nmodels: review configs follow roots.json');
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-models-roots-')));
const elsewhere = path.join(home, 'code', 'work');
const inRoot = path.join(elsewhere, 'app', '.claude', 'review-config.json');
const legacy = path.join(home, ['Documents', 'Projects'].join(path.sep), 'old', '.claude', 'review-config.json');
write(inRoot, '{\n  "model": "gpt-5.6-sol"\n}\n');
write(legacy, '{\n  "model": "gpt-5.6-terra"\n}\n');
const rootsFile = path.join(home, '.agent-config-studio', 'roots.json');
const setRoots = (doc) => write(rootsFile, typeof doc === 'string' ? doc : JSON.stringify(doc));
const root = (p, id = 'work') => ({ id, path: p, label: id, access: 'read' });

// The installed copy: nothing of this checkout beside it.
const inst = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'model-id'), '--install'], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
const installed = path.join(home, '.agent-config-studio', 'bin', 'model-id');
ok('model-id --install into the temp HOME', inst.status === 0 && fs.existsSync(installed), inst.stderr);
const lint = () => {
  const r = spawnSync(installed, ['--lint'], { env: { HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

const cases = [
  ['a root elsewhere', [root(elsewhere)], true, false],
  ['~/Documents/Projects only when it is a root', [root(elsewhere), root(path.dirname(path.dirname(path.dirname(legacy))), 'projects')], true, true],
  ['a root that is HOME itself is skipped', [root(home, 'home')], false, false],
  ['a root that no longer exists is skipped', [root(path.join(home, 'gone'))], false, false],
  ['a root removed from the file (revoked) is not scanned', [], false, false],
];
for (const [what, roots, wantIn, wantLegacy] of cases) {
  setRoots({ version: 1, roots });
  const scope = lintScope(home);
  ok(`3 server path, ${what}: the root's review config ${wantIn ? 'is' : 'is not'} found`, scope.includes(fs.realpathSync(inRoot)) === wantIn, JSON.stringify(scope));
  ok(`3 server path, ${what}: ~/Documents/Projects ${wantLegacy ? 'is' : 'is not'} scanned`, scope.some((f) => f.endsWith(path.join('old', '.claude', 'review-config.json'))) === wantLegacy, JSON.stringify(scope));
  const r = lint();
  ok(`B11 installed resolver, ${what}: ${wantIn ? 'flags' : 'does not flag'} the root's config`, /work\/app\/\.claude\/review-config\.json:2/.test(r.out) === wantIn, r.out);
  ok(`B11 installed resolver, ${what}: ${wantLegacy ? 'flags' : 'never reads'} ~/Documents/Projects`, /old\/\.claude\/review-config\.json/.test(r.out) === wantLegacy, r.out);
  ok(`B11 installed resolver, ${what}: exit ${wantIn || wantLegacy ? 1 : 0}`, r.code === (wantIn || wantLegacy ? 1 : 0), `${r.code} ${r.out}`);
}

for (const [what, body] of [['missing', null], ['not JSON', '{ "roots": '], ['no roots list', '{"version":1}'], ['roots not a list', '{"roots":{}}']]) {
  if (body === null) fs.rmSync(rootsFile, { force: true }); else setRoots(body);
  ok(`B11 roots.json ${what}: no project folder is scanned (server path)`, projectRoots(home).length === 0 && !lintScope(home).some((f) => f.endsWith('review-config.json') && f.includes(`${path.sep}app${path.sep}`)));
  const r = lint();
  ok(`B11 roots.json ${what}: the installed resolver runs clean`, r.code === 0, r.out);
}

fs.rmSync(home, { recursive: true, force: true });
assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
