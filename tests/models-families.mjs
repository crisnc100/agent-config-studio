/**
 * Families added from a CLI's model list (~/.agent-config-studio/families.json): how the registry, model-id, roles
 * and pauses read them, and what a hidden or broken entry does. Every HOME is a temp dir; model-id runs as a child
 * process against it.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { familiesPath, loadRegistry } from '../lib/models.js';
import { readPaused } from '../lib/roles.js';
import { resolverStale } from '../lib/roles-panel.js';
import { tempDir } from './fixtures/cleanup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'model-id');
const DEFAULTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.default.json'), 'utf8'));
const ARGON = 'gemini-4-argon';
const HYDROGEN = 'gemini-4-hydrogen';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const J = JSON.stringify;
const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof body === 'string' ? body : J(body)); };
const home = () => fs.realpathSync(tempDir('acs-families-'));
const studio = (h, name) => path.join(h, '.agent-config-studio', name);
const families = (h, fams, extra = {}) => write(familiesPath(h), { version: 1, families: fams, ...extra });
function run(h, ...args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { HOME: h, PATH: '/usr/bin:/bin' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

console.log('\nmodels/families: model-id reads added families');
{
  const h = home();
  const plain = J(Object.keys(JSON.parse(run(h, '--json').out)).sort());
  families(h, { argon: { id: ARGON, addedAt: '2026-11-21T00:00:00Z' } });
  const r = run(h, 'argon');
  ok('model-id argon → its id', r.code === 0 && r.out === `${ARGON}\n`, J(r));
  ok('--table lists it', /^argon\s+gemini-4-argon$/m.test(run(h, '--table').out));
  const j = JSON.parse(run(h, '--json').out);
  ok('--json has it under models, and no new top-level key', j.models.argon === ARGON && J(Object.keys(j).sort()) === plain, J(Object.keys(j)));
  ok('shipped families still resolve', run(h, 'opus').out === `${DEFAULTS.models.opus}\n`);
  const reg = loadRegistry({ home: h });
  ok('loadRegistry: userFamilies beside defaults, not inside registry', reg.userFamilies.argon?.id === ARGON
    && !Object.hasOwn(reg.registry, 'userFamilies') && !Object.hasOwn(reg.registry, 'familiesHidden') && reg.familiesError === null, J(Object.keys(reg)));
  ok('...defaults stay the shipped document', !Object.hasOwn(reg.defaults.models, 'argon'));
}
{
  const h = home();
  write(studio(h, 'models.json'), { version: 1, models: { opus: 'claude-opus-9' } });
  families(h, { argon: { id: ARGON } });
  const reg = loadRegistry({ home: h });
  ok('added families sit beside a models.json override', reg.registry.models.argon === ARGON && reg.registry.models.opus === 'claude-opus-9');
  write(studio(h, 'models.json'), '{ broken');
  const broken = loadRegistry({ home: h });
  ok('...and stay when models.json is broken (roles may name them)', !!broken.error && broken.registry.models.argon === ARGON);
}
{
  const h = home();
  families(h, { argon: { id: ARGON } });
  ok('cache: the first read sees argon', loadRegistry({ home: h }).registry.models.argon === ARGON);
  families(h, { argon: { id: HYDROGEN }, hydrogen: { id: 'gemini-4-hydrogen-x' } });
  const next = loadRegistry({ home: h });
  ok('cache: an edit to families.json shows on the next read', next.registry.models.argon === HYDROGEN && next.registry.models.hydrogen === 'gemini-4-hydrogen-x', J(next.registry.models));
}

console.log('\nmodels/families: a broken file never breaks the shipped families');
for (const [what, body] of [
  ['not JSON', '{ nope'],
  ['not an object', '[1, 2]'],
  ['version 2', J({ version: 2, families: { argon: { id: ARGON } } })],
  ['no version', J({ families: { argon: { id: ARGON } } })],
  ['families not an object', J({ version: 1, families: ['argon'] })],
]) {
  const h = home();
  write(familiesPath(h), body);
  const reg = loadRegistry({ home: h });
  ok(`${what}: model-id opus still works`, run(h, 'opus').code === 0 && reg.error === null, run(h, 'opus').err);
  const a = run(h, 'argon');
  ok(`${what}: no family is added, and the error names families.json`, a.code === 1 && !reg.registry.models.argon && !!reg.familiesError
    && /families\.json could not be read/.test(a.err), a.err);
}
{
  const h = home();
  write(familiesPath(h), J({ version: 3, families: { argon: { id: ARGON } } }));
  ok('a newer version says to update the resolver', /version 3 is newer than this resolver understands — run: acs install-model-id/.test(loadRegistry({ home: h }).familiesError));
}

console.log('\nmodels/families: an entry this build cannot use is hidden, alone');
{
  const h = home();
  families(h, {
    argon: { id: ARGON },
    argontwo: { id: HYDROGEN, harness: 'opencode' },
    hydrogen2: { id: HYDROGEN },
    gemini: { id: HYDROGEN },
    neon: { id: HYDROGEN },
    opusish: { id: 'claude-opus-9' },
    badid: { id: 'Gemini 4' },
    when: { id: HYDROGEN, addedAt: 5 },
    notobj: 'gemini-4-x',
  }, { note: 'a key a later build added' });
  const reg = loadRegistry({ home: h });
  ok('the good entry is added', reg.registry.models.argon === ARGON && reg.familiesError === null, reg.familiesError);
  const want = {
    argontwo: 'it has a key this ACS does not know ("harness")',
    hydrogen2: 'its name must be 2–24 lowercase letters',
    gemini: '"gemini" is reserved (a CLI or account name)',
    neon: 'a shipped family has this name',
    opusish: 'its id is not a gemini- id',
    badid: 'its id is not a valid model id',
    when: 'addedAt must be a date and time',
    notobj: 'it must be an object',
  };
  for (const [name, why] of Object.entries(want)) ok(`hidden: ${name} — ${why}`, reg.familiesHidden[name] === why, reg.familiesHidden[name]);
  ok('no hidden entry reaches the registry; a shipped name keeps the shipped id', !['argontwo', 'hydrogen2', 'gemini', 'opusish', 'badid', 'when', 'notobj'].some((n) => Object.hasOwn(reg.registry.models, n))
    && reg.registry.models.neon === DEFAULTS.models.neon);
  ok('an unknown top-level key is ignored, not an error', reg.familiesError === null);
  const o = run(h, 'opusish');
  ok('model-id on a hidden entry names families.json and why', o.code === 1 && o.err.includes('families.json has it, but hidden: its id is not a gemini- id'), o.err);
}

console.log('\nmodels/families: roles and pauses');
{
  const h = home();
  families(h, { argon: { id: ARGON } });
  write(studio(h, 'roles.json'), { version: 2, roles: { reviewer: { use: ['argon', 'opus'] } }, flavor: { argon: { brief: 'Give it the diff.' } } });
  const r = run(h, '--role', 'reviewer');
  ok('a role naming an added family resolves to it', r.code === 0 && r.out === `family=argon id=${ARGON} effort= alt=\n`, J(r));
  ok('its flavor reads', /Briefing argon: Give it the diff\./.test(run(h, '--flavor', 'argon').out));
  write(studio(h, 'paused.json'), { version: 1, paused: [{ name: 'argon' }] });
  const p = readPaused({ home: h });
  ok('a pause naming it reads', p.error === null && p.active.map((e) => e.name).join() === 'argon', J(p));
  const skipped = run(h, '--role', 'reviewer');
  ok('...and the role skips it', skipped.code === 0 && skipped.out.startsWith('family=opus '), J(skipped));
}
{
  const h = home();
  families(h, { argon: { id: 'claude-opus-9' } });
  write(studio(h, 'roles.json'), { version: 2, roles: { reviewer: { use: ['argon'] } } });
  const r = run(h, '--role', 'reviewer');
  ok('a role naming a hidden entry: roles.json is invalid, and the error names families.json and why', r.code === 2
    && r.err.includes('unknown family "argon"') && r.err.includes('families.json has it, but hidden: its id is not a gemini- id'), r.err);
  write(studio(h, 'roles.json'), { version: 2, roles: { reviewer: { use: ['opus'] } }, flavor: { argon: { brief: 'x' } } });
  const f = run(h, '--role', 'reviewer');
  ok('a flavor naming it: the same', f.code === 2 && f.err.includes('flavor: unknown family "argon"') && f.err.includes('hidden: its id is not a gemini- id'), f.err);
  write(studio(h, 'paused.json'), { version: 1, paused: [{ name: 'argon' }] });
  const p = readPaused({ home: h });
  ok('a pause naming it: paused.json is invalid, with families.json and why', /is not a vendor .* or a model family — ~\/\.agent-config-studio\/families\.json has it, but hidden/.test(p.error || ''), p.error);
}
{
  const h = home();
  write(familiesPath(h), '{ broken');
  write(studio(h, 'roles.json'), { version: 2, roles: { reviewer: { use: ['argon'] } } });
  const r = run(h, '--role', 'reviewer');
  ok('a role naming an added family while families.json is broken: the error says the file could not be read', r.code === 2
    && r.err.includes('unknown family "argon"') && r.err.includes('families.json could not be read'), r.err);
}

console.log('\nmodels/families: a stale installed resolver');
{
  const h = home();
  const lib = path.join(h, '.agent-config-studio', 'resolver', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'lib', 'roles.js'), path.join(lib, 'roles.js'));
  fs.copyFileSync(path.join(ROOT, 'lib', 'models.js'), path.join(lib, 'models.js'));
  ok('identical roles.js and models.js: not stale', resolverStale(h) === false);
  fs.appendFileSync(path.join(lib, 'models.js'), '// an older copy, before families.json\n');
  ok('a different models.js: stale', resolverStale(h) === true);
  fs.rmSync(path.join(lib, 'models.js'));
  ok('no models.js beside a matching roles.js: not stale', resolverStale(h) === false);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
