/**
 * PR F (builds/ui-clarity/final-critique.md): plain words where a newcomer meets them, one verb
 * (Compare) for every side-by-side, the PATH need said once, a picker for a role's models with its
 * error by the field, readable Memory cleanups, a labelled session delete, Setup's Recheck that
 * says it checked, the sidebar keeping your place inside a file, and a focus ring on role rows.
 *
 * The page in the fake DOM against stubbed routes (tests/fixtures/shell-page.mjs), plus static
 * reads of public/. No server, no HOME.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bootPage, routesFor, settle, ROOT, MEMORY, CONTEXT, PATHS } from './fixtures/shell-page.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const pages = [];
const boot = async (o) => { const p = await bootPage(o); pages.push(p); await settle(20); return p; };
const btnText = (p, root) => root.querySelectorAll('button').map((b) => p.text(b).trim());

/* ── static: the words and verbs public/ may show ─────────────────────── */
console.log('\nstatic: no jargon in what the views say');
{
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
  const files = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.js')).map((f) => [f, strip(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'))]);
  // Each phrase a newcomer can't act on (final critique P1-1, P2-1, P2-2), as it would sit in a string literal.
  const BANNED = [
    [/drifted from trunk|differs from trunk|Diff vs trunk|\(trunk\)/, '"trunk" outside Worktrees'],
    [/['"`]drifted['"`]/, 'the "drifted" badge'],
    [/headroom/i, '"headroom"'],
    [/['"`]Route to['"`]/, '"Route to"'],
    [/Orphans &/, '"Orphans & duplicates"'],
    [/\bOperations\b/, '"Operations"'],
    [/frontmatter date/, '"frontmatter date"'],
    [/['"`]DIR['"`]/, '"DIR"'],
    [/invocation/, '"invocations"'],
    [/Asking the toolkit/, '"Asking the toolkit"'],
    [/Assist registry/, '"the Assist registry"'],
    [/PATH fix/, '"PATH fix"'],
    [/byte-for-byte/, '"byte-for-byte"'],
    [/['"`]Catalog name['"`]/, '"Catalog name"'],
  ];
  // Strings only: a word in an identifier (seatHeadroom, trunkId) is not something the page says.
  const literals = (src) => [...src.matchAll(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g)].map((m) => m[0]);
  for (const [re, name] of BANNED) {
    const hits = files.flatMap(([f, src]) => literals(src).filter((s) => re.test(s)).map((s) => `${f}: ${s.slice(0, 80)}`));
    ok(`public/: no ${name}`, hits.length === 0, hits.join(' | '));
  }
  // One verb for a side-by-side: Compare. No button reads "Diff…".
  const diffBtns = files.flatMap(([f, src]) => [...src.matchAll(/el\(\s*'button'[^;]*?,\s*(['`])(Diff[^'`]*)\1/g)].map((m) => `${f}: ${m[2]}`));
  ok('public/: no button says "Diff" — the verb is Compare', diffBtns.length === 0, diffBtns.join(' | '));

  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].split(',').map((x) => x.trim()).includes(sel)).map((m) => m[2]).join(';');
  ok('a role row has a visible focus ring: a 2px outline on :focus-visible, like every other control', /outline\s*:\s*2px solid/.test(rule('.roles-row:focus-visible')), rule('.roles-row:focus-visible'));
}

/* ── P1-1: Home and Context say "main checkout", and Compare ──────────── */
console.log('\nHome and Context: no "trunk", one verb');
{
  const v = (id, over) => ({ id, lines: 3, copies: 1, readOnly: false, outline: [], open: { path: `/h/p/${id}/CLAUDE.md`, display: `~/p/${id}/CLAUDE.md` },
    paths: [{ display: `~/p/${id}/CLAUDE.md`, trunk: !!over.trunk }], ...over });
  const ctx = {
    totals: { files: 2, entries: 2, collapsedCopies: 0, drifted: 1 },
    roots: { projects: { label: 'Projects', files: 2, entries: 2, drifted: 1 } }, unreadable: [],
    groups: [{ root: 'projects', rootLabel: 'Projects', label: 'app', display: '~/p', checkouts: [{}, {}], scopes: [
      { scope: '.', kind: 'claude', drift: true, trunkId: 'main', variants: [v('main', { trunk: true }), v('wt', { trunk: false, drift: true })] },
    ] }],
  };
  const p = await boot({ routes: routesFor({ 'GET /api/context': () => ctx }), hash: '#context' });
  const t = p.text(p.$('content'));
  ok('Context: no "trunk" and no "drifted" on the page', !/trunk|drifted/i.test(t), t.slice(0, 300));
  ok('Context: the drift is said plainly — differs from the main checkout', /differs from the main checkout/.test(t) && /main checkout/.test(t), t.slice(0, 300));
  ok('Context: the side-by-side button is "Compare with main checkout"', btnText(p, p.$('content')).includes('Compare with main checkout'), btnText(p, p.$('content')).join(' | '));

  const h = await boot({ routes: routesFor({ 'GET /api/context': () => ctx }), hash: '#home' });
  const home = p.text(h.$('content'));
  ok('Home: the to-do says an instruction file differs from the main checkout, with Compare', /1 instruction file in a worktree differs from the main checkout/.test(home)
    && !/trunk|drifted/i.test(home), home.slice(0, 400));
}

/* ── P2-2: the PATH need, once ────────────────────────────────────────── */
console.log('\nPacks: the PATH need is said once, at the top');
{
  const p = await boot({ hash: '#home' });
  const req = (id, ok_, extra = {}) => ({ id, name: id, ok: ok_, what: id, fix: `fix ${id}`, ...extra });
  const packs = [
    { id: 'a', requirements: [req('model-id', false, { group: 'path' }), req('git', true)] },
    { id: 'b', requirements: [req('cli', false, { group: 'path', name: 'Grok' }), req('git', true)] },
    { id: 'c', requirements: [req('git', true)] },
  ];
  const out = JSON.parse(p.eval(`(() => { PK.data = { packs: ${JSON.stringify(packs)} };
    const shared = pkShared(); const todo = pkTodo();
    return JSON.stringify({ keys: [...shared.keys()], names: shared.get('path') ? pkNames(shared.get('path')) : [], todo: todo ? todo.textContent : '' }); })()`));
  ok('a PATH need on some packs (not all) is shared: listed at the top, so no card repeats it', out.keys.includes('path') && out.names.join() === 'model-id,Grok', JSON.stringify(out));
  ok('…in plain words, with what to do', /search path/.test(out.todo) && /Fix:/.test(out.todo) && !/PATH fix/.test(out.todo), out.todo);
}

/* ── P2-4: a role's models are picked, not typed ──────────────────────── */
console.log('\nModels: the role editor picks models from a list');
{
  const view = {
    roles: [{ name: 'reviewer', use: ['astra'], ids: ['astra-id'], effort: '', resolvedEffort: '', alt: '', altId: '', note: 'reads diffs',
      custom: true, provenance: { use: 'user' }, defaults: null, warnings: [] }],
    flavor: [], families: ['fable', 'opus', 'astra', 'sol'], efforts: ['medium', 'high'],
    limits: { brief: 600, item: 160, items: 12, note: 160, use: 8 }, base: 'sha256:1', userText: '{}\n', error: null,
    userFile: '~/.agent-config-studio/roles.json', describe: { ready: false, why: 'off', limits: { description: 10 } },
  };
  const sets = [];
  let refuse = null;
  const p = await boot({ hash: '#models', routes: routesFor({
    'GET /api/models': () => ({ pending: 0, checkedAt: Date.now(), catalogs: [], rows: [] }),
    'GET /api/models/roles': () => view,
    'POST /api/models/roles/set': (b) => { sets.push(b); if (refuse) throw refuse; return { saved: true, base: 'sha256:2', warnings: [] }; },
  }) });
  const row = () => p.$('content').querySelector('.roles-row[data-role="reviewer"]');
  row().click();
  await settle(5);
  const ed = () => p.$('content').querySelector('.roles-detail');
  const picks = () => (ed()?.querySelectorAll('.roles-pick') || []);
  ok('no free-text box for the models: one pick button per known model', !ed()?.querySelector('input.roles-use') && picks().map((b) => b.dataset.family).join() === 'fable,opus,astra,sol',
    picks().map((b) => b.dataset.family).join());
  ok('…the chosen ones pressed, numbered in order', picks().filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.family).join() === 'astra'
    && /1/.test(p.text(picks().find((b) => b.dataset.family === 'astra'))));
  picks().find((b) => b.dataset.family === 'sol')?.click();
  picks().find((b) => b.dataset.family === 'opus')?.click();
  ok('picking adds to the end of the order', picks().filter((b) => b.getAttribute('aria-pressed') === 'true').sort((a, b) => a.dataset.order - b.dataset.order).map((b) => b.dataset.family).join() === 'astra,sol,opus');
  picks().find((b) => b.dataset.family === 'astra')?.click();
  ed()?.querySelectorAll('button').find((b) => p.text(b) === 'Save')?.click();
  await settle(10);
  ok('Save sends the picked order (a pick pressed again is taken out)', JSON.stringify(sets.at(-1)?.fields?.use) === '["sol","opus"]', JSON.stringify(sets.at(-1)));

  // A refused value: the reason sits by the field in plain words, and no toast carries the raw roles.json path.
  row().click(); await settle(5);
  if (!ed()) { row().click(); await settle(5); }
  refuse = { status: 400, body: { error: 'roles.json: roles.reviewer.use[0]: unknown family "opuss" (known: fable, opus, astra, sol)' } };
  ed()?.querySelectorAll('button').find((b) => p.text(b) === 'Save')?.click();
  await settle(10);
  const err = ed()?.querySelector('.models-write-error');
  ok('a refused model shows inline, by the field, in plain words', !!err && /No model called “opuss”/.test(p.text(err)) && !/roles\.json|use\[0\]/.test(p.text(err)), err ? p.text(err) : '(none)');
  ok('…and no toast repeats the raw error', !/roles\.json: roles\./.test(p.text(p.$('notice-slot'))), p.text(p.$('notice-slot')));
  // Nothing picked: said by the field, nothing sent.
  const before = sets.length;
  for (const b of picks().filter((x) => x.getAttribute('aria-pressed') === 'true')) b.click();
  ed()?.querySelectorAll('button').find((b) => p.text(b) === 'Save')?.click();
  await settle(10);
  ok('Save with no model picked says so by the field and sends nothing', sets.length === before && /Pick at least one model/.test(p.text(ed()?.querySelector('.models-write-error'))));
}

/* ── P2-5: Memory → Cleanups reads as names, not slugs and raw lines ──── */
console.log('\nMemory → Cleanups: readable names and short labels');
{
  const mem = { ...MEMORY, findings: { ...MEMORY.findings,
    emptySlugs: [
      { id: 'e1', slug: '-Users-pat-Documents-Projects-empty-one', where: '~/Documents/Projects/empty-one', probe: false, state: 'non-git' },
      { id: 'e2', slug: '-private-var-folders-8k-abc123-T-Projects-gone-two', probe: false, state: 'missing' },
    ],
    dangling: [{ id: 'd1', group: 'g1', slug: '-app', line: 3, label: 'fresh branches', target: 'gone-1.md', offer: 'remove',
      lineText: '- [dev:all](live-1.md) · [biome only](live-2.md) · [fresh branches](gone-1.md)' }],
  } };
  const p = await boot({ hash: '#memory', routes: routesFor({ 'GET /api/memory': () => mem }) });
  p.$('content').querySelectorAll('.mem-tabs button').find((b) => /^Cleanups/.test(p.text(b)))?.click();
  await settle(5);
  const t = p.text(p.$('content'));
  ok('an empty project folder shows its real path, not its encoded name', /~\/Documents\/Projects\/empty-one/.test(t) && !/-Users-pat-Documents/.test(t), t.slice(0, 500));
  ok('…and one with no known path shows a short name, never the whole slug', /gone-two/.test(t) && !/-private-var-folders/.test(t));
  ok('a broken index link shows only its text and missing target', /fresh branches/.test(t) && /gone-1\.md/.test(t) && !/live-1\.md|biome only/.test(t), t);
  ok('…with no "byte-for-byte" or "_archive" fine print', !/byte-for-byte|_archive/.test(t));
  const tabs = p.$('content').querySelectorAll('.mem-tabs button').map((b) => p.text(b));
  ok('the tabs say "Unlinked & duplicates" and "Recent cleanups"', tabs.some((x) => /^Unlinked & duplicates/.test(x)) && tabs.some((x) => /^Recent cleanups/.test(x)), tabs.join(' | '));
}

/* ── P2-6: the session delete is not a second × ───────────────────────── */
console.log('\nAssist: delete session is labelled, apart from Close');
{
  const p = await boot({ hash: '#home' });
  p.eval(`C.sessions = [{ id: 's1', title: 't', mentions: [], slots: {}, createdAt: 0, updatedAt: 0, messages: [] }]; C.activeId = 's1';`);
  p.$('btn-assist').click();
  await settle(5);
  const bar = p.$('session-bar');
  const del = bar.querySelectorAll('button').find((b) => /delete/i.test(b.getAttribute('aria-label') || '') || /Delete/.test(p.text(b)));
  ok('the session delete is a labelled button ("Delete session"), not a bare ×', !!del && p.text(del).trim() === 'Delete session' && del.getAttribute('aria-label') === 'Delete this session',
    del ? `${p.text(del)} / ${del.getAttribute('aria-label')}` : '(none)');
  ok('…styled quiet and danger', !!del && del.classList.contains('btn') && del.classList.contains('ghost') && del.classList.contains('danger'));
  ok('…and no button in the session bar is a bare ×', !bar.querySelectorAll('button').some((b) => p.text(b).trim() === '×'));
}

/* ── P2-7: Recheck says it checked ────────────────────────────────────── */
console.log('\nSetup: Recheck gives feedback');
{
  const clis = { clis: [{ id: 'claude', label: 'Claude Code', installed: true, binary: '~/.local/bin/claude', version: '2.1.0',
    signIn: { state: 'present', label: 'credentials present' }, fix: {} }], acsOnPath: true, next: [] };
  const p = await boot({ hash: '#setup', routes: routesFor({ 'GET /api/setup/status': () => ({ state: 'none' }), 'GET /api/setup/clis': () => clis }) });
  const recheck = () => p.$('content').querySelectorAll('button').find((b) => /^(Recheck|Checking…)$/.test(p.text(b)));
  ok('before any Recheck, no "checked" line', !p.$('content').querySelector('.setup-checked'));
  recheck()?.click();
  await settle(20);
  const line = p.$('content').querySelector('.setup-checked');
  ok('after Recheck, a status line says when it checked and what it found', !!line && /^Checked at .+ — 1 of 1 installed$/.test(p.text(line)) && line.getAttribute('role') === 'status',
    line ? p.text(line) : '(none)');
}

/* ── P2-8: the sidebar keeps your place inside a file ─────────────────── */
console.log('\nSidebar: opening a file keeps the view you came from marked');
{
  const p = await boot({ hash: '#context' });
  await settle(5);
  p.$('content').querySelector('.cx-variant button')?.click();
  await settle(20);
  ok('a file opened from Context: the editor shows, and Context stays marked in the sidebar', p.eval('S.view') === 'entry'
    && p.$('btn-context').classList.contains('active') && !!p.$('btn-context').getAttribute('aria-current'), p.eval('S.view'));
  const q = await boot({ hash: `#file=${encodeURIComponent(PATHS.claudeMd)}` });
  await settle(10);
  ok('a file opened straight from a link: Files is marked', q.eval('S.view') === 'entry' && q.$('btn-files').classList.contains('active'));
  q.$('btn-home').click();
  await settle(10);
  ok('…and leaving for Home moves the mark', q.$('btn-home').classList.contains('active') && !q.$('btn-files').classList.contains('active'));
}

/* ── Packs: no folds; "Files and undo" opens a dialog (Cris, after the critique) ── */
console.log('\nPacks: no folds — a summary line, and "Files and undo" opens a dialog');
{
  const req = (id, ok_, extra = {}) => ({ id, ok: ok_, what: `${id} need`, fix: `fix ${id}`, dep: null, ...extra });
  const part = (id, title, explain) => ({ id, title, default: true, kind: 'skill', harnesses: ['claude'], explain });
  const pack = (id, title, parts, requirements) => ({ id, title, version: '1.0.0', summary: `${title} does a thing.`,
    explain: { what: `${title} is a pack.`, does: 'Day to day it helps.', changes: ['~/.claude/skills/x/', 'a marked block in ~/.zshrc', '~/.agent-config-studio/x/'], undo: 'Uninstalling removes the skill folders.' },
    requires: { packs: [] }, parts, requirements, installed: null });
  const cat = { packs: [
    pack('alpha', 'Alpha', [part('a-skill', 'Alpha skill', { what: 'Alpha skill does it.', does: 'd', changes: ['~/.claude/skills/alpha/'], undo: 'Remove alpha.' }),
      part('a-guard', 'Alpha guard', { what: 'Guards it.', does: 'd', changes: ['~/.claude/settings.json hook'], undo: 'Remove the hook.' })], [req('node', true), req('roles', false)]),
    pack('beta', 'Beta', [part('b-skill', 'Beta skill', { what: 'Beta does it.', changes: ['~/.claude/skills/beta/'] })], [req('node', true)]),
  ], harnesses: [{ id: 'claude', label: 'Claude Code', present: true, installed: true, cli: true, home: '~/.claude', note: null, why: null }],
  legacy: [], words: { status: { installed: 'installed', absent: 'not installed' }, symbol: {}, what: {} } };
  const p = await boot({ hash: '#packs', routes: routesFor({ 'GET /api/packs': () => cat,
    'GET /api/packs/status': () => ({ job: { running: false, result: { packs: [], legacy: [], checkedAt: Date.now(), trust: false } } }) }) });
  for (let i = 0; i < 100 && !p.$('content').querySelector('.pk-card'); i++) await settle(5);
  const c = p.$('content');
  ok('Packs: no <details>, no summary.fold, no chevron control, no triangle glyph', c.querySelectorAll('details').length === 0 && c.querySelectorAll('summary').length === 0
    && c.querySelectorAll('.chev, .fold').length === 0 && !/[▸▾▶▼◂◀›⌄]/.test(p.text(c)), `${c.querySelectorAll('details').length} details`);
  const card = (id) => c.querySelector(`[data-pack="${id}"]`);
  const line = (id) => p.text(card(id).querySelector('.pk-changes'));
  ok('each card says what it changes and how to undo it in one short muted line', line('alpha') === 'Changes 3 places · undo: acs packs uninstall alpha'
    && line('beta') === 'Changes 3 places · undo: acs packs uninstall beta', `${line('alpha')} | ${line('beta')}`);
  const btn = card('alpha').querySelectorAll('button').find((b) => p.text(b) === 'Files and undo');
  ok('…and a secondary "Files and undo" button (bordered, not quiet or primary)', !!btn && btn.classList.contains('btn') && !btn.classList.contains('ghost') && !btn.classList.contains('primary')
    && btn.getAttribute('aria-haspopup') === 'dialog');
  btn.focus();
  btn.click();
  await settle(2);
  const dlg = () => p.doc.body.querySelector('.pk-dialog');
  const d = dlg();
  ok('the button opens a modal dialog, named by its title', !!d && d.getAttribute('role') === 'dialog' && d.getAttribute('aria-modal') === 'true'
    && /Alpha/.test(p.text(p.doc.getElementById(d.getAttribute('aria-labelledby')))));
  const dt = d ? p.text(d) : '';
  ok('…with the full list: what it is, every change, how to undo it with the command, what it needs', /Alpha is a pack/.test(dt) && /a marked block in ~\/\.zshrc/.test(dt)
    && /Uninstalling removes the skill folders/.test(dt) && /acs packs uninstall alpha/.test(dt) && !!d.querySelector('.pk-reqs') && /roles need/.test(dt), dt.slice(0, 400));
  ok('…and each part with what it changes and its undo', /Alpha guard/.test(dt) && /~\/\.claude\/settings\.json hook/.test(dt) && /Remove the hook/.test(dt));
  ok('focus moves into the dialog', !!d && d.contains(p.doc.activeElement));
  const focusables = d.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"]');
  focusables.at(-1).focus();
  p.key('Tab');
  ok('Tab from the last control wraps to the first (focus stays in the dialog)', p.doc.activeElement === focusables[0]);
  p.key('Tab', { shift: true });
  ok('…and Shift+Tab from the first wraps to the last', p.doc.activeElement === focusables.at(-1));
  p.key('Escape');
  await settle(2);
  ok('Esc closes it and focus goes back to the button', !dlg() && p.doc.activeElement === btn);
  ok('(the page still has no folds after the dialog)', c.querySelectorAll('details, summary').length === 0);

  // The installer's output: a button to a dialog, not a fold.
  p.eval(`(() => { const b = document.createElement('div'); b.id = 'logbox'; document.getElementById('content').appendChild(b); pkLog(b, ['line one', 'line two']); })()`);
  const lb = p.$('logbox');
  const logBtn = lb.querySelectorAll('button').find((b) => p.text(b) === 'Installer output');
  ok('the installer output is a button, not a fold', !lb.querySelector('details, summary') && !!logBtn && logBtn.classList.contains('btn'));
  logBtn.click();
  await settle(2);
  ok('…that opens the output in a dialog', /line one\s*line two/.test(p.text(dlg()?.querySelector('pre') || { textContent: '' })));
  p.key('Escape');
  await settle(2);
  ok('…which Esc closes', !dlg());
}

for (const p of pages) p.done?.();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
