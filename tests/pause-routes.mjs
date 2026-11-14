/**
 * The pause routes through the real server (builds/pause-account R6, R7, R8):
 * a `node server.js` with HOME redirected to a temp dir. Strict same-origin,
 * the stale-resolver refusal before any write, and the Roles view's notice
 * data. roles.json is never written.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { tempDir, track } from './fixtures/cleanup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realBefore = snapshotRealHomes();
const J = JSON.stringify;
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

const home = fs.realpathSync(tempDir('acs-pause-routes-'));
const studio = path.join(home, '.agent-config-studio');
fs.mkdirSync(studio, { recursive: true });
const ROLES = J({ version: 2, roles: { builder: { use: ['opus', 'sol'] }, reviewer: { use: ['fable', 'sol'] }, advisor: { use: 'fable', alt: 'astra' } } });
fs.writeFileSync(path.join(studio, 'roles.json'), ROLES);
const pausedFile = path.join(studio, 'paused.json');
const readPaused = () => { try { return JSON.parse(fs.readFileSync(pausedFile, 'utf8')); } catch { return null; } };

const port = await freePort();
const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: { HOME: home, PORT: String(port), PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: os.tmpdir() }, stdio: ['ignore', 'pipe', 'pipe'],
}); track(child);
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
const base = `http://localhost:${port}`;
let up = false;
for (let i = 0; i < 100 && !up; i++) {
  try { up = (await fetch(`${base}/api/health`)).ok; } catch {}
  if (!up) await sleep(100);
}
if (!up) { console.log(`server did not start: ${log.slice(-600)}`); process.exit(1); }

const SAME = { 'sec-fetch-site': 'same-origin' };
async function call(method, route, body, headers = SAME) {
  const r = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : J(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json };
}

try {
  console.log('\npause routes: strict same-origin, before any write');
  for (const [route, method, body] of [['/api/pause', 'GET'], ['/api/pause', 'POST', { name: 'claude', until: null }], ['/api/pause/resume', 'POST', { name: 'claude' }]]) {
    const r = await call(method, route, body, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
    ok(`${method} ${route} from another site → 403`, r.status === 403, J(r));
  }
  ok('…and nothing was written', !fs.existsSync(pausedFile));

  console.log('\npause routes: R7 — pause and resume');
  const g = await call('GET', '/api/pause');
  ok('GET /api/pause: nothing paused', g.status === 200 && J(g.body.entries) === '[]' && g.body.error === null && g.body.resolverStale === false, J(g));
  const until = new Date(Date.now() + 3600_000).toISOString();
  const p = await call('POST', '/api/pause', { name: 'claude', until });
  ok('POST /api/pause: claude until a time', p.status === 200 && J(readPaused()) === J({ version: 1, paused: [{ name: 'claude', until }] }), J({ p, file: readPaused() }));
  ok('…the answer lists it as in force, with its vendor', J(p.body.entries) === J([{ name: 'claude', kind: 'vendor', vendor: 'claude', until, active: true }]), J(p.body));
  const fam = await call('POST', '/api/pause', { name: 'sol', until: null });
  ok('a family, until resumed: its vendor comes from its id', fam.status === 200 && fam.body.entries.find((e) => e.name === 'sol')?.vendor === 'codex', J(fam.body));
  const bad = await call('POST', '/api/pause', { name: 'nobody', until: null });
  ok('an unknown name → 400', bad.status === 400 && /is not an account/.test(bad.body.error), J(bad));
  const past = await call('POST', '/api/pause', { name: 'codex', until: '2001-01-01T00:00:00Z' });
  ok('a past time → 400', past.status === 400 && /already passed/.test(past.body.error), J(past));

  console.log('\npause routes: R8 — the Roles view carries what the pauses do');
  const v = await call('GET', '/api/models/roles');
  const by = Object.fromEntries((v.body.pause?.roles || []).map((r) => [r.name, r]));
  ok('the roles view has the pause state', v.status === 200 && J(v.body.pause.active) === J(['claude', 'sol']), J(v.body.pause));
  ok('advisor refuses (fable only), reviewer and builder refuse too with sol also paused', by.advisor?.refuses === true && by.reviewer?.refuses === true && by.builder?.refuses === true, J(by));
  await call('POST', '/api/pause/resume', { name: 'sol' });
  const v2 = (await call('GET', '/api/models/roles')).body.pause;
  const by2 = Object.fromEntries(v2.roles.map((r) => [r.name, r]));
  ok('with only claude paused: reviewer → sol (skipped fable), builder → sol', by2.reviewer.family === 'sol' && J(by2.reviewer.skipped) === J([{ family: 'fable', by: 'claude' }]) && by2.builder.family === 'sol', J(by2));
  ok('…and builder and reviewer now share codex', v2.sameVendor === 'codex', J(v2));
  ok('roles.json was never written', fs.readFileSync(path.join(studio, 'roles.json'), 'utf8') === ROLES);
  const r = await call('POST', '/api/pause/resume', { name: 'claude' });
  ok('POST /api/pause/resume: nothing left paused', r.status === 200 && J(readPaused()) === J({ version: 1, paused: [] }), J(readPaused()));
  ok('the roles view then has no effect to show', J((await call('GET', '/api/models/roles')).body.pause.roles) === '[]');

  console.log('\npause routes: R6 — a stale installed resolver refuses the pause');
  const installed = path.join(studio, 'resolver', 'lib', 'roles.js');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, '// an older roles.js\n');
  const before = fs.readFileSync(pausedFile, 'utf8');
  const s = await call('GET', '/api/pause');
  ok('GET says so, with the fix', s.body.resolverStale === true && /would ignore a pause\. Run: acs install-model-id/.test(s.body.staleFix), J(s.body));
  const refused = await call('POST', '/api/pause', { name: 'claude', until: null });
  ok('POST → 409 naming acs install-model-id', refused.status === 409 && /Run: acs install-model-id, then pause again/.test(refused.body.error), J(refused));
  ok('…and nothing is written', fs.readFileSync(pausedFile, 'utf8') === before);
  fs.copyFileSync(path.join(ROOT, 'lib', 'roles.js'), installed);
  const fine = await call('POST', '/api/pause', { name: 'claude', until: null });
  ok('an identical installed copy: the pause goes through', fine.status === 200 && readPaused().paused[0]?.name === 'claude', J(fine));
} finally {
  child.kill('SIGKILL');
}
assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
