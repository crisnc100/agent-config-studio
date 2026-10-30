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
import { tempDir } from './fixtures/cleanup.mjs';

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

const tmp = (tag) => { const d = fs.realpathSync(tempDir(`acs-roles-${tag}-`)); temps.push(d); return d; };
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
    for (const args of [...Object.keys(MODELS.models).map((f) => [f]), ['gpt-5.6-sol'], ['claude-opus-5-5'], ['opuss'], [], ['--json'], ['--table'], ['--sidecars'], ['a', 'b'], ['--bogus']]) {
      const a = then(home, ...args), b = now(home, ...args);
      ok(`${label}: model-id ${args.join(' ') || '(nothing)'} — same status, stdout and stderr`, same(a, b), JSON.stringify({ old: a, new: b }).slice(0, 400));
    }
    ok(`${label}: --table names no role (roles are --roles only)`, !/^role\s/m.test(now(home, '--table').out));
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
  ok('...and --table is untouched by it (exit 0, families, nothing on stderr)', t.status === 0 && /^opus\s/m.test(t.stdout) && t.stderr === '', JSON.stringify(t.stderr));
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
    ['avoid that is not a list', { flavor: { grok: { avoid: 'builder' } } }, /flavor\.grok\.avoid: must be a list of role names/],
    ['avoid naming a bad role name', { flavor: { grok: { avoid: ['Builder'] } } }, /flavor\.grok\.avoid\[0\]: role name "Builder" must match/],
    ['avoid with a non-string', { flavor: { grok: { avoid: [7] } } }, /flavor\.grok\.avoid\[0\]: role name 7 must match/],
    ['avoid naming a role twice', { flavor: { grok: { avoid: ['builder', 'builder'] } } }, /flavor\.grok\.avoid: names a role twice/],
    ['avoid with 13 roles', { flavor: { grok: { avoid: Array.from({ length: 13 }, (_, i) => `r${i}`) } } }, /flavor\.grok\.avoid: has 13 roles; the limit is 12/],
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
  ok('...or --table (exit 0, families, nothing on stderr — it never reads roles)', t.code === 0 && /^opus\s/m.test(t.out) && t.err === '');
}

console.log('\nroles: avoid — accepted, merged, and invisible to the plain flags');
{
  const home = tempHome({ roles: { version: 1, flavor: { grok: { avoid: ['builder', 'nobody'] } } } });
  const r = now(home, '--role', 'builder');
  ok('an avoid list (an unknown role name included) is valid: --role still resolves', r.code === 0 && r.err === '', r.err);
  const f = now(home, '--flavor', 'grok');
  ok('--flavor text is unchanged by avoid', f.code === 0 && f.out === `Briefing grok: ${ROLES.flavor.grok.brief}\nGood at: ${ROLES.flavor.grok.likes.join('; ')}.\nWatch for: ${ROLES.flavor.grok.quirks.join('; ')}.\n`, f.out);
  const fj = json(now(home, '--flavor', 'grok', '--json'));
  ok('--flavor --json carries it in the merged flavor, with its provenance', JSON.stringify(fj?.flavor?.avoid) === '["builder","nobody"]' && fj?.provenance?.avoid === 'user', JSON.stringify(fj));
  const cleared = tempHome({ roles: { version: 1, flavor: { grok: { avoid: null } } } });
  const cj = json(now(cleared, '--flavor', 'grok', '--json'));
  ok('null clears it, like the other flavor lists (the defaults have none)', now(cleared, '--role', 'builder').code === 0 && cj?.flavor?.avoid === undefined && cj?.provenance?.avoid === 'cleared', JSON.stringify(cj));
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'roles.default.json'), 'utf8'));
  ok('the shipped defaults set no avoid list', Object.values(shipped.flavor).every((fl) => fl.avoid === undefined));
}

console.log('\nroles: per-model effort — a use or alt entry may be {family, effort}');
{
  const cases = [
    ['a member effort that is not one', { roles: { builder: { use: [{ family: 'opus', effort: 'huge' }] } } }, /roles\.builder\.use\[0\]\.effort: "huge" is not one of low\/medium/],
    ['a member without an effort', { roles: { builder: { use: [{ family: 'opus' }] } } }, /roles\.builder\.use\[0\]\.effort: undefined is not one of/],
    ['a member with an extra key', { roles: { builder: { use: [{ family: 'opus', effort: 'high', note: 'x' }] } } }, /roles\.builder\.use\[0\]: unknown key "note" \(allowed: family, effort\)/],
    ['a member with an unknown family', { roles: { builder: { use: ['sol', { family: 'gpt', effort: 'high' }] } } }, /roles\.builder\.use\[1\]\.family: unknown family "gpt"/],
    ['a member without a family', { roles: { builder: { use: [{ effort: 'high' }] } } }, /roles\.builder\.use\[0\]: "family" is required/],
    ['a family twice, once as a name and once as an object', { roles: { builder: { use: ['opus', { family: 'opus', effort: 'high' }] } } }, /roles\.builder\.use: names a family twice/],
    ['a family twice, both as objects', { roles: { builder: { use: [{ family: 'sol', effort: 'low' }, { family: 'sol', effort: 'high' }] } } }, /roles\.builder\.use: names a family twice/],
    ['a bare object as use', { roles: { builder: { use: { family: 'opus', effort: 'high' } } } }, /roles\.builder\.use: must be a family or a non-empty list/],
    ['an alt object with a bad effort', { roles: { advisor: { alt: { family: 'astra', effort: 'turbo' } } } }, /roles\.advisor\.alt\.effort: "turbo" is not one of/],
    ['an alt object with an extra key', { roles: { advisor: { alt: { family: 'astra', effort: 'high', why: 'x' } } } }, /roles\.advisor\.alt: unknown key "why"/],
    ['an alt object with an unknown family', { roles: { advisor: { alt: { family: 'gpt', effort: 'high' } } } }, /roles\.advisor\.alt\.family: unknown family "gpt"/],
    ['an alt that is a list', { roles: { advisor: { alt: ['astra'] } } }, /roles\.advisor\.alt: must be a family name/],
  ];
  for (const [what, doc, re] of cases) {
    const r = now(tempHome({ roles: doc }), '--role', 'reviewer');
    ok(`refuses ${what}`, r.code === 2 && re.test(r.err) && /MODEL-ID-UNRESOLVED/.test(r.out), r.err.trim());
  }

  // One role per precedence step: the member's own effort, the role's, the family's flavor, none.
  const home = tempHome({ roles: {
    roles: {
      builder: { use: [{ family: 'opus', effort: 'low' }, 'sol', { family: 'grok', effort: 'max' }], effort: 'medium', alt: { family: 'astra', effort: 'xhigh' } },
      scout: { use: ['haiku', 'sol', { family: 'grok', effort: 'low' }], alt: 'fable' },
      judge: { use: [{ family: 'fable', effort: 'medium' }], effort: null, alt: 'opus' },
    },
    flavor: { sol: { effort: 'high' }, fable: { effort: null } },
  } });
  const rows = (r) => r.members.map((m) => `${m.family}:${m.effort}:${m.source}`).join(' ');
  const b = json(now(home, '--role', 'builder', '--json'));
  ok('member effort wins over the role effort; a member without one takes the role effort',
    rows(b) === 'opus:low:member sol:medium:role grok:max:member', JSON.stringify(b?.members));
  ok('…members carry each id in use order', JSON.stringify(b.members.map((m) => m.id)) === JSON.stringify([MODELS.models.opus, MODELS.models.sol, MODELS.models.grok]) && Object.keys(b.members[0]).join() === 'family,id,effort,source');
  ok('…and use, ids and effort keep their meaning: names, ids, the first member\'s effort',
    JSON.stringify(b.use) === '["opus","sol","grok"]' && JSON.stringify(b.ids) === JSON.stringify(b.members.map((m) => m.id)) && b.effort === 'low' && b.family === 'opus', JSON.stringify(b));
  ok('…the alt object resolves with its own effort, and alt stays a family name',
    JSON.stringify(b.altMember) === JSON.stringify({ family: 'astra', id: MODELS.models.astra, effort: 'xhigh', source: 'member' }) && b.alt === 'astra' && b.altEffort === 'xhigh', JSON.stringify(b.altMember));
  ok('the plain line prints the first member\'s effort, in the same format', now(home, '--role', 'builder').out === `family=opus id=${MODELS.models.opus} effort=low alt=astra\n`);
  const s = json(now(home, '--role', 'scout', '--json'));
  ok('no member or role effort: the family\'s flavor effort, else empty', rows(s) === 'haiku:: sol:high:flavor grok:low:member', rows(s));
  ok('…and the alt the same way', JSON.stringify(s.altMember) === JSON.stringify({ family: 'fable', id: MODELS.models.fable, effort: ROLES.flavor.fable.effort ?? '', source: ROLES.flavor.fable.effort ? 'flavor' : '' }), JSON.stringify(s.altMember));
  const j = json(now(home, '--role', 'judge', '--json'));
  ok('a member effort applies to that member only: the alt runs at its family\'s effort', rows(j) === 'fable:medium:member' && j.altMember.family === 'opus' && j.altMember.source !== 'member', JSON.stringify(j.altMember));
  const plain = json(now(home, '--role', 'reviewer', '--json'));
  ok('a role without member effort has no members or altMember: its output is what it always was',
    plain && !Object.hasOwn(plain, 'members') && !Object.hasOwn(plain, 'altMember') && Object.keys(plain).at(-1) === 'source', JSON.stringify(plain));
  const alone = json(now(tempHome({ roles: { roles: { advisor: { alt: { family: 'astra', effort: 'max' } } } } }), '--role', 'advisor', '--json'));
  ok('an alt with its own effort alone brings both keys', alone.members?.[0]?.source === 'role' && alone.altMember?.source === 'member', JSON.stringify(alone));
  const nomem = json(now(tempHome({ roles: { roles: { builder: { use: [{ family: 'opus', effort: 'low' }] } } } }), '--role', 'builder', '--json'));
  ok('…and members without an alt give altMember null', nomem.members.length === 1 && nomem.altMember === null, JSON.stringify(nomem));
  const rj = json(now(home, '--roles', '--json'));
  ok('--roles --json adds them only to the roles that have a member effort',
    Object.entries(rj.roles).every(([n, r]) => Object.hasOwn(r, 'members') === ['builder', 'scout', 'judge'].includes(n)), JSON.stringify(Object.keys(rj.roles)));
  const all = now(home, '--roles');
  ok('--roles prints the first member\'s effort', all.code === 0 && /^builder\s+opus\s+\S+\s+low\s+astra$/m.test(all.out), all.out);
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
