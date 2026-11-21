/**
 * Antigravity on the Models panel: ACS's own list of the Gemini models agy offers (agy keeps none on disk), written
 * only by "Check now" and read like any CLI catalog. Every HOME is a temp dir; agy is a fake in that HOME's
 * ~/.local/bin or an in-process stand-in, never the real one.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agyModelsPath, detect, readCatalogs } from '../lib/models-catalog.js';
import { createModelsState } from '../lib/models-panel.js';
import { shapeModels } from '../lib/usage/gemini.js';
import { tempDir, track } from './fixtures/cleanup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DEFAULTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.default.json'), 'utf8'));
const REPLY = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'agy-models', 'models-1.5.13.json'), 'utf8'));
const MODELS = shapeModels(REPLY).models;
const DAY = 86400000;
const NEON = DEFAULTS.models.neon;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const J = JSON.stringify;
const home = () => fs.realpathSync(tempDir('acs-models-agy-'));
const writeList = (h, models = MODELS, fetchedAt = Date.now()) => {
  fs.mkdirSync(path.dirname(agyModelsPath(h)), { recursive: true });
  fs.writeFileSync(agyModelsPath(h), J({ version: 1, fetchedAt, agyVersion: '1.5.13', models }));
};
const neonRow = (cats, registry = DEFAULTS) => detect({ registry, defaults: DEFAULTS, catalogs: cats }).rows.find((r) => r.family === 'neon');

console.log('\nmodels/agy: reading ACS\'s Antigravity list');
{
  const h = home();
  const c = readCatalogs({ home: h });
  ok('never checked → missing, not a failed read', c.agy.ok === false && c.agy.missing === true, J(c.agy));
  ok('...its note says to press Check now, never to run agy', /press Check now to create it/.test(c.agy.note) && !/run `agy`/.test(c.agy.note), c.agy.note);
  ok('...and it is marked as filled only by Check now', c.agy.checkOnly === true && c.codex.checkOnly === undefined);
  ok('the other CLIs still say to run them once', /run `codex` once to create it/.test(c.codex.note) && /run `grok` once/.test(c.grok.note), `${c.codex.note} | ${c.grok.note}`);
  ok('no noCatalog flag is left on any vendor', Object.values(c).every((x) => x.noCatalog === undefined));
  ok('with no list, neon gets no alerts (nothing to check against)', neonRow(c).alerts.length === 0, J(neonRow(c).alerts));
}
{
  const h = home();
  writeList(h);
  const c = readCatalogs({ home: h });
  const byId = Object.fromEntries(c.agy.models.map((m) => [m.id, m]));
  ok('a saved list reads: ok, fresh, six models', c.agy.ok === true && c.agy.note === null && c.agy.stale === false && c.agy.models.length === 6, J({ note: c.agy.note, n: c.agy.models.length }));
  ok('the neon default is in it, under its family', byId[NEON]?.family === 'neon' && byId[NEON].displayName === 'Gemini 4 Neon', J(byId[NEON]));
  ok('efforts ride along', J(byId[NEON]?.efforts) === J(['low', 'medium', 'high', 'xhigh']), J(byId[NEON]));
  ok('a dotted version still names its family', byId['gemini-3.8-flash']?.family === 'flash');
  ok('orchestrators belong to no family', ['gemini-pro-orchestrator-neon', 'gemini-pro-orchestrator-g1-pro'].every((id) => byId[id] && byId[id].family === null));
  ok('other vendors\' models carry efforts: null', c.claude.models.every((m) => m.efforts === null));
  const row = neonRow(c);
  ok('neon: Vendor\'s name from the list, no alerts', row.vendor === 'agy' && row.displayName === 'Gemini 4 Neon' && row.alerts.length === 0, J(row));
}
{
  const h = home();
  writeList(h, [...MODELS, { id: 'gemini-4.1-neon', displayName: 'Gemini 4.1 Neon', efforts: ['high'] }]);
  const up = neonRow(readCatalogs({ home: h })).alerts.find((a) => a.kind === 'update');
  ok('a newer neon in the list → an update alert, acceptable', up?.candidate === 'gemini-4.1-neon' && up.acceptable === true && up.displayName === 'Gemini 4.1 Neon', J(up));
}
{
  const h = home();
  writeList(h, [...MODELS, { id: 'gemini-pro-orchestrator-neon-9', displayName: 'Orchestrator (Neon 9)', efforts: [] },
    { id: 'gemini-9-hydrogen', displayName: 'Hydrogen 9', efforts: [] }]);
  ok('an orchestrator or another family\'s newer model never alerts neon', neonRow(readCatalogs({ home: h })).alerts.length === 0, J(neonRow(readCatalogs({ home: h })).alerts));
}
{
  const h = home();
  writeList(h, MODELS.filter((m) => m.id !== NEON));
  const a = neonRow(readCatalogs({ home: h })).alerts;
  ok('neon gone from the list → vanished', a.length === 1 && a[0].kind === 'vanished', J(a));
}
{
  const h = home();
  writeList(h, MODELS, Date.now() - 8 * DAY);
  const c = readCatalogs({ home: h });
  ok('an 8-day-old list is stale, and says to press Check now', c.agy.ok === true && c.agy.stale === true && /8 days old — press Check now to refresh it/.test(c.agy.note), c.agy.note);
}
{
  const h = home();
  fs.mkdirSync(path.dirname(agyModelsPath(h)), { recursive: true });
  fs.writeFileSync(agyModelsPath(h), '{ not json');
  const c = readCatalogs({ home: h });
  ok('a broken list is a failed read, not missing', c.agy.ok === false && c.agy.missing === false && /could not be read .* press Check now/.test(c.agy.note), c.agy.note);
  fs.writeFileSync(agyModelsPath(h), J({ version: 1, fetchedAt: Date.now() }));
  ok('a list with no models array is a failed read', readCatalogs({ home: h }).agy.ok === false && /no model list/.test(readCatalogs({ home: h }).agy.note));
}
{
  const h = home();
  writeList(h, [...MODELS, { id: 'claude-opus-9', displayName: 'Planted' }, { id: 'GEMINI BAD', displayName: 'x' }, { displayName: 'no id' }]);
  const ids = readCatalogs({ home: h }).agy.models.map((m) => m.id);
  ok('a hand-added non-Gemini or malformed id is not read', ids.length === 6 && !ids.includes('claude-opus-9'), J(ids));
}

console.log('\nmodels/agy: Check now');
const state = (h, refreshAgy) => createModelsState({ detectFn: async () => [], codexHomes: () => [], refreshAgy, home: h });
const agyCat = (v) => v.catalogs.find((c) => c.vendor === 'agy');
{
  const h = home();
  let calls = 0;
  const s = state(h, async () => { calls++; return { ok: true, agyVersion: '1.5.13', models: MODELS.map((m) => ({ ...m, extra: 'dropped' })) }; });
  await s.check();
  ok('a plain read (server start) never asks agy', calls === 0 && !fs.existsSync(agyModelsPath(h)));
  await s.check({ refresh: true });
  ok('Check now asks agy once', calls === 1);
  const saved = JSON.parse(fs.readFileSync(agyModelsPath(h), 'utf8'));
  ok('...and saves the list in ~/.agent-config-studio/cache/agy-models.json', saved.version === 1 && saved.agyVersion === '1.5.13'
    && Math.abs(saved.fetchedAt - Date.now()) < 60000 && saved.models.length === 6, J({ ...saved, models: saved.models.length }));
  ok('...with only id, displayName and efforts per model', saved.models.every((m) => J(Object.keys(m)) === J(['id', 'displayName', 'efforts'])));
  ok('...and nothing else at the top', J(Object.keys(saved).sort()) === J(['agyVersion', 'fetchedAt', 'models', 'version']));
  const v = await s.view();
  const cat = agyCat(v);
  ok('the view: Antigravity ok, six models, no note', cat.ok === true && cat.count === 6 && cat.note === null && cat.refreshNote === null, J(cat));
  ok('...with the names listed', J(cat.names) === J(MODELS.map((m) => m.displayName)), J(cat.names));
  ok('...and only for Antigravity', v.catalogs.filter((c) => c.vendor !== 'agy').every((c) => c.names === undefined));
  ok('...and no model objects leave the view', v.catalogs.every((c) => c.models === undefined));
  ok('...neon reads its name', v.rows.find((r) => r.family === 'neon')?.displayName === 'Gemini 4 Neon');
}
{
  const h = home();
  writeList(h, MODELS, Date.now() - 2 * DAY);
  const before = fs.readFileSync(agyModelsPath(h), 'utf8');
  const s = state(h, async () => ({ ok: false, agyVersion: '1.5.13', reason: 'agy models exited 1 — if agy is signed out, run `agy` and sign in' }));
  const v = (await s.check({ refresh: true }), await s.view());
  ok('a failed ask keeps the saved list byte for byte', fs.readFileSync(agyModelsPath(h), 'utf8') === before);
  ok('...the list still shows', agyCat(v).ok === true && agyCat(v).count === 6);
  ok('...with the reason, and that it is the last fetched', /^Not refreshed: agy models exited 1 .*\. Shown as last fetched\.$/.test(agyCat(v).refreshNote || ''), agyCat(v).refreshNote);
}
{
  const h = home();
  const s = state(h, async () => ({ ok: false, reason: 'the Antigravity CLI (agy) is not installed' }));
  await s.check({ refresh: true });
  const cat = agyCat(await s.view());
  ok('a failed ask with nothing saved: no file, the reason, no "last fetched"', !fs.existsSync(agyModelsPath(h)) && cat.refreshNote === 'Not refreshed: the Antigravity CLI (agy) is not installed.' && cat.missing === true, J(cat));
}
{
  const h = home();
  writeList(h);
  const before = fs.readFileSync(agyModelsPath(h), 'utf8');
  const s1 = state(h, async () => { throw new Error('boom'); });
  await s1.check({ refresh: true });
  ok('a refresher that throws → its message, the list kept', /^Not refreshed: boom\. Shown as last fetched\.$/.test(agyCat(await s1.view()).refreshNote || '') && fs.readFileSync(agyModelsPath(h), 'utf8') === before);
  const s2 = state(h, async () => ({ ok: true, models: null }));
  await s2.check({ refresh: true });
  ok('an ok answer without a model list is not saved', /^Not refreshed: /.test(agyCat(await s2.view()).refreshNote || '') && fs.readFileSync(agyModelsPath(h), 'utf8') === before);
}
{
  const h = home();
  let calls = 0;
  const s = state(h, () => new Promise((r) => { calls++; setTimeout(() => r({ ok: true, agyVersion: '1.5.13', models: MODELS }), 300); }));
  await Promise.all([s.check({ refresh: true }), s.check({ refresh: true })]);
  ok('two Check nows at once ask agy once', calls === 1, String(calls));
}

console.log('\nmodels/agy: Check now through the real server and a fake agy');
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
{
  const h = home();
  const bin = path.join(h, '.local', 'bin');
  const log = path.join(h, 'agy-calls.jsonl');
  // ok answers; nostatus answers without a status; hang never answers.
  const modeFile = path.join(h, 'agy-mode');
  const { status: _status, ...noStatus } = REPLY;
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'agy'), `#!${process.execPath}
const fs = require('fs');
let mode = 'ok';
try { mode = fs.readFileSync(${J(modeFile)}, 'utf8').trim(); } catch {}
fs.appendFileSync(${J(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), entries: fs.readdirSync(process.cwd()), pid: process.pid }) + '\\n');
if (process.argv[2] === '--version') { process.stdout.write('1.5.13\\n'); process.exit(0); }
if (process.argv.slice(2).join(' ') === '--output-format json models') {
  if (mode === 'hang') setTimeout(() => {}, 60000);
  else { process.stdout.write(mode === 'nostatus' ? ${J(J(noStatus))} : ${J(J(REPLY))}); process.exit(0); }
} else process.exit(9);
`, { mode: 0o755 });
  const calls = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
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
  try {
    ok('the server starts', up, out.slice(-400));
    const first = await (await fetch(`${base}/api/models`)).json();
    ok('server start and GET /api/models never run agy', calls().length === 0 && agyCat(first).missing === true, J(calls()));
    const r = await fetch(`${base}/api/models/check`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' });
    const v = await r.json();
    const c = calls();
    ok('Check now runs agy: --version, then the pinned models argv', r.status === 200 && c.length === 2 && c[0].argv.join(' ') === '--version'
      && c[1].argv.join(' ') === '--output-format json models', J(c.map((x) => x.argv)));
    ok('...each from an empty folder that is not the server\'s', c.every((x) => x.entries.length === 0 && path.resolve(x.cwd) !== ROOT));
    ok('...and the answer is saved and shown', fs.existsSync(agyModelsPath(h)) && agyCat(v).ok === true && agyCat(v).names?.includes('Gemini 4 Neon'), J(agyCat(v)));
    ok('...neon reads Gemini 4 Neon with no alert', v.rows.find((x) => x.family === 'neon')?.displayName === 'Gemini 4 Neon'
      && v.rows.find((x) => x.family === 'neon').alerts.length === 0, J(v.rows.find((x) => x.family === 'neon')));
    ok('...and no file path leaves the response', !JSON.stringify(v).includes('agy-models.json') && !JSON.stringify(v).includes(h));

    // A reply without status "SUCCESS" must not replace the saved list.
    const saved = fs.readFileSync(agyModelsPath(h), 'utf8');
    fs.writeFileSync(modeFile, 'nostatus');
    const ns = await (await fetch(`${base}/api/models/check`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' })).json();
    ok('a models reply with no status leaves the saved list byte for byte', fs.readFileSync(agyModelsPath(h), 'utf8') === saved);
    ok('...still shown, with why it was not refreshed', agyCat(ns).ok === true && /^Not refreshed: agy models reported no SUCCESS status\. Shown as last fetched\.$/.test(agyCat(ns).refreshNote || ''), J(agyCat(ns)));

    // Stopping the studio (acs stop sends SIGTERM) while Check now waits on agy: agy and its folder go with it.
    fs.writeFileSync(modeFile, 'hang');
    const before = calls().length;
    const inflight = fetch(`${base}/api/models/check`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' }).catch(() => null);
    let hung = null;
    for (let i = 0; i < 150 && !hung; i++) {
      hung = calls().slice(before).find((x) => x.argv.join(' ') === '--output-format json models') || null;
      if (!hung) await new Promise((r) => setTimeout(r, 30));
    }
    ok('Check now is waiting on a hanging agy', !!hung && fs.existsSync(hung.cwd), J(calls().slice(before)));
    const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
    child.kill('SIGTERM');
    const ended = await exited;
    await inflight;
    let alive = true;
    for (let i = 0; i < 50 && alive && hung; i++) {
      try { process.kill(hung.pid, 0); await new Promise((r) => setTimeout(r, 20)); } catch { alive = false; }
    }
    ok('the studio stops on SIGTERM', ended.signal === 'SIGTERM', J(ended));
    ok('...and agy does not outlive it', !!hung && alive === false, String(hung?.pid));
    ok('...nor does agy\'s temp folder', !!hung && !fs.existsSync(hung.cwd), hung?.cwd);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const gone = new Promise((r) => child.once('exit', r));
      child.kill('SIGINT');
      await gone;
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
