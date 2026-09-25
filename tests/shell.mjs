/**
 * The navigation shell (redesign PR A): the sidebar built from one VIEWS
 * table, the Files panel collapsed on every load, deep links, the icon rail,
 * the narrow-width overlay, and every older path through the page that the
 * shell must not break — create actions, live file events, the keyboard.
 *
 * Runs index.html and the real public/ scripts in a node VM against stubbed
 * routes (tests/fixtures/shell-page.mjs). No server, no HOME.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bootPage, routesFor, registry, PATHS, PUB, HTML, settle } from './fixtures/shell-page.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\nnavigation shell');

const APP = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
const FORMER = { Skills: 'configure', MCP: 'configure', Models: 'configure', Memory: 'review', Context: 'review',
  Worktrees: 'review', Usage: 'review', Scope: 'review', Trash: 'footer', Theme: 'footer' };
const pages = [];
const boot = async (o) => { const p = await bootPage(o); pages.push(p); return p; };
const noErrors = (p) => p.errors.length === 0;

// ── 1. the bottom bar holds no navigation; every former button is in the sidebar ──
{
  const status = HTML.slice(HTML.indexOf('<footer class="statusbar">'), HTML.indexOf('</footer>'));
  ok('1 the status bar has no buttons, only the live dot and status text',
     !/<button/.test(status) && /live-dot/.test(status) && /status-left/.test(status) && /status-right/.test(status));
  const p = await boot();
  const views = p.eval('VIEWS');
  for (const [label, group] of Object.entries(FORMER)) {
    const v = views.find((x) => x.label === label);
    const b = v && p.$(`btn-${v.id}`);
    const where = b && (group === 'footer' ? b.closest('.nav-foot') : b.closest('.nav-group'));
    const title = where && group !== 'footer' ? p.text(where.querySelector('.nav-group-title')).toLowerCase() : 'footer';
    ok(`1 ${label} is a VIEWS row in ${group} and a sidebar button there`, !!b && v.group === group && !!where && title === group,
       `${v?.group} / ${title}`);
  }
  ok('1 Home has its own sidebar item, first', p.$('nav').querySelector('.nav-item')?.getAttribute('id') === 'btn-home');
  ok('1 Files is under Configure', p.$('btn-files').closest('.nav-group') === p.$('btn-skills').closest('.nav-group'));
  const sidebar = p.$('sidebar');
  const nameless = sidebar.querySelectorAll('button').filter((b) => !p.text(b) && !b.getAttribute('aria-label'));
  ok('1 every sidebar button has an accessible name', nameless.length === 0, nameless.map((b) => b.outerHTML.slice(0, 80)).join(' '));
  ok('1 the icon buttons outside it are named too', ['nav-menu', 'drawer-close'].every((id) => p.$(id).getAttribute('aria-label')));
  // Each generated button runs its row's open function.
  let hits = 0;
  for (const v of views.filter((x) => x.group && x.kind !== 'action')) {
    p.$(`btn-${v.id}`).click();
    await settle(5);
    if (p.eval('S.view') === v.id) hits++;
  }
  ok('1 clicking each view button opens that view', hits === views.filter((x) => x.group && x.kind !== 'action').length, `${hits}`);
  const wtBefore = p.requests.filter((r) => r.path === '/api/worktree').length;
  p.$('btn-worktrees').click();
  await settle(5);
  ok('1 the generated Worktrees button runs openWorktrees (its view asks /api/worktree)', p.eval('S.view') === 'worktrees'
     && p.requests.filter((r) => r.path === '/api/worktree').length === wtBefore + 1 && p.text(p.$('title')) === 'Worktrees');
  p.$('btn-trash').click();
  await settle(5);
  ok('1 …and marks it current', p.$('btn-trash').getAttribute('aria-current') === 'page' && !p.$('btn-home').hasAttribute('aria-current'));
  ok('1 the Models badge shows the registry alert count', p.text(p.$('btn-models').querySelector('.nav-badge')) === '2'
     && !p.$('btn-models').querySelector('.nav-badge').hidden);
  ok('1 no page errors', noErrors(p), p.errors.join(' | '));
}

// ── 2. Files: collapsed on every load; opens on click and on search; reveals ──
{
  const p = await boot();
  ok('2 the Files panel is collapsed on first load', p.$('files-panel').hidden && p.$('btn-files').getAttribute('aria-expanded') === 'false');
  p.$('btn-files').click();
  ok('2 it opens on click', !p.$('files-panel').hidden && p.$('btn-files').getAttribute('aria-expanded') === 'true');
  ok('2 …holding the tree', p.$('files-panel').querySelectorAll('.group').length > 0);
  const again = await boot({ carry: p.store });
  ok('2 and is collapsed again on reload, with the same storage', again.$('files-panel').hidden);
  again.key('k', { meta: true });
  ok('2 ⌘K opens it and focuses search', !again.$('files-panel').hidden && again.doc.activeElement === again.$('search'));

  // Opening a file from each panel still works, and reveals it in the tree.
  const opened = async (q, label) => {
    await settle(10);
    const good = q.eval('S.view') === 'entry' && !!q.eval('S.file');
    ok(`2 ${label}: the file opens`, good, `${q.eval('S.view')}`);
    return good;
  };
  {
    const q = await boot();
    q.input(q.$('search'), 'pre');
    await settle(260);
    q.$('content').querySelector('.result').click();
    await opened(q, 'search');
    ok('2 search: the file is revealed — panel open, its collapsed group expanded, scrolled to',
       !q.$('files-panel').hidden && q.$('tree').querySelector('.item.active')?.textContent.includes('pre tool')
       && q.doc.scrolledIntoView.includes(q.$('tree').querySelector('.item.active')));
  }
  {
    const q = await boot({ hash: '#mcp' });
    await settle(5);
    q.$('content').querySelector('.scope-open').click();
    await opened(q, 'MCP');
    ok('2 MCP: revealed in the tree', !q.$('files-panel').hidden && !!q.$('tree').querySelector('.item.active'));
  }
  {
    const q = await boot({ hash: '#memory' });
    await settle(5);
    const open = q.$('content').querySelectorAll('.mem-fact').find((r) => r.dataset.id === 'r1').querySelector('button');
    open.click();
    await opened(q, 'Memory');
    ok('2 Memory: revealed in the tree', !q.$('files-panel').hidden && !!q.$('tree').querySelector('.item.active'));
  }
  {
    const q = await boot({ hash: '#memory' });
    await settle(5);
    q.$('content').querySelectorAll('.mem-fact').find((r) => r.dataset.id === 'r2').querySelector('button').click();
    await settle(10);
    ok('2 Memory: a synthetic entry (not in the tree) opens and keeps its path display',
       q.eval('S.view') === 'entry' && q.text(q.$('title-path')) === '~/.claude/projects/-gone/memory/orphan.md' && !q.$('tree').querySelector('.item.active'));
  }
  {
    const q = await boot({ hash: '#context' });
    await settle(5);
    q.$('content').querySelector('.cx-variant button').click();
    await opened(q, 'Context');
    ok('2 Context: revealed in the tree', !q.$('files-panel').hidden && !!q.$('tree').querySelector('.item.active'));
  }
  {
    const q = await boot();
    q.eval(`C.sessions = [{ id: 'sx', title: 't', mentions: [], slots: {}, createdAt: 0, updatedAt: 0, messages: [
      { role: 'assistant', harness: 'claude', text: 'here', proposals: [{ path: ${JSON.stringify(PATHS.claudeMd)}, display: 'CLAUDE.md', edits: 1, current: 'a', proposed: 'b', mtime: 1 }] }] }];
      C.activeId = 'sx';`);
    q.$('btn-assist').click();
    ok('2 Assist: the drawer opens', q.$('drawer').classList.contains('open'));
    const btn = q.$('drawer-body').querySelectorAll('button').find((b) => b.textContent === 'Open file');
    btn.click();
    await opened(q, 'Assist "Open file"');
    ok('2 Assist: the drawer closes and the file is revealed', !q.$('drawer').classList.contains('open') && !!q.$('tree').querySelector('.item.active'));
  }
  {
    const q = await boot();
    q.$('btn-files').click();
    q.$('reveal-files').click();
    q.$('btn-files').click();
    const r = await boot({ carry: q.store, hash: '#mcp' });
    await settle(5);
    r.$('content').querySelector('.scope-open').click();
    await settle(10);
    ok('2 with "Show opened files here" off, opening a file leaves the panel shut (remembered)',
       r.eval('S.view') === 'entry' && r.$('files-panel').hidden && r.$('reveal-files').checked === false);
  }
  {
    const q = await boot({ hash: `#file=${encodeURIComponent(PATHS.hook)}` });
    await settle(10);
    ok('2 a cold #file= link opens the file but not the panel', q.eval('S.file?.path') === PATHS.hook && q.$('files-panel').hidden);
  }
}

// ── 3. one VIEWS table; every hash; unknown → Home; special hashes ────────────
{
  const code = APP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('3 no hand-written hash list: no location.hash.startsWith(\'#view\') outside the router',
     !/location\.hash\.startsWith\('#(?!assist)/.test(code));
  ok('3 no hand-written button wiring for views', !/\$\('btn-(skills|memory|context|worktrees|trash|models|usage|mcp|scope|theme)'\)\.onclick/.test(code));
  const topbar = code.slice(code.indexOf('function renderTopbar'), code.indexOf('function renderFilebar'));
  const content = code.slice(code.indexOf('function renderContent'), code.indexOf('function goHome'));
  const perView = /S\.view === '(scope|mcp|models|worktrees|trash|skills|memory|context|usage|welcome|home)'/;
  ok('3 renderTopbar and renderContent read VIEWS, not a per-view chain', !perView.test(topbar) && !perView.test(content)
     && topbar.includes('viewById(') && content.includes('viewById('));
  ok('3 boot routes through the same table', /routeHash\(location\.hash, \{ cold: true \}\)/.test(code) && /VIEWS\.find\(\(x\) => x\.hash/.test(code));
  ok('3 there is no \'welcome\' view left', !/'welcome'/.test(code));

  const probe = await boot();
  const hashed = probe.eval('VIEWS').filter((v) => v.hash);
  for (const v of hashed) {
    const cold = await boot({ hash: v.hash });
    await settle(5);
    const warm = await boot();
    warm.navigate(v.hash);
    await settle(5);
    ok(`3 ${v.hash} opens ${v.id} on a cold load and at runtime`, cold.eval('S.view') === v.id && warm.eval('S.view') === v.id,
       `${cold.eval('S.view')} / ${warm.eval('S.view')}`);
  }
  const unknown = await boot({ hash: '#nope' });
  ok('3 an unknown hash lands on Home (cold)', unknown.eval('S.view') === 'home' && unknown.$('content').querySelector('.empty'));
  unknown.$('btn-skills').click();
  await settle(5);
  unknown.navigate('#nope-again');
  await settle(5);
  ok('3 …and at runtime', unknown.eval('S.view') === 'home');
  const enc = await boot({ hash: `#file=${encodeURIComponent(PATHS.hook)}` });
  await settle(10);
  ok('3 an encoded #file= path (a space in it) opens that file', enc.eval('S.file?.path') === PATHS.hook);
  const bad = await boot({ hash: '#file=%E0%A4%A' });
  ok('3 a malformed #file= escape lands on Home without an error', bad.eval('S.view') === 'home' && noErrors(bad), bad.errors.join(' '));
  const missing = await boot({ hash: `#file=${encodeURIComponent('/h/not/there.md')}` });
  ok('3 a #file= for a file not in the registry lands on Home', missing.eval('S.view') === 'home');
  const warmFile = await boot();
  warmFile.navigate(`#file=${encodeURIComponent(PATHS.claudeMd)}`);
  await settle(10);
  ok('3 #file= at runtime opens the file', warmFile.eval('S.file?.path') === PATHS.claudeMd);
  const assist = await boot({ hash: '#assist' });
  ok('3 #assist on a cold load opens the drawer over Home', assist.$('drawer').classList.contains('open') && assist.eval('S.view') === 'home');
  const assistWarm = await boot();
  assistWarm.navigate('#assist');
  ok('3 #assist at runtime opens the drawer', assistWarm.$('drawer').classList.contains('open'));

  // Navigating away from a dirty editor, cancelled.
  const d = await boot({ hash: `#file=${encodeURIComponent(PATHS.claudeMd)}` });
  await settle(10);
  d.$('tabs').querySelectorAll('button').find((b) => b.textContent === 'Edit').click();
  d.input(d.$('content').querySelector('textarea'), 'changed');
  let asked = 0;
  d.confirm = () => { asked++; return false; };
  const before = d.location.hash;
  d.navigate('#skills');
  await settle(5);
  ok('3 a hash away from unsaved edits asks, and cancelling stays — hash put back',
     asked === 1 && d.eval('S.view') === 'entry' && d.eval('S.draft') === 'changed' && d.location.hash === before, `${asked} ${d.location.hash}`);
  d.$('btn-memory').click();
  d.$('btn-home').click();
  await settle(5);
  ok('3 sidebar clicks away from unsaved edits ask too, and cancelling stays', asked === 3 && d.eval('S.view') === 'entry');
  d.confirm = () => { asked++; return true; };
  d.navigate('#skills');
  await settle(5);
  ok('3 confirming discards once and goes — no second prompt', asked === 4 && d.eval('S.view') === 'skills', `${asked}`);
}

// ── 4. no inline styles on nav; tokens only ────────────────────────────────
{
  ok('4 index.html has no inline style= at all', !/\sstyle=/.test(HTML));
  const nav = APP.slice(APP.indexOf('/* ── navigation'), APP.indexOf('/* ── file tree'));
  ok('4 the sidebar code sets no inline styles', nav.length > 1000 && !/\.style\b|cssText/.test(nav));
  const outside = CSS.replace(/:root(\[data-theme="light"\])?\s*\{[^}]*\}/g, '');
  const hex = outside.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  ok('4 styles.css has no hex colour outside the :root token blocks', hex.length === 0, hex.join(' '));
  const lightBlock = CSS.match(/:root\[data-theme="light"\]\s*\{[^}]*\}/)[0];
  const darkBlock = CSS.match(/:root\s*\{[^}]*\}/)[0];
  const used = [...new Set([...CSS.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))];
  const undefinedTokens = used.filter((t) => !darkBlock.includes(`${t}:`) && !/--rail-w/.test(t));
  ok('4 every var() names a defined token', undefinedTokens.length === 0, undefinedTokens.join(' '));
  ok('4 the light theme overrides the shadow token for its own surface', /--shadow:/.test(lightBlock));
}

// ── 5. the rail collapses, is remembered, and survives throwing storage ─────
{
  const p = await boot();
  p.$('rail-toggle').click();
  ok('5 the rail collapses to icons', p.$('app').classList.contains('rail-collapsed')
     && p.$('rail-toggle').getAttribute('aria-label') === 'Expand sidebar');
  const again = await boot({ carry: p.store });
  ok('5 …and stays collapsed across a reload', again.$('app').classList.contains('rail-collapsed'));
  again.$('btn-files').click();
  ok('5 Files on the icon rail expands the rail and opens the panel', !again.$('app').classList.contains('rail-collapsed') && !again.$('files-panel').hidden);
  const blocked = await boot({ storage: 'throws', hash: '#skills' });
  ok('5 with localStorage throwing, the page still boots and renders the sidebar',
     blocked.eval('S.view') === 'skills' && blocked.$('sidebar').querySelectorAll('.nav-item').length === 12 && noErrors(blocked), blocked.errors.join(' | '));
  blocked.$('rail-toggle').click();
  blocked.$('btn-theme').click();
  ok('5 …and the rail and theme toggles still work there', blocked.$('app').classList.contains('rail-collapsed')
     && blocked.doc.documentElement.dataset.theme === 'light' && noErrors(blocked));
  const src = APP.replace(/const store = \{[\s\S]*?\n\};/, '');
  ok('5 no localStorage access outside the guarded helper and the already-guarded sessions store',
     (src.match(/localStorage\./g) || []).length === 2 && /try \{\s*localStorage\.setItem\(SESSIONS_KEY/.test(src) && /try \{\s*const raw = localStorage\.getItem\(SESSIONS_KEY\)/.test(src));
}

// ── Bounce folds: create actions, theme, welcome→home, live events, keyboard, narrow ──
{
  const p = await boot();
  p.$('btn-files').click();
  const adds = p.$('tree').querySelectorAll('.group-add');
  ok('F every group with a createKind keeps its + button', adds.length === 3, `${adds.length}`);
  p.ctx.prompt = () => 'newskill';
  adds.find((b) => b.title === 'New skill').click();
  await settle(10);
  ok('F + on Skills still creates, and opens the new file in Edit', p.requests.some((r) => r.path === '/api/create' && r.body.kind === 'claude-skill' && r.body.name === 'newskill')
     && p.eval('S.tab') === 'edit');
  adds.find((b) => b.title === 'New hook').click();
  await settle(10);
  ok('F + on Hooks still creates its own kind', p.requests.some((r) => r.path === '/api/create' && r.body.kind === 'claude-hook'));
  adds.find((b) => b.title === 'New worktree').click();
  await settle(10);
  ok('F + on Worktrees still opens the registration form, not a file scaffold',
     p.requests.some((r) => r.path === '/api/worktree' && r.search === '?status=0') && !!p.doc.body.querySelector('.wt-overlay'));
  p.doc.body.querySelector('.wt-overlay .btn.ghost').click();
  p.eval(`openEntry(findEntry('skill:alpha'))`);
  await settle(10);
  p.ctx.prompt = () => 'extra.md';
  p.$('filebar').querySelectorAll('button').find((b) => b.textContent === '+ file').click();
  await settle(10);
  ok('F the skill "+ file" chip still adds a file', p.requests.some((r) => r.path === '/api/create-file' && r.body.name === 'extra.md'));

  const t = await boot();
  const was = t.doc.documentElement.dataset.theme;
  t.$('btn-theme').click();
  ok('F Theme is an action: it flips the theme, stays on the view, and is remembered',
     t.doc.documentElement.dataset.theme !== was && t.eval('S.view') === 'home' && t.store.get('acs.theme') === t.doc.documentElement.dataset.theme);
  ok('F the Theme item names the theme it switches to', /theme/i.test(t.text(t.$('btn-theme'))));
}
{
  // Search clear, external delete and local delete all land on Home.
  const p = await boot();
  p.input(p.$('search'), 'pre');
  await settle(260);
  ok('F search shows results', p.eval('S.view') === 'search');
  p.input(p.$('search'), '');
  ok('F clearing search lands on Home', p.eval('S.view') === 'home');

  const e = await boot({ hash: `#file=${encodeURIComponent(PATHS.claudeMd)}` });
  await settle(10);
  const es = e.sources[0];
  es.onmessage({ data: JSON.stringify({ type: 'files', origin: 'outside', removed: [PATHS.claudeMd], removedPaths: [PATHS.claudeMd], added: [], changed: [] }) });
  await settle(10);
  ok('F an outside delete of the open file (Files closed) lands on Home and keeps its sticky notice',
     e.$('files-panel').hidden && e.eval('S.view') === 'home' && /deleted outside/.test(e.text(e.$('notice-slot'))));

  const l = await boot({ hash: `#file=${encodeURIComponent(PATHS.hook)}` });
  await settle(10);
  l.eval('deleteOpenEntry()');
  await settle(10);
  ok('F a local delete lands on Home with its notice', l.eval('S.view') === 'home' && /Deleted/.test(l.text(l.$('notice-slot'))));
}
{
  // Live events while the Files panel is closed.
  const routes = routesFor();
  const p = await boot({ routes, hash: `#file=${encodeURIComponent(PATHS.claudeMd)}` });
  await settle(10);
  const es = p.sources[0];
  const fire = async (d) => { es.onmessage({ data: JSON.stringify({ type: 'files', added: [], removed: [], changed: [], ...d }) }); await settle(10); };
  es.onopen();
  ok('F live: connected shows the live dot', p.$('live-dot').classList.contains('on'));
  es.onerror();
  ok('F live: a dropped stream shows it disconnected', !p.$('live-dot').classList.contains('on'));
  es.onopen();
  ok('F live: a reconnect shows it live again', p.$('live-dot').classList.contains('on'));

  const newPath = '/h/.claude/skills/beta/SKILL.md';
  await fire({ origin: 'outside', added: [newPath] });
  ok('F live: an outside add is announced, the open file untouched', /1 added outside/.test(p.text(p.$('notice-slot'))) && p.eval('S.file.path') === PATHS.claudeMd);
  const regCalls = p.requests.filter((r) => r.path === '/api/registry').length;
  ok('F live: the registry was refreshed for it', regCalls >= 2);

  routes.files.set(PATHS.claudeMd, 'changed on disk\n');
  await fire({ origin: 'outside', changed: [PATHS.claudeMd], changedPaths: [PATHS.claudeMd] });
  ok('F live: an outside change to the clean open file reloads it', p.eval('S.draft') === 'changed on disk\n' && /Reloaded/.test(p.text(p.$('notice-slot'))));

  p.eval(`S.tab = 'edit'; renderContent();`);
  p.input(p.$('content').querySelector('textarea'), 'my edit');
  routes.files.set(PATHS.claudeMd, 'changed again\n');
  await fire({ origin: 'outside', changed: [PATHS.claudeMd], changedPaths: [PATHS.claudeMd] });
  ok('F live: an outside change while dirty keeps the edits and warns', p.eval('S.draft') === 'my edit' && /changed on disk while you were editing/.test(p.text(p.$('notice-slot'))));

  p.key('s', { meta: true });
  await settle(10);
  ok('F keyboard: ⌘S saves the open file', p.requests.some((r) => r.method === 'PUT' && r.path === '/api/file' && r.body.content === 'my edit'));
  p.eval('clearNotice()');
  await fire({ origin: 'studio', changed: [PATHS.claudeMd], changedPaths: [PATHS.claudeMd] });
  ok('F live: this tab\'s own save echoing back is quiet and keeps the text', p.eval('S.draft') === 'my edit' && p.text(p.$('notice-slot')) === '');
  await fire({ origin: 'studio', added: ['/h/.claude/skills/gamma/SKILL.md'] });
  ok('F live: a studio add elsewhere is not announced', p.text(p.$('notice-slot')) === '');
  ok('F live: no page errors', noErrors(p), p.errors.join(' | '));
}
{
  // The keyboard journey, and the narrow overlay.
  const p = await boot({ hash: `#file=${encodeURIComponent(PATHS.claudeMd)}` });
  await settle(10);
  p.key('e', { meta: true });
  ok('F keyboard: ⌘E switches to Edit', p.eval('S.tab') === 'edit' && !!p.$('content').querySelector('textarea'));
  p.$('btn-assist').click();
  p.key('Escape');
  ok('F keyboard: Escape closes Assist', !p.$('drawer').classList.contains('open'));
  p.key('k', { meta: true });
  p.key('Escape');
  ok('F keyboard: Escape leaves search', p.doc.activeElement !== p.$('search'));

  const n = await boot({ width: 800 });
  n.$('nav-menu').click();
  ok('F narrow: the menu button opens the sidebar overlay', n.$('app').classList.contains('nav-open') && n.$('nav-menu').getAttribute('aria-expanded') === 'true');
  n.$('btn-files').click();
  ok('F narrow: Files opens inside the overlay without closing it', n.$('app').classList.contains('nav-open') && !n.$('files-panel').hidden);
  n.$('btn-usage').click();
  await settle(5);
  ok('F narrow: choosing a view closes the overlay and opens it', !n.$('app').classList.contains('nav-open') && n.eval('S.view') === 'usage');
  n.$('nav-menu').click();
  n.key('Escape');
  ok('F narrow: Escape closes the overlay', !n.$('app').classList.contains('nav-open'));
  n.$('nav-menu').click();
  n.$('nav-scrim').click();
  ok('F narrow: the scrim closes it', !n.$('app').classList.contains('nav-open'));
  n.key('k', { meta: true });
  ok('F narrow: ⌘K opens the overlay to the search box', n.$('app').classList.contains('nav-open') && n.doc.activeElement === n.$('search'));
  const r = await boot({ width: 800, hash: '#mcp' });
  await settle(5);
  r.$('content').querySelector('.scope-open').click();
  await settle(10);
  ok('F narrow: opening a file from a panel does not pop the overlay open', r.eval('S.view') === 'entry' && !r.$('app').classList.contains('nav-open'));
  ok('F narrow: no page errors', noErrors(n) && noErrors(r), [...n.errors, ...r.errors].join(' | '));
  const css = CSS.slice(CSS.indexOf('@media (max-width: 900px)'));
  ok('F narrow: the CSS turns the sidebar into an overlay rather than hiding it', /\.sidebar\s*\{[^}]*position: fixed/.test(css)
     && /#app\.nav-open \.sidebar/.test(css) && !/\.sidebar\s*\{\s*display:\s*none/.test(css) && /\.nav-menu \{ display: grid; \}/.test(css));
  ok('F focus is visible: a :focus-visible outline is defined', /:focus-visible\s*\{\s*outline: 2px solid var\(--accent\)/.test(CSS));
}

// ── Grade fixes (PR A) ─────────────────────────────────────────────────────
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
{
  // G2: an accepted Home entry leaves nothing open behind it.
  const p = await boot({ hash: `#file=${encodeURIComponent(PATHS.claudeMd)}` });
  await settle(10);
  p.eval(`S.tab = 'edit'; renderContent();`);
  p.input(p.$('content').querySelector('textarea'), 'unsaved');
  let asked = 0;
  p.confirm = () => { asked++; return true; };
  p.$('btn-home').click();
  await settle(5);
  ok('G2 accepting the discard on the way Home clears the open file and its draft',
     asked === 1 && p.eval('S.view') === 'home' && p.eval('S.file') === null && !p.eval('isDirty()') && p.eval('S.draft') === '');
  p.$('btn-skills').click();
  await settle(5);
  ok('G2 …so the next navigation does not ask again', asked === 1 && p.eval('S.view') === 'skills');
  p.$('btn-home').click();
  p.$('btn-assist').click();
  ok('G2 …and Assist opened from Home attaches no old file', p.eval('active().mentions.length') === 0);

  const q = await boot({ hash: `#file=${encodeURIComponent(PATHS.claudeMd)}` });
  await settle(10);
  q.eval(`S.tab = 'edit'; renderContent();`);
  q.input(q.$('content').querySelector('textarea'), 'unsaved');
  q.input(q.$('search'), 'pre');
  await settle(260);
  q.input(q.$('search'), '');
  ok('G2 clearing search with unsaved edits goes back to the file, edits intact, not to Home',
     q.eval('S.view') === 'entry' && q.eval('S.draft') === 'unsaved' && !!q.$('content').querySelector('textarea'));
}
{
  // G3: Assist before the registry has loaded.
  const reg = deferred();
  const routes = routesFor({ 'GET /api/registry': () => reg.promise });
  const p = await boot({ routes });
  p.$('btn-assist').click();
  p.$('drawer-compose').querySelector('.mention-add').click();
  ok('G3 "@ attach a file" before the registry loads says so and does not throw',
     p.errors.length === 0 && /Loading files/.test(p.text(p.$('drawer-compose').querySelector('.picker'))), p.errors.join(' | '));
  reg.resolve(registry());
  await settle(10);
  const sel = p.$('drawer-compose').querySelector('.assist-harness');
  const send = p.$('drawer-compose').querySelectorAll('button').find((b) => b.textContent === 'Send');
  ok('G3 once the registry lands, the open drawer is repainted with its harness enabled',
     sel && !sel.disabled && sel.value === 'claude' && send && !send.disabled && p.errors.length === 0, p.errors.join(' | '));
}
{
  // G4: narrow ⌘K keeps the focus it asked for, past the overlay's focus timer.
  const n = await boot({ width: 800 });
  n.key('k', { meta: true });
  await settle(20);
  ok('G4 narrow: after the overlay opens, ⌘K\'s focus is still on search', n.doc.activeElement === n.$('search'),
     n.doc.activeElement?.getAttribute?.('id'));
  n.key('Escape');
  n.$('nav-menu').click();
  await settle(20);
  ok('G4 narrow: the menu button still focuses the first nav item', n.doc.activeElement === n.$('btn-home'));
}
{
  // G5: a hash changed while the registry is still loading is routed once it lands.
  const reg = deferred();
  const p = await boot({ routes: routesFor({ 'GET /api/registry': () => reg.promise }) });
  p.navigate('#context');
  reg.resolve(registry());
  await settle(10);
  ok('G5 a hash changed during boot opens that view once the registry is in', p.eval('S.view') === 'context' && p.location.hash === '#context');
}
{
  // G6: reveal on the icon rail and in the narrow overlay — deferred to the next expand.
  const p = await boot();
  p.$('rail-toggle').click();
  p.eval(`openEntry(findEntry('hook:pre'))`);
  await settle(10);
  ok('G6 rail: opening a file expands its group now, without widening the rail',
     p.eval(`collapsed.has('hooks')`) === false && p.$('app').classList.contains('rail-collapsed'));
  p.$('rail-toggle').click();
  const active = p.$('tree').querySelector('.item.active');
  ok('G6 rail: the next expand opens Files scrolled to that file',
     !p.$('files-panel').hidden && active?.textContent.includes('pre tool') && p.doc.scrolledIntoView.includes(active));
  const n = await boot({ width: 800, hash: '#mcp' });
  await settle(5);
  n.$('content').querySelector('.scope-open').click();
  await settle(10);
  ok('G6 narrow: opening a file leaves the overlay shut', !n.$('app').classList.contains('nav-open'));
  n.$('nav-menu').click();
  const nActive = n.$('tree').querySelector('.item.active');
  ok('G6 narrow: the next time the overlay opens, Files shows that file', !n.$('files-panel').hidden && !!nActive && n.doc.scrolledIntoView.includes(nActive));
  const off = await boot();
  off.$('btn-files').click();
  off.$('reveal-files').click();
  off.$('btn-files').click();
  off.$('rail-toggle').click();
  off.eval(`openEntry(findEntry('hook:pre'))`);
  await settle(10);
  off.$('rail-toggle').click();
  ok('G6 with reveal off, nothing is revealed on expand', off.$('files-panel').hidden && off.eval(`collapsed.has('hooks')`));
}
{
  // G9: hashes match exactly — a prefix of a view name is not that view.
  const cold = await boot({ hash: '#models-not-a-view' });
  ok('G9 #models-not-a-view lands on Home (cold)', cold.eval('S.view') === 'home');
  const warm = await boot();
  warm.navigate('#memoryx');
  await settle(5);
  ok('G9 …and #memoryx at runtime', warm.eval('S.view') === 'home');
  const as = await boot({ hash: '#assistant' });
  ok('G9 #assistant is not #assist', !as.$('drawer').classList.contains('open'));
  const qs = await boot({ hash: '#memory&tab=ops' });
  await settle(5);
  ok('G9 a view hash with &-parameters still opens its view', qs.eval('S.view') === 'memory');
}

for (const p of pages) { p.done(); for (const s of p.sources) s.close(); }
const stray = pages.flatMap((p) => p.errors);
ok('no page errors across every page booted', stray.length === 0, stray.slice(0, 3).join(' | '));
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
