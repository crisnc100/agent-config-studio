/**
 * Roles and flavor in the resolver (builds/model-roles A1–A3, R1, R6, R7, R12),
 * run as real child processes against temp HOMEs. The resolver as it was
 * before roles is kept as a fixture (CI's checkout has no history), so
 * "byte-identical" is compared against the real old output, not a
 * description of it.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'model-id');
const MODELS = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.default.json'), 'utf8'));
const ROLES = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'roles.default.json'), 'utf8'));
/** The resolver every existing install has: bin/model-id.mjs and lib/models.js as of afa33a1. */
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'pre-roles-resolver');
const temps = [];

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tmp = (tag) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `acs-roles-${tag}-`))); temps.push(d); return d; };
const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
const studio = (home, name) => path.join(home, '.agent-config-studio', name);

function tempHome({ models, roles } = {}) {
  const home = tmp('home');
  if (models !== undefined) write(studio(home, 'models.json'), typeof models === 'string' ? models : JSON.stringify(models));
  if (roles !== undefined) write(studio(home, 'roles.json'), typeof roles === 'string' ? roles : JSON.stringify(roles));
  return home;
}

function run(bin, home, ...args) {
  const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const now = (home, ...a) => run(BIN, home, ...a);
const json = (r) => { try { return JSON.parse(r.out); } catch { return null; } };

/** The pre-roles resolver as a checkout of its own, with today's shipped defaults. */
const old = tmp('old');
for (const rel of ['bin/model-id.mjs', 'lib/models.js']) write(path.join(old, rel), fs.readFileSync(path.join(FIXTURE, rel)));
for (const rel of ['models.default.json', 'package.json']) write(path.join(old, rel), fs.readFileSync(path.join(ROOT, rel)));
const haveOld = !fs.existsSync(path.join(old, 'lib', 'roles.js'));
const OLD = path.join(old, 'bin', 'model-id.mjs');
const then = (home, ...a) => run(OLD, home, ...a);

console.log('\nroles: A1 — existing invocations, byte for byte against the pre-roles resolver');
ok('the pre-roles resolver fixture knows nothing of roles', haveOld && !fs.readFileSync(path.join(FIXTURE, 'bin', 'model-id.mjs'), 'utf8').includes('--role'));
if (haveOld) {
  // The new resolver's paths differ from the old copy's only in where it lives.
  const same = (a, b) => a.code === b.code && a.out.split(old).join(ROOT) === b.out && a.err.split(old).join(ROOT) === b.err;
  for (const [label, opts] of [
    ['no user files', {}],
    ['an old models.json (models only)', { models: { models: { opus: 'claude-opus-6' } } }],
    ['models.json plus a roles.json the old resolver never reads', { models: { models: { opus: 'claude-opus-6' } }, roles: { roles: { reviewer: { effort: 'max' } } } }],
  ]) {
    const home = tempHome(opts);
    for (const args of [...Object.keys(MODELS.models).map((f) => [f]), ['gpt-5.6-sol'], ['claude-opus-5-5'], ['opuss'], [], ['--json'], ['--sidecars'], ['a', 'b'], ['--bogus']]) {
      const a = then(home, ...args), b = now(home, ...args);
      ok(`${label}: model-id ${args.join(' ') || '(nothing)'} — same status, stdout and stderr`, same(a, b), JSON.stringify({ old: a, new: b }).slice(0, 400));
    }
    const a = then(home, '--table'), b = now(home, '--table');
    const prefix = a.out.split(old).join(ROOT);
    ok(`${label}: --table keeps the existing section byte for byte, then appends roles`,
       a.code === b.code && b.out.startsWith(prefix) && /^\nrole\s+family\s+id\s+effort\s+alt\n/.test(b.out.slice(prefix.length)), JSON.stringify(b.out.slice(prefix.length, prefix.length + 120)));
  }
  const unk = now(tempHome(), 'opuss');
  ok('unknown family: still exit 1 with the sentinel', unk.code === 1 && unk.out === 'MODEL-ID-UNRESOLVED-opuss\n');
}

console.log('\nroles: R1 — both upgrade orders, and an installed copy');
if (haveOld) {
  const home = tempHome({ roles: { roles: { reviewer: { use: 'sol' } }, flavor: { sol: { brief: 'Mine.' } } } });
  ok('new data, old resolver: families still resolve', then(home, 'opus').out === `${MODELS.models.opus}\n`);
  const r = then(home, '--role', 'reviewer');
  ok('new data, old resolver: --role fails loudly (exit 1, sentinel), never a guessed id',
     r.code === 1 && /^MODEL-ID-UNRESOLVED-\S+\n$/.test(r.out) && !/gpt|claude/.test(r.out), JSON.stringify(r));
}
{
  // Install from a checkout copy, then delete the copy: the installed resolver has to carry roles itself.
  const src = tmp('src');
  for (const rel of ['bin/model-id', 'bin/model-id.mjs', 'lib/models.js', 'lib/roles.js', 'lib/roles.default.json', 'models.default.json', 'package.json']) {
    if (rel === 'bin/model-id') fs.mkdirSync(path.join(src, 'bin'), { recursive: true }), fs.symlinkSync('model-id.mjs', path.join(src, rel));
    else write(path.join(src, rel), fs.readFileSync(path.join(ROOT, rel)));
  }
  const home = tempHome({ roles: { roles: { reviewer: { effort: 'max' } } } });
  const inst = spawnSync(process.execPath, [path.join(src, 'bin', 'model-id.mjs'), '--install'], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } });
  ok('--install succeeds', inst.status === 0, inst.stderr);
  const resolver = studio(home, 'resolver');
  ok('--install copies lib/roles.js and lib/roles.default.json byte for byte',
     ['lib/roles.js', 'lib/roles.default.json'].every((rel) => fs.readFileSync(path.join(resolver, rel)).equals(fs.readFileSync(path.join(ROOT, rel)))));
  fs.rmSync(src, { recursive: true, force: true });
  const sh = (cmd) => spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', env: { HOME: home, PATH: `/usr/bin:/bin:${path.join(home, '.local', 'bin')}` } });
  const role = sh('model-id --role reviewer');
  ok('after the checkout is gone, the installed copy resolves a role with the user override',
     role.status === 0 && role.stdout === `family=astra id=${MODELS.models.astra} effort=max alt=\n`, JSON.stringify(role));
  ok('...and a flavor', sh('model-id --flavor sol').stdout.startsWith('Briefing sol: '));
  ok('...and a family, as before', sh('model-id opus').stdout === `${MODELS.models.opus}\n`);

  // A stale copy: one installed without the roles pair.
  fs.rmSync(path.join(resolver, 'lib', 'roles.js'));
  const stale = sh('model-id --role reviewer');
  ok('a copy without lib/roles.js: --role exits 2 and says run: acs install-model-id',
     stale.status === 2 && /run: acs install-model-id/.test(stale.stderr) && /^family=MODEL-ID-UNRESOLVED-reviewer id=MODEL-ID-UNRESOLVED-reviewer /.test(stale.stdout), JSON.stringify(stale));
  ok('...while families still resolve', sh('model-id opus').stdout === `${MODELS.models.opus}\n`);
  const t = sh('model-id --table');
  ok('...and --table prints the existing section, with the reason on stderr', t.status === 0 && /^opus\s/m.test(t.stdout) && /run: acs install-model-id/.test(t.stderr));
  write(path.join(resolver, 'lib', 'roles.js'), fs.readFileSync(path.join(ROOT, 'lib', 'roles.js')));
  fs.rmSync(path.join(resolver, 'lib', 'roles.default.json'));
  const noDefaults = sh('model-id --role reviewer');
  ok('a copy without lib/roles.default.json: exit 2, run: acs install-model-id', noDefaults.status === 2 && /missing beside this resolver — run: acs install-model-id/.test(noDefaults.stderr), noDefaults.stderr);
  // Data from a newer studio than this resolver.
  const future = tempHome({ roles: { version: 2, roles: {} } });
  const fr = now(future, '--role', 'reviewer');
  ok('a roles.json newer than the resolver: exit 2, run: acs install-model-id', fr.code === 2 && /version 2 is newer than this resolver understands — run: acs install-model-id/.test(fr.err), fr.err);
}

console.log('\nroles: A2 — seeded values, overrides, merge and resolution (R6, R7)');
{
  const home = tempHome();
  for (const [name, r] of Object.entries(ROLES.roles)) {
    const use = [].concat(r.use);
    const want = `family=${use[0]} id=${MODELS.models[use[0]]} effort=${r.effort || ''} alt=${r.alt || ''}\n`;
    ok(`--role ${name} → ${want.trim()}`, now(home, '--role', name).out === want, now(home, '--role', name).out);
  }
  const j = json(now(home, '--role', 'builder', '--json'));
  ok('--role builder --json gives the whole ordered use list with ids', j && JSON.stringify(j.use) === '["opus","sol"]' && JSON.stringify(j.ids) === JSON.stringify([MODELS.models.opus, MODELS.models.sol]), JSON.stringify(j));
  const j2 = json(now(home, '--json', '--role', 'builder'));
  ok('--json --role builder (flag order) gives the same', j2 && JSON.stringify(j2) === JSON.stringify(j));
  const adv = json(now(home, '--role', 'advisor', '--json'));
  ok('alt is resolved the same way (id, effort), never used as the answer', adv.family === 'fable' && adv.alt === 'astra' && adv.altId === MODELS.models.astra && adv.altEffort === 'high');
  ok('provenance is per field: every seeded field says default', Object.values(adv.provenance).every((p) => p === 'default') && adv.provenance.use === 'default');
  const fl = now(home, '--flavor', 'sol');
  ok('--flavor sol is plain text built from the seed', fl.code === 0 && fl.out === `Briefing sol: ${ROLES.flavor.sol.brief}\nGood at: ${ROLES.flavor.sol.likes.join('; ')}.\nWatch for: ${ROLES.flavor.sol.quirks.join('; ')}.\n`, fl.out);
  const nofl = now(home, '--flavor', 'grok-prev');
  ok('--flavor for a known family with none: empty, exit 0', nofl.code === 0 && nofl.out === '');
  const all = now(home, '--roles');
  ok('--roles lists every role', all.code === 0 && Object.keys(ROLES.roles).every((n) => new RegExp(`^${n}\\s`, 'm').test(all.out)), all.out);
}
{
  const home = tempHome({ roles: { roles: { reviewer: { effort: 'max' } } } });
  const r = json(now(home, '--role', 'reviewer', '--json'));
  ok('one overridden field merges over the default; the rest are kept', r.effort === 'max' && r.family === 'astra' && r.note === ROLES.roles.reviewer.note, JSON.stringify(r));
  ok('...and provenance says which is which', r.provenance.effort === 'user' && r.provenance.use === 'default' && r.provenance.note === 'default');
}
{
  const home = tempHome({ roles: { roles: { builder: { use: ['sol'] }, advisor: { alt: null, effort: null } }, flavor: { fable: { effort: 'xhigh' }, sol: { likes: ['only this'] } } } });
  const b = json(now(home, '--role', 'builder', '--json'));
  ok('use replaces the list, never concatenates', JSON.stringify(b.use) === '["sol"]' && b.family === 'sol');
  const a = json(now(home, '--role', 'advisor', '--json'));
  ok('null clears alt', a.alt === '' && a.altId === '' && a.provenance.alt === 'cleared');
  ok('a cleared role effort falls back to the family flavor effort', a.effort === 'xhigh', a.effort);
  const s = json(now(home, '--flavor', 'sol', '--json'));
  ok('flavor merges per field: likes replaced, brief and quirks kept', JSON.stringify(s.flavor.likes) === '["only this"]' && s.flavor.brief === ROLES.flavor.sol.brief && s.provenance.likes === 'user' && s.provenance.brief === 'default');
  const none = tempHome({ roles: { roles: { judge: { effort: null } } } });
  ok('no role effort and no flavor effort → empty, never guessed', now(none, '--role', 'judge').out === `family=fable id=${MODELS.models.fable} effort= alt=\n`);
}
{
  const home = tempHome({ models: { models: { astra: 'gpt-7-astra' } }, roles: { roles: { scout: { use: ['haiku', 'sonnet'], note: 'quick looks' } } } });
  ok('each id resolves through the models registry (a models.json bump moves the role)', now(home, '--role', 'reviewer').out.startsWith('family=astra id=gpt-7-astra '));
  const c = json(now(home, '--role', 'scout', '--json'));
  ok('a custom role with use resolves and is marked custom', c.custom === true && c.family === 'haiku' && c.effort === '');
  const bad = tempHome({ models: { models: { sol: 'Not An Id' } } });
  const r = now(bad, '--role', 'builder');
  ok('a role whose id is malformed refuses (exit 2), never substitutes another family', r.code === 2 && /not a valid model id/.test(r.err) && !r.out.includes(MODELS.models.opus), JSON.stringify(r));
  const bb = now(bad, '--role', 'builder', '--json');
  ok('...even when the malformed one is a later preference, and nothing is printed as JSON', bb.code === 2 && bb.out === '');
}

console.log('\nroles: R12 — new flags exit 2 on unknown names');
{
  const home = tempHome();
  const unk = now(home, '--role', 'nope');
  ok('--role nope → exit 2, sentinel ids, reason on stderr', unk.code === 2 && unk.out === 'family=MODEL-ID-UNRESOLVED-nope id=MODEL-ID-UNRESOLVED-nope effort= alt=\n' && /unknown role "nope"/.test(unk.err), JSON.stringify(unk));
  const unkj = now(home, '--role', 'nope', '--json');
  ok('--role nope --json → exit 2, nothing on stdout', unkj.code === 2 && unkj.out === '');
  const fl = now(home, '--flavor', 'gpt');
  ok('--flavor gpt → exit 2, nothing on stdout', fl.code === 2 && fl.out === '' && /unknown model family "gpt"/.test(fl.err));
  ok('--role with no name → exit 2', now(home, '--role').code === 2);
  ok('--role a --flavor b → exit 2 (one question at a time)', now(home, '--role', 'reviewer', '--flavor', 'sol').code === 2);
  ok('--role reviewer extra → exit 2', now(home, '--role', 'reviewer', 'extra').code === 2);
}

console.log('\nroles: A3 — every malformed case refused, with a precise message');
{
  const long = (n) => 'x'.repeat(n);
  const cases = [
    ['an unknown top-level key', { rolez: {} }, /unknown key "rolez"/],
    ['an unknown role key', { roles: { reviewer: { model: 'sol' } } }, /roles\.reviewer: unknown key "model"/],
    ['a bad role name', { roles: { Reviewer: { use: 'sol' } } }, /role name "Reviewer" must match/],
    ['a role name too long', { roles: { [`a${long(32)}`]: { use: 'sol' } } }, /must match \[a-z\]/],
    ['use naming an unknown family', { roles: { reviewer: { use: 'gpt' } } }, /roles\.reviewer\.use: unknown family "gpt"/],
    ['use list with an unknown family', { roles: { builder: { use: ['opus', 'gpt'] } } }, /roles\.builder\.use\[1\]: unknown family "gpt"/],
    ['an empty use list', { roles: { builder: { use: [] } } }, /roles\.builder\.use: must be a family or a non-empty list/],
    ['a family twice in use', { roles: { builder: { use: ['sol', 'sol'] } } }, /roles\.builder\.use: names a family twice/],
    ['use cleared with null', { roles: { builder: { use: null } } }, /roles\.builder\.use: cannot be cleared/],
    ['a bad effort', { roles: { reviewer: { effort: 'huge' } } }, /roles\.reviewer\.effort: "huge" is not one of low\/medium\/high\/xhigh\/max/],
    ['alt naming an unknown family', { roles: { advisor: { alt: 'gpt' } } }, /roles\.advisor\.alt: unknown family "gpt"/],
    ['a note over 160 characters', { roles: { reviewer: { note: long(161) } } }, /roles\.reviewer\.note: is 161 characters; the limit is 160/],
    ['a note with a newline', { roles: { reviewer: { note: 'a\nb' } } }, /roles\.reviewer\.note: contains a control character/],
    ['a custom role without use', { roles: { scout: { effort: 'low' } } }, /roles\.scout: "use" is required/],
    ['flavor for an unknown family', { flavor: { gpt: { brief: 'x' } } }, /flavor: unknown family "gpt"/],
    ['an unknown flavor key', { flavor: { sol: { style: 'x' } } }, /flavor\.sol: unknown key "style"/],
    ['likes that is not a list', { flavor: { sol: { likes: 'everything' } } }, /flavor\.sol\.likes: must be a list of strings/],
    ['a like over 160 characters', { flavor: { sol: { likes: [long(161)] } } }, /flavor\.sol\.likes\[0\]: is 161 characters/],
    ['13 quirks', { flavor: { sol: { quirks: Array.from({ length: 13 }, (_, i) => `q${i}`) } } }, /flavor\.sol\.quirks: has 13 items; the limit is 12/],
    ['a list item with a newline', { flavor: { sol: { quirks: ['one\ntwo'] } } }, /flavor\.sol\.quirks\[0\]: contains a control character/],
    ['an empty list item', { flavor: { sol: { likes: ['  '] } } }, /flavor\.sol\.likes\[0\]: must not be empty/],
    ['a brief over 600 characters', { flavor: { sol: { brief: long(601) } } }, /flavor\.sol\.brief: is 601 characters; the limit is 600/],
    ['a brief hiding a bidi override', { flavor: { sol: { brief: 'safe ‮ text' } } }, /flavor\.sol\.brief: contains a control character/],
    ['a flavor effort that is not one', { flavor: { sol: { effort: 'turbo' } } }, /flavor\.sol\.effort: "turbo" is not one of/],
    ['version 0', { version: 0 }, /version must be 1, got 0/],
    ['roles not an object', { roles: [] }, /"roles" must be an object/],
  ];
  for (const [what, doc, re] of cases) {
    const home = tempHome({ roles: doc });
    const r = now(home, '--role', 'reviewer');
    ok(`refuses ${what}`, r.code === 2 && re.test(r.err) && /roles\.json/.test(r.err) && /MODEL-ID-UNRESOLVED/.test(r.out), r.err.trim());
  }
  const broken = tempHome({ roles: '{ "roles": ' });
  const b = now(broken, '--role', 'reviewer');
  ok('refuses roles.json that is not JSON', b.code === 2 && /not valid JSON/.test(b.err), b.err);
  ok('a broken roles.json never breaks a family lookup', now(broken, 'opus').out === `${MODELS.models.opus}\n`);
  const t = now(broken, '--table');
  ok('...or --table (existing section printed, exit 0, reason on stderr)', t.code === 0 && /^opus\s/m.test(t.out) && /roles are invalid/.test(t.err));
}

console.log('\nroles: the shipped seed');
{
  ok('every seeded role uses a shipped family', Object.values(ROLES.roles).every((r) => [].concat(r.use).every((f) => Object.hasOwn(MODELS.models, f))));
  const seed = fs.readFileSync(path.join(ROOT, 'lib', 'roles.default.json'), 'utf8');
  ok('the seed names families, never a versioned id', !/claude-[a-z]+-\d|gpt-\d|grok-\d/.test(seed));
}

for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
