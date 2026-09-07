/**
 * The usage HTTP surface.
 *
 * HOME is redirected to a temp directory BEFORE anything is imported, so this
 * never reads or writes the real ~/.agent-config-studio, ~/.codex or ~/.claude.
 * That redirection is asserted before the first request rather than assumed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = os.homedir();
// Fingerprint the real registry BEFORE anything runs, so "we didn't touch it"
// is a comparison rather than an assumption.
const realRegistry = path.join(realHome, '.agent-config-studio', 'seats.json');
const realBefore = (() => {
  try { return { mtime: fs.statSync(realRegistry).mtimeMs, body: fs.readFileSync(realRegistry, 'utf8') }; }
  catch { return null; }
})();
const realSeatRoot = path.join(realHome, '.codex-seats');
const realSeatsBefore = (() => { try { return fs.readdirSync(realSeatRoot).sort().join(','); } catch { return null; } })();

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-routes-'));
process.env.HOME = fakeHome;
process.env.ACS_SUITE = 'offline';
delete process.env.CODEX_HOME;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\nusage/routes');
ok('HOME is redirected away from the real one', os.homedir() === fakeHome && fakeHome !== realHome, os.homedir());

// A primary codex home with one quota reading, so a real seat can be adopted.
const primary = path.join(fakeHome, '.codex', 'sessions', '2026', '09', '07');
fs.mkdirSync(primary, { recursive: true });
fs.writeFileSync(path.join(primary, 'rollout-2026-09-07T10-00-00-a.jsonl'),
  JSON.stringify({ info: { rate_limits: {
    primary: { used_percent: 44, window_minutes: 10080, resets_at: 1789047414 }, plan_type: 'prolite' } } }) + '\n');
fs.writeFileSync(path.join(fakeHome, '.codex', 'config.toml'), 'model = "x"\n');

const { createApp } = await import('../server.js');
const { server } = createApp();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const B = `http://localhost:${server.address().port}`;
const get = (p) => fetch(B + p).then(async (r) => [r.status, await r.json()]);
const post = (p, b) => fetch(B + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
}).then(async (r) => [r.status, await r.json()]);

// --- empty state -------------------------------------------------------------
{
  const [s, j] = await get('/api/usage');
  ok('GET /api/usage with no seats is 200, not an error', s === 200 && Array.isArray(j.seats) && j.seats.length === 0);
}

// --- adding ------------------------------------------------------------------
{
  const [s, j] = await post('/api/usage/seats', { vendor: 'codex', label: 'Codex (main)' });
  ok('adding a codex seat adopts the existing home', s === 200 && j.adopted === true, JSON.stringify(j));
  const [, u] = await get('/api/usage');
  ok('the new seat reports its live quota', u.seats[0]?.ok === true && u.seats[0].windows[0].usedPercent === 44,
     JSON.stringify(u.seats[0]));
}
{
  const [s, j] = await post('/api/usage/seats', { vendor: 'codex', label: 'Codex (work)' });
  ok('a second codex seat gets its own home', s === 200 && j.seat.home.includes('.codex-seats'), j.seat?.home);
  ok('it comes back with a login command to run', /codex login$/.test(j.loginCommand || ''));
  ok('the studio did not perform the login itself',
     !fs.existsSync(path.join(j.seat.home, 'auth.json')));
}

// --- rejection ---------------------------------------------------------------
{
  ok('unknown vendor is 400', (await post('/api/usage/seats', { vendor: 'evil', label: 'x' }))[0] === 400);
  ok('blank label is 400', (await post('/api/usage/seats', { vendor: 'grok', label: '  ' }))[0] === 400);
  ok('missing body fields are 400', (await post('/api/usage/seats', {}))[0] === 400);
}
{
  // The body must never choose where a directory is created.
  const [s, j] = await post('/api/usage/seats', { vendor: 'codex', label: '../../pwned', home: '/etc/pwned' });
  ok('a home supplied in the body is ignored', s === 200 && !j.seat.home.startsWith('/etc'), j.seat?.home);
  ok('a traversal label stays inside the seat root',
     j.seat.home.startsWith(path.join(fakeHome, '.codex-seats')) && !j.seat.home.includes('..'), j.seat.home);
  ok('nothing was created outside the fake home', !fs.existsSync('/etc/pwned'));
}
{
  const [s] = await post('/api/usage/seats', { vendor: '__proto__', label: 'x' });
  ok('a prototype-polluting vendor is rejected', s === 400);
  ok('Object.prototype is unpolluted', ({}).vendor === undefined && ({}).label === undefined);
}

// --- removing ----------------------------------------------------------------
{
  const [, before] = await get('/api/usage');
  const victim = before.seats.find((x) => x.label === 'Codex (work)');
  const home = (await get('/api/usage'))[1].seats.find((x) => x.seatId === victim.seatId);
  const [s] = await post('/api/usage/seats/remove', { id: victim.seatId });
  ok('removing a seat is 200', s === 200);
  const [, after] = await get('/api/usage');
  ok('the seat is gone from the reading', !after.seats.some((x) => x.seatId === victim.seatId));
  // Unregistering must never destroy a login or its history.
  const seatDir = path.join(fakeHome, '.codex-seats');
  ok('the seat home survives removal', fs.existsSync(seatDir) && fs.readdirSync(seatDir).length > 0,
     JSON.stringify(fs.existsSync(seatDir) ? fs.readdirSync(seatDir) : null));
  ok('removing an unknown id is 404', (await post('/api/usage/seats/remove', { id: 'ghost' }))[0] === 404);
}

// --- refresh -----------------------------------------------------------------
{
  const snapFile = path.join(fakeHome, '.agent-config-studio', 'usage-snapshot.json');
  fs.rmSync(snapFile, { force: true });

  const [s, j] = await post('/api/usage/refresh', {});
  ok('refresh returns a reading', s === 200 && Array.isArray(j.seats), JSON.stringify(j).slice(0, 120));
  ok('refresh keeps credential-free seats live', j.seats.find((x) => x.vendor === 'codex')?.ok === true);
  ok('no token appears in any usage response', !/Bearer|accessToken|sk-[A-Za-z0-9]/.test(JSON.stringify(j)));

  // The regression this exists for: the CLI parsed `--json` as an unknown
  // subcommand, printed help, and wrote nothing — so Refresh returned a
  // perfectly good stored reading while silently refreshing nothing. Asserting
  // the response alone cannot see that; the snapshot on disk can.
  ok('refresh actually wrote a snapshot', fs.existsSync(snapFile), snapFile);
  if (fs.existsSync(snapFile)) {
    const written = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
    ok('the written snapshot holds the seats', Array.isArray(written.seats) && written.seats.length > 0);
    const first = fs.statSync(snapFile).mtimeMs;
    await post('/api/usage/refresh', {});
    ok('a second refresh rewrites it', fs.statSync(snapFile).mtimeMs >= first);
  }
}

// --- signed in vs never connected -------------------------------------------
{
  // A seat that is logged in but has never run a turn must not be reported the
  // same as one that was never connected — that sends someone to re-run a
  // login that already worked.
  const idle = path.join(fakeHome, '.codex-seats', 'idle-seat');
  fs.mkdirSync(idle, { recursive: true });
  fs.writeFileSync(path.join(idle, 'auth.json'), '{}');
  const { readCodexUsage } = await import('../lib/usage/codex.js');
  const r = readCodexUsage({ codexHome: idle });
  ok('a signed-in seat with no turns reports signedIn', r.signedIn === true && r.ok === false);
  ok('...and says so instead of naming a missing directory',
     /no turn has run/.test(r.reason) && !/no sessions directory/.test(r.reason), r.reason);

  const bare = path.join(fakeHome, '.codex-seats', 'bare-seat');
  fs.mkdirSync(bare, { recursive: true });
  const b = readCodexUsage({ codexHome: bare });
  ok('a seat with no auth.json reports not signed in', b.signedIn === false && /not signed in/.test(b.reason), b.reason);
  ok('neither state invents a window', r.windows.length === 0 && b.windows.length === 0);
}

// --- codex sign-in ----------------------------------------------------------
{
  const { startLogin, loginState, cancelLogin, isSignedIn } = await import('../lib/usage/connect.js');

  const gone = path.join(fakeHome, 'no-such-seat');
  const r = await startLogin({ seatId: 'gone', home: gone });
  ok('a login for a missing home errors instead of spawning',
     !!r.error && /no longer exists|not installed/.test(r.error), r.error);

  const idle = path.join(fakeHome, '.codex-seats', 'signin-test');
  fs.mkdirSync(idle, { recursive: true });
  ok('a home with no auth.json is not signed in', isSignedIn(idle) === false);
  fs.writeFileSync(path.join(idle, 'auth.json'), '{"tokens":{}}');
  ok('a home with auth.json is signed in', isSignedIn(idle) === true);
  // An empty auth.json is a failed login, not a successful one.
  fs.writeFileSync(path.join(idle, 'auth.json'), '');
  ok('an empty auth.json does not count as signed in', isSignedIn(idle) === false);

  ok('state for an unknown seat is inert, not an error',
     loginState({ seatId: 'never-started', home: idle }).running === false);
  ok('cancelling a login that was never started is a no-op',
     cancelLogin({ seatId: 'never-started' }).cancelled === false);
}

// --- connect routes ---------------------------------------------------------
{
  const [s1, j1] = await post('/api/usage/connect', { id: 'does-not-exist' });
  ok('connecting an unknown seat is 404', s1 === 404, JSON.stringify(j1));

  await post('/api/usage/seats', { vendor: 'claude', label: 'Claude' });
  const claude = (await get('/api/usage'))[1].seats.find((x) => x.vendor === 'claude');
  const [s2, j2] = await post('/api/usage/connect', { id: claude.seatId });
  ok('a claude seat cannot be connected through the codex flow', s2 === 400 && /not connected this way/.test(j2.error), JSON.stringify(j2));

  const [s3] = await post('/api/usage/connect/cancel', { id: 'anything' });
  ok('cancel is safe to call for any id', s3 === 200);
}

// --- the real home was never touched ----------------------------------------
{
  const realAfter = (() => {
    try { return { mtime: fs.statSync(realRegistry).mtimeMs, body: fs.readFileSync(realRegistry, 'utf8') }; }
    catch { return null; }
  })();
  ok('the real registry is byte-identical after this run',
     JSON.stringify(realBefore) === JSON.stringify(realAfter),
     realBefore === null ? 'it did not exist before; it must still not exist' : 'it changed');
  const realSeatsAfter = (() => { try { return fs.readdirSync(realSeatRoot).sort().join(','); } catch { return null; } })();
  ok('no seat home was created in the real ~/.codex-seats', realSeatsBefore === realSeatsAfter,
     `${realSeatsBefore} -> ${realSeatsAfter}`);
  ok('every write landed under the fake home',
     fs.existsSync(path.join(fakeHome, '.agent-config-studio', 'seats.json')));
}

server.close();
fs.rmSync(fakeHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
