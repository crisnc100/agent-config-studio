/**
 * The skill wizard's Blocks step in the page (builds/blocks-wizard-step C4,
 * C6), in the fake DOM against stubbed routes: where the step sits, that it
 * lists every block by name and summary with none ticked, what a draft
 * sends, that a toggle drops the draft, Review's Back, and the UI rules (no
 * folds, styled buttons, plain words, theme tokens). No server, no HOME.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bootPage, PUB, routesFor, settle } from './fixtures/shell-page.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\nskill wizard ui: the Blocks step');

const BLOCKS = [
  { id: 'a-rule', name: 'A rule', summary: 'Does the first thing.' },
  { id: 'b-rule', name: 'B rule', summary: 'Does the second thing.' },
  { id: 'c-rule', name: 'C rule', summary: 'Does the third thing.' },
];
const info = (blocks) => ({
  backend: { harness: 'claude', label: 'Claude', model: 'm-1', modelLabel: 'Model One', ready: true, why: null },
  limits: { description: 4000, answer: 2000 },
  targets: {
    global: [
      { key: 'claude', label: 'Claude', display: '~/.claude/skills', available: true, installed: true, on: true, why: null },
      { key: 'codex', label: 'Codex', display: '~/.codex/skills', available: true, installed: true, on: false, why: null },
      { key: 'shared', label: 'Shared', display: '~/.agents/skills', available: true, installed: true, on: false, why: null },
    ],
    projects: [],
    dirs: ['.claude', '.codex', '.agents'],
    overlaps: [],
  },
  blocks,
});
const DRAFT = (name) => `---\nname: ${name}\ndescription: Does it. Use when asked.\n---\n\n# ${name}\n\nSteps.\n`;

function stubs(st) {
  return routesFor({
    'GET /api/skills': () => ({ skills: [], usage: { caveat: { text: '' } } }),
    'GET /api/skill-wizard': () => st.info,
    'POST /api/skill-wizard/target': (b) => ({ targets: b.dests.map((d) => ({ dest: d, display: `~/.claude/skills/${b.name}/SKILL.md`, taken: false })) }),
    'POST /api/skill-wizard/cancel': () => ({ cancelled: true }),
    'POST /api/skill-wizard/turn': (b) => {
      st.turns.push(b);
      return b.kind === 'draft' ? { seq: b.seq, kind: 'draft', name: b.name, content: DRAFT(b.name) } : { seq: b.seq, kind: 'done', name: 'cut-release', summary: null };
    },
  });
}
const pages = [];
async function boot({ blocks = BLOCKS, carrySession } = {}) {
  const st = { info: info(blocks), turns: [] };
  const p = await bootPage({ routes: stubs(st), hash: '#skills/new', carrySession });
  await settle(20);
  p.st = st;
  pages.push(p);
  return p;
}
const C = (p) => p.$('content');
const btn = (p, text) => { const all = C(p).querySelectorAll('button'); return all.find((b) => p.text(b) === text) || all.find((b) => p.text(b).startsWith(text)); };
const click = async (b) => { b?.click(); await settle(15); };
const step = (p) => C(p).querySelector('.sw-step.current')?.dataset.step;
const ticks = (p) => C(p).querySelectorAll('.sw-blocks input').filter((i) => i.type === 'checkbox');
const drafts = (p) => p.st.turns.filter((t) => t.kind === 'draft');
async function toWhere(p) {
  p.input(C(p).querySelector('.sw-describe'), 'Cut a release');
  await click(btn(p, 'Start the interview'));
  await settle(20);
}

{
  const p = await boot();
  ok('the stepper: Describe → Interview → Where → Blocks → Review', C(p).querySelectorAll('.sw-step').map((s) => s.dataset.step).join() === 'describe,interview,where,blocks,review');
  await toWhere(p);
  ok('Where\'s button is Next; drafting is no longer on Where', step(p) === 'where' && !!btn(p, 'Next') && btn(p, 'Next').classList.contains('primary') && !btn(p, 'Draft the skill'));
  await click(btn(p, 'Next'));
  ok('Next goes to Blocks, without asking the model', step(p) === 'blocks' && drafts(p).length === 0);
  const rows = C(p).querySelectorAll('.sw-block');
  ok('every block is listed by name and summary, in the order the server gave', rows.length === 3
    && rows.map((r) => p.text(r.querySelector('.sw-block-name'))).join() === 'A rule,B rule,C rule'
    && rows.map((r) => p.text(r.querySelector('.sw-block-summary'))).join('|') === 'Does the first thing.|Does the second thing.|Does the third thing.', rows.map((r) => p.text(r)).join(' | '));
  ok('C4 none is ticked: nothing is preselected or suggested', ticks(p).length === 3 && ticks(p).every((c) => !c.checked) && !/suggest|recommend/i.test(p.text(C(p).querySelector('.sw-blocks'))));
  ok('the step says what ticking does, in plain words', /word for word/.test(p.text(C(p))) && /Shared rules/.test(p.text(C(p))) && /only the names/i.test(p.text(C(p))), p.text(C(p)).slice(0, 600));
  ok('C6 no folds: no details or summary elements', !C(p).querySelector('details') && !C(p).querySelector('summary'));
  ok('C6 every button is styled primary, secondary or quiet', C(p).querySelectorAll('button').filter((b) => !b.classList.contains('sw-step-btn')).every((b) => /\bbtn\b/.test(b.className)),
    C(p).querySelectorAll('button').map((b) => `${p.text(b)}:${b.className}`).join(' | '));
  ok('C6 plain words: no "harness" on the step', !/harness/i.test(p.text(C(p))));
  ok('…Back (quiet) and Draft the skill (primary)', btn(p, 'Back')?.classList.contains('ghost') && btn(p, 'Draft the skill')?.classList.contains('primary'));

  await click(btn(p, 'Draft the skill'));
  ok('C4 with nothing ticked, the draft asks for no blocks', step(p) === 'review' && drafts(p).length === 1 && Array.isArray(drafts(p)[0].blocks) && drafts(p)[0].blocks.length === 0, JSON.stringify(drafts(p)[0]));
  await click(btn(p, 'Back'));
  ok('Review\'s Back goes to Blocks', step(p) === 'blocks');
  await click(btn(p, 'Draft the skill'));
  ok('…and back again with nothing changed shows the same draft, no new turn', step(p) === 'review' && drafts(p).length === 1);
  await click(btn(p, 'Back'));
  ticks(p)[2]?.click(); await settle(5);
  ticks(p)[0]?.click(); await settle(5);
  ok('ticking a block drops the draft (a new one is needed)', p.eval('SW.draft') === null);
  await click(btn(p, 'Draft the skill'));
  ok('the draft sends the ticked ids, and only those', drafts(p).length === 2 && JSON.stringify([...drafts(p)[1].blocks].sort()) === '["a-rule","c-rule"]', JSON.stringify(drafts(p)[1]?.blocks));
  p.input(C(p).querySelector('.sw-note'), 'shorter');
  await click(btn(p, 'Regenerate'));
  ok('Regenerate sends the same ids', drafts(p).length === 3 && JSON.stringify([...drafts(p)[2].blocks].sort()) === '["a-rule","c-rule"]');

  await click(btn(p, 'Back'));
  const saved = [...p.sessionStore];
  const p2 = await boot({ carrySession: saved });
  ok('reload on Blocks keeps the step and the ticks', step(p2) === 'blocks' && ticks(p2).map((c) => c.checked).join() === 'true,false,true');
  ticks(p2)[0]?.click(); await settle(5);
  ok('unticking one drops it from what is sent', JSON.stringify(p2.eval('SW.blocks')) === '["c-rule"]');
}

{
  // A pick the server no longer lists is dropped where the person can see it, not sent.
  const p = await boot();
  await toWhere(p);
  await click(btn(p, 'Next'));
  ticks(p)[1]?.click(); await settle(5);
  const saved = [...p.sessionStore];
  const p2 = await boot({ blocks: BLOCKS.filter((b) => b.id !== 'b-rule'), carrySession: saved });
  const gone = C(p2).querySelector('.sw-blocks-gone');
  ok('a ticked block that is gone is named on the step and dropped', step(p2) === 'blocks' && !!gone && /b-rule/.test(p2.text(gone)) && ticks(p2).length === 2, p2.text(C(p2)).slice(0, 600));
  ok('…and not sent', JSON.stringify(p2.eval('SW.blocks')) === '[]');
}

{
  const p = await boot({ blocks: [] });
  await toWhere(p);
  await click(btn(p, 'Next'));
  ok('no blocks at all: a plain line says so, and Draft still works', step(p) === 'blocks' && /no building blocks/i.test(p.text(C(p))) && !btn(p, 'Draft the skill').disabled);
}

{
  const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
  const added = css.split('\n').filter((l) => /^\.sw-block/.test(l));
  ok('the Blocks step has its own rules', added.length >= 2);
  ok('…using var(--…) tokens only: no hex, rgb or named colours, readable in light and dark', added.every((l) => !/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|:\s*(white|black|red|green)\b/i.test(l)), added.join('\n'));
}

for (const p of pages) {
  if (p.errors.length) ok('no page errors', false, p.errors.join(' | ').slice(0, 400));
  p.done();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
