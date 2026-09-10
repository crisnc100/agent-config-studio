/** Account fingerprinting and duplicate demotion. Offline, temp dirs only. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexAccountFingerprint, grokAccountFingerprint, fingerprintFor, markDuplicates }
  from '../lib/usage/identity.js';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-ident-'));
const codexHome = (name, accountId) => {
  const h = path.join(tmp, name); fs.mkdirSync(h, { recursive: true });
  if (accountId !== undefined) fs.writeFileSync(path.join(h, 'auth.json'),
    JSON.stringify({ tokens: { account_id: accountId, access_token: 'SECRET-TOKEN-VALUE' } }));
  return h;
};

console.log('\nusage/identity');

// --- fingerprints identify, they do not expose ------------------------------
{
  const a = codexHome('a', 'acct-111'), b = codexHome('b', 'acct-111'), c = codexHome('c', 'acct-222');
  const fa = codexAccountFingerprint(a), fb = codexAccountFingerprint(b), fc = codexAccountFingerprint(c);
  ok('the same account fingerprints identically', fa === fb && fa !== null, `${fa} / ${fb}`);
  ok('a different account fingerprints differently', fa !== fc);
  // The whole reason this module is allowed to open auth.json.
  ok('the raw account id never appears in the fingerprint', !fa.includes('acct'));
  ok('no token can leak through it', !fa.includes('SECRET'));
  ok('the fingerprint is short and opaque', /^[0-9a-f]{12}$/.test(fa), fa);
}
{
  ok('a home with no auth.json has no fingerprint', codexAccountFingerprint(codexHome('noauth')) === null);
  const bad = codexHome('bad'); fs.writeFileSync(path.join(bad, 'auth.json'), 'not json');
  ok('malformed auth.json yields null, not a throw', codexAccountFingerprint(bad) === null);
  ok('a missing directory yields null', codexAccountFingerprint(path.join(tmp, 'nope')) === null);
  const noid = codexHome('noid'); fs.writeFileSync(path.join(noid, 'auth.json'), '{"tokens":{}}');
  ok('auth.json without an account_id yields null', codexAccountFingerprint(noid) === null);
}
{
  const g = path.join(tmp, 'grok'); fs.mkdirSync(g, { recursive: true });
  fs.writeFileSync(path.join(g, 'auth.json'),
    JSON.stringify({ 'https://auth.x.ai::abc': { user_id: 'user-9', key: 'SECRET' } }));
  const f = grokAccountFingerprint(g);
  ok('grok fingerprints from user_id', /^[0-9a-f]{12}$/.test(f), f);
  ok('...without exposing it', !f.includes('user-9') && !f.includes('SECRET'));
}
ok('a seat with no home has no fingerprint', fingerprintFor({ vendor: 'codex' }) === null);
ok('an unsupported vendor has no fingerprint', fingerprintFor({ vendor: 'claude', home: '/x' }) === null);

// --- duplicates are demoted, and the FRESHEST one survives ------------------
{
  // The real failure: two seats on one subscription. The staler reading shows a
  // lower percentage, wins the routing line, and sends work to an exhausted pool.
  const seats = [
    { seatId: 'a', label: 'Primary', vendor: 'codex', ok: true, observedAt: 2000,
      accountFingerprint: 'same', windows: [{ usedPercent: 100 }] },
    { seatId: 'b', label: 'Second', vendor: 'codex', ok: true, observedAt: 1000,
      accountFingerprint: 'same', windows: [{ usedPercent: 1 }] },
  ];
  markDuplicates(seats);
  const a = seats.find((s) => s.seatId === 'a'), b = seats.find((s) => s.seatId === 'b');
  ok('the freshest reading survives', a.ok === true && a.duplicateOf === null);
  ok('it names its siblings', a.duplicateSiblings.includes('Second'));
  ok('the stale duplicate is demoted', b.ok === false && b.duplicateOf === 'Primary');
  ok('the stale duplicate cannot rank', b.windows.length === 0);
  ok('and it says what to do', /different subscription|stop tracking/.test(b.reason), b.reason);
}
{
  const seats = [
    { seatId: 'a', label: 'A', vendor: 'codex', ok: true, observedAt: 1, accountFingerprint: 'x', windows: [{ usedPercent: 5 }] },
    { seatId: 'b', label: 'B', vendor: 'codex', ok: true, observedAt: 2, accountFingerprint: 'y', windows: [{ usedPercent: 6 }] },
  ];
  markDuplicates(seats);
  ok('genuinely different accounts are both kept', seats.every((s) => s.ok === true && !s.duplicateOf));
}
{
  // Same fingerprint across vendors is not a duplicate — different services.
  const seats = [
    { seatId: 'a', label: 'A', vendor: 'codex', ok: true, observedAt: 1, accountFingerprint: 'z', windows: [{ usedPercent: 5 }] },
    { seatId: 'b', label: 'B', vendor: 'grok', ok: true, observedAt: 2, accountFingerprint: 'z', windows: [{ usedPercent: 6 }] },
  ];
  markDuplicates(seats);
  ok('a fingerprint collision across vendors is not a duplicate', seats.every((s) => !s.duplicateOf));
}
{
  const seats = [{ seatId: 'a', label: 'A', vendor: 'codex', ok: true, observedAt: 1, accountFingerprint: null, windows: [] }];
  markDuplicates(seats);
  ok('seats without a fingerprint are never grouped', !seats[0].duplicateOf);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
