/* Agent Config Studio — the Packs view: recommended skill packs, explained, previewed, installed (lib/packs-routes.js) */

/**
 * Loaded before app.js, which owns the helpers this calls (el, api, notice,
 * renderSidebar…). Every write goes through a preview: the page asks the
 * server for the plan of what the card shows, lists every path and setting
 * it changes, and the Install / Update / Uninstall button under it sends
 * that same request back with the preview's signature. Any change on the
 * card drops the preview, so the button only ever applies what was shown;
 * the server refuses (409) if the disk moved in between.
 *
 * Status is a job on the server (the Codex trust check is slow): the page
 * starts it, then polls until it is done, showing each progress line.
 */
const PK = { data: null, error: null, status: null, statusError: null, job: null, trust: true, statusGen: 0, cards: {}, roles: null, rolesError: null };
const PK_VERB = { install: 'Install', update: 'Update', uninstall: 'Uninstall' };
const PK_DONE = { install: 'Installed', update: 'Updated', uninstall: 'Uninstalled' };
const PK_POLL_MS = 400;

const pkPack = (id) => PK.data?.packs.find((p) => p.id === id) || null;
const pkInstalled = (pack, partId) => !!pack.installed?.parts?.[partId];
const pkHarnesses = (pack) => [...new Set(pack.parts.flatMap((p) => p.harnesses))];
const pkHarness = (id) => PK.data?.harnesses.find((h) => h.id === id) || null;
/** A harness a part can install for here: present, or the Claude skills folder on a machine that has only Grok (it reads it). */
const pkUsable = (id) => !!pkHarness(id)?.present || (id === 'claude' && !!pkHarness('grok')?.present);
const pkDefaults = (pack) => pack.parts.filter((p) => p.default && !pkInstalled(pack, p.id)).map((p) => p.id);

function pkCard(pack) {
  PK.cards[pack.id] ||= { parts: new Set(pkDefaults(pack)), harnesses: null, withDeps: false, setRoles: {}, replace: false, preview: null, busy: null, result: null, error: null, seq: 0, variant: null };
  return PK.cards[pack.id];
}
/** Anything the card shows changed: the preview no longer describes it. */
function pkDrop(card) { card.preview = null; card.error = null; card.seq++; }

async function openPacks() {
  if (!confirmDiscard()) return;
  S.view = 'packs';
  leaveEditor();
  window.history.replaceState(null, '', '#packs');
  renderSidebar(); renderTopbar(); renderTabs(); renderStatus();
  $('filebar').hidden = true;
  $('content').innerHTML = '<div class="scope"><div class="scope-sub"><span class="spinner"></span> Reading the packs…</div></div>';
  // The roles every diagram names, read fresh each time Packs opens: a role changed on Models shows here (R3).
  const roles = pkLoadRoles();
  await pkLoad();
  await roles;
  if (S.view === 'packs' && PK.data) pkCheckStatus();
}

async function pkLoadRoles() {
  try { PK.roles = (await api('GET', '/api/models/roles')).roles || []; PK.rolesError = null; }
  catch (e) { PK.roles = null; PK.rolesError = e.message; }
  if (S.view === 'packs' && PK.data) paintPacks();
}

/**
 * One line per card for the roles its workflow names that are not chosen yet: "2 roles not set — choose them
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
    job = (await api('GET', `/api/packs/status?trust=${PK.trust ? 1 : 0}`)).job;
    while (job.running) {
      if (gen !== PK.statusGen || S.view !== 'packs') return;
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
  if (S.view === 'packs') paintPacks();
}

function paintPacks() {
  if (S.view !== 'packs') return;
  const c = $('content');
  c.innerHTML = '';
  const box = el('div', 'scope pk');
  box.appendChild(pageHeading('Skill packs'));
  box.appendChild(el('p', 'pk-promise', 'The studio sets how its own packs behave here. Everything else it shows and edits as files.'));
  if (PK.error) {
    const n = el('div', 'notice error pk-error');
    n.setAttribute('role', 'alert');
    n.appendChild(el('div', null, `The packs could not be read: ${PK.error}`));
    const retry = el('button', 'btn', 'Try again');
    retry.onclick = () => pkLoad();
    n.appendChild(retry);
    box.appendChild(n);
    c.appendChild(box);
    return;
  }
  if (!PK.data) { c.appendChild(box); return; }
  const legacy = PK.status?.legacy?.length ? PK.status.legacy : PK.data.legacy;
  if (legacy.length) box.appendChild(el('div', 'notice warn pk-legacy', `An earlier review-gate install is here (${legacy.join(', ')}). The packs installer does not migrate it; the review script still reads the older log and config locations.`));
  box.appendChild(pkHere());
  // One quiet line: when status was checked, the Codex trust check, and Refresh. No fold.
  const status = el('div', 'pk-status');
  status.id = 'pk-status';
  box.appendChild(status);
  const todo = pkTodo();
  if (todo) box.appendChild(todo);
  for (const pack of PK.data.packs) box.appendChild(pkCardView(pack));
  c.appendChild(box);
  pkPaintStatus();
}

/** The status bar: running with its progress, or when it was checked and a refresh. */
function pkPaintStatus() {
  const s = $('pk-status');
  if (!s || S.view !== 'packs') return;
  s.innerHTML = '';
  const line = el('div', 'pk-status-line');
  if (PK.job) {
    line.appendChild(el('span', 'spinner'));
    const last = PK.job.progress?.at(-1)?.message || 'starting the status check…';
    const live = el('span', 'pk-status-text', `${last} (${Math.round((PK.job.elapsedMs || 0) / 1000)} s)`);
    live.setAttribute('aria-live', 'polite');
    line.appendChild(live);
  } else {
    const when = PK.status?.checkedAt ? new Date(PK.status.checkedAt).toLocaleTimeString() : null;
    line.appendChild(el('span', 'pk-status-text', when
      ? `Status checked at ${when}${PK.status.trust ? ', with the Codex trust check' : ', without the Codex trust check'}.`
      : 'Status not checked yet.'));
  }
  // On the same line: the trust check (its cost behind an (i)), then Refresh.
  const trust = pkCheck('Include the Codex ', PK.trust, (v) => { PK.trust = v; });
  trust.querySelector('span').appendChild(glossTip('trust', 'trust check'));
  trust.querySelector('input').disabled = !!PK.job;
  if (PK.job) trust.title = 'Wait for the status check to finish';
  line.appendChild(trust);
  if (!PK.job) {
    const again = el('button', 'btn ghost', 'Refresh status');
    again.onclick = () => pkCheckStatus();
    line.appendChild(again);
  }
  s.appendChild(line);
  if (PK.job?.progress?.length > 1) {
    const ul = el('ul', 'pk-progress');
    for (const p of PK.job.progress) ul.appendChild(el('li', null, p.message));
    s.appendChild(ul);
  }
  if (PK.statusError) {
    const n = el('div', 'notice error');
    n.setAttribute('role', 'alert');
    n.textContent = `The status check failed: ${PK.statusError}`;
    s.appendChild(n);
  }
}

/** Each CLI as Home and Setup see it: installed or not, nothing else (a PATH gap shows in the need it blocks). */
function pkHere() {
  const row = el('div', 'pk-here');
  row.appendChild(el('span', 'pk-here-title', 'On this machine:'));
  for (const h of PK.data.harnesses) {
    const on = h.installed ?? h.present;
    const chip = el('span', `pk-harness ${on ? 'on' : 'off'}`, `${on ? '✓' : '—'} ${h.label}`);
    row.appendChild(chip);
    // Only "not installed" or "only its folder": an installed CLI's gaps show where they block (Install-for row, needs).
    const note = h.note || (!h.present && !h.installed ? h.why : null);
    if (note) row.appendChild(el('span', 'pk-harness-why', note));
  }
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
/** A fix as one short phrase for a card: "Needs …". */
function pkNeedText(fix) {
  const r = fix.reqs[0];
  if (r.dep) return `the ${pkPack(r.dep)?.title || r.dep} pack first`;
  // Off the search path, not missing: the CLIs it names are installed. Said once at the top (pkShared), so rarely here.
  if (fix.key === 'path') return `commands on your search path: ${pkNames(fix).join(', ')}`;
  return PK_NEED_SHORT[r.id] || r.what;
}
/** A fix as the top block lists it: what to do, then how. */
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
/** A card's "What it needs": what is met, then each missing fix once (the PATH problems as one item). */
function pkNeedsList(pack) {
  return [...pack.requirements.filter((r) => r.ok), ...pkFixes(pack).map((f) => ({ ok: false, ...pkFixItem(f) }))];
}
/** Fixes every pack needs: checked once at the top, never repeated on a card. */
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
  // The search-path fix is one machine fix, whichever packs it blocks: said once at the top, with every name,
  // never repeated on each card (final critique P2-2).
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

/** "To use packs: do these 2 things": only what every pack needs. */
function pkTodo() {
  const shared = pkShared();
  if (!shared.size) return null;
  const box = el('div', 'pk-todo');
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', 'What packs need');
  box.appendChild(el('div', 'pk-todo-title', shared.size === 1 ? 'To use packs: do this one thing' : `To use packs: do these ${shared.size} things`));
  const ol = el('ol', 'pk-todo-list');
  for (const f of shared.values()) {
    const item = pkFixItem(f);
    const li = el('li', null, item.what);
    li.appendChild(el('div', 'pk-fix', `Fix: ${item.fix}`));
    // Said once for every pack it blocks — and how many that is, when it is not all of them.
    if (f.blocked && f.blocked < f.of) li.appendChild(el('div', 'pk-fix', `Needed by ${f.blocked} of ${f.of} packs.`));
    ol.appendChild(li);
  }
  box.appendChild(ol);
  return box;
}

/** Children with a space between them, so the text reads (and copies) as words, not run together. */
function pkJoin(parent, ...kids) {
  kids.forEach((k, i) => { if (i) parent.appendChild(document.createTextNode(' ')); parent.appendChild(k); });
  return parent;
}
const pkBtn = (cls, text, fn, disabled = false) => { const b = el('button', `btn ${cls}`, text); b.onclick = fn; b.disabled = disabled; return b; };
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

/** What it is, day to day, what it changes, how to undo it — the CLI's explain, in the same words; a pack's adds what it needs. */
function pkExplainBody(e, reqs = null, undoCmd = null) {
  const dl = el('div', 'pk-explain-body');
  const field = (label, text) => { if (!text) return; const p = el('p'); p.appendChild(el('strong', null, `${label}: `)); p.appendChild(document.createTextNode(text)); dl.appendChild(p); };
  field('What it is', e?.what);
  field('Day to day', e?.does);
  if (e?.changes?.length) {
    dl.appendChild(el('strong', null, 'What it changes:'));
    const ul = el('ul');
    for (const ch of e.changes) ul.appendChild(el('li', null, ch));
    dl.appendChild(ul);
  }
  field('How to undo it', e?.undo);
  if (undoCmd) { const p = el('p'); p.appendChild(el('strong', null, 'Command: ')); p.appendChild(el('code', null, undoCmd)); dl.appendChild(p); }
  if (reqs?.length) {
    dl.appendChild(el('strong', null, 'What it needs:'));
    const ul = el('ul', 'pk-reqs');
    for (const r of reqs) {
      const li = el('li', r.ok ? 'ok' : 'missing', `${r.ok ? '✓' : '✖'} ${r.what}`);
      if (!r.ok) li.appendChild(el('span', 'pk-fix', ` — fix: ${r.fix}`));
      ul.appendChild(li);
    }
    dl.appendChild(ul);
  }
  return dl;
}

/**
 * A modal dialog over the page (Packs has no folds): focus moves in and stays in
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
    // The card may have repainted under the dialog: find its button again.
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

/** A card's files and undo: one muted line, and the full list (pack and every part) in a dialog. */
function pkFilesAndUndo(pack) {
  const cmd = `acs packs uninstall ${pack.id}`;
  const n = pack.explain?.changes?.length || 0;
  const row = el('div', 'pk-changes-row');
  row.appendChild(el('span', 'pk-changes', `Changes ${n} place${n === 1 ? '' : 's'} · undo: ${cmd}`));
  const b = el('button', 'btn pk-files-btn', 'Files and undo');
  b.setAttribute('aria-haspopup', 'dialog');
  b.onclick = () => {
    const body = el('div', 'pk-dialog-body');
    body.appendChild(pkExplainBody(pack.explain, pkNeedsList(pack), cmd));
    if (pack.parts.length) {
      body.appendChild(el('h3', 'pk-dialog-sub', 'Parts'));
      for (const part of pack.parts) {
        const sec = el('div', 'pk-dialog-part');
        sec.appendChild(el('h4', null, part.title));
        sec.appendChild(pkExplainBody(part.explain));
        body.appendChild(sec);
      }
    }
    pkDialog(`${pack.title}: files and undo`, body, b, () => document.querySelector(`[data-pack="${pack.id}"]`)?.querySelector('.pk-files-btn'));
  };
  row.appendChild(b);
  return row;
}

/** A part in plain words: the first sentence of what it is. */
const pkPlain = (text) => (/^[\s\S]*?[.!?](?=\s|$)/.exec(String(text || '').trim())?.[0] || String(text || '').trim());
const pkCliNames = (ids) => ids.map((h) => pkHarness(h)?.label || h).join(' and ');

const pkStatusOf = (pack, partId) => PK.status?.packs.find((p) => p.id === pack.id)?.parts.find((x) => x.id === partId) || null;
/** A status word's kind (installed, edited, update, broken, newHarness, absent), for its colour. */
const pkKind = (s) => Object.keys(PK.data?.words?.status || {}).find((k) => PK.data.words.status[k] === s) || 'other';

function pkCardView(pack) {
  const card = pkCard(pack);
  const sec = el('section', 'pk-card');
  sec.dataset.pack = pack.id;
  const head = el('div', 'pk-head');
  head.appendChild(el('h3', null, pack.title));
  if (pack.workflow?.command) head.appendChild(el('span', 'cmd', pack.workflow.command));
  const inst = pack.installed;
  head.appendChild(el('span', `pk-badge ${inst ? 'installed' : 'absent'}`, inst
    ? `installed ${inst.version}${inst.version !== pack.version ? ` (version ${pack.version} is available)` : ''}`
    : 'not installed'));
  // Ready, or the one thing it still needs (the full list is in the explain).
  // Ready, its single most important missing fix, or — when only shared fixes are left — a pointer to them.
  const fixes = pkFixes(pack);
  const shared = pkShared();
  const own = fixes.filter((f) => !shared.has(f.key));
  head.appendChild(!fixes.length ? el('span', 'pk-ready ok', '✓ Ready')
    : own.length ? el('span', 'pk-ready missing', 'Setup needed')
      : el('span', 'pk-ready later', 'Not ready — see “To use packs” above'));
  sec.appendChild(head);
  sec.appendChild(el('p', 'pk-summary', pack.summary));
  // The workflow first: what runs, and who or what does each step (B3).
  if (pack.workflow) {
    sec.appendChild(wfDiagram(pack.workflow, {
      roles: PK.roles, rolesError: PK.rolesError, settings: PK.data.settings || {},
      installedParts: new Set(Object.keys(pack.installed?.parts || {})), pickedParts: card.parts,
      variant: card.variant, onVariant: (v) => { card.variant = v; paintPacks(); },
    }));
    // Under the diagram: the roles it names that are not chosen yet.
    const unset = pkUnsetLine(pack.workflow);
    if (unset) sec.appendChild(unset);
  }
  if (pack.id === 'review-gate') sec.appendChild(pkSettingsView(pack));
  if (pack.id === 'build') {
    const cross = PK_CROSS_MODES.find(([m]) => m === (PK.data.settings?.crossFamily || 'prefer'))[1];
    sec.appendChild(el('p', 'pk-cross-note', `The Grade's vendor swap follows Cross-vendor checks in the review gate's settings (now: ${cross}).`));
  }
  // What this pack still needs, in full (the head says only "Setup needed").
  if (own.length) sec.appendChild(el('p', 'pk-need', `Needs ${pkNeedText(own[0])}`));
  sec.appendChild(pkFilesAndUndo(pack));
  const busy = !!card.busy;
  for (const r of pack.requirements.filter((x) => x.dep && !x.ok)) {
    const dep = pkPack(r.dep);
    sec.appendChild(pkCheck(`Also install the ${dep?.title || r.dep} pack's skill now — ${pack.title} needs it: its gate commands run the review gate's review.mjs`, card.withDeps,
      (v) => { card.withDeps = v; pkDrop(card); paintPacks(); }, { disabled: busy }));
  }

  sec.appendChild(el('div', 'pk-label', 'Parts'));
  const parts = el('div', 'pk-parts');
  for (const part of pack.parts) parts.appendChild(pkPartView(pack, part, card));
  sec.appendChild(parts);

  const hs = pkHarnesses(pack);
  if (hs.length) {
    const row = el('div', 'pk-harnesses');
    row.appendChild(el('span', 'pk-label-inline', 'Install for:'));
    for (const id of hs) {
      const h = pkHarness(id);
      const usable = pkUsable(id);
      const on = usable && (card.harnesses ? card.harnesses.has(id) : true);
      const label = `${h?.label || id}${id === 'claude' && !h?.present && usable ? ' skills folder (for Grok, which reads it)' : ''} (${h?.home || ''})`;
      const why = busy ? 'Wait for the current preview or install to finish' : usable ? null : `${h?.label || id}: ${h?.why}`;
      row.appendChild(pkCheck(label, on, (v) => {
        const now = new Set(card.harnesses || hs.filter(pkUsable));
        if (v) now.add(id); else now.delete(id);
        card.harnesses = hs.filter(pkUsable).every((x) => now.has(x)) ? null : now;
        pkDrop(card); paintPacks();
      }, { disabled: !usable || busy, title: why }));
      if (!usable && h?.why) row.appendChild(el('span', 'pk-harness-why', `${h.label}: ${h.why}`));
    }
    sec.appendChild(row);
  }

  const actions = el('div', 'pk-actions');
  const picked = [...card.parts];
  const harnessesOk = !card.harnesses || card.harnesses.size > 0;
  const why = !picked.length ? 'Pick at least one part to install.' : !harnessesOk ? 'Pick at least one CLI to install for.' : null;
  const prev = pkBtn('', `Preview install${picked.length ? ` (${plural(picked.length, 'part')})` : ''}`, () => pkPreview(pack, 'install'), busy || !!why);
  actions.appendChild(prev);
  if (inst) {
    actions.appendChild(pkBtn('', 'Preview update', () => pkPreview(pack, 'update'), busy));
    actions.appendChild(pkBtn('danger', 'Preview uninstall', () => pkPreview(pack, 'uninstall'), busy));
  }
  // A disabled button says why, beside it — not only in a tooltip.
  const blocked = why || (busy && card.busy !== 'plan' ? 'Working — wait for it to finish.' : null);
  if (blocked) {
    for (const b of actions.querySelectorAll('button')) if (b.disabled) b.title = blocked;
    actions.appendChild(el('span', 'pk-why', blocked));
  }
  if (card.busy === 'plan') { const s = el('span', 'pk-busy'); s.appendChild(el('span', 'spinner')); s.appendChild(el('span', null, ' Working out what would change…')); actions.appendChild(s); }
  sec.appendChild(actions);

  if (card.error) {
    const n = el('div', 'notice error pk-error');
    n.setAttribute('role', 'alert');
    n.appendChild(el('div', null, card.error.message));
    if (card.error.log?.length) pkLog(n, card.error.log);
    sec.appendChild(n);
  }
  if (card.preview) sec.appendChild(pkPreviewView(pack, card));
  if (card.result) sec.appendChild(pkResultView(card));
  return sec;
}

function pkPartView(pack, part, card) {
  const row = el('div', 'pk-part');
  row.dataset.part = part.id;
  const top = el('div', 'pk-part-top');
  top.appendChild(pkCheck(part.title, card.parts.has(part.id), (v) => {
    if (v) card.parts.add(part.id); else card.parts.delete(part.id);
    pkDrop(card); paintPacks();
  }, { disabled: !!card.busy }));
  top.appendChild(document.createTextNode(' '));
  top.appendChild(el('span', 'pk-part-meta', `${part.harnesses.length ? `For ${pkCliNames(part.harnesses)} · ` : ''}${part.default ? 'on by default' : 'off unless you pick it'}`));
  const st = pkStatusOf(pack, part.id);
  const statuses = st?.statuses || [pkInstalled(pack, part.id) ? PK.data.words.status.installed : PK.data.words.status.absent];
  const badges = el('span', 'pk-badges');
  const hsNow = st?.harnesses?.length ? st.harnesses : pack.installed?.parts?.[part.id]?.harnesses || [];
  pkJoin(badges, ...statuses.map((x) => el('span', `pk-badge ${pkKind(x)}`, x)), ...(hsNow.length ? [el('span', 'chip-mini', `for ${hsNow.join(', ')}`)] : []));
  top.appendChild(document.createTextNode(' '));
  top.appendChild(badges);
  row.appendChild(top);
  row.appendChild(el('div', 'pk-part-what', pkPlain(part.explain?.what)));
  const lines = [...Object.entries(st?.harness || {}).map(([h, s]) => `${h}: ${s}`), ...(st?.details || [])];
  if (lines.length) {
    const ul = el('ul', 'pk-details');
    for (const l of lines) ul.appendChild(el('li', null, l));
    row.appendChild(ul);
  }
  // A part's full explain is in the card's "Files and undo" dialog: no fold here.
  if (pkInstalled(pack, part.id) && Object.keys(pack.installed.parts).length > 1) {
    const foot = el('div', 'pk-part-foot');
    foot.appendChild(pkBtn('ghost pk-part-remove', 'Preview uninstalling this part', () => pkPreview(pack, 'uninstall', { parts: [part.id] }), !!card.busy));
    row.appendChild(foot);
  }
  return row;
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
  ['standard', 'Low-risk PRs', 'An agent may merge any low-risk PR.'],
  ['always', 'Low and medium-risk PRs', 'An agent may merge low- and medium-risk PRs: medium-risk code merges without you. High-risk always waits for you.'],
];
const PK_CROSS_MODES = [
  ['prefer', 'Prefer another vendor', 'Reviews and grades use a model from another vendor when one is available; never a blocker.'],
  ['off', 'Off', 'Any reviewer in your roles may check any work.'],
];
/**
 * The section's state. `draft` holds every change picked but not saved ({ key: value } over the writer's
 * allow-list): one preview covers them all, and Save writes them in one request with one backup.
 * `paths` is the box's text while it differs from what is saved.
 */
const PK_SEC = { draft: {}, paths: null, preview: null, busy: false, error: null, result: null, seq: 0 };
const pkSaved = () => {
  const s = PK.data.settings || {};
  return { 'security.run': s.security || 'off', 'merge.policy': s.merge?.policy || 'off', 'merge.alwaysHuman': s.merge?.alwaysHuman || [], crossFamily: s.crossFamily || 'prefer' };
};
const pkPicked = (key) => (Object.hasOwn(PK_SEC.draft, key) ? PK_SEC.draft[key] : pkSaved()[key]);
const pkPathsOf = (text) => [...new Set(String(text || '').split('\n').map((l) => l.trim()).filter(Boolean))];
const pkLabelOf = {
  'security.run': (v) => PK_SEC_LEVELS.find(([l]) => l === v)?.[1] || v,
  'merge.policy': (v) => PK_MERGE_POLICIES.find(([l]) => l === v)?.[1] || v,
  'merge.alwaysHuman': (v) => (v.length ? `${v.length} path${v.length === 1 ? '' : 's'} of your own` : 'no paths of your own'),
  crossFamily: (v) => PK_CROSS_MODES.find(([l]) => l === v)?.[1] || v,
};
const PK_SETTING_NAME = { 'security.run': 'security pass', 'merge.policy': 'agent merge', 'merge.alwaysHuman': 'always needs you', crossFamily: 'cross-vendor checks' };
/** “When code changes”, or “Low-risk PRs” (agent merge) and “Off” (cross-vendor checks) when more than one changed. */
function pkSaysText(changes) {
  const keys = Object.keys(changes);
  if (keys.length === 1) return `“${pkLabelOf[keys[0]](changes[keys[0]])}”`;
  const parts = keys.map((k) => `“${pkLabelOf[k](changes[k])}” (${PK_SETTING_NAME[k]})`);
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** "After Save: …" while a pick for `key` waits in the preview, so Now (the saved value) and the pressed button never seem to disagree. */
function pkAfterSave(options, key) {
  if (!PK_SEC.preview || !Object.hasOwn(PK_SEC.preview.changes, key)) return null;
  const line = options.find(([v]) => v === PK_SEC.preview.changes[key]);
  return line ? el('p', 'pk-sec-after', `After Save: ${line[2]}`) : null;
}

/** A row of choices with the line saying what each does; the picked one (saved, or waiting in the preview) is pressed. */
function pkChoices(options, key, { rowClass = '' } = {}) {
  const now = pkPicked(key);
  const wrap = el('div');
  const row = el('div', `pk-choice-row${rowClass ? ` ${rowClass}` : ''}`);
  for (const [value, label] of options) {
    const b = pkBtn(value === now ? 'pk-sec-on' : '', label, () => pkPick(key, value), PK_SEC.busy);
    b.setAttribute('aria-pressed', String(value === now));
    b.dataset.level = value;
    row.appendChild(b);
  }
  wrap.appendChild(row);
  return wrap;
}
function pkChoiceLines(options, key) {
  const now = pkPicked(key);
  const ul = el('ul', 'pk-choice-lines');
  for (const [value, label, line] of options) {
    const li = el('li', value === now ? 'on' : null);
    li.appendChild(el('strong', null, `${label}: `));
    li.appendChild(el('span', null, line));
    ul.appendChild(li);
  }
  return ul;
}

/**
 * The review gate card's Settings: the security pass, agent merge, the paths that always need you and
 * cross-vendor checks. Only with the code-review part installed: it ships the scripts that read them.
 */
function pkSettingsView(pack) {
  if (!pack.installed?.parts?.['code-review']) {
    return el('p', 'pk-settings-none', 'Install the Code review part to set the security pass, agent merge and cross-vendor checks here.');
  }
  const s = PK.data.settings || {};
  const box = el('div', 'pk-sec pk-settings');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Review gate settings');

  const secBox = el('div', 'pk-setting pk-security');
  secBox.appendChild(el('div', 'pk-label', 'Security pass in PR reviews'));
  secBox.appendChild(pkChoices(PK_SEC_LEVELS, 'security.run', { rowClass: 'pk-sec-levels' }));
  secBox.appendChild(el('p', 'pk-sec-now', `Now: ${PK_SEC_LEVELS.find(([l]) => l === (s.security || 'off'))[2]} /security-check runs on its own either way.`));
  const secAfter = pkAfterSave(PK_SEC_LEVELS, 'security.run');
  if (secAfter) secBox.appendChild(secAfter);
  box.appendChild(secBox);

  const mg = el('div', 'pk-setting pk-merge');
  mg.appendChild(el('div', 'pk-label', 'Agent merge'));
  mg.appendChild(pkChoices(PK_MERGE_POLICIES, 'merge.policy'));
  mg.appendChild(pkChoiceLines(PK_MERGE_POLICIES, 'merge.policy'));
  const policyNow = PK_MERGE_POLICIES.find(([p]) => p === (s.merge?.policy || 'off'))[2];
  mg.appendChild(el('p', 'pk-sec-now', `Now: ${policyNow} Agent merge needs the gh CLI, and a repo with no CI checks always waits for you.`));
  const mergeAfter = pkAfterSave(PK_MERGE_POLICIES, 'merge.policy');
  if (mergeAfter) mg.appendChild(mergeAfter);
  mg.appendChild(el('p', 'pk-sec-now', 'An agent merges only through merge.mjs, and only when the review is closed at the tip, CI is green and nobody asked for changes.'));
  mg.appendChild(pkPathsView(s.merge || {}));
  mg.appendChild(el('p', 'pk-help', 'Saved as merge.policy and merge.alwaysHuman in your home review config.'));
  box.appendChild(mg);

  const cf = el('div', 'pk-setting pk-cross');
  cf.appendChild(el('div', 'pk-label', 'Cross-vendor checks'));
  cf.appendChild(pkChoices(PK_CROSS_MODES, 'crossFamily'));
  cf.appendChild(pkChoiceLines(PK_CROSS_MODES, 'crossFamily'));
  cf.appendChild(el('p', 'pk-help', 'Saved as crossFamily in your home review config.'));
  box.appendChild(cf);

  box.appendChild(pkOtherSettings(s.reviewConfig));
  pkSettingsFoot(box);
  return box;
}

/** Always needs you: the review script's built-ins and risky paths, read-only, then your own, one per line. */
function pkPathsView(merge) {
  const wrap = el('div', 'pk-paths');
  wrap.appendChild(el('div', 'pk-label pk-sub', 'Always needs you'));
  wrap.appendChild(el('p', 'pk-help', 'A change to any of these paths is high-risk, so no agent merges it.'));
  wrap.appendChild(el('p', 'pk-fixed', `Built in: ${(merge.builtIn || []).join(', ')}`));
  const from = merge.riskPathsFrom === 'config' ? 'from your review config' : 'the review gate\'s defaults';
  wrap.appendChild(el('p', 'pk-fixed', `Risky paths (${from}): ${(merge.riskPaths || []).join(', ')}`));
  const ta = el('textarea', 'pk-paths-box');
  ta.rows = 3;
  ta.value = PK_SEC.paths ?? (pkPicked('merge.alwaysHuman') || []).join('\n');
  ta.placeholder = 'infra/**';
  ta.setAttribute('aria-label', 'Your own paths that always need you, one per line');
  ta.disabled = PK_SEC.busy;
  ta.oninput = () => { PK_SEC.paths = ta.value; };
  wrap.appendChild(el('div', 'pk-label-inline', 'Your own paths, one per line:'));
  wrap.appendChild(ta);
  const acts = el('div', 'pk-actions');
  acts.appendChild(pkBtn('', 'Preview', () => { PK_SEC.paths = ta.value; pkPick('merge.alwaysHuman', pkPathsOf(ta.value)); }, PK_SEC.busy));
  wrap.appendChild(acts);
  return wrap;
}

/** "Other review settings live in <file>", opening it in Files when Files lists it. */
function pkOtherSettings(rc) {
  const line = el('p', 'pk-other');
  if (!rc?.file) return line;
  line.appendChild(el('span', null, `Other review settings live in ${rc.file}.`));
  // Files lists only what its registry found; ~/.agent-config-studio is outside its folders, so that copy is named only.
  const entry = rc.exists ? (S.registry?.groups || []).flatMap((g) => g.entries).find((e) => e.files.some((f) => f.display === rc.file)) : null;
  if (entry) {
    line.appendChild(document.createTextNode(' '));
    line.appendChild(pkBtn('ghost', 'Open in Files', () => openEntry(entry, entry.files.find((f) => f.display === rc.file).path, 'packs')));
  }
  return line;
}

/** Busy, the error, the one preview with Save and Cancel, and the saved line. */
function pkSettingsFoot(box) {
  if (PK_SEC.busy) { const s = el('span', 'pk-busy'); s.appendChild(el('span', 'spinner')); s.appendChild(el('span', null, ' Working…')); box.appendChild(s); }
  if (PK_SEC.error) {
    const n = el('div', 'notice error');
    n.setAttribute('role', 'alert');
    n.textContent = PK_SEC.error;
    box.appendChild(n);
  }
  const p = PK_SEC.preview;
  if (p) {
    const pre = el('div', 'pk-sec-preview');
    pre.setAttribute('role', 'region');
    pre.setAttribute('aria-label', 'Review gate settings preview');
    if (p.refreshed) pre.appendChild(el('p', 'pk-refreshed', 'The list changed since the preview; check the new preview and Save again.'));
    pre.appendChild(el('p', null, p.view.changes
      ? `Set to ${pkSaysText(p.changes)}: this changes ${p.view.file}${p.view.exists ? ', and a copy of it goes to the backups folder first' : ' (a new file)'}.`
      : `${p.view.file} already says ${pkSaysText(p.changes)}. Nothing to change.`));
    if (p.view.changes) pre.appendChild(pkSecurityDiff(p.view.diff));
    const acts = el('div', 'pk-actions');
    if (p.view.changes) acts.appendChild(pkBtn('primary', 'Save', () => pkSettingsApply(), PK_SEC.busy));
    acts.appendChild(pkBtn('ghost', 'Cancel', () => { PK_SEC.draft = {}; PK_SEC.paths = null; PK_SEC.preview = null; PK_SEC.seq++; paintPacks(); }, PK_SEC.busy));
    pre.appendChild(acts);
    box.appendChild(pre);
  }
  if (PK_SEC.result) {
    const r = PK_SEC.result;
    const after = !r.changed ? '' : r.backupDir ? ` The old file is at ${r.backupDir}.` : ' No existing file needed a backup.';
    box.appendChild(el('div', 'notice pk-result', `Saved: ${r.file} now says ${pkSaysText(r.saved)}.${after}`));
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
/** The paths box as it is on screen, into the draft: typed text counts whatever was clicked, so nothing on screen is left out of a preview. */
function pkDraftPaths() {
  const ta = $('content')?.querySelector('.pk-paths-box');
  if (ta) PK_SEC.paths = ta.value;
  if (PK_SEC.paths !== null) pkDraftSet('merge.alwaysHuman', pkPathsOf(PK_SEC.paths));
}

/** Add a pick to the draft (or drop it when it is what is saved), then preview every pending change at once. */
async function pkPick(key, value) {
  pkDraftPaths();
  if (key !== 'merge.alwaysHuman' || PK_SEC.paths === null) pkDraftSet(key, value);
  return pkReplan();
}

/** Preview the whole draft as it stands. */
async function pkReplan({ refreshed = false } = {}) {
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
  if (seq === PK_SEC.seq) PK_SEC.busy = false;
  paintPacks();
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
  } catch (e) { if (seq === PK_SEC.seq) PK_SEC.error = e.message; }
  if (seq === PK_SEC.seq) PK_SEC.busy = false;
  paintPacks();
}

/** The request the card describes for `action`: exactly what the preview and the apply send. */
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

/** Ask for the plan; a fresh preview starts with the preview-only offers (roles, replace) unticked. */
async function pkPreview(pack, action, extra = {}, { keepOffers = false } = {}) {
  const card = pkCard(pack);
  if (!keepOffers) { card.setRoles = {}; card.replace = false; }
  pkDrop(card);
  card.result = null;
  card.busy = 'plan';
  const seq = card.seq;
  paintPacks();
  const body = pkBody(pack, action, card, extra);
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

function pkPreviewView(pack, card) {
  const { action, view } = card.preview;
  const box = el('div', `pk-preview pk-preview-${action}`);
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', `${PK_VERB[action]} preview`);
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
      if (r.note) li.appendChild(el('span', 'pk-note', ` — ${r.note}`));
      return li;
    });
  }
  if (settings.length) {
    box.appendChild(el('div', 'pk-label', 'Settings'));
    list('pk-rows', settings, (r) => pkJoin(el('li', 'pk-row'), el('code', 'pk-sym', '~'), el('code', 'pk-path', r.setting)));
  }
  list('pk-warnings', view.warnings, (w) => el('li', null, `warning: ${w}`));
  list('pk-kept', view.kept, (k) => el('li', null, `kept: ${k.path} — ${k.why}`));
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

  const bar = el('div', 'pk-actions');
  const can = view.changes && !view.refusals.length;
  const go = pkBtn(action === 'uninstall' ? 'danger pk-apply' : 'primary pk-apply', card.busy === 'apply' ? `${PK_VERB[action].replace(/e$/, '')}ing…` : PK_VERB[action], () => pkApply(pack), !can || !!card.busy);
  bar.appendChild(go);
  bar.appendChild(pkBtn('ghost', 'Cancel', () => { pkDrop(card); paintPacks(); }, card.busy === 'apply'));
  if (card.busy === 'apply') bar.appendChild(el('span', 'spinner'));
  box.appendChild(bar);
  if (can) box.appendChild(el('div', 'pk-note', `${PK_VERB[action]} applies exactly this preview. If anything on disk changes first, it stops and asks you to preview again.`));
  return box;
}

async function pkApply(pack) {
  const card = pkCard(pack);
  if (!card.preview || card.busy) return;
  const { action, body, view } = card.preview;
  card.busy = 'apply';
  card.error = null;
  paintPacks();
  try {
    const r = await api('POST', '/api/packs/apply', { ...body, signature: view.signature });
    card.result = { action, r };
    card.preview = null;
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
  const list = (items, fmt) => { if (!items?.length) return; const ul = el('ul'); for (const x of items) ul.appendChild(el('li', null, fmt(x))); n.appendChild(ul); };
  list(r.kept, (k) => `kept: ${k.path} — ${k.why}`);
  list(r.notes, (x) => `note: ${x}`);
  list(r.warnings, (x) => `warning: ${x}`);
  if (r.log?.length) pkLog(n, r.log);
  const close = pkBtn('ghost', 'Dismiss', () => { card.result = null; paintPacks(); });
  n.appendChild(close);
  return n;
}

/** The installers' output: a button to a dialog, not a fold. */
function pkLog(box, lines) {
  const b = el('button', 'btn pk-log-btn', 'Installer output');
  b.setAttribute('aria-haspopup', 'dialog');
  b.onclick = () => {
    const body = el('div', 'pk-dialog-body');
    body.appendChild(el('pre', 'pk-log', lines.join('\n')));
    // The post-install status check repaints the card under the dialog: find its new button by the pack it sits in.
    let k = b;
    while (k && !k.dataset?.pack) k = k.parentNode;
    const id = k?.dataset?.pack;
    pkDialog('Installer output', body, b, () => (id ? document.querySelector(`[data-pack="${id}"]`)?.querySelector('.pk-log-btn') : null));
  };
  box.appendChild(b);
}
