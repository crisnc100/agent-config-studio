/**
 * The review gate's merge and cross-vendor settings (Packs → Review gate),
 * beside the security switch: merge.policy and merge.alwaysHuman, and
 * crossFamily, written to the home review config the review script reads
 * first, with the same preview, signature and backup as the security switch.
 * The lib half runs against temp HOMEs and the review script reads the
 * result back; the page half drives the buttons in the fake DOM, with the
 * routes answered by the same lib code against a temp HOME; the routes half
 * runs a real server for the same-origin and unknown-field checks.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { tempDir } from './fixtures/cleanup.mjs';
import { ROOT, sandbox, tests, track } from './fixtures/packs-sandbox.mjs';
import { bootPage, routesFor, settle } from './fixtures/shell-page.mjs';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { machine } from '../lib/packs.js';
import { catalogView } from '../lib/packs-routes.js';
import { crossFamilyApply, crossFamilyPlan, mergeApply, mergePlan } from '../lib/review-settings.js';

const realBefore = snapshotRealHomes();
const { ok, done } = tests();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REVIEW = path.join(ROOT, 'packs', 'review-gate', 'runtime', 'review.mjs');

function home() {
  const h = tempDir('acs-review-settings-');
  const bin = path.join(h, 'bin');
  fs.mkdirSync(bin);
  // model-id answers the reviewer role, so review.mjs --show-config can print what it reads.
  fs.writeFileSync(path.join(bin, 'model-id'), `#!${process.execPath}
const a = process.argv.slice(2)
if (a[0] === '--role') console.log(JSON.stringify({ use: ['sol'], ids: ['gpt-stub-sol'] }))
else if (a[0] === '--flavor') console.log(JSON.stringify({ flavor: { effort: 'high' } }))
else console.log('gpt-stub-sol')
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}\n`, { mode: 0o755 });
  const m = machine({ HOME: h, PATH: process.env.PATH });
  return { h, bin, m, primary: path.join(m.runtime, 'config.json'), older: path.join(m.claudeHome, 'review-config.json') };
}
const put = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
// What the review script itself prints for --show-config in this HOME.
function gate(t) {
  const r = spawnSync(process.execPath, [REVIEW, '--show-config'], { cwd: t.h, encoding: 'utf8',
    env: { HOME: t.h, PATH: [t.bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'), GIT_CONFIG_NOSYSTEM: '1' } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { json, stderr: r.stderr, stdout: r.stdout };
}
const status = (fn) => { try { fn(); return null; } catch (e) { return e.status || 500; } };
const backups = (t) => (fs.existsSync(t.m.backups) ? fs.readdirSync(t.m.backups, { recursive: true }).filter((f) => fs.statSync(path.join(t.m.backups, f)).isFile()) : []);

try {
  console.log('\nthe lib: merge policy and always-human paths');
  {
    const t = home();
    ok('no home config: the studio reads merge off with no paths, and cross-vendor prefer', (() => {
      const s = catalogView(t.m, { installedOf: () => true }).settings;
      return s.merge?.policy === 'off' && Array.isArray(s.merge.alwaysHuman) && s.merge.alwaysHuman.length === 0 && s.crossFamily === 'prefer';
    })(), JSON.stringify(catalogView(t.m, { installedOf: () => true }).settings));
    const plan = mergePlan({ policy: 'standard', alwaysHuman: ['infra/**'] }, t.m);
    ok('the preview names the primary file as new and writes nothing', plan.file === '~/.agent-config-studio/review-gate/config.json'
      && !plan.exists && plan.changes && plan.was.policy === 'off' && read(t.primary) === null, JSON.stringify(plan));
    ok('…its diff adds merge.policy "standard" and the path', plan.diff.some((d) => d.op === '+' && /"policy": "standard"/.test(d.line))
      && plan.diff.some((d) => d.op === '+' && /"infra\/\*\*"/.test(d.line)), JSON.stringify(plan.diff));
    const r = mergeApply({ policy: 'standard', alwaysHuman: ['infra/**'] }, plan.signature, t.m);
    const doc = JSON.parse(read(t.primary));
    ok('apply writes merge.policy and merge.alwaysHuman, no backup for a new file', r.changed && r.backup === null
      && doc.merge.policy === 'standard' && JSON.stringify(doc.merge.alwaysHuman) === '["infra/**"]', read(t.primary));
    ok('the studio reads it back', (() => { const s = catalogView(t.m, { installedOf: () => true }).settings.merge; return s.policy === 'standard' && s.alwaysHuman.join() === 'infra/**'; })());
    const g = gate(t);
    ok('the review script reads the file without a merge warning', g.json && !/merge\.policy/.test(g.stderr), `${g.stderr} ${g.stdout.slice(0, 200)}`);
  }
  {
    const t = home();
    const before = '{\n  "reviewer": "sol",\n  "security": { "run": "required" },\n  "merge": { "policy": "off", "onHuman": "none", "threshold": 0.9, "alwaysHuman": ["db/**"] },\n  "crossFamily": "off"\n}\n';
    put(t.older, before);
    const plan = mergePlan({ policy: 'always', alwaysHuman: ['db/**', 'infra/**'] }, t.m);
    ok('only ~/.claude/review-config.json: that is the file changed', plan.file === '~/.claude/review-config.json' && plan.exists
      && plan.was.policy === 'off' && plan.was.alwaysHuman.join() === 'db/**', JSON.stringify(plan));
    const r = mergeApply({ policy: 'always', alwaysHuman: ['db/**', 'infra/**'] }, plan.signature, t.m);
    const doc = JSON.parse(read(t.older));
    ok('every other key is kept, the other merge keys included', doc.reviewer === 'sol' && doc.security.run === 'required' && doc.crossFamily === 'off'
      && doc.merge.onHuman === 'none' && doc.merge.threshold === 0.9 && doc.merge.policy === 'always' && doc.merge.alwaysHuman.join() === 'db/**,infra/**', read(t.older));
    ok('no primary file appears', read(t.primary) === null);
    ok('the old file is in the backups folder, byte for byte', r.backup && fs.readFileSync(r.backup.replace(/^~/, t.h), 'utf8') === before && backups(t).length === 1, JSON.stringify(r));
    const p2 = mergePlan({ policy: 'always', alwaysHuman: ['infra/**'] }, t.m);
    ok('removing a path: the diff drops it', p2.changes && p2.diff.some((d) => d.op === '-' && /"db\/\*\*"/.test(d.line)), JSON.stringify(p2.diff));
    mergeApply({ policy: 'always', alwaysHuman: ['infra/**'] }, p2.signature, t.m);
    ok('…and the file keeps only the other path', JSON.parse(read(t.older)).merge.alwaysHuman.join() === 'infra/**');
  }
  {
    const t = home();
    put(t.primary, '{"merge":{"policy":"strict"}}\n');
    put(t.older, '{"merge":{"policy":"always"}}\n');
    const plan = mergePlan({ policy: 'off', alwaysHuman: [] }, t.m);
    ok('both exist: the primary is changed, with no empty path list added', plan.file === '~/.agent-config-studio/review-gate/config.json' && plan.was.policy === 'strict'
      && !/alwaysHuman/.test(plan.next), plan.next);
    mergeApply({ policy: 'off', alwaysHuman: [] }, plan.signature, t.m);
    ok('…the older file is untouched', read(t.older) === '{"merge":{"policy":"always"}}\n');
    put(t.primary, '{"merge":{"policy":"strict"}}');
    const same = mergePlan({ policy: 'strict', alwaysHuman: [] }, t.m);
    const kept = backups(t).length;
    ok('the policy already set and no paths: no change, byte for byte, and apply writes nothing', !same.changes && same.next === same.current
      && mergeApply({ policy: 'strict', alwaysHuman: [] }, same.signature, t.m).changed === false && backups(t).length === kept
      && read(t.primary) === '{"merge":{"policy":"strict"}}');
    ok('paths are trimmed and repeats dropped', JSON.parse(mergePlan({ policy: 'strict', alwaysHuman: [' a/** ', 'a/**', 'b'] }, t.m).next).merge.alwaysHuman.join() === 'a/**,b');
    ok('an unknown policy: refused (400)', status(() => mergePlan({ policy: 'sometimes', alwaysHuman: [] }, t.m)) === 400 && status(() => mergePlan({ alwaysHuman: [] }, t.m)) === 400);
    ok('paths that are not a list of short one-line strings: refused (400)', [undefined, 'a/**', [1], [''], ['a\nb'], ['x'.repeat(201)], Array(65).fill('a')]
      .every((alwaysHuman) => status(() => mergePlan({ policy: 'strict', alwaysHuman }, t.m)) === 400));
    const stale = mergePlan({ policy: 'always', alwaysHuman: [] }, t.m);
    put(t.primary, '{"merge":{"policy":"strict"},"pick":"rotate"}\n');
    ok('a file changed after the preview: apply refuses (409) and writes nothing', status(() => mergeApply({ policy: 'always', alwaysHuman: [] }, stale.signature, t.m)) === 409
      && read(t.primary) === '{"merge":{"policy":"strict"},"pick":"rotate"}\n');
    ok('no signature: refused (400)', status(() => mergeApply({ policy: 'always', alwaysHuman: [] }, undefined, t.m)) === 400);
    put(t.primary, '{"merge":"standard"}\n');
    ok('merge that is not an object is replaced by one, keeping nothing it cannot read', JSON.parse(mergePlan({ policy: 'standard', alwaysHuman: [] }, t.m).next).merge.policy === 'standard');
    put(t.primary, '{ not json');
    ok('a malformed config: refused (409), nothing changes', status(() => mergePlan({ policy: 'always', alwaysHuman: [] }, t.m)) === 409 && read(t.primary) === '{ not json');
  }

  console.log('\nthe lib: cross-vendor checks');
  {
    const t = home();
    put(t.primary, '{\n  "reviewer": "",\n  "merge": { "policy": "standard" }\n}\n');
    const plan = crossFamilyPlan('off', t.m);
    ok('prefer → off: the diff adds crossFamily "off"', plan.changes && plan.was === 'prefer' && plan.diff.some((d) => d.op === '+' && /"crossFamily": "off"/.test(d.line)), JSON.stringify(plan));
    const r = crossFamilyApply('off', plan.signature, t.m);
    const doc = JSON.parse(read(t.primary));
    ok('apply writes it, keeps the other keys, and backs up the old file', r.changed && r.backup && doc.crossFamily === 'off' && doc.merge.policy === 'standard', JSON.stringify(r));
    ok('the studio reads off', catalogView(t.m, { installedOf: () => true }).settings.crossFamily === 'off');
    const g = gate(t);
    ok('the review script reads crossFamily "off"', g.json?.crossFamily === 'off', g.stdout.slice(0, 300) + g.stderr);
    const back = crossFamilyPlan('prefer', t.m);
    crossFamilyApply('prefer', back.signature, t.m);
    ok('…and back to prefer', JSON.parse(read(t.primary)).crossFamily === 'prefer' && gate(t).json?.crossFamily === 'prefer');
    ok('an unknown mode: refused (400)', status(() => crossFamilyPlan('never', t.m)) === 400 && status(() => crossFamilyPlan(undefined, t.m)) === 400);
    const same = crossFamilyPlan('prefer', t.m);
    ok('the mode already set: no change', !same.changes && crossFamilyApply('prefer', same.signature, t.m).changed === false);
  }

  console.log('\nthe page: agent merge and cross-vendor checks beside the security switch');
  const t = home();
  put(t.primary, '{\n  "pick": "rotate"\n}\n');
  const writes = [];
  const routes = routesFor({
    'GET /api/packs': () => catalogView(t.m, { installedOf: () => true }),
    'GET /api/packs/status': () => ({ job: { running: false, result: { packs: [], legacy: [], checkedAt: Date.now(), trust: false } } }),
    'GET /api/models/roles': () => ({ roles: [] }),
    'POST /api/packs/merge/plan': (b) => mergePlan(b, t.m),
    'POST /api/packs/merge/apply': (b) => { writes.push(b); const { signature, ...rest } = b; return mergeApply(rest, signature, t.m); },
    'POST /api/packs/cross-family/plan': (b) => crossFamilyPlan(b.mode, t.m),
    'POST /api/packs/cross-family/apply': (b) => { writes.push(b); return crossFamilyApply(b.mode, b.signature, t.m); },
  });
  const page = await bootPage({ routes, hash: '#packs' });
  const c = () => page.$('content');
  const card = () => c().querySelector('[data-pack="review-gate"]');
  const mg = () => card()?.querySelector('.pk-merge');
  const cf = () => card()?.querySelector('.pk-cross');
  for (let i = 0; i < 100 && !mg(); i++) await sleep(30);
  await settle(10);
  const tx = (n) => (n ? page.text(n) : '');
  const choices = (box) => box.querySelectorAll('.pk-sec-levels button');
  const pressed = (box) => choices(box).find((b) => b.getAttribute('aria-pressed') === 'true');
  const waitFor = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await sleep(20); await settle(5); };

  ok('the review gate card has Agent merge, after the security switch', !!mg() && /Agent merge/.test(tx(mg())) && !!card().querySelector('.pk-sec'), tx(mg()));
  ok('four choices in plain words', choices(mg()).map(tx).join('|') === 'Off|Docs and tests only|Low-risk PRs|Low and medium-risk PRs', choices(mg()).map(tx).join('|'));
  ok('each choice says in one line what it does', ['You merge every PR.', 'An agent may merge a low-risk PR that changes only docs or tests.',
    'An agent may merge any low-risk PR.', 'An agent may merge low- and medium-risk PRs; high-risk always waits for you.'].every((s) => tx(mg()).includes(s)), tx(mg()));
  ok('the choice in force is pressed: Off', tx(pressed(mg())) === 'Off');
  ok('the line that is always true', /an agent merges only when the review is closed at the tip, CI is green and nobody asked for changes/i.test(tx(mg()))
    && /package\.json, CI workflows and the paths below always need you/.test(tx(mg())), tx(mg()));
  ok('an "Always needs you" list, empty for now', /Always needs you/.test(tx(mg())) && mg().querySelectorAll('.pk-paths li').length === 0, tx(mg()));
  ok('Cross-vendor checks: two choices, Prefer another vendor pressed', !!cf() && /Cross-vendor checks/.test(tx(cf()))
    && choices(cf()).map(tx).join('|') === 'Prefer another vendor|Off' && tx(pressed(cf())) === 'Prefer another vendor', tx(cf()));
  ok('…each with its line', tx(cf()).includes('Reviews and grades use a model from another vendor when one is available; never a blocker.')
    && tx(cf()).includes('Any reviewer in your roles may check any work.'), tx(cf()));
  const allButtons = () => [...mg().querySelectorAll('button'), ...cf().querySelectorAll('button')];
  ok('every button is a styled kind, and no fold anywhere on the card', allButtons().every((b) => /\bbtn\b/.test(b.className)) && !card().querySelector('details'));
  ok('no raw key name in a label or choice', ![...choices(mg()), ...choices(cf()), ...mg().querySelectorAll('.pk-label'), ...cf().querySelectorAll('.pk-label')]
    .some((n) => /merge\.policy|alwaysHuman|crossFamily|strict|standard/.test(tx(n))));

  choices(mg()).find((b) => tx(b) === 'Low-risk PRs').click();
  const pre = (box) => box.querySelector('.pk-sec-preview');
  await waitFor(() => pre(mg()));
  ok('choosing Low-risk PRs shows the file and its diff first', /this changes ~\/\.agent-config-studio\/review-gate\/config\.json, and a copy of it goes to the backups folder first/.test(tx(pre(mg())))
    && pre(mg()).querySelectorAll('.diff-line.add').some((l) => /"policy": "standard"/.test(tx(l))), tx(pre(mg())));
  ok('…nothing written yet', writes.length === 0 && read(t.primary) === '{\n  "pick": "rotate"\n}\n');
  const acts = (box) => pre(box).querySelectorAll('button');
  ok('the preview\'s buttons: Save (primary) and Cancel (quiet)', acts(mg()).map((b) => `${tx(b)}:${b.className}`).join('|') === 'Save:btn primary|Cancel:btn ghost');
  acts(mg()).find((b) => tx(b) === 'Save').click();
  await waitFor(() => mg().querySelector('.pk-result'));
  ok('Save writes merge.policy "standard" and keeps the file\'s other keys', writes.length === 1 && /^[0-9a-f]{64}$/.test(writes[0].signature)
    && JSON.parse(read(t.primary)).merge.policy === 'standard' && JSON.parse(read(t.primary)).pick === 'rotate', read(t.primary));
  ok('…says where it saved and where the old file went', /Saved: ~\/\.agent-config-studio\/review-gate\/config\.json now says “Low-risk PRs”\. The old file is at ~\/\.agent-config-studio\/backups\//.test(tx(mg().querySelector('.pk-result'))), tx(mg()));
  ok('…and the pressed choice follows', tx(pressed(mg())) === 'Low-risk PRs');

  const input = () => mg().querySelector('.pk-paths-add input');
  const addBtn = () => mg().querySelector('.pk-paths-add button');
  ok('the add row: a labelled box and an Add button', !!input() && !!input().getAttribute('aria-label') && tx(addBtn()) === 'Add' && /\bbtn\b/.test(addBtn().className));
  input().value = 'infra/**';
  addBtn().click();
  await waitFor(() => pre(mg()));
  ok('adding a path previews the diff', pre(mg()).querySelectorAll('.diff-line.add').some((l) => /"infra\/\*\*"/.test(tx(l))), tx(pre(mg())));
  acts(mg()).find((b) => tx(b) === 'Save').click();
  await waitFor(() => mg().querySelector('.pk-result'));
  ok('…Save writes it, and the list shows it with a Remove button', JSON.parse(read(t.primary)).merge.alwaysHuman.join() === 'infra/**'
    && mg().querySelectorAll('.pk-paths li').map(tx).some((s) => /infra\/\*\*/.test(s) && /Remove/.test(s)), tx(mg()));
  ok('…the result line names the paths change', /Saved: .* now says “Low-risk PRs”, with 1 path that always needs you\./.test(tx(mg().querySelector('.pk-result'))), tx(mg().querySelector('.pk-result')));
  mg().querySelector('.pk-paths li button').click();
  await waitFor(() => pre(mg()));
  ok('Remove previews dropping it', pre(mg()).querySelectorAll('.diff-line.del').some((l) => /"infra\/\*\*"/.test(tx(l))), tx(pre(mg())));
  acts(mg()).find((b) => tx(b) === 'Cancel').click();
  await settle(5);
  ok('Cancel writes nothing', !pre(mg()) && JSON.parse(read(t.primary)).merge.alwaysHuman.join() === 'infra/**');

  choices(cf()).find((b) => tx(b) === 'Off').click();
  await waitFor(() => pre(cf()));
  ok('cross-vendor Off previews crossFamily "off"', pre(cf()).querySelectorAll('.diff-line.add').some((l) => /"crossFamily": "off"/.test(tx(l))), tx(pre(cf())));
  acts(cf()).find((b) => tx(b) === 'Save').click();
  await waitFor(() => cf().querySelector('.pk-result'));
  ok('…Save writes it and confirms with the backup', JSON.parse(read(t.primary)).crossFamily === 'off' && tx(pressed(cf())) === 'Off'
    && /Saved: .* now says “Off”\. The old file is at ~\/\.agent-config-studio\/backups\//.test(tx(cf().querySelector('.pk-result'))), tx(cf()));

  choices(mg()).find((b) => tx(b) === 'Off').click();
  await waitFor(() => pre(mg()));
  put(t.primary, '{"merge":{"policy":"always"}}\n');
  acts(mg()).find((b) => tx(b) === 'Save').click();
  await waitFor(() => mg().querySelector('.notice.error'));
  ok('a stale preview: the refusal is shown, and the file is not overwritten', /changed since the preview/.test(tx(mg().querySelector('.notice.error'))) && read(t.primary) === '{"merge":{"policy":"always"}}\n', tx(mg()));
  ok('no page errors', page.errors.length === 0, page.errors.join(' | '));
  page.done();

  console.log('\nthe routes, through a real server: same-origin only, unknown fields refused, a plan writes nothing');
  const sb = sandbox('review-settings', { clis: ['claude'] });
  try {
    const port = await new Promise((res, rej) => { const srv = net.createServer(); srv.once('error', rej); srv.listen(0, '127.0.0.1', () => { const n = srv.address().port; srv.close(() => res(n)); }); });
    const child = track(spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...sb.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] }));
    const base = `http://localhost:${port}`;
    for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await sleep(100); }
    const post = async (route, body, headers = {}) => {
      const r = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers }, body: JSON.stringify(body) });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, body: json, text };
    };
    const file = path.join(sb.home, '.agent-config-studio/review-gate/config.json');
    for (const route of ['/api/packs/merge/plan', '/api/packs/merge/apply', '/api/packs/cross-family/plan', '/api/packs/cross-family/apply']) {
      const r = await post(route, { policy: 'always', alwaysHuman: [], mode: 'off', signature: '0'.repeat(64) }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
      ok(`a foreign origin: POST ${route} → 403`, r.status === 403, `${r.status} ${r.text.slice(0, 120)}`);
    }
    ok('an unknown field: 400', (await post('/api/packs/merge/plan', { policy: 'always', alwaysHuman: [], path: '/etc/x' })).status === 400
      && (await post('/api/packs/cross-family/plan', { mode: 'off', file: '/etc/x' })).status === 400);
    const plan = await post('/api/packs/merge/plan', { policy: 'strict', alwaysHuman: ['infra/**'] });
    ok('a merge plan answers with the diff and writes nothing, with no absolute HOME path in it', plan.status === 200 && plan.body.changes && !fs.existsSync(file) && !plan.text.includes(sb.home), plan.text.slice(0, 300));
    const applied = await post('/api/packs/merge/apply', { policy: 'strict', alwaysHuman: ['infra/**'], signature: plan.body.signature });
    ok('apply with the plan\'s signature writes it', applied.status === 200 && JSON.parse(fs.readFileSync(file, 'utf8')).merge.policy === 'strict', applied.text.slice(0, 300));
    const again = await post('/api/packs/merge/apply', { policy: 'strict', alwaysHuman: ['infra/**'], signature: plan.body.signature });
    ok('the same signature again, now stale: 409', again.status === 409, `${again.status} ${again.text.slice(0, 120)}`);
    const cplan = await post('/api/packs/cross-family/plan', { mode: 'off' });
    const capplied = await post('/api/packs/cross-family/apply', { mode: 'off', signature: cplan.body?.signature });
    ok('cross-family plan then apply writes crossFamily, keeping merge', capplied.status === 200 && JSON.parse(fs.readFileSync(file, 'utf8')).crossFamily === 'off'
      && JSON.parse(fs.readFileSync(file, 'utf8')).merge.policy === 'strict', capplied.text.slice(0, 300));
    const pk = await fetch(`${base}/api/packs`, { headers: { 'sec-fetch-site': 'same-origin' } }).then((r) => r.json());
    ok('GET /api/packs carries the current values', pk.settings?.merge?.policy === 'strict' && pk.settings.merge.alwaysHuman.join() === 'infra/**' && pk.settings.crossFamily === 'off', JSON.stringify(pk.settings));
    child.kill('SIGKILL');
  } finally { sb.cleanup(); }
} catch (e) {
  ok(`no test block threw (${e?.message || e})`, false, e?.stack || String(e));
} finally {
  try { assertRealHomesUnchanged(realBefore, ok); } catch (e) { ok('the real homes are unchanged', false, e.message); }
  done();
}
