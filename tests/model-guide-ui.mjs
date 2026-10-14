/**
 * The Models panel's Model guide section (builds/model-guide G6) in the fake
 * DOM against stubbed routes: the chip per status, Add / Update / Remove
 * showing the full diff and writing only on Accept, the warnings a proposal
 * carries, and the out-of-date strip after a roles edit. No server, no HOME.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootPage, routesFor, settle } from './fixtures/shell-page.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\nmodel guide ui');

const MODELS = { pending: 0, checkedAt: Date.now(), catalogs: [], claudeVersion: null, rows: [] };
const ROLES = {
  roles: [], flavor: [], families: ['sol'], efforts: ['high'], limits: { brief: 600, item: 160, items: 12, note: 160, use: 8 },
  base: 'sha256:r1', userText: null, error: null, userFile: '~/.agent-config-studio/roles.json',
  describe: { harness: 'claude', label: 'Claude', installed: true, model: 'm', modelLabel: 'M', ready: true, why: null, running: false, limits: { description: 4000 } },
};
const target = (key, status, over = {}) => ({
  key, label: key[0].toUpperCase() + key.slice(1), path: key === 'claude' ? '~/.claude/CLAUDE.md' : `~/.${key}/AGENTS.md`,
  harnessInstalled: status !== 'not-installed', exists: status !== 'not-installed', installed: ['current', 'stale', 'edited', 'roles-invalid'].includes(status), status, ...over,
});
const guide = (targets, rolesError = null) => ({ targets, rolesError });
const BLOCK = '<!-- acs:model-guide v1 sep=1 sha256:aa -->\n## Model guide\n<!-- /acs:model-guide -->\n';

const pages = [];
async function boot(state, over = {}) {
  const routes = routesFor({
    'GET /api/models': () => MODELS,
    'GET /api/models/roles': () => ROLES,
    'GET /api/model-guide': () => state.guide,
    'POST /api/models/roles/set': () => { state.guide = state.afterRoles || state.guide; return { saved: true, base: 'sha256:r2', warnings: [] }; },
    'POST /api/model-guide/propose': (b) => state.propose(b),
    'POST /api/model-guide/accept': (b) => state.accept(b),
    'POST /api/model-guide/reject': () => ({ rejected: true }),
    'GET /api/models/where': () => ({ hits: [], roles: [] }),
    ...over,
  });
  const p = await bootPage({ routes, hash: '#models' });
  await settle(20);
  pages.push(p);
  return p;
}
const content = (p) => p.$('content');
const sec = (p) => content(p).querySelector('.models-guide');
const row = (p, key) => sec(p).querySelectorAll('.guide-row').find((r) => r.dataset.target === key);
const txt = (b) => b.textContent.replace(/\s+/g, ' ').trim();
const button = (root, text) => root?.querySelectorAll('button').find((b) => txt(b) === text);
const posts = (p, route) => p.requests.filter((r) => r.method === 'POST' && r.path === route);

// ── a chip per status ─────────────────────────────────────────────────────
{
  const state = { guide: guide([
    target('claude', 'absent'), target('codex', 'current'), target('grok', 'stale'),
  ]) };
  const p = await boot(state);
  ok('G6 the Model guide section shows after Roles and Describe', !!sec(p) && content(p).querySelector('.models-describe') && [...content(p).querySelector('.models').children].indexOf(sec(p)) > [...content(p).querySelector('.models').children].indexOf(content(p).querySelector('.models-describe')));
  ok('…with its one-line explanation', /Agents read this file at the start of every session\. The block tells them which model does which job\./.test(p.text(sec(p))));
  ok('…one row per target, by display path', sec(p).querySelectorAll('.guide-row').length === 3 && /~\/\.claude\/CLAUDE\.md/.test(p.text(row(p, 'claude'))));
  const cases = [
    ['absent', 'Not added', ['Add']], ['current', 'Up to date', ['Remove']], ['stale', 'Out of date', ['Update', 'Remove']],
    ['edited', 'Edited by hand', ['Update', 'Remove']], ['malformed', 'Markers broken', []], ['not-installed', 'Not installed', []],
    ['roles-invalid', 'Roles invalid', ['Remove']], ['not-utf8', 'Not UTF-8', []],
  ];
  for (const [status, chip, buttons] of cases) {
    const st = { guide: guide([target('claude', status, status === 'malformed' ? { reason: 'there is more than one start marker', lines: [3, 9] } : status === 'not-utf8' ? { message: 'This file is not valid UTF-8, so ACS won\'t edit it.' } : {})], status === 'roles-invalid' ? 'roles.json: bad' : null) };
    const q = await boot(st);
    const r = row(q, 'claude');
    const shown = r.querySelectorAll('button').map(txt);
    ok(`${status}: chip "${chip}", buttons ${buttons.join('/') || 'none'}`, txt(r.querySelector('.guide-chip')) === chip && JSON.stringify(shown) === JSON.stringify(buttons), `${txt(r.querySelector('.guide-chip'))} ${JSON.stringify(shown)}`);
    if (status === 'malformed') ok('…malformed names the lines to fix by hand', /line(s)? 3, 9/.test(q.text(r)) && /by hand/.test(q.text(r)));
    if (status === 'edited') ok('…edited says Update or Remove replaces the hand edits', /replaces those edits/.test(q.text(r)));
    if (status === 'not-installed') ok('…not installed offers nothing and says ACS never creates the folder', /never creates its folder/.test(q.text(r)));
  }
  const err = await boot({ guide: guide([target('claude', 'error', { reason: 'too-large', message: 'the file is over 1 MB' }), target('codex', 'error', { reason: 'hard-link', message: "the file has hard links; ACS won't edit it" }), target('grok', 'current')]) });
  ok('error: "Too large" and "Can’t use" chips with their reasons, the others unaffected',
    txt(row(err, 'claude').querySelector('.guide-chip')) === 'Too large' && /over 1 MB/.test(err.text(row(err, 'claude')))
      && txt(row(err, 'codex').querySelector('.guide-chip')) === 'Can’t use' && /hard links/.test(err.text(row(err, 'codex')))
      && txt(row(err, 'grok').querySelector('.guide-chip')) === 'Up to date');
  const inv = await boot({ guide: guide([target('claude', 'absent'), target('codex', 'roles-invalid')], 'roles.json: roles.x: unknown family') });
  ok('R3 roles invalid: the section says so, Add is disabled, Remove is not',
    /Roles invalid — fix in Models → Jobs/.test(inv.text(sec(inv))) && button(row(inv, 'claude'), 'Add').disabled === true && button(row(inv, 'codex'), 'Remove').disabled === false);
  const shared = await boot({ guide: guide([target('claude', 'current', { sharedWith: ['codex'] }), target('codex', 'current', { sharedWith: ['claude'], linkedTo: '~/.claude/CLAUDE.md' })]) });
  ok('R2 a shared file says every target sharing it changes', /Shared with ~\/\.codex\/AGENTS\.md/.test(shared.text(row(shared, 'claude'))) && /→ ~\/\.claude\/CLAUDE\.md/.test(shared.text(row(shared, 'codex'))));
}

// ── Add: a diff first, the write only on Accept ──────────────────────────
{
  const current = '# Mine\n';
  const proposed = `# Mine\n\n${BLOCK}`;
  const state = {
    guide: guide([target('claude', 'absent'), target('codex', 'current'), target('grok', 'not-installed')]),
    propose: (b) => ({ id: 'a'.repeat(32), target: b.target, action: b.action, path: '~/.claude/CLAUDE.md', status: 'absent', base: 'sha256:x', current, proposed, newFile: false, overwritesEdits: false }),
    accept: () => { state.guide = guide([target('claude', 'current'), target('codex', 'current'), target('grok', 'not-installed')]); return { saved: true, warnings: [] }; },
  };
  const p = await boot(state);
  button(row(p, 'claude'), 'Add').click();
  await settle(10);
  ok('Add proposes install for that target key, and nothing else is sent', JSON.stringify(posts(p, '/api/model-guide/propose').map((r) => r.body)) === '[{"target":"claude","action":"install"}]');
  ok('…nothing is accepted yet', posts(p, '/api/model-guide/accept').length === 0);
  const prop = row(p, 'claude').querySelector('.guide-proposal');
  ok('…the diff shows the full before → after', prop && prop.querySelector('.diff') && /<!-- acs:model-guide v1/.test(p.text(prop)) && /# Mine/.test(p.text(prop)));
  ok('…with every block line as added and none removed', prop.querySelectorAll('.diff-line.add').length === 4 && prop.querySelectorAll('.diff-line.del').length === 0, `${prop.querySelectorAll('.diff-line.add').length}`);
  ok('…and the Add button is disabled while it is open', button(row(p, 'claude'), 'Add').disabled === true);
  button(prop, 'Accept').click();
  await settle(10);
  ok('Accept sends the proposal id', posts(p, '/api/model-guide/accept')[0]?.body.id === 'a'.repeat(32));
  ok('…then the row reads Up to date and the proposal is gone', txt(row(p, 'claude').querySelector('.guide-chip')) === 'Up to date' && !row(p, 'claude').querySelector('.guide-proposal'));
  ok('…and says so', /Model guide added to ~\/\.claude\/CLAUDE\.md/.test(p.text(p.$('notice-slot'))));
}

// ── Cancel, a new file, CRLF, edited, history warnings, a 409 ────────────
{
  const state = {
    guide: guide([target('claude', 'edited'), target('codex', 'absent', { newFile: true, exists: false }), target('grok', 'current')]),
    propose: (b) => (b.target === 'claude'
      ? { id: 'b'.repeat(32), target: 'claude', action: b.action, path: '~/.claude/CLAUDE.md', status: 'edited', current: `x\r\n\r\n${BLOCK.replace(/\n/g, '\r\n')}`, proposed: 'x\r\n', newFile: false, overwritesEdits: true }
      : b.target === 'codex'
        ? { id: 'c'.repeat(32), target: 'codex', action: 'install', path: '~/.codex/AGENTS.md', status: 'absent', current: '', proposed: BLOCK, newFile: true, overwritesEdits: false }
        : { id: 'd'.repeat(32), target: 'grok', action: 'remove', path: '~/.grok/AGENTS.md', status: 'current', current: `notes\n\n${BLOCK.trimEnd()}`, proposed: 'notes\n', newFile: false, overwritesEdits: false }),
    accept: (b) => {
      if (b.id === 'b'.repeat(32)) throw { status: 409, body: { error: 'The file changed since this was proposed. Nothing was written; propose again.' } };
      return { saved: true, warnings: ['~/.codex/AGENTS.md was written, but not versioned in history: read-only'] };
    },
  };
  const p = await boot(state);
  button(row(p, 'claude'), 'Remove').click();
  await settle(10);
  const prop = row(p, 'claude').querySelector('.guide-proposal');
  const warn = prop.querySelector('.guide-overwrites');
  ok('edited: the proposal leads with the overwrite warning, as an alert', warn && warn.getAttribute('role') === 'alert' && /edited by hand/.test(p.text(warn)) && prop.firstChild === warn);
  ok('R9 a CRLF file says its line endings are kept', /CRLF line endings; they are kept/.test(p.text(prop)));
  button(prop, 'Cancel').click();
  await settle(10);
  ok('Cancel drops the proposal, rejects it, and accepts nothing', !row(p, 'claude').querySelector('.guide-proposal') && posts(p, '/api/model-guide/reject').length === 1 && posts(p, '/api/model-guide/accept').length === 0);

  button(row(p, 'codex'), 'Add').click();
  await settle(10);
  const np = row(p, 'codex').querySelector('.guide-proposal');
  ok('a new file is named as one', /\(new file\)/.test(p.text(np)) && /no file → after/.test(p.text(np)));
  button(np, 'Accept').click();
  await settle(10);
  ok('G5 a history warning on Accept is shown, not swallowed', /not versioned in history: read-only/.test(p.text(p.$('notice-slot'))));

  button(row(p, 'grok'), 'Remove').click();
  await settle(10);
  ok('R9 a change to the trailing newline is stated', /before it doesn’t end with a newline, after it does/.test(p.text(row(p, 'grok').querySelector('.guide-proposal'))));

  button(row(p, 'claude'), 'Remove').click();
  await settle(10);
  button(row(p, 'claude').querySelector('.guide-proposal'), 'Accept').click();
  await settle(10);
  ok('a 409 on Accept is shown and the status is read again', /changed since this was proposed/.test(p.text(p.$('notice-slot'))) && !row(p, 'claude').querySelector('.guide-proposal') && p.requests.filter((r) => r.path === '/api/model-guide').length >= 3);
}

// ── the out-of-date strip ────────────────────────────────────────────────
{
  const stale = guide([target('claude', 'stale'), target('codex', 'stale', { sharedWith: ['grok'] }), target('grok', 'stale', { sharedWith: ['codex'] })]);
  const state = {
    guide: guide([target('claude', 'current'), target('codex', 'current'), target('grok', 'absent')]),
    afterRoles: stale,
    propose: (b) => ({ id: (b.target === 'claude' ? 'e' : 'f').repeat(32), target: b.target, action: b.action, path: b.target, status: 'stale', current: 'a\n', proposed: 'b\n', newFile: false, overwritesEdits: false }),
    accept: () => { state.guide = guide([target('claude', 'current'), target('codex', 'stale', { sharedWith: ['grok'] }), target('grok', 'stale', { sharedWith: ['codex'] })]); return { saved: true, warnings: [] }; },
  };
  const p = await boot(state, {
    'GET /api/models/roles': () => ({ ...ROLES, roles: [{ name: 'reviewer', use: ['sol'], ids: ['sol-1'], effort: 'high', resolvedEffort: 'high', alt: '', altId: '', note: '', custom: false, provenance: { use: 'default' }, defaults: { use: 'sol' }, warnings: [] }] }),
  });
  ok('no strip while every guide is current', !content(p).querySelector('.guide-stale'));
  content(p).querySelectorAll('.roles-row').find((r) => r.dataset.role === 'reviewer').click();
  await settle(5);
  button(content(p).querySelector('.roles-detail'), 'Save').click();
  await settle(15);
  const strip = content(p).querySelector('.guide-stale');
  ok('after a roles edit the strip appears, counting each real file once', strip && /Model guide is out of date in 2 files/.test(p.text(strip)), strip && p.text(strip));
  ok('…and the status was read again after the save', p.requests.filter((r) => r.path === '/api/model-guide').length >= 2);
  button(strip, 'Review update').click();
  await settle(15);
  ok('Review update proposes an update per file, writing nothing', JSON.stringify(posts(p, '/api/model-guide/propose').map((r) => r.body)) === '[{"target":"claude","action":"update"},{"target":"codex","action":"update"}]' && posts(p, '/api/model-guide/accept').length === 0);
  ok('…each shown as a diff in its row', row(p, 'claude').querySelector('.guide-proposal .diff') && row(p, 'codex').querySelector('.guide-proposal .diff'));
  button(row(p, 'claude').querySelector('.guide-proposal'), 'Accept').click();
  await settle(10);
  ok('one accepted: the strip counts what is left', /out of date in 1 file —/.test(p.text(content(p).querySelector('.guide-stale'))));
  state.accept = () => { state.guide = guide([target('claude', 'current'), target('codex', 'current', { sharedWith: ['grok'] }), target('grok', 'current', { sharedWith: ['codex'] })]); return { saved: true, warnings: [] }; };
  button(row(p, 'codex').querySelector('.guide-proposal'), 'Accept').click();
  await settle(10);
  ok('all accepted: the strip clears', !content(p).querySelector('.guide-stale'));
}

// ── light and dark: the section draws only from the theme tokens ────────
{
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const rules = css.slice(css.indexOf('models view: the model guide block'));
  ok('the guide styles exist', /\.guide-chip/.test(rules) && /\.guide-stale/.test(rules));
  ok('…and use no literal colour, so both themes apply', !/#[0-9a-f]{3,8}\b|rgba?\(/i.test(rules));
}

for (const p of pages) p.done();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
