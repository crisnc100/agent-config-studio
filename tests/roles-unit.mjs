/**
 * Roles and flavor in-process (builds/model-roles R3, R8, R9, R10, R12): the
 * write boundary's history and folder cases, availability warnings,
 * where-used through roles, proposal parsing, and the Describe timeout —
 * each needs a seam the server does not expose. HOME is a temp dir, set
 * before any studio module loads; the fake `claude` never calls a model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { describeCli } from './fixtures/describe-cli.mjs';

const realBefore = snapshotRealHomes();
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-roles-unit-')));
process.env.HOME = home;

const { writeRoles, rolesView, hashOf, setRole } = await import('../lib/roles-panel.js');
const { parseProposal, normalizeProposal, lineDiff, createDescribe, DESCRIBE_LIMITS } = await import('../lib/describe.js');
const { loadRoles, rolesUserPath } = await import('../lib/roles.js');
const { whereUsed } = await import('../lib/models-panel.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

console.log('\nroles unit: R3 — history failures are shown, a symlinked folder is refused');
{
  const failing = {
    recordBaseline: async () => { throw new Error('baseline exploded'); },
    record: async () => { throw new Error('history repo is read-only'); },
  };
  const file = rolesUserPath(home);
  const first = await writeRoles({ text: '{"version":1}\n', base: 'absent', message: 'test', home, hist: failing });
  ok('the write lands', first.saved === true && fs.readFileSync(file, 'utf8') === '{"version":1}\n');
  ok('…and the history failure is a warning in the response, not swallowed', first.warnings.some((w) => /not versioned in history: history repo is read-only/.test(w)) && /read-only/.test(first.historyError));
  const second = await writeRoles({ text: '{"version":1,"roles":{}}\n', base: first.base, message: 'test', home, hist: failing });
  ok('a failed baseline is a warning too', second.warnings.some((w) => /not versioned first: baseline exploded/.test(w)), JSON.stringify(second.warnings));
  const bad = await rejects(writeRoles({ text: '{"roles":{"x":{}}}', base: second.base, message: 't', home, hist: failing }));
  ok('A3 an invalid document is refused before anything is touched', bad?.status === 400 && /"use" is required/.test(bad.message) && fs.readFileSync(file, 'utf8') === '{"version":1,"roles":{}}\n');
  ok('no temp file is left behind', fs.readdirSync(path.dirname(file)).every((f) => !f.includes('.tmp-')));

  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-roles-other-')));
  const linkedHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-roles-linked-')));
  fs.symlinkSync(other, path.join(linkedHome, '.agent-config-studio'));
  const e = await rejects(writeRoles({ text: '{"version":1}\n', base: 'absent', message: 't', home: linkedHome, hist: failing }));
  ok('a symlinked studio folder is refused', e?.status === 409 && /symlink/.test(e.message), e?.message);
  ok('…and nothing lands at its target', fs.readdirSync(other).length === 0);
  fs.rmSync(other, { recursive: true, force: true });
  fs.rmSync(linkedHome, { recursive: true, force: true });
  fs.rmSync(file);
}

console.log('\nroles unit: R8 — warnings, never substitution');
{
  fs.mkdirSync(path.join(home, '.agent-config-studio'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agent-config-studio', 'models.json'), JSON.stringify({ models: { sol: 'Not An Id' } }));
  const v = rolesView({ home, modelRows: [
    { family: 'astra', alerts: [{ kind: 'retiring', date: '2026-12-01T00:00:00Z' }] },
    { family: 'fable', alerts: [{ kind: 'vanished' }] },
    { family: 'opus', alerts: [{ kind: 'update', candidate: 'claude-opus-6' }] },
  ] });
  const role = (n) => v.roles.find((r) => r.name === n);
  ok('a role on a retiring family is warned', role('reviewer').warnings.some((w) => /astra .* is retiring on 2026-12-01/.test(w)), JSON.stringify(role('reviewer').warnings));
  ok('a role whose alt has vanished is warned', role('advisor').warnings.some((w) => /fable .* no longer in its CLI's catalog/.test(w)));
  ok('a malformed id in the use list is warned', role('builder').warnings.some((w) => /sol resolves to "Not An Id"/.test(w)));
  ok('an update alert is not a warning (newer is not unavailable)', !role('builder').warnings.some((w) => /opus/.test(w)));
  ok('…and the role still names its own family, nothing substituted', role('reviewer').use[0] === 'astra' && role('builder').use.join() === 'opus,sol');
  fs.rmSync(path.join(home, '.agent-config-studio', 'models.json'));
}

console.log('\nroles unit: R12 — where-used maps `model-id --role` to the role\'s current family');
{
  const skill = path.join(home, '.claude', 'skills', 'demo', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, 'eval "$(model-id --role reviewer || true)"\nmodel-id --json --role builder\nmodel-id astra\nmodel-id --role reviewers\n');
  const astra = whereUsed('astra', { home });
  ok('astra: the direct call and the reviewer role call', astra.hits.length === 2 && astra.hits.some((h) => h.role === 'reviewer' && h.line === 1) && astra.hits.some((h) => !h.role && h.line === 3), JSON.stringify(astra.hits));
  ok('…not a longer role name that merely starts the same', !astra.hits.some((h) => h.line === 4));
  ok('opus: the builder role (its first use family)', whereUsed('opus', { home }).hits.map((h) => h.role).join() === 'builder');
  ok('sol: nothing (a later preference is not what --role prints)', whereUsed('sol', { home }).hits.length === 0);
  const r = await setRole({ name: 'reviewer', fields: { use: ['sol'] }, base: 'absent', home });
  ok('after the reviewer role moves to sol, its call moves with it', r.saved && whereUsed('sol', { home }).hits.some((h) => h.role === 'reviewer') && !whereUsed('astra', { home }).hits.some((h) => h.role));
  fs.rmSync(rolesUserPath(home));
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
}

console.log('\nroles unit: R9 — parsing and normalizing a proposal');
{
  const loaded = loadRoles({ home });
  const p = (raw) => { try { return { text: parseProposal(raw, loaded) }; } catch (e) { return { error: e }; } };
  const norm = normalizeProposal({ roles: { reviewer: { use: ['astra'], effort: 'high', alt: null } }, flavor: { sol: { brief: loaded.defaults.flavor.sol.brief } } }, loaded.defaults);
  ok('fields equal to the default, and nulls that clear nothing, are dropped', JSON.stringify(norm) === '{"version":1}', JSON.stringify(norm));
  ok('`use` compares as a list (["opus"] vs ["opus","sol"] differs)', JSON.stringify(normalizeProposal({ roles: { builder: { use: ['opus'] } } }, loaded.defaults)) === '{"version":1,"roles":{"builder":{"use":["opus"]}}}');
  ok('a null that clears a default is kept', normalizeProposal({ roles: { advisor: { alt: null } } }, loaded.defaults).roles.advisor.alt === null);
  ok('the bytes are pretty JSON with a final newline', p('{"roles":{"judge":{"use":"sol"}}}').text === '{\n  "version": 1,\n  "roles": {\n    "judge": {\n      "use": "sol"\n    }\n  }\n}\n');
  ok('whitespace around the object is fine', !p('\n  {"roles":{}}  \n').error);
  ok('a fence with no language is fine', !p('```\n{}\n```').error);
  ok('a fence with prose after it is refused', /single ```json fence/.test(p('```json\n{}\n```\nDone.').error?.message));
  ok('a string holding a brace does not end the object early', !p('{"flavor":{"sol":{"brief":"use } and { freely"}}}').error);
  ok('every refusal is a 422 that says nothing was written', p('nope').error?.status === 422 && /Nothing was written/.test(p('nope').error.message));
  const d = lineDiff('a\nb\nc\n', 'a\nc\nd\n');
  ok('the diff shows every line of both sides', d.map((l) => l.op + l.line).join('|') === ' a|-b| c|+d');
  ok('a diff from nothing is all additions', lineDiff('', 'x\ny\n').every((l) => l.op === '+'));
}

console.log('\nroles unit: R10 — the 120 s timeout, at a test scale');
{
  const bin = describeCli(path.join(home, '.local', 'bin', 'claude'));
  fs.writeFileSync(path.join(path.dirname(bin), 'mode.json'), JSON.stringify({ kind: 'hang' }));
  ok('the shipped limits are the plan\'s', DESCRIBE_LIMITS.description === 4000 && DESCRIBE_LIMITS.outputBytes === 65536 && DESCRIBE_LIMITS.timeoutMs === 120_000);
  const d = createDescribe({ home, limits: { ...DESCRIBE_LIMITS, timeoutMs: 1500 } });
  const t0 = Date.now();
  const e = await rejects(d.describe({ description: 'x' }));
  const pid = Number(fs.readFileSync(path.join(path.dirname(bin), 'pid'), 'utf8'));
  ok('a run past the timeout is killed and refused (504)', e?.status === 504 && /timed out/.test(e.message) && Date.now() - t0 < 10_000, e?.message);
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  ok('…its process is gone', !alive);
  ok('…and the slot is free again', d.running === false);
  ok('…and nothing was written', !fs.existsSync(rolesUserPath(home)));
  const ttl = createDescribe({ home, now: (() => { let t = 0; return () => (t += 11 * 60_000); })() });
  fs.writeFileSync(path.join(path.dirname(bin), 'mode.json'), JSON.stringify({ kind: 'ok', reply: '{"roles":{"judge":{"use":"sol"}}}' }));
  const prop = await ttl.describe({ description: 'x' });
  const late = await rejects(ttl.accept({ id: prop.id }));
  ok('R2 a proposal past its TTL cannot be accepted (410)', late?.status === 410, late?.message);
  ok('…and wrote nothing', !fs.existsSync(rolesUserPath(home)));
}

assertRealHomesUnchanged(realBefore, ok);
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
