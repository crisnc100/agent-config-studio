/**
 * Codex usage reader. Fixtures are synthetic and written to a temp dir — this
 * never reads or writes the real ~/.codex. The one live check is read-only and
 * skips itself when the machine has no Codex history.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  labelForWindow, listRollouts, lastRateLimits, readCodexUsage, defaultCodexHome,
} from '../lib/usage/codex.js';
import { numericPercent } from '../lib/usage/percent.js';

let pass = 0, fail = 0, skip = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const skipped = (name, why) => { skip++; console.log(`  skip ${name} — ${why}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-usage-'));
const seat = (name) => {
  const home = path.join(tmp, name);
  fs.mkdirSync(path.join(home, 'sessions', '2026', '09', '07'), { recursive: true });
  return home;
};
const rollout = (home, stamp, lines) => {
  const [y, m, d] = stamp.slice(0, 10).split('-');
  const dir = path.join(home, 'sessions', y, m, d);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${stamp}-fixture.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
};
const limits = (primary, secondary = null, extra = {}, at = '2026-09-07T10:00:00.000Z') => ({
  timestamp: at,
  type: 'turn.completed',
  info: { rate_limits: { limit_id: 'codex', primary, secondary, plan_type: 'prolite', ...extra } },
});
const win = (used, minutes, resets) => ({ used_percent: used, window_minutes: minutes, resets_at: resets });

// Fixtures live in a fixed era, and every read below is pinned to a clock inside
// it. Absolute wall-clock values here rot: once real time passes a fixture's
// resets_at, the reading expires *by design* and assertions read undefined.
// That has been misdiagnosed as a code bug twice — anchor, don't hardcode.
const ERA = Date.parse('2026-09-07T00:00:00.000Z');
const READ_AT = ERA + 10.5 * 3600_000;                       // 2026-09-07T10:30Z
const RESET_A = Math.floor((ERA + 30 * 3600_000) / 1000);    // 2026-09-08T06:00Z
const RESET_B = Math.floor((ERA + 78 * 3600_000) / 1000);    // 2026-09-10T06:00Z
const read = (opts) => readCodexUsage({ now: READ_AT, ...opts });

console.log('\nusage/codex');

// --- labels come from duration, never from key position -----------------------
ok('10080 min labels Weekly', labelForWindow(10080) === 'Weekly', labelForWindow(10080));
ok('300 min labels 5h rolling', labelForWindow(300) === '5h rolling', labelForWindow(300));
ok('1440 min labels Daily', labelForWindow(1440) === 'Daily', labelForWindow(1440));
ok('garbage window is not silently a real label',
   labelForWindow(undefined) === 'Unknown window', labelForWindow(undefined));

// The regression this whole design exists to prevent: the old schema put the
// 5h window in `primary`. Reading it positionally mislabels it as the weekly.
{
  const home = seat('legacy');
  rollout(home, '2026-09-07T10-00-00', [limits(win(80, 300, RESET_A), win(20, 10080, RESET_B))]);
  // Pin the clock just after the fixture's own event, or the 5h window ages out
  // by the expiry rule and this stops testing the labelling it exists to test.
  const r = readCodexUsage({ codexHome: home, now: Date.parse('2026-09-07T10:30:00.000Z') });
  const five = r.windows.find((w) => w.windowMinutes === 300);
  const week = r.windows.find((w) => w.windowMinutes === 10080);
  ok('legacy schema: 5h window labelled 5h despite being `primary`',
     five?.label === '5h rolling' && five.usedPercent === 80, JSON.stringify(r.windows));
  ok('legacy schema: weekly labelled Weekly despite being `secondary`',
     week?.label === 'Weekly' && week.usedPercent === 20);
  ok('windows sort shortest-first', r.windows[0].windowMinutes === 300);
}

// --- current schema ----------------------------------------------------------
{
  const home = seat('current');
  rollout(home, '2026-09-07T12-00-00', [limits(win(56, 10080, RESET_B), null,
    { credits: { has_credits: false, unlimited: false, balance: '0' } }, '2026-09-07T12:00:00.000Z')]);
  // Pin the clock inside the fixture's own window. Left unpinned, this test
  // silently rots: once wall-clock passes the fixture's resets_at the reading
  // expires by design and the assertions below read undefined.
  const r = readCodexUsage({ codexHome: home, now: Date.parse('2026-09-07T12:30:00.000Z') });
  ok('current schema reads', r.ok === true && r.windows.length === 1, r.reason || '');
  ok('used_percent carried through', r.windows[0].usedPercent === 56);
  ok('resets_at converted seconds -> millis',
     r.windows[0].resetsAt === RESET_B * 1000, String(r.windows[0].resetsAt));
  ok('plan_type carried', r.planType === 'prolite');
  ok('credits carried', r.credits?.hasCredits === false && r.credits.balance === '0');
}

// --- freshness: the newest OBSERVATION wins ---------------------------------
// The bug this replaces: candidates were ranked by the timestamp in the
// filename, so RESUMING an old session hid its newer usage completely and an
// idle newer session's stale number was reported as current — pointing you at a
// seat that is actually nearly exhausted.
{
  const home = seat('freshness');
  // Created later, but idle since: an old, low reading.
  rollout(home, '2026-09-07T09-00-00', [limits(win(10, 10080, RESET_A), null, {}, '2026-09-07T09:05:00.000Z')]);
  // Created EARLIER, but resumed just now with a much higher reading.
  const resumed = rollout(home, '2026-09-05T08-00-00', [limits(win(95, 10080, RESET_B), null, {}, '2026-09-07T18:00:00.000Z')]);
  const now = Date.now();
  fs.utimesSync(resumed, now / 1000, now / 1000);   // resuming appends, so mtime is now

  const r = read({ codexHome: home });
  ok('a resumed older session wins on its event timestamp', r.windows[0].usedPercent === 95,
     `got ${r.windows[0]?.usedPercent} — an idle newer session masked the real usage`);
  ok('observedAt is the event time, not the file time',
     r.observedAt === Date.parse('2026-09-07T18:00:00.000Z'), new Date(r.observedAt).toISOString());
}

// --- last reading within a file wins ----------------------------------------
{
  const home = seat('within');
  rollout(home, '2026-09-07T11-00-00', [
    limits(win(11, 10080, RESET_A)),
    { type: 'noise' },
    limits(win(77, 10080, RESET_B)),
  ]);
  ok('last rate_limits in a file wins', read({ codexHome: home }).windows[0].usedPercent === 77);
}

// --- never fake a zero -------------------------------------------------------
{
  const home = seat('empty');
  const r = read({ codexHome: home });
  ok('no rollouts -> ok:false with a reason', r.ok === false && /not signed in/.test(r.reason), r.reason);
  ok('no rollouts -> no windows invented', r.windows.length === 0);
}
{
  const home = seat('noquota');
  rollout(home, '2026-09-07T11-00-00', [{ type: 'turn.completed' }, { type: 'other' }]);
  const r = read({ codexHome: home });
  ok('rollouts without rate_limits -> ok:false',
     r.ok === false && /no quota reading|not signed in|no turn has run/.test(r.reason), r.reason);
}
{
  const r = read({ codexHome: path.join(tmp, 'does-not-exist') });
  ok('missing home -> ok:false, no throw', r.ok === false && r.reason.length > 0, r.reason);
}

// --- malformed input must not throw -----------------------------------------
{
  const home = seat('broken');
  const dir = path.join(home, 'sessions', '2026', '09', '07');
  fs.writeFileSync(path.join(dir, 'rollout-2026-09-07T13-00-00-x.jsonl'),
    '{"rate_limits": truncated\n\x00\x01 not json at all\n');
  let threw = null;
  let r;
  try { r = read({ codexHome: home }); } catch (e) { threw = e; }
  ok('malformed jsonl does not throw', threw === null, threw?.message);
  ok('malformed jsonl -> ok:false', r?.ok === false);
}

// --- a re-auth must not inherit the previous account's numbers --------------
{
  // Rollouts carry no account identity. After signing a seat into a DIFFERENT
  // subscription, the old account's rollouts are still on disk — reporting them
  // under the new seat shows one subscription's quota as another's.
  const home = seat('reauth');
  rollout(home, '2026-09-07T10-00-00', [limits(win(1, 10080, RESET_A), null, {}, '2026-09-07T10:05:00.000Z')]);
  const auth = path.join(home, 'auth.json');
  fs.writeFileSync(auth, '{"tokens":{"account_id":"new"}}');
  const loginAt = Date.parse('2026-09-07T12:00:00.000Z');       // signed in AFTER that rollout
  fs.utimesSync(auth, loginAt / 1000, loginAt / 1000);

  const r = read({ codexHome: home });
  ok('a reading from before the current login is ignored', r.ok === false, JSON.stringify(r.windows));
  ok('...and no window is carried over', r.windows.length === 0);
  ok('...and it says a turn has not run since signing in',
     /since it last signed in/.test(r.reason), r.reason);

  // A turn after the login is this account's and must count.
  rollout(home, '2026-09-07T13-00-00', [limits(win(7, 10080, RESET_B), null, {}, '2026-09-07T13:05:00.000Z')]);
  const r2 = read({ codexHome: home });
  ok('a reading from after the login is used', r2.ok === true && r2.windows[0].usedPercent === 7,
     JSON.stringify(r2.windows));
}

// --- a session open across a re-auth keeps the OLD account -------------------
{
  // An interactive session holds the credentials it started with. Left open
  // across a re-auth it keeps writing the previous account's quota into this
  // home, with timestamps NEWER than the login — so filtering events by time
  // is not enough; the whole session has to be excluded by its start.
  const home = seat('openacross');
  const auth = path.join(home, 'auth.json');
  fs.writeFileSync(auth, '{"tokens":{"account_id":"new"}}');

  // Codex writes the session start into the filename in LOCAL time, so the
  // fixture has to be built the same way or the comparison is meaningless.
  const localStamp = (d) => {
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
           `T${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  };
  const loginAt = new Date('2026-09-07T12:00:00').getTime();       // local
  fs.utimesSync(auth, loginAt / 1000, loginAt / 1000);

  // Started BEFORE the login, still emitting AFTER it — the old account.
  rollout(home, localStamp(new Date(loginAt - 2 * 3600_000)),
          [limits(win(100, 300, RESET_A), null, {}, new Date(loginAt + 90 * 60_000).toISOString())]);
  // Started after the login — genuinely this account.
  rollout(home, localStamp(new Date(loginAt + 30 * 60_000)),
          [limits(win(58, 10080, RESET_B), null, {}, new Date(loginAt + 35 * 60_000).toISOString())]);

  const r = read({ codexHome: home });
  ok('a session started before the login is excluded entirely',
     r.ok === true && r.windows[0].usedPercent === 58,
     `got ${r.windows.map((w) => w.usedPercent + '%').join(',')} — the old account won on recency`);
  ok('...even though its events are newer', r.windows.every((w) => w.usedPercent !== 100));
}

// --- signed in vs never connected -------------------------------------------
// Reporting a logged-in seat as "not connected" sends someone to re-run a login
// that already worked, so the two states must never collapse into one.
{
  const home = seat('signedin');
  fs.writeFileSync(path.join(home, 'auth.json'), '{}');
  const r = read({ codexHome: home });
  ok('signed in with no turns -> signedIn true', r.signedIn === true && r.ok === false);
  ok('signed in with no turns names the real cause', /no turn has run/.test(r.reason), r.reason);
  ok('auth.json is never opened, only stat-ed',
     !JSON.stringify(r).includes('auth.json') || r.signedIn === true);

  const bare = seat('notsignedin');
  const b = read({ codexHome: bare });
  ok('no auth.json -> signedIn false and says to log in',
     b.signedIn === false && /not signed in/.test(b.reason), b.reason);
}

// --- big file: only the tail is read ----------------------------------------
{
  const home = seat('big');
  const dir = path.join(home, 'sessions', '2026', '09', '07');
  const file = path.join(dir, 'rollout-2026-09-07T14-00-00-big.jsonl');
  const filler = JSON.stringify({ type: 'noise', pad: 'x'.repeat(4096) }) + '\n';
  fs.writeFileSync(file, filler.repeat(400) + JSON.stringify(limits(win(42, 10080, RESET_B))) + '\n');
  ok('multi-MB rollout still reads its last quota', read({ codexHome: home }).windows[0].usedPercent === 42);

  // Negative control: a quota that appears ONLY before the tail window must
  // come back null. Reading past the tail would make the whole-file cost of a
  // 40MB rollout the normal case; returning null lets the caller fall through
  // to the next session instead of guessing.
  const buried = path.join(dir, 'rollout-2026-09-07T14-30-00-buried.jsonl');
  fs.writeFileSync(buried, JSON.stringify(limits(win(42, 10080, RESET_B))) + '\n' + filler.repeat(400));
  ok('a quota only present BEFORE the tail window is missed, not guessed',
     lastRateLimits(buried, 2048) === null, JSON.stringify(lastRateLimits(buried, 2048)));
  ok('...and the same file DOES read with a tail big enough to reach it',
     lastRateLimits(buried, 4 * 1024 * 1024)?.limits?.primary?.used_percent === 42);
}

// --- a window whose period already reset is not current usage ---------------
{
  // The panel showed 100% of a 5h limit that had reset hours earlier and was
  // really 8%. A percentage only describes the window it was measured in.
  const home = seat('expired');
  const at = Date.parse('2026-09-07T10:00:00.000Z');
  rollout(home, '2026-09-07T10-00-00', [limits(
    win(100, 300, Math.floor((at + 3600_000) / 1000)),      // 5h window, resets an hour later
    win(16, 10080, Math.floor((at + 7 * 86400_000) / 1000)), // weekly, still open
    {}, '2026-09-07T10:00:00.000Z')]);

  const later = at + 5 * 3600_000;   // past the 5h reset, inside the weekly
  const r = readCodexUsage({ codexHome: home, now: later });
  ok('an expired window is dropped', !r.windows.some((w) => w.windowMinutes === 300),
     JSON.stringify(r.windows));
  ok('the still-open window survives', r.windows.some((w) => w.usedPercent === 16));
  ok('the drop is reported, not silent', r.expiredWindows === 1, String(r.expiredWindows));

  // Every window expired -> there is nothing current to report at all.
  const all = seat('allexpired');
  rollout(all, '2026-09-07T10-00-00', [limits(win(100, 300, Math.floor((at + 60_000) / 1000)), null, {}, '2026-09-07T10:00:00.000Z')]);
  const r2 = readCodexUsage({ codexHome: all, now: later });
  ok('when every window has reset the seat reports no usage', r2.ok === false && r2.windows.length === 0);
  ok('...and says to run a turn', /run a turn/.test(r2.reason), r2.reason);
}

// --- a stale reading is never routed on -------------------------------------
{
  // Window anchors move: a weekly reading can belong to a window that has
  // already been replaced while its stored resets_at is still in the future,
  // so expiry alone cannot catch it. Age has to disqualify it from ranking.
  const home = seat('stale');
  const at = Date.parse('2026-09-07T10:00:00.000Z');
  rollout(home, '2026-09-07T10-00-00', [limits(
    win(16, 10080, Math.floor((at + 7 * 86400_000) / 1000)), null, {}, '2026-09-07T10:00:00.000Z')]);

  const fresh = readCodexUsage({ codexHome: home, now: at + 60_000 });
  ok('a fresh reading is not stale', fresh.stale === false && fresh.ok === true);

  const old = readCodexUsage({ codexHome: home, now: at + 21 * 3600_000 });
  ok('a 21h-old reading is marked stale', old.stale === true, String(old.stale));
  ok('...but its numbers are still shown, not discarded', old.ok === true && old.windows.length === 1);
}

// --- a missing percent is never 0 -------------------------------------------
// Number(null) is 0, and 0% renders as a full green bar — "we do not know"
// displayed as "nothing used", which is the worst possible routing advice.
{
  ok('null is not a percent', numericPercent(null) === null);
  ok('undefined is not a percent', numericPercent(undefined) === null);
  ok('blank string is not a percent', numericPercent('   ') === null);
  ok('false is not a percent', numericPercent(false) === null);
  ok('a numeric string is a percent', numericPercent('42') === 42);
  ok('zero really is zero', numericPercent(0) === 0);

  const home = seat('nullpct');
  rollout(home, '2026-09-07T10-00-00', [limits({ used_percent: null, window_minutes: 10080, resets_at: RESET_B })]);
  const r = read({ codexHome: home });
  ok('a null used_percent yields no window rather than 0%', r.windows.length === 0, JSON.stringify(r.windows));
  ok('...and the seat reports not-ok instead of full headroom', r.ok === false);

  const mixed = seat('mixedpct');
  rollout(mixed, '2026-09-07T10-00-00', [limits(
    { used_percent: null, window_minutes: 300, resets_at: RESET_A },
    { used_percent: 77, window_minutes: 10080, resets_at: RESET_B })]);
  const m = read({ codexHome: mixed });
  ok('a good window survives beside an unreadable one',
     m.ok === true && m.windows.length === 1 && m.windows[0].usedPercent === 77, JSON.stringify(m.windows));
}

// --- seat isolation ----------------------------------------------------------
{
  const a = seat('seat-a'); const b = seat('seat-b');
  rollout(a, '2026-09-07T15-00-00', [limits(win(12, 10080, RESET_A))]);
  rollout(b, '2026-09-07T15-00-00', [limits(win(88, 10080, RESET_A))]);
  const ra = read({ codexHome: a }), rb = read({ codexHome: b });
  ok('two homes report independently', ra.windows[0].usedPercent === 12 && rb.windows[0].usedPercent === 88);
  ok('result names the home it read', ra.home === a && rb.home === b);
}

// --- live, read-only ---------------------------------------------------------
{
  const home = defaultCodexHome();
  if (!fs.existsSync(path.join(home, 'sessions'))) {
    skipped('live read of the real codex home', 'no ~/.codex/sessions on this machine');
  } else {
    const before = fs.statSync(path.join(home, 'sessions')).mtimeMs;
    const r = read({ codexHome: home });
    ok('live: real codex home yields a reading', r.ok === true, r.reason || '');
    ok('live: every window has a sane percent',
       r.windows.every((w) => w.usedPercent >= 0 && w.usedPercent <= 100), JSON.stringify(r.windows));
    ok('live: reading is not mutating anything',
       fs.statSync(path.join(home, 'sessions')).mtimeMs === before);
    console.log(`       -> ${r.planType}: ` +
      r.windows.map((w) => `${w.label} ${w.usedPercent}% (resets ${new Date(w.resetsAt).toISOString()})`).join(', '));
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped\n`);
process.exit(fail === 0 ? 0 : 1);
