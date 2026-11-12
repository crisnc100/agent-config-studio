/**
 * The Shared rules page (builds/building-blocks-page C1–C4, builds/shared-rules-page
 * A1–A6), in the fake DOM against stubbed routes: under Workflows in the sidebar,
 * each rule with its reference text and every copy's place and rating, no fold,
 * every button one of the three kinds; reading, the only request is GET /api/blocks, and
 * only making one copy match (builds/shared-rules-ux B1, B2, B6) posts.
 * The static half reads the view's source and its styles. No server, no HOME.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bootPage, routesFor, settle, PUB } from './fixtures/shell-page.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 800)}` : ''}`); }
};
console.log('\nshared rules page');

const VIEW = {
  blocks: [
    { id: 'review-policy', name: 'Review policy', summary: 'The eleven rules for a review.', text: '1. The operator is involved only at PR merge.\n2. **One** fix round.\n',
      marker: '<!-- block:review-policy sha256:aa -->', counts: { same: 1, reworded: 2, differs: 1 }, copies: [
        { file: 'packs/build/skills/claude/build/SKILL.md', source: 'pack', kind: 'skill', skill: 'build', project: null, pack: true, line: 222, endLine: 232, rating: 'same', marked: false, note: null, text: '1. The operator is involved only at PR merge.\n2. **One** fix round.', textCut: false },
        { file: '~/.claude/skills/build/SKILL.md', source: 'claude', kind: 'skill', skill: 'build', project: null, pack: false, line: 220, endLine: 230, rating: 'reworded', marked: true, note: 'edited after it was added', text: '1. The operator is involved only at merge.\n2. **One** fix round.', textCut: false },
        { file: '~/.claude/skills/code-review/SKILL.md', source: 'claude', kind: 'skill', skill: 'code-review', project: null, pack: false, line: 103, endLine: 117, rating: 'differs', marked: false, note: 'the whole block is there, with more added', text: 'First read the plan. 1. The operator is involved only at PR merge. 2. One fix round. Then report.', textCut: false },
        { file: '~/.claude/CLAUDE.md', source: 'claude', kind: 'instructions', skill: null, project: null, pack: false, line: 30, endLine: 31, rating: 'reworded', marked: false, note: null, text: 'The operator is involved only at PR merge.\nOne fix round only.', textCut: false },
      ] },
    { id: 'operator-merges', name: 'Only the operator merges', summary: 'Agents never merge.', text: 'Never merge a PR or enable auto-merge.\n',
      marker: '<!-- block:operator-merges sha256:bb -->', counts: { same: 0, reworded: 0, differs: 0 }, copies: [] },
  ],
  scanned: { files: 102, unreadable: [] },
};

const calls = [];
const recording = (routes) => {
  const fn = async (method, p, body, url) => { calls.push(`${method} ${p}`); return routes(method, p, body, url); };
  return Object.assign(fn, routes);
};

try {
  const p = await bootPage({ routes: recording(routesFor({ 'GET /api/blocks': () => VIEW })), hash: '#blocks' });
  for (let i = 0; i < 60 && !p.$('content').querySelector('.bb-card'); i++) await settle(5);
  const c = p.$('content');
  const t = (n) => (n ? p.text(n) : '');
  ok('#blocks opens the view', p.eval('S.view') === 'blocks' && c.querySelectorAll('.bb-card').length === 2, t(c).slice(0, 300));
  ok('a Shared rules item under Workflows, after Skills and before Models', t(p.$('btn-blocks')?.closest('.nav-group')?.querySelector('.nav-group-title')) === 'Workflows'
    && JSON.stringify(p.$('btn-blocks').closest('.nav-group').querySelectorAll('.nav-item').map((b) => t(b.querySelector('.nav-label')))) === JSON.stringify(['Packs', 'Skills', 'Shared rules', 'Models']));
  const [rp, om] = c.querySelectorAll('.bb-card');
  ok('each block shows its name, summary and its text', t(rp.querySelector('.bb-name')) === 'Review policy' && t(rp.querySelector('.bb-summary')) === 'The eleven rules for a review.'
    && /The operator is involved only at PR merge\./.test(t(rp.querySelector('.bb-text'))), rp.innerHTML.slice(0, 400));
  ok('the card leads with how many of your copies match: "0 of 3 copies match" (pack copies apart)', t(rp.querySelector('.bb-counts')) === '0 of 3 copies match', t(rp.querySelector('.bb-counts')));
  const rows = rp.querySelectorAll('.bb-copy');
  ok('every copy of yours with its place in words, its full path and its rating, Big changes first; the pack copy is not a row', rows.length === 3
    && JSON.stringify(rows.map((r) => [t(r.querySelector('.bb-rating')), t(r.querySelector('.bb-place')), t(r.querySelector('.bb-path'))])) === JSON.stringify([
      ['Big changes', 'SKILL.md in the code-review skill (Claude) · lines 103–117', '~/.claude/skills/code-review/SKILL.md'],
      ['Small changes', 'SKILL.md in the build skill (Claude) · lines 220–230', '~/.claude/skills/build/SKILL.md'],
      ['Small changes', 'CLAUDE.md (Claude, global) · lines 30–31', '~/.claude/CLAUDE.md']]),
    JSON.stringify(rows.map((r) => t(r))));
  ok('no copy says "marked"; a note shows beside its copy, in plain words', !/\bmarked\b/i.test(t(rp)) && !rows.some((r) => r.querySelector('.bb-marked'))
    && t(rows[1].querySelector('.bb-note')) === 'Changed by hand after it was pasted in.' && t(rows[0].querySelector('.bb-note')) === 'The whole rule is here, inside longer text.',
    rows.map((r) => t(r)).join(' | '));
  ok('a copy\'s type is in its place words ("(Claude, global)" for an instruction file, "the … skill" for a skill), with no tag beside it',
    / skill \(Claude\) · /.test(t(rows[0].querySelector('.bb-place'))) && / skill \(Claude\) · /.test(t(rows[1].querySelector('.bb-place')))
    && /^CLAUDE\.md \(Claude, global\) · /.test(t(rows[2].querySelector('.bb-place'))) && !rp.querySelector('.bb-kind'),
    rows.map((r) => t(r)).join(' | '));
  // Plural agreement: "3 of 12 copies match", "1 of 7 copies matches", "1 of 1 copy matches".
  const line = (m, n) => p.eval(`bbCounts(${JSON.stringify({ copies: [...Array(m).fill({ rating: 'same', pack: false }), ...Array(n - m).fill({ rating: 'differs', pack: false }), { rating: 'same', pack: true }] })})`);
  ok('the lead agrees in number, and never counts pack copies', line(3, 12) === '3 of 12 copies match' && line(1, 7) === '1 of 7 copies matches' && line(1, 1) === '1 of 1 copy matches',
    `${line(3, 12)} / ${line(1, 7)} / ${line(1, 1)}`);
  ok('each rating has its own class for its colour', ['differs', 'reworded', 'reworded'].every((k, i) => rows[i].querySelector('.bb-rating').classList.contains(`bb-rating-${k}`)));
  ok('a rule with no copies says so in one line', t(om.querySelector('.bb-counts')) === 'Not found in any of your files.' && !om.querySelector('.bb-copies'));
  ok('the status line counts rules by group and the files checked', t(c.querySelector('.bb-total')) === '1 rule needs a look · 0 have small wording changes · 0 match everywhere · 1 not in your files · checked 102 files', t(c.querySelector('.bb-total')));
  ok('no fold: no <details>, summary or toggle', c.querySelectorAll('details, summary, [aria-expanded]').length === 0);
  const buttons = c.querySelectorAll('button');
  ok('every button is primary, secondary or quiet', buttons.length > 0 && buttons.every((b) => /\bbtn\b/.test(b.className)), buttons.map((b) => b.className).join(' | '));

  // Check again reads the same route again — and only that.
  calls.length = 0;
  c.querySelector('.bb-bar .btn').click();
  for (let i = 0; i < 40 && !calls.length; i++) await settle(5);
  await settle(10);
  ok('Check again asks GET /api/blocks once more, nothing else', JSON.stringify(calls) === JSON.stringify(['GET /api/blocks']), calls.join(', '));
  ok('no page errors', p.errors.length === 0, p.errors.join(' | '));
  p.done();

  // From a cold boot, every request is a GET, and the view's own is /api/blocks alone.
  calls.length = 0;
  const q = await bootPage({ routes: recording(routesFor({ 'GET /api/blocks': () => VIEW })), hash: '#blocks' });
  for (let i = 0; i < 60 && !q.$('content').querySelector('.bb-card'); i++) await settle(5);
  await settle(20);
  ok('the page makes no write request: every call is a GET', calls.length > 0 && calls.every((x) => x.startsWith('GET ')), calls.join(', '));
  ok('…and /api/blocks is asked once', calls.filter((x) => x === 'GET /api/blocks').length === 1, calls.join(', '));
  q.done();

  // An error reading: said in view, with Try again.
  const e = await bootPage({ routes: routesFor({ 'GET /api/blocks': () => { throw { status: 500, body: { error: 'disk on fire' } }; } }), hash: '#blocks' });
  for (let i = 0; i < 60 && !/could not be read/.test(e.text(e.$('content'))); i++) await settle(5);
  ok('a failed read says what failed, with a secondary Try again', /The shared rules could not be read: disk on fire/.test(e.text(e.$('content')))
    && e.$('content').querySelectorAll('button').some((b) => b.className === 'btn' && e.text(b) === 'Try again'), e.text(e.$('content')));
  e.done();
} catch (err) {
  ok(`no test block threw (${err?.message || err})`, false, err?.stack || String(err));
}

/* ── Shared rules: groups, status, pack copies, repeats, Compare (builds/shared-rules-page A1–A5) ── */
console.log('\nshared rules: groups, status line, pack copies, repeats');
const cp = (o) => ({ source: 'claude', kind: 'skill', skill: null, project: null, pack: false, marked: false, note: null, textCut: false, ...o, endLine: o.endLine ?? o.line });
const RP_TEXT = '1. The operator is involved only at PR merge.\n2. **One** fix round.\n';
const RICH = {
  blocks: [
    { id: 'builders-commit', name: 'Builders commit, never push', summary: 'Builders commit at every phase end and never push.', text: 'Builders commit at every phase end; they never push.\n',
      marker: '', counts: { same: 0, reworded: 1, differs: 1 }, copies: [
        cp({ file: '~/.claude/CLAUDE.md', kind: 'instructions', line: 26, rating: 'reworded', text: 'Builders commit at every phase end; they never push it.' }),
        cp({ file: '~/.claude/CLAUDE.md', kind: 'instructions', line: 168, rating: 'differs', text: 'Builders never push.' }),
      ] },
    { id: 'callback-contract', name: 'Callback contract', summary: 'When a builder stops to ask.', text: 'Come back only when the spec is silent.\n',
      marker: '', counts: { same: 1, reworded: 1, differs: 0 }, copies: [
        cp({ file: '~/Projects/team-bundle/.claude/skills/build/SKILL.md', source: 'project', skill: 'build', project: 'team-bundle', line: 48, endLine: 52, rating: 'reworded', text: 'Come back only when the brief is silent.' }),
        cp({ file: '~/.agents/skills/helper/SKILL.md', source: 'shared', skill: 'helper', line: 3, rating: 'same', text: 'Come back only when the spec is silent.' }),
      ] },
    { id: 'deferred-findings', name: 'Deferred findings in the PR body', summary: 'List deferred findings.', text: 'Every PR body lists its deferred findings.\n',
      marker: '', counts: { same: 3, reworded: 0, differs: 0 }, copies: [
        cp({ file: '~/.codex/AGENTS.md', source: 'codex', kind: 'instructions', line: 197, rating: 'same', text: 'Every PR body lists its deferred findings.' }),
        cp({ file: 'packs/build/skills/claude/build/SKILL.md', source: 'pack', skill: 'build', pack: true, line: 234, rating: 'same', text: 'Every PR body lists its deferred findings.' }),
        cp({ file: 'packs/build/skills/codex/build/SKILL.md', source: 'pack', skill: 'build', pack: true, line: 123, rating: 'same', text: 'Every PR body lists its deferred findings.' }),
      ] },
    { id: 'lookup-test', name: 'The lookup test', summary: 'Only ask what cannot be looked up.', text: 'If you can look it up, it is not a question.\n',
      marker: '', counts: { same: 0, reworded: 1, differs: 0 }, copies: [
        cp({ file: 'packs/advisor/skills/claude/advisor/SKILL.md', source: 'pack', skill: 'advisor', pack: true, line: 105, endLine: 112, rating: 'reworded', text: 'If it can be looked up, it is not a question.' }),
      ] },
    { id: 'operator-merges', name: 'Only the operator merges', summary: 'Agents never merge.', text: 'Never merge a PR or enable auto-merge.\n',
      marker: '', counts: { same: 0, reworded: 0, differs: 0 }, copies: [] },
    { id: 'review-policy', name: 'Review policy', summary: 'The eleven rules for a review.', text: RP_TEXT,
      marker: '', counts: { same: 1, reworded: 1, differs: 2 }, copies: [
        cp({ file: '~/.claude/skills/build/SKILL.md', skill: 'build', line: 220, endLine: 230, rating: 'reworded', marked: true, note: 'edited after it was added', text: '1. The operator is involved only at merge.\n2. **One** fix round.' }),
        cp({ file: '~/.claude/skills/code-review/SKILL.md', skill: 'code-review', line: 65, rating: 'differs', text: 'One fix round.' }),
        cp({ file: '~/.claude/skills/code-review/SKILL.md', skill: 'code-review', line: 103, endLine: 117, rating: 'differs', note: 'the whole block is there, with more added',
          text: 'First read the plan. 1. The operator is involved only at PR merge. 2. One fix round. Then report.' }),
        cp({ file: '~/.claude/skills/review/SKILL.md', skill: 'review', line: 40, endLine: 41, rating: 'same', text: '1. The operator is involved only at PR merge.\n2. One fix round.' }),
        cp({ file: 'packs/build/skills/claude/build/SKILL.md', source: 'pack', skill: 'build', pack: true, line: 222, endLine: 232, rating: 'same', text: RP_TEXT.trim() }),
      ] },
  ],
  scanned: { files: 40, unreadable: [] },
};
const rcalls = [];
const rich = () => { const fn = routesFor({ 'GET /api/blocks': () => RICH }); return Object.assign(async (m, pth, b, u) => { rcalls.push(`${m} ${pth}`); return fn(m, pth, b, u); }, fn); };
const until = async (cond) => { for (let i = 0; i < 80 && !cond(); i++) await settle(5); return cond(); };
try {
  const p = await bootPage({ routes: rich(), hash: '#blocks' });
  const c = p.$('content');
  const t = (n) => (n ? p.text(n) : '');
  await until(() => c.querySelector('.bb-card'));
  ok('A1 the page heading and the top bar say "Shared rules"', t(c.querySelector('h2.vh')) === 'Shared rules' && t(p.$('title')) === 'Shared rules', `${t(c.querySelector('h2'))} / ${t(p.$('title'))}`);
  ok('A1 the intro is always shown, word for word', t(c.querySelector('.bb-intro')) === 'Some rules appear in more than one of your instruction files and skills. The studio keeps one reference version of each and checks every file for it. When copies drift apart, your agents follow different versions of the same rule, depending on which file they read.',
    t(c.querySelector('.bb-intro')));
  ok('A1 the status line, computed: rules per group, then the files checked', t(c.querySelector('.bb-total')) === '2 rules need a look · 1 has small wording changes · 1 matches everywhere · 2 not in your files · checked 40 files',
    t(c.querySelector('.bb-total')));
  const again = c.querySelector('.bb-bar button');
  ok('…with a quiet Check again beside it', t(again) === 'Check again' && /\bbtn\b/.test(again.className) && /\bghost\b/.test(again.className), again?.className);
  const groups = c.querySelectorAll('.bb-group');
  const shape = groups.map((g) => [t(g.querySelector('.bb-group-title')), t(g.querySelector('.bb-group-sub')), g.querySelectorAll('.bb-card').map((k) => k.id)]);
  ok('A1 the groups, in order, each with its one line, each rule under its worst copy of yours', JSON.stringify(shape) === JSON.stringify([
    ['Needs a look', 'At least one copy is quite different from the reference: it may leave part of the rule out, add other rules, or sit inside a longer paragraph.', ['bb-builders-commit', 'bb-review-policy']],
    ['Small wording changes', 'Every copy is close to the reference, with a few words changed. Check that the meaning held.', ['bb-callback-contract']],
    ['Match everywhere', 'Every copy is word for word the same.', ['bb-deferred-findings']],
    ['Not in your files', 'The studio has these rules, but none of your files carries a copy.', ['bb-lookup-test', 'bb-operator-merges']],
  ]), JSON.stringify(shape));
  const card = (id) => c.querySelector(`#bb-${id}`);
  ok('a rule found only in the studio\'s packs is not in your files, and says so', t(card('lookup-test').querySelector('.bb-counts')) === 'Not found in any of your files.'
    && !card('lookup-test').querySelector('.bb-copies'), t(card('lookup-test')));
  ok('the lead line counts your copies only', t(card('review-policy').querySelector('.bb-counts')) === '1 of 4 copies matches' && t(card('deferred-findings').querySelector('.bb-counts')) === '1 of 1 copy matches'
    && t(card('callback-contract').querySelector('.bb-counts')) === '1 of 2 copies matches', ['review-policy', 'deferred-findings', 'callback-contract'].map((x) => t(card(x).querySelector('.bb-counts'))).join(' | '));
  ok('A4 pack copies are one quiet line per rule, never rows', t(card('review-policy').querySelector('.bb-packs')) === 'Also in the studio\'s own packs: 1 copy (you don\'t need to change these).'
    && t(card('deferred-findings').querySelector('.bb-packs')) === 'Also in the studio\'s own packs: 2 copies (you don\'t need to change these).'
    && t(card('lookup-test').querySelector('.bb-packs')) === 'Also in the studio\'s own packs: 1 copy (you don\'t need to change these).'
    && !card('callback-contract').querySelector('.bb-packs') && !c.querySelectorAll('.bb-path').some((n) => /^packs\//.test(t(n))), c.querySelectorAll('.bb-packs').map(t).join(' | '));
  const flags = c.querySelectorAll('.bb-copy').filter((r) => r.querySelector('.bb-flag')).map((r) => [t(r.querySelector('.bb-place')), t(r.querySelector('.bb-flag'))]);
  ok('A4 a rule found twice in one file is flagged on both copies, and nowhere else', JSON.stringify(flags) === JSON.stringify([
    ['CLAUDE.md (Claude, global) · line 168', 'Appears twice in this file'], ['CLAUDE.md (Claude, global) · line 26', 'Appears twice in this file'],
    ['SKILL.md in the code-review skill (Claude) · line 65', 'Appears twice in this file'], ['SKILL.md in the code-review skill (Claude) · lines 103–117', 'Appears twice in this file']]), JSON.stringify(flags));
  const places = c.querySelectorAll('.bb-copy').map((r) => t(r.querySelector('.bb-place')));
  ok('A6 places in words: a project\'s skill names the project folder, the shared folder says so, Codex\'s global file says Codex',
    places.includes('SKILL.md in the build skill (team-bundle project) · lines 48–52') && places.includes('SKILL.md in the helper skill (shared skills folder) · line 3')
    && places.includes('AGENTS.md (Codex, global) · line 197'), places.join(' | '));
  const LABEL_CLASS = { Matches: 'same', 'Small changes': 'reworded', 'Big changes': 'differs' };
  const badges = c.querySelectorAll('.bb-copy .bb-rating');
  ok('each rating has its own class for its colour, Matches included: every badge on the list, and a matching copy of yours carries bb-rating-same',
    badges.length > 0 && badges.every((r) => r.classList.contains(`bb-rating-${LABEL_CLASS[t(r)]}`))
    && c.querySelector('#bb-review-policy').querySelectorAll('.bb-copy').some((r) => /review skill/.test(t(r.querySelector('.bb-place'))) && r.querySelector('.bb-rating').classList.contains('bb-rating-same') && t(r.querySelector('.bb-rating')) === 'Matches'),
    badges.map((r) => `${t(r)}:${r.className}`).join(' | '));
  ok('A3 labels are Matches, Small changes and Big changes, and only Big changes takes the warning colour', JSON.stringify([...new Set(c.querySelectorAll('.bb-rating').map(t))].sort()) === JSON.stringify(['Big changes', 'Matches', 'Small changes'])
    && c.querySelectorAll('.bb-rating').every((r) => r.classList.contains('bb-rating-differs') === (t(r) === 'Big changes')));
  ok('A3 nothing on the page claims the same meaning, and no "marked", "block" or "differs" outside quoted rule text', (() => {
    let words = t(c);
    for (const n of c.querySelectorAll('.bb-text')) words = words.split(t(n)).join('');
    return !/same meaning|\bmarked\b|\bblocks?\b|\bdiffers?\b|\breworded\b/i.test(words);
  })(), t(c).slice(0, 600));
  ok('the summary is cut when it repeats the rule\'s text; kept when it does not', !card('builders-commit').querySelector('.bb-summary') && t(card('review-policy').querySelector('.bb-summary')) === 'The eleven rules for a review.');
  const cmp = (id) => card(id).querySelectorAll('button').filter((b) => t(b) === 'Compare copies');
  ok('A2 Compare copies: primary on each Needs a look rule, secondary on Small wording changes, none elsewhere', cmp('builders-commit').length === 1 && /\bprimary\b/.test(cmp('review-policy')[0]?.className)
    && cmp('callback-contract').length === 1 && cmp('callback-contract')[0].className === 'btn' && !cmp('deferred-findings').length && !cmp('lookup-test').length && !cmp('operator-merges').length);
  ok('no link-looking tags: no copy-type tag and no bare file:line', !c.querySelector('.bb-kind, .bb-where, .bb-marked'));
  ok('no page errors on the list', p.errors.length === 0, p.errors.join(' | '));

  console.log('\nCompare copies: its own view');
  rcalls.length = 0;
  cmp('review-policy')[0].click();
  await until(() => c.querySelector('.bb-cmp'));
  ok('A2 Compare opens its own view at #blocks/compare&rule=<id>, not a fold', p.eval('S.view') === 'blocks-compare' && p.location.hash === '#blocks/compare&rule=review-policy'
    && !c.querySelector('.bb-card'), `${p.eval('S.view')} ${p.location.hash}`);
  ok('QA the Compare title is a visible heading, not the hidden page heading', !c.querySelector('h2').classList.contains('vh') && c.querySelectorAll('h2.vh').length === 0, c.querySelector('h2')?.className);
  ok('…titled with the rule, and the sidebar keeps Shared rules marked', t(c.querySelector('h2')) === 'Compare copies: Review policy' && p.$('btn-blocks').classList.contains('active')
    && t(p.$('title')) === 'Shared rules', `${t(c.querySelector('h2'))} | ${p.$('btn-blocks').className}`);
  ok('…says it compares words, not meaning, with a legend for both marks', /compares words, not meaning/i.test(t(c.querySelector('.bb-cmp-intro')))
    && t(c.querySelector('.bb-legend .bb-missing')) === 'Missing from this copy' && t(c.querySelector('.bb-legend .bb-only')) === 'Only in this copy', t(c).slice(0, 400));
  const cs = c.querySelectorAll('.bb-cmp');
  ok('one section per copy of yours, worst first; pack copies are a quiet line', cs.length === 4 && JSON.stringify(cs.map((x) => t(x.querySelector('.bb-place'))))
    === JSON.stringify(['SKILL.md in the code-review skill (Claude) · line 65', 'SKILL.md in the code-review skill (Claude) · lines 103–117', 'SKILL.md in the build skill (Claude) · lines 220–230', 'SKILL.md in the review skill (Claude) · lines 40–41'])
    && /Also in the studio's own packs: 1 copy/.test(t(c.querySelector('.bb-packs'))), cs.map((x) => t(x.querySelector('.bb-place'))).join(' | '));
  const sq = (x) => x.replace(/\s+/g, ' ').trim();
  const buried = cs[1];
  ok('A2 each copy shows the reference beside its own actual text', !!buried.querySelector('.bb-ref') && !!buried.querySelector('.bb-mine')
    && sq(t(buried.querySelector('.bb-mine .bb-diff'))) === 'First read the plan. 1. The operator is involved only at PR merge. 2. One fix round. Then report.'
    && sq(t(buried.querySelector('.bb-ref .bb-diff'))) === sq(RP_TEXT), buried.innerHTML.slice(0, 600));
  ok('A2 …words only in the copy are marked in the copy', JSON.stringify(buried.querySelectorAll('.bb-mine .bb-only').map(t)) === JSON.stringify(['First read the plan.', 'Then report.'])
    && !buried.querySelector('.bb-ref .bb-missing'), JSON.stringify(buried.querySelectorAll('.bb-only').map(t)));
  ok('A2 …and words missing from the copy are marked in the reference', JSON.stringify(cs[2].querySelectorAll('.bb-ref .bb-missing').map(t)) === JSON.stringify(['PR'])
    && !cs[2].querySelector('.bb-mine .bb-only'), cs[2].innerHTML.slice(0, 500));
  ok('…Markdown marks, case and punctuation are not differences', !cs[3].querySelector('.bb-only, .bb-missing'));
  ok('a copy that matches says so instead of two columns', t(cs[3].querySelector('.bb-same')) === 'Word for word the same as the reference.' && !cs[3].querySelector('.bb-mine'));
  ok('each copy keeps its label and note', t(cs[1].querySelector('.bb-rating')) === 'Big changes' && t(cs[1].querySelector('.bb-note')) === 'The whole rule is here, inside longer text.'
    && t(cs[0].querySelector('.bb-flag')) === 'Appears twice in this file');
  const kinds = c.querySelectorAll('button');
  ok('no fold here either, and every button is primary, secondary or quiet', !c.querySelector('details, summary, [aria-expanded]') && kinds.length > 0 && kinds.every((b) => /\bbtn\b/.test(b.className)),
    kinds.map((b) => b.className).join(' | '));
  ok('A5 opening Compare asks the server nothing', rcalls.length === 0, rcalls.join(', '));
  const back = kinds.find((b) => t(b) === 'Back');
  ok('a Back button', !!back);
  back.click();
  await until(() => c.querySelector('.bb-card'));
  ok('Back returns to the list at #blocks, without reading every file again, focused on that rule\'s Compare copies', p.eval('S.view') === 'blocks' && p.location.hash === '#blocks'
    && rcalls.length === 0 && p.doc.activeElement === card('review-policy').querySelectorAll('button').find((b) => t(b) === 'Compare copies'), `${p.eval('S.view')} ${p.location.hash} ${rcalls.join(',')}`);
  ok('no page errors on Compare and Back', p.errors.length === 0, p.errors.join(' | '));
  p.done();

  // A link straight to a comparison reads the rules once and opens it.
  rcalls.length = 0;
  const q = await bootPage({ routes: rich(), hash: '#blocks/compare&rule=callback-contract' });
  await until(() => q.$('content').querySelector('.bb-cmp'));
  ok('a link to #blocks/compare&rule=<id> opens that comparison, reading the rules once', q.eval('S.view') === 'blocks-compare' && q.text(q.$('content').querySelector('h2')) === 'Compare copies: Callback contract'
    && rcalls.filter((x) => x === 'GET /api/blocks').length === 1 && rcalls.every((x) => x.startsWith('GET ')), rcalls.join(', '));
  // f1: with Compare open, a link to another rule opens that rule; the same link again repaints nothing.
  rcalls.length = 0;
  q.navigate('#blocks/compare&rule=review-policy');
  await until(() => q.text(q.$('content').querySelector('h2')) === 'Compare copies: Review policy');
  ok('with Compare open, a link to another rule shows that rule, without reading the files again', q.eval('S.view') === 'blocks-compare'
    && q.text(q.$('content').querySelector('h2')) === 'Compare copies: Review policy' && q.location.hash === '#blocks/compare&rule=review-policy' && rcalls.length === 0,
    `${q.text(q.$('content').querySelector('h2'))} ${q.location.hash} ${rcalls.join(',')}`);
  const shown = q.$('content').querySelector('.bb-cmp');
  q.navigate('#blocks/compare&rule=review-policy');
  await settle(10);
  ok('…and a link to the rule already shown leaves the view as it is', q.$('content').querySelector('.bb-cmp') === shown);
  q.done();
  const u = await bootPage({ routes: rich(), hash: '#blocks/compare&rule=gone-rule' });
  await until(() => /not on the list/.test(u.text(u.$('content'))));
  ok('a rule that is no longer there says so plainly, with Back', /That rule is not on the list any more\./.test(u.text(u.$('content')))
    && u.$('content').querySelectorAll('button').some((b) => u.text(b) === 'Back' && /\bbtn\b/.test(b.className)), u.text(u.$('content')));
  u.done();

  console.log('\nevery group shows; counts agree; summaries');
  {
    const e1 = await bootPage({ routes: routesFor({ 'GET /api/blocks': () => ({ blocks: RICH.blocks.filter((b) => b.id === 'callback-contract'), scanned: RICH.scanned }) }), hash: '#blocks' });
    const lead = (m, n) => e1.eval(`bbCounts(${JSON.stringify({ copies: [...Array(m).fill({ rating: 'same', pack: false }), ...Array(n - m).fill({ rating: 'differs', pack: false })] })})`);
    await until(() => e1.$('content').querySelector('.bb-card'));
    const gs = e1.$('content').querySelectorAll('.bb-group').map((g) => [e1.text(g.querySelector('.bb-group-title')), e1.text(g.querySelector('.bb-group-empty')), g.querySelectorAll('.bb-card').length]);
    ok('QA the three groups always show, in order; an empty one says so plainly; Not in your files only when it has rules', JSON.stringify(gs) === JSON.stringify([
      ['Needs a look', 'Nothing needs a look. Every copy matches or has only small wording changes.', 0],
      ['Small wording changes', '', 1],
      ['Match everywhere', 'No rule matches word for word everywhere yet.', 0]]), JSON.stringify(gs));
    ok('QA count forms: 1 of 1 copy matches, 0 of 1 copy matches, 2 of 5 copies match, 0 of 5 copies match, 1 of 7 copies matches',
      lead(1, 1) === '1 of 1 copy matches' && lead(0, 1) === '0 of 1 copy matches' && lead(2, 5) === '2 of 5 copies match' && lead(0, 5) === '0 of 5 copies match' && lead(1, 7) === '1 of 7 copies matches',
      [lead(1, 1), lead(0, 1), lead(2, 5), lead(0, 5), lead(1, 7)].join(' | '));
    // The shipped rules: only a summary that says the text again is cut (builders-commit); a shorter restatement stays (operator-overrides).
    const shipped = fs.readdirSync(path.join(path.dirname(PUB), 'blocks')).filter((f) => f.endsWith('.md')).map((f) => {
      const raw = fs.readFileSync(path.join(path.dirname(PUB), 'blocks', f), 'utf8');
      return { id: f.slice(0, -3), summary: raw.match(/^summary: (.*)$/m)[1], text: raw.split(/^---$/m)[2] };
    });
    const cut = shipped.filter((b) => e1.eval(`bbRepeatsText(${JSON.stringify(b.summary)}, ${JSON.stringify(b.text)})`)).map((b) => b.id);
    ok('QA of the shipped rules only builders-commit\'s summary is cut as a repeat; operator-overrides keeps its summary', JSON.stringify(cut) === JSON.stringify(['builders-commit']), cut.join(', '));
    e1.done();
    const e2 = await bootPage({ routes: routesFor({ 'GET /api/blocks': () => ({ blocks: RICH.blocks.filter((b) => b.id === 'review-policy'), scanned: RICH.scanned }) }), hash: '#blocks' });
    await until(() => e2.$('content').querySelector('.bb-card'));
    const small = e2.$('content').querySelectorAll('.bb-group').find((g) => e2.text(g.querySelector('.bb-group-title')) === 'Small wording changes');
    ok('QA an empty Small wording changes group says so plainly', e2.text(small?.querySelector('.bb-group-empty')) === 'No rule has small wording changes right now.' && !small.querySelector('.bb-card'));
    ok('…and no page errors', e1.errors.length === 0 && e2.errors.length === 0, [...e1.errors, ...e2.errors].join(' | '));
    e2.done();
  }

  console.log('\nthe word diff');
  const d = await bootPage({ routes: rich(), hash: '#home' });
  const diff = (a, b) => JSON.parse(d.eval(`JSON.stringify(bbWordDiff(${JSON.stringify(a)}, ${JSON.stringify(b)}))`));
  const marked = (side) => side.filter((x) => x.mark).map((x) => x.text.trim());
  const w = diff('Never merge a PR or enable auto-merge.', 'Never merge a pull request. Only the user merges.');
  ok('missing words are marked on the reference side, extra words on the copy side, runs joined', JSON.stringify(marked(w.ref)) === JSON.stringify(['PR or enable auto-merge.'])
    && JSON.stringify(marked(w.copy)) === JSON.stringify(['pull request. Only the user merges.']), JSON.stringify(w));
  ok('both sides keep every character of their text', w.ref.map((x) => x.text).join('') === 'Never merge a PR or enable auto-merge.' && w.copy.map((x) => x.text).join('') === 'Never merge a pull request. Only the user merges.');
  const same = diff('**Never** merge, a PR.\n- or enable it', 'never merge a pr or\nenable it!');
  ok('case, punctuation, Markdown marks and line breaks are not differences', !same.ref.some((x) => x.mark) && !same.copy.some((x) => x.mark), JSON.stringify(same));
  const moved = diff('alpha beta gamma', 'gamma alpha beta');
  ok('a moved word shows as missing in one place and extra in the other', JSON.stringify(marked(moved.ref)) === JSON.stringify(['gamma']) && JSON.stringify(marked(moved.copy)) === JSON.stringify(['gamma']), JSON.stringify(moved));
  d.done();
} catch (err) {
  ok(`no shared-rules test block threw (${err?.message || err})`, false, err?.stack || String(err));
}

/* ── make one copy match (builds/shared-rules-ux B1, B2, B6) ─────────── */
console.log('\nCompare copies: make one copy match');
{
  const RP = RICH.blocks.find((b) => b.id === 'review-policy');
  const WHY = 'This copy sits inside a longer paragraph, so the studio cannot tell exactly where the rule starts and ends. Change it by hand.';
  const fixable = (c) => (c.pack || c.rating === 'same' ? { ...c, canMatch: false, whyNot: null }
    : c.line === 103 ? { ...c, canMatch: false, whyNot: WHY } : { ...c, canMatch: true, whyNot: null });
  const state = { matched: false };
  const view = () => ({ blocks: [{ ...RP, copies: RP.copies.map(fixable).map((c) => (state.matched && c.line === 220 ? { ...c, rating: 'same', canMatch: false, note: null, text: RP_TEXT.trim() } : c)) }], scanned: RICH.scanned });
  const PREVIEW = { file: '~/.claude/skills/build/SKILL.md', line: 220, endLine: 230, removed: ['old line'], added: ['new line'], signature: 'f'.repeat(64),
    diff: [{ op: ' ', line: '<!-- block:review-policy sha256:aa -->' }, { op: '-', line: '1. The operator is involved only at merge.' }, { op: '+', line: '1. The operator is involved only at PR merge.' }] };
  const mcalls = [];
  let applyAnswer = () => { state.matched = true; return { saved: true, file: '~/.claude/skills/build/SKILL.md', line: 220, sha: 'abc', warnings: [], undo: 'The old version is in History (~/.agent-config-studio/history): open ~/.claude/skills/build/SKILL.md and choose History to put it back.' }; };
  const base = routesFor({
    'GET /api/blocks': () => view(),
    'POST /api/blocks/match/preview': (b) => { mcalls.push(['preview', b]); return PREVIEW; },
    'POST /api/blocks/match/apply': (b) => { mcalls.push(['apply', b]); return applyAnswer(b); },
  });
  const all = [];
  const routes = Object.assign(async (m, pth, b, u) => { all.push(`${m} ${pth}`); return base(m, pth, b, u); }, base);
  try {
    const p = await bootPage({ routes, hash: '#blocks/compare&rule=review-policy' });
    const c = p.$('content');
    const t = (n) => (n ? p.text(n) : '');
    await until(() => c.querySelector('.bb-cmp'));
    const sec = (line) => c.querySelectorAll('.bb-cmp').find((x) => new RegExp(`· lines? ${line}\\b`).test(t(x.querySelector('.bb-place'))));
    const btnIn = (n, label) => n?.querySelectorAll('button').find((b) => t(b) === label);
    ok('B1 a drifted copy of yours has a secondary "Make this copy match"', btnIn(sec(220), 'Make this copy match')?.className === 'btn' && btnIn(sec(65), 'Make this copy match')?.className === 'btn',
      [sec(220), sec(65)].map((x) => x?.innerHTML.slice(0, 200)).join(' | '));
    ok('B1 …a matching copy has none, and pack copies are not on the page to offer', !btnIn(sec(40), 'Make this copy match')
      && c.querySelectorAll('button').filter((b) => t(b) === 'Make this copy match').length === 2);
    ok('a copy that cannot be replaced exactly has no button, and one line saying why', !btnIn(sec(103), 'Make this copy match') && t(sec(103).querySelector('.bb-why')) === WHY, t(sec(103)));
    ok('no update-all button', !c.querySelectorAll('button').some((b) => /\ball\b/i.test(t(b))));
    all.length = 0;
    btnIn(sec(220), 'Make this copy match').click();
    await until(() => sec(220)?.querySelector('.bb-match .diff'));
    const box = sec(220).querySelector('.bb-match');
    ok('B2 clicking asks for a preview of that copy, as the scan named it, and writes nothing', JSON.stringify(mcalls) === JSON.stringify([['preview', { rule: 'review-policy', file: '~/.claude/skills/build/SKILL.md', line: 220, endLine: 230 }]])
      && !all.some((x) => /apply/.test(x)), JSON.stringify(mcalls));
    ok('B2 the preview sits under that copy: the file, and the lines removed and added', /~\/\.claude\/skills\/build\/SKILL\.md/.test(t(box)) && /lines 220–230/.test(t(box))
      && box.querySelectorAll('.diff-line.del').length === 1 && box.querySelectorAll('.diff-line.add').length === 1 && /involved only at merge/.test(t(box.querySelector('.diff-line.del')))
      && /only at PR merge/.test(t(box.querySelector('.diff-line.add'))), t(box));
    ok('B2 …with the real line numbers of the file', t(box.querySelector('.diff-line .n')) === '220', t(box.querySelector('.diff-line .n')));
    ok('B2 …saying the old file goes to History first', /History/.test(t(box)), t(box));
    ok('B2 …a primary "Make it match" and a quiet Cancel', /\bprimary\b/.test(btnIn(box, 'Make it match')?.className) && /\bghost\b/.test(btnIn(box, 'Cancel')?.className),
      box.querySelectorAll('button').map((b) => `${t(b)}:${b.className}`).join(' | '));
    ok('no fold, and every button styled', !c.querySelector('details, summary, [aria-expanded]') && c.querySelectorAll('button').every((b) => /\bbtn\b/.test(b.className)));
    btnIn(box, 'Cancel').click();
    await settle(10);
    ok('B2 Cancel drops the preview, writes nothing, and the button is back', !sec(220).querySelector('.bb-match') && !!btnIn(sec(220), 'Make this copy match')
      && mcalls.length === 1, JSON.stringify(mcalls));

    // A stale apply: refused, said so, Preview again.
    applyAnswer = () => { throw { status: 409, body: { error: 'The file changed since the preview. Nothing was written; preview it again.' } }; };
    btnIn(sec(220), 'Make this copy match').click();
    await until(() => btnIn(sec(220)?.querySelector('.bb-match'), 'Make it match'));
    btnIn(sec(220).querySelector('.bb-match'), 'Make it match').click();
    await until(() => /changed since the preview/.test(t(sec(220)?.querySelector('.bb-match'))));
    const st = sec(220).querySelector('.bb-match');
    ok('a stale apply says the file changed and nothing was written', /The file changed since the preview\. Nothing was written/.test(t(st)), t(st));
    ok('…offers a secondary Preview again, and no Make it match', btnIn(st, 'Preview again')?.className === 'btn' && !btnIn(st, 'Make it match'), st.querySelectorAll('button').map((b) => `${t(b)}:${b.className}`).join(' | '));
    ok('…and the apply carried the preview\'s signature', mcalls.at(-1)[0] === 'apply' && mcalls.at(-1)[1].signature === 'f'.repeat(64), JSON.stringify(mcalls.at(-1)));
    mcalls.length = 0;
    btnIn(st, 'Preview again').click();
    await until(() => btnIn(sec(220)?.querySelector('.bb-match'), 'Make it match'));
    ok('Preview again asks for a fresh preview', mcalls.length === 1 && mcalls[0][0] === 'preview', JSON.stringify(mcalls));

    // Apply: the page checks again and the copy shows as the same.
    applyAnswer = (b) => { state.matched = true; return { saved: true, file: b.file, line: 220, sha: 'abc', warnings: [], undo: 'The old version is in History (~/.agent-config-studio/history): open ~/.claude/skills/build/SKILL.md and choose History to put it back.' }; };
    all.length = 0;
    btnIn(sec(220).querySelector('.bb-match'), 'Make it match').click();
    await until(() => c.querySelector('.bb-result'));
    await until(() => sec(220)?.querySelector('.bb-same'));
    ok('B6 after the write the page checks again (GET /api/blocks)', all.includes('POST /api/blocks/match/apply') && all.indexOf('GET /api/blocks') > all.indexOf('POST /api/blocks/match/apply'), all.join(', '));
    ok('B6 …and that copy now shows as the same, with no button', t(sec(220).querySelector('.bb-rating')) === 'Matches' && !!sec(220).querySelector('.bb-same') && !btnIn(sec(220), 'Make this copy match'), t(sec(220)));
    ok('B3 the result line names the file and how to undo', /~\/\.claude\/skills\/build\/SKILL\.md/.test(t(c.querySelector('.bb-result'))) && /History/.test(t(c.querySelector('.bb-result'))),
      t(c.querySelector('.bb-result')));
    ok('the page stays on Compare for that rule', p.eval('S.view') === 'blocks-compare' && p.location.hash === '#blocks/compare&rule=review-policy');
    ok('no "marked" in the page\'s own words', !/\bmarked\b/i.test(c.querySelectorAll('.bb-cmp-intro, .bb-why, .bb-match p, .bb-result').map(t).join(' ')));
    ok('no page errors', p.errors.length === 0, p.errors.join(' | '));
    p.done();
  } catch (err) {
    ok(`no make-it-match test block threw (${err?.message || err})`, false, err?.stack || String(err));
  }
}

/* ── Preview again after the copy moved (review f3) ─────────────────── */
console.log('\nCompare copies: Preview again checks again first');
{
  const RP = RICH.blocks.find((b) => b.id === 'review-policy');
  const state = { moved: false };
  const copies = () => RP.copies.filter((c) => !c.pack && c.line === 220).map((c) => ({ ...c, canMatch: true, whyNot: null, ...(state.moved ? { line: 223, endLine: 233 } : {}) }));
  const view = () => ({ blocks: [{ ...RP, copies: copies() }], scanned: RICH.scanned });
  const seen = [];
  const base = routesFor({
    'GET /api/blocks': () => view(),
    'POST /api/blocks/match/preview': (b) => {
      seen.push(['preview', b.line]);
      if (b.line !== (state.moved ? 223 : 220)) throw { status: 409, body: { error: 'This copy is not where it was: the file changed. Check again.' } };
      return { file: b.file, line: b.line, endLine: b.endLine, removed: ['a'], added: ['b'], signature: 'e'.repeat(64), diff: [{ op: '-', line: 'a' }, { op: '+', line: 'b' }] };
    },
    'POST /api/blocks/match/apply': () => { seen.push(['apply']); throw { status: 409, body: { error: 'The file changed since the preview. Nothing was written; preview it again.' } }; },
  });
  const routes = Object.assign(async (m, pth, b, u) => { seen.push([`${m} ${pth}`]); return base(m, pth, b, u); }, base);
  try {
    const p = await bootPage({ routes, hash: '#blocks/compare&rule=review-policy' });
    const c = p.$('content');
    const t = (n) => (n ? p.text(n) : '');
    const btn = (label) => c.querySelectorAll('button').find((b) => t(b) === label);
    await until(() => btn('Make this copy match'));
    btn('Make this copy match').click();
    await until(() => btn('Make it match'));
    state.moved = true;
    btn('Make it match').click();
    await until(() => btn('Preview again'));
    seen.length = 0;
    btn('Preview again').click();
    await until(() => btn('Make it match'));
    const order = seen.map((x) => x[0]);
    ok('f3 Preview again checks again (GET /api/blocks) before it previews', order.indexOf('GET /api/blocks') > -1 && order.indexOf('GET /api/blocks') < order.lastIndexOf('preview'), JSON.stringify(seen));
    ok('f3 …and previews the copy where it is now, not at its old lines', seen.filter((x) => x[0] === 'preview').at(-1)?.[1] === 223 && /lines 223–233/.test(t(c.querySelector('.bb-match'))), JSON.stringify(seen));
    ok('no page errors', p.errors.length === 0, p.errors.join(' | '));
    p.done();
  } catch (err) {
    ok(`no Preview again test block threw (${err?.message || err})`, false, err?.stack || String(err));
  }
}

/* ── browser QA fixes: one line's grammar, Cancel after a refusal ────── */
console.log('\nCompare copies: QA fixes');
{
  const RP = RICH.blocks.find((b) => b.id === 'review-policy');
  const view = () => ({ blocks: [{ ...RP, copies: RP.copies.filter((c) => c.line === 220).map((c) => ({ ...c, canMatch: true, whyNot: null })) }], scanned: RICH.scanned });
  let answer = (b) => ({ file: b.file, line: 7, endLine: 7, removed: ['a'], added: ['b'], signature: 'd'.repeat(64), diff: [{ op: '-', line: 'a' }, { op: '+', line: 'b' }] });
  const seen = [];
  const base = routesFor({ 'GET /api/blocks': () => view(), 'POST /api/blocks/match/preview': (b) => answer(b) });
  const routes = Object.assign(async (m, pth, b, u) => { seen.push(`${m} ${pth}`); return base(m, pth, b, u); }, base);
  try {
    const p = await bootPage({ routes, hash: '#blocks/compare&rule=review-policy' });
    const c = p.$('content');
    const t = (n) => (n ? p.text(n) : '');
    const btn = (label) => c.querySelectorAll('button').find((b) => t(b) === label);
    await until(() => btn('Make this copy match'));
    btn('Make this copy match').click();
    await until(() => btn('Make it match'));
    ok('QA a one-line preview says "line 7 becomes"', /, line 7 becomes the reference version:/.test(t(c.querySelector('.bb-match'))), t(c.querySelector('.bb-match')));
    btn('Cancel').click();
    await settle(10);
    answer = () => { throw { status: 409, body: { error: 'This copy is not where it was: the file changed. Preview it again.' } }; };
    btn('Make this copy match').click();
    await until(() => btn('Preview again'));
    seen.length = 0;
    btn('Cancel').click();
    await until(() => seen.includes('GET /api/blocks') && btn('Make this copy match'));
    ok('QA Cancel after a refused preview checks again, so the copy\'s lines are current', seen.includes('GET /api/blocks') && !c.querySelector('.bb-match'), seen.join(', '));
    ok('no page errors', p.errors.length === 0, p.errors.join(' | '));
    p.done();
  } catch (err) {
    ok(`no QA-fix test block threw (${err?.message || err})`, false, err?.stack || String(err));
  }
  const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const bb = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /\.bb-/.test(m[1]));
  const px = bb.flatMap((m) => [...m[2].matchAll(/font(?:-size)?\s*:\s*[^;]*?(\d+(?:\.\d+)?)px/g)].map((x) => [m[1].trim(), Number(x[1])]));
  ok('QA nothing on the Shared rules pages is under 12px, the file path under each copy included', px.length > 5 && px.every(([, n]) => n >= 12)
    && px.some(([sel]) => sel === '.bb-path'), px.filter(([, n]) => n < 12).map((x) => x.join(' ')).join(' | '));
  const sameSec = bb.filter((m) => m[1].split(',').some((x) => x.trim() === '.bb-cmp.bb-same')).map((m) => m[2]).join(';');
  ok('QA a matching copy\'s section keeps the gap below it that the other sections have', /margin\s*:\s*0 0 14px/.test(sameSec), sameSec);
}

/* ── static: the view only reads; its colours are the theme's ────────── */
console.log('\nstatic: blocks-view.js and its styles');
{
  const src = fs.readFileSync(path.join(PUB, 'blocks-view.js'), 'utf8');
  const apiCalls = [...src.matchAll(/api\(\s*'([A-Z]+)'\s*,\s*'([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`);
  ok('blocks-view.js calls the API three ways: GET /api/blocks, and the preview and apply of making one copy match', JSON.stringify(apiCalls) === JSON.stringify(['GET /api/blocks', 'POST /api/blocks/match/preview', 'POST /api/blocks/match/apply']), apiCalls.join(', '));
  ok('…and has no other way out: no fetch, form, XHR or beacon', !/\bfetch\(|XMLHttpRequest|sendBeacon|<form|\.submit\(/.test(src));
  const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const bb = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /\.bb-/.test(m[1]));
  ok('the page has its styles', bb.length > 5);
  const literal = bb.filter((m) => /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(m[2]));
  ok('every colour on the page is a theme token, so light and dark both hold the studio\'s contrast', literal.length === 0, literal.map((m) => m[1].trim()).join(' | '));
  const colours = bb.flatMap((m) => [...m[2].matchAll(/(?:^|;)\s*(?:color|background|border(?:-left)?)\s*:\s*([^;]+)/g)].map((x) => x[1].trim()));
  const themeBlock = (sel) => (css.match(new RegExp(`${sel.replace(/[[\]"]/g, '\\$&')}\\s*\\{([^}]*)\\}`)) || [, ''])[1];
  const dark = themeBlock(':root'), light = themeBlock(':root[data-theme="light"]');
  const tokens = [...new Set(colours.flatMap((v) => [...v.matchAll(/var\((--[\w-]+)\)/g)].map((x) => x[1])))];
  const unset = tokens.filter((tok) => !new RegExp(`${tok}\\s*:`).test(dark) || !new RegExp(`${tok}\\s*:`).test(light));
  ok('…and each colour token is set for both the dark and the light theme', tokens.length > 4 && light.length > 100 && unset.length === 0, `${tokens.join(' ')} | unset: ${unset.join(' ')}`);
  // QA, light theme: the base .md code (0.855em of the block's 13px, --accent) read 4.89:1 at 11.1px.
  const code = bb.filter((m) => m[1].split(',').some((sel) => /\.bb-text\s+code\s*$/.test(sel.trim())));
  const px = code.flatMap((m) => [...m[2].matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/g)].map((x) => Number(x[1])));
  ok('inline code in block text is 12px or larger, in the darker accent ink', px.length > 0 && Math.min(...px) >= 12
    && code.some((m) => /color\s*:\s*var\(--accent-ink\)/.test(m[2])), code.map((m) => m[0].trim()).join(' | '));
  const ruleColour = (cls) => (bb.find((m) => m[1].trim() === `.bb-rating-${cls}`) || [, , ''])[2];
  ok('A3 only Big changes takes the warning colour; Small changes and Matches are calm', /var\(--amber-ink\)/.test(ruleColour('differs'))
    && !/--(amber|red)/.test(ruleColour('reworded')) && !/--(amber|red)/.test(ruleColour('same')), ['differs', 'reworded', 'same'].map(ruleColour).join(' | '));
  const rule = (sel) => bb.filter((m) => m[1].split(',').some((x) => x.trim() === sel)).map((m) => m[2]).join(';');
  ok('QA "Only in this copy" is not underlined like a link: a tint and a border, in the body text colour', !/text-decoration\s*:[^;]*underline/.test(rule('.bb-only'))
    && /background\s*:/.test(rule('.bb-only')) && /(?:^|;)\s*border\s*:/.test(rule('.bb-only')) && /color\s*:\s*var\(--text\)/.test(rule('.bb-missing, .bb-only') + rule('.bb-only')),
    rule('.bb-only'));
  ok('QA …and "Missing from this copy" stays distinct: struck through, its own tint', /line-through/.test(rule('.bb-missing')) && /--red/.test(rule('.bb-missing')) && !/--red/.test(rule('.bb-only')), rule('.bb-missing'));
  ok('QA the reference text lines up with the card: no centred margin or width cap from .md', /margin\s*:\s*0\b/.test(rule('.bb-text')) && /max-width\s*:\s*none/.test(rule('.bb-text')), rule('.bb-text'));
  const fontPx = bb.flatMap((m) => [...m[2].matchAll(/font(?:-size)?\s*:\s*[^;]*?(\d+(?:\.\d+)?)px/g)].map((x) => [m[1].trim(), Number(x[1])]));
  ok('A6 nothing on the page is under 11px', fontPx.length > 5 && fontPx.every(([, n]) => n >= 11), fontPx.filter(([, n]) => n < 11).map((x) => x.join(' ')).join(' | '));
  const cc = fs.readFileSync(path.join(path.dirname(PUB), 'blocks', 'callback-contract.md'), 'utf8').match(/^summary: (.*)$/m)?.[1] || '';
  ok('the callback contract\'s summary reads as a sentence (no ", and that")', cc.length > 20 && !/, and that\b/.test(cc), cc);
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  ok('index.html loads blocks-view.js before app.js', html.indexOf('/blocks-view.js') > 0 && html.indexOf('/blocks-view.js') < html.indexOf('/app.js'));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
