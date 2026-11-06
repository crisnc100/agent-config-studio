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
 * { kind, k, v?, n?, unset? }: k the role, v the models, n a note.
 */
function wfRoleChip(roleName, step, ctx, { note = null } = {}) {
  if (!ctx.roles) return { kind: 'role', k: roleName, v: ctx.rolesError ? 'roles unavailable' : 'reading…', n: null };
  const role = ctx.roles.find((r) => r.name === roleName);
  if (!role || role.unset) return { kind: 'role', k: roleName, unset: true };
  let models = wfMembers(role);
  if (step.vendor) models = models.filter((m) => wfVendor(m.id) === step.vendor);
  if (step.use === 'alt') models = wfAlt(role) ? [wfAlt(role)] : [];
  if (step.use === 'both') models = [models[0], wfAlt(role)].filter(Boolean);
  if (!models.length) return { kind: 'role', k: roleName, v: step.use ? 'no second opinion set' : 'no model of that vendor', n: null };
  let v;
  let n = note;
  if (step.use === 'both') v = models.map(wfModel).join(' and ');
  else if (models.length > 1) { v = models.map((m) => wfName(m.family)).join(' or '); n = step.pool || n; }
  else v = wfModel(models[0]);
  if (step.swap === 'grade') {
    // The Grade's grader swap (build SKILL.md): the advisor's second opinion when the builder shares the judge's vendor.
    const advisor = ctx.roles.find((r) => r.name === 'advisor');
    const alt = advisor && !advisor.unset ? wfAlt(advisor) : null;
    const jv = wfVendor(models[0].id);
    if (alt && wfVendor(alt.id) && wfVendor(alt.id) !== jv) n = `${wfName(alt.family)} instead when the builder is the same vendor as ${wfName(models[0].family)}`;
  }
  return { kind: 'role', k: roleName, v, n };
}

/** Every chip a step shows: a role (and an `also` role), you, your session agent, or a script. */
function wfChips(step, ctx) {
  if (step.who === 'you') return [{ kind: 'you', k: 'you' }];
  if (step.who === 'agent') return [{ kind: 'agent', k: 'your session agent' }];
  if (step.who === 'script') return [{ kind: 'script', k: `${step.tool || 'script'} — no model` }];
  const chips = [wfRoleChip(step.role, step, ctx, { note: step.note || null })];
  if (step.also) chips.push(wfRoleChip(step.also, { ...step, vendor: null, use: null, pool: null, swap: null }, ctx, { note: step.alsoNote || null }));
  return chips;
}

function wfChipEl(c) {
  const w = el('span', `w ${c.kind}`);
  w.appendChild(el('span', 'w-k', c.k));
  if (c.unset) {
    const a = el('a', 'w-unset', 'not set — choose');
    a.href = '#models';
    a.dataset.role = c.k;
    a.title = `Choose the ${c.k} role's model on Models`;
    w.appendChild(a);
  } else if (c.v) w.appendChild(el('span', 'w-v', c.v));
  if (c.n) w.appendChild(el('span', 'w-n', c.n));
  return w;
}

const WF_LEGEND = [['role', 'a role from Models'], ['agent', 'your session agent'], ['you', 'you'], ['script', 'a script, no model']];

/**
 * A pack's diagram, or its one-line strip.
 * ctx: { roles, rolesError, settings, installedParts: Set, pickedParts: Set, variant, onVariant(id) }.
 */
function wfDiagram(wf, ctx) {
  if (wf.strip) {
    const s = el('div', 'pk-strip');
    s.appendChild(el('span', 'cmd', wf.command));
    s.appendChild(document.createTextNode(' '));
    s.appendChild(el('span', null, wf.strip));
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
  const ol = el('ol', 'flow');
  for (const raw of wf.steps) {
    const step = wfStepFor(raw, variant);
    const on = wfStepOn(step, ctx);
    const li = el('li', `step${on ? '' : ' off'}`);
    li.dataset.step = step.id;
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
  for (const [kind, text] of WF_LEGEND) {
    const li = el('li');
    li.appendChild(el('span', `wf-sw ${kind}`));
    li.appendChild(document.createTextNode(text));
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
