/**
 * The Packs view (builds/skill-packs P3, C13; builds/packs-redesign) in the
 * page: index.html and the real public/ scripts in the test VM
 * (tests/fixtures/shell-page.mjs), every request forwarded to a real
 * `node server.js` in a temp HOME with stub CLIs — so each pack's page renders
 * exactly what the routes say, and its buttons really install into that HOME.
 * Checks the grid and a pack's page, its parts and the install preview's CLI
 * choice, that the button applies exactly the preview on screen and any
 * change drops it, the dependency and role offers, part statuses and the
 * trust check's visible progress (its preference set on Setup), update with
 * replace, uninstall, a stale preview, and the theme. The browser QA run
 * covers how it looks.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { ROOT, sandbox, sha, tests, track } from './fixtures/packs-sandbox.mjs';
import { bootPage } from './fixtures/shell-page.mjs';

const realBefore = snapshotRealHomes();
const { ok, done } = tests();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 20_000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (cond()) return true; await sleep(40); } return !!cond(); };

const sb = sandbox('ui', { clis: ['claude', 'codex'] });
fs.mkdirSync(path.join(sb.home, '.agent-config-studio'), { recursive: true });
fs.writeFileSync(path.join(sb.home, '.agent-config-studio', 'setup.json'), JSON.stringify({ completed: 'done', at: new Date().toISOString() }));
const port = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const server = track(spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: { ...sb.env, PORT: String(port), STUB_HOOKS_DELAY_MS: '1500' }, stdio: ['ignore', 'ignore', 'ignore'],
}));
const base = `http://localhost:${port}`;
for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await sleep(100); }

const proxy = async (method, p, body, u) => {
  const r = await fetch(`${base}${p}${u?.search || ''}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw { status: r.status, body: data };
  return data;
};

const page = await bootPage({ routes: proxy, hash: '#packs' });
const t = (n) => page.text(n);
// A pack's own page, opened through its route when another page is shown: every control lives there now.
const card = (id) => {
  if (page.eval('S.view') !== 'pack' || page.eval('PK.page') !== id) page.navigate(`#packs/${id}`);
  return page.$('content').querySelector(`.pk-page[data-pack="${id}"]`);
};
const button = (root, re) => (root ? root.querySelectorAll('button').find((b) => re.test(t(b))) : null);
const check = (root, re) => (root ? root.querySelectorAll('label').find((l) => re.test(t(l)))?.querySelector('input') : null);
const statusDone = () => /Checked at/.test(t(page.$('pk-status')));
const previewOf = (id) => card(id)?.querySelector('.pk-preview') || null;
const rows = (id) => (previewOf(id)?.querySelectorAll('.pk-row') || []).map((r) => t(r));
const reqs = () => page.requests.filter((r) => r.path.startsWith('/api/packs/'));
const act = (id, re) => button(card(id)?.querySelector('.pk-page-actions'), re);
const part = (id, partId) => card(id)?.querySelector(`.pk-part[data-part="${partId}"]`);
const files = (id) => t(card(id)?.querySelector('#pk-sec-files'));
/** The preview's own apply button (Install / Update / Uninstall), once the plan is in. */
const apply = (id, re) => button(previewOf(id)?.querySelector('.pk-actions'), re);

try {
  console.log('\nthe Packs grid, a pack\'s page, its parts and its Install for');
  {
    ok('#packs opens the view, with a Packs item in the sidebar', await waitFor(() => page.$('content').querySelectorAll('.pk-card').length === 8)
      && page.eval('S.view') === 'packs' && !!page.$('btn-packs')?.closest('.nav-group') && t(page.$('btn-packs')) === 'Packs', t(page.$('content')).slice(0, 300));
    ok('…and the first status check runs by itself and finishes', await waitFor(statusDone), t(page.$('pk-status')));
    const grok = page.$('content').querySelectorAll('.pk-cli').find((n) => /Grok/.test(t(n)));
    ok('the machine line says Grok is not here, and why', !!grok && grok.classList.contains('off') && /not installed, and no ~\/\.grok/.test(grok.getAttribute('title')), grok?.getAttribute('title'));
    const rg = card('review-gate');
    ok('each pack\'s page has its title, its summary and a Files and undo section with what it changes and how to undo it', /Review gate/.test(t(rg.querySelector('h1'))) && t(rg.querySelector('.pk-page-lead')).length > 20
      && /acs packs uninstall review-gate/.test(files('review-gate')) && /Uninstalling removes/.test(files('review-gate')) && rg.querySelectorAll('#pk-sec-files .pk-paths li').length > 2 && !rg.querySelector('details'));
    ok('…one row per part, each with what it does in a line, "Off", and one Add…', rg.querySelectorAll('.pk-part').length === 6
      && rg.querySelectorAll('.pk-part').every((r) => t(r.querySelector('.pk-part-what')).length > 0 && !r.querySelector('details') && t(r.querySelector('.pk-st')) === 'Off'
        && /not installed/.test(r.querySelector('.pk-st').getAttribute('title')) && r.querySelectorAll('button').map(t).join('|') === 'Add…'));
    ok('…the requirements met, not installed: "Ready to install", no tick', t(rg.querySelector('.pk-page-meta .pk-ready')) === 'Ready to install' && !rg.querySelector('.pk-page-meta .pk-ready svg') && !rg.querySelector('.pk-reqs'));
    ok('no request so far wrote anything (only GETs and no apply)', !reqs().some((r) => r.path === '/api/packs/apply' || r.path === '/api/packs/plan'));
    act('review-gate', /^Install$/).click();
    await waitFor(() => previewOf('review-gate')?.querySelector('.pk-preview-head'));
    ok('the page\'s Install previews the default part only', JSON.stringify(reqs().filter((r) => r.path === '/api/packs/plan').at(-1).body) === JSON.stringify({ action: 'install', pack: 'review-gate', parts: ['code-review'] })
      && /review-gate\/code-review/.test(t(previewOf('review-gate').querySelector('.pk-preview-head'))), t(previewOf('review-gate')).slice(0, 300));
    ok('…and its Install for boxes: Claude and Codex, both detected and ticked', check(previewOf('review-gate'), /^Claude Code \(~\/\.claude\)/)?.checked && check(previewOf('review-gate'), /^Codex \(~\/\.codex\)/)?.checked
      && !check(previewOf('review-gate'), /^Codex \(/)?.disabled, previewOf('review-gate').querySelectorAll('label').map(t).join(' | '));
    button(previewOf('review-gate'), /^Cancel$/).click();
    ok('…Cancel closes it, nothing applied', await waitFor(() => !previewOf('review-gate')) && !reqs().some((r) => r.path === '/api/packs/apply'));
  }

  console.log('\npreview, then install exactly that preview');
  {
    act('handoff', /^Install$/).click();
    ok('Install previews every path it will change, with the CLI\'s words', await waitFor(() => rows('handoff').length > 0)
      && rows('handoff').some((r) => /^\+ ~\/\.claude\/skills\/handoff\/SKILL\.md new file/.test(r)) && rows('handoff').some((r) => /~\/\.codex\/skills\/handoff\/SKILL\.md/.test(r)), rows('handoff').join(' | '));
    ok('…and the Install button under it is enabled', !apply('handoff', /^Install$/)?.disabled);
    check(previewOf('handoff'), /^Codex \(/).click();
    ok('unticking Codex drops the old preview at once: its rows and its Install button are gone until the new one lands', rows('handoff').length === 0 && !apply('handoff', /^Install$/)
      && !!previewOf('handoff')?.querySelector('.pk-busy'), t(previewOf('handoff')).slice(0, 300));
    ok('unticking Codex drops that preview and previews again for Claude only', await waitFor(() => rows('handoff').length > 0 && !rows('handoff').some((r) => /\.codex/.test(r)))
      && rows('handoff').some((r) => /~\/\.claude\/skills\/handoff/.test(r)), rows('handoff').join(' | '));
    const sent = reqs().filter((r) => r.path === '/api/packs/plan').at(-1).body;
    ok('…sent as harnesses: claude', JSON.stringify(sent) === JSON.stringify({ action: 'install', pack: 'handoff', parts: ['handoff'], harnesses: ['claude'] }), JSON.stringify(sent));
    apply('handoff', /^Install$/).click();
    ok('Install applies it and shows the result on the page', await waitFor(() => card('handoff')?.querySelector('.pk-result')) && /Installed: handoff\/handoff/.test(t(card('handoff').querySelector('.pk-result'))), t(card('handoff')).slice(0, 400));
    const applied = reqs().filter((r) => r.path === '/api/packs/apply').at(-1).body;
    ok('…the apply carried exactly the previewed request and its signature', JSON.stringify({ ...applied, signature: undefined }) === JSON.stringify({ ...sent, signature: undefined }) && /^[0-9a-f]{64}$/.test(applied.signature));
    ok('…the skill is on disk for Claude, not for Codex', fs.existsSync(path.join(sb.home, '.claude/skills/handoff/SKILL.md')) && !fs.existsSync(path.join(sb.env.CODEX_HOME, 'skills/handoff')));
    ok('…and after the status refresh the page says installed, for Claude Code, with Uninstall…', await waitFor(() => statusDone() && /Installed · 1\.0\.0/.test(t(card('handoff').querySelector('.pk-page-meta'))))
      && /Handoff skill: installed for Claude Code/.test(files('handoff')) && !!act('handoff', /^Uninstall…$/), files('handoff'));
    ok('…and codex shows as a new CLI for it', t(part('handoff', 'handoff').querySelector('.pk-st')) === 'New CLI here'
      && /a new CLI is here, not installed for it/.test(part('handoff', 'handoff').querySelector('.pk-st').getAttribute('title')) && /codex is here now/.test(files('handoff')), t(part('handoff', 'handoff')));
  }

  console.log('\nthe build → review-gate dependency offer');
  {
    act('build', /^Install$/).click();
    await waitFor(() => previewOf('build')?.querySelector('.pk-preview-head'));
    const offer = () => check(previewOf('build'), /Also install the .* pack's skill now/);
    ok('build\'s install preview offers to add review-gate\'s skill, unticked', !!offer() && !offer().checked);
    ok('without it the preview shows the refusal and no usable button', /needs the review-gate pack/.test(t(previewOf('build').querySelector('.pk-refusals'))) && apply('build', /^Install$/).disabled);
    offer().click();
    ok('ticking the offer previews again: it adds review-gate/code-review, with the button enabled', await waitFor(() => /review-gate\/code-review/.test(t(previewOf('build')?.querySelector('.pk-preview-head'))))
      && !previewOf('build').querySelector('.pk-refusals') && !apply('build', /^Install$/).disabled && reqs().filter((r) => r.path === '/api/packs/plan').at(-1).body.withDeps === true, t(previewOf('build')));
    button(previewOf('build'), /^Cancel$/).click();
    ok('Cancel drops it and writes nothing', await waitFor(() => !previewOf('build')) && !fs.existsSync(path.join(sb.home, '.claude/skills/build')));
  }

  console.log('\nthe agent guard: install, and the trust check\'s progress while status runs');
  {
    act('review-gate', /^Install$/).click();
    await waitFor(() => apply('review-gate', /^Install$/) && !apply('review-gate', /^Install$/).disabled);
    apply('review-gate', /^Install$/).click();
    ok('the review gate installs its code-review part from the page', await waitFor(() => card('review-gate')?.querySelector('.pk-result'), 30_000) && /Installed: review-gate\/code-review/.test(t(card('review-gate').querySelector('.pk-result'))));
    await waitFor(statusDone, 30_000);
    button(part('review-gate', 'agent-guard'), /^Add…$/).click();
    await waitFor(() => part('review-gate', 'agent-guard')?.querySelector('.pk-preview .pk-preview-head'));
    const gp = () => part('review-gate', 'agent-guard')?.querySelector('.pk-preview');
    const grows = () => (gp()?.querySelectorAll('.pk-row') || []).map(t);
    ok('the guard\'s Add… previews under its own row: Claude\'s settings and the Codex hooks', grows().some((r) => /~\/\.claude\/settings\.json/.test(r)) && grows().some((r) => /~\/\.codex\/hooks\.json/.test(r)), grows().join(' | '));
    button(gp(), /^Install$/).click();
    ok('…the button reads Installing… while it runs', await waitFor(() => /Installing…/.test(t(card('review-gate'))), 5000));
    const res = () => part('review-gate', 'agent-guard')?.querySelector('.pk-result');
    ok('…and it installs, the result under its row', await waitFor(res, 30_000) && /Installed: review-gate\/agent-guard/.test(t(res())), t(card('review-gate')).slice(0, 600));
    ok('…with the installers\' output shown in place (no button, no fold, no dialog)', !!res()?.querySelector('pre.pk-log') && /Installer output/.test(t(res())) && !res().querySelector('details, button.pk-log-btn')
      && !page.doc.body.querySelector('.pk-dialog'));
    ok('the status refresh after it shows a spinner and the trust check\'s progress line', await waitFor(() => page.$('pk-status')?.querySelector('.spinner') && /checking the agent guard/.test(t(page.$('pk-status'))), 10_000), t(page.$('pk-status')));
    ok('…with the elapsed seconds, and no trust checkbox of its own (Setup holds it)', /\(\d+ s\)/.test(t(page.$('pk-status'))) && !page.$('pk-status').querySelector('input'));
    ok('…and then it finishes: the guard is active for claude and the Codex home', await waitFor(statusDone, 30_000)
      && /Agent guard against skipping hooks: claude: active/.test(files('review-gate')) && /codex ~\/\.codex: active/.test(files('review-gate')), files('review-gate'));
    // The trust check is a preference on Setup, under Codex: turn it off there, then Refresh here.
    page.navigate('#setup');
    await waitFor(() => page.$('content').querySelector('[data-cli="codex"] .setup-trust input'), 30_000);
    page.$('content').querySelector('[data-cli="codex"] .setup-trust input').click();
    card('review-gate');
    await waitFor(() => statusDone());
    button(page.$('pk-status'), /^Refresh$/).click();
    ok('unticked on Setup, Refresh runs without it and says so', await waitFor(() => statusDone() && /Without the Codex trust check/.test(page.$('pk-status').querySelector('.pk-status-text')?.getAttribute('title') || ''), 30_000)
      && /trust not checked/.test(files('review-gate')), files('review-gate'));
  }

  console.log('\nedited by you, and update with replace');
  {
    const skill = path.join(sb.home, '.claude/skills/handoff/SKILL.md');
    fs.appendFileSync(skill, '\nmy note\n');
    card('handoff');
    button(page.$('pk-status'), /^Refresh$/).click();
    ok('my edit shows as "Edited", and Files and undo names the file', await waitFor(() => statusDone() && t(part('handoff', 'handoff')?.querySelector('.pk-st')) === 'Edited', 30_000)
      && /edited by you/.test(part('handoff', 'handoff').querySelector('.pk-st').getAttribute('title')) && /edited: ~\/\.claude\/skills\/handoff\/SKILL\.md/.test(files('handoff')), files('handoff'));
    // The QA state: installed for Claude only, its SKILL.md edited, Codex here. The card and the page offer the same thing, and it does something.
    const primaries = () => card('handoff').querySelector('.pk-page-actions').querySelectorAll('button.primary').map(t);
    const onPage = primaries();
    page.navigate('#packs');
    await waitFor(() => page.$('content').querySelector('.pk-card[data-pack="handoff"]'));
    const gridBtn = () => page.$('content').querySelector('.pk-card[data-pack="handoff"]').querySelectorAll('button.primary');
    const onCard = gridBtn().map(t);
    ok('edited and a new CLI here: the grid card and the page offer the same one action, Install for Codex, and no Update', JSON.stringify(onCard) === '["Install for Codex"]' && JSON.stringify(onPage) === JSON.stringify(onCard)
      && !act('handoff', /^Update$/), `card: ${onCard.join('|')} / page: ${onPage.join('|')}`);
    page.navigate('#packs');
    await waitFor(() => gridBtn().length === 1);
    gridBtn()[0].click();
    ok('…the card\'s Install for Codex opens the page with a preview that installs for Codex only, its Install enabled', await waitFor(() => !!apply('handoff', /^Install$/))
      && !apply('handoff', /^Install$/).disabled && rows('handoff').some((r) => /~\/\.codex\/skills\/handoff\/SKILL\.md/.test(r)) && !rows('handoff').some((r) => /~\/\.claude\/skills/.test(r)), rows('handoff').join(' | '));
    button(previewOf('handoff'), /^Cancel$/).click();
    await waitFor(() => !previewOf('handoff'));
    const shown = primaries();
    const usable = [];
    for (const label of shown) {
      button(card('handoff').querySelector('.pk-page-actions'), new RegExp(`^${label}$`)).click();
      usable.push(await waitFor(() => { const b = previewOf('handoff')?.querySelector('.pk-actions .pk-apply'); return !!b && !b.disabled; }));
      button(previewOf('handoff'), /^Cancel$/).click();
      await waitFor(() => !previewOf('handoff'));
    }
    ok('…every primary action on the page previews something it can apply', shown.length > 0 && usable.every(Boolean), `${shown.join('|')}: ${usable.join('|')}`);
    ok('the edited part\'s row offers Restore… (the pack\'s copy back) beside Remove…', part('handoff', 'handoff').querySelectorAll('button').map(t).join('|') === 'Restore…|Remove…',
      part('handoff', 'handoff').querySelectorAll('button').map(t).join('|'));
    button(part('handoff', 'handoff'), /^Remove…$/).click();
    const rp = () => part('handoff', 'handoff')?.querySelector('.pk-preview');
    await waitFor(() => rp()?.querySelector('.pk-preview-head'));
    const mentions = (t(rp()).match(/~\/\.claude\/skills\/handoff\/SKILL\.md/g) || []).length;
    ok('Remove… says the kept file once, and its button says Remove, not Uninstall', mentions === 1 && !!button(rp().querySelector('.pk-actions'), /^Remove$/) && !button(rp(), /^Uninstall$/),
      `${mentions} mentions | ${rp().querySelectorAll('button').map(t).join('|')}`);
    button(rp(), /^Cancel$/).click();
    await waitFor(() => !rp());
    button(part('handoff', 'handoff'), /^Restore…$/).click();
    const taken = () => check(previewOf('handoff'), /Take the pack's copy/);
    ok('Restore… previews the update with the pack\'s copy taken: the edit is backed up, then replaced, and Restore is enabled', await waitFor(() => rows('handoff').some((r) => /your edit is backed up, then replaced/.test(r)))
      && !!taken()?.checked && !apply('handoff', /^Restore$/).disabled && reqs().filter((r) => r.path === '/api/packs/plan').at(-1).body.replace === true, rows('handoff').join(' | '));
    taken().click();
    ok('unticking it re-previews keeping the edit, says so, and leaves nothing to apply', await waitFor(() => /kept: ~\/\.claude\/skills\/handoff\/SKILL\.md — you edited it/.test(t(previewOf('handoff'))))
      && !taken().checked && apply('handoff', /^Restore$/).disabled, t(previewOf('handoff')).slice(0, 400));
    taken().click();
    ok('ticking it again re-previews: the edit is backed up, then replaced', await waitFor(() => rows('handoff').some((r) => /your edit is backed up, then replaced/.test(r))) && !apply('handoff', /^Restore$/).disabled, rows('handoff').join(' | '));
    apply('handoff', /^Restore$/).click();
    ok('Restore applies it: the pack\'s copy is back, with a backup folder named', await waitFor(() => card('handoff')?.querySelector('.pk-result'))
      && !/my note/.test(sb.read(skill)) && /Backups of every existing file it changed: ~\/\.agent-config-studio\/backups\//.test(t(card('handoff').querySelector('.pk-result'))), t(card('handoff').querySelector('.pk-result')));
  }

  console.log('\na missing skill file: Update puts it back');
  {
    const skill = path.join(sb.home, '.claude/skills/handoff/SKILL.md');
    await waitFor(statusDone, 30_000);
    fs.rmSync(skill);
    card('handoff');
    button(page.$('pk-status'), /^Refresh$/).click();
    ok('a removed SKILL.md shows the part as not working, and the page offers Update', await waitFor(() => statusDone() && t(part('handoff', 'handoff')?.querySelector('.pk-st')) === 'Not working', 30_000)
      && !!act('handoff', /^Update$/), t(part('handoff', 'handoff')));
    act('handoff', /^Update$/).click();
    ok('…its preview starts with the pack\'s copy taken: it puts the file back, with Update enabled', await waitFor(() => rows('handoff').some((r) => /~\/\.claude\/skills\/handoff\/SKILL\.md/.test(r)) && !!apply('handoff', /^Update$/))
      && !apply('handoff', /^Update$/).disabled && !!check(previewOf('handoff'), /Take the pack's copy/)?.checked && reqs().filter((r) => r.path === '/api/packs/plan').at(-1).body.replace === true, rows('handoff').join(' | '));
    apply('handoff', /^Update$/).click();
    ok('…and Update puts it back on disk', await waitFor(() => card('handoff')?.querySelector('.pk-result'), 30_000) && fs.existsSync(skill), t(card('handoff').querySelector('.pk-result')));
  }

  console.log('\na stale preview, and uninstall');
  {
    await waitFor(statusDone, 30_000);
    act('handoff', /^Uninstall…$/).click();
    await waitFor(() => rows('handoff').length > 0);
    ok('the uninstall preview names the skill file it removes', rows('handoff').some((r) => /^- ~\/\.claude\/skills\/handoff\/SKILL\.md removed/.test(r)), rows('handoff').join(' | '));
    fs.appendFileSync(path.join(sb.home, '.claude/skills/handoff/SKILL.md'), '\nedited after the preview\n');
    apply('handoff', /^Uninstall$/).click();
    ok('a file changed after the preview: the page says to preview again, and drops the preview\'s list and its Uninstall', await waitFor(() => card('handoff')?.querySelector('.pk-error'))
      && /different from the preview/.test(t(card('handoff').querySelector('.pk-error'))) && rows('handoff').length === 0 && !apply('handoff', /^Uninstall$/) && !!button(previewOf('handoff'), /^Preview again$/), t(card('handoff')).slice(0, 500));
    ok('…and nothing was removed', fs.existsSync(path.join(sb.home, '.claude/skills/handoff/SKILL.md')));
    button(previewOf('handoff'), /^Preview again$/).click();
    await waitFor(() => apply('handoff', /^Uninstall$/) && !apply('handoff', /^Uninstall$/).disabled);
    apply('handoff', /^Uninstall$/).click();
    ok('previewed again, Uninstall removes it and reports what it kept', await waitFor(() => card('handoff')?.querySelector('.pk-result'))
      && /kept: ~\/\.claude\/skills\/handoff\/SKILL\.md/.test(t(card('handoff').querySelector('.pk-result'))), t(card('handoff').querySelector('.pk-result')));
    await waitFor(statusDone, 30_000);
    button(part('review-gate', 'agent-guard'), /^Remove…$/).click();
    await waitFor(() => part('review-gate', 'agent-guard')?.querySelector('.pk-preview-head'));
    ok('a part\'s Remove… previews only that part, under its row', /^Uninstall: review-gate — review-gate\/agent-guard/.test(t(part('review-gate', 'agent-guard').querySelector('.pk-preview-head'))), t(part('review-gate', 'agent-guard').querySelector('.pk-preview-head')));
    act('review-gate', /^Uninstall…$/).click();
    await waitFor(() => /review-gate\/code-review/.test(t(card('review-gate').querySelector(':scope > .pk-preview .pk-preview-head') || card('review-gate').querySelector('.pk-page > .pk-preview .pk-preview-head') || previewOf('review-gate')?.querySelector('.pk-preview-head'))));
    ok('…and the pack\'s Uninstall… moves the preview up under the page\'s own button', !part('review-gate', 'agent-guard').querySelector('.pk-preview') && /review-gate\/code-review/.test(t(previewOf('review-gate')?.querySelector('.pk-preview-head'))));
    apply('review-gate', /^Uninstall$/).click();
    ok('the pack\'s Uninstall takes the rest out', await waitFor(() => card('review-gate')?.querySelector('.pk-result'), 30_000)
      && !fs.existsSync(path.join(sb.home, '.claude/skills/code-review')) && !fs.existsSync(path.join(sb.home, '.agent-config-studio/review-gate')), t(card('review-gate')).slice(0, 400));
    ok('…and the page goes back to not installed', await waitFor(() => /Not installed/.test(t(card('review-gate').querySelector('.pk-page-meta')))));
  }

  console.log('\nupdate puts back an instructions block I removed');
  {
    const claudeMd = path.join(sb.home, '.claude/CLAUDE.md');
    const begin = '<!-- acs-pack:review-gate/instructions begin -->', end = '<!-- acs-pack:review-gate/instructions end -->\n';
    const shipped = fs.readFileSync(path.join(ROOT, 'packs/review-gate/instructions/review-gate.md'), 'utf8');
    await waitFor(statusDone, 30_000);
    button(part('review-gate', 'instructions'), /^Add…$/).click();
    await waitFor(() => part('review-gate', 'instructions')?.querySelector('.pk-preview-head'));
    const ip = () => part('review-gate', 'instructions')?.querySelector('.pk-preview');
    check(ip(), /^Codex \(/).click();
    await waitFor(() => ip()?.querySelector('.pk-preview-head') && !(ip().querySelectorAll('.pk-row').map(t).some((r) => /\.codex/.test(r))) && !button(ip(), /^Install$/)?.disabled);
    ok('the instructions part previews for Claude alone from its own row', JSON.stringify(reqs().filter((r) => r.path === '/api/packs/plan').at(-1).body) === JSON.stringify({ action: 'install', pack: 'review-gate', parts: ['instructions'], harnesses: ['claude'] }),
      JSON.stringify(reqs().filter((r) => r.path === '/api/packs/plan').at(-1).body));
    button(ip(), /^Install$/).click();
    const ires = () => part('review-gate', 'instructions')?.querySelector('.pk-result');
    ok('the instructions part installs for Claude through the page', await waitFor(ires, 30_000)
      && /Installed: review-gate\/instructions/.test(t(ires())) && sb.read(claudeMd)?.includes(begin), t(card('review-gate')).slice(0, 600));
    await waitFor(statusDone, 30_000);
    // A newer pack: the record says an earlier block went in (what an older version shipped), and then I deleted the block.
    const statePath = path.join(sb.home, '.agent-config-studio/packs/state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const recs = Object.values(state.packs['review-gate'].parts.instructions.files);
    for (const rec of recs) rec.body = `sha256:${sha('the block an older version shipped\n')}`;
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const text = sb.read(claudeMd);
    fs.writeFileSync(claudeMd, text.slice(0, text.indexOf(begin)) + text.slice(text.indexOf(end) + end.length));
    ok('…recorded for CLAUDE.md only, and the block is now gone from it', recs.length === 1 && !sb.read(claudeMd).includes(begin), JSON.stringify(Object.keys(state.packs['review-gate'].parts.instructions.files)));
    button(page.$('pk-status'), /^Refresh$/).click();
    ok('after a Refresh the page offers Update for it', await waitFor(() => statusDone() && !!act('review-gate', /^Update$/), 30_000), t(part('review-gate', 'instructions')));
    act('review-gate', /^Update$/).click();
    await waitFor(() => previewOf('review-gate')?.querySelector('.pk-preview-head'));
    const offer = () => check(previewOf('review-gate'), /Take the pack's copy/);
    ok('the update preview keeps it, saying the block is gone, and offers the pack\'s copy', (previewOf('review-gate')?.querySelectorAll('.pk-kept li') || []).map(t).join(' | ') === 'kept: ~/.claude/CLAUDE.md — the block is gone from the file'
      && !!offer() && !offer().checked && apply('review-gate', /^Update$/).disabled, t(previewOf('review-gate')).slice(0, 600));
    offer().click();
    ok('ticking it re-previews: CLAUDE.md gets the block, and Update is enabled', await waitFor(() => offer()?.checked && rows('review-gate').some((r) => /~\/\.claude\/CLAUDE\.md/.test(r)))
      && !previewOf('review-gate').querySelector('.pk-kept') && !apply('review-gate', /^Update$/).disabled, t(previewOf('review-gate')).slice(0, 600));
    const sent = reqs().filter((r) => r.path === '/api/packs/plan').at(-1).body;
    ok('…sent as replace: true', JSON.stringify(sent) === JSON.stringify({ action: 'update', pack: 'review-gate', replace: true }), JSON.stringify(sent));
    apply('review-gate', /^Update$/).click();
    ok('Update puts the pack\'s block back in CLAUDE.md', await waitFor(() => card('review-gate')?.querySelector('.pk-result'), 30_000)
      && /Updated: review-gate\/instructions/.test(t(card('review-gate').querySelector('.pk-result'))) && sb.read(claudeMd).includes(`${begin}\n${shipped}`), t(card('review-gate')).slice(0, 600));
    // Installed for Claude only, with Codex here: "New CLI here" is the honest word; never broken or an update waiting.
    ok('…and the status after it says it is in, not broken and no update waiting', await waitFor(() => statusDone() && /^(On|New CLI here)$/.test(t(part('review-gate', 'instructions')?.querySelector('.pk-st'))), 30_000)
      && !/not working|update available|block is gone/.test(part('review-gate', 'instructions').querySelector('.pk-st').getAttribute('title')), t(part('review-gate', 'instructions')));
  }

  console.log('\nlight and dark');
  {
    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
    const block = css.slice(css.indexOf('/* ── packs view'));
    ok('the packs styles use only the theme tokens (no literal colours)', block.length > 200 && !/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(block), (block.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/i) || [])[0]);
    page.navigate('#packs');
    await waitFor(() => page.$('content').querySelectorAll('.pk-card').length === 8);
    page.$('btn-theme').click();
    ok('the theme toggle switches with Packs open, and the grid still renders', page.doc.documentElement.dataset.theme === 'light' && page.$('content').querySelectorAll('.pk-card').length === 8);
    card('review-gate');
    ok('…and so does a pack\'s page', page.doc.documentElement.dataset.theme === 'light' && !!page.$('content').querySelector('.pk-page #pk-sec-files'));
  }
  ok('no page errors', page.errors.length === 0, page.errors.join(' | '));

  console.log('\na Claude-only machine: Codex disabled with why, and the role fix-up offer');
  {
    const c1 = sandbox('ui-claude', { clis: ['claude'] });
    fs.mkdirSync(path.join(c1.home, '.agent-config-studio'), { recursive: true });
    fs.writeFileSync(path.join(c1.home, '.agent-config-studio', 'setup.json'), JSON.stringify({ completed: 'done', at: new Date().toISOString() }));
    const port1 = await new Promise((resolve) => { const s1 = net.createServer(); s1.listen(0, '127.0.0.1', () => { const p1 = s1.address().port; s1.close(() => resolve(p1)); }); });
    track(spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...c1.env, PORT: String(port1) }, stdio: ['ignore', 'ignore', 'ignore'] }));
    const base1 = `http://localhost:${port1}`;
    for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base1}/api/health`)).ok) break; } catch {} await sleep(100); }
    const proxy1 = async (method, p, body, u) => {
      const r = await fetch(`${base1}${p}${u?.search || ''}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
      const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
      if (!r.ok) throw { status: r.status, body: data };
      return data;
    };
    const p1 = await bootPage({ routes: proxy1, hash: '#packs/review-gate' });
    const card1 = () => p1.$('content').querySelector('.pk-page[data-pack="review-gate"]');
    await waitFor(() => card1());
    card1().querySelector('.pk-page-actions').querySelectorAll('button').find((b) => p1.text(b) === 'Install').click();
    const pv = () => card1().querySelector('.pk-preview');
    await waitFor(() => pv()?.querySelector('.pk-preview-head'));
    const codexBox = pv().querySelectorAll('label').find((l) => /^Codex \(/.test(p1.text(l)));
    ok('in the install preview, Codex\'s box is there, disabled and unticked, with why beside it', codexBox && codexBox.querySelector('input').disabled && !codexBox.querySelector('input').checked
      && /Codex: not installed, and no ~\/\.codex/.test(p1.text(pv().querySelector('.pk-harnesses'))), p1.text(pv().querySelector('.pk-harnesses')));
    const offer = () => pv()?.querySelector('select.pk-role-pick');
    ok('the preview says the reviewer role is not set and offers the installed families, blank until one is chosen, none put forward',
      /The reviewer role is not set: skills that use it stop until you choose its model/.test(p1.text(pv())) && offer() && offer().value === ''
        && JSON.stringify(offer().querySelectorAll('option').map((o) => o.value)) === '["","fable","opus","sonnet","haiku"]' && !/suggest/i.test(p1.text(pv())), p1.text(pv()).slice(0, 600));
    offer().value = 'opus';
    offer().dispatchEvent({ type: 'change', bubbles: false });
    ok('choosing one re-previews with the role change in the list, chosen', await waitFor(() => offer()?.value === 'opus' && /~\/\.agent-config-studio\/roles\.json/.test(p1.text(pv())))
      && /reviewer role →/.test(p1.text(pv())) && !/warning: the reviewer role/.test(p1.text(pv())), p1.text(pv()).slice(0, 800));
    const sent = p1.requests.filter((r) => r.path === '/api/packs/plan').at(-1).body;
    ok('…sent as setRoles with the family chosen', JSON.stringify(sent.setRoles?.reviewer) === '["opus"]', JSON.stringify(sent));
    ok('…and nothing was written', !fs.existsSync(path.join(c1.home, '.agent-config-studio', 'roles.json')) && !fs.existsSync(path.join(c1.home, '.claude', 'skills', 'code-review')));
    ok('no page errors there either', p1.errors.length === 0, p1.errors.join(' | '));
    p1.done();
  }

  console.log('\nthe browser QA launcher (tests/skill-packs-qa-server.mjs) advertises only its own sandbox server');
  {
    // Run in a sandbox of its own: its temp dirs land in qa.root, so what it leaves is visible.
    const qa = sandbox('ui-qa', { clis: [], modelId: false, dirs: [] });
    const launch = (extra = {}) => {
      const out = { text: '', code: undefined, signal: undefined };
      const child = track(spawn(process.execPath, [path.join(ROOT, 'tests', 'skill-packs-qa-server.mjs')], { cwd: ROOT, env: { ...qa.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }));
      child.stdout.on('data', (d) => { out.text += d; });
      child.stderr.on('data', (d) => { out.text += d; });
      child.on('exit', (code, signal) => { out.code = code; out.signal = signal; });
      return { child, out };
    };
    const left = () => fs.readdirSync(qa.root).filter((n) => n.startsWith('acs-packs-qa-'));
    const advertised = (text) => /\burl\s+http:/.test(text) || /\bHOME\s+\//.test(text);

    // Another studio already on PORT: its /api/health answers, but with its own pid and nonce.
    let asked = 0;
    const other = http.createServer((req, res) => {
      asked++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ app: 'agent-config-studio', pid: process.pid, nonce: 'f'.repeat(32) }));
    });
    await new Promise((r) => other.listen(0, '127.0.0.1', r));
    const a = launch({ PORT: String(other.address().port) });
    await waitFor(() => a.out.code !== undefined, 60_000);
    ok('PORT held by another studio: the launcher exits non-zero', a.out.code !== undefined && a.out.code !== 0, a.out.text.slice(-800));
    ok('…without printing a url or a HOME, though that studio answered its health check', !advertised(a.out.text) && asked > 0, `${asked} health requests; ${a.out.text.slice(-800)}`);
    ok('…saying its own server exited before it was ready', /exited \(\d+\) before it was ready/.test(a.out.text), a.out.text.slice(-800));
    ok('…and its sandbox is removed', left().length === 0, left().join(' '));
    await new Promise((r) => other.close(r));

    // Something on PORT that is not an HTTP server: the launcher's own server dies at listen, and
    // the launcher sees it at once instead of polling on and printing a URL.
    const squatter = net.createServer((sock) => sock.destroy());
    await new Promise((r) => squatter.listen(0, '127.0.0.1', r));
    const t0 = Date.now();
    const b = launch({ PORT: String(squatter.address().port) });
    await waitFor(() => b.out.code !== undefined, 60_000);
    ok('its server dying before it is ready: non-zero, no url, and it says so', b.out.code !== undefined && b.out.code !== 0 && !advertised(b.out.text) && /before it was ready/.test(b.out.text), b.out.text.slice(-800));
    ok('…as soon as it dies, not after the 30 s wait for readiness', Date.now() - t0 < 25_000, `${Date.now() - t0} ms`);
    ok('…and its sandbox is removed', left().length === 0, left().join(' '));
    await new Promise((r) => squatter.close(r));

    // A free port: it prints the URL and HOME of the server it started, and Ctrl-C removes it all.
    const c = launch();
    await waitFor(() => /\burl\s+http:\/\/localhost:\d+\/#packs/.test(c.out.text) || c.out.code !== undefined, 60_000);
    const url = c.out.text.match(/\burl\s+(http:\/\/localhost:(\d+))\/#packs/);
    const home = c.out.text.match(/\bHOME\s+(\/\S+)/)?.[1];
    let health = null, run = null;
    try { health = await (await fetch(`${url[1]}/api/health`)).json(); } catch {}
    try { run = JSON.parse(fs.readFileSync(path.join(home, '.agent-config-studio', 'run', `${url[2]}.json`), 'utf8')); } catch {}
    ok('a free port: it prints the url and the temp HOME', !!url && !!home && home.startsWith(`${qa.root}${path.sep}acs-packs-qa-`), c.out.text.slice(-800));
    ok('…and the url is the studio it started in that HOME (its run file has the same pid and nonce)', !!health && !!run && health.pid === run.pid && health.nonce === run.nonce, JSON.stringify({ health, run: run && { pid: run.pid, nonce: run.nonce } }));
    c.child.kill('SIGINT');
    ok('Ctrl-C stops it and removes the sandbox', await waitFor(() => c.out.code !== undefined || c.out.signal, 20_000) && left().length === 0, left().join(' '));
    let still = true;
    try { await fetch(`${url[1]}/api/health`, { signal: AbortSignal.timeout(1000) }); } catch { still = false; }
    ok('…and its server is gone', !still);
  }
} finally {
  page.done();
  server.kill('SIGKILL');
  await sleep(200);
  sb.cleanup();
}
assertRealHomesUnchanged(realBefore, ok);
done();
