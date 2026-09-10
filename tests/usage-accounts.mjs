/**
 * Account-change tracking. Entirely offline, temp dirs only.
 *
 * The bug this exists to kill: "when did this seat sign in" was read from
 * auth.json's mtime, but Codex rewrites that file on every TOKEN REFRESH. Any
 * long-lived process — the ChatGPT desktop app runs one that never exits —
 * moves the mtime forward with no login, and every reading older than that
 * phantom login is discarded. A seat nobody touched blanks itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAccounts, writeAccounts, reconcile, accountsPath } from '../lib/usage/accounts.js';
import { readCodexUsage } from '../lib/usage/codex.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-accounts-'));
const seat = (id) => ({ id, vendor: 'codex', label: id, home: path.join(tmp, id) });
const fpMap = (o) => new Map(Object.entries(o));

console.log('\nusage/accounts');

// --- first sight is a baseline, not a change --------------------------------
{
  const f = path.join(tmp, 'a.json');
  const s = [seat('codex-1')];
  const r = reconcile(s, fpMap({ 'codex-1': 'aaaaaaaaaaaa' }), { file: f, now: 1000 });
  ok('a newly seen seat is not reported as changed', r.get('codex-1').changed === false);
  ok('...and is baselined at the fallback', r.get('codex-1').since === 1000);
  ok('...and is persisted', readAccounts(f)['codex-1'].fingerprint === 'aaaaaaaaaaaa');
}

// --- THE BUG: the same account seen again must not move `since` -------------
{
  const f = path.join(tmp, 'b.json');
  const s = [seat('codex-1')];
  reconcile(s, fpMap({ 'codex-1': 'aaaaaaaaaaaa' }), { file: f, now: 1000 });
  // Hours later, a token refresh. Same account, new file mtime — and this is
  // precisely what used to be mistaken for a fresh login.
  const later = reconcile(s, fpMap({ 'codex-1': 'aaaaaaaaaaaa' }),
    { file: f, now: 999000, fallbackFor: () => 999000 });
  ok('a token refresh does NOT count as a new sign-in', later.get('codex-1').changed === false);
  ok('...and `since` stays at the original login', later.get('codex-1').since === 1000,
     String(later.get('codex-1').since));
}

// --- a real account change does move it -------------------------------------
{
  const f = path.join(tmp, 'c.json');
  const s = [seat('codex-1')];
  reconcile(s, fpMap({ 'codex-1': 'aaaaaaaaaaaa' }), { file: f, now: 1000 });
  const swapped = reconcile(s, fpMap({ 'codex-1': 'bbbbbbbbbbbb' }), { file: f, now: 5000 });
  ok('a different account IS a change', swapped.get('codex-1').changed === true);
  ok('...and `since` moves to when it was noticed', swapped.get('codex-1').since === 5000);
  ok('...and the new fingerprint is stored', readAccounts(f)['codex-1'].fingerprint === 'bbbbbbbbbbbb');
  const again = reconcile(s, fpMap({ 'codex-1': 'bbbbbbbbbbbb' }), { file: f, now: 9000 });
  ok('...and it is only reported once, not every run', again.get('codex-1').changed === false);
}

// --- unreadable or signed-out seats keep their history -----------------------
{
  const f = path.join(tmp, 'd.json');
  const s = [seat('codex-1')];
  reconcile(s, fpMap({ 'codex-1': 'aaaaaaaaaaaa' }), { file: f, now: 1000 });
  const gone = reconcile(s, fpMap({}), { file: f, now: 7000 });
  ok('a seat with no fingerprint is not a change', gone.get('codex-1').changed === false);
  ok('...and its stored history survives', readAccounts(f)['codex-1'].since === 1000);
}

// --- a removed seat does not bequeath its account to a reused id ------------
{
  const f = path.join(tmp, 'e.json');
  reconcile([seat('codex-1')], fpMap({ 'codex-1': 'aaaaaaaaaaaa' }), { file: f, now: 1000 });
  reconcile([seat('codex-2')], fpMap({ 'codex-2': 'cccccccccccc' }), { file: f, now: 2000 });
  ok('a seat that is gone is dropped from state', readAccounts(f)['codex-1'] === undefined);
  const reused = reconcile([seat('codex-1')], fpMap({ 'codex-1': 'dddddddddddd' }),
    { file: f, now: 3000, fallbackFor: () => 3000 });
  ok('a reused id starts fresh rather than inheriting', reused.get('codex-1').changed === false);
}

// --- a corrupt state file must not decide which readings count --------------
{
  const f = path.join(tmp, 'f.json');
  fs.writeFileSync(f, '{ not json');
  ok('corrupt state reads as empty', Object.keys(readAccounts(f)).length === 0);
  fs.writeFileSync(f, JSON.stringify({ seats: { a: { fingerprint: 'NOT-HEX', since: 1 },
                                                b: { fingerprint: 'aaaaaaaaaaaa', since: 'soon' },
                                                c: { fingerprint: 'aaaaaaaaaaaa', since: 5 } } }));
  const parsed = readAccounts(f);
  ok('a bad fingerprint is dropped', parsed.a === undefined);
  ok('a non-numeric timestamp is dropped', parsed.b === undefined);
  ok('the valid entry survives', parsed.c.since === 5);
}

// --- end to end: the reader honours the supplied moment ---------------------
{
  const home = path.join(tmp, 'reader');
  const day = path.join(home, 'sessions', '2026', '09', '07');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), '{"tokens":{"account_id":"x"}}');
  fs.writeFileSync(path.join(day, 'rollout-2026-09-07T10-00-00-a.jsonl'),
    JSON.stringify({ timestamp: '2026-09-07T10:05:00.000Z', type: 'turn.completed',
      info: { rate_limits: { primary: {
        used_percent: 44, window_minutes: 10080,
        resets_at: Math.floor(Date.parse('2026-09-14T00:00:00Z') / 1000) } } } }) + '\n');

  const now = Date.parse('2026-09-07T12:00:00.000Z');

  // Simulate the refresh: push auth.json's mtime PAST the only reading.
  const bogus = Date.parse('2026-09-07T11:00:00.000Z');
  fs.utimesSync(path.join(home, 'auth.json'), bogus / 1000, bogus / 1000);

  const byMtime = readCodexUsage({ codexHome: home, now });
  ok('mtime alone discards the reading (the old, wrong behaviour)',
     byMtime.ok === false, JSON.stringify(byMtime.windows));

  const byAccount = readCodexUsage({
    codexHome: home, now, signedInAt: Date.parse('2026-09-07T09:00:00.000Z'),
  });
  ok('an account-derived sign-in keeps it', byAccount.ok === true, byAccount.reason || '');
  ok('...with the real number', byAccount.windows[0]?.usedPercent === 44);

  // A genuine account change must still exclude the older account's reading.
  const afterSwap = readCodexUsage({
    codexHome: home, now, signedInAt: Date.parse('2026-09-07T11:30:00.000Z'),
  });
  ok('a real account change still discards the previous account', afterSwap.ok === false);
  ok('...and says why', /since it last signed in|no turn has run/.test(afterSwap.reason), afterSwap.reason);
}

// --- the real machine is untouched ------------------------------------------
ok('state lives under the studio home, not the repo', accountsPath('/x') === '/x/accounts.json');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
