/**
 * The live Codex quota read.
 *
 * Shaping is tested against the protocol's REAL reply shapes, captured from
 * two accounts on different plans, because the primary/secondary keys do not
 * mean the same thing on both — a prolite account puts its weekly in `primary`
 * with `secondary` null, while a team account puts a 5h window there. Labelling
 * by position would mislabel one of them, and the panel would confidently show
 * a weekly number under "5h rolling".
 */
import { shapeLimits } from '../lib/usage/codex-limits.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\nusage/codex-limits');

// Captured from `account/rateLimits/read` on a team account.
const TEAM = {
  accountId: 'acct-team',
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 36, windowDurationMins: 300, resetsAt: 1789670554 },
    secondary: { usedPercent: 78, windowDurationMins: 10080, resetsAt: 1790102368 },
    credits: { hasCredits: true, unlimited: false, balance: null },
    planType: 'team',
  },
};
// Captured from a prolite account: ONE window, and it lives in `primary`.
const PROLITE = {
  accountId: 'acct-pro',
  rateLimits: {
    primary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: 1790126940 },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    planType: 'prolite',
  },
};

{
  const r = shapeLimits(TEAM);
  ok('a team reply is readable', r.ok === true, r.reason);
  ok('both windows come through', r.windows.length === 2);
  ok('windows sort tightest-first', r.windows[0].windowMinutes === 300);
  ok('the 5h window is labelled by DURATION, not by its key',
     r.windows[0].label === '5h rolling', r.windows[0].label);
  ok('the weekly window is labelled weekly', r.windows[1].label === 'Weekly', r.windows[1].label);
  ok('resetsAt is converted from epoch seconds to millis',
     r.windows[1].resetsAt === 1790102368 * 1000, String(r.windows[1].resetsAt));
  ok('the plan comes from the reply', r.planType === 'team');
  ok('credits are carried', r.credits?.hasCredits === true);
  ok('the account id is carried, so no module has to open auth.json',
     r.accountId === 'acct-team');
}

{
  const r = shapeLimits(PROLITE);
  ok('a prolite reply is readable', r.ok === true, r.reason);
  ok('a null secondary is dropped rather than becoming a zero window',
     r.windows.length === 1, JSON.stringify(r.windows));
  // The bug this prevents: keying on primary/secondary would call this "5h".
  ok('a weekly window sitting in `primary` is still labelled Weekly',
     r.windows[0].label === 'Weekly' && r.windows[0].usedPercent === 42, r.windows[0].label);
}

// --- never invent a reading --------------------------------------------------
{
  ok('a reply with no rateLimits is not ok', shapeLimits({}).ok === false);
  ok('...and says why', /no rate limits/.test(shapeLimits({}).reason || ''));
  ok('a null result is not ok', shapeLimits(null).ok === false);
  // usedPercent absent must NOT become 0 — a 0 reads as "plenty left", which is
  // the exact opposite of "we do not know", and would route work to a dead seat.
  const blank = shapeLimits({ rateLimits: { primary: { windowDurationMins: 300 }, secondary: null } });
  ok('a window with no percent is dropped, never read as 0% used',
     blank.ok === false, JSON.stringify(blank.windows || []));
  const nulled = shapeLimits({ rateLimits: { primary: { usedPercent: null, windowDurationMins: 300 } } });
  ok('an explicitly null percent is dropped too', nulled.ok === false);
}

// --- one window reported twice is one window ---------------------------------
{
  const dup = shapeLimits({ rateLimits: {
    primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1790102368 },
    secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1790102368 },
  } });
  ok('a duplicate window is collapsed', dup.windows.length === 1);
}

// --- degrading when the CLI cannot answer ------------------------------------
// The live read is primary, but it must never be load-bearing: a machine with
// no codex binary, an old CLI without the method, or no network still has real
// readings in its rollout logs. Losing those and showing "not connected" would
// be worse than the staleness the live read exists to fix.
{
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-fallback-'));
  const at = Date.now() - 30 * 60_000;
  const d = new Date(at - 5 * 60_000);
  const p2 = (n) => String(n).padStart(2, '0');
  const dir = path.join(home, 'sessions', String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
    + `T${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  fs.writeFileSync(path.join(dir, `rollout-${stamp}-a.jsonl`), JSON.stringify({
    timestamp: new Date(at).toISOString(),
    info: { rate_limits: { primary: {
      used_percent: 61, window_minutes: 10080,
      resets_at: Math.floor((at + 10080 * 60_000) / 1000),
    } } },
  }) + '\n');
  fs.writeFileSync(path.join(home, 'auth.json'), '{"tokens":{"account_id":"acct-x"}}');
  fs.utimesSync(path.join(home, 'auth.json'), (at - 3600_000) / 1000, (at - 3600_000) / 1000);

  const script = `
    import { readCodexSeat } from ${JSON.stringify(new URL('../lib/usage/codex.js', import.meta.url).href)};
    const r = await readCodexSeat({ codexHome: ${JSON.stringify(home)} });
    process.stdout.write(JSON.stringify({ ok: r.ok, pct: r.windows[0]?.usedPercent,
      live: r.live === true, liveReason: r.liveReason || null }));
  `;
  let out = '';
  try {
    out = execFileSync(process.execPath, ['--input-type=module', '-e', script],
      { env: { PATH: '', HOME: home }, encoding: 'utf8', timeout: 30_000 });
  } catch (e) { out = `THREW ${e.message}`; }

  let r = null;
  try { r = JSON.parse(out); } catch { /* reported below */ }
  ok('with no codex binary the seat still reports, rather than erroring',
     r !== null && r.ok === true, out.slice(0, 200));
  ok('...using the reading its rollout logs still hold', r?.pct === 61, JSON.stringify(r));
  ok('...marked as NOT live, so staleness is still judged honestly', r?.live === false, JSON.stringify(r));
  ok('...and carrying why there is no live number', /not installed/.test(r?.liveReason || ''), r?.liveReason);

  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
