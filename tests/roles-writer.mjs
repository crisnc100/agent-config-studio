/**
 * The `writer` role (the context pass's comment and doc editor): shipped as Opus then Sonnet, unset on every
 * existing install until chosen, and resolved by `model-id --role writer` once it is. Real child processes against temp HOMEs.
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
  const home = fs.realpathSync(tempDir('acs-roles-writer-'));
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

console.log('\nroles: writer — the context pass that edits comments and technical docs');
const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'roles.default.json'), 'utf8'));
ok('roles.default.json ships a writer role: Opus first, Sonnet as the fallback, with a note', JSON.stringify(shipped.roles.writer?.use) === '["opus","sonnet"]' && !!shipped.roles.writer?.note,
  JSON.stringify(shipped.roles.writer));

const fresh = tempHome({ version: 2, roles: { reviewer: { use: ['sol'] } } });
const unset = run(fresh, '--role', 'writer', '--json');
ok('unset on an existing install: model-id --role writer refuses (exit 2) with the fix naming the review-gate pack',
  unset.code === 2 && /role "writer" is not set — choose its model: acs packs install review-gate --set-role writer=/.test(unset.err), `${unset.code} ${unset.err}`);
const roles = run(fresh, '--roles', '--json');
const doc = JSON.parse(roles.out || '{}');
ok('--roles lists writer under unset', Array.isArray(doc.unset) && doc.unset.includes('writer'), roles.out.slice(0, 400));
const { rolesView } = await import(path.join(ROOT, 'lib', 'roles-panel.js'));
const row = (rolesView({ home: fresh }).roles || []).find((r) => r.name === 'writer');
ok('Models → Roles shows writer as an unset role', row?.unset === true, JSON.stringify(row));

const chosen = tempHome({ version: 2, roles: { writer: { use: ['opus', 'sonnet'], effort: 'medium' } } });
const set = run(chosen, '--role', 'writer', '--json');
const resolved = JSON.parse(set.out || '{}');
ok('set: model-id --role writer resolves Opus then Sonnet', set.code === 0 && JSON.stringify(resolved.use) === '["opus","sonnet"]' && resolved.ids?.length === 2, set.out + set.err);

const legacy = tempHome({ roles: { reviewer: { use: ['sol'] } } });
const legacyRole = run(legacy, '--role', 'writer', '--json');
ok('legacy roles.json: writer stays unset (no model is set for you)', legacyRole.code === 2 && /role "writer" is not set/.test(legacyRole.err), `${legacyRole.code} ${legacyRole.err}`);
const { legacyFill, INSTALL_ONLY_ROLES } = await import(path.join(ROOT, 'lib', 'roles.js'));
const fill = legacyFill(shipped, { roles: { reviewer: { use: ['sol'] } } });
ok('legacy migration never writes writer out', fill && !Object.hasOwn(fill, 'writer') && !Object.hasOwn(fill, 'security'), JSON.stringify(Object.keys(fill || {})));
ok('writer is an install-only role, beside security', INSTALL_ONLY_ROLES.includes('writer') && INSTALL_ONLY_ROLES.includes('security'));
const needs = fs.readFileSync(path.join(ROOT, 'lib', 'packs.js'), 'utf8').match(/const ROLE_NEEDS = (\{[^\n]*\});/)?.[1];
ok('the review-gate pack does not require the writer role at install (it is optional, like security)', !!needs && /'review-gate': \[[^\]]*\]/.test(needs) && !/writer/.test(needs), needs);

for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
