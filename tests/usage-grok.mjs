/** Grok activity reader. Synthetic fixtures in a temp dir; one read-only live check. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readGrokUsage, listSessions, sessionUsage, defaultGrokHome } from '../lib/usage/grok.js';
import { shapeBilling } from '../lib/usage/grok-billing.js';

let pass = 0, fail = 0, skip = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`); } };
const skipped = (n, w) => { skip++; console.log(`  skip ${n} — ${w}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-grok-'));
const mkHome = (name) => { const h = path.join(tmp, name); fs.mkdirSync(path.join(h, 'sessions'), { recursive: true }); return h; };
const mkSession = (home, proj, id, updates, summaryMtime) => {
  const dir = path.join(home, 'sessions', proj, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ info: { id } }));
  fs.writeFileSync(path.join(dir, 'updates.jsonl'), updates.map((u) => JSON.stringify(u)).join('\n') + '\n');
  if (summaryMtime) fs.utimesSync(path.join(dir, 'summary.json'), summaryMtime / 1000, summaryMtime / 1000);
  return dir;
};
const turn = (inTok, outTok, at, ticks = 1000) => ({
  timestamp: new Date(at).toISOString(), type: 'turn_completed',
  usage: { inputTokens: inTok, outputTokens: outTok, totalTokens: inTok + outTok, costUsdTicks: ticks, modelCalls: 1 },
});

console.log('\nusage/grok');
const NOW = Date.parse('2026-09-07T18:00:00.000Z');

// --- a grok seat must NEVER rank as headroom --------------------------------
// It has no quota, so letting it look rankable would put it on the route line
// beside real percentages that mean something different.
{
  const home = mkHome('active');
  fs.writeFileSync(path.join(home, 'auth.json'), '{"k":1}');
  mkSession(home, 'proj', 's1', [turn(1000, 100, NOW - 3600_000)], NOW - 3600_000);
  const r = readGrokUsage({ grokHome: home, now: NOW });
  ok('never reports ok — there is no headroom to report', r.ok === false);
  ok('never invents a window', r.windows.length === 0);
  ok('flags itself as quota-less', r.noQuota === true);
  ok('knows it is signed in', r.signedIn === true);
  ok('counts the turn', r.activity.turns === 1 && r.activity.inputTokens === 1000);
  ok('reports last active', r.lastActiveAt === NOW - 3600_000, String(r.lastActiveAt));
  ok('the reason explains rather than blames', /no subscription quota/.test(r.reason), r.reason);
}

// --- signed out vs connected -------------------------------------------------
{
  const home = mkHome('signedout');
  mkSession(home, 'p', 's', [turn(10, 10, NOW)], NOW);
  const r = readGrokUsage({ grokHome: home, now: NOW });
  ok('no auth.json -> not signed in', r.signedIn === false && /not signed in/.test(r.reason), r.reason);

  const empty = mkHome('emptyauth');
  fs.writeFileSync(path.join(empty, 'auth.json'), '');
  ok('an empty auth.json is not signed in', readGrokUsage({ grokHome: empty, now: NOW }).signedIn === false);
}

// --- the 24h window ----------------------------------------------------------
{
  const home = mkHome('window');
  fs.writeFileSync(path.join(home, 'auth.json'), '{"k":1}');
  mkSession(home, 'p', 'recent', [turn(500, 50, NOW - 3600_000)], NOW - 3600_000);
  mkSession(home, 'p', 'old', [turn(9999, 9999, NOW - 40 * 3600_000)], NOW - 40 * 3600_000);
  const r = readGrokUsage({ grokHome: home, now: NOW });
  ok('only sessions inside the window are counted', r.activity.inputTokens === 500, String(r.activity.inputTokens));
  ok('but every session is still counted as a session', r.activity.sessions === 2);
  // Opening every updates.jsonl on each 60s poll would be the wrong shape.
  ok('an out-of-window session is not opened', r.activity.turns === 1);

  // The real bug: a RESUMED old session has a recent summary mtime, so it
  // passes the prefilter — and summing the whole file dragged days of history
  // into a figure labelled "the last 24 hours".
  const resumed = mkHome('resumed');
  fs.writeFileSync(path.join(resumed, 'auth.json'), '{"k":1}');
  mkSession(resumed, 'p', 'long', [
    turn(100000, 100000, NOW - 5 * 24 * 3600_000),   // last week
    turn(100000, 100000, NOW - 3 * 24 * 3600_000),   // still old
    turn(700, 50, NOW - 1800_000),                   // today
  ], NOW - 1800_000);                                // resumed just now
  const rr = readGrokUsage({ grokHome: resumed, now: NOW });
  ok('a resumed session contributes only its in-window turns',
     rr.activity.turns === 1 && rr.activity.inputTokens === 700,
     `${rr.activity.turns} turns / ${rr.activity.inputTokens} tokens`);
  ok('...and last-active still reflects the recent turn',
     rr.lastActiveAt === NOW - 1800_000, String(rr.lastActiveAt));

  // A turn with no usable timestamp cannot be placed in the window.
  const undated = mkHome('undated');
  fs.writeFileSync(path.join(undated, 'auth.json'), '{"k":1}');
  const d = path.join(undated, 'sessions', 'p', 's');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'summary.json'), '{}');
  fs.writeFileSync(path.join(d, 'updates.jsonl'),
    JSON.stringify({ usage: { inputTokens: 999, outputTokens: 1 } }) + '\n');
  const ru = readGrokUsage({ grokHome: undated, now: NOW });
  ok('an undated turn is left out rather than assumed recent', ru.activity.inputTokens === 0);
}

// --- malformed input ---------------------------------------------------------
{
  const home = mkHome('broken');
  fs.writeFileSync(path.join(home, 'auth.json'), '{"k":1}');
  const dir = path.join(home, 'sessions', 'p', 'bad');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), '{}');
  fs.writeFileSync(path.join(dir, 'updates.jsonl'), '{"usage": truncated\n\x00 junk\n');
  let threw = null, r;
  try { r = readGrokUsage({ grokHome: home, now: NOW }); } catch (e) { threw = e; }
  ok('malformed updates.jsonl does not throw', threw === null, threw?.message);
  ok('and contributes no tokens', r.activity.inputTokens === 0);
  ok('a session with no updates.jsonl is skipped', sessionUsage(path.join(tmp, 'nope')) === null);
}

// --- no sessions at all ------------------------------------------------------
{
  const bare = path.join(tmp, 'bare');
  fs.mkdirSync(bare, { recursive: true });
  const r = readGrokUsage({ grokHome: bare, now: NOW });
  ok('a home with no sessions dir still answers', r.ok === false && r.windows.length === 0);
  ok('...and says why', r.reason.length > 0, r.reason);
}

// --- no dollar figure is ever produced --------------------------------------
{
  const home = mkHome('cost');
  fs.writeFileSync(path.join(home, 'auth.json'), '{"k":1}');
  mkSession(home, 'p', 's', [turn(10, 10, NOW, 48144000)], NOW);
  const r = readGrokUsage({ grokHome: home, now: NOW });
  // The ticks-per-dollar scale is unverified. Raw ticks are carried so the
  // scale can be settled later; a dollar figure now would be a guess on screen.
  ok('raw cost ticks are carried', r.activity.costTicks === 48144000);
  ok('no dollar figure is derived', !/usd|dollar|costUsd\b/i.test(JSON.stringify(r).replace(/costUsdTicks|costTicks/gi, '')));
}

// --- the weekly quota, shaped ------------------------------------------------
// Captured verbatim from a real _x.ai/billing reply on 2026-09-07.
{
  const REAL = { config: {
    creditUsagePercent: 1,
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-09-07T12:46:34.445561+00:00', end: '2026-09-14T12:46:34.445561+00:00' },
    onDemandCap: { val: 0 }, onDemandUsed: { val: 0 }, prepaidBalance: { val: 0 },
    isUnifiedBillingUser: true,
    billingPeriodStart: '2026-09-07T12:46:34.445561+00:00',
    billingPeriodEnd: '2026-09-14T12:46:34.445561+00:00' },
    subscription_tier: 'SuperGrok' };

  const b = shapeBilling(REAL);
  ok('a real billing reply yields one weekly window', b.ok === true && b.windows.length === 1);
  ok('percent carried', b.windows[0].usedPercent === 1);
  ok('weekly is 10080 minutes', b.windows[0].windowMinutes === 10080);
  ok('reset parsed from the period end',
     b.windows[0].resetsAt === Date.parse('2026-09-14T12:46:34.445561+00:00'));
  ok('tier carried', b.tier === 'SuperGrok');

  // The same null-percent trap as the other readers: Number(null) is 0, which
  // would paint a full green bar for a quota we could not read.
  // Every one of these coerces to 0 through Number(), and 0% is a full green
  // bar meaning "nothing used" for a quota we could not read.
  for (const bad of [null, undefined, '', '   ', [], [5], {}, false, true, 'abc', NaN]) {
    const r2 = shapeBilling({ config: { ...REAL.config, creditUsagePercent: bad } });
    ok(`creditUsagePercent ${JSON.stringify(bad) ?? 'undefined'} is refused, not shown as 0%`,
       r2.ok === false, JSON.stringify(r2.windows));
  }
  ok('a numeric string is still accepted',
     shapeBilling({ config: { ...REAL.config, creditUsagePercent: '37' } }).windows[0].usedPercent === 37);
  ok('a real zero is still zero',
     shapeBilling({ config: { ...REAL.config, creditUsagePercent: 0 } }).windows[0].usedPercent === 0);
  ok('a missing config is refused', shapeBilling({}).ok === false);
  ok('a garbage reply does not throw', shapeBilling(null).ok === false);

  // A non-weekly period must not be mislabelled Weekly.
  const monthly = shapeBilling({ config: { creditUsagePercent: 50,
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY',
      start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' } } });
  ok('a non-weekly period is not labelled Weekly',
     monthly.windows[0].label === 'Current period' && monthly.windows[0].windowMinutes !== 10080,
     JSON.stringify(monthly.windows[0]));
}

// --- live --------------------------------------------------------------------
{
  const home = defaultGrokHome();
  if (!fs.existsSync(path.join(home, 'sessions'))) skipped('live read of the real grok home', 'no ~/.grok/sessions here');
  else {
    const before = fs.statSync(path.join(home, 'sessions')).mtimeMs;
    const r = readGrokUsage({ grokHome: home });
    ok('live: reads real sessions', r.activity.sessions > 0, String(r.activity?.sessions));
    ok('live: never claims headroom', r.ok === false && r.windows.length === 0);
    ok('live: does not mutate anything', fs.statSync(path.join(home, 'sessions')).mtimeMs === before);
    console.log(`       -> ${r.activity.sessions} sessions, ${r.activity.turns} turns/24h, ` +
      `${r.activity.inputTokens + r.activity.outputTokens} tokens`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped\n`);
process.exit(fail === 0 ? 0 : 1);
