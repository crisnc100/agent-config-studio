/* Agent Config Studio — the Packs view: recommended skill packs, explained, previewed, installed (lib/packs-routes.js) */

/**
 * Loaded before app.js, which owns the helpers this calls (el, api, notice,
 * renderSidebar…). Three kinds of page: `#packs` is a grid of cards that only
 * open pages, `#packs/<id>` is one pack's page (the review gate's paths that
 * always need you get their own, `#packs/review-gate/paths`), and `#packs/setup`
 * lists the fixes every pack shares. All of them share one state (PK), read once when
 * Packs is entered from another view, so moving between them keeps previews
 * and results where they were.
 *
 * Every write goes through a preview: the page asks the server for the plan
 * of what was asked, lists every path and setting it changes, and the
 * Install / Update / Uninstall button under it sends that same request back
 * with the preview's signature. Any change to the request drops the preview,
 * so the button only ever applies what was shown; the server refuses (409)
 * if the disk moved in between.
 *
 * Status is a job on the server (the Codex trust check is slow): the page
 * starts it, then polls until it is done, showing its latest progress line.
 * Whether it runs the trust check is a preference set on Setup.
 */
const PK = { data: null, error: null, status: null, statusError: null, job: null, statusGen: 0, cards: {}, roles: null, rolesError: null, page: null, sub: null };
const PK_VERB = { install: 'Install', update: 'Update', uninstall: 'Uninstall' };
const PK_DONE = { install: 'Installed', update: 'Updated', uninstall: 'Uninstalled' };
const PK_POLL_MS = 400;
const PK_TRUST_KEY = 'acs.packs.trust';
/** The shared-fixes page: a reserved word in the pack-id slot of the route. */
const PK_SETUP = 'setup';

/** The Codex trust check, as Setup saved it: on unless turned off. */
const pkTrust = () => store.get(PK_TRUST_KEY) !== '0';
const pkSetTrust = (on) => store.set(PK_TRUST_KEY, on ? '1' : '0');

const pkPack = (id) => PK.data?.packs.find((p) => p.id === id) || null;
const pkInstalled = (pack, partId) => !!pack.installed?.parts?.[partId];
const pkHarness = (id) => PK.data?.harnesses.find((h) => h.id === id) || null;
/** A harness a part can install for here: present, or the Claude skills folder on a machine that has only Grok (it reads it). */
const pkUsable = (id) => !!pkHarness(id)?.present || (id === 'claude' && !!pkHarness('grok')?.present);
const pkDefaults = (pack) => pack.parts.filter((p) => p.default && !pkInstalled(pack, p.id)).map((p) => p.id);
const pkShown = () => S.view === 'packs' || S.view === 'pack';

/**
 * A pack's page state. `flow` is the action in progress ({ action, at, extra }, `at` being 'pack' or a part id):
 * its preview, error and busy line render under the button that started it. `parts`, `harnesses` and
 * `withDeps` are what an install asks for; the preview-only offers (`setRoles`, `replace`) start unticked.
 */
function pkCard(pack) {
  PK.cards[pack.id] ||= { parts: new Set(pkDefaults(pack)), harnesses: null, withDeps: false, setRoles: {}, replace: false, flow: null, preview: null, busy: null, result: null, error: null, seq: 0, variant: null };
  return PK.cards[pack.id];
}
/** Anything the request depends on changed: the preview no longer describes it. */
function pkDrop(card) { card.preview = null; card.error = null; card.seq++; }

/** The pack id (or the setup page) a hash names: #packs/<id>. */
function pkRouteOf(hash) {
  const m = /^#packs\/([^&/]+)/.exec(hash || '');
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}
/** The page under a pack a hash names: #packs/<id>/<sub> (only the review gate's paths page is one). */
function pkSubOf(hash) {
  const m = /^#packs\/[^&/]+\/([^&/]+)/.exec(hash || '');
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}
/** For routeHash: a #packs/<id>[/<sub>] link to a page other than the one shown. */
const pkMoved = (hash) => pkRouteOf(hash) !== PK.page || pkSubOf(hash) !== PK.sub;
const pkHash = (page, sub = null) => (page ? `#packs/${encodeURIComponent(page)}${sub ? `/${encodeURIComponent(sub)}` : ''}` : '#packs');

async function pkEnter(view, page, { focus = false, sub = null } = {}) {
  if (!confirmDiscard()) return;
  const from = PK.page, fromSub = PK.sub;
  // Within Packs the catalog, roles and status already read stay: only a visit from elsewhere reads them again.
  const fresh = !pkShown();
  S.view = view;
  PK.page = page;
  PK.sub = sub;
  leaveEditor();
  window.history.replaceState(null, '', pkHash(page, sub));
  renderSidebar(); renderTopbar(); renderTabs(); renderStatus();
  $('filebar').hidden = true;
  $('content').scrollTop = 0;
  if (!fresh && PK.data) { paintPacks(); if (focus) pkFocusPage(from, fromSub); return; }
  $('content').innerHTML = '<div class="scope pk"><div class="scope-sub"><span class="spinner"></span> Reading the packs…</div></div>';
  // The roles every diagram names, read fresh each time Packs opens: a role changed on Models shows here.
  const roles = pkLoadRoles();
  await pkLoad();
  await roles;
  if (focus) pkFocusPage(from, fromSub);
  if (pkShown() && PK.data) pkCheckStatus();
}

function openPacks() { return pkEnter('packs', null); }
/** #packs/<id>[/<sub>]: the page the hash names, or the page last shown (coming back from a file opened here). */
function openPackPage() {
  const id = pkRouteOf(location.hash);
  return id != null ? pkEnter('pack', id, { sub: pkSubOf(location.hash) }) : pkEnter('pack', PK.page, { sub: PK.sub });
}

/** Navigate inside Packs. The hash change this makes finds the page already shown and does nothing. */
function pkGo(page, sub = null) {
  location.hash = pkHash(page, sub);
  return page ? pkEnter('pack', page, { focus: true, sub }) : pkEnter('packs', null, { focus: true });
}

/**
 * After a navigation inside Packs the old focus is gone with the old page: on a pack's page it goes to the
 * back button (or to Edit paths, back from the paths page), and back on the grid to the card of the pack just left.
 */
function pkFocusPage(from, fromSub) {
  if (!pkShown()) return;
  const c = $('content');
  const target = S.view !== 'pack' ? c.querySelector(`.pk-card[data-pack="${from}"] .pk-card-link`)
    : (fromSub === PK_PATHS && from === PK.page && !PK.sub && c.querySelector('.pk-edit-paths')) || c.querySelector('.pk-back');
  target?.focus?.();
}

async function pkLoadRoles() {
  try { PK.roles = (await api('GET', '/api/models/roles')).roles || []; PK.rolesError = null; }
  catch (e) { PK.roles = null; PK.rolesError = e.message; }
  if (pkShown() && PK.data) paintPacks();
}

async function pkLoad() {
  try { PK.data = await api('GET', '/api/packs'); PK.error = null; }
  catch (e) { PK.error = e.message; }
  for (const pack of PK.data?.packs || []) pkCard(pack);
  paintPacks();
}

/** Start (or join) a status check, then poll it until it is done. */
async function pkCheckStatus() {
  const gen = ++PK.statusGen;
  PK.statusError = null;
  PK.job = { running: true, progress: [], elapsedMs: 0 };
  pkPaintStatus();
  let job;
  try {
    job = (await api('GET', `/api/packs/status?trust=${pkTrust() ? 1 : 0}`)).job;
    while (job.running) {
      if (gen !== PK.statusGen || !pkShown()) return;
      PK.job = job;
      pkPaintStatus();
      await new Promise((r) => setTimeout(r, PK_POLL_MS));
      job = (await api('GET', `/api/packs/status?job=${encodeURIComponent(job.id)}`)).job;
    }
  } catch (e) {
    if (gen !== PK.statusGen) return;
    PK.job = null;
    PK.statusError = e.message;
    return paintPacks();
  }
  if (gen !== PK.statusGen) return;
  PK.job = null;
  if (job.error) PK.statusError = job.error;
  else PK.status = job.result;
  if (pkShown()) paintPacks();
}

/** Which page to draw: the grid, the shared fixes, a pack, or "No pack called …". */
function paintPacks() {
  if (!pkShown()) return;
  const c = $('content');
  const top = c.scrollTop;
  c.innerHTML = '';
  const box = el('div', 'scope pk');
  if (PK.error) {
    box.appendChild(pageHeading('Skill packs'));
    const n = el('div', 'notice error pk-error');
    n.setAttribute('role', 'alert');
    n.appendChild(el('div', null, `The packs could not be read: ${PK.error}`));
    n.appendChild(pkBtn('', 'Try again', () => pkLoad()));
    box.appendChild(n);
  } else if (PK.data) {
    if (S.view === 'packs') pkGrid(box);
    else if (PK.sub) {
      if (PK.page === 'review-gate' && PK.sub === PK_PATHS && pkPack(PK.page)) pkPathsPage(box, pkPack(PK.page));
      else pkMissing(box);
    } else if (PK.page === PK_SETUP) pkSetupPage(box);
    else if (pkPack(PK.page)) pkPage(box, pkPack(PK.page));
    else pkMissing(box);
  }
  c.appendChild(box);
  c.scrollTop = top;
  pkPaintStatus();
}

const pkBtn = (cls, text, fn, disabled = false) => { const b = el('button', `btn${cls ? ` ${cls}` : ''}`, text); b.type = 'button'; b.onclick = fn; b.disabled = disabled; return b; };
function pkCheck(label, checked, onchange, { disabled = false, title = null } = {}) {
  const l = el('label', `pk-check${disabled ? ' disabled' : ''}`);
  const i = el('input');
  i.type = 'checkbox';
  i.checked = !!checked;
  i.disabled = disabled;
  i.onchange = () => onchange(i.checked);
  l.appendChild(i);
  l.appendChild(el('span', null, label));
  if (title) l.title = title;
  return l;
}
/** Children with a space between them, so the text reads (and copies) as words, not run together. */
function pkJoin(parent, ...kids) {
  kids.forEach((k, i) => { if (i) parent.appendChild(document.createTextNode(' ')); parent.appendChild(k); });
  return parent;
}
const PK_ICONS = {
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  go: '<path d="M6 3.5L10.5 8 6 12.5"/>',
  back: '<path d="M10 3.5L5.5 8 10 12.5"/>',
  copy: '<rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5"/><path d="M3 10.5V4.5A1.5 1.5 0 0 1 4.5 3h6"/>',
};
function pkIcon(name, cls = 'pk-icon') {
  const s = el('span', cls);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${PK_ICONS[name]}</svg>`;
  return s;
}
/** A status word with its dot: tone ok (green), warn (amber), err (red) or off (hollow). */
function pkStatusWord(word, tone, title = null) {
  const s = el('span', `pk-st ${tone}`);
  s.appendChild(el('span', 'pk-dot'));
  s.appendChild(el('span', null, word));
  if (title) s.title = title;
  return s;
}
/** Back to the grid, or from a page under a pack back to that pack. */
function pkBackButton(pack = null) {
  const b = pkBtn('ghost pk-back', '', () => pkGo(pack?.id ?? null));
  b.appendChild(pkIcon('back'));
  b.appendChild(el('span', null, pack ? pack.title : 'Skill packs'));
  return b;
}
/** A command with a quiet Copy beside it. */
function pkCommand(text, cls) {
  const row = el('div', cls);
  row.appendChild(el('code', null, text));
  const copy = pkBtn('ghost', '', async () => {
    try { await navigator.clipboard.writeText(text); label.textContent = 'Copied'; }
    catch { label.textContent = 'Select and copy it'; }
    setTimeout(() => { label.textContent = 'Copy'; }, 2000);
  });
  copy.appendChild(pkIcon('copy'));
  const label = el('span', null, 'Copy');
  copy.appendChild(label);
  copy.setAttribute('aria-label', `Copy: ${text}`);
  row.appendChild(copy);
  return row;
}

/**
 * A pack's missing needs as fixes: model-id, ask-model and CLIs off the PATH are one fix (group 'path');
 * every other need is its own. Most important first: the fix that unblocks the most.
 */
const PK_ORDER = ['node', 'cli', 'git', 'path', 'roles'];
const PK_NEED_SHORT = { node: 'a newer Node.js', git: 'git', roles: 'valid ACS roles', cli: 'an agent CLI' };
function pkFixes(pack) {
  const out = new Map();
  for (const r of pack.requirements.filter((x) => !x.ok)) {
    const key = r.dep ? `pack:${r.dep}` : r.group || r.id;
    if (!out.has(key)) out.set(key, { key, reqs: [] });
    out.get(key).reqs.push(r);
  }
  const rank = (k) => (k.startsWith('pack:') ? PK_ORDER.length : PK_ORDER.indexOf(k) === -1 ? PK_ORDER.length - 0.5 : PK_ORDER.indexOf(k));
  return [...out.values()].sort((a, b) => rank(a.key) - rank(b.key));
}
const pkNames = (fix) => fix.reqs.flatMap((r) => String(r.name || r.id).split(' and '));
/** A fix as one short phrase: "Needs …". */
function pkNeedText(fix) {
  const r = fix.reqs[0];
  if (r.dep) return `the ${pkPack(r.dep)?.title || r.dep} pack first`;
  // Off the search path, not missing: the CLIs it names are installed. Said once on the setup page (pkShared), so rarely here.
  if (fix.key === 'path') return `commands on your search path: ${pkNames(fix).join(', ')}`;
  return PK_NEED_SHORT[r.id] || r.what;
}
/** A fix as the setup page lists it: what to do, then how. */
function pkFixItem(fix) {
  if (fix.key !== 'path') return { what: fix.reqs[0].what, fix: fix.reqs[0].fix };
  const tools = fix.reqs.some((r) => ['model-id', 'ask-model'].includes(r.id));
  const clis = fix.reqs.some((r) => r.id === 'cli');
  return {
    what: `Some commands aren’t on your shell’s search path, so agents can’t run them: ${pkNames(fix).join(', ')}`,
    fix: [tools ? 'run acs install-model-id' : null,
      `add ${tools ? '~/.local/bin' : ''}${tools && clis ? ' and ' : ''}${clis ? "each CLI's folder" : ''} to your shell’s PATH`,
      'then restart the studio'].filter(Boolean).join(', '),
  };
}
/** Fixes every pack needs: listed once on the setup page, never repeated on a pack. */
function pkShared() {
  const packs = PK.data.packs;
  if (!packs.length) return new Map();
  const [first, ...rest] = packs.map(pkFixes);
  // A merged PATH fix differs per pack (some lack only model-id): share it if every pack has one, listing every name.
  const shared = new Map();
  for (const f of first) {
    if (f.key.startsWith('pack:') || f.key === 'path' || !rest.every((fs) => fs.some((g) => g.key === f.key))) continue;
    const reqs = new Map();
    for (const fs of [first, ...rest]) for (const r of fs.find((g) => g.key === f.key).reqs) reqs.set(r.name || r.id, r);
    shared.set(f.key, { key: f.key, reqs: [...reqs.values()] });
  }
  // The search-path fix is one machine fix, whichever packs it blocks: said once, with every name.
  const pathReqs = new Map();
  let blocked = 0;
  for (const fs of [first, ...rest]) {
    const f = fs.find((g) => g.key === 'path');
    if (f) blocked++;
    for (const r of f?.reqs || []) pathReqs.set(r.name || r.id, r);
  }
  if (pathReqs.size) shared.set('path', { key: 'path', reqs: [...pathReqs.values()], blocked, of: packs.length });
  return shared;
}
/** A pack's own fixes: what it needs beyond the shared ones. */
const pkOwnFixes = (pack, shared = pkShared()) => pkFixes(pack).filter((f) => !shared.has(f.key));

/** The shared fixes as a list: what to do, how, and how many packs it blocks when not all. */
function pkTodo() {
  const shared = pkShared();
  if (!shared.size) return null;
  const box = el('div', 'pk-todo');
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', 'What packs need');
  const ol = el('ol', 'pk-todo-list');
  for (const f of shared.values()) {
    const item = pkFixItem(f);
    const li = el('li', null, item.what);
    li.appendChild(el('div', 'pk-fix', `Fix: ${item.fix}`));
    if (f.blocked && f.blocked < f.of) li.appendChild(el('div', 'pk-fix', `Needed by ${f.blocked} of ${f.of} packs.`));
    ol.appendChild(li);
  }
  box.appendChild(ol);
  return box;
}

const pkStatusOf = (pack, partId) => PK.status?.packs.find((p) => p.id === pack.id)?.parts.find((x) => x.id === partId) || null;
/** A status word's kind (installed, edited, update, broken, newHarness, absent). */
const pkKind = (s) => Object.keys(PK.data?.words?.status || {}).find((k) => PK.data.words.status[k] === s) || 'other';
/** The status check's words for a part, or installed / not installed before it has run. */
function pkPartStatuses(pack, partId) {
  const st = pkStatusOf(pack, partId);
  const w = PK.data.words.status;
  return st?.statuses || [pkInstalled(pack, partId) ? w.installed : w.absent];
}
/** A part's one word, the most pressing of its statuses first. */
const PK_PART_WORD = [['broken', 'Not working', 'err'], ['update', 'Update ready', 'warn'], ['edited', 'Edited', 'warn'], ['newHarness', 'New CLI here', 'warn'], ['installed', 'On', 'ok'], ['absent', 'Off', 'off']];
function pkPartWord(pack, partId) {
  const kinds = pkPartStatuses(pack, partId).map(pkKind);
  const hit = PK_PART_WORD.find(([k]) => kinds.includes(k)) || (pkInstalled(pack, partId) ? PK_PART_WORD[4] : PK_PART_WORD[5]);
  return { kind: hit[0], word: hit[1], tone: hit[2] };
}
/** Installed, with a newer version or a part the status check says has an update. */
function pkUpdateReady(pack) {
  if (!pack.installed) return false;
  return pack.installed.version !== pack.version || Object.keys(pack.installed.parts || {}).some((id) => pkPartStatuses(pack, id).map(pkKind).includes('update'));
}
/** The parts broken in a way the status check says an update puts right (a missing file, not an unset role). */
const pkUpdateFixes = (pack) => Object.keys(pack.installed?.parts || {}).filter((id) => pkPartStatuses(pack, id).map(pkKind).includes('broken')
  && (pkStatusOf(pack, id)?.details || []).some((d) => /acs packs update/.test(d)));
/** Update does something: an update is ready, or it puts a broken part right. */
const pkUpdateUseful = (pack) => pkUpdateReady(pack) || pkUpdateFixes(pack).length > 0;
/** The CLIs a part could be installed for here but is not. */
const pkFreshClis = (pack, partId) => (pkPack(pack.id) || pack).parts.find((p) => p.id === partId)?.harnesses.filter(pkUsable)
  .filter((h) => !(pkStatusOf(pack, partId)?.harnesses || []).includes(h)) || [];
/**
 * The one action a pack needs, for its card and its page alike, or null. An edit alone needs none: Update would
 * keep the edit and change nothing, so the edited part's row offers Restore… instead.
 */
function pkPackAction(pack) {
  if (!pack.installed) return { action: 'install', label: 'Install', extra: {} };
  // A missing file comes back only with replace (the planner keeps a removed file otherwise), so that update starts ticked.
  if (pkUpdateUseful(pack)) return { action: 'update', label: 'Update', extra: pkUpdateFixes(pack).length ? { replace: true } : {} };
  const parts = Object.keys(pack.installed.parts || {}).filter((id) => pkPartStatuses(pack, id).map(pkKind).includes('newHarness'));
  const clis = [...new Set(parts.flatMap((id) => pkFreshClis(pack, id)))];
  if (!parts.length || !clis.length) return null;
  return { action: 'install', label: `Install for ${pkCliNames(clis)}`, extra: { parts, harnesses: clis } };
}
/** A card's status: Update ready, Needs setup, Installed or Not installed. */
function pkState(pack, shared = pkShared()) {
  if (pkUpdateReady(pack)) return { key: 'update', word: 'Update ready', tone: 'warn' };
  if (pkOwnFixes(pack, shared).length) return { key: 'setup', word: 'Needs setup', tone: 'warn' };
  if (pack.installed) return { key: 'installed', word: 'Installed', tone: 'ok' };
  return { key: 'absent', word: 'Not installed', tone: 'off' };
}

/** Each card's one line: shorter than pack.json's summary, which leads the pack's own page. */
const PK_LINES = {
  'review-gate': 'Reviews your branch for bugs, fixes them once, and logs the result.',
  build: 'Plans a change with you, has a builder write it, then grades it.',
  advisor: 'Gets an outside verdict on scope and direction before you commit.',
  'second-opinion': 'Asks other models for their take and shows the replies side by side.',
  pr: 'Writes a pull request anyone can read in a minute.',
  handoff: 'Leaves a resume-here note so the next session picks up cleanly.',
  flag: 'Files a short report when the agent workflow itself goes wrong.',
  worktree: 'Shell commands that give each goal its own tidy worktree.',
};
const PK_WHO = [['role', 'a model from your roles'], ['agent', 'your session agent'], ['you', 'you'], ['script', 'a script']];
/** Who does a single-step pack, said on its card. */
const PK_SOLO = { agent: 'Your session agent', you: 'You run them', script: 'A script', role: 'A model from your roles' };
const pkWhos = (wf) => (wf?.strip ? [wf.stripWho || 'agent'] : (wf?.steps || []).map((s) => s.who));

function pkGrid(box) {
  const head = el('header', 'pk-head-row');
  const left = el('div', 'pk-head-text');
  left.appendChild(el('h1', 'pk-title', 'Skill packs'));
  left.appendChild(el('p', 'pk-lead', 'Ready-made workflows for your agents. Open one to see how it runs and change how it behaves.'));
  head.appendChild(left);
  const machine = el('div', 'pk-machine');
  machine.appendChild(pkClis());
  const status = el('div', 'pk-status');
  status.id = 'pk-status';
  machine.appendChild(status);
  head.appendChild(machine);
  box.appendChild(head);
  const shared = pkShared();
  if (shared.size) {
    const n = el('div', 'pk-shared');
    n.setAttribute('role', 'status');
    n.appendChild(el('strong', null, `${plural(shared.size, 'thing')} to set up before packs run`));
    n.appendChild(pkBtn('', 'Show me', () => pkGo(PK_SETUP)));
    box.appendChild(n);
  }
  const legend = el('ul', 'pk-legend');
  legend.setAttribute('aria-label', 'Step colours');
  for (const [who, text] of PK_WHO) {
    const li = el('li');
    li.appendChild(el('i', `pk-strip-seg ${who}`));
    li.appendChild(document.createTextNode(text));
    legend.appendChild(li);
  }
  box.appendChild(legend);
  const grid = el('div', 'pk-grid');
  for (const pack of PK.data.packs) grid.appendChild(pkCardView(pack, shared));
  box.appendChild(grid);
}

/** Each CLI as Home and Setup see it: installed or not; why not, on hover (a PATH gap shows where it blocks). */
function pkClis() {
  const row = el('div', 'pk-clis');
  row.setAttribute('aria-label', 'CLIs on this machine');
  for (const h of PK.data.harnesses) {
    const on = h.installed ?? h.present;
    const chip = el('span', `pk-cli ${on ? 'on' : 'off'}`);
    chip.appendChild(on ? pkIcon('check') : el('span', 'pk-dot'));
    chip.appendChild(el('span', null, h.label));
    const note = h.note || (!h.present && !h.installed ? h.why : null);
    chip.title = note ? `${h.label}: ${note}` : `${h.label}: installed`;
    if (!on) chip.appendChild(el('span', 'vh', ` (${note || 'not installed'})`));
    row.appendChild(chip);
  }
  return row;
}

function pkCardView(pack, shared) {
  const k = el('article', 'pk-card');
  k.dataset.pack = pack.id;
  const top = el('div', 'pk-card-top');
  const name = el('div');
  const h = el('h2', 'pk-card-name');
  const a = el('a', 'pk-card-link', pack.title);
  a.href = pkHash(pack.id);
  h.appendChild(a);
  name.appendChild(h);
  if (pack.workflow?.command) name.appendChild(el('span', 'pk-card-cmd', pack.workflow.command));
  top.appendChild(name);
  const st = pkState(pack, shared);
  top.appendChild(pkStatusWord(st.word, st.tone));
  k.appendChild(top);
  k.appendChild(el('p', 'pk-card-line', PK_LINES[pack.id] || pack.summary));
  const foot = el('div', 'pk-card-foot');
  const steps = el('div', 'pk-card-steps');
  const whos = pkWhos(pack.workflow);
  const strip = el('span', 'pk-strip-segs');
  strip.setAttribute('aria-hidden', 'true');
  for (const w of whos) strip.appendChild(el('i', `pk-strip-seg ${w}`));
  steps.appendChild(strip);
  steps.appendChild(el('span', null, pack.workflow?.strip ? PK_SOLO[whos[0]] : plural(whos.length, 'step')));
  foot.appendChild(steps);
  // One primary button, only where something needs doing; it opens the page with the preview loaded.
  const pa = pkPackAction(pack);
  if (pa) {
    foot.appendChild(pkBtn('primary', pa.label, (e) => {
      e.stopPropagation();
      pkGo(pack.id);
      pkPreview(pack, pa.action, pa.extra, { at: 'pack' });
    }));
  } else foot.appendChild(pkIcon('go', 'pk-card-go'));
  k.appendChild(foot);
  // The whole card opens the page; a modified click is left to the link (a new tab).
  k.onclick = (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    pkGo(pack.id);
  };
  return k;
}

function pkSetupPage(box) {
  const page = el('div', 'pk-page');
  page.appendChild(pkBackButton());
  page.appendChild(el('h1', null, 'Before packs run'));
  const todo = pkTodo();
  if (!todo) { page.appendChild(el('p', 'pk-page-lead', 'Nothing to set up: every pack has what this machine needs.')); box.appendChild(page); return; }
  page.appendChild(el('p', 'pk-page-lead', 'These are fixes for this machine, so every pack waits on them. Do them once.'));
  page.appendChild(todo);
  box.appendChild(page);
}

function pkMissing(box) {
  const page = el('div', 'pk-page');
  page.appendChild(pkBackButton());
  page.appendChild(el('h1', null, 'Skill packs'));
  page.appendChild(el('p', 'pk-page-lead', PK.sub ? `No page called ${PK.page}/${PK.sub}.` : `No pack called ${PK.page}.`));
  box.appendChild(page);
}

/** "What it does": two to four words and one sentence each, from explain.does. A pack with less to say has fewer. */
const PK_DOES = {
  'review-gate': [
    ['Finds bugs', 'A model from your reviewer role reads the branch. Every finding must quote real code.'],
    ['Fixes them once', 'High and medium findings get one fix round and one check. The rest are logged.'],
    ['Guards the push', 'With the push gate on, code nobody has reviewed is not pushed.'],
  ],
  build: [
    ['Plans with you', 'It writes a plan in a builds/ folder and asks you to approve what done means.'],
    ['A builder writes it', 'A model from your builder role works phase by phase against your tests.'],
    ['Another model grades it', 'The Grade checks the result against your criteria, then you judge it.'],
  ],
  advisor: [
    ['An outside verdict', 'A model from your advisor role reads the brief and says what it thinks of the plan.'],
    ['Reads, never writes', 'It may read files and run commands to check a point, but it changes nothing.'],
    ['Checked against the code', 'Your agent checks each point and says where it agrees or not.'],
  ],
  'second-opinion': [
    ['Asks other models', 'Each model answers read-only and blind to the others.'],
    ['Side by side', 'Every reply is labeled, with a short note on where they agree and differ.'],
    ['Never picks a winner', 'The choice stays yours.'],
  ],
  pr: [
    ['In your style', 'Sections, order and tone come from your style file.'],
    ['Checked first', 'A helper checks the description against the facts before the PR opens.'],
    ['Opens the PR', 'It runs gh pr create, or gh pr edit when the PR already exists.'],
  ],
  handoff: [
    ['A resume-here note', 'The goal, where things stand, what failed and the next step, in one file.'],
    ['Kept out of git', 'The note stays out of your commits, so it never rides a PR.'],
  ],
  flag: [
    ['Short reports', 'It files a report when a rule, skill or tool goes wrong, without stopping the work.'],
    ['Redacted first', 'Keys, tokens and passwords are stripped before anything is stored.'],
    ['Proposes fixes', '/flag review groups reports by cause and suggests rule changes. It never edits one.'],
  ],
  worktree: [
    ['A worktree per goal', 'wnew makes one in the right place from a fresh base, with its env files and a free port.'],
    ['Finds strays', 'wls lists a project’s worktrees and flags any outside the expected place.'],
  ],
};
/** The first sentence of a text. */
const pkPlain = (text) => (/^[\s\S]*?[.!?](?=\s|$)/.exec(String(text || '').trim())?.[0] || String(text || '').trim());
const pkCliNames = (ids) => ids.map((h) => pkHarness(h)?.label || h).join(' and ');

function pkPage(box, pack) {
  const card = pkCard(pack);
  const page = el('div', 'pk-page');
  page.dataset.pack = pack.id;
  page.appendChild(pkBackButton());
  const sections = [['does', 'What it does', pkDoesView], ['runs', 'How it runs', pkRunsView],
    ...(pack.id === 'review-gate' ? [['settings', 'Settings', pkSettingsSection]] : []),
    ['parts', 'Parts', pkPartsView], ['files', 'Files and undo', pkFilesView]];
  page.appendChild(pkPageHead(pack, card, sections));
  for (const n of pkFlowAt(pack, card, 'pack')) page.appendChild(n);
  for (const [key, title, draw] of sections) {
    const sec = el('section', 'pk-sec-block');
    sec.id = `pk-sec-${key}`;
    sec.appendChild(el('h2', null, title));
    draw(sec, pack, card);
    page.appendChild(sec);
  }
  box.appendChild(page);
}

function pkPageHead(pack, card, sections) {
  const head = el('header', 'pk-page-head');
  const left = el('div', 'pk-page-text');
  const title = el('div', 'pk-page-title');
  title.appendChild(el('h1', null, pack.title));
  if (pack.workflow?.command) title.appendChild(el('span', 'pk-pill', pack.workflow.command));
  left.appendChild(title);
  left.appendChild(el('p', 'pk-page-lead', pack.summary));
  const meta = el('div', 'pk-page-meta');
  const inst = pack.installed;
  const st = pkState(pack);
  meta.appendChild(inst
    ? pkStatusWord(st.key === 'update' && inst.version !== pack.version ? `Update ready · ${inst.version} → ${pack.version}` : `${st.key === 'update' ? 'Update ready' : 'Installed'} · ${inst.version}`, st.key === 'update' ? 'warn' : 'ok')
    : pkStatusWord('Not installed', 'off'));
  // Ready, its own most important missing fix, or — when only shared fixes are left — the way to them.
  const shared = pkShared();
  const fixes = pkFixes(pack);
  const own = pkOwnFixes(pack, shared);
  if (!fixes.length && !inst) meta.appendChild(el('span', 'pk-st pk-ready', 'Ready to install'));
  else if (!fixes.length) {
    const ready = el('span', 'pk-st ok pk-ready');
    ready.appendChild(pkIcon('check'));
    ready.appendChild(el('span', null, 'Ready to run'));
    meta.appendChild(ready);
  } else if (own.length) meta.appendChild(pkStatusWord(`Needs ${pkNeedText(own[0])}`, 'warn pk-need'));
  else {
    meta.appendChild(pkStatusWord('Not ready', 'warn pk-not-ready'));
    meta.appendChild(pkBtn('ghost', 'See what to set up', () => pkGo(PK_SETUP)));
  }
  left.appendChild(meta);
  if (own.length > 1 || (own.length === 1 && own[0].reqs.length > 1)) {
    const ul = el('ul', 'pk-reqs');
    for (const f of own) { const it = pkFixItem(f); const li = el('li', 'missing', it.what); li.appendChild(el('span', 'pk-fix', ` — fix: ${it.fix}`)); ul.appendChild(li); }
    left.appendChild(ul);
  } else if (own.length === 1) left.appendChild(el('p', 'pk-fix-line', `Fix: ${pkFixItem(own[0]).fix}`));
  const jump = el('nav', 'pk-jump');
  jump.setAttribute('aria-label', 'On this page');
  for (const [key, label] of sections) {
    const a = el('a', null, label);
    a.href = pkHash(pack.id);
    a.onclick = (e) => {
      e.preventDefault();
      const target = $('content').querySelector(`#pk-sec-${key}`);
      target?.scrollIntoView({ block: 'start' });
    };
    jump.appendChild(a);
  }
  left.appendChild(jump);
  head.appendChild(left);
  const acts = el('div', 'pk-page-actions');
  const busy = !!card.busy;
  const pa = pkPackAction(pack);
  if (pa) acts.appendChild(pkBtn('primary', pa.label, () => pkPreview(pack, pa.action, pa.extra, { at: 'pack' }), busy || (!inst && !pkDefaults(pack).length)));
  if (inst) acts.appendChild(pkBtn('danger', 'Uninstall…', () => pkPreview(pack, 'uninstall', {}, { at: 'pack' }), busy));
  head.appendChild(acts);
  return head;
}

function pkDoesView(sec, pack) {
  const tiles = PK_DOES[pack.id] || [['Day to day', pkPlain(pack.explain?.does)]];
  const ul = el('ul', 'pk-does');
  for (const [title, line] of tiles) {
    const li = el('li');
    li.appendChild(el('strong', null, title));
    li.appendChild(el('span', null, line));
    ul.appendChild(li);
  }
  sec.appendChild(ul);
}

/** "Say /x. These steps run in order.", with the command in code. */
function pkRunsLead(wf) {
  const p = el('p', 'pk-sec-lead');
  const cmd = el('code', null, wf.command);
  if (wf.strip && wf.stripWho === 'you') { p.append('Run ', cmd, ' in your terminal.'); return p; }
  p.append(wf.command === '/pr-review' ? 'When a branch is ready, say ' : 'Say ', cmd, wf.strip ? '.' : '. These steps run in order.');
  return p;
}

function pkRunsView(sec, pack, card) {
  const wf = pack.workflow;
  if (!wf) { sec.appendChild(el('p', 'pk-sec-lead', pkPlain(pack.explain?.does))); return; }
  sec.appendChild(pkRunsLead(wf));
  // A step whose part is on its way in (the install preview open for it) shows as on.
  const picked = card.flow?.action === 'install' ? card.parts : new Set();
  sec.appendChild(wfDiagram(wf, {
    roles: PK.roles, rolesError: PK.rolesError, settings: PK.data.settings || {},
    installedParts: new Set(Object.keys(pack.installed?.parts || {})), pickedParts: picked,
    variant: card.variant, onVariant: (v) => { card.variant = v; paintPacks(); },
  }));
  const unset = pkUnsetLine(wf);
  if (unset) sec.appendChild(unset);
  if (wf.note) sec.appendChild(el('p', 'pk-flow-note', wf.note));
  if (pack.id === 'build') {
    const cross = PK_CROSS_MODES.find(([m]) => m === (PK.data.settings?.crossFamily || 'prefer'))[1];
    sec.appendChild(el('p', 'pk-cross-note', `The Grade's vendor swap follows Cross-vendor checks in the review gate's settings (now: ${cross}).`));
  }
  if (wfRoles(wf).length) sec.appendChild(el('p', 'pk-rail-note', 'Models come from your roles on the Models page.'));
}

/**
 * One line for the roles a workflow names that are not chosen yet: "2 roles not set — choose them
 * on Models", linked to the first one's row (#models&role=…, which opens its editor there).
 */
function pkUnsetLine(wf) {
  if (!PK.roles) return null;
  const unset = wfRoles(wf).filter((name) => { const r = PK.roles.find((x) => x.name === name); return !r || r.unset; });
  if (!unset.length) return null;
  const line = el('p', 'pk-unset');
  const a = el('a', null, `${unset.length === 1 ? '1 role' : `${unset.length} roles`} not set — choose ${unset.length === 1 ? 'it' : 'them'} on Models`);
  a.href = `#models&role=${encodeURIComponent(unset[0])}`;
  a.title = `Unset: ${unset.join(', ')}`;
  line.appendChild(a);
  return line;
}

function pkSettingsSection(sec, pack) {
  sec.appendChild(el('p', 'pk-sec-lead', 'Nothing is saved until you preview the change.'));
  sec.appendChild(pkSettingsView(pack));
}

function pkPartsView(sec, pack, card) {
  const lead = el('div', 'pk-parts-lead');
  lead.appendChild(el('p', 'pk-sec-lead', 'Turn parts on or off. Each change is previewed first.'));
  const status = el('div', 'pk-status');
  status.id = 'pk-status';
  lead.appendChild(status);
  sec.appendChild(lead);
  const ul = el('ul', 'pk-parts');
  const installed = Object.keys(pack.installed?.parts || {});
  for (const part of pack.parts) {
    const li = el('li', 'pk-part');
    li.dataset.part = part.id;
    const text = el('div', 'pk-part-text');
    text.appendChild(el('div', 'pk-part-name', part.title));
    text.appendChild(el('div', 'pk-part-what', pkPlain(part.explain?.what)));
    li.appendChild(text);
    const w = pkPartWord(pack, part.id);
    li.appendChild(pkStatusWord(w.word, w.tone, pkPartStatuses(pack, part.id).join(', ')));
    const act = el('span', 'pk-part-act');
    const busy = !!card.busy;
    if (!pkInstalled(pack, part.id) || w.kind === 'newHarness') {
      act.appendChild(pkBtn('', 'Add…', () => pkPreview(pack, 'install', { parts: [part.id] }, { at: part.id }), busy));
    } else {
      // Update is pack-wide: Restore… previews it with the pack's copy taken, so its preview lists every edited file it replaces.
      // Only a skill's files: the planner leaves an edited instruction block or worktree file alone even with replace.
      if (part.kind === 'skill' && pkPartStatuses(pack, part.id).map(pkKind).includes('edited')) act.appendChild(pkBtn('', 'Restore…', () => pkPreview(pack, 'update', { replace: true }, { at: part.id, verb: 'Restore' }), busy));
      // The last part out is the pack's uninstall.
      const only = installed.length === 1;
      act.appendChild(pkBtn('ghost', 'Remove…', () => pkPreview(pack, 'uninstall', only ? {} : { parts: [part.id] }, { at: part.id, verb: 'Remove' }), busy));
    }
    li.appendChild(act);
    const flow = pkFlowAt(pack, card, part.id);
    if (flow.length) {
      const slot = el('div', 'pk-part-flow');
      for (const n of flow) slot.appendChild(n);
      li.appendChild(slot);
    }
    ul.appendChild(li);
  }
  sec.appendChild(ul);
}

/**
 * A change as its path and a plain line: "~/x/ (the skill, …)", "~/x (or $Y): the toolkit" or "~/x, only for …". Text that
 * does not start with a path stays one line.
 */
const PK_PATH = '(?:~|\\$)\\S*(?:(?:,| and) (?:~|\\$)?\\S+)*?';
function pkChange(text) {
  const m = new RegExp(`^(${PK_PATH}(?: \\([^)]*\\))?):\\s+(.+)$`).exec(text) || new RegExp(`^(${PK_PATH})\\s+\\((.+)\\)$`).exec(text)
    || new RegExp(`^(${PK_PATH}),\\s+(.+)$`).exec(text);
  if (!m) return { path: null, line: text };
  return { path: m[1], line: m[2][0].toUpperCase() + m[2].slice(1) };
}

function pkFilesView(sec, pack) {
  const wrap = el('div', 'pk-files');
  const what = el('div', 'pk-box');
  what.appendChild(el('h3', null, 'What it changes'));
  const ul = el('ul', 'pk-paths');
  for (const ch of pack.explain?.changes || []) {
    const { path, line } = pkChange(ch);
    const li = el('li');
    if (path) { li.appendChild(el('code', null, path)); li.appendChild(el('div', null, line)); }
    else li.appendChild(el('div', null, line));
    ul.appendChild(li);
  }
  what.appendChild(ul);
  // Per part: the CLIs it is installed for, then what the status check found (each home's state, anything it noticed).
  const lines = pack.parts.flatMap((part) => {
    const st = pkStatusOf(pack, part.id);
    const hs = st?.harnesses?.length ? st.harnesses : pack.installed?.parts?.[part.id]?.harnesses || [];
    return [...(pkInstalled(pack, part.id) && hs.length ? [`${part.title}: installed for ${pkCliNames(hs)}`] : []),
      ...Object.entries(st?.harness || {}).map(([h, s]) => `${part.title}: ${h}: ${s}`), ...(st?.details || []).map((d) => `${part.title}: ${d}`)];
  });
  if (lines.length) {
    what.appendChild(el('h3', 'pk-box-sub', 'On this machine'));
    const d = el('ul', 'pk-details');
    for (const l of lines) d.appendChild(el('li', null, l));
    what.appendChild(d);
  }
  wrap.appendChild(what);
  const undo = el('div', 'pk-box');
  undo.appendChild(el('h3', null, 'Undo'));
  undo.appendChild(pkCommand(`acs packs uninstall ${pack.id}`, 'pk-undo'));
  if (pack.explain?.undo) undo.appendChild(el('p', null, pack.explain.undo));
  const legacy = PK.status?.legacy?.length ? PK.status.legacy : PK.data.legacy;
  if (pack.id === 'review-gate' && legacy?.length) {
    const n = el('div', 'pk-notice pk-legacy');
    n.appendChild(el('strong', null, 'Older install found.'));
    n.appendChild(document.createTextNode(' The review script still reads its log and config. The installer does not move them.'));
    n.appendChild(el('div', 'pk-notice-paths', legacy.join(', ')));
    undo.appendChild(n);
  }
  wrap.appendChild(undo);
  sec.appendChild(wrap);
}

/** The status line: running with its latest progress, or when it was checked and a quiet Refresh. */
function pkPaintStatus() {
  const s = $('pk-status');
  if (!s || !pkShown()) return;
  s.innerHTML = '';
  const line = el('div', 'pk-status-line');
  if (PK.job) {
    line.appendChild(el('span', 'spinner'));
    const last = PK.job.progress?.at(-1)?.message || 'starting the status check…';
    const live = el('span', 'pk-status-text', `${last} (${Math.round((PK.job.elapsedMs || 0) / 1000)} s)`);
    live.setAttribute('aria-live', 'polite');
    line.appendChild(live);
  } else {
    const when = PK.status?.checkedAt ? new Date(PK.status.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
    const text = el('span', 'pk-status-text', when ? `Checked at ${when}` : 'Not checked yet');
    if (when) text.title = PK.status.trust ? 'With the Codex trust check' : 'Without the Codex trust check (set on Setup)';
    line.appendChild(text);
    line.appendChild(pkBtn('ghost', 'Refresh', () => pkCheckStatus()));
  }
  s.appendChild(line);
  if (PK.statusError) {
    const n = el('div', 'notice error');
    n.setAttribute('role', 'alert');
    n.textContent = `The status check failed: ${PK.statusError}`;
    s.appendChild(n);
  }
}

/* ── the review gate's Settings section: one writer, one pending preview ── */

const PK_SEC_LEVELS = [
  ['off', 'Off', 'PR reviews run no security pass.'],
  ['required', 'When code changes', 'A security reviewer reads the PR review whenever the change touches code or a risky path.'],
  ['always', 'Always', 'A security reviewer reads every PR review.'],
];
const PK_MERGE_POLICIES = [
  ['off', 'Off', 'You merge every PR.'],
  ['strict', 'Docs and tests only', 'An agent may merge a low-risk PR that changes only docs or tests.'],
  ['standard', 'Low-risk PRs', 'An agent may merge any low-risk PR. You merge the rest.'],
  ['always', 'Low and medium-risk PRs', 'An agent may merge low- and medium-risk PRs; high-risk always waits for you.'],
];
const PK_CROSS_MODES = [
  ['prefer', 'Prefer another vendor', 'Reviews and grades use a model from another vendor when one is available; never a blocker.'],
  ['off', 'Off', 'Any reviewer in your roles may check any work.'],
];
/** The review gate's own page for the paths that always need you: #packs/review-gate/paths. */
const PK_PATHS = 'paths';
/**
 * The section's state, shared by the pack page and its paths page. `draft` holds every change picked but not
 * saved ({ key: value } over the writer's allow-list): the save bar names them, one preview covers them all, and
 * Save writes them in one request with one backup. `paths` is the paths box's text, kept while you move between
 * the two pages so a Save from either includes it, and cleared (null) by a successful Save or by Cancel, when the
 * box shows what is saved again.
 */
const PK_SEC = { draft: {}, paths: null, preview: null, busy: false, error: null, result: null, seq: 0 };
const pkSaved = () => {
  const s = PK.data.settings || {};
  return { 'security.run': s.security || 'off', 'merge.policy': s.merge?.policy || 'off', 'merge.alwaysHuman': s.merge?.alwaysHuman || [], crossFamily: s.crossFamily || 'prefer' };
};
const pkPicked = (key) => (Object.hasOwn(PK_SEC.draft, key) ? PK_SEC.draft[key] : pkSaved()[key]);
const pkPathsOf = (text) => [...new Set(String(text || '').split('\n').map((l) => l.trim()).filter(Boolean))];
const pkOwnPaths = () => (PK_SEC.paths !== null ? pkPathsOf(PK_SEC.paths) : pkPicked('merge.alwaysHuman') || []);
const pkLabelOf = {
  'security.run': (v) => PK_SEC_LEVELS.find(([l]) => l === v)?.[1] || v,
  'merge.policy': (v) => PK_MERGE_POLICIES.find(([l]) => l === v)?.[1] || v,
  'merge.alwaysHuman': (v) => (v.length ? `${v.length} path${v.length === 1 ? '' : 's'} of your own` : 'no paths of your own'),
  crossFamily: (v) => PK_CROSS_MODES.find(([l]) => l === v)?.[1] || v,
};
const PK_SETTING_NAME = { 'security.run': 'security pass', 'merge.policy': 'agent merge', 'merge.alwaysHuman': 'always needs you', crossFamily: 'cross-vendor checks' };
const pkAnd = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0]);
/** “When code changes”, or “Low-risk PRs” (agent merge) and “Off” (cross-vendor checks) when more than one changed. */
function pkSaysText(changes) {
  const keys = Object.keys(changes);
  if (keys.length === 1) return `“${pkLabelOf[keys[0]](changes[keys[0]])}”`;
  return pkAnd(keys.map((k) => `“${pkLabelOf[k](changes[k])}” (${PK_SETTING_NAME[k]})`));
}
/** The save bar's line: 1 change: agent merge to “Low-risk PRs”. */
function pkBarText(changes) {
  const keys = Object.keys(changes);
  return `${keys.length} change${keys.length === 1 ? '' : 's'}: ${pkAnd(keys.map((k) => `${PK_SETTING_NAME[k]} to “${pkLabelOf[k](changes[k])}”`))}`;
}

const pkSettingsNone = () => el('p', 'pk-settings-none', 'Install the Code review part to set the security pass, agent merge and cross-vendor checks here.');

/** One setting: its name on the left, the control and its line on the right. */
function pkSetRow(name, cls, key, ...body) {
  const row = el('div', `pk-set ${cls}`);
  row.dataset.setting = key;
  row.appendChild(el('div', 'pk-set-name', name));
  const right = el('div', 'pk-set-body');
  for (const n of body) if (n) right.appendChild(n);
  row.appendChild(right);
  return row;
}

/** A segmented choice, and one line for the choice picked (saved, or waiting in the save bar). */
function pkChoiceRow(name, cls, key, options, { groupClass = '' } = {}) {
  const now = pkPicked(key);
  const seg = el('div', `pk-tabs${groupClass ? ` ${groupClass}` : ''}`);
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', name);
  for (const [value, label] of options) {
    const b = el('button', 'pk-tab', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(value === now));
    b.dataset.level = value;
    b.disabled = PK_SEC.busy;
    b.onclick = () => pkPick(key, value);
    seg.appendChild(b);
  }
  const line = options.find(([v]) => v === now)?.[2];
  return pkSetRow(name, cls, key, seg, line ? el('p', 'pk-set-says', line) : null);
}

function pkPathsCount(merge) {
  const built = (merge.builtIn || []).length, risky = (merge.riskPaths || []).length, own = pkOwnPaths().length;
  const n = built + risky + own;
  return `${n} path${n === 1 ? '' : 's'}: ${built} built in, ${risky} risky, ${own || 'none'} of your own`;
}

/**
 * The review gate's Settings: the security pass, agent merge, the paths that always need you and
 * cross-vendor checks. Only with the code-review part installed: it ships the scripts that read them.
 */
function pkSettingsView(pack) {
  if (!pack.installed?.parts?.['code-review']) return pkSettingsNone();
  const s = PK.data.settings || {};
  const wrap = el('div', 'pk-sec pk-settings');
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Review gate settings');
  const rows = el('div', 'pk-set-rows');
  rows.appendChild(pkChoiceRow('Security pass', 'pk-security', 'security.run', PK_SEC_LEVELS, { groupClass: 'pk-sec-levels' }));
  const merge = pkChoiceRow('Agent merge', 'pk-merge', 'merge.policy', PK_MERGE_POLICIES);
  // merge.mjs cannot merge without gh; the line shows only when the server reports gh missing (false, not absent).
  if (s.merge?.gh === false && pkPicked('merge.policy') !== 'off') {
    merge.querySelector('.pk-set-body').appendChild(el('p', 'pk-set-warn', 'Agent merge needs the gh CLI, and it is not on your PATH.'));
  }
  rows.appendChild(merge);
  const inline = el('div', 'pk-set-inline');
  inline.appendChild(el('span', null, pkPathsCount(s.merge || {})));
  inline.appendChild(pkBtn('pk-edit-paths', 'Edit paths', () => pkGo(pack.id, PK_PATHS)));
  rows.appendChild(pkSetRow('Always needs you', 'pk-always', 'merge.alwaysHuman', inline));
  rows.appendChild(pkChoiceRow('Cross-vendor checks', 'pk-cross', 'crossFamily', PK_CROSS_MODES));
  rows.appendChild(pkSettingsFoot(s.reviewConfig));
  wrap.appendChild(rows);
  pkSaveSlot(wrap);
  return wrap;
}

/** "Saved in <file>", with Open in Files when Files lists it. */
function pkSettingsFoot(rc) {
  const foot = el('div', 'pk-set-foot');
  if (!rc?.file) return foot;
  const where = el('span', null, 'Saved in ');
  where.appendChild(el('code', null, rc.file));
  foot.appendChild(where);
  // Files lists only what its registry found; ~/.agent-config-studio is outside its folders, so that copy is named only.
  const entry = rc.exists ? (S.registry?.groups || []).flatMap((g) => g.entries).find((e) => e.files.some((f) => f.display === rc.file)) : null;
  if (entry) foot.appendChild(pkBtn('ghost', 'Open in Files', () => openEntry(entry, entry.files.find((f) => f.display === rc.file).path, S.view)));
  return foot;
}

/** #packs/review-gate/paths: the built-in and risky paths, read-only, and the box for your own. */
function pkPathsPage(box, pack) {
  const page = el('div', 'pk-page pk-paths-page');
  page.appendChild(pkBackButton(pack));
  page.appendChild(el('h1', null, 'Always needs you'));
  if (!pack.installed?.parts?.['code-review']) { page.appendChild(pkSettingsNone()); box.appendChild(page); return; }
  page.appendChild(el('p', 'pk-page-lead', 'A change to any of these paths is high-risk, so no agent merges it. Nothing is saved until you preview the change.'));
  const merge = PK.data.settings?.merge || {};
  const lists = el('div', 'pk-path-lists');
  lists.appendChild(pkPathList('Built in', 'The review script always counts these.', merge.builtIn, 'built-in'));
  lists.appendChild(pkPathList('Risky paths', merge.riskPathsFrom === 'config' ? 'From your review config.' : 'From the review gate\'s defaults.', merge.riskPaths, 'risky'));
  page.appendChild(lists);
  const own = el('div', 'pk-path-box pk-own-paths');
  own.appendChild(el('h2', null, 'Your own'));
  own.appendChild(el('p', 'pk-path-note', 'One per line, like infra/**.'));
  const ta = el('textarea', 'pk-paths-box');
  ta.rows = 5;
  ta.value = PK_SEC.paths ?? pkPicked('merge.alwaysHuman').join('\n');
  ta.placeholder = 'infra/**';
  ta.setAttribute('aria-label', 'Your own paths that always need you, one per line');
  ta.disabled = PK_SEC.busy;
  // Only the save bar repaints while typing, so the box keeps its caret.
  ta.oninput = () => { PK_SEC.paths = ta.value; pkPaintSlot(); };
  own.appendChild(ta);
  page.appendChild(own);
  pkSaveSlot(page);
  box.appendChild(page);
}
function pkPathList(title, note, items, cls) {
  const wrap = el('div', 'pk-path-box');
  wrap.appendChild(el('h2', null, title));
  wrap.appendChild(el('p', 'pk-path-note', note));
  const ul = el('ul', `pk-path-list ${cls}`);
  for (const p of items || []) { const li = el('li'); li.appendChild(el('code', null, p)); ul.appendChild(li); }
  wrap.appendChild(ul);
  return wrap;
}

/**
 * The save bar's place, at the end of `host` (the Settings section or the paths page): the error, then the bar
 * while changes wait, the preview in its place, or the saved line. They are the host's own children because sticky
 * holds to the parent, and the host is tall enough for the bar to stay in view while the rows are on screen.
 */
function pkSaveSlot(host) {
  host.classList.add('pk-save-host');
  pkFillSlot(host);
}
function pkPaintSlot() {
  const host = $('content')?.querySelector('.pk-save-host');
  if (host) pkFillSlot(host);
}
function pkFillSlot(host) {
  for (const n of [...host.children].filter((c) => c.classList.contains('pk-save-part'))) n.remove();
  const add = (n) => { n.classList.add('pk-save-part'); host.appendChild(n); };
  if (PK_SEC.error) {
    const n = el('div', 'notice error');
    n.setAttribute('role', 'alert');
    n.textContent = PK_SEC.error;
    add(n);
  }
  const busy = () => { const s = el('span', 'pk-busy'); s.appendChild(el('span', 'spinner')); s.appendChild(el('span', null, ' Working…')); return s; };
  const p = PK_SEC.preview;
  if (p) {
    const pre = el('div', 'pk-sec-preview pk-savebar-preview');
    pre.setAttribute('role', 'region');
    pre.setAttribute('aria-label', 'Review gate settings preview');
    if (p.refreshed) pre.appendChild(el('p', 'pk-refreshed', 'The list changed since the preview; check the new preview and Save again.'));
    pre.appendChild(el('p', null, p.view.changes
      ? `Set to ${pkSaysText(p.changes)}: this changes ${p.view.file}${p.view.exists ? ', and a copy of it goes to the backups folder first' : ' (a new file)'}.`
      : `${p.view.file} already says ${pkSaysText(p.changes)}. Nothing to change.`));
    if (p.view.changes) pre.appendChild(pkSecurityDiff(p.view.diff));
    const acts = el('div', 'pk-actions');
    if (p.view.changes) acts.appendChild(pkBtn('primary', 'Save', () => pkSettingsApply(), PK_SEC.busy));
    acts.appendChild(pkBtn('ghost', 'Cancel', () => pkSettingsCancel(), PK_SEC.busy));
    if (PK_SEC.busy) acts.appendChild(busy());
    pre.appendChild(acts);
    add(pre);
    return;
  }
  pkDraftPaths();
  if (Object.keys(PK_SEC.draft).length) {
    const bar = el('div', 'pk-savebar');
    bar.setAttribute('role', 'status');
    bar.appendChild(el('span', 'pk-savebar-text', pkBarText(PK_SEC.draft)));
    const acts = el('div', 'pk-savebar-acts');
    if (PK_SEC.busy) acts.appendChild(busy());
    acts.appendChild(pkBtn('ghost', 'Cancel', () => pkSettingsCancel(), PK_SEC.busy));
    acts.appendChild(pkBtn('primary', 'Preview and save', () => pkReplan(), PK_SEC.busy));
    bar.appendChild(acts);
    add(bar);
  } else if (PK_SEC.result) {
    const r = PK_SEC.result;
    const after = !r.changed ? '' : r.backupDir ? ` The old file is at ${r.backupDir}.` : ' No existing file needed a backup.';
    add(el('div', 'notice pk-result', `Saved: ${r.file} now says ${pkSaysText(r.saved)}.${after}`));
  }
}

/** The server's line diff of the config, every line shown: the file is a few lines long. */
function pkSecurityDiff(rows) {
  const wrap = el('div', 'diff');
  const type = { '+': 'add', '-': 'del', ' ': 'ctx' };
  let a = 0, b = 0;
  for (const r of rows) {
    if (r.op !== '+') a++;
    if (r.op !== '-') b++;
    const line = el('div', `diff-line ${type[r.op]}`);
    line.appendChild(el('span', 'n', String(r.op === '-' ? a : b)));
    line.appendChild(el('span', 't', `${r.op === ' ' ? ' ' : r.op} ${r.line}`));
    wrap.appendChild(line);
  }
  return wrap;
}

/** Set or drop one draft key: dropped when it is what is saved. */
function pkDraftSet(key, value) {
  if (JSON.stringify(value) === JSON.stringify(pkSaved()[key])) delete PK_SEC.draft[key];
  else PK_SEC.draft[key] = value;
}
/** The paths box as it is on screen (or as last typed, from the pack page), into the draft. */
function pkDraftPaths() {
  const ta = $('content')?.querySelector('.pk-paths-box');
  if (ta) PK_SEC.paths = ta.value;
  if (PK_SEC.paths !== null) pkDraftSet('merge.alwaysHuman', pkPathsOf(PK_SEC.paths));
}

/** A pick joins the draft (or leaves it, when it is what is saved) and the save bar names it; nothing is previewed yet. */
function pkPick(key, value) {
  pkDraftPaths();
  pkDraftSet(key, value);
  PK_SEC.preview = null; PK_SEC.error = null; PK_SEC.result = null;
  PK_SEC.seq++;
  paintPacks();
  $('content').querySelector(`.pk-set[data-setting="${key}"] .pk-tab[data-level="${value}"]`)?.focus?.();
}

/** Back to what is saved: the draft, the typed paths and any preview go. */
function pkSettingsCancel() {
  PK_SEC.draft = {}; PK_SEC.paths = null; PK_SEC.preview = null; PK_SEC.error = null;
  PK_SEC.seq++;
  paintPacks();
  const c = $('content');
  (c.querySelector('.pk-paths-box') || c.querySelector('.pk-set-rows .pk-tab[aria-pressed="true"]'))?.focus?.();
}

/** Preview the whole draft as it stands. */
async function pkReplan({ refreshed = false } = {}) {
  pkDraftPaths();
  PK_SEC.error = null; PK_SEC.result = null; PK_SEC.preview = null;
  const seq = ++PK_SEC.seq;
  const changes = { ...PK_SEC.draft };
  if (!Object.keys(changes).length) { PK_SEC.busy = false; paintPacks(); return; }
  PK_SEC.busy = true;
  paintPacks();
  try {
    const view = await api('POST', '/api/packs/review-settings/plan', { changes });
    if (seq === PK_SEC.seq) PK_SEC.preview = { changes, view, refreshed };
  } catch (e) { if (seq === PK_SEC.seq) PK_SEC.error = e.message; }
  if (seq !== PK_SEC.seq) return;
  PK_SEC.busy = false;
  paintPacks();
  const pre = $('content').querySelector('.pk-savebar-preview');
  pre?.scrollIntoView?.({ block: 'nearest' });
  pre?.querySelector('.btn.primary')?.focus?.({ preventScroll: true });
}

async function pkSettingsApply() {
  pkDraftPaths();
  // The box changed after the preview: show the new diff rather than write what is no longer on screen.
  if (JSON.stringify(PK_SEC.draft) !== JSON.stringify(PK_SEC.preview.changes)) return pkReplan({ refreshed: true });
  const { changes, view } = PK_SEC.preview;
  PK_SEC.busy = true; PK_SEC.error = null;
  const seq = ++PK_SEC.seq;
  paintPacks();
  try {
    const r = await api('POST', '/api/packs/review-settings/apply', { changes, signature: view.signature });
    if (seq !== PK_SEC.seq) return;
    PK_SEC.result = r; PK_SEC.preview = null; PK_SEC.draft = {}; PK_SEC.paths = null;
    const s = PK.data.settings || {};
    const v = (k, d) => (Object.hasOwn(r.saved, k) ? r.saved[k] : d);
    PK.data.settings = {
      ...s,
      security: v('security.run', s.security || 'off'),
      merge: { ...(s.merge || {}), policy: v('merge.policy', s.merge?.policy || 'off'), alwaysHuman: v('merge.alwaysHuman', s.merge?.alwaysHuman || []) },
      crossFamily: v('crossFamily', s.crossFamily || 'prefer'),
      reviewConfig: { ...(s.reviewConfig || {}), file: r.file, exists: true },
    };
  } catch (e) {
    // A refused Save (the file changed since the preview) keeps the picks: the bar is back, to preview again.
    if (seq === PK_SEC.seq) { PK_SEC.error = e.message; PK_SEC.preview = null; }
  }
  if (seq === PK_SEC.seq) PK_SEC.busy = false;
  paintPacks();
  // The Save button that had focus is gone; focus the bar's button without moving the page.
  if (PK_SEC.error) $('content').querySelector('.pk-savebar .btn.primary')?.focus?.({ preventScroll: true });
}

/**
 * A modal dialog over the page (Models' "Used by" and the skill wizard's reply): focus moves in and stays in
 * (Tab and Shift+Tab wrap), Esc or Close shuts it, and focus goes back to what opened it.
 */
let pkDialogN = 0;
function pkDialog(title, body, opener, reopen) {
  document.body.querySelector('.pk-dialog')?.pkClose?.();
  const scrim = el('div', 'pk-scrim');
  const d = el('div', 'pk-dialog');
  const id = `pk-dialog-title-${++pkDialogN}`;
  d.setAttribute('role', 'dialog');
  d.setAttribute('aria-modal', 'true');
  d.setAttribute('aria-labelledby', id);
  const head = el('div', 'pk-dialog-head');
  const h = el('h2', 'pk-dialog-title', title);
  h.id = id;
  head.appendChild(h);
  const close = el('button', 'btn ghost', 'Close');
  head.appendChild(close);
  d.appendChild(head);
  d.appendChild(body);
  const shut = () => {
    scrim.remove();
    d.remove();
    // The page may have repainted under the dialog: find its button again.
    const back = opener && document.body.contains(opener) ? opener : reopen?.();
    back?.focus();
  };
  d.pkClose = shut;
  close.onclick = shut;
  scrim.onclick = shut;
  d.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); shut(); return; }
    // The app's ⌘/Ctrl shortcuts (search, save, edit) act on the page behind: none reach it while the dialog is open.
    if (e.metaKey || e.ctrlKey) {
      e.stopPropagation();
      if (['k', 's', 'e'].includes(String(e.key).toLowerCase())) e.preventDefault();
      return;
    }
    if (e.key !== 'Tab') return;
    // A real NodeList has no .filter: spread it first.
    const f = [...d.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"]')].filter((x) => !x.disabled);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  document.body.appendChild(scrim);
  document.body.appendChild(d);
  close.focus();
  return d;
}

/** The request the page describes for `action`: exactly what the preview and the apply send. */
function pkBody(pack, action, card, extra = {}) {
  if (action === 'install') {
    const b = { action, pack: pack.id, parts: pack.parts.map((p) => p.id).filter((id) => card.parts.has(id)) };
    if (card.harnesses) b.harnesses = [...card.harnesses];
    if (card.withDeps) b.withDeps = true;
    if (Object.keys(card.setRoles).length) b.setRoles = card.setRoles;
    return b;
  }
  if (action === 'update') return { action, pack: pack.id, ...(card.replace ? { replace: true } : {}) };
  return { action, pack: pack.id, ...(extra.parts ? { parts: extra.parts } : {}) };
}

/** The CLIs an install of the picked parts can be for. */
const pkFlowHarnesses = (pack, card) => [...new Set(pack.parts.filter((p) => card.parts.has(p.id)).flatMap((p) => p.harnesses))];
/** Why an install cannot be previewed as asked, or null. */
function pkInstallWhy(pack, card) {
  if (!card.parts.size) return 'Pick at least one part to install.';
  if (card.harnesses && card.harnesses.size === 0) return 'Pick at least one CLI to install for.';
  return null;
}

/**
 * Ask for the plan. A new action (`at` given) starts a fresh request under the button at `at`: an install
 * of `extra.parts` or the default parts, for every usable CLI, with the preview-only offers unticked.
 * `keepOffers` re-asks for the same action after a choice in the preview changed it.
 */
async function pkPreview(pack, action, extra = {}, { keepOffers = false, at, verb } = {}) {
  const card = pkCard(pack);
  if (at !== undefined || !card.flow) {
    card.flow = { action, at: at ?? 'pack', extra, verb: verb || PK_VERB[action] };
    card.setRoles = {}; card.replace = !!extra.replace;
    if (action === 'install') { card.parts = new Set(extra.parts || pkDefaults(pack)); card.harnesses = extra.harnesses ? new Set(extra.harnesses) : null; card.withDeps = false; }
  } else {
    card.flow = { ...card.flow, action };
    if (!keepOffers) { card.setRoles = {}; card.replace = false; }
  }
  pkDrop(card);
  card.result = null;
  if (action === 'install' && pkInstallWhy(pack, card)) { card.busy = null; paintPacks(); return; }
  card.busy = 'plan';
  const seq = card.seq;
  paintPacks();
  const body = pkBody(pack, action, card, card.flow.extra);
  try {
    const view = await api('POST', '/api/packs/plan', body);
    if (seq !== card.seq) return;
    card.preview = { action, body, view };
  } catch (e) {
    if (seq !== card.seq) return;
    card.error = { message: e.message };
  }
  card.busy = null;
  paintPacks();
}

/** What renders under the button at `at`: the action in progress there, and the result of the last one. */
function pkFlowAt(pack, card, at) {
  const out = [];
  if (card.flow?.at === at) out.push(pkPreviewView(pack, card));
  if (card.result?.at === at) out.push(pkResultView(card));
  return out;
}

/** The choices an install needs before its preview: which CLIs, and another pack it depends on. */
function pkInstallChoices(pack, card, box) {
  const busy = !!card.busy;
  const hs = pkFlowHarnesses(pack, card);
  if (hs.length) {
    const row = el('div', 'pk-harnesses');
    row.appendChild(el('span', 'pk-label-inline', 'Install for:'));
    for (const id of hs) {
      const h = pkHarness(id);
      const usable = pkUsable(id);
      const on = usable && (card.harnesses ? card.harnesses.has(id) : true);
      const label = `${h?.label || id}${id === 'claude' && !h?.present && usable ? ' skills folder (for Grok, which reads it)' : ''} (${h?.home || ''})`;
      const why = busy ? 'Wait for the preview to finish' : usable ? null : `${h?.label || id}: ${h?.why}`;
      row.appendChild(pkCheck(label, on, (v) => {
        const now = new Set(card.harnesses || hs.filter(pkUsable));
        if (v) now.add(id); else now.delete(id);
        card.harnesses = hs.filter(pkUsable).every((x) => now.has(x)) ? null : now;
        pkPreview(pack, 'install', {}, { keepOffers: true });
      }, { disabled: !usable || busy, title: why }));
      if (!usable && h?.why) row.appendChild(el('span', 'pk-harness-why', `${h.label}: ${h.why}`));
    }
    box.appendChild(row);
  }
  for (const r of pack.requirements.filter((x) => x.dep && !x.ok)) {
    const dep = pkPack(r.dep);
    box.appendChild(pkCheck(`Also install the ${dep?.title || r.dep} pack's skill now — ${pack.title} needs it: its gate commands run the review gate's review.mjs`, card.withDeps,
      (v) => { card.withDeps = v; pkPreview(pack, 'install', {}, { keepOffers: true }); }, { disabled: busy }));
  }
}

function pkPreviewView(pack, card) {
  const action = card.flow.action;
  const box = el('div', `pk-preview pk-preview-${action}`);
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', `${PK_VERB[action]} preview`);
  if (action === 'install') pkInstallChoices(pack, card, box);
  const why = action === 'install' ? pkInstallWhy(pack, card) : null;
  if (why) box.appendChild(el('p', 'pk-why', why));
  if (card.busy === 'plan') { const s = el('p', 'pk-busy'); s.appendChild(el('span', 'spinner')); s.appendChild(el('span', null, ' Working out what would change…')); box.appendChild(s); }
  if (card.error) {
    const n = el('div', 'notice error pk-error');
    n.setAttribute('role', 'alert');
    n.appendChild(el('div', null, card.error.message));
    if (card.error.log?.length) pkLog(n, card.error.log);
    box.appendChild(n);
  }
  if (card.preview) pkPreviewBody(pack, card, box);
  const bar = el('div', 'pk-actions');
  if (card.preview) {
    const { view } = card.preview;
    const can = view.changes && !view.refusals.length;
    const verb = card.flow.verb || PK_VERB[action];
    bar.appendChild(pkBtn(action === 'uninstall' ? 'danger pk-apply' : 'primary pk-apply', card.busy === 'apply' ? `${verb.replace(/e$/, '')}ing…` : verb, () => pkApply(pack), !can || !!card.busy));
  } else if (card.error && !card.busy && !why) {
    bar.appendChild(pkBtn('', 'Preview again', () => pkPreview(pack, action, card.flow.extra, { at: card.flow.at })));
  }
  // Cancel is off while an apply runs, so busy here is only a plan in flight: pkDrop orphans that request, which never clears busy itself.
  bar.appendChild(pkBtn('ghost', 'Cancel', () => { card.flow = null; pkDrop(card); card.busy = null; paintPacks(); }, card.busy === 'apply'));
  if (card.busy === 'apply') bar.appendChild(el('span', 'spinner'));
  box.appendChild(bar);
  if (card.preview?.view.changes && !card.preview.view.refusals.length) box.appendChild(el('div', 'pk-note', `${card.flow.verb || PK_VERB[action]} applies exactly this preview. If anything on disk changes first, it stops and asks you to preview again.`));
  return box;
}

/** The plan as the CLI words it: the head, what fails, every path and setting, what is kept or refused, the offers. */
function pkPreviewBody(pack, card, box) {
  const { action, view } = card.preview;
  box.appendChild(el('div', 'pk-preview-head', `${PK_VERB[action]}: ${view.packs.join(', ')}${view.units.length ? ` — ${view.units.map((u) => `${u.key}${u.harnesses.length ? ` (${u.harnesses.join(', ')})` : ''}`).join(', ')}` : ''}`));
  const list = (cls, items, fmt) => {
    if (!items.length) return;
    const ul = el('ul', cls);
    for (const x of items) ul.appendChild(fmt(x));
    box.appendChild(ul);
  };
  const failed = view.requirements.filter((r) => !r.ok);
  list('pk-reqs', failed, (r) => el('li', 'missing', `✖ ${r.what} — fix: ${r.fix}`));
  list('pk-notes', view.notes, (n) => el('li', null, `note: ${n}`));
  const files = view.preview.filter((r) => r.path);
  const settings = view.preview.filter((r) => r.setting);
  if (files.length) {
    box.appendChild(el('div', 'pk-label', 'Will change'));
    list('pk-rows', files, (r) => {
      const li = el('li', `pk-row ${r.action || ''}`);
      pkJoin(li, el('code', 'pk-sym', r.symbol), el('code', 'pk-path', r.path), el('span', 'pk-what', r.what || ''));
      // The planner's keep note ends with "kept" again; the row has said it.
      const note = r.action === 'keep' ? r.note?.replace(/:\s*kept$/, '') : r.note;
      if (note) li.appendChild(el('span', 'pk-note', ` — ${note}`));
      return li;
    });
  }
  if (settings.length) {
    box.appendChild(el('div', 'pk-label', 'Settings'));
    list('pk-rows', settings, (r) => pkJoin(el('li', 'pk-row'), el('code', 'pk-sym', '~'), el('code', 'pk-path', r.setting)));
  }
  list('pk-warnings', view.warnings, (w) => el('li', null, `warning: ${w}`));
  // A kept file already on its own row is not said twice.
  list('pk-kept', view.kept.filter((k) => !files.some((r) => r.path === k.path)), (k) => el('li', null, `kept: ${k.path} — ${k.why}`));
  list('pk-refusals', view.refusals, (r) => el('li', null, `✖ ${r}`));

  // The role fix-up: the CLI's offer, per role — set it to the installed families, through ACS's roles.
  for (const r of view.roles) {
    const offer = el('div', 'pk-offer');
    offer.appendChild(el('div', null, r.missing
      ? `The ${r.role} role is not set: skills that use it stop until you choose its model (here, or any family in Models → Roles).`
      : `The ${r.role} role uses ${r.use.join(', ') || 'nothing'}, and none of their CLIs is installed here.`));
    if ((r.families || []).length) {
      // A choice, never a default: blank until the user picks, from the families a CLI here runs.
      const pick = el('select', 'pk-role-pick');
      pick.appendChild(el('option', null, `Choose the ${r.role} model…`)).value = '';
      for (const f of r.families) pick.appendChild(el('option', null, f)).value = f;
      pick.value = r.set?.[0] || '';
      pick.disabled = !!card.busy;
      pick.onchange = () => {
        if (pick.value) card.setRoles = { ...card.setRoles, [r.role]: [pick.value] };
        else { const { [r.role]: _, ...rest } = card.setRoles; card.setRoles = rest; }
        pkPreview(pack, 'install', {}, { keepOffers: true });
      };
      const label = el('label', 'pk-check');
      label.appendChild(el('span', null, `Set the ${r.role} role (through ACS's roles; it stays after an uninstall): `));
      label.appendChild(pick);
      offer.appendChild(label);
    } else offer.appendChild(el('div', 'pk-note', 'No installed CLI can run any family; install one.'));
    box.appendChild(offer);
  }
  // Every reason the update planner keeps a file that replace would take instead (lib/packs.js planUpdate).
  if (action === 'update' && (view.kept.some((k) => /you edited|you removed|you customised|the block is gone/.test(k.why)) || card.replace)) {
    const offer = el('div', 'pk-offer');
    offer.appendChild(pkCheck('Take the pack\'s copy of the files you changed (each edited one is backed up first)', card.replace, (v) => {
      card.replace = v;
      pkPreview(pack, 'update', {}, { keepOffers: true });
    }, { disabled: !!card.busy }));
    box.appendChild(offer);
  }
  if (!view.changes && !view.refusals.length) box.appendChild(el('div', 'pk-note pk-nothing', 'Nothing to change.'));
}

async function pkApply(pack) {
  const card = pkCard(pack);
  if (!card.preview || card.busy) return;
  const { action, body, view } = card.preview;
  const at = card.flow?.at ?? 'pack';
  card.busy = 'apply';
  card.error = null;
  paintPacks();
  try {
    const r = await api('POST', '/api/packs/apply', { ...body, signature: view.signature });
    card.result = { action, r, at };
    card.preview = null;
    card.flow = null;
  } catch (e) {
    card.error = { message: e.message, log: e.body?.log };
    // A stale preview (409) is gone; anything else keeps it on screen beside the error.
    if (e.status === 409) card.preview = null;
  }
  card.busy = null;
  card.seq++;
  await pkLoad();
  card.parts = new Set(pkDefaults(pkPack(pack.id) || pack));
  card.harnesses = null; card.withDeps = false; card.setRoles = {}; card.replace = false;
  paintPacks();
  if (card.result) {
    if (typeof refreshRegistry === 'function') refreshRegistry().catch(() => {});
    // An install can set roles (the preview's role offer): the diagrams show them at once, not on the next visit.
    pkLoadRoles();
    pkCheckStatus();
  }
}

function pkResultView(card) {
  const { action, r } = card.result;
  const n = el('div', 'notice ok pk-result');
  n.setAttribute('role', 'status');
  n.appendChild(el('div', 'pk-result-head', `${PK_DONE[action]}: ${r.units.join(', ') || r.packs.join(', ')}.`));
  n.appendChild(el('div', null, r.backupDir ? `Backups of every existing file it changed: ${r.backupDir}` : 'No existing file needed a backup.'));
  const list = (items, fmt, cls) => { if (!items?.length) return; const ul = el('ul', cls); for (const x of items) ul.appendChild(el('li', null, fmt(x))); n.appendChild(ul); };
  list(r.kept, (k) => `kept: ${k.path} — ${k.why}`);
  list(r.notes, (x) => `note: ${x}`);
  list(r.warnings, (x) => `warning: ${x}`, 'pk-warnings');
  if (r.log?.length) pkLog(n, r.log);
  n.appendChild(pkBtn('ghost', 'Dismiss', () => { card.result = null; paintPacks(); }));
  return n;
}

/** The installers' output, in place under its result: a short scrolling box, never a fold. */
function pkLog(box, lines) {
  box.appendChild(el('div', 'pk-log-head', 'Installer output'));
  const pre = el('pre', 'pk-log', lines.join('\n'));
  pre.tabIndex = 0;
  pre.setAttribute('aria-label', 'Installer output');
  box.appendChild(pre);
}
