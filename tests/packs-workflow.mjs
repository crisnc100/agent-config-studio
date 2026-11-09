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
  ok('review-gate: the /pr-review flow, with no variant tabs (the reviewer tiers are /code-review\'s)', rg.command === '/pr-review' && !rg.variants?.length, JSON.stringify(rg.variants));
  ok('review-gate: the steps /pr-review names, in order', JSON.stringify(rg.steps.map((s) => s.id)) === '["review","security","fix","dispute","check","close","gate","pr"]',
    JSON.stringify(rg.steps.map((s) => s.id)));
  ok('…the code review and the security check run side by side, and the note says each runs alone too', rg.steps.find((s) => s.id === 'security').beside === 'review'
    && rg.steps.filter((s) => s.beside).length === 1 && /\/code-review/.test(rg.note || '') && /\/security-check/.test(rg.note || ''), JSON.stringify(rg.note));
  // PR C: eight steps share one row, so each says what it does in one short line.
  const whats = rg.steps.flatMap((st) => [st.what, ...Object.values(st.variants || {}).map((o) => o.what)]).filter(Boolean);
  ok('review-gate: every step\'s description is one short line (36 characters at most)', whats.every((w) => w.length <= 36), whats.filter((w) => w.length > 36).join(' | '));
  ok('…the security pass follows the security setting, the push gate its part', rg.steps.find((s) => s.id === 'security').setting === 'security'
    && rg.steps.find((s) => s.id === 'gate').part === 'push-gate');
  const build = catalog.find((p) => p.id === 'build').workflow;
  ok('build: Understand, Shape, Bounce, you approve, Build, Grade, you judge — and a lightweight note',
    JSON.stringify(build.steps.map((s) => [s.id, s.who, s.role || null])) === JSON.stringify([['understand', 'agent', null], ['shape', 'agent', null], ['bounce', 'role', 'advisor'], ['approve', 'you', null], ['build', 'role', 'builder'], ['grade', 'role', 'judge'], ['judge', 'you', null]])
      && /lightweight/i.test(build.note || '') && /then \/code-review\.$/.test(build.note || ''), JSON.stringify(build.steps.map((s) => s.id)));
  ok('build: the Grade step carries the vendor swap', build.steps.find((s) => s.id === 'grade').swap === 'grade');
  const pr = catalog.find((p) => p.id === 'pr').workflow;
  ok('pr: facts script, your agent writes, --check, gh — and "no extra model is called"', pr.steps.map((s) => s.who).join() === 'script,agent,script,script'
    && /no extra model is called/i.test(pr.note || ''));
  const adv = catalog.find((p) => p.id === 'advisor').workflow;
  ok('advisor: Advisor, Second and Both tabs', JSON.stringify(adv.variants.map((v) => v.id)) === '["advisor","second","both"]');
  ok('review-gate: the two reviewers are named by their skills', /\/code-review/.test(rg.steps.find((s) => s.id === 'review').what) && /\/security-check/.test(rg.steps.find((s) => s.id === 'security').what),
    JSON.stringify(rg.steps.slice(0, 2).map((s) => s.what)));
  const so = catalog.find((p) => p.id === 'second-opinion').workflow.steps.find((s) => s.id === 'ask');
  ok('second-opinion "Its take": the advisor and its second opinion, plus the reviewer pool (f1)', so.role === 'advisor' && so.use === 'both' && so.also === 'reviewer', JSON.stringify(so));
  ok('every summary in plain words: no "ACS", no "Frame, Bar and Judge", no "role" jargon', catalog.every((p) => !/\bACS\b|Frame, Bar|\brole\b/.test(p.summary)),
    catalog.filter((p) => /\bACS\b|Frame, Bar|\brole\b/.test(p.summary)).map((p) => `${p.id}: ${p.summary}`).join(' | '));
  ok('the strips say who does them: handoff and flag your session agent, worktree you', ['handoff', 'flag'].every((id) => catalog.find((p) => p.id === id).workflow.stripWho === 'agent')
    && catalog.find((p) => p.id === 'worktree').workflow.stripWho === 'you');
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
  bad('a step override for a variant that does not exist', (w) => { (w.steps[0].variants ??= {}).nope = { what: 'x' }; }, /variant/);
  bad('a step beside a step that is not the one before it', (w) => { w.steps[3].beside = 'review'; }, /beside/);
  bad('a step beside one that is itself beside another', (w) => { w.steps[2].beside = 'security'; }, /beside/);
  bad('the first step beside anything', (w) => { w.steps[0].beside = 'security'; }, /beside/);
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
    // The skill the card's command runs (/pr-review in the review gate's part of three skills), else the part's first.
    const own = (h) => skill.files.map((f) => path.join(ROOT, f.from || f)).filter((f) => f.includes(`/skills/${h}/`) && f.endsWith('SKILL.md'))
    const twins = ['claude', 'codex'].map((h) => ({ h, file: own(h).find((f) => f.endsWith(`/${pack.workflow.command.replace(/^\//, '')}/SKILL.md`)) || own(h)[0] }));
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
  'POST /api/packs/plan': (b) => ({ packs: [b.pack], units: [], requirements: [], notes: [], preview: [{ path: '~/x/SKILL.md', symbol: '+', what: 'new file' }],
    warnings: [], kept: [], refusals: [], roles: [], changes: true, signature: 'sig' }),
  'POST /api/packs/apply': (b) => { state.applied.push(b); return { units: [b.pack], packs: [b.pack], backupDir: null, kept: [], notes: [], warnings: [], log: [] }; },
});
state.applied = [];

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
  ok('a pool step lists its members with their efforts: "reviewer — Opus · xhigh or Sol · xhigh · picked per review"', /^reviewer/.test(who('review-gate', 'review'))
    && /Opus · xhigh or Sol · xhigh/.test(who('review-gate', 'review')) && /picked per review/.test(who('review-gate', 'review')), who('review-gate', 'review'));
  ok('…each model name in its own unbreakable span, so a chip never wraps mid-name', step('review-gate', 'review').querySelectorAll('.w-m').map(t).join('|') === 'Opus · xhigh|Sol · xhigh',
    step('review-gate', 'review').querySelectorAll('.w-m').map(t).join('|'));
  ok('a single-model role shows the model and its effort: "advisor — Fable · high"', /advisor/.test(who('build', 'bounce')) && /Fable · high/.test(who('build', 'bounce')), who('build', 'bounce'));
  ok('the Grade step computes the swap from the ids: "Astra instead when the builder is the same vendor as Fable"',
    /judge/.test(who('build', 'grade')) && /Fable · high/.test(who('build', 'grade')) && /Astra instead when the builder is the same vendor as Fable/.test(who('build', 'grade')), who('build', 'grade'));
  // An unset role: the chip says "not set" quietly; one line per card links to the first unset role's row (design 3, f2).
  const quiet = step('review-gate', 'security')?.querySelector('.w-unset');
  ok('an unset role\'s chip says "not set", quietly, with no link of its own', t(quiet) === 'not set' && quiet.localName !== 'a', who('review-gate', 'security'));
  const line = card('review-gate').querySelector('.pk-unset');
  const go = line?.querySelector('a');
  ok('…and one line per card: "1 role not set — choose it on Models", linked to that role\'s row', /^1 role not set — choose it on Models$/.test(t(line))
    && go?.getAttribute('href') === '#models&role=security', `${t(line)} ${go?.getAttribute('href')}`);
  ok('…a card whose roles are all set has no such line', !card('build').querySelector('.pk-unset'));
  ok('every card header names its command: /code-review, /build, /pr, /advisor, /second-opinion, /handoff, /flag, wnew',
    catalog.every((p) => t(card(p.id).querySelector('.pk-head .cmd')) === p.workflow.command), catalog.map((p) => t(card(p.id).querySelector('.pk-head .cmd'))).join(' '));
  ok('the handoff strip carries its who-chip, "your session agent", coloured like the diagrams', t(card('handoff').querySelector('.pk-strip .w.agent')) === 'your session agent'
    && t(card('worktree').querySelector('.pk-strip .w.you')) === 'you');
  ok('…and its card head shows the Ready state', !!card('handoff').querySelector('.pk-head .pk-ready'));
  ok('the Grade swap: always shown', /Astra instead when the builder is the same vendor as Fable/.test(who('build', 'grade')), who('build', 'grade'));
  ok('Dispute, with two reviewers in the pool: "another model from the pool than the one that found it"', /another model from the pool than the one that found it/.test(who('review-gate', 'dispute')), who('review-gate', 'dispute'));
  ok('second-opinion "Its take": Fable · high and Astra · high, plus the reviewer pool (f1)', /Fable · high and Astra · high/.test(who('second-opinion', 'ask'))
    && /reviewer/.test(who('second-opinion', 'ask')) && /Opus · xhigh or Sol · xhigh/.test(who('second-opinion', 'ask')), who('second-opinion', 'ask'));
  ok('no-model steps and off steps are narrow tiles, so role steps get the width (design 1)', step('review-gate', 'close').classList.contains('narrow')
    && step('review-gate', 'security').classList.contains('narrow') && !step('review-gate', 'review').classList.contains('narrow'));
  ok('who is you, your session agent, or a script with no model', /^you\b/.test(who('build', 'judge')) && /your session agent/.test(who('build', 'understand'))
    && who('review-gate', 'close') === 'script' && who('review-gate', 'gate') === 'git hook' && who('review-gate', 'pr') === 'your session agent',
    `${who('build', 'judge')} | ${who('build', 'understand')} | ${who('review-gate', 'close')} | ${who('review-gate', 'gate')} | ${who('review-gate', 'pr')}`);
  const pair = card('review-gate').querySelector('.flow .step-pair');
  ok('the code review and the security check share one column, marked "at the same time", and the arrow leaves the pair', !!pair
    && pair.querySelectorAll('.step').map((x) => x.dataset.step).join() === 'review,security' && /at the same time/.test(t(pair.querySelector('.pair-note')))
    && pair.parentNode === card('review-gate').querySelector('.flow') && card('review-gate').querySelector('.flow').children.length === 7, t(pair));
  ok('pr says no extra model is called', /No extra model is called/.test(t(card('pr').querySelector('.pk-flow-note'))));
  ok('build notes its lightweight mode', /lightweight/i.test(t(card('build').querySelector('.pk-flow-note'))));
  ok('the strips: handoff says your session agent writes it, with no extra model', /your session agent/.test(t(card('handoff').querySelector('.pk-strip'))) && /no extra model/i.test(t(card('handoff').querySelector('.pk-strip'))));
  // The legend lists only the kinds a diagram uses, and carries "no model" for the scripts (PR C QA).
  const legend = (id) => card(id).querySelectorAll('.legend li').map((li) => t(li));
  // PR D: an off step is in the legend too, in its own look (dashed), apart from a script (solid outline).
  ok('a legend says what each kind of chip in that diagram means — only those, and "off" when a step is off', JSON.stringify(legend('review-gate')) === '["a role from Models","your session agent","a script — no model","off — not turned on"]'
    && JSON.stringify(legend('build')) === '["a role from Models","your session agent","you"]', `${legend('review-gate')} | ${legend('build')}`);
  ok('…the "off" swatch carries the off look, the script swatch its own', !!card('review-gate').querySelector('.legend .wf-sw.off') && !!card('review-gate').querySelector('.legend .wf-sw.script'));
  ok('eight or more steps lay out in rows of four; seven or fewer stay one row', card('review-gate').querySelector('.flow').classList.contains('rows')
    && !card('build').querySelector('.flow').classList.contains('rows'));
  ok('a part\'s "What this part is and changes" is a quiet fold, not an action', card('review-gate').querySelectorAll('.pk-part summary.fold').length > 0);

  console.log('\nsteps dim when their part or setting is off (R5)');
  ok('security off in the home config: the security pass is dimmed and marked "off"', step('review-gate', 'security').classList.contains('off') && t(step('review-gate', 'security').querySelector('.step-off')) === 'off');
  ok('a step with neither is always on', !step('review-gate', 'close').classList.contains('off') && !step('review-gate', 'review').classList.contains('off'));
  ok('the push gate part is not picked: its step is dimmed', step('review-gate', 'gate').classList.contains('off'));
  const box = (label) => card('review-gate').querySelectorAll('.pk-part label').find((l) => new RegExp(label, 'i').test(t(l)))?.querySelector('input');
  box('Push gate').click();
  await settle(5);
  ok('tick the push gate part: its step comes on', !step('review-gate', 'gate').classList.contains('off'));
  box('Push gate').click();
  await settle(5);
  ok('untick it: the step dims again', step('review-gate', 'gate').classList.contains('off'));

  console.log('\nvariant tabs (R4)');
  ok('review-gate has no tabs', card('review-gate').querySelectorAll('.pk-tab').length === 0);
  const tabs = card('advisor').querySelectorAll('.pk-tab');
  ok('advisor: three tabs, the first selected', tabs.length === 3 && tabs[0].getAttribute('aria-selected') === 'true' && tabs.every((b) => b.getAttribute('role') === 'tab'));
  card('advisor').querySelectorAll('.pk-tab').find((b) => t(b) === 'Second').click();
  await settle(5);
  ok('advisor Second: the role\'s second opinion, Astra · high', /Astra · high/.test(who('advisor', 'ask')) && !/Fable/.test(who('advisor', 'ask')), who('advisor', 'ask'));
  card('advisor').querySelectorAll('.pk-tab').find((b) => t(b) === 'Both').click();
  await settle(5);
  ok('advisor Both: "Fable · high and Astra · high", blind, in parallel (design 4)', /Fable · high and Astra · high/.test(who('advisor', 'ask')) && /blind, in parallel/.test(who('advisor', 'ask')), who('advisor', 'ask'));

  console.log('\nf3: an install refreshes the roles the diagrams show');
  const before = state.roleGets;
  card('handoff').querySelectorAll('.pk-actions button').find((b) => /^Preview install/.test(t(b))).click();
  for (let i = 0; i < 100 && !card('handoff').querySelector('.pk-apply'); i++) await sleep(20);
  card('handoff').querySelector('.pk-apply').click();
  for (let i = 0; i < 100 && !state.applied.length; i++) await sleep(20);
  for (let i = 0; i < 100 && state.roleGets === before; i++) await sleep(20);
  ok('after Install, Packs asks for the roles again (a role the install set shows at once)', state.applied.length === 1 && state.roleGets > before, `${state.applied.length} ${before}→${state.roleGets}`);

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
  ok('reviewer: "Steps: /pr-review · Code review, Dispute, Fix check …"', /^Steps:/.test(steps('reviewer')) && /\/pr-review · Code review/.test(steps('reviewer')) && /Fix check/.test(steps('reviewer')), steps('reviewer'));
  ok('judge: the Grade in /build, and no /pr-review step', /\/build · Grade/.test(steps('judge')) && !/\/pr-review/.test(steps('judge')), steps('judge'));
  ok('security: its step says it is off', /\/pr-review · Security check \(off\)/.test(steps('security')), steps('security'));
  ok('investigator: no pack uses it', /no pack uses it/.test(steps('investigator')), steps('investigator'));
  ok('family cards keep "Used by N roles"', !mp.$('content').querySelector('.model-card') || mp.$('content').querySelectorAll('.model-used-toggle').every((b) => /Used by/.test(mp.text(b))));
  ok('no page errors on Models', mp.errors.length === 0, mp.errors.join(' | '));
  mp.done();

  console.log('\nf2: "choose it on Models" lands on that role\'s row, editor open');
  const dl = await bootPage({ routes, hash: '#models&role=security' });
  for (let i = 0; i < 100 && !dl.$('content').querySelector('.roles-row[data-role="security"]'); i++) await sleep(30);
  await settle(20);
  const row = dl.$('content').querySelectorAll('.roles-row').find((r) => r.dataset.role === 'security');
  ok('#models&role=security opens the security role\'s editor and focuses its row', row?.getAttribute('aria-expanded') === 'true' && dl.eval('document.activeElement') === row,
    `${row?.getAttribute('aria-expanded')} ${dl.eval('document.activeElement')?.className}`);
  ok('…with no page errors', dl.errors.length === 0, dl.errors.join(' | '));
  dl.done();

  console.log('\nA: the Grade swap when the advisor has no second opinion; Dispute with one reviewer');
  state.roles = rolesView({ advisor: { alt: '', altId: '', altMember: null }, reviewer: { use: ['opus'], ids: [ID.opus], members: [member('opus', 'xhigh')] } });
  const np = await bootPage({ routes, hash: '#packs' });
  for (let i = 0; i < 100 && !np.$('content').querySelector('.pk-card .flow'); i++) await sleep(30);
  await settle(10);
  const nwho = (pack, id) => np.text(np.$('content').querySelector(`[data-pack="${pack}"] .step[data-step="${id}"] .who`) || { textContent: '' });
  ok('no second opinion: "the advisor\'s second opinion instead (not set)"', /the advisor.s second opinion instead \(not set\)/.test(nwho('build', 'grade')), nwho('build', 'grade'));
  ok('one reviewer: Dispute says "a different model than the reviewer"', /a different model than the reviewer/.test(nwho('review-gate', 'dispute')) && !/from the pool/.test(nwho('review-gate', 'dispute')), nwho('review-gate', 'dispute'));
  ok('…with no page errors', np.errors.length === 0, np.errors.join(' | '));
  np.done();
  state.roles = rolesView();

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
