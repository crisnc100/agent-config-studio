/**
 * The setup screen in the page (builds/setup-screen criteria 1, 2, 4, 6, S14,
 * S15), in the node VM against stubbed routes (tests/fixtures/shell-page.mjs).
 * No server, no HOME.
 *
 *   1 / S14  boot lands on #setup only with no setup.json, only as the default
 *            landing, and only if nobody navigated meanwhile; a deep link wins;
 *            a reload mid-setup returns to its step; a malformed setup.json is
 *            a notice, never a redirect loop; Skip and Finish write it; a
 *            failed Finish keeps you on setup with the error
 *   2        the CLI cards show the route's versions, sign-in and commands;
 *            Recheck repaints them without a reload
 *   4        suggestions are never added without a click; the Codex sign-in
 *            polls from setup and shows the unchecked warning
 *   6        no scan request on load or on opening the step — only on the click;
 *            switching to edit asks a confirm naming the real path, a cancel
 *            leaves it read and sends nothing
 *   S15      Finish forgets Home's caches; Home shows the folder count, each
 *            CLI's state, and links back to setup
 */
import { bootPage, routesFor, settle } from './fixtures/shell-page.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const pages = [];
const boot = async (o) => { const p = await bootPage(o); pages.push(p); return p; };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const btn = (p, text, root = p.$('content')) => root.querySelectorAll('button').find((b) => b.textContent === text);

const CLIS = (over = {}) => ({
  clis: [
    { id: 'claude', label: 'Claude Code', installed: true, binary: '~/.local/bin/claude', version: '2.1.0 (Claude Code)',
      signIn: { state: 'unknown', label: 'unknown — refresh', detail: null }, fix: { signIn: 'claude auth login' } },
    { id: 'codex', label: 'Codex', installed: true, binary: '/opt/homebrew/bin/codex', version: 'codex-cli 0.1',
      signIn: { state: 'present', label: 'credentials present', detail: 'in ~/.codex' }, fix: {} },
    { id: 'grok', label: 'Grok', installed: false, binary: null, version: null,
      signIn: { state: 'none', label: 'not signed in', detail: null }, fix: { install: 'curl -fsSL https://x.ai/cli/install.sh | bash' } },
  ],
  acsOnPath: false,
  next: [
    { key: 'next.model-id', command: '/src/acs/bin/acs install-model-id', note: 'Lets skills resolve model ids.', platforms: null },
    { key: 'next.worktree', command: '/src/acs/bin/acs install-worktree', note: 'The worktree helpers.', platforms: 'zsh/macOS only' },
  ],
  ...over,
});
const ROOTS = (roots = []) => ({ state: 'ok', error: null, file: '~/.agent-config-studio/roots.json', roots, invalid: [], addHint: 'acs roots add <path>' });

/** Stubs for every setup route, with a writable setup state. */
function setupRoutes(over = {}) {
  const st = { setup: { state: 'none' }, seats: [], roots: [], clis: CLIS() };
  const routes = routesFor({
    'GET /api/setup/status': () => st.setup,
    'POST /api/setup/complete': (b) => { st.setup = { state: b.completed }; return st.setup; },
    'GET /api/setup/clis': () => st.clis,
    'GET /api/setup/accounts': () => ({ suggestions: [
      { key: 'codex', vendor: 'codex', label: 'Codex (primary)', home: '~/.codex', added: st.seats.some((s) => s.vendor === 'codex'), seatId: null },
      { key: 'claude', vendor: 'claude', label: 'Claude', home: null, added: false, seatId: null },
    ] }),
    'POST /api/setup/seats': (b) => {
      const seat = { id: b.key || b.vendor, vendor: b.key || b.vendor, label: b.label || 'Codex (primary)', home: '/h/.codex' };
      st.seats.push(seat);
      return { seat, already: false };
    },
    'GET /api/usage': () => ({ seats: st.seats.map((s) => ({ seatId: s.id, label: s.label, vendor: s.vendor, home: s.home, ok: false, signedIn: false, windows: [], reason: 'not signed in' })) }),
    'POST /api/usage/refresh': () => ({ seats: [] }),
    // A login as the server keeps one: running from the start until signed in.
    'POST /api/usage/connect': () => { st.login = { url: 'https://auth.openai.com/oauth/authorize?x=1', unchecked: 'lsof is not installed, so running Codex sessions cannot be detected — quit any Codex session using this seat before signing in, or it may undo the sign-in' }; return st.login; },
    'POST /api/usage/connect/state': () => (st.login
      ? { signedIn: !!st.signedIn, running: !st.signedIn, url: st.signedIn ? null : st.login.url, unchecked: st.login.unchecked }
      : { signedIn: false, running: false, url: null }),
    'GET /api/roots': () => ROOTS(st.roots),
    'GET /api/setup/scan': () => ({ suggestions: [
      { path: '/h/code/work', display: '~/code/work', repos: 2, contextFiles: 1, status: 'new' },
      { path: '/h/code/old', display: '~/code/old', repos: 1, contextFiles: 0, status: 'covered', coveredBy: '~/code' },
    ], blocked: [{ path: '~/Documents/locked', reason: 'permission denied — macOS may ask for access' }], truncated: false, scanned: {} }),
    'POST /api/roots/preview': (b) => ({ canonical: `/real${b.path}`, display: '~/real/work', typed: b.path, label: 'work', access: { edit: null, read: null }, grants: 'The studio may now open, save…' }),
    'POST /api/roots/add': (b) => {
      const r = { id: 'work', label: 'work', access: b.access, status: 'ok', display: '~/code/work' };
      st.roots.push(r);
      return { added: r, roots: ROOTS(st.roots) };
    },
    ...over,
  });
  routes.st = st;
  return routes;
}

console.log('\nsetup in the page');

/* ── 1 / S14: boot routing ─────────────────────────────────────────────── */
{
  const p = await boot({ routes: setupRoutes() });
  await settle(20);
  ok('1 with no setup.json, the default landing opens #setup', p.eval('S.view') === 'setup' && /^#setup&step=clis$/.test(p.location.hash), `${p.eval('S.view')} ${p.location.hash}`);
  ok('1 …with no sidebar item for it (the nav count stays 12)', p.$('sidebar').querySelectorAll('.nav-item').length === 12);
  ok('6 no scan request on page load', !p.requests.some((r) => r.path === '/api/setup/scan'));
  ok('no page errors', p.errors.length === 0, p.errors.join(' | '));
}
{
  const routes = setupRoutes();
  routes.st.setup = { state: 'migrated' };
  const p = await boot({ routes });
  await settle(20);
  ok('1 with setup.json present (migrated), it lands on Home', p.eval('S.view') === 'home');
}
{
  const p = await boot({ routes: setupRoutes(), hash: '#skills' });
  await settle(20);
  ok('1 a deep link to another view still works on first run', p.eval('S.view') === 'skills');
}
{
  const gate = deferred();
  const p = await boot({ routes: setupRoutes({ 'GET /api/setup/status': () => gate.promise }) });
  await settle(10);
  p.$('btn-files').click();
  await settle(5);
  gate.resolve({ state: 'none' });
  await settle(20);
  ok('S14 navigating before the status answers cancels the redirect', p.eval('S.view') === 'files', p.eval('S.view'));
}
{
  const p = await boot({ routes: setupRoutes(), hash: '#setup&step=folders' });
  await settle(20);
  ok('S14 a reload mid-setup returns to its step', p.eval('S.view') === 'setup' && p.eval('SETUP.step') === 'folders' && /Project folders/.test(p.text(p.$('content'))));
  ok('6 opening the folders step does not scan either', !p.requests.some((r) => r.path === '/api/setup/scan'));
}
{
  const routes = setupRoutes();
  routes.st.setup = { state: 'error', error: 'setup.json is not valid: Unexpected end of JSON input' };
  const p = await boot({ routes });
  await settle(20);
  ok('S14 a malformed setup.json: no redirect, a notice on Home', p.eval('S.view') === 'home' && /setup.json is not valid/.test(p.text(p.$('notice-slot'))));
  p.eval("openSetup()");
  await settle(20);
  ok('S14 …setup itself says so and offers to rewrite it', /not valid/.test(p.text(p.$('content'))) && !!btn(p, 'Rewrite it as done'));
  btn(p, 'Rewrite it as done').click();
  await settle(20);
  ok('S14 …which writes completed: done and stays put', routes.st.setup.state === 'done' && p.eval('S.view') === 'setup'
     && p.requests.some((r) => r.path === '/api/setup/complete' && r.body.completed === 'done'));
}
{
  const routes = setupRoutes();
  const p = await boot({ routes });
  await settle(20);
  btn(p, 'Skip setup').click();
  await settle(20);
  ok('1 Skip writes completed: skipped and lands on Home', routes.st.setup.state === 'skipped' && p.eval('S.view') === 'home');
  p.eval("openSetup()");
  await settle(20);
  ok('1 #setup is reachable afterwards', p.eval('S.view') === 'setup');
  const writes = p.requests.filter((r) => r.method === 'POST' && r.path !== '/api/setup/complete').length;
  ok('1 …and re-running changes nothing until the user acts (no write on open)', writes === 0, String(writes));
}
{
  const routes = setupRoutes({ 'POST /api/setup/complete': () => { throw { status: 500, body: { error: 'setup.json could not be written: EACCES' } }; } });
  const p = await boot({ routes, hash: '#setup&step=done' });
  await settle(20);
  btn(p, 'Finish').click();
  await settle(20);
  ok('S14 a failed Finish keeps you on setup with the error', p.eval('S.view') === 'setup' && /could not be saved: setup.json could not be written: EACCES/.test(p.text(p.$('notice-slot'))));
}

/* ── 2: the CLI cards ──────────────────────────────────────────────────── */
{
  const routes = setupRoutes();
  const p = await boot({ routes });
  await settle(20);
  const card = (id) => p.$('content').querySelector(`[data-cli="${id}"]`);
  ok('2 each card shows installed and its version', /installed/.test(p.text(card('claude'))) && /2\.1\.0 \(Claude Code\)/.test(p.text(card('claude'))) && /codex-cli 0\.1/.test(p.text(card('codex'))));
  ok('2 sign-in is the route\'s wording', /sign-in: unknown — refresh/.test(p.text(card('claude'))) && /sign-in: credentials present/.test(p.text(card('codex'))));
  ok('2 a missing CLI shows not installed with the route\'s install command', /not installed/.test(p.text(card('grok'))) && /curl -fsSL https:\/\/x\.ai\/cli\/install\.sh \| bash/.test(p.text(card('grok'))));
  ok('2 a CLI needing sign-in shows the route\'s sign-in command', /claude auth login/.test(p.text(card('claude'))));
  routes.st.clis = CLIS({ clis: CLIS().clis.map((c) => (c.id === 'grok' ? { ...c, installed: true, version: 'grok 1.0', binary: '~/.grok/bin/grok', signIn: { state: 'present', label: 'credentials present' }, fix: {} } : c)) });
  btn(p, 'Recheck').click();
  await settle(20);
  ok('2 Recheck asks again with recheck=1 and turns the card green without a reload',
     p.requests.some((r) => r.path === '/api/setup/clis' && r.search === '?recheck=1') && /installed/.test(p.text(card('grok'))) && !/not installed/.test(p.text(card('grok'))) && /grok 1\.0/.test(p.text(card('grok'))));
}

/* ── 4: accounts ───────────────────────────────────────────────────────── */
{
  const routes = setupRoutes();
  const p = await boot({ routes, hash: '#setup&step=accounts' });
  await settle(20);
  const content = () => p.text(p.$('content'));
  ok('4 suggestions appear', /Codex \(primary\)/.test(content()) && /~\/\.codex/.test(content()) && /Claude/.test(content()));
  ok('4 …and none is added without a click', !p.requests.some((r) => r.path === '/api/setup/seats'));
  ok('S2 the manual "Add an account" is always there', /Add an account/.test(content()));
  p.$('content').querySelector('[data-suggestion="codex"] button').click();
  await settle(20);
  ok('4 clicking Add sends exactly that suggestion\'s key', p.requests.some((r) => r.path === '/api/setup/seats' && r.body.key === 'codex' && !r.body.home));
  ok('4 …then it reads added, and the seat is listed with its state', /added/.test(p.text(p.$('content').querySelector('[data-suggestion="codex"]'))) && !!p.$('content').querySelector('[data-seat="codex"]'));
  const signIn = btn(p, 'Sign in with ChatGPT');
  ok('4 a codex seat not signed in offers the in-browser sign-in', !!signIn);
  signIn.click();
  await settle(30);
  ok('S7 the unchecked warning is shown in setup', /lsof is not installed/.test(content()));
  await new Promise((r) => setTimeout(r, 2200));
  ok('4 setup polls connect/state itself while it is open', p.requests.some((r) => r.path === '/api/usage/connect/state'));
  btn(p, 'Refresh').click();
  await settle(20);
  ok('4 Refresh calls /api/usage/refresh and repaints', p.requests.some((r) => r.path === '/api/usage/refresh'));
  p.$('btn-skills').click();
  const n = p.requests.filter((r) => r.path === '/api/usage/connect/state').length;
  await new Promise((r) => setTimeout(r, 2200));
  ok('4 …and stops polling once setup is left', p.requests.filter((r) => r.path === '/api/usage/connect/state').length === n);
}

/* ── 4: the login poller belongs to the row on screen ─────────────────── */
{
  const routes = setupRoutes();
  routes.st.seats.push({ id: 'codex', vendor: 'codex', label: 'Codex (primary)', home: '/h/.codex' });
  const p = await boot({ routes, hash: '#setup&step=accounts' });
  await settle(30);
  btn(p, 'Sign in with ChatGPT').click();
  await settle(30);
  btn(p, 'Next').click();
  await settle(30);
  btn(p, 'Back').click();
  await settle(40);
  const row = () => p.$('content').querySelector('.usage-hint');
  ok('4 Next then Back: the login in flight is shown again — its link and warning, the button not offered twice',
     /Open the sign-in page/.test(p.text(row())) && /lsof is not installed/.test(p.text(row())) && btn(p, 'Sign in with ChatGPT')?.disabled === true, p.text(row()));
  ok('4 …with exactly one poller for the seat', p.eval('LOGIN_POLLS.size') === 1);
  const before = p.requests.filter((r) => r.path === '/api/usage/connect/state').length;
  await new Promise((r) => setTimeout(r, 4300));
  const ticks = p.requests.filter((r) => r.path === '/api/usage/connect/state').length - before;
  ok('4 …polling once per tick (2 polls in two ticks, not 3)', ticks === 2, String(ticks));
  p.$('btn-skills').click();
  await new Promise((r) => setTimeout(r, 2200));
  ok('4 leaving setup stops it', p.eval('LOGIN_POLLS.size') === 0);
}
{
  // A signed-in answer still in flight when the person moves to Skills.
  const routes = setupRoutes();
  routes.st.seats.push({ id: 'codex', vendor: 'codex', label: 'Codex (primary)', home: '/h/.codex' });
  let hold = null;
  const base = routes.table['POST /api/usage/connect/state'];
  routes.table['POST /api/usage/connect/state'] = (b) => {
    if (routes.st.login && !hold) { hold = deferred(); return hold.promise; }
    return base(b);
  };
  const p = await boot({ routes, hash: '#setup&step=accounts' });
  await settle(30);
  btn(p, 'Sign in with ChatGPT').click();
  await new Promise((r) => setTimeout(r, 2200));
  ok('4 (a poll is out)', !!hold);
  p.$('btn-skills').click();
  await settle(10);
  hold.resolve({ signedIn: true, running: false, url: null });
  await settle(40);
  ok('4 a signed-in answer released after moving to Skills posts no refresh and shows no notice',
     !p.requests.some((r) => r.path === '/api/usage/refresh') && !/is signed in/.test(p.text(p.$('notice-slot'))) && p.eval('S.view') === 'skills');
}

{
  // A connect answer held until after Next, Back: the new row has resumed the
  // login; the old, detached row's late answer must not take or stop it.
  const routes = setupRoutes();
  routes.st.seats.push({ id: 'codex', vendor: 'codex', label: 'Codex (primary)', home: '/h/.codex' });
  let release;
  const connect = routes.table['POST /api/usage/connect'];
  routes.table['POST /api/usage/connect'] = (b) => { const res = connect(b); return new Promise((r) => { release = () => r(res); }); };
  const p = await boot({ routes, hash: '#setup&step=accounts' });
  await settle(30);
  btn(p, 'Sign in with ChatGPT').click();
  await settle(20);
  btn(p, 'Next').click();
  await settle(30);
  btn(p, 'Back').click();
  await settle(40);
  ok('4 (the new row resumed the login while the old answer was still out)', p.eval('LOGIN_POLLS.size') === 1);
  release();
  await settle(40);
  const row = () => p.$('content').querySelector('.usage-hint');
  ok('4 a late connect answer for a detached row leaves exactly one live poller, owned by the row on screen',
     p.eval('LOGIN_POLLS.size') === 1 && p.eval("document.body.contains([...LOGIN_POLLS.values()][0].row)"), String(p.eval('LOGIN_POLLS.size')));
  ok('4 …and the visible row is progressing (its link shown), not stuck disabled with nothing behind it',
     /Open the sign-in page/.test(p.text(row())) && /waiting/.test(p.text(row())), p.text(row()));
  const before = p.requests.filter((r) => r.path === '/api/usage/connect/state').length;
  await new Promise((r) => setTimeout(r, 2200));
  ok('4 …which keeps polling', p.requests.filter((r) => r.path === '/api/usage/connect/state').length > before);
  p.$('btn-skills').click();
}
{
  // The sign-in finishes while the person is on Folders.
  const routes = setupRoutes();
  routes.st.seats.push({ id: 'codex', vendor: 'codex', label: 'Codex (primary)', home: '/h/.codex' });
  const p = await boot({ routes, hash: '#setup&step=accounts' });
  await settle(30);
  btn(p, 'Sign in with ChatGPT').click();
  await settle(30);
  btn(p, 'Next').click();
  await new Promise((r) => setTimeout(r, 2300));
  ok('4 (on Folders, no poller is left running)', p.eval('LOGIN_POLLS.size') === 0);
  routes.st.signedIn = true;
  const usageBefore = p.requests.filter((r) => r.path === '/api/usage').length;
  btn(p, 'Back').click();
  await settle(60);
  const refreshes = p.requests.filter((r) => r.path === '/api/usage/refresh').length;
  ok('4 back on Accounts, a sign-in that finished off-screen is reconciled: usage re-read, one refresh, the signed-in notice',
     p.requests.filter((r) => r.path === '/api/usage').length > usageBefore && refreshes === 1 && /is signed in/.test(p.text(p.$('notice-slot'))), `refreshes=${refreshes} ${p.text(p.$('notice-slot'))}`);
  ok('4 …and no fresh sign-in button is offered over the completed login', !btn(p, 'Sign in with ChatGPT') && /signed in/.test(p.text(p.$('content').querySelector('.usage-hint'))));
  await settle(60);
  ok('4 …the refresh happens once, not on every repaint', p.requests.filter((r) => r.path === '/api/usage/refresh').length === 1);
  p.$('btn-skills').click();
}

/* ── P2: every async answer proves it still owns the screen ─────────────── */
{
  // Home's first /api/roots answer is held; setup adds a folder and finishes; then the old answer lands.
  const routes = setupRoutes();
  routes.st.setup = { state: 'done' };
  let first = null;
  const roots = routes.table['GET /api/roots'];
  routes.table['GET /api/roots'] = () => { if (!first) { first = deferred(); return first.promise; } return roots(); };
  const p = await boot({ routes });
  await settle(30);
  btn(p, 'Run setup again').click();
  await settle(20);
  routes.st.roots.push({ id: 'work', label: 'Work', access: 'edit', status: 'ok', display: '~/code/work' });
  p.eval("setupGo('done')");
  await settle(20);
  btn(p, 'Finish').click();
  await settle(40);
  ok('S15 after Finish, Home shows the new folder', /Project folders: 1 \(edit\)/.test(p.text(p.$('content'))), p.text(p.$('content')).slice(0, 120));
  first.resolve(ROOTS([]));
  await settle(40);
  ok('S15 …and the old, held /api/roots answer cannot paint over it', /Project folders: 1 \(edit\)/.test(p.text(p.$('content'))), p.text(p.$('content')).slice(0, 120));
}
{
  // The boot status is held at "none"; the person runs setup from Home and finishes; then it lands.
  const routes = setupRoutes();
  let gate = null;
  routes.table['GET /api/setup/status'] = () => { if (!gate) { gate = deferred(); return gate.promise; } return routes.st.setup; };
  const p = await boot({ routes });
  await settle(30);
  btn(p, 'Run setup again').click();
  await settle(20);
  p.eval("setupGo('done')");
  await settle(20);
  btn(p, 'Finish').click();
  await settle(30);
  gate.resolve({ state: 'none' });
  await settle(40);
  ok('S14 a stale boot status, released after Run setup again + Finish, leaves you on Home', p.eval('S.view') === 'home' && p.location.hash === '#home', `${p.eval('S.view')} ${p.location.hash}`);
}

/* ── 6: folders ────────────────────────────────────────────────────────── */
{
  const routes = setupRoutes();
  const p = await boot({ routes, hash: '#setup&step=folders' });
  await settle(20);
  ok('6 the scan button warns about the macOS prompt before it runs', /macOS, reading ~\/Documents can make your terminal ask/.test(p.text(p.$('content'))));
  btn(p, 'Scan for projects').click();
  await settle(20);
  ok('6 the scan runs on the click', p.requests.filter((r) => r.path === '/api/setup/scan').length === 1);
  const row = p.$('content').querySelector('[data-folder="~/code/work"]');
  ok('6 suggestions show their counts', /2 repos · 1 with CLAUDE\.md \/ AGENTS\.md/.test(p.text(row)));
  ok('6 a covered folder is shown as covered, not offered', /already covered by ~\/code/.test(p.text(p.$('content').querySelector('[data-folder="~/code/old"]'))) && !p.$('content').querySelector('[data-folder="~/code/old"] input'));
  ok('6 a blocked folder is reported plainly', /~\/Documents\/locked: permission denied/.test(p.text(p.$('content'))));
  const sel = row.querySelector('select');
  ok('6 suggestions default to read', sel.value === 'read');
  const asked = [];
  p.confirm = (m) => { asked.push(m); return false; };
  sel.value = 'edit'; sel.onchange();
  await settle(20);
  ok('6 switching to edit asks a confirm naming where it really leads', asked.length === 1 && /~\/real\/work/.test(asked[0]));
  ok('6 …cancelled, it goes back to read and nothing is added', sel.value === 'read' && !p.requests.some((r) => r.path === '/api/roots/add'));
  p.confirm = (m) => { asked.push(m); return true; };
  sel.value = 'edit'; sel.onchange();
  await settle(20);
  btn(p, 'Add selected').click();
  await settle(20);
  const add = p.requests.find((r) => r.path === '/api/roots/add');
  ok('6 confirmed, Add sends edit with confirm = the canonical path', add && add.body.access === 'edit' && add.body.confirm === '/real/h/code/work' && add.body.path === '/h/code/work', JSON.stringify(add?.body));
  ok('6 …and the folder is listed as added', /work/.test(p.text(p.$('content').querySelector('[data-root="work"]'))));
}

/* ── S15: Finish lands on a Home that reflects setup ──────────────────── */
{
  const routes = setupRoutes();
  routes.st.setup = { state: 'done' };
  const p = await boot({ routes });
  await settle(40);
  ok('S15 Home shows the folder line', /Project folders: 0 \(edit\) · 0 \(read\)/.test(p.text(p.$('content'))), p.text(p.$('content')).slice(0, 200));
  btn(p, 'Run setup again').click();
  await settle(20);
  ok('S15 "Run setup again" opens setup', p.eval('S.view') === 'setup');
  routes.st.roots.push({ id: 'work', label: 'Work', access: 'edit', status: 'ok', display: '~/code/work' }, { id: 'r', label: 'R', access: 'read', status: 'ok', display: '~/r' });
  routes.st.seats.push({ id: 'codex', vendor: 'codex', label: 'Codex (primary)', home: '/h/.codex' });
  p.eval("setupGo('done')");
  await settle(20);
  ok('S16 the Done step shows the route\'s next commands, the worktree one marked zsh/macOS only',
     /\/src\/acs\/bin\/acs install-model-id/.test(p.text(p.$('content'))) && /The worktree helpers\. \(zsh\/macOS only\)/.test(p.text(p.$('content'))));
  btn(p, 'Finish').click();
  await settle(40);
  const home = p.text(p.$('content'));
  ok('S15 Finish writes done and lands on #home', routes.st.setup.state === 'done' && p.eval('S.view') === 'home' && p.location.hash === '#home');
  ok('S15 …with Home re-read, not cached: the new folder count', /Project folders: 1 \(edit\) · 1 \(read\)/.test(home), home.slice(0, 300));
  ok('S15 …each CLI\'s state from /api/setup/clis', /Claude Code.*2\.1\.0 \(Claude Code\) · sign-in: unknown — refresh/.test(home) && /Codex.*sign-in: credentials present/.test(home) && /Grok.*not installed/.test(home));
  ok('S15 …and the added seat', /Codex \(primary\)/.test(home));
}

/* ── browser QA fixes ──────────────────────────────────────────────────── */
const focused = (p) => p.doc.activeElement;
const onPage = (p, n) => n && n !== p.doc.body && p.doc.body.contains(n);
{
  // 1: focus survives the repaint each action causes; Enter submits a typed path.
  const routes = setupRoutes();
  const p = await boot({ routes });
  await settle(30);
  btn(p, 'Recheck').focus();
  btn(p, 'Recheck').click();
  await settle(30);
  ok('QA1 after Recheck, focus is on Recheck again, not <body>', onPage(p, focused(p)) && focused(p).textContent === 'Recheck', focused(p)?.tagName);
  p.eval("setupGo('folders')");
  await settle(30);
  btn(p, 'Scan for projects').click();
  await settle(30);
  ok('QA1 after Scan, focus is on the first result', onPage(p, focused(p)) && focused(p).dataset.focus === 'suggestion', focused(p)?.tagName);
  const row = p.$('content').querySelector('[data-folder="~/code/work"]');
  row.querySelector('input').click();
  await settle(10);
  btn(p, 'Add selected').click();
  await settle(40);
  ok('QA1 after Add selected, focus stays in the step, not <body>', onPage(p, focused(p)), focused(p)?.tagName);
  const input = p.$('content').querySelector('[data-focus="typed-path"]');
  input.focus();
  p.input(input, '/h/code/notes');
  p.key('Enter');
  await settle(40);
  ok('QA1 Enter in "Or type a folder" submits it', p.requests.some((r) => r.path === '/api/roots/add' && r.body.path === '/h/code/notes'));
  ok('QA1 …and focus comes back to the field', onPage(p, focused(p)) && focused(p).dataset.focus === 'typed-path');
  p.$('btn-skills').click();
}
{
  // 2: the popup message tells the truth.
  for (const [what, open, re] of [['opened', () => ({ closed: false }), /waiting for you to finish/], ['blocked (null)', () => null, /blocked the popup/], ['closed at once', () => ({ closed: true }), /blocked the popup/]]) {
    const routes = setupRoutes();
    routes.st.seats.push({ id: 'codex', vendor: 'codex', label: 'Codex (primary)', home: '/h/.codex' });
    const p = await boot({ routes, hash: '#setup&step=accounts' });
    await settle(30);
    p.win.open = open;
    btn(p, 'Sign in with ChatGPT').click();
    await settle(30);
    ok(`QA2 a popup that ${what}: ${re.source.includes('waiting') ? 'waiting' : 'blocked'} is said`, re.test(p.text(p.$('content').querySelector('.usage-hint'))), p.text(p.$('content').querySelector('.usage-hint')));
    p.$('btn-skills').click();
  }
}
{
  // 3: Home never calls an installed CLI missing.
  const routes = setupRoutes({
    'GET /api/models': () => ({ rows: [], pending: 0, checkedAt: Date.now(), catalogs: [
      { vendor: 'claude', label: 'Claude', ok: false, missing: true }, { vendor: 'codex', label: 'Codex', ok: false, missing: true },
      { vendor: 'grok', label: 'Grok', ok: false, missing: true }] }),
  });
  routes.st.setup = { state: 'done' };
  const p = await boot({ routes });
  await settle(60);
  const home = p.text(p.$('content'));
  ok('QA3 Home says installed CLIs have no catalog yet — not "not installed"',
     /Claude: installed, no model catalog yet/.test(home) && /Codex: installed, no model catalog yet/.test(home) && !/(Claude|Codex): not installed/.test(home), home.slice(0, 600));
  ok('QA3 …and only the CLI setup did not find reads not installed', /Grok: not installed — not checked/.test(home));
}
{
  // 4: a signed-in seat says so on its row.
  const routes = setupRoutes({ 'GET /api/usage': () => ({ seats: [{ seatId: 'codex', label: 'Codex (primary)', vendor: 'codex', home: '/h/.codex', ok: false, signedIn: true, windows: [], reason: 'no turn has run since signing in' }] }) });
  routes.st.seats.push({ id: 'codex', vendor: 'codex', label: 'Codex (primary)', home: '/h/.codex' });
  const p = await boot({ routes, hash: '#setup&step=accounts' });
  await settle(40);
  ok('QA4 a signed-in seat shows "signed in" on its row', /signed in/.test(p.text(p.$('content').querySelector('[data-seat="codex"]'))), p.text(p.$('content').querySelector('[data-seat="codex"]')));
  p.$('btn-skills').click();
}
{
  // 5, 6, 7: typed add marks the suggestion; one word for read; a failed add keeps the input.
  let failNext = false;
  const routes = setupRoutes({
    'POST /api/roots/preview': (b) => ({ canonical: b.path, display: b.path.replace('/h', '~'), typed: b.path, label: 'x', access: { edit: null, read: null }, grants: 'g' }),
  });
  const add = routes.table['POST /api/roots/add'];
  routes.table['POST /api/roots/add'] = (b) => { if (failNext) { failNext = false; throw { status: 400, body: { error: 'nope, not that one' } }; } return add(b); };
  const p = await boot({ routes, hash: '#setup&step=folders' });
  await settle(30);
  btn(p, 'Scan for projects').click();
  await settle(30);
  const opts = [...p.$('content').querySelector('[data-folder="~/code/work"] select').querySelectorAll('option')].map((o) => o.textContent);
  ok('QA6 the access choice reads "read-only" / "edit", as Folders does', JSON.stringify(opts) === JSON.stringify(['read-only', 'edit']), JSON.stringify(opts));
  const input = () => p.$('content').querySelector('[data-focus="typed-path"]');
  p.input(input(), '/h/code/work');
  btn(p, 'Add folder').click();
  await settle(40);
  ok('QA5 after a typed add, the matching scan suggestion shows "added"', /added/.test(p.text(p.$('content').querySelector('[data-folder="~/code/work"]'))), p.text(p.$('content').querySelector('[data-folder="~/code/work"]')));
  failNext = true;
  p.input(input(), '/h/code/bad');
  btn(p, 'Add folder').click();
  await settle(40);
  ok('QA7 a failed add keeps the typed path', input().value === '/h/code/bad' && /nope, not that one/.test(p.text(p.$('notice-slot'))), input().value);
  p.$('btn-skills').click();
}
{
  // 8: Copied resets; 12: Done's Back and Finish sit where Back and Next do.
  const p = await boot({ routes: setupRoutes(), hash: '#setup&step=done' });
  await settle(30);
  const copy = p.$('content').querySelector('.setup-cmd button');
  copy.click();
  await settle(10);
  const said = copy.textContent;
  await new Promise((r) => setTimeout(r, 2100));
  ok('QA8 the Copy button\'s answer resets after ~2 s', said !== 'Copy' && copy.textContent === 'Copy', `${said} → ${copy.textContent}`);
  const nav = [...p.$('content').querySelector('.setup-nav').querySelectorAll('button')].map((b) => b.textContent);
  ok('QA12 on Done, Back and Finish sit together in the step nav, Finish where Next is', JSON.stringify(nav) === JSON.stringify(['Back', 'Finish']) && p.$('content').querySelectorAll('.setup-finish').length === 1, JSON.stringify(nav));
  p.$('btn-skills').click();
}
{
  // The Done step's PATH row (build 3 QA): a title, `acs` as code, and the
  // Back / Finish pair centred on one line like every other step's nav.
  const p = await boot({ routes: setupRoutes({ 'GET /api/setup/clis': () => CLIS({ path: { key: 'next.path', command: "'/src/my acs/bin/acs' install", note: 'Puts acs on your PATH, so `acs` starts the studio from any terminal. It never edits a shell profile.' } }) }), hash: '#setup&step=done' });
  await settle(30);
  const row = p.$('content').querySelector('.setup-path');
  ok('QA the PATH row has its title', p.text(row?.querySelector('.setup-path-title') || row || p.$('content')) === 'Put acs on your PATH', row ? p.text(row) : 'no row');
  const codes = row ? row.querySelectorAll('code').map((c) => c.textContent) : [];
  ok('QA …`acs` in its description is a <code>, with no literal backticks', codes.includes('acs') && !p.text(row).includes('`'), JSON.stringify(codes));
  ok('QA …and its command is the server\'s, with a Copy button', row?.querySelector('.setup-cmd code')?.textContent === "'/src/my acs/bin/acs' install" && !!row.querySelector('.setup-cmd button'));
  const css = (await import('node:fs')).readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const rule = (sel) => (css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.#]/g, '\\$&')}\\s*\\{([^}]*)\\}`)) || [])[1] || '';
  ok('QA Done: the nav centres its buttons and Finish carries no extra top margin (Back and Finish the same height, one line)',
     /align-items:\s*center/.test(rule('.setup-nav')) && !/\.setup-finish\s*\{[^}]*margin/.test(css), rule('.setup-nav'));
  ok('QA the Copy button keeps its width when it says "Copied"', /min-width:\s*\d/.test(rule('.setup-cmd .btn')), rule('.setup-cmd .btn'));
}
{
  // 10: the outside-change toast names the paths.
  const p = await boot({ routes: setupRoutes({ 'GET /api/setup/status': () => ({ state: 'done' }) }) });
  await settle(30);
  p.sources[0].onmessage({ data: JSON.stringify({ type: 'files', origin: 'outside', added: ['~/a/CLAUDE.md', '~/b/CLAUDE.md'], removed: [], changed: [], revoked: [], addedPaths: ['/h/a/CLAUDE.md', '/h/b/CLAUDE.md'], removedPaths: [], changedPaths: [], revokedPaths: [] }) });
  await settle(30);
  ok('QA10 the toast names the paths, not two bare CLAUDE.md', /~\/a\/CLAUDE\.md, ~\/b\/CLAUDE\.md/.test(p.text(p.$('notice-slot'))), p.text(p.$('notice-slot')));
}
{
  // 9, 11: layout, from the stylesheet (the VM has no layout engine).
  const css = (await import('node:fs')).readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const rule = (sel) => (css.match(new RegExp(`${sel.replace(/[.#]/g, '\\$&')}\\s*\\{([^}]*)\\}`)) || [])[1] || '';
  ok('QA11 toasts are a fixed overlay: they never shift the page', /position:\s*fixed/.test(rule('#notice-slot')), rule('#notice-slot'));
  ok('QA9 the seat reading may wrap as text in its own flexible column (no fixed 38px width)',
     /min-width:\s*0/.test(rule('.setup-seat-pct')) && /flex:\s*1 1/.test(rule('.setup-seat-read')) && !/width:\s*38px/.test(rule('.setup-seat-pct')));
  const p = await boot({ routes: setupRoutes({ 'GET /api/usage': () => ({ seats: [{ seatId: 'codex', label: 'Codex (primary)', vendor: 'codex', home: '/h/.codex', ok: true, windows: [{ label: 'Weekly (fixture)', usedPercent: 25, resetsAt: Date.now() + 1e8 }] }] }) }), hash: '#setup&step=accounts' });
  await settle(40);
  ok('QA9 …and the reading is rendered in that column, not the Usage panel\'s fixed-width cell', !!p.$('content').querySelector('[data-seat] .setup-seat-pct') && !p.$('content').querySelector('[data-seat] .usage-pct'));
  p.$('btn-skills').click();
}

/* ── keyboard: every setup control is a real control ──────────────────── */
{
  const p = await boot({ routes: setupRoutes() });
  await settle(20);
  for (const step of ['clis', 'accounts', 'folders', 'done']) {
    p.eval(`setupGo('${step}')`);
    await settle(20);
    if (step === 'folders') { btn(p, 'Scan for projects').click(); await settle(20); }
  }
  const clickable = p.$('content').querySelectorAll('*').filter((n) => n.onclick && !['BUTTON', 'A', 'INPUT', 'SELECT'].includes(n.tagName));
  ok('10 every clickable thing in setup is a button, link or form control (reachable by keyboard)', clickable.length === 0, clickable.map((n) => n.tagName).join());
}

for (const p of pages) p.done();
const stray = pages.flatMap((p) => p.errors);
ok('no page errors across every page booted', stray.length === 0, stray.slice(0, 3).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
