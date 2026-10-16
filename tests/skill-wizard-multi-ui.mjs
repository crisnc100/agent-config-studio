/**
 * The skill wizard's Where and Create for every harness at once, in the fake
 * DOM against stubbed routes: the checkbox defaults (installed harnesses on,
 * the shared folder off, an uninstalled one disabled with its reason), the
 * overlap warning, a name taken in one place, per-destination results and a
 * Retry that sends only the failed ones, and the toast naming every path.
 * Plus: the styles it adds use the theme tokens only. No server, no HOME.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bootPage, PUB, routesFor, settle } from './fixtures/shell-page.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\nskill wizard ui: every harness');

const OVERLAPS = [{ global: ['codex', 'shared'], dirs: ['.codex', '.agents'], why: 'Codex reads both its own skills folder and the shared .agents one: with both checked, Codex loads this skill twice.' }];
const info = ({ codex = true } = {}) => ({
  backend: { harness: 'claude', label: 'Claude', model: 'm-1', modelLabel: 'Model One', ready: true, why: null },
  limits: { description: 4000, answer: 2000 },
  targets: {
    global: [
      { key: 'claude', label: 'Claude', display: '~/.claude/skills', available: true, installed: true, on: true, why: null },
      codex
        ? { key: 'codex', label: 'Codex', display: '~/.codex/skills', available: true, installed: true, on: true, why: null }
        : { key: 'codex', label: 'Codex', display: '~/.codex/skills', available: true, installed: false, on: false, why: 'Codex is not installed: no codex CLI was found and there is no ~/.codex.' },
      { key: 'shared', label: 'Shared', display: '~/.agents/skills', available: true, installed: true, on: false, why: null },
    ],
    projects: [
      { id: 'aaaaaaaaaaaa', name: 'repo-a', display: '~/Projects/repo-a', root: 'Projects', harnessDirs: ['.claude'] },
    ],
    dirs: ['.claude', '.codex', '.agents'],
    dirInfo: [
      { dir: '.claude', installed: true, on: true, why: null },
      codex ? { dir: '.codex', installed: true, on: true, why: null } : { dir: '.codex', installed: false, on: false, why: 'Codex is not installed here.' },
      { dir: '.agents', installed: true, on: false, why: null },
    ],
    overlaps: OVERLAPS,
  },
});
const DRAFT = (name) => `---\nname: ${name}\ndescription: Does it. Use when asked.\n---\n\n# ${name}\n\nSteps.\n`;
const display = (name, d) => (d.scope === 'global' ? `~/${{ claude: '.claude', codex: '.codex', shared: '.agents' }[d.key]}/skills/${name}/SKILL.md` : `~/Projects/repo-a/${d.dir}/skills/${name}/SKILL.md`);
const real = (name, d) => display(name, d).replace(/^~/, '/h');

function stubs(st) {
  const r = routesFor({
    'GET /api/skills': () => ({ skills: [], usage: { caveat: { text: '' } } }),
    'GET /api/skill-wizard': () => st.info,
    'POST /api/skill-wizard/target': (b) => { st.previews.push(b); return { targets: b.dests.map((d) => ({ dest: d, display: display(b.name, d), taken: (st.taken[b.name] || []).includes(d.key || d.dir) })) }; },
    'POST /api/skill-wizard/cancel': () => ({ cancelled: true }),
    'POST /api/skill-wizard/turn': (b) => (b.kind === 'draft' ? { seq: b.seq, kind: 'draft', name: b.name, content: DRAFT(b.name) } : { seq: b.seq, kind: 'done', name: st.name, summary: null }),
    'POST /api/skill-wizard/create': (b) => {
      st.creates.push(b);
      const fails = st.fail.shift() || [];
      return { results: b.dests.map((d) => (fails.includes(d.key || d.dir)
        ? { dest: d, ok: false, display: display(b.name, d), status: 403, error: 'not inside a folder ACS may write' }
        : { dest: d, ok: true, created: true, path: real(b.name, d), display: display(b.name, d), sha: 'abc', warnings: [] })) };
    },
  });
  const create = r.table['POST /api/skill-wizard/create'];
  r.table['POST /api/skill-wizard/create'] = async (b) => { const out = await create(b); for (const x of out.results) if (x.ok) r.files.set(x.path, b.content); return out; };
  return r;
}
const pages = [];
async function boot({ codex = true, name = 'cut-release' } = {}) {
  const st = { info: info({ codex }), name, previews: [], creates: [], fail: [], taken: {} };
  const p = await bootPage({ routes: stubs(st), hash: '#skills/new' });
  await settle(20);
  p.st = st;
  pages.push(p);
  p.input(C(p).querySelector('.sw-describe'), 'Cut a release');
  await click(btn(p, 'Start the interview'));
  await settle(20);
  return p;
}
const C = (p) => p.$('content');
const btn = (p, text) => { const all = C(p).querySelectorAll('button'); return all.find((b) => p.text(b) === text) || all.find((b) => p.text(b).startsWith(text)); };
const click = async (b) => { b.click(); await settle(15); };
const boxes = (p) => C(p).querySelectorAll('.sw-harnesses input').filter((i) => i.type === 'checkbox');
const box = (p, id) => boxes(p).find((c) => c.value === id);
const step = (p) => C(p).querySelector('.sw-step.current')?.dataset.step;

{
  const p = await boot();
  ok('Where opens with a checkbox per global skills folder', step(p) === 'where' && boxes(p).map((c) => c.value).join() === 'claude,codex,shared');
  ok('both harnesses available → Claude and Codex checked by default', box(p, 'claude').checked && box(p, 'codex').checked && !box(p, 'claude').disabled && !box(p, 'codex').disabled);
  ok('the shared ~/.agents/skills is offered, unchecked', !box(p, 'shared').checked && !box(p, 'shared').disabled);
  ok('every checked place shows its exact path', p.text(C(p).querySelector('.sw-target')) === 'Creates ~/.claude/skills/cut-release/SKILL.md and ~/.codex/skills/cut-release/SKILL.md');
  ok('…and the preview asked about both', JSON.stringify(p.st.previews.at(-1).dests) === '[{"scope":"global","key":"claude"},{"scope":"global","key":"codex"}]');
  ok('no overlap warning with Codex alone', !C(p).querySelector('.sw-overlap'));
  await click(box(p, 'shared'));
  ok('Codex and shared both checked → a one-line overlap warning', /Codex loads this skill twice/.test(p.text(C(p).querySelector('.sw-overlap')) || ''));
  await click(box(p, 'codex'));
  ok('…gone once Codex is unchecked', !C(p).querySelector('.sw-overlap') && p.text(C(p).querySelector('.sw-target')) === 'Creates ~/.claude/skills/cut-release/SKILL.md and ~/.agents/skills/cut-release/SKILL.md');
  await click(box(p, 'claude'));
  await click(box(p, 'shared'));
  ok('nothing checked → an error, and Draft is disabled', /Check at least one/.test(p.text(C(p).querySelector('.sw-target'))) && btn(p, 'Draft the skill').disabled);
  await click(box(p, 'claude'));
  await click(box(p, 'codex'));

  // A name taken in one place blocks, naming only that place.
  p.st.taken['taken-one'] = ['codex'];
  p.input(C(p).querySelector('.sw-name'), 'taken-one');
  await settle(300);
  const t = p.text(C(p).querySelector('.sw-target'));
  ok('a name taken in ~/.codex only: that one is named, Draft disabled', /~\/\.codex\/skills\/taken-one already exists/.test(t) && !/\.claude/.test(t) && btn(p, 'Draft the skill').disabled, t);
  p.input(C(p).querySelector('.sw-name'), 'cut-release');
  await settle(300);
  ok('…a free name clears it', !btn(p, 'Draft the skill').disabled);

  // Create: both, one fails, Retry sends only that one.
  await click(btn(p, 'Draft the skill'));
  await settle(20);
  ok('Review says where it goes: both paths', /written exactly as shown, to ~\/\.claude\/skills\/cut-release\/SKILL\.md and ~\/\.codex\/skills\/cut-release\/SKILL\.md/.test(p.text(C(p))));
  p.st.fail.push(['codex']);
  await click(btn(p, 'Create'));
  ok('Create sends the reviewed bytes to both checked places', p.st.creates[0].dests.length === 2 && p.st.creates[0].content === DRAFT('cut-release') && p.st.creates[0].retry === false);
  const res = p.text(C(p).querySelector('.sw-results') || { textContent: '' });
  ok('a partial failure shows per-place results: created, and failed with the reason', /Created 1 of 2/.test(res) && /~\/\.claude\/skills\/cut-release\/SKILL\.md — created/.test(res) && /~\/\.codex\/skills\/cut-release\/SKILL\.md — failed: not inside a folder ACS may write/.test(res), res);
  ok('…stays on Review, the created one kept: the source is now read-only, Back and Regenerate off', step(p) === 'review' && C(p).querySelector('.sw-source').readOnly === true && btn(p, 'Back').disabled && btn(p, 'Regenerate').disabled);
  ok('…and the stepper cannot go back', C(p).querySelectorAll('.sw-step-btn').length === 0);
  await click(btn(p, 'Retry the failed ones'));
  ok('Retry sends only the failed place', JSON.stringify(p.st.creates[1].dests) === '[{"scope":"global","key":"codex"}]' && p.st.creates[1].content === DRAFT('cut-release'));
  ok('…then opens the first created file in the editor', p.eval('S.view') === 'entry' && p.eval('S.file && S.file.path') === '/h/.claude/skills/cut-release/SKILL.md', `${p.eval('S.view')} ${p.eval('S.file && S.file.path')}`);
  ok('…the toast lists every created path', /Created ~\/\.claude\/skills\/cut-release\/SKILL\.md, ~\/\.codex\/skills\/cut-release\/SKILL\.md/.test(p.text(p.$('notice-slot'))), p.text(p.$('notice-slot')));
  ok('…and the wizard state is cleared', !p.sessionStore.has('acs.skillWizard'));
}

{
  const p = await boot({ codex: false });
  ok('Codex not installed → unchecked and disabled', !box(p, 'codex').checked && box(p, 'codex').disabled);
  ok('…with the reason beside it', /Codex is not installed: no codex CLI was found and there is no ~\/\.codex/.test(p.text(C(p).querySelector('.sw-harnesses'))));
  ok('…and only Claude is created', p.text(C(p).querySelector('.sw-target')) === 'Creates ~/.claude/skills/cut-release/SKILL.md');
}

{
  const p = await boot();
  const proj = C(p).querySelectorAll('.sw-radio input').find((r) => r.value === 'project');
  proj.checked = true; proj.dispatchEvent({ type: 'change' }); await settle(20);
  ok('project: a checkbox per folder', boxes(p).map((c) => c.value).join() === '.claude,.codex,.agents');
  ok('….claude and .codex checked by default, .agents not', box(p, '.claude').checked && box(p, '.codex').checked && !box(p, '.agents').checked);
  ok('…the ones the repo lacks say they will be created', /\.codex\/skills \(will be created\)/.test(p.text(C(p).querySelector('.sw-harnesses'))) && !/\.claude\/skills \(will be created\)/.test(p.text(C(p).querySelector('.sw-harnesses'))));
  ok('…each with its exact path', p.text(C(p).querySelector('.sw-target')) === 'Creates ~/Projects/repo-a/.claude/skills/cut-release/SKILL.md and ~/Projects/repo-a/.codex/skills/cut-release/SKILL.md');
  await click(box(p, '.agents'));
  ok('….codex and .agents both checked → the overlap warning', /Codex loads this skill twice/.test(p.text(C(p).querySelector('.sw-overlap')) || ''));
  await click(box(p, '.agents'));
  await click(btn(p, 'Draft the skill'));
  await settle(20);
  await click(btn(p, 'Create'));
  ok('Create in a project sends .claude and .codex', JSON.stringify(p.st.creates[0].dests) === '[{"scope":"project","project":"aaaaaaaaaaaa","dir":".claude"},{"scope":"project","project":"aaaaaaaaaaaa","dir":".codex"}]');
  ok('…all created: straight to the editor, the toast naming both', p.eval('S.view') === 'entry' && /Created ~\/Projects\/repo-a\/\.claude\/skills\/cut-release\/SKILL\.md, ~\/Projects\/repo-a\/\.codex\/skills\/cut-release\/SKILL\.md/.test(p.text(p.$('notice-slot'))));
}

{
  const p = await boot({ codex: false });
  const proj = C(p).querySelectorAll('.sw-radio input').find((r) => r.value === 'project');
  proj.checked = true; proj.dispatchEvent({ type: 'change' }); await settle(20);
  ok('project with Codex not installed: .codex unchecked and disabled, with the reason', !box(p, '.codex').checked && box(p, '.codex').disabled && /Codex is not installed here/.test(p.text(C(p).querySelector('.sw-harnesses'))));
}

{
  // Giving up on the failed one: Finish opens what was created and says what was not.
  const p = await boot();
  await click(btn(p, 'Draft the skill'));
  await settle(20);
  p.st.fail.push(['claude']);
  await click(btn(p, 'Create'));
  await click(btn(p, 'Finish without them'));
  ok('Finish without them: no second Create, the created one opens', p.st.creates.length === 1 && p.eval('S.view') === 'entry' && p.eval('S.file && S.file.path') === '/h/.codex/skills/cut-release/SKILL.md');
  ok('…and the toast warns which was not created, and why', /Created ~\/\.codex\/skills\/cut-release\/SKILL\.md/.test(p.text(p.$('notice-slot'))) && /Not created: ~\/\.claude\/skills\/cut-release\/SKILL\.md — not inside a folder ACS may write/.test(p.text(p.$('notice-slot'))), p.text(p.$('notice-slot')));
}

{
  // The defaults are not remembered: a new wizard starts from all available checked.
  const p = await boot();
  await click(box(p, 'codex'));
  p.eval('SW = null; swClear()');
  p.navigate('#skills');
  await settle(10);
  p.navigate('#skills/new');
  await settle(20);
  p.input(C(p).querySelector('.sw-describe'), 'Again');
  await click(btn(p, 'Start the interview'));
  await settle(20);
  ok('a new wizard ignores the last one\'s choices: Claude and Codex checked again', box(p, 'claude').checked && box(p, 'codex').checked);
}

{
  // Light/dark: what this adds to the stylesheet is theme tokens, never a literal colour.
  const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
  const added = css.split('\n').filter((l) => /^\.sw-(harnesses|check|why|result|overlap)|^\.sw-target \.sw-path/.test(l));
  ok('the new wizard rules exist', added.length >= 5);
  ok('…and use var(--…) tokens only: no hex, rgb or named colours', added.every((l) => !/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|:\s*(white|black|red|green)\b/i.test(l)), added.join('\n'));
}

for (const p of pages) {
  if (p.errors.length) ok('no page errors', false, p.errors.join(' | ').slice(0, 400));
  p.done();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
