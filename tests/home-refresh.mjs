/**
 * Home's Refresh usage (builds/model-roles A6, R11) in the fake DOM against
 * stubbed routes: one request per click, a visible busy state, a repaint on
 * success, an inline reason on failure or timeout, and no older reading
 * painted over a newer one. Usage's own Refresh shares the request. No
 * server, no HOME.
 */
import { bootPage, routesFor, settle } from './fixtures/shell-page.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
console.log('\nhome: Refresh usage');

const seat = (label, used) => ({ seatId: label.toLowerCase().replace(/\W+/g, '-'), label, vendor: 'codex', home: '/h/.codex', ok: true, observedAt: Date.now(), windows: [{ label: 'Weekly', usedPercent: used }] });
const OLD = { seats: [seat('Old Seat', 10)] };
const NEW = { seats: [seat('New Seat', 40)] };

const pages = [];
async function boot(over) {
  const p = await bootPage({ routes: routesFor({ 'GET /api/usage': () => OLD, 'GET /api/setup/clis': () => ({ clis: [], next: [] }), ...over }) });
  await settle(20);
  pages.push(p);
  return p;
}
const accounts = (p) => p.$('content').querySelector('.home-accounts');
const body = (p) => accounts(p).querySelector('.home-card-body');
const btn = (p) => accounts(p).querySelector('.home-refresh-usage');
const refreshes = (p) => p.requests.filter((r) => r.method === 'POST' && r.path === '/api/usage/refresh').length;

{
  const run = deferred();
  const p = await boot({ 'POST /api/usage/refresh': () => run.promise });
  ok('A6 the Accounts & usage card has a Refresh usage button', p.eval('S.view') === 'home' && btn(p) && p.text(btn(p)) === 'Refresh usage' && !btn(p).disabled);
  ok('…showing the stored reading first', /Old Seat/.test(p.text(body(p))));
  btn(p).click();
  await settle(5);
  ok('A6 one click → one POST /api/usage/refresh', refreshes(p) === 1);
  ok('A6 while it runs the button is disabled and visibly busy', btn(p).disabled === true && /Refreshing…/.test(p.text(btn(p))) && btn(p).querySelector('.spinner') && btn(p).getAttribute('aria-busy') === 'true');
  btn(p).click(); btn(p).click();
  p.eval('homeRefreshUsage()');
  await settle(5);
  ok('A6 more clicks while busy send nothing more (no storm)', refreshes(p) === 1, `${refreshes(p)} requests`);
  run.resolve({ ...NEW, fresh: true, at: Date.now() });
  await settle(10);
  ok('A6 on success the card re-renders from the answer', /New Seat/.test(p.text(body(p))) && !/Old Seat/.test(p.text(body(p))));
  ok('…the button is ready again, with no error shown', !btn(p).disabled && p.text(btn(p)) === 'Refresh usage' && !body(p).querySelector('.home-refresh-note'));
  ok('R11 Home\'s cached usage request is dropped after a refresh', p.eval('HOME.inflight.usage') === null);
  ok('no page errors', p.errors.length === 0, p.errors.join(' | '));
}
{
  const p = await boot({ 'POST /api/usage/refresh': () => ({ ...OLD, fresh: false, error: 'the usage reader exited 1', at: Date.now() }) });
  btn(p).click();
  await settle(10);
  const note = body(p).querySelector('.home-refresh-note');
  ok('A6 a refresh the server reports as not fresh shows inline, with the reason', note && /Not refreshed: the usage reader exited 1\. Showing the last stored reading\./.test(p.text(note)) && note.getAttribute('role') === 'alert');
  ok('…the stored reading is still shown, not "unavailable"', /Old Seat/.test(p.text(body(p))) && !/Usage unavailable/.test(p.text(body(p))));
  ok('…and the button is usable again', !btn(p).disabled);
}
{
  const p = await boot({ 'POST /api/usage/refresh': () => { throw { status: 500, body: { error: 'server exploded' } }; } });
  btn(p).click();
  await settle(10);
  ok('A6 an HTTP error shows inline in the card', /Not refreshed: server exploded\./.test(p.text(body(p))) && /Old Seat/.test(p.text(body(p))));
}
{
  const p = await boot({ 'POST /api/usage/refresh': () => new Promise(() => {}) });
  p.eval('USAGE_REFRESH.timeoutMs = 60');
  btn(p).click();
  await settle(5);
  ok('(busy while the request hangs)', btn(p).disabled === true);
  await settle(120);
  ok('A6 a request that never answers times out and says so, never a spinner left turning',
     /Not refreshed: the refresh did not answer within 0\.06s\./.test(p.text(body(p))) && !btn(p).disabled && !btn(p).querySelector('.spinner'), p.text(body(p)));
}
{
  // An older GET in flight when the refresh lands must not paint over it.
  let gets = 0;
  const firstGet = deferred();
  const run = deferred();
  const p = await boot({
    'GET /api/usage': () => (++gets === 1 ? OLD : firstGet.promise),
    'POST /api/usage/refresh': () => run.promise,
  });
  p.eval('HOME.settledAt = 0; renderContent()');
  await settle(5);
  btn(p).click();
  await settle(5);
  run.resolve({ ...NEW, fresh: true, at: Date.now() });
  await settle(10);
  firstGet.resolve(OLD);
  await settle(10);
  ok('R11 an older usage reading that lands after the refresh is dropped', /New Seat/.test(p.text(body(p))) && !/Old Seat/.test(p.text(body(p))), p.text(body(p)));
}
{
  const run = deferred();
  const p = await boot({ 'POST /api/usage/refresh': () => run.promise });
  btn(p).click();
  await settle(5);
  p.eval('openUsage()');
  await settle(10);
  const usageRefresh = p.$('content').querySelectorAll('button').find((b) => b.textContent === 'Refresh');
  usageRefresh.click();
  await settle(5);
  ok('R11 Usage\'s Refresh joins the one already in flight from Home', refreshes(p) === 1, `${refreshes(p)} requests`);
  run.resolve({ ...OLD, fresh: false, error: 'the usage reader timed out after 30s', at: Date.now() });
  await settle(20);
  ok('…and Usage reports a refresh that did not refresh', /Usage was not refreshed: the usage reader timed out after 30s/.test(p.text(p.$('notice-slot'))));
}

for (const p of pages) p.done();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
