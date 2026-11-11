/**
 * The Shared rules page (builds/building-blocks-page C1–C4, builds/shared-rules-page
 * A1–A6), in the fake DOM against stubbed routes: under Workflows in the sidebar,
 * each rule with its reference text and every copy's place and rating, no fold,
 * every button one of the three kinds, and the only request the page makes is GET /api/blocks.
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
    /\(Claude, global\)/.test(t(rows[2].querySelector('.bb-place'))) && / skill \(Claude\)/.test(t(rows[0].querySelector('.bb-place'))) && !rp.querySelector('.bb-kind'),
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

/* ── static: the view only reads; its colours are the theme's ────────── */
console.log('\nstatic: blocks-view.js and its styles');
{
  const src = fs.readFileSync(path.join(PUB, 'blocks-view.js'), 'utf8');
  const apiCalls = [...src.matchAll(/api\(\s*'([A-Z]+)'\s*,\s*'([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`);
  ok('blocks-view.js calls the API once, GET /api/blocks', JSON.stringify(apiCalls) === JSON.stringify(['GET /api/blocks']), apiCalls.join(', '));
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
  const cc = fs.readFileSync(path.join(path.dirname(PUB), 'blocks', 'callback-contract.md'), 'utf8').match(/^summary: (.*)$/m)?.[1] || '';
  ok('the callback contract\'s summary reads as a sentence (no ", and that")', cc.length > 20 && !/, and that\b/.test(cc), cc);
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  ok('index.html loads blocks-view.js before app.js', html.indexOf('/blocks-view.js') > 0 && html.indexOf('/blocks-view.js') < html.indexOf('/app.js'));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
