/**
 * Accounts in setup (builds/setup-screen criterion 4, S2, S3, S6):
 *
 *   S2  on a HOME with nothing but the CLIs installed, suggestions still come
 *       (from the binaries), and a manual vendor + label add always works
 *   S3  adding a suggestion registers exactly the detected home ($CODEX_HOME
 *       honoured), twice adds nothing, and registered ones show as added
 *   4   suggestions are never added without a click; an added one lands in
 *       seats.json; the Codex connect flow reaches signed in against a fake
 *       `codex login`, polled the way setup polls
 *   S6  the connect flow under concurrency (a fake codex, real children):
 *       two simultaneous starts share one child; a failed login retried
 *       starts a fresh child with a live URL; cancel then retry; two seats at
 *       once are independent; a finished login is never "already running"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { startServer } from './fixtures/roots-home.mjs';
import { fakeCli, isolatedPath, calls } from './fixtures/setup-home.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realHome = os.homedir();
const realBefore = snapshotRealHomes();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const temps = [];
const mkTemp = (tag) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `acs-accounts-${tag}-`))); temps.push(d); return d; };
const S = await import('../lib/usage/seats.js');
const registry = (H) => path.join(H, '.agent-config-studio', 'seats.json');
const seatsIn = (H) => { try { return JSON.parse(fs.readFileSync(registry(H), 'utf8')).seats; } catch { return null; } };

console.log('\nsetup: accounts');

/* ── S2 / S3, the library ─────────────────────────────────────────────── */
{
  const H = mkTemp('lib');
  ok('the real HOME is never a test HOME', H !== realHome);
  const all = { claude: true, codex: true, grok: true };
  ok('S2 a bare HOME with no CLIs suggests nothing', S.suggestSeats({ home: H, env: {}, file: registry(H) }).length === 0);
  const sg = S.suggestSeats({ home: H, env: {}, binaries: all, file: registry(H) });
  ok('S2 …with the three CLIs installed, all three are suggested, none added',
     sg.map((x) => x.key).join() === 'codex,claude,grok' && sg.every((x) => !x.added) && seatsIn(H) === null, JSON.stringify(sg));
  const own = path.join(H, 'custom-codex');
  const env = { CODEX_HOME: own };
  const c = S.suggestSeats({ home: H, env, binaries: all, file: registry(H) }).find((x) => x.key === 'codex');
  ok('S3 the codex suggestion honours $CODEX_HOME', c.home === own, c.home);
  const a1 = S.addSuggestedSeat({ key: 'codex', home: H, env, binaries: all, file: registry(H) });
  ok('S3 adding it registers exactly that home (detected home == seats.json home)', seatsIn(H)[0].home === own && a1.seat.home === own && fs.statSync(own).isDirectory(), JSON.stringify(seatsIn(H)));
  const a2 = S.addSuggestedSeat({ key: 'codex', home: H, env, binaries: all, file: registry(H) });
  ok('S3 adding it twice adds nothing', a2.already === true && seatsIn(H).length === 1);
  ok('S3 …and it now shows as added', S.suggestSeats({ home: H, env, binaries: all, file: registry(H) }).find((x) => x.key === 'codex').added === true);
  S.addSuggestedSeat({ key: 'claude', home: H, env, binaries: all, file: registry(H) });
  const again = S.addSuggestedSeat({ key: 'claude', home: H, env, binaries: all, file: registry(H) });
  ok('S3 claude: twice is still one seat', again.already && seatsIn(H).filter((s) => s.vendor === 'claude').length === 1);
  let threw = null;
  try { S.addSuggestedSeat({ key: '../../etc', home: H, env, binaries: all, file: registry(H) }); } catch (e) { threw = e.message; }
  ok('S3 a key that is not a suggestion here is refused — no path is ever taken from the caller', /not a suggestion/.test(threw || ''), threw);

  const H2 = mkTemp('split');
  fs.mkdirSync(path.join(H2, '.codex-seats', 'old'), { recursive: true });
  ok('S3 once Codex seats were split, the shared ~/.codex is not offered',
     !S.suggestSeats({ home: H2, env: {}, binaries: all, file: registry(H2) }).some((x) => x.key === 'codex'));
}

/* ── 4 + S2, through the server, on an empty HOME with only fake CLIs ─── */
const sandbox = mkTemp('srv');
const home = path.join(sandbox, 'home');
const bin = path.join(sandbox, 'bin');
fs.mkdirSync(home);
for (const c of ['claude', 'codex', 'grok']) fakeCli(bin, c, { loginMs: 400 });
const PATH = isolatedPath(bin);
{
  const srv = await startServer(home, { root: ROOT, env: { PATH } });
  ok('the server boots', srv.up, srv.log().slice(-300));
  const api = async (p, body) => {
    const r = await fetch(srv.base + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    return { status: r.status, json: await r.json() };
  };
  const sg = await api('/api/setup/accounts');
  ok('4 S2 an empty HOME with only the CLIs gets suggestions (no sessions seeded)',
     sg.status === 200 && ['codex', 'claude', 'grok'].every((k) => sg.json.suggestions.some((x) => x.key === k)), JSON.stringify(sg.json));
  ok('4 …the codex one is ~/.codex, and none is added without a click', sg.json.suggestions.find((x) => x.key === 'codex').home === '~/.codex'
     && sg.json.suggestions.every((x) => !x.added) && seatsIn(home) === null);
  const add = await api('/api/setup/seats', { key: 'codex' });
  ok('4 S3 adding it lands in seats.json with exactly the detected home',
     add.status === 200 && seatsIn(home)?.length === 1 && seatsIn(home)[0].home === path.join(home, '.codex'), JSON.stringify(add.json));
  const twice = await api('/api/setup/seats', { key: 'codex' });
  ok('S3 the same click twice adds nothing', twice.status === 200 && twice.json.already && seatsIn(home).length === 1);
  const manual = await api('/api/setup/seats', { vendor: 'grok', label: 'Grok at work' });
  ok('S2 the manual "Add an account" (vendor + label) works', manual.status === 200 && seatsIn(home).some((s) => s.vendor === 'grok' && s.label === 'Grok at work'), JSON.stringify(manual.json));
  const badVendor = await api('/api/setup/seats', { vendor: 'openai', label: 'x' });
  const badKey = await api('/api/setup/seats', { key: 7 });
  ok('S11 a bad vendor or a non-string key is a 400', badVendor.status === 400 && badKey.status === 400);
  const after = await api('/api/setup/accounts');
  ok('S3 the added suggestion now shows as added', after.json.suggestions.find((x) => x.key === 'codex').added === true);

  // The Codex sign-in from setup, polled the way the setup view polls.
  const id = seatsIn(home).find((s) => s.vendor === 'codex').id;
  const start = await api('/api/usage/connect', { id });
  ok('4 the connect flow starts and hands back the sign-in URL', start.status === 200 && /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/.test(start.json.url || ''), JSON.stringify(start.json));
  let state = null;
  for (let i = 0; i < 40; i++) {
    state = (await api('/api/usage/connect/state', { id })).json;
    if (state.signedIn && !state.running) break;
    await sleep(150);
  }
  ok('4 …and polling reaches signed in once the fake login finishes', state?.signedIn === true && state.running === false && state.url === null, JSON.stringify(state));
  const cards = await api('/api/setup/clis');
  ok('4 the CLI card then reads credentials present for codex', cards.json.clis.find((c) => c.id === 'codex').signIn.state === 'present');
  await srv.stop();
}

/* ── S6: the connect flow under concurrency, in-process ───────────────── */
{
  process.env.PATH = PATH;
  const C = await import('../lib/usage/connect.js');
  const log0 = () => (calls(bin).match(/codex login/g) || []).length;
  const seatHome = (n) => { const d = path.join(sandbox, 'seats', n); fs.mkdirSync(d, { recursive: true }); return d; };

  fakeCli(bin, 'codex', { loginMs: 1500 });
  const A = seatHome('a');
  let n0 = log0();
  const [s1, s2] = await Promise.all([C.startLogin({ seatId: 'a', home: A }), C.startLogin({ seatId: 'a', home: A })]);
  await sleep(200);
  ok('S6 two simultaneous starts share one child and one URL', log0() - n0 === 1 && s1.url && s1.url === s2.url, `${log0() - n0} children ${JSON.stringify([s1, s2])}`);
  const s3 = await C.startLogin({ seatId: 'a', home: A });
  ok('S6 a third start while it waits gets the same URL, marked already running', s3.alreadyRunning && s3.url === s1.url);
  for (let i = 0; i < 40 && C.loginState({ seatId: 'a', home: A }).running; i++) await sleep(100);
  const st = C.loginState({ seatId: 'a', home: A });
  ok('S6 once finished: signed in, not running, and no dead URL', st.signedIn && !st.running && st.url === null, JSON.stringify(st));
  n0 = log0();
  const s4 = await C.startLogin({ seatId: 'a', home: A });
  ok('S6 a finished login is never returned as already running; a new start is fresh', !s4.alreadyRunning && s4.url && log0() - n0 === 1, JSON.stringify(s4));
  C.cancelLogin({ seatId: 'a' });

  // Fail, then retry.
  const B = seatHome('b');
  fakeCli(bin, 'codex', { loginUrl: false, loginMs: 100 });
  const f1 = await C.startLogin({ seatId: 'b', home: B });
  ok('S6 a login that exits without a URL reports an error', !!f1.error && !f1.url, JSON.stringify(f1));
  fakeCli(bin, 'codex', { loginMs: 20_000 });
  n0 = log0();
  const f2 = await C.startLogin({ seatId: 'b', home: B });
  ok('S6 …and the retry starts a fresh child with a live URL', !f2.alreadyRunning && /^https:/.test(f2.url || '') && log0() - n0 === 1
     && C.loginState({ seatId: 'b', home: B }).running, JSON.stringify(f2));

  // Cancel, then retry.
  const c1 = C.cancelLogin({ seatId: 'b' });
  const afterCancel = C.loginState({ seatId: 'b', home: B });
  n0 = log0();
  const c2 = await C.startLogin({ seatId: 'b', home: B });
  ok('S6 cancel stops it (not running, no URL), and a retry starts afresh',
     c1.cancelled && !afterCancel.running && afterCancel.url === null && !c2.alreadyRunning && c2.url && log0() - n0 === 1, JSON.stringify({ afterCancel, c2 }));
  C.cancelLogin({ seatId: 'b' });

  // Two seats at once.
  const X = seatHome('x'), Y = seatHome('y');
  n0 = log0();
  const [x, y] = await Promise.all([C.startLogin({ seatId: 'x', home: X }), C.startLogin({ seatId: 'y', home: Y })]);
  ok('S6 overlapping logins for two seats are independent: two children, both live',
     x.url && y.url && log0() - n0 === 2 && C.loginState({ seatId: 'x', home: X }).running && C.loginState({ seatId: 'y', home: Y }).running);
  C.cancelLogin({ seatId: 'x' });
  ok('S6 …cancelling one leaves the other running', !C.loginState({ seatId: 'x', home: X }).running && C.loginState({ seatId: 'y', home: Y }).running);
  C.cancelLogin({ seatId: 'y' });

  // S7: no lsof — the sign-in goes ahead, and says the conflict check did not run.
  C._setProcessCheck(async () => { const e = new Error('lsof is not installed, so running Codex sessions cannot be detected'); e.unsupported = true; throw e; });
  const Z = seatHome('z');
  const z = await C.startLogin({ seatId: 'z', home: Z });
  ok('S7 lsof absent: the start still returns a URL, and its `unchecked` warning is in the response',
     /^https:/.test(z.url || '') && /lsof is not installed/.test(z.unchecked || '') && /quit any Codex session/.test(z.unchecked), JSON.stringify(z));
  ok('S7 …and in the state setup and Usage poll', /lsof is not installed/.test(C.loginState({ seatId: 'z', home: Z }).unchecked || ''));
  const z2 = await C.startLogin({ seatId: 'z', home: Z });
  ok('S7 …and on an already-running start', z2.alreadyRunning && /lsof/.test(z2.unchecked || ''));
  C.cancelLogin({ seatId: 'z' });
  C._setProcessCheck(null);
}

assertRealHomesUnchanged(realBefore, ok);
for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
