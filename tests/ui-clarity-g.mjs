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

/* ── Files: every type open; a long one shows the first few and "Show all N" ── */
console.log('\nFiles: no group toggles; long types show the first few');
{
  const reg = registry();
  const skills = reg.groups.find((g) => g.id === 'skills');
  const base = skills.entries[0];
  for (let i = 0; i < 11; i++) skills.entries.push({ ...base, id: `skill:x${i}`, label: `x${String(i).padStart(2, '0')}`, display: `~/.claude/skills/x${i}`,
    dir: `/h/.claude/skills/x${i}`, primary: `/h/.claude/skills/x${i}/SKILL.md`, files: [{ name: 'SKILL.md', path: `/h/.claude/skills/x${i}/SKILL.md`, display: `~/.claude/skills/x${i}/SKILL.md` }] });
  const am = reg.groups.find((g) => g.id === 'auto-memory');
  for (let i = 0; i < 5; i++) am.entries.push({ ...am.entries[0], id: `am:f${i}`, label: `f${i}` });
  const p = await boot({ hash: '#files', routes: routesFor({ 'GET /api/registry': () => reg }) });
  const c = p.$('content');
  const type = (name) => c.querySelectorAll('.files-type').find((t) => p.text(t.querySelector('.files-type-name')) === name);
  ok('no fold on Files: no type toggle, no details, no chevron', noFolds(p, c) && !c.querySelector('.files-type-toggle'), `${c.querySelectorAll('.files-type-toggle').length} toggles`);
  const sk = type('Skills');
  ok('a long type (12 skills) shows its first 8, then a secondary "Show all 12"', sk.querySelectorAll('.files-item').length === 8
    && !!btn(p, sk, 'Show all 12') && btn(p, sk, 'Show all 12').classList.contains('btn') && !btn(p, sk, 'Show all 12').classList.contains('primary'),
    `${sk.querySelectorAll('.files-item').length} shown`);
  ok('…its count still says all 12', p.text(sk.querySelector('.files-type-count')) === '12');
  const auto = type('Auto-memory');
  ok('a low-traffic type (Auto-memory, 6) shows its first 3, then "Show all 6"', auto.querySelectorAll('.files-item').length === 3 && !!btn(p, auto, 'Show all 6'));
  btn(p, sk, 'Show all 12')?.click();
  await settle(5);
  const sk2 = type('Skills');
  ok('"Show all" expands in place: all 12, and no button left', sk2.querySelectorAll('.files-item').length === 12 && !btn(p, sk2, 'Show all 12') && p.eval('S.view') === 'files');

  // The open file is never hidden behind the cap.
  const q = await boot({ hash: '#files', routes: routesFor({ 'GET /api/registry': () => reg }) });
  q.eval(`S.lastEntryId = 'skill:x10'; paintFilesBody();`);
  await settle(5);
  const hit = q.$('content').querySelector('.files-item[data-entry="skill:x10"]');
  ok('the last-opened file shows even past the cap', !!hit && hit.classList.contains('active'));
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
  ok('"Show all" expands in place, every file selectable', card2.querySelectorAll('.mem-fact').length === 5 && !btn(p, card2, 'Show all 5 files')
    && p.$('content').querySelectorAll('.mem-card .sel-check').length === 5);
}

/* ── Audit: refusals listed, capped ───────────────────────────────────── */
console.log('\nAudit: refused files are listed, not folded');
{
  const byClass = Object.fromEntries(['user', 'synced', 'readonly', 'plugin', 'vendor'].map((k) => [k, { files: 0, findings: 0, fixable: 0 }]));
  const refusals = Array.from({ length: 5 }, (_, i) => ({ path: `~/p/f${i}.md`, reason: 'too large' }));
  const audit = { scannedAt: 1, run: 1, partial: false, partialReasons: [], policyError: null, refusals, files: [],
    counts: { files: 0, findings: 0, fixable: 0, skipped: { tooLarge: 0, binary: 0, backup: 0 }, refused: 5, byClass } };
  const p = await boot({ hash: '#audit', routes: routesFor({ 'GET /api/audit': () => audit, 'GET /api/audit/summary': () => ({ state: 'ok', findings: 0, fixable: 0, scannedAt: 1, stale: false }) }) });
  const c = p.$('content');
  const r = c.querySelector('.audit-refusals');
  ok('refused files: a heading line, the first 3 listed, then "Show all 5"', !!r && noFolds(p, c) && /5 files were not read/.test(p.text(r))
    && r.querySelectorAll('.scope-note').length === 3 && !!btn(p, r, 'Show all 5'), r ? p.text(r) : '(none)');
  btn(p, r, 'Show all 5')?.click();
  await settle(5);
  const r2 = p.$('content').querySelector('.audit-refusals');
  ok('…which expands in place', r2.querySelectorAll('.scope-note').length === 5 && !btn(p, r2, 'Show all 5'));
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
