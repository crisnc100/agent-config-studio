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
const limits = (primary, secondary = null, extra = {}) => ({
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

// --- freshness: newest reading wins, and it must beat mtime ------------------
{
  const home = seat('freshness');
  const older = rollout(home, '2026-09-05T09-00-00', [limits(win(10, 10080, 1789000000))]);
  rollout(home, '2026-09-07T09-00-00', [limits(win(90, 10080, 1789047414))]);
  // A long-running OLD session touched most recently. Ranking by mtime would
  // pick the stale 10% and tell Cris he has headroom he does not have.
  const future = Date.now() + 60_000;
  fs.utimesSync(older, future / 1000, future / 1000);
  const r = readCodexUsage({ codexHome: home });
  ok('newest session wins over most-recently-touched', r.windows[0].usedPercent === 90,
     `got ${r.windows[0]?.usedPercent}`);
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
  ok('no rollouts -> ok:false with a reason', r.ok === false && /no rollout/.test(r.reason), r.reason);
  ok('no rollouts -> no windows invented', r.windows.length === 0);
}
{
  const home = seat('noquota');
  rollout(home, '2026-09-07T11-00-00', [{ type: 'turn.completed' }, { type: 'other' }]);
  const r = readCodexUsage({ codexHome: home });
  ok('rollouts without rate_limits -> ok:false', r.ok === false && /none carried/.test(r.reason), r.reason);
}
{
  const r = readCodexUsage({ codexHome: path.join(tmp, 'does-not-exist') });
  ok('missing home -> ok:false, no throw', r.ok === false && /no sessions directory/.test(r.reason), r.reason);
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
     lastRateLimits(buried, 4 * 1024 * 1024)?.primary?.used_percent === 42);
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
