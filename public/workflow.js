/* Agent Config Studio — workflow diagrams: who does each step of a pack, from pack.json's `workflow` and the live roles */

/**
 * Loaded before packs-view.js and app.js; it uses app.js's `el` at call time
 * only. Pure apart from building DOM: Packs draws a card's diagram with
 * wfDiagram, Models lists a role's steps with wfRoleSteps. Who does a step is
 * resolved here from /api/models/roles as the page has it now — never stored
 * in the pack — so a role changed on Models shows the next time Packs opens.
 */

/** A family's display name: "opus" → "Opus". */
const wfName = (f) => (f ? f[0].toUpperCase() + f.slice(1) : '');
/** A model id's vendor, by its prefix (lib/models-catalog.js vendorOf). */
const wfVendor = (id) => (typeof id !== 'string' ? null : id.startsWith('claude-') ? 'claude' : id.startsWith('gpt-') ? 'codex' : id.startsWith('grok-') ? 'grok' : null);

/** A role's members as [{ family, effort, id }], in order; worked out from `use` for an older payload without them. */
function wfMembers(role) {
  const list = role.members?.length ? role.members : (role.use || []).map((family) => ({ family, effort: role.resolvedEffort || role.effort || '' }));
  return list.map((m, i) => ({ family: m.family, effort: m.effort || '', id: role.ids?.[i] ?? null }));
}
const wfAlt = (role) => (role.alt ? { family: role.alt, effort: role.altMember?.effort || '', id: role.altId || null } : null);
/** "Fable · high", or just "Fable" with no effort. */
const wfModel = (m) => `${wfName(m.family)}${m.effort ? ` · ${m.effort}` : ''}`;

/** A step as one variant runs it: the step with that variant's overrides laid over it. */
function wfStepFor(step, variant) {
  const o = (variant && step.variants?.[variant]) || {};
  return { ...step, ...o };
}

/** Is the step on? Off when its part is neither installed nor picked, or its setting is off. */
function wfStepOn(step, ctx) {
  if (step.part && !(ctx.installedParts?.has(step.part) || ctx.pickedParts?.has(step.part))) return false;
  if (step.setting === 'security' && (ctx.settings?.security || 'off') === 'off') return false;
  return true;
}

/**
 * One "who" chip for a role: its model(s) as the studio has them now.
 * { kind, k, models?: [{ family, effort }], join?: 'or'|'and', v?, n?, unset? }: k the role, n a note.
 */
function wfRoleChip(roleName, step, ctx, { note = null } = {}) {
  if (!ctx.roles) return { kind: 'role', k: roleName, v: ctx.rolesError ? 'roles unavailable' : 'reading…', n: null };
  const role = ctx.roles.find((r) => r.name === roleName);
  if (!role || role.unset) return { kind: 'role', k: roleName, unset: true };
  let models = wfMembers(role);
  if (step.vendor) models = models.filter((m) => wfVendor(m.id) === step.vendor);
  if (step.use === 'alt') models = wfAlt(role) ? [wfAlt(role)] : [];
  if (step.use === 'both') models = [models[0], wfAlt(role)].filter(Boolean);
  if (!models.length) return { kind: 'role', k: roleName, v: step.use === 'alt' ? 'no second opinion set' : 'no model of that vendor', n: null };
  // A pool reads "Opus · xhigh or Sol · xhigh" (picked per run); advisor-and-second reads "Fable · high and Astra · high".
  const join = step.use === 'both' ? 'and' : 'or';
  let n = note;
  if (models.length > 1 && join === 'or') n = step.pool || (step.noteMany ?? n);
  if (step.swap === 'grade') {
    // The Grade's grader swap (build SKILL.md), always said: the advisor's second opinion when the builder shares the judge's vendor.
    const advisor = ctx.roles.find((r) => r.name === 'advisor');
    const alt = advisor && !advisor.unset ? wfAlt(advisor) : null;
    const judge = wfName(models[0].family);
    if (!alt) n = `when the builder is the same vendor as ${judge}: the advisor's second opinion instead (not set)`;
    else if (wfVendor(alt.id) && wfVendor(alt.id) === wfVendor(models[0].id)) n = `no swap: the advisor's second opinion, ${wfName(alt.family)}, is the same vendor as ${judge}`;
    else n = `${wfName(alt.family)} instead when the builder is the same vendor as ${judge}`;
  }
  return { kind: 'role', k: roleName, models, join, n };
}

/** Every chip a step shows: a role (and an `also` role), you, your session agent, or a script. */
function wfChips(step, ctx) {
  if (step.who === 'you') return [{ kind: 'you', k: 'you' }];
  if (step.who === 'agent') return [{ kind: 'agent', k: 'your session agent' }];
  // "no model" is said once, in the legend: the chip names only what runs.
  if (step.who === 'script') return [{ kind: 'script', k: step.tool || 'script' }];
  const chips = [wfRoleChip(step.role, step, ctx, { note: step.note || null })];
  if (step.also) chips.push(wfRoleChip(step.also, { ...step, vendor: null, use: null, pool: null, swap: null, noteMany: null }, ctx, { note: step.alsoNote || null }));
  return chips;
}

function wfChipEl(c) {
  const w = el('span', `w ${c.kind}`);
  w.appendChild(el('span', 'w-k', c.k));
  // Unset: said quietly here; the card's one line links to Models (packs-view.js pkUnsetLine).
  if (c.unset) w.appendChild(el('span', 'w-unset', 'not set'));
  else if (c.models) {
    // Each model in its own span that never wraps, so a chip breaks only between models.
    const v = el('span', 'w-v');
    c.models.forEach((m, i) => { if (i) v.appendChild(document.createTextNode(` ${c.join} `)); v.appendChild(el('span', 'w-m', wfModel(m))); });
    w.appendChild(v);
  } else if (c.v) w.appendChild(el('span', 'w-v', c.v));
  if (c.n) w.appendChild(el('span', 'w-n', c.n));
  return w;
}

/** The roles a workflow names (every step, every variant), in step order. */
function wfRoles(wf) {
  const out = [];
  const add = (r) => { if (r && !out.includes(r)) out.push(r); };
  for (const s of wf.steps || []) { add(s.role); add(s.also); for (const o of Object.values(s.variants || {})) { add(o.role); add(o.also); } }
  return out;
}

const WF_LEGEND = [['role', 'a role from Models'], ['agent', 'your session agent'], ['you', 'you'], ['script', 'a script — no model']];

/**
 * A pack's diagram, or its one-line strip.
 * ctx: { roles, rolesError, settings, installedParts: Set, pickedParts: Set, variant, onVariant(id) }.
 */
function wfDiagram(wf, ctx) {
  if (wf.strip) {
    const s = el('div', 'pk-strip');
    s.appendChild(wfChipEl(wfChips({ who: wf.stripWho || 'agent' }, ctx)[0]));
    s.appendChild(el('span', 'pk-strip-text', wf.strip));
    return s;
  }
  const box = el('div', 'pk-flow');
  const bar = el('div', 'flow-bar');
  bar.appendChild(el('span', 'flow-title', 'How it runs'));
  const variant = wf.variants?.length ? (wf.variants.some((v) => v.id === ctx.variant) ? ctx.variant : wf.variants[0].id) : null;
  if (wf.variants?.length) {
    const tabs = el('div', 'pk-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Ways to run it');
    for (const v of wf.variants) {
      const b = el('button', 'pk-tab', v.label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(v.id === variant));
      b.onclick = () => ctx.onVariant?.(v.id);
      tabs.appendChild(b);
    }
    bar.appendChild(tabs);
    const hint = wf.variants.find((v) => v.id === variant)?.hint;
    if (hint) bar.appendChild(el('span', 'pk-flow-hint', hint));
  }
  box.appendChild(bar);
  // Eight or more steps would squeeze each to a sliver at a desktop width: rows of four instead.
  const ol = el('ol', `flow${wf.steps.length > 7 ? ' rows' : ''}`);
  let anyOff = false;
  for (const [i, raw] of wf.steps.entries()) {
    const step = wfStepFor(raw, variant);
    const on = wfStepOn(step, ctx);
    if (!on) anyOff = true;
    // A step with no model, or one that is off, is a narrow tile: the role steps get the width.
    // A step `beside` the one before runs at the same time: the two are joined by a mark, not an arrow.
    const li = el('li', `step${on ? '' : ' off'}${!on || step.who === 'script' ? ' narrow' : ''}${wf.steps[i + 1]?.beside ? ' with-next' : ''}${raw.beside ? ' beside' : ''}`);
    li.dataset.step = step.id;
    if (raw.beside) li.appendChild(el('span', 'pair-note', 'at the same time'));
    const name = el('div', 'step-name', step.label);
    if (!on) { name.appendChild(document.createTextNode(' ')); name.appendChild(el('span', 'step-off', 'off')); }
    li.appendChild(name);
    if (step.what) li.appendChild(el('p', 'step-what', step.what));
    const who = el('div', 'who');
    for (const c of wfChips(step, ctx)) who.appendChild(wfChipEl(c));
    li.appendChild(who);
    ol.appendChild(li);
  }
  box.appendChild(ol);
  const legend = el('ul', 'legend');
  legend.setAttribute('aria-label', 'Who does a step');
  // Only the kinds this diagram uses.
  const used = new Set(wf.steps.map((st) => st.who));
  for (const [kind, text] of WF_LEGEND.filter(([k]) => used.has(k))) {
    const li = el('li');
    li.appendChild(el('span', `wf-sw ${kind}`));
    li.appendChild(document.createTextNode(text));
    legend.appendChild(li);
  }
  // One look per meaning: an off step is a dashed tile, so the legend says so — only when one is off.
  if (anyOff) {
    const li = el('li');
    li.appendChild(el('span', 'wf-sw off'));
    li.appendChild(document.createTextNode('off — not turned on'));
    legend.appendChild(li);
  }
  box.appendChild(legend);
  if (wf.note) box.appendChild(el('p', 'pk-flow-note', wf.note));
  return box;
}

/**
 * The steps that use a role, across the catalog: "/code-review · Review, Fix check; /build · Grade".
 * A step a variant hands to the role says which ("Review (Premium)"); a step whose setting is off says "(off)".
 */
function wfRoleSteps(packs, roleName, settings = {}) {
  const groups = [];
  for (const pack of packs || []) {
    const wf = pack.workflow;
    if (!wf?.steps) continue;
    const labels = [];
    for (const s of wf.steps) {
      const off = s.setting === 'security' && (settings.security || 'off') === 'off' ? ' (off)' : '';
      if (s.role === roleName || s.also === roleName) labels.push(`${s.label}${off}`);
      for (const [vid, o] of Object.entries(s.variants || {})) {
        if ((o.role === roleName || o.also === roleName) && s.role !== roleName && s.also !== roleName) {
          labels.push(`${s.label} (${wf.variants.find((v) => v.id === vid)?.label || vid})`);
        }
      }
    }
    if (labels.length) groups.push(`${wf.command} · ${[...new Set(labels)].join(', ')}`);
  }
  return groups;
}
