/**
 * The Skills page with skills on it (builds/ui-clarity, the Skills page bug of
 * 2026-11-06): QA's seeded home had none, so this layout was never drawn. In
 * the fake DOM against stubbed routes: the usage caveat sits inside the closed
 * Details fold — only an error reading usage shows outside it — the fold is
 * not part of the toolbar, and the top bar's subtitle is marked as a path
 * only on a file. No server, no HOME.
 */
import { bootPage, routesFor, settle, PATHS } from './fixtures/shell-page.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\nskills page');
const CAVEAT = 'Counted by skill NAME from Claude Code transcripts only — No observations means UNKNOWN, not unused.';
const skill = (id, name, source, extra = {}) => ({ id, displayName: name, source, sourceLabel: source, files: 1, totalBytes: 512, description: `${name} does a thing.`,
  paths: [`/h/.claude/skills/${name}/SKILL.md`], display: `~/.claude/skills/${name}`, ...extra });
const skills = (usage) => () => ({ skills: [
  skill('a', 'review-helper', 'claude-global', { usage: { count: 3, lastSeen: new Date().toISOString(), sharedWith: 2 } }),
  skill('b', 'never-used', 'claude-global', { usage: { count: 0 } }),
  skill('c', 'review-helper', 'codex-global', { usage: { count: 3, lastSeen: new Date().toISOString(), sharedWith: 2 } }),
], usage });

try {
  const p = await bootPage({ routes: routesFor({ 'GET /api/skills': skills({ available: true, caveat: { text: CAVEAT } }) }), hash: '#skills' });
  await settle(20);
  const c = p.$('content');
  const caveatHome = c.querySelectorAll('*').filter((n) => n.childNodes.some((t) => t.nodeType === 3 && /Counted by skill NAME/.test(t.textContent)));
  const fold = caveatHome[0]?.closest('details');
  ok('the usage caveat is on the page once', caveatHome.length === 1, `${caveatHome.length}`);
  ok('…inside a Details fold that starts closed', !!fold && !fold.hasAttribute('open') && fold.classList.contains('more'), fold?.outerHTML?.slice(0, 120));
  ok('…and no caveat banner sits outside the fold', !c.querySelector('.sk-caveat') || !!c.querySelector('.sk-caveat').closest('details'));
  ok('the fold is not part of the toolbar: not inside the head that holds New skill', !c.querySelector('.sw-head details') && !!c.querySelector('.sw-head .sk-new'));
  ok('the rows still say an unseen skill is unknown, not unused (the caveat travels with the data)', /unknown, not unused/i.test(p.text(c)) || /no recorded use/.test(p.text(c)), p.text(c).slice(0, 400));
  ok('the top bar subtitle is a sentence here, not marked as a path', !p.$('title-path').classList.contains('is-path'));
  ok('no page errors', p.errors.length === 0, p.errors.join(' | '));
  p.done();

  // Usage could not be read: that error is not fine print — it stays outside the fold.
  const q = await bootPage({ routes: routesFor({ 'GET /api/skills': skills({ available: false, reason: 'transcripts unreadable', caveat: { text: CAVEAT } }) }), hash: '#skills' });
  await settle(20);
  const err = q.$('content').querySelectorAll('*').find((n) => n.childNodes.some((t) => t.nodeType === 3 && /Usage could not be read/.test(t.textContent)));
  ok('an error reading usage shows outside the fold', !!err && !err.closest('details'), q.text(q.$('content')).slice(0, 300));
  q.done();

  // On a file, the subtitle is its path: monospace there only.
  const f = await bootPage({ hash: `#file=${encodeURIComponent(PATHS.claudeMd)}` });
  for (let i = 0; i < 60 && f.eval('S.view') !== 'entry'; i++) await settle(5);
  ok('on a file, the top bar subtitle is marked as a path', f.$('title-path').classList.contains('is-path'), f.eval('S.view'));
  f.done();
} catch (e) {
  ok(`no test block threw (${e?.message || e})`, false, e?.stack || String(e));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
