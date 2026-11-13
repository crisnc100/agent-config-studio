/**
 * PR G (builds/ui-clarity/final-critique-2.md): no folds anywhere — every <details>, summary and
 * chevron toggle gives way to a list that is just shown, a "Show all N" button that expands in place,
 * or a dialog for reference detail — and the Trash badge sized to its word.
 *
 * The page in the fake DOM against stubbed routes (tests/fixtures/shell-page.mjs), plus static
 * reads of public/. No server, no HOME.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bootPage, routesFor, settle, ROOT, MEMORY, registry } from './fixtures/shell-page.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const pages = [];
const boot = async (o) => { const p = await bootPage(o); pages.push(p); await settle(20); return p; };
const btn = (p, root, text) => root?.querySelectorAll('button').find((b) => p.text(b).trim() === text);
const noFolds = (p, root) => root.querySelectorAll('details, summary, .chev, .fold').length === 0 && !/[▸▾▶▼◂◀]/.test(p.text(root));

/* ── static: no fold left in the code or the styles ───────────────────── */
console.log('\nstatic: no folds in public/');
{
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
  const js = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.js')).map((f) => [f, strip(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'))]);
  const made = js.flatMap(([f, src]) => [...src.matchAll(/el\(\s*'(details|summary)'|createElement\(\s*'(details|summary)'/g)].map((m) => `${f}: ${m[0]}`));
  ok('no view builds a <details> or <summary>', made.length === 0, made.join(' | '));
  const chev = js.flatMap(([f, src]) => [...src.matchAll(/['"`][^'"`]*\bchev\b[^'"`]*['"`]/g)].map((m) => `${f}: ${m[0]}`));
  ok('no control carries the chevron class (.chev)', chev.length === 0, chev.join(' | '));
  const css = strip(fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8'));
  const sels = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) => m[1].trim());
  const foldSels = sels.filter((s) => /(^|[\s,>+~])(summary|details)\b|\.chev\b|summary\.fold|files-type-toggle::before/.test(s));
  ok('styles.css has no fold rule: no summary, details, .chev or toggle chevron', foldSels.length === 0, foldSels.join(' | '));
  const rule = (sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].split(',').map((x) => x.trim()).includes(sel)).map((m) => m[2]).join(';');
  const tk = rule('.trash-kind');
  ok('the Trash badge is sized to its word: no fixed width, a min-width, one line, never shrunk', !!tk && !/(^|;)\s*width\s*:/.test(tk) && /min-width\s*:/.test(tk)
    && /white-space\s*:\s*nowrap/.test(tk) && /flex\s*:\s*none/.test(tk), tk);
}

/* ── File lists on their own pages: every file shown, no folds ── */
console.log('\nFile lists: every file shown, no group toggles');
{
  const reg = registry();
  const hooks = reg.groups.find((g) => g.id === 'hooks');
  const base = hooks.entries[0];
  for (let i = 0; i < 11; i++) hooks.entries.push({ ...base, id: `hook:x${i}`, label: `x${String(i).padStart(2, '0')}`, display: `~/.claude/hooks/x${i}.sh`,
    primary: `/h/.claude/hooks/x${i}.sh`, files: [{ name: `x${i}.sh`, path: `/h/.claude/hooks/x${i}.sh`, display: `~/.claude/hooks/x${i}.sh` }] });
  const p = await boot({ hash: '#setup&step=settings', routes: routesFor({ 'GET /api/registry': () => reg }) });
  await settle(10);
  const c = p.$('content');
  ok('no fold on Setup\'s file lists: every one of the 12 hooks is listed, with no toggle or "Show all"', noFolds(p, c)
    && hooks.entries.every((e) => c.querySelector(`.entry-row[data-entry="${e.id}"]`)) && !c.querySelectorAll('button').some((b) => /^Show all/.test(p.text(b))),
    `${c.querySelectorAll('.entry-row').length} rows`);
}

/* ── Models: Model ids always open; "Used by" opens a dialog ──────────── */
console.log('\nModels: no folds');
{
  const view = {
    roles: [{ name: 'reviewer', use: ['opus'], ids: ['opus-id'], effort: '', resolvedEffort: '', alt: '', altId: '', note: 'reads diffs',
      custom: true, provenance: { use: 'user' }, defaults: null, warnings: [] }],
    flavor: [{ family: 'opus', flavor: { likes: ['a'], quirks: [], brief: 'b' }, provenance: {}, defaults: {} }],
    families: ['opus', 'sol'], efforts: ['medium'], limits: { brief: 600, item: 160, items: 12, note: 160, use: 8 }, base: 'sha256:1', userText: '{}\n', error: null,
    userFile: '~/.agent-config-studio/roles.json', describe: { ready: false, why: 'off', limits: { description: 10 } },
  };
  const models = { pending: 0, checkedAt: Date.now(), catalogs: [], rows: [
    { family: 'opus', id: 'opus-id', vendor: 'claude', track: true, source: 'default', defaultId: 'opus-id', alerts: [] },
    { family: 'sol', id: 'sol-id', vendor: 'codex', track: true, source: 'default', defaultId: 'sol-id', alerts: [] },
  ] };
  const p = await boot({ hash: '#models', routes: routesFor({ 'GET /api/models': () => models, 'GET /api/models/roles': () => view,
    'GET /api/models/where': () => ({ hits: [{ file: '~/.claude/skills/r/SKILL.md', line: 3, text: 'model-id --role reviewer' }] }) }) });
  const c = p.$('content');
  ok('no fold on Models: no details, no chevron toggle', noFolds(p, c) && !c.querySelector('[aria-expanded].ids-toggle'));
  const ids = c.querySelector('.models-ids');
  ok('Model ids is always shown: its table drawn with no alert waiting', !!ids?.querySelector('.models-table') && ids.querySelectorAll('.models-row').length === 2 && /Model ids/.test(p.text(ids)));
  const used = c.querySelector('.model-card[data-family="opus"] .model-used-toggle');
  ok('"Used by 1 role" is a quiet button that opens a dialog, not a fold', !!used && used.classList.contains('ghost') && used.getAttribute('aria-haspopup') === 'dialog' && !used.hasAttribute('aria-expanded'));
  used?.click();
  await settle(10);
  const d = p.doc.body.querySelector('.pk-dialog');
  ok('…the dialog names the roles and the files that call it', !!d && /Roles: reviewer/.test(p.text(d)) && /SKILL\.md:3/.test(p.text(d)), d ? p.text(d) : '(none)');
  p.key('Escape');
  await settle(2);
  ok('…Esc closes it, focus back on the button', !p.doc.body.querySelector('.pk-dialog') && p.doc.activeElement?.classList?.contains('model-used-toggle'));

  // f2: a slow lookup that answers after you left Models opens nothing.
  let release;
  const slow = new Promise((r) => { release = r; });
  const q = await boot({ hash: '#models', routes: routesFor({ 'GET /api/models': () => models, 'GET /api/models/roles': () => view,
    'GET /api/models/where': () => slow }) });
  q.$('content').querySelector('.model-card[data-family="opus"] .model-used-toggle').click();
  await settle(2);
  q.$('btn-home').click();
  await settle(5);
  release({ hits: [] });
  await settle(10);
  ok('f2 a "Used by" answer that lands after leaving Models opens no dialog', !q.doc.body.querySelector('.pk-dialog') && q.eval('S.view') === 'home');
}

/* ── Memory → Projects: plain cards, first few files, "Show all N" ────── */
console.log('\nMemory → Projects: plain cards');
{
  const rows = Array.from({ length: 5 }, (_, i) => ({ ...MEMORY.rows[0], id: `r${i}`, name: `fact${i}`, rel: `fact${i}.md`, inQueue: false }));
  const mem = { ...MEMORY, rows, groups: [{ ...MEMORY.groups[0], rowCount: 5 }] };
  const p = await boot({ hash: '#memory', routes: routesFor({ 'GET /api/memory': () => mem }) });
  btn(p, p.$('content').querySelector('.mem-tabs'), 'Projects (1)')?.click();
  await settle(5);
  const c = p.$('content');
  const card = c.querySelector('.mem-card');
  ok('a project card is a plain card, not a fold', !!card && card.localName !== 'details' && noFolds(p, c));
  ok('…showing its first 3 files, then "Show all 5 files"', card.querySelectorAll('.mem-fact').length === 3 && !!btn(p, card, 'Show all 5 files'));
  ok('…its shown rows are selectable', c.querySelectorAll('.mem-card .sel-check').length === 3);
  btn(p, card, 'Show all 5 files')?.click();
  await settle(5);
  const card2 = p.$('content').querySelector('.mem-card');
  ok('f1 focus lands on the first newly shown file (row 4), not a detached button', !!p.doc.activeElement && card2.querySelectorAll('.mem-fact')[3]?.contains(p.doc.activeElement),
    p.doc.activeElement?.className);
  ok('"Show all" expands in place, every file selectable', card2.querySelectorAll('.mem-fact').length === 5 && !btn(p, card2, 'Show all 5 files')
    && p.$('content').querySelectorAll('.mem-card .sel-check').length === 5);
}


/* ── Trash: the badge is its own class, sized to its word ──────────────── */
console.log('\nTrash: the kind badge');
{
  const p = await boot({ hash: '#trash', routes: routesFor({ 'GET /api/trash': () => ({ items: [
    { id: 't1', isDir: true, display: '~/.claude/skills/x', deletedAt: Date.now(), fileCount: 3, restorable: true },
    { id: 't2', isDir: false, display: '~/.claude/CLAUDE.md', deletedAt: Date.now(), fileCount: 1, restorable: true },
  ] }) }) });
  const kinds = p.$('content').querySelectorAll('.trash-kind').map((k) => p.text(k));
  ok('each Trash row has a "folder" / "file" badge with its own class (not the 24px rank square)', kinds.join() === 'folder,file'
    && !p.$('content').querySelectorAll('.trash-kind').some((k) => k.classList.contains('scope-rank')), kinds.join());
}

for (const p of pages) p.done?.();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
