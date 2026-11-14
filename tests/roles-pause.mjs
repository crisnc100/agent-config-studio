/**
 * Paused accounts in the resolver (builds/pause-account R1–R5): resolveRole
 * in process, then model-id, ask-model and the review gate's reviewer pool
 * as real child processes against temp HOMEs. No model is called: the CLIs
 * on PATH are stubs.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';
import { guideText, loadRoles, pauseLine, readPaused, resolveRole } from '../lib/roles.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_ID = path.join(ROOT, 'bin', 'model-id.mjs');
const ASK = path.join(ROOT, 'tools', 'ask-model.mjs');
const REVIEW = path.join(ROOT, 'packs', 'review-gate', 'runtime', 'review.mjs');
const IDS = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.default.json'), 'utf8')).models;
const J = JSON.stringify;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tmp = fs.realpathSync(tempDir('acs-pause-'));
const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
const ROLES = {
  version: 2,
  roles: {
    reviewer: { use: ['fable', 'sol'] },
    advisor: { use: 'fable', alt: 'astra' },
    writer: { use: ['opus'] },
    builder: { use: [{ family: 'sol', effort: 'high' }, { family: 'opus', effort: 'medium' }], alt: 'fable' },
    investigator: { use: ['fable', 'opus'] },
  },
};
let n = 0;
/** A HOME with these roles and, unless undefined, this paused.json (an object is written as JSON, a string as is). */
function home(paused, roles = ROLES) {
  const h = path.join(tmp, `home-${++n}`);
  write(path.join(h, '.agent-config-studio', 'roles.json'), J(roles));
  if (paused !== undefined) write(path.join(h, '.agent-config-studio', 'paused.json'), typeof paused === 'string' ? paused : J(paused));
  return h;
}
const rolesBytes = (h) => fs.readFileSync(path.join(h, '.agent-config-studio', 'roles.json'), 'utf8');
const HOUR = 3600_000;
const later = new Date(Date.now() + HOUR).toISOString();
const earlier = new Date(Date.now() - HOUR).toISOString();

console.log('\npause: R1 — the file');
{
  const none = home(undefined);
  const r = resolveRole('reviewer', { home: none });
  ok('no paused.json: nothing is paused, the role answers as written', r.family === 'fable' && J(r.use) === J(['fable', 'sol']), J(r));
  ok('…and the answer carries no pause fields at all', !('paused' in r) && !('skipped' in r) && !('altSkipped' in r) && !('pauseError' in r), J(r));
  ok('readPaused on no file: empty, no error', J(readPaused({ home: none })) === J({ entries: [], active: [], error: null, file: path.join(none, '.agent-config-studio', 'paused.json') }));

  for (const [label, body] of [
    ['not JSON', '{ nope'],
    ['an unknown key', { paused: [], extra: 1 }],
    ['an unknown name', { paused: [{ name: 'opuss' }] }],
    ['a bad until', { paused: [{ name: 'claude', until: 'tomorrow-ish' }] }],
    ['a newer version', { version: 9, paused: [] }],
  ]) {
    const h = home(body);
    const p = readPaused({ home: h });
    const rr = resolveRole('reviewer', { home: h });
    ok(`invalid (${label}): reported, nothing paused, no throw`, p.error && !p.active.length && rr.family === 'fable' && typeof rr.pauseError === 'string', J({ p, rr }));
  }
  const newer = readPaused({ home: home({ version: 9, paused: [] }) });
  ok('a newer version names the fix', /newer than this resolver understands — run: acs install-model-id/.test(newer.error), newer.error);
  const h = home({ paused: [{ name: 'claude' }] });
  const before = rolesBytes(h);
  resolveRole('reviewer', { home: h });
  ok('resolving under a pause never writes roles.json', rolesBytes(h) === before);
}

console.log('\npause: R2 — resolution skips paused families');
{
  const vendor = home({ paused: [{ name: 'claude' }] });
  const r = resolveRole('reviewer', { home: vendor });
  ok('a paused vendor: reviewer → sol, its fable skipped', r.family === 'sol' && r.id === IDS.sol && J(r.use) === J(['sol']) && J(r.ids) === J([IDS.sol]), J(r));
  const b = resolveRole('builder', { home: vendor });
  ok('a paused vendor: builder keeps sol at its own effort, its claude fallback dropped', b.family === 'sol' && b.effort === 'high' && J(b.use) === J(['sol']) && J(b.members.map((m) => m.family)) === J(['sol']), J(b));
  ok('…and its alt (fable) is skipped the same way, leaving it empty', b.alt === '' && b.altId === '' && b.altEffort === '' && b.altMember === null && J(b.altSkipped) === J({ family: 'fable', by: 'claude' }), J(b));

  const fam = home({ paused: [{ name: 'fable' }] });
  ok('a paused family: reviewer → sol', resolveRole('reviewer', { home: fam }).family === 'sol');
  const inv = resolveRole('investigator', { home: fam });
  ok('a paused family leaves its vendor\'s other families: investigator → opus', inv.family === 'opus' && inv.id === IDS.opus, J(inv));

  const codex = home({ paused: [{ name: 'codex' }] });
  const a = resolveRole('advisor', { home: codex });
  ok('a paused alt only: advisor still fable, second opinion empty', a.family === 'fable' && a.alt === '' && a.altId === '' && J(a.altSkipped) === J({ family: 'astra', by: 'codex' }) && J(a.skipped) === '[]', J(a));

  const expired = home({ paused: [{ name: 'claude', until: earlier }] });
  const e = resolveRole('reviewer', { home: expired });
  ok('an expired pause is ignored', e.family === 'fable' && !('paused' in e), J(e));
  const live = home({ paused: [{ name: 'claude', until: later }] });
  ok('a pause until a later time holds', resolveRole('reviewer', { home: live }).family === 'sol');
  ok('…and stops holding once that time passes', resolveRole('reviewer', { home: live, now: Date.now() + 2 * HOUR }).family === 'fable');
}

console.log('\npause: R3 — loud, never silent');
{
  const h = home({ paused: [{ name: 'claude' }] });
  const r = resolveRole('reviewer', { home: h });
  ok('the answer names what is paused and what was skipped', J(r.paused) === J(['claude']) && J(r.skipped) === J([{ family: 'fable', by: 'claude' }]), J(r));
  ok('pauseLine is one plain line', pauseLine(r) === 'claude paused: reviewer → sol (skipped fable)', pauseLine(r));
  const mid = (args, hh = h) => spawnSync(process.execPath, [MODEL_ID, ...args], { encoding: 'utf8', env: { HOME: hh, PATH: '/usr/bin:/bin' } });
  const t = mid(['--role', 'reviewer']);
  ok('model-id --role: exit 0, the new answer on stdout', t.status === 0 && t.stdout === `family=sol id=${IDS.sol} effort= alt=\n`, J(t));
  ok('model-id --role: one stderr line naming the skip', t.stderr === 'model-id: claude paused: reviewer → sol (skipped fable)\n', t.stderr);
  const j = mid(['--role', 'reviewer', '--json']);
  const d = JSON.parse(j.stdout);
  ok('model-id --role --json: carries paused and skipped', j.status === 0 && J(d.paused) === J(['claude']) && J(d.skipped) === J([{ family: 'fable', by: 'claude' }]) && d.family === 'sol', j.stdout);
  const alt = mid(['--role', 'builder']);
  ok('a skipped second opinion is said too', alt.stderr === 'model-id: claude paused: builder → sol (skipped opus; no second opinion: fable skipped)\n', alt.stderr);
  const quiet = mid(['--role', 'reviewer'], home(undefined));
  ok('nothing paused: stderr stays empty', quiet.status === 0 && quiet.stderr === '', J(quiet));
  const bad = mid(['--role', 'reviewer'], home('{ nope'));
  ok('an invalid paused.json: the role answers as written, and stderr says the file is ignored', bad.status === 0 && /^family=fable /.test(bad.stdout) && /paused\.json: not valid JSON .* — nothing is paused until it is fixed\n$/.test(bad.stderr), J(bad));
  const all = mid(['--roles']);
  ok('model-id --roles: each skipping role gets its line', /reviewer → sol/.test(all.stderr) && /builder → sol/.test(all.stderr), all.stderr);
}

console.log('\npause: R4 — a role with nothing left refuses');
{
  const h = home({ paused: [{ name: 'claude' }] });
  const r = resolveRole('advisor', { home: h });
  ok('advisor (fable only) refuses with the fix, never promoting its second opinion', r.error === 'every model for advisor is paused; resume claude or add a fallback in ACS → Models → Roles' && !r.family, J(r));
  const w = resolveRole('writer', { home: h });
  ok('the writer role is not exempt', w.error === 'every model for writer is paused; resume claude or add a fallback in ACS → Models → Roles', J(w));
  const two = resolveRole('investigator', { home: home({ paused: [{ name: 'fable' }, { name: 'opus' }] }) });
  ok('paused by two names: the fix names both', two.error === 'every model for investigator is paused; resume fable or opus or add a fallback in ACS → Models → Roles', J(two));
  const m = spawnSync(process.execPath, [MODEL_ID, '--role', 'advisor'], { encoding: 'utf8', env: { HOME: h, PATH: '/usr/bin:/bin' } });
  ok('model-id --role advisor: exit 2, the fix on stderr, unresolved ids on stdout', m.status === 2 && m.stderr === 'model-id: every model for advisor is paused; resume claude or add a fallback in ACS → Models → Roles\n'
    && m.stdout === 'family=MODEL-ID-UNRESOLVED-advisor id=MODEL-ID-UNRESOLVED-advisor effort= alt=\n', J(m));
  const mj = spawnSync(process.execPath, [MODEL_ID, '--role', 'writer', '--json'], { encoding: 'utf8', env: { HOME: h, PATH: '/usr/bin:/bin' } });
  ok('model-id --role writer --json: exit 2, nothing on stdout', mj.status === 2 && mj.stdout === '' && /every model for writer is paused/.test(mj.stderr), J(mj));
}

console.log('\npause: R5 — a family named directly is never paused');
{
  const h = home({ paused: [{ name: 'claude' }] });
  const f = spawnSync(process.execPath, [MODEL_ID, 'fable'], { encoding: 'utf8', env: { HOME: h, PATH: '/usr/bin:/bin' } });
  ok('model-id fable while claude is paused: its id, no note', f.status === 0 && f.stdout === `${IDS.fable}\n` && f.stderr === '', J(f));
}

console.log('\npause: R10 — one sentence in the model guide, never a rewrite per pause');
{
  const free = home(undefined);
  const paused = home({ paused: [{ name: 'claude' }] });
  const a = guideText(loadRoles({ home: free }));
  const b = guideText(loadRoles({ home: paused }));
  ok('the guide says roles skip paused accounts and how to get the current answer',
    a.includes('Roles skip paused accounts (ACS → Usage → Pause); `model-id --role <name>` gives the current answer.'), a);
  ok('the guide is byte-identical whether or not anything is paused', a === b);
}

console.log('\npause: R11 — the README documents pausing');
{
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const sec = readme.slice(readme.indexOf('### Pausing an account'), readme.indexOf('## Model registry'));
  ok('a Pausing section under Subscription usage', readme.indexOf('## Subscription usage') < readme.indexOf('### Pausing an account') && sec.length > 200);
  ok('…naming the file, the refusal, named families and the CLI',
    ['paused.json', 'roles.json` is never written', 'refuses with exit 2', 'never paused', 'acs install-model-id', 'acs pause', 'acs resume'].every((w) => sec.includes(w)), sec);
}

/* ── ask-model and the reviewer pool, with stub CLIs on PATH ─────────── */

const BIN = path.join(tmp, 'bin');
const LOG = path.join(tmp, 'calls.jsonl');
const stub = (name) => `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
if (a[0] === 'mcp') { process.stdout.write('[]'); process.exit(0); }
fs.appendFileSync(${J(LOG)}, JSON.stringify({ name: ${J(name)}, argv: a }) + '\\n');
const i = a.findIndex((x) => x === '--model' || x === '-m');
const model = i === -1 ? 'none' : a[i + 1];
if (${J(name)} === 'claude') process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'answer from ' + model, modelUsage: { [model]: { inputTokens: 1 } } }));
else process.stdout.write('answer from ' + model + '\\n');
`;
for (const name of ['claude', 'codex']) write(path.join(BIN, name), stub(name));
write(path.join(BIN, 'model-id'), `#!/bin/sh\nexec '${process.execPath}' '${MODEL_ID}' "$@"\n`);
for (const f of fs.readdirSync(BIN)) fs.chmodSync(path.join(BIN, f), 0o755);
const PATHS = [BIN, '/usr/bin', '/bin'].join(':');
const PROMPT = path.join(tmp, 'prompt.txt');
fs.writeFileSync(PROMPT, 'Say hello.\n');
const WORK = path.join(tmp, 'work');
fs.mkdirSync(WORK);

function ask(args, h) {
  fs.writeFileSync(LOG, '');
  const r = spawnSync(process.execPath, [ASK, '--prompt-file', PROMPT, '--cwd', WORK, ...args], {
    cwd: WORK, encoding: 'utf8', env: { HOME: h, PATH: PATHS, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig') },
  });
  const calls = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { code: r.status, out: r.stdout, err: r.stderr, calls };
}

console.log('\npause: ask-model follows the pause, and ignores it for a named family');
{
  const h = home({ paused: [{ name: 'claude' }] });
  const r = ask(['--role', 'reviewer'], h);
  ok('--role reviewer while claude is paused: codex runs sol', r.code === 0 && r.calls.length === 1 && r.calls[0].name === 'codex' && r.calls[0].argv.includes(IDS.sol), J(r));
  ok('…and stderr names the skip', r.err.includes('ask-model: claude paused: reviewer → sol (skipped fable)\n'), r.err);
  const f = ask(['--family', 'fable'], h);
  ok('--family fable while claude is paused: claude runs fable', f.code === 0 && f.calls.length === 1 && f.calls[0].name === 'claude' && f.calls[0].argv.includes(IDS.fable), J(f));
  const e = ask(['--role', 'advisor'], h);
  ok('--role advisor with every model paused: refuses, calls nothing', e.code !== 0 && e.calls.length === 0 && /every model for advisor is paused; resume claude/.test(e.err), J(e));
  const s = ask(['--role', 'advisor', '--second'], home({ paused: [{ name: 'codex' }] }));
  ok('--second when the second opinion is paused: refuses naming it, calls nothing', s.code !== 0 && s.calls.length === 0 && /second opinion \(astra\) is paused; resume codex/.test(s.err), J(s));
}

console.log('\npause: the review gate\'s reviewer pool follows the pause');
function showConfig(h, env = {}) {
  const r = spawnSync(process.execPath, [REVIEW, '--show-config'], { cwd: WORK, encoding: 'utf8', env: { HOME: h, PATH: PATHS, REVIEW_CONFIG: '', ...env } });
  const at = r.stdout.indexOf('{');
  let data = null;
  try { data = JSON.parse(r.stdout.slice(at)); } catch {}
  return { code: r.status, data, out: r.stdout, err: r.stderr };
}
{
  const h = home({ paused: [{ name: 'claude' }] });
  const c = showConfig(h);
  ok('pool: only sol, and sol is selected', c.code === 0 && J(c.data?.pool?.map((m) => m.family)) === J(['sol']) && c.data?.selected?.family === 'sol', J(c).slice(0, 600));
  const free = showConfig(home(undefined));
  ok('nothing paused: the pool is fable and sol', J(free.data?.pool?.map((m) => m.family)) === J(['fable', 'sol']), J(free).slice(0, 600));
  const named = showConfig(h, { REVIEW_REVIEWER: 'fable' });
  ok('REVIEW_REVIEWER=fable while claude is paused: fable reviews', named.code === 0 && named.data?.selected?.family === 'fable', J(named).slice(0, 600));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
