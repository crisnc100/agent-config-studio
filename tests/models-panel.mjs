/**
 * The Models panel: catalog detection (criterion 2), no secret in any response
 * (4), the edit round-trip (6), the alert flow (7), sidecars (8), and the
 * view's data with a malformed user file (1) — against real `node server.js`
 * children whose HOME is a temp dir seeded from tests/fixtures. The live HOME
 * is never read or written here.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MARKERS, claudeModel, codexModel, defaultCatalogs, grokModel, seedHome,
  writeClaudeCatalog, writeCodexCatalog, writeGrokCatalog,
} from './fixtures/models-home.mjs';
import { compareVersions, detect, parseVersion, readCatalogs } from '../lib/models-catalog.js';
import { withModel, withoutModel } from '../lib/models-panel.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'model-id');
const DEFAULTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.default.json'), 'utf8'));
const realHome = os.homedir();
const temps = [];
const children = [];
const serverHomes = [];

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const home = (opts) => { const h = seedHome(opts); temps.push(h); return h; };
const userFile = (h) => path.join(h, '.agent-config-studio', 'models.json');
const writeUser = (h, text) => { fs.mkdirSync(path.dirname(userFile(h)), { recursive: true }); fs.writeFileSync(userFile(h), text); };
const read = (f) => fs.readFileSync(f, 'utf8');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startServer(h) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { HOME: h, PORT: String(port), PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: os.tmpdir() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  serverHomes.push(h);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return { child, base, log: () => log }; } catch {}
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

/** Every body is kept, so criterion 4 can be checked over all of them at the end. */
const bodies = [];
async function call(base, method, route, body) {
  const r = await fetch(`${base}${route}`, {
    method, headers: body ? { 'content-type': 'application/json', origin: base } : { origin: base },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  bodies.push({ route, text });
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json, text };
}
const get = (b, r) => call(b, 'GET', r);
const post = (b, r, body = {}) => call(b, 'POST', r, body);

const row = (view, family) => view.rows.find((r) => r.family === family);
const live = (r) => r.alerts.filter((a) => !a.dismissed);
const modelId = (h, fam) => spawnSync(process.execPath, [BIN, fam], { encoding: 'utf8', env: { HOME: h, PATH: '/usr/bin:/bin' } });

const HOUR = 3600 * 1000;

/** Detection on hand-built catalogs, no server: the rules themselves. */
function detectWith({ models, claude = [], codex = [], grok = [], claudeVersion = '2.1.300', families }) {
  const registry = { version: 1, models: { ...DEFAULTS.models, ...(models || {}) }, assist: {}, families: families ?? DEFAULTS.families };
  const cat = (vendor, list) => ({ vendor, ok: true, models: list, fetchedAt: Date.now() });
  const catalogs = { claude: cat('claude', claude), codex: cat('codex', codex), grok: cat('grok', grok) };
  return detect({ registry, defaults: DEFAULTS, catalogs, claudeVersion });
}

async function main() {
  console.log('\nmodels/panel');

  // ── criterion 2: detection rules ───────────────────────────────────────
  {
    const h = home();
    const cats = readCatalogs({ home: h });
    const d = detect({ registry: { ...DEFAULTS }, defaults: DEFAULTS, catalogs: cats, claudeVersion: '2.1.300 (Claude Code)' });
    const opus = row(d, 'opus');
    ok('claude-opus-5-6 is proposed over claude-opus-5-5', opus.alerts.some((a) => a.kind === 'update' && a.candidate === 'claude-opus-5-6'), JSON.stringify(opus.alerts));
    ok('...and claude-opus-5 is not', !opus.alerts.some((a) => a.candidate === 'claude-opus-5'));
    ok('numeric compare: claude-opus-5-10 beats -5-9', compareVersions(parseVersion('claude-opus-5-10'), parseVersion('claude-opus-5-9')) > 0);
    ok('numeric compare: x-5.10 beats x-5.6', compareVersions(parseVersion('x-5.10'), parseVersion('x-5.6')) > 0);
    const tens = detectWith({ models: { opus: 'claude-opus-5-9' }, claude: [
      claudeModel('claude-opus-5-9', 'Opus 5.9', 'Opus'), claudeModel('claude-opus-5-10', 'Opus 5.10', 'Opus'),
    ].map((m) => ({ ...m, vendor: 'claude', family: 'opus', hidden: false, displayName: m.name })) });
    ok('...and detection proposes -5-10 over -5-9', row(tens, 'opus').alerts.some((a) => a.candidate === 'claude-opus-5-10'), JSON.stringify(row(tens, 'opus').alerts));

    const grok = row(d, 'grok');
    ok('grok-4.8-build-fast (suffixed) and hidden grok-4.9 are never proposed', !grok.alerts.some((a) => a.kind === 'update'), JSON.stringify(grok.alerts));
    ok('grok-prev (track:false) is never proposed, though grok-4.7 is newer', !row(d, 'grok-prev').alerts.some((a) => a.kind === 'update') && row(d, 'grok-prev').track === false);
    const sol = row(d, 'sol');
    ok('codex hidden gpt-7-sol and codex-9-sol are never proposed', !sol.alerts.some((a) => a.kind === 'update'), JSON.stringify(sol.alerts));
    const codexFam = Object.fromEntries(cats.codex.models.map((m) => [m.id, m.family]));
    ok('gpt-5.5 (numeric trailing word) has no family', codexFam['gpt-5.5'] === null);
    ok('codex-* and hidden slugs have no family', codexFam['codex-9-sol'] === null && codexFam['gpt-7-sol'] === null && codexFam['gpt-reserve'] === null);
    const latest = detectWith({ models: { sol: 'gpt-6-sol' }, codex: [
      { vendor: 'codex', id: 'gpt-6-sol', family: 'sol', hidden: false },
    ] });
    ok('(control) a pinned id present in its catalog raises nothing', live(row(latest, 'sol')).length === 0);
    {
      const h2 = home();
      writeCodexCatalog(path.join(h2, '.codex'), [codexModel('gpt-6-sol', 'Sol'), codexModel('gpt-9-sol-latest', 'Latest'), codexModel('gpt-9-sol', 'Nine', 'hide')], Date.now());
      const c2 = readCatalogs({ home: h2 });
      ok('a -latest slug has no family', c2.codex.models.find((m) => m.id === 'gpt-9-sol-latest').family === null);
    }
    const unparse = detectWith({ models: { opus: 'claude-opus-next' }, claude: [
      { vendor: 'claude', id: 'claude-opus-next', family: 'opus', hidden: false },
      { vendor: 'claude', id: 'claude-opus-9', family: 'opus', hidden: false },
    ] });
    ok('an unparseable current id is never proposed an update', !row(unparse, 'opus').alerts.some((a) => a.kind === 'update'));
    const unparseCand = detectWith({ claude: [
      { vendor: 'claude', id: 'claude-opus-5-5', family: 'opus', hidden: false },
      { vendor: 'claude', id: 'claude-opus-6o', family: 'opus', hidden: false },
    ] });
    ok('an unparseable candidate is never proposed', !row(unparseCand, 'opus').alerts.some((a) => a.kind === 'update'));
    const sonnet = row(d, 'sonnet').alerts.find((a) => a.kind === 'update');
    ok('a Claude candidate above the installed CLI is shown as not acceptable', sonnet && sonnet.candidate === 'claude-sonnet-5-1' && sonnet.acceptable === false && /9\.0\.0/.test(sonnet.reason), JSON.stringify(sonnet));
    ok('...and one within it is acceptable', opus.alerts.find((a) => a.kind === 'update').acceptable === true);
    const terra = row(d, 'terra').alerts.find((a) => a.kind === 'retiring');
    ok('a Codex upgrade/retirement_at on a pinned id raises Retiring with date and suggestion', terra && terra.date === '2026-12-01T19:00:00Z' && terra.candidate === 'gpt-6-sol' && /retiring/.test(terra.message), JSON.stringify(terra));
    ok('a pinned id missing from its catalog raises Vanished', row(d, 'haiku').alerts.some((a) => a.kind === 'vanished'));

    const dated = detectWith({ claude: [
      { vendor: 'claude', id: 'claude-opus-5-5', family: 'opus', hidden: false },
      { vendor: 'claude', id: 'claude-opus-5-5-20260101', family: 'opus', hidden: false },
    ] });
    ok('a dated snapshot (…-20260101) is never proposed over the undated id', !row(dated, 'opus').alerts.some((a) => a.kind === 'update'), JSON.stringify(row(dated, 'opus').alerts));
    const datedBoth = detectWith({ claude: [
      { vendor: 'claude', id: 'claude-haiku-4-5-20251001', family: 'haiku', hidden: false },
      { vendor: 'claude', id: 'claude-haiku-4-5-20260101', family: 'haiku', hidden: false },
      { vendor: 'claude', id: 'claude-opus-5-5', family: 'opus', hidden: false },
      { vendor: 'claude', id: 'claude-opus-5-6', family: 'opus', hidden: false },
    ] });
    ok('...a newer date over a dated current id still is', row(datedBoth, 'haiku').alerts.some((a) => a.candidate === 'claude-haiku-4-5-20260101'));
    ok('...and an undated newer release still is', row(datedBoth, 'opus').alerts.some((a) => a.candidate === 'claude-opus-5-6'));
    {
      const hv = home();
      const noVis = codexModel('gpt-6-astra', 'GPT-6-Astra');
      delete noVis.visibility;
      const noVisNew = codexModel('gpt-7-astra', 'GPT-7-Astra');
      delete noVisNew.visibility;
      writeCodexCatalog(path.join(hv, '.codex'), [noVis, noVisNew], Date.now());
      const cv = readCatalogs({ home: hv });
      ok('a Codex entry with no visibility field is listed, not hidden', cv.codex.models.every((m) => m.hidden === false && m.family === 'astra'));
      ok('...so it can be proposed', row(detect({ registry: DEFAULTS, defaults: DEFAULTS, catalogs: cv }), 'astra').alerts.some((a) => a.candidate === 'gpt-7-astra'));
    }

    // Two Claude catalogs → newest fetchedAt wins, whichever sorts first.
    const h3 = home();
    fs.rmSync(path.join(h3, '.claude', 'cache', 'model-catalog'), { recursive: true });
    writeClaudeCatalog(h3, [claudeModel('claude-opus-5-5', 'Opus 5.5', 'Opus'), claudeModel('claude-opus-5-7', 'Opus 5.7', 'Opus')], Date.now() - HOUR, 'aaaa-cc.json');
    writeClaudeCatalog(h3, [claudeModel('claude-opus-5-5', 'Opus 5.5', 'Opus')], Date.now() - 3 * HOUR, 'zzzz-cc.json');
    ok('two Claude catalogs → the newer fetchedAt wins', readCatalogs({ home: h3 }).claude.models.some((m) => m.id === 'claude-opus-5-7'));
    writeClaudeCatalog(h3, [claudeModel('claude-opus-5-5', 'Opus 5.5', 'Opus')], Date.now() - 3 * HOUR, 'aaaa-cc.json');
    writeClaudeCatalog(h3, [claudeModel('claude-opus-5-5', 'Opus 5.5', 'Opus'), claudeModel('claude-opus-5-8', 'Opus 5.8', 'Opus')], Date.now() - HOUR, 'zzzz-cc.json');
    ok('...by fetchedAt, not by filename', readCatalogs({ home: h3 }).claude.models.some((m) => m.id === 'claude-opus-5-8'));

    // Codex: the UNION of ~/.codex and every seat home.
    const seat = path.join(h3, '.codex-seats', 'second');
    writeCodexCatalog(path.join(h3, '.codex'), [codexModel('gpt-6-sol', 'Sol')], Date.now() - 5 * HOUR);
    writeCodexCatalog(seat, [codexModel('gpt-6-sol', 'Sol'), codexModel('gpt-6-luna', 'Luna')], Date.now() - HOUR);
    ok('a seat-home Codex cache is read beside ~/.codex', readCatalogs({ home: h3, codexHomes: [seat] }).codex.models.some((m) => m.id === 'gpt-6-luna'));
    ok('...and ~/.codex alone is read without seats', !readCatalogs({ home: h3 }).codex.models.some((m) => m.id === 'gpt-6-luna'));

    // Catalog A (an older client, fetched last) lacks gpt-6-sol; catalog B lists it.
    const now = Date.now();
    writeCodexCatalog(path.join(h3, '.codex'), [
      codexModel('gpt-6-astra', 'Astra (old client)'), codexModel('gpt-5.6-sol', 'Sol 5.6 (old client)'), codexModel('gpt-5.6-terra', 'Terra'),
    ], now - 60 * 1000, '0.155.0');
    writeCodexCatalog(seat, [
      codexModel('gpt-6-astra', 'GPT-6-Astra'), codexModel('gpt-6-sol', 'GPT-6-Sol'), codexModel('gpt-5.6-sol', 'GPT-5.6-Sol'), codexModel('gpt-5.6-terra', 'Terra'),
    ], now - 2 * HOUR, '0.156.0');
    const u = readCatalogs({ home: h3, codexHomes: [seat] });
    const du = detect({ registry: DEFAULTS, defaults: DEFAULTS, catalogs: u });
    ok('union: an id listed by any catalog is offered — gpt-6-sol raises no Vanished', !row(du, 'sol').alerts.length, JSON.stringify(row(du, 'sol').alerts));
    ok('...and no false candidate for sol or astra', !row(du, 'sol').alerts.some((a) => a.kind === 'update') && !row(du, 'astra').alerts.length);
    ok('...per-id metadata comes from the highest client_version', u.codex.models.find((m) => m.id === 'gpt-6-astra').displayName === 'GPT-6-Astra');
    ok('...catalog age is the newest fetched_at', Math.abs(u.codex.fetchedAt - (now - 60 * 1000)) < 1000);
    ok('...the disagreement is noted, naming the home and client, not the file',
       /~\/\.codex's comes from Codex 0\.155\.0 and lacks 1 of the 4/.test(u.codex.disagree || '') && !/models_cache/.test(u.codex.disagree), u.codex.disagree);
    ok('...and the note is not a failure: the catalog is ok and not stale', u.codex.ok && !u.codex.stale && u.codex.note === null);
    ok('...a Vanished still fires when every catalog lacks the id', row(detect({
      registry: { ...DEFAULTS, models: { ...DEFAULTS.models, sol: 'gpt-6-nope-sol' } }, defaults: DEFAULTS, catalogs: u,
    }), 'sol').alerts.some((a) => a.kind === 'vanished'));
    ok('agreeing catalogs raise no disagreement note', readCatalogs({ home: h3 }).codex.disagree === null);

    // Missing and stale.
    const h4 = home();
    fs.rmSync(path.join(h4, '.grok', 'models_cache.json'));
    writeCodexCatalog(path.join(h4, '.codex'), [codexModel('gpt-6-sol', 'Sol')], Date.now() - 9 * 24 * HOUR);
    const c4 = readCatalogs({ home: h4 });
    ok('a missing catalog gives a per-vendor note', !c4.grok.ok && /No Grok catalog/.test(c4.grok.note) && /run `grok` once/.test(c4.grok.note), c4.grok.note);
    ok('a stale catalog gives a stale note', c4.codex.ok && c4.codex.stale && /9 days old/.test(c4.codex.note) && /run `codex` once/.test(c4.codex.note), c4.codex.note);
    ok('...and a fresh one gives none', c4.claude.ok && c4.claude.note === null);
    const d4 = detect({ registry: DEFAULTS, defaults: DEFAULTS, catalogs: c4 });
    ok('a missing catalog raises no Vanished for its families', !row(d4, 'grok').alerts.length);
    // Grok age comes from renewed_at, falling back to fetched_at.
    writeGrokCatalog(h4, [grokModel('grok-4.7', 'Grok 4.7')], Date.now() - 20 * 24 * HOUR, Date.now() - HOUR);
    ok('grok age is renewed_at, not fetched_at', !readCatalogs({ home: h4 }).grok.stale);
    writeGrokCatalog(h4, [grokModel('grok-4.7', 'Grok 4.7')], Date.now() - 20 * 24 * HOUR, null);
    ok('...falling back to fetched_at', readCatalogs({ home: h4 }).grok.stale);
    fs.writeFileSync(path.join(h4, '.grok', 'models_cache.json'), `{"x": "${MARKERS.identity}"`);
    const broken = readCatalogs({ home: h4 }).grok;
    ok('a broken catalog is a note, and the note quotes none of its contents', !broken.ok && /could not be read/.test(broken.note) && !broken.note.includes('MARKER'), broken.note);
  }

  // ── positional edits of the user file ─────────────────────────────────
  {
    const src = '{\n  "models": {\n    "sol": "gpt-6-sol"\n  },\n  "assist": {"claude":{"default":"opus"}}\n}\n';
    const a = withModel(src, 'opus', 'claude-opus-5-6');
    ok('withModel adds exactly one member', a === '{\n  "models": {\n    "sol": "gpt-6-sol",\n    "opus": "claude-opus-5-6"\n  },\n  "assist": {"claude":{"default":"opus"}}\n}\n', JSON.stringify(a));
    ok('withoutModel removes exactly that member', withoutModel(a, 'opus') === src, JSON.stringify(withoutModel(a, 'opus')));
    ok('withModel on a file with no models key keeps everything else', JSON.parse(withModel('{"assist": {}}', 'opus', 'x-1')).models.opus === 'x-1' &&
       withModel('{"assist": {}}', 'opus', 'x-1').startsWith('{"assist": {}'));
    ok('withModel with no file writes a fresh one', JSON.parse(withModel(null, 'opus', 'x-1')).models.opus === 'x-1');
  }

  // ── server: criteria 1, 4, 6, 7, 8 ─────────────────────────────────────
  const h = home();
  const assistUser = '{\n  "models": {\n    "astra": "gpt-6-astra"\n  },\n  "assist": {\n    "claude": { "default": "opus" }\n  }\n}\n';
  writeUser(h, assistUser);
  let srv = await startServer(h);
  try {
    const v = await get(srv.base, '/api/models');
    ok('GET /api/models → 200 with every family', v.status === 200 && Object.keys(DEFAULTS.models).every((f) => row(v.body, f)), v.text.slice(0, 200));
    ok('...each with id, source and alerts', v.body.rows.every((r) => typeof r.id === 'string' && ['default', 'override'].includes(r.source) && Array.isArray(r.alerts)));
    ok('...astra reads as your override, opus as the default', row(v.body, 'astra').source === 'override' && row(v.body, 'opus').source === 'default');
    ok('...pending counts every live alert (opus, sonnet, terra, haiku)', v.body.pending === 4, String(v.body.pending));
    const boot = await get(srv.base, '/api/registry');
    ok('the boot payload carries the alert count', boot.body.modelAlerts === 4, String(boot.body.modelAlerts));

    // where-used: anchored to `model-id <family>`.
    const w = await get(srv.base, '/api/models/where?family=opus');
    ok('where-used finds `model-id opus` as file:line', w.body.hits.length === 1 && w.body.hits[0].line === 4 && /SKILL\.md$/.test(w.body.hits[0].file), JSON.stringify(w.body));
    ok('...in the fixture HOME: the server read the seeded skill, not a live one', w.body.hits[0]?.text.includes('fixture-review-skill'), JSON.stringify(w.body.hits[0]));
    const wg = await get(srv.base, '/api/models/where?family=grok');
    ok('...`model-id grok-prev` is not a use of grok', wg.body.hits.length === 0, JSON.stringify(wg.body));
    ok('...an unknown family is a 400', (await get(srv.base, '/api/models/where?family=..%2Fx')).status === 400);

    // Bad ids: 400 and file unchanged.
    for (const bad of ['--x', 'a b', 'a'.repeat(65)]) {
      const r = await post(srv.base, '/api/models/set', { family: 'opus', id: bad });
      ok(`bad id ${JSON.stringify(bad.length > 10 ? `${bad.slice(0, 6)}…(${bad.length})` : bad)} → 400, file unchanged`, r.status === 400 && read(userFile(h)) === assistUser, `${r.status} ${r.text}`);
    }
    ok('an unknown family → 400', (await post(srv.base, '/api/models/set', { family: 'opsu', id: 'claude-opus-5-6' })).status === 400);
    const cross = await post(srv.base, '/api/models/set', { family: 'opus', id: 'gpt-6-sol' });
    ok('a vendor-prefix change needs confirm, and nothing is written', cross.body.needsConfirm === true && /Claude to Codex/.test(cross.body.warnings.join(' ')) && read(userFile(h)) === assistUser, cross.text);
    const absent = await post(srv.base, '/api/models/set', { family: 'opus', id: 'claude-opus-9-9' });
    ok('an id absent from the catalog needs confirm, and nothing is written', absent.body.needsConfirm === true && /not in the Claude catalog/.test(absent.body.warnings.join(' ')) && read(userFile(h)) === assistUser, absent.text);
    const cross2 = await post(srv.base, '/api/models/set', { family: 'opus', id: 'gpt-6-sol', confirm: true });
    ok('...confirmed, it saves', cross2.body.saved === true && JSON.parse(read(userFile(h))).models.opus === 'gpt-6-sol', cross2.text);
    await post(srv.base, '/api/models/reset', { family: 'opus' });
    ok('...and reset puts the file back byte-for-byte', read(userFile(h)) === assistUser, read(userFile(h)));

    // The edit round-trip.
    const settingsBefore = read(path.join(h, '.claude', 'settings.json'));
    const edit = await post(srv.base, '/api/models/set', { family: 'opus', id: 'claude-opus-5-6' });
    const after = read(userFile(h));
    ok('editing opus saves', edit.status === 200 && edit.body.saved === true, edit.text);
    ok('...writing only models.opus', JSON.stringify(Object.keys(JSON.parse(after).models)) === '["astra","opus"]' && JSON.parse(after).models.opus === 'claude-opus-5-6', after);
    ok('...the assist override and the other family\'s override are byte-identical',
       after.includes('"assist": {\n    "claude": { "default": "opus" }\n  }') && after.includes('"astra": "gpt-6-astra"') &&
       after.replace(',\n    "opus": "claude-opus-5-6"', '') === assistUser, JSON.stringify(after));
    ok('...model-id opus now resolves to it', modelId(h, 'opus').stdout.trim() === 'claude-opus-5-6', modelId(h, 'opus').stderr);
    const picker = await get(srv.base, '/api/harnesses');
    const claude = picker.body.harnesses.find((x) => x.id === 'claude');
    ok('...the running server\'s Assist picker changed', claude?.models.some((m) => m.id === 'claude-opus-5-6') && !claude.models.some((m) => m.id === 'claude-opus-5-5'), JSON.stringify(claude?.models));
    ok('...history recorded it', typeof edit.body.sha === 'string' && /^[0-9a-f]{40}$/.test(edit.body.sha) && !edit.body.historyError, JSON.stringify(edit.body));
    const log = spawnSync('git', ['-C', path.join(h, '.agent-config-studio', 'history'), 'log', '--format=%s', '--', 'home/.agent-config-studio/models.json'], { encoding: 'utf8' }).stdout;
    ok('...as a commit on the mirrored models.json', /models: opus claude-opus-5-5 → claude-opus-5-6/.test(log), log);
    ok('...the opus update alert is gone now it is current', !row((await get(srv.base, '/api/models')).body, 'opus').alerts.some((a) => a.kind === 'update'));

    // Sidecars (criterion 8), proposed from the single edit.
    const sc = edit.body.sidecars || [];
    const ms = sc.find((s) => s.kind === 'modelSettings');
    const top = sc.find((s) => s.kind === 'settingsModel');
    ok('the strip proposes copying modelSettings', !!ms && ms.from === 'claude-opus-5-5' && ms.to === 'claude-opus-5-6' && ms.file === '~/.claude/settings.json', JSON.stringify(sc));
    ok('...and the top-level "model" separately', !!top);
    ok('...and nothing for config.toml (no codex id changed)', !sc.some((s) => s.kind === 'codexModel'));
    ok('the edit itself left settings.json untouched', read(path.join(h, '.claude', 'settings.json')) === settingsBefore);
    const acc = await post(srv.base, '/api/models/sidecar', ms);
    const settingsAfter = read(path.join(h, '.claude', 'settings.json'));
    const expected = settingsBefore.replace('"claude-opus-5-5": { "effortLevel": "medium" },',
      '"claude-opus-5-5": { "effortLevel": "medium" },\n    "claude-opus-5-6": { "effortLevel": "medium" },');
    ok('Accept copies only that key\'s region — every other byte identical', acc.body?.saved && settingsAfter === expected, JSON.stringify(settingsAfter));
    ok('...the top-level "model": "<old>" is untouched', JSON.parse(settingsAfter).model === 'claude-opus-5-5');
    ok('...the old key stays (Copy)', JSON.parse(settingsAfter).modelSettings['claude-opus-5-5'].effortLevel === 'medium');
    const stale = await post(srv.base, '/api/models/sidecar', top);
    ok('a second proposal on the same file with the old mtime → conflict', stale.status === 409, stale.text);
    const topOk = await post(srv.base, '/api/models/sidecar', { ...top, mtime: acc.body.mtime });
    ok('...accepted separately (with the new mtime), it changes only "model"', topOk.body?.saved &&
       read(path.join(h, '.claude', 'settings.json')) === expected.replace('"model": "claude-opus-5-5"', '"model": "claude-opus-5-6"'), topOk.text);
    ok('...history recorded the sidecar', /^[0-9a-f]{40}$/.test(topOk.body?.sha || ''));
    ok('a sidecar edit toward a non-registry id is refused', (await post(srv.base, '/api/models/sidecar', { ...top, to: 'claude-opus-9-9', mtime: Date.now() })).status === 400);

    const tomlFile = path.join(h, '.codex', 'config.toml');
    const tomlBefore = read(tomlFile);
    const solEdit = await post(srv.base, '/api/models/set', { family: 'sol', id: 'gpt-5.6-sol' });
    const tm = (solEdit.body.sidecars || []).find((s) => s.kind === 'codexModel');
    ok('a sol change proposes the config.toml top-level model line', !!tm, solEdit.text);
    fs.appendFileSync(tomlFile, '# edited outside the studio\n');
    const conflict = await post(srv.base, '/api/models/sidecar', tm);
    ok('an external edit between proposal and Accept → 409, file unchanged', conflict.status === 409 && read(tomlFile) === `${tomlBefore}# edited outside the studio\n`, conflict.text);
    fs.writeFileSync(tomlFile, tomlBefore);
    const tm2 = { ...tm, mtime: fs.statSync(tomlFile).mtimeMs };
    const tAcc = await post(srv.base, '/api/models/sidecar', tm2);
    ok('config.toml changes only its top-level model = line', tAcc.body?.saved &&
       read(tomlFile) === tomlBefore.replace(/^model = "gpt-6-sol"/, 'model = "gpt-5.6-sol"'), JSON.stringify(read(tomlFile)));
    ok('...the [profiles.review] model line is untouched', read(tomlFile).includes('[profiles.review]\nmodel = "gpt-6-sol"'));
    await post(srv.base, '/api/models/reset', { family: 'sol' });

    // A multi-line array whose continuation lines start with `[` is not a table header.
    const tomlArray = 'notify = [\n  ["say", "done"],\n  [ "beep" ]\n]\nmodel = "gpt-6-sol"\n\n[profiles.review]\nmodel = "gpt-6-sol"\n';
    fs.writeFileSync(tomlFile, tomlArray);
    const solArr = await post(srv.base, '/api/models/set', { family: 'sol', id: 'gpt-5.6-sol' });
    const ta = (solArr.body.sidecars || []).find((x) => x.kind === 'codexModel');
    ok('a top-level model after a multi-line array of arrays is still found', !!ta, solArr.text);
    const taAcc = ta ? await post(srv.base, '/api/models/sidecar', ta) : { body: null };
    ok('...and only that line changes', taAcc.body?.saved && read(tomlFile) === tomlArray.replace('\nmodel = "gpt-6-sol"\n\n', '\nmodel = "gpt-5.6-sol"\n\n'), JSON.stringify(read(tomlFile)));
    fs.writeFileSync(tomlFile, 'x = 1\n[profiles.review]\nmodel = "gpt-5.6-sol"\n');
    ok('...while a model = line under a real table header is never proposed',
       !(await post(srv.base, '/api/models/reset', { family: 'sol' })).body.sidecars?.some((x) => x.kind === 'codexModel'));

    // Reset removes only that key.
    const reset = await post(srv.base, '/api/models/reset', { family: 'opus' });
    ok('Reset removes only models.opus', reset.body.saved && read(userFile(h)) === assistUser, read(userFile(h)));
    ok('...model-id opus is back to the default', modelId(h, 'opus').stdout.trim() === DEFAULTS.models.opus);

    // Alert flow (criterion 7): Accept writes exactly what a manual edit writes.
    const manual = read(userFile(h));
    const handEdit = await post(srv.base, '/api/models/set', { family: 'opus', id: 'claude-opus-5-6' });
    const byHand = read(userFile(h));
    await post(srv.base, '/api/models/reset', { family: 'opus' });
    ok('(reset between) back to the start', read(userFile(h)) === manual);
    const v2 = (await get(srv.base, '/api/models')).body;
    const upd = row(v2, 'opus').alerts.find((a) => a.kind === 'update');
    const accepted = await post(srv.base, '/api/models/accept', { family: 'opus', key: upd.key });
    ok('Accepting the update writes exactly what the manual edit wrote', accepted.body.saved && read(userFile(h)) === byHand, read(userFile(h)));
    const kinds = (r) => JSON.stringify((r.body.sidecars || []).map((x) => [x.kind, x.from, x.to]));
    ok('...and proposes the same sidecars', kinds(accepted) === kinds(handEdit), `${kinds(accepted)} vs ${kinds(handEdit)}`);
    await post(srv.base, '/api/models/reset', { family: 'opus' });
    const notOk = row((await get(srv.base, '/api/models')).body, 'sonnet').alerts.find((a) => a.kind === 'update');
    const refused = await post(srv.base, '/api/models/accept', { family: 'sonnet', key: notOk.key });
    ok('a candidate needing a newer Claude Code cannot be accepted', refused.status === 409 && /Claude Code/.test(refused.text) && !JSON.parse(read(userFile(h))).models.sonnet, refused.text);
    ok('accepting an alert that does not exist → 409', (await post(srv.base, '/api/models/accept', { family: 'opus', key: 'update:claude-opus-7' })).status === 409);

    // Dismiss.
    const dis = await post(srv.base, '/api/models/dismiss', { family: 'opus', key: upd.key });
    ok('Dismiss hides the alert', dis.status === 200 && !live(row((await get(srv.base, '/api/models')).body, 'opus')).length, dis.text);
    ok('...and the count drops', (await get(srv.base, '/api/models')).body.pending === 3);
    ok('...stored in ~/.agent-config-studio/models-dismissed.json', JSON.parse(read(path.join(h, '.agent-config-studio', 'models-dismissed.json'))).families.opus.keys.includes('update:claude-opus-5-6'));
  } finally { await stop(srv); }

  // Restart: dismissal survives, the badge count is in the boot payload with nothing clicked.
  srv = await startServer(h);
  try {
    const boot = await get(srv.base, '/api/registry');
    ok('after a restart the count is in the boot payload, nothing clicked', boot.body.modelAlerts === 3, String(boot.body.modelAlerts));
    ok('...and the dismissal survived', !live(row((await get(srv.base, '/api/models')).body, 'opus')).length);
    // A different, newer candidate un-hides.
    const c = defaultCatalogs();
    c.claude.push(claudeModel('claude-opus-5-7', 'Opus 5.7', 'Opus', '2.1.280'));
    writeClaudeCatalog(h, c.claude, Date.now());
    const stillOld = row((await get(srv.base, '/api/models')).body, 'opus');
    ok('catalogs are re-read only on Check now, not per request', !stillOld.alerts.some((a) => a.candidate === 'claude-opus-5-7'));
    const checked = await post(srv.base, '/api/models/check');
    const opus = row(checked.body, 'opus');
    ok('Check now re-reads: a different newer candidate un-hides', live(opus).some((a) => a.candidate === 'claude-opus-5-7'), JSON.stringify(opus.alerts));
  } finally { await stop(srv); }

  // ── criterion 1: a malformed user file ──────────────────────────────────
  {
    const hb = home();
    const broken = '{ "models": { "opus": "claude-opus-5-6", }';
    writeUser(hb, broken);
    const s = await startServer(hb);
    try {
      const v = await get(s.base, '/api/models');
      ok('malformed user file: /api/models is 200 with registryError', v.status === 200 && /not valid JSON/.test(v.body.registryError || ''), v.text.slice(0, 200));
      ok('...the defaults are served', row(v.body, 'opus').id === DEFAULTS.models.opus && v.body.rows.every((r) => r.source === 'default'));
      const e1 = await post(s.base, '/api/models/set', { family: 'opus', id: 'claude-opus-5-6', confirm: true });
      const e2 = await post(s.base, '/api/models/reset', { family: 'opus' });
      const upd = row(v.body, 'opus').alerts.find((a) => a.kind === 'update');
      const e3 = await post(s.base, '/api/models/accept', { family: 'opus', key: upd?.key });
      ok('...edits, resets and accepts are refused with the error', [e1, e2, e3].every((r) => r.status === 409 && /invalid/.test(r.body.error)), [e1, e2, e3].map((r) => r.text).join(' | '));
      ok('...and the user file is never overwritten', read(userFile(hb)) === broken);
      ok('...the server stays up', (await get(s.base, '/api/health')).status === 200 && s.child.exitCode === null);
    } finally { await stop(s); }
  }

  // ── same-origin gate on the new POST routes ──────────────────────────────
  {
    const hc = home();
    const s = await startServer(hc);
    try {
      const r = await fetch(`${s.base}/api/models/set`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
        body: JSON.stringify({ family: 'opus', id: 'claude-opus-5-6', confirm: true }),
      });
      ok('a cross-origin POST to /api/models/set → 403, nothing written', r.status === 403 && !fs.existsSync(userFile(hc)));
    } finally { await stop(s); }
  }

  // ── criterion 4: nothing sensitive in any response ──────────────────────
  {
    const leaks = bodies.filter((b) => b.text.includes('MARKER') || /model-catalog|models_cache\.json|-cc\.json/.test(b.text));
    ok(`no marker and no catalog path in any of ${bodies.length} response bodies`, bodies.length > 40 && leaks.length === 0,
       leaks.slice(0, 3).map((l) => `${l.route}: ${l.text.slice(0, 120)}`).join(' | '));
    const planted = Object.values(MARKERS);
    ok('...the fixtures really did plant every marker', planted.every((m) => temps.some((t) => {
      const files = [];
      const walk = (d) => { for (const n of fs.readdirSync(d)) { const a = path.join(d, n); const st = fs.lstatSync(a); if (st.isDirectory()) { if (n !== 'history') walk(a); } else files.push(a); } };
      walk(t);
      return files.some((f) => f.includes(m) || (fs.statSync(f).size < 2e6 && read(f).includes(m)));
    })));
  }

  const tmpRoot = fs.realpathSync(os.tmpdir());
  ok(`all ${serverHomes.length} server HOMEs were fresh temp dirs, never the live HOME`,
     serverHomes.length >= 4 && serverHomes.every((x) => x !== realHome && x.startsWith(tmpRoot + path.sep) && !realHome.startsWith(x)),
     serverHomes.join(', '));
}

try { await main(); }
catch (e) { fail++; console.log(`  FAIL crashed — ${e.stack}`); }
finally {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
