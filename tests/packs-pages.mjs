/**
 * The Packs grid and each pack's own page (builds/packs-redesign, C3–C7):
 * `#packs` is a grid of cards that only open pages, `#packs/<id>` is a pack's
 * page with its five sections, `#packs/setup` lists the fixes every pack
 * shares, and the Codex trust check is a preference set on Setup. The page in
 * the fake DOM (tests/fixtures/shell-page.mjs) against stubbed routes built
 * from the real catalog in a temp HOME; packs-ui.mjs runs the same pages
 * against a real server.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, sandbox, tests } from './fixtures/packs-sandbox.mjs';
import { bootPage, routesFor, settle } from './fixtures/shell-page.mjs';
import { loadCatalog, machine } from '../lib/packs.js';
import { catalogView } from '../lib/packs-routes.js';

const { ok, done } = tests();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (x) => JSON.parse(JSON.stringify(x));
const waitFor = async (cond, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (cond()) return true; await sleep(20); } return !!cond(); };

const sb = sandbox('pages', { clis: ['claude', 'codex'] });
const m = machine(sb.env);
const catalog = loadCatalog();
const base = catalogView(m, { installedOf: () => true });
for (const p of base.packs) for (const r of p.requirements) r.ok = true;

// Every pack installed at its version except two: handoff not installed, review gate one version behind.
const installedAll = (view) => {
  const v = clone(view);
  for (const p of v.packs) {
    if (p.id === 'handoff') { p.installed = null; continue; }
    p.installed = { version: p.id === 'review-gate' ? '0.9.0' : p.version,
      parts: Object.fromEntries(p.parts.filter((x) => x.default).map((x) => [x.id, { harnesses: ['claude'], installedAt: null }])) };
  }
  return v;
};

const ONE_LINERS = {
  'review-gate': 'Reviews your branch for bugs, fixes them once, and logs the result.',
  build: 'Plans a change with you, has a builder write it, then grades it.',
  advisor: 'Gets an outside verdict on scope and direction before you commit.',
  'second-opinion': 'Asks other models for their take and shows the replies side by side.',
  pr: 'Writes a pull request anyone can read in a minute.',
  handoff: 'Leaves a resume-here note so the next session picks up cleanly.',
  flag: 'Files a short report when the agent workflow itself goes wrong.',
  worktree: 'Shell commands that give each goal its own tidy worktree.',
};
const SOLO = { handoff: 'Your session agent', flag: 'Your session agent', worktree: 'You run them' };

function stub(view, extra = {}) {
  const state = { view, statusAsks: [], plans: [], applies: [] };
  state.routes = routesFor({
    'GET /api/packs': () => state.view,
    'GET /api/packs/status': (_b, u) => { state.statusAsks.push(u.search); return { job: { running: false, result: { packs: [], legacy: [], checkedAt: Date.now(), trust: u.searchParams.get('trust') === '1' } } }; },
    'GET /api/models/roles': () => ({ roles: [] }),
    'POST /api/packs/plan': (b) => { state.plans.push(b); return { packs: [b.pack], units: [], requirements: [], notes: [], preview: [{ path: '~/x/SKILL.md', symbol: '+', what: 'new file', action: 'create' }],
      warnings: [], kept: [], refusals: [], roles: [], changes: true, signature: 'sig' }; },
    'POST /api/packs/apply': (b) => { state.applies.push(b); return { units: [b.pack], packs: [b.pack], backupDir: null, kept: [], notes: [], warnings: [], log: [] }; },
    ...extra,
  });
  return state;
}

try {
  console.log('\nC3: #packs is a grid of cards');
  {
    const st = stub(installedAll(base));
    const page = await bootPage({ routes: st.routes, hash: '#packs' });
    const c = () => page.$('content');
    const t = (n) => (n ? page.text(n) : '');
    await waitFor(() => c().querySelectorAll('.pk-card').length === 8);
    await settle(10);
    const card = (id) => c().querySelector(`.pk-card[data-pack="${id}"]`);
    ok('#packs shows eight cards, one per pack, in the catalog order', page.eval('S.view') === 'packs'
      && JSON.stringify(c().querySelectorAll('.pk-card').map((k) => k.dataset.pack)) === JSON.stringify(catalog.map((p) => p.id)), c().querySelectorAll('.pk-card').map((k) => k.dataset.pack).join(' '));
    ok('each card: its name and its command', catalog.every((p) => t(card(p.id).querySelector('.pk-card-name')) === p.title && t(card(p.id).querySelector('.pk-card-cmd')) === p.workflow.command),
      catalog.map((p) => `${t(card(p.id).querySelector('.pk-card-name'))} ${t(card(p.id).querySelector('.pk-card-cmd'))}`).join(' | '));
    ok('…and the one-liner from direction.md, not the pack.json summary', catalog.every((p) => t(card(p.id).querySelector('.pk-card-line')) === ONE_LINERS[p.id]),
      catalog.map((p) => t(card(p.id).querySelector('.pk-card-line'))).join(' | '));
    const segs = (id) => card(id).querySelectorAll('.pk-strip-seg').map((s) => ['role', 'agent', 'you', 'script'].find((w) => s.classList.contains(w)));
    ok('a workflow card\'s strip has one segment per step, coloured by who does it, and says "N steps"', catalog.filter((p) => !p.workflow.strip).every((p) => JSON.stringify(segs(p.id)) === JSON.stringify(p.workflow.steps.map((s) => s.who))
      && t(card(p.id).querySelector('.pk-card-steps')).endsWith(`${p.workflow.steps.length} steps`)), catalog.map((p) => `${p.id}:${segs(p.id).join(',')} ${t(card(p.id).querySelector('.pk-card-steps'))}`).join(' | '));
    ok('…the review gate\'s reads role ×5, script, role, script ×2', segs('review-gate').join(',') === 'role,role,role,role,role,script,role,script,script', segs('review-gate').join(','));
    ok('a single-step pack: one segment and who does it', Object.entries(SOLO).every(([id, who]) => segs(id).length === 1 && t(card(id).querySelector('.pk-card-steps')) === who)
      && segs('handoff')[0] === 'agent' && segs('worktree')[0] === 'you', Object.keys(SOLO).map((id) => `${segs(id)} ${t(card(id).querySelector('.pk-card-steps'))}`).join(' | '));
    const status = (id) => t(card(id).querySelector('.pk-st'));
    ok('status: Installed, Not installed and Update ready', status('build') === 'Installed' && status('handoff') === 'Not installed' && status('review-gate') === 'Update ready',
      catalog.map((p) => `${p.id}: ${status(p.id)}`).join(' | '));
    const btns = (id) => card(id).querySelectorAll('button');
    ok('a primary button only on the cards that need one: Install where not installed, Update where an update is ready', btns('handoff').length === 1 && t(btns('handoff')[0]) === 'Install' && btns('handoff')[0].classList.contains('primary')
      && btns('review-gate').length === 1 && t(btns('review-gate')[0]) === 'Update' && btns('review-gate')[0].classList.contains('primary')
      && catalog.filter((p) => !['handoff', 'review-gate'].includes(p.id)).every((p) => btns(p.id).length === 0), catalog.map((p) => `${p.id}: ${btns(p.id).map(t).join(',')}`).join(' | '));
    ok('every card links to its page', catalog.every((p) => card(p.id).querySelector('a.pk-card-link')?.getAttribute('href') === `#packs/${p.id}`));
    ok('no settings, parts or install controls on the grid', !c().querySelector('.pk-settings, .pk-part, .pk-harnesses, .pk-preview, input, select, textarea, .pk-sec'), t(c()).slice(0, 300));
    ok('the legend row, once: four kinds', c().querySelectorAll('.pk-legend').length === 1 && c().querySelectorAll('.pk-legend li').length === 4
      && /a model from your roles/.test(t(c().querySelector('.pk-legend'))) && /a script/.test(t(c().querySelector('.pk-legend'))), t(c().querySelector('.pk-legend')));
    ok('the header: title, lead, the CLI chips and "Checked at … Refresh"', t(c().querySelector('.pk-title')) === 'Skill packs'
      && t(c().querySelector('.pk-lead')) === 'Ready-made workflows for your agents. Open one to see how it runs and change how it behaves.'
      && c().querySelectorAll('.pk-cli').length === base.harnesses.length && /^Checked at .+Refresh$/.test(t(page.$('pk-status'))), `${t(c().querySelector('.pk-head-row'))}`);
    ok('…and Refresh is a quiet button', page.$('pk-status').querySelector('button')?.classList.contains('ghost'));
    ok('no shared-fixes notice when nothing is missing', !c().querySelector('.pk-shared'));
    ok('no older-install notice on the grid', !c().querySelector('.pk-legacy'));
    ok('no page errors', page.errors.length === 0, page.errors.join(' | '));
    page.done();
  }

  console.log('\nC4: routing between the grid and a pack\'s page');
  {
    const st = stub(installedAll(base));
    const page = await bootPage({ routes: st.routes, hash: '#packs' });
    const c = () => page.$('content');
    const t = (n) => (n ? page.text(n) : '');
    await waitFor(() => c().querySelectorAll('.pk-card').length === 8);
    c().querySelector('.pk-card[data-pack="build"]').click();
    await settle(10);
    ok('clicking a card opens #packs/<id>', page.eval('S.view') === 'pack' && page.location.hash === '#packs/build' && t(c().querySelector('.pk-page h1')) === 'Build loop', `${page.eval('S.view')} ${page.location.hash}`);
    ok('…with Packs still marked in the sidebar', page.$('btn-packs').classList.contains('active'));
    ok('…and the topbar still says Skill packs', t(page.$('title')) === 'Skill packs');
    page.navigate(page.location.hash);
    await settle(10);
    ok('the hashchange its own navigation fires changes nothing', page.eval('S.view') === 'pack' && t(c().querySelector('.pk-page h1')) === 'Build loop');
    c().querySelectorAll('button').find((b) => t(b) === 'Skill packs').click();
    await settle(10);
    ok('the back button returns to the grid', page.eval('S.view') === 'packs' && page.location.hash === '#packs' && c().querySelectorAll('.pk-card').length === 8);
    c().querySelector('.pk-card[data-pack="advisor"]').click();
    await settle(10);
    page.$('btn-packs').click();
    await settle(10);
    ok('the sidebar\'s Packs returns to the grid from a pack page', page.eval('S.view') === 'packs' && page.location.hash === '#packs' && c().querySelectorAll('.pk-card').length === 8);
    page.navigate('#packs/flag');
    await settle(10);
    ok('a link to #packs/<id> opens that pack', page.eval('S.view') === 'pack' && t(c().querySelector('.pk-page h1')) === 'Flag');
    page.navigate('#packs/advisor');
    await settle(10);
    ok('…and from one pack page to another', t(c().querySelector('.pk-page h1')) === 'Advisor');
    ok('moving between the grid and pack pages reads the catalog once', st.routes && page.requests.filter((r) => r.path === '/api/packs').length === 1, page.requests.filter((r) => r.path === '/api/packs').length);
    ok('no page errors', page.errors.length === 0, page.errors.join(' | '));
    page.done();

    const cold = await bootPage({ routes: stub(installedAll(base)).routes, hash: '#packs/review-gate' });
    await waitFor(() => cold.$('content').querySelector('.pk-page h1'));
    ok('a reload on #packs/<id> lands on the pack page', cold.eval('S.view') === 'pack' && cold.location.hash === '#packs/review-gate' && cold.text(cold.$('content').querySelector('.pk-page h1')) === 'Review gate'
      && cold.$('btn-packs').classList.contains('active'), cold.location.hash);
    ok('…with no page errors', cold.errors.length === 0, cold.errors.join(' | '));
    cold.done();

    const nope = await bootPage({ routes: stub(installedAll(base)).routes, hash: '#packs/nope' });
    await waitFor(() => /No pack called/.test(nope.text(nope.$('content'))));
    ok('an unknown id: "No pack called nope." and nothing else of a pack', nope.eval('S.view') === 'pack' && /No pack called nope\./.test(nope.text(nope.$('content')))
      && !nope.$('content').querySelector('.pk-card, .pk-sec-block'), nope.text(nope.$('content')).slice(0, 200));
    nope.$('content').querySelectorAll('button').find((b) => nope.text(b) === 'Skill packs').click();
    await settle(10);
    ok('…with a way back to the grid', nope.eval('S.view') === 'packs' && nope.$('content').querySelectorAll('.pk-card').length === 8);
    ok('…and no page errors', nope.errors.length === 0, nope.errors.join(' | '));
    nope.done();
  }

  console.log('\nC3/C5: a card\'s Install opens the pack page with the preview loaded, nothing written');
  {
    const st = stub(installedAll(base));
    const page = await bootPage({ routes: st.routes, hash: '#packs' });
    const c = () => page.$('content');
    await waitFor(() => c().querySelectorAll('.pk-card').length === 8);
    c().querySelector('.pk-card[data-pack="handoff"]').querySelector('button').click();
    await waitFor(() => c().querySelector('.pk-preview .pk-apply'));
    ok('Install on the card opens #packs/handoff with its install preview', page.location.hash === '#packs/handoff' && !!c().querySelector('.pk-page .pk-preview-install')
      && st.plans.length === 1 && st.plans[0].action === 'install' && JSON.stringify(st.plans[0].parts) === '["handoff"]', JSON.stringify(st.plans));
    ok('…and nothing is applied until the preview\'s own button', st.applies.length === 0);
    c().querySelectorAll('.pk-preview button').find((b) => page.text(b) === 'Install').click();
    await waitFor(() => st.applies.length === 1);
    ok('the preview\'s Install applies exactly what was previewed', st.applies.length === 1 && st.applies[0].signature === 'sig' && JSON.stringify({ ...st.applies[0], signature: undefined }) === JSON.stringify({ ...st.plans[0], signature: undefined }));
    const rg = c();
    page.navigate('#packs');
    await settle(10);
    c().querySelector('.pk-card[data-pack="review-gate"]').querySelector('button').click();
    await waitFor(() => st.plans.length === 2);
    ok('Update on the card opens the review gate with its update preview', page.location.hash === '#packs/review-gate' && st.plans[1].action === 'update' && !!rg.querySelector('.pk-preview-update'), JSON.stringify(st.plans[1]));
    ok('no page errors', page.errors.length === 0, page.errors.join(' | '));
    page.done();
  }

  console.log('\nC5: the pack page\'s sections');
  {
    const v = installedAll(base);
    v.legacy = ['~/.claude/review-config.json'];
    const st = stub(v);
    const page = await bootPage({ routes: st.routes, hash: '#packs/review-gate' });
    const c = () => page.$('content');
    const t = (n) => (n ? page.text(n) : '');
    await waitFor(() => c().querySelector('.pk-page h1'));
    await settle(10);
    const heads = () => c().querySelectorAll('.pk-sec-block h2').map(t);
    ok('the review gate: five sections, in order', JSON.stringify(heads()) === '["What it does","How it runs","Settings","Parts","Files and undo"]', JSON.stringify(heads()));
    const jumps = c().querySelectorAll('.pk-jump a');
    ok('…with a jump link to each (anchors, not tabs)', jumps.map(t).join('|') === heads().join('|') && jumps.every((a) => a.getAttribute('role') !== 'tab' && /^#packs\/review-gate$/.test(a.getAttribute('href'))));
    jumps[3].click();
    ok('…and a jump link scrolls to its section, leaving the hash alone', page.doc.scrolledIntoView.at(-1) === c().querySelectorAll('.pk-sec-block')[3] && page.location.hash === '#packs/review-gate');
    ok('the header: the pack.json summary as the lead, the command pill, the status', t(c().querySelector('.pk-page-lead')) === v.packs.find((p) => p.id === 'review-gate').summary
      && t(c().querySelector('.pk-pill')) === '/pr-review' && /Update ready/.test(t(c().querySelector('.pk-page-meta'))), t(c().querySelector('.pk-page-head')));
    const acts = c().querySelector('.pk-page-actions').querySelectorAll('button');
    ok('…Update (primary) and Uninstall… (secondary, danger)', acts.map(t).join('|') === 'Update|Uninstall…' && acts[0].classList.contains('primary')
      && acts[1].classList.contains('danger') && !acts[1].classList.contains('primary') && !acts[1].classList.contains('ghost'), acts.map((b) => `${t(b)}:${b.className}`).join(' | '));
    ok('What it does: three tiles from direction.md', c().querySelectorAll('.pk-does li').map((li) => t(li.querySelector('strong'))).join('|') === 'Finds bugs|Fixes them once|Guards the push');
    ok('Files and undo: the undo command with a quiet Copy, and the older-install notice', /acs packs uninstall review-gate/.test(t(c().querySelector('.pk-undo')))
      && c().querySelector('.pk-undo button')?.classList.contains('ghost') && /Older install found\./.test(t(c().querySelector('.pk-files .pk-legacy'))), t(c().querySelector('.pk-files')));
    ok('no dialog anywhere, and no fold', !page.doc.body.querySelector('.pk-dialog, .pk-scrim') && !c().querySelector('details, summary'));
    page.navigate('#packs/build');
    await settle(10);
    ok('another pack skips Settings: four sections', JSON.stringify(heads()) === '["What it does","How it runs","Parts","Files and undo"]' && c().querySelectorAll('.pk-jump a').length === 4, heads().join(' | '));
    ok('…and no older-install notice outside the review gate', !c().querySelector('.pk-legacy'));
    page.navigate('#packs/handoff');
    await settle(10);
    ok('a pack with less to say gets fewer tiles, not padding', c().querySelectorAll('.pk-does li').length === 2);
    ok('…and a not-installed pack offers Install (primary), no Uninstall', c().querySelector('.pk-page-actions').querySelectorAll('button').map(t).join('|') === 'Install');
    ok('no page errors', page.errors.length === 0, page.errors.join(' | '));
    page.done();
  }

  console.log('\nshared fixes: one notice on the grid, its own page');
  {
    const v = installedAll(base);
    for (const p of v.packs) p.requirements.push({ id: 'git', ok: false, what: 'git is not on PATH', fix: 'install git', dep: null });
    const page = await bootPage({ routes: stub(v).routes, hash: '#packs' });
    const c = () => page.$('content');
    const t = (n) => (n ? page.text(n) : '');
    await waitFor(() => c().querySelectorAll('.pk-card').length === 8);
    const n = c().querySelector('.pk-shared');
    ok('one line above the grid: "1 thing to set up before packs run"', !!n && /^1 thing to set up before packs run/.test(t(n)), t(n));
    const show = n.querySelectorAll('button').find((b) => t(b) === 'Show me');
    ok('…with a secondary Show me', !!show && !show.classList.contains('primary') && !show.classList.contains('ghost'));
    show.click();
    await settle(10);
    ok('Show me opens #packs/setup, listing the fix', page.location.hash === '#packs/setup' && /git/.test(t(c().querySelector('.pk-todo-list'))) && /Fix:/.test(t(c().querySelector('.pk-todo-list'))), t(c()).slice(0, 300));
    page.done();
  }

  console.log('\nC6: the Codex trust check is set on Setup');
  {
    const st = stub(installedAll(base));
    const page = await bootPage({ routes: st.routes, hash: '#packs' });
    await waitFor(() => st.statusAsks.length > 0);
    ok('by default the status check includes the trust check', /trust=1/.test(st.statusAsks[0]), st.statusAsks[0]);
    ok('…and Packs has no trust checkbox of its own', !page.$('content').querySelector('input'));
    page.done();

    const clis = { clis: ['claude', 'codex', 'grok'].map((id) => ({ id, label: id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex' : 'Grok', installed: id !== 'grok', binary: `/bin/${id}`, version: '1.0', signIn: { state: 'verified', label: 'verified' }, fix: {} })) };
    const st2 = stub(installedAll(base), { 'GET /api/setup/clis': () => clis, 'GET /api/setup/status': () => ({ state: 'done' }) });
    const sp = await bootPage({ routes: st2.routes, hash: '#setup' });
    await waitFor(() => sp.$('content').querySelector('[data-cli="codex"]'));
    const box = () => sp.$('content').querySelector('[data-cli="codex"] .setup-trust input');
    ok('Setup: a checkbox under Codex, ticked by default', !!box() && box().checked && !sp.$('content').querySelector('[data-cli="claude"] .setup-trust'), sp.text(sp.$('content').querySelector('[data-cli="codex"]')));
    ok('…with the trust check\'s (i) on its words', sp.text(sp.$('content').querySelector('[data-cli="codex"] .setup-trust .tip .tip-term')) === 'trust check');
    box().click();
    ok('…unticking it saves the preference', sp.store.get('acs.packs.trust') === '0' && !box().checked);
    sp.navigate('#packs');
    await waitFor(() => st2.statusAsks.length > 0);
    ok('…and the next status check leaves the trust check out', /trust=0/.test(st2.statusAsks.at(-1)), st2.statusAsks.join(' '));
    ok('no page errors', sp.errors.length === 0, sp.errors.join(' | '));
    sp.done();

    const kept = await bootPage({ routes: stub(installedAll(base)).routes, hash: '#setup', carry: [['acs.packs.trust', '0']] });
    await waitFor(() => kept.$('content').querySelector('[data-cli="codex"] .setup-trust input') || /Codex/.test(kept.text(kept.$('content'))));
    await settle(20);
    const kb = kept.$('content').querySelector('[data-cli="codex"] .setup-trust input');
    ok('a saved "off" shows unticked after a reload', !kb || !kb.checked);
    kept.done();
  }

  console.log('\nC7: width, type size and labels');
  {
    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const start = css.indexOf('.scope.pk');
    const end = css.indexOf('.mcp-empty');
    const block = css.slice(start, end);
    const rules = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((x) => ({ sel: x[1].trim(), body: x[2] }));
    ok('the packs pages are 1080px wide', rules.some((r) => r.sel.split(',').map((s) => s.trim()).includes('.scope.pk') && /max-width\s*:\s*1080px/.test(r.body)));
    const small = rules.flatMap((r) => [...r.body.matchAll(/font(?:-size)?\s*:\s*[^;]*?(\d+(?:\.\d+)?)px/g)].filter((x) => Number(x[1]) < 12).map((x) => `${r.sel}: ${x[0]}`));
    ok('no packs or diagram rule sets text under 12px', block.length > 1000 && small.length === 0, small.join(' | '));
    const upper = rules.filter((r) => /text-transform\s*:\s*uppercase/.test(r.body)).map((r) => r.sel);
    ok('no uppercase labels in the packs or diagram styles', upper.length === 0, upper.join(' | '));
    ok('no literal colours in them either (theme tokens only)', !/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(block.replace(/url\("data:[^"]*"\)/g, '')), (block.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/i) || [])[0]);
    ok('the spacing and type scales are tokens, outside the colour block', /--s7\s*:\s*48px/.test(css) && /--t-page\s*:\s*26px/.test(css)
      && !/--s7/.test(css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')))));
  }

  console.log('\nCancel while a preview is still loading');
  {
    let release = null;
    const st = stub(installedAll(base));
    const instant = st.routes.table['POST /api/packs/plan'];
    // The first plan waits until the test lets it go; later ones answer at once.
    st.routes.table['POST /api/packs/plan'] = (b) => (release ? instant(b) : new Promise((r) => { release = () => r(instant(b)); }));
    const page = await bootPage({ routes: st.routes, hash: '#packs/handoff' });
    const c = () => page.$('content');
    const t = (n) => (n ? page.text(n) : '');
    await waitFor(() => c().querySelector('.pk-page-actions button'));
    const install = () => c().querySelector('.pk-page-actions').querySelectorAll('button').find((b) => t(b) === 'Install');
    install().click();
    await waitFor(() => !!release && !!c().querySelector('.pk-preview .pk-busy'));
    c().querySelector('.pk-preview').querySelectorAll('button').find((b) => t(b) === 'Cancel').click();
    ok('Cancel during a pending preview closes it and leaves the pack\'s Install enabled', !c().querySelector('.pk-preview') && !!install() && !install().disabled,
      install() ? `disabled=${install().disabled}` : 'no Install');
    release();
    await settle(10);
    ok('…the late answer does not bring the preview back, and Install stays enabled', !c().querySelector('.pk-preview') && !install().disabled);
    install().click();
    ok('…and a later Install previews and can be applied', await waitFor(() => !!c().querySelector('.pk-preview .pk-apply'))
      && !c().querySelector('.pk-preview .pk-apply').disabled && st.plans.length === 2, `${st.plans.length} plans | ${t(c().querySelector('.pk-preview')).slice(0, 200)}`);
    ok('no page errors', page.errors.length === 0, page.errors.join(' | '));
    page.done();
  }
} catch (e) {
  ok(`no test block threw (${e?.message || e})`, false, e?.stack || String(e));
} finally {
  done();
}
