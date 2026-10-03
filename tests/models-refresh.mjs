/**
 * "Check now" refreshes every Codex home's catalog: ~/.codex and each codex
 * seat home, by the codex CLI found on PATH, through codex-limits.js's
 * app-server chokepoint. A fake codex in a temp dir stands in for the real
 * one — it rewrites the catalog only when asked `model/list`, and logs every
 * method it is sent — and every HOME here is a fresh temp dir. The real codex
 * and the live HOME are never touched.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexModel, seedHome, writeCodexCatalog } from './fixtures/models-home.mjs';
import { refreshCodexCatalogs } from '../lib/usage/codex-limits.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realHome = os.homedir();
const temps = [];
const children = [];
const HOUR = 3600 * 1000;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tmpDir = (prefix) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); temps.push(d); return d; };
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const cache = (h) => readJson(path.join(h, 'models_cache.json'));
const methods = (h) => { try { return fs.readFileSync(path.join(h, 'fake-methods.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const setMode = (h, mode) => fs.writeFileSync(path.join(h, 'fake-mode'), mode);

/**
 * A fake codex 0.160.0. `model/list` re-stamps $CODEX_HOME's catalog with its
 * version and adds gpt-6.1-sol, as the real one does for an older catalog.
 * $CODEX_HOME/fake-mode picks a failure: `error` answers with an error,
 * `silent` answers without writing (a signed-out home), `hang` never answers.
 */
function fakeCodex(dir) {
  const file = path.join(dir, 'codex');
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require('fs'), path = require('path');
if (process.argv[2] === '--version') { console.log('codex-cli 0.160.0'); process.exit(0); }
if (process.argv[2] !== 'app-server') process.exit(2);
const home = process.env.CODEX_HOME;
let mode = 'ok';
try { mode = fs.readFileSync(path.join(home, 'fake-mode'), 'utf8').trim(); } catch {}
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const msg = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    fs.appendFileSync(path.join(home, 'fake-methods.log'), msg.method + '\\n');
    if (mode === 'hang') continue;
    if (msg.method === 'initialize') send({ id: msg.id, result: { userAgent: 'fake/0.160.0' } });
    else if (msg.method === 'model/list') {
      if (mode === 'error') { send({ id: msg.id, error: { code: -32000, message: 'not signed in' } }); continue; }
      if (mode !== 'silent') {
        const f = path.join(home, 'models_cache.json');
        const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
        doc.client_version = '0.160.0';
        doc.fetched_at = new Date().toISOString();
        if (!doc.models.some((m) => m.slug === 'gpt-6.1-sol')) doc.models.unshift({ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list' });
        fs.writeFileSync(f, JSON.stringify(doc));
      }
      send({ id: msg.id, result: { data: [] } });
    } else send({ id: msg.id, error: { code: -32601, message: 'unexpected ' + msg.method } });
  }
});
`, { mode: 0o755 });
  return dir;
}

const OLD = [codexModel('gpt-6-sol', 'GPT-6-Sol'), codexModel('gpt-6-astra', 'GPT-6-Astra')];
const oldCatalog = (h) => writeCodexCatalog(h, OLD, Date.now() - 2 * HOUR, '0.156.0');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startServer(h, pathDirs) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { HOME: h, PORT: String(port), PATH: [...pathDirs, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'), TMPDIR: os.tmpdir() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return { child, base }; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`server did not start: ${log.slice(-600)}`);
}

const stop = async (srv) => {
  if (srv.child.exitCode !== null) return;
  const gone = new Promise((r) => srv.child.once('exit', r));
  srv.child.kill('SIGINT');
  await gone;
};

async function post(base, route) {
  const r = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: r.status, body, text };
}
const codexCat = (v) => v.catalogs.find((c) => c.vendor === 'codex');

/** A temp HOME with ~/.codex and two registered codex seats, all on an old catalog. */
function seatedHome() {
  const h = seedHome({ prefix: 'acs-refresh-' });
  temps.push(h);
  const seats = ['a', 'b'].map((n) => path.join(h, '.codex-seats', `seat-${n}`));
  for (const s of seats) oldCatalog(s);
  oldCatalog(path.join(h, '.codex'));
  fs.mkdirSync(path.join(h, '.agent-config-studio'), { recursive: true });
  fs.writeFileSync(path.join(h, '.agent-config-studio', 'seats.json'), JSON.stringify({
    version: 1,
    seats: seats.map((home, i) => ({ id: `seat-${'ab'[i]}`, vendor: 'codex', label: `Seat ${'AB'[i]}`, home })),
  }));
  return { h, homes: [path.join(h, '.codex'), ...seats] };
}

async function main() {
  console.log('\nmodels: Check now refreshes the Codex catalogs');
  const fakeBin = fakeCodex(tmpDir('acs-fake-codex-'));

  // ── criterion 1: every known home, refreshed by the codex on PATH ────────
  {
    const { h, homes } = seatedHome();
    const srv = await startServer(h, [fakeBin]);
    try {
      ok('server start does not refresh: no home was sent anything', homes.every((x) => methods(x).length === 0),
         homes.map((x) => methods(x).join(',')).join(' | '));
      const r = await post(srv.base, '/api/models/check');
      ok('Check now → 200', r.status === 200, r.text.slice(0, 200));
      ok('every home\'s catalog is re-stamped by Codex 0.160.0 (~/.codex and both seats)',
         homes.every((x) => cache(x).client_version === '0.160.0'), homes.map((x) => cache(x).client_version).join(', '));
      ok('...and each now lists gpt-6.1-sol', homes.every((x) => cache(x).models.some((m) => m.slug === 'gpt-6.1-sol')));
      ok('the view is read after the refresh: gpt-6.1-sol is counted', codexCat(r.body).count === 3, JSON.stringify(codexCat(r.body)));
      ok('...and no refresh note when every home refreshed', codexCat(r.body).refreshNote === null, codexCat(r.body).refreshNote);
      // criterion 4: only initialize and model/list, never a thread or a turn.
      ok('each home was sent exactly initialize, model/list', homes.every((x) => methods(x).join(',') === 'initialize,model/list'),
         homes.map((x) => methods(x).join(',')).join(' | '));
    } finally { await stop(srv); }
  }

  // ── criterion 2: per-home failures are named; the rest still refresh ─────
  {
    const { h, homes } = seatedHome();
    const [shared, a, b] = homes;
    setMode(a, 'silent');
    setMode(b, 'error');
    const before = { a: fs.readFileSync(path.join(a, 'models_cache.json'), 'utf8'), b: fs.readFileSync(path.join(b, 'models_cache.json'), 'utf8') };
    const srv = await startServer(h, [fakeBin]);
    try {
      const r = await post(srv.base, '/api/models/check');
      const note = codexCat(r.body).refreshNote || '';
      ok('a failing home does not stop the others: ~/.codex refreshed', cache(shared).client_version === '0.160.0');
      ok('the erroring seat is named with Codex\'s reason', /~\/\.codex-seats\/seat-b \(model\/list: not signed in\)/.test(note), note);
      ok('the seat that answered without rewriting is named, as possibly signed out',
         /~\/\.codex-seats\/seat-a \(Codex 0\.160\.0 answered but left the catalog from Codex 0\.156\.0 — is this home signed in\?\)/.test(note), note);
      ok('...and ~/.codex is not named', !/~\/\.codex[ ,(]/.test(note), note);
      ok('the failed homes\' catalogs are left as they were',
         fs.readFileSync(path.join(a, 'models_cache.json'), 'utf8') === before.a && fs.readFileSync(path.join(b, 'models_cache.json'), 'utf8') === before.b);
      ok('the panel still loads, from the caches as they are', r.status === 200 && codexCat(r.body).ok && r.body.rows.length > 0, r.text.slice(0, 200));
      ok('the note names homes, never a catalog file', !/models_cache/.test(r.text));
    } finally { await stop(srv); }
  }

  // ── criterion 2: codex not installed ─────────────────────────────────────
  {
    const { h, homes } = seatedHome();
    const before = homes.map((x) => fs.readFileSync(path.join(x, 'models_cache.json'), 'utf8'));
    const srv = await startServer(h, []);
    try {
      const r = await post(srv.base, '/api/models/check');
      const cat = codexCat(r.body);
      ok('no codex on PATH: one plain reason naming every home',
         cat.refreshNote === 'Not refreshed: ~/.codex, ~/.codex-seats/seat-a, ~/.codex-seats/seat-b (the codex CLI is not installed). Shown as last fetched.',
         cat.refreshNote);
      ok('...the panel loads from the existing caches', r.status === 200 && cat.ok && cat.count === 2, JSON.stringify(cat));
      ok('...and no catalog changed', homes.every((x, i) => fs.readFileSync(path.join(x, 'models_cache.json'), 'utf8') === before[i]));
    } finally { await stop(srv); }
  }

  // ── criterion 4: bounded per home, parallel under a cap ──────────────────
  {
    const savedPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
    try {
      const root = tmpDir('acs-refresh-hang-');
      const homes = Array.from({ length: 6 }, (_, i) => path.join(root, `h${i}`));
      for (const x of homes) { oldCatalog(x); setMode(x, 'hang'); }
      const t0 = Date.now();
      const res = await refreshCodexCatalogs(homes, { timeoutMs: 800, concurrency: 4 });
      const took = Date.now() - t0;
      ok('a home that never answers times out with a plain reason',
         res.length === 6 && res.every((x) => !x.ok && x.reason === 'the codex app-server did not answer within 800ms'), JSON.stringify(res[0]));
      ok(`six hung homes at a cap of four take two timeouts, not one or six (${took}ms)`, took >= 1500 && took < 3500, String(took));
      ok('...and each hung home was only ever sent initialize', homes.every((x) => methods(x).join(',') === 'initialize'),
         homes.map((x) => methods(x).join(',')).join(' | '));

      const mixed = ['ok', 'error', 'ok'].map((m, i) => { const x = path.join(root, `m${i}`); oldCatalog(x); setMode(x, m); return x; });
      const r2 = await refreshCodexCatalogs(mixed, { timeoutMs: 5000 });
      ok('one result per home, in order', r2.map((x) => x.ok).join(',') === 'true,false,true', JSON.stringify(r2));
      ok('a refreshed home reports the CLI version that refreshed it', r2[0].cliVersion === 'codex-cli 0.160.0', r2[0].cliVersion);
    } finally { process.env.PATH = savedPath; }
  }

  const tmpRoot = fs.realpathSync(os.tmpdir());
  ok('every HOME and codex home here was a temp dir, never the live HOME',
     temps.length > 0 && temps.every((x) => x !== realHome && x.startsWith(tmpRoot + path.sep) && !realHome.startsWith(x)), temps.join(', '));
}

try { await main(); }
catch (e) { fail++; console.log(`  FAIL crashed — ${e.stack}`); }
finally {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
