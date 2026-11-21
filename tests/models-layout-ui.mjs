/**
 * The Models panel's layout (Jobs, Your models, Model ids, Model guide) in the
 * fake DOM against stubbed routes: the effort each lineup chip shows, the
 * second-opinion label, Model ids folded until an alert waits, a card's
 * save and reset requests, and "changed from default" only where a field
 * differs. No server, no HOME.
 */
import { bootPage, routesFor, settle } from './fixtures/shell-page.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\nmodels layout ui');

const row = (family, alerts = []) => ({ family, id: `${family}-id-1`, vendor: family === 'grok' ? 'grok' : family === 'sol' || family === 'astra' ? 'codex' : 'claude', track: true, source: 'default', defaultId: `${family}-id-1`, alerts });
const models = (alerts = []) => ({
  pending: alerts.length, checkedAt: Date.now(), catalogs: [], claudeVersion: null,
  rows: [row('opus', alerts), row('sol'), row('grok'), row('fable'), row('astra')],
});
const ALERT = { kind: 'update', key: 'update:opus-id-2', candidate: 'opus-id-2', displayName: 'Opus 6', acceptable: true, dismissed: false };
const prov = (fields, over = {}) => Object.fromEntries(fields.map((f) => [f, over[f] || 'default']));
const fl = (family, flavor, over = {}, defaults = flavor) => ({ family, flavor, provenance: prov(Object.keys(flavor), over), defaults });
const view = () => ({
  roles: [
    // No effort of its own: each model runs at its default effort.
    { name: 'reviewer', use: ['opus', 'sol', 'grok', 'fable'], ids: ['opus-id-1', 'sol-id-1', 'grok-id-1', 'fable-id-1'], effort: '', resolvedEffort: 'high',
      alt: 'astra', altId: 'astra-id-1', note: 'reads a diff and reports findings', custom: false,
      provenance: prov(['use', 'effort', 'alt', 'note'], { use: 'user', effort: 'cleared' }),
      defaults: { use: 'astra', effort: 'high', alt: 'astra', note: 'reads a diff and reports findings' }, warnings: [] },
    // Its own effort wins over every model's default.
    { name: 'builder', use: ['opus', 'grok'], ids: ['opus-id-1', 'grok-id-1'], effort: 'medium', resolvedEffort: 'medium', alt: '', altId: '', note: 'implements from a brief',
      custom: false, provenance: prov(['use', 'effort', 'note']), defaults: { use: ['opus', 'grok'], effort: 'medium', note: 'implements from a brief' }, warnings: [] },
    // Yours, but set to exactly the default: not a change.
    { name: 'judge', use: ['fable'], ids: ['fable-id-1'], effort: 'high', resolvedEffort: 'high', alt: '', altId: '', note: 'grades work',
      custom: false, provenance: prov(['use', 'effort', 'note'], { effort: 'user' }), defaults: { use: 'fable', effort: 'high', note: 'grades work' }, warnings: [] },
  ],
  flavor: [
    fl('opus', { likes: ['builds'], quirks: ['challenges'], brief: 'Name the files.', effort: 'high' }),
    fl('sol', { likes: ['keeps going'], quirks: ['over-builds'], brief: 'State the stop condition.', effort: 'high' }, { brief: 'user' },
      { likes: ['keeps going'], quirks: ['over-builds'], brief: 'Set limits.', effort: 'high' }),
    fl('grok', { likes: ['backend'], quirks: [], brief: 'Spell it out.', effort: 'xhigh' }),
    fl('fable', { likes: ['judgment'], quirks: ['costly'], brief: 'Ask for a verdict.', effort: 'high' }),
    fl('astra', { likes: ['review'], quirks: ['slow'], brief: 'Give it the diff.', effort: 'high' }),
  ],
  families: ['opus', 'sol', 'grok', 'fable', 'astra'],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  limits: { brief: 600, item: 160, items: 12, note: 160, use: 8 },
  base: 'sha256:base-1', userText: '{}\n', error: null, userFile: '~/.agent-config-studio/roles.json',
  describe: { harness: 'claude', label: 'Claude', installed: true, model: 'm', modelLabel: 'M', ready: true, why: null, running: false, limits: { description: 4000 } },
});

const pages = [];
async function boot(m = models(), over = {}) {
  const routes = routesFor({
    'GET /api/models': () => m,
    'GET /api/models/roles': () => view(),
    'GET /api/model-guide': () => ({ targets: [], rolesError: null }),
    'POST /api/models/flavor/set': () => ({ saved: true, base: 'sha256:base-2', warnings: [] }),
    'POST /api/models/flavor/reset': () => ({ saved: true, base: 'sha256:base-2', warnings: [] }),
    'GET /api/models/where': () => ({ hits: [{ file: '~/.claude/skills/x/SKILL.md', line: 3, text: 'model-id opus' }], roles: [] }),
    ...over,
  });
  const p = await bootPage({ routes, hash: '#models' });
  await settle(20);
  pages.push(p);
  return p;
}
const content = (p) => p.$('content');
const txt = (b) => b.textContent.replace(/\s+/g, ' ').trim();
const button = (root, text) => root?.querySelectorAll('button').find((b) => txt(b) === text);
const roleRow = (p, name) => content(p).querySelectorAll('.roles-row').find((r) => r.dataset.role === name);
const card = (p, family) => content(p).querySelector(`.model-card[data-family="${family}"]`);
const lineup = (r) => r.querySelectorAll('.roles-lineup .job-chip').map(txt);
const posts = (p, path) => p.requests.filter((r) => r.method === 'POST' && r.path === path);
/** The visible marker text in `root`. */
const marks = (root) => (root ? root.querySelectorAll('.changed-mark').map(txt) : []);
const ids = (p) => content(p).querySelector('.models-ids');

// ── the order: Jobs, Describe, Your models, Model ids, Model guide ───────
{
  const p = await boot();
  const kids = content(p).querySelector('.models').children;
  const at = (cls) => kids.findIndex((k) => k.classList.contains(cls));
  ok('Jobs, then Describe, then Your models, then Model ids, then Model guide',
    at('models-roles') !== -1 && at('models-roles') < at('models-describe') && at('models-describe') < at('models-families')
      && at('models-families') < at('models-ids') && at('models-ids') < at('models-guide'),
    ['models-roles', 'models-describe', 'models-families', 'models-ids', 'models-guide'].map(at).join(','));
  ok('the CLI is named only in the "For skills and scripts" note',
    /For skills and scripts/.test(p.text(content(p).querySelector('.models-scripts')))
      && !/model-id/.test([...kids].filter((k) => !k.classList.contains('models-scripts')).map((k) => p.text(k)).join(' ')));
  ok('no page errors', p.errors.length === 0, p.errors.join(' | '));
}

// ── the effort that applies, per chip ──────────────────────────────────
{
  const p = await boot();
  ok('a job with no effort runs each model at its own default: Opus · high, Sol · high, Grok · xhigh, Fable · high',
    JSON.stringify(lineup(roleRow(p, 'reviewer'))) === '["Opus · high","Sol · high","Grok · xhigh","Fable · high"]', JSON.stringify(lineup(roleRow(p, 'reviewer'))));
  ok('a job with its own effort runs every model at it, over their defaults',
    JSON.stringify(lineup(roleRow(p, 'builder'))) === '["Opus · medium","Grok · medium"]', JSON.stringify(lineup(roleRow(p, 'builder'))));
  ok('the first chip is marked as the default', roleRow(p, 'reviewer').querySelectorAll('.job-chip')[0].classList.contains('first')
    && !roleRow(p, 'reviewer').querySelectorAll('.job-chip')[1].classList.contains('first'));
  ok('several models: the hint explains the order', /First is the default; the rest are alternatives\./.test(p.text(roleRow(p, 'reviewer'))));
  ok('…and one model needs no hint', !/the rest are alternatives/.test(p.text(roleRow(p, 'judge'))));
  ok('each job reads its note as a one-line explanation', p.text(roleRow(p, 'reviewer').querySelector('.roles-note-text')) === 'reads a diff and reports findings');
}

// ── the second opinion ──────────────────────────────────────────────────
{
  const p = await boot();
  const second = roleRow(p, 'reviewer').querySelector('.roles-second');
  ok('the alt reads "Second opinion: Astra · high", at the effort that applies', second && p.text(second).startsWith('Second opinion: Astra · high'), p.text(second));
  ok('…and "Alt" appears nowhere in Jobs', !/\bAlt\b/.test(p.text(content(p).querySelector('.models-roles'))));
  ok('a job without one shows no second-opinion line', !roleRow(p, 'builder').querySelector('.roles-second'));
}

// ── "changed from default" only where a field differs ───────────────────
{
  const p = await boot();
  const rv = roleRow(p, 'reviewer');
  ok('jobs: a changed lineup carries the mark, reading "changed from default"', JSON.stringify(marks(rv.querySelector('.roles-lineup'))) === '["changed from default"]' && marks(rv).length === 1);
  ok('…an unchanged note and second opinion do not', !rv.querySelector('.roles-top .changed-mark') && !rv.querySelector('.roles-second .changed-mark'));
  ok('…an untouched job carries none', !roleRow(p, 'builder').querySelector('.changed-mark'));
  ok('…a field yours but equal to the default carries none', !roleRow(p, 'judge').querySelector('.changed-mark'));
  rv.click();
  await settle(5);
  const ed = content(p).querySelector('.roles-detail');
  const marked = ed.querySelectorAll('.roles-field').filter((f) => marks(f).join() === 'changed from default').map((f) => f.querySelector('input, select, .roles-use').className);
  ok('…in the editor, only the changed fields (models, effort) are marked',
    marked.length === 2 && /roles-use/.test(marked[0]) && /roles-effort-input/.test(marked[1]), JSON.stringify(marked));
  ok('models: only the differing field (Briefing tips) is marked on the card',
    JSON.stringify(card(p, 'sol').querySelectorAll('.model-field').filter((f) => marks(f).join() === 'changed from default').map((f) => f.className)) === '["model-field model-field-brief"]' && marks(card(p, 'sol')).length === 1);
  ok('…and an untouched card has none', !card(p, 'opus').querySelector('.changed-mark'));
  ok('no "default" or "yours" tag on every field', !/· (default|yours)\b/.test(p.text(content(p))));
}

// ── a card: what it shows, Save and Reset ───────────────────────────────
{
  const p = await boot();
  const c = card(p, 'grok');
  ok('a card per model: its name and id', c && p.text(c.querySelector('.model-card-name')) === 'Grok' && p.text(c.querySelector('.model-card-id')) === 'grok-id-1');
  ok('…Strengths, Weaknesses, Briefing tips and Default effort',
    JSON.stringify(c.querySelectorAll('.model-field-label').map(txt)) === '["Strengths","Weaknesses","Briefing tips","Default effort","Avoid for"]'
      && /backend/.test(p.text(c.querySelector('.model-field-likes'))) && /xhigh/.test(p.text(c.querySelector('.model-field-effort'))));
  ok('the one line of help is shown', /Agents read this when you hand them work — write it the way you’d brief them\./.test(p.text(content(p).querySelector('.models-families'))));

  button(c, 'Edit').click();
  await settle(5);
  const form = card(p, 'grok').querySelector('.models-flavor');
  p.input(form.querySelector('.flavor-quirks'), 'under-fills\n\n  guesses ');
  const eff = form.querySelector('.flavor-effort');
  eff.value = 'max';
  eff.dispatchEvent({ type: 'change', bubbles: false });
  button(form, 'Save').click();
  await settle(10);
  const set = posts(p, '/api/models/flavor/set');
  ok('Save sends POST /api/models/flavor/set with the family, every field and the base',
    set.length === 1 && JSON.stringify(set[0].body) === JSON.stringify({ family: 'grok', fields: { likes: ['backend'], quirks: ['under-fills', 'guesses'], brief: 'Spell it out.', effort: 'max', avoid: [] }, base: 'sha256:base-1' }),
    JSON.stringify(set));
  ok('…then the card is back to reading, and the roles are read again',
    !card(p, 'grok').querySelector('.models-flavor') && p.requests.filter((r) => r.path === '/api/models/roles').length >= 2);

  const reset = button(card(p, 'sol'), 'Reset to default');
  ok('Reset is offered on a card with your notes, not on an untouched one', reset && !reset.disabled && button(card(p, 'opus'), 'Reset to default').disabled === true);
  reset.click();
  await settle(10);
  ok('Reset sends POST /api/models/flavor/reset with the family and the base',
    JSON.stringify(posts(p, '/api/models/flavor/reset').map((r) => r.body)) === JSON.stringify([{ family: 'sol', base: 'sha256:base-1' }]));

  button(card(p, 'opus'), 'Edit').click();
  await settle(5);
  p.input(card(p, 'opus').querySelector('.flavor-brief'), 'draft');
  button(card(p, 'opus').querySelector('.models-flavor'), 'Cancel').click();
  await settle(5);
  ok('Cancel closes the form, sends nothing, and drops the draft',
    !card(p, 'opus').querySelector('.models-flavor') && posts(p, '/api/models/flavor/set').length === 1 && /Name the files\./.test(p.text(card(p, 'opus'))));

  const used = card(p, 'opus').querySelector('.model-used');
  // PR G (no folds): "Used by" is a quiet button that opens a dialog, not an in-card fold.
  ok('Used by is a button counting the roles, its detail not in the card', /Used by 2 roles/.test(p.text(used)) && !used.querySelector('.models-where-hit'));
  button(used, txt(used.querySelector('.model-used-toggle'))).click();
  await settle(10);
  const u2 = p.doc.body.querySelector('.pk-dialog');
  ok('…pressed, its dialog names the roles and the files that call it',
    !!u2 && /Roles: reviewer, builder/.test(p.text(u2)) && /SKILL\.md:3/.test(p.text(u2))
      && p.requests.some((r) => r.path === '/api/models/where' && r.search === '?family=opus'));
  p.key('Escape');
  ok('no page errors', p.errors.length === 0, p.errors.join(' | '));
}

// ── Model ids: always shown (PR G, no folds); an alert is counted on its header ─────────────
{
  const p = await boot();
  ok('no alerts: Model ids is still shown, its table drawn (no fold)', ids(p) && !!ids(p).querySelector('.models-table') && !ids(p).querySelector('[aria-expanded]'));
  ok('…Check now stays reachable on its header', !!button(ids(p), 'Check now'));
  ok('…every family listed', ids(p).querySelectorAll('.models-row').length === 5);
  content(p).querySelectorAll('.models-row').find((r) => r.dataset.family === 'sol').click();
  await settle(5);
  ok('…and a row still opens its id editor', !!ids(p).querySelector('.models-detail .models-input'));

  const q = await boot(models([ALERT]));
  ok('an alert pending: Model ids shows its table', !!ids(q).querySelector('.models-table'));
  ok('…with the count on its header', p.text(ids(q).querySelector('.ids-count')) === '1 alert');
  ok('…and the alert with its buttons', /Newer: opus-id-2/.test(q.text(ids(q))) && button(ids(q), 'Accept') && button(ids(q), 'Dismiss'));
}

// ── Avoid for: the picker, the warning line, a save that creates a conflict ──
{
  // Grok avoids builder, and builder uses grok: one conflict in a use slot.
  // Astra avoids reviewer, where it is the second opinion: one in the alt slot.
  const withAvoid = (v, conflicts) => {
    v.flavor.find((f) => f.family === 'grok').flavor.avoid = ['builder', 'gone'];
    v.flavor.find((f) => f.family === 'astra').flavor.avoid = ['reviewer'];
    v.conflicts = conflicts;
    return v;
  };
  const BOTH = [{ role: 'builder', family: 'grok', slot: 'use' }, { role: 'reviewer', family: 'astra', slot: 'alt' }];
  const state = { view: withAvoid(view(), BOTH) };
  const p = await boot(models(), {
    'GET /api/models/roles': () => state.view,
    'POST /api/models/flavor/set': (b) => {
      // The server saves and reports the conflict the save created.
      const v = withAvoid(view(), [...BOTH, { role: 'judge', family: 'fable', slot: 'use' }]);
      v.flavor.find((f) => f.family === 'fable').flavor.avoid = b.fields.avoid;
      state.view = v;
      return { saved: true, base: 'sha256:base-2', warnings: [] };
    },
  });
  ok('a job with a conflict shows the warning line', p.text(roleRow(p, 'builder').querySelector('.roles-conflict')) === "⚠ Grok is marked 'avoid for builder' on its card");
  ok('…an alt-slot conflict says it is the second opinion', p.text(roleRow(p, 'reviewer').querySelector('.roles-conflict')) === "⚠ Astra (second opinion) is marked 'avoid for reviewer' on its card");
  ok('…and a job without one shows none', !roleRow(p, 'judge').querySelector('.roles-conflict'));
  ok('the card reads its avoid list, an unknown name flagged rather than dropped', /builder, gone \(not a role\)/.test(p.text(card(p, 'grok').querySelector('.model-field-avoid'))));

  button(card(p, 'grok'), 'Edit').click();
  await settle(5);
  const boxes = card(p, 'grok').querySelectorAll('.avoid-picker input');
  ok('Avoid for is a multi-select of every role name, plus the unknown one already listed',
    JSON.stringify(boxes.map((b) => b.value)) === '["reviewer","builder","judge","gone"]'
      && JSON.stringify(boxes.filter((b) => b.checked).map((b) => b.value)) === '["builder","gone"]', JSON.stringify(boxes.map((b) => [b.value, b.checked])));
  button(card(p, 'grok').querySelector('.models-flavor'), 'Cancel').click();
  await settle(5);

  button(card(p, 'fable'), 'Edit').click();
  await settle(5);
  card(p, 'fable').querySelectorAll('.avoid-picker input').find((b) => b.value === 'judge').click();
  button(card(p, 'fable').querySelector('.models-flavor'), 'Save').click();
  await settle(15);
  const sent = posts(p, '/api/models/flavor/set').pop();
  ok('a save that creates a conflict is sent, the ticked role in avoid', JSON.stringify(sent?.body.fields.avoid) === '["judge"]', JSON.stringify(sent?.body));
  ok('…the warning shows straight away on the job', p.text(roleRow(p, 'judge').querySelector('.roles-conflict')) === "⚠ Fable is marked 'avoid for judge' on its card");
  const n = p.$('notice-slot').querySelector('.notice');
  ok('…and the notice says it saved, naming only the new conflict', n?.classList.contains('warn') && /fable notes saved\. It saved, but now:/.test(p.text(n))
    && n.querySelectorAll('li').length === 1 && /avoid for judge/.test(p.text(n)), p.text(n));
  ok('no page errors', p.errors.length === 0, p.errors.join(' | '));
}

// ── a stale installed resolver: the banner, and the refused save shown in the card ──
{
  const STALE = "Your installed model-id is older than this version of ACS and would stop working with 'Avoid for'. Run: acs install-model-id, then save again.";
  const p = await boot(models(), {
    'GET /api/models/roles': () => ({ ...view(), resolverStale: true }),
    'POST /api/models/flavor/set': () => { throw { status: 409, body: { error: STALE } }; },
  });
  ok('the Models page says the installed resolver is stale', /installed model-id is older than this version of ACS\. Run: acs install-model-id/.test(p.text(content(p).querySelector('.models-resolver-stale'))));
  button(card(p, 'grok'), 'Edit').click();
  await settle(5);
  card(p, 'grok').querySelectorAll('.avoid-picker input').find((b) => b.value === 'builder').click();
  button(card(p, 'grok').querySelector('.models-flavor'), 'Save').click();
  await settle(15);
  const form = card(p, 'grok').querySelector('.models-flavor');
  ok('a refused save shows its reason inline, in the card', form && p.text(form.querySelector('.models-write-error')) === STALE && form.querySelector('.models-write-error').getAttribute('role') === 'alert');
  ok('…the form stays open with the draft kept', form.querySelectorAll('.avoid-picker input').find((b) => b.value === 'builder').checked === true);
  button(form, 'Cancel').click();
  await settle(5);
  button(card(p, 'grok'), 'Edit').click();
  await settle(5);
  ok('…and Cancel clears the message', !card(p, 'grok').querySelector('.models-write-error'));
  const q = await boot();
  ok('no banner when the resolver is current', !content(q).querySelector('.models-resolver-stale'));
}

// ── Describe: the conflicts a proposal would create ─────────────────────
{
  const PROPOSAL = {
    id: 'a'.repeat(32), base: 'sha256:base-1', current: '{}\n', proposed: '{"version":1}\n', diff: [{ op: '+', line: '{"version":1}' }],
    conflicts: [{ role: 'builder', family: 'grok', slot: 'use' }], backend: { harness: 'claude', model: 'm', modelLabel: 'M' },
  };
  const p = await boot(models(), { 'POST /api/models/roles/describe': () => PROPOSAL });
  p.input(content(p).querySelector('.describe-text'), 'Grok should never build.');
  button(content(p).querySelector('.models-describe'), 'Describe').click();
  await settle(10);
  const prop = content(p).querySelector('.describe-proposal');
  ok('the proposal lists the conflicts it would create', /would create these conflicts/.test(p.text(prop.querySelector('.describe-conflicts')))
    && p.text(prop.querySelector('.describe-conflicts .roles-conflict')) === "⚠ Grok is marked 'avoid for builder' on its card");
  ok('…and Accept is still offered', !!button(prop, 'Accept') && !button(prop, 'Accept').disabled);
}

// ── the catalog lines: Antigravity lists its models by name ─────────────
{
  const J = JSON.stringify;
  const at = Date.now() - 5 * 60000;
  const cats = [
    { vendor: 'claude', label: 'Claude', ok: true, missing: false, fetchedAt: at, note: null, stale: false, count: 9 },
    { vendor: 'agy', label: 'Antigravity', ok: true, missing: false, fetchedAt: at, note: null, stale: false, checkOnly: true, refreshNote: null,
      count: 3, names: ['Neon Test', 'Argon Test', 'Orchestrator (Neon)'] },
  ];
  const p = await boot({ ...models(), catalogs: cats });
  // Each line is the CLI's name, then its text, in two spans.
  const lines = ids(p).querySelectorAll('.models-catalog').map((l) => l.querySelectorAll('span').map(txt).join(' | '));
  ok('Antigravity\'s line names its models', lines.some((l) => /^Antigravity \| 3 models: Neon Test, Argon Test, Orchestrator \(Neon\) · fetched /.test(l)), J(lines));
  ok('…the other lines keep their count alone', lines.some((l) => /^Claude \| 9 models · fetched /.test(l)), J(lines));
  ok('Check now says it asks Antigravity too', /Check now asks Codex to refresh its list and Antigravity for its models first; it uses no tokens\./.test(p.text(ids(p))), p.text(ids(p)));
  const q = await boot({ ...models(), catalogs: [{ vendor: 'agy', label: 'Antigravity', ok: false, missing: true, fetchedAt: null, stale: false, checkOnly: true, count: 0, names: [],
    note: 'No Antigravity catalog on this machine — press Check now to create it.', refreshNote: 'Not refreshed: the Antigravity CLI (agy) is not installed.' }] });
  const qLines = ids(q).querySelectorAll('.models-catalog').map((l) => l.querySelectorAll('span').map(txt).join(' | ') || txt(l));
  ok('no list yet: the note, and why Check now did not fill it', qLines[0] === 'Antigravity | No Antigravity catalog on this machine — press Check now to create it.'
    && qLines[1] === 'Not refreshed: the Antigravity CLI (agy) is not installed.', J(qLines));
}

// ── models added from Antigravity's list: Add, "added by you", Remove ─────
{
  const J = JSON.stringify;
  const at = Date.now() - 5 * 60000;
  const agy = { vendor: 'agy', label: 'Antigravity', ok: true, missing: false, fetchedAt: at, note: null, stale: false, checkOnly: true, refreshNote: null,
    count: 4, names: ['Neon Test', 'Argon Test', 'Hydrogen Test', 'Orchestrator (Neon)'] };
  const claude = { vendor: 'claude', label: 'Claude', ok: true, missing: false, fetchedAt: at, note: null, stale: false, count: 9 };
  const ADDABLE = [{ id: 'argon-id-1', displayName: 'Argon Test', family: 'argon' }, { id: 'hydrogen-id-1', displayName: null, family: 'hydrogen' }];
  const addedRow = { family: 'xenon', id: 'xenon-id-1', vendor: 'agy', track: true, source: 'added', defaultId: null, displayName: 'Xenon Test', alerts: [] };
  const withAdded = (over = {}) => ({ ...models(), catalogs: [claude, agy], rows: [...models().rows, addedRow], addable: ADDABLE, familiesError: null, familiesHidden: {}, ...over });
  const lineText = (l) => l.querySelectorAll('span').filter((x) => !x.querySelector('span')).map(txt).join(' | ');
  const addLine = (p) => ids(p).querySelector('.models-addable');
  const notice = (p) => p.$('notice-slot').querySelector('.notice');

  const adopted = [];
  let after = null;
  const p = await boot(withAdded(), {
    'GET /api/models': () => after || withAdded(),
    'POST /api/models/adopt': (b) => {
      adopted.push(b);
      if (b.id === 'hydrogen-id-1') throw { status: 409, body: { error: 'A family named hydrogen already exists, so hydrogen-id-1 cannot be added under that name.' } };
      after = withAdded({ addable: ADDABLE.slice(1) });
      return { saved: true, family: 'argon', id: 'argon-id-1' };
    },
  });
  const lines = ids(p).querySelectorAll('.models-catalog');
  const agyAt = lines.findIndex((l) => /^Antigravity/.test(txt(l)));
  ok('"Not added yet" sits right under the Antigravity line', agyAt >= 0 && lines[agyAt + 1]?.classList.contains('models-addable'), J(lines.map(txt)));
  ok('...listing each model with an Add naming the family it becomes', lineText(addLine(p)) === 'Not added yet | Argon Test | hydrogen-id-1'
    && J(addLine(p).querySelectorAll('button').map(txt)) === '["Add as argon","Add as hydrogen"]', lineText(addLine(p)));
  button(addLine(p), 'Add as argon').click();
  await settle(20);
  ok('Add posts the id alone', J(adopted) === '[{"id":"argon-id-1"}]', J(adopted));
  ok('...says what it added, and the list is fetched again', /argon added: it points to argon-id-1\./.test(p.text(notice(p)))
    && !addLine(p).querySelectorAll('button').some((b) => txt(b) === 'Add as argon'), p.text(notice(p)));
  button(addLine(p), 'Add as hydrogen').click();
  await settle(20);
  ok('a refused Add shows why', notice(p)?.classList.contains('error') && /A family named hydrogen already exists/.test(p.text(notice(p))), p.text(notice(p)));

  const row = ids(p).querySelectorAll('.models-row').find((r) => r.dataset.family === 'xenon');
  ok('an added family\'s row says "added by you"', txt(row.querySelector('.models-source')) === 'added by you', txt(row));
  ok('...a shipped one still says default', txt(ids(p).querySelectorAll('.models-row').find((r) => r.dataset.family === 'opus').querySelector('.models-source')) === 'default');

  const none = await boot({ ...models(), catalogs: [claude, agy], addable: [] });
  ok('nothing left to add: no line', !addLine(none));
  const missing = await boot({ ...models(), catalogs: [{ ...agy, ok: false, missing: true, count: 0, names: [], note: 'No Antigravity catalog on this machine — press Check now to create it.' }], addable: [] });
  ok('no Antigravity list: no line', !addLine(missing));
}
{
  const J = JSON.stringify;
  const addedRow = { family: 'xenon', id: 'xenon-id-1', vendor: 'agy', track: true, source: 'added', defaultId: null, displayName: null, alerts: [] };
  const removed = [];
  let named = true;
  const p = await boot({ ...models(), rows: [...models().rows, addedRow], addable: [], registryError: 'models.json: not valid JSON' }, {
    'POST /api/models/remove': (b) => {
      removed.push(b);
      if (named) throw { status: 409, body: { error: 'xenon is still named by the reviewer role. Take it out there first.' } };
      return { saved: true, removed: 'xenon', id: 'xenon-id-1' };
    },
  });
  const open = (family) => { ids(p).querySelectorAll('.models-row').find((r) => r.dataset.family === family).click(); };
  open('xenon');
  await settle(5);
  const detail = ids(p).querySelector('.models-detail');
  ok('an added family\'s editor offers Save and Remove, no Reset to default', J(detail.querySelectorAll('button').map(txt)) === '["Save","Remove"]', J(detail.querySelectorAll('button').map(txt)));
  ok('...and stays usable while models.json is broken (its id lives in families.json)', !button(detail, 'Save').disabled && !button(detail, 'Remove').disabled);
  button(detail, 'Remove').click();
  await settle(20);
  const n = p.$('notice-slot').querySelector('.notice');
  ok('Remove posts the family; refused, it says where the family is named', J(removed) === '[{"family":"xenon"}]' && n?.classList.contains('error')
    && /xenon is still named by the reviewer role\. Take it out there first\./.test(p.text(n)), p.text(n));
  named = false;
  button(ids(p).querySelector('.models-detail'), 'Remove').click();
  await settle(20);
  ok('...once nothing names it, Remove goes through', removed.length === 2 && /xenon removed\./.test(p.text(p.$('notice-slot').querySelector('.notice'))));
  open('opus');
  await settle(5);
  const shipped = ids(p).querySelectorAll('.models-detail').find((d) => !button(d, 'Remove'));
  ok('a shipped family keeps Reset to default, refused while models.json is broken', !!button(shipped, 'Reset to default') && button(shipped, 'Save').disabled);
}
{
  const p = await boot({ ...models(), addable: [], familiesError: '~/.agent-config-studio/families.json: not valid JSON', familiesHidden: { argontwo: 'it has a key this ACS does not know ("harness")' } });
  const errs = content(p).querySelectorAll('.models-error').map(txt);
  ok('a broken families.json is a notice at the top', errs.some((t) => /^families\.json is invalid\. The models you added are left out/.test(t) && /not valid JSON/.test(t)), JSON.stringify(errs));
  ok('...and each hidden entry is named with why', errs.some((t) => /argontwo: it has a key this ACS does not know \("harness"\)/.test(t)), JSON.stringify(errs));
}

for (const p of pages) p.done();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
