/* Agent Config Studio — front end */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const esc = (s) => s.replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Render markdown, then strip anything executable from the result.
 * The preview shows third-party plugin skills and model-generated assist
 * output, and marked passes raw HTML straight through — an `onerror` handler
 * in a skill file would otherwise run with same-origin access to the write API.
 */
const DANGEROUS_TAGS = 'script,style,iframe,object,embed,link,meta,form,base';
function renderMarkdown(src) {
  const host = document.createElement('div');
  host.innerHTML = marked.parse(src);
  host.querySelectorAll(DANGEROUS_TAGS).forEach((n) => n.remove());
  host.querySelectorAll('*').forEach((n) => {
    for (const attr of [...n.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.replace(/\s+/g, '').toLowerCase();
      if (name.startsWith('on')) n.removeAttribute(attr.name);
      else if (/^(href|src|xlink:href|action|formaction)$/.test(name) &&
               /^(javascript|vbscript|data:text\/html)/.test(value)) {
        n.removeAttribute(attr.name);
      }
    }
  });
  return host.innerHTML;
}

/**
 * localStorage, fail-soft. A private window or blocked site data makes the
 * accessor itself throw, and every value kept here is a convenience the page
 * must still start without.
 */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* quota, private mode, blocked */ } },
};

const S = {
  registry: null,
  view: 'home',         // 'entry', or a content view's id in VIEWS
  entry: null,
  file: null,           // { path, kind, content, mtime, display }
  original: '',
  draft: '',
  tab: 'preview',
  badges: { models: 0 },
  navs: 0,              // navigations asked for since load; first run checks it
};

/**
 * Every place the sidebar can take you, in one table: boot's deep links, the
 * runtime hash router, the topbar title, renderContent and the sidebar itself
 * all read it. `kind: 'action'` rows (Files, Theme) act in place rather than
 * switch the view; `group: null` rows are views with no sidebar item.
 */
const VIEWS = [
  { id: 'home', label: 'Home', group: 'home', icon: 'home', hash: '#home',
    title: 'Home', sub: 'What is connected, what is left, and what needs you', open: openHome, render: renderHome,
    titleExtra: homeNeedsChip },
  { id: 'files', label: 'Files', group: 'configure', icon: 'files', hash: '#files',
    title: 'Files', sub: 'Every config file, by the tool that reads it', open: () => openFiles(), render: renderFiles },
  { id: 'skills', label: 'Skills', group: 'configure', icon: 'skills', hash: '#skills',
    title: 'Skills', sub: 'Every skill on this machine — browse, select, download', open: openSkills },
  { id: 'mcp', label: 'MCP', group: 'configure', icon: 'mcp', hash: '#mcp',
    title: 'MCP servers', sub: 'Model Context Protocol servers across both harnesses', open: openMcp },
  // No sidebar item: reached from the Files page's folder line, and #folders.
  { id: 'folders', label: 'Folders', group: null, icon: 'folders', hash: '#folders',
    title: 'Folders', sub: 'The project folders the studio reads and edits', open: openFolders },
  // No sidebar item either: first run lands here, and Home links to it.
  { id: 'setup', label: 'Setup', group: null, icon: 'home', hash: '#setup',
    title: 'Setup', sub: 'CLIs, accounts and project folders — each step optional', open: openSetup },
  { id: 'models', label: 'Models', group: 'configure', icon: 'models', hash: '#models',
    title: 'Models', sub: 'Every model family, its current id, and what the CLIs offer', open: openModels,
    badge: () => S.badges.models },
  { id: 'memory', label: 'Memory', group: 'review', icon: 'memory', hash: '#memory',
    title: 'Memory', sub: 'Claude auto-memory by project — review, and clean up with a preview first', open: openMemory },
  { id: 'context', label: 'Context', group: 'review', icon: 'context', hash: '#context',
    title: 'Context', sub: 'What each project tells its agents — CLAUDE.md, AGENTS.md, Cursor rules', open: openContext },
  { id: 'worktrees', label: 'Worktrees', group: 'review', icon: 'worktrees', hash: '#worktrees',
    title: 'Worktrees', sub: 'Every registered project’s worktrees — env, and which are provably done', open: openWorktrees },
  { id: 'usage', label: 'Usage', group: 'review', icon: 'usage', hash: '#usage',
    title: 'Usage', sub: 'Subscription headroom per seat — where the next task should go', open: openUsage },
  { id: 'scope', label: 'Scope', group: 'review', icon: 'scope', hash: '#scope',
    title: 'Scope chain', sub: 'What actually applies when an agent runs in a directory', open: openScope },
  { id: 'trash', label: 'Trash', group: 'footer', icon: 'trash', hash: '#trash',
    title: 'Trash', sub: 'Deleted items — restorable', open: openTrash },
  { id: 'theme', label: 'Theme', group: 'footer', icon: 'theme', kind: 'action', open: toggleTheme },
];
const viewById = (id) => VIEWS.find((v) => v.id === id) || null;
const NAV_GROUPS = [['home', null], ['configure', 'Configure'], ['review', 'Review']];

/* Stroke icons, 16px, drawn in currentColor so both themes colour them. */
const svg = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  home: svg('<path d="M2.5 7.2 8 2.8l5.5 4.4V13a.5.5 0 0 1-.5.5H9.5V10h-3v3.5H3a.5.5 0 0 1-.5-.5z"/>'),
  files: svg('<path d="M2.5 4a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>'),
  skills: svg('<path d="M8 2.2l1.6 3.3 3.6.5-2.6 2.5.6 3.6L8 10.4l-3.2 1.7.6-3.6-2.6-2.5 3.6-.5z"/>'),
  mcp: svg('<path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11.5v2"/>'),
  folders: svg('<path d="M2.5 5a1 1 0 0 1 1-1h2.5l1.2 1.2h5.3a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/><path d="M2.5 7.5h11"/>'),
  models: svg('<rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M6.5 1.8v2.2M9.5 1.8v2.2M6.5 12v2.2M9.5 12v2.2M1.8 6.5H4M1.8 9.5H4M12 6.5h2.2M12 9.5h2.2"/>'),
  memory: svg('<path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h8v10.5h-8A1.5 1.5 0 0 0 3 14zM3 14V3.5M6 5h4"/>'),
  context: svg('<path d="M8 2 2.5 5 8 8l5.5-3zM2.5 8 8 11l5.5-3M2.5 11 8 14l5.5-3"/>'),
  worktrees: svg('<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-3 2.5-5.5 4"/>'),
  usage: svg('<path d="M2.5 11.5a5.5 5.5 0 1 1 11 0"/><path d="M8 11.5 10.5 7"/>'),
  scope: svg('<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2"/>'),
  trash: svg('<path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.6 8.6a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8.6"/>'),
  sun: svg('<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>'),
  moon: svg('<path d="M13.2 9.6A5.5 5.5 0 0 1 6.4 2.8a5.5 5.5 0 1 0 6.8 6.8z"/>'),
  chevron: svg('<path d="M6 3.5 10.5 8 6 12.5"/>'),
  rail: svg('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M6 2.5v11"/>'),
  menu: svg('<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>'),
};

/* ── api ─────────────────────────────────────────────────────────────── */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ── notices ─────────────────────────────────────────────────────────── */
let noticeTimer;
function notice(kind, text, list, sticky) {
  clearTimeout(noticeTimer);
  const slot = $('notice-slot');
  slot.innerHTML = '';
  const n = el('div', `notice ${kind}`);
  n.appendChild(el('div', null, text));
  if (list?.length) {
    const ul = el('ul');
    list.forEach((x) => ul.appendChild(el('li', null, x)));
    n.appendChild(ul);
  }
  slot.appendChild(n);
  if (!sticky) noticeTimer = setTimeout(() => { slot.innerHTML = ''; }, 6000);
}
const clearNotice = () => { clearTimeout(noticeTimer); $('notice-slot').innerHTML = ''; };

/* ── boot ────────────────────────────────────────────────────────────── */
/** Resolves true once the registry is in, false if it could not be read. */
let registryReady = Promise.resolve(false);

async function boot() {
  marked.setOptions({ gfm: true, breaks: false, mangle: false, headerIds: false });
  renderNav();
  wireGlobalKeys();
  restoreSessions();
  // The shell paints before the registry resolves: the registry waits on model
  // inspection, and Home's cards fetch their own sources. Every other deep
  // link needs the registry, so it routes once that is in.
  const hash = location.hash;
  // Setup fetches its own sources, so it opens before the registry like Home.
  const early = landsOnHome(hash) || hashIs(hash, '#setup');
  registryReady = loadRegistry();
  if (early) routeHash(hash, { cold: true });
  firstRunCheck(hash);
  if (!(await registryReady)) { if (!early) goHome(); return; }
  connectEvents();
  resolveHarness();
  // Assist may have been opened while detection was still out: repaint it with the harnesses.
  if ($('drawer').classList.contains('open')) renderChat();
  paintModelsBadge(S.registry.modelAlerts || 0);
  if (S.registry.registryError) {
    notice('warn', 'The model registry has a problem — Assist is using what it could:',
      S.registry.registryError.split('\n'), true);
  }
  // The newest navigation asked for while the registry was out — a sidebar
  // click or a hash change, whichever came last — and only that one.
  const want = S.pendingNav;
  S.pendingNav = null;
  if (want != null) routeHash(want);
  else if (!early) routeHash(location.hash, { cold: true });
}

async function loadRegistry() {
  try {
    S.registry = await api('GET', '/api/registry');
  } catch (e) {
    S.registryFailed = e.message;
    renderSidebar();
    $('brand-sub').textContent = 'registry unavailable';
    notice('error', `Could not load the config registry: ${e.message}. Reload to try again.`, null, true);
    if (S.view === 'home') paintHome(['recent']);
    return false;
  }
  seedCollapsed();
  renderSidebar();
  const total = S.registry.groups.reduce(
    (n, g) => n + g.entries.reduce((m, e) => m + e.files.length, 0), 0);
  $('brand-sub').textContent = `${total} files · ${S.registry.history.commits} versions`;
  renderStatus();
  if (S.view === 'home') paintHome(['recent']);
  return true;
}

/**
 * First run: with no setup.json, the default landing is #setup. Only the
 * default — a deep link is honoured — and only if nobody has navigated since
 * the page loaded, so a slow answer never yanks someone out of a view they
 * chose. A setup.json that cannot be read is said on Home, never a redirect
 * loop: setup offers to rewrite it.
 */
function firstRunCheck(hash) {
  const navs = S.navs;
  api('GET', '/api/setup/status').then((st) => {
    S.setupState = st.state;
    if (st.state === 'error') {
      notice('warn', `${st.error}. Open setup from Home to rewrite it.`, null, true);
      return;
    }
    if (st.state === 'none' && S.navs === navs && S.view === 'home' && landsOnHome(hash)) openSetup();
  }, () => { /* no answer: stay where we are */ });
}

/** Whether routeHash would land this hash on Home: no file, no drawer, no view. */
function landsOnHome(hash) {
  if (hashIs(hash, '#assist') || /^#file=/.test(hash)) return false;
  const v = VIEWS.find((x) => x.hash && hashIs(hash, x.hash));
  return !v || v.id === 'home';
}

/**
 * Deep links. `#file=<encoded path>` opens a file, `#assist` opens the drawer
 * over Home, and every VIEWS row with a hash opens its view. Anything else
 * lands on Home. On a cold load the Files panel stays shut even for a file
 * link: it is collapsed on every load.
 */
/** A hash names a view exactly, optionally followed by &-parameters: #models-x is not #models. */
const hashIs = (hash, h) => hash === h || hash.startsWith(`${h}&`);

function routeHash(hash, { cold = false } = {}) {
  if (hashIs(hash, '#assist')) {
    if (cold) goHome();
    return openDrawer();
  }
  const m = hash.match(/^#file=([^&]+)/);
  if (m) {
    let p = null;
    try { p = decodeURIComponent(m[1]); } catch { /* a malformed escape is an unknown link */ }
    const entry = p && entryForFile(p);
    if (entry) {
      if (!cold && S.view === 'entry' && S.file?.path === p) return;
      return openEntry(entry, p);
    }
    return cold ? goHome() : openHome();
  }
  const v = VIEWS.find((x) => x.hash && hashIs(hash, x.hash));
  if (v) {
    if (!cold && S.view === v.id) return;
    return v.open();
  }
  if (cold) return goHome();
  if (S.view !== 'home') openHome(); else window.history.replaceState(null, '', location.pathname + location.search);
}

function entryForFile(p) {
  for (const g of S.registry?.groups || []) {
    const e = g.entries.find((x) => x.files.some((f) => f.path === p));
    if (e) return e;
  }
  return null;
}

/* ── navigation ──────────────────────────────────────────────────────── */
/** The sidebar is navigation only: built once from VIEWS, then only re-marked. */
const UI = {
  rail: store.get('acs.rail') === 'collapsed' ? 'collapsed' : 'expanded',
};
const narrow = () => !!window.matchMedia?.('(max-width: 900px)').matches;

function renderNav() {
  const nav = $('nav');
  nav.innerHTML = '';
  for (const [group, title] of NAV_GROUPS) {
    const sec = el('div', 'nav-group');
    if (title) sec.appendChild(el('div', 'nav-group-title', title));
    for (const v of VIEWS.filter((x) => x.group === group)) sec.appendChild(navButton(v));
    nav.appendChild(sec);
  }
  const foot = $('nav-foot');
  foot.innerHTML = '';
  for (const v of VIEWS.filter((x) => x.group === 'footer')) foot.appendChild(navButton(v));

  $('rail-toggle').onclick = () => setRail(UI.rail === 'collapsed' ? 'expanded' : 'collapsed');
  $('nav-menu').innerHTML = ICONS.menu;
  $('nav-menu').onclick = () => setNavOverlay(!$('app').classList.contains('nav-open'));
  $('nav-scrim').onclick = () => setNavOverlay(false);
  setRail(UI.rail, { save: false });
  syncNav();
}

function navButton(v) {
  const b = el('button', 'nav-item');
  b.id = `btn-${v.id}`;
  b.dataset.view = v.id;
  b.title = v.label;
  const icon = el('span', 'nav-icon');
  icon.innerHTML = ICONS[v.icon] || '';
  b.appendChild(icon);
  b.appendChild(el('span', 'nav-label', v.label));
  if (v.badge) {
    const badge = el('span', 'nav-badge');
    badge.hidden = true;
    b.appendChild(badge);
  }
  b.onclick = () => {
    if (v.kind !== 'action') setNavOverlay(false);
    if (navNow(v)) v.open();
  };
  return b;
}

/**
 * The gate every navigation passes — sidebar clicks and ⌘K alike. Other
 * views need the registry: before it lands a request only takes the one
 * pending-navigation slot (see boot), so a newer one replaces it. Views that
 * open at once (Home, Files) supersede whatever was pending.
 */
function navNow(v) {
  S.navs++;
  if (!S.registry && v.kind !== 'action' && v.id !== 'home' && v.id !== 'files' && v.id !== 'setup') { S.pendingNav = v.hash; return false; }
  if (v.kind !== 'action') S.pendingNav = null;
  return true;
}

/** Re-mark the sidebar: the current view, badges, and the theme toggle. */
function syncNav() {
  for (const v of VIEWS) {
    const b = $(`btn-${v.id}`);
    if (!b) continue;
    const here = v.kind !== 'action' && S.view === v.id;
    b.classList.toggle('active', here);
    if (here) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    if (v.badge) {
      const n = v.badge() || 0;
      const badge = b.querySelector('.nav-badge');
      badge.hidden = n <= 0;
      badge.textContent = n > 0 ? String(n) : '';
      b.title = n > 0 ? `${v.label} — ${n} alert${n === 1 ? '' : 's'}` : v.label;
    }
  }
  const theme = $('btn-theme');
  if (theme) {
    const dark = document.documentElement.dataset.theme !== 'light';
    theme.querySelector('.nav-icon').innerHTML = dark ? ICONS.sun : ICONS.moon;
    theme.querySelector('.nav-label').textContent = dark ? 'Light theme' : 'Dark theme';
    theme.title = dark ? 'Switch to the light theme' : 'Switch to the dark theme';
  }
}

function setRail(mode, { save = true } = {}) {
  UI.rail = mode;
  const collapsedRail = mode === 'collapsed';
  $('app').classList.toggle('rail-collapsed', collapsedRail);
  const t = $('rail-toggle');
  t.innerHTML = ICONS.rail;
  t.setAttribute('aria-label', collapsedRail ? 'Expand sidebar' : 'Collapse sidebar');
  t.title = collapsedRail ? 'Expand sidebar' : 'Collapse sidebar';
  t.setAttribute('aria-pressed', String(collapsedRail));
  if (save) store.set('acs.rail', mode);
}

function setNavOverlay(open, { focusNav = true } = {}) {
  $('app').classList.toggle('nav-open', open);
  $('nav-menu').setAttribute('aria-expanded', String(open));
  $('nav-menu').setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  // Only while it is still open: closing it before the timer runs must not steal focus back.
  if (open && focusNav) setTimeout(() => { if ($('app').classList.contains('nav-open')) $('sidebar').querySelector('.nav-item')?.focus(); }, 0);
}

/** ⌘K: search lives at the top of the Files page, so it opens that page. */
function focusSearch() {
  setNavOverlay(false);
  if (navNow(viewById('files'))) openFiles({ focus: true });
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('acs.theme', next);
  syncNav();
}

/* ── Files page ──────────────────────────────────────────────────────── */
/**
 * Every config file on one page: search first, then what you opened lately,
 * then each tool's files by type. Hooks, subagents, commands and settings
 * have no other panel, so this is their home, and each type keeps its "+".
 */
const stored = store.get('acs.collapsed');
const collapsed = new Set((() => {
  try { const v = stored ? JSON.parse(stored) : []; return Array.isArray(v) ? v : []; } catch { return []; }
})());
/** First run: low-traffic groups (the server marks them) start folded. */
function seedCollapsed() {
  if (stored) return;
  for (const tool of filesModel(S.registry)) {
    for (const t of tool.types) if (t.group.collapsed) collapsed.add(t.key);
  }
}

const RECENT_KEY = 'acs.recentFiles';
/** Recently opened, kept in this browser only. It records opens, never edits. */
function recentFiles() {
  try { const v = JSON.parse(store.get(RECENT_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function rememberOpened(f, entry) {
  store.set(RECENT_KEY, JSON.stringify(pushRecent(recentFiles(), {
    path: f.path, display: f.display, label: entry?.label ?? f.display.split('/').pop(),
    synthetic: !!entry?.id?.startsWith('adhoc:'),
  })));
}

const FILES = { query: '', timer: null, scrolled: false, unfold: null };

function openFiles({ focus = false } = {}) {
  if (S.view !== 'files') {
    if (!confirmDiscard()) return;
    S.view = 'files';
    leaveEditor();
    FILES.query = '';
    FILES.scrolled = false;
    FILES.unfold = 'pending';       // the open file's type shows this visit, even if folded
    window.history.replaceState(null, '', '#files');
    renderSidebar();
    renderAll();
  }
  if (focus) { $('search')?.focus(); $('search')?.select(); }
}

function renderFiles(c) {
  const page = el('div', 'files');
  const top = el('div', 'files-search-wrap');
  const input = el('input', 'search files-search');
  input.id = 'search';
  input.placeholder = 'Search all config…  ⌘K';
  input.setAttribute('aria-label', 'Search all config');
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = FILES.query;
  input.addEventListener('input', () => {
    clearTimeout(FILES.timer);
    FILES.query = input.value.trim();
    if (FILES.query.length < 2) return paintFilesBody();
    FILES.timer = setTimeout(paintFilesBody, 220);
  });
  top.appendChild(input);
  page.appendChild(top);
  const body = el('div', 'files-body');
  body.id = 'files-body';
  page.appendChild(body);
  c.appendChild(page);
  paintFilesBody();
}

/** The part below the search box: results while searching, else recent + tools. */
function paintFilesBody() {
  const body = $('files-body');
  if (!body || S.view !== 'files') return;
  body.innerHTML = '';
  if (FILES.query.length >= 2) return paintSearch(body, FILES.query);
  body.appendChild(recentCard());
  body.appendChild(foldersLine());
  if (!S.registry) {
    body.appendChild(el('div', 'scope-sub', S.registryFailed
      ? `The file list is unavailable: ${S.registryFailed}. Reload to try again.` : 'Loading files…'));
    return;
  }
  const model = filesModel(S.registry);
  if (FILES.unfold === 'pending') {
    FILES.unfold = model.flatMap((t) => t.types).find((t) => t.entries.some((e) => e.id === S.lastEntryId))?.key ?? null;
  }
  const tools = el('div', 'files-tools');
  for (const tool of model) tools.appendChild(toolCard(tool));
  body.appendChild(tools);
  const here = tools.querySelector('.files-item.active');
  if (here && !FILES.scrolled) { FILES.scrolled = true; here.scrollIntoView?.({ block: 'center' }); }
}

/** One line under Recent: which project folders the file list comes from. */
function foldersLine() {
  const line = el('div', 'scope-sub files-folders');
  if (FOLDERS.data) fillFoldersLine(line, FOLDERS.data);
  // Filled in place when the list arrives, so the page around it (scroll,
  // the unfolded type) is not repainted for it.
  else loadFolders().then((d) => { if (d && line.isConnected !== false) fillFoldersLine(line, d); });
  return line;
}

function fillFoldersLine(line, d) {
  line.innerHTML = '';
  const more = el('button', 'btn ghost', 'Folders');
  more.onclick = () => openFolders();
  if (d.state === 'error') line.appendChild(el('span', null, `Project folders unavailable: ${d.error}. `));
  else if (!d.roots.length) line.appendChild(el('span', null, 'No project folders yet — run acs roots add <path>. '));
  else {
    line.appendChild(el('span', null, `Project folders: ${d.roots.map((r) => `${r.label} (${r.status === 'missing' ? 'missing' : r.access === 'edit' ? 'edit' : 'read-only'})`).join(' · ')} `));
  }
  line.appendChild(more);
  return line;
}

function recentCard() {
  const card = el('section', 'home-card files-recent');
  const head = el('div', 'home-card-head');
  head.appendChild(el('h2', 'home-card-title', 'Recently opened'));
  card.appendChild(head);
  const row = el('div', 'files-recent-row');
  const items = recentFiles().filter((r) => r.synthetic || entryForFile(r.path));
  if (!items.length) row.appendChild(el('div', 'home-muted', 'Files you open appear here — in this browser only.'));
  for (const r of items) {
    const b = el('button', 'files-recent-item');
    const entry = entryForFile(r.path);
    b.appendChild(el('span', `item-dot ${entry?.harness || 'claude'}`));
    b.appendChild(el('span', 'files-item-label', r.synthetic ? r.display.split('/').pop() : (entry?.label ?? r.label)));
    b.title = r.display;
    b.onclick = () => (entry ? openEntry(entry, r.path) : openInEditor(r.path, r.display));
    row.appendChild(b);
  }
  card.appendChild(row);
  return card;
}

function toolCard(tool) {
  const card = el('section', `home-card files-tool files-tool-${tool.id}`);
  const head = el('div', 'home-card-head');
  head.appendChild(el('h2', 'home-card-title', tool.label));
  head.appendChild(el('span', 'files-count', `${tool.count} file${tool.count === 1 ? '' : 's'}`));
  card.appendChild(head);
  for (const t of tool.types) {
    const sec = el('div', 'files-type');
    // A row, not a button — it holds its own "+" button, and nesting
    // interactive elements inside a button is invalid.
    const row = el('div', 'files-type-head');
    const toggle = el('button', 'files-type-toggle');
    const folded = collapsed.has(t.key) && FILES.unfold !== t.key;
    toggle.setAttribute('aria-expanded', String(!folded));
    toggle.appendChild(el('span', 'files-type-name', t.label));
    toggle.appendChild(el('span', 'files-type-count', String(t.entries.length)));
    toggle.onclick = () => {
      if (FILES.unfold === t.key) { FILES.unfold = null; if (!collapsed.has(t.key)) collapsed.add(t.key); }
      else if (collapsed.has(t.key)) collapsed.delete(t.key); else collapsed.add(t.key);
      store.set('acs.collapsed', JSON.stringify([...collapsed]));
      paintFilesBody();
    };
    row.appendChild(toggle);
    if (t.create) {
      const add = el('button', 'files-add', '+');
      add.title = `New ${t.group.title.replace(/s$/, '').toLowerCase()}`;
      add.setAttribute('aria-label', add.title);
      add.onclick = () => createInGroup(t.group);
      row.appendChild(add);
    }
    sec.appendChild(row);
    const list = el('div', 'files-entries');
    list.hidden = folded;
    if (!t.entries.length) list.appendChild(el('div', 'files-empty', 'Empty — + creates the first one.'));
    for (const e of t.entries) {
      const b = el('button', 'files-item' + (S.lastEntryId === e.id ? ' active' : ''));
      b.dataset.entry = e.id;
      b.appendChild(el('span', `item-dot ${e.harness}`));
      b.appendChild(el('span', 'files-item-label', t.labels[e.id]));
      if (e.extraFiles > 0) b.appendChild(el('span', 'item-badge', `+${e.extraFiles}`));
      const where = e.where ? `${e.where}\n${e.display}` : e.display;
      b.title = e.description ? `${where}\n\n${e.description}` : where;
      b.onclick = () => openEntry(e);
      list.appendChild(b);
    }
    sec.appendChild(list);
    card.appendChild(sec);
  }
  return card;
}

async function paintSearch(body, q) {
  body.appendChild(el('div', 'scope-sub', '')).innerHTML = '<span class="spinner"></span> searching…';
  let data;
  try { data = await api('GET', `/api/search?q=${encodeURIComponent(q)}`); }
  catch (e) { if (FILES.query === q) { body.innerHTML = ''; body.appendChild(el('div', 'scope-sub', e.message)); } return; }
  // Typed on since, or left the page: this answer is for a query nobody holds.
  if (FILES.query !== q || S.view !== 'files') return;
  body.innerHTML = '';
  const box = el('div', 'results');
  box.appendChild(el('div', 'scope-sub',
    data.hits.length ? `${data.hits.length} files contain “${q}”` : `Nothing matches “${q}”.`));
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');

  for (const h of data.hits) {
    const b = el('button', 'result');
    const head = el('div', 'result-head');
    head.appendChild(el('span', `item-dot ${h.harness}`));
    head.appendChild(el('span', 'result-name', `${h.entryLabel}${h.file !== 'SKILL.md' ? ' · ' + h.file : ''}`));
    head.appendChild(el('span', 'item-badge', h.group));
    head.appendChild(el('span', 'result-path', h.display));
    b.appendChild(head);
    for (const m of h.matches) {
      const line = el('div', 'result-line');
      line.innerHTML = `<span class="result-ln">${m.line}</span>` +
        esc(m.text).replace(rx, (x) => `<b>${x}</b>`);
      b.appendChild(line);
    }
    if (h.total > h.matches.length) {
      b.appendChild(el('div', 'result-line', `  +${h.total - h.matches.length} more`));
    }
    b.onclick = () => {
      const entry = findEntry(h.entryId);
      if (entry) openEntry(entry, h.path);
    };
    box.appendChild(b);
  }
  body.appendChild(box);
}

/** Every opener calls this: re-mark the sidebar, and keep an open Files page current. */
function renderSidebar() {
  syncNav();
  if (S.view === 'files') paintFilesBody();
}

function findEntry(id) {
  for (const g of S.registry?.groups || []) {
    const e = g.entries.find((x) => x.id === id);
    if (e) return e;
  }
  return null;
}

/* ── opening files ───────────────────────────────────────────────────── */
function confirmDiscard() {
  if (!isDirty()) return true;
  return confirm('You have unsaved changes. Discard them?');
}
const isDirty = () => S.file && S.draft !== S.original;

async function openEntry(entry, filePath) {
  if (!confirmDiscard()) return;
  S.entry = entry;
  S.lastEntryId = entry.id;         // what the Files page highlights when you go there
  S.view = 'entry';
  clearNotice();
  renderSidebar();
  await loadFile(filePath || entry.primary || entry.files[0]?.path);
}

async function loadFile(p) {
  if (!p) return;
  try {
    const f = await api('GET', `/api/file?path=${encodeURIComponent(p)}`);
    S.file = f;
    S.original = f.content;
    S.draft = f.content;
    S.revoked = false;
    S.tab = S.tab === 'history' || S.tab === 'compare' ? 'preview' : S.tab;
    window.history.replaceState(null, '', `#file=${encodeURIComponent(f.path)}`);
    rememberOpened(f, S.entry);
    renderAll();
  } catch (e) {
    notice('error', e.message, null, true);
  }
}

/* ── chrome ──────────────────────────────────────────────────────────── */
function renderAll() {
  renderTopbar();
  renderFilebar();
  renderTabs();
  renderContent();
  renderStatus();
}

function renderTopbar() {
  const t = $('title');
  t.innerHTML = '';
  if (S.view === 'entry' && S.entry) {
    t.appendChild(el('span', 'title-text', S.entry.label));
    const tag = el('span', `harness-tag ${S.entry.harness}`,
      S.entry.harness === 'both' ? 'shared' : S.entry.harness);
    t.appendChild(tag);
    $('title-path').textContent = S.file?.display || S.entry.display;
  } else {
    const v = viewById(S.view) || viewById('home');
    t.textContent = v.title;
    $('title-path').textContent = v.sub;
    const extra = v.titleExtra?.();
    if (extra) t.appendChild(extra);
  }
  const onEntry = S.view === 'entry' && !!S.file;
  // Assist is a chat over the whole corpus — reachable with nothing open.
  $('btn-assist').disabled = false;

  const del = $('btn-delete');
  del.hidden = !onEntry;
  del.disabled = !onEntry || !S.entry?.deletable;
  del.title = S.entry?.deletable === false
    ? (S.entry.undeletableReason || 'Cannot be deleted')
    : 'Delete (moves to trash, recoverable)';

  // Copying a skill across harnesses is only meaningful for skills.
  const copy = $('btn-copy');
  const isSkill = S.entry?.kindLabel === 'skill' && /SKILL\.md$/.test(S.file?.path || '');
  copy.hidden = !(onEntry && isSkill);
  if (!copy.hidden) {
    copy.textContent = S.entry.harness === 'claude' ? 'Copy to Codex' : 'Copy to Claude';
  }
}

function renderFilebar() {
  const bar = $('filebar');
  const files = S.entry?.files || [];
  const group = S.entry ? S.registry.groups.find((g) => g.entries.includes(S.entry)) : null;
  const canAdd = !!group?.canAddFiles && S.entry?.kindLabel === 'skill';

  if (S.view !== 'entry' || (files.length < 2 && !canAdd)) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = '';
  for (const f of files) {
    const c = el('button', 'filechip' + (S.file?.path === f.path ? ' active' : ''), f.name);
    c.onclick = () => { if (confirmDiscard()) loadFile(f.path); };
    bar.appendChild(c);
  }
  if (canAdd) {
    const add = el('button', 'filechip', '+ file');
    add.title = 'Add a reference file to this skill';
    add.onclick = addFileToEntry;
    bar.appendChild(add);
  }
}

function renderTabs() {
  const tabs = $('tabs');
  tabs.innerHTML = '';
  tabs.style.display = (S.view === 'entry' && S.file) ? 'flex' : 'none';
  if (S.view !== 'entry' || !S.file) return;
  const list = [['preview', 'Preview'], ['edit', 'Edit'], ['history', 'History']];
  if (S.entry.pairedWith && /SKILL\.md$/.test(S.file.path)) list.push(['compare', 'Compare']);
  for (const [id, label] of list) {
    const b = el('button', 'tab' + (S.tab === id ? ' active' : ''), label);
    b.onclick = () => { S.tab = id; renderContent(); renderTabs(); renderStatus(); };
    tabs.appendChild(b);
  }
}

function renderStatus() {
  const L = $('status-left'), R = $('status-right');
  if (S.view === 'entry' && S.file) {
    const lines = S.draft.split('\n').length;
    L.textContent = `${lines} lines · ${S.draft.length.toLocaleString()} chars · ${S.file.kind}`
      + (S.tab === 'edit' ? ' · Esc leaves the editor' : '');
    R.innerHTML = '';
    if (isDirty()) {
      R.appendChild(el('span', 'dot-dirty', '● unsaved'));
    } else {
      R.appendChild(el('span', null, 'saved'));
    }
  } else {
    L.textContent = S.registry ? `history: ${S.registry.history.path}` : '';
    R.textContent = '';
  }
  // Save only ever acts on the open file — never leave it live on a view that
  // isn't showing one.
  $('btn-save').disabled = S.view !== 'entry' || !isDirty() || !!S.revoked;
  $('btn-save').hidden = S.view !== 'entry' || !S.file;
}

/* ── content panes ───────────────────────────────────────────────────── */
function renderContent() {
  const c = $('content');
  c.innerHTML = '';
  // Every other view either renders here (Home) or is painted by its own
  // open function (search by doSearch), which owns its loading state.
  if (S.view !== 'entry') return viewById(S.view)?.render?.(c);
  if (!S.file) return;

  if (S.tab === 'preview') return renderPreview(c);
  if (S.tab === 'edit') return renderEditor(c);
  if (S.tab === 'history') return renderHistory(c);
  if (S.tab === 'compare') return renderCompare(c);
}

/**
 * Every accepted navigation away from a file leaves the editor this way:
 * nothing stays open behind another view, so the discard prompt cannot
 * repeat and Assist cannot attach a file that is no longer on screen.
 * S.lastEntryId stays, for the Files page to highlight.
 */
function leaveEditor() {
  S.entry = null; S.file = null; S.original = ''; S.draft = ''; S.revoked = false;
}

/** Home, without the confirm: for transitions whose file is already gone. */
function goHome() {
  S.view = 'home';
  leaveEditor();
  window.history.replaceState(null, '', location.pathname + location.search);
  renderSidebar();
  renderAll();
}
function openHome() {
  if (!confirmDiscard()) return;
  goHome();
}

/**
 * Split a leading YAML frontmatter block off the body. Markdown would otherwise
 * render `---\nname: x\n---` as a setext heading, which swallows the top of
 * every SKILL.md.
 */
function splitFrontmatter(text) {
  if (!text.startsWith('---')) return { fields: null, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { fields: null, body: text };
  const block = text.slice(3, end);
  // The closing `---` may be the last line with no trailing newline; treating a
  // missing newline as index 0 would hand the whole file back as the body and
  // render the frontmatter as a heading all over again.
  const nl = text.indexOf('\n', end + 1);
  const body = nl === -1 ? '' : text.slice(nl + 1);
  const fields = [];
  for (const line of block.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) fields.push([m[1], m[2].trim()]);
    else if (fields.length && line.trim()) fields[fields.length - 1][1] += ' ' + line.trim();
  }
  return { fields: fields.length ? fields : null, body };
}

function renderPreview(c) {
  if (S.file.kind !== 'markdown') {
    c.appendChild(el('pre', 'raw', S.draft));
    return;
  }
  const { fields, body } = splitFrontmatter(S.draft);
  const d = el('div', 'md');
  if (fields) {
    const card = el('div', 'fm-card');
    for (const [k, v] of fields) {
      const row = el('div', 'fm-row');
      row.appendChild(el('div', 'fm-key', k));
      row.appendChild(el('div', 'fm-val', v));
      card.appendChild(row);
    }
    d.appendChild(card);
  }
  const bodyEl = el('div');
  bodyEl.innerHTML = renderMarkdown(body);
  d.appendChild(bodyEl);
  c.appendChild(d);
}

function renderEditor(c) {
  const wrap = el('div', 'editor-wrap');
  const ta = el('textarea', 'editor');
  ta.value = S.draft;
  ta.spellcheck = false;
  // A revoked folder: the draft can still be selected and copied, not edited.
  // readOnly stops typing, not code — so every path that changes the text
  // checks it too, and an input that got through anyway is put back.
  ta.readOnly = !!S.revoked;
  ta.oninput = () => {
    if (S.revoked) { ta.value = S.draft; return; }
    S.draft = ta.value; renderStatus();
  };
  ta.onkeydown = (ev) => {
    if (ev.key === 'Tab') {
      ev.preventDefault();
      if (S.revoked) return;
      const s = ta.selectionStart, e = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(e);
      ta.selectionStart = ta.selectionEnd = s + 2;
      S.draft = ta.value;
      renderStatus();
    } else if (ev.key === 'Escape') {
      // Leave the editor without touching the draft: to Save when there is
      // something to save, else to the active tab.
      ev.preventDefault();
      const save = $('btn-save');
      if (!save.hidden && !save.disabled) save.focus();
      else $('tabs').querySelector('.tab.active')?.focus();
    }
  };
  wrap.appendChild(ta);
  c.appendChild(wrap);
  setTimeout(() => ta.focus(), 0);
}

async function renderHistory(c) {
  const box = el('div', 'hist');
  box.appendChild(el('div', 'scope-sub', 'Every save the studio has made to this file.'));
  c.appendChild(box);
  let data;
  try { data = await api('GET', `/api/history?path=${encodeURIComponent(S.file.path)}`); }
  catch (e) { box.appendChild(el('div', 'scope-sub', e.message)); return; }

  if (!data.commits.length) {
    box.appendChild(el('div', 'scope-sub', 'No versions recorded yet — the first save will create one.'));
    return;
  }
  data.commits.forEach((cm, i) => {
    const row = el('div', 'hist-row');
    row.appendChild(el('span', 'hist-sha', cm.sha.slice(0, 8)));
    row.appendChild(el('span', 'hist-when', new Date(cm.at).toLocaleString()));
    row.appendChild(el('span', 'hist-msg', cm.subject));
    if (i === 0) row.appendChild(el('span', 'item-badge', 'current'));

    const view = el('button', 'btn ghost', 'Diff');
    view.style.padding = '3px 10px';
    view.onclick = () => showVersionDiff(cm.sha);
    row.appendChild(view);

    if (i > 0) {
      const rest = el('button', 'btn danger', 'Restore');
      rest.style.padding = '3px 10px';
      rest.onclick = () => restoreVersion(cm.sha);
      row.appendChild(rest);
    }
    box.appendChild(row);
  });
}

async function showVersionDiff(sha) {
  const c = $('content');
  c.innerHTML = '';
  const back = el('button', 'btn ghost', '← back to history');
  back.style.margin = '16px 0 0 20px';
  back.onclick = () => renderContent();
  c.appendChild(back);
  try {
    const { content } = await api('GET',
      `/api/history/version?path=${encodeURIComponent(S.file.path)}&sha=${sha}`);
    c.appendChild(diffView(content, S.draft, `${sha.slice(0, 8)}`, 'now'));
  } catch (e) {
    c.appendChild(el('div', 'scope-sub', e.message));
  }
}

async function restoreVersion(sha) {
  if (S.revoked) return notice('warn', 'This folder is no longer editable — copy your changes first.', null, true);
  if (isDirty() && !confirm('You have unsaved changes in the editor. Restoring will discard them.\n\nContinue?')) return;
  if (!confirm(`Restore this file to version ${sha.slice(0, 8)}?\n\nThe current contents are recorded first, so this is reversible.`)) return;
  try {
    const r = await api('POST', '/api/history/restore', {
      path: S.file.path, sha, mtime: S.file.mtime,
    });
    S.file.content = r.content;
    S.file.mtime = r.mtime;
    S.original = r.content;
    S.draft = r.content;
    S.tab = 'preview';
    renderAll();
    notice('ok', `Restored to ${sha.slice(0, 8)}.`);
  } catch (e) {
    notice('error', e.message, null, true);
  }
}

async function renderCompare(c) {
  const other = findEntry(S.entry.pairedWith);
  if (!other) { c.appendChild(el('div', 'scope-sub', 'Paired skill not found.')); return; }
  const grid = el('div', 'compare');

  for (const [entry, content] of [[S.entry, S.draft], [other, null]]) {
    const col = el('div', 'compare-col');
    const head = el('div', 'compare-head');
    head.appendChild(el('span', `harness-tag ${entry.harness}`, entry.harness));
    head.appendChild(el('span', null, `${entry.label}/SKILL.md`));
    col.appendChild(head);
    const body = el('div', 'md');
    body.innerHTML = '<p style="color:var(--muted)">loading…</p>';
    col.appendChild(body);
    grid.appendChild(col);

    if (content != null) {
      body.innerHTML = renderMarkdown(content);
    } else {
      const p = entry.primary;
      api('GET', `/api/file?path=${encodeURIComponent(p)}`)
        .then((f) => { body.innerHTML = renderMarkdown(f.content); })
        .catch((e) => { body.innerHTML = `<p style="color:var(--red)">${esc(e.message)}</p>`; });
      const open = el('button', 'btn ghost', 'Open →');
      open.style.cssText = 'padding:2px 9px;margin-left:auto';
      open.onclick = () => openEntry(entry);
      head.appendChild(open);
    }
  }
  c.appendChild(grid);
}

/* ── diff ────────────────────────────────────────────────────────────── */
function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  // Guard: full LCS is O(n*m); fall back to a blunt replace on huge files.
  if (A.length * B.length > 4_000_000) {
    return [...A.map((t) => ({ type: 'del', text: t })), ...B.map((t) => ({ type: 'add', text: t }))];
  }
  const m = A.length, n = B.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) { out.push({ type: 'ctx', text: A[i], na: i + 1, nb: j + 1 }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: A[i], na: i + 1 }); i++; }
    else { out.push({ type: 'add', text: B[j], nb: j + 1 }); j++; }
  }
  while (i < m) out.push({ type: 'del', text: A[i], na: ++i });
  while (j < n) out.push({ type: 'add', text: B[j], nb: ++j });
  return out;
}

function diffView(oldText, newText, oldLabel = 'before', newLabel = 'after') {
  const rows = lineDiff(oldText, newText);
  const wrap = el('div', 'diff');
  const changes = rows.filter((r) => r.type !== 'ctx').length;
  const head = el('div', 'scope-sub');
  head.style.padding = '0 8px 10px';
  head.textContent = changes === 0
    ? 'Identical.'
    : `${rows.filter(r => r.type === 'add').length} added, ${rows.filter(r => r.type === 'del').length} removed  ·  ${oldLabel} → ${newLabel}`;
  wrap.appendChild(head);

  // Collapse long unchanged runs to 3 lines of context on each side.
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.type === 'ctx') return;
    for (let k = Math.max(0, i - 3); k <= Math.min(rows.length - 1, i + 3); k++) keep[k] = true;
  });
  let skipped = 0;
  rows.forEach((r, i) => {
    if (!keep[i]) { skipped++; return; }
    if (skipped) { wrap.appendChild(el('div', 'diff-skip', `⋯ ${skipped} unchanged line${skipped === 1 ? '' : 's'}`)); skipped = 0; }
    const line = el('div', `diff-line ${r.type}`);
    line.appendChild(el('span', 'n', r.type === 'add' ? String(r.nb ?? '') : String(r.na ?? '')));
    const t = el('span', 't', (r.type === 'add' ? '+ ' : r.type === 'del' ? '- ' : '  ') + r.text);
    line.appendChild(t);
    wrap.appendChild(line);
  });
  if (skipped) wrap.appendChild(el('div', 'diff-skip', `⋯ ${skipped} unchanged line${skipped === 1 ? '' : 's'}`));
  return wrap;
}

/* ── save ────────────────────────────────────────────────────────────── */
async function save() {
  if (!isDirty() || S.revoked) return;
  // Snapshot exactly what is being sent. Anything typed during the round trip
  // must stay dirty — assigning from the live draft afterwards would mark
  // unwritten edits as saved.
  const file = S.file;
  const content = S.draft;

  const btn = $('btn-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const r = await api('PUT', '/api/file', {
      path: file.path, content, mtime: file.mtime,
    });
    const stillOpen = S.file && S.file.path === file.path;

    if (!r.saved && r.errors?.length) {
      notice('error', 'Not saved — this would break the file:', r.errors, true);
    } else if (r.unchanged) {
      notice('ok', 'No changes to save.');
    } else {
      if (stillOpen) {
        S.original = content;
        S.file.mtime = r.mtime;
      }
      const notes = [...(r.warnings || [])];
      if (r.historyError) notes.push(`File written, but not versioned: ${r.historyError}`);
      if (notes.length) notice('warn', 'Saved, with notes:', notes, true);
      else notice('ok', `Saved · version ${r.sha?.slice(0, 8) ?? ''}`);
      S.registry.history.commits++;
      if (stillOpen && S.draft !== content) {
        notice('warn', 'Saved what was sent — you typed more since, so there are still unsaved changes.', null, true);
      }
    }
  } catch (e) {
    notice('error', e.message, null, true);
  } finally {
    btn.textContent = 'Save';
    renderStatus();
  }
}

/* ── scope view ──────────────────────────────────────────────────────── */
async function openScope() {
  if (!confirmDiscard()) return;
  S.view = 'scope';
  leaveEditor();
  window.history.replaceState(null, '', '#scope');
  renderSidebar(); renderTopbar(); renderTabs(); renderStatus();
  $('filebar').hidden = true;
  const c = $('content');
  c.innerHTML = '';
  const box = el('div', 'scope');
  box.appendChild(el('h2', null, 'What applies where'));
  box.appendChild(el('div', 'scope-sub',
    'Pick a directory to see every memory file an agent loads there, in the order they layer.'));
  const sel = el('select', 'scope-select');
  box.appendChild(sel);
  const list = el('div');
  box.appendChild(list);
  c.appendChild(box);

  const { dirs } = await api('GET', '/api/scope/dirs');
  for (const d of dirs) {
    const o = el('option', null, d.display);
    o.value = d.path;
    sel.appendChild(o);
  }
  const load = async () => {
    list.innerHTML = '<div class="scope-sub"><span class="spinner"></span></div>';
    const { chain } = await api('GET', `/api/scope?dir=${encodeURIComponent(sel.value)}`);
    list.innerHTML = '';
    if (!chain.length) { list.appendChild(el('div', 'scope-sub', 'No memory files apply here.')); return; }
    chain.forEach((f, i) => {
      const row = el('div', 'scope-item');
      row.appendChild(el('div', 'scope-rank', String(i + 1)));
      const body = el('div', 'scope-body');
      body.appendChild(el('div', 'scope-path', f.display));
      body.appendChild(el('div', 'scope-note',
        `${f.scope === 'global' ? 'Global' : 'Directory'} · ${f.note} · ${(f.size / 1024).toFixed(1)} KB`));
      row.appendChild(body);
      const open = el('button', 'btn ghost scope-open', 'Open');
      open.onclick = () => {
        for (const g of S.registry.groups) {
          const e = g.entries.find((x) => x.files.some((ff) => ff.path === f.path));
          if (e) return openEntry(e, f.path);
        }
        notice('warn', 'That file is not in the registry yet — reload to pick it up.');
      };
      row.appendChild(open);
      list.appendChild(row);
    });
  };
  sel.onchange = load;
  load();
}

/* ── create / delete ─────────────────────────────────────────────────── */

async function refreshRegistry(selectPath) {
  S.registry = await api('GET', '/api/registry');
  // The rebuild produces fresh entry objects; re-point at the equivalent one so
  // identity checks (active row, "can add files") keep working.
  if (S.file) S.entry = entryForFile(S.file.path) ?? S.entry;
  resolveHarness();       // detection is re-run server-side on every rebuild
  paintModelsBadge(S.registry.modelAlerts || 0);
  renderSidebar();
  const total = S.registry.groups.reduce(
    (n, g) => n + g.entries.reduce((m, e) => m + e.files.length, 0), 0);
  $('brand-sub').textContent = `${total} files · ${S.registry.history.commits} versions`;
  if (selectPath) {
    const entry = entryForFile(selectPath);
    if (entry) await openEntry(entry, selectPath);
  }
}

/* ── live file events ────────────────────────────────────────────────── */
/**
 * The corpus is edited by other things — Claude Code writing auto-memory, a
 * skill installed from the terminal, an agent touching a CLAUDE.md. Without
 * this the sidebar silently goes stale until a reload.
 */
function connectEvents() {
  const es = new EventSource('/api/events');

  es.onmessage = (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    if (d.type === 'roots') return void handleRootsEvent(d);
    if (d.type !== 'files') return;
    handleFileEvent(d);
  };

  es.onerror = () => setLive(false);
  es.onopen = () => setLive(true);
}

async function handleFileEvent(d) {
  await refreshRegistry().catch(() => {});
  const openPath = S.file?.path;
  const plan = fileEventPlan(d, { openPath, dirty: isDirty() });

  if (plan.open === 'revoked') {
    // Not a deletion: the file is still there, the studio may no longer save
    // it. Closing would throw the draft away, so it stays, read-only.
    S.revoked = true;
    renderAll();
    notice('warn', plan.dirty
      ? 'This folder is no longer editable — copy your changes. They are still here, but the studio can no longer save this file.'
      : 'This folder is no longer editable — the file is shown read-only.', null, true);
    return;
  }

  if (plan.open === 'closed') {
    S.entry = null; S.file = null; S.original = ''; S.draft = '';
    goHome();
    notice('warn', plan.studio
      ? 'The file you had open was moved to the studio trash.'
      : 'The file you had open was deleted outside the studio.', null, true);
    return;
  }

  const conflict = () => notice('warn',
    // Never silently discard their edits — the save will 409 anyway.
    'This file changed on disk while you were editing it. Your unsaved changes are still here, but saving will be refused until you reload.',
    null, true);
  if (plan.open === 'conflict' && !plan.studio) { conflict(); return; }

  if (plan.open === 'conflict' || plan.open === 'reload') {
    // A studio write may be this tab's own save, with more typed since; and
    // anything may have been typed while this fetch was in flight — so the
    // decision is made after it, from the editor's state then.
    const f = await api('GET', `/api/file?path=${encodeURIComponent(openPath)}`).catch(() => null);
    const what = reloadDecision({ sameFile: S.file?.path === openPath, dirty: isDirty(), fetched: f?.content ?? null, original: S.original });
    if (what === 'meta') {
      S.file.mtime = f.mtime; S.file.size = f.size; S.file.lines = f.lines;
      renderStatus();
    } else if (what === 'replace') {
      S.file = f; S.original = f.content; S.draft = f.content;
      renderAll();
      if (!plan.studio) notice('ok', 'Reloaded — this file changed on disk.');
    } else if (what === 'conflict') {
      conflict();
    }
    return;
  }

  // Only announce structural changes made outside the studio.
  const added = plan.announce ? d.added || [] : [];
  const removed = plan.announce ? d.removed || [] : [];
  const parts = [];
  if (added.length) parts.push(`${added.length} added`);
  if (removed.length) parts.push(`${removed.length} removed`);
  if (parts.length) {
    const names = [...added, ...removed]
      .slice(0, 3).map((p) => p.split('/').pop()).join(', ');
    notice('ok', `${parts.join(', ')} outside the studio — ${names}${(added.length + removed.length) > 3 ? '…' : ''}`);
  }
  setLive(true);
}

function setLive(on) {
  const dot = $('live-dot');
  if (dot) {
    dot.classList.toggle('on', !!on);
    dot.title = on ? 'Watching for changes made outside the studio' : 'Live updates disconnected — reconnecting';
  }
}

async function createInGroup(group) {
  // Worktrees are not a file scaffold — registering a project runs `wtinit`.
  if (group.createKind === 'worktree-project') return openWorktreeForm();
  const name = prompt(`New ${group.title.replace(/s$/, '').toLowerCase()} name\n\nLowercase letters, numbers and hyphens.`);
  if (!name) return;
  try {
    const r = await api('POST', '/api/create', { kind: group.createKind, name });
    await refreshRegistry(r.path);
    S.tab = 'edit';
    renderAll();
    notice('ok', `Created ${r.display} — fill in the description, then Save.`);
  } catch (e) {
    notice('error', e.message, null, true);
  }
}


/* ── register a worktree project ─────────────────────────────────────── */

/**
 * The + on Worktrees runs `wtinit` for a repo, so a new project gets its trunk,
 * its layout and its own commands without dropping to a terminal.
 */
async function openWorktreeForm() {
  let data;
  try {
    data = await api('GET', '/api/worktree?status=0');
  } catch (e) {
    return notice('error', e.message, null, true);
  }
  if (!data.candidates.length) {
    return notice('ok', 'Every git repo found is already registered.');
  }

  const wrap = el('div', 'wt-overlay');
  const card = el('div', 'wt-card');
  wrap.appendChild(card);
  card.appendChild(el('h2', 'wt-title', 'Register a project'));
  card.appendChild(el('p', 'wt-sub',
    'Creates the trunk, sets where worktrees go, and defines this project’s commands. Runs once per project.'));

  const field = (label, control, hint) => {
    const f = el('div', 'wt-field');
    f.appendChild(el('label', null, label));
    f.appendChild(control);
    const h = el('div', 'wt-hint', hint || '');
    f.appendChild(h);
    card.appendChild(f);
    return h;
  };

  const repo = el('select');
  for (const c of data.candidates) {
    const o = el('option', null, c.display);
    o.value = c.path;
    repo.appendChild(o);
  }
  field('Repository', repo);

  const key = el('input');
  key.type = 'text';
  field('Project name', key,
    'Names the trunk and the worktrees — kylie gives kylie-trunk and kylie-<name>.');

  const cmd = el('input');
  cmd.type = 'text';
  const cmdHint = field('Command prefix', cmd, '');

  const base = el('select');
  field('Branch from', base, 'New worktrees are always cut from the latest of this branch.');

  const layout = el('select');
  for (const [v, t] of [
    ['flat', 'Beside the trunk (kylie/kylie-alpha)'],
    ['sub', 'In a subfolder (personal/airflo-wt/airflo-alpha)'],
  ]) {
    const o = el('option', null, t);
    o.value = v;
    layout.appendChild(o);
  }
  field('Where worktrees go', layout,
    'Use a subfolder when the containing directory also holds other projects.');

  const out = el('pre', 'wt-out');
  out.hidden = true;
  card.appendChild(out);

  const row = el('div', 'wt-actions');
  const cancel = el('button', 'btn ghost', 'Cancel');
  const go = el('button', 'btn primary', 'Register');
  row.appendChild(cancel);
  row.appendChild(go);
  card.appendChild(row);

  const guessKey = (p) => p.split('/').pop().toLowerCase().replace(/[^a-z0-9-]/g, '');
  const syncCmd = () => {
    cmdHint.textContent = cmd.value
      ? `Gives you ${cmd.value}new, ${cmd.value}ls, ${cmd.value}go — and ${cmd.value} to jump to the trunk.`
      : 'Optional. Without one you use the generic wnew/wls inside the repo.';
  };

  const loadBases = async () => {
    base.innerHTML = '';
    try {
      const b = await api('GET', `/api/worktree/bases?repo=${encodeURIComponent(repo.value)}`);
      for (const name of b.bases) {
        const o = el('option', null, name);
        o.value = name;
        if (name === b.suggested) o.selected = true;
        base.appendChild(o);
      }
      if (!b.bases.length) base.appendChild(el('option', null, '(no origin branches found)'));
    } catch {
      base.appendChild(el('option', null, '(could not read branches)'));
    }
  };

  const onRepo = () => {
    key.value = guessKey(repo.value);
    cmd.value = key.value;
    syncCmd();
    loadBases();
  };
  repo.onchange = onRepo;
  cmd.oninput = syncCmd;
  onRepo();

  const close = () => {
    document.removeEventListener('keydown', onKey);
    wrap.remove();
  };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  cancel.onclick = close;
  wrap.onclick = (ev) => { if (ev.target === wrap) close(); };

  go.onclick = async () => {
    go.disabled = true;
    go.textContent = 'Running…';
    out.hidden = false;
    out.textContent = 'wtinit…';
    const body = {
      repoPath: repo.value,
      key: key.value.trim(),
      cmd: cmd.value.trim(),
      base: base.value.startsWith('origin/') ? base.value : '',
    };
    if (layout.value === 'sub') {
      const parent = repo.value.split('/').slice(0, -1).join('/');
      body.root = `${parent}/${body.key}-wt`;
    }
    try {
      const r = await api('POST', '/api/worktree/init', body);
      out.textContent = r.output;
      go.textContent = 'Done';
      await refreshRegistry();
      renderAll();
      notice('ok', `${body.key} registered — open a new terminal to use ${body.cmd || 'wnew'}.`);
      setTimeout(close, 2500);
    } catch (e) {
      out.textContent = e.message;
      go.disabled = false;
      go.textContent = 'Register';
    }
  };

  document.body.appendChild(wrap);
  key.focus();
}

/** Seed a new skill in the other harness from the open one. */
async function copyToOtherHarness() {
  const from = S.entry.harness;
  const kind = from === 'claude' ? 'codex-skill' : 'claude-skill';
  const name = prompt(`Copy "${S.entry.label}" into ${from === 'claude' ? 'Codex' : 'Claude'} skills as:`, S.entry.label);
  if (!name) return;
  try {
    const r = await api('POST', '/api/create', { kind, name, sourcePath: S.file.path });
    await refreshRegistry(r.path);
    notice('ok', `Created ${r.display} as a copy — edit it freely, the two are expected to diverge.`);
  } catch (e) {
    notice('error', e.message, null, true);
  }
}

async function addFileToEntry() {
  const name = prompt('New file name inside this skill\n\ne.g. reference.md, config.example.json');
  if (!name) return;
  try {
    const r = await api('POST', '/api/create-file', { dir: S.entry.dir, name });
    await refreshRegistry(r.path);
    notice('ok', `Created ${r.display}.`);
  } catch (e) {
    notice('error', e.message, null, true);
  }
}

async function deleteTarget({ path: p, label, isWhole, protectedEntry }) {
  if (protectedEntry) {
    const typed = prompt(
      `"${label}" is loaded by the harness on every session.\n\n` +
      `Type its name to confirm deletion:`);
    if (typed !== label) {
      if (typed !== null) notice('warn', 'Name did not match — nothing was deleted.');
      return;
    }
  } else if (!confirm(
    `Delete ${label}?\n\n` +
    `It moves to the studio's trash and is committed to history first, so you can restore it either way.`)) {
    return;
  }

  try {
    const r = await api('POST', '/api/delete', { path: p });
    const wasOpen = S.file && (S.file.path === p || S.file.path.startsWith(p + '/'));
    await refreshRegistry();
    if (wasOpen || isWhole) {
      S.entry = null; S.file = null; S.original = ''; S.draft = '';
      goHome();
    } else {
      renderAll();
    }
    notice('ok', `Deleted ${r.display} (${r.files} file${r.files === 1 ? '' : 's'}). Recover it under Trash.`, null, true);
  } catch (e) {
    notice('error', e.message, null, true);
  }
}

function deleteOpenEntry() {
  const e = S.entry;
  if (!e) return;
  if (!e.deletable) { notice('warn', e.undeletableReason || 'This cannot be deleted.', null, true); return; }

  const multi = e.files.length > 1;
  // For a multi-file skill, make "this file" vs "the whole skill" an explicit choice.
  if (multi && S.file) {
    const whole = confirm(
      `Delete the whole "${e.label}" skill (${e.files.length} files)?\n\n` +
      `OK = delete the entire skill\nCancel = delete only ${S.file.display.split('/').pop()}`);
    if (whole) {
      return deleteTarget({ path: e.dir, label: e.label, isWhole: true, protectedEntry: e.protected });
    }
    return deleteTarget({ path: S.file.path, label: S.file.display.split('/').pop(), isWhole: false });
  }
  const target = e.files.length === 1 && !e.dir.endsWith(e.label) ? e.files[0].path : (e.primary || e.files[0]?.path);
  return deleteTarget({
    path: e.kindLabel === 'skill' ? e.dir : target,
    label: e.label, isWhole: true, protectedEntry: e.protected,
  });
}

/* ── worktrees view ──────────────────────────────────────────────────── */

/**
 * Read-only on purpose. The verdicts come from the toolkit's own `wclean
 * --json`, and removal stays in the terminal: a done row shows the command
 * to run, never a button. `wclean --remove` re-checks every worktree right
 * before removing it, which a click here could not promise.
 */
async function openWorktrees() {
  if (!confirmDiscard()) return;
  S.view = 'worktrees';
  leaveEditor();
  window.history.replaceState(null, '', '#worktrees');
  renderSidebar(); renderTopbar(); renderTabs(); renderStatus();
  $('filebar').hidden = true;

  const c = $('content');
  c.innerHTML = '<div class="scope"><div class="scope-sub"><span class="spinner"></span> Asking the toolkit…</div></div>';
  let data;
  try {
    data = await api('GET', '/api/worktree');
  } catch (e) {
    c.innerHTML = '';
    return notice('error', e.message, null, true);
  }
  if (S.view !== 'worktrees') return;
  c.innerHTML = '';
  const box = el('div', 'scope');
  box.appendChild(el('h2', null, 'Worktrees'));
  box.appendChild(el('div', 'scope-sub',
    'Env shows how each worktree gets its env files: linked to the trunk, or a copy. Done means the exact commit was merged, '
    + 'nothing is uncommitted, and no env file holds anything the trunk lacks. Merge status is against the last fetch.'));
  if (!data.projects?.length) {
    box.appendChild(el('div', 'scope-sub', 'No registered projects. Register one with + on Worktrees in the sidebar.'));
    c.appendChild(box);
    return;
  }
  for (const p of data.projects) {
    const head = el('div', 'wt-proj');
    head.appendChild(el('h3', null, p.key));
    head.appendChild(el('span', 'scope-note', `${p.display}${p.base ? ` · off ${p.base}` : ''}${p.cmd ? ` · ${p.cmd}new / ${p.cmd}ls` : ''}`));
    box.appendChild(head);
    if (p.status !== 'ok') {
      box.appendChild(el('div', 'scope-note wt-unknown', `unknown — ${p.error}`));
      continue;
    }
    for (const n of p.notes) box.appendChild(el('div', 'scope-note', n));
    for (const w of p.worktrees) {
      const row = el('div', 'scope-item');
      const done = w.verdict.status === 'done';
      row.appendChild(el('div', `scope-rank wt-${w.trunk ? 'trunk' : w.verdict.status}`,
        w.trunk ? 'TRUNK' : done ? 'DONE' : w.verdict.status === 'unknown' ? '?' : '—'));
      const body = el('div', 'scope-body');
      body.appendChild(el('div', 'scope-path', `${w.name}  [${w.branch || 'detached'}]`));
      const bits = [`env: ${w.env}`];
      if (w.envrc === 'blocked') bits.push('envrc: blocked');
      if (w.dirty) bits.push(`${w.dirty} uncommitted`);
      if (w.port) bits.push(`port ${w.port}`);
      if (w.offBook) bits.push('off-book');
      body.appendChild(el('div', 'scope-note', bits.join(' · ')));
      if (!w.trunk) body.appendChild(el('div', 'scope-note', done ? `done — ${w.verdict.via}` : w.verdict.reason));
      if (w.removeCmd) {
        const cmd = el('code', 'wt-cmd', w.removeCmd);
        cmd.title = 'Run this in a terminal — it asks once, and re-checks each worktree before removing it';
        body.appendChild(cmd);
      }
      row.appendChild(body);
      box.appendChild(row);
    }
  }
  c.appendChild(box);
}

/* ── trash view ──────────────────────────────────────────────────────── */
async function openTrash() {
  if (!confirmDiscard()) return;
  S.view = 'trash';
  leaveEditor();
  window.history.replaceState(null, '', '#trash');
  renderSidebar(); renderTopbar(); renderTabs(); renderStatus();
  $('filebar').hidden = true;

  const c = $('content');
  c.innerHTML = '<div class="scope"><div class="scope-sub"><span class="spinner"></span></div></div>';
  const { items } = await api('GET', '/api/trash');
  c.innerHTML = '';
  const box = el('div', 'scope');
  box.appendChild(el('h2', null, 'Trash'));
  box.appendChild(el('div', 'scope-sub',
    'Deleted items, newest first. Contents were committed to history before removal, so anything here is recoverable two ways.'));

  if (!items.length) {
    box.appendChild(el('div', 'scope-sub', 'Nothing deleted yet.'));
    c.appendChild(box);
    return;
  }
  for (const it of items) {
    const row = el('div', 'scope-item');
    row.appendChild(el('div', 'scope-rank', it.isDir ? 'DIR' : 'FILE'));
    const body = el('div', 'scope-body');
    body.appendChild(el('div', 'scope-path', it.display));
    body.appendChild(el('div', 'scope-note',
      `${new Date(it.deletedAt).toLocaleString()} · ${it.fileCount} file${it.fileCount === 1 ? '' : 's'}` +
      (it.restorable ? '' : ' · something now exists at that path')));
    row.appendChild(body);
    const btn = el('button', 'btn ghost scope-open', 'Restore');
    btn.disabled = !it.restorable;
    btn.onclick = async () => {
      try {
        const r = await api('POST', '/api/trash/restore', { id: it.id });
        await refreshRegistry();
        notice('ok', `Restored ${r.display}.`);
        openTrash();
      } catch (e) { notice('error', e.message, null, true); }
    };
    row.appendChild(btn);
    box.appendChild(row);
  }
  c.appendChild(box);
}

/* ── Skills view ─────────────────────────────────────────────────────── */

/**
 * Browse every skill on the machine and download a selection.
 *
 * The honesty rules below are load-bearing, not decoration. The usage number is
 * name-level, Claude-Code-only and bounded by retained transcripts, so a row
 * with no observations means UNKNOWN. Rendering that as "0 uses" would invite
 * exactly the deletion the data cannot justify — hence the wording branch in
 * usageLine(), the shared-count note, and the caveat printed in the panel body
 * rather than parked in a title attribute nobody hovers.
 */
const SK = {
  rows: [],
  usage: null,
  selected: new Set(),   // ids only — the client never holds a path
};

const SOURCE_LABELS = {
  'global-claude': 'Claude — global',
  'global-codex': 'Codex — global',
};

/**
 * The project folders, from roots.json via /api/roots: the only place the page
 * learns a folder's name. Every edit folder's skills are source 'project'; a
 * read folder's are its own id (lib/skills.js sources()).
 */
const FOLDERS = { data: null };
async function loadFolders() {
  try { FOLDERS.data = await api('GET', '/api/roots'); } catch { /* labels fall back to ids */ }
  return FOLDERS.data;
}
const folderRows = () => FOLDERS.data?.roots || [];
function sourceLabel(source) {
  if (SOURCE_LABELS[source]) return SOURCE_LABELS[source];
  if (source === 'project') {
    const edit = folderRows().filter((r) => r.access === 'edit');
    return edit.length === 1 ? edit[0].label : 'Edit folders';
  }
  const root = folderRows().find((r) => r.access === 'read' && r.id === source);
  return root ? root.label : source;
}
const sourceOrder = () => ['global-claude', 'global-codex', 'project',
  ...folderRows().filter((r) => r.access === 'read').map((r) => r.id)];

/**
 * The Folders view: what roots.json holds, read-only. Folders are added and
 * removed with `acs roots`; the page shows the result live (the 'roots'
 * event). A missing folder stays listed and inactive; an entry that failed
 * validation is listed with why; an unreadable roots.json is the whole story.
 */
async function openFolders() {
  if (!confirmDiscard()) return;
  S.view = 'folders';
  leaveEditor();
  window.history.replaceState(null, '', '#folders');
  renderSidebar(); renderTopbar(); renderTabs(); renderStatus();
  $('filebar').hidden = true;
  $('content').innerHTML = '<div class="scope"><div class="scope-sub"><span class="spinner"></span></div></div>';
  await loadFolders();
  paintFolders();
}

function paintFolders() {
  if (S.view !== 'folders') return;
  const c = $('content');
  c.innerHTML = '';
  const box = el('div', 'scope folders');
  box.appendChild(el('h2', null, 'Folders'));
  const d = FOLDERS.data;
  if (!d) {
    box.appendChild(el('div', 'notice error', 'Could not read the folder list. Reload to try again.'));
    c.appendChild(box);
    return;
  }
  box.appendChild(el('div', 'scope-sub',
    'Edit folders open in the editor and keep history. Read folders are listed in Context, Skills and Worktrees, '
    + `and the studio never writes there. The list lives in ${d.file}; change it from a terminal.`));
  const cmd = (text) => { const code = el('code', 'folders-cmd', text); return code; };
  if (d.state === 'error') {
    const n = el('div', 'notice error folders-error');
    n.appendChild(el('div', null, `${d.error}. No project folders are active until it is fixed or removed.`));
    box.appendChild(n);
  } else if (!d.roots.length) {
    const empty = el('div', 'folders-empty');
    empty.appendChild(el('div', null, 'No project folders yet. Add the folder your projects live in:'));
    empty.appendChild(cmd('acs roots add <path>'));
    empty.appendChild(el('div', 'scope-sub', 'Read-only unless you add --edit. Then:'));
    empty.appendChild(cmd('acs roots add <path> --edit'));
    box.appendChild(empty);
  } else {
    for (const r of d.roots) {
      const row = el('div', 'mem-card folders-row');
      const top = el('div', 'folders-top');
      top.appendChild(el('span', 'folders-label', r.label));
      top.appendChild(el('span', `mem-badge folders-${r.access}`, r.access === 'edit' ? 'edit' : 'read-only'));
      if (r.status === 'missing') top.appendChild(el('span', 'mem-badge folders-missing', 'missing'));
      if (r.partial) top.appendChild(el('span', 'mem-badge folders-missing', 'large folder — partially indexed'));
      row.appendChild(top);
      row.appendChild(el('div', 'mem-note', r.display));
      if (r.status === 'missing') {
        row.appendChild(el('div', 'mem-note', 'The folder is not there right now (unmounted or moved). It stays listed and comes back when it does.'));
      }
      box.appendChild(row);
    }
    box.appendChild(el('div', 'scope-sub', 'Add another with:'));
    box.appendChild(cmd('acs roots add <path> [--edit]'));
  }
  if (d.invalid?.length) {
    const bad = el('div', 'notice warn folders-invalid');
    bad.appendChild(el('div', null, `${d.invalid.length} ${d.invalid.length === 1 ? 'entry was' : 'entries were'} skipped:`));
    const ul = el('ul');
    for (const x of d.invalid) ul.appendChild(el('li', null, `${x.id ?? 'an entry'}: ${x.reason}`));
    bad.appendChild(ul);
    box.appendChild(bad);
  }
  c.appendChild(box);
}

/**
 * roots.json changed (B6). The event carries the new list; everything that
 * shows folders reloads its data. The editor itself is handled by the files
 * event that precedes this one (a revoked file stays open, read-only).
 */
async function handleRootsEvent(d) {
  FOLDERS.data = { state: d.state, error: d.error, file: d.file, roots: d.roots, invalid: d.invalid, addHint: d.addHint };
  await refreshRegistry().catch(() => {});
  if (S.view === 'folders') paintFolders();
  else if (S.view === 'setup') paintSetup();
  else if (S.view === 'files') paintFilesBody();
  else if (S.view === 'home') { HOME.settledAt = 0; renderContent(); }
  else if (S.view === 'context') {
    try { CX.data = await api('GET', '/api/context'); } catch { return; }
    paintContext();
  } else if (S.view === 'skills') {
    try { const data = await api('GET', '/api/skills'); SK.rows = data.skills; SK.usage = data.usage; } catch { return; }
    if (S.view === 'skills') paintSkills();
  }
}

const fmtSize = (n) => (n >= 1024 * 1024
  ? `${(n / (1024 * 1024)).toFixed(1)} MB`
  : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

async function openSkills() {
  if (!confirmDiscard()) return;
  S.view = 'skills';
  leaveEditor();
  window.history.replaceState(null, '', '#skills');
  renderSidebar(); renderTopbar(); renderTabs(); renderStatus();
  $('filebar').hidden = true;

  const c = $('content');
  c.innerHTML = '<div class="scope"><div class="scope-sub"><span class="spinner"></span></div></div>';
  try {
    const [data] = await Promise.all([api('GET', '/api/skills'), loadFolders()]);
    SK.rows = data.skills;
    SK.usage = data.usage;
    // Ids can disappear between opens (a skill edited changes its bundle hash),
    // so drop anything selected that no longer exists rather than exporting it.
    const live = new Set(SK.rows.map((r) => r.id));
    for (const id of [...SK.selected]) if (!live.has(id)) SK.selected.delete(id);
  } catch (e) {
    c.innerHTML = '';
    const box = el('div', 'scope');
    box.appendChild(el('h2', null, 'Skills'));
    box.appendChild(el('div', 'notice error', e.message));
    c.appendChild(box);
    return;
  }
  paintSkills();
}

function paintSkills() {
  const c = $('content');
  c.innerHTML = '';
  const box = el('div', 'scope');

  box.appendChild(el('h2', null, 'Skills'));
  box.appendChild(el('div', 'scope-sub',
    `${SK.rows.length} skills across both harnesses and every project. `
    + 'Identical copies are collapsed into one row. Pick any set and download it — '
    + 'one skill saves as a readable .md, several as a .zip.'));

  box.appendChild(usageCaveatBanner());
  const bar = selectionBar();
  box.appendChild(bar);

  const groups = new Map();
  for (const r of SK.rows) {
    if (!groups.has(r.source)) groups.set(r.source, []);
    groups.get(r.source).push(r);
  }
  const known = sourceOrder();
  const order = [...known.filter((s) => groups.has(s)),
    ...[...groups.keys()].filter((s) => !known.includes(s))];

  for (const source of order) {
    const rows = groups.get(source).slice().sort((a, b) =>
      a.displayName.localeCompare(b.displayName));
    box.appendChild(skillGroup(source, rows));
  }

  c.appendChild(box);
  syncSkillSelectionUI();
}

/**
 * The caveat, in the panel body.
 *
 * It ships as a field on the payload precisely so the UI cannot quietly drop
 * it; putting it in a tooltip would be dropping it. If the usage read failed
 * outright, say that instead — an absent signal is not a zero.
 */
function usageCaveatBanner() {
  const n = el('div', 'notice warn sk-caveat');
  if (SK.usage?.available === false) {
    n.appendChild(el('div', null,
      `Usage could not be read (${SK.usage.reason || 'unknown error'}), so no row below carries a count.`));
  }
  n.appendChild(el('div', null, SK.usage?.caveat?.text || ''));
  return n;
}

function selectionBar() {
  const bar = el('div', 'sk-bar');
  bar.id = 'sk-bar';

  const summary = el('div', 'sk-bar-summary');
  summary.id = 'sk-summary';
  bar.appendChild(summary);

  const clear = el('button', 'btn ghost sk-bar-clear', 'Clear');
  clear.id = 'sk-clear';
  clear.onclick = () => { SK.selected.clear(); syncSkillSelectionUI(); };
  bar.appendChild(clear);

  const dl = el('button', 'btn primary', 'Download');
  dl.id = 'sk-download';
  dl.onclick = downloadSelectedSkills;
  bar.appendChild(dl);
  return bar;
}

function skillGroup(source, rows) {
  const wrap = el('div', 'sk-group');
  const head = el('div', 'sk-group-head');
  head.appendChild(el('div', 'sk-group-name', sourceLabel(source)));

  const selectable = rows.filter((r) => !r.broken);
  head.appendChild(el('div', 'sk-group-count',
    `${rows.length} skill${rows.length === 1 ? '' : 's'}`));

  const all = el('button', 'btn ghost sk-group-act', 'Select all');
  all.disabled = !selectable.length;
  all.onclick = () => { selectable.forEach((r) => SK.selected.add(r.id)); syncSkillSelectionUI(); };
  head.appendChild(all);

  const none = el('button', 'btn ghost sk-group-act', 'None');
  none.disabled = !selectable.length;
  none.onclick = () => { selectable.forEach((r) => SK.selected.delete(r.id)); syncSkillSelectionUI(); };
  head.appendChild(none);

  wrap.appendChild(head);
  for (const r of rows) wrap.appendChild(skillRow(r));
  return wrap;
}

function skillRow(r) {
  const row = el('label', 'sk-row' + (r.broken ? ' broken' : ''));
  row.dataset.id = r.id;

  const cb = el('input', 'sk-check');
  cb.type = 'checkbox';
  cb.checked = SK.selected.has(r.id);
  // A broken row has no readable bundle, so it is not a thing that can be
  // exported — disabled rather than hidden, with the reason attached, because
  // "where did find-skills go" is a worse question than a greyed-out row.
  cb.disabled = !!r.broken;
  cb.onchange = () => {
    if (cb.checked) SK.selected.add(r.id); else SK.selected.delete(r.id);
    syncSkillSelectionUI();
  };
  row.appendChild(cb);

  const body = el('div', 'sk-body');
  const head = el('div', 'sk-head');
  head.appendChild(el('span', 'sk-name', r.displayName));
  head.appendChild(el('span', `sk-source ${r.source}`, sourceLabel(r.source)));
  body.appendChild(head);

  const fileCount = r.files.length;
  body.appendChild(el('div', 'sk-meta',
    `${fileCount} file${fileCount === 1 ? '' : 's'} · ${fmtSize(r.totalBytes)}`));

  if (r.description) body.appendChild(el('div', 'sk-desc', r.description));

  if (r.broken) {
    body.appendChild(el('div', 'sk-broken',
      `Unavailable — ${r.reason || 'this skill could not be read'}`));
  }

  // Collapsed copies: say how many other places hold the identical bundle
  // rather than printing the same skill four times.
  if (r.aliasCount) {
    const where = r.aliasSources.map(sourceLabel).join(', ');
    body.appendChild(el('div', 'sk-note',
      `also in ${r.aliasCount} other place${r.aliasCount === 1 ? '' : 's'}`
      + (where ? ` (${where})` : '') + ' — identical, downloaded once'));
  }

  const usage = usageLine(r);
  if (usage) body.appendChild(usage);

  row.appendChild(body);
  return row;
}

/**
 * The usage line for one row.
 *
 * Two branches, and the distinction between them is the whole point: an
 * observed row gets a number, an unobserved row gets "no recorded use" and an
 * explicit statement that this is not evidence of disuse. Never "0 uses".
 */
function usageLine(r) {
  const u = r.usage;
  if (!u) return null;
  const line = el('div', 'sk-usage');

  if (u.observed) {
    const when = u.lastUsedAt ? new Date(u.lastUsedAt).toLocaleDateString() : 'unknown date';
    line.appendChild(el('span', 'sk-usage-count',
      `${u.count} invocation${u.count === 1 ? '' : 's'}`));
    line.appendChild(el('span', 'sk-usage-when', `last seen ${when}`));
  } else {
    line.appendChild(el('span', 'sk-usage-none', 'no recorded use'));
    line.appendChild(el('span', 'sk-usage-when', 'unknown, not unused'));
  }

  // A shared name means the count covers every copy of it, so it cannot speak
  // for this row alone. Stated on the row, not only in the panel caveat.
  if (u.nameShared) {
    line.appendChild(el('span', 'sk-usage-shared',
      `count is shared across ${u.nameSharedWith} skills named "${r.name}"`));
  }
  return line;
}

/**
 * Repaint only what selection changes — checkboxes, the running total, and the
 * Download button — so toggling a row does not rebuild 124 rows of DOM.
 */
function syncSkillSelectionUI() {
  const byId = new Map(SK.rows.map((r) => [r.id, r]));
  for (const cb of document.querySelectorAll('.sk-row .sk-check')) {
    cb.checked = SK.selected.has(cb.parentElement.dataset.id);
  }
  const chosen = [...SK.selected].map((id) => byId.get(id)).filter(Boolean);
  const bytes = chosen.reduce((n, r) => n + r.totalBytes, 0);

  const summary = $('sk-summary');
  if (summary) {
    summary.textContent = chosen.length
      ? `${chosen.length} selected · ${fmtSize(bytes)} · downloads as `
        + (chosen.length === 1 ? `${chosen[0].displayName}.md` : 'a .zip')
      : 'Nothing selected';
  }
  const dl = $('sk-download');
  if (dl) dl.disabled = chosen.length === 0;
  const clear = $('sk-clear');
  if (clear) clear.disabled = chosen.length === 0;
}

/**
 * Start the download.
 *
 * NOT through api(): that helper calls res.json() on every response and would
 * turn an archive into a parse error. A browser only saves a response straight
 * to disk from a navigation, so this is an anchor click — which is also why the
 * export endpoint tolerates a request with no Origin header. The filename comes
 * from the server's content-disposition; `download` is only the save hint.
 */
function downloadSelectedSkills() {
  const ids = [...SK.selected];
  if (!ids.length) return;
  const a = el('a');
  a.href = `/api/skills/export?ids=${ids.map(encodeURIComponent).join(',')}`;
  a.download = '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  notice('ok', ids.length === 1
    ? 'Downloading one skill as a .md file.'
    : `Downloading ${ids.length} skills as a .zip.`);
}

/* ── Memory view ─────────────────────────────────────────────────────── */

/**
 * Claude auto-memory, grouped by repository, with the rot around it.
 *
 * Wording is load-bearing here the same way it is in the Skills view: the only
 * activity signal is a successful write found in retained transcripts, so a
 * fact with none shows "last written: unknown" — never a word that implies
 * nobody reads it. Every cleanup is previewed as a diff or a list and applied
 * only on Accept, and every applied one can be restored from Operations.
 *
 * The client holds ids, never paths: `openPath` is only ever handed to the
 * existing editor, and every memory action names an id.
 */
const MV = {
  data: null,
  ops: [],
  tab: 'review',
  age: 0,                  // days; 0 = any age
  picked: {},              // finding kind -> Set of ids
  preview: null,           // { opId, summary, diffs, items }
  compare: null,           // { orphan, rows }
  diff: null,              // { key, before, after, labels }
  restoreRefusal: null,    // { opId, reason, diffs }
};

const DAY_MS = 24 * 60 * 60 * 1000;
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString() : null);
const daysAgo = (iso) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / DAY_MS) : null);
const picked = (kind) => (MV.picked[kind] ||= new Set());

const SLUG_STATE_LABELS = {
  resolved: 'git repository',
  'non-git': 'folder, not a repository',
  ambiguous: 'ambiguous — more than one folder fits',
  inaccessible: 'inaccessible — could not look',
  missing: 'project folder not found',
  'temp-probe': 'temporary session folder',
};

async function openMemory() {
  if (!confirmDiscard()) return;
  S.view = 'memory';
  leaveEditor();
  // Nothing stays open behind this view, or a cleanup that trashes the file
  // last opened would make the live-change handler leave the view.
  S.file = null; S.original = ''; S.draft = '';
  window.history.replaceState(null, '', '#memory');
  renderSidebar(); renderTopbar(); renderTabs(); renderStatus();
  $('filebar').hidden = true;

  const c = $('content');
  c.innerHTML = '<div class="scope"><div class="scope-sub"><span class="spinner"></span> Reading memory and transcripts…</div></div>';
  try {
    const [data, ops] = await Promise.all([api('GET', '/api/memory'), api('GET', '/api/memory/ops')]);
    MV.data = data;
    MV.ops = ops.ops;
    // A finding id survives a reload only while its finding does.
    const live = new Set([
      ...data.findings.emptySlugs, ...data.findings.dangling, ...data.findings.unindexed,
    ].map((f) => f.id));
    for (const set of Object.values(MV.picked)) for (const id of [...set]) if (!live.has(id)) set.delete(id);
  } catch (e) {
    c.innerHTML = '';
    const box = el('div', 'scope');
    box.appendChild(el('h2', null, 'Memory'));
    box.appendChild(el('div', 'notice error', e.message));
    c.appendChild(box);
    return;
  }
  paintMemory();
}

function paintMemory() {
  if (S.view !== 'memory' || !MV.data) return;
  const d = MV.data;
  const c = $('content');
  const scroll = c.scrollTop;
  c.innerHTML = '';
  const box = el('div', 'scope mem');

  box.appendChild(el('h2', null, 'Memory'));
  box.appendChild(el('div', 'scope-sub',
    `${d.rows.length} memory files in ${d.groups.length} projects, from ${d.slugCount} Claude Code project folders. `
    + 'Grouped by repository, so a project\'s worktrees and subfolders roll up together.'));

  const caveat = el('div', 'notice warn mem-caveat');
  caveat.appendChild(el('div', null, d.caveat.text));
  box.appendChild(caveat);

  const facts = el('div', 'mem-facts');
  const states = Object.entries(d.states).map(([k, n]) => `${n} ${SLUG_STATE_LABELS[k] || k}`).join(' · ');
  facts.appendChild(el('div', null, `Project folders: ${states}. Temporary session folders are left out of the project list`
    + (d.hiddenProbeFiles ? `, with the ${d.hiddenProbeFiles} memory file${d.hiddenProbeFiles === 1 ? '' : 's'} in them.` : '.')));
  const o = d.other;
  const store = (label, s) => (s.count == null ? `${label}: ${s.note}` : `${label}: ${s.count} ${s.unit}${s.scopes != null ? ` in ${s.scopes} scope${s.scopes === 1 ? '' : 's'}` : ''} (${s.store}, read-only)`);
  facts.appendChild(el('div', null, `${store('Codex', o.codex)} · ${store('Grok', o.grok)}`));
  facts.appendChild(el('div', null,
    `Transcripts: ${d.scan.transcripts} (${d.scan.scanned} read, ${d.scan.reused} from cache) in ${d.scan.ms} ms.`));
  box.appendChild(facts);

  const f = d.findings;
  const queue = d.rows.filter((r) => r.inQueue);
  const cleanups = f.emptySlugs.length + f.dangling.length + f.unindexed.length + f.oversized.length;
  const tabs = [
    ['review', `Review (${queue.length})`],
    ['cleanups', `Cleanups (${cleanups})`],
    ['orphans', `Orphans & duplicates (${f.orphans.length + f.duplicates.length})`],
    ['projects', `Projects (${d.groups.length})`],
    ['ops', `Operations (${MV.ops.length})`],
  ];
  const bar = el('div', 'mem-tabs');
  for (const [id, label] of tabs) {
    const b = el('button', 'tab' + (MV.tab === id ? ' active' : ''), label);
    b.onclick = () => { MV.tab = id; MV.compare = null; MV.diff = null; paintMemory(); };
    bar.appendChild(b);
  }
  box.appendChild(bar);

  if (MV.preview) box.appendChild(previewPanel());

  if (MV.tab === 'review') box.appendChild(reviewTab());
  else if (MV.tab === 'cleanups') box.appendChild(cleanupsTab());
  else if (MV.tab === 'orphans') box.appendChild(orphansTab());
  else if (MV.tab === 'projects') box.appendChild(projectsTab());
  else if (MV.tab === 'ops') box.appendChild(opsTab());

  c.appendChild(box);
  c.scrollTop = scroll;
}

const groupLabel = (id) => MV.data.groups.find((g) => g.id === id)?.label ?? '(project)';
const rowById = (id) => MV.data.rows.find((r) => r.id === id);

/** "modified …" and "last written …" — the two dates, each with where it came from. */
function factDates(r) {
  const line = el('div', 'mem-dates');
  const mod = el('span', null, `modified ${fmtDate(r.modified)}`
    + (r.modifiedSource === 'mtime' ? ' (file time)' : ''));
  line.appendChild(mod);
  if (r.modifiedFlag) {
    line.appendChild(el('span', 'mem-flag',
      r.modifiedFlag === 'future' ? 'frontmatter date is in the future' : 'frontmatter date unreadable'));
  }
  if (r.lastWrite) {
    line.appendChild(el('span', 'mem-written',
      `last written ${fmtDate(r.lastWrite)}${r.writeCount > 1 ? ` · ${r.writeCount} recorded writes` : ''}`));
  } else {
    line.appendChild(el('span', 'mem-unknown', 'last written: unknown'));
  }
  return line;
}

function openInEditor(p, display) {
  const entry = entryForFile(p) || {
    id: `adhoc:${p}`, label: display.split('/').pop(), kindLabel: 'memory', harness: 'claude',
    dir: p.slice(0, p.lastIndexOf('/')), display, files: [{ name: display.split('/').pop(), path: p, display }],
    primary: p, deletable: false, undeletableReason: 'Delete memory from the Memory view, where it is restorable with its index link.',
  };
  openEntry(entry, p);
}

function reviewTab() {
  const wrap = el('div');
  const d = MV.data;
  const head = el('div', 'mem-row-head');
  head.appendChild(el('div', 'scope-sub', 'Oldest first, by the later of "modified" and "last written". '
    + `Keep hides a fact for ${d.keepDays} days, or until its content changes. Nothing here edits a memory file.`));
  const sel = el('select', 'scope-select');
  for (const [v, label] of [[0, 'Any age'], [30, 'Older than 30 days'], [90, 'Older than 90 days'], [180, 'Older than 180 days'], [365, 'Older than a year']]) {
    const opt = el('option', null, label);
    opt.value = String(v);
    if (MV.age === v) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.onchange = () => { MV.age = Number(sel.value); paintMemory(); };
  head.appendChild(sel);
  wrap.appendChild(head);

  const kept = d.rows.filter((r) => !r.archived && !r.inQueue).length;
  const rows = d.rows.filter((r) => r.inQueue && (!MV.age || daysAgo(r.activity) >= MV.age))
    .sort((a, b) => (a.activity < b.activity ? -1 : a.activity > b.activity ? 1 : 0));
  if (kept) wrap.appendChild(el('div', 'mem-note', `${kept} kept fact${kept === 1 ? '' : 's'} hidden.`));
  if (!rows.length) { wrap.appendChild(el('div', 'scope-sub', 'Nothing to review at this age.')); return wrap; }
  for (const r of rows) wrap.appendChild(factRow(r, { review: true }));
  return wrap;
}

function factRow(r, { review = false, trash = true } = {}) {
  const row = el('div', 'mem-fact');
  row.dataset.id = r.id;
  const body = el('div', 'sk-body');
  const top = el('div', 'sk-head');
  top.appendChild(el('span', 'sk-name', r.name));
  if (r.type) top.appendChild(el('span', 'sk-source', r.type));
  top.appendChild(el('span', 'mem-where', `${groupLabel(r.group)} · ${r.rel}`));
  if (r.archived) top.appendChild(el('span', 'mem-badge', 'archived'));
  if (r.kept?.contentChanged) top.appendChild(el('span', 'mem-badge warn', 'changed since kept'));
  body.appendChild(top);
  if (r.description) body.appendChild(el('div', 'sk-desc', r.description));
  body.appendChild(factDates(r));
  row.appendChild(body);

  const acts = el('div', 'mem-acts');
  const open = el('button', 'btn ghost', 'Open');
  open.onclick = () => openInEditor(r.openPath, r.display);
  acts.appendChild(open);
  if (review) {
    const keep = el('button', 'btn', 'Keep');
    keep.onclick = async () => {
      try {
        const k = await api('POST', '/api/memory/keep', { id: r.id });
        notice('ok', `Kept ${r.name} until ${fmtDate(k.until)} (sooner if it changes).`);
        await openMemory();
      } catch (e) { notice('error', e.message, null, true); }
    };
    acts.appendChild(keep);
  }
  if (trash) {
    const t = el('button', 'btn danger', 'Trash…');
    t.onclick = () => startPreview('trash-fact', [r.id]);
    acts.appendChild(t);
  }
  row.appendChild(acts);
  return row;
}

/* Cleanups: each finding kind is a checklist that previews as one operation. */
function findingList(kind, title, sub, items, render, action, actLabel) {
  const wrap = el('div', 'sk-group');
  const head = el('div', 'sk-group-head');
  head.appendChild(el('div', 'sk-group-name', title));
  head.appendChild(el('div', 'sk-group-count', `${items.length}`));
  const set = picked(kind);
  const all = el('button', 'btn ghost sk-group-act', 'Select all');
  all.disabled = !items.length;
  all.onclick = () => { items.forEach((x) => set.add(x.id)); paintMemory(); };
  head.appendChild(all);
  const none = el('button', 'btn ghost sk-group-act', 'None');
  none.disabled = !items.length;
  none.onclick = () => { set.clear(); paintMemory(); };
  head.appendChild(none);
  const go = el('button', 'btn primary sk-group-act', actLabel);
  go.disabled = ![...set].length;
  go.onclick = () => startPreview(action, [...set]);
  head.appendChild(go);
  wrap.appendChild(head);
  if (sub) wrap.appendChild(el('div', 'mem-note', sub));
  if (!items.length) wrap.appendChild(el('div', 'mem-note', 'None found.'));
  for (const x of items) {
    const row = el('label', 'sk-row');
    const cb = el('input', 'sk-check');
    cb.type = 'checkbox';
    cb.checked = set.has(x.id);
    cb.onchange = () => { if (cb.checked) set.add(x.id); else set.delete(x.id); paintMemory(); };
    row.appendChild(cb);
    row.appendChild(render(x));
    wrap.appendChild(row);
  }
  return wrap;
}

function cleanupsTab() {
  const f = MV.data.findings;
  const wrap = el('div');
  wrap.appendChild(findingList('empty', 'Empty project folders',
    'Only folders holding nothing but an empty memory/ are listed — never one with a transcript in it. Each moves to the ACS trash.',
    f.emptySlugs, (x) => {
      const b = el('div', 'sk-body');
      b.appendChild(el('div', 'scope-path', x.slug));
      b.appendChild(el('div', 'mem-note', x.probe ? 'temporary session folder' : (SLUG_STATE_LABELS[x.state] || x.state)));
      return b;
    }, 'trash-empty-slugs', 'Preview trash'));

  wrap.appendChild(findingList('dangling', 'Index links to missing files',
    'Only the link itself is removed; every other link and all text on the line stay byte-for-byte. '
    + 'Where the file now sits in _archive/, the link is pointed there instead.',
    f.dangling, (x) => {
      const b = el('div', 'sk-body');
      const h = el('div', 'sk-head');
      h.appendChild(el('span', 'sk-name', x.label || x.target));
      h.appendChild(el('span', 'mem-where', `${groupLabel(x.group)} · MEMORY.md:${x.line} → ${x.target}`));
      h.appendChild(el('span', 'mem-badge', x.offer === 'archive' ? `point at ${x.archiveRel}` : 'remove link'));
      b.appendChild(h);
      b.appendChild(el('div', 'mem-line', x.lineText.length > 220 ? x.lineText.slice(0, 220) + '…' : x.lineText));
      return b;
    }, 'fix-links', 'Preview repair'));

  wrap.appendChild(findingList('unindexed', 'Files missing from their index',
    'Each gets one index entry built from its own frontmatter. A folder with no MEMORY.md gets one created. Archived files are never offered.',
    f.unindexed, (x) => {
      const b = el('div', 'sk-body');
      const r = rowById(x.row);
      const h = el('div', 'sk-head');
      h.appendChild(el('span', 'sk-name', r?.name || x.rel));
      h.appendChild(el('span', 'mem-where', `${groupLabel(x.group)} · ${x.rel}`));
      if (x.createsIndex) h.appendChild(el('span', 'mem-badge', 'creates MEMORY.md'));
      b.appendChild(h);
      return b;
    }, 'add-to-index', 'Preview entries'));

  if (f.oversized.length) {
    const warn = el('div', 'notice warn');
    warn.appendChild(el('div', null, `Index files over ${f.oversized[0].threshold} lines — the harness may cut the rest off:`));
    const ul = el('ul');
    for (const o of f.oversized) ul.appendChild(el('li', null, `${groupLabel(o.group)}: ${o.lines} lines`));
    warn.appendChild(ul);
    wrap.appendChild(warn);
  }
  return wrap;
}

function orphansTab() {
  const f = MV.data.findings;
  const wrap = el('div');
  wrap.appendChild(el('div', 'scope-sub',
    'Memory whose project folder could not be found, each with how sure that is. Review only: moving memory '
    + 'between folders is not offered yet. The one action is trashing a single file, with its index link.'));
  if (!f.orphans.length) wrap.appendChild(el('div', 'mem-note', 'No orphaned memory.'));
  for (const o of f.orphans) {
    const card = el('div', 'mem-card');
    const h = el('div', 'sk-head');
    h.appendChild(el('span', 'sk-name', groupLabel(o.group)));
    h.appendChild(el('span', `mem-badge state-${o.state}`, SLUG_STATE_LABELS[o.state] || o.state));
    card.appendChild(h);
    card.appendChild(el('div', 'scope-path', o.slug));
    if (o.nearest) card.appendChild(el('div', 'mem-note', `Deepest folder that still exists on that path: ${o.nearest}`));
    if (o.candidates.length) card.appendChild(el('div', 'mem-note', `Could be: ${o.candidates.join(' · ')}`));
    const acts = el('div', 'mem-acts');
    for (const cp of o.counterparts) {
      const b = el('button', 'btn', `Compare with ${groupLabel(cp)}`);
      b.onclick = () => { MV.compare = { orphan: o.group, other: cp }; MV.diff = null; paintMemory(); };
      acts.appendChild(b);
    }
    const solo = el('button', 'btn ghost', 'Show files');
    solo.onclick = () => { MV.compare = { orphan: o.group, other: null }; MV.diff = null; paintMemory(); };
    acts.appendChild(solo);
    card.appendChild(acts);
    if (MV.compare?.orphan === o.group) card.appendChild(sideBySide(MV.compare.orphan, MV.compare.other));
    wrap.appendChild(card);
  }

  const dh = el('h3', 'mem-h3', `Same name in more than one project (${f.duplicates.length})`);
  wrap.appendChild(dh);
  if (!f.duplicates.length) wrap.appendChild(el('div', 'mem-note', 'None.'));
  for (const dup of f.duplicates) {
    const card = el('div', 'mem-card');
    card.appendChild(el('div', 'sk-name', dup.name));
    const rows = dup.rows.map(rowById).filter(Boolean);
    for (const r of rows) card.appendChild(factRow(r));
    if (rows.length >= 2) {
      const key = `dup:${dup.name}`;
      const b = el('button', 'btn ghost', 'Diff the first two');
      b.onclick = () => showMemoryDiff(key, rows[0], rows[1]);
      card.appendChild(b);
      if (MV.diff?.key === key) card.appendChild(diffBlock());
    }
    wrap.appendChild(card);
  }
  return wrap;
}

/** The orphan's files beside its counterpart's, matched by relative path. */
function sideBySide(orphanGroup, otherGroup) {
  const rows = MV.data.rows;
  const mine = rows.filter((r) => r.group === orphanGroup);
  const theirs = otherGroup ? rows.filter((r) => r.group === otherGroup) : [];
  const rels = [...new Set([...mine, ...theirs].map((r) => r.rel))].sort();
  const t = el('table', 'mem-table');
  const hr = el('tr');
  for (const h of ['File', groupLabel(orphanGroup) + ' (orphan)', otherGroup ? groupLabel(otherGroup) : '', '']) hr.appendChild(el('th', null, h));
  t.appendChild(hr);
  for (const rel of rels) {
    const a = mine.find((r) => r.rel === rel);
    const b = theirs.find((r) => r.rel === rel);
    const tr = el('tr');
    tr.appendChild(el('td', 'scope-path', rel));
    tr.appendChild(el('td', null, a ? `${fmtDate(a.modified)} · ${a.size} B` : '—'));
    tr.appendChild(el('td', null, otherGroup ? (b ? `${fmtDate(b.modified)} · ${b.size} B` : '—') : ''));
    const acts = el('td', 'mem-acts');
    if (a && b) {
      const d = el('button', 'btn ghost', 'Diff');
      d.onclick = () => showMemoryDiff(`side:${rel}`, a, b);
      acts.appendChild(d);
    }
    if (a) {
      const x = el('button', 'btn danger', 'Trash…');
      x.onclick = () => startPreview('trash-fact', [a.id]);
      acts.appendChild(x);
    }
    tr.appendChild(acts);
    t.appendChild(tr);
  }
  const wrap = el('div', 'mem-compare');
  wrap.appendChild(t);
  if (MV.diff?.key?.startsWith('side:')) wrap.appendChild(diffBlock());
  return wrap;
}

async function showMemoryDiff(key, a, b) {
  try {
    const [fa, fb] = await Promise.all([
      api('GET', `/api/memory/file?id=${encodeURIComponent(a.id)}`),
      api('GET', `/api/memory/file?id=${encodeURIComponent(b.id)}`),
    ]);
    MV.diff = { key, before: fa.content, after: fb.content, labels: [fa.display, fb.display] };
    paintMemory();
    document.querySelector('.mem-diff')?.scrollIntoView({ block: 'start' });
  } catch (e) { notice('error', e.message, null, true); }
}

function diffBlock() {
  const w = el('div', 'mem-diff');
  w.appendChild(diffView(MV.diff.before, MV.diff.after, MV.diff.labels[0], MV.diff.labels[1]));
  return w;
}

function projectsTab() {
  const wrap = el('div');
  for (const g of MV.data.groups) {
    const card = el('details', 'mem-card');
    const sum = el('summary', 'sk-head');
    sum.appendChild(el('span', 'sk-name', g.label));
    sum.appendChild(el('span', `mem-badge state-${g.state}`, SLUG_STATE_LABELS[g.state] || g.state));
    sum.appendChild(el('span', 'mem-where', `${g.rowCount} file${g.rowCount === 1 ? '' : 's'} · ${g.display}`));
    card.appendChild(sum);
    for (const s of g.slugs) {
      const line = el('div', 'mem-note', `${s.worktree ? 'worktree' : 'folder'} ${s.display || s.slug}`
        + (s.memoryFiles ? ` · memory/ holds ${s.memoryFiles}` : ''));
      card.appendChild(line);
      for (const x of s.excluded) card.appendChild(el('div', 'mem-flag', `not read: ${x.rel} (${x.reason})`));
    }
    for (const ix of g.indexes) {
      card.appendChild(el('div', ix.oversized ? 'mem-flag' : 'mem-note', `MEMORY.md: ${ix.lines} lines${ix.oversized ? ' — over the limit' : ''}`));
    }
    card.ontoggle = () => {
      if (!card.open || card.dataset.filled) return;
      card.dataset.filled = '1';
      for (const r of MV.data.rows.filter((x) => x.group === g.id)) card.appendChild(factRow(r));
    };
    wrap.appendChild(card);
  }
  return wrap;
}

function opsTab() {
  const wrap = el('div');
  wrap.appendChild(el('div', 'scope-sub',
    'Every cleanup Accepted here, newest first. Restore puts back everything the operation changed — '
    + 'unless a file was edited since, in which case it shows what changed and restores nothing.'));
  if (!MV.ops.length) wrap.appendChild(el('div', 'mem-note', 'No operations yet.'));
  for (const op of MV.ops) {
    const row = el('div', 'scope-item');
    row.appendChild(el('div', 'mem-badge mem-status', op.status));
    const body = el('div', 'scope-body');
    body.appendChild(el('div', 'scope-path', op.summary));
    body.appendChild(el('div', 'scope-note',
      `${new Date(op.acceptedAt).toLocaleString()} · ${op.steps.filter((s) => s.done).length}/${op.steps.length} steps`
      + (op.restoredAt ? ` · restored ${new Date(op.restoredAt).toLocaleString()}` : '')
      + (op.skipped.length ? ` · skipped: ${op.skipped.join('; ')}` : '')
      + (op.historyError ? ` · history: ${op.historyError}` : '')));
    for (const s of op.steps) body.appendChild(el('div', 'mem-note', `${s.restored ? '↺' : s.done ? '✓' : '·'} ${s.type} ${s.label}`));
    if (op.error) body.appendChild(el('div', 'mem-flag', op.error));
    if (MV.restoreRefusal?.opId === op.id) {
      const r = MV.restoreRefusal;
      body.appendChild(el('div', 'notice error', r.reason));
      for (const dff of r.diffs) body.appendChild(diffView(dff.before, dff.after, `${dff.label} as the cleanup left it`, 'now'));
    }
    row.appendChild(body);
    const btn = el('button', 'btn ghost scope-open', 'Restore');
    btn.disabled = ['restored', 'refused', 'unrecognised'].includes(op.status);
    btn.onclick = async () => {
      try {
        const r = await api('POST', '/api/memory/restore', { opId: op.id });
        if (!r.restored) {
          MV.restoreRefusal = { opId: op.id, reason: r.reason, diffs: r.diffs };
          paintMemory();
          return;
        }
        MV.restoreRefusal = null;
        notice('ok', `Restored: ${op.summary}.` + (r.historyError ? ` (history: ${r.historyError})` : ''));
        await refreshRegistry();
        await openMemory();
      } catch (e) { notice('error', e.message, null, true); }
    };
    row.appendChild(btn);
    wrap.appendChild(row);
  }
  return wrap;
}

async function startPreview(action, ids) {
  try {
    MV.preview = await api('POST', '/api/memory/preview', { action, ids });
    MV.restoreRefusal = null;
    paintMemory();
    $('content').scrollTop = 0;
  } catch (e) { notice('error', e.message, null, true); }
}

function previewPanel() {
  const p = MV.preview;
  const panel = el('div', 'mem-preview');
  panel.appendChild(el('h3', 'mem-h3', `Preview — ${p.summary}`));
  panel.appendChild(el('div', 'mem-note',
    'Nothing has changed yet. Accept re-checks every file first and refuses if any changed since this preview. '
    + 'Anything trashed goes to the ACS trash, and the whole operation can be restored from Operations.'));
  if (p.items.length) {
    const ul = el('ul', 'mem-items');
    for (const it of p.items) ul.appendChild(el('li', null, it));
    panel.appendChild(ul);
  }
  for (const d of p.diffs) {
    panel.appendChild(el('div', 'scope-path', d.label));
    panel.appendChild(diffView(d.before, d.after, 'now', 'after Accept'));
  }
  const acts = el('div', 'mem-acts');
  const accept = el('button', 'btn primary', 'Accept');
  accept.onclick = async () => {
    accept.disabled = true;
    try {
      const r = await api('POST', '/api/memory/accept', { opId: p.opId });
      MV.preview = null;
      for (const set of Object.values(MV.picked)) set.clear();
      const extra = [...r.skipped.map((s) => `Skipped ${s}`), ...(r.historyError ? [`History: ${r.historyError}`] : [])];
      notice(extra.length ? 'warn' : 'ok', `${r.summary} — done. Restorable from Operations.`, extra, extra.length > 0);
      await refreshRegistry();
      await openMemory();
    } catch (e) {
      MV.preview = null;
      notice('error', e.message, null, true);
      await openMemory();
    }
  };
  acts.appendChild(accept);
  const cancel = el('button', 'btn ghost', 'Cancel');
  cancel.onclick = () => { MV.preview = null; paintMemory(); };
  acts.appendChild(cancel);
  panel.appendChild(acts);
  return panel;
}

/* ── Context view ────────────────────────────────────────────────────── */

/**
 * What each project tells its agents, without opening the codebase: every
 * CLAUDE.md / AGENTS.md / .cursor rule per repository, with a heading outline.
 * Identical copies (worktrees, AGENTS.md links) are one entry that still lists
 * every path; a worktree copy that differs from trunk is flagged and diffs.
 */
const CX = { data: null, diff: null, view: null };

async function openContext() {
  if (!confirmDiscard()) return;
  S.view = 'context';
  leaveEditor();
  // Nothing stays open behind this view, or a cleanup that trashes the file
  // last opened would make the live-change handler leave the view.
  S.file = null; S.original = ''; S.draft = '';
  window.history.replaceState(null, '', '#context');
  renderSidebar(); renderTopbar(); renderTabs(); renderStatus();
  $('filebar').hidden = true;
  const c = $('content');
  c.innerHTML = '<div class="scope"><div class="scope-sub"><span class="spinner"></span></div></div>';
  try {
    CX.data = await api('GET', '/api/context');
  } catch (e) {
    c.innerHTML = '';
    const box = el('div', 'scope');
    box.appendChild(el('h2', null, 'Context'));
    box.appendChild(el('div', 'notice error', e.message));
    c.appendChild(box);
    return;
  }
  paintContext();
}

function paintContext() {
  if (S.view !== 'context' || !CX.data) return;
  const d = CX.data;
  const c = $('content');
  const scroll = c.scrollTop;
  c.innerHTML = '';
  const box = el('div', 'scope mem');
  box.appendChild(el('h2', null, 'Context'));
  const perRoot = Object.values(d.roots || {})
    .map((r) => `${r.label}: ${r.files} files as ${r.entries} entries, ${r.drifted} drifted`).join(' · ');
  box.appendChild(el('div', 'scope-sub',
    `${d.totals.files} instruction files, shown as ${d.totals.entries} entries: `
    + `${d.totals.collapsedCopies} identical copies collapsed, ${d.totals.drifted} drifted from trunk. `
    + `${perRoot}. Every copy's path is still listed. Files in edit folders open in the editor, trunk copy first; `
    + 'files in read folders open here, read-only.'));
  for (const u of d.unreadable) box.appendChild(el('div', 'mem-flag', `not read: ${u.display} (${u.reason})`));

  let lastRoot = null;
  for (const g of d.groups) {
    if (g.root !== lastRoot) {
      lastRoot = g.root;
      box.appendChild(el('h3', 'mem-h3', g.readOnly ? `${g.rootLabel} — read-only` : g.rootLabel));
    }
    const card = el('div', 'mem-card');
    const h = el('div', 'sk-head');
    h.appendChild(el('span', 'sk-name', g.label));
    h.appendChild(el('span', 'mem-where', g.display));
    if (g.checkouts.length > 1) h.appendChild(el('span', 'mem-badge', `${g.checkouts.length} checkouts`));
    card.appendChild(h);
    for (const s of g.scopes) card.appendChild(contextScope(s));
    box.appendChild(card);
  }
  c.appendChild(box);
  c.scrollTop = scroll;
}

function contextScope(s) {
  const wrap = el('div', 'cx-scope');
  const h = el('div', 'sk-head');
  h.appendChild(el('span', 'scope-path', s.scope));
  h.appendChild(el('span', 'sk-source', s.kind === 'cursor-rule' ? 'cursor rule' : s.kind === 'agents' ? 'AGENTS.md' : 'CLAUDE.md'));
  if (s.drift) h.appendChild(el('span', 'mem-badge warn', 'drifted'));
  wrap.appendChild(h);

  for (const v of s.variants) {
    const box = el('div', 'cx-variant' + (v.drift ? ' drift' : ''));
    const top = el('div', 'sk-head');
    top.appendChild(el('span', 'mem-where',
      `${v.trunk ? 'trunk' : v.drift ? 'differs from trunk' : 'copy'} · ${v.lines} lines`
      + (v.copies > 1 ? ` · ${v.copies - 1} identical cop${v.copies === 2 ? 'y' : 'ies'} collapsed` : '')));
    const open = el('button', 'btn ghost', v.readOnly ? (CX.view?.id === v.id ? 'Close' : 'View') : 'Open');
    open.onclick = () => (v.readOnly ? toggleContextView(v.id) : openInEditor(v.open.path, v.open.display));
    top.appendChild(open);
    if (v.readOnly) top.appendChild(el('span', 'mem-badge', 'read-only'));
    if (v.drift && s.trunkId) {
      const diffBtn = el('button', 'btn', 'Diff vs trunk');
      diffBtn.onclick = () => showContextDiff(s.trunkId, v.id);
      top.appendChild(diffBtn);
    }
    box.appendChild(top);
    const paths = el('div', 'cx-paths');
    for (const p of v.paths) {
      paths.appendChild(el('div', 'mem-note', `${p.display}${p.trunk ? ' (trunk)' : ''}${p.readOnly && !v.readOnly ? ' (read-only)' : ''}${p.alias ? ` — link ${p.alias}` : ''}`));
    }
    box.appendChild(paths);
    if (v.outline.length) {
      const ol = el('div', 'cx-outline');
      for (const o of v.outline) {
        const line = el('div', 'cx-head', `${'  '.repeat(o.level - 1)}${o.text}`);
        line.appendChild(el('span', 'cx-lines', `${o.lines} line${o.lines === 1 ? '' : 's'}`));
        ol.appendChild(line);
      }
      box.appendChild(ol);
    } else {
      box.appendChild(el('div', 'mem-note', 'No headings.'));
    }
    if (CX.view?.id === v.id) {
      const view = el('div', 'cx-read md');
      view.innerHTML = renderMarkdown(CX.view.content);
      box.appendChild(view);
    }
    if (CX.diff?.id === v.id) {
      box.appendChild(diffView(CX.diff.before, CX.diff.after, CX.diff.labels[0], CX.diff.labels[1]));
    }
    wrap.appendChild(box);
  }
  return wrap;
}

/** A read-only root's file, shown in place by id — it never goes to the editor. */
async function toggleContextView(id) {
  if (CX.view?.id === id) { CX.view = null; paintContext(); return; }
  try {
    const f = await api('GET', `/api/context/file?id=${encodeURIComponent(id)}`);
    CX.view = { id, content: f.content };
    paintContext();
  } catch (e) { notice('error', e.message, null, true); }
}

async function showContextDiff(trunkId, id) {
  try {
    const [a, b] = await Promise.all([
      api('GET', `/api/context/file?id=${encodeURIComponent(trunkId)}`),
      api('GET', `/api/context/file?id=${encodeURIComponent(id)}`),
    ]);
    CX.diff = { id, before: a.content, after: b.content, labels: [a.display, b.display] };
    paintContext();
  } catch (e) { notice('error', e.message, null, true); }
}

/* ── Usage view ──────────────────────────────────────────────────────── */

/**
 * Subscription headroom per seat.
 *
 * This is a routing gauge, not a dashboard: the question it answers is "which
 * subscription should the next task go to", so seats sort by the headroom of
 * their tightest window and the answer is the first line.
 *
 * The studio reads no credential of its own. Codex seats are read live from
 * their own logs; Claude's reading is taken by a separate process and shown
 * with its age rather than implied to be current.
 */

let usageTimer = null;

/**
 * A command the user has to run in their own terminal.
 *
 * The studio never performs a login: the OAuth flow needs a browser, and the
 * credential must not pass through here. So the honest affordance is the exact
 * command, ready to copy.
 */
/**
 * Sign a Codex seat in without leaving the browser.
 *
 * `codex login` prints an OAuth URL and runs a local callback server, so the
 * studio starts it, opens the URL, and polls until the seat has credentials.
 * The token lands in the seat's own auth.json — the studio never sees it.
 */
/**
 * `view` is the view that owns the row: polling stops once it is left (Usage,
 * or the setup screen, which runs the same flow). `onSignedIn` repaints it.
 */
function connectRow(seat, { reauth = false, view = 'usage', onSignedIn = () => paintUsage() } = {}) {
  const row = el('div', 'usage-hint');
  const btn = el('button', 'btn', reauth ? 'Sign in as a different account' : 'Sign in with ChatGPT');
  const status = el('span', 'usage-hint-label', '');

  btn.onclick = async () => {
    btn.disabled = true; status.textContent = 'starting sign-in…';
    let res;
    try { res = await api('POST', '/api/usage/connect', { id: seat.seatId, reauth }); }
    catch (e) { btn.disabled = false; status.textContent = ''; return notice('error', e.message); }
    // Something is holding this seat's home open. Signing in now would be
    // undone the next time that process refreshes its token, so offer to stop
    // it here rather than sending the user to a terminal to find pids.
    if (res.conflicts?.length) {
      btn.disabled = false;
      status.textContent = '';
      row.appendChild(conflictRow(seat, res.conflicts, res.error, () => btn.click()));
      return;
    }
    if (res.error) { btn.disabled = false; status.textContent = ''; return notice('error', res.error); }
    // The conflict check could not run here (no lsof): sign-in goes ahead,
    // and the person is told what that check would have caught.
    if (res.unchecked) row.appendChild(el('div', 'usage-conflict-why connect-unchecked', res.unchecked));

    // The window.open happens after an await, so the browser's user-activation
    // window may have expired and the popup be blocked silently. Always render
    // the link too, so a blocked tab is a visible next step rather than a UI
    // that claims to be waiting for something that never opened.
    const opened = window.open(res.url, '_blank', 'noopener');
    const link = el('a', 'usage-hint-link', 'Open the sign-in page');
    link.href = res.url;
    link.target = '_blank';
    link.rel = 'noopener';
    row.appendChild(link);
    status.textContent = opened
      ? 'waiting for you to finish in the other tab…'
      : 'your browser blocked the popup — use the link';

    // Poll rather than hold a request open for the whole OAuth round trip.
    const started = Date.now();
    const poll = setInterval(async () => {
      if (S.view !== view) return clearInterval(poll);
      let st;
      try { st = await api('POST', '/api/usage/connect/state', { id: seat.seatId }); }
      catch { return; }
      if (st.signedIn) {
        clearInterval(poll);
        // Reconcile through the CLI before repainting. It is the only process
        // that can read account identity, so until it has run, the studio
        // cannot know this seat changed account — and would keep filtering
        // against the previous login.
        status.textContent = 'signed in — checking this seat…';
        try { await api('POST', '/api/usage/refresh'); } catch { /* the repaint still shows state */ }
        notice('info', `${seat.label} is signed in. Its usage appears after the seat runs once.`);
        onSignedIn();
      } else if (!st.running && Date.now() - started > 5000) {
        clearInterval(poll);
        btn.disabled = false;
        status.textContent = 'sign-in was cancelled or did not complete';
      }
    }, 2000);
  };

  row.appendChild(btn);
  row.appendChild(status);
  return row;
}

/**
 * A seat is busy: running Codex processes hold its home open.
 *
 * This is the UI for a failure that used to be a runbook instruction. A Codex
 * process refreshes its credentials back into its home on its own schedule, so
 * one left running across a sign-in silently undoes it minutes later. "Quit
 * your session first" is not actionable — nobody can see which sessions those
 * are. So: name them, and offer one button.
 */
function conflictRow(seat, conflicts, message, retry) {
  const box = el('div', 'usage-conflict');
  box.appendChild(el('div', 'usage-conflict-why', message
    || 'Something is using this seat right now. Signing in would be undone when it next refreshes.'));

  const list = el('div', 'usage-conflict-list');
  for (const c of conflicts) {
    list.appendChild(el('div', 'usage-conflict-item', `${c.command} · pid ${c.pid}`));
  }
  box.appendChild(list);

  const stop = el('button', 'btn', conflicts.length === 1 ? 'Quit it and sign in' : 'Quit them and sign in');
  stop.onclick = async () => {
    stop.disabled = true;
    stop.textContent = 'stopping…';
    let r;
    try { r = await api('POST', '/api/usage/seats/conflicts/stop', { id: seat.seatId, pids: conflicts.map((c) => c.pid) }); }
    catch (e) { stop.disabled = false; stop.textContent = 'Quit them and sign in'; return notice('error', e.message); }
    if (r.remaining?.length) {
      stop.disabled = false;
      stop.textContent = 'Try again';
      return notice('error',
        `${r.remaining.length} still running (${r.remaining.map((x) => x.pid).join(', ')}). ` +
        'Some processes need to be closed from their own window.');
    }
    box.remove();
    retry();
  };
  box.appendChild(stop);
  box.appendChild(el('div', 'usage-conflict-note',
    'They are asked to stop, not force-killed, so anything in progress gets to save.'));
  return box;
}

/**
 * A seat is still parked in the shared ~/.codex.
 *
 * Not an error — it usually reads fine — which is why this is offered on a
 * healthy card too. The point is that its ACCOUNT can be changed by things the
 * user never sees: the ChatGPT desktop app, a bare `codex login`, any
 * long-lived process refreshing a token back into that folder.
 */
function sharedHomeNotice(s) {
  const warn = el('div', 'usage-conflict');
  warn.appendChild(el('div', 'usage-conflict-why',
    'This seat shares the default Codex folder with the ChatGPT app and every plain ' +
    '`codex` command. Anything that signs in there changes this seat\'s account. ' +
    'Moving it to its own folder means only you decide what it is signed in to.'));
  const move = el('button', 'btn', 'Move to its own folder');
  move.onclick = async () => {
    move.disabled = true; move.textContent = 'moving…';
    try {
      await api('POST', '/api/usage/seats/move', { id: s.seatId });
      notice('info', `${s.label} now has its own folder. Sign it in to finish.`);
    } catch (e) {
      move.disabled = false; move.textContent = 'Move to its own folder';
      return notice('error', e.message);
    }
    await paintUsage();
  };
  warn.appendChild(move);
  warn.appendChild(el('div', 'usage-conflict-note',
    'Your settings stay shared. Only the sign-in and session history become private, ' +
    'so you will sign in once more after this.'));
  return warn;
}

/** The seat's account changed since we last looked — deliberate, or not. */
function accountChangedNotice() {
  return el('div', 'usage-offline-why',
    'This seat is signed in to a different account than last time. If you did not just ' +
    're-authenticate it, something else is writing to this folder — earlier readings have ' +
    'been discarded because they belong to the previous account.');
}

/** Signed in, but Codex has not recorded a quota reading yet. */
function waitingHint() {
  const row = el('div', 'usage-hint');
  row.appendChild(el('span', 'usage-hint-label',
    'Connected. Codex reports quota only after a turn runs, so this fills in the first time you use this seat.'));
  return row;
}

/**
 * Shell shortcuts panel.
 *
 * The point of the whole feature: switching subscriptions should be a word you
 * type, not a path you remember. Everything here is one screen of plain choices;
 * the validation that makes it safe lives on the server, because this output is
 * executed by every terminal the user opens.
 */
function shortcutsPanel(state) {
  const form = el('div', 'usage-add');
  form.appendChild(el('div', 'usage-add-title', 'Terminal shortcuts'));

  if (!state.shortcuts.length) {
    form.appendChild(el('div', 'usage-add-note',
      'Shortcuts apply to Codex seats — they are the only ones whose account is chosen by ' +
      'the terminal. Add a second Codex seat and it will appear here.'));
    return form;
  }

  const edits = { words: {}, flags: {}, defaultId: (state.shortcuts.find((s) => s.isDefault) || {}).id };
  for (const sc of state.shortcuts) {
    const row = el('div', 'usage-add-row');
    row.appendChild(el('span', 'usage-shortcut-seat', sc.label));

    const word = document.createElement('input');
    word.className = 'usage-add-label';
    word.value = sc.word;
    word.maxLength = 24;
    word.placeholder = 'word to type';
    word.oninput = () => { edits.words[sc.id] = word.value.trim(); };

    const flags = document.createElement('input');
    flags.className = 'usage-add-label';
    flags.value = sc.flags || '';
    flags.maxLength = 120;
    flags.placeholder = 'always-on flags (e.g. --yolo)';
    flags.oninput = () => { edits.flags[sc.id] = flags.value.trim(); };

    // Which seat a bare `codex` spends is an explicit choice — otherwise it
    // would follow registry order, and reordering seats would quietly move a
    // subscription's spend.
    const def = document.createElement('label');
    def.className = 'usage-shortcut-default';
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'acs-default-seat';
    radio.checked = !!sc.isDefault;
    radio.onchange = () => { edits.defaultId = sc.id; };
    def.appendChild(radio);
    def.appendChild(document.createTextNode(' default'));

    row.appendChild(word); row.appendChild(flags); row.appendChild(def);
    form.appendChild(row);
    form.appendChild(el('div', 'usage-add-note',
      `Type “${sc.word}”, “codex ${sc.word}”, or “codex-${sc.word}” — each runs Codex on this seat.` +
      (sc.isDefault ? ' A plain “codex” runs this one.' : '')));
  }

  const controls = el('div', 'usage-add-row');
  const save = el('button', 'btn', state.installed ? 'Save' : 'Turn on shortcuts');
  save.onclick = async () => {
    save.disabled = true;
    const words = { ...Object.fromEntries(state.shortcuts.map((s) => [s.id, s.word])), ...edits.words };
    const flags = { ...Object.fromEntries(state.shortcuts.map((s) => [s.id, s.flags || ''])), ...edits.flags };
    try {
      const r = await api('POST', '/api/usage/shortcuts',
        { words, flags, defaultId: edits.defaultId, install: true });
      notice('info', `Shortcuts saved: ${r.shortcuts.map((s) => s.word).join(', ')}. ` +
        'Open a new terminal tab to use them.');
    } catch (e) { notice('error', e.message); }
    save.disabled = false;
    await paintUsage();
  };
  controls.appendChild(save);

  if (state.installed) {
    const off = el('button', 'btn ghost', 'Turn off');
    off.onclick = async () => {
      off.disabled = true;
      try {
        await api('POST', '/api/usage/shortcuts', { words: {}, flags: {}, install: false });
        notice('info', 'Shortcuts removed from your shell. Existing tabs keep them until reopened.');
      } catch (e) { notice('error', e.message); }
      await paintUsage();
    };
    controls.appendChild(off);
  }
  form.appendChild(controls);

  form.appendChild(el('div', 'usage-add-note',
    state.installed
      ? `Active in every terminal. Installed as one line in ${state.zshenv}, which zsh reads for ` +
        'every shell — new tabs, scripts and all. Switching seats never asks you to sign in again.'
      : 'Turning these on adds a single line to your shell profile. Nothing else on your machine changes.'));
  form.appendChild(el('div', 'usage-add-note',
    'Quit a running Codex session before switching — the account is fixed when it starts.'));
  return form;
}

function addSeatForm() {
  const form = el('div', 'usage-add');
  form.appendChild(el('div', 'usage-add-title', 'Track another subscription'));

  const row = el('div', 'usage-add-row');
  const vendor = document.createElement('select');
  vendor.className = 'usage-add-vendor';
  for (const [value, text] of [['codex', 'Codex (ChatGPT)'], ['claude', 'Claude'], ['grok', 'Grok']]) {
    const o = document.createElement('option');
    o.value = value; o.textContent = text;
    vendor.appendChild(o);
  }
  const label = document.createElement('input');
  label.className = 'usage-add-label';
  label.placeholder = 'Name it — e.g. "Codex (work)"';
  label.maxLength = 60;

  const save = el('button', 'btn', 'Add');
  const submit = async () => {
    if (!label.value.trim()) return label.focus();
    save.disabled = true;
    let res;
    try { res = await api('POST', '/api/usage/seats', { vendor: vendor.value, label: label.value.trim() }); }
    catch (e) { save.disabled = false; return notice('error', e.message); }
    S.usageAdding = false;
    await paintUsage();
    if (res.loginCommand) {
      notice('info', `Seat added. Run the login command shown on "${res.seat.label}" to connect it.`);
    } else if (res.note) {
      notice('info', res.note);
    }
  };
  save.onclick = submit;
  label.onkeydown = (e) => { if (e.key === 'Enter') submit(); };

  row.appendChild(vendor); row.appendChild(label); row.appendChild(save);
  form.appendChild(row);
  form.appendChild(el('div', 'usage-add-note',
    'A second Codex seat gets its own home, sharing your config by symlink — only the login and ' +
    'session history differ. You sign in from here; no terminal needed. ' +
    'A Grok seat reads its weekly quota through the Grok CLI, so sign in with `grok login` first.'));
  return form;
}


// seatHeadroom, rankSeats, routeSeat, seatState, seatConnect, windowLeft,
// pressure and untilText live in usage-view.js: Home reads seats the same way.

const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const agoText = (ms) => (ms == null ? '' : ms < 60000 ? 'just now' : `${untilText(Date.now() + ms)} ago`);

async function openUsage() {
  if (!confirmDiscard()) return;
  S.view = 'usage';
  leaveEditor();
  window.history.replaceState(null, '', '#usage');
  renderSidebar(); renderTopbar(); renderTabs(); renderStatus();
  $('filebar').hidden = true;

  const c = $('content');
  c.innerHTML = '<div class="scope"><div class="scope-sub"><span class="spinner"></span> reading usage…</div></div>';
  await paintUsage();

  // Meant to be left open, so it keeps itself current. Cleared whenever the
  // view changes so a closed panel is not polling forever.
  clearInterval(usageTimer);
  usageTimer = setInterval(() => {
    if (S.view !== 'usage') { clearInterval(usageTimer); usageTimer = null; return; }
    paintUsage();
  }, 60_000);
}

async function paintUsage() {
  const c = $('content');
  let u;
  try { u = await api('GET', '/api/usage'); }
  catch (e) { c.innerHTML = `<div class="scope"><div class="scope-sub">${esc(e.message)}</div></div>`; return; }
  if (S.view !== 'usage') return;   // the view changed while the request was in flight

  const seats = rankSeats(u.seats);

  c.innerHTML = '';
  const box = el('div', 'scope');

  const panelHead = el('div', 'usage-head');
  panelHead.appendChild(el('h2', null, 'Subscription usage'));
  const actions = el('div', 'usage-actions');

  const refresh = el('button', 'btn ghost', 'Refresh');
  refresh.onclick = async () => {
    refresh.disabled = true; refresh.textContent = 'Refreshing…';
    // The reading Claude needs a token for is taken by a child process, so the
    // credential never enters the studio. It can take a second.
    try { await api('POST', '/api/usage/refresh'); } catch (e) { notice('error', e.message); }
    await paintUsage();
  };
  actions.appendChild(refresh);

  const addBtn = el('button', 'btn ghost', '+ Add seat');
  addBtn.onclick = () => { S.usageAdding = !S.usageAdding; paintUsage(); };
  actions.appendChild(addBtn);

  const scBtn = el('button', 'btn ghost', 'Shortcuts');
  scBtn.onclick = () => { S.usageShortcuts = !S.usageShortcuts; paintUsage(); };
  actions.appendChild(scBtn);
  panelHead.appendChild(actions);
  box.appendChild(panelHead);

  if (S.usageAdding) box.appendChild(addSeatForm());
  if (S.usageShortcuts) {
    let sc = null;
    try { sc = await api('GET', '/api/usage/shortcuts'); } catch (e) { notice('error', e.message); }
    if (sc) box.appendChild(shortcutsPanel(sc));
  }

  if (!seats.length) {
    box.appendChild(el('div', 'scope-sub',
      'No subscriptions tracked yet — use + Add seat above.'));
    c.appendChild(box);
    revealUsageFocus(box);
    return;
  }

  const route = routeSeat(seats);
  const head = el('div', 'usage-route');
  if (route) {
    head.appendChild(el('span', 'usage-route-label', 'Route to'));
    head.appendChild(el('span', 'usage-route-seat', route.seat.label));
    head.appendChild(el('span', 'usage-route-pct', `${route.left}% left`));
  } else {
    head.appendChild(el('span', 'usage-route-label', 'No seat is reporting usable headroom'));
  }
  box.appendChild(head);

  for (const s of seats) {
    const card = el('div', 'usage-seat');
    card.dataset.seat = s.seatId;
    const title = el('div', 'usage-seat-head');
    title.appendChild(el('span', 'usage-seat-name', s.label));
    const meta = [s.vendor, s.planType, s.subscriptionType].filter(Boolean).join(' · ');
    title.appendChild(el('span', 'usage-seat-meta', meta));
    card.appendChild(title);

    const drop = el('button', 'usage-drop', '×');
    drop.title = 'Stop tracking this seat';
    drop.onclick = async () => {
      // Unregisters only. The seat's home holds a real login and its history,
      // so removing a row from a list must never destroy credentials.
      if (!confirm(`Stop tracking "${s.label}"?\n\nIts login and history stay on disk.`)) return;
      try { await api('POST', '/api/usage/seats/remove', { id: s.seatId }); }
      catch (e) { return notice('error', e.message); }
      paintUsage();
    };
    title.appendChild(drop);

    if (!s.ok) {
      // A signed-in seat with no turns yet is a different state from one that
      // was never connected, and telling someone to re-run a login that already
      // worked is the worst thing this panel could do. seatState() holds the
      // distinctions; they are shared with Home.
      const st = seatState(s);
      const noQuota = st.kind === 'noQuota';
      const why = el('div', 'usage-offline');
      const tag = el('span', 'usage-offline-tag', st.tag);
      if (st.tone) tag.classList.add(st.tone);
      why.appendChild(tag);
      why.appendChild(el('span', 'usage-offline-why', s.reason || ''));
      card.appendChild(why);

      if (noQuota && s.activity) {
        const bits = [];
        if (s.activity.turns) {
          bits.push(`${s.activity.turns} turn${s.activity.turns === 1 ? '' : 's'} in the last 24h`);
          bits.push(`${fmtTokens(s.activity.inputTokens + s.activity.outputTokens)} tokens`);
        }
        if (s.lastActiveAt) bits.push(`last used ${agoText(Date.now() - s.lastActiveAt)}`);
        // Deliberately no dollar figure: the cost field is in "ticks" whose
        // scale is unverified, and a wrong one would be a confident wrong number.
        if (bits.length) card.appendChild(el('div', 'usage-note', bits.join(' · ')));
      }
      if (s.vendor === 'codex' && s.home) {
        // A duplicate is signed in — it just needs a DIFFERENT account, so the
        // affordance is re-auth, not sign-in.
        const connect = seatConnect(s);
        card.appendChild(connect ? connectRow(s, { reauth: connect === 'reauth' }) : waitingHint());
      }
    } else {
      for (const w of s.windows) {
        const row = el('div', 'usage-row');
        const track = el('div', 'usage-track');
        const fill = el('div', 'usage-fill');
        // Everything in this panel measures what is LEFT, never what is spent.
        // Both directions used to appear here at once — an unlabelled "72%" on
        // the bar meaning spent, and "97% headroom" in the summary meaning
        // left — which put the conversion in the reader's head and got a seat
        // read as empty when it was untouched. One direction, stated in words.
        const left = windowLeft(w);
        fill.style.width = `${left}%`;
        // Tinting is by pressure, not by vendor: the colour has to mean the
        // same thing on every gauge or it stops being readable at a glance.
        fill.dataset.level = pressure(left);
        track.appendChild(fill);
        row.appendChild(el('span', 'usage-pct', `${Math.round(left)}% left`));
        row.appendChild(track);
        const lbl = el('span', 'usage-label', w.label);
        if (w.resetsAt) lbl.appendChild(el('span', 'usage-reset', ` resets in ${untilText(w.resetsAt)}`));
        row.appendChild(lbl);
        card.appendChild(row);
      }
      const notes = [];
      if (s.credits?.hasCredits) {
        notes.push(`credits ${s.credits.unlimited ? 'unlimited'
          : (s.credits.balance == null ? 'available' : s.credits.balance)}`);
      }
      if (s.extraUsage?.enabled) {
        notes.push(`extra usage ${s.extraUsage.usedCredits}/${s.extraUsage.monthlyLimit} ${s.extraUsage.currency}`);
      }
      // A reading is only as good as its age. Codex readings come from the last
      // turn that ran, so an idle seat's number can be hours old and still true.
      // A held-over reading must say so, or a stale number looks current.
      if (s.staleReason) notes.push(`${s.staleReason} — showing the last good reading`);
      if (s.stale && s.observedAt) {
        const stale = el('div', 'usage-stale',
          `as of ${agoText(Date.now() - s.observedAt)} — not current. Run a turn on this seat to refresh it.`);
        card.appendChild(stale);
      }
      if (s.expiredWindows) notes.push(`${s.expiredWindows} window(s) hidden — already reset`);
      if (s.readingAge != null && s.readingAge > 5 * 60_000) notes.push(`read ${agoText(s.readingAge)}`);
      else if (s.observedAt && Date.now() - s.observedAt > 30 * 60_000) {
        notes.push(`last recorded turn ${agoText(Date.now() - s.observedAt)}`);
      }
      if (notes.length) card.appendChild(el('div', 'usage-note', notes.join(' · ')));
    }
    // Both notices live at CARD level, not inside the not-ok branch. A seat
    // parked in the shared folder is usually reading perfectly well — that is
    // exactly the state the offer is for — and an account change that already
    // has a reading would otherwise be invisible.
    if (s.sharedHome) card.appendChild(sharedHomeNotice(s));
    if (s.accountChanged) card.appendChild(accountChangedNotice());

    box.appendChild(card);
  }

  box.appendChild(el('div', 'scope-sub',
    'Codex reads its own logs live. Claude needs an OAuth token, which the studio never handles ' +
    'itself — Refresh takes that reading in a separate process.'));
  c.appendChild(box);
  revealUsageFocus(box);
}

/**
 * Arriving from Home's Connect or Add account: show that seat, or the Add
 * form, and put focus on its first control. The flow itself runs here —
 * connectRow polls only while this view is open.
 */
function revealUsageFocus(box) {
  const want = S.usageFocus;
  S.usageFocus = null;
  if (!want) return;
  if (want.add) {
    const input = box.querySelector('.usage-add-label');
    input?.scrollIntoView?.({ block: 'center' });
    return input?.focus();
  }
  const card = [...box.querySelectorAll('.usage-seat')].find((x) => x.dataset.seat === want.seat);
  if (!card) return;
  card.classList.add('usage-seat-focus');
  card.scrollIntoView?.({ block: 'center' });
  card.querySelector('.usage-hint .btn')?.focus();
}

/* ── Home view ───────────────────────────────────────────────────────── */

/**
 * Where to start: what is connected, how much is left, and what needs you.
 *
 * Each card calls the existing route it needs and paints on its own — a slow
 * or failing source shows a spinner or "unavailable" on its card and nowhere
 * else. There is no aggregate endpoint. The memory index and `wclean` are the
 * slow ones, so they start after first paint. What the cards say is decided
 * in home.js; this paints it.
 */
const HOME = {
  src: {},             // source id -> { state, data, error }
  inflight: {},        // source id -> its pending request, shared by re-renders
  settledAt: 0,        // when every source of the last full load answered
  body: {},            // card id -> its body element, for the current render
  timing: null,        // { painted, settled } ms since page start, first load only
};
const HOME_ROUTES = {
  usage: '/api/usage', models: '/api/models', context: '/api/context',
  trash: '/api/trash', clis: '/api/setup/clis', roots: '/api/roots',
  memory: '/api/memory', worktrees: '/api/worktree',
};
const HOME_SLOW = new Set(['memory', 'worktrees']);
const HOME_CARDS_OF = {
  usage: ['accounts', 'clis'], clis: ['clis'], roots: ['folders'], trash: ['recent'],
  models: ['attention'], memory: ['attention'], worktrees: ['attention'], context: ['attention'],
};
/** Revisiting Home within this long repaints what it has rather than asking again. */
const HOME_FRESH_MS = 30_000;

function renderHome(c) {
  const box = el('div', 'home');

  const accounts = homeCard('accounts', 'Accounts & usage');
  const addBtn = el('button', 'btn ghost', 'Add account');
  addBtn.onclick = () => goUsage({ add: true });
  const usageBtn = el('button', 'btn ghost', 'Open Usage');
  usageBtn.onclick = () => goUsage(null);
  accounts.tools.append(addBtn, usageBtn);

  const attention = homeCard('attention', 'Needs attention');
  const refresh = el('button', 'btn ghost', 'Refresh');
  refresh.onclick = () => { HOME.settledAt = 0; renderContent(); };
  attention.tools.appendChild(refresh);

  const clis = homeCard('clis', 'CLIs');
  const recent = homeCard('recent', 'Recent');
  const trashBtn = el('button', 'btn ghost', 'Open Trash');
  trashBtn.onclick = () => openTrash();
  recent.tools.appendChild(trashBtn);

  // One line for the folders, and the way back into setup.
  const folders = el('div', 'home-folders');
  folders.setAttribute('aria-live', 'polite');
  box.appendChild(folders);
  box.appendChild(accounts.card);
  const grid = el('div', 'home-grid');
  const side = el('div', 'home-col');
  side.append(clis.card, recent.card);
  grid.append(attention.card, side);
  box.appendChild(grid);
  c.appendChild(box);

  HOME.body = { folders, accounts: accounts.body, attention: attention.body, clis: clis.body, recent: recent.body };
  paintHome(Object.keys(HOME.body));
  if (!HOME.timing) HOME.timing = { painted: Math.round(performance.now()), settled: null };

  if (HOME.settledAt && Date.now() - HOME.settledAt < HOME_FRESH_MS) return;
  loadHome();
}

/** "Needs you: N" beside the Home title — what Needs attention lists, hidden at zero. */
function homeNeedsChip() {
  const n = attentionModel(HOME.src).items.length;
  return n ? el('span', 'home-needs', `Needs you: ${n}`) : null;
}

function homeCard(id, title) {
  const card = el('section', `home-card home-${id}`);
  card.setAttribute('aria-labelledby', `home-${id}-title`);
  const head = el('div', 'home-card-head');
  const h = el('h2', 'home-card-title', title);
  h.id = `home-${id}-title`;
  const tools = el('div', 'home-card-tools');
  head.append(h, tools);
  const body = el('div', 'home-card-body');
  body.setAttribute('aria-live', 'polite');
  card.append(head, body);
  return { card, tools, body };
}

/**
 * Ask every source, fast ones now and slow ones once the page has painted.
 * A source keeps its last answer on screen until the new one lands, and an
 * answer that lands after you left Home is dropped rather than painted.
 */
function loadHome() {
  // After first paint — or after 50 ms if no frame comes, since a background
  // tab runs none. Whichever is first; the promise settles once either way.
  const afterPaint = new Promise((r) => {
    requestAnimationFrame(() => setTimeout(r, 0));
    setTimeout(r, 50);
  });
  const ask = (id) => {
    if (!HOME.src[id]) HOME.src[id] = { state: 'loading' };
    const start = HOME_SLOW.has(id) ? afterPaint : Promise.resolve();
    return start.then(() => {
      if (S.view !== 'home') return false;
      HOME.inflight[id] ||= api('GET', HOME_ROUTES[id])
        .then(homeSource, (e) => ({ state: 'error', error: e.message }))
        .finally(() => { HOME.inflight[id] = null; });
      return HOME.inflight[id].then((res) => {
        if (S.view !== 'home') return false;
        HOME.src[id] = res;
        if (id === 'models' && res.state === 'ok') paintModelsBadge(res.data.pending || 0);
        paintHome(HOME_CARDS_OF[id]);
        return true;
      });
    });
  };
  // Recent's history line is the registry's, so "all loaded" waits for it too.
  const history = registryReady.then(() => S.view === 'home');
  Promise.all([...Object.keys(HOME_ROUTES).map(ask), history]).then((stored) => {
    if (!stored.every(Boolean)) return;
    HOME.settledAt = Date.now();
    if (HOME.timing && HOME.timing.settled == null) HOME.timing.settled = Math.round(performance.now());
  });
}

function paintHome(cards) {
  if (S.view !== 'home') return;
  const painters = { folders: paintFolderLine, accounts: paintAccounts, attention: paintAttention, clis: paintClis, recent: paintRecent };
  for (const id of new Set(cards)) {
    const body = HOME.body[id];
    if (!body) continue;
    body.innerHTML = '';
    painters[id](body);
  }
}

const homeLoading = (text) => {
  const row = el('div', 'home-state');
  row.appendChild(el('span', 'spinner'));
  row.appendChild(el('span', null, text));
  return row;
};
const homeFailed = (label, error) => {
  const row = el('div', 'home-state home-failed');
  row.appendChild(el('span', 'home-dash', '—'));
  row.appendChild(el('span', null, `${label} unavailable${error ? `: ${error}` : ''}`));
  return row;
};

/** Home's Connect and Add account go to Usage, which runs the flow. */
function goUsage(focus) {
  if (!confirmDiscard()) return;
  S.usageFocus = focus;
  if (focus?.add) S.usageAdding = true;
  openUsage();
}

function homeAction(action) {
  if (!confirmDiscard()) return;
  if (action.view === 'memory' && action.tab) MV.tab = action.tab;
  viewById(action.view).open();
}

function paintAccounts(body) {
  const src = HOME.src.usage;
  if (!src || src.state === 'loading') return body.appendChild(homeLoading('Reading usage…'));
  if (src.state === 'error') return body.appendChild(homeFailed('Usage', src.error));
  const { route, rows } = accountsModel(src.data);
  if (!rows.length) {
    const empty = el('div', 'home-state');
    empty.appendChild(el('span', null, 'No subscriptions tracked yet.'));
    const add = el('button', 'btn', 'Add account');
    add.onclick = () => goUsage({ add: true });
    empty.appendChild(add);
    return body.appendChild(empty);
  }

  const head = el('div', 'home-route');
  if (route) {
    head.appendChild(el('span', 'usage-route-label', 'Route to'));
    head.appendChild(el('span', 'home-route-seat', route.seat.label));
    head.appendChild(el('span', 'usage-route-pct', `${route.left}% left`));
  } else {
    head.appendChild(el('span', 'usage-route-label', 'No seat is reporting usable headroom'));
  }
  body.appendChild(head);

  for (const r of rows) {
    const row = el('div', 'home-seat');
    row.dataset.seat = r.id;
    const who = el('div', 'home-seat-who');
    who.appendChild(el('div', 'home-seat-name', r.label));
    if (r.meta) who.appendChild(el('div', 'home-seat-meta', r.meta));
    row.appendChild(who);

    const read = el('div', 'home-seat-read');
    if (r.state.kind === 'reading') {
      if (!r.windows.length) read.appendChild(el('span', 'home-muted', 'connected · no quota windows reported'));
      for (const w of r.windows) {
        const win = el('div', 'home-win');
        win.appendChild(el('span', 'usage-pct', `${w.left}% left`));
        const track = el('div', 'usage-track home-track');
        const fill = el('div', 'usage-fill');
        fill.style.width = `${w.left}%`;
        fill.dataset.level = w.level;
        track.appendChild(fill);
        win.appendChild(track);
        const lbl = el('span', 'usage-label', w.label);
        if (w.resetsAt) lbl.appendChild(el('span', 'usage-reset', ` · resets in ${untilText(w.resetsAt)}`));
        win.appendChild(lbl);
        read.appendChild(win);
      }
      if (r.stale) {
        read.appendChild(el('div', 'usage-stale',
          `as of ${r.observedAt ? agoText(Date.now() - r.observedAt) : 'an earlier reading'} — not current`));
      }
    } else {
      const line = el('div', 'home-seat-state');
      const tag = el('span', 'usage-offline-tag', r.state.tag);
      if (r.state.tone) tag.classList.add(r.state.tone);
      line.appendChild(tag);
      if (r.reason) line.appendChild(el('span', 'home-muted', r.reason));
      read.appendChild(line);
    }
    row.appendChild(read);

    const act = el('div', 'home-seat-act');
    if (r.connect) {
      const b = el('button', 'btn', r.connect === 'reauth' ? 'Sign in again' : 'Connect');
      b.title = 'Opens this seat in Usage, where the sign-in runs';
      b.onclick = () => goUsage({ seat: r.id });
      act.appendChild(b);
    }
    row.appendChild(act);
    body.appendChild(row);
  }
}

function paintAttention(body) {
  const m = attentionModel(HOME.src);
  for (const it of m.items) {
    const row = el('div', `home-item ${it.kind}`);
    row.appendChild(el('span', 'home-item-dot'));
    row.appendChild(el('span', 'home-item-text', it.text));
    const b = el('button', 'btn ghost home-item-btn', it.action.label);
    b.onclick = () => homeAction(it.action);
    row.appendChild(b);
    body.appendChild(row);
  }
  for (const p of m.partial) {
    const row = el('div', 'home-state home-failed');
    row.appendChild(el('span', 'home-dash', '—'));
    row.appendChild(el('span', null, `${p.label}: ${p.text}`));
    body.appendChild(row);
  }
  for (const f of m.failed) body.appendChild(homeFailed(f.label, f.error));
  if (m.loading.length) body.appendChild(homeLoading(`Checking ${m.loading.map((x) => x.label.toLowerCase()).join(', ')}…`));
  if (m.clear) {
    const ok = el('div', 'home-clear');
    ok.appendChild(el('div', 'home-clear-title', 'Nothing needs you.'));
    ok.appendChild(el('div', 'home-muted', m.quiet.length
      ? 'Everything installed was checked: models, memory, worktrees and context.'
      : 'Models, memory, worktrees and context all checked.'));
    body.appendChild(ok);
  }
  for (const q of m.quiet) body.appendChild(el('div', 'home-muted home-pad home-quiet', q.text));
  renderTopbar();
}

function paintFolderLine(body) {
  const r = HOME.src.roots;
  if (!r || r.state === 'loading') body.appendChild(el('span', 'home-muted', 'Project folders: …'));
  else if (r.state === 'error') body.appendChild(el('span', 'home-muted', `Project folders unavailable: ${r.error}`));
  else body.appendChild(el('span', 'home-folders-count', folderCountText(r.data)));
  const open = el('button', 'btn ghost', 'Folders');
  open.onclick = () => homeAction({ view: 'folders' });
  const again = el('button', 'btn ghost', 'Run setup again');
  again.onclick = () => homeAction({ view: 'setup' });
  body.append(open, again);
}

function paintClis(body) {
  const src = HOME.src.clis;
  const rows = clisCardModel(src?.state === 'ok' ? src.data : null);
  if (!src || src.state === 'loading') body.appendChild(homeLoading('Detecting CLIs…'));
  else if (src.state === 'error') body.appendChild(homeFailed('Detection', src.error));
  for (const r of rows) {
    const row = el('div', 'home-cli');
    row.dataset.cli = r.id;
    const top = el('div', 'home-cli-top');
    top.appendChild(el('span', 'home-cli-name', r.label));
    top.appendChild(el('span', `home-chip ${r.installed ? 'ok' : 'warn'}`, r.installed ? 'installed' : 'not installed'));
    row.appendChild(top);
    row.appendChild(el('div', 'home-muted', r.installed ? `${r.version} · sign-in: ${r.signIn}` : 'install it from setup'));
    body.appendChild(row);
  }

  const { codex } = cliModel(null, HOME.src.usage);
  const row = el('div', 'home-cli');
  const top = el('div', 'home-cli-top');
  top.appendChild(el('span', 'home-cli-name', 'Codex seats'));
  row.appendChild(top);
  if (codex.state === 'loading') row.appendChild(homeLoading('from Usage…'));
  else if (codex.state === 'error') row.appendChild(homeFailed('Usage', codex.error));
  else if (!codex.seats) row.appendChild(el('div', 'home-muted', 'no Codex seat tracked in Usage'));
  else {
    top.appendChild(el('span', `home-chip ${codex.signIn ? 'warn' : 'ok'}`, codex.signIn ? 'needs sign-in' : 'signed in'));
    row.appendChild(el('div', 'home-muted',
      `${codex.seats} seat${codex.seats === 1 ? '' : 's'} in Usage · ${codex.reading} reading` +
      (codex.signIn ? ` · ${codex.signIn} to sign in` : '')));
    if (codex.signIn) {
      const fix = el('button', 'btn ghost home-item-btn', 'Sign in from Usage');
      fix.onclick = () => goUsage(null);
      top.appendChild(fix);
    }
  }
  body.appendChild(row);
  const again = el('button', 'btn ghost home-item-btn', 'Check in setup');
  again.onclick = () => homeAction({ view: 'setup' });
  const foot = el('div', 'home-foot', 'Installed CLIs, their versions and sign-in, as setup checks them. ');
  foot.appendChild(again);
  body.appendChild(foot);
}

function paintRecent(body) {
  const t = HOME.src.trash;
  const hist = S.registry?.history ?? null;
  const m = recentModel(t?.state === 'ok' ? t.data : null, hist);

  const last = el('div', 'home-recent-last');
  if (!S.registry && S.registryFailed) last.appendChild(homeFailed('History', S.registryFailed));
  else if (!S.registry) last.appendChild(homeLoading('Reading history…'));
  else if (!m.last) last.appendChild(el('span', 'home-muted', 'No versions recorded yet.'));
  else {
    last.appendChild(el('div', 'home-recent-subject', m.last.subject || '(no message)'));
    last.appendChild(el('div', 'home-muted',
      `last version ${m.last.at ? agoText(Date.now() - m.last.at) : ''} · ${m.last.commits} kept`));
  }
  body.appendChild(last);

  body.appendChild(el('div', 'home-sub', 'Recently deleted'));
  if (!t || t.state === 'loading') return body.appendChild(homeLoading('Reading trash…'));
  if (t.state === 'error') return body.appendChild(homeFailed('Trash', t.error));
  if (!m.trash.length) return body.appendChild(el('div', 'home-muted home-pad', 'Nothing deleted.'));
  for (const it of m.trash) {
    const row = el('div', 'home-trash');
    row.appendChild(el('span', 'home-trash-path', it.display));
    row.appendChild(el('span', 'home-muted', agoText(Date.now() - new Date(it.deletedAt).getTime())));
    body.appendChild(row);
  }
  if (m.more) body.appendChild(el('div', 'home-muted home-pad', `and ${m.more} more in Trash`));
}

/* ── MCP view ────────────────────────────────────────────────────────── */
async function openMcp() {
  if (!confirmDiscard()) return;
  S.view = 'mcp';
  leaveEditor();
  window.history.replaceState(null, '', '#mcp');
  renderSidebar(); renderTopbar(); renderTabs(); renderStatus();
  $('filebar').hidden = true;

  const c = $('content');
  c.innerHTML = '<div class="scope"><div class="scope-sub"><span class="spinner"></span> reading MCP config…</div></div>';
  let m;
  try { m = await api('GET', '/api/mcp'); }
  catch (e) { c.innerHTML = `<div class="scope"><div class="scope-sub">${esc(e.message)}</div></div>`; return; }

  c.innerHTML = '';
  const box = el('div', 'scope');
  box.appendChild(el('h2', null, 'MCP servers'));
  box.appendChild(el('div', 'scope-sub', m.note || ''));

  const section = (title, rows, empty) => {
    box.appendChild(el('p', 'assist-label', title));
    if (!rows.length) { box.appendChild(el('div', 'scope-sub', empty)); return; }
    for (const s of rows) {
      const row = el('div', 'scope-item');
      row.appendChild(el('div', 'scope-rank', s.name.slice(0, 2).toUpperCase()));
      const body = el('div', 'scope-body');
      body.appendChild(el('div', 'scope-path', s.name));
      const bits = [s.scope, s.transport, s.target].filter(Boolean);
      body.appendChild(el('div', 'scope-note', bits.join(' · ')));
      row.appendChild(body);
      box.appendChild(row);
    }
  };

  section('Claude Code — read-only', m.global, 'No MCP servers configured.');
  section('Codex', m.codex, 'No MCP servers in config.toml.');

  const editable = S.registry.groups.find((g) => g.id === 'mcp');
  if (editable) {
    box.appendChild(el('p', 'assist-label', 'Project .mcp.json — editable'));
    for (const e of editable.entries) {
      const row = el('div', 'scope-item');
      row.appendChild(el('div', 'scope-rank', '{ }'));
      const body = el('div', 'scope-body');
      body.appendChild(el('div', 'scope-path', e.display));
      body.appendChild(el('div', 'scope-note', e.description || ''));
      row.appendChild(body);
      const open = el('button', 'btn ghost scope-open', 'Open');
      open.onclick = () => openEntry(e);
      row.appendChild(open);
      box.appendChild(row);
    }
  }
  c.appendChild(box);
}

/* ── Models view ─────────────────────────────────────────────────────── */
/**
 * Every registry family, where its id comes from and where it is used, and
 * what the CLIs' own catalogs say about it. The studio proposes; nothing is
 * applied until you press a button.
 */
const M = { open: new Set(), where: {}, drafts: {}, sidecars: [], data: null };

function paintModelsBadge(n) {
  S.badges.models = n || 0;
  syncNav();
}

async function openModels() {
  if (!confirmDiscard()) return;
  S.view = 'models';
  leaveEditor();
  window.history.replaceState(null, '', '#models');
  renderSidebar(); renderTopbar(); renderTabs(); renderStatus();
  $('filebar').hidden = true;
  $('content').innerHTML = '<div class="scope"><div class="scope-sub"><span class="spinner"></span> reading model catalogs…</div></div>';
  await paintModels(() => api('GET', '/api/models'));
}

async function paintModels(load) {
  const c = $('content');
  let m;
  try { m = load ? await load() : M.data; }
  catch (e) { c.innerHTML = `<div class="scope"><div class="scope-sub">${esc(e.message)}</div></div>`; return; }
  if (S.view !== 'models') return;
  M.data = m;
  paintModelsBadge(m.pending);

  c.innerHTML = '';
  const box = el('div', 'scope models');
  const head = el('div', 'usage-head');
  head.appendChild(el('h2', null, 'Models'));
  const actions = el('div', 'usage-actions');
  const check = el('button', 'btn ghost', 'Check now');
  check.onclick = async () => {
    check.disabled = true; check.textContent = 'Checking…';
    await paintModels(() => api('POST', '/api/models/check'));
  };
  actions.appendChild(check);
  head.appendChild(actions);
  box.appendChild(head);
  box.appendChild(el('div', 'scope-sub',
    `Read from each CLI's own catalog on disk; Check now first has Codex refresh its catalogs — no tokens. Checked ${agoText(Date.now() - m.checkedAt)}` +
    (m.claudeVersion ? ` · Claude Code ${m.claudeVersion.split(' ')[0]}` : '') + '.'));

  if (m.registryError) {
    const n = el('div', 'notice error models-error');
    n.appendChild(el('div', null, 'The model registry file is invalid. Defaults are in use, and edits are refused until it is fixed:'));
    n.appendChild(el('div', 'models-error-text', m.registryError));
    box.appendChild(n);
  }

  const cats = el('div', 'models-catalogs');
  for (const cat of m.catalogs) {
    const line = el('div', `models-catalog${cat.note ? (cat.ok ? ' stale' : ' missing') : ''}`);
    line.appendChild(el('span', 'models-catalog-name', cat.label));
    line.appendChild(el('span', null, cat.note ||
      `${cat.count} models · fetched ${agoText(Date.now() - cat.fetchedAt)}`));
    cats.appendChild(line);
    if (cat.disagree) cats.appendChild(el('div', 'models-catalog stale', cat.disagree));
    if (cat.refreshNote) cats.appendChild(el('div', 'models-catalog stale', cat.refreshNote));
  }
  box.appendChild(cats);

  if (M.sidecars.length) box.appendChild(sidecarStrip());

  const table = el('table', 'models-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['Family', 'Current id', 'Name', 'Source', 'Alerts']) hr.appendChild(el('th', null, h));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const r of m.rows) {
    const tr = el('tr', `models-row${M.open.has(r.family) ? ' open' : ''}`);
    tr.dataset.family = r.family;
    tr.onclick = (e) => {
      if (e.target.closest('button')) return;
      if (M.open.has(r.family)) M.open.delete(r.family); else M.open.add(r.family);
      paintModels();
    };
    const fam = el('td', 'models-family');
    fam.appendChild(el('span', `item-dot ${r.vendor === 'claude' ? 'claude' : r.vendor === 'codex' ? 'codex' : 'grok'}`));
    fam.appendChild(document.createTextNode(r.family));
    if (!r.track) fam.appendChild(el('span', 'item-badge', 'pinned'));
    tr.appendChild(fam);
    tr.appendChild(el('td', 'models-id', r.id));
    tr.appendChild(el('td', 'models-name', r.displayName || '—'));
    tr.appendChild(el('td', `models-source ${r.source}`, r.source === 'override' ? 'your override' : 'default'));
    const al = el('td', 'models-alerts');
    const live = r.alerts.filter((a) => !a.dismissed);
    if (!live.length) al.appendChild(el('span', 'models-none', r.alerts.length ? 'dismissed' : '—'));
    for (const a of live) al.appendChild(alertChip(r, a));
    tr.appendChild(al);
    tbody.appendChild(tr);
    if (M.open.has(r.family)) tbody.appendChild(modelDetail(r, m));
  }
  table.appendChild(tbody);
  box.appendChild(table);
  c.appendChild(box);
}

function alertChip(row, a) {
  const chip = el('div', `models-alert ${a.kind}`);
  const text = a.kind === 'update'
    ? `Newer: ${a.candidate}${a.displayName ? ` (${a.displayName})` : ''}`
    : a.kind === 'retiring'
      ? `Retiring${a.date ? ` ${new Date(a.date).toLocaleDateString()}` : ''}${a.candidate ? ` → ${a.candidate}` : ''}`
      : 'No longer offered by the CLI';
  chip.appendChild(el('span', 'models-alert-text', text));
  if (a.message) chip.title = a.message;
  if (a.reason) chip.appendChild(el('span', 'models-alert-why', a.reason));
  if (a.candidate) {
    const acc = el('button', 'btn ghost models-alert-btn', 'Accept');
    acc.disabled = !a.acceptable || !!M.data.registryError;
    acc.title = a.reason || `Set ${row.family} to ${a.candidate}`;
    acc.onclick = () => modelWrite('/api/models/accept', { family: row.family, key: a.key },
      `${row.family} is now ${a.candidate}.`);
    chip.appendChild(acc);
  }
  const dis = el('button', 'btn ghost models-alert-btn', 'Dismiss');
  dis.onclick = async () => {
    try { await api('POST', '/api/models/dismiss', { family: row.family, key: a.key }); }
    catch (e) { return notice('error', e.message, null, true); }
    await paintModels(() => api('GET', '/api/models'));
  };
  chip.appendChild(dis);
  return chip;
}

function modelDetail(r, m) {
  const tr = el('tr', 'models-detail');
  const td = el('td');
  td.colSpan = 5;

  const edit = el('div', 'models-edit');
  const input = el('input', 'models-input');
  // Kept across repaints: where-used arriving mid-typing must not wipe the draft.
  input.value = M.drafts[r.family] ?? r.id;
  input.oninput = () => { M.drafts[r.family] = input.value; };
  input.spellcheck = false;
  input.setAttribute('aria-label', `${r.family} model id`);
  const save = el('button', 'btn primary', 'Save');
  const reset = el('button', 'btn ghost', 'Reset to default');
  const refused = !!m.registryError;
  save.disabled = refused;
  reset.disabled = refused || r.source !== 'override';
  reset.title = r.source === 'override' ? `Remove your override; the default is ${r.defaultId}` : 'Already the default';
  const submit = () => {
    const id = input.value.trim();
    if (!ID_SHAPE.test(id)) return notice('error', `${id || '(empty)'} is not a valid model id — lowercase letters, digits, "." and "-", up to 64 characters.`);
    modelWrite('/api/models/set', { family: r.family, id }, `${r.family} is now ${id}.`);
  };
  save.onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  reset.onclick = () => modelWrite('/api/models/reset', { family: r.family }, `${r.family} is back to the default, ${r.defaultId}.`);
  edit.appendChild(input);
  edit.appendChild(save);
  edit.appendChild(reset);
  td.appendChild(edit);
  if (refused) td.appendChild(el('div', 'scope-note', 'Edits are refused while the registry file is invalid.'));

  for (const a of r.alerts.filter((x) => x.message)) td.appendChild(el('div', 'models-message', a.message));

  const where = el('div', 'models-where');
  where.appendChild(el('p', 'assist-label', `Where model-id ${r.family} is used`));
  const w = M.where[r.family];
  if (!w) {
    where.appendChild(el('div', 'scope-note', 'reading…'));
    api('GET', `/api/models/where?family=${encodeURIComponent(r.family)}`)
      .then((res) => { M.where[r.family] = res; if (S.view === 'models') paintModels(); })
      .catch((e) => { M.where[r.family] = { hits: [], error: e.message }; if (S.view === 'models') paintModels(); });
  } else if (w.error) {
    where.appendChild(el('div', 'scope-note', w.error));
  } else if (!w.hits.length) {
    where.appendChild(el('div', 'scope-note', 'No skill, config or CLAUDE.md calls it.'));
  } else {
    for (const h of w.hits) {
      const line = el('div', 'models-where-hit');
      line.appendChild(el('span', 'models-where-file', `${h.file}:${h.line}`));
      line.appendChild(el('span', 'models-where-text', h.text));
      where.appendChild(line);
    }
    if (w.truncated) where.appendChild(el('div', 'scope-note', 'Showing the first matches only.'));
  }
  td.appendChild(where);
  tr.appendChild(td);
  return tr;
}

const ID_SHAPE = /^[a-z0-9][a-z0-9.\-]{0,63}$/;

/** Set, reset or accept: one write path, with the server's confirm round-trip. */
async function modelWrite(path, body, okText) {
  let r;
  try {
    r = await api('POST', path, body);
    if (r.needsConfirm) {
      if (!confirm(`${r.warnings.join('\n')}\n\nSave ${r.family} = ${r.id} anyway?`)) return;
      r = await api('POST', path, { ...body, confirm: true });
    }
  } catch (e) { return notice('error', e.message, null, true); }
  if (r.unchanged) { notice('ok', 'Nothing to change.'); return; }
  if (!r.saved) return notice('error', 'Not saved.', null, true);
  notice('ok', okText + (r.historyError ? ` (history: ${r.historyError})` : ''));
  M.sidecars = r.sidecars || [];
  M.where = {};
  M.drafts = {};
  // The Assist picker reads the registry; refresh it so the change shows there too.
  await refreshRegistry().catch(() => {});
  await paintModels(() => api('GET', '/api/models'));
}

function sidecarStrip() {
  const strip = el('div', 'models-sidecars');
  const head = el('div', 'models-sidecars-head');
  head.appendChild(el('span', null, 'Files the CLIs own still name the old id. Each edit changes only the part it names:'));
  const close = el('button', 'btn ghost models-alert-btn', 'Done');
  close.onclick = () => { M.sidecars = []; paintModels(); };
  head.appendChild(close);
  strip.appendChild(head);
  for (const s of M.sidecars) {
    const row = el('div', 'models-sidecar');
    row.appendChild(el('span', 'models-where-file', s.file));
    row.appendChild(el('span', 'models-sidecar-what', s.what));
    const acc = el('button', 'btn ghost models-alert-btn', 'Accept');
    acc.onclick = async () => {
      let res;
      try { res = await api('POST', '/api/models/sidecar', { kind: s.kind, from: s.from, to: s.to, mtime: s.mtime }); }
      catch (e) { return notice('error', e.message, null, true); }
      notice('ok', `Updated ${s.file}.`);
      // This write is the only change since the others in the same file were
      // proposed, so they carry its mtime forward rather than reading as a conflict.
      M.sidecars = M.sidecars.filter((x) => x !== s).map((x) => (x.file === s.file ? { ...x, mtime: res.mtime } : x));
      paintModels();
    };
    row.appendChild(acc);
    const skip = el('button', 'btn ghost models-alert-btn', 'Skip');
    skip.onclick = () => { M.sidecars = M.sidecars.filter((x) => x !== s); paintModels(); };
    row.appendChild(skip);
    strip.appendChild(row);
  }
  return strip;
}

/* ── assist chat ─────────────────────────────────────────────────────── */
/**
 * Sessions are the unit of work: one thread about one topic, kept across drawer
 * open/close and page reloads. Up to MAX_SESSIONS are retained; the CLI session
 * behind a thread is an implementation detail that changes when you compact,
 * while the thread itself keeps its identity.
 */
const MAX_SESSIONS = 5;
const CONTEXT_LIMIT = 200_000;
const SESSIONS_KEY = 'acs.sessions.v2';

const C = {
  sessions: [],
  activeId: null,
  busy: false,
  stream: '',
  startedAt: 0,
  running: null,        // {harness, model} captured at submit — see sendTurn
  abort: null,
  draft: '',
  picker: null,
  harness: null,        // reconciled against the server's detected list at boot
  model: null,          // ...and so is this: the default is the harness's, from the registry
};

/* ── harness ─────────────────────────────────────────────────────────── */
/**
 * Which CLI runs Assist. The choice is explicit and sticky: it never follows
 * the file you have open. A model that changes underneath you as you move
 * between files produces "why did this answer get worse" reports that nobody
 * can reproduce.
 */
const harnesses = () => S.registry?.harnesses ?? [];
const harnessOf = (id) => harnesses().find((h) => h.id === id) || null;
const harnessLabel = (id) => harnessOf(id)?.label ?? id ?? 'no harness';
/** The server sends each harness's models as [{id,label}] — its own allowlist. */
const modelsOf = (h) => h?.models ?? [];

/**
 * Reconcile the stored choice with what the server actually detected. A harness
 * that has gone away is reported, not swapped out from under you — the whole
 * point of the picker is that you know what answered.
 */
function resolveHarness() {
  const list = harnesses();
  if (!list.length) { C.harness = null; return; }
  const want = C.harness;
  const h = harnessOf(want) ?? harnessOf(S.registry.defaultHarness) ?? list[0];
  if (want && h.id !== want) {
    notice('warn', `${want} is no longer available here — Assist switched to ${h.label}.`, null, true);
  }
  if (h.id !== C.harness) {
    C.harness = h.id;
    // Moved off a harness you had chosen — its model means nothing here. With
    // nothing stored (first run, or a session written before the picker) the
    // model below is still valid and worth keeping.
    if (want) C.model = h.defaultModel;
  }
  // A stored id the registry has since replaced follows its family forward,
  // rather than silently resetting to the default.
  if (!modelsOf(h).some((m) => m.id === C.model) && Object.hasOwn(h.retired ?? {}, C.model)) {
    C.model = h.retired[C.model];
  }
  // A stored model may belong to a harness you have since left.
  if (!modelsOf(h).some((m) => m.id === C.model)) C.model = h.defaultModel;
  saveSessions();
}

const PRESETS = [
  ['Tighten', 'Tighten the attached file. Cut filler and hedging. Preserve every rule, path, command and threshold exactly. Do not add rules.'],
  ['Critique', 'Review the attached file and give me the three most important problems — ambiguous rules, contradictions, or anything stale. Be specific and quote the text. Do not rewrite it.'],
  ['Improve description', 'Improve only the `description` field in the frontmatter so the model loads this skill at the right moment. Leave everything else byte-identical.'],
];

const COMPACT_PROMPT =
  'Summarise this conversation so it can continue in a fresh context. Cover: what we are working on, ' +
  'decisions made, edits already applied, and anything still pending. Be dense and specific — file paths, ' +
  'exact wording we settled on, open questions. No preamble. This summary is the only thing that survives.';

function newSession(mentions = []) {
  return {
    id: 's' + Math.random().toString(36).slice(2, 10),
    title: 'New session',
    mentions: [...mentions],
    messages: [],
    slots: {},            // harness id -> its CLI session, seed and stats
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Per-harness CLI state inside one thread. The transcript is yours, but the CLI
 * session under it belongs to whichever harness produced it: switching harness
 * parks that slot and opens a fresh one, and switching back resumes where you
 * were. A Claude session id is never offered to grok — the server refuses the
 * pair, and the client has no business asking.
 */
function newSlot() {
  return {
    cliSessionId: null,
    seed: null,
    compactions: 0,
    stats: { turns: 0, contextTokens: 0, costUsd: 0, baselineTokens: 0 },
  };
}
const slotOf = (s, harness = C.harness) => s?.slots?.[harness || 'none'] ?? null;
function slotFor(s, harness = C.harness) {
  const key = harness || 'none';
  s.slots ||= {};
  return (s.slots[key] ||= newSlot());
}

function active() {
  return C.sessions.find((s) => s.id === C.activeId) || null;
}

function ensureSession() {
  let s = active();
  if (!s) {
    if (!C.sessions.length) {
      s = newSession(S.file ? [S.file.path] : []);
      C.sessions.unshift(s);
    } else {
      s = C.sessions[0];
    }
    C.activeId = s.id;
  }
  return s;
}

function saveSessions() {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify({
      activeId: C.activeId,
      harness: C.harness,
      model: C.model,
      sessions: C.sessions.map((s) => ({
        ...s,
        // Proposals are dropped: by next load the file may have moved on, and a
        // stale diff must never remain applyable.
        messages: s.messages.map((m) => ({
          role: m.role, text: m.text, error: m.error, note: m.note,
          mentions: m.mentions, harness: m.harness,
        })),
      })),
    }));
  } catch { /* quota or private mode */ }
}

function restoreSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return;
    const t = JSON.parse(raw);
    C.sessions = (t.sessions || []).slice(0, MAX_SESSIONS).map((s) => {
      // Sessions written before the picker have one flat CLI session, and it
      // can only have come from Claude.
      const { cliSessionId, seed, stats, compactions, ...rest } = s;
      return {
        ...rest,
        slots: s.slots ?? {
          claude: {
            cliSessionId: cliSessionId ?? null,
            seed: seed ?? null,
            compactions: compactions ?? 0,
            stats: { ...newSlot().stats, ...(stats || {}) },
          },
        },
        messages: (s.messages || []).map((m) => ({ ...m, proposals: [] })),
      };
    });
    C.activeId = t.activeId && C.sessions.some((s) => s.id === t.activeId) ? t.activeId : (C.sessions[0]?.id ?? null);
    if (t.harness) C.harness = t.harness;
    if (t.model) C.model = t.model;
  } catch { /* corrupt store — start clean */ }
}

/** Context is a property of the CLI session, so it is read per harness slot. */
function contextPct(s) {
  return Math.min(100, Math.round(((slotOf(s)?.stats.contextTokens || 0) / CONTEXT_LIMIT) * 100));
}
const contextLeft = (s) => 100 - contextPct(s);

/** Tokens attributable to this conversation, excluding fixed harness overhead. */
function conversationTokens(s) {
  const st = slotOf(s)?.stats;
  if (!st?.baselineTokens) return 0;
  return Math.max(0, (st.contextTokens || 0) - st.baselineTokens);
}
/** Below this, compaction frees less than it costs to run. */
const COMPACT_WORTH_IT = 15_000;

function titleFor(s) {
  if (s.title && s.title !== 'New session') return s.title;
  const firstUser = s.messages.find((m) => m.role === 'user');
  if (firstUser) return firstUser.text.replace(/\s+/g, ' ').slice(0, 42);
  if (s.mentions.length) return s.mentions[0].split('/').pop();
  return 'New session';
}

/* ── drawer ──────────────────────────────────────────────────────────── */
function openDrawer() {
  const d = $('drawer');
  if (!d.classList.contains('open') && !d.contains(document.activeElement)) C.opener = document.activeElement;
  d.classList.add('open');
  d.inert = false;
  d.removeAttribute('aria-hidden');
  $('scrim').classList.add('open');
  const s = ensureSession();
  // Default the target to whatever is open — still you pointing at it, just
  // without retyping what you are already looking at.
  if (!s.mentions.length && S.file) s.mentions = [S.file.path];
  renderChat();
  setTimeout(() => $('chat-input')?.focus(), 60);
}
/** Closed, the drawer leaves the tab order, and focus goes back to what opened it. */
function closeDrawer() {
  const d = $('drawer');
  if (!d.classList.contains('open')) return;
  d.classList.remove('open');
  d.inert = true;
  d.setAttribute('aria-hidden', 'true');
  $('scrim').classList.remove('open');
  const back = C.opener && document.body.contains(C.opener) && C.opener !== document.body ? C.opener : $('btn-assist');
  C.opener = null;
  back.focus();
}

function allFiles() {
  const out = [];
  for (const g of S.registry?.groups || []) {
    for (const e of g.entries) {
      for (const f of e.files) out.push({ ...f, group: g.title, entry: e.label, harness: e.harness });
    }
  }
  return out;
}

function renderChat() {
  renderSessionBar();
  renderChatBody();
  renderCompose();
}

/* ── session bar ─────────────────────────────────────────────────────── */
function renderSessionBar() {
  const bar = $('session-bar');
  const s = active();
  bar.innerHTML = '';
  if (!s) { bar.hidden = true; return; }
  bar.hidden = false;

  // Switcher
  const row = el('div', 'sess-row');
  const sel = el('select', 'sess-select');
  C.sessions.forEach((x) => {
    const comp = slotOf(x)?.compactions ?? 0;
    const o = el('option', null,
      `${titleFor(x)}  ·  ${contextLeft(x)}% left${comp ? ` · compacted ×${comp}` : ''}`);
    o.value = x.id;
    if (x.id === C.activeId) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = () => { C.activeId = sel.value; C.draft = ''; saveSessions(); renderChat(); };
  row.appendChild(sel);

  const add = el('button', 'btn ghost sess-btn', '+');
  add.title = `New session (${C.sessions.length}/${MAX_SESSIONS})`;
  add.onclick = createSession;
  row.appendChild(add);

  const del = el('button', 'btn ghost sess-btn', '×');
  del.title = 'Delete this session';
  del.onclick = deleteSession;
  row.appendChild(del);
  bar.appendChild(row);

  // Context meter — how much room is LEFT, which is the number that matters.
  // It describes the CURRENT harness's slot; switching harness shows that one.
  const sl = slotFor(s);
  const left = contextLeft(s);
  const label = el('div', 'sess-label');
  const big = el('span', 'sess-left', `${left}% context left`);
  if (left <= 15) big.classList.add('hot');
  else if (left <= 35) big.classList.add('warm');
  label.appendChild(big);
  const conv = conversationTokens(s);
  label.appendChild(el('span', 'sess-dim',
    `${sl.stats.turns} turn${sl.stats.turns === 1 ? '' : 's'}` +
    (sl.stats.baselineTokens
      ? ` · ${(conv / 1000).toFixed(1)}k conversation + ${(sl.stats.baselineTokens / 1000).toFixed(0)}k overhead`
      : ` · ${(sl.stats.contextTokens / 1000).toFixed(1)}k / 200k`)));
  if (sl.stats.costUsd) label.appendChild(el('span', 'sess-dim', `$${sl.stats.costUsd.toFixed(2)}`));

  const convo = conversationTokens(s);
  const compact = el('button', 'btn ghost sess-compact', 'Compact');
  compact.disabled = C.busy || !sl.cliSessionId || convo < COMPACT_WORTH_IT;
  compact.title = convo < COMPACT_WORTH_IT
    ? `Not worth it yet — only ${(convo / 1000).toFixed(1)}k of this context is the conversation. ` +
      `The other ${(sl.stats.baselineTokens / 1000).toFixed(0)}k is ${harnessLabel(C.harness)}'s own overhead and compaction cannot reclaim it.`
    : `Summarise ${(convo / 1000).toFixed(1)}k of conversation and continue in a fresh context. Same session.`;
  compact.onclick = compactSession;
  label.appendChild(compact);
  bar.appendChild(label);

  const meter = el('div', 'sess-meter');
  const fill = el('div', 'sess-fill');
  fill.style.width = `${Math.max(2, 100 - left)}%`;
  if (left <= 15) fill.classList.add('hot');
  else if (left <= 35) fill.classList.add('warm');
  meter.appendChild(fill);
  bar.appendChild(meter);

  if (left <= 15) {
    bar.appendChild(el('div', 'sess-warn',
      'Nearly full. Auto-compaction is off in your settings, so compact this thread or start a new one before the next turn.'));
  }
}

function createSession() {
  if (C.sessions.length >= MAX_SESSIONS) {
    notice('warn',
      `You're at the ${MAX_SESSIONS}-session cap. Delete one with × before starting another.`, null, true);
    return;
  }
  const s = newSession(S.file ? [S.file.path] : []);
  C.sessions.unshift(s);
  C.activeId = s.id;
  C.draft = '';
  saveSessions();
  renderChat();
}

function deleteSession() {
  const s = active();
  if (!s) return;
  if (s.messages.length && !confirm(`Delete "${titleFor(s)}"?\n\nThe conversation is discarded. Files and edits you already accepted are untouched.`)) return;
  C.sessions = C.sessions.filter((x) => x.id !== s.id);
  C.activeId = C.sessions[0]?.id ?? null;
  if (!C.sessions.length) ensureSession();
  saveSessions();
  renderChat();
}

/**
 * Manual compaction. Claude Code's own /compact does not work through
 * `-p --resume` — it reports success but the history is gone, verified. So we
 * ask for a summary, then continue the same thread on a fresh CLI session
 * seeded with it. Same session to you; new session id underneath.
 */
async function compactSession() {
  const s = active();
  const req = { harness: C.harness, model: C.model };
  const sl = slotFor(s ?? {}, req.harness);
  if (!s || C.busy || !sl.cliSessionId) return;

  C.busy = true;
  C.stream = '';
  C.startedAt = Date.now();
  C.running = req;
  C.abort = new AbortController();
  renderChat();
  clearInterval(tickTimer);
  tickTimer = setInterval(renderChatBody, 1000);

  try {
    const final = await streamChat({
      message: COMPACT_PROMPT,
      mentions: [],
      sessionId: sl.cliSessionId,
      harness: req.harness,
      model: req.model,
      onDelta: () => renderChatBody(),
    });
    // Fail closed: only an explicit ok:true is a success. The server has exactly one
    // `done` sender and it always sets `ok`, so a missing field means a malformed or
    // truncated stream — which must not persist a session id or render as a reply.
    if (final?.ok !== true) throw new Error(final?.error || 'The turn failed.');
    const summary = (C.stream || final?.text || '').trim();
    if (!summary) throw new Error('Compaction returned nothing — thread left as it was.');

    const turnsBefore = sl.stats.turns;
    sl.seed = summary;
    sl.cliSessionId = null;                // next turn starts fresh, seeded
    sl.compactions += 1;
    sl.stats.contextTokens = 0;
    sl.stats.baselineTokens = 0;
    s.messages = [{
      role: 'assistant',
      harness: req.harness,
      note: `Compacted ${turnsBefore} turn${turnsBefore === 1 ? '' : 's'} into a summary. The thread continues from here.`,
      text: summary,
    }];
    saveSessions();
    notice('ok', `Compacted — ${contextLeft(s)}% context free again.`);
  } catch (e) {
    if (e.name !== 'AbortError') notice('error', `Compaction failed: ${e.message}`, null, true);
  } finally {
    clearInterval(tickTimer);
    C.busy = false;
    C.stream = '';
    C.running = null;
    C.abort = null;
    renderChat();
  }
}

/* ── transcript ──────────────────────────────────────────────────────── */
function renderChatBody() {
  const body = $('drawer-body');
  const s = active();
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  body.innerHTML = '';

  if (s && !s.messages.length && !C.busy) {
    const intro = el('div', 'chat-intro');
    intro.appendChild(el('p', 'assist-label', 'Ask for a change'));
    intro.appendChild(el('div', 'scope-sub',
      'Attach the files you want changed with @, then say what you want. Edits come back as diffs you accept per file — nothing is written until you do.'));
    const row = el('div', 'assist-actions');
    for (const [label, text] of PRESETS) {
      const chip = el('button', 'assist-chip', label);
      chip.onclick = () => { C.draft = text; renderCompose(); $('chat-input')?.focus(); };
      row.appendChild(chip);
    }
    intro.appendChild(row);
    body.appendChild(intro);
  }

  for (const m of s?.messages || []) body.appendChild(renderMessage(m));

  if (C.busy) {
    // Named for the harness that is actually running, not the one now picked —
    // you may have switched the dropdown while this turn was in flight.
    const run = C.running || { harness: C.harness };
    const secs = (Date.now() - C.startedAt) / 1000;
    const live = el('div', 'msg assistant');
    const meta = el('div', 'msg-meta');
    meta.appendChild(el('span', 'spinner'));
    meta.appendChild(el('span', null, `${harnessLabel(run.harness)} · ${secs.toFixed(0)}s`));
    live.appendChild(meta);
    const prose = stripEditBlocks(C.stream);
    live.appendChild(prose
      ? el('div', 'msg-text', prose)
      : el('div', 'msg-wait', waitingLine(run.harness, secs)));
    body.appendChild(live);
  }
  if (atBottom) body.scrollTop = body.scrollHeight;
}

/**
 * The silence before the first token is harness-sized — Claude's is ~5s, grok's
 * has been measured at 37s — and a harness with streams:false has no first
 * token at all, only the finished reply. Say which of those you are waiting on;
 * an unexplained spinner reads as a hang.
 */
function waitingLine(harness, secs) {
  if (harnessOf(harness)?.streams === false) {
    return 'Working — this harness returns the whole reply at once, so nothing appears until it is done.';
  }
  return secs < 12 ? 'Working…' : 'Working — still waiting on the first token.';
}

/** Edit blocks are rendered as diffs below, so keep them out of the prose. */
function stripEditBlocks(text) {
  return text
    .replace(/^@@(EDIT|APPEND)[ \t]+.*$[\s\S]*?^@@END[ \t]*$/gm, '')
    .replace(/^@@(EDIT|APPEND)[ \t]+.*$[\s\S]*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderMessage(m) {
  const wrap = el('div', `msg ${m.role}`);
  if (m.note) wrap.appendChild(el('div', 'msg-note', m.note));

  if (m.role === 'user') {
    wrap.appendChild(el('div', 'msg-text', m.text));
    if (m.mentions?.length) {
      const chips = el('div', 'msg-chips');
      for (const p of m.mentions) chips.appendChild(el('span', 'chip-mini', p.split('/').pop()));
      wrap.appendChild(chips);
    }
    return wrap;
  }
  // Threads can mix harnesses, so each reply says who wrote it.
  if (m.harness) wrap.appendChild(el('div', 'msg-meta', harnessLabel(m.harness)));
  if (m.error) { wrap.appendChild(el('div', 'notice error', m.error)); return wrap; }

  const prose = stripEditBlocks(m.text);
  if (prose) {
    const t = el('div', 'msg-text md');
    t.innerHTML = renderMarkdown(prose);
    wrap.appendChild(t);
  }
  for (const p of m.proposals || []) wrap.appendChild(renderProposal(p));
  return wrap;
}

function renderProposal(p) {
  const card = el('div', 'prop');
  const head = el('div', 'prop-head');
  head.appendChild(el('span', 'prop-path', p.display));
  if (!p.error) head.appendChild(el('span', 'item-badge', `${p.edits} edit${p.edits === 1 ? '' : 's'}`));
  card.appendChild(head);

  if (p.error) { card.appendChild(el('div', 'prop-error', p.error)); return card; }
  if (p.state === 'accepted') { card.appendChild(el('div', 'prop-ok', 'Applied and versioned.')); return card; }
  if (p.state === 'rejected') { card.appendChild(el('div', 'prop-error', 'Rejected — nothing written.')); return card; }

  const d = diffView(p.current, p.proposed, 'now', 'proposed');
  d.style.padding = '0';
  card.appendChild(d);

  const foot = el('div', 'prop-foot');
  const accept = el('button', 'btn primary', 'Accept');
  accept.onclick = () => acceptProposal(p);
  const reject = el('button', 'btn ghost', 'Reject');
  reject.onclick = () => { p.state = 'rejected'; renderChatBody(); };
  const open = el('button', 'btn ghost', 'Open file');
  open.onclick = () => {
    const entry = entryForFile(p.path);
    if (entry) { closeDrawer(); openEntry(entry, p.path); }
  };
  foot.append(accept, reject, open);
  card.appendChild(foot);
  return card;
}

async function acceptProposal(p) {
  try {
    const r = await api('PUT', '/api/file', { path: p.path, content: p.proposed, mtime: p.mtime });
    if (!r.saved && r.errors?.length) {
      notice('error', `Not applied — ${p.display} would be invalid:`, r.errors, true);
      return;
    }
    p.state = 'accepted';
    renderChatBody();
    if (S.file?.path === p.path && !S.revoked) {
      S.file.mtime = r.mtime;
      S.original = p.proposed;
      S.draft = p.proposed;
      renderAll();
    }
    S.registry.history.commits++;
    notice('ok', `Applied to ${p.display} · version ${r.sha?.slice(0, 8) ?? ''}`);
  } catch (e) {
    notice('error', e.message, null, true);
  }
}

/* ── compose ─────────────────────────────────────────────────────────── */
function renderCompose() {
  const box = $('drawer-compose');
  const s = ensureSession();
  box.innerHTML = '';

  const chips = el('div', 'mention-row');
  for (const p of s.mentions) {
    const chip = el('span', 'mention-chip');
    chip.appendChild(el('span', null, p.split('/').pop()));
    const x = el('button', 'mention-x', '×');
    x.title = p;
    x.onclick = () => { s.mentions = s.mentions.filter((q) => q !== p); saveSessions(); renderCompose(); };
    chip.appendChild(x);
    chips.appendChild(chip);
  }
  const add = el('button', 'mention-add', s.mentions.length ? '+ file' : '@ attach a file');
  add.onclick = () => { C.draft += (C.draft.endsWith(' ') || !C.draft ? '' : ' ') + '@'; openPicker(''); };
  chips.appendChild(add);
  box.appendChild(chips);

  if (C.picker) box.appendChild(renderPicker());

  const input = el('textarea', 'chat-input');
  input.id = 'chat-input';
  input.placeholder = s.mentions.length
    ? 'What should change in these files?'
    : 'Ask a question, or attach a file with @ to make edits…';
  input.value = C.draft;
  input.rows = 3;
  input.oninput = () => {
    C.draft = input.value;
    const m = input.value.slice(0, input.selectionStart).match(/@([^\s@]*)$/);
    if (m) openPicker(m[1], true); else if (C.picker) { C.picker = null; renderCompose(); }
  };
  input.onkeydown = (ev) => {
    if (C.picker) {
      const list = pickerMatches();
      if (ev.key === 'ArrowDown') { ev.preventDefault(); C.picker.index = Math.min(C.picker.index + 1, list.length - 1); renderCompose(); return; }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); C.picker.index = Math.max(C.picker.index - 1, 0); renderCompose(); return; }
      if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); choosePicker(list[C.picker.index]); return; }
      if (ev.key === 'Escape') { ev.preventDefault(); C.picker = null; renderCompose(); return; }
    }
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendTurn(); }
  };
  box.appendChild(input);

  const row = el('div', 'compose-row');

  // Harness first, then that harness's models. Only detected harnesses are
  // offered — the server refuses the rest anyway.
  const list = harnesses();
  const harness = el('select', 'assist-harness');
  harness.title = 'Which CLI answers. Sticky — it never changes with the file you open.';
  if (!list.length) {
    harness.appendChild(el('option', null, S.registry ? 'No harness detected' : 'Detecting…'));
    harness.disabled = true;
  } else {
    for (const h of list) {
      const o = el('option', null, h.label); o.value = h.id;
      if (h.id === C.harness) o.selected = true;
      harness.appendChild(o);
    }
  }
  harness.onchange = () => {
    C.harness = harness.value;
    C.model = harnessOf(C.harness)?.defaultModel ?? C.model;
    saveSessions();
    // The whole chat re-renders: context, cost and turns all belong to the new
    // harness's slot, not the one you just left.
    renderChat();
  };
  row.appendChild(harness);

  const current = harnessOf(C.harness);
  const model = el('select', 'assist-model');
  // The server owns the list — it is the same object used as the allowlist.
  const choices = current ? modelsOf(current) : [{ id: C.model ?? '', label: C.model ?? 'no model' }];
  // A saved session may name a model that is no longer offered; don't let the
  // dropdown show one thing while the server silently runs another.
  if (!choices.some((c) => c.id === C.model)) C.model = choices[0].id;
  for (const { id, label } of choices) {
    const o = el('option', null, label); o.value = id;
    if (id === C.model) o.selected = true;
    model.appendChild(o);
  }
  model.disabled = !current;
  model.onchange = () => { C.model = model.value; saveSessions(); };
  row.appendChild(model);
  row.appendChild(el('span', 'spacer'));

  if (C.busy) {
    const cancel = el('button', 'btn danger', 'Cancel');
    cancel.onclick = () => C.abort?.abort();
    row.appendChild(cancel);
  } else {
    const send = el('button', 'btn primary', 'Send');
    send.disabled = !C.harness;
    if (!C.harness) send.title = 'No supported CLI was found on this machine.';
    send.onclick = sendTurn;
    row.appendChild(send);
  }
  box.appendChild(row);
}

/* ── @ file picker ───────────────────────────────────────────────────── */
function openPicker(query, keepIndex) {
  C.picker = { query, index: keepIndex && C.picker ? Math.min(C.picker.index, 20) : 0 };
  renderCompose();
  $('chat-input')?.focus();
}

function pickerMatches() {
  const s = active();
  const q = (C.picker?.query || '').toLowerCase();
  const files = allFiles().filter((f) => !s?.mentions.includes(f.path));
  if (!q) return files.slice(0, 12);
  return files
    .map((f) => {
      const i = `${f.entry} ${f.name} ${f.display}`.toLowerCase().indexOf(q);
      return i === -1 ? null : { f, score: i };
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score)
    .slice(0, 12)
    .map((x) => x.f);
}

function renderPicker() {
  const list = pickerMatches();
  const box = el('div', 'picker');
  if (!S.registry) { box.appendChild(el('div', 'picker-empty', 'Loading files…')); return box; }
  if (!list.length) { box.appendChild(el('div', 'picker-empty', 'No file matches that.')); return box; }
  list.forEach((f, i) => {
    const row = el('button', 'picker-row' + (i === C.picker.index ? ' active' : ''));
    row.appendChild(el('span', `item-dot ${f.harness}`));
    row.appendChild(el('span', 'picker-name', f.entry === f.name ? f.name : `${f.entry} · ${f.name}`));
    row.appendChild(el('span', 'picker-path', f.display));
    row.onmousedown = (ev) => { ev.preventDefault(); choosePicker(f); };
    box.appendChild(row);
  });
  return box;
}

function choosePicker(f) {
  if (!f) return;
  const s = ensureSession();
  if (!s.mentions.includes(f.path)) s.mentions.push(f.path);
  C.draft = C.draft.replace(/@([^\s@]*)$/, '').replace(/\s+$/, '');
  C.picker = null;
  saveSessions();
  renderCompose();
  $('chat-input')?.focus();
}

/* ── sending ─────────────────────────────────────────────────────────── */
let tickTimer;

/** Shared streaming reader for both normal turns and compaction. */
async function streamChat({ message, mentions, sessionId, seed, harness, model, onDelta }) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // harness and model are passed in, never read from C: the picker may move
    // while this request is open and the turn must stay what it was at submit.
    body: JSON.stringify({ message, mentions, sessionId, seed, model, harness }),
    signal: C.abort.signal,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', final = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.t === 'delta') { C.stream += ev.text; onDelta?.(); }
      else if (ev.t === 'done') final = ev;
      else if (ev.t === 'error') throw new Error(ev.message);
    }
  }
  return final;
}

async function sendTurn() {
  const text = C.draft.trim();
  if (!text || C.busy) return;
  if (!C.harness) { notice('error', 'No supported CLI was found on this machine.', null, true); return; }
  const s = ensureSession();
  // Bound at submit: everything below writes back through these, so moving the
  // picker mid-turn cannot land a reply or a session id in another harness.
  const run = { harness: C.harness, model: C.model };
  const sl = slotFor(s, run.harness);

  s.messages.push({ role: 'user', text, mentions: [...s.mentions] });
  if (s.title === 'New session') s.title = titleFor(s);
  C.draft = '';
  C.picker = null;
  C.busy = true;
  C.stream = '';
  C.startedAt = Date.now();
  C.running = run;
  C.abort = new AbortController();
  // The running state goes up NOW, not on the first delta: grok has taken 37s
  // to say anything at all, and half a minute of dead UI reads as a crash.
  renderChat();
  clearInterval(tickTimer);
  tickTimer = setInterval(renderChatBody, 1000);

  try {
    const final = await streamChat({
      message: text,
      mentions: s.mentions,
      sessionId: sl.cliSessionId,
      seed: sl.cliSessionId ? null : sl.seed,
      harness: run.harness,
      model: run.model,
      onDelta: renderChatBody,
    });

    // A turn the server calls failed is a failure here too: no reply text, no
    // session id kept. The server refuses to bind an id from a failed turn, so
    // storing one would only guarantee the next turn is rejected.
    // Fail closed: only an explicit ok:true is a success. The server has exactly one
    // `done` sender and it always sets `ok`, so a missing field means a malformed or
    // truncated stream — which must not persist a session id or render as a reply.
    if (final?.ok !== true) throw new Error(final?.error || 'The turn failed.');

    sl.cliSessionId = final?.sessionId ?? sl.cliSessionId;
    if (final?.stats) {
      sl.stats.turns += 1;
      sl.stats.contextTokens = final.stats.contextTokens || sl.stats.contextTokens;
      sl.stats.costUsd = (sl.stats.costUsd || 0) + (final.stats.costUsd || 0);
      // The first turn is almost entirely the harness's own overhead — system
      // prompt, tool definitions, CLAUDE.md, skills index. Recording it lets us
      // report how much of the context is actually *this conversation*.
      if (!sl.stats.baselineTokens) sl.stats.baselineTokens = final.stats.contextTokens || 0;
    }
    s.updatedAt = Date.now();
    s.messages.push({
      role: 'assistant', harness: run.harness,
      // Deltas when there were any; a harness with streams:false sends none and
      // its whole reply arrives in the done event instead.
      text: C.stream || final?.text || '',
      proposals: final?.proposals ?? [],
    });

    if (final?.rateLimit?.status && final.rateLimit.status !== 'allowed') {
      notice('warn', `Usage limit: ${final.rateLimit.status}` +
        (final.rateLimit.resetsAt ? ` — resets ${new Date(final.rateLimit.resetsAt).toLocaleTimeString()}` : ''), null, true);
    }
  } catch (e) {
    // The server binds each session id to the harness that issued it. If it
    // refuses ours the slot is dead — drop it so the next turn starts clean
    // instead of re-offering an id that can only be rejected again.
    if (/session is bound/i.test(e.message)) sl.cliSessionId = null;
    s.messages.push({
      role: 'assistant', harness: run.harness, text: '',
      error: e.name === 'AbortError' ? 'Cancelled.' : e.message,
    });
  } finally {
    clearInterval(tickTimer);
    C.busy = false;
    C.stream = '';
    C.running = null;
    C.abort = null;
    saveSessions();
    renderChat();
  }
}

/* ── wiring ──────────────────────────────────────────────────────────── */
$('btn-save').onclick = save;
$('btn-assist').onclick = openDrawer;
$('drawer-close').onclick = closeDrawer;
$('scrim').onclick = closeDrawer;
$('btn-delete').onclick = deleteOpenEntry;
$('btn-copy').onclick = copyToOtherHarness;
document.documentElement.dataset.theme = store.get('acs.theme') === 'light' ? 'light' : 'dark';

function wireGlobalKeys() {
  window.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === 's') { e.preventDefault(); if (S.view === 'entry') save(); }
    else if (meta && e.key === 'k') { e.preventDefault(); focusSearch(); }
    else if (meta && e.key === 'e' && S.file) {
      e.preventDefault();
      S.tab = S.tab === 'edit' ? 'preview' : 'edit';
      renderContent(); renderTabs();
    } else if (e.key === 'Escape') {
      closeDrawer();
      if ($('app').classList.contains('nav-open')) { setNavOverlay(false); $('nav-menu').focus(); }
      if (document.activeElement === $('search')) $('search').blur();
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });
}

// Following a link or typing a hash switches the view, not only a reload. A
// cancelled discard puts the old hash back, so the URL keeps naming what is shown.
window.addEventListener('hashchange', (e) => {
  S.navs++;
  // Before the registry is in, only remember it: boot routes it once it lands.
  if (!S.registry && !hashIs(location.hash, '#setup')) { S.pendingNav = location.hash; return; }
  if (isDirty() && !hashIs(location.hash, '#assist')) {
    if (!confirmDiscard()) {
      const old = e.oldURL ? new URL(e.oldURL).hash : '';
      window.history.replaceState(null, '', old || location.pathname + location.search);
      return;
    }
    S.draft = S.original;   // discarded: the opener below must not ask again
  }
  routeHash(location.hash);
});

boot().catch((e) => {
  document.body.innerHTML =
    `<div class="empty"><div class="empty-title">Could not start</div><div>${esc(e.message)}</div></div>`;
});
