/**
 * Workflow diagrams (builds/ui-clarity PR B): each pack's `workflow` in
 * pack.json — its shape, checked by validatePack; a drift guard against the
 * pack's SKILL.md twins; the catalog route passing it through with the home
 * review config's security setting; and the Packs card drawing it in the
 * page (fake DOM, stubbed routes): who does each step, resolved live from
 * the studio's roles; pools, the Grade swap, unset roles; dimmed steps for
 * a part or setting that is off; variant tabs; the one-line strips; and the
 * Models role rows' "Steps:" line. No browser: tests/ui-words.mjs and the QA
 * run cover how it looks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, sandbox, tests } from './fixtures/packs-sandbox.mjs';
import { bootPage, routesFor, settle } from './fixtures/shell-page.mjs';
import { loadCatalog, validatePack, machine } from '../lib/packs.js';
import { catalogView, securitySetting } from '../lib/packs-routes.js';

const { ok, done } = tests();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (x) => JSON.parse(JSON.stringify(x));

/* ── the data: every pack, its shape, and what its skills say ────────── */
console.log('\nworkflow data in pack.json');
const catalog = loadCatalog();
const rolesIn = (wf) => {
  const out = new Set();
  const add = (s) => { if (s?.role) out.add(s.role); if (s?.also) out.add(s.also); };
  for (const s of wf.steps || []) { add(s); for (const o of Object.values(s.variants || {})) add(o); }
  return out;
};
{
  ok('every pack has a workflow', catalog.every((p) => p.workflow && typeof p.workflow === 'object'), catalog.filter((p) => !p.workflow).map((p) => p.id).join(', '));
  const strips = catalog.filter((p) => p.workflow?.strip).map((p) => p.id).sort();
  ok('handoff, flag and worktree are one-line strips; every other pack is a diagram of steps', JSON.stringify(strips) === '["flag","handoff","worktree"]'
    && catalog.filter((p) => !p.workflow?.strip).every((p) => p.workflow.steps.length >= 3), JSON.stringify(strips));
  const rg = catalog.find((p) => p.id === 'review-gate').workflow;
  ok('review-gate: Standard, Premium, Both and Claude team tabs', JSON.stringify(rg.variants.map((v) => v.label)) === '["Standard","Premium","Both","Claude team"]');
  ok('review-gate: the steps the skill names, in order', JSON.stringify(rg.steps.map((s) => s.id)) === '["review","security","quote","fix","dispute","check","log","gate"]',
    JSON.stringify(rg.steps.map((s) => s.id)));
  ok('…the security pass follows the security setting, the push gate its part', rg.steps.find((s) => s.id === 'security').setting === 'security'
    && rg.steps.find((s) => s.id === 'gate').part === 'push-gate');
  const build = catalog.find((p) => p.id === 'build').workflow;
  ok('build: Understand, Shape, Bounce, you approve, Build, Grade, you judge — and a lightweight note',
    JSON.stringify(build.steps.map((s) => [s.id, s.who, s.role || null])) === JSON.stringify([['understand', 'agent', null], ['shape', 'agent', null], ['bounce', 'role', 'advisor'], ['approve', 'you', null], ['build', 'role', 'builder'], ['grade', 'role', 'judge'], ['judge', 'you', null]])
      && /lightweight/i.test(build.note || ''), JSON.stringify(build.steps.map((s) => s.id)));
  ok('build: the Grade step carries the vendor swap', build.steps.find((s) => s.id === 'grade').swap === 'grade');
  const pr = catalog.find((p) => p.id === 'pr').workflow;
  ok('pr: facts script, your agent writes, --check, gh — and "no extra model is called"', pr.steps.map((s) => s.who).join() === 'script,agent,script,script'
    && /no extra model is called/i.test(pr.note || ''));
  const adv = catalog.find((p) => p.id === 'advisor').workflow;
  ok('advisor: Advisor, Second and Both tabs', JSON.stringify(adv.variants.map((v) => v.id)) === '["advisor","second","both"]');
  for (const id of ['handoff', 'flag', 'worktree']) {
    const s = catalog.find((p) => p.id === id).workflow.strip;
    ok(`${id}: its strip names who does it and that no extra model is called`, typeof s === 'string' && /no extra model/i.test(s), s);
  }
}

console.log('\nvalidatePack checks the workflow shape (R6)');
{
  const base = catalog.find((p) => p.id === 'review-gate');
  const bad = (name, mutate, re) => {
    const p = clone(base);
    mutate(p.workflow, p);
    let msg = null;
    try { validatePack(p); } catch (e) { msg = e.message; }
    ok(`refuses ${name}`, !!msg && re.test(msg), msg);
  };
  ok('accepts every shipped workflow', catalog.every((p) => { try { validatePack(clone(p)); return true; } catch { return false; } }));
  bad('a step with an unknown "who"', (w) => { w.steps[0].who = 'robot'; }, /who/);
  bad('a role step without a role', (w) => { delete w.steps[0].role; }, /role/);
  bad('a step linked to a part the pack does not have', (w) => { w.steps.at(-1).part = 'no-such-part'; }, /part/);
  bad('a setting the studio does not read', (w) => { w.steps[1].setting = 'colour'; }, /setting/);
  bad('a step override for a variant that does not exist', (w) => { w.steps[0].variants.nope = { what: 'x' }; }, /variant/);
  bad('two steps with one id', (w) => { w.steps[2].id = w.steps[1].id; }, /id/);
  bad('a step without a label', (w) => { w.steps[0].label = ''; }, /label/);
  bad('neither steps nor a strip', (w) => { delete w.steps; }, /steps|strip/);
}

console.log('\ndrift guard: every role a workflow names is in its SKILL.md twins');
{
  for (const pack of catalog) {
    const roles = rolesIn(pack.workflow);
    if (!roles.size) continue;
    const skill = pack.parts.find((p) => p.kind === 'skill');
    const twins = ['claude', 'codex'].map((h) => ({ h, file: skill.files.map((f) => path.join(ROOT, f.from || f)).find((f) => f.includes(`/skills/${h}/`) && f.endsWith('SKILL.md')) }));
    for (const { h, file } of twins) {
      ok(`${pack.id}: its ${h} SKILL.md exists`, !!file && fs.existsSync(file), JSON.stringify(skill.files).slice(0, 200));
      if (!file) continue;
      const text = fs.readFileSync(file, 'utf8');
      // A variant documented only in some twins says so (`twins`); its roles are checked there only.
      const only = (pack.workflow.variants || []).filter((v) => v.twins && !v.twins.includes(h)).map((v) => v.id);
      const need = new Set();
      for (const s of pack.workflow.steps) {
        if (s.role) need.add(s.role);
        for (const [v, o] of Object.entries(s.variants || {})) if (!only.includes(v)) { if (o.role) need.add(o.role); if (o.also) need.add(o.also); }
      }
      const missing = [...need].filter((r) => !new RegExp(`\\b${r}\\b`).test(text));
      ok(`${pack.id}: every role its workflow names is in the ${h} SKILL.md`, missing.length === 0, missing.join(', '));
    }
  }
}

/* ── the route: workflow passed through, the security setting read (R2a, R2d) ── */
console.log('\nthe catalog route: workflow and the review gate\'s security setting');
const sb = sandbox('wf', { clis: ['claude', 'codex'] });
const m = machine(sb.env);
{
  const view = catalogView(m, { installedOf: () => true });
  ok('every pack carries its workflow through the route', view.packs.every((p) => p.workflow && JSON.stringify(p.workflow) === JSON.stringify(catalog.find((c) => c.id === p.id).workflow)));
  ok('no home review config: security is "off"', view.settings?.security === 'off' && securitySetting(m) === 'off', JSON.stringify(view.settings));
  const cfg = path.join(sb.home, '.agent-config-studio', 'review-gate', 'config.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  for (const level of ['required', 'always', 'off']) {
    fs.writeFileSync(cfg, JSON.stringify({ security: { run: level } }));
    ok(`security.run "${level}" in the home config reads as "${level}"`, securitySetting(m) === level);
  }
  fs.writeFileSync(cfg, JSON.stringify({ security: { run: 'sometimes' } }));
  ok('an unknown level reads as "off"', securitySetting(m) === 'off');
  fs.writeFileSync(cfg, '{ not json');
  ok('a malformed config reads as "off", never throws', securitySetting(m) === 'off');
  fs.writeFileSync(cfg, JSON.stringify({ security: { run: 'required' } }));
}

/* ── the page: the diagrams, drawn from the roles the studio has now ─── */
const member = (family, effort) => ({ family, own: '', effort });
const role = (name, fams, effort, extra = {}) => ({ name, use: fams, ids: fams.map((f) => ID[f]), effort, resolvedEffort: effort, members: fams.map((f) => member(f, effort)),
  altMember: null, alt: '', altId: '', note: '', custom: false, provenance: {}, defaults: null, warnings: [], ...extra });
const ID = { fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sol: 'gpt-6-sol', astra: 'gpt-6-astra', grok: 'grok-4.7' };
const rolesView = (over = {}) => ({
  roles: [
    role('advisor', ['fable'], 'high', { alt: 'astra', altId: ID.astra, altMember: member('astra', 'high') }),
    role('builder', ['opus', 'sol'], 'high'),
    role('investigator', ['fable'], 'high'),
    role('judge', ['fable'], 'high'),
    role('reviewer', ['opus', 'sol'], 'xhigh'),
    { name: 'security', unset: true, use: [], ids: [], effort: '', resolvedEffort: '', members: [], altMember: null, alt: '', altId: '', note: '', custom: false, provenance: {}, defaults: null, warnings: [] },
    ...(over.extra || []),
  ].map((r) => (over[r.name] ? { ...r, ...over[r.name] } : r)),
  flavor: [], families: Object.keys(ID), efforts: ['low', 'medium', 'high', 'xhigh', 'max'], limits: {}, base: 'b', userText: '{}', error: null, userFile: '~/x',
  describe: { harness: 'claude', label: 'Claude', installed: true, model: 'x', modelLabel: 'X', ready: true, why: null, running: false, limits: { description: 4000 } },
});
const status = () => ({ job: { running: false, result: { packs: [], legacy: [], checkedAt: Date.now(), trust: false } } });

const state = { catalog: catalogView(m, { installedOf: () => true }), roles: rolesView(), roleGets: 0 };
state.catalog.settings.security = 'off';
const routes = routesFor({
  'GET /api/packs': () => state.catalog,
  'GET /api/packs/status': status,
  'GET /api/models/roles': () => { state.roleGets++; return state.roles; },
  'GET /api/models': () => ({ pending: 0, checkedAt: Date.now(), catalogs: [], claudeVersion: null, rows: [] }),
  'GET /api/model-guide': () => ({ targets: [], rolesError: null }),
  'GET /api/models/where': () => ({ hits: [], roles: [] }),
  'POST /api/models/roles/set': () => ({ saved: true, base: 'b2', warnings: [] }),
});

try {
  console.log('\nthe Packs card draws each workflow (B1)');
  const page = await bootPage({ routes, hash: '#packs' });
  const c = () => page.$('content');
  for (let i = 0; i < 100 && !c().querySelector('.pk-card .flow'); i++) await sleep(30);
  await settle(10);
  const t = (n) => (n ? page.text(n) : '');
  const card = (id) => c().querySelector(`[data-pack="${id}"]`);
  const step = (pack, id) => card(pack)?.querySelector(`.step[data-step="${id}"]`);
  const who = (pack, id) => t(step(pack, id)?.querySelector('.who'));

  ok('every pack draws a diagram or a one-line strip', catalog.every((p) => (p.workflow.strip ? !!card(p.id)?.querySelector('.pk-strip') : card(p.id)?.querySelectorAll('.step').length === p.workflow.steps.length)),
    catalog.map((p) => `${p.id}:${card(p.id)?.querySelectorAll('.step').length}`).join(' '));
  const kids = card('review-gate').children;
  const at = kids.findIndex((k) => k.classList.contains('pk-summary'));
  ok('the diagram comes right after the one-line summary', at !== -1 && kids[at + 1]?.classList.contains('pk-flow'), kids.map((k) => k.className).join(' '));
  ok('Packs asked for the roles itself when it opened (R3)', state.roleGets === 1, state.roleGets);
  ok('a pool step lists its members: "reviewer — Opus or Sol · picked per review"', /^reviewer/.test(who('review-gate', 'review')) && /Opus or Sol/.test(who('review-gate', 'review')) && /picked per review/.test(who('review-gate', 'review')),
    who('review-gate', 'review'));
  ok('a single-model role shows the model and its effort: "advisor — Fable · high"', /advisor/.test(who('build', 'bounce')) && /Fable · high/.test(who('build', 'bounce')), who('build', 'bounce'));
  ok('the Grade step computes the swap from the ids: "Astra instead when the builder is the same vendor as Fable"',
    /judge/.test(who('build', 'grade')) && /Fable · high/.test(who('build', 'grade')) && /Astra instead when the builder is the same vendor as Fable/.test(who('build', 'grade')), who('build', 'grade'));
  const unset = step('review-gate', 'security')?.querySelector('a.w-unset');
  ok('an unset role reads "not set — choose", linked to its row on Models', t(unset) === 'not set — choose' && unset.getAttribute('href') === '#models' && unset.dataset.role === 'security',
    who('review-gate', 'security'));
  ok('who is you, your session agent, or a script with no model', /^you\b/.test(who('build', 'judge')) && /your session agent/.test(who('build', 'understand'))
    && /script — no model/.test(who('review-gate', 'quote')) && /git hook — no model/.test(who('review-gate', 'gate')), `${who('build', 'judge')} | ${who('build', 'understand')} | ${who('review-gate', 'quote')}`);
  ok('pr says no extra model is called', /No extra model is called/.test(t(card('pr').querySelector('.pk-flow-note'))));
  ok('build notes its lightweight mode', /lightweight/i.test(t(card('build').querySelector('.pk-flow-note'))));
  ok('the strips: handoff says your session agent writes it, with no extra model', /your session agent/i.test(t(card('handoff').querySelector('.pk-strip'))) && /no extra model/i.test(t(card('handoff').querySelector('.pk-strip'))));
  ok('a legend says what each kind of chip means', card('review-gate').querySelectorAll('.legend li').length === 4);

  console.log('\nsteps dim when their part or setting is off (R5)');
  ok('security off in the home config: the security pass is dimmed and marked "off"', step('review-gate', 'security').classList.contains('off') && t(step('review-gate', 'security').querySelector('.step-off')) === 'off');
  ok('a step with neither is always on', !step('review-gate', 'quote').classList.contains('off') && !step('review-gate', 'review').classList.contains('off'));
  ok('the push gate part is not picked: its step is dimmed', step('review-gate', 'gate').classList.contains('off'));
  const box = (label) => card('review-gate').querySelectorAll('.pk-part label').find((l) => new RegExp(label, 'i').test(t(l)))?.querySelector('input');
  box('Push gate').click();
  await settle(5);
  ok('tick the push gate part: its step comes on', !step('review-gate', 'gate').classList.contains('off'));
  box('Push gate').click();
  await settle(5);
  ok('untick it: the step dims again', step('review-gate', 'gate').classList.contains('off'));

  console.log('\nvariant tabs (R4)');
  const tabs = card('review-gate').querySelectorAll('.pk-tab');
  ok('four tabs, Standard selected', tabs.length === 4 && tabs[0].getAttribute('aria-selected') === 'true' && tabs.every((b) => b.getAttribute('role') === 'tab'));
  tabs.find((b) => t(b) === 'Premium').click();
  await settle(5);
  ok('Premium: the review is the judge — "Fable · high", one pass', /judge/.test(who('review-gate', 'review')) && /Fable · high/.test(who('review-gate', 'review')) && !/Opus or Sol/.test(who('review-gate', 'review')),
    who('review-gate', 'review'));
  ok('…the tab says it is a Claude Code command', /Claude Code/.test(t(card('review-gate').querySelector('.pk-flow-hint'))), t(card('review-gate').querySelector('.pk-flow-hint')));
  card('review-gate').querySelectorAll('.pk-tab').find((b) => t(b) === 'Both').click();
  await settle(5);
  ok('Both: the pool, then the judge double-checks', /Opus or Sol/.test(who('review-gate', 'review')) && /judge/.test(who('review-gate', 'review')), who('review-gate', 'review'));
  card('review-gate').querySelectorAll('.pk-tab').find((b) => t(b) === 'Claude team').click();
  await settle(5);
  ok('Claude team: only the pool\'s Claude families', /Opus/.test(who('review-gate', 'review')) && !/Sol/.test(who('review-gate', 'review')), who('review-gate', 'review'));
  card('advisor').querySelectorAll('.pk-tab').find((b) => t(b) === 'Second').click();
  await settle(5);
  ok('advisor Second: the role\'s second opinion, Astra · high', /Astra · high/.test(who('advisor', 'ask')) && !/Fable/.test(who('advisor', 'ask')), who('advisor', 'ask'));

  console.log('\nlive roles: change one on Models, open Packs, the diagram follows (R3)');
  state.roles = rolesView({ reviewer: { use: ['grok'], ids: [ID.grok], members: [member('grok', 'high')], resolvedEffort: 'high', effort: 'high' } });
  page.$('btn-models')?.click() ?? page.eval("location.hash = '#models'");
  for (let i = 0; i < 100 && page.eval('S.view') !== 'models'; i++) await sleep(20);
  page.$('btn-packs').click();
  for (let i = 0; i < 100 && !/Grok/.test(who('review-gate', 'fix') + who('review-gate', 'check') + who('review-gate', 'review')); i++) await sleep(30);
  ok('Packs asks for the roles again on open, and the review now names Grok', state.roleGets >= 2 && /Grok · high/.test(who('review-gate', 'check')), `${state.roleGets} ${who('review-gate', 'check')}`);
  ok('no page errors', page.errors.length === 0, page.errors.join(' | '));
  page.done();

  console.log('\nModels: each role row says which steps use it (R10)');
  state.roles = rolesView();
  const mp = await bootPage({ routes, hash: '#models' });
  for (let i = 0; i < 100 && !mp.$('content').querySelector('.roles-steps'); i++) await sleep(30);
  await settle(10);
  const steps = (name) => mp.text(mp.$('content').querySelectorAll('.roles-row').find((r) => r.dataset.role === name)?.querySelector('.roles-steps') || { textContent: '' });
  ok('reviewer: "Steps: /code-review · Review, Fix check …"', /^Steps:/.test(steps('reviewer')) && /\/code-review · Review/.test(steps('reviewer')) && /Fix check/.test(steps('reviewer')), steps('reviewer'));
  ok('judge: the Grade in /build and Premium review', /\/build · Grade/.test(steps('judge')) && /\/code-review · Review \(Premium\)/.test(steps('judge')), steps('judge'));
  ok('security: its step says it is off', /\/code-review · Security pass \(off\)/.test(steps('security')), steps('security'));
  ok('investigator: no pack uses it', /no pack uses it/.test(steps('investigator')), steps('investigator'));
  ok('family cards keep "Used by N roles"', !mp.$('content').querySelector('.model-card') || mp.$('content').querySelectorAll('.model-used-toggle').every((b) => /Used by/.test(mp.text(b))));
  ok('no page errors on Models', mp.errors.length === 0, mp.errors.join(' | '));
  mp.done();

  // Models without the packs route answering (an older server, a failure): no Steps line, no error.
  const bare = await bootPage({ routes: routesFor({ 'GET /api/models/roles': () => rolesView(), 'GET /api/models': () => ({ pending: 0, checkedAt: Date.now(), catalogs: [], rows: [] }) }), hash: '#models' });
  await settle(30);
  ok('Models still renders when /api/packs fails, with no Steps line and no page error', !!bare.$('content').querySelector('.roles-row') && bare.errors.length === 0, bare.errors.join(' | '));
  bare.done();
} catch (e) {
  ok(`no test block threw (${e?.message || e})`, false, e?.stack || String(e));
} finally {
  done();
}
