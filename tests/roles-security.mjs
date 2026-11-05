/**
 * The `security` role (the review gate's security pass): shipped unset, listed in Models → Roles as not set, and
 * resolved by `model-id --role security` once chosen. Real child processes against temp HOMEs.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'model-id');
const temps = [];
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const tempHome = (roles) => {
  const home = fs.realpathSync(tempDir('acs-roles-security-'));
  temps.push(home);
  if (roles) {
    fs.mkdirSync(path.join(home, '.agent-config-studio'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agent-config-studio', 'roles.json'), JSON.stringify(roles));
  }
  return home;
};
const run = (home, ...args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

console.log('\nroles: security — the review gate security pass');
const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'roles.default.json'), 'utf8'));
ok('roles.default.json ships a security role with a note', !!shipped.roles.security?.note, JSON.stringify(shipped.roles.security));

const fresh = tempHome({ version: 2, roles: { reviewer: { use: ['sol'] } } });
const unset = run(fresh, '--role', 'security', '--json');
ok('unset: model-id --role security refuses (exit 2) with the fix naming the review-gate pack',
  unset.code === 2 && /role "security" is not set — choose its model: acs packs install review-gate --set-role security=/.test(unset.err), `${unset.code} ${unset.err}`);
const roles = run(fresh, '--roles', '--json');
const doc = JSON.parse(roles.out || '{}');
ok('unset: --roles lists security under unset', Array.isArray(doc.unset) && doc.unset.includes('security'), roles.out.slice(0, 400));

const { rolesView } = await import(path.join(ROOT, 'lib', 'roles-panel.js'));
const view = rolesView({ home: fresh });
const row = (view.roles || []).find((r) => r.name === 'security');
ok('Models → Roles shows security as an unset role', row?.unset === true, JSON.stringify(row));

const chosen = tempHome({ version: 2, roles: { security: { use: ['opus', 'sol'], effort: 'high' } } });
const set = run(chosen, '--role', 'security', '--json');
const resolved = JSON.parse(set.out || '{}');
ok('set: model-id --role security resolves its families in order', set.code === 0 && JSON.stringify(resolved.use) === '["opus","sol"]' &&
  Array.isArray(resolved.ids) && resolved.ids.length === 2 && resolved.ids.every((id) => typeof id === 'string' && id), set.out + set.err);

// A legacy (version 1) roles.json is filled from the shipped roles, but never with security: since roles are chosen at
// install, a role added later stays unset until the user chooses it, and migration never writes it out.
const legacy = tempHome({ roles: { reviewer: { use: ['sol'] } } });
const legacyRole = run(legacy, '--role', 'security', '--json');
ok('legacy roles.json: security stays unset (exit 2, the review-gate fix)', legacyRole.code === 2 && /role "security" is not set/.test(legacyRole.err), `${legacyRole.code} ${legacyRole.out} ${legacyRole.err}`);
const legacyAdvisor = run(legacy, '--role', 'advisor', '--json');
ok('legacy roles.json: the older shipped roles still fill (advisor resolves)', legacyAdvisor.code === 0, legacyAdvisor.err);
const { legacyFill } = await import(path.join(ROOT, 'lib', 'roles.js'));
const fill = legacyFill(shipped, { roles: { reviewer: { use: ['sol'] } } });
ok('legacy migration writes out the shipped roles without security', fill && !Object.hasOwn(fill, 'security') && Object.hasOwn(fill, 'advisor'), JSON.stringify(Object.keys(fill || {})));

const { ROLE_NEEDS } = await import(path.join(ROOT, 'lib', 'packs.js')).catch(() => ({}));
ok('the review-gate pack does not require the security role at install', !ROLE_NEEDS || !ROLE_NEEDS['review-gate']?.includes('security'));

for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
