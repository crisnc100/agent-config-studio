/* Agent Config Studio — the first-run setup screen (#setup) */

/**
 * Four steps, each skippable: the agent CLIs, the accounts Usage tracks, the
 * project folders, and what to run next. Every fact here comes from a route:
 * /api/setup/clis (versions, sign-in, the commands to show — read from
 * builds/setup-screen/commands.md), /api/setup/accounts, /api/setup/scan.
 * The page spells no command of its own.
 *
 * Nothing runs on its own: the folder scan waits for its button, an account
 * is added only by a click, and an edit folder only after a confirm naming
 * where it really leads. Re-running setup removes nothing.
 *
 * The step lives in the hash (#setup&step=folders), so a reload mid-setup
 * comes back to the same step.
 */

const SETUP_STEPS = [['clis', 'CLIs'], ['accounts', 'Accounts'], ['folders', 'Project folders'], ['done', 'Done']];
const SETUP = {
  step: 'clis',
  clis: null,          // /api/setup/clis answer
  clisError: null,
  checking: false,
  accounts: null,      // /api/setup/accounts answer
  usage: null,         // /api/usage answer, for the seats' state
  scan: null,          // /api/setup/scan answer
  scanning: false,
  picks: {},           // suggestion path -> { on, access, canonical }
  status: null,        // /api/setup/status answer
  finishing: false,
};

/** The step a hash names, or the first. */
function setupStepOf(hash) {
  const m = /[#&]step=([a-z]+)/.exec(hash || '');
  return SETUP_STEPS.some(([id]) => id === m?.[1]) ? m[1] : 'clis';
}

async function openSetup() {
  if (!confirmDiscard()) return;
  S.view = 'setup';
  leaveEditor();
  SETUP.step = setupStepOf(location.hash);
  window.history.replaceState(null, '', `#setup&step=${SETUP.step}`);
  renderSidebar(); renderTopbar(); renderTabs(); renderStatus();
  $('filebar').hidden = true;
  paintSetup();
  api('GET', '/api/setup/status').then((s) => { SETUP.status = s; paintSetup(); }, () => {});
  loadSetupStep();
}

function setupGo(step) {
  SETUP.step = step;
  window.history.replaceState(null, '', `#setup&step=${step}`);
  paintSetup();
  loadSetupStep();
  $('content').querySelector('.setup-step h3')?.focus?.();
}

/** Fetch what the current step shows, once; Recheck and Refresh ask again. */
function loadSetupStep() {
  if ((SETUP.step === 'clis' || SETUP.step === 'done') && !SETUP.clis && !SETUP.checking) loadSetupClis(false);
  if (SETUP.step === 'accounts' && !SETUP.accounts) loadSetupAccounts();
  if (SETUP.step === 'folders' && !FOLDERS.data) loadFolders().then(() => paintSetup());
}

async function loadSetupClis(recheck) {
  SETUP.checking = true;
  paintSetup();
  try { SETUP.clis = await api('GET', `/api/setup/clis${recheck ? '?recheck=1' : ''}`); SETUP.clisError = null; }
  catch (e) { SETUP.clisError = e.message; }
  SETUP.checking = false;
  paintSetup();
}

async function loadSetupAccounts() {
  try {
    const [a, u] = await Promise.all([api('GET', '/api/setup/accounts'), api('GET', '/api/usage')]);
    SETUP.accounts = a; SETUP.usage = u;
  } catch (e) { SETUP.accounts = { suggestions: [], error: e.message }; }
  paintSetup();
}

function paintSetup() {
  if (S.view !== 'setup') return;
  const c = $('content');
  c.innerHTML = '';
  const box = el('div', 'scope setup');
  const head = el('div', 'setup-head');
  head.appendChild(el('h2', null, 'Set up Agent Config Studio'));
  const skip = el('button', 'btn ghost', 'Skip setup');
  skip.onclick = () => finishSetup('skipped');
  head.appendChild(skip);
  box.appendChild(head);
  box.appendChild(el('div', 'scope-sub', 'Four steps, each optional. Nothing here removes anything, and you can come back from Home at any time.'));

  if (SETUP.status?.state === 'error') box.appendChild(setupStatusNotice());

  const steps = el('ol', 'setup-steps');
  steps.setAttribute('aria-label', 'Setup steps');
  SETUP_STEPS.forEach(([id, label], i) => {
    const li = el('li');
    const b = el('button', `setup-step-btn${SETUP.step === id ? ' active' : ''}`, `${i + 1}. ${label}`);
    if (SETUP.step === id) b.setAttribute('aria-current', 'step');
    b.onclick = () => setupGo(id);
    li.appendChild(b);
    steps.appendChild(li);
  });
  box.appendChild(steps);

  const body = el('section', 'setup-step');
  const painters = { clis: setupClisStep, accounts: setupAccountsStep, folders: setupFoldersStep, done: setupDoneStep };
  painters[SETUP.step](body);
  box.appendChild(body);

  const nav = el('div', 'setup-nav');
  const i = SETUP_STEPS.findIndex(([id]) => id === SETUP.step);
  if (i > 0) {
    const back = el('button', 'btn', 'Back');
    back.onclick = () => setupGo(SETUP_STEPS[i - 1][0]);
    nav.appendChild(back);
  }
  if (i < SETUP_STEPS.length - 1) {
    const next = el('button', 'btn primary', 'Next');
    next.onclick = () => setupGo(SETUP_STEPS[i + 1][0]);
    nav.appendChild(next);
  }
  box.appendChild(nav);
  c.appendChild(box);
}

/** setup.json could not be read: say so, and offer to write a good one. */
function setupStatusNotice() {
  const n = el('div', 'notice warn setup-status');
  n.appendChild(el('div', null, `${SETUP.status.error}. Setup still works; finishing or skipping rewrites the file.`));
  const fix = el('button', 'btn', 'Rewrite it as done');
  fix.onclick = () => finishSetup('done', { stay: true });
  n.appendChild(fix);
  return n;
}

/** A command to run in a terminal, with a Copy button. */
function setupCommand(text, note) {
  const row = el('div', 'setup-cmd');
  row.appendChild(el('code', 'folders-cmd', text));
  const copy = el('button', 'btn ghost', 'Copy');
  copy.setAttribute('aria-label', `Copy: ${text}`);
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied'; }
    catch { copy.textContent = 'Select and copy it'; }
  };
  row.appendChild(copy);
  if (note) row.appendChild(el('span', 'home-muted', note));
  return row;
}

/* ── step 1: CLIs ─────────────────────────────────────────────────────── */
function setupClisStep(body) {
  const h = el('h3', null, 'Agent CLIs');
  h.tabIndex = -1;
  body.appendChild(h);
  body.appendChild(el('div', 'scope-sub', 'The studio works with Claude Code, Codex and Grok. Install the ones you use, sign in, then Recheck — no reload needed.'));
  const tools = el('div', 'setup-tools');
  const recheck = el('button', 'btn', SETUP.checking ? 'Checking…' : 'Recheck');
  recheck.disabled = SETUP.checking;
  recheck.onclick = () => loadSetupClis(true);
  tools.appendChild(recheck);
  body.appendChild(tools);
  if (SETUP.clisError) body.appendChild(el('div', 'notice error', `Could not check the CLIs: ${SETUP.clisError}`));
  if (!SETUP.clis) { if (!SETUP.clisError) body.appendChild(homeLoading('Looking for the CLIs…')); return; }
  const grid = el('div', 'setup-cards');
  for (const cli of SETUP.clis.clis) grid.appendChild(setupCliCard(cli));
  body.appendChild(grid);
}

function setupCliCard(cli) {
  const card = el('div', 'mem-card setup-cli');
  card.dataset.cli = cli.id;
  const top = el('div', 'home-cli-top');
  top.appendChild(el('span', 'home-cli-name', cli.label));
  top.appendChild(el('span', `home-chip ${cli.installed ? 'ok' : 'warn'}`, cli.installed ? 'installed' : 'not installed'));
  card.appendChild(top);
  if (cli.installed) {
    card.appendChild(el('div', 'home-muted', `${cli.version || 'version unknown'} · ${cli.binary}`));
    const tone = { verified: 'ok', present: 'ok', rejected: 'warn', none: 'warn', unknown: '' }[cli.signIn.state];
    const line = el('div', 'setup-signin');
    line.appendChild(el('span', `home-chip ${tone}`, `sign-in: ${cli.signIn.label}`));
    if (cli.signIn.detail) line.appendChild(el('span', 'home-muted', cli.signIn.detail));
    card.appendChild(line);
  }
  if (cli.fix.install) card.appendChild(setupCommand(cli.fix.install, 'to install'));
  if (cli.fix.signIn) card.appendChild(setupCommand(cli.fix.signIn, 'to sign in'));
  if (cli.fix.docs) {
    const a = el('a', 'usage-hint-link', 'Install and sign-in instructions');
    a.href = cli.fix.docs; a.target = '_blank'; a.rel = 'noopener';
    card.appendChild(a);
  }
  return card;
}

/* ── step 2: accounts ─────────────────────────────────────────────────── */
function setupAccountsStep(body) {
  const h = el('h3', null, 'Accounts');
  h.tabIndex = -1;
  body.appendChild(h);
  body.appendChild(el('div', 'scope-sub', 'The subscriptions Usage tracks. Suggestions come from what is on this machine; none is added until you click.'));
  const a = SETUP.accounts;
  if (!a) return body.appendChild(homeLoading('Looking for accounts…'));
  if (a.error) body.appendChild(el('div', 'notice error', `Could not look for accounts: ${a.error}`));

  const list = el('div', 'setup-list');
  if (!a.suggestions.length) list.appendChild(el('div', 'home-muted', 'Nothing to suggest on this machine — add one by hand below.'));
  for (const sg of a.suggestions) {
    const row = el('div', 'setup-row');
    row.dataset.suggestion = sg.key;
    const who = el('div', 'setup-row-main');
    who.appendChild(el('span', 'home-cli-name', sg.label));
    if (sg.home) who.appendChild(el('span', 'home-muted', sg.home));
    row.appendChild(who);
    if (sg.added) row.appendChild(el('span', 'home-chip ok', 'added'));
    else {
      const add = el('button', 'btn', 'Add');
      add.setAttribute('aria-label', `Add ${sg.label}`);
      add.onclick = () => setupAddSeat({ key: sg.key }, add);
      row.appendChild(add);
    }
    list.appendChild(row);
  }
  body.appendChild(list);
  body.appendChild(setupManualSeat());

  const seats = rankSeats(SETUP.usage?.seats || []);
  if (seats.length) {
    const tools = el('div', 'setup-tools');
    tools.appendChild(el('h4', null, 'Tracked now'));
    const refresh = el('button', 'btn', 'Refresh');
    refresh.onclick = async () => {
      refresh.disabled = true; refresh.textContent = 'Refreshing…';
      try { await api('POST', '/api/usage/refresh'); } catch (e) { notice('error', e.message); }
      SETUP.accounts = null;
      loadSetupAccounts();
    };
    tools.appendChild(refresh);
    body.appendChild(tools);
    for (const r of accountsModel({ seats }).rows) {
      const seat = seats.find((s) => s.seatId === r.id);
      const row = el('div', 'setup-row setup-seat');
      row.dataset.seat = r.id;
      const who = el('div', 'setup-row-main');
      who.appendChild(el('span', 'home-cli-name', r.label));
      if (r.meta) who.appendChild(el('span', 'home-muted', r.meta));
      row.appendChild(who);
      const read = el('div', 'setup-seat-read');
      if (r.state.kind === 'reading') {
        read.appendChild(el('span', 'usage-pct', r.windows.length ? r.windows.map((w) => `${w.label}: ${w.left}% left`).join(' · ') : 'connected · no quota windows reported'));
      } else {
        const tag = el('span', 'usage-offline-tag', r.state.tag);
        if (r.state.tone) tag.classList.add(r.state.tone);
        read.appendChild(tag);
        if (r.reason) read.appendChild(el('span', 'home-muted', r.reason));
      }
      row.appendChild(read);
      body.appendChild(row);
      if (seat.vendor === 'codex' && seat.home && r.connect) {
        body.appendChild(connectRow(seat, { reauth: r.connect === 'reauth', view: 'setup', onSignedIn: () => { SETUP.accounts = null; loadSetupAccounts(); } }));
      }
    }
  }
}

function setupManualSeat() {
  const form = el('div', 'usage-add setup-manual');
  form.appendChild(el('div', 'usage-add-title', 'Add an account'));
  const row = el('div', 'usage-add-row');
  const vendor = document.createElement('select');
  vendor.className = 'usage-add-vendor';
  vendor.setAttribute('aria-label', 'Vendor');
  for (const [value, text] of [['codex', 'Codex (ChatGPT)'], ['claude', 'Claude'], ['grok', 'Grok']]) {
    const o = document.createElement('option');
    o.value = value; o.textContent = text;
    vendor.appendChild(o);
  }
  const label = document.createElement('input');
  label.className = 'usage-add-label';
  label.setAttribute('aria-label', 'Name');
  label.placeholder = 'Name it — e.g. "Codex (work)"';
  label.maxLength = 60;
  const add = el('button', 'btn', 'Add');
  const submit = () => {
    if (!label.value.trim()) return label.focus();
    setupAddSeat({ vendor: vendor.value, label: label.value.trim() }, add);
  };
  add.onclick = submit;
  label.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  row.append(vendor, label, add);
  form.appendChild(row);
  return form;
}

async function setupAddSeat(body, btn) {
  btn.disabled = true;
  let res;
  try { res = await api('POST', '/api/setup/seats', body); }
  catch (e) { btn.disabled = false; return notice('error', e.message); }
  if (res.note) notice('info', res.note);
  else notice('ok', `${res.seat.label} ${res.already ? 'was already tracked' : 'is tracked in Usage'}.`);
  SETUP.accounts = null;
  loadSetupAccounts();
}

/* ── step 3: project folders ──────────────────────────────────────────── */
function setupFoldersStep(body) {
  const h = el('h3', null, 'Project folders');
  h.tabIndex = -1;
  body.appendChild(h);
  body.appendChild(el('div', 'scope-sub', 'The folders your projects live in. Read folders are listed in Context, Skills and Worktrees; edit folders also open in the editor, with history. Folders start as read.'));

  const reg = FOLDERS.data?.roots || [];
  if (reg.length) {
    const have = el('div', 'setup-list');
    have.appendChild(el('h4', null, 'Added'));
    for (const r of reg) {
      const row = el('div', 'setup-row');
      row.dataset.root = r.id;
      const main = el('div', 'setup-row-main');
      main.appendChild(el('span', 'home-cli-name', r.label));
      main.appendChild(el('span', 'home-muted', r.display));
      row.appendChild(main);
      row.appendChild(el('span', `mem-badge folders-${r.access}`, r.access === 'edit' ? 'edit' : 'read-only'));
      if (r.partial) row.appendChild(el('span', 'mem-badge folders-missing', 'large folder — partially indexed'));
      have.appendChild(row);
    }
    body.appendChild(have);
  }

  const tools = el('div', 'setup-tools');
  const scanBtn = el('button', 'btn', SETUP.scanning ? 'Scanning…' : 'Scan for projects');
  scanBtn.disabled = SETUP.scanning;
  scanBtn.onclick = setupScan;
  tools.appendChild(scanBtn);
  tools.appendChild(el('span', 'home-muted setup-privacy',
    'Looks a few levels into ~/Documents, ~/code, ~/Projects and similar. On macOS, reading ~/Documents can make your terminal ask for permission.'));
  body.appendChild(tools);

  const sc = SETUP.scan;
  if (sc?.error) body.appendChild(el('div', 'notice error', `The scan did not finish: ${sc.error}`));
  if (sc && !sc.error) {
    const list = el('div', 'setup-list');
    if (!sc.suggestions.length) list.appendChild(el('div', 'home-muted', 'No project folders found there — type a path below.'));
    for (const sg of sc.suggestions) list.appendChild(setupSuggestionRow(sg));
    body.appendChild(list);
    if (sc.truncated) body.appendChild(el('div', 'home-muted', 'The scan stopped at its limit, so this may not be everything — type a path below for anything missing.'));
    for (const b of sc.blocked) body.appendChild(el('div', 'home-muted setup-blocked', `${b.path}: ${b.reason}`));
    const fresh = sc.suggestions.filter((s) => s.status === 'new');
    if (fresh.length) {
      const add = el('button', 'btn primary', 'Add selected');
      add.onclick = () => setupAddPicked(add);
      body.appendChild(add);
    }
  }
  body.appendChild(setupTypedFolder());
}

async function setupScan() {
  SETUP.scanning = true;
  paintSetup();
  try { SETUP.scan = await api('GET', '/api/setup/scan'); }
  catch (e) { SETUP.scan = { error: e.message }; }
  SETUP.scanning = false;
  for (const s of SETUP.scan.suggestions || []) SETUP.picks[s.path] ||= { on: false, access: 'read', canonical: null };
  paintSetup();
}

function setupSuggestionRow(sg) {
  const row = el('div', 'setup-row');
  row.dataset.folder = sg.display;
  const counts = [sg.repos ? `${sg.repos} repo${sg.repos === 1 ? '' : 's'}` : null,
    sg.contextFiles ? `${sg.contextFiles} with CLAUDE.md / AGENTS.md` : null].filter(Boolean).join(' · ');
  if (sg.status !== 'new') {
    const main = el('div', 'setup-row-main');
    main.appendChild(el('span', 'home-cli-name', sg.display));
    if (counts) main.appendChild(el('span', 'home-muted', counts));
    row.appendChild(main);
    row.appendChild(el('span', 'home-chip ok', sg.status === 'added' ? 'added' : `already covered by ${sg.coveredBy}`));
    return row;
  }
  const pick = SETUP.picks[sg.path];
  const label = el('label', 'setup-row-main');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = pick.on;
  box.onchange = () => { pick.on = box.checked; };
  label.appendChild(box);
  label.appendChild(el('span', 'home-cli-name', sg.display));
  if (counts) label.appendChild(el('span', 'home-muted', counts));
  row.appendChild(label);
  const access = setupAccessSelect(pick.access, async (to, sel) => {
    if (to === 'read') { pick.access = 'read'; pick.canonical = null; return; }
    const ok = await setupConfirmEdit(sg.path);
    if (ok) { pick.access = 'edit'; pick.canonical = ok; pick.on = true; box.checked = true; }
    else { sel.value = 'read'; pick.access = 'read'; }
  });
  access.setAttribute('aria-label', `Access for ${sg.display}`);
  row.appendChild(access);
  return row;
}

function setupAccessSelect(value, onChange) {
  const sel = document.createElement('select');
  for (const [v, t] of [['read', 'read'], ['edit', 'edit']]) {
    const o = document.createElement('option');
    o.value = v; o.textContent = t;
    sel.appendChild(o);
  }
  sel.value = value;
  sel.onchange = () => onChange(sel.value, sel);
  return sel;
}

/**
 * The edit confirm. Asks the server where the path really leads and names
 * that place; resolves to the canonical path to send as `confirm`, or null.
 */
async function setupConfirmEdit(p) {
  let pv;
  try { pv = await api('POST', '/api/roots/preview', { path: p }); }
  catch (e) { notice('error', e.message); return null; }
  if (pv.access.edit) { notice('error', pv.access.edit); return null; }
  return confirm(`Give the studio edit access to ${pv.display}?\n\n${pv.grants}`) ? pv.canonical : null;
}

async function setupAddRoot({ path: p, access, canonical, label }) {
  const body = { path: p, access };
  if (label) body.label = label;
  if (access === 'edit') body.confirm = canonical;
  const res = await api('POST', '/api/roots/add', body);
  FOLDERS.data = res.roots;
  return res;
}

async function setupAddPicked(btn) {
  const chosen = (SETUP.scan?.suggestions || []).filter((s) => s.status === 'new' && SETUP.picks[s.path]?.on);
  if (!chosen.length) return notice('warn', 'Tick the folders to add first.');
  btn.disabled = true;
  const failed = [];
  for (const s of chosen) {
    const pick = SETUP.picks[s.path];
    try { await setupAddRoot({ path: s.path, access: pick.access, canonical: pick.canonical }); s.status = 'added'; }
    catch (e) { failed.push(`${s.display}: ${e.message}`); }
  }
  if (failed.length) notice('error', 'Some folders were not added:', failed, true);
  else notice('ok', `${chosen.length} folder${chosen.length === 1 ? '' : 's'} added.`);
  paintSetup();
}

function setupTypedFolder() {
  const form = el('div', 'usage-add setup-typed');
  form.appendChild(el('div', 'usage-add-title', 'Or type a folder'));
  const row = el('div', 'usage-add-row');
  const input = document.createElement('input');
  input.className = 'usage-add-label';
  input.setAttribute('aria-label', 'Folder path');
  input.placeholder = '~/code/work or /full/path';
  const access = setupAccessSelect('read', () => {});
  access.setAttribute('aria-label', 'Access for the typed folder');
  const add = el('button', 'btn', 'Add folder');
  add.onclick = async () => {
    const p = input.value.trim();
    if (!p) return input.focus();
    let canonical = null;
    if (access.value === 'edit') {
      canonical = await setupConfirmEdit(p);
      if (!canonical) return;
    }
    add.disabled = true;
    try { await setupAddRoot({ path: p, access: access.value, canonical }); notice('ok', `${p} added.`); input.value = ''; }
    catch (e) { notice('error', e.message); }
    add.disabled = false;
    paintSetup();
  };
  row.append(input, access, add);
  form.appendChild(row);
  return form;
}

/* ── step 4: done ─────────────────────────────────────────────────────── */
function setupDoneStep(body) {
  const h = el('h3', null, 'Next steps');
  h.tabIndex = -1;
  body.appendChild(h);
  body.appendChild(el('div', 'scope-sub', 'Optional extras, run in a terminal. Then Finish and you are on Home.'));
  if (!SETUP.clis) body.appendChild(homeLoading('Reading the commands…'));
  for (const s of SETUP.clis?.next || []) {
    const row = el('div', 'setup-next');
    row.appendChild(el('div', null, s.note + (s.platforms ? ` (${s.platforms})` : '')));
    row.appendChild(setupCommand(s.command));
    body.appendChild(row);
  }
  const finish = el('button', 'btn primary setup-finish', SETUP.finishing ? 'Finishing…' : 'Finish');
  finish.disabled = SETUP.finishing;
  finish.onclick = () => finishSetup('done');
  body.appendChild(finish);
}

/**
 * Finish or Skip: write setup.json, forget what Home had cached (accounts,
 * CLIs, folders may all have changed here), and land on Home. A write that
 * fails keeps the person on setup, with the error.
 */
async function finishSetup(completed, { stay = false } = {}) {
  SETUP.finishing = true;
  paintSetup();
  try { SETUP.status = await api('POST', '/api/setup/complete', { completed }); }
  catch (e) {
    SETUP.finishing = false;
    paintSetup();
    return notice('error', `Setup could not be saved: ${e.message}. You are still in setup — try again.`, null, true);
  }
  SETUP.finishing = false;
  HOME.src = {}; HOME.inflight = {}; HOME.settledAt = 0;
  FOLDERS.data = null;
  if (stay) { paintSetup(); return notice('ok', 'setup.json rewritten.'); }
  Object.assign(SETUP, { clis: null, accounts: null, usage: null, scan: null, picks: {} });
  clearNotice();
  goHome();
  window.history.replaceState(null, '', '#home');
}
