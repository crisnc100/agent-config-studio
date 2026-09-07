/**
 * Claude usage reader. Every check but the last runs offline against a captured
 * response body and stub credential sources — no network, no keychain. The one
 * live check is read-only and skips itself when no credential is available.
 */
import {
  labelForLimit, shapeUsage, resolveCredential, readClaudeUsage,
  fromEnv, fromKeychain, fromCredentialsFile, DEFAULT_SOURCES,
} from '../lib/usage/claude.js';

let pass = 0, fail = 0, skip = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const skipped = (name, why) => { skip++; console.log(`  skip ${name} — ${why}`); };

// Captured verbatim from a real 200 on 2026-09-07, trimmed to the fields read.
const BODY = {
  five_hour: { utilization: 21.0, resets_at: '2026-09-07T18:50:00.265749+00:00' },
  seven_day: { utilization: 8.0, resets_at: '2026-09-10T03:00:00.265781+00:00' },
  nimbus_quill: { utilization: 0.0, resets_at: null },
  tangelo: null, iguana_necktie: null, omelette_promotional: null,
  limits: [
    { kind: 'session', group: 'session', percent: 21, severity: 'normal',
      resets_at: '2026-09-07T18:50:00.265749+00:00', scope: null, is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 8, severity: 'normal',
      resets_at: '2026-09-10T03:00:00.265781+00:00', scope: null, is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 11, severity: 'normal',
      resets_at: '2026-09-10T03:00:00.266036+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
  ],
  extra_usage: { is_enabled: false, monthly_limit: 20000, used_credits: 0.0,
                 utilization: 0.0, currency: 'USD' },
  spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 },
           limit: { amount_minor: 20000, currency: 'USD', exponent: 2 },
           percent: 0, severity: 'normal', enabled: false },
};

const stub = (status, body) => async () => ({
  ok: status >= 200 && status < 300, status,
  json: async () => { if (body === undefined) throw new Error('not json'); return body; },
});
const cred = (t = 'tok', extra = {}) => () => ({ token: t, expiresAt: null, source: 'stub', ...extra });

console.log('\nusage/claude');

// --- labels ------------------------------------------------------------------
ok('session labelled', labelForLimit({ kind: 'session' }) === 'Current session (5h)');
ok('weekly_all labelled', labelForLimit({ kind: 'weekly_all' }) === 'Weekly (all models)');
ok('weekly_scoped names the model',
   labelForLimit({ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } } }) === 'Weekly (Fable)');
ok('unknown kind degrades, does not throw',
   labelForLimit({ kind: 'future_thing' }) === 'future_thing');
ok('shapeless input degrades', labelForLimit(null) === 'Unknown limit');

// --- shaping the real body ---------------------------------------------------
{
  const s = shapeUsage(BODY);
  ok('three windows, matching the /usage dialog', s.windows.length === 3, String(s.windows.length));
  const by = Object.fromEntries(s.windows.map((w) => [w.kind, w]));
  ok('session 21%', by.session.usedPercent === 21);
  ok('weekly_all 8%', by.weekly_all.usedPercent === 8);
  ok('weekly Fable 11%', by.weekly_scoped.usedPercent === 11 && by.weekly_scoped.label === 'Weekly (Fable)');
  ok('resets_at parsed to millis', by.session.resetsAt === Date.parse('2026-09-07T18:50:00.265749+00:00'));
  ok('session window is 300 min', by.session.windowMinutes === 300);
  ok('weekly windows are 10080 min', by.weekly_all.windowMinutes === 10080);
  ok('is_active carried', by.session.isActive === true && by.weekly_all.isActive === false);
  ok('severity carried', by.session.severity === 'normal');
  ok('extra usage reported beside the windows, not inside them',
     s.extraUsage.enabled === false && s.extraUsage.monthlyLimit === 20000);
  ok('spend shaped', s.spend.limitMinor === 20000 && s.spend.currency === 'USD' && s.spend.enabled === false);
}

// The regression this guards: reading the rotating codenamed top-level keys
// instead of limits[]. `nimbus_quill` is 0% and would render as a real gauge.
{
  const s = shapeUsage(BODY);
  ok('codenamed top-level keys never become windows',
     !s.windows.some((w) => /nimbus|tangelo|iguana|omelette/i.test(w.label)),
     JSON.stringify(s.windows.map((w) => w.label)));
}

// --- credential resolution ---------------------------------------------------
{
  const expired = () => ({ token: 'old', expiresAt: 1000, source: 'credentials-file' });
  const live = () => ({ token: 'new', expiresAt: 9e15, source: 'keychain' });
  const r = resolveCredential([expired, live], 5000);
  ok('an expired credential is skipped for a live one', r.cred?.source === 'keychain', r.cred?.source);
  ok('the skip is reported, not silent', r.tried.some((t) => /expired/.test(t)), JSON.stringify(r.tried));
  ok('no sources -> no credential', resolveCredential([() => null]).cred === null);
}
{
  const before = process.env.ACS_CLAUDE_TOKEN;
  process.env.ACS_CLAUDE_TOKEN = 'explicit';
  ok('env source reads the connected token', fromEnv()?.token === 'explicit');
  delete process.env.ACS_CLAUDE_TOKEN;
  ok('env source absent when unset', fromEnv() === null);
  if (before !== undefined) process.env.ACS_CLAUDE_TOKEN = before;
}
ok('env is tried before credential stores', DEFAULT_SOURCES[0] === fromEnv);
ok('every source returns null rather than throwing on a bad path',
   fromCredentialsFile('/nonexistent/nope.json') === null);

// --- end to end, offline -----------------------------------------------------
{
  const r = await readClaudeUsage({ sources: [cred()], fetchImpl: stub(200, BODY) });
  ok('200 -> ok with three windows', r.ok === true && r.windows.length === 3, r.reason || '');
  ok('credential source is reported', r.credentialSource === 'stub');
  ok('no token anywhere in the result', !JSON.stringify(r).includes('tok'));
}
{
  const r = await readClaudeUsage({ sources: [() => null] });
  ok('no credential -> ok:false with a reason', r.ok === false && /no usable Claude credential/.test(r.reason), r.reason);
  ok('no credential -> no windows invented', r.windows.length === 0);
}
{
  const r = await readClaudeUsage({ sources: [cred()], fetchImpl: stub(401) });
  ok('401 -> actionable reason', r.ok === false && /refresh/.test(r.reason), r.reason);
  ok('401 -> no windows invented', r.windows.length === 0);
}
{
  const r = await readClaudeUsage({ sources: [cred()], fetchImpl: stub(500) });
  ok('500 -> ok:false naming the status', r.ok === false && /HTTP 500/.test(r.reason), r.reason);
}
{
  const r = await readClaudeUsage({ sources: [cred()], fetchImpl: stub(200) });
  ok('non-JSON 200 -> ok:false', r.ok === false && /non-JSON/.test(r.reason), r.reason);
}
{
  // The shape changing under us must read as broken, never as "nothing used".
  const r = await readClaudeUsage({ sources: [cred()], fetchImpl: stub(200, { five_hour: { utilization: 99 } }) });
  ok('200 with no limits[] -> ok:false, not a zeroed gauge',
     r.ok === false && /shape may have changed/.test(r.reason), r.reason);
}
{
  const r = await readClaudeUsage({
    sources: [cred('SECRET-TOKEN')],
    fetchImpl: async () => { throw new Error('connect failed for Bearer SECRET-TOKEN'); },
  });
  ok('network error -> ok:false', r.ok === false && /usage request failed/.test(r.reason));
  ok('a token echoed in an error is redacted',
     !JSON.stringify(r).includes('SECRET-TOKEN') && r.reason.includes('<token>'), r.reason);
}
{
  let aborted = false;
  const r = await readClaudeUsage({
    sources: [cred()], timeoutMs: 20,
    fetchImpl: (_u, o) => new Promise((_res, rej) =>
      o.signal.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); })),
  });
  ok('a hung request is aborted by the timeout', aborted === true && r.ok === false, r.reason);
}

// --- live, read-only ---------------------------------------------------------
{
  const c = fromKeychain();
  if (!c) {
    skipped('live read of the real usage endpoint', 'no Claude credential available here');
  } else {
    const r = await readClaudeUsage();
    if (!r.ok && /rejected|failed/.test(r.reason)) {
      skipped('live read of the real usage endpoint', r.reason);
    } else {
      ok('live: endpoint returns windows', r.ok === true && r.windows.length > 0, r.reason || '');
      ok('live: percentages are sane', r.windows.every((w) => w.usedPercent >= 0 && w.usedPercent <= 100));
      ok('live: no token in the result', !JSON.stringify(r).includes(c.token));
      console.log(`       -> ${r.subscriptionType}: ` +
        r.windows.map((w) => `${w.label} ${w.usedPercent}%`).join(', '));
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped\n`);
process.exit(fail === 0 ? 0 : 1);
