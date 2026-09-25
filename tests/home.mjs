/**
 * Home (redesign PR B): the default view, its four cards loading on their own,
 * every Usage seat state, every attention source, and the rules that keep it
 * honest — a failed or pending source is never "Nothing needs you", and no
 * number appears that a route did not give.
 *
 * home.js and usage-view.js run pure in a VM; the whole page runs in the fake
 * DOM against stubbed routes (tests/fixtures/shell-page.mjs). No server, no HOME.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { bootPage, routesFor, registry, MEMORY, CONTEXT, PUB, ROOT, settle } from './fixtures/shell-page.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\nhome');

const pages = [];
const boot = async (o) => { const p = await bootPage(o); pages.push(p); return p; };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const card = (p, id) => p.$('content').querySelector(`.home-${id} .home-card-body`);
const H = Date.now() + 3_600_000;

// ── fixtures ────────────────────────────────────────────────────────────────
const SEATS = [
  { seatId: 'a', label: 'Codex (main)', vendor: 'codex', home: '/h/.codex', ok: true, planType: 'pro', observedAt: Date.now(),
    windows: [{ label: '5h rolling', usedPercent: 20, resetsAt: H }, { label: 'Weekly', usedPercent: 45.6, resetsAt: H }, { label: 'Odd custom window', usedPercent: 3 }] },
  { seatId: 'b', label: 'Claude Max', vendor: 'claude', ok: true, observedAt: Date.now(), windows: [{ label: '5-hour', usedPercent: 70 }] },
  { seatId: 'st', label: 'Grok', vendor: 'grok', ok: true, stale: true, observedAt: Date.now() - 3 * 3_600_000, windows: [{ label: 'Weekly', usedPercent: 1 }] },
  { seatId: 'nw', label: 'Codex (empty)', vendor: 'codex', home: '/h/x', ok: true, windows: [] },
  { seatId: 'off', label: 'Codex (work)', vendor: 'codex', home: '/h/.codex-seats/work', ok: false, signedIn: false, windows: [], reason: 'not signed in — run the login command' },
  { seatId: 'wait', label: 'Codex (spare)', vendor: 'codex', home: '/h/.codex-seats/spare', ok: false, signedIn: true, windows: [], reason: 'no turn yet' },
  { seatId: 'dup', label: 'Codex (dup)', vendor: 'codex', home: '/h/.codex-seats/dup', ok: false, signedIn: true, duplicateOf: 'a', windows: [], reason: 'same account as Codex (main)' },
  { seatId: 'nq', label: 'Grok (team)', vendor: 'grok', ok: false, signedIn: true, noQuota: true, windows: [], reason: 'no quota published' },
  { seatId: 'rolled', label: 'Codex (old)', vendor: 'codex', home: '/h/.codex-seats/old', ok: false, signedIn: true, windowRolledOver: true, windows: [], reason: 'rolled over' },
  { seatId: 'err', label: 'Claude (work)', vendor: 'claude', ok: false, windows: [], reason: 'reader threw: boom' },
];
const MODELS = { pending: 3, checkedAt: Date.now(), catalogs: [], rows: [
  { family: 'opus', alerts: [{ kind: 'update', candidate: 'next-opus-id', key: 'u1' }, { kind: 'update', candidate: 'old', key: 'u0', dismissed: true }] },
  { family: 'terra', alerts: [{ kind: 'retiring', date: '2026-12-01T00:00:00Z', key: 'r1' }] },
  { family: 'haiku', alerts: [{ kind: 'vanished', key: 'v1' }] },
  { family: 'fable', alerts: [] },
] };
const slug = (id) => ({ id, slug: `-gone-${id}`, state: 'missing' });
const link = (id) => ({ id, label: id, target: `${id}.md`, group: 'g1', line: 1, offer: 'remove', lineText: `- [${id}](${id}.md)` });
const unindexed = (id) => ({ id, row: 'r1', rel: `${id}.md`, group: 'g1' });
const MEMORY_DIRTY = { ...MEMORY, findings: { emptySlugs: [slug('e1'), slug('e2')], dangling: [link('d1')],
  unindexed: [unindexed('u1'), unindexed('u2'), unindexed('u3')], oversized: [{ group: 'g1', lines: 300, threshold: 200 }], orphans: [], duplicates: [] } };
const wt = (name, status, trunk = false) => ({ name, branch: name, env: 'linked', trunk,
  verdict: status === 'done' ? { status, via: 'merged' } : { status, reason: 'work left' } });
const proj = (key, worktrees) => ({ key, display: `~/p/${key}`, status: 'ok', notes: [], worktrees });
const WORKTREES = { projects: [
  proj('app', [wt('app', 'trunk', true), wt('a1', 'done'), wt('a2', 'done'), wt('a3', 'active')]),
  proj('site', [wt('s1', 'done')]),
  proj('quiet', [wt('q1', 'active')]),
] };
const CONTEXT_DRIFT = { ...CONTEXT, totals: { ...CONTEXT.totals, drifted: 2 } };
const CLEAN = {
  models: { pending: 0, rows: [{ family: 'opus', alerts: [{ kind: 'update', key: 'x', dismissed: true }] }] },
  memory: MEMORY,
  worktrees: { projects: [proj('app', [wt('a3', 'active')])] },
  context: CONTEXT,
};

// ── the pure layer, as the browser loads it ─────────────────────────────────
{
  const ctx = vm.createContext({});
  for (const f of ['usage-view.js', 'home.js']) vm.runInContext(fs.readFileSync(path.join(PUB, f), 'utf8'), ctx);
  const run = (code) => vm.runInContext(code, ctx);
  ctx.SEATS = SEATS;
  const acc = run('accountsModel({ seats: SEATS })');
  ok('9 one row per configured seat, not a fixed four', acc.rows.length === SEATS.length);
  ok('9 ranked the Usage way: most headroom first, unreadable seats last',
     acc.rows[0].id === 'a' && acc.rows[1].id === 'b' && acc.rows.slice(2).every((r) => r.id !== 'a' && r.id !== 'b'));
  ok('9 the route skips a stale reading even with the most headroom', acc.route.seat.seatId === 'a' && acc.route.left === 54);
  const a = acc.rows.find((r) => r.id === 'a');
  ok('9 percent left is 100 − the route\'s usedPercent, per window, any label, any count',
     JSON.stringify(a.windows.map((w) => [w.label, w.left])) === JSON.stringify([['5h rolling', 80], ['Weekly', 54], ['Odd custom window', 97]]));
  const kinds = Object.fromEntries(acc.rows.map((r) => [r.id, r.state.kind]));
  ok('9 every existing seat state is kept: reading, not connected, waiting, duplicate, no quota, rolled over',
     kinds.a === 'reading' && kinds.off === 'offline' && kinds.wait === 'waiting' && kinds.dup === 'duplicate' && kinds.nq === 'noQuota' && kinds.rolled === 'rolled' && kinds.err === 'offline');
  ok('9 …with the Usage panel\'s own words', acc.rows.find((r) => r.id === 'nq').state.tag === 'connected · no quota published'
     && acc.rows.find((r) => r.id === 'rolled').state.tag === 'signed in · reading out of date' && acc.rows.find((r) => r.id === 'dup').state.tag === 'duplicate account');
  ok('9 a seat with no reading carries no percentage at all', acc.rows.filter((r) => r.state.kind !== 'reading').every((r) => r.windows.length === 0));
  ok('9 a reading with no windows reports none, not a made-up one', acc.rows.find((r) => r.id === 'nw').windows.length === 0);
  ok('9 a stale reading is marked so', acc.rows.find((r) => r.id === 'st').stale === true && !acc.rows.find((r) => r.id === 'a').stale);
  ok('9 sign-in is offered where Usage offers it: not connected → sign in, duplicate → re-auth, waiting → none, non-Codex → none',
     acc.rows.find((r) => r.id === 'off').connect === 'signin' && acc.rows.find((r) => r.id === 'dup').connect === 'reauth'
     && acc.rows.find((r) => r.id === 'wait').connect === null && acc.rows.find((r) => r.id === 'err').connect === null);
  ok('9 no seat reporting headroom → no route', run(`accountsModel({ seats: SEATS.filter((s) => !s.ok || s.stale) })`).route === null);
  ok('9 a missing seats list is no seats, not a crash', run('accountsModel({})').rows.length === 0);

  const until = (min) => run(`untilText(Date.now() + ${min * 60_000})`);
  ok('reset times: 59.5 minutes reads "1h 0m", not "60m"', until(59.5) === '1h 0m', until(59.5));
  ok('reset times: 2h 59m 40s reads "3h 0m", not "2h 60m"', until(179 + 40 / 60) === '3h 0m', until(179 + 40 / 60));
  const sixty = [];
  for (let m = 0.5; m < 26 * 60; m += 0.25) if (/(^|\s)60m$|(^|\s)24h$/.test(until(m))) sixty.push(`${m}→${until(m)}`);
  ok('reset times: no duration from 30s to 26h ever reads 60m or 24h', sixty.length === 0, sixty.slice(0, 3).join(' '));
  ok('reset times: the Usage format is kept — minutes, h m, d h, resetting', until(12) === '12m' && until(125) === '2h 5m'
     && until(3 * 1440 + 125) === '3d 2h' && run('untilText(Date.now() - 1)') === 'resetting');

  ok('8 an HTTP 200 carrying `error` is a failure', run(`homeSource({ seats: [], error: 'boom' })`).state === 'error' && run('homeSource({ seats: [] })').state === 'ok');

  ctx.src = { models: { state: 'ok', data: MODELS }, memory: { state: 'ok', data: MEMORY_DIRTY }, worktrees: { state: 'ok', data: WORKTREES }, context: { state: 'ok', data: CONTEXT_DRIFT } };
  const att = run('attentionModel(src)');
  const texts = att.items.map((i) => i.text);
  ok('10 models: one line per live alert, dismissed ones left out, details from /api/models',
     att.items.filter((i) => i.source === 'models').length === 3 && texts.some((t) => /opus: a newer id is available — next-opus-id/.test(t))
     && texts.some((t) => /terra is retiring on/.test(t)) && texts.some((t) => /haiku is no longer offered/.test(t)) && !texts.some((t) => /— old$/.test(t)));
  ok('10 memory: a count per cleanup kind', ['2 empty project folders', '1 index link to', '3 memory files missing', '1 memory index over'].every((x) => texts.some((t) => t.startsWith(x))));
  ok('10 worktrees: the done count per project, trunk excluded, projects with none left out',
     texts.includes('app: 2 finished worktrees ready to remove') && texts.includes('site: 1 finished worktree ready to remove') && !texts.some((t) => t.startsWith('quiet')));
  ok('10 context: drifted files', texts.includes('2 context files drifted from trunk'));
  ok('10 each item names the view it opens', att.items.every((i) => ['models', 'memory', 'worktrees', 'context'].includes(i.action.view))
     && att.items.filter((i) => i.source === 'memory').every((i) => i.action.tab === 'cleanups'));
  ok('10 with items there is no empty state', att.clear === false);

  ctx.clean = Object.fromEntries(Object.entries(CLEAN).map(([k, v]) => [k, { state: 'ok', data: v }]));
  ok('10 every source succeeded with nothing → "Nothing needs you"', run('attentionModel(clean)').clear === true);
  ok('10 …but one still loading → no empty state', run(`attentionModel({ ...clean, memory: { state: 'loading' } })`).clear === false);
  ok('10 …one failed → no empty state, and the failure is listed', (() => {
    const m = run(`attentionModel({ ...clean, worktrees: { state: 'error', error: 'wclean timed out' } })`);
    return m.clear === false && m.failed[0].id === 'worktrees' && m.failed[0].error === 'wclean timed out';
  })());
  ok('10 …a project with unknown status → no empty state, and it is said', (() => {
    const m = run(`attentionModel({ ...clean, worktrees: { state: 'ok', data: { projects: [{ key: 'app', status: 'unknown', error: 'x' }] } } })`);
    return m.clear === false && /status unknown for app/.test(m.partial[0].text);
  })());
  ok('10 …a source never asked is loading, not clear', run('attentionModel({})').clear === false && run('attentionModel({})').loading.length === 4);

  ctx.harn = { harnesses: [{ id: 'claude', label: 'Claude', models: [{}, {}] }] };
  const cli = run(`cliModel(harn, { state: 'ok', data: { seats: SEATS } })`);
  ok('CLIs list only what the server detected, version and sign-in unknown (never inferred)',
     cli.rows.length === 1 && cli.rows[0].id === 'claude' && cli.rows[0].version === null && cli.rows[0].signedIn === null);
  ok('CLIs: Codex health comes from its Usage seats', cli.codex.state === 'ok' && cli.codex.seats === 6 && cli.codex.reading === 2 && cli.codex.signIn === 2);
  ok('CLIs: Usage failing makes Codex unavailable, not zero', run(`cliModel(harn, { state: 'error', error: 'x' })`).codex.state === 'error');

  const rec = run(`recentModel({ items: [1,2,3,4,5,6].map((i) => ({ id: 't' + i, display: '~/x' + i, deletedAt: 0 })) }, { commits: 9, lastSubject: 'save x', lastAt: 5 })`);
  ok('Recent: trash entries plus the last history summary only', rec.trash.length === 4 && rec.more === 2 && rec.last.subject === 'save x' && rec.last.commits === 9);
  ok('Recent: no history yet → no summary', run('recentModel({ items: [] }, { commits: 0 })').last === null);
}

// ── 8. Home is the default view; cards render independently ──────────────
const homeRoutes = (over = {}) => routesFor({
  'GET /api/usage': () => ({ seats: SEATS }),
  'GET /api/models': () => MODELS,
  'GET /api/memory': () => MEMORY_DIRTY,
  'GET /api/worktree': () => WORKTREES,
  'GET /api/context': () => CONTEXT_DRIFT,
  'GET /api/trash': () => ({ items: [{ id: 't1', display: '~/.claude/skills/old', deletedAt: Date.now() - 60_000 }] }),
  ...over,
});
{
  const p = await boot({ routes: homeRoutes() });
  await settle(20);
  ok('8 with no hash, Home is the view and the sidebar marks it', p.eval('S.view') === 'home' && p.$('btn-home').getAttribute('aria-current') === 'page');
  ok('8 all four cards are there', ['accounts', 'attention', 'clis', 'recent'].every((id) => card(p, id)));
  ok('8 the topbar says Home', p.text(p.$('title')) === 'Home');
  ok('8 no page errors', p.errors.length === 0, p.errors.join(' | '));
}
{
  // Each source fails its own way; every other card still renders.
  const p = await boot({ routes: homeRoutes({
    'GET /api/usage': () => ({ seats: [], error: 'the usage snapshot is unreadable' }),
    'GET /api/models': () => { throw { status: 500, body: { error: 'catalog read failed' } }; },
    'GET /api/trash': () => { throw { status: 503, body: { error: 'trash offline' } }; },
    'GET /api/harnesses': () => { throw { status: 500, body: { error: 'detect failed' } }; },
  }) });
  await settle(20);
  const acc = p.text(card(p, 'accounts'));
  ok('8 Usage answering 200 with `error` shows "unavailable" on its card, not "No subscriptions"',
     /Usage unavailable: the usage snapshot is unreadable/.test(acc) && !/No subscriptions/.test(acc) && !/% left/.test(acc));
  const att = p.text(card(p, 'attention'));
  ok('8 Models failing shows on Needs attention, whose other sources still list their items',
     /Models unavailable: catalog read failed/.test(att) && /empty project folders/.test(att) && /finished worktree/.test(att) && !/Nothing needs you/.test(att));
  ok('8 Trash failing shows on Recent, with the history summary still there', /Trash unavailable: trash offline/.test(p.text(card(p, 'recent'))) && /save CLAUDE.md/.test(p.text(card(p, 'recent'))));
  ok('8 detection failing shows on CLIs, and Codex still reports (unavailable, from the failed Usage)',
     /Detection unavailable: detect failed/.test(p.text(card(p, 'clis'))) && /Usage unavailable/.test(p.text(card(p, 'clis'))));
  ok('8 a failing card never raises a page error or a notice', p.errors.length === 0 && p.text(p.$('notice-slot')) === '', p.errors.join(' | '));
}
{
  // A slow source spins on its own card; first paint does not wait for the memory index or wclean.
  const mem = deferred(), wt = deferred(), reg = deferred();
  const routes = homeRoutes({ 'GET /api/memory': () => mem.promise, 'GET /api/worktree': () => wt.promise, 'GET /api/registry': () => reg.promise });
  const p = await boot({ routes });
  ok('8 the shell and Home paint before the registry resolves', p.eval('S.registry') === null && !!card(p, 'accounts') && p.$('sidebar').querySelectorAll('.nav-item').length === 12);
  ok('11 the memory index and wclean are asked after first paint, not before it',
     !p.requests.some((r) => r.path === '/api/memory' || r.path === '/api/worktree') || p.requests.findIndex((r) => r.path === '/api/memory') > p.requests.findIndex((r) => r.path === '/api/usage'));
  await settle(20);
  ok('8 while they are slow, the fast cards are filled', /Codex \(main\)/.test(p.text(card(p, 'accounts'))) && /opus: a newer id/.test(p.text(card(p, 'attention'))));
  ok('8 …and Needs attention says what it is still checking', /Checking memory, worktrees/.test(p.text(card(p, 'attention'))) && !/Nothing needs you/.test(p.text(card(p, 'attention'))));
  ok('8 Recent waits for the registry for its history line only', /Reading history/.test(p.text(card(p, 'recent'))) && /~\/\.claude\/skills\/old/.test(p.text(card(p, 'recent'))));
  ok('11 the first-paint time is recorded before everything has answered', p.eval('HOME.timing.painted') >= 0 && p.eval('HOME.timing.settled') === null);
  reg.resolve(registry());
  await settle(10);
  ok('8 the registry landing fills Recent\'s history line', /save CLAUDE.md/.test(p.text(card(p, 'recent'))));
  mem.resolve(MEMORY_DIRTY);
  wt.resolve(WORKTREES);
  await settle(10);
  ok('8 the slow sources land on their card', /empty project folders/.test(p.text(card(p, 'attention'))) && /app: 2 finished worktrees/.test(p.text(card(p, 'attention'))) && !/Checking/.test(p.text(card(p, 'attention'))));
  ok('11 …and all-cards-loaded is recorded after first paint', p.eval('HOME.timing.settled') >= p.eval('HOME.timing.painted'));
}
{
  // Late answers after you navigate away are dropped.
  const usage = deferred();
  const p = await boot({ routes: homeRoutes({ 'GET /api/usage': () => usage.promise }) });
  await settle(10);
  p.$('btn-skills').click();
  await settle(5);
  usage.resolve({ seats: SEATS });
  await settle(10);
  ok('8 an answer that lands after you left Home is dropped — nothing painted into Skills',
     p.eval('S.view') === 'skills' && !p.$('content').querySelector('.home-card') && p.eval('HOME.src.usage.state') === 'loading');
  p.$('btn-home').click();
  await settle(20);
  ok('8 coming back asks again and paints', /Codex \(main\)/.test(p.text(card(p, 'accounts'))));
}
{
  // A card refresh never clears a sticky warning.
  const p = await boot({ routes: homeRoutes() });
  await settle(20);
  p.eval(`notice('warn', 'sticky thing', null, true)`);
  p.$('content').querySelectorAll('button').find((b) => b.textContent === 'Refresh').click();
  await settle(20);
  ok('8 Refresh re-asks the sources and keeps a sticky warning', /sticky thing/.test(p.text(p.$('notice-slot')))
     && p.requests.filter((r) => r.path === '/api/memory').length === 2);
  const before = p.requests.length;
  p.$('btn-skills').click();
  await settle(5);
  p.$('btn-home').click();
  await settle(10);
  ok('8 revisiting Home within 30s repaints what it has without asking again', p.requests.slice(before).every((r) => r.path !== '/api/memory') && /Codex \(main\)/.test(p.text(card(p, 'accounts'))));
}

// ── 9. the Accounts card on the page; Connect goes to Usage ──────────────
{
  const p = await boot({ routes: homeRoutes() });
  await settle(20);
  const rows = p.$('content').querySelectorAll('.home-seat');
  ok('9 the card shows one row per seat', rows.length === SEATS.length, `${rows.length}`);
  const row = (id) => rows.find((r) => r.dataset.seat === id);
  ok('9 the percentages shown are the route\'s, as percent left', /80% left/.test(p.text(row('a'))) && /54% left/.test(p.text(row('a'))) && /97% left/.test(p.text(row('a'))) && /30% left/.test(p.text(row('b'))));
  ok('9 no number on a seat the route gave none for', ['off', 'wait', 'dup', 'nq', 'rolled', 'err', 'nw'].every((id) => !/\d+%/.test(p.text(row(id)))));
  ok('9 the route line names the seat Usage would', /Route to\s*Codex \(main\)\s*54% left/.test(p.text(card(p, 'accounts'))));
  ok('9 a stale reading says it is not current', /not current/.test(p.text(row('st'))));
  ok('9 each state reads as Usage says it', /not connected/.test(p.text(row('off'))) && /signed in · no usage yet/.test(p.text(row('wait')))
     && /duplicate account/.test(p.text(row('dup'))) && /no quota published/.test(p.text(row('nq'))) && /reading out of date/.test(p.text(row('rolled'))));
  ok('9 Connect only where Usage offers a sign-in', !!row('off').querySelector('.home-seat-act .btn') && /Sign in again/.test(p.text(row('dup')))
     && !row('wait').querySelector('.home-seat-act .btn') && !row('err').querySelector('.home-seat-act .btn'));
  row('off').querySelector('.home-seat-act .btn').click();
  await settle(20);
  const focused = p.$('content').querySelectorAll('.usage-seat').find((c) => c.classList.contains('usage-seat-focus'));
  ok('9 Connect goes to Usage and reveals that seat, focused on its sign-in', p.eval('S.view') === 'usage' && focused?.dataset.seat === 'off'
     && p.doc.activeElement?.textContent === 'Sign in with ChatGPT');
  ok('9 …and does not start the sign-in on its own', !p.requests.some((r) => r.path === '/api/usage/connect'));

  p.$('btn-home').click();
  await settle(20);
  p.$('content').querySelectorAll('.home-accounts .home-card-tools button').find((b) => b.textContent === 'Add account').click();
  await settle(20);
  ok('9 Add account goes to Usage with the Add form open and focused', p.eval('S.view') === 'usage' && !!p.$('content').querySelector('.usage-add')
     && p.doc.activeElement === p.$('content').querySelector('.usage-add-label'));

  const empty = await boot({ routes: homeRoutes({ 'GET /api/usage': () => ({ seats: [] }) }) });
  await settle(20);
  ok('9 no seats at all → an honest empty state with Add account', /No subscriptions tracked yet/.test(p.text(card(empty, 'accounts'))) && !/% left/.test(p.text(card(empty, 'accounts'))));
}
{
  // No new credential access in anything this redesign added.
  const files = ['home.js', 'usage-view.js'].map((f) => fs.readFileSync(path.join(PUB, f), 'utf8'));
  const app = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  files.push(app.slice(app.indexOf('/* ── Home view'), app.indexOf('/* ── MCP view')));
  files.push(app.slice(app.indexOf('/* ── navigation'), app.indexOf('/* ── opening files')));
  const bad = files.flatMap((t) => t.match(/auth\.json|credentials?\b|keychain|security find|\btokens?\b|oauth/gi) || []);
  ok('9 no token, credential or keychain reads in the new code', bad.length === 0, bad.join(' '));
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok('9 Home calls existing routes only — every one it asks is a server route', ['/api/usage', '/api/models', '/api/context', '/api/trash', '/api/harnesses', '/api/memory', '/api/worktree']
    .every((r) => server.includes(`'GET ${r}'`)));
}

// ── 10. Needs attention on the page: every button opens the right view ──
{
  const p = await boot({ routes: homeRoutes() });
  await settle(20);
  const items = () => p.$('content').querySelectorAll('.home-item');
  const expect = { 'opus: a newer id': 'models', 'terra is retiring': 'models', 'haiku is no longer': 'models',
    '2 empty project folders': 'memory', '1 index link': 'memory', '3 memory files': 'memory', '1 memory index': 'memory',
    'app: 2 finished': 'worktrees', 'site: 1 finished': 'worktrees', '2 context files drifted': 'context' };
  ok('10 every item type is listed', items().length === Object.keys(expect).length, items().map((i) => p.text(i)).join(' / '));
  let right = 0;
  for (const [start, view] of Object.entries(expect)) {
    p.$('btn-home').click();
    await settle(10);
    const it = items().find((i) => p.text(i).startsWith(start));
    it?.querySelector('button').click();
    await settle(10);
    if (p.eval('S.view') === view && (view !== 'memory' || p.eval('MV.tab') === 'cleanups')) right++;
    else console.log(`    ${start} → ${p.eval('S.view')}`);
  }
  ok('10 each button opens its view (memory ones on Cleanups)', right === Object.keys(expect).length, `${right}`);

  const clean = await boot({ routes: homeRoutes(Object.fromEntries(Object.entries(CLEAN).map(([k, v]) => [`GET /api/${k === 'worktrees' ? 'worktree' : k}`, () => v]))) });
  await settle(20);
  ok('10 the empty state appears when every source succeeded with nothing', /Nothing needs you/.test(p.text(card(clean, 'attention'))) && !clean.$('content').querySelector('.home-item'));
  const oneDown = await boot({ routes: homeRoutes({ ...Object.fromEntries(Object.entries(CLEAN).map(([k, v]) => [`GET /api/${k === 'worktrees' ? 'worktree' : k}`, () => v])),
    'GET /api/context': () => { throw { status: 500, body: { error: 'walk failed' } }; } }) });
  await settle(20);
  ok('10 …and not when one source failed', !/Nothing needs you/.test(p.text(card(oneDown, 'attention'))) && /Context unavailable: walk failed/.test(p.text(card(oneDown, 'attention'))));
  ok('10 the Models badge follows /api/models', p.text(p.$('btn-models').querySelector('.nav-badge')) === '3');
}

for (const p of pages) p.done();
const stray = pages.flatMap((p) => p.errors);
ok('no page errors across every page booted', stray.length === 0, stray.slice(0, 3).join(' | '));
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
