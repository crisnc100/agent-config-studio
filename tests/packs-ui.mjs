/**
 * The Packs view (builds/skill-packs P3, C13) in the page: index.html and the
 * real public/ scripts in the test VM (tests/fixtures/shell-page.mjs), every
 * request forwarded to a real `node server.js` in a temp HOME with stub CLIs
 * — so the card renders exactly what the routes say, and its buttons really
 * install into that HOME. Checks the cards and explanations, toggles and
 * harnesses, that the button applies exactly the preview on screen and any
 * change drops it, the dependency and role offers, status badges and the
 * trust check's visible progress, update with replace, uninstall, a stale
 * preview, and the theme. The browser QA run covers how it looks.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { ROOT, sandbox, tests, track } from './fixtures/packs-sandbox.mjs';
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
const card = (id) => page.$('content').querySelector(`[data-pack="${id}"]`);
const button = (root, re) => (root ? root.querySelectorAll('button').find((b) => re.test(t(b))) : null);
const check = (root, re) => (root ? root.querySelectorAll('label').find((l) => re.test(t(l)))?.querySelector('input') : null);
const statusDone = () => /Status checked at/.test(t(page.$('pk-status')));
const previewOf = (id) => card(id)?.querySelector('.pk-preview') || null;
const rows = (id) => (previewOf(id)?.querySelectorAll('.pk-row') || []).map((r) => t(r));
const reqs = () => page.requests.filter((r) => r.path.startsWith('/api/packs/'));

try {
  console.log('\nthe Packs view: cards, explanations, toggles and harnesses');
  {
    ok('#packs opens the view, with a Packs item in the sidebar under Configure', await waitFor(() => page.$('content').querySelectorAll('.pk-card').length === 6)
      && page.eval('S.view') === 'packs' && !!page.$('btn-packs')?.closest('.nav-group') && t(page.$('btn-packs')) === 'Packs', t(page.$('content')).slice(0, 300));
    ok('…and the first status check runs by itself and finishes', await waitFor(statusDone), t(page.$('pk-status')));
    const rg = card('review-gate');
    ok('each card has its title, summary and an expandable explain', /Review gate|review/i.test(t(rg.querySelector('h3'))) && t(rg.querySelector('.pk-summary')).length > 20
      && /What it is:/.test(t(rg.querySelector('.pk-explain'))) && /How to undo it:/.test(t(rg.querySelector('.pk-explain'))) && rg.querySelector('.pk-explain').localName === 'details');
    ok('…one row per part, each with its own explain and a not-installed badge', rg.querySelectorAll('.pk-part').length === 6
      && rg.querySelectorAll('.pk-part').every((r) => r.querySelector('details.pk-explain') && /not installed/.test(t(r.querySelector('.pk-badges')))));
    ok('…the default part ticked, the opt-in parts not', check(rg, /^Code-review skill/i)?.checked && !check(rg, /Agent guard/i)?.checked && !check(rg, /push gate/i)?.checked, rg.querySelectorAll('label').map(t).join(' | '));
    ok('…the requirements, met', rg.querySelectorAll('.pk-reqs li.ok').length >= 4 && !rg.querySelector('.pk-reqs li.missing'));
    ok('…and harness boxes for Claude and Codex, both detected and ticked', check(rg, /^Claude Code \(~\/\.claude\)/)?.checked && check(rg, /^Codex \(~\/\.codex\)/)?.checked && !check(rg, /^Codex \(/)?.disabled, rg.querySelectorAll('label').map(t).join(' | '));
    ok('the machine line says Grok is not here, and why', /Grok/.test(t(page.$('content').querySelector('.pk-here'))) && /no grok CLI on PATH and no ~\/\.grok/.test(t(page.$('content').querySelector('.pk-here'))));
    ok('no request so far wrote anything (only GETs and no apply)', !reqs().some((r) => r.path === '/api/packs/apply' || r.path === '/api/packs/plan'));
  }

  console.log('\npreview, then install exactly that preview');
  {
    button(card('handoff'), /^Preview install/).click();
    ok('Preview install shows every path it will change, with the CLI\'s words', await waitFor(() => rows('handoff').length > 0)
      && rows('handoff').some((r) => /^\+ ~\/\.claude\/skills\/handoff\/SKILL\.md new file/.test(r)) && rows('handoff').some((r) => /~\/\.codex\/skills\/handoff\/SKILL\.md/.test(r)), rows('handoff').join(' | '));
    ok('…and the Install button under it is enabled', !button(previewOf('handoff'), /^Install$/)?.disabled);
    check(card('handoff'), /^Codex \(/).click();
    ok('unticking Codex drops the preview and its button', await waitFor(() => !previewOf('handoff')) && !button(card('handoff'), /^Install$/));
    button(card('handoff'), /^Preview install/).click();
    await waitFor(() => rows('handoff').length > 0);
    ok('…and the next preview is Claude only', rows('handoff').some((r) => /~\/\.claude\/skills\/handoff/.test(r)) && !rows('handoff').some((r) => /\.codex/.test(r)), rows('handoff').join(' | '));
    const sent = reqs().filter((r) => r.path === '/api/packs/plan').at(-1).body;
    ok('…sent as harnesses: claude', JSON.stringify(sent) === JSON.stringify({ action: 'install', pack: 'handoff', parts: ['handoff'], harnesses: ['claude'] }), JSON.stringify(sent));
    button(previewOf('handoff'), /^Install$/).click();
    ok('Install applies it and shows the result', await waitFor(() => card('handoff')?.querySelector('.pk-result')) && /Installed: handoff\/handoff/.test(t(card('handoff').querySelector('.pk-result'))), t(card('handoff')));
    const applied = reqs().filter((r) => r.path === '/api/packs/apply').at(-1).body;
    ok('…the apply carried exactly the previewed request and its signature', JSON.stringify({ ...applied, signature: undefined }) === JSON.stringify({ ...sent, signature: undefined }) && /^[0-9a-f]{64}$/.test(applied.signature));
    ok('…the skill is on disk for Claude, not for Codex', fs.existsSync(path.join(sb.home, '.claude/skills/handoff/SKILL.md')) && !fs.existsSync(path.join(sb.env.CODEX_HOME, 'skills/handoff')));
    ok('…and after the status refresh the card says installed, for claude, with Update and Uninstall', await waitFor(() => statusDone() && /installed 1\.0\.0/.test(t(card('handoff').querySelector('.pk-head'))))
      && /for claude$/.test(t(card('handoff').querySelector('.pk-badges'))) && !!button(card('handoff'), /^Preview update/) && !!button(card('handoff'), /^Preview uninstall/), t(card('handoff').querySelector('.pk-part')));
    ok('…and codex shows as a new harness for it', /new harness detected/.test(t(card('handoff').querySelector('.pk-badges'))) && /codex is here now/.test(t(card('handoff').querySelector('.pk-details'))), t(card('handoff').querySelector('.pk-part')));
  }

  console.log('\nthe build → review-gate dependency offer');
  {
    const offer = () => check(card('build'), /Also install the .* pack's skill now/);
    ok('build offers to add review-gate\'s skill', !!offer() && !offer().checked);
    button(card('build'), /^Preview install/).click();
    await waitFor(() => previewOf('build'));
    ok('without it the preview shows the refusal and no usable button', /needs the review-gate pack/.test(t(previewOf('build').querySelector('.pk-refusals'))) && button(previewOf('build'), /^Install$/).disabled);
    offer().click();
    ok('ticking the offer drops that preview', await waitFor(() => !previewOf('build')));
    button(card('build'), /^Preview install/).click();
    await waitFor(() => previewOf('build'));
    ok('…and the next one adds review-gate/code-review, with the button enabled', /review-gate\/code-review/.test(t(previewOf('build').querySelector('.pk-preview-head'))) && !previewOf('build').querySelector('.pk-refusals') && !button(previewOf('build'), /^Install$/).disabled, t(previewOf('build')));
    button(previewOf('build'), /^Cancel$/).click();
    ok('Cancel drops it and writes nothing', await waitFor(() => !previewOf('build')) && !fs.existsSync(path.join(sb.home, '.claude/skills/build')));
  }

  console.log('\nthe agent guard: install, and the trust check\'s progress while status runs');
  {
    check(card('review-gate'), /Agent guard/i).click();
    await waitFor(() => !!button(card('review-gate'), /^Preview install \(2 parts\)/));
    button(card('review-gate'), /^Preview install/).click();
    await waitFor(() => previewOf('review-gate'));
    ok('the guard preview names Claude\'s settings and the Codex hooks', rows('review-gate').some((r) => /~\/\.claude\/settings\.json/.test(r)) && rows('review-gate').some((r) => /~\/\.codex\/hooks\.json/.test(r)), rows('review-gate').join(' | '));
    button(previewOf('review-gate'), /^Install$/).click();
    ok('…the button reads Installing… while it runs', await waitFor(() => /Installing…/.test(t(card('review-gate'))), 5000));
    ok('…and it installs', await waitFor(() => card('review-gate')?.querySelector('.pk-result'), 30_000) && /Installed: review-gate\/code-review, review-gate\/agent-guard/.test(t(card('review-gate').querySelector('.pk-result'))), t(card('review-gate')).slice(0, 600));
    ok('…with the installers\' output behind a disclosure', /Installer output/.test(t(card('review-gate').querySelector('.pk-result .pk-log summary'))));
    ok('the status refresh after it shows a spinner and the trust check\'s progress line', await waitFor(() => page.$('pk-status')?.querySelector('.spinner') && /checking the agent guard/.test(t(page.$('pk-status'))), 10_000), t(page.$('pk-status')));
    ok('…with the elapsed seconds, and the trust box locked while it runs', /\(\d+ s\)/.test(t(page.$('pk-status'))) && page.$('pk-status').querySelector('input').disabled);
    ok('…and then it finishes: the guard is active for claude and the Codex home', await waitFor(statusDone, 30_000)
      && /claude: active/.test(t(card('review-gate').querySelector('[data-part="agent-guard"]'))) && /codex ~\/\.codex: active/.test(t(card('review-gate').querySelector('[data-part="agent-guard"]'))), t(card('review-gate').querySelector('[data-part="agent-guard"]')));
    const box = check(page.$('pk-status'), /Include the Codex trust check/);
    box.click();
    button(page.$('pk-status'), /^Refresh status$/).click();
    ok('unticked, Refresh status runs without it and says so', await waitFor(() => statusDone() && /without the Codex trust check/.test(t(page.$('pk-status'))))
      && /trust not checked/.test(t(card('review-gate').querySelector('[data-part="agent-guard"]'))));
  }

  console.log('\nedited by you, and update with replace');
  {
    const skill = path.join(sb.home, '.claude/skills/handoff/SKILL.md');
    fs.appendFileSync(skill, '\nmy note\n');
    button(page.$('pk-status'), /^Refresh status$/).click();
    ok('my edit shows as an "edited by you" badge, naming the file', await waitFor(() => statusDone() && /edited by you/.test(t(card('handoff').querySelector('.pk-badges'))))
      && /edited: ~\/\.claude\/skills\/handoff\/SKILL\.md/.test(t(card('handoff').querySelector('.pk-details'))));
    button(card('handoff'), /^Preview update/).click();
    await waitFor(() => previewOf('handoff'));
    ok('the update preview keeps it, says so, and offers the pack\'s copy', /kept: ~\/\.claude\/skills\/handoff\/SKILL\.md — you edited it/.test(t(previewOf('handoff'))) && !!check(previewOf('handoff'), /Take the pack's copy/) && button(previewOf('handoff'), /^Update$/).disabled);
    check(previewOf('handoff'), /Take the pack's copy/).click();
    ok('ticking it re-previews: the edit is backed up, then replaced', await waitFor(() => rows('handoff').some((r) => /your edit is backed up, then replaced/.test(r))) && !button(previewOf('handoff'), /^Update$/).disabled, rows('handoff').join(' | '));
    button(previewOf('handoff'), /^Update$/).click();
    ok('Update applies it: the pack\'s copy is back, with a backup folder named', await waitFor(() => card('handoff')?.querySelector('.pk-result'))
      && !/my note/.test(sb.read(skill)) && /Backups of every existing file it changed: ~\/\.agent-config-studio\/backups\//.test(t(card('handoff').querySelector('.pk-result'))), t(card('handoff').querySelector('.pk-result')));
  }

  console.log('\na stale preview, and uninstall');
  {
    await waitFor(statusDone);
    button(card('handoff'), /^Preview uninstall/).click();
    await waitFor(() => previewOf('handoff'));
    ok('the uninstall preview names the skill file it removes', rows('handoff').some((r) => /^- ~\/\.claude\/skills\/handoff\/SKILL\.md removed/.test(r)), rows('handoff').join(' | '));
    fs.appendFileSync(path.join(sb.home, '.claude/skills/handoff/SKILL.md'), '\nedited after the preview\n');
    button(previewOf('handoff'), /^Uninstall$/).click();
    ok('a file changed after the preview: the card says to preview again, and drops the preview', await waitFor(() => card('handoff')?.querySelector('.pk-error'))
      && /different from the preview/.test(t(card('handoff').querySelector('.pk-error'))) && !previewOf('handoff'), t(card('handoff')).slice(0, 500));
    ok('…and nothing was removed', fs.existsSync(path.join(sb.home, '.claude/skills/handoff/SKILL.md')));
    button(card('handoff'), /^Preview uninstall/).click();
    await waitFor(() => previewOf('handoff'));
    button(previewOf('handoff'), /^Uninstall$/).click();
    ok('previewed again, Uninstall removes it and reports what it kept', await waitFor(() => card('handoff')?.querySelector('.pk-result'))
      && /kept: ~\/\.claude\/skills\/handoff\/SKILL\.md/.test(t(card('handoff').querySelector('.pk-result'))), t(card('handoff').querySelector('.pk-result')));
    await waitFor(statusDone);
    const one = card('review-gate').querySelector('[data-part="agent-guard"]');
    button(one, /^Preview uninstalling this part/).click();
    await waitFor(() => previewOf('review-gate'));
    ok('a part\'s own uninstall previews only that part', /^Uninstall: review-gate — review-gate\/agent-guard/.test(t(previewOf('review-gate').querySelector('.pk-preview-head'))), t(previewOf('review-gate').querySelector('.pk-preview-head')));
    button(card('review-gate'), /^Preview uninstall$/).click();
    await waitFor(() => /review-gate\/code-review/.test(t(previewOf('review-gate')?.querySelector('.pk-preview-head'))));
    button(previewOf('review-gate'), /^Uninstall$/).click();
    ok('the pack\'s Uninstall takes the rest out', await waitFor(() => card('review-gate')?.querySelector('.pk-result'), 30_000)
      && !fs.existsSync(path.join(sb.home, '.claude/skills/code-review')) && !fs.existsSync(path.join(sb.home, '.agent-config-studio/review-gate')), t(card('review-gate')).slice(0, 400));
    ok('…and the card goes back to not installed', await waitFor(() => /not installed/.test(t(card('review-gate').querySelector('.pk-head')))));
  }

  console.log('\nlight and dark');
  {
    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
    const block = css.slice(css.indexOf('/* ── packs view'));
    ok('the packs styles use only the theme tokens (no literal colours)', block.length > 200 && !/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(block), (block.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/i) || [])[0]);
    page.$('btn-theme').click();
    ok('the theme toggle switches with the Packs view open, and it still renders', page.doc.documentElement.dataset.theme === 'light' && page.$('content').querySelectorAll('.pk-card').length === 6);
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
    const p1 = await bootPage({ routes: proxy1, hash: '#packs' });
    const card1 = (id) => p1.$('content').querySelector(`[data-pack="${id}"]`);
    await waitFor(() => p1.$('content').querySelectorAll('.pk-card').length === 6);
    const codexBox = card1('review-gate').querySelectorAll('label').find((l) => /^Codex \(/.test(p1.text(l)));
    ok('Codex\'s box is there, disabled and unticked, with why beside it', codexBox && codexBox.querySelector('input').disabled && !codexBox.querySelector('input').checked
      && /Codex: no codex CLI on PATH and no ~\/\.codex/.test(p1.text(card1('review-gate').querySelector('.pk-harnesses'))), p1.text(card1('review-gate').querySelector('.pk-harnesses')));
    card1('review-gate').querySelectorAll('button').find((b) => /^Preview install/.test(p1.text(b))).click();
    await waitFor(() => card1('review-gate')?.querySelector('.pk-preview'));
    const pv = () => card1('review-gate').querySelector('.pk-preview');
    const offer = () => pv()?.querySelectorAll('label').find((l) => /^Set the reviewer role to /.test(p1.text(l)))?.querySelector('input');
    ok('the preview says the reviewer role has no installed CLI and offers installed families', /The reviewer role uses astra, and none of their CLIs is installed here/.test(p1.text(pv())) && offer() && !offer().checked, p1.text(pv()).slice(0, 600));
    offer().click();
    ok('ticking it re-previews with the role change in the list, ticked', await waitFor(() => offer()?.checked && /~\/\.agent-config-studio\/roles\.json/.test(p1.text(pv())))
      && /reviewer role →/.test(p1.text(pv())) && !/warning: the reviewer role/.test(p1.text(pv())), p1.text(pv()).slice(0, 800));
    const sent = p1.requests.filter((r) => r.path === '/api/packs/plan').at(-1).body;
    ok('…sent as setRoles with the families offered', Array.isArray(sent.setRoles?.reviewer) && sent.setRoles.reviewer.length > 0, JSON.stringify(sent));
    ok('…and nothing was written', !fs.existsSync(path.join(c1.home, '.agent-config-studio', 'roles.json')) && !fs.existsSync(path.join(c1.home, '.claude', 'skills', 'code-review')));
    ok('no page errors there either', p1.errors.length === 0, p1.errors.join(' | '));
    p1.done();
  }
} finally {
  page.done();
  server.kill('SIGKILL');
  await sleep(200);
  sb.cleanup();
}
assertRealHomesUnchanged(realBefore, ok);
done();
