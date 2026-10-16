/* Agent Config Studio — the skill wizard: Describe → Interview → Where → Review (lib/skill-wizard.js) */

/**
 * Loaded before app.js, which owns the helpers this calls (el, api, notice,
 * renderSidebar…). The wizard's state is per tab: kept in sessionStorage so
 * a reload keeps the draft, best-effort — a blocked storage only costs that.
 *
 * Every model turn carries a sequence number; a reply for an older one is
 * dropped, so an answer edited while a turn runs can never be overwritten by
 * the stale reply. Changing an answer, the name or the destination drops the
 * draft: Review always shows a draft of what is on screen now.
 */
const SW_KEY = 'acs.skillWizard';
const SW_STEPS = [['describe', 'Describe'], ['interview', 'Interview'], ['where', 'Where'], ['review', 'Review']];
const SW_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SW_MAX_Q = 10;

const swFresh = () => ({
  id: [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join(''),
  step: 'describe', description: '', answers: [], current: null, done: null,
  seq: 0, name: '', nameTouched: false, scope: 'global', project: null, picks: {},
  draft: null, note: '', error: null, createSent: false, results: {},
});
let SW = null;
/** Not persisted: what is in flight, the server's targets, and the refused reply behind the error on screen. */
const SWX = { busy: null, info: null, preview: null, editing: null, reply: null };

function swLoad() {
  try { const raw = sessionStorage.getItem(SW_KEY); if (raw) { const s = JSON.parse(raw); if (s && s.id && s.step) return { ...swFresh(), ...s, error: null }; } } catch {}
  return swFresh();
}
function swSave() { try { sessionStorage.setItem(SW_KEY, JSON.stringify(SW)); } catch { /* private mode, blocked */ } }
function swClear() { try { sessionStorage.removeItem(SW_KEY); } catch {} }

/** Same rule as the server's deriveName: a name from the description. */
function swDeriveName(text) {
  const n = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 5).join('-').slice(0, 64).replace(/-+$/, '');
  return SW_NAME_RE.test(n) ? n : 'new-skill';
}

/**
 * Create in flight locks the wizard: no step change, edit, turn or second
 * Create until it answers. And every await re-checks it is still talking to
 * the same wizard — Create's success replaces SW with null.
 */
const swLocked = () => SWX.busy === 'create';
const swLive = (w, seq) => SW === w && !!w && w.seq === seq;

/** Anything that changes what the skill is drops the draft. */
function swInvalidate() { SW.draft = null; SW.createSent = false; if (!swPartial()) SW.results = {}; }

/**
 * Where the skill goes: one destination per ticked box. A box the person has
 * not touched follows the server's default (`on`: every installed harness,
 * never the shared folder); one that cannot be used is never ticked.
 */
const swKey = (d) => JSON.stringify(d);
function swBoxes() {
  const t = SWX.info?.targets;
  if (!t) return [];
  if (SW.scope === 'global') {
    return t.global.map((g) => {
      const usable = g.available && g.installed !== false;
      return { id: g.key, label: `${g.label} — ${g.display}`, usable, why: g.why, checked: usable && (SW.picks[g.key] ?? (g.on ?? g.key !== 'shared')), dest: { scope: 'global', key: g.key } };
    });
  }
  const proj = t.projects.find((x) => x.id === SW.project);
  if (!proj) return [];
  return t.dirs.map((dir) => {
    const d = (t.dirInfo || []).find((x) => x.dir === dir) || { installed: true, on: dir !== '.agents' };
    const has = proj.harnessDirs.includes(dir);
    const usable = d.installed !== false || has;
    const on = d.on || (has && dir !== '.agents');
    return { id: dir, label: `${dir}/skills${has ? '' : ' (will be created)'}`, usable, why: usable ? null : d.why, checked: usable && (SW.picks[dir] ?? on), dest: { scope: 'project', project: proj.id, dir } };
  });
}
const swDests = () => swBoxes().filter((b) => b.checked).map((b) => b.dest);
/** The overlap note for what is ticked now: a harness that reads two of the ticked folders. */
function swOverlap() {
  const ids = new Set(swBoxes().filter((b) => b.checked).map((b) => b.id));
  const ov = (SWX.info?.targets?.overlaps || []).find((o) => (SW.scope === 'global' ? o.global : o.dirs).every((k) => ids.has(k)));
  return ov ? ov.why : null;
}
/** Some destinations already have the skill: what is left must get the same bytes, so the skill is fixed. */
const swPartial = () => Object.values(SW.results || {}).some((r) => r.ok);

async function openSkillWizard() {
  if (!confirmDiscard()) return;
  S.view = 'skill-new';
  leaveEditor();
  window.history.replaceState(null, '', '#skills/new');
  renderSidebar(); renderTopbar(); renderTabs(); renderStatus();
  $('filebar').hidden = true;
  if (!SW) SW = swLoad();
  $('content').innerHTML = '<div class="scope"><div class="scope-sub"><span class="spinner"></span></div></div>';
  try { SWX.info = await api('GET', '/api/skill-wizard'); }
  catch (e) { SWX.info = null; SW.error = `The wizard could not load: ${e.message}`; }
  paintWizard();
  if (SW.step === 'where') swPreview();
  if (SW.step === 'review' && !SW.draft && !SWX.busy) swDraft();
  // Reloaded mid-turn: the question it was waiting for is asked again.
  if (SW.step === 'interview' && !SW.current && !SW.done && !SW.error && !SWX.busy && SW.answers.length < SW_MAX_Q && SWX.info?.backend?.ready) swAsk();
}

function swGo(step) {
  if (!SW || swLocked()) return;
  SW.step = step; SW.error = null; swSave(); paintWizard();
  if (step === 'where') swPreview();
  if (step === 'review' && !SW.draft && !SWX.busy) swDraft();
}

function paintWizard() {
  if (S.view !== 'skill-new') return;
  const c = $('content');
  c.innerHTML = '';
  const box = el('div', 'scope sw');
  const head = el('div', 'sw-head');
  head.appendChild(el('h2', null, 'New skill'));
  const back = el('button', 'btn ghost sw-exit', 'Back to Skills');
  back.onclick = () => { location.hash = '#skills'; };
  back.disabled = swLocked();
  head.appendChild(back);
  box.appendChild(head);
  box.appendChild(swStepper());
  const b = SWX.info?.backend;
  if (b) box.appendChild(el('div', 'scope-note sw-backend', b.ready
    ? `Assist runs ${b.label} ${b.modelLabel || b.model} with no tools. It sees your words and the names and descriptions of your existing skills — never their files.`
    : `The interview is unavailable: ${b.why}`));
  const body = el('div', 'sw-body');
  ({ describe: swDescribe, interview: swInterview, where: swWhere, review: swReview })[SW.step](body);
  box.appendChild(body);
  c.appendChild(box);
}

function swStepper() {
  const nav = el('ol', 'sw-steps');
  const at = SW_STEPS.findIndex(([k]) => k === SW.step);
  SW_STEPS.forEach(([key, label], i) => {
    const li = el('li', `sw-step${i === at ? ' current' : i < at ? ' done' : ''}`);
    li.dataset.step = key;
    if (i < at && !SWX.busy && !swPartial()) {
      const b = el('button', 'sw-step-btn', `${i + 1}. ${label}`);
      b.onclick = () => swGo(key);
      li.appendChild(b);
    } else li.appendChild(el('span', null, `${i + 1}. ${label}`));
    if (i === at) li.setAttribute('aria-current', 'step');
    nav.appendChild(li);
  });
  return nav;
}

function swError(box, retry) {
  if (!SW.error) return;
  const n = el('div', 'notice error sw-error');
  n.setAttribute('role', 'alert');
  n.appendChild(el('div', null, SW.error));
  // The refused reply, as plain text: never parsed, never rendered as markup.
  if (SWX.reply && SWX.reply.error === SW.error) {
    const d = el('details', 'sw-reply');
    d.appendChild(el('summary', null, "Show the AI's reply"));
    d.appendChild(el('pre', 'sw-reply-text', SWX.reply.text));
    if (SWX.reply.cut) d.appendChild(el('div', 'scope-note', 'Cut at 4 KB.'));
    n.appendChild(d);
  }
  if (retry) {
    const r = el('button', 'btn sw-retry', 'Retry');
    r.onclick = retry;
    n.appendChild(r);
  }
  box.appendChild(n);
}

function swBar(...buttons) {
  const bar = el('div', 'sw-bar');
  buttons.filter(Boolean).forEach((b) => bar.appendChild(b));
  return bar;
}
const swBtn = (cls, text, fn, disabled = false) => { const b = el('button', `btn ${cls}`, text); b.onclick = fn; b.disabled = disabled; return b; };

/* ── 1. describe ─────────────────────────────────────────────────────── */
function swDescribe(box) {
  box.appendChild(el('label', 'sw-label', 'What should this skill do? Write it however you think about it.'));
  const max = SWX.info?.limits?.description || 4000;
  const ta = el('textarea', 'models-input sw-describe');
  ta.rows = 7; ta.maxLength = max;
  ta.placeholder = 'e.g. When I say "cut a release", bump the version, tag it, and write release notes from the merged PRs. Never push tags without asking.';
  ta.value = SW.description;
  const count = el('div', 'scope-note sw-count', `${SW.description.length} / ${max}`);
  const next = swBtn('primary sw-next', 'Start the interview', () => {
    if (!SW.description.trim()) return;
    SW.step = 'interview'; swSave();
    if (!SW.current && !SW.done && SW.answers.length < SW_MAX_Q) swAsk(); else paintWizard();
  }, !SW.description.trim() || !SWX.info?.backend?.ready);
  ta.oninput = () => {
    if (ta.value.trim() !== SW.description.trim()) { SW.current = null; SW.done = null; swInvalidate(); }
    SW.description = ta.value; count.textContent = `${ta.value.length} / ${max}`;
    next.disabled = !ta.value.trim() || !SWX.info?.backend?.ready; swSave();
  };
  box.appendChild(ta);
  box.appendChild(count);
  swError(box);
  box.appendChild(swBar(next));
}

/** A refused turn's reply rides with its error: shown only while that error is. */
function swKeepReply(e) {
  const text = e.body?.reply;
  SWX.reply = typeof text === 'string' && text ? { error: SW.error, text, cut: e.body.replyCut === true } : null;
}

/* ── 2. interview ────────────────────────────────────────────────────── */
const swSent = () => SW.answers.map((a) => ({ question: a.question, answer: a.answer }));

async function swAsk() {
  if (!SW || swLocked()) return;
  const w = SW;
  const seq = ++w.seq;
  SWX.busy = 'question'; SW.error = null; SW.current = null; swSave(); paintWizard();
  let r;
  try {
    r = await api('POST', '/api/skill-wizard/turn', { wizardId: SW.id, seq, kind: 'question', description: SW.description, answers: swSent() });
  } catch (e) {
    if (!swLive(w, seq)) return;
    SWX.busy = null;
    SW.error = e.status === 499 ? 'Stopped. Retry to ask again.' : e.message;
    swKeepReply(e);
    swSave(); paintWizard();
    return;
  }
  if (!swLive(w, seq)) return;   // an answer changed since: this reply is for a transcript that is gone
  SWX.busy = null;
  if (r.kind === 'done') {
    SW.done = { name: r.name, summary: r.summary };
    if (!SW.nameTouched) SW.name = r.name;
    SW.step = 'where'; swSave(); paintWizard(); swPreview();
    return;
  }
  SW.current = { question: r.question, why: r.why, recommended: r.recommended, choices: r.choices || [] };
  swSave(); paintWizard();
}

function swAnswer(text) {
  if (!SW || swLocked()) return;
  const q = SW.current;
  if (!q) return;
  SW.answers.push({ ...q, answer: text });
  SW.current = null; SW.done = null; swInvalidate(); swSave();
  if (SW.answers.length >= SW_MAX_Q) return swEnough();
  swAsk();
}

/** "That's enough", and the cap: straight on, without waiting for the model to say done. */
function swEnough() {
  if (!SW || swLocked()) return;
  if (SWX.busy) { SW.seq++; api('POST', '/api/skill-wizard/cancel', { wizardId: SW.id }).catch(() => {}); SWX.busy = null; }
  SW.current = null;
  if (!SW.done) SW.done = { name: swDeriveName(SW.description), summary: null };
  if (!SW.nameTouched) SW.name = SW.done.name;
  swGo('where');
}

function swCancel() {
  if (!SW || swLocked()) return;
  SW.seq++;
  SWX.busy = null;
  SW.error = 'Stopped. Retry to ask again.';
  api('POST', '/api/skill-wizard/cancel', { wizardId: SW.id }).catch(() => {});
  swSave(); paintWizard();
}

function swInterview(box) {
  const list = el('ol', 'sw-transcript');
  SW.answers.forEach((a, i) => {
    const li = el('li', 'sw-qa');
    li.appendChild(el('div', 'sw-qa-q', a.question));
    if (SWX.editing === i) {
      const ta = el('textarea', 'models-input sw-qa-edit');
      ta.rows = 2; ta.value = a.answer === '(skipped)' ? '' : a.answer;
      li.appendChild(ta);
      li.appendChild(swBar(
        swBtn('primary sw-qa-save', 'Save and continue from here', () => {
          // Everything after this answer depended on it: it goes, and the interview resumes here.
          SW.answers = SW.answers.slice(0, i).concat([{ ...a, answer: ta.value.trim() || '(skipped)' }]);
          SWX.editing = null; SW.done = null; SW.current = null; swInvalidate(); swSave();
          if (SW.answers.length >= SW_MAX_Q) return swEnough();
          swAsk();
        }),
        swBtn('ghost', 'Cancel', () => { SWX.editing = null; paintWizard(); }),
      ));
    } else {
      const row = el('div', 'sw-qa-a');
      row.appendChild(el('span', a.answer === '(skipped)' ? 'sw-skipped' : null, a.answer));
      const edit = swBtn('ghost sw-qa-editbtn', 'Edit', () => { SWX.editing = i; paintWizard(); });
      row.appendChild(edit);
      li.appendChild(row);
    }
    list.appendChild(li);
  });
  if (SW.answers.length) box.appendChild(list);

  if (SWX.busy === 'question') {
    const w = el('div', 'sw-waiting');
    w.appendChild(el('span', 'spinner'));
    w.appendChild(document.createTextNode(SW.answers.length ? ' Thinking about the next question…' : ' Reading your description…'));
    box.appendChild(w);
    box.appendChild(swBar(swBtn('ghost sw-cancel', 'Cancel', swCancel), swBtn('ghost sw-enough', 'That’s enough — draft it', swEnough)));
    return;
  }
  swError(box, swAsk);
  const q = SW.current;
  if (q) {
    const card = el('div', 'sw-card');
    card.appendChild(el('div', 'sw-card-n', `Question ${SW.answers.length + 1} of at most ${SW_MAX_Q}`));
    card.appendChild(el('div', 'sw-card-q', q.question));
    if (q.why) card.appendChild(el('div', 'sw-card-why', q.why));
    const rec = el('button', 'btn primary sw-rec');
    rec.appendChild(el('span', 'sw-rec-label', 'Use the recommended answer: '));
    rec.appendChild(document.createTextNode(q.recommended));
    rec.onclick = () => swAnswer(q.recommended);
    card.appendChild(rec);
    if (q.choices.length) {
      const chips = el('div', 'sw-chips');
      for (const ch of q.choices) {
        const b = el('button', 'btn sw-chip', ch);
        b.onclick = () => swAnswer(ch);
        chips.appendChild(b);
      }
      card.appendChild(chips);
    }
    const ta = el('textarea', 'models-input sw-free');
    ta.rows = 2; ta.maxLength = SWX.info?.limits?.answer || 2000;
    ta.placeholder = 'Or answer in your own words';
    const send = swBtn('sw-send', 'Answer', () => { if (ta.value.trim()) swAnswer(ta.value.trim()); }, true);
    ta.oninput = () => { send.disabled = !ta.value.trim(); };
    card.appendChild(ta);
    card.appendChild(swBar(send, swBtn('ghost sw-skip', 'Skip', () => swAnswer('(skipped)'))));
    box.appendChild(card);
  }
  box.appendChild(swBar(
    swBtn('ghost sw-back', 'Back', () => swGo('describe')),
    swBtn('ghost sw-enough', 'That’s enough — draft it', swEnough),
    !q && !SW.error && SW.done ? swBtn('primary', 'Next', () => swGo('where')) : null,
  ));
}

/* ── 3. where ────────────────────────────────────────────────────────── */
let swPreviewSeq = 0;
async function swPreview() {
  if (!SW) return;
  const w = SW;
  const seq = ++swPreviewSeq;
  SWX.preview = null;
  if (!SW_NAME_RE.test(SW.name)) { SWX.preview = { error: 'Lowercase letters, digits and hyphens; start with a letter or digit; at most 64.' }; paintWizard(); return; }
  if (SW.scope === 'project' && !SW.project) { paintWizard(); return; }
  const dests = swDests();
  if (!dests.length) { SWX.preview = { error: 'Check at least one place for the skill.' }; paintWizard(); return; }
  try {
    const r = await api('POST', '/api/skill-wizard/target', { dests, name: SW.name });
    if (seq !== swPreviewSeq || SW !== w) return;
    const targets = r.targets;
    const taken = targets.filter((x) => x.taken).map((x) => x.display.replace(/\/SKILL\.md$/, ''));
    SWX.preview = taken.length ? { targets, error: `${taken.join(' and ')} already exist${taken.length === 1 ? 's' : ''}. Pick another name.` } : { targets };
  } catch (e) {
    if (seq !== swPreviewSeq || SW !== w) return;
    SWX.preview = { error: e.message };
  }
  paintWizard();
}

function swWhere(box) {
  const t = SWX.info?.targets;
  if (!t) { swError(box); return; }
  const changed = () => { swInvalidate(); swSave(); swPreview(); };

  const scope = el('div', 'sw-scope');
  for (const [val, label] of [['global', 'Global — every session on this machine'], ['project', 'A project — only inside one repository']]) {
    const l = el('label', 'sw-radio');
    const r = el('input'); r.type = 'radio'; r.name = 'sw-scope'; r.value = val; r.checked = SW.scope === val;
    // Switching scope starts from the defaults again.
    r.onchange = () => { SW.scope = val; SW.picks = {}; if (val === 'project' && !SW.project) SW.project = t.projects[0]?.id || null; changed(); };
    l.appendChild(r); l.appendChild(document.createTextNode(` ${label}`));
    scope.appendChild(l);
  }
  box.appendChild(scope);

  const fields = el('div', 'sw-fields');
  if (SW.scope === 'project' && !t.projects.length) {
    fields.appendChild(el('div', 'notice warn', 'No repositories were found in your edit folders. Add a folder in Folders, or create the skill globally.'));
  } else if (SW.scope === 'project') {
    const p = el('select', 'models-input sw-project');
    for (const x of t.projects) {
      const o = el('option', null, `${x.name}${x.root ? ` (${x.root})` : ''} — ${x.display}`);
      o.value = x.id; o.selected = SW.project === x.id;
      p.appendChild(o);
    }
    p.onchange = () => { SW.project = p.value; SW.picks = {}; changed(); };
    fields.appendChild(swField('Project', p));
  }
  const name = el('input', 'models-input sw-name');
  name.value = SW.name; name.maxLength = 64; name.spellcheck = false;
  name.oninput = () => { SW.name = name.value.trim(); SW.nameTouched = true; swInvalidate(); swSave(); clearTimeout(swWhere.t); swWhere.t = setTimeout(swPreview, 250); };
  fields.appendChild(swField('Name', name));
  box.appendChild(fields);

  const boxes = swBoxes();
  if (boxes.length) {
    const set = el('fieldset', 'sw-harnesses');
    set.appendChild(el('legend', 'sw-field-label', SW.scope === 'global' ? 'Create it for' : 'Folders'));
    for (const b of boxes) {
      const l = el('label', `sw-check${b.usable ? '' : ' off'}`);
      const c = el('input'); c.type = 'checkbox'; c.value = b.id; c.checked = b.checked; c.disabled = !b.usable;
      c.onchange = () => { SW.picks[b.id] = c.checked; changed(); };
      l.appendChild(c); l.appendChild(document.createTextNode(` ${b.label}`));
      if (b.why) l.appendChild(el('span', 'scope-note sw-why', ` — ${b.why}`));
      set.appendChild(l);
    }
    box.appendChild(set);
  }
  const ov = swOverlap();
  if (ov) box.appendChild(el('div', 'notice warn sw-overlap', ov));

  const pv = SWX.preview;
  const at = el('div', `sw-target${pv?.error ? ' bad' : ''}`);
  if (pv?.targets && !pv.error) {
    at.appendChild(el('span', 'scope-note', 'Creates '));
    pv.targets.forEach((x, i) => { if (i) at.appendChild(el('span', 'scope-note', ' and ')); at.appendChild(el('code', 'sw-path', x.display)); });
  } else if (pv?.error) { at.setAttribute('role', 'alert'); at.textContent = pv.error; }
  else at.appendChild(el('span', 'spinner'));
  box.appendChild(at);
  box.appendChild(swBar(
    swBtn('ghost sw-back', 'Back', () => swGo('interview')),
    swBtn('primary sw-next', 'Draft the skill', () => swGo('review'), !pv?.targets || !!pv.error),
  ));
}
function swField(label, input) {
  const f = el('label', 'sw-field');
  f.appendChild(el('span', 'sw-field-label', label));
  f.appendChild(input);
  return f;
}

/* ── 4. review ───────────────────────────────────────────────────────── */
async function swDraft({ note = null } = {}) {
  if (!SW || swLocked()) return;
  const w = SW;
  const seq = ++w.seq;
  SWX.busy = 'draft'; SW.error = null; paintWizard();
  let r;
  try {
    r = await api('POST', '/api/skill-wizard/turn', {
      wizardId: SW.id, seq, kind: 'draft', description: SW.description, answers: swSent(),
      name: SW.name, summary: SW.done?.summary || null, note, previous: note ? SW.draft?.content || null : null,
    });
  } catch (e) {
    if (!swLive(w, seq)) return;
    SWX.busy = null;
    SW.error = e.status === 499 ? 'Stopped. Regenerate to try again.' : e.message;
    swKeepReply(e);
    swSave(); paintWizard();
    return;
  }
  if (!swLive(w, seq)) return;
  SWX.busy = null;
  SW.draft = { content: r.content, name: r.name, dests: swDests() };
  SW.note = ''; SW.createSent = false;
  swSave(); paintWizard();
}

function swReview(box) {
  if (SWX.busy === 'draft') {
    const w = el('div', 'sw-waiting');
    w.appendChild(el('span', 'spinner'));
    w.appendChild(document.createTextNode(' Drafting the SKILL.md…'));
    box.appendChild(w);
    box.appendChild(swBar(swBtn('ghost sw-cancel', 'Cancel', () => {
      SW.seq++; SWX.busy = null; SW.error = 'Stopped. Regenerate to try again.';
      api('POST', '/api/skill-wizard/cancel', { wizardId: SW.id }).catch(() => {});
      swSave(); paintWizard();
    })));
    return;
  }
  swError(box, () => swDraft());
  if (!SW.draft) {
    box.appendChild(swBar(swBtn('ghost sw-back', 'Back', () => swGo('where')), swBtn('primary sw-regen', 'Regenerate', () => swDraft())));
    return;
  }
  const dests = SW.draft.dests || swDests();
  const shown = SWX.preview?.targets?.map((x) => x.display);
  box.appendChild(el('div', 'scope-note', `Review it before creating — it is written exactly as shown, to ${shown?.length ? shown.join(' and ') : 'the folders you picked'}.`));
  const split = el('div', 'sw-split');
  const ta = el('textarea', 'models-input sw-source');
  const locked = swLocked();
  // Once one place has it, the rest must get the same bytes: nothing about the skill changes.
  const fixed = locked || swPartial();
  ta.rows = 22; ta.spellcheck = false; ta.value = SW.draft.content; ta.readOnly = fixed;
  const pv = el('div', 'sw-preview md');
  const paint = () => { pv.innerHTML = renderMarkdown(splitFrontmatter(ta.value).body ?? ta.value); };
  ta.oninput = () => { if (!SW || swLocked() || swPartial()) return; SW.draft.content = ta.value; SW.createSent = false; SW.results = {}; swSave(); paint(); };
  split.appendChild(ta); split.appendChild(pv);
  paint();
  box.appendChild(split);

  const note = el('input', 'models-input sw-note');
  note.placeholder = 'Optional: what to change when regenerating';
  note.value = SW.note; note.maxLength = 1000; note.disabled = fixed;
  note.oninput = () => { SW.note = note.value; swSave(); };
  box.appendChild(note);

  const tried = dests.filter((d) => SW.results[swKey(d)]);
  const failed = tried.filter((d) => !SW.results[swKey(d)].ok);
  if (tried.length) {
    const res = el('div', `notice ${failed.length ? 'error' : 'ok'} sw-results`);
    if (failed.length) res.setAttribute('role', 'alert');
    res.appendChild(el('div', null, failed.length ? `Created ${tried.length - failed.length} of ${dests.length}. Retry creates only the ones that failed.` : 'Created.'));
    const list = el('ul', 'sw-result-list');
    for (const d of dests) {
      const x = SW.results[swKey(d)];
      if (!x) continue;
      const li = el('li', `sw-result ${x.ok ? 'ok' : 'bad'}`);
      li.appendChild(el('code', 'sw-path', x.display));
      li.appendChild(el('span', null, x.ok ? ` — ${x.alreadyCreated ? 'already created' : 'created'}` : ` — failed: ${x.error}`));
      list.appendChild(li);
    }
    res.appendChild(list);
    box.appendChild(res);
  }
  box.appendChild(swBar(
    swBtn('ghost sw-back', 'Back', () => swGo('where'), fixed),
    swBtn('sw-regen', 'Regenerate', () => swDraft({ note: SW.note.trim() || 'Write it again.' }), fixed),
    swPartial() && failed.length ? swBtn('ghost sw-finish', 'Finish without them', () => swFinish(SW, dests), locked) : null,
    swBtn('primary sw-create', locked ? 'Creating…' : failed.length ? 'Retry the failed ones' : 'Create', swCreate, locked),
  ));
}

async function swCreate() {
  if (!SW || swLocked() || !SW.draft) return;
  const w = SW;
  const all = SW.draft.dests || swDests();
  // Only what is not there yet: a Retry never re-sends a destination that has the skill.
  const send = all.filter((d) => !SW.results[swKey(d)]?.ok);
  if (!send.length) return swFinish(w, all);
  SWX.busy = 'create'; SW.error = null; paintWizard();
  const retry = SW.createSent;
  SW.createSent = true; swSave();
  let r;
  try {
    r = await api('POST', '/api/skill-wizard/create', { dests: send, name: SW.name, content: SW.draft.content, retry });
  } catch (e) {
    SWX.busy = null;
    if (SW !== w) return;
    // A refusal (an HTTP status) is final for these bytes; a lost response may have written them.
    if (e.status) SW.createSent = false;
    SW.error = e.status ? e.message : `${e.message} — the skill may have been created. Retry checks.`;
    swSave(); paintWizard();
    return;
  }
  SWX.busy = null;
  if (SW !== w) return;
  // One result per destination sent, in order.
  send.forEach((d, i) => { if (r.results?.[i]) SW.results[swKey(d)] = { ...r.results[i], dest: d }; });
  SW.createSent = false;
  if (all.some((d) => !SW.results[swKey(d)]?.ok)) { swSave(); paintWizard(); return; }
  return swFinish(w, all);
}

/** Into the editor at the first one created; the toast names every one, and any that failed. */
async function swFinish(w, all) {
  if (!SW || SW !== w || swLocked()) return;
  const made = all.map((d) => SW.results[swKey(d)]).filter((x) => x?.ok);
  const missed = all.map((d) => SW.results[swKey(d)]).filter((x) => x && !x.ok);
  if (!made.length) return;
  const done = { ...SW };
  SW = null; swClear();
  // The new file in the editor (opening it clears notices, so the toast follows);
  // the inventory catches up in the background.
  try { await refreshRegistry(); } catch { /* the editor opens it ad hoc */ }
  const first = made[0];
  const entry = entryForFile(first.path);
  if (entry) await openEntry(entry, first.path); else openInEditor(first.path, first.display);
  const fresh = made.filter((x) => !x.alreadyCreated).map((x) => x.display);
  const again = made.filter((x) => x.alreadyCreated).map((x) => x.display);
  const text = [fresh.length ? `Created ${fresh.join(', ')}` : null, again.length ? `${fresh.length ? 'already created' : 'Already created'} ${again.join(', ')}` : null].filter(Boolean).join('; ');
  const warnings = [...made.flatMap((x) => x.warnings || []), ...missed.map((x) => `Not created: ${x.display} — ${x.error}`)];
  notice(warnings.length ? 'warn' : 'ok', `${text}.`, warnings, !!warnings.length);
  api('GET', '/api/skills').then((d) => { SK.rows = d.skills; SK.usage = d.usage; })
    .catch((e) => notice('warn', `${done.name} was created, but the Skills list could not refresh: ${e.message}`));
}
