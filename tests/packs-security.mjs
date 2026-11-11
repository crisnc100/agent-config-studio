/**
 * The review gate's security switch (Packs → Review gate): Off / When code
 * changes / Always, written to security.run in the home review config the
 * review script reads first. The lib half runs against temp HOMEs, and the
 * review script itself reads the result back; the page half drives the
 * buttons in the fake DOM, with the routes answered by the same lib code
 * against a temp HOME, so a click writes a real file.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { tempDir } from './fixtures/cleanup.mjs';
import { ROOT, sandbox, tests, track } from './fixtures/packs-sandbox.mjs';
import { bootPage, routesFor, settle } from './fixtures/shell-page.mjs';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { machine } from '../lib/packs.js';
import { catalogView, securitySetting } from '../lib/packs-routes.js';
import { securityApply, securityPlan } from '../lib/review-security.js';
import { settingsApply, settingsPlan } from '../lib/review-settings.js';

const realBefore = snapshotRealHomes();
const { ok, done } = tests();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REVIEW = path.join(ROOT, 'packs', 'review-gate', 'runtime', 'review.mjs');

function home() {
  const h = tempDir('acs-security-switch-');
  const bin = path.join(h, 'bin');
  fs.mkdirSync(bin);
  // model-id answers the reviewer role, so review.mjs --show-config can print what it reads.
  fs.writeFileSync(path.join(bin, 'model-id'), `#!${process.execPath}
const a = process.argv.slice(2)
if (a[0] === '--role') console.log(JSON.stringify({ use: ['sol'], ids: ['gpt-stub-sol'] }))
else if (a[0] === '--flavor') console.log(JSON.stringify({ flavor: { effort: 'high' } }))
else console.log('gpt-stub-sol')
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}\n`, { mode: 0o755 });
  const m = machine({ HOME: h, PATH: process.env.PATH });
  return { h, bin, m, primary: path.join(m.runtime, 'config.json'), older: path.join(m.claudeHome, 'review-config.json') };
}
const put = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
// What the review script itself reads as security.run in this HOME.
function gateReads(t) {
  const r = spawnSync(process.execPath, [REVIEW, '--show-config'], { cwd: t.h, encoding: 'utf8',
    env: { HOME: t.h, PATH: [t.bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'), GIT_CONFIG_NOSYSTEM: '1' } });
  try { return JSON.parse(r.stdout).security; } catch { return `unreadable: ${r.stdout} ${r.stderr}`; }
}
const status = (fn) => { try { fn(); return null; } catch (e) { return e.status || 500; } };
const backups = (t) => (fs.existsSync(t.m.backups) ? fs.readdirSync(t.m.backups, { recursive: true }).filter((f) => fs.statSync(path.join(t.m.backups, f)).isFile()) : []);

try {
  console.log('\nthe lib: which file, the diff first, a backup, and the review script reads it');
  {
    const t = home();
    const plan = securityPlan('required', t.m);
    ok('no home config: the preview names the primary file as new, and writes nothing', plan.file === '~/.agent-config-studio/review-gate/config.json'
      && !plan.exists && plan.changes && read(t.primary) === null, JSON.stringify(plan));
    ok('…its diff adds security.run "required"', plan.diff.some((d) => d.op === '+' && /"run": "required"/.test(d.line)) && plan.diff.every((d) => d.op === '+'), JSON.stringify(plan.diff));
    const r = securityApply('required', plan.signature, t.m);
    ok('apply writes it, with no backup for a file that did not exist', r.changed && r.backup === null && JSON.parse(read(t.primary)).security.run === 'required', JSON.stringify(r));
    ok('the review script reads "required"', gateReads(t) === 'required', gateReads(t));
    ok('the studio\'s reader agrees', securitySetting(t.m) === 'required' && catalogView(t.m, { installedOf: () => true }).settings.security === 'required');
  }
  {
    const t = home();
    const before = '{\n  "reviewer": "sol",\n  "security": { "timeoutMs": 60000 },\n  "merge": { "policy": "off" }\n}\n';
    put(t.older, before);
    const plan = securityPlan('always', t.m);
    ok('only ~/.claude/review-config.json: that is the file the gate reads, so that is the one changed', plan.file === '~/.claude/review-config.json' && plan.exists, plan.file);
    const r = securityApply('always', plan.signature, t.m);
    const doc = JSON.parse(read(t.older));
    ok('every other key is kept, security.timeoutMs included', doc.reviewer === 'sol' && doc.merge.policy === 'off' && doc.security.timeoutMs === 60000 && doc.security.run === 'always', read(t.older));
    ok('no primary file appears', read(t.primary) === null);
    ok('the old file is in the backups folder, byte for byte', r.backup && fs.readFileSync(r.backup.replace(/^~/, t.h), 'utf8') === before && backups(t).length === 1, JSON.stringify(r));
    ok('the review script reads "always"', gateReads(t) === 'always', gateReads(t));
  }
  {
    const t = home();
    put(t.primary, '{"security":{"run":"always"}}\n');
    put(t.older, '{"security":{"run":"off"}}\n');
    const plan = securityPlan('off', t.m);
    ok('both exist: the primary is the one the gate reads first, and the one changed', plan.file === '~/.agent-config-studio/review-gate/config.json' && plan.was === 'always', JSON.stringify(plan));
    securityApply('off', plan.signature, t.m);
    ok('…the older file is untouched', read(t.older) === '{"security":{"run":"off"}}\n');
    ok('the review script reads "off"', gateReads(t) === 'off', gateReads(t));
  }
  {
    const t = home();
    put(t.primary, '{"security":{"run":"off"}}\n');
    const plan = securityPlan('required', t.m);
    put(t.primary, '{"security":{"run":"off"},"pick":"rotate"}\n');
    ok('a file changed after the preview: apply refuses (409) and writes nothing', status(() => securityApply('required', plan.signature, t.m)) === 409
      && read(t.primary) === '{"security":{"run":"off"},"pick":"rotate"}\n' && backups(t).length === 0);
    ok('no signature, or a made-up one: refused', status(() => securityApply('required', undefined, t.m)) === 400 && status(() => securityApply('required', 'f'.repeat(64), t.m)) === 409);
    ok('an unknown level: refused (400)', status(() => securityPlan('sometimes', t.m)) === 400 && status(() => securityPlan(undefined, t.m)) === 400);
    put(t.primary, '{ not json');
    ok('a malformed config: the preview refuses (409) and names the file; nothing changes', status(() => securityPlan('always', t.m)) === 409 && read(t.primary) === '{ not json');
    put(t.primary, '[1]');
    ok('a config that is not an object: refused', status(() => securityPlan('always', t.m)) === 409);
    put(t.primary, '{"security":{"run":"always"}}\n');
    const same = securityPlan('always', t.m);
    ok('the level already set: no change, and apply writes nothing', !same.changes && securityApply('always', same.signature, t.m).changed === false && backups(t).length === 0);
  }

  console.log('\nthe page: three buttons, the diff before anything is saved, Save and Cancel');
  const t = home();
  put(t.primary, '{\n  "pick": "rotate"\n}\n');
  const writes = [];
  // The settings show only once the review gate's code-review part is installed.
  const withGate = (v) => { v.packs.find((p) => p.id === 'review-gate').installed = { version: '1', parts: { 'code-review': { harnesses: ['claude'], installedAt: null } } }; return v; };
  const routes = routesFor({
    'GET /api/packs': () => withGate(catalogView(t.m, { installedOf: () => true })),
    'GET /api/packs/status': () => ({ job: { running: false, result: { packs: [], legacy: [], checkedAt: Date.now(), trust: false } } }),
    'GET /api/models/roles': () => ({ roles: [] }),
    'POST /api/packs/review-settings/plan': (b) => settingsPlan(b.changes, t.m),
    'POST /api/packs/review-settings/apply': (b) => { writes.push(b); return settingsApply(b.changes, b.signature, t.m); },
  });
  const page = await bootPage({ routes, hash: '#packs' });
  const c = () => page.$('content');
  const sec = () => c().querySelector('[data-pack="review-gate"] .pk-sec');
  for (let i = 0; i < 100 && !sec(); i++) await sleep(30);
  await settle(10);
  const tx = (n) => (n ? page.text(n) : '');
  const levels = () => sec().querySelectorAll('.pk-sec-levels button');
  const pressed = () => levels().find((b) => b.getAttribute('aria-pressed') === 'true');
  ok('the review gate card has the switch, labelled in plain words', !!sec() && /Security pass in PR reviews/.test(tx(sec())), tx(sec()));
  ok('three buttons: Off, When code changes, Always', levels().map(tx).join('|') === 'Off|When code changes|Always', levels().map(tx).join('|'));
  ok('the level in force is the pressed one: Off', tx(pressed()) === 'Off' && /Now: PR reviews run no security pass\./.test(tx(sec())), tx(sec()));
  ok('every button is a styled kind (secondary), and no fold', levels().every((b) => /\bbtn\b/.test(b.className)) && !sec().querySelector('details'));
  ok('only the review gate card has it', c().querySelectorAll('.pk-sec').length === 1);

  levels().find((b) => tx(b) === 'Always').click();
  for (let i = 0; i < 100 && !sec().querySelector('.pk-sec-preview'); i++) await sleep(20);
  await settle(5);
  const pre = () => sec().querySelector('.pk-sec-preview');
  ok('clicking Always shows the file and its diff first', /this changes ~\/\.agent-config-studio\/review-gate\/config\.json, and a copy of it goes to the backups folder first/.test(tx(pre()))
    && pre().querySelectorAll('.diff-line.add').some((l) => /"run": "always"/.test(tx(l))), tx(pre()));
  ok('…and nothing is written yet', read(t.primary) === '{\n  "pick": "rotate"\n}\n' && writes.length === 0);
  const acts = () => pre().querySelectorAll('button');
  ok('the preview\'s buttons: Save (primary) and Cancel (quiet)', acts().map((b) => `${tx(b)}:${b.className}`).join('|') === 'Save:btn primary|Cancel:btn ghost', acts().map((b) => `${tx(b)}:${b.className}`).join('|'));
  acts().find((b) => tx(b) === 'Cancel').click();
  await settle(5);
  ok('Cancel drops the preview and writes nothing', !pre() && writes.length === 0 && read(t.primary) === '{\n  "pick": "rotate"\n}\n');

  levels().find((b) => tx(b) === 'When code changes').click();
  for (let i = 0; i < 100 && !pre(); i++) await sleep(20);
  acts().find((b) => tx(b) === 'Save').click();
  for (let i = 0; i < 100 && !sec().querySelector('.pk-result'); i++) await sleep(20);
  await settle(5);
  ok('Save sends the preview\'s signature and writes security.run "required"', writes.length === 1 && JSON.stringify(writes[0].changes) === '{"security.run":"required"}' && /^[0-9a-f]{64}$/.test(writes[0].signature)
    && JSON.parse(read(t.primary)).security.run === 'required' && JSON.parse(read(t.primary)).pick === 'rotate', read(t.primary));
  ok('…says where it saved and where the old file went', /Saved: ~\/\.agent-config-studio\/review-gate\/config\.json now says “When code changes”\. The old file is at ~\/\.agent-config-studio\/backups\//.test(tx(sec().querySelector('.pk-result'))), tx(sec()));
  ok('…the pressed button and the diagram follow it', tx(pressed()) === 'When code changes' && !c().querySelector('[data-pack="review-gate"] .step[data-step="security"]')?.classList.contains('off'), tx(sec()));
  ok('the review script reads "required"', gateReads(t) === 'required', gateReads(t));

  // A file that changed after the preview: the server's 409 shows, and the file is left as it is now.
  levels().find((b) => tx(b) === 'Off').click();
  for (let i = 0; i < 100 && !pre(); i++) await sleep(20);
  put(t.primary, '{"security":{"run":"always"}}\n');
  acts().find((b) => tx(b) === 'Save').click();
  for (let i = 0; i < 100 && !sec().querySelector('.notice.error'); i++) await sleep(20);
  ok('a stale preview: the refusal is shown, and the file is not overwritten', /changed since the preview/.test(tx(sec().querySelector('.notice.error'))) && read(t.primary) === '{"security":{"run":"always"}}\n', tx(sec()));
  ok('no page errors', page.errors.length === 0, page.errors.join(' | '));
  page.done();

  console.log('\nthe routes, through a real server: same-origin only, unknown fields refused, a plan writes nothing');
  const sb = sandbox('security', { clis: ['claude'] });
  try {
    const port = await new Promise((res, rej) => { const srv = net.createServer(); srv.once('error', rej); srv.listen(0, '127.0.0.1', () => { const n = srv.address().port; srv.close(() => res(n)); }); });
    const child = track(spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...sb.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] }));
    const base = `http://localhost:${port}`;
    for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await sleep(100); }
    const post = async (route, body, headers = {}) => {
      const r = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers }, body: JSON.stringify(body) });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, body: json, text };
    };
    const file = path.join(sb.home, '.agent-config-studio/review-gate/config.json');
    for (const route of ['/api/packs/security/plan', '/api/packs/security/apply']) {
      const r = await post(route, { level: 'always', signature: '0'.repeat(64) }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
      ok(`a foreign origin: POST ${route} → 403`, r.status === 403, `${r.status} ${r.text.slice(0, 120)}`);
    }
    ok('an unknown field: 400', (await post('/api/packs/security/plan', { level: 'always', path: '/etc/x' })).status === 400);
    const plan = await post('/api/packs/security/plan', { level: 'always' });
    ok('a plan answers with the diff and writes nothing, with no absolute HOME path in it', plan.status === 200 && plan.body.changes && !fs.existsSync(file) && !plan.text.includes(sb.home), plan.text.slice(0, 300));
    const applied = await post('/api/packs/security/apply', { level: 'always', signature: plan.body.signature });
    ok('apply with the plan\'s signature writes security.run "always"', applied.status === 200 && JSON.parse(fs.readFileSync(file, 'utf8')).security.run === 'always', applied.text.slice(0, 300));
    const again = await post('/api/packs/security/apply', { level: 'always', signature: plan.body.signature });
    ok('the same signature again, now stale: 409', again.status === 409, `${again.status} ${again.text.slice(0, 120)}`);
    child.kill('SIGKILL');
  } finally { sb.cleanup(); }
} catch (e) {
  ok(`no test block threw (${e?.message || e})`, false, e?.stack || String(e));
} finally {
  try { assertRealHomesUnchanged(realBefore, ok); } catch (e) { ok('the real homes are unchanged', false, e.message); }
  done();
}
