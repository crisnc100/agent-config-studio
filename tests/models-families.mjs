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
import { claudeModel, codexModel, grokModel, writeClaudeCatalog, writeCodexCatalog, writeGrokCatalog } from './fixtures/models-home.mjs';

const realBefore = snapshotRealHomes();
process.env.HOME = fs.realpathSync(tempDir('acs-families-proc-'));
const { familiesPath, loadRegistry, tracks } = await import('../lib/models.js');
const { readPaused } = await import('../lib/roles.js');
const { resolverStale } = await import('../lib/roles-panel.js');
const { readCatalogs, agyModelsPath, detect, newestFor, planSync } = await import('../lib/models-catalog.js');
const { shapeModels } = await import('../lib/usage/gemini.js');
const { ADD_STALE, addable, adoptFamily, createModelsState, heldBy, pinFamily, removeFamily, resetModel, setModel, syncFamilies } = await import('../lib/models-panel.js');

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
    llamaish: { id: 'llama-4-x' },
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
    llamaish: 'its id does not start with claude-, gpt-, grok-, gemini-',
    badid: 'its id is not a valid model id',
    when: 'addedAt must be a date and time',
    notobj: 'it must be an object',
  };
  for (const [name, why] of Object.entries(want)) ok(`hidden: ${name} — ${why}`, reg.familiesHidden[name] === why, reg.familiesHidden[name]);
  ok('no hidden entry reaches the registry; a shipped name keeps the shipped id', !['argontwo', 'hydrogen2', 'gemini', 'llamaish', 'badid', 'when', 'notobj'].some((n) => Object.hasOwn(reg.registry.models, n))
    && reg.registry.models.neon === DEFAULTS.models.neon);
  ok('an unknown top-level key is ignored, not an error', reg.familiesError === null);
  const o = run(h, 'llamaish');
  ok('model-id on a hidden entry names families.json and why', o.code === 1 && o.err.includes('families.json has it, but hidden: its id does not start with claude-, gpt-, grok-, gemini-'), o.err);
  for (const args of [['--flavor', 'llamaish'], ['--effort', 'llamaish']]) {
    const f = run(h, ...args);
    ok(`model-id ${args[0]} on a hidden entry says the same`, f.code !== 0 && f.err.includes('families.json has it, but hidden: its id does not start with claude-, gpt-, grok-, gemini-'), J(f));
  }
}

console.log('\nmodels/families: every vendor\'s ids, and pins');
{
  const h = home();
  families(h, {
    luna: { id: 'gpt-6-luna' },
    mythos: { id: 'claude-mythos-1' },
    nova: { id: 'grok-5' },
    argon: { id: ARGON, track: false },
    flash: { id: 'gemini-3.8-flash', track: true },
    llamaish: { id: 'llama-4-x' },
    pinny: { id: HYDROGEN, track: 'no' },
  });
  for (const [name, id] of [['luna', 'gpt-6-luna'], ['mythos', 'claude-mythos-1'], ['nova', 'grok-5']]) {
    const r = run(h, name);
    ok(`a ${id.split('-')[0]}- entry resolves (${name})`, r.code === 0 && r.out === `${id}\n`, J(r));
  }
  const reg = loadRegistry({ home: h });
  ok('an id with no known prefix is hidden, with why', reg.familiesHidden.llamaish === 'its id does not start with claude-, gpt-, grok-, gemini-', reg.familiesHidden.llamaish);
  ok('a track that is not true or false is hidden, with why', reg.familiesHidden.pinny === 'track must be true or false', reg.familiesHidden.pinny);
  ok('track: false pins the family where tracks() reads it', reg.registry.families.argon?.track === false && tracks(reg.registry, 'argon') === false, J(reg.registry.families));
  ok('...track: true and no track both follow', tracks(reg.registry, 'flash') && tracks(reg.registry, 'luna') && !Object.hasOwn(reg.registry.families, 'flash'));
  ok('...and the shipped pins stay', reg.registry.families['grok-prev']?.track === false);
  ok('...the shipped document is untouched', !Object.hasOwn(reg.defaults.families, 'argon'));
  const cats = { agy: { ok: true, models: [{ id: ARGON, family: 'argon', hidden: false }, { id: 'gemini-4.1-argon', family: 'argon', hidden: false }] } };
  const row = detect({ registry: reg.registry, defaults: reg.defaults, catalogs: cats }).rows.find((x) => x.family === 'argon');
  ok('a pinned family\'s row is untracked, with no update alert', row.track === false && !row.alerts.some((a) => a.kind === 'update'), J(row));
  const j = JSON.parse(run(h, '--json').out);
  ok('model-id --json: no new top-level key with a pin', J(Object.keys(j).sort()) === J(Object.keys(JSON.parse(run(home(), '--json').out)).sort()), J(Object.keys(j)));
  ok('neon still resolves to the shipped id', run(h, 'neon').out === `${DEFAULTS.models.neon}\n`);
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
  families(h, { argon: { id: 'llama-4-x' } });
  write(studio(h, 'roles.json'), { version: 2, roles: { reviewer: { use: ['argon'] } } });
  const r = run(h, '--role', 'reviewer');
  ok('a role naming a hidden entry: roles.json is invalid, and the error names families.json and why', r.code === 2
    && r.err.includes('unknown family "argon"') && r.err.includes('families.json has it, but hidden: its id does not start with claude-, gpt-, grok-, gemini-'), r.err);
  write(studio(h, 'roles.json'), { version: 2, roles: { reviewer: { use: ['opus'] } }, flavor: { argon: { brief: 'x' } } });
  const f = run(h, '--role', 'reviewer');
  ok('a flavor naming it: the same', f.code === 2 && f.err.includes('flavor: unknown family "argon"') && f.err.includes('hidden: its id does not start with claude-, gpt-, grok-, gemini-'), f.err);
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
  for (const id of ['llama-4-x', 'mistral-9']) {
    const e = await refused(setModel({ family: 'argon', id, confirm: true, catalogs: cats, home: h }));
    ok(`Set to ${id} is refused even confirmed: the read side would hide it`, e?.status === 400 && /its id does not start with claude-, gpt-, grok-, gemini-/.test(e.message), e?.message);
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

console.log('\nmodels/families: sync plans from every catalog');
const CC = '2.1.300 (Claude Code)';
const agyEntry = (id, displayName = id, efforts = null) => ({ id, displayName, efforts });
const SYNC = {
  claude: [
    claudeModel('claude-opus-5-5', 'Opus 5.5', 'Opus'),
    claudeModel('claude-lyra-2', 'Lyra 2', 'Lyra'),
    claudeModel('claude-lyra-2-20260101', 'Lyra 2 (snapshot)', 'Lyra'),
    claudeModel('claude-mythos-1', 'Mythos 1', 'Mythos', '9.0.0'),
  ],
  codex: [
    codexModel('gpt-6.2-sol', 'Sol'),
    codexModel('gpt-6-luna', 'Luna'),
    codexModel('gpt-5.6-luna', 'Luna 5.6'),
    codexModel('gpt-7-vega', 'Vega', 'hide'),
    codexModel('gpt-6-latest', 'Latest'),
    codexModel('codex-6-nova', 'Codex Nova'),
    codexModel('gpt-6-gemini', 'Gemini?'),
  ],
  grok: [grokModel('grok-4.7', 'Grok 4.7'), grokModel('grok-4.8-build-fast', 'Grok 4.8 Fast')],
  agy: [
    agyEntry(DEFAULTS.models.neon, 'Gemini 4 Neon'), agyEntry('gemini-4.1-neon', 'Gemini 4.1 Neon'),
    agyEntry(ARGON, 'Gemini 4 Argon'), agyEntry(HYDROGEN, 'Gemini 4 Hydrogen'),
    agyEntry('gemini-pro-orchestrator-neon', 'Orchestrator'), agyEntry('gemini-4-sol', 'Gemini 4 Sol'), agyEntry('gemini-4-luna', 'Gemini 4 Luna'),
  ],
};
function plantAll(h, c = SYNC) {
  const at = Date.now() - 60000;
  if (c.claude) writeClaudeCatalog(h, c.claude, at);
  if (c.codex) writeCodexCatalog(path.join(h, '.codex'), c.codex, at);
  if (c.grok) writeGrokCatalog(h, c.grok, at);
  if (c.agy) plantAgy(h, c.agy);
}
const sync = (h, cc = CC) => syncFamilies({ catalogs: catalogsOf(h), claudeVersion: cc, home: h });
const famDoc = (h) => JSON.parse(readOr(familiesPath(h)));
const ids = (h) => Object.fromEntries(Object.entries(famDoc(h).families).map(([k, v]) => [k, v.id]));
const why = (r, family, vendor) => r.skipped.find((x) => x.family === family && x.vendor === vendor)?.why;
{
  const h = home();
  plantAll(h);
  const r = await sync(h);
  ok('a sync adds each new word at its newest id, and nothing else', J(ids(h)) === J({ lyra: 'claude-lyra-2', luna: 'gpt-6-luna', argon: ARGON, hydrogen: HYDROGEN }), readOr(familiesPath(h)));
  ok('...each entry is id and addedAt, no pin', Object.values(famDoc(h).families).every((e) => J(Object.keys(e)) === '["id","addedAt"]' && Number.isFinite(Date.parse(e.addedAt))));
  ok('...and says what it added, by vendor', J(r.added.map((a) => `${a.vendor}:${a.family}`)) === J(['claude:lyra', 'codex:luna', 'agy:argon', 'agy:hydrogen']) && r.moved.length === 0 && r.error === null, J(r));
  ok('a dated snapshot does not beat the undated id (lyra)', ids(h).lyra === 'claude-lyra-2');
  ok('an entry needing a newer Claude Code is not added, and says so', !ids(h).mythos && why(r, 'mythos', 'claude') === 'needs Claude Code ≥ 9.0.0', J(r.skipped));
  ok('hidden, -latest and codex- slugs, Grok variants and orchestrators are never offered', !['vega', 'latest', 'nova', 'fast', 'orchestrator'].some((n) => Object.hasOwn(ids(h), n) || r.skipped.some((x) => x.family === n)), J(r.skipped));
  ok('a shipped word from the same vendor is that family: no entry, no note (opus, sol, grok, neon)', !['opus', 'sol', 'grok', 'neon'].some((n) => Object.hasOwn(ids(h), n))
    && !r.skipped.some((x) => ['opus', 'grok', 'neon'].includes(x.family) || (x.family === 'sol' && x.vendor === 'codex')), J(r.skipped));
  ok('a shipped word from another vendor is skipped, naming the family', why(r, 'sol', 'agy') === 'the shipped Codex family has that name', J(r.skipped));
  ok('a reserved word is skipped with why', why(r, 'gemini', 'codex') === '"gemini" is reserved (a CLI or account name)', J(r.skipped));
  ok('a word two vendors offer anew: the first in order has it, the other is skipped', ids(h).luna === 'gpt-6-luna' && why(r, 'luna', 'agy') === 'Codex offers luna too, and has the name', J(r.skipped));
  ok('model-id resolves what sync added', run(h, 'luna').out === 'gpt-6-luna\n' && run(h, 'argon').out === `${ARGON}\n`);
  ok('neon is never written, and resolves to the shipped id', run(h, 'neon').out === `${DEFAULTS.models.neon}\n`);
  const neon = detect({ registry: loadRegistry({ home: h }).registry, defaults: DEFAULTS, catalogs: catalogsOf(h) }).rows.find((x) => x.family === 'neon');
  ok('...a newer neon is still an update alert for Accept', neon.alerts.some((a) => a.kind === 'update' && a.candidate === 'gemini-4.1-neon'), J(neon.alerts));
  ok('nothing but families.json is written', !fs.existsSync(studio(h, 'models.json')) && !fs.existsSync(studio(h, 'roles.json')) && !fs.existsSync(studio(h, 'paused.json')));
  const before = readOr(familiesPath(h));
  const stamp = (f) => { const st = fs.statSync(f, { bigint: true }); return `${st.ino}:${st.mtimeNs}`; };
  const was = stamp(familiesPath(h));
  const again = await sync(h);
  ok('a second sync writes nothing: same bytes, same file', readOr(familiesPath(h)) === before && stamp(familiesPath(h)) === was
    && again.added.length === 0 && again.moved.length === 0 && again.error === null, J(again));
  ok('...and the other vendor\'s luna is now skipped for the families.json entry', why(again, 'luna', 'agy') === 'the Codex family luna in families.json has that name', J(again.skipped));
  const newer = await sync(h, '9.1.0 (Claude Code)');
  ok('with a new enough Claude Code, the gated word is added', newer.added.map((a) => a.family).join() === 'mythos' && ids(h).mythos === 'claude-mythos-1', J(newer));
}

{
  const h = home();
  plantAll(h, { claude: SYNC.claude.slice(0, 1), agy: SYNC.agy.slice(0, 2) });
  const r = await sync(h);
  ok('nothing new to add: no families.json is created', !fs.existsSync(familiesPath(h)) && r.error === null && r.added.length === 0, J(r));
}

console.log('\nmodels/families: sync moves only forward, and only what nothing holds');
const ARGON41 = 'gemini-4.1-argon';
const withArgon = (h, entry, list) => { families(h, { argon: entry }); plantAll(h, { agy: list }); };
{
  const h = home();
  withArgon(h, { id: ARGON }, [agyEntry(ARGON), agyEntry(ARGON41)]);
  const r = await sync(h);
  ok('an unused family moves to a strictly higher id', ids(h).argon === ARGON41 && J(r.moved) === J([{ family: 'argon', vendor: 'agy', from: ARGON, to: ARGON41 }]), J(r));
  ok('...changing only its id', J(Object.keys(famDoc(h).families.argon)) === '["id"]');
}
for (const [what, roles, paused] of [
  ['a role uses it', { version: 2, roles: { reviewer: { use: ['opus', 'argon'] } } }, null],
  ['a role uses it as a member object', { version: 2, roles: { reviewer: { use: [{ family: 'argon', effort: 'high' }] } } }, null],
  ['it is a role\'s second opinion', { version: 2, roles: { reviewer: { use: ['opus'], alt: 'argon' } } }, null],
  ['its flavor names it', { version: 2, flavor: { argon: { brief: 'x' } } }, null],
  ['an expired pause names it', null, { version: 1, paused: [{ name: 'argon', until: '2000-01-01T00:00:00Z' }] }],
  ['roles.json cannot be read', '{ nope', null],
]) {
  const h = home();
  withArgon(h, { id: ARGON }, [agyEntry(ARGON), agyEntry(ARGON41), agyEntry(HYDROGEN)]);
  if (roles) write(studio(h, 'roles.json'), roles);
  if (paused) write(studio(h, 'paused.json'), paused);
  const r = await sync(h);
  ok(`not moved while ${what}`, ids(h).argon === ARGON && r.moved.length === 0, J(r));
  ok(`...and a new word is still added (${what})`, ids(h).hydrogen === HYDROGEN);
}
{
  const h = home();
  write(studio(h, 'roles.json'), { version: 2, roles: { reviewer: { use: ['opus', 'argon'] } } });
  withArgon(h, { id: ARGON }, [agyEntry(ARGON)]);
  ok('heldBy names each place a family is held', J(heldBy(h).get('argon')) === '["the reviewer role"]' && J(heldBy(h).get('opus')).includes('the reviewer role'));
  write(studio(h, 'roles.json'), '{ nope');
  ok('...and is null when roles.json cannot be read', heldBy(h) === null);
}
{
  const h = home();
  withArgon(h, { id: ARGON, track: false }, [agyEntry(ARGON), agyEntry(ARGON41)]);
  const r = await sync(h);
  ok('a pinned family is not moved', ids(h).argon === ARGON && r.moved.length === 0 && famDoc(h).families.argon.track === false, J(r));
}
for (const [what, current, list, want] of [
  ['only a lower id is listed', ARGON41, [agyEntry(ARGON)], ARGON41],
  ['its id is gone and only a lower one is listed', 'gemini-4.2-argon', [agyEntry(ARGON41)], 'gemini-4.2-argon'],
  ['its id is gone and a higher one is listed', ARGON, [agyEntry(ARGON41)], ARGON41],
  ['its word is gone from the list', ARGON, [agyEntry(HYDROGEN)], ARGON],
  ['the list cannot be read', ARGON, null, ARGON],
]) {
  const h = home();
  families(h, { argon: { id: current } });
  if (list) plantAll(h, { agy: list }); else write(agyModelsPath(h), '{ nope');
  await sync(h);
  ok(`${what}: argon is ${want === current ? 'kept as it is' : `moved to ${want}`}`, ids(h).argon === want, readOr(familiesPath(h)));
}
{
  const h = home();
  families(h, { argon: { id: ARGON } });
  plantAll(h, { agy: [agyEntry(HYDROGEN)] });
  await sync(h);
  const row = detect({ registry: loadRegistry({ home: h }).registry, defaults: DEFAULTS, catalogs: catalogsOf(h) }).rows.find((x) => x.family === 'argon');
  ok('a family whose word is gone keeps its row, with the vanished alert', row?.id === ARGON && row.alerts.some((a) => a.kind === 'vanished'), J(row));
}
{
  const h = home();
  families(h, { lyra: { id: 'claude-lyra-2' } });
  plantAll(h, { claude: [claudeModel('claude-lyra-2', 'Lyra 2', 'Lyra'), claudeModel('claude-lyra-3', 'Lyra 3', 'Lyra', '9.0.0')] });
  await sync(h);
  ok('a move needing a newer Claude Code is not made', ids(h).lyra === 'claude-lyra-2');
  await sync(h, null);
  ok('...nor with the Claude Code version unknown', ids(h).lyra === 'claude-lyra-2');
  await sync(h, '9.0.0 (Claude Code)');
  ok('...and is made once it is new enough', ids(h).lyra === 'claude-lyra-3');
}
{
  const m = [{ id: 'x-1', family: 'x', hidden: false }, { id: 'x-3', family: 'x', hidden: true }, { id: 'x-2-20260101', family: 'x', hidden: false }, { id: 'x-next', family: 'x', hidden: false }];
  ok('newestFor: hidden and unorderable ids never win; a dated one never beats an undated current id', newestFor(m, 'x', { above: 'x-1' }) === null && newestFor(m, 'x')?.id === 'x-1');
  ok('...a dated current id may move to a newer dated one', newestFor(m, 'x', { above: 'x-1-20250101' })?.id === 'x-2-20260101');
  ok('...an unorderable current id never moves', newestFor(m, 'x', { above: 'x-next' }) === null);
}

console.log('\nmodels/families: sync leaves the rest of families.json alone');
{
  const h = home();
  const text = '{\n  "version": 1,\n  "families": {\n    "argon": { "id": "gemini-4-argon", "harness": "opencode" },\n    "zz9": {"id":"gemini-4-zz"}\n  },\n  "note": "kept"\n}\n';
  write(familiesPath(h), text);
  plantAll(h, { agy: SYNC.agy });
  const r = await sync(h);
  const after = readOr(familiesPath(h));
  ok('a hidden entry by a word\'s name is never overwritten, and the skip says why', JSON.parse(after).families.argon.harness === 'opencode'
    && why(r, 'argon', 'agy') === 'families.json has a hidden entry by that name (it has a key this ACS does not know ("harness"))', J(r.skipped));
  ok('hidden entries and an unknown key are kept byte for byte around the added one', after.startsWith(text.slice(0, text.indexOf('\n  },'))) && after.endsWith('\n  },\n  "note": "kept"\n}\n')
    && JSON.parse(after).families.hydrogen.id === HYDROGEN, after);
}
{
  const h = home();
  write(familiesPath(h), '{ broken');
  plantAll(h, { agy: SYNC.agy });
  const r = await sync(h);
  ok('a broken families.json: no write, and the summary says why', readOr(familiesPath(h)) === '{ broken' && /families\.json is invalid, so nothing was synced: .*not valid JSON/.test(r.error || ''), J(r));
}
{
  const h = home();
  write(familiesPath(h), J({ version: 1, families: { luna: { id: 'gpt-6-luna' } } }));
  plantAll(h, { agy: [agyEntry('gemini-4-luna')] });
  const r = await sync(h);
  ok('a word another vendor\'s families.json entry has is skipped, never moved across', ids(h).luna === 'gpt-6-luna' && why(r, 'luna', 'agy') === 'the Codex family luna in families.json has that name', J(r));
}

console.log('\nmodels/families: check() runs the sync, and survives it failing');
{
  const h = home();
  plantAgy(h);
  fs.chmodSync(studio(h, ''), 0o555);
  let v;
  try {
    const st = createModelsState({ detectFn: async () => [], codexHomes: () => [], home: h });
    v = await st.view();
    ok('a sync that throws: the view still answers, with the rows', v.rows.some((r) => r.family === 'neon') && !fs.existsSync(familiesPath(h)), J(v.rows.map((r) => r.family)));
    ok('...and says why in `sync`', /^The sync from the model lists failed: .*EACCES/.test(v.sync?.error || ''), J(v.sync));
    fs.chmodSync(studio(h, ''), 0o755);
    await st.check();
    const after = await st.view();
    ok('...the next check syncs', after.sync.error === null && J(after.sync.added.map((a) => a.family)) === '["argon","hydrogen"]' && ids(h).argon === ARGON, J(after.sync));
  } finally { fs.chmodSync(studio(h, ''), 0o755); }
}
{
  const h = home();
  plantAgy(h);
  write(familiesPath(h), J({ version: 2, families: {} }));
  const v = await createModelsState({ detectFn: async () => [], codexHomes: () => [], home: h }).view();
  ok('a newer families.json: nothing synced, and the view says why', /^families\.json is invalid, so nothing was synced: .*version 2 is newer/.test(v.sync?.error || '')
    && J(JSON.parse(readOr(familiesPath(h)))) === J({ version: 2, families: {} }), J(v.sync));
}
{
  const h = home();
  families(h, { argon: { id: ARGON }, flash: { id: 'gemini-3.8-flash' } });
  write(studio(h, 'roles.json'), { version: 2, roles: { reviewer: { use: ['opus', 'argon'] } } });
  plantAgy(h, [agyEntry(ARGON), agyEntry('gemini-4.1-argon')]);
  const v = await createModelsState({ detectFn: async () => [], codexHomes: () => [], home: h }).view();
  const row = (f) => v.rows.find((r) => r.family === f);
  ok('a synced row: source, vendor, whether its list still offers it, and what holds it', row('argon').source === 'synced' && row('argon').vendor === 'agy'
    && row('argon').offered === true && J(row('argon').heldBy) === '["the reviewer role"]', J(row('argon')));
  ok('...a held family keeps its id, with the update alert', row('argon').id === ARGON && row('argon').alerts.some((a) => a.kind === 'update' && a.candidate === 'gemini-4.1-argon'));
  ok('...a word gone from its list reads offered: false, held by nothing', row('flash').offered === false && J(row('flash').heldBy) === '[]', J(row('flash')));
  ok('...shipped rows carry neither', !Object.hasOwn(row('neon'), 'offered') && !Object.hasOwn(row('neon'), 'heldBy') && row('neon').source === 'default');
  write(agyModelsPath(h), '{ nope');
  const unread = await createModelsState({ detectFn: async () => [], codexHomes: () => [], home: h }).view();
  ok('...offered is unknown (null) when the list cannot be read', unread.rows.find((r) => r.family === 'flash').offered === null);
}

console.log('\nmodels/families: Pin, and Set pins');
{
  const h = home();
  families(h, { argon: { id: ARGON } });
  const cats = catalogsOf(h);
  const p = await pinFamily({ family: 'argon', pinned: true, home: h });
  ok('Pin writes track: false into the entry', p.saved === true && famDoc(h).families.argon.track === false && loadRegistry({ home: h }).registry.families.argon?.track === false, readOr(familiesPath(h)));
  ok('...pinning again changes nothing', (await pinFamily({ family: 'argon', pinned: true, home: h })).unchanged === true);
  const u = await pinFamily({ family: 'argon', pinned: false, home: h });
  ok('Unpin takes the track key out', u.saved === true && J(Object.keys(famDoc(h).families.argon)) === '["id"]', readOr(familiesPath(h)));
  for (const [what, args, re] of [
    ['a shipped family', { family: 'neon', pinned: true }, /is not a family in families\.json/],
    ['an unknown family', { family: 'xenon', pinned: true }, /is not a family in families\.json/],
    ['a pinned that is not true or false', { family: 'argon', pinned: 'yes' }, /pinned must be true or false/],
  ]) {
    const e = await refused(pinFamily({ ...args, home: h }));
    ok(`Pin refuses ${what}: 400`, e?.status === 400 && re.test(e.message), e?.message);
  }
  const set = await setModel({ family: 'argon', id: 'gemini-4.1-argon', confirm: true, pin: true, catalogs: cats, home: h });
  ok('Set with pin (a typed id) also pins', set.saved === true && set.pinned === true && famDoc(h).families.argon.id === 'gemini-4.1-argon' && famDoc(h).families.argon.track === false, readOr(familiesPath(h)));
  await pinFamily({ family: 'argon', pinned: false, home: h });
  const acc = await setModel({ family: 'argon', id: ARGON, confirm: true, catalogs: cats, home: h });
  ok('Set without pin (Accept) never pins', acc.saved === true && acc.pinned === false && !Object.hasOwn(famDoc(h).families.argon, 'track'), readOr(familiesPath(h)));
  const shipped = await setModel({ family: 'opus', id: 'claude-opus-9-9', confirm: true, pin: true, catalogs: cats, home: h });
  ok('pin on a shipped family\'s Set writes models.json as before, with no pin', shipped.saved === true && JSON.parse(readOr(studio(h, 'models.json'))).models.opus === 'claude-opus-9-9'
    && !JSON.parse(readOr(studio(h, 'models.json'))).families);
}

console.log('\nmodels/families: sync at studio start and on Check now, through the real server');
async function startStudio(h) {
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
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    if (child.exitCode !== null) break;
    try { up = (await fetch(`${base}/api/health`)).ok; } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  const post = async (route, body, headers = { origin: base, 'sec-fetch-site': 'same-origin' }) => {
    const r = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: J(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const get = async (route) => (await fetch(`${base}${route}`)).json();
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const gone = new Promise((r) => child.once('exit', r));
      child.kill('SIGINT');
      await gone;
    }
  };
  return { up, out: () => out, base, post, get, stop };
}
{
  const h = home();
  const REPLY = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'agy-models', 'models-1.5.13.json'), 'utf8'));
  const replyWith = (extra) => ({ ...REPLY, command: { ...REPLY.command, data: { ...REPLY.command.data, models: [...REPLY.command.data.models, ...extra] } } });
  plantAll(h, {
    claude: [claudeModel('claude-opus-5-5', 'Opus 5.5', 'Opus')],
    codex: [codexModel('gpt-6.2-sol', 'Sol'), codexModel('gpt-6-luna', 'Luna'), codexModel('gpt-5.6-luna', 'Luna 5.6')],
    grok: [grokModel('grok-4.7', 'Grok 4.7'), grokModel('grok-4.8-build-fast', 'Fast')],
    agy: shapeModels(REPLY).models,
  });
  const bin = path.join(h, '.local', 'bin');
  const log = path.join(h, 'agy-calls.jsonl');
  const replyFile = path.join(h, 'agy-reply.json');
  write(replyFile, replyWith([{ id: 'gemini-4.1-argon-high', label: 'Gemini 4.1 Argon (High)' }, { id: 'gemini-4.1-hydrogen-high', label: 'Gemini 4.1 Hydrogen (High)' }]));
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'agy'), `#!${process.execPath}
const fs = require('fs');
fs.appendFileSync(${J(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === '--version') { process.stdout.write('1.5.13\\n'); process.exit(0); }
if (process.argv.slice(2).join(' ') === '--output-format json models') { process.stdout.write(fs.readFileSync(${J(replyFile)}, 'utf8')); process.exit(0); }
process.exit(9);
`, { mode: 0o755 });
  const calls = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  const srv = await startStudio(h);
  try {
    ok('the server starts', srv.up, srv.out().slice(-400));
    const v = await srv.get('/api/models');
    ok('at start, families.json gains exactly what the lists offer anew: argon, flash, hydrogen and luna', J(ids(h)) === J({ luna: 'gpt-6-luna', argon: ARGON, flash: 'gemini-3.8-flash', hydrogen: HYDROGEN }), readOr(familiesPath(h)));
    ok('...without running agy', calls().length === 0, J(calls()));
    ok('...and the view says what the sync added', J(v.sync.added.map((a) => `${a.vendor}:${a.family}`)) === J(['codex:luna', 'agy:argon', 'agy:flash', 'agy:hydrogen']) && v.sync.error === null, J(v.sync));
    const histLog = () => spawnSync('git', ['-C', studio(h, 'history'), 'log', '--format=%s', '--', 'home/.agent-config-studio/families.json'], { encoding: 'utf8' }).stdout;
    ok('...recorded in ACS history', histLog().includes('families: synced — added luna (gpt-6-luna), argon (gemini-4-argon), flash (gemini-3.8-flash), hydrogen (gemini-4-hydrogen)'), histLog());
    const luna = v.rows.find((r) => r.family === 'luna');
    ok('...luna is a synced Codex row, offered, held by nothing', luna?.source === 'synced' && luna.vendor === 'codex' && luna.id === 'gpt-6-luna' && luna.offered === true && J(luna.heldBy) === '[]', J(luna));
    ok('...no file path leaves the response', !J(v).includes(h));
    ok('model-id resolves the synced families', run(h, 'luna').out === 'gpt-6-luna\n' && run(h, 'flash').out === 'gemini-3.8-flash\n');

    write(studio(h, 'roles.json'), { version: 2, roles: { reviewer: { use: ['opus', 'hydrogen'] } } });
    const c = await srv.post('/api/models/check', {});
    ok('Check now asks agy, and moves the unused argon to the newer id', c.status === 200 && calls().length === 2 && ids(h).argon === 'gemini-4.1-argon'
      && J(c.body.sync.moved) === J([{ family: 'argon', vendor: 'agy', from: ARGON, to: 'gemini-4.1-argon' }]), J(c.body.sync));
    const hyd = c.body.rows.find((r) => r.family === 'hydrogen');
    const alert = hyd.alerts.find((a) => a.kind === 'update');
    ok('...but not the hydrogen the reviewer role uses: an update alert that says what holds it', ids(h).hydrogen === HYDROGEN && alert?.candidate === 'gemini-4.1-hydrogen'
      && J(hyd.heldBy) === '["the reviewer role"]', J(hyd));
    ok('...counted for the badge', (await srv.get('/api/registry')).modelAlerts >= 1);
    const acc = await srv.post('/api/models/accept', { family: 'hydrogen', key: alert.key });
    ok('Accept moves it, without a pin', acc.status === 200 && ids(h).hydrogen === 'gemini-4.1-hydrogen' && !Object.hasOwn(famDoc(h).families.hydrogen, 'track'), J(acc));

    const xp = await srv.post('/api/models/pin', { family: 'argon', pinned: true }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
    ok('a cross-site Pin → 403, nothing written', xp.status === 403 && !Object.hasOwn(famDoc(h).families.argon, 'track'), J(xp));
    const arr = await srv.post('/api/models/pin', ['argon']);
    ok('a Pin body that is not an object → 400', arr.status === 400, J(arr));
    const pin = await srv.post('/api/models/pin', { family: 'argon', pinned: true });
    ok('Pin through the route, recorded in history', pin.status === 200 && famDoc(h).families.argon.track === false && /^[0-9a-f]{40}$/.test(pin.body.sha || '') && !pin.body.historyError
      && histLog().includes('families: pinned argon'), J(pin));
    write(replyFile, replyWith([{ id: 'gemini-4.2-argon-high', label: 'Gemini 4.2 Argon (High)' }]));
    const c2 = await srv.post('/api/models/check', {});
    const argon = c2.body.rows.find((r) => r.family === 'argon');
    ok('a pinned argon stays put at the next Check now, with no update alert', ids(h).argon === 'gemini-4.1-argon' && argon.track === false && !argon.alerts.some((a) => a.kind === 'update'), J(argon));
    await srv.post('/api/models/pin', { family: 'argon', pinned: false });
    await srv.post('/api/models/check', {});
    ok('...unpinned, it follows again', ids(h).argon === 'gemini-4.2-argon');

    const s1 = await srv.post('/api/models/set', { family: 'flash', id: 'gemini-3.9-flash' });
    const s2 = await srv.post('/api/models/set', { family: 'flash', id: 'gemini-3.9-flash', confirm: true });
    ok('Set through the route asks to confirm an id not in the list, then saves and pins', s1.body.needsConfirm === true && s2.status === 200 && s2.body.pinned === true
      && famDoc(h).families.flash.id === 'gemini-3.9-flash' && famDoc(h).families.flash.track === false, J([s1.body, s2.body]));
    const adopt = await srv.post('/api/models/adopt', { id: ARGON });
    ok('the adopt route is gone', adopt.status === 404, J(adopt));
    ok('neon is the shipped id throughout', run(h, 'neon').out === `${DEFAULTS.models.neon}\n` && !Object.hasOwn(famDoc(h).families, 'neon'));
  } finally { await srv.stop(); }
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
