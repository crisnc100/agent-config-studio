/**
 * The setup screen's CLI cards (builds/setup-screen criterion 2, S9, S10),
 * through a real `node server.js` on a temp HOME whose PATH holds only fake
 * claude, codex and grok scripts:
 *
 *   - each card shows installed and the version the fake printed;
 *   - a CLI removed from PATH shows not installed, with commands.md's install
 *     command; Recheck finds one installed into a directory the server's own
 *     PATH lacks;
 *   - codex/grok sign-in is "credentials present" for a non-empty auth.json
 *     and "not signed in" for an empty one — by stat alone: an unreadable
 *     credential file reads the same;
 *   - Claude's state follows the stored usage snapshot: verified when fresh,
 *     "unknown — refresh" when older than 10 minutes, rejected, network
 *     failure, rate limited;
 *   - three slow --version probes leave /api/health responsive, and the route
 *     answers within 4 s.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { startServer } from './fixtures/roots-home.mjs';
import { fakeCli, isolatedPath } from './fixtures/setup-home.mjs';
import { readCommands } from '../lib/setup-commands.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realHome = os.homedir();
const realBefore = snapshotRealHomes();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const table = readCommands();

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-setup-clis-')));
const home = path.join(sandbox, 'home');
const bin = path.join(sandbox, 'bin');
fs.mkdirSync(home);
for (const c of ['claude', 'codex', 'grok']) fakeCli(bin, c, { version: `${c} 1.2.3 (fake)` });
const PATH = isolatedPath(bin);
const studio = path.join(home, '.agent-config-studio');

console.log('\nsetup: CLI cards');
ok('the real HOME is never the test HOME', home !== realHome);
const srv = await startServer(home, { root: ROOT, env: { PATH } });
ok('the server boots', srv.up, srv.log().slice(-400));
const clis = async (q = '') => {
  const r = await fetch(`${srv.base}/api/setup/clis${q}`);
  const j = await r.json();
  return { status: r.status, json: j, by: Object.fromEntries((j.clis || []).map((c) => [c.id, c])) };
};

{
  const { status, by } = await clis();
  ok('2 every card shows installed with its version', status === 200
     && ['claude', 'codex', 'grok'].every((c) => by[c]?.installed && by[c].version === `${c} 1.2.3 (fake)`), JSON.stringify(by));
  ok('2 …and where it was found, in display form', by.codex.binary === path.join(bin, 'codex'), by.codex.binary);
  ok('2 codex with no auth.json is "not signed in", and offers commands.md\'s sign-in',
     by.codex.signIn.state === 'none' && by.codex.signIn.label === 'not signed in' && by.codex.fix.signIn === table['signin.codex'].command, JSON.stringify(by.codex));
  ok('2 claude with no seat and no snapshot is unknown, and says how to check',
     by.claude.signIn.state === 'unknown' && /Accounts/.test(by.claude.signIn.detail), JSON.stringify(by.claude.signIn));
}

{
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"tokens":"x"}');
  fs.writeFileSync(path.join(home, '.grok', 'auth.json'), '{"k":"x"}');
  let { by } = await clis();
  ok('2 S9 a non-empty codex auth.json reads "credentials present" — never "signed in"',
     by.codex.signIn.state === 'present' && by.codex.signIn.label === 'credentials present' && !by.codex.fix.signIn, JSON.stringify(by.codex.signIn));
  ok('S9 …grok the same', by.grok.signIn.state === 'present', JSON.stringify(by.grok.signIn));
  fs.chmodSync(path.join(home, '.codex', 'auth.json'), 0o000);
  ({ by } = await clis());
  ok('2 the credential is stat-ed, never opened: an unreadable auth.json still reads present',
     by.codex.signIn.state === 'present', JSON.stringify(by.codex.signIn));
  fs.chmodSync(path.join(home, '.codex', 'auth.json'), 0o600);
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '');
  ({ by } = await clis());
  ok('2 an empty codex auth.json reads "not signed in"', by.codex.signIn.state === 'none', JSON.stringify(by.codex.signIn));
}

{
  fs.mkdirSync(studio, { recursive: true });
  fs.writeFileSync(path.join(studio, 'seats.json'), JSON.stringify({ version: 1, seats: [{ id: 'claude', vendor: 'claude', label: 'Claude' }] }));
  const snap = (takenAt, entry) => fs.writeFileSync(path.join(studio, 'usage-snapshot.json'),
    JSON.stringify({ takenAt, seats: [{ seatId: 'claude', vendor: 'claude', label: 'Claude', windows: [], ...entry }] }));
  const now = Date.now();
  const cases = [
    ['a fresh good reading → verified', now - 60_000, { ok: true }, (s) => s.state === 'verified' && s.label === 'verified'],
    ['a good reading older than 10 min → "unknown — refresh"', now - 11 * 60_000, { ok: true }, (s) => s.state === 'unknown' && s.label === 'unknown — refresh'],
    ['a rejected credential → rejected', now - 60_000, { ok: false, reason: 'credential rejected (HTTP 401) — run `claude` once to refresh it' }, (s) => s.state === 'rejected'],
    ['a network failure → unknown, with the reason', now - 60_000, { ok: false, reason: 'usage request failed: fetch failed' }, (s) => s.state === 'unknown' && /fetch failed/.test(s.detail)],
    ['rate limited → verified (the credential was accepted), said so', now - 60_000, { ok: false, rateLimited: true, reason: 'the usage endpoint is rate limiting us' }, (s) => s.state === 'verified' && /rate limit/.test(s.detail)],
    ['no usable credential → not signed in', now - 60_000, { ok: false, reason: 'no usable Claude credential (fromEnv: none)' }, (s) => s.state === 'none'],
  ];
  for (const [what, takenAt, entry, check] of cases) {
    snap(takenAt, entry);
    const { by } = await clis();
    ok(`2 S9 claude follows the stored snapshot: ${what}`, check(by.claude.signIn), JSON.stringify(by.claude.signIn));
  }
  const { by } = await clis();
  ok('2 claude not verified offers commands.md\'s sign-in', by.claude.fix.signIn === table['signin.claude'].command, JSON.stringify(by.claude.fix));
}

{
  fs.rmSync(path.join(bin, 'grok'));
  let { by } = await clis();
  ok('2 a CLI removed from PATH shows not installed, with commands.md\'s install command',
     by.grok.installed === false && by.grok.version === null && by.grok.fix.install === table['install.grok'].command, JSON.stringify(by.grok));
  // Installed the way an installer does it: a new directory, added to PATH in
  // the login shell's startup file. The server's own PATH never changes.
  const newbin = path.join(home, 'newbin');
  fakeCli(newbin, 'grok', { version: 'grok 2.0.0 (fake)' });
  fs.writeFileSync(path.join(home, '.profile'), `PATH="${newbin}:$PATH"\nexport PATH\n`);
  ({ by } = await clis());
  ok('S10 a CLI installed somewhere the server\'s PATH lacks is not seen without Recheck', by.grok.installed === false);
  ({ by } = await clis('?recheck=1'));
  ok('S10 …and Recheck, reading the login shell\'s PATH, finds it with its version', by.grok.installed === true && by.grok.version === 'grok 2.0.0 (fake)', JSON.stringify(by.grok));
}

{
  for (const c of ['claude', 'codex']) fakeCli(bin, c, { slowMs: 10_000 });
  fakeCli(bin, 'grok', { slowMs: 10_000 });
  const t0 = Date.now();
  const pending = clis();
  let worst = 0;
  while (Date.now() - t0 < 2500) {
    const h0 = Date.now();
    const r = await fetch(`${srv.base}/api/health`);
    await r.json();
    worst = Math.max(worst, Date.now() - h0);
    await sleep(100);
  }
  const { by } = await pending;
  const took = Date.now() - t0;
  ok('S10 three slow --version probes: /api/health stays responsive (< 500 ms each)', worst < 500, `worst ${worst} ms`);
  ok('S10 …and the route answers within 4 s, the CLIs installed with no version', took < 4000
     && ['claude', 'codex', 'grok'].every((c) => by[c].installed && by[c].version === null), `${took} ms ${JSON.stringify(by)}`);
}

await srv.stop();
assertRealHomesUnchanged(realBefore, ok);
fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
