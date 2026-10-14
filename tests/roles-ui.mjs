/**
 * The Models panel's roles, flavor and Describe (builds/model-roles A4, A5,
 * R7–R10) in the fake DOM against stubbed routes: what shows, what each
 * button sends, and how busy, error and proposal states read. No server,
 * no HOME.
 */
import { bootPage, routesFor, settle } from './fixtures/shell-page.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
console.log('\nroles ui');

const MODELS = { pending: 0, checkedAt: Date.now(), catalogs: [], claudeVersion: null, rows: [
  { family: 'astra', id: 'astra-id-1', vendor: 'codex', track: true, source: 'default', defaultId: 'astra-id-1', alerts: [] },
  { family: 'sol', id: 'sol-id-1', vendor: 'codex', track: true, source: 'default', defaultId: 'sol-id-1', alerts: [] },
] };
const prov = (fields, over = {}) => Object.fromEntries(fields.map((f) => [f, over[f] || 'default']));
const view = (over = {}) => ({
  roles: [
    { name: 'builder', use: ['opus', 'sol'], ids: ['opus-id-1', 'sol-id-1'], effort: 'medium', resolvedEffort: 'medium', alt: '', altId: '', note: 'implements',
      custom: false, provenance: prov(['use', 'effort', 'note']), defaults: { use: ['opus', 'sol'], effort: 'medium', note: 'implements' }, warnings: [] },
    { name: 'reviewer', use: ['astra'], ids: ['astra-id-1'], effort: 'max', resolvedEffort: 'max', alt: '', altId: '', note: 'reads diffs',
      custom: false, provenance: prov(['use', 'effort', 'note'], { effort: 'user' }), defaults: { use: 'astra', effort: 'high', note: 'reads diffs' },
      warnings: ['astra (astra-id-1) is retiring on 2026-12-01.'] },
    { name: 'scout', use: ['haiku'], ids: ['haiku-id-1'], effort: '', resolvedEffort: '', alt: '', altId: '', note: '',
      custom: true, provenance: { use: 'user' }, defaults: null, warnings: [] },
  ],
  flavor: [
    { family: 'astra', flavor: { likes: ['review'], quirks: ['slow'], brief: 'Give it the diff.' }, provenance: prov(['likes', 'quirks', 'brief']), defaults: {} },
    { family: 'sol', flavor: { likes: ['builds'], quirks: [], brief: 'Set limits.' }, provenance: prov(['likes', 'quirks', 'brief'], { brief: 'user' }), defaults: {} },
  ],
  families: ['fable', 'opus', 'haiku', 'astra', 'sol'],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  limits: { brief: 600, item: 160, items: 12, note: 160, use: 8 },
  base: 'sha256:base-1',
  userText: '{}\n',
  error: null,
  userFile: '~/.agent-config-studio/roles.json',
  describe: { harness: 'claude', label: 'Claude', installed: true, model: 'sonnet-id-1', modelLabel: 'Sonnet 5', ready: true, why: null, running: false, limits: { description: 4000 } },
  ...over,
});

const pages = [];
async function boot(over = {}, v = view()) {
  const state = { view: v };
  const routes = routesFor({
    'GET /api/models': () => MODELS,
    'GET /api/models/roles': () => state.view,
    'POST /api/models/roles/set': () => ({ saved: true, base: 'sha256:base-2', warnings: [] }),
    'POST /api/models/roles/reset': () => ({ saved: true, base: 'sha256:base-2', warnings: [] }),
    'POST /api/models/roles/delete': () => ({ saved: true, base: 'sha256:base-2', warnings: [] }),
    'POST /api/models/flavor/set': () => ({ saved: true, base: 'sha256:base-2', warnings: [] }),
    'POST /api/models/flavor/reset': () => ({ saved: true, base: 'sha256:base-2', warnings: [] }),
    'GET /api/models/where': () => ({ hits: [], roles: [] }),
    ...over,
  });
  const p = await bootPage({ routes, hash: '#models' });
  await settle(20);
  pages.push(p);
  p.state = state;
  return p;
}
const content = (p) => p.$('content');
const roleRow = (p, name) => content(p).querySelectorAll('.roles-row').find((r) => r.dataset.role === name);
const button = (root, text) => root.querySelectorAll('button').find((b) => p0text(b) === text);
const p0text = (b) => b.textContent.replace(/\s+/g, ' ').trim();
const card = (p, family) => content(p).querySelector(`.model-card[data-family="${family}"]`);
/** The visible marker text in `root`: one "changed from default" per changed field, nothing else. */
const marks = (root) => (root ? root.querySelectorAll('.changed-mark').map(p0text) : []);
const MARK = '["changed from default"]';
/** The editor fields carrying a marker, by their input's class. */
const markedFields = (root) => root.querySelectorAll('.roles-field').filter((f) => marks(f).length)
  .map((f) => [f.querySelector('input, select, textarea').className.split(' ').find((c) => /^(roles|flavor)-/.test(c) && c !== 'roles-select'), marks(f)]);
const chips = (root) => root.querySelectorAll('.roles-lineup .job-chip').map(p0text);
const posts = (p, path) => p.requests.filter((r) => r.method === 'POST' && r.path === path);

// ── the Roles table ─────────────────────────────────────────────────────
{
  const p = await boot();
  const text = p.text(content(p));
  ok('A4 the Roles section shows on the Models view', /Jobs/.test(text) && content(p).querySelector('.roles-list'));
  ok('…each role with its family and id, in order of preference', JSON.stringify(chips(roleRow(p, 'builder'))) === '["Opus · medium","Sol · medium"]'
     && JSON.stringify(roleRow(p, 'builder').querySelectorAll('.roles-lineup .job-chip').map((c) => c.title.split(',')[0])) === '["opus-id-1","sol-id-1"]',
     JSON.stringify(chips(roleRow(p, 'builder'))));
  ok('…its resolved effort and alt', /max/.test(p.text(roleRow(p, 'reviewer'))) && /medium/.test(p.text(roleRow(p, 'builder'))));
  ok('R7 provenance per field: an overridden field is marked "changed from default", an untouched role is not, a custom one reads "your role"',
     JSON.stringify(marks(roleRow(p, 'reviewer').querySelector('.roles-lineup'))) === MARK && JSON.stringify(marks(roleRow(p, 'reviewer'))) === MARK
       && marks(roleRow(p, 'builder')).length === 0 && /your role/.test(p.text(roleRow(p, 'scout'))) && marks(roleRow(p, 'scout')).length === 0,
     JSON.stringify([marks(roleRow(p, 'reviewer')), marks(roleRow(p, 'builder')), marks(roleRow(p, 'scout'))]));
  ok('R8 a role on a retiring family carries the warning', /retiring on 2026-12-01/.test(p.text(roleRow(p, 'reviewer'))));
  ok('the file it saves to is named', /~\/\.agent-config-studio\/roles\.json/.test(text));

  roleRow(p, 'reviewer').click();
  await settle(5);
  const editor = content(p).querySelector('.roles-detail');
  ok('A4 clicking a role opens its editor', !!editor && editor.querySelector('.roles-use').value === 'astra');
  ok('R7 …where only the overridden field, effort, is marked "changed from default"',
     JSON.stringify(markedFields(editor)) === '[["roles-effort-input",["changed from default"]]]', JSON.stringify(markedFields(editor)));
  const effort = editor.querySelector('.roles-effort-input');
  effort.value = 'xhigh';
  effort.dispatchEvent({ type: 'change', bubbles: false });
  p.input(editor.querySelector('.roles-note'), 'reads every diff');
  button(editor, 'Save').click();
  await settle(10);
  const set = posts(p, '/api/models/roles/set');
  ok('A4 Save sends the whole row with the base it was read at',
     set.length === 1 && set[0].body.name === 'reviewer' && JSON.stringify(set[0].body.fields) === '{"use":["astra"],"effort":"xhigh","alt":"","note":"reads every diff"}' && set[0].body.base === 'sha256:base-1',
     JSON.stringify(set));
  ok('…then reads the roles again', p.requests.filter((r) => r.path === '/api/models/roles').length >= 2);
  ok('…and says so', /Role reviewer saved/.test(p.text(p.$('notice-slot'))));

  const ed2 = content(p).querySelector('.roles-detail');
  const reset = button(ed2, 'Reset to default');
  ok('Reset is offered for a role with your fields', reset && !reset.disabled);
  reset.click();
  await settle(10);
  ok('A4 Reset sends the role and the base', posts(p, '/api/models/roles/reset')[0]?.body.name === 'reviewer' && posts(p, '/api/models/roles/reset')[0]?.body.base === 'sha256:base-1');

  roleRow(p, 'builder').click();
  await settle(5);
  const bEd = content(p).querySelectorAll('.roles-detail').find((d) => d.querySelector('.roles-use').value === 'opus, sol');
  ok('a role with nothing of yours: Reset is disabled', button(bEd, 'Reset to default').disabled === true);
  ok('…and its defaults are shown', /Default: opus, sol · medium/.test(p.text(bEd)));

  roleRow(p, 'scout').click();
  await settle(5);
  const sEd = content(p).querySelectorAll('.roles-detail').find((d) => d.querySelector('.roles-use').value === 'haiku');
  ok('R7 a custom role offers Delete, not Reset', button(sEd, 'Delete role') && !button(sEd, 'Reset to default'));
  button(sEd, 'Delete role').click();
  await settle(10);
  ok('…and Delete sends the role name', posts(p, '/api/models/roles/delete')[0]?.body.name === 'scout');

  button(content(p), 'Add a role').click();
  await settle(5);
  const add = content(p).querySelectorAll('.roles-detail').find((d) => d.querySelector('.roles-name'));
  p.input(add.querySelector('.roles-name'), 'scout2');
  p.input(add.querySelector('.roles-use'), 'haiku, sonnet');
  button(add, 'Save').click();
  await settle(10);
  const addPost = posts(p, '/api/models/roles/set').pop();
  ok('Add a role: a name and a use list are sent', addPost.body.name === 'scout2' && JSON.stringify(addPost.body.fields.use) === '["haiku","sonnet"]');
  ok('no page errors', p.errors.length === 0, p.errors.join(' | '));
}

// ── grade 3: Reset clears the draft before repainting ──────────────────
{
  const p = await boot({
    // No later repaint to hide behind: where-used never answers here.
    'GET /api/models/where': () => new Promise(() => {}),
    'POST /api/models/roles/reset': () => {
      // After the reset the server's view has the default back.
      const v = view();
      const r = v.roles.find((x) => x.name === 'reviewer');
      Object.assign(r, { effort: 'high', resolvedEffort: 'high', provenance: prov(['use', 'effort', 'note']) });
      p.state.view = v;
      return { saved: true, base: 'sha256:base-2', warnings: [] };
    },
  });
  roleRow(p, 'reviewer').click();
  await settle(5);
  ok('(the editor starts at the override, max)', content(p).querySelector('.roles-detail .roles-effort-input').value === 'max');
  button(content(p).querySelector('.roles-detail'), 'Reset to default').click();
  await settle(10);
  const ed = content(p).querySelector('.roles-detail');
  ok('3 after Reset the editor shows the default, not the stale max', ed.querySelector('.roles-effort-input').value === 'high', ed.querySelector('.roles-effort-input').value);
  button(ed, 'Save').click();
  await settle(10);
  const sent = posts(p, '/api/models/roles/set').pop();
  ok('3 …and Save right after sends the default, not the stale value', sent?.body.fields.effort === 'high', JSON.stringify(sent?.body));

  button(card(p, 'sol'), 'Edit').click();
  await settle(10);
  p.input(content(p).querySelector('.models-flavor .flavor-brief'), 'stale draft');
  button(content(p).querySelector('.models-flavor'), 'Reset to default').click();
  await settle(10);
  ok('3 Reset flavor clears its draft too', content(p).querySelector('.models-flavor .flavor-brief').value === 'Set limits.', content(p).querySelector('.models-flavor .flavor-brief').value);
}

// ── a stale base: the error shows and the roles are read again ─────────
{
  const p = await boot({ 'POST /api/models/roles/set': () => { throw { status: 409, body: { error: 'roles.json changed since this was shown (another tab, an editor, or an accepted proposal). Reload and try again.' } }; } });
  roleRow(p, 'reviewer').click();
  await settle(5);
  const before = p.requests.filter((r) => r.path === '/api/models/roles').length;
  button(content(p).querySelector('.roles-detail'), 'Save').click();
  await settle(10);
  ok('R2 a 409 shows the reason', /changed since this was shown/.test(p.text(p.$('notice-slot'))));
  ok('…and reloads the roles', p.requests.filter((r) => r.path === '/api/models/roles').length > before);
}

// ── flavor, inside each family's row ──────────────────────────────────
{
  const p = await boot();
  button(card(p, 'sol'), 'Edit').click();
  await settle(10);
  const fl = card(p, 'sol').querySelector('.models-flavor');
  ok('A4 a family row shows its flavor', fl && fl.querySelector('.flavor-brief').value === 'Set limits.' && fl.querySelector('.flavor-likes').value === 'builds');
  ok('…with where each field comes from: only the overridden brief is marked "changed from default"',
     JSON.stringify(markedFields(fl)) === '[["flavor-brief",["changed from default"]]]' && marks(fl).length === 1, JSON.stringify(markedFields(fl)));
  ok('R5 …and says flavor text becomes other agents\' instructions', /Agents read this when you hand them work — write it the way you’d brief them\./.test(p.text(content(p).querySelector('.models-families'))));
  p.input(fl.querySelector('.flavor-likes'), 'builds\n  tests first \n\n');
  button(fl, 'Save').click();
  await settle(10);
  const fs = posts(p, '/api/models/flavor/set');
  ok('A4 Save flavor sends one item per line, trimmed, empties dropped', fs.length === 1 && fs[0].body.family === 'sol' && JSON.stringify(fs[0].body.fields.likes) === '["builds","tests first"]' && fs[0].body.base === 'sha256:base-1', JSON.stringify(fs));
  const fl2 = card(p, 'sol');
  button(fl2, 'Reset to default').click();
  await settle(10);
  ok('A4 Reset flavor sends the family', posts(p, '/api/models/flavor/reset')[0]?.body.family === 'sol');
}

// ── Describe your models ──────────────────────────────────────────────
const PROPOSAL = {
  id: 'a'.repeat(32), base: 'sha256:base-1', current: '{}\n', proposed: '{\n  "version": 1\n}\n',
  diff: [{ op: '-', line: '{}' }, { op: '+', line: '{' }, { op: '+', line: '  "version": 1' }, { op: '+', line: '}' }],
  backend: { harness: 'claude', model: 'sonnet-id-1', modelLabel: 'Sonnet 5' },
};
{
  const run = deferred();
  const p = await boot({
    'POST /api/models/roles/describe': () => run.promise,
    'POST /api/models/roles/describe/cancel': () => ({ cancelled: true }),
    'POST /api/models/roles/proposal/accept': () => ({ saved: true, base: 'sha256:base-3', warnings: [], written: PROPOSAL.proposed }),
  });
  const sec = () => content(p).querySelector('.models-describe');
  ok('R10 the box names the backend and model it will use, and that it has no tools', /Runs Claude Sonnet 5 with no tools — the Assist registry's default model/.test(p.text(sec())));
  p.input(sec().querySelector('.describe-text'), 'Sol builds. Astra reviews.');
  ok('…and counts characters against the limit', /26 \/ 4000/.test(p.text(sec())));
  button(sec(), 'Describe').click();
  await settle(5);
  const go = sec().querySelector('.describe-go');
  ok('A5 Describe sends the text', posts(p, '/api/models/roles/describe')[0]?.body.description === 'Sol builds. Astra reviews.');
  ok('R10 while it runs: the button is disabled and busy, with a Cancel', go.disabled === true && /Reading your description/.test(p0text(go)) && go.querySelector('.spinner') && button(sec(), 'Cancel'));
  ok('…and the text box is locked', sec().querySelector('.describe-text').disabled === true);
  button(sec(), 'Cancel').click();
  await settle(5);
  ok('R10 Cancel asks the server to kill the run', posts(p, '/api/models/roles/describe/cancel').length === 1);
  run.resolve(PROPOSAL);
  await settle(10);
  const prop = sec().querySelector('.describe-proposal');
  ok('A5 a proposal shows as a diff, every line, added and removed marked', prop && prop.querySelectorAll('.diff-line').length === 4
     && prop.querySelectorAll('.diff-line.add').length === 3 && prop.querySelectorAll('.diff-line.del').length === 1);
  ok('R9 …saying plainly it is the AI\'s reading, to review', /This is the AI’s reading of your description/.test(p.text(prop)));
  ok('…and Describe waits until it is accepted or rejected', sec().querySelector('.describe-go').disabled === true);
  button(prop, 'Accept').click();
  await settle(10);
  ok('A5 Accept sends the proposal id', posts(p, '/api/models/roles/proposal/accept')[0]?.body.id === PROPOSAL.id);
  ok('…says it was written, and clears the proposal', /roles\.json updated from your description/.test(p.text(p.$('notice-slot'))) && !sec().querySelector('.describe-proposal'));
  ok('no page errors', p.errors.length === 0, p.errors.join(' | '));
}
{
  const p = await boot({
    'POST /api/models/roles/describe': () => PROPOSAL,
    'POST /api/models/roles/proposal/reject': () => ({ rejected: true }),
  });
  const sec = () => content(p).querySelector('.models-describe');
  p.input(sec().querySelector('.describe-text'), 'x');
  button(sec(), 'Describe').click();
  await settle(10);
  button(sec().querySelector('.describe-proposal'), 'Reject').click();
  await settle(10);
  ok('A5 Reject sends the id and drops the proposal', posts(p, '/api/models/roles/proposal/reject')[0]?.body.id === PROPOSAL.id && !sec().querySelector('.describe-proposal'));
  ok('…and nothing was accepted', posts(p, '/api/models/roles/proposal/accept').length === 0);
}
{
  const p = await boot({ 'POST /api/models/roles/describe': () => { throw { status: 422, body: { error: 'The AI\'s reply was refused: it had text outside the one JSON object. Nothing was written.' } }; } });
  const sec = () => content(p).querySelector('.models-describe');
  p.input(sec().querySelector('.describe-text'), 'x');
  button(sec(), 'Describe').click();
  await settle(10);
  const err = sec().querySelector('.describe-error');
  ok('A5 invalid output: a visible error in the box naming what failed', err && /text outside the one JSON object/.test(p.text(err)) && err.getAttribute('role') === 'alert');
  ok('…no proposal, and Describe is ready again', !sec().querySelector('.describe-proposal') && sec().querySelector('.describe-go').disabled === false);
}
{
  const v = view();
  v.describe = { ...v.describe, installed: false, ready: false, why: 'Describe uses the Claude CLI, which is not installed (or not found).' };
  const p = await boot({}, v);
  const sec = content(p).querySelector('.models-describe');
  ok('R10 no backend: the box says why, and Describe is disabled', /Describe is unavailable: Describe uses the Claude CLI, which is not installed/.test(p.text(sec)) && sec.querySelector('.describe-go').disabled === true);
}
{
  const p = await boot({}, view({ error: 'roles.json: roles.x: "use" is required' }));
  ok('an invalid roles.json is shown, and edits are disabled', /roles\.json is invalid/.test(p.text(content(p))) && button(content(p), 'Add a role').disabled === true);
}

for (const p of pages) p.done();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
