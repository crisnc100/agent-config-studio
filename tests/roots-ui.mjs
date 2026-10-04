/**
 * The page's side of configurable roots (builds/configurable-roots/plan.md),
 * in the node VM against stubbed routes (tests/fixtures/shell-page.mjs):
 *
 *   B2   a revoked folder under a dirty editor keeps the draft, goes
 *        read-only and says so — the decision function and the app
 *   B6   a `roots` event reloads Folders, Context, Skills, Files and Home
 *   B8 / AC7  the Folders view shows missing folders, skipped entries and
 *        an unreadable roots.json
 *   AC5  the Folders empty state prints the add command
 *   labels for skill groups come from the folder list, not a hardcoded map
 *
 * No server, no HOME.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { bootPage, routesFor, PATHS, PUB, settle } from './fixtures/shell-page.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const pages = [];
const boot = async (o) => { const p = await bootPage(o); pages.push(p); return p; };

const FOLDERS = (over = {}) => ({
  state: 'ok', error: null, file: '~/.agent-config-studio/roots.json', addHint: 'acs roots add <path>',
  roots: [
    { id: 'work', label: 'Work', access: 'edit', status: 'ok', display: '~/code/work' },
    { id: 'shared', label: 'Shared', access: 'read', status: 'ok', display: '/Volumes/team/shared' },
  ],
  invalid: [],
  ...over,
});

console.log('\nroots in the page');

// ── B2: the decision function ──────────────────────────────────────────────
{
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(PUB, 'file-events.js'), 'utf8'), ctx);
  const plan = (d, o) => vm.runInContext(`fileEventPlan(${JSON.stringify(d)}, ${JSON.stringify(o)})`, ctx);
  const f = '/h/code/work/app/CLAUDE.md';
  const dirty = plan({ origin: 'outside', revokedPaths: [f], removedPaths: [] }, { openPath: f, dirty: true });
  ok('B2 decision: a revoked open file with a draft is "revoked", never "closed"', dirty.open === 'revoked' && dirty.dirty === true, JSON.stringify(dirty));
  const clean = plan({ origin: 'outside', revokedPaths: [f] }, { openPath: f, dirty: false });
  ok('B2 decision: …clean, it is "revoked" too (shown read-only, not closed)', clean.open === 'revoked', JSON.stringify(clean));
  const del = plan({ origin: 'outside', removedPaths: [f] }, { openPath: f, dirty: true });
  ok('B2 decision: a real delete still closes it (unchanged)', del.open === 'closed');
  const other = plan({ origin: 'outside', revokedPaths: ['/h/other.md'] }, { openPath: f, dirty: true });
  ok('B2 decision: another file revoked leaves the open one alone', other.open === 'none');
}

// ── B2: the app ─────────────────────────────────────────────────────────────
{
  const routes = routesFor({ 'GET /api/roots': () => FOLDERS() });
  const p = await boot({ routes, hash: `#file=${encodeURIComponent(PATHS.claudeMd)}` });
  await settle(10);
  p.eval(`S.tab = 'edit'; renderContent();`);
  p.input(p.$('content').querySelector('textarea'), 'my unsaved draft');
  const es = p.sources[0];
  es.onmessage({ data: JSON.stringify({ type: 'files', origin: 'outside', added: [], removed: [], changed: [], revoked: ['~/Documents/Projects/app/CLAUDE.md'], revokedPaths: [PATHS.claudeMd], removedPaths: [] }) });
  await settle(10);
  ok('B2 app: the dirty editor stays open on the file', p.eval('S.view') === 'entry' && p.eval('S.file?.path') === PATHS.claudeMd);
  ok('B2 app: …with the draft intact', p.eval('S.draft') === 'my unsaved draft');
  ok('B2 app: …read-only', p.$('content').querySelector('textarea')?.readOnly === true && p.eval('S.revoked') === true);
  ok('B2 app: …with the notice to copy the changes', /no longer editable — copy your changes/.test(p.text(p.$('notice-slot'))), p.text(p.$('notice-slot')));
  ok('B2 app: Save is disabled', p.$('btn-save').disabled === true);
  const puts = p.requests.filter((r) => r.method === 'PUT').length;
  p.eval('save()');
  await settle(5);
  ok('B2 app: …and a save attempt (⌘S) sends nothing', p.requests.filter((r) => r.method === 'PUT').length === puts);
  p.confirm = () => false;
  p.$('btn-skills').click();
  await settle(5);
  ok('B2 app: leaving still asks first, since the draft is unsaved', p.eval('S.view') === 'entry' && p.eval('S.draft') === 'my unsaved draft');
}
{
  const routes = routesFor({ 'GET /api/roots': () => FOLDERS() });
  const p = await boot({ routes, hash: `#file=${encodeURIComponent(PATHS.claudeMd)}` });
  await settle(10);
  p.sources[0].onmessage({ data: JSON.stringify({ type: 'files', origin: 'outside', added: [], removed: [], changed: [], revokedPaths: [PATHS.claudeMd] }) });
  await settle(10);
  ok('B2 app: a clean editor is kept too, read-only, with its own wording',
     p.eval('S.view') === 'entry' && p.eval('S.revoked') === true && /no longer editable — the file is shown read-only/.test(p.text(p.$('notice-slot'))));
  p.eval(`S.tab = 'edit'; renderContent();`);
  ok('B2 app: …and its editor tab will not take typing', p.$('content').querySelector('textarea')?.readOnly === true);
}

// ── Folders view: list, missing, skipped, empty, error ─────────────────────
{
  const routes = routesFor({ 'GET /api/roots': () => FOLDERS({
    roots: [
      { id: 'work', label: 'Work', access: 'edit', status: 'ok', display: '~/code/work' },
      { id: 'usb', label: 'USB', access: 'read', status: 'missing', display: '/Volumes/usb/projects' },
    ],
    invalid: [{ id: 'keys', reason: '~/.ssh holds your keys and cannot be a project folder' }],
  }) });
  const p = await boot({ routes, hash: '#folders' });
  await settle(10);
  const text = p.text(p.$('content'));
  ok('Folders: #folders opens the view', p.eval('S.view') === 'folders' && p.text(p.$('title')) === 'Folders');
  ok('Folders: each root shows label, path and access', /Work/.test(text) && /~\/code\/work/.test(text) && /edit/.test(text) && /USB/.test(text) && /read-only/.test(text), text);
  ok('B8 Folders: a missing folder is marked missing and explained', /missing/.test(text) && /comes back when it does/.test(text), text);
  ok('AC7 Folders: a skipped entry is reported with its reason', /1 entry was skipped/.test(text) && /keys: ~\/\.ssh holds your keys/.test(text), text);
  ok('Folders: no page errors', p.errors.length === 0, p.errors.join(' | '));
}
{
  const routes = routesFor({ 'GET /api/roots': () => FOLDERS({ roots: [] }) });
  const p = await boot({ routes, hash: '#folders' });
  await settle(10);
  const text = p.text(p.$('content'));
  ok('AC5 the Folders empty state says there are none and prints the add command',
     /No project folders yet/.test(text) && /acs roots add <path>/.test(text) && /--edit/.test(text), text);
}
{
  const routes = routesFor({ 'GET /api/roots': () => FOLDERS({ state: 'error', error: 'roots.json is not valid: Unexpected token', roots: [] }) });
  const p = await boot({ routes, hash: '#folders' });
  await settle(10);
  const text = p.text(p.$('content'));
  ok('B8 Folders: an unreadable roots.json shows the error, not an empty list',
     /roots\.json is not valid/.test(text) && /No project folders are active/.test(text) && !/No project folders yet/.test(text), text);
}

// ── labels from the folder list ────────────────────────────────────────────
{
  const routes = routesFor({
    'GET /api/roots': () => FOLDERS(),
    'GET /api/skills': () => ({ usage: { caveat: { text: '' } }, skills: [
      { id: 'a1', name: 'w-skill', displayName: 'w-skill', source: 'project', rootId: 'work', description: '', files: [], excluded: [], emptyDirs: [], totalBytes: 1, broken: false, aliasCount: 0, aliasSources: [] },
      { id: 'b2', name: 's-skill', displayName: 's-skill', source: 'shared', rootId: 'shared', description: '', files: [], excluded: [], emptyDirs: [], totalBytes: 1, broken: false, aliasCount: 0, aliasSources: [] },
    ] }),
  });
  const p = await boot({ routes, hash: '#skills' });
  await settle(10);
  const groups = p.$('content').querySelectorAll('.sk-group-name').map((g) => p.text(g));
  ok('skill groups are named by the folder list: the edit root by its label, the read root by its label',
     groups.includes('Work') && groups.includes('Shared') && !groups.includes('project') && !groups.includes('shared'), JSON.stringify(groups));
  const app = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  ok('no folder name is hardcoded in the page', !/Garman/i.test(app) && !/Documents\/Projects/.test(app));
}

// ── B6: a roots event reloads what each view shows ─────────────────────────
{
  const state = { list: FOLDERS() };
  const routes = routesFor({ 'GET /api/roots': () => state.list });
  const p = await boot({ routes, hash: '#folders' });
  await settle(10);
  const next = FOLDERS({ roots: [...FOLDERS().roots, { id: 'new', label: 'Brand New', access: 'read', status: 'ok', display: '~/new' }] });
  const fire = async () => { p.sources[0].onmessage({ data: JSON.stringify({ type: 'roots', ...next }) }); await settle(10); };
  const count = (route) => p.requests.filter((r) => r.path === route).length;

  let reg = count('/api/registry');
  await fire();
  ok('B6 Folders repaints from the event, and the registry is refetched', /Brand New/.test(p.text(p.$('content'))) && count('/api/registry') > reg);

  p.$('btn-context').click(); await settle(10);
  let ctx = count('/api/context');
  await fire();
  ok('B6 Context refetches its data on a roots event', count('/api/context') > ctx);

  p.$('btn-skills').click(); await settle(10);
  const sk = count('/api/skills');
  await fire();
  ok('B6 Skills refetches its data on a roots event', count('/api/skills') > sk);

  p.$('btn-files').click(); await settle(10);
  await fire();
  ok('B6 Files repaints its folder line from the event', /Project folders: .*Brand New \(read-only\)/.test(p.text(p.$('content'))), p.text(p.$('content')).slice(0, 300));

  p.$('btn-home').click(); await settle(10);
  const usage = count('/api/usage');
  await fire();
  ok('B6 Home reloads its cards on a roots event', count('/api/usage') > usage);
  ok('B6 no page errors across the reloads', p.errors.length === 0, p.errors.join(' | '));
}

// ── the Files page names the folders, or how to add one ────────────────────
{
  const p = await boot({ routes: routesFor({ 'GET /api/roots': () => FOLDERS({ roots: [] }) }), hash: '#files' });
  await settle(10);
  ok('AC5 the Files page says there are no project folders and how to add one', /No project folders yet — run acs roots add <path>/.test(p.text(p.$('content'))), p.text(p.$('content')).slice(0, 300));
}

for (const p of pages) p.done();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
