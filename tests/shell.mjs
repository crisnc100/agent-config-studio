/**
 * The navigation shell (redesign PR A, reshaped in builds/acs-reshape): the
 * sidebar built from one VIEWS table, ⌘K Search, deep links, the icon rail,
 * the narrow-width overlay, and every older path through the page that the
 * shell must not break — create actions, live file events, the keyboard.
 *
 * Runs index.html and the real public/ scripts in a node VM against stubbed
 * routes (tests/fixtures/shell-page.mjs). No server, no HOME.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bootPage, routesFor, registry, PATHS, PUB, HTML, settle } from './fixtures/shell-page.mjs';
import { ndjson } from './fixtures/fake-dom.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\nnavigation shell');

const APP = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
// builds/acs-reshape R1-R6: one untitled list of seven, and Setup in the footer beside Trash and Theme.
const FORMER = { Home: 'main', Context: 'main', Tools: 'main', Models: 'main', Usage: 'main', Memory: 'main', Packs: 'main',
  Setup: 'footer', Trash: 'footer', Theme: 'footer' };
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
    ok(`1 ${label} is a VIEWS row in ${group} and a sidebar button there`, !!b && v.group === group && !!where, `${v?.group}`);
  }
  ok('1 Home has its own sidebar item, first', p.$('nav').querySelector('.nav-item')?.getAttribute('id') === 'btn-home');
  ok('1 the sidebar is one untitled list: Home, Context, Tools, Models, Usage, Memory, Packs, in that order',
    JSON.stringify(p.$('nav').querySelectorAll('.nav-group').map((g) => [p.text(g.querySelector('.nav-group-title')), g.querySelectorAll('.nav-item').map((b) => p.text(b.querySelector('.nav-label')))]))
      === JSON.stringify([['', ['Home', 'Context', 'Tools', 'Models', 'Usage', 'Memory', 'Packs']]]),
    JSON.stringify(p.$('nav').querySelectorAll('.nav-group').map((g) => p.text(g))));
  ok('1 Files, Scope, Folders, Audit, Worktrees, Skills and MCP have no sidebar item', ['files', 'scope', 'folders', 'audit', 'worktrees', 'skills', 'mcp', 'search'].every((id) => !p.$(`btn-${id}`)));
  // The theme item names the theme it switches to ("Light theme" / "Dark theme").
  const foot = p.$('nav-foot').querySelectorAll('.nav-item').map((b) => p.text(b.querySelector('.nav-label')));
  ok('1 the footer reads Setup, Trash, then the theme switch', foot.length === 3 && foot[0] === 'Setup' && foot[1] === 'Trash' && /^(Light|Dark) theme$/.test(foot[2]), JSON.stringify(foot));
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
  p.navigate('#worktrees');
  await settle(5);
  ok('1 #worktrees runs openWorktrees (its view asks /api/worktree), with Packs marked as where it lives', p.eval('S.view') === 'worktrees'
     && p.requests.filter((r) => r.path === '/api/worktree').length === wtBefore + 1 && p.text(p.$('title')) === 'Worktrees'
     && p.$('btn-packs').getAttribute('aria-current') === 'location');
  p.$('btn-trash').click();
  await settle(5);
  ok('1 …and marks it current', p.$('btn-trash').getAttribute('aria-current') === 'page' && !p.$('btn-home').hasAttribute('aria-current'));
  ok('1 the Models badge shows the registry alert count', p.text(p.$('btn-models').querySelector('.nav-badge')) === '2'
     && !p.$('btn-models').querySelector('.nav-badge').hidden);
  ok('1 no page errors', noErrors(p), p.errors.join(' | '));
}

// ── 2. Search (⌘K): its own page, no sidebar item; files open from the pages that list them ──
const searchPage = async (p) => { p.navigate('#search'); await settle(5); return p.$('content').querySelector('.files'); };
{
  const p = await boot();
  p.key('k', { meta: true });
  await settle(5);
  const page = p.$('content').querySelector('.files');
  ok('2 ⌘K opens Search as a page: the sidebar holds navigation only',
     p.eval('S.view') === 'search' && !!page && p.location.hash === '#search' && !p.$('sidebar').querySelector('input'));
  ok('2 the search box is first on the page', page.children[0]?.querySelector('input')?.getAttribute('id') === 'search');
  ok('2 Search lists no file tree of its own', !page.querySelector('.files-tool, .files-item'));
  p.navigate('#setup&step=settings');
  await settle(10);
  const hook = p.$('content').querySelectorAll('.entry-row').find((r) => r.dataset.entry === 'hook:pre');
  ok('2 files show short names on the page that lists them, with the full path beside', p.text(hook.querySelector('.scope-path')) === 'pre tool'
     && p.text(hook.querySelector('.scope-note')).includes('~/.claude/hooks/pre tool.sh'));
  hook.querySelector('button').click();
  await settle(10);
  ok('2 clicking Open opens the editor as before, full path in the topbar', p.eval('S.view') === 'entry' && p.eval('S.file.path') === PATHS.hook
     && p.text(p.$('title-path')) === '~/.claude/hooks/pre tool.sh');
  ok('2 …and Setup stays marked as where it came from', p.$('btn-setup').getAttribute('aria-current') === 'location');
  ok('2 no page errors', noErrors(p), p.errors.join(' | '));
}
{
  // Search on the page, and ⌘K from anywhere.
  const p = await boot({ hash: '#tools' });
  await settle(5);
  p.key('k', { meta: true });
  await settle(20);
  ok('2 ⌘K from another view opens Search and focuses its box', p.eval('S.view') === 'search' && p.doc.activeElement === p.$('search'));
  const box = p.$('search');
  p.input(box, 'pre');
  await settle(260);
  ok('2 typing searches in place: results on the page, the view and the search box stay', p.eval('S.view') === 'search' && p.$('search') === box
     && !!p.$('content').querySelector('.result') && !p.$('content').querySelector('.files-recent'));
  p.input(box, '');
  ok('2 clearing search brings Recently opened back', !!p.$('content').querySelector('.files-recent') && !p.$('content').querySelector('.result'));
  p.input(box, 'pre');
  await settle(260);
  p.$('content').querySelector('.result').click();
  await settle(10);
  ok('2 a search result opens its file', p.eval('S.view') === 'entry' && p.eval('S.file.path') === PATHS.hook);
}
{
  // Opening from each page works as before; that page stays marked in the sidebar while the file is open.
  const opened = async (q, label, from) => {
    await settle(10);
    const good = q.eval('S.view') === 'entry' && !!q.eval('S.file');
    ok(`2 ${label}: the file opens`, good, `${q.eval('S.view')}`);
    ok(`2 ${label}: ${from} stays marked while it is open`, q.$(`btn-${from}`).getAttribute('aria-current') === 'location', q.eval('S.fromView'));
    return good;
  };
  {
    const q = await boot({ hash: '#tools/mcp' });
    await settle(5);
    q.$('content').querySelector('.scope-open').click();
    await opened(q, 'MCP', 'tools');
  }
  {
    const q = await boot({ hash: '#memory' });
    await settle(5);
    q.$('content').querySelectorAll('.mem-fact').find((r) => r.dataset.id === 'r1').querySelector('button').click();
    await opened(q, 'Memory', 'memory');
  }
  {
    const q = await boot({ hash: '#context' });
    await settle(5);
    q.$('content').querySelector('.cx-variant button').click();
    await opened(q, 'Context', 'context');
  }
  {
    const q = await boot();
    q.eval(`C.sessions = [{ id: 'sx', title: 't', mentions: [], slots: {}, createdAt: 0, updatedAt: 0, messages: [
      { role: 'assistant', harness: 'claude', text: 'here', proposals: [{ path: ${JSON.stringify(PATHS.claudeMd)}, display: 'CLAUDE.md', edits: 1, current: 'a', proposed: 'b', mtime: 1 }] }] }];
      C.activeId = 'sx';`);
    q.$('btn-assist').click();
    ok('2 Assist: the drawer opens', q.$('drawer').classList.contains('open'));
    q.$('drawer-body').querySelectorAll('button').find((b) => b.textContent === 'Open file').click();
    ok('2 Assist: "Open file" closes the drawer', !q.$('drawer').classList.contains('open'));
    await opened(q, 'Assist "Open file"', 'home');
  }
  {
    const q = await boot({ hash: '#memory' });
    await settle(5);
    q.$('content').querySelectorAll('.mem-fact').find((r) => r.dataset.id === 'r2').querySelector('button').click();
    await settle(10);
    ok('2 Memory: a synthetic entry (not in the registry) opens and keeps its path display',
       q.eval('S.view') === 'entry' && q.text(q.$('title-path')) === '~/.claude/projects/-gone/memory/orphan.md');
  }
  {
    const q = await boot({ hash: `#file=${encodeURIComponent(PATHS.hook)}` });
    await settle(10);
    ok('2 a cold #file= link opens the file, the page that lists it marked', q.eval('S.file?.path') === PATHS.hook && q.eval('S.view') === 'entry'
       && q.$('btn-setup').getAttribute('aria-current') === 'location');
  }
}
{
  // Recently opened: per browser, labelled exactly that.
  const p = await boot();
  let page = await searchPage(p);
  const recent = () => p.$('content').querySelector('.files-recent');
  ok('2 a "Recently opened" row sits under the search box, empty to start', p.text(recent().querySelector('.home-card-title')) === 'Recently opened'
     && /appear here/.test(p.text(recent())) && page.querySelector('#files-body').children[0] === recent());
  p.eval(`openEntry(findEntry('hook:pre'))`);
  await settle(10);
  p.eval(`openEntry(findEntry('md:app'))`);
  await settle(10);
  p.eval(`openInEditor(${JSON.stringify(PATHS.synthetic)}, '~/.claude/projects/-gone/memory/orphan.md')`);
  await settle(10);
  page = await searchPage(p);
  const chips = () => recent().querySelectorAll('.files-recent-item');
  ok('2 it lists opened files, most recent first, by short name', JSON.stringify(chips().map((c) => p.text(c.querySelector('.files-item-label')))) === JSON.stringify(['orphan.md', 'app', 'pre tool']),
     chips().map((c) => p.text(c)).join(' / '));
  ok('2 each shows its path in a tooltip', chips()[2].title.includes('~/.claude/hooks/pre tool.sh'));
  const r = await boot({ carry: p.store });
  await searchPage(r);
  ok('2 it survives a reload (this browser only)', r.$('content').querySelectorAll('.files-recent-item').length === 3);
  r.$('content').querySelectorAll('.files-recent-item')[0].click();
  await settle(10);
  ok('2 a synthetic memory entry in it reopens with its path display', r.eval('S.view') === 'entry' && r.text(r.$('title-path')) === '~/.claude/projects/-gone/memory/orphan.md');
  const blocked = await boot({ storage: 'throws' });
  await searchPage(blocked);
  blocked.eval(`openEntry(findEntry('hook:pre'))`);
  await settle(10);
  await searchPage(blocked);
  ok('2 with storage blocked the page still renders, the row just stays empty', !!blocked.$('content').querySelector('.files-recent')
     && !blocked.$('content').querySelector('.files-recent-item') && noErrors(blocked), blocked.errors.join(' | '));
  const src = APP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('2 it is never called "recent edits"', !/recent(ly)?[ -]edit/i.test(src + HTML));
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
  ok('3 boot routes through the same table', /routeHash\(hash, \{ cold: true \}\)/.test(code) && /VIEWS\.find\(\(x\) => x\.hash/.test(code));
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
  ok('3 an unknown hash lands on Home (cold)', unknown.eval('S.view') === 'home' && unknown.$('content').querySelector('.home-card'));
  unknown.$('btn-tools').click();
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
  d.navigate('#tools/skills');
  await settle(5);
  ok('3 a hash away from unsaved edits asks, and cancelling stays — hash put back',
     asked === 1 && d.eval('S.view') === 'entry' && d.eval('S.draft') === 'changed' && d.location.hash === before, `${asked} ${d.location.hash}`);
  d.$('btn-memory').click();
  d.$('btn-home').click();
  await settle(5);
  ok('3 sidebar clicks away from unsaved edits ask too, and cancelling stays', asked === 3 && d.eval('S.view') === 'entry');
  d.confirm = () => { asked++; return true; };
  d.navigate('#tools/skills');
  await settle(5);
  ok('3 confirming discards once and goes — no second prompt', asked === 4 && d.eval('S.view') === 'tools', `${asked}`);
}

// ── 4. no inline styles on nav; tokens only ────────────────────────────────
{
  ok('4 index.html has no inline style= at all', !/\sstyle=/.test(HTML));
  const nav = APP.slice(APP.indexOf('/* ── navigation'), APP.indexOf('/* ── opening files'));
  ok('4 the sidebar code sets no inline styles', nav.length > 1000 && !/\.style\b|cssText/.test(nav));
  const outside = CSS.replace(/:root(\[data-theme="light"\])?\s*\{[^}]*\}/g, '');
  const hex = outside.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  ok('4 styles.css has no hex colour outside the :root token blocks', hex.length === 0, hex.join(' '));
  const lightBlock = CSS.match(/:root\[data-theme="light"\]\s*\{[^}]*\}/)[0];
  const used = [...new Set([...CSS.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))];
  // Colours live in the first :root block; scales (Packs' spacing and type) in a :root rule of their own.
  const rootRules = [...CSS.matchAll(/(?:^|\n):root\s*\{[^}]*\}/g)].map((m) => m[0]).join('\n');
  const undefinedTokens = used.filter((t) => !rootRules.includes(`${t}:`) && !/--rail-w/.test(t));
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
  again.$('btn-tools').click();
  await settle(5);
  ok('5 Tools on the icon rail opens the Tools page, the rail left as it is', again.$('app').classList.contains('rail-collapsed') && again.eval('S.view') === 'tools');
  const blocked = await boot({ storage: 'throws', hash: '#tools' });
  ok('5 with localStorage throwing, the page still boots and renders the sidebar',
     blocked.eval('S.view') === 'tools' && blocked.$('sidebar').querySelectorAll('.nav-item').length === 10 && noErrors(blocked), blocked.errors.join(' | '));
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
  // Every create action keeps a button, on the page that lists what it creates.
  const p = await boot();
  const newBtn = (label) => p.$('content').querySelectorAll('button').find((b) => b.textContent === label);
  p.navigate('#tools/skills');
  await settle(5);
  newBtn('New skill').click();
  p.navigate(p.location.hash);
  await settle(5);
  ok('F New skill on Tools opens the skill wizard', p.location.hash === '#skills/new' && p.eval('S.view') === 'skill-new'
     && p.$('btn-tools').getAttribute('aria-current') === 'location');
  p.navigate('#setup&step=settings');
  await settle(5);
  p.ctx.prompt = () => 'newhook';
  newBtn('New hook').click();
  await settle(10);
  ok('F New hook on Setup creates its own kind, and opens the new file in Edit', p.requests.some((r) => r.path === '/api/create' && r.body.kind === 'claude-hook' && r.body.name === 'newhook')
     && p.eval('S.tab') === 'edit');
  p.navigate('#worktrees');
  await settle(5);
  newBtn('Register a project').click();
  await settle(10);
  ok('F Register a project on Worktrees opens the registration form, not a file scaffold',
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
  // External delete and local delete land on Home.

  const e = await boot({ hash: `#file=${encodeURIComponent(PATHS.claudeMd)}` });
  await settle(10);
  const es = e.sources[0];
  es.onmessage({ data: JSON.stringify({ type: 'files', origin: 'outside', removed: [PATHS.claudeMd], removedPaths: [PATHS.claudeMd], added: [], changed: [] }) });
  await settle(10);
  ok('F an outside delete of the open file lands on Home and keeps its sticky notice',
     e.eval('S.view') === 'home' && /deleted outside/.test(e.text(e.$('notice-slot'))));

  const l = await boot({ hash: `#file=${encodeURIComponent(PATHS.hook)}` });
  await settle(10);
  l.eval('deleteOpenEntry()');
  await settle(10);
  ok('F a local delete lands on Home with its notice', l.eval('S.view') === 'home' && /Moved .* to Trash/.test(l.text(l.$('notice-slot'))));
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
  await settle(5);
  p.key('Escape');
  ok('F keyboard: Escape leaves search', !!p.$('search') && p.doc.activeElement !== p.$('search'));

  const n = await boot({ width: 800 });
  n.$('nav-menu').click();
  ok('F narrow: the menu button opens the sidebar overlay', n.$('app').classList.contains('nav-open') && n.$('nav-menu').getAttribute('aria-expanded') === 'true');
  n.$('btn-tools').click();
  await settle(5);
  ok('F narrow: Tools is a view like the rest — the overlay closes and the page opens', !n.$('app').classList.contains('nav-open') && n.eval('S.view') === 'tools');
  n.$('nav-menu').click();
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
  await settle(5);
  ok('F narrow: ⌘K opens Search with its box focused, the overlay left shut', !n.$('app').classList.contains('nav-open') && n.doc.activeElement === n.$('search'));
  const r = await boot({ width: 800, hash: '#tools/mcp' });
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
  p.$('btn-tools').click();
  await settle(5);
  ok('G2 …so the next navigation does not ask again', asked === 1 && p.eval('S.view') === 'tools');
  p.$('btn-home').click();
  p.$('btn-assist').click();
  ok('G2 …and Assist opened from Home attaches no old file', p.eval('active().mentions.length') === 0);

  const q = await boot({ hash: `#file=${encodeURIComponent(PATHS.claudeMd)}` });
  await settle(10);
  q.eval(`S.tab = 'edit'; renderContent();`);
  q.input(q.$('content').querySelector('textarea'), 'unsaved');
  let qa = 0;
  q.confirm = () => { qa++; return false; };
  q.key('k', { meta: true });
  await settle(5);
  ok('G2 ⌘K over unsaved edits asks first; cancelling stays in the editor, edits intact',
     qa === 1 && q.eval('S.view') === 'entry' && q.eval('S.draft') === 'unsaved' && !!q.$('content').querySelector('textarea'));
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
  ok('G4 narrow: ⌘K\'s focus is still on search once every timer has run', n.doc.activeElement === n.$('search'),
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

// ── Re-grade and browser QA (PR A) ─────────────────────────────────────────
{
  // R2: a create action is there even before its group has a file (no agents, commands, hooks or worktree files).
  const routes = routesFor();
  const groups = registry().groups.filter((g) => !['hooks', 'worktrees'].includes(g.id));
  routes.reg.current = registry({ groups });
  const p = await boot({ routes });
  const newBtn = (label) => p.$('content').querySelectorAll('button').find((b) => b.textContent === label);
  p.navigate('#tools/agents');
  await settle(5);
  ok('R2 with no subagents or commands yet, Tools still offers New subagent and New slash command', !!newBtn('New subagent') && !!newBtn('New slash command'));
  p.ctx.prompt = () => 'first';
  newBtn('New subagent').click();
  await settle(10);
  ok('R2 the first subagent can be created', p.requests.some((r) => r.path === '/api/create' && r.body.kind === 'agent' && r.body.name === 'first'));
  p.navigate('#tools/agents');
  await settle(5);
  newBtn('New slash command').click();
  await settle(10);
  ok('R2 …and the first slash command', p.requests.some((r) => r.path === '/api/create' && r.body.kind === 'command'));
  p.navigate('#setup&step=settings');
  await settle(5);
  newBtn('New hook').click();
  await settle(10);
  ok('R2 …and the first hook', p.requests.some((r) => r.path === '/api/create' && r.body.kind === 'hook'));
  p.navigate('#worktrees');
  await settle(5);
  newBtn('Register a project').click();
  await settle(10);
  ok('R2 …and the first project registered, with no Worktrees files yet', !!p.doc.body.querySelector('.wt-overlay'));
}
{
  // R3: every accepted navigation away from a file leaves the editor the same way.
  for (const [label, go] of [['Search', (p) => p.key('k', { meta: true })], ['Tools', (p) => p.$('btn-tools').click()], ['Usage', (p) => p.$('btn-usage').click()]]) {
    const p = await boot({ hash: `#file=${encodeURIComponent(PATHS.hook)}` });
    await settle(10);
    p.eval(`S.tab = 'edit'; renderContent();`);
    p.input(p.$('content').querySelector('textarea'), 'unsaved');
    let asked = 0;
    p.confirm = () => { asked++; return true; };
    go(p);
    await settle(10);
    ok(`R3 edit → ${label} → accept discard: nothing dirty, nothing open`, asked === 1 && !p.eval('isDirty()') && p.eval('S.file') === null && p.eval('S.draft') === '');
    p.$('btn-assist').click();
    ok(`R3 …Assist from ${label} attaches nothing`, p.eval('active().mentions.length') === 0);
    p.key('Escape');
    p.$('btn-home').click();
    await settle(5);
    ok(`R3 …and Home does not ask again`, asked === 1 && p.eval('S.view') === 'home');
  }
}
{
  // R4: the newest navigation during boot wins, clicks and hashes alike.
  const reg = deferred();
  const p = await boot({ routes: routesFor({ 'GET /api/registry': () => reg.promise }) });
  p.$('btn-context').click();
  p.$('btn-tools').click();
  reg.resolve(registry());
  await settle(20);
  ok('R4 Context, then Tools, during boot → Tools', p.eval('S.view') === 'tools', p.eval('S.view'));
  const reg2 = deferred();
  const q = await boot({ routes: routesFor({ 'GET /api/registry': () => reg2.promise }) });
  q.$('btn-models').click();
  q.navigate('#context');
  reg2.resolve(registry());
  await settle(20);
  ok('R4 Models, then a newer #context, during boot → Context', q.eval('S.view') === 'context' && q.location.hash === '#context', q.eval('S.view'));
  const reg3 = deferred();
  const h = await boot({ routes: routesFor({ 'GET /api/registry': () => reg3.promise }) });
  h.$('btn-memory').click();
  h.$('btn-home').click();
  reg3.resolve(registry());
  await settle(20);
  ok('R4 Memory, then Home, during boot → stays on Home (the earlier click is dropped)', h.eval('S.view') === 'home', h.eval('S.view'));
  const reg4 = deferred();
  const k = await boot({ routes: routesFor({ 'GET /api/registry': () => reg4.promise }) });
  k.navigate('#models');
  k.$('btn-context').click();
  reg4.resolve(registry());
  await settle(20);
  ok('R4 #models, then a Context click, during boot → Context', k.eval('S.view') === 'context', k.eval('S.view'));
  const reg5 = deferred();
  const c = await boot({ routes: routesFor({ 'GET /api/registry': () => reg5.promise }) });
  c.$('btn-context').click();
  c.key('k', { meta: true });
  reg5.resolve(registry());
  await settle(20);
  ok('R4 Context, then ⌘K, during boot → Search, its box focused', c.eval('S.view') === 'search' && c.doc.activeElement === c.$('search'), c.eval('S.view'));
}
{
  // QA1: the closed drawer is out of the tab order, and closing returns focus.
  const p = await boot();
  const d = p.$('drawer');
  ok('QA1 the closed drawer is inert and aria-hidden', d.inert === true && d.getAttribute('aria-hidden') === 'true');
  p.$('btn-assist').focus();
  p.$('btn-assist').click();
  ok('QA1 open, it is neither', d.inert === false && !d.hasAttribute('aria-hidden'));
  p.key('Escape');
  ok('QA1 Escape closes it: inert again, focus back on Assist', d.inert === true && d.getAttribute('aria-hidden') === 'true' && p.doc.activeElement === p.$('btn-assist'));
  p.$('btn-assist').click();
  p.$('drawer-close').click();
  ok('QA1 the close button does the same', d.inert === true && p.doc.activeElement === p.$('btn-assist'));
}
{
  // QA2: Escape leaves the editor without discarding anything; Tab still indents.
  const p = await boot({ hash: `#file=${encodeURIComponent(PATHS.claudeMd)}` });
  await settle(10);
  p.key('e', { meta: true });
  await settle(5);
  const ta = p.$('content').querySelector('textarea');
  ta.focus();
  p.input(ta, 'typed');
  const tab = p.key('Tab');
  ok('QA2 Tab still indents in the editor', tab.defaultPrevented && p.eval('S.draft').includes('  '));
  p.key('Escape');
  ok('QA2 Escape moves focus out to Save, edits kept', p.doc.activeElement === p.$('btn-save') && p.eval('isDirty()') && p.eval('S.tab') === 'edit');
  ok('QA2 the editor status says how', /Esc/.test(p.text(p.$('status-left'))));
  const q = await boot({ hash: `#file=${encodeURIComponent(PATHS.claudeMd)}` });
  await settle(10);
  q.key('e', { meta: true });
  await settle(5);
  q.$('content').querySelector('textarea').focus();
  q.key('Escape');
  ok('QA2 with nothing to save, Escape lands on the active tab instead', q.doc.activeElement?.classList?.contains('tab') && q.doc.activeElement.classList.contains('active'));
}
{
  // QA3: labels that collide get their parent segment, as a page's file list renders them. The fixture's
  // look-alike instruction files are served as the Worktree rules list, one of the lists that page renders.
  const routes = routesFor();
  const reg = registry();
  const alike = reg.groups.find((g) => g.id === 'memory').entries.filter((e) => e.scope === 'project');
  reg.groups.find((g) => g.id === 'worktrees').entries = alike;
  routes.reg.current = reg;
  const p = await boot({ routes, hash: '#worktrees' });
  await settle(10);
  const shownRow = (id) => p.$('content').querySelectorAll('.entry-row').find((r) => r.dataset.entry === id);
  const labels = Object.fromEntries(alike.map((e) => [e.id, shownRow(e.id) ? p.text(shownRow(e.id).querySelector('.scope-path')) : null]));
  const web = ['md:web1', 'md:web2'].map((id) => labels[id]);
  ok('QA3 two "apps/web" entries are told apart by their parent', JSON.stringify(web) === JSON.stringify(['alpha/apps/web', 'alpha-feature/apps/web']), web.join(' | '));
  const af = ['md:af-trunk', 'md:af-wt'].map((id) => labels[id]);
  ok('F2 a trunk and its worktree grow parent context until they differ', JSON.stringify(af) === JSON.stringify(['shop-trunk/storefront/lib/production', 'shop-feature/storefront/lib/production']), af.join(' | '));
  const boat = ['md:boat-agents', 'md:boat-claude'].map((id) => labels[id]);
  ok('F2 two files in the same folder are told apart by filename, without growing the path', JSON.stringify(boat) === JSON.stringify(['personal/side-project · AGENTS.md', 'personal/side-project · CLAUDE.md']), boat.join(' | '));
  const all = Object.values(labels);
  ok('F2 within the rendered list, every label is unique', all.every(Boolean) && new Set(all).size === all.length, all.join(', '));
  p.navigate('#setup&step=settings');
  await settle(5);
  const hook = p.$('content').querySelectorAll('.entry-row').find((r) => r.dataset.entry === 'hook:pre');
  ok('QA3 …and a unique label is left alone', p.text(hook.querySelector('.scope-path')) === 'pre tool');
}
{
  // QA4: Save only where there is a file.
  const p = await boot();
  const hidden = [];
  for (const v of ['home', 'context', 'usage', 'tools']) { p.$(`btn-${v}`).click(); await settle(5); hidden.push(p.$('btn-save').hidden); }
  p.key('k', { meta: true }); await settle(5); hidden.push(p.$('btn-save').hidden);
  ok('QA4 Save is hidden on Home, Context, Usage, Tools and Search', hidden.every(Boolean), hidden.join(','));
  p.eval(`openEntry(findEntry('hook:pre'))`);
  await settle(10);
  ok('QA4 on an open file it shows, disabled until there is something to save', !p.$('btn-save').hidden && p.$('btn-save').disabled);
}
{
  // QA5 and the runtime unknown hash.
  const css = CSS.slice(CSS.indexOf('@media (max-width: 900px)'));
  ok('QA5 at ≤900px the topbar stays on one line, the title truncating', /\.topbar\s*\{[^}]*flex-wrap:\s*nowrap/.test(css) && /\.title-block\s*\{[^}]*min-width:\s*0/.test(css));
  const p = await boot();
  p.navigate('#bogus');
  await settle(5);
  ok('R9 an unknown hash typed on Home is cleared, as on a cold load', p.eval('S.view') === 'home' && p.location.hash === '');
}

{
  // A refused Assist turn (builds/ready-for-strangers B1/B2) reads as a plain
  // notice in the chat drawer and after a compaction — not a crash, and with
  // no reply text or proposal kept.
  const REFUSAL = 'Grok Assist is unavailable while grok has MCP servers configured (jev): grok starts them for every run, and ACS cannot keep them out.';
  const chats = [];
  const routes = routesFor({ 'POST /api/chat': (b) => { chats.push(b); return ndjson([{ t: 'error', message: REFUSAL }]); } });
  const p = await boot({ routes });
  await settle(20);
  p.eval(`C.sessions = [{ id: 'sr', title: 't', mentions: [], createdAt: 0, updatedAt: 0, messages: [],
    slots: { claude: { cliSessionId: 'old-1', seed: null, stats: { turns: 3, contextTokens: 90000, baselineTokens: 1000, costUsd: 0 } } } }];
    C.activeId = 'sr';`);
  p.$('btn-assist').click();
  p.eval(`C.draft = 'tighten it'; sendTurn();`);
  await settle(30);
  const body = p.$('drawer-body');
  const shown = body.querySelectorAll('.notice.error').map((n) => p.text(n));
  ok('B2 a refused turn shows its reason as a plain notice in the chat drawer', chats.length === 1 && shown.some((t) => t.includes(REFUSAL)), shown.join(' | '));
  ok('B2 …with no reply text and no proposal kept', p.eval(`active().messages.at(-1).text === '' && !active().messages.at(-1).proposals`) && !body.querySelectorAll('button').some((b) => b.textContent === 'Accept'));
  ok('B2 …and the drawer is usable again (not stuck busy)', p.eval('C.busy') === false);
  p.eval('compactSession()');
  await settle(30);
  ok('B2 a refused compaction says why, as a notice', /Compaction failed: Grok Assist is unavailable/.test(p.text(p.$('notice-slot'))), p.text(p.$('notice-slot')));
  ok('B2 …and keeps the session it had', p.eval(`slotFor(active(), 'claude').cliSessionId`) === 'old-1');
}

for (const p of pages) { p.done(); for (const s of p.sources) s.close(); }
const stray = pages.flatMap((p) => p.errors);
ok('no page errors across every page booted', stray.length === 0, stray.slice(0, 3).join(' | '));
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
