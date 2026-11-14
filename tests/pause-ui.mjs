/**
 * The Pause switch on Usage and its effect on Models → Roles
 * (builds/pause-account R7, R8, R11) in the fake DOM against stubbed routes:
 * what each row offers, what each button sends, and the notice the Roles
 * section shows while anything is paused. No server, no HOME.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, bootPage, routesFor, settle } from './fixtures/shell-page.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const J = JSON.stringify;
const HOUR = 3600_000;
const RESET = Date.now() + 5 * HOUR;
const SEATS = [
  { seatId: 'c1', label: 'Claude Max', vendor: 'claude', ok: true, windows: [
    { label: '5h', usedPercent: 30, resetsAt: Date.now() + HOUR }, { label: 'week', usedPercent: 92, resetsAt: RESET }] },
  { seatId: 'x1', label: 'Codex Pro', vendor: 'codex', ok: true, windows: [{ label: 'week', usedPercent: 10 }] },
];
const state = (entries = [], over = {}) => ({
  entries, active: entries.filter((e) => e.active).map((e) => e.name), error: null, resolverStale: false, staleFix: null, vendors: ['claude', 'codex', 'grok'], ...over,
});
const text = (n) => n.textContent.replace(/\s+/g, ' ').trim();
const buttons = (root) => root.querySelectorAll('button');
const button = (root, t) => buttons(root).find((b) => text(b) === t || text(b).startsWith(t));
const card = (p, id) => p.$('content').querySelectorAll('.usage-seat').find((c) => c.dataset.seat === id);
const posts = (p, route) => p.requests.filter((r) => r.method === 'POST' && r.path === route);

async function usage(pause, extra = {}) {
  const st = { pause };
  const routes = routesFor({
    'GET /api/usage': () => ({ seats: SEATS }),
    'GET /api/pause': () => (typeof st.pause === 'function' ? st.pause() : st.pause),
    'POST /api/pause': (b) => { st.pause = state([{ name: b.name, kind: 'vendor', vendor: b.name, until: b.until, active: true }]); return st.pause; },
    'POST /api/pause/resume': () => { st.pause = state(); return st.pause; },
    ...extra,
  });
  const p = await bootPage({ routes, hash: '#usage' });
  await settle(20);
  return p;
}

console.log('\npause ui: R7 — the switch on each Usage row');
{
  const p = await usage(state());
  const c = card(p, 'c1');
  const pause = button(c, 'Pause');
  ok('each account row has a Pause button, styled as a secondary button', pause && pause.className === 'btn' && button(card(p, 'x1'), 'Pause'), c && text(c));
  pause.click();
  await settle(10);
  const c2 = card(p, 'c1');
  const at = buttons(c2).find((b) => /^Until it resets \(/.test(text(b)));
  ok('pausing offers "until it resets", pre-filled from the reading, as the primary choice', at && at.className === 'btn primary' && text(at).includes(new Date(RESET).toLocaleString([], { hour: 'numeric', minute: '2-digit' })), c2 && text(c2));
  ok('…"Until I resume" as the secondary, and Cancel as a quiet button', button(c2, 'Until I resume')?.className === 'btn' && button(c2, 'Cancel')?.className === 'btn ghost');
  at.click();
  await settle(20);
  const sent = posts(p, '/api/pause');
  ok('"until it resets" sends the vendor and the reset time', sent.length === 1 && sent[0].body.name === 'claude' && sent[0].body.until === new Date(RESET).toISOString(), J(sent));
  const c3 = card(p, 'c1');
  ok('a paused account shows "Paused until …" and a Resume button', /Paused until .* — roles skip claude models/.test(text(c3)) && button(c3, 'Resume')?.className === 'btn', text(c3));
  button(c3, 'Resume').click();
  await settle(20);
  ok('Resume sends the name', posts(p, '/api/pause/resume').length === 1 && posts(p, '/api/pause/resume')[0].body.name === 'claude');
  ok('…and the row offers Pause again', button(card(p, 'c1'), 'Pause') && !/Paused/.test(text(card(p, 'c1'))));
}
{
  const p = await usage(state());
  button(card(p, 'x1'), 'Pause').click();
  await settle(10);
  const c = card(p, 'x1');
  ok('a reading with no reset time: only "Until I resume" (primary), no reset choice', !buttons(c).some((b) => /Until it resets/.test(text(b))) && button(c, 'Until I resume')?.className === 'btn primary', text(c));
  button(c, 'Until I resume').click();
  await settle(20);
  const sent = posts(p, '/api/pause');
  ok('"Until I resume" sends until: null', sent.length === 1 && J(sent[0].body) === J({ name: 'codex', until: null }), J(sent));
  ok('…and the row says "Paused until you resume"', /Paused until you resume/.test(text(card(p, 'x1'))));
}
{
  const p = await usage(state([{ name: 'claude', kind: 'vendor', vendor: 'claude', until: null, active: true },
    { name: 'sol', kind: 'family', vendor: 'codex', until: new Date(RESET).toISOString(), active: true }]));
  ok('a family paused by name shows on its vendor\'s row with its own Resume', /sol paused until/.test(text(card(p, 'x1'))) && button(card(p, 'x1'), 'Resume sol')?.className === 'btn ghost', text(card(p, 'x1')));
  ok('…and the vendor is still offered a Pause of its own', !!button(card(p, 'x1'), 'Pause'));
}
{
  const fix = 'Your installed model-id is older than this version of ACS and would ignore a pause. Run: acs install-model-id, then pause again.';
  const p = await usage(state([], { resolverStale: true, staleFix: fix }));
  const b = button(card(p, 'c1'), 'Pause');
  ok('a stale resolver: Pause is disabled and the row names the fix', b?.disabled === true && text(card(p, 'c1')).includes(fix), text(card(p, 'c1')));
  const refused = await usage(state(), { 'POST /api/pause': () => { throw { status: 409, body: { error: fix } }; } });
  button(card(refused, 'c1'), 'Pause').click();
  await settle(10);
  button(card(refused, 'c1'), 'Until I resume').click();
  await settle(20);
  ok('a refusal from the server is shown as given', text(refused.$('notice-slot')).includes(fix), text(refused.$('notice-slot')));
}
{
  const p = await usage(state([], { error: '~/.agent-config-studio/paused.json: not valid JSON' }));
  ok('an invalid paused.json: one error naming it, and Pause disabled', /paused\.json is invalid, so nothing is paused/.test(text(p.$('content'))) && button(card(p, 'c1'), 'Pause')?.disabled === true, text(p.$('content')));
  const none = await usage(null, { 'GET /api/pause': () => { throw { status: 500, body: { error: 'boom' } }; } });
  ok('the pause state unreadable: usage still shows, with no switch', !!card(none, 'c1') && !button(card(none, 'c1'), 'Pause'));
}

console.log('\npause ui: R8 — the effect on Models → Roles');
const ROLES_VIEW = (pause) => ({
  roles: [
    { name: 'builder', use: ['opus', 'sol'], ids: ['opus-id', 'sol-id'], effort: 'medium', resolvedEffort: 'medium', alt: '', altId: '', note: '', custom: false, provenance: {}, defaults: null, warnings: [] },
    { name: 'reviewer', use: ['fable', 'sol'], ids: ['fable-id', 'sol-id'], effort: '', resolvedEffort: '', alt: '', altId: '', note: '', custom: false, provenance: {}, defaults: null, warnings: [] },
  ],
  flavor: [], families: ['fable', 'opus', 'sol'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  limits: { brief: 600, item: 160, items: 12, note: 160, use: 8 }, base: 'sha256:b', userText: '{}\n', error: null, userFile: '~/.agent-config-studio/roles.json',
  describe: { harness: 'claude', label: 'Claude', installed: true, model: 'm', modelLabel: 'M', ready: true, why: null, running: false, limits: { description: 4000 } },
  pause,
});
async function roles(pause) {
  const routes = routesFor({
    'GET /api/models': () => ({ pending: 0, checkedAt: Date.now(), catalogs: [], claudeVersion: null, rows: [] }),
    'GET /api/models/roles': () => ROLES_VIEW(pause),
    'GET /api/usage': () => ({ seats: SEATS }),
    'GET /api/pause': () => state(),
  });
  const p = await bootPage({ routes, hash: '#models' });
  await settle(20);
  return p;
}
{
  const p = await roles({ ...state([{ name: 'claude', kind: 'vendor', vendor: 'claude', until: null, active: true }]),
    roles: [
      { name: 'advisor', refuses: true, error: 'every model for advisor is paused', family: '', skipped: [{ family: 'fable', by: 'claude' }], altSkipped: null },
      { name: 'builder', refuses: false, error: null, family: 'sol', skipped: [{ family: 'opus', by: 'claude' }], altSkipped: null, alt: '' },
      { name: 'reviewer', refuses: false, error: null, family: 'sol', skipped: [{ family: 'fable', by: 'claude' }], altSkipped: { family: 'astra', by: 'codex' }, alt: '' },
      { name: 'scout', refuses: false, error: null, family: 'sol', skipped: [], altSkipped: null, alt: '' },
    ],
    sameVendor: 'codex' });
  const n = p.$('content').querySelector('.roles-pause');
  const t = n ? text(n) : '';
  ok('a notice on Roles names what is paused', n && /Paused: claude until you resume/.test(t), t);
  ok('…each role\'s answer now, with what it skips', /builder → sol \(skips opus\)/.test(t) && /reviewer → sol \(skips fable; no second opinion \(astra is paused\)\)/.test(t) && /scout → sol/.test(t), t);
  ok('…marks a role that would refuse', /advisor: refuses — every model for it is paused/.test(t), t);
  ok('…and the same-vendor note', /Builder and reviewer both run on codex now, so codex checks its own work\./.test(t), t);
  const go = button(n, 'Pause or resume on Usage');
  ok('…with a quiet button to the switch', go?.className === 'btn ghost');
  go.click();
  await settle(20);
  ok('…which opens Usage', p.$('content').querySelectorAll('.usage-seat').length === 2);
}
{
  const p = await roles({ ...state(), roles: [], sameVendor: null });
  ok('nothing paused: no notice on Roles', !p.$('content').querySelector('.roles-pause'));
}

console.log('\npause ui: R11 — styles');
{
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /(usage-pause|roles-pause)/.test(m[1]));
  ok('the pause rules exist', rules.length >= 5, String(rules.length));
  const small = rules.flatMap((m) => [...m[2].matchAll(/font(?:-size)?\s*:\s*[^;]*?(\d*\.?\d+)px/g)].map((v) => Number(v[1]))).filter((v) => v < 12);
  ok('no pause text under 12px', small.length === 0, J(small));
  const literal = rules.filter((m) => /#[0-9a-f]{3,8}\b|rgb\(/i.test(m[2]));
  ok('colours come from the theme variables, so light and dark both hold', literal.length === 0, J(literal.map((m) => m[1])));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
