/**
 * The Audit view (builds/skills-audit A6, the deterministic parts) in the
 * fake DOM against stubbed routes: findings grouped by file, Fix showing the
 * diff and writing only on Accept, Dismiss persisting across a reload, the
 * synced acknowledgement, findings-only classes, the vendor filter, the
 * partial and policy banners, Home's line and Setup's offer, and the view's
 * colours coming from the theme tokens. No server, no HOME.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootPage, routesFor, settle } from './fixtures/shell-page.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\naudit ui');

const finding = (id, over = {}) => ({ id, rule: 'D2', severity: 'warn', line: 3, col: 15, match: 'old-id-1', message: `message ${id}`, fixable: true, replacement: '"$(model-id sol || echo MODEL-ID-UNRESOLVED-sol)"', dismissed: false, ...over });
const file = (ref, display, cls, findings, over = {}) => ({ ref, display, cls, kind: 'skill', skill: display.split('/').at(-2), aliases: 0, copies: [], findings, ...over });
const counts = (files) => {
  const byClass = Object.fromEntries(['user', 'synced', 'readonly', 'plugin', 'vendor'].map((c) => [c, { files: 0, findings: 0, fixable: 0 }]));
  let findings = 0, fixable = 0;
  for (const f of files) {
    byClass[f.cls].files++;
    for (const x of f.findings.filter((y) => !y.dismissed)) {
      byClass[f.cls].findings++;
      if (x.fixable) byClass[f.cls].fixable++;
      if (f.cls !== 'vendor') { findings++; if (x.fixable) fixable++; }
    }
  }
  return { files: files.length, findings, fixable, skipped: { tooLarge: 0, binary: 0, backup: 0 }, refused: 0, byClass };
};
function auditState(over = {}) {
  const files = [
    file('a'.repeat(16), '~/.claude/skills/alpha/SKILL.md', 'user', [finding('1'.repeat(16)), finding('2'.repeat(16), { rule: 'D1', severity: 'info', match: 'x', fixable: false, replacement: undefined, message: 'a note' })],
      { copies: [{ ref: 'c'.repeat(16), display: '~/Projects/app/.claude/skills/alpha/SKILL.md', cls: 'user' }] }),
    file('b'.repeat(16), '~/.claude/skills/synced/u/beta/SKILL.md', 'synced', [finding('3'.repeat(16))]),
    file('d'.repeat(16), '~/.claude/plugins/cache/m/p/1.0.0/skills/p1/SKILL.md', 'plugin', [finding('4'.repeat(16), { fixable: false })]),
    file('e'.repeat(16), '~/.codex/skills/.system/vend/SKILL.md', 'vendor', [finding('5'.repeat(16), { fixable: false })]),
    file('f'.repeat(16), 'Client/CLAUDE.md', 'readonly', [finding('6'.repeat(16), { fixable: false })], { kind: 'instruction', skill: undefined, scope: 'root' }),
  ];
  const st = { dismissed: new Set(), files, partial: false, partialReasons: [], policyError: null, accepted: 0, ...over };
  st.result = () => {
    const fs_ = st.files.map((f) => ({ ...f, findings: f.findings.map((x) => ({ ...x, dismissed: st.dismissed.has(x.id) })) }));
    return { scannedAt: 1, run: 1, partial: st.partial, partialReasons: st.partialReasons, policyError: st.policyError, counts: counts(fs_), refusals: [], files: fs_ };
  };
  return st;
}
const CURRENT = '---\nname: alpha\n---\ncodex exec -m old-id-1 "x"\n';
const PROPOSED = '---\nname: alpha\n---\ncodex exec -m "$(model-id sol || echo MODEL-ID-UNRESOLVED-sol)" "x"\n';
const auditRoutes = (st, extra = {}) => routesFor({
  'GET /api/audit': () => st.result(),
  'GET /api/audit/summary': () => st.summary || { state: 'ok', findings: 3, fixable: 2, scannedAt: 1, stale: false },
  'POST /api/audit/propose': (b) => {
    if (st.refuse) throw st.refuse;
    return { id: '9'.repeat(32), fileRef: b.fileRef, path: st.files.find((f) => f.ref === b.fileRef).display, cls: st.files.find((f) => f.ref === b.fileRef).cls,
      fixes: b.findingIds.length, base: 'sha256:x', current: CURRENT, proposed: PROPOSED, expiresAt: 0, copies: st.files.find((f) => f.ref === b.fileRef).copies.length };
  },
  'POST /api/audit/accept': () => { st.accepted++; return { saved: true, path: '~/.claude/skills/alpha/SKILL.md', sha: 'abc', warnings: [], historyError: null }; },
  'POST /api/audit/reject': () => ({ rejected: true }),
  'POST /api/audit/dismiss': (b) => { st.dismissed.add(b.id); return { dismissed: true, id: b.id }; },
  'POST /api/audit/undismiss': (b) => { st.dismissed.delete(b.id); return { dismissed: false, id: b.id }; },
  ...extra,
});

const pages = [];
async function boot(routes, { hash = '#audit', storage } = {}) {
  const p = await bootPage({ routes, hash, storage });
  await settle(30);
  pages.push(p);
  return p;
}
const txt = (n) => n.textContent.replace(/\s+/g, ' ').trim();
const cards = (p) => p.$('content').querySelectorAll('.audit-file');
const card = (p, ref) => cards(p).find((c) => c.dataset.ref === ref);
const button = (root, text) => root?.querySelectorAll('button').find((b) => txt(b) === text);
const posts = (p, route) => p.requests.filter((r) => r.method === 'POST' && r.path === route);

// ── grouped by file, classes, filters ──────────────────────────────────────
{
  const st = auditState();
  const p = await boot(auditRoutes(st));
  ok('the Audit view opens from #audit, with its sidebar item', p.eval('S.view') === 'audit' && !!p.$('btn-audit'));
  ok('one card per file; vendor is hidden by default', cards(p).length === 4 && !card(p, 'e'.repeat(16)), cards(p).map((c) => c.dataset.ref[0]).join());
  const a = card(p, 'a'.repeat(16));
  ok('a card shows the display path, its class and its findings', /~\/\.claude\/skills\/alpha\/SKILL\.md/.test(txt(a)) && txt(a.querySelector('.audit-class')) === 'yours' && a.querySelectorAll('.audit-finding').length === 2);
  ok('…each finding with its rule, line, match and message', /Model flag/.test(txt(a)) && /line 3/.test(txt(a)) && /old-id-1/.test(txt(a)) && /message 1111/.test(txt(a)));
  ok('…the fix it would make', /Fix: "\$\(model-id sol \|\| echo MODEL-ID-UNRESOLVED-sol\)"/.test(txt(a)));
  ok('…and its identical copies, saying a fix changes this file only', /Also in 1 identical copy: ~\/Projects\/app\/\.claude\/skills\/alpha\/SKILL\.md\. A fix changes this file only\./.test(txt(a)));
  ok('Fix counts only the fixable findings', !!button(a, 'Fix 1'));
  ok('the summary says what is hidden', /5 findings · 2 fixable · 1 in vendor files, hidden/.test(txt(p.$('content').querySelector('.audit-summary'))), txt(p.$('content').querySelector('.audit-summary')));
  const plugin = card(p, 'd'.repeat(16));
  ok('plugin findings show no Fix button, and say why', !plugin.querySelector('.audit-fix') && /Findings only: this file belongs to a plugin/.test(txt(plugin)));
  const ro = card(p, 'f'.repeat(16));
  ok('read-only findings show no Fix button', !ro.querySelector('.audit-fix') && /read-only folder/.test(txt(ro)));
  const vendor = p.$('content').querySelector('.audit-show-vendor input');
  vendor.checked = true; vendor.onchange();
  await settle(5);
  ok('Show vendor brings the vendor card, findings only', !!card(p, 'e'.repeat(16)) && !card(p, 'e'.repeat(16)).querySelector('.audit-fix') && /ships with the CLI/.test(txt(card(p, 'e'.repeat(16)))));
  ok('…and the choice is remembered', p.store.get('acs.audit.vendor') === '1');
}

// ── Fix: the diff first, a write only on Accept ─────────────────────────────
{
  const st = auditState();
  const p = await boot(auditRoutes(st));
  button(card(p, 'a'.repeat(16)), 'Fix 1').click();
  await settle(10);
  const prop = posts(p, '/api/audit/propose');
  ok('Fix proposes exactly the fixable findings of that file', prop.length === 1 && prop[0].body.fileRef === 'a'.repeat(16) && JSON.stringify(prop[0].body.findingIds) === JSON.stringify(['1'.repeat(16)]) && !('ackSync' in prop[0].body));
  const a = card(p, 'a'.repeat(16));
  ok('…the full diff is shown', !!a.querySelector('.audit-proposal .diff') && /\+ codex exec -m "\$\(model-id sol/.test(txt(a.querySelector('.diff'))) && /- codex exec -m old-id-1/.test(txt(a.querySelector('.diff'))));
  ok('…saying the copy is not changed', /The other 1 identical copy is not changed\./.test(txt(a)));
  ok('…and nothing is written yet', posts(p, '/api/audit/accept').length === 0);
  button(a, 'Cancel').click();
  await settle(10);
  ok('Cancel rejects the proposal and writes nothing', posts(p, '/api/audit/reject').length === 1 && posts(p, '/api/audit/accept').length === 0 && !card(p, 'a'.repeat(16)).querySelector('.audit-proposal'));
  button(card(p, 'a'.repeat(16)), 'Fix 1').click();
  await settle(10);
  button(card(p, 'a'.repeat(16)), 'Accept').click();
  await settle(20);
  ok('Accept writes, says so, and runs the audit again', st.accepted === 1 && /Fixed ~\/\.claude\/skills\/alpha\/SKILL\.md\./.test(p.text(p.$('notice-slot'))) && p.requests.some((r) => r.path === '/api/audit' && r.search === '?refresh=1'));
  const refused = auditState({ refuse: { status: 409, body: { error: 'Some of those findings are no longer in the file. Run the audit again.' } } });
  const q = await boot(auditRoutes(refused));
  button(card(q, 'a'.repeat(16)), 'Fix 1').click();
  await settle(20);
  ok('a refused propose shows the reason and runs the audit again', /no longer in the file/.test(q.text(q.$('notice-slot'))) && q.requests.some((r) => r.path === '/api/audit' && r.search === '?refresh=1'));
}

// ── synced: the acknowledgement ───────────────────────────────────────────
{
  const st = auditState();
  const p = await boot(auditRoutes(st));
  const s = card(p, 'b'.repeat(16));
  ok('a synced file warns that the next sync overwrites a fix', /This skill is synced: the next sync overwrites a fix here\./.test(txt(s)));
  ok('…and Fix waits for the acknowledgement', button(s, 'Fix 1').disabled === true);
  const ack = s.querySelector('.audit-ack input');
  ack.checked = true; ack.onchange();
  await settle(5);
  button(card(p, 'b'.repeat(16)), 'Fix 1').click();
  await settle(10);
  const prop = posts(p, '/api/audit/propose');
  ok('…then the proposal carries ackSync: true', prop.length === 1 && prop[0].body.ackSync === true);
  ok('…and the diff repeats the warning', /Synced skill: the next sync overwrites this\./.test(txt(card(p, 'b'.repeat(16)))));
}

// ── Dismiss persists across a reload ───────────────────────────────────────
{
  const st = auditState();
  const routes = auditRoutes(st);
  const p = await boot(routes);
  const row = card(p, 'a'.repeat(16)).querySelectorAll('.audit-finding').find((r) => r.dataset.id === '1'.repeat(16));
  button(row, 'Dismiss').click();
  await settle(10);
  ok('Dismiss posts the finding id', posts(p, '/api/audit/dismiss').length === 1 && posts(p, '/api/audit/dismiss')[0].body.id === '1'.repeat(16));
  ok('…hides it, and the counts follow', !card(p, 'a'.repeat(16)).querySelectorAll('.audit-finding').some((r) => r.dataset.id === '1'.repeat(16)) && /4 findings · 1 fixable/.test(txt(p.$('content').querySelector('.audit-summary'))));
  ok('…and Fix goes with it', !card(p, 'a'.repeat(16)).querySelector('.audit-fix'));
  const again = await boot(routes);
  ok('after a reload it is still dismissed', !card(again, 'a'.repeat(16)).querySelectorAll('.audit-finding').some((r) => r.dataset.id === '1'.repeat(16)));
  const show = again.$('content').querySelector('.audit-show-dismissed input');
  show.checked = true; show.onchange();
  await settle(5);
  const back = card(again, 'a'.repeat(16)).querySelectorAll('.audit-finding').find((r) => r.dataset.id === '1'.repeat(16));
  ok('Show dismissed brings it back, marked, with Undismiss', back && back.classList.contains('dismissed') && !!button(back, 'Undismiss'));
  button(back, 'Undismiss').click();
  await settle(10);
  ok('Undismiss posts it', posts(again, '/api/audit/undismiss').length === 1 && !st.dismissed.has('1'.repeat(16)));
}

// ── banners, refusals, errors ─────────────────────────────────────────────
{
  const st = auditState({ partial: true, partialReasons: ['stopped at 2000 files'], policyError: 'models: ~/.agent-config-studio/models.json: unknown family "x"' });
  const p = await boot(auditRoutes(st));
  ok('a partial audit says so, with the reason', /This audit is partial: stopped at 2000 files\./.test(txt(p.$('content').querySelector('.audit-partial'))));
  ok('an invalid registry is a banner naming the error', /stale ids, efforts and fixes are not checked/.test(txt(p.$('content').querySelector('.audit-policy'))) && /unknown family "x"/.test(txt(p.$('content').querySelector('.audit-policy'))));
  const q = await boot(auditRoutes(auditState(), { 'GET /api/audit': () => { throw { status: 403, body: { error: 'cross-origin requests are not accepted' } }; } }));
  ok('a failed run shows the error', /The audit could not run: cross-origin requests are not accepted/.test(txt(q.$('content'))));
}

// ── Home's line ───────────────────────────────────────────────────────────
{
  const at = (summary) => { const st = auditState(); st.summary = summary; return auditRoutes(st); };
  const attention = (p) => txt(p.$('content').querySelector('.home-attention'));
  const p = await boot(at({ state: 'ok', findings: 4, fixable: 2, scannedAt: 1, stale: false }), { hash: '#home' });
  await settle(30);
  ok('Home counts the fixable findings, from the summary', /2 fixable audit findings in skills and instruction files/.test(attention(p)), attention(p));
  ok('…and never runs the audit itself', !p.requests.some((r) => r.path === '/api/audit') && p.requests.some((r) => r.path === '/api/audit/summary'));
  ok('…with the Needs-you chip counting it', /Needs you: \d/.test(p.text(p.$('title'))));
  button(p.$('content').querySelector('.home-attention'), 'Review').click();
  await settle(20);
  ok('…and Review opens the Audit view', p.eval('S.view') === 'audit');
  const n = await boot(at({ state: 'not-audited' }), { hash: '#home' });
  await settle(30);
  ok('not audited yet → said quietly, with a way in', /Skills and instruction files: not audited yet\./.test(attention(n)) && !!button(n.$('content').querySelector('.home-attention'), 'Audit'));
  const s = await boot(at({ state: 'ok', findings: 4, fixable: 2, scannedAt: 1, stale: true }), { hash: '#home' });
  await settle(30);
  ok('a stale count says it is as of the last audit', /\(as of the last audit\)/.test(attention(s)));
  const pa = await boot(at({ state: 'partial', findings: 0, fixable: 0, scannedAt: 1, stale: false }), { hash: '#home' });
  await settle(30);
  ok('a partial audit with nothing fixable says it was partial', /The last audit was partial/.test(attention(pa)));
}

// ── Setup's offer, only once done is recorded ─────────────────────────────
{
  const at = async (state) => {
    const st = auditState();
    const setup = { state };
    const routes = auditRoutes(st, {
      'GET /api/setup/status': () => setup,
      'POST /api/setup/complete': (b) => { setup.state = b.completed; return setup; },
      'GET /api/setup/clis': () => ({ clis: [], acsOnPath: true, next: [] }),
      'GET /api/roots': () => ({ state: 'ok', error: null, roots: [], invalid: [] }),
    });
    const p = await boot(routes, { hash: '#setup' });
    p.eval("setupGo('done')");
    await settle(20);
    return { p, setup };
  };
  const first = await at('none');
  ok('a first run\'s Done step makes no audit offer: done is not recorded yet', !first.p.$('content').querySelector('.setup-audit'));
  const again = await at('done');
  const offer = again.p.$('content').querySelector('.setup-audit');
  ok('with done recorded (Run setup again), the Done step offers to audit the skills', offer && /Audit your 1 skill and instruction files/.test(txt(offer)), offer && txt(offer));
  const nav = [...again.p.$('content').querySelector('.setup-nav').querySelectorAll('button')].map(txt);
  ok('…without changing the step nav', JSON.stringify(nav) === JSON.stringify(['Back', 'Finish']));
  button(offer, 'Open Audit').click();
  await settle(30);
  ok('…Open Audit opens the view and writes nothing to setup', again.p.eval('S.view') === 'audit' && again.p.location.hash === '#audit' && !again.p.requests.some((r) => r.path === '/api/setup/complete'));
}

// ── Cancel resolving after you left the view ──────────────────────────────
{
  const st = auditState();
  let release;
  const held = new Promise((r) => { release = r; });
  const p = await boot(auditRoutes(st, { 'POST /api/audit/reject': async () => { await held; return { rejected: true }; } }));
  button(card(p, 'a'.repeat(16)), 'Fix 1').click();
  await settle(10);
  button(card(p, 'a'.repeat(16)), 'Cancel').click();
  await settle(5);
  p.eval("viewById('home').open()");
  await settle(10);
  release();
  await settle(20);
  ok('a Cancel that lands after you went to Home does not paint Audit over Home', p.eval('S.view') === 'home' && !!p.$('content').querySelector('.home') && !p.$('content').querySelector('.audit'));
  const q = await boot(auditRoutes(auditState(), { 'POST /api/audit/dismiss': async (b) => { await new Promise((r) => setTimeout(r, 30)); return { dismissed: true, id: b.id }; } }));
  button(card(q, 'a'.repeat(16)).querySelectorAll('.audit-finding')[0], 'Dismiss').click();
  q.eval("viewById('home').open()");
  await settle(60);
  ok('…nor does a Dismiss', q.eval('S.view') === 'home' && !q.$('content').querySelector('.audit'));
}

// ── light and dark ────────────────────────────────────────────────────────
{
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const block = css.slice(css.indexOf('/* ── audit view'));
  ok('the Audit view\'s colours all come from the theme tokens (both themes)', block.length > 200 && !/#[0-9a-f]{3,8}\b|rgb\(/i.test(block));
  const st = auditState();
  const p = await boot(auditRoutes(st), { storage: { 'acs.theme': 'light' } });
  p.eval("document.documentElement.dataset.theme = 'light'; paintAudit()");
  ok('…and it renders the same in the light theme', cards(p).length === 4);
}

for (const p of pages) p.done?.();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
