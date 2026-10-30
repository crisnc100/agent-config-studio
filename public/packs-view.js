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
const PK = { data: null, error: null, status: null, statusError: null, job: null, trust: true, statusGen: 0, cards: {} };
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
  PK.cards[pack.id] ||= { parts: new Set(pkDefaults(pack)), harnesses: null, withDeps: false, setRoles: {}, replace: false, preview: null, busy: null, result: null, error: null, seq: 0 };
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
  await pkLoad();
  if (S.view === 'packs' && PK.data) pkCheckStatus();
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
  box.appendChild(el('h2', null, 'Skill packs'));
  box.appendChild(el('div', 'scope-sub', 'Ready-made skills, and for some packs the scripts and settings they need. Each pack says what it is, what it '
    + 'changes and how to undo it. Nothing is written until you preview a change and press the button under that preview.'));
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
  const status = el('div', 'pk-status');
  status.id = 'pk-status';
  box.appendChild(status);
  box.appendChild(pkHere());
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
    const again = el('button', 'btn', 'Refresh status');
    again.onclick = () => pkCheckStatus();
    line.appendChild(again);
  }
  s.appendChild(line);
  const trust = pkCheck('Include the Codex trust check (it starts codex app-server once per Codex home; slower)', PK.trust, (v) => { PK.trust = v; });
  trust.querySelector('input').disabled = !!PK.job;
  s.appendChild(trust);
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

/** Which harnesses this machine has, the way the installer decides it. */
function pkHere() {
  const row = el('div', 'pk-here');
  row.appendChild(el('span', 'pk-here-title', 'On this machine:'));
  for (const h of PK.data.harnesses) {
    const chip = el('span', `pk-harness ${h.present ? 'on' : 'off'}`, `${h.present ? '✓' : '—'} ${h.label}`);
    chip.title = h.present ? `${h.cli ? 'CLI on PATH' : 'no CLI on PATH'}; ${h.home}` : h.why;
    row.appendChild(chip);
    if (!h.present) row.appendChild(el('span', 'pk-harness-why', h.why));
  }
  return row;
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

/** What it is, day to day, what it changes, how to undo it — the CLI's explain, in the same words. */
function pkExplain(e, summary) {
  const d = el('details', 'pk-explain');
  d.appendChild(el('summary', null, summary));
  const dl = el('div', 'pk-explain-body');
  const field = (label, text) => { const p = el('p'); p.appendChild(el('strong', null, `${label}: `)); p.appendChild(document.createTextNode(text)); dl.appendChild(p); };
  field('What it is', e.what);
  field('Day to day', e.does);
  dl.appendChild(el('strong', null, 'What it changes:'));
  const ul = el('ul');
  for (const ch of e.changes) ul.appendChild(el('li', null, ch));
  dl.appendChild(ul);
  field('How to undo it', e.undo);
  d.appendChild(dl);
  return d;
}

const pkStatusOf = (pack, partId) => PK.status?.packs.find((p) => p.id === pack.id)?.parts.find((x) => x.id === partId) || null;
/** A status word's kind (installed, edited, update, broken, newHarness, absent), for its colour. */
const pkKind = (s) => Object.keys(PK.data?.words?.status || {}).find((k) => PK.data.words.status[k] === s) || 'other';

function pkCardView(pack) {
  const card = pkCard(pack);
  const sec = el('section', 'pk-card');
  sec.dataset.pack = pack.id;
  const head = el('div', 'pk-head');
  head.appendChild(el('h3', null, pack.title));
  head.appendChild(el('span', 'chip-mini', `${pack.id} ${pack.version}`));
  const inst = pack.installed;
  head.appendChild(el('span', `pk-badge ${inst ? 'installed' : 'absent'}`, inst
    ? `installed ${inst.version}${inst.version !== pack.version ? ` (package has ${pack.version})` : ''}`
    : 'not installed'));
  sec.appendChild(head);
  sec.appendChild(el('p', 'pk-summary', pack.summary));
  sec.appendChild(pkExplain(pack.explain, 'What it is, what it changes, how to undo it'));

  const reqs = el('ul', 'pk-reqs');
  for (const r of pack.requirements) {
    const li = el('li', r.ok ? 'ok' : 'missing', `${r.ok ? '✓' : '✖'} ${r.what}`);
    if (!r.ok) li.appendChild(el('span', 'pk-fix', ` — fix: ${r.fix}`));
    reqs.appendChild(li);
  }
  if (pack.requirements.length) {
    sec.appendChild(el('div', 'pk-label', 'Needs'));
    sec.appendChild(reqs);
  }
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
      row.appendChild(pkCheck(label, on, (v) => {
        const now = new Set(card.harnesses || hs.filter(pkUsable));
        if (v) now.add(id); else now.delete(id);
        card.harnesses = hs.filter(pkUsable).every((x) => now.has(x)) ? null : now;
        pkDrop(card); paintPacks();
      }, { disabled: !usable || busy, title: usable ? null : h?.why }));
      if (!usable && h?.why) row.appendChild(el('span', 'pk-harness-why', `${h.label}: ${h.why}`));
    }
    sec.appendChild(row);
  }

  const actions = el('div', 'pk-actions');
  const picked = [...card.parts];
  const harnessesOk = !card.harnesses || card.harnesses.size > 0;
  const why = !picked.length ? 'Pick at least one part to install.' : !harnessesOk ? 'Pick at least one harness.' : null;
  const prev = pkBtn('', `Preview install${picked.length ? ` (${picked.length} part${picked.length === 1 ? '' : 's'})` : ''}`, () => pkPreview(pack, 'install'), busy || !!why);
  if (why) prev.title = why;
  actions.appendChild(prev);
  if (inst) {
    actions.appendChild(pkBtn('', 'Preview update', () => pkPreview(pack, 'update'), busy));
    actions.appendChild(pkBtn('danger', 'Preview uninstall', () => pkPreview(pack, 'uninstall'), busy));
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
  top.appendChild(el('span', 'pk-part-meta', `${part.id} · ${part.kind}${part.harnesses.length ? ` · ${part.harnesses.join(', ')}` : ''} · ${part.default ? 'on by default' : 'off unless you pick it'}`));
  const st = pkStatusOf(pack, part.id);
  const statuses = st?.statuses || [pkInstalled(pack, part.id) ? PK.data.words.status.installed : PK.data.words.status.absent];
  const badges = el('span', 'pk-badges');
  const hsNow = st?.harnesses?.length ? st.harnesses : pack.installed?.parts?.[part.id]?.harnesses || [];
  pkJoin(badges, ...statuses.map((x) => el('span', `pk-badge ${pkKind(x)}`, x)), ...(hsNow.length ? [el('span', 'chip-mini', `for ${hsNow.join(', ')}`)] : []));
  top.appendChild(document.createTextNode(' '));
  top.appendChild(badges);
  row.appendChild(top);
  const lines = [...Object.entries(st?.harness || {}).map(([h, s]) => `${h}: ${s}`), ...(st?.details || [])];
  if (lines.length) {
    const ul = el('ul', 'pk-details');
    for (const l of lines) ul.appendChild(el('li', null, l));
    row.appendChild(ul);
  }
  const foot = el('div', 'pk-part-foot');
  foot.appendChild(pkExplain(part.explain, 'What this part is and changes'));
  if (pkInstalled(pack, part.id) && Object.keys(pack.installed.parts).length > 1) {
    foot.appendChild(pkBtn('ghost pk-part-remove', 'Preview uninstalling this part', () => pkPreview(pack, 'uninstall', { parts: [part.id] }), !!card.busy));
  }
  row.appendChild(foot);
  return row;
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
    offer.appendChild(el('div', null, `The ${r.role} role uses ${r.use.join(', ') || 'nothing'}, and none of their CLIs is installed here.`));
    if (r.suggestion.length) {
      offer.appendChild(pkCheck(`Set the ${r.role} role to ${r.suggestion.join(', ')} (through ACS's roles; it stays after an uninstall)`, !!r.set, (v) => {
        if (v) card.setRoles = { ...card.setRoles, [r.role]: r.suggestion };
        else { const { [r.role]: _, ...rest } = card.setRoles; card.setRoles = rest; }
        pkPreview(pack, 'install', {}, { keepOffers: true });
      }, { disabled: !!card.busy }));
    } else offer.appendChild(el('div', 'pk-note', 'No installed CLI can run any family; install one.'));
    box.appendChild(offer);
  }
  if (action === 'update' && (view.kept.some((k) => /you edited|you removed|you customised/.test(k.why)) || card.replace)) {
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

function pkLog(box, lines) {
  const d = el('details', 'pk-log');
  d.appendChild(el('summary', null, 'Installer output'));
  d.appendChild(el('pre', null, lines.join('\n')));
  box.appendChild(d);
}
