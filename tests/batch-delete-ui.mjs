/**
 * Multi-select delete in the page (builds/batch-delete/plan.md, criterion 2
 * and folds D1, D5, D8–D10): Context's checkboxes, bar, confirm and per-item
 * notice; Memory's Delete selected through the trash-fact preview; selection
 * that only ever holds visible rows; the editor and navigation while a batch
 * is pending.
 *
 * Runs index.html and the real public/ scripts in a node VM against stubbed
 * routes (tests/fixtures/shell-page.mjs). No server, no HOME. Real Tab and
 * Space, focus after a repaint, tooltips and the sticky bar are browser-QA
 * items: the fake DOM has no layout or focus rules.
 */
import { bootPage, routesFor, MEMORY, PATHS, settle } from './fixtures/shell-page.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\nbatch delete — page');

const H = '/h';
/** A Context payload: `n` editable rows, one protected, one read-only. */
function contextOf(n, { extra = [] } = {}) {
  const v = (id, over) => ({ id, sha: id, trunk: true, drift: false, lines: 3, copies: 1, readOnly: false, protected: false,
    paths: [{ display: `~/p/${id}`, trunk: true }], outline: [], ...over });
  const variants = [
    ...Array.from({ length: n }, (_, i) => v(`e${i}`, { open: { path: `${H}/p/e${i}/CLAUDE.md`, display: `~/p/e${i}/CLAUDE.md` } })),
    v('prot', { protected: true, open: { path: `${H}/p/CLAUDE.md`, display: '~/p/CLAUDE.md' } }),
    v('ro', { readOnly: true, open: { display: '~/client/CLAUDE.md' } }),
    ...extra,
  ];
  return {
    totals: { files: variants.length, entries: variants.length, collapsedCopies: 0, drifted: 0 },
    roots: { p: { label: 'Projects', files: variants.length, entries: variants.length, drifted: 0 } }, unreadable: [],
    groups: [{ root: 'p', rootLabel: 'Projects', label: 'p', display: '~/p', checkouts: [{}],
      scopes: variants.map((x) => ({ scope: x.id, kind: 'claude', drift: false, trunkId: null, variants: [x] })) }],
  };
}
const trashedAll = (paths) => ({ results: paths.map((p, i) => ({ path: p, display: p.replace(H, '~'), status: 'trashed', trashId: `t${i}`, files: 1 })), historyWarnings: [] });

const pages = [];
async function boot({ hash = '#context', ctx = contextOf(3), over = {} } = {}) {
  const state = { ctx, posts: [], batch: (b) => trashedAll(b.paths) };
  const routes = routesFor({
    'GET /api/context': () => state.ctx,
    'POST /api/delete/batch': (b) => { state.posts.push(b); return state.batch(b); },
    ...over,
  });
  const p = await bootPage({ routes, hash });
  pages.push(p);
  await settle(10);
  p.state = state;
  return p;
}
const boxes = (p) => p.$('content').querySelectorAll('.sel-check');
const enabled = (p) => boxes(p).filter((b) => !b.disabled);
const bar = (p) => p.$('content').querySelector('.sel-bar');
const barBtn = (p, label) => bar(p).querySelectorAll('button').find((b) => p.text(b).startsWith(label));
const count = (p) => p.text(bar(p).querySelector('.sel-count'));
const noticeText = (p) => p.text(p.$('notice-slot'));
const requests = (p, path, method = 'GET') => p.requests.filter((r) => r.path === path && r.method === method);

// ── Context: what can be selected ─────────────────────────────────────────
{
  const p = await boot();
  ok('C2 Context: one checkbox per row, and a selection bar', boxes(p).length === 5 && bar(p), `${boxes(p).length}`);
  const prot = boxes(p).find((b) => /~\/p\/CLAUDE\.md/.test(b.getAttribute('aria-label')));
  const ro = boxes(p).find((b) => /client/.test(b.getAttribute('aria-label')));
  ok('C2 a protected row\'s checkbox is disabled, and says why', prot?.disabled && /Loaded on every session/.test(prot.title)
     && /typ/.test(prot.parentNode.title), prot?.title);
  ok('D2 a read-only row\'s checkbox is disabled, and says why', ro?.disabled && /read-only/.test(ro.title), ro?.title);
  ok('keyboard: every enabled checkbox is a focusable checkbox input, labelled', enabled(p).length === 3
     && enabled(p).every((b) => b.localName === 'input' && b.type === 'checkbox' && b.getAttribute('tabindex') !== '-1' && /^Select /.test(b.getAttribute('aria-label'))));
  ok('keyboard: the bar is buttons in a labelled toolbar, reachable by Tab', bar(p).getAttribute('role') === 'toolbar'
     && bar(p).querySelectorAll('button').length === 3 && bar(p).querySelectorAll('button').every((b) => b.getAttribute('tabindex') !== '-1'));
  ok('the bar starts at 0 selected, Delete and Clear disabled', count(p) === '0 selected' && barBtn(p, 'Delete').disabled && barBtn(p, 'Clear').disabled);

  enabled(p)[1].click();
  ok('a tick counts on the bar without a repaint', count(p) === '1 selected' && !barBtn(p, 'Delete').disabled && enabled(p)[1].checked);
  barBtn(p, 'Select all').click();
  ok('C2 Select all (visible) ticks every selectable row, never a disabled one', count(p) === '3 selected'
     && enabled(p).every((b) => b.checked) && !boxes(p).some((b) => b.disabled && b.checked));
  barBtn(p, 'Clear').click();
  ok('Clear empties it', count(p) === '0 selected' && !boxes(p).some((b) => b.checked));
  ok('no page errors', p.errors.length === 0, p.errors.join('; '));
}

// ── Context: confirm, cancel, OK, notice, refresh ─────────────────────────
{
  const p = await boot({ ctx: contextOf(12) });
  barBtn(p, 'Select all').click();
  let asked = null;
  p.confirm = (m) => { asked = m; return false; };
  barBtn(p, 'Delete').click();
  await settle(5);
  ok('C2 the confirm names the count and lists ten paths, then "+2 more"', /^Delete 12 files\?/.test(asked)
     && asked.includes('~/p/e0/CLAUDE.md') && asked.includes('~/p/e9/CLAUDE.md') && !asked.includes('~/p/e10/') && asked.includes('+2 more'), asked);
  ok('C2 …and says they go to Trash and can be restored', /trash/.test(asked) && /restore them from Trash/.test(asked));
  ok('C2 Cancel posts nothing, and keeps the selection', p.state.posts.length === 0 && count(p) === '12 selected');

  const ctxGets = requests(p, '/api/context').length, regGets = requests(p, '/api/registry').length;
  p.state.ctx = contextOf(0);   // what the server shows once those are gone
  p.confirm = () => true;
  barBtn(p, 'Delete').click();
  await settle(10);
  const sent = p.state.posts[0]?.paths;
  ok('C2 OK posts exactly the selected paths, once', p.state.posts.length === 1 && sent.length === 12
     && sent.every((x, i) => x === `${H}/p/e${i}/CLAUDE.md`), JSON.stringify(sent));
  ok('C2 the notice says how many, and where to recover them', /Deleted 12 files\. Recover them under Trash\./.test(noticeText(p)), noticeText(p));
  ok('D8 the Context data and the registry are fetched again', requests(p, '/api/context').length === ctxGets + 1 && requests(p, '/api/registry').length === regGets + 1);
  ok('D8 …and the rows on screen really change', boxes(p).length === 2 && /2 instruction files/.test(p.text(p.$('content'))), `${boxes(p).length}`);
  ok('D9 the selection is cleared after the batch', count(p) === '0 selected');
  ok('no page errors', p.errors.length === 0, p.errors.join('; '));
}

// ── Context: per-item outcomes reach the notice ───────────────────────────
{
  const p = await boot({ ctx: contextOf(4) });
  p.state.batch = ({ paths }) => ({
    results: [
      { path: paths[0], display: '~/p/e0/CLAUDE.md', status: 'trashed', trashId: 't0' },
      { path: paths[1], display: '~/p/e1/CLAUDE.md', status: 'moved-but-unfinished', trashId: 't1', error: 'EIO renaming metadata' },
      { path: paths[2], display: '~/p/e2/CLAUDE.md', status: 'failed', error: 'disk full' },
      { path: paths[3], display: '~/p/e3/CLAUDE.md', status: 'not-attempted' },
    ],
    historyWarnings: [{ display: '~/p/e0/CLAUDE.md', error: 'git lock' }],
  });
  barBtn(p, 'Select all').click();
  barBtn(p, 'Delete').click();
  await settle(10);
  const t = noticeText(p);
  ok('D5 a partial batch: the notice is a warning with the count trashed', p.$('notice-slot').querySelector('.notice.warn') && /Deleted 1 file\. Recover it under Trash\./.test(t), t);
  ok('D5 …moved-but-unfinished says it is restorable', /e1\/CLAUDE\.md: moved to Trash, but the delete did not finish \(EIO renaming metadata\)\. It can be restored from Trash\./.test(t));
  ok('D5 …failed carries its error', /e2\/CLAUDE\.md: not deleted — disk full/.test(t));
  ok('D5 …not-attempted is named', /e3\/CLAUDE\.md: not attempted/.test(t));
  ok('D7 …and the history warning is shown', /e0\/CLAUDE\.md: history not recorded — git lock/.test(t));
}

// ── Context: a preflight refusal, and a re-read that fails ────────────────
{
  const p = await boot({ ctx: contextOf(2) });
  p.state.batch = () => { throw { status: 400, body: { error: '~/p/e1/CLAUDE.md is hard-linked — nothing was deleted', path: `${H}/p/e1/CLAUDE.md` } }; };
  barBtn(p, 'Select all').click();
  barBtn(p, 'Delete').click();
  await settle(10);
  ok('a refused batch shows the server\'s reason, and keeps the selection', /hard-linked — nothing was deleted/.test(noticeText(p))
     && count(p) === '2 selected' && !barBtn(p, 'Delete').disabled, noticeText(p));
}
{
  // The re-read after the delete fails: the old rows stay, marked.
  let failing = false;
  const p = await boot({ ctx: contextOf(2), over: { 'GET /api/context': () => { if (failing) throw { status: 500, body: { error: 'scan timed out' } }; return contextOf(2); } } });
  barBtn(p, 'Select all').click();
  failing = true;
  barBtn(p, 'Delete').click();
  await settle(10);
  ok('D8 a failed re-read keeps the view, marked as from before the delete', p.eval('S.view') === 'context' && boxes(p).length === 4
     && /Showing Context as it was before the delete — reading it again failed \(scan timed out\)/.test(p.text(p.$('content'))));
  ok('D8 …and the notice says so beside the result', /Deleted 2 files/.test(noticeText(p)) && /could not be read again \(scan timed out\)/.test(noticeText(p)), noticeText(p));
  ok('D8 the page uses no wording the Memory/Context copy rules forbid', !/\bstale\b|\bunused\b|never used/i.test(p.text(p.$('content')) + noticeText(p)));
}

// ── while a batch is pending ──────────────────────────────────────────────
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
{
  const p = await boot({ ctx: contextOf(3) });
  const d = deferred();
  p.state.batch = () => d.promise;
  enabled(p)[0].click(); enabled(p)[1].click();
  barBtn(p, 'Delete').click();
  await settle(5);
  ok('D9 while it runs, the bar\'s buttons and the checkboxes are disabled', barBtn(p, 'Delete').disabled && barBtn(p, 'Select all').disabled
     && barBtn(p, 'Clear').disabled && boxes(p).every((b) => b.disabled));
  barBtn(p, 'Delete').click();
  await settle(5);
  ok('D9 …so a second click posts nothing more', p.state.posts.length === 1);

  // Leave for Memory before the answer arrives.
  p.$('btn-memory').click();
  await settle(10);
  ok('D10 navigation while pending: Memory opens', p.eval('S.view') === 'memory' && /Memory/.test(p.text(p.$('content').querySelector('h2'))));
  d.resolve(trashedAll(p.state.posts[0].paths));
  await settle(10);
  ok('D10 …and the late answer does not repaint Context over it', p.eval('S.view') === 'memory' && p.$('content').querySelector('h2') && p.text(p.$('content').querySelector('h2')) === 'Memory'
     && !p.$('content').querySelector('.cx-variant'));
  ok('D10 …while its notice still reports the result', /Deleted 2 files/.test(noticeText(p)), noticeText(p));
  p.$('btn-context').click();
  await settle(10);
  ok('D9 back on Context: the selection was cleared by the view change', count(p) === '0 selected');
  ok('no page errors', p.errors.length === 0, p.errors.join('; '));
}
{
  // The editor opened, during the batch, on a file the batch removes.
  const ctx = contextOf(0, { extra: [
    { id: 'm', sha: 'm', trunk: true, drift: false, lines: 3, copies: 1, readOnly: false, protected: false, paths: [], outline: [],
      open: { path: PATHS.claudeMd, display: '~/Documents/Projects/app/CLAUDE.md' } },
    { id: 'h', sha: 'h', trunk: true, drift: false, lines: 3, copies: 1, readOnly: false, protected: false, paths: [], outline: [],
      open: { path: PATHS.hook, display: '~/.claude/hooks/pre tool.sh' } },
  ] });
  const p = await boot({ ctx });
  const d = deferred();
  p.state.batch = () => d.promise;
  enabled(p).find((b) => /app\/CLAUDE\.md/.test(b.getAttribute('aria-label'))).click();
  barBtn(p, 'Delete').click();
  await settle(5);
  p.eval(`openInEditor(${JSON.stringify(PATHS.claudeMd)}, '~/Documents/Projects/app/CLAUDE.md')`);
  await settle(10);
  ok('D10 (setup) the editor is open on a file in the pending batch', p.eval('S.view') === 'entry' && p.eval('S.file?.path') === PATHS.claudeMd);
  d.resolve(trashedAll([PATHS.claudeMd]));
  await settle(10);
  ok('D10 the deleted file\'s editor closes, as single delete\'s does', p.eval('S.file') === null && p.eval('S.view') === 'home');

  const q = await boot({ ctx });
  const d2 = deferred();
  q.state.batch = () => d2.promise;
  enabled(q).find((b) => /app\/CLAUDE\.md/.test(b.getAttribute('aria-label'))).click();
  barBtn(q, 'Delete').click();
  await settle(5);
  q.eval(`openInEditor(${JSON.stringify(PATHS.hook)}, '~/.claude/hooks/pre tool.sh')`);
  await settle(10);
  q.eval(`S.draft = 'an unsaved edit'`);
  d2.resolve(trashedAll([PATHS.claudeMd]));
  await settle(10);
  ok('D10 an unrelated draft is left exactly as it was', q.eval('S.view') === 'entry' && q.eval('S.file?.path') === PATHS.hook
     && q.eval('S.draft') === 'an unsaved edit');
}

// ── the cap ───────────────────────────────────────────────────────────────
{
  const p = await boot({ ctx: contextOf(205) });
  barBtn(p, 'Select all').click();
  ok('D9 over 200 visible: Select all takes the first 200, and says so', count(p) === '200 selected'
     && /first 200 of 205/.test(noticeText(p)) && !barBtn(p, 'Delete').disabled, `${count(p)} / ${noticeText(p)}`);
  enabled(p)[204].click();
  ok('D9 a 201st tick is counted honestly and Delete refuses it', count(p) === '201 selected — at most 200 at once' && barBtn(p, 'Delete').disabled);
}

// ── Memory: Delete selected is the trash-fact operation ──────────────────
const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
const memoryOf = (rows) => ({ ...MEMORY, rows, groups: [{ ...MEMORY.groups[0], rowCount: rows.length }] });
const R3 = { id: 'r3', name: 'fresh', type: 'project', group: 'g1', rel: 'fresh.md', inQueue: true, activity: recent, modified: recent,
  openPath: `${H}/.claude/projects/-app/memory/fresh.md`, display: '~/.claude/projects/-app/memory/fresh.md' };
async function bootMemory() {
  const m = { rows: [...MEMORY.rows, R3], previews: [], accepts: [], failRead: false };
  const p = await boot({ hash: '#memory', over: {
    'GET /api/memory': () => { if (m.failRead) throw { status: 500, body: { error: 'transcripts unreadable' } }; return memoryOf(m.rows); },
    'POST /api/memory/preview': (b) => {
      m.previews.push(b);
      const gone = m.rows.filter((r) => b.ids.includes(r.id));
      return { opId: 'a'.repeat(24), action: b.action, summary: `Trash ${b.ids.length} facts and their index links`,
        items: gone.map((r) => `${r.display} — moves to the ACS trash`), diffs: [] };
    },
    'POST /api/memory/accept': async (b) => {
      m.accepts.push(b);
      if (m.holdAccept) { const h = m.holdAccept; m.holdAccept = null; await h.promise; }
      if (m.failAccept) throw m.failAccept;
      const ids = m.previews.at(-1).ids;
      const steps = m.rows.filter((r) => ids.includes(r.id)).map((r) => ({ type: 'trash', label: r.display, path: r.display, done: true, restored: false }));
      m.rows = m.rows.filter((r) => !ids.includes(r.id));
      return { id: 'a'.repeat(24), summary: `Trash ${ids.length} facts`, status: 'applied', steps, skipped: [], historyError: null };
    },
  } });
  p.m = m;
  return p;
}
{
  const p = await bootMemory();
  ok('D1 Memory: each fact row has a checkbox, and the bar is there', boxes(p).length === 3 && bar(p));
  enabled(p)[0].click(); enabled(p)[1].click();
  barBtn(p, 'Delete').click();
  await settle(10);
  ok('D1 Delete selected previews trash-fact for exactly the ticked ids', p.m.previews.length === 1 && p.m.previews[0].action === 'trash-fact'
     && JSON.stringify(p.m.previews[0].ids) === JSON.stringify(['r1', 'r2']), JSON.stringify(p.m.previews));
  ok('D1 …the preview lists each file, and nothing is accepted yet', p.$('content').querySelectorAll('.mem-items li').length === 2 && p.m.accepts.length === 0);
  const panelBtn = (label) => p.$('content').querySelector('.mem-preview').querySelectorAll('button').find((b) => p.text(b) === label);
  panelBtn('Cancel').click();
  await settle(5);
  ok('C2 Cancel accepts nothing and keeps the selection', p.m.accepts.length === 0 && !p.$('content').querySelector('.mem-preview') && count(p) === '2 selected');
  barBtn(p, 'Delete').click();
  await settle(10);
  const gets = requests(p, '/api/memory').length;
  p.$('content').querySelector('.mem-preview').querySelectorAll('button').find((b) => p.text(b) === 'Accept').click();
  await settle(10);
  ok('D1 Accept accepts the previewed operation', p.m.accepts.length === 1 && p.m.accepts[0].opId === 'a'.repeat(24));
  ok('D8 the Memory data is read again and the rows really change', requests(p, '/api/memory').length === gets + 1 && boxes(p).length === 1
     && /1 memory files/.test(p.text(p.$('content'))), `${boxes(p).length}`);
  ok('D9 the selection is cleared after it', count(p) === '0 selected');
  ok('D10 Accept stays on Memory', p.eval('S.view') === 'memory');
  ok('no page errors', p.errors.length === 0, p.errors.join('; '));
}
{
  const p = await bootMemory();
  const fresh = () => enabled(p).find((b) => /fresh\.md/.test(b.getAttribute('aria-label')));
  fresh().click();
  ok('(setup) the recent fact is ticked', count(p) === '1 selected');
  const age = p.$('content').querySelector('select');
  age.value = '30';
  age.onchange();
  await settle(5);
  ok('D9 a filter that hides a ticked row drops it from the selection', !fresh() && count(p) === '0 selected');
  barBtn(p, 'Select all').click();
  ok('C2 Select all respects the filter: only the two older facts', count(p) === '2 selected' && enabled(p).length === 2);
  const tab = (label) => p.$('content').querySelectorAll('.mem-tabs .tab').find((b) => p.text(b).startsWith(label));
  tab('Projects').click();
  await settle(5);
  ok('D9 a tab change clears the selection', count(p) === '0 selected');
  ok('D9 a closed project card shows no rows to select', boxes(p).length === 0 && barBtn(p, 'Select all').disabled);
  const card = p.$('content').querySelector('details.mem-card');
  card.open = true; card.ontoggle();
  ok('D9 opened, its rows can be selected', boxes(p).length === 3 && !barBtn(p, 'Select all').disabled);
  barBtn(p, 'Select all').click();
  ok('(setup) all three ticked', count(p) === '3 selected');
  card.open = false; card.ontoggle();
  ok('D9 closing the card drops its rows from the selection', count(p) === '0 selected' && barBtn(p, 'Select all').disabled);
  card.open = true; card.ontoggle();
  ok('D9 reopened, they are selectable again, unticked', !barBtn(p, 'Select all').disabled && boxes(p).every((b) => !b.checked));

  tab('Review').click();
  await settle(5);
  barBtn(p, 'Select all').click();
  p.$('btn-context').click();
  await settle(10);
  p.$('btn-memory').click();
  await settle(10);
  ok('D9 leaving Memory and coming back clears the selection', count(p) === '0 selected');
}
{
  const p = await bootMemory();
  enabled(p)[0].click();
  barBtn(p, 'Delete').click();
  await settle(10);
  p.m.failRead = true;
  p.$('content').querySelector('.mem-preview').querySelectorAll('button').find((b) => p.text(b) === 'Accept').click();
  await settle(10);
  ok('D8 Memory: a failed re-read keeps the rows shown, marked', p.eval('S.view') === 'memory' && boxes(p).length === 3
     && /Showing Memory as it was before the last change — reading it again failed \(transcripts unreadable\)/.test(p.text(p.$('content'))));
  ok('D8 …the result notice is still shown', /done\. Restorable from Operations/.test(noticeText(p)), noticeText(p));
}

// ── grade 1: an older Context read never overwrites a newer one ───────────
{
  let held = null, current = contextOf(2);
  const p = await boot({ over: { 'GET /api/context': () => { if (held) { const h = held; held = null; return h.promise; } return current; } } });
  const row = (i) => enabled(p).find((b) => b.getAttribute('aria-label') === `Select ~/p/e${i}/CLAUDE.md`);
  row(0).click();
  const old = deferred();
  held = old;
  barBtn(p, 'Delete').click();
  await settle(10);
  // Away and back: a fresh open reads B alone; then B is deleted and the newest read is empty.
  p.$('btn-memory').click(); await settle(10);
  current = { ...contextOf(0), groups: [{ ...contextOf(2).groups[0], scopes: contextOf(2).groups[0].scopes.filter((x) => x.scope !== 'e0') }] };
  p.$('btn-context').click(); await settle(10);
  ok('(setup) after returning, only B is selectable', enabled(p).length === 1 && row(1));
  row(1).click();
  current = contextOf(0);
  barBtn(p, 'Delete').click();
  await settle(10);
  ok('(setup) the newest read is empty', enabled(p).length === 0);
  old.resolve({ ...contextOf(0), groups: [{ ...contextOf(2).groups[0], scopes: contextOf(2).groups[0].scopes.filter((x) => x.scope !== 'e0') }] });
  await settle(10);
  ok('grade 1: the older read, answering last, is dropped — B does not come back', enabled(p).length === 0 && !row(1));
  ok('no page errors', p.errors.length === 0, p.errors.join('; '));
}

// ── grade 2–4: Memory while Accept is out, and when it fails ──────────────
async function memoryAccepting(p) {
  enabled(p)[0].click(); enabled(p)[1].click();
  barBtn(p, 'Delete').click();
  await settle(10);
}
const acceptBtn = (p) => p.$('content').querySelector('.mem-preview')?.querySelectorAll('button').find((b) => p.text(b) === 'Accept');
const failedOp = (rows) => ({ status: 500, body: { error: 'disk full — the steps that ran can be restored from Operations',
  op: { id: 'a'.repeat(24), status: 'failed', steps: rows.map((r, i) => ({ type: 'trash', label: r.display, path: r.display, done: i === 0, restored: false })) } } });
{
  const p = await bootMemory();
  const held = deferred();
  await memoryAccepting(p);
  ok('grade 3: with the preview open, the selection is frozen: checkboxes, Delete and the filter disabled',
     boxes(p).every((b) => b.disabled) && barBtn(p, 'Delete').disabled && p.$('content').querySelector('select').disabled && !acceptBtn(p).disabled);
  p.m.holdAccept = held;
  acceptBtn(p).click();
  await settle(5);
  ok('grade 3: during Accept, Accept itself is disabled too', acceptBtn(p).disabled && boxes(p).every((b) => b.disabled) && barBtn(p, 'Delete').disabled);
  p.eval('paintMemory()');
  ok('grade 3: …and a repaint mid-Accept keeps every one of them disabled', acceptBtn(p).disabled && boxes(p).every((b) => b.disabled)
     && barBtn(p, 'Delete').disabled && barBtn(p, 'Select all').disabled && p.$('content').querySelector('select').disabled);
  held.resolve();
  await settle(10);
  ok('grade 3: settled, everything is live again', !barBtn(p, 'Select all').disabled && enabled(p).length > 0 && !p.$('content').querySelector('select').disabled);
  ok('QA B: after Accept, focus is on the bar, not BODY', p.doc.activeElement !== p.doc.body && bar(p).contains(p.doc.activeElement), p.doc.activeElement?.tagName);
}
{
  const p = await bootMemory();
  const rows = p.m.rows.slice(0, 2);
  await memoryAccepting(p);
  const held = deferred();
  p.m.holdAccept = held;
  acceptBtn(p).click();
  await settle(5);
  p.$('btn-context').click();
  await settle(10);
  const gets = requests(p, '/api/memory').length;
  held.reject(failedOp(rows));
  await settle(10);
  ok('grade 2: a late Accept failure does not navigate back to Memory', p.eval('S.view') === 'context' && p.$('content').querySelector('.cx-variant'));
  ok('grade 2: …it reports, and does not read Memory again behind Context', /disk full/.test(noticeText(p)) && requests(p, '/api/memory').length === gets);
}
{
  const p = await bootMemory();
  const rows = p.m.rows.slice(0, 2);
  await memoryAccepting(p);
  const regs = requests(p, '/api/registry').length;
  p.m.failAccept = failedOp(rows);
  p.m.failRead = true;
  acceptBtn(p).click();
  await settle(10);
  const t = noticeText(p);
  ok('grade 4: a partial failure names the fact that moved, and where Restore is', new RegExp(`${rows[0].display.replace(/[.]/g, '\\.')}: moved to the ACS trash`).test(t)
     && /Restore puts them back, under Operations/.test(t) && !t.includes(`${rows[1].display}: moved`), t);
  ok('grade 4: …the registry is refreshed', requests(p, '/api/registry').length === regs + 1);
  ok('grade 4: …and a failed re-read keeps the rows, marked — never an error screen', p.eval('S.view') === 'memory' && boxes(p).length === 3
     && /Showing Memory as it was before the last change/.test(p.text(p.$('content'))));
  ok('C: an error notice is an alert', p.$('notice-slot').querySelector('.notice.error')?.getAttribute('role') === 'alert');
}
{
  const p = await bootMemory();
  const rows = p.m.rows.slice(0, 2);
  await memoryAccepting(p);
  const held = deferred();
  p.m.holdAccept = held;
  acceptBtn(p).click();
  await settle(5);
  p.eval(`openInEditor(${JSON.stringify(rows[0].openPath)}, ${JSON.stringify(rows[0].display)})`);
  await settle(10);
  ok('(setup) the editor is open on the fact that will move', p.eval('S.view') === 'entry' && p.eval('S.file?.path') === rows[0].openPath);
  held.reject(failedOp(rows));
  await settle(10);
  ok('grade 4: after a partial failure, the editor on a moved fact closes, as on success', p.eval('S.file') === null && p.eval('S.view') === 'home');
}

// ── QA A–C: the bar's modifier, focus, the live region ────────────────────
{
  const p = await boot();
  const CSS = (await import('node:fs')).readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  ok('QA A: the empty bar is .is-empty, never .empty, so the global empty-state rule cannot match it',
     bar(p).classList.contains('is-empty') && !bar(p).classList.contains('empty') && !bar(p).matches('.empty') && !/\.sel-bar\.empty\b/.test(CSS));
  enabled(p)[0].click();
  ok('QA A: …and ticking only drops the modifier', !bar(p).classList.contains('is-empty') && !bar(p).matches('.empty'));
  barBtn(p, 'Clear').click();
  ok('QA B: after Clear (which disables itself), focus is on Select all', p.doc.activeElement === barBtn(p, 'Select all'), p.doc.activeElement?.tagName);
  enabled(p)[0].focus();
  enabled(p)[0].click();
  barBtn(p, 'Delete').focus();
  barBtn(p, 'Delete').click();
  await settle(10);
  ok('QA B: after a keyboard-started delete repaints, focus is on the bar, not BODY', p.doc.activeElement !== p.doc.body && bar(p).contains(p.doc.activeElement), p.doc.activeElement?.tagName);
  const slot = p.$('notice-slot');
  ok('QA C: the notice slot is a polite live region', slot.getAttribute('role') === 'status' && slot.getAttribute('aria-live') === 'polite');
  ok('no page errors', p.errors.length === 0, p.errors.join('; '));
}

for (const p of pages) p.done();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
