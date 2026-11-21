/**
 * Families added from a CLI's model list (~/.agent-config-studio/families.json): how the registry, model-id, roles
 * and pauses read them, what a hidden or broken entry does, and adding, changing and removing one, in-process and
 * through the real server. Every HOME is a temp dir, the process's own set before any studio module loads (history
 * writes under it); model-id and the server run as child processes.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { tempDir, track } from './fixtures/cleanup.mjs';

const realBefore = snapshotRealHomes();
process.env.HOME = fs.realpathSync(tempDir('acs-families-proc-'));
const { familiesPath, loadRegistry } = await import('../lib/models.js');
const { readPaused } = await import('../lib/roles.js');
const { resolverStale } = await import('../lib/roles-panel.js');
const { readCatalogs, agyModelsPath } = await import('../lib/models-catalog.js');
const { ADD_STALE, addable, adoptFamily, createModelsState, removeFamily, resetModel, setModel } = await import('../lib/models-panel.js');

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
  for (const args of [['--flavor', 'opusish'], ['--effort', 'opusish']]) {
    const f = run(h, ...args);
    ok(`model-id ${args[0]} on a hidden entry says the same`, f.code !== 0 && f.err.includes('families.json has it, but hidden: its id is not a gemini- id'), J(f));
  }
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

console.log('\nmodels/families: adding one of Antigravity\'s models');
const CATALOG = [
  { id: DEFAULTS.models.neon, displayName: 'Gemini 4 Neon', efforts: ['low', 'high'] },
  { id: ARGON, displayName: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'] },
  { id: HYDROGEN, displayName: 'Gemini 4 Hydrogen', efforts: ['low', 'high'] },
  { id: 'gemini-4-agent-orchestrator', displayName: 'Gemini 4 Orchestrator', efforts: null },
  { id: 'gemini-4-sol', displayName: 'Gemini 4 Sol', efforts: null },
  { id: 'gemini-4-gemini', displayName: 'Gemini 4 Gemini', efforts: null },
];
const plantAgy = (h, models = CATALOG) => write(agyModelsPath(h), { version: 1, fetchedAt: Date.now(), agyVersion: '1.5.13', models });
const catalogsOf = (h) => readCatalogs({ home: h });
const readOr = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const refused = async (p) => { try { await p; return null; } catch (e) { return e; } };
const freshResolver = (h) => {
  const lib = path.join(h, '.agent-config-studio', 'resolver', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  for (const f of ['roles.js', 'models.js']) fs.copyFileSync(path.join(ROOT, 'lib', f), path.join(lib, f));
};
{
  const h = home();
  plantAgy(h);
  const cats = catalogsOf(h);
  const list = addable(cats, loadRegistry({ home: h }));
  ok('the addable list leaves out the id neon holds and the orchestrator', J(list.map((m) => m.id)) === J([ARGON, HYDROGEN, 'gemini-4-sol', 'gemini-4-gemini'])
    && list[0].family === 'argon' && list[0].displayName === 'Gemini 4 Argon', J(list));
  ok('no Antigravity list: nothing to add', addable({}, loadRegistry({ home: h })).length === 0);

  const a = await adoptFamily({ id: ARGON, catalogs: cats, home: h });
  const doc = JSON.parse(readOr(familiesPath(h)));
  ok('Add writes one entry, named by the catalog word', a.saved === true && a.family === 'argon' && J(Object.keys(doc.families)) === '["argon"]'
    && doc.version === 1 && J(Object.keys(doc.families.argon)) === '["id","addedAt"]' && doc.families.argon.id === ARGON
    && Number.isFinite(Date.parse(doc.families.argon.addedAt)), readOr(familiesPath(h)));
  ok('...and it resolves at once', run(h, 'argon').out === `${ARGON}\n` && loadRegistry({ home: h }).userFamilies.argon?.id === ARGON);
  ok('...and nothing else is written', !fs.existsSync(studio(h, 'models.json')) && !fs.existsSync(studio(h, 'roles.json')));
  ok('...and it leaves the addable list', !addable(cats, loadRegistry({ home: h })).some((m) => m.id === ARGON));

  const before = readOr(familiesPath(h));
  for (const [what, id, status, re] of [
    ['an id a family already holds (argon)', ARGON, 409, /^argon already uses gemini-4-argon\.$/],
    ['an id a shipped family holds (neon)', DEFAULTS.models.neon, 409, /^neon already uses /],
    ['an orchestrator', 'gemini-4-agent-orchestrator', 400, /has no family name of its own/],
    ['an id not in the list', 'gemini-4-xenon', 400, /is not in Antigravity's model list/],
    ['a name a shipped family has (sol)', 'gemini-4-sol', 409, /A family named sol already exists/],
    ['a reserved name (gemini)', 'gemini-4-gemini', 400, /cannot be added as gemini: "gemini" is reserved/],
    ['not an id', 'Gemini 4', 400, /is not a valid model id/],
  ]) {
    const e = await refused(adoptFamily({ id, catalogs: cats, home: h }));
    ok(`Add refuses ${what}: ${status}`, e?.status === status && re.test(e.message), e?.message);
  }
  ok('...and none of them wrote anything', readOr(familiesPath(h)) === before);
  const none = await refused(adoptFamily({ id: HYDROGEN, catalogs: {}, home: h }));
  ok('Add with no Antigravity list → 409 naming Check now', none?.status === 409 && /Press Check now first/.test(none.message), none?.message);

  // Two tabs adding at once: neither entry is lost.
  const both = await Promise.all([adoptFamily({ id: HYDROGEN, catalogs: cats, home: h }), refused(adoptFamily({ id: HYDROGEN, catalogs: cats, home: h }))]);
  const after = JSON.parse(readOr(familiesPath(h)));
  ok('two Adds at once: one saves, the second sees it and refuses', both[0].saved === true && both[1]?.status === 409
    && J(Object.keys(after.families)) === '["argon","hydrogen"]', J(after));
}
{
  const h = home();
  plantAgy(h);
  const hidden = '{\n  "version": 1,\n  "families": {\n    "hydrogen": { "id": "gemini-4-hydrogen", "harness": "opencode" },\n    "zz9": {"id":"gemini-4-zz"}\n  },\n  "note": "kept"\n}\n';
  write(familiesPath(h), hidden);
  const e = await refused(adoptFamily({ id: HYDROGEN, catalogs: catalogsOf(h), home: h }));
  ok('Add refuses a name a hidden entry has', e?.status === 409 && /A family named hydrogen already exists/.test(e.message), e?.message);
  await adoptFamily({ id: ARGON, catalogs: catalogsOf(h), home: h });
  const added = readOr(familiesPath(h));
  ok('Add keeps the hidden entries and the unknown key byte for byte', added.startsWith(hidden.slice(0, hidden.indexOf('\n  },'))) && added.endsWith('\n  },\n  "note": "kept"\n}\n')
    && JSON.parse(added).families.argon.id === ARGON, added);
  const r = await removeFamily({ family: 'argon', home: h });
  ok('Remove brings the file back byte for byte', r.saved === true && readOr(familiesPath(h)) === hidden, readOr(familiesPath(h)));
  const rh = await refused(removeFamily({ family: 'hydrogen', home: h }));
  ok('Remove refuses a hidden entry (not a family you added)', rh?.status === 400 && readOr(familiesPath(h)) === hidden, rh?.message);
}
{
  const h = home();
  plantAgy(h);
  write(familiesPath(h), '{ broken');
  const e = await refused(adoptFamily({ id: ARGON, catalogs: catalogsOf(h), home: h }));
  ok('Add refuses while families.json is broken, and writes nothing', e?.status === 409 && /families\.json is invalid/.test(e.message) && readOr(familiesPath(h)) === '{ broken', e?.message);
  write(familiesPath(h), J({ version: 2, families: {} }));
  const v2 = await refused(adoptFamily({ id: ARGON, catalogs: catalogsOf(h), home: h }));
  ok('...and while it is a newer version', v2?.status === 409 && /version 2 is newer/.test(v2.message), v2?.message);
}
{
  const h = home();
  plantAgy(h);
  freshResolver(h);
  ok('a matching installed resolver: Add goes through', (await adoptFamily({ id: ARGON, catalogs: catalogsOf(h), home: h })).saved === true);
  fs.appendFileSync(path.join(h, '.agent-config-studio', 'resolver', 'lib', 'models.js'), '// an older copy\n');
  const before = readOr(familiesPath(h));
  const e = await refused(adoptFamily({ id: HYDROGEN, catalogs: catalogsOf(h), home: h }));
  ok('a stale installed resolver: Add → 409 with the install line, nothing written', e?.status === 409 && e.message === ADD_STALE && readOr(familiesPath(h)) === before, e?.message);
}

console.log('\nmodels/families: Set, Accept and Reset on an added family');
{
  const h = home();
  plantAgy(h);
  const cats = catalogsOf(h);
  await adoptFamily({ id: ARGON, catalogs: cats, home: h });
  const unlisted = await setModel({ family: 'argon', id: 'gemini-4-argon-x', catalogs: cats, home: h });
  ok('Set to an id not in the list asks to confirm', unlisted.needsConfirm === true && /not in the Antigravity catalog/.test(unlisted.warnings.join(' ')), J(unlisted));
  const set = await setModel({ family: 'argon', id: 'gemini-4-argon-x', confirm: true, catalogs: cats, home: h });
  ok('...confirmed, it writes families.json and never models.json', set.saved === true && set.old === ARGON
    && JSON.parse(readOr(familiesPath(h))).families.argon.id === 'gemini-4-argon-x' && !fs.existsSync(studio(h, 'models.json')), J(set));
  const before = readOr(familiesPath(h));
  for (const id of ['claude-opus-9', 'gpt-6.2-sol']) {
    const e = await refused(setModel({ family: 'argon', id, confirm: true, catalogs: cats, home: h }));
    ok(`Set to ${id} is refused even confirmed: the read side would hide it`, e?.status === 400 && /its id is not a gemini- id/.test(e.message), e?.message);
  }
  ok('...and nothing is written', readOr(familiesPath(h)) === before && !fs.existsSync(studio(h, 'models.json')));
  const rs = await refused(resetModel({ family: 'argon', home: h }));
  ok('Reset on an added family → 400, Remove instead', rs?.status === 400 && /no shipped id to reset to/.test(rs.message) && readOr(familiesPath(h)) === before, rs?.message);
  const opus = await setModel({ family: 'opus', id: 'claude-opus-9-9', confirm: true, catalogs: cats, home: h });
  ok('a shipped family still writes models.json', opus.saved === true && JSON.parse(readOr(studio(h, 'models.json'))).models.opus === 'claude-opus-9-9');
}
{
  const h = home();
  plantAgy(h);
  write(familiesPath(h), J({ version: 1, families: { argon: { id: 'gemini-4-first' }, hydrogen: { id: HYDROGEN } } }).replace('"hydrogen"', '"argon"'));
  ok('(a file naming argon twice reads the last)', loadRegistry({ home: h }).userFamilies.argon?.id === HYDROGEN);
  const before = readOr(familiesPath(h));
  const e = await refused(setModel({ family: 'argon', id: 'gemini-4-argon-y', confirm: true, catalogs: catalogsOf(h), home: h }));
  ok('Set on it is refused rather than editing the entry that is not read', e?.status === 409 && /could not be edited safely/.test(e.message) && readOr(familiesPath(h)) === before, e?.message);
}

console.log('\nmodels/families: Remove');
{
  const h = home();
  plantAgy(h);
  await adoptFamily({ id: ARGON, catalogs: catalogsOf(h), home: h });
  const fam = readOr(familiesPath(h));
  for (const [what, roles, paused, re] of [
    ['a role uses it', { version: 2, roles: { reviewer: { use: ['opus', 'argon'] } } }, null, /still named by the reviewer role\./],
    ['a role\'s second opinion', { version: 2, roles: { reviewer: { use: ['opus'], alt: 'argon' } } }, null, /the reviewer role's second opinion/],
    ['its flavor', { version: 2, flavor: { argon: { brief: 'x' } } }, null, /still named by its flavor/],
    ['a pause', null, { version: 1, paused: [{ name: 'argon', until: '2000-01-01T00:00:00Z' }] }, /still named by a pause/],
    ['roles.json is invalid', '{ nope', null, /roles\.json or paused\.json is invalid/],
  ]) {
    fs.rmSync(studio(h, 'roles.json'), { force: true });
    fs.rmSync(studio(h, 'paused.json'), { force: true });
    if (roles) write(studio(h, 'roles.json'), roles);
    if (paused) write(studio(h, 'paused.json'), paused);
    const e = await refused(removeFamily({ family: 'argon', home: h }));
    ok(`Remove is refused while ${what}`, e?.status === 409 && re.test(e.message) && readOr(familiesPath(h)) === fam, e?.message);
  }
  fs.rmSync(studio(h, 'paused.json'), { force: true });
  write(studio(h, 'roles.json'), { version: 2, roles: { reviewer: { use: ['opus'] } } });
  const rolesBefore = readOr(studio(h, 'roles.json'));
  const r = await removeFamily({ family: 'argon', home: h });
  ok('named nowhere: Remove takes it out of families.json only', r.saved === true && J(JSON.parse(readOr(familiesPath(h))).families) === '{}'
    && readOr(studio(h, 'roles.json')) === rolesBefore && !fs.existsSync(studio(h, 'models.json')) && !fs.existsSync(studio(h, 'paused.json')), readOr(familiesPath(h)));
  ok('...and argon no longer resolves', run(h, 'argon').code === 1);
  const again = await refused(removeFamily({ family: 'argon', home: h }));
  ok('Remove of a family that is not there → 400', again?.status === 400);
  const shipped = await refused(removeFamily({ family: 'neon', home: h }));
  ok('Remove of a shipped family → 400', shipped?.status === 400 && /is not a family you added/.test(shipped.message));
}

console.log('\nmodels/families: the panel view');
{
  const h = home();
  plantAgy(h);
  await adoptFamily({ id: ARGON, catalogs: catalogsOf(h), home: h });
  const st = createModelsState({ detectFn: async () => [], codexHomes: () => [], home: h });
  const v = await st.view();
  const row = v.rows.find((r) => r.family === 'argon');
  ok('the added family has a row: source added, no shipped id', row?.source === 'added' && row.defaultId === null && row.id === ARGON && row.displayName === 'Gemini 4 Argon', J(row));
  ok('the view lists what is left to add, and no families.json problems', J(v.addable.map((m) => m.family)) === '["hydrogen","sol","gemini"]' && v.familiesError === null && J(v.familiesHidden) === '{}', J(v.addable));
  plantAgy(h, [...CATALOG, { id: 'gemini-4.1-argon', displayName: 'Gemini 4.1 Argon', efforts: null }]);
  await st.check();
  const upd = (await st.view()).rows.find((r) => r.family === 'argon');
  ok('a newer Argon in the list is an update alert on the added family', upd.alerts.some((a) => a.kind === 'update' && a.candidate === 'gemini-4.1-argon'), J(upd.alerts));
  write(familiesPath(h), '{ broken');
  const broken = await st.view();
  ok('a broken families.json: the view says so, and the family has no row', /not valid JSON/.test(broken.familiesError || '') && !broken.rows.some((r) => r.family === 'argon'), broken.familiesError);
}

console.log('\nmodels/families: the routes, through the real server');
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
{
  const h = home();
  plantAgy(h, [...CATALOG, { id: 'gemini-4.1-argon', displayName: 'Gemini 4.1 Argon', efforts: null }]);
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { HOME: h, PORT: String(port), PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: os.tmpdir() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  track(child);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const base = `http://localhost:${port}`;
  const post = async (route, body, headers = { origin: base, 'sec-fetch-site': 'same-origin' }) => {
    const r = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: J(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    if (child.exitCode !== null) break;
    try { up = (await fetch(`${base}/api/health`)).ok; } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  try {
    ok('the server starts', up, out.slice(-400));
    const cross = await post('/api/models/adopt', { id: ARGON }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
    ok('a cross-site Add → 403, nothing written', cross.status === 403 && !fs.existsSync(familiesPath(h)), J(cross));
    const a = await post('/api/models/adopt', { id: ARGON });
    ok('Add through the route', a.status === 200 && a.body.family === 'argon' && JSON.parse(readOr(familiesPath(h))).families.argon.id === ARGON, J(a));
    const v = await (await fetch(`${base}/api/models`)).json();
    const row = v.rows.find((r) => r.family === 'argon');
    ok('GET /api/models: the row says added, with the update alert', row?.source === 'added' && row.alerts.some((x) => x.kind === 'update'), J(row));
    ok('...and the addable list, with no file path in it', v.addable.some((m) => m.id === HYDROGEN) && !J(v).includes(h));
    const where = await fetch(`${base}/api/models/where?family=argon`);
    ok('where-used knows the added family', where.status === 200);
    const alert = row.alerts.find((x) => x.kind === 'update');
    const acc = await post('/api/models/accept', { family: 'argon', key: alert.key });
    ok('Accept writes the newer id into families.json, not models.json', acc.status === 200 && JSON.parse(readOr(familiesPath(h))).families.argon.id === 'gemini-4.1-argon'
      && !fs.existsSync(studio(h, 'models.json')), J(acc));
    const reset = await post('/api/models/reset', { family: 'argon' });
    ok('Reset on it → 400', reset.status === 400, J(reset));
    const xr = await post('/api/models/remove', { family: 'argon' }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
    ok('a cross-site Remove → 403, nothing removed', xr.status === 403 && !!JSON.parse(readOr(familiesPath(h))).families.argon, J(xr));
    const rm = await post('/api/models/remove', { family: 'argon' });
    ok('Remove through the route', rm.status === 200 && rm.body.removed === 'argon' && !JSON.parse(readOr(familiesPath(h))).families.argon, J(rm));
    const arr = await post('/api/models/adopt', [ARGON]);
    ok('a body that is not an object → 400', arr.status === 400, J(arr));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const gone = new Promise((r) => child.once('exit', r));
      child.kill('SIGINT');
      await gone;
    }
  }
}

assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
