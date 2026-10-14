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
  ok('jobs: a changed lineup carries the mark', !!rv.querySelector('.roles-lineup .changed-mark'));
  ok('…an unchanged note and second opinion do not', !rv.querySelector('.roles-top .changed-mark') && !rv.querySelector('.roles-second .changed-mark'));
  ok('…an untouched job carries none', !roleRow(p, 'builder').querySelector('.changed-mark'));
  ok('…a field yours but equal to the default carries none', !roleRow(p, 'judge').querySelector('.changed-mark'));
  rv.click();
  await settle(5);
  const ed = content(p).querySelector('.roles-detail');
  const marked = ed.querySelectorAll('.roles-field').filter((f) => f.querySelector('.changed-mark')).map((f) => f.querySelector('input, select').className);
  ok('…in the editor, only the changed fields (models, effort) are marked',
    marked.length === 2 && /roles-use/.test(marked[0]) && /roles-effort-input/.test(marked[1]), JSON.stringify(marked));
  ok('models: only the differing field (Briefing tips) is marked on the card',
    JSON.stringify(card(p, 'sol').querySelectorAll('.model-field').filter((f) => f.querySelector('.changed-mark')).map((f) => f.className)) === '["model-field model-field-brief"]');
  ok('…and an untouched card has none', !card(p, 'opus').querySelector('.changed-mark'));
  ok('no "default" or "yours" tag on every field', !/· (default|yours)\b/.test(p.text(content(p))));
}

// ── a card: what it shows, Save and Reset ───────────────────────────────
{
  const p = await boot();
  const c = card(p, 'grok');
  ok('a card per model: its name and id', c && p.text(c.querySelector('.model-card-name')) === 'Grok' && p.text(c.querySelector('.model-card-id')) === 'grok-id-1');
  ok('…Strengths, Weaknesses, Briefing tips and Default effort',
    JSON.stringify(c.querySelectorAll('.model-field-label').map(txt)) === '["Strengths","Weaknesses","Briefing tips","Default effort"]'
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
    set.length === 1 && JSON.stringify(set[0].body) === JSON.stringify({ family: 'grok', fields: { likes: ['backend'], quirks: ['under-fills', 'guesses'], brief: 'Spell it out.', effort: 'max' }, base: 'sha256:base-1' }),
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
  ok('Used by is folded, counting the jobs', /Used by 2 jobs/.test(p.text(used)) && !used.querySelector('.models-where-hit'));
  button(used, txt(used.querySelector('.model-used-toggle'))).click();
  await settle(10);
  const u2 = card(p, 'opus').querySelector('.model-used');
  ok('…open, it names the jobs and the files that call it',
    /Jobs: reviewer, builder/.test(p.text(u2)) && /SKILL\.md:3/.test(p.text(u2))
      && p.requests.some((r) => r.path === '/api/models/where' && r.search === '?family=opus'));
  ok('no page errors', p.errors.length === 0, p.errors.join(' | '));
}

// ── Model ids: folded by default, open while an alert waits ─────────────
{
  const p = await boot();
  ok('no alerts: Model ids is collapsed, its table not drawn', ids(p) && !ids(p).querySelector('.models-table')
    && ids(p).querySelector('.ids-toggle').getAttribute('aria-expanded') === 'false');
  ok('…Check now stays reachable on its header', !!button(ids(p), 'Check now'));
  ids(p).querySelector('.ids-toggle').click();
  await settle(5);
  ok('…a click opens it, every family listed', ids(p).querySelectorAll('.models-row').length === 5);
  content(p).querySelectorAll('.models-row').find((r) => r.dataset.family === 'sol').click();
  await settle(5);
  ok('…and a row still opens its id editor', !!ids(p).querySelector('.models-detail .models-input'));

  const q = await boot(models([ALERT]));
  ok('an alert pending: Model ids opens on its own', ids(q).querySelector('.models-table') && ids(q).querySelector('.ids-toggle').getAttribute('aria-expanded') === 'true');
  ok('…with the count on its header', p.text(ids(q).querySelector('.ids-count')) === '1 alert');
  ok('…and the alert with its buttons', /Newer: opus-id-2/.test(q.text(ids(q))) && button(ids(q), 'Accept') && button(ids(q), 'Dismiss'));
  ids(q).querySelector('.ids-toggle').click();
  await settle(5);
  ok('folded by hand, the count still shows', !ids(q).querySelector('.models-table') && q.text(ids(q).querySelector('.ids-count')) === '1 alert');
}

for (const p of pages) p.done();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
