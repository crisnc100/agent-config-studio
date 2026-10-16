/**
 * The skill wizard in the page (builds/skill-wizard W2, W6, S5, S8, S10), in
 * the fake DOM against stubbed routes: what each step shows, what each
 * control sends, stale replies, reload, and what Create does. No server, no
 * HOME.
 */
import { bootPage, routesFor, settle } from './fixtures/shell-page.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
console.log('\nskill wizard ui');

const INFO = {
  backend: { harness: 'claude', label: 'Claude', model: 'm-1', modelLabel: 'Model One', ready: true, why: null },
  limits: { description: 4000, answer: 2000 },
  targets: {
    global: [
      { key: 'claude', label: 'Claude', display: '~/.claude/skills', available: true },
      { key: 'codex', label: 'Codex', display: '~/.codex/skills', available: true },
      { key: 'shared', label: 'Shared', display: '~/.agents/skills', available: true },
    ],
    projects: [
      { id: 'aaaaaaaaaaaa', name: 'repo-a', display: '~/Projects/repo-a', root: 'Projects', harnessDirs: ['.claude'] },
      { id: 'bbbbbbbbbbbb', name: 'repo-b', display: '~/Projects/repo-b', root: 'Projects', harnessDirs: [] },
    ],
    dirs: ['.claude', '.codex', '.agents'],
  },
};
const Q = (n, extra = {}) => ({ kind: 'question', question: `Question number ${n}?`, why: `Why ${n}.`, recommended: `Rec ${n}`, choices: [`Chip ${n}a`, `Chip ${n}b`], ...extra });
const DRAFT = (name) => `---\nname: ${name}\ndescription: Does it. Use when asked.\n---\n\n# ${name}\n\nSteps.\n`;
const paths = (name, dest) => (dest.scope === 'global' ? `~/.claude/skills/${name}/SKILL.md` : `~/Projects/${dest.project === 'bbbbbbbbbbbb' ? 'repo-b' : 'repo-a'}/${dest.dir}/skills/${name}/SKILL.md`);

function stubs(st) {
  const r = routesFor({
    'GET /api/skills': () => ({ skills: [], usage: { caveat: { text: '' } } }),
    'GET /api/skill-wizard': () => INFO,
    'POST /api/skill-wizard/target': (b) => ({ display: paths(b.name, b.dest), taken: st.taken?.includes(b.name) || false }),
    'POST /api/skill-wizard/cancel': () => ({ cancelled: true }),
    'POST /api/skill-wizard/turn': (b) => {
      st.turns.push(b);
      const h = st.next.shift();
      if (h) return h(b);
      if (b.kind === 'draft') return { seq: b.seq, kind: 'draft', name: b.name, content: DRAFT(b.name) };
      return { seq: b.seq, ...Q(b.answers.length + 1) };
    },
    'POST /api/skill-wizard/create': (b) => {
      st.creates.push(b);
      const h = st.create.shift();
      if (h) return h(b);
      return { created: true, path: `/h/.claude/skills/${b.name}/SKILL.md`, display: paths(b.name, b.dest), sha: 'abc', warnings: [] };
    },
  });
  // The editor reads back what Create wrote.
  const create = r.table['POST /api/skill-wizard/create'];
  r.table['POST /api/skill-wizard/create'] = async (b) => { const out = await create(b); r.files.set(out.path, b.content); return out; };
  return r;
}
const pages = [];
async function boot({ hash = '#skills', carrySession } = {}) {
  const st = { turns: [], next: [], creates: [], create: [], taken: [] };
  const p = await bootPage({ routes: stubs(st), hash, carrySession });
  await settle(20);
  p.st = st;
  pages.push(p);
  return p;
}
const C = (p) => p.$('content');
const btn = (p, text) => { const all = C(p).querySelectorAll('button'); return all.find((b) => p.text(b) === text) || all.find((b) => p.text(b).startsWith(text)); };
const click = async (b) => { b.click(); await settle(15); };
const cards = (p) => C(p).querySelectorAll('.sw-card');
const step = (p) => C(p).querySelector('.sw-step.current')?.dataset.step;

{
  const p = await boot();
  const add = C(p).querySelector('.sk-new');
  ok('W6 the Skills view has a New skill button', !!add && p.text(add) === 'New skill');
  add.click();
  p.navigate(p.location.hash);
  await settle(20);
  ok('…which opens the wizard at #skills/new', p.location.hash === '#skills/new' && !!C(p).querySelector('.sw'));
  ok('W6 a stepper: Describe → Interview → Where → Review, on Describe', C(p).querySelectorAll('.sw-step').map((s) => s.dataset.step).join() === 'describe,interview,where,review' && step(p) === 'describe');
  ok('the backend is named, and what it sees', /Claude Model One with no tools/.test(p.text(C(p))) && /never their files/.test(p.text(C(p))));
  const start = btn(p, 'Start the interview');
  ok('Start is disabled with an empty description', start.disabled);
  p.input(C(p).querySelector('.sw-describe'), 'Cut a release of my app');
  await click(btn(p, 'Start the interview'));
  const t0 = p.st.turns[0];
  ok('W1 the first turn asks for a question with the description and no answers', t0?.kind === 'question' && t0.description === 'Cut a release of my app' && t0.answers.length === 0 && t0.seq === 1);
  ok('W1 one question card: the question, why, the recommended answer, chips, free text, Skip', cards(p).length === 1
     && /Question number 1\?/.test(p.text(cards(p)[0])) && /Why 1\./.test(p.text(cards(p)[0]))
     && !!btn(p, 'Use the recommended answer: Rec 1') && cards(p)[0].querySelectorAll('.sw-chip').length === 2
     && !!cards(p)[0].querySelector('.sw-free') && !!btn(p, 'Skip') && !!btn(p, 'That’s enough'));

  await click(btn(p, 'Use the recommended answer'));
  ok('W2 one click on the recommended answer sends it as the answer', JSON.stringify(p.st.turns[1].answers) === JSON.stringify([{ question: 'Question number 1?', answer: 'Rec 1' }]));
  ok('…and still exactly one card, now question 2, with the answer in the transcript above', cards(p).length === 1 && /Question number 2\?/.test(p.text(cards(p)[0])) && /Rec 1/.test(p.text(C(p).querySelector('.sw-transcript'))));
  await click(C(p).querySelectorAll('.sw-chip')[1]);
  ok('W2 a choice chip answers with that choice', p.st.turns[2].answers[1].answer === 'Chip 2b');
  const free = C(p).querySelector('.sw-free');
  p.input(free, 'my own words');
  await click(btn(p, 'Answer'));
  ok('W2 free text answers in the person\'s words', p.st.turns[3].answers[2].answer === 'my own words');
  await click(btn(p, 'Skip'));
  ok('W2/S8 Skip is sent as "(skipped)"', p.st.turns[4].answers[3].answer === '(skipped)');

  // S5: edit an earlier answer while a turn is in flight; the stale reply is dropped.
  const slow = deferred();
  p.st.next.push(() => slow.promise);
  await click(btn(p, 'Use the recommended answer'));
  ok('W6 busy: a waiting line and Cancel while a turn runs, no card', !!C(p).querySelector('.sw-waiting') && cards(p).length === 0 && !!btn(p, 'Cancel'));
  const staleSeq = p.st.turns[5].seq;
  const editBtns = C(p).querySelectorAll('.sw-qa-editbtn');
  ok('every answer has Edit', editBtns.length === 5);
  editBtns[1].click(); await settle(5);
  const ed = C(p).querySelector('.sw-qa-edit');
  p.input(ed, 'Chip 2a');
  await click(btn(p, 'Save and continue from here'));
  const after = p.st.turns[p.st.turns.length - 1];
  ok('W2 editing answer 2 re-runs from there: answers 1–2 only, the edited one sent', JSON.stringify(after.answers.map((a) => a.answer)) === '["Rec 1","Chip 2a"]' && after.seq > staleSeq);
  slow.resolve({ seq: staleSeq, ...Q(77) });
  await settle(20);
  ok('S5 the reply to the older turn is ignored: its question never shows', !/Question number 77/.test(p.text(C(p))) && cards(p).length === 1 && /Question number 3\?/.test(p.text(cards(p)[0])), p.text(C(p)).slice(0, 300));
  ok('…and the transcript holds the two remaining answers', C(p).querySelectorAll('.sw-qa').length === 2);

  // Reload keeps the draft state.
  const saved = [...p.sessionStore];
  const p2 = await boot({ hash: '#skills/new', carrySession: saved });
  ok('W6 reload keeps the wizard: the same step, transcript and card', step(p2) === 'interview' && p2.$('content').querySelectorAll('.sw-qa').length === 2 && /Question number 3\?/.test(p2.text(p2.$('content'))));

  await click(btn(p, 'That’s enough'));
  ok('S8 "That\'s enough" goes straight to Where, without asking the model', step(p) === 'where' && p.st.turns.filter((t) => t.kind === 'draft').length === 0);
  ok('…with a name derived from the description', C(p).querySelector('.sw-name').value === 'cut-a-release-of-my');
  ok('W3 the exact target path is shown', p.text(C(p).querySelector('.sw-target')) === 'Creates ~/.claude/skills/cut-a-release-of-my/SKILL.md');

  await click(btn(p, 'Back'));
  ok('W6 Back to the interview keeps every answer', step(p) === 'interview' && C(p).querySelectorAll('.sw-qa').length === 2);
  await click(C(p).querySelectorAll('.sw-step-btn').find((b) => /Describe/.test(p.text(b))));
  ok('…and the stepper goes back to Describe with the text kept', step(p) === 'describe' && C(p).querySelector('.sw-describe').value === 'Cut a release of my app');
  p.navigate('#skills/new');
  await settle(10);
}

{
  // Where → Review → Create, through a project.
  const p = await boot({ hash: '#skills/new' });
  p.input(C(p).querySelector('.sw-describe'), 'Lint everything');
  p.st.next.push((b) => ({ seq: b.seq, kind: 'done', name: 'lint-all', summary: 'Lints.' }));
  await click(btn(p, 'Start the interview'));
  ok('W1 done moves on to Where with the proposed name', step(p) === 'where' && C(p).querySelector('.sw-name').value === 'lint-all');
  const proj = C(p).querySelectorAll('.sw-radio input').find((r) => r.value === 'project');
  proj.checked = true; proj.dispatchEvent({ type: 'change' }); await settle(15);
  ok('W3 Project lists the repos (edit roots only, as the server gave them)', C(p).querySelectorAll('.sw-project option').map((o) => p.text(o)).join(' | ') === 'repo-a (Projects) — ~/Projects/repo-a | repo-b (Projects) — ~/Projects/repo-b');
  const sel = C(p).querySelector('.sw-project');
  sel.value = 'bbbbbbbbbbbb'; sel.dispatchEvent({ type: 'change' }); await settle(15);
  const dirOpts = C(p).querySelectorAll('.sw-dir option').map((o) => p.text(o));
  ok('…a repo with no harness dir says it will be created', dirOpts[0] === '.claude/skills (will be created)');
  const dir = C(p).querySelector('.sw-dir');
  dir.value = '.codex'; dir.dispatchEvent({ type: 'change' }); await settle(15);
  ok('W3 the path follows the choice exactly', p.text(C(p).querySelector('.sw-target')) === 'Creates ~/Projects/repo-b/.codex/skills/lint-all/SKILL.md');
  p.st.taken.push('taken-one');
  p.input(C(p).querySelector('.sw-name'), 'taken-one');
  await settle(300);
  ok('W3 a taken name is an error and Next is disabled', /already exists/.test(p.text(C(p).querySelector('.sw-target'))) && btn(p, 'Draft the skill').disabled);
  p.input(C(p).querySelector('.sw-name'), 'Bad Name');
  await settle(300);
  ok('W3 an invalid name is an error too', /Lowercase letters/.test(p.text(C(p).querySelector('.sw-target'))) && btn(p, 'Draft the skill').disabled);
  p.input(C(p).querySelector('.sw-name'), 'lint-all');
  await settle(300);
  await click(btn(p, 'Draft the skill'));
  const dt = p.st.turns.find((t) => t.kind === 'draft');
  ok('W4 Review asks for a draft with the chosen name and summary', step(p) === 'review' && dt?.name === 'lint-all' && dt.summary === 'Lints.' && dt.previous === null);
  const src = C(p).querySelector('.sw-source');
  ok('W4 the draft shows as editable source plus a preview', src?.value === DRAFT('lint-all') && !!C(p).querySelector('.sw-preview'));
  p.input(src, DRAFT('lint-all').replace('Steps.', 'My edited steps.'));
  p.input(C(p).querySelector('.sw-note'), 'shorter please');
  await click(btn(p, 'Regenerate'));
  const rg = p.st.turns.filter((t) => t.kind === 'draft')[1];
  ok('W4 Regenerate sends the note and the current (edited) source', rg?.note === 'shorter please' && /My edited steps/.test(rg.previous));
  p.input(C(p).querySelector('.sw-source'), DRAFT('lint-all').replace('Steps.', 'Final words.'));
  await click(btn(p, 'Back'));
  ok('Back from Review keeps the draft', step(p) === 'where');
  await click(btn(p, 'Draft the skill'));
  ok('…returning shows the same draft, no new turn', p.st.turns.filter((t) => t.kind === 'draft').length === 2 && /Final words/.test(C(p).querySelector('.sw-source').value));
  await click(btn(p, 'Back'));
  p.input(C(p).querySelector('.sw-name'), 'lint-every');
  await settle(300);
  await click(btn(p, 'Draft the skill'));
  ok('S5 changing the name drops the draft: Review drafts again for the new name', p.st.turns.filter((t) => t.kind === 'draft').length === 3 && p.st.turns.at(-1).name === 'lint-every');
  p.input(C(p).querySelector('.sw-source'), DRAFT('lint-every').replace('Steps.', 'Mine.'));

  // A lost response, then Retry with retry: true.
  p.st.create.push(() => { throw new TypeError('Failed to fetch'); });
  // fetch rejecting is not a route throw in the stub; model it as a 0-status error instead.
  p.st.create.length = 0;
  p.st.create.push(() => { throw { status: 409, body: { error: 'already exists. Pick another name.' } }; });
  await click(btn(p, 'Create'));
  ok('W6 a refused Create shows the error and stays on Review', /already exists/.test(p.text(C(p).querySelector('.sw-error'))) && step(p) === 'review');
  ok('…sending the person\'s edited bytes to the chosen place', p.st.creates[0].content === DRAFT('lint-every').replace('Steps.', 'Mine.') && JSON.stringify(p.st.creates[0].dest) === '{"scope":"project","project":"bbbbbbbbbbbb","dir":".codex"}' && p.st.creates[0].retry === false);
  await click(btn(p, 'Create'));
  ok('S10 after a refusal, Create again is not a retry', p.st.creates[1].retry === false);
  ok('S10 success opens the new SKILL.md in the editor', p.eval('S.view') === 'entry' && p.eval('S.file && S.file.path') === '/h/.claude/skills/lint-every/SKILL.md', `${p.eval('S.view')}`);
  ok('…with a notice naming its path', /Created ~\/Projects\/repo-b\/\.codex\/skills\/lint-every\/SKILL\.md/.test(p.text(p.$('notice-slot'))));
  ok('…and the wizard state is cleared', !p.sessionStore.has('acs.skillWizard'));
}

{
  // Errors, cancel and Retry on a turn; lost Create responses.
  const p = await boot({ hash: '#skills/new' });
  p.input(C(p).querySelector('.sw-describe'), 'Do a thing');
  p.st.next.push(() => { throw { status: 502, body: { error: "The AI's reply was refused twice (it was empty). Retry, or draft the skill now." } }; });
  await click(btn(p, 'Start the interview'));
  ok('W6 a failed turn is a visible error with Retry, and no card', /refused twice/.test(p.text(C(p).querySelector('.sw-error'))) && cards(p).length === 0 && !!btn(p, 'Retry'));
  await click(btn(p, 'Retry'));
  ok('…Retry asks again', cards(p).length === 1 && p.st.turns.length === 2);
  const hang = deferred();
  p.st.next.push(() => hang.promise);
  await click(btn(p, 'Use the recommended answer'));
  await click(btn(p, 'Cancel'));
  ok('W6 Cancel posts cancel and shows a stopped state with Retry', p.requests.some((r) => r.path === '/api/skill-wizard/cancel') && /Stopped/.test(p.text(C(p))) && !!btn(p, 'Retry'));
  hang.resolve({ seq: p.st.turns.at(-1).seq, ...Q(55) });
  await settle(15);
  ok('…and the cancelled turn\'s late reply is ignored', !/Question number 55/.test(p.text(C(p))));
  // Ten answers: the cap goes straight to Where.
  await click(btn(p, 'Retry'));
  for (let i = 0; i < 9 && btn(p, 'Use the recommended answer'); i++) await click(btn(p, 'Use the recommended answer'));
  ok('S8 the tenth answer goes straight to Where, no eleventh question asked', step(p) === 'where' && p.st.turns.filter((t) => t.kind === 'question').every((t) => t.answers.length < 10), `${step(p)} ${p.st.turns.length}`);
  await click(btn(p, 'Draft the skill'));
  p.st.create.push(() => new Promise((_, rej) => rej(new TypeError('NetworkError when attempting to fetch resource.'))));
  await click(btn(p, 'Create'));
  ok('S10 a lost Create response says it may have been created', /may have been created/.test(p.text(C(p).querySelector('.sw-error'))));
  p.st.create.push((b) => ({ created: false, alreadyCreated: true, path: `/h/.claude/skills/${b.name}/SKILL.md`, display: paths(b.name, b.dest), warnings: [] }));
  await click(btn(p, 'Create'));
  ok('…Retry sends retry: true, and "already created" opens the file', p.st.creates.at(-1).retry === true && /Already created/.test(p.text(p.$('notice-slot'))) && p.eval('S.view') === 'entry');
}

for (const p of pages) {
  if (p.errors.length) ok('no page errors', false, p.errors.join(' | ').slice(0, 400));
  p.done();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
