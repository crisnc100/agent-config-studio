/**
 * Codex usage reader. Fixtures are synthetic and written to a temp dir — this
 * never reads or writes the real ~/.codex. The one live check is read-only and
 * skips itself when the machine has no Codex history.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  labelForWindow, listRollouts, lastRateLimits, readCodexUsage, defaultCodexHome, numericPercent,
} from '../lib/usage/codex.js';

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
  rollout(home, '2026-09-07T10-00-00', [limits(win(80, 300, 1789000000), win(20, 10080, 1789047414))]);
  const r = readCodexUsage({ codexHome: home });
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
  rollout(home, '2026-09-07T12-00-00', [limits(win(56, 10080, 1789047414), null,
    { credits: { has_credits: false, unlimited: false, balance: '0' } })]);
  const r = readCodexUsage({ codexHome: home });
  ok('current schema reads', r.ok === true && r.windows.length === 1, r.reason || '');
  ok('used_percent carried through', r.windows[0].usedPercent === 56);
  ok('resets_at converted seconds -> millis',
     r.windows[0].resetsAt === 1789047414 * 1000, String(r.windows[0].resetsAt));
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
  rollout(home, '2026-09-07T09-00-00', [limits(win(10, 10080, 1789000000), null, {}, '2026-09-07T09:05:00.000Z')]);
  // Created EARLIER, but resumed just now with a much higher reading.
  const resumed = rollout(home, '2026-09-05T08-00-00', [limits(win(95, 10080, 1789047414), null, {}, '2026-09-07T18:00:00.000Z')]);
  const now = Date.now();
  fs.utimesSync(resumed, now / 1000, now / 1000);   // resuming appends, so mtime is now

  const r = readCodexUsage({ codexHome: home });
  ok('a resumed older session wins on its event timestamp', r.windows[0].usedPercent === 95,
     `got ${r.windows[0]?.usedPercent} — an idle newer session masked the real usage`);
  ok('observedAt is the event time, not the file time',
     r.observedAt === Date.parse('2026-09-07T18:00:00.000Z'), new Date(r.observedAt).toISOString());
}

// --- last reading within a file wins ----------------------------------------
{
  const home = seat('within');
  rollout(home, '2026-09-07T11-00-00', [
    limits(win(11, 10080, 1789000000)),
    { type: 'noise' },
    limits(win(77, 10080, 1789047414)),
  ]);
  ok('last rate_limits in a file wins', readCodexUsage({ codexHome: home }).windows[0].usedPercent === 77);
}

// --- never fake a zero -------------------------------------------------------
{
  const home = seat('empty');
  const r = readCodexUsage({ codexHome: home });
  ok('no rollouts -> ok:false with a reason', r.ok === false && /not signed in/.test(r.reason), r.reason);
  ok('no rollouts -> no windows invented', r.windows.length === 0);
}
{
  const home = seat('noquota');
  rollout(home, '2026-09-07T11-00-00', [{ type: 'turn.completed' }, { type: 'other' }]);
  const r = readCodexUsage({ codexHome: home });
  ok('rollouts without rate_limits -> ok:false',
     r.ok === false && /no quota reading|not signed in|no turn has run/.test(r.reason), r.reason);
}
{
  const r = readCodexUsage({ codexHome: path.join(tmp, 'does-not-exist') });
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
  try { r = readCodexUsage({ codexHome: home }); } catch (e) { threw = e; }
  ok('malformed jsonl does not throw', threw === null, threw?.message);
  ok('malformed jsonl -> ok:false', r?.ok === false);
}

// --- signed in vs never connected -------------------------------------------
// Reporting a logged-in seat as "not connected" sends someone to re-run a login
// that already worked, so the two states must never collapse into one.
{
  const home = seat('signedin');
  fs.writeFileSync(path.join(home, 'auth.json'), '{}');
  const r = readCodexUsage({ codexHome: home });
  ok('signed in with no turns -> signedIn true', r.signedIn === true && r.ok === false);
  ok('signed in with no turns names the real cause', /no turn has run/.test(r.reason), r.reason);
  ok('auth.json is never opened, only stat-ed',
     !JSON.stringify(r).includes('auth.json') || r.signedIn === true);

  const bare = seat('notsignedin');
  const b = readCodexUsage({ codexHome: bare });
  ok('no auth.json -> signedIn false and says to log in',
     b.signedIn === false && /not signed in/.test(b.reason), b.reason);
}

// --- big file: only the tail is read ----------------------------------------
{
  const home = seat('big');
  const dir = path.join(home, 'sessions', '2026', '09', '07');
  const file = path.join(dir, 'rollout-2026-09-07T14-00-00-big.jsonl');
  const filler = JSON.stringify({ type: 'noise', pad: 'x'.repeat(4096) }) + '\n';
  fs.writeFileSync(file, filler.repeat(400) + JSON.stringify(limits(win(42, 10080, 1789047414))) + '\n');
  ok('multi-MB rollout still reads its last quota', readCodexUsage({ codexHome: home }).windows[0].usedPercent === 42);

  // Negative control: a quota that appears ONLY before the tail window must
  // come back null. Reading past the tail would make the whole-file cost of a
  // 40MB rollout the normal case; returning null lets the caller fall through
  // to the next session instead of guessing.
  const buried = path.join(dir, 'rollout-2026-09-07T14-30-00-buried.jsonl');
  fs.writeFileSync(buried, JSON.stringify(limits(win(42, 10080, 1789047414))) + '\n' + filler.repeat(400));
  ok('a quota only present BEFORE the tail window is missed, not guessed',
     lastRateLimits(buried, 2048) === null, JSON.stringify(lastRateLimits(buried, 2048)));
  ok('...and the same file DOES read with a tail big enough to reach it',
     lastRateLimits(buried, 4 * 1024 * 1024)?.limits?.primary?.used_percent === 42);
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
  rollout(home, '2026-09-07T10-00-00', [limits({ used_percent: null, window_minutes: 10080, resets_at: 1789047414 })]);
  const r = readCodexUsage({ codexHome: home });
  ok('a null used_percent yields no window rather than 0%', r.windows.length === 0, JSON.stringify(r.windows));
  ok('...and the seat reports not-ok instead of full headroom', r.ok === false);

  const mixed = seat('mixedpct');
  rollout(mixed, '2026-09-07T10-00-00', [limits(
    { used_percent: null, window_minutes: 300, resets_at: 1789000000 },
    { used_percent: 77, window_minutes: 10080, resets_at: 1789047414 })]);
  const m = readCodexUsage({ codexHome: mixed });
  ok('a good window survives beside an unreadable one',
     m.ok === true && m.windows.length === 1 && m.windows[0].usedPercent === 77, JSON.stringify(m.windows));
}

// --- seat isolation ----------------------------------------------------------
{
  const a = seat('seat-a'); const b = seat('seat-b');
  rollout(a, '2026-09-07T15-00-00', [limits(win(12, 10080, 1789000000))]);
  rollout(b, '2026-09-07T15-00-00', [limits(win(88, 10080, 1789000000))]);
  const ra = readCodexUsage({ codexHome: a }), rb = readCodexUsage({ codexHome: b });
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
    const r = readCodexUsage({ codexHome: home });
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
