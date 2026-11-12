/**
 * The review gate's Settings section (Packs → Review gate): the security
 * pass, agent merge, the paths that always need you and cross-vendor checks,
 * through one writer over an allow-list of keys (security.run, merge.policy,
 * merge.alwaysHuman, crossFamily) into the home review config the review
 * script reads first, with one preview, one signature and one backup per
 * save. Also where those settings show elsewhere: the Merge step in the
 * review gate's steps and the Grade's swap note and its pointer on the Build
 * page.
 *
 * The lib half runs against temp HOMEs and the review script reads the
 * result back; the page half drives the fake DOM with the routes answered by
 * the same lib code against a temp HOME; the routes half runs a real server.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { tempDir } from './fixtures/cleanup.mjs';
import { ROOT, sandbox, tests, track } from './fixtures/packs-sandbox.mjs';
import { bootPage, registry, routesFor, settle } from './fixtures/shell-page.mjs';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { machine } from '../lib/packs.js';
import { catalogView } from '../lib/packs-routes.js';
import { BUILT_IN_HUMAN, DEFAULT_RISK_PATHS, settingsApply, settingsPlan } from '../lib/review-settings.js';
import { securityApply, securityPlan } from '../lib/review-security.js';

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
function gate(t) {
  const r = spawnSync(process.execPath, [REVIEW, '--show-config'], { cwd: t.h, encoding: 'utf8',
    env: { HOME: t.h, PATH: [t.bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'), GIT_CONFIG_NOSYSTEM: '1' } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { json, stderr: r.stderr, stdout: r.stdout };
}
const status = (fn) => { try { fn(); return null; } catch (e) { return e.status || 500; } };
const backupDirs = (t) => (fs.existsSync(t.m.backups) ? fs.readdirSync(t.m.backups) : []);
const view = (t) => catalogView(t.m, { installedOf: () => true });

try {
  console.log('\nthe writer: one allow-list of keys, one preview, one backup');
  {
    const t = home();
    const s = view(t).settings;
    ok('no home config: merge off with no paths of your own, cross-vendor prefer, security off', s.merge?.policy === 'off' && s.merge.alwaysHuman.length === 0
      && s.crossFamily === 'prefer' && s.security === 'off', JSON.stringify(s));
    ok('…the built-in always-human paths and the default risky paths are carried, read-only', JSON.stringify(s.merge.builtIn) === '[".github/workflows/**","package.json"]'
      && JSON.stringify(s.merge.riskPaths) === JSON.stringify(DEFAULT_RISK_PATHS) && s.merge.riskPathsFrom === 'default', JSON.stringify(s.merge));
    ok('…and where the config is: the primary file, not there yet', s.reviewConfig?.file === '~/.agent-config-studio/review-gate/config.json' && s.reviewConfig.exists === false, JSON.stringify(s.reviewConfig));
    const changes = { 'security.run': 'required', 'merge.policy': 'standard', 'merge.alwaysHuman': ['infra/**'], crossFamily: 'off' };
    const plan = settingsPlan(changes, t.m);
    ok('a plan of all four keys names the primary file as new, writes nothing', plan.file === '~/.agent-config-studio/review-gate/config.json' && !plan.exists && plan.changes && read(t.primary) === null, JSON.stringify(plan));
    const r = settingsApply(changes, plan.signature, t.m);
    const doc = JSON.parse(read(t.primary));
    ok('one apply writes all four, with no backup for a new file', r.changed && r.backup === null && doc.security.run === 'required' && doc.merge.policy === 'standard'
      && doc.merge.alwaysHuman.join() === 'infra/**' && doc.crossFamily === 'off', read(t.primary));
    const g = gate(t);
    ok('the review script reads crossFamily "off" and security "required", with no merge warning', g.json?.crossFamily === 'off' && g.json?.security === 'required' && !/merge\.policy/.test(g.stderr), g.stdout.slice(0, 300) + g.stderr);
    const s2 = view(t).settings;
    ok('the studio reads them back', s2.merge.policy === 'standard' && s2.merge.alwaysHuman.join() === 'infra/**' && s2.crossFamily === 'off' && s2.security === 'required' && s2.reviewConfig.exists);
    const p2 = settingsPlan({ 'merge.policy': 'always', crossFamily: 'prefer' }, t.m);
    const r2 = settingsApply({ 'merge.policy': 'always', crossFamily: 'prefer' }, p2.signature, t.m);
    ok('two keys changed in one save make exactly one backup, of the file as it was', r2.backup && backupDirs(t).length === 1
      && fs.readFileSync(r2.backup.replace(/^~/, t.h), 'utf8') === `${JSON.stringify(doc, null, 2)}\n`, JSON.stringify(r2));
  }
  {
    const t = home();
    const before = '{\n  "reviewer": "sol",\n  "riskPaths": ["*vault*"],\n  "security": { "run": "required", "timeoutMs": 60000 },\n  "merge": { "policy": "off", "onHuman": "none", "threshold": 0.9, "alwaysHuman": ["db/**"] }\n}\n';
    put(t.older, before);
    ok('the risky paths come from the home config when it sets them', JSON.stringify(view(t).settings.merge.riskPaths) === '["*vault*"]' && view(t).settings.merge.riskPathsFrom === 'config');
    ok('…and the older file is the one in force', view(t).settings.reviewConfig.file === '~/.claude/review-config.json' && view(t).settings.reviewConfig.exists);
    const plan = settingsPlan({ 'merge.alwaysHuman': ['db/**', 'infra/**'] }, t.m);
    ok('only ~/.claude/review-config.json: that is the file changed', plan.file === '~/.claude/review-config.json' && plan.exists, plan.file);
    settingsApply({ 'merge.alwaysHuman': ['db/**', 'infra/**'] }, plan.signature, t.m);
    const doc = JSON.parse(read(t.older));
    ok('every other key is kept, the other merge and security keys included', doc.reviewer === 'sol' && doc.riskPaths.join() === '*vault*' && doc.security.timeoutMs === 60000
      && doc.merge.onHuman === 'none' && doc.merge.threshold === 0.9 && doc.merge.policy === 'off' && doc.merge.alwaysHuman.join() === 'db/**,infra/**', read(t.older));
    ok('no primary file appears', read(t.primary) === null);
  }
  {
    const t = home();
    put(t.primary, '{"merge":{"policy":"strict"}}');
    const same = settingsPlan({ 'merge.policy': 'strict', 'merge.alwaysHuman': [] }, t.m);
    ok('values already in force: no change, byte for byte (no empty path list added), and apply writes nothing', !same.changes && same.next === same.current
      && settingsApply({ 'merge.policy': 'strict', 'merge.alwaysHuman': [] }, same.signature, t.m).changed === false && backupDirs(t).length === 0);
    ok('paths are trimmed and repeats dropped', JSON.parse(settingsPlan({ 'merge.alwaysHuman': [' a/** ', 'a/**', 'b'] }, t.m).next).merge.alwaysHuman.join() === 'a/**,b');
    ok('a key outside the allow-list: refused (400)', ['riskPaths', 'merge.onHuman', 'pick', 'security.timeoutMs', '__proto__'].every((k) => status(() => settingsPlan({ [k]: 'x' }, t.m)) === 400));
    ok('no change asked for: refused (400)', status(() => settingsPlan({}, t.m)) === 400 && status(() => settingsPlan(null, t.m)) === 400 && status(() => settingsPlan([], t.m)) === 400);
    ok('a value outside its key\'s set: refused (400)', status(() => settingsPlan({ 'merge.policy': 'sometimes' }, t.m)) === 400
      && status(() => settingsPlan({ crossFamily: 'never' }, t.m)) === 400 && status(() => settingsPlan({ 'security.run': 'maybe' }, t.m)) === 400);
    ok('paths that are not a list of short one-line strings: refused (400)', ['a/**', [1], [''], ['a\nb'], ['x'.repeat(201)], Array(65).fill('a')]
      .every((v) => status(() => settingsPlan({ 'merge.alwaysHuman': v }, t.m)) === 400));
    const stale = settingsPlan({ 'merge.policy': 'always' }, t.m);
    put(t.primary, '{"merge":{"policy":"strict"},"pick":"rotate"}\n');
    ok('a file changed after the preview: apply refuses (409) and writes nothing', status(() => settingsApply({ 'merge.policy': 'always' }, stale.signature, t.m)) === 409
      && read(t.primary) === '{"merge":{"policy":"strict"},"pick":"rotate"}\n');
    ok('a signature for other changes: refused (409)', status(() => settingsApply({ crossFamily: 'off' }, settingsPlan({ 'merge.policy': 'always' }, t.m).signature, t.m)) === 409);
    ok('no signature: refused (400)', status(() => settingsApply({ 'merge.policy': 'always' }, undefined, t.m)) === 400);
    put(t.primary, '{"merge":"standard"}\n');
    ok('merge that is not an object becomes one', JSON.parse(settingsPlan({ 'merge.policy': 'standard' }, t.m).next).merge.policy === 'standard');
    put(t.primary, '{ not json');
    ok('a malformed config: refused (409), nothing changes', status(() => settingsPlan({ 'merge.policy': 'always' }, t.m)) === 409 && read(t.primary) === '{ not json');
    put(t.primary, '{"security":{"run":"off"}}\n');
    const sp = securityPlan('always', t.m);
    const sr = securityApply('always', sp.signature, t.m);
    ok('the security switch goes through the same writer: same file, backup, and its own backup folder name', sr.changed && /review-security/.test(sr.backup || '') && JSON.parse(read(t.primary)).security.run === 'always', JSON.stringify(sr));
  }
  {
    const src = fs.readFileSync(REVIEW, 'utf8');
    ok('the built-in always-human paths are the review script\'s', src.includes(`const ALWAYS_HUMAN = ${JSON.stringify(BUILT_IN_HUMAN).replace(/"/g, "'").replace(/,/g, ', ')}`), JSON.stringify(BUILT_IN_HUMAN));
    ok('the default risky paths are the review script\'s', src.includes(`: ${JSON.stringify(DEFAULT_RISK_PATHS).replace(/"/g, "'").replace(/,/g, ', ')}`), JSON.stringify(DEFAULT_RISK_PATHS));
  }

  console.log('\nthe catalog: a Merge step in the review gate\'s diagram');
  {
    const t = home();
    const rg = view(t).packs.find((p) => p.id === 'review-gate').workflow;
    const mergeStep = rg.steps.at(-1);
    ok('the review gate\'s workflow ends with Merge: merge.mjs, a script, its setting "merge", in the code-review part', mergeStep?.id === 'merge' && mergeStep.label === 'Merge'
      && mergeStep.who === 'script' && mergeStep.tool === 'merge.mjs' && mergeStep.setting === 'merge' && mergeStep.part === 'code-review' && mergeStep.what.length <= 36, JSON.stringify(mergeStep));
    ok('…and no other pack gains a step', view(t).packs.filter((p) => p.id !== 'review-gate').every((p) => !p.workflow?.steps?.some((s) => s.id === 'merge')));
  }

  console.log('\nthe page: the Settings section on the review gate\'s page');
  const t = home();
  put(t.primary, '{\n  "pick": "rotate"\n}\n');
  const writes = [];
  const ID = { fable: 'claude-fable-5-1', astra: 'gpt-6-astra' };
  const role = (name, family, extra = {}) => ({ name, use: [family], ids: [ID[family]], members: [{ family, effort: 'high' }], effort: 'high', resolvedEffort: 'high', unset: false, ...extra });
  const roles = { roles: [role('judge', 'fable'), role('advisor', 'fable', { alt: 'astra', altId: ID.astra, altMember: { family: 'astra', effort: 'high' } })] };
  let installed = true;
  const withGate = (v) => {
    if (installed) v.packs.find((p) => p.id === 'review-gate').installed = { version: '1', parts: { 'code-review': { harnesses: ['claude'], installedAt: null } } };
    return v;
  };
  const routes = routesFor({
    'GET /api/packs': () => withGate(view(t)),
    'GET /api/packs/status': () => ({ job: { running: false, result: { packs: [], legacy: [], checkedAt: Date.now(), trust: false } } }),
    'GET /api/models/roles': () => roles,
    'POST /api/packs/review-settings/plan': (b) => settingsPlan(b.changes, t.m),
    'POST /api/packs/review-settings/apply': (b) => { writes.push(b); return settingsApply(b.changes, b.signature, t.m); },
  });
  const page = await bootPage({ routes, hash: '#packs/review-gate' });
  const c = () => page.$('content');
  // A pack's own page, opened through its route when another page (or the paths page) is shown.
  const card = (id = 'review-gate') => {
    if (page.eval('PK.page') !== id || page.eval('PK.sub')) page.navigate(`#packs/${id}`);
    return c().querySelector(`.pk-page[data-pack="${id}"]`);
  };
  const sec = () => card()?.querySelector('.pk-settings');
  const secRow = () => sec()?.querySelector('.pk-security');
  const mg = () => sec()?.querySelector('.pk-merge');
  const cf = () => sec()?.querySelector('.pk-cross');
  const always = () => sec()?.querySelector('.pk-always');
  for (let i = 0; i < 100 && !mg(); i++) await sleep(30);
  await settle(10);
  const tx = (n) => (n ? page.text(n) : '');
  const choices = (box) => box.querySelectorAll('.pk-tabs button');
  const pressed = (box) => choices(box).find((b) => b.getAttribute('aria-pressed') === 'true');
  const says = (box) => box.querySelectorAll('.pk-set-says').map(tx);
  // The paths page, or the pack page's Settings: wherever the save bar is drawn now.
  const pathsPage = () => c().querySelector('.pk-paths-page');
  const here = () => pathsPage() || sec();
  const bar = () => here()?.querySelector('.pk-savebar');
  const barBtn = (label) => bar()?.querySelectorAll('button').find((b) => tx(b) === label);
  const pre = () => here()?.querySelector('.pk-sec-preview');
  const acts = () => pre().querySelectorAll('button');
  const result = () => here()?.querySelector('.pk-result');
  const waitFor = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await sleep(20); await settle(5); };
  const pick = async (boxOf, label) => { choices(boxOf()).find((b) => tx(b) === label).click(); await settle(5); };
  const previewIt = async () => { barBtn('Preview and save').click(); await waitFor(() => pre() || here()?.querySelector('.notice.error')); };
  const saveIt = async () => { acts().find((b) => tx(b) === 'Save').click(); await waitFor(() => result() || pre() || here()?.querySelector('.notice.error')); };
  const toPaths = async () => { always().querySelectorAll('button').find((b) => tx(b) === 'Edit paths').click(); await waitFor(() => pathsPage()); };
  const toPack = async () => { pathsPage().querySelector('.pk-back').click(); await waitFor(() => sec()); };
  const box = () => pathsPage()?.querySelector('textarea');
  const added = (want) => pre().querySelectorAll('.diff-line.add').some((l) => want.test(tx(l)));

  ok('one Settings section on the review gate page, holding the security switch, agent merge and cross-vendor checks', c().querySelectorAll('.pk-settings').length === 1
    && !!sec().querySelector('.pk-sec-levels') && !!mg() && !!cf(), tx(sec()));
  ok('C8: four rows, in order: Security pass, Agent merge, Always needs you, Cross-vendor checks', sec().querySelectorAll('.pk-set').map((r) => tx(r.querySelector('.pk-set-name'))).join('|')
    === 'Security pass|Agent merge|Always needs you|Cross-vendor checks', sec().querySelectorAll('.pk-set-name').map(tx).join('|'));
  ok('…under the lead "Nothing is saved until you preview the change."', tx(card().querySelector('#pk-sec-settings .pk-sec-lead')) === 'Nothing is saved until you preview the change.');
  ok('R3: four merge choices in plain words, Off pressed', choices(mg()).map(tx).join('|') === 'Off|Docs and tests only|Low-risk PRs|Low and medium-risk PRs' && tx(pressed(mg())) === 'Off',
    choices(mg()).map(tx).join('|'));
  ok('C8: …one line, for the selected choice only', JSON.stringify(says(mg())) === '["You merge every PR."]'
    && !['An agent may merge a low-risk PR', 'An agent may merge any low-risk PR', 'An agent may merge low- and medium-risk PRs'].some((s) => tx(mg()).includes(s)), tx(mg()));
  ok('C8: with gh not reported missing, no gh or CI line, and no merge.mjs essay', !mg().querySelector('.pk-set-warn') && !/gh CLI|CI checks|merge\.mjs/.test(tx(mg())), tx(mg()));
  ok('C8: security pass, one line for Off', choices(secRow()).map(tx).join('|') === 'Off|When code changes|Always' && JSON.stringify(says(secRow())) === '["PR reviews run no security pass."]', tx(secRow()));
  ok('R5: Cross-vendor checks, Prefer another vendor pressed, its line only', choices(cf()).map(tx).join('|') === 'Prefer another vendor|Off' && tx(pressed(cf())) === 'Prefer another vendor'
    && JSON.stringify(says(cf())) === '["Reviews and grades use a model from another vendor when one is available; never a blocker."]' && !tx(cf()).includes('Any reviewer in your roles'), tx(cf()));
  ok('R4: Always needs you is a count and Edit paths (secondary); no box, no lists on the pack page', tx(always().querySelector('.pk-set-inline span')) === '9 paths: 2 built in, 7 risky, none of your own'
    && always().querySelectorAll('button').map((b) => `${tx(b)}:${b.className}`).join('|') === 'Edit paths:btn pk-edit-paths' && !sec().querySelector('textarea') && !/package\.json|\*auth\*/.test(tx(sec())), tx(always()));
  ok('R7: the footer says where it is saved (the primary file has no Files entry, so no button), and no "Saved as" key line', /^Saved in ~\/\.agent-config-studio\/review-gate\/config\.json$/.test(tx(sec().querySelector('.pk-set-foot')))
    && !sec().querySelector('.pk-set-foot button') && !/Saved as|Other review settings/.test(tx(sec())), tx(sec().querySelector('.pk-set-foot')));
  ok('nothing picked: no save bar and no preview', !bar() && !pre());
  ok('every button is a styled kind or a segment, and no fold on the page', sec().querySelectorAll('button').every((b) => /\bbtn\b/.test(b.className) || b.classList.contains('pk-tab')) && !card().querySelector('details'));
  ok('no raw key name in a label or a choice', [...sec().querySelectorAll('.pk-tabs button'), ...sec().querySelectorAll('.pk-set-name')].every((n) => !/merge\.policy|alwaysHuman|crossFamily|riskPaths|strict|standard/.test(tx(n))));

  console.log('\nR6 and R5: the diagram, the Grade and the Build page follow the settings');
  const step = (pack, id) => card(pack)?.querySelector(`.step[data-step="${id}"]`);
  ok('the Merge step is drawn last, greyed and marked off while merge is off', !!step('review-gate', 'merge') && step('review-gate', 'merge').classList.contains('off')
    && tx(step('review-gate', 'merge').querySelector('.step-off')) === 'off', tx(step('review-gate', 'merge')));
  ok('the Grade swaps vendors while cross-vendor checks prefer another vendor', /Astra instead when the builder is the same vendor as Fable/.test(tx(step('build', 'grade'))), tx(step('build', 'grade')));
  ok('the Build page points to the setting', /The Grade's vendor swap follows Cross-vendor checks in the review gate's settings \(now: Prefer another vendor\)\./.test(tx(card('build').querySelector('.pk-cross-note'))), tx(card('build')));

  console.log('\nC10: a pick opens the save bar; Preview and save shows the diff in its place; one save');
  {
    const opened = [];
    for (const [boxOf, label, line, want] of [[mg, 'Docs and tests only', 'agent merge to “Docs and tests only”', /"policy": "strict"/], [mg, 'Low-risk PRs', 'agent merge to “Low-risk PRs”', /"policy": "standard"/],
      [mg, 'Low and medium-risk PRs', 'agent merge to “Low and medium-risk PRs”', /"policy": "always"/], [cf, 'Off', 'cross-vendor checks to “Off”', /"crossFamily": "off"/],
      [secRow, 'Always', 'security pass to “Always”', /"run": "always"/]]) {
      await pick(boxOf, label);
      const named = tx(bar()?.querySelector('.pk-savebar-text')) === `1 change: ${line}` && !pre();
      await previewIt();
      opened.push(named && !!pre() && added(want) && !bar());
      acts().find((b) => tx(b) === 'Cancel').click();
      await settle(5);
    }
    ok('QA 2: every choice, merge, cross-vendor and security alike, names itself in the bar, and Preview and save shows its diff', opened.every(Boolean) && writes.length === 0, JSON.stringify(opened));
  }
  const plans = () => page.requests.filter((r) => /review-settings\/plan/.test(r.path)).length;
  const plansBefore = plans();
  await pick(mg, 'Low-risk PRs');
  ok('C10: a pick opens the bar: the change named, quiet Cancel and primary Preview and save; nothing previewed or written', tx(bar().querySelector('.pk-savebar-text')) === '1 change: agent merge to “Low-risk PRs”'
    && bar().querySelectorAll('button').map((b) => `${tx(b)}:${b.className}`).join('|') === 'Cancel:btn ghost|Preview and save:btn primary'
    && !pre() && writes.length === 0 && plans() === plansBefore, tx(bar()));
  ok('…the choice shows as picked, and the row\'s one line is the pick\'s', tx(pressed(mg())) === 'Low-risk PRs' && JSON.stringify(says(mg())) === '["An agent may merge any low-risk PR. You merge the rest."]', tx(mg()));
  ok('…with no Now or After Save lines', !/Now:|After Save:/.test(tx(sec())), tx(sec()));
  await pick(cf, 'Off');
  ok('C10: a second pick: the bar counts both', tx(bar().querySelector('.pk-savebar-text')) === '2 changes: agent merge to “Low-risk PRs” and cross-vendor checks to “Off”', tx(bar()));
  await previewIt();
  ok('C10: Preview and save shows the file and one diff with both in place of the bar, nothing written', !bar() && sec().querySelectorAll('.pk-sec-preview').length === 1
    && /this changes ~\/\.agent-config-studio\/review-gate\/config\.json, and a copy of it goes to the backups folder first/.test(tx(pre()))
    && added(/"policy": "standard"/) && added(/"crossFamily": "off"/) && writes.length === 0 && read(t.primary) === '{\n  "pick": "rotate"\n}\n', tx(pre()));
  ok('…the preview sits in the bar\'s place, after the rows, not inside them', !sec().querySelector('.pk-set-rows .pk-sec-preview') && !!sec().querySelector('.pk-savebar-slot .pk-sec-preview'));
  ok('the preview\'s buttons: Save (primary) and Cancel (quiet)', acts().map((b) => `${tx(b)}:${b.className}`).join('|') === 'Save:btn primary|Cancel:btn ghost');
  await saveIt();
  ok('Save writes both in one request and keeps the other keys', writes.length === 1 && /^[0-9a-f]{64}$/.test(writes[0].signature)
    && JSON.stringify(writes[0].changes) === '{"merge.policy":"standard","crossFamily":"off"}'
    && JSON.parse(read(t.primary)).merge.policy === 'standard' && JSON.parse(read(t.primary)).crossFamily === 'off' && JSON.parse(read(t.primary)).pick === 'rotate', read(t.primary));
  ok('C10: …with one backup', backupDirs(t).length === 1, backupDirs(t).join(' '));
  ok('…and says what it saved and where the old file went', /Saved: ~\/\.agent-config-studio\/review-gate\/config\.json now says “Low-risk PRs” \(agent merge\) and “Off” \(cross-vendor checks\)\. The old file is at ~\/\.agent-config-studio\/backups\//.test(tx(result())), tx(result()));
  ok('QA 6: the backup is shown as its ~ folder, never the nested absolute path', /The old file is at ~\/\.agent-config-studio\/backups\/[^\s/]+-review-settings\/\./.test(tx(result()))
    && !tx(result()).includes(t.h) && !/\/0\//.test(tx(result())), tx(result()));
  ok('QA 3: after Save no After Save line, no bar and no preview are left', !/After Save:/.test(tx(sec())) && !bar() && !pre(), tx(sec()));
  ok('…the pressed choices, the Merge step, the Grade note and the Build page follow', tx(pressed(mg())) === 'Low-risk PRs' && tx(pressed(cf())) === 'Off'
    && !step('review-gate', 'merge').classList.contains('off') && /no swap: Cross-vendor checks is off/.test(tx(step('build', 'grade')))
    && /\(now: Off\)/.test(tx(card('build').querySelector('.pk-cross-note'))), `${tx(step('build', 'grade'))} | ${tx(card('build').querySelector('.pk-cross-note'))}`);

  await pick(mg, 'Off');
  await pick(secRow, 'Always');
  ok('C10: picks waiting in the bar', tx(bar().querySelector('.pk-savebar-text')) === '2 changes: agent merge to “Off” and security pass to “Always”' && tx(pressed(mg())) === 'Off', tx(bar()));
  barBtn('Cancel').click();
  await settle(5);
  ok('C10: the bar\'s Cancel restores the saved values: the pressed choices and their lines, no bar, nothing written', !bar() && !pre() && tx(pressed(mg())) === 'Low-risk PRs' && tx(pressed(secRow())) === 'Off'
    && JSON.stringify(says(mg())) === '["An agent may merge any low-risk PR. You merge the rest."]' && writes.length === 1 && JSON.parse(read(t.primary)).merge.policy === 'standard', tx(sec()));
  await pick(mg, 'Off');
  await previewIt();
  acts().find((b) => tx(b) === 'Cancel').click();
  await settle(5);
  ok('the preview\'s Cancel drops the pending changes too and writes nothing', !pre() && !bar() && tx(pressed(mg())) === 'Low-risk PRs' && JSON.parse(read(t.primary)).merge.policy === 'standard');
  await pick(mg, 'Off');
  await pick(mg, 'Low-risk PRs');
  ok('picking back what is saved asks for nothing: no bar', !pre() && !bar() && writes.length === 1);

  console.log('\nC9: Edit paths opens its own page');
  await toPaths();
  ok('C9: Edit paths opens #packs/review-gate/paths, its own page', page.location.hash === '#packs/review-gate/paths' && page.eval('S.view') === 'pack' && !c().querySelector('.pk-settings') && !!pathsPage(), page.location.hash);
  ok('…titled Always needs you, with a quiet way back to the review gate', tx(pathsPage().querySelector('h1')) === 'Always needs you' && tx(pathsPage().querySelector('.pk-back')) === 'Review gate'
    && /\bbtn ghost\b/.test(pathsPage().querySelector('.pk-back').className), tx(pathsPage()).slice(0, 200));
  ok('C9: the built-in list and the risky list, read-only', pathsPage().querySelectorAll('.pk-path-list.built-in li').map(tx).join(',') === '.github/workflows/**,package.json'
    && pathsPage().querySelectorAll('.pk-path-list.risky li').map(tx).join(',') === DEFAULT_RISK_PATHS.join(',') && /the review gate's defaults/.test(tx(pathsPage())), tx(pathsPage()));
  ok('C9: …and one labelled box for your own, empty; no Preview button and no risky-paths editor', !!box() && !!box().getAttribute('aria-label') && box().value === ''
    && pathsPage().querySelectorAll('textarea').length === 1 && !pathsPage().querySelectorAll('button').some((b) => tx(b) === 'Preview') && !bar());
  page.input(box(), 'infra/**\n\n  db/** \ninfra/**');
  await settle(5);
  ok('C9: typing opens the save bar here, the box keeping what was typed', tx(bar()?.querySelector('.pk-savebar-text')) === '1 change: always needs you to “2 paths of your own”' && box().value === 'infra/**\n\n  db/** \ninfra/**', tx(bar()));
  await previewIt();
  ok('C9: Save there previews first: blank lines dropped, trimmed, repeats once, nothing written', !bar() && added(/"infra\/\*\*"/) && added(/"db\/\*\*"/) && writes.length === 1, tx(pre()));
  await saveIt();
  ok('…Save writes them, and the result counts them', JSON.parse(read(t.primary)).merge.alwaysHuman.join() === 'infra/**,db/**' && writes.length === 2
    && /now says “2 paths of your own”\./.test(tx(result())) && box().value === 'infra/**\ndb/**', tx(result()));
  await toPack();
  ok('C9: back returns to the review gate\'s page, focus on Edit paths, and the count follows', page.location.hash === '#packs/review-gate' && !pathsPage()
    && page.doc.activeElement === always().querySelector('.pk-edit-paths') && tx(always().querySelector('.pk-set-inline span')) === '11 paths: 2 built in, 7 risky, 2 of your own', `${page.location.hash} ${tx(always())}`);

  // Trap: paths typed on their page were lost when another setting was saved first.
  await toPaths();
  page.input(box(), 'infra/**\ndb/**\nvendor/**');
  await settle(5);
  await toPack();
  ok('typed paths, then back: the bar still holds them, and the count counts them', tx(bar()?.querySelector('.pk-savebar-text')) === '1 change: always needs you to “3 paths of your own”'
    && tx(always().querySelector('.pk-set-inline span')) === '12 paths: 2 built in, 7 risky, 3 of your own', tx(bar()));
  await pick(cf, 'Prefer another vendor');
  ok('…a choice joins them in the bar', tx(bar().querySelector('.pk-savebar-text')) === '2 changes: always needs you to “3 paths of your own” and cross-vendor checks to “Prefer another vendor”', tx(bar()));
  await previewIt();
  ok('typed paths, then a choice: the one preview covers both', added(/"vendor\/\*\*"/) && added(/"crossFamily": "prefer"/), tx(pre()));
  await saveIt();
  ok('…and Save writes both in one request', writes.length === 3 && JSON.parse(read(t.primary)).merge.alwaysHuman.join() === 'infra/**,db/**,vendor/**'
    && JSON.parse(read(t.primary)).crossFamily === 'prefer', read(t.primary));
  await toPaths();
  ok('…the box showing what was saved', box().value === 'infra/**\ndb/**\nvendor/**' && !bar(), box().value);

  page.input(box(), 'infra/**\nlib/**');
  await settle(5);
  await previewIt();
  box().value = 'infra/**\nlib/**\ncfg/**';
  const before = writes.length;
  acts().find((b) => tx(b) === 'Save').click();
  await waitFor(() => pre() && added(/"cfg\/\*\*"/));
  ok('QA 4: the refreshed preview says why it did not save', /The list changed since the preview; check the new preview and Save again\./.test(tx(pre())), tx(pre()));
  ok('paths edited after their preview: Save shows the new diff instead of writing the old list', writes.length === before
    && JSON.parse(read(t.primary)).merge.alwaysHuman.join() === 'infra/**,db/**,vendor/**' && added(/"cfg\/\*\*"/), tx(pre()));
  await saveIt();
  ok('…then Save writes what is on screen', JSON.parse(read(t.primary)).merge.alwaysHuman.join() === 'infra/**,lib/**,cfg/**' && box().value === 'infra/**\nlib/**\ncfg/**', read(t.primary));

  // Trap: an old paths list came back after the page's data was read again.
  put(t.primary, `${JSON.stringify({ ...JSON.parse(read(t.primary)), merge: { ...JSON.parse(read(t.primary)).merge, alwaysHuman: ['disk/**'] } }, null, 2)}\n`);
  await page.eval('pkLoad()');
  await settle(5);
  ok('the data read again: the box shows the list on disk, not the one saved before', box().value === 'disk/**' && !bar(), box().value);
  page.input(box(), 'typed/**');
  await settle(5);
  barBtn('Cancel').click();
  await settle(5);
  await page.eval('pkLoad()');
  await settle(5);
  ok('typed, then Cancel, then the data read again: the box shows the list on disk', box().value === 'disk/**' && !bar(), box().value);

  page.navigate('#packs/review-gate/paths');
  await settle(5);
  ok('C9: a hash change to the paths page lands on it', !!pathsPage() && page.location.hash === '#packs/review-gate/paths');
  page.navigate('#packs/build/paths');
  await settle(5);
  ok('…another pack has no paths page: a plain "No page called" with a way back', !pathsPage() && /No page called build\/paths\./.test(tx(c())) && !!c().querySelector('.pk-back'), tx(c()).slice(0, 200));

  await pick(mg, 'Low and medium-risk PRs');
  await previewIt();
  put(t.primary, '{"merge":{"policy":"strict"}}\n');
  const stale = writes.length;
  acts().find((b) => tx(b) === 'Save').click();
  await waitFor(() => sec().querySelector('.notice.error'));
  ok('a stale preview: the refusal is shown, and the file is not overwritten', /changed since the preview/.test(tx(sec().querySelector('.notice.error'))) && read(t.primary) === '{"merge":{"policy":"strict"}}\n', tx(sec()));
  ok('C10: …it asks to preview again: the preview is gone and the bar is back with the pick', !pre() && tx(bar()?.querySelector('.pk-savebar-text')) === '1 change: agent merge to “Low and medium-risk PRs”'
    && !!barBtn('Preview and save') && writes.length === stale + 1, tx(sec()));
  await previewIt();
  ok('…and previewing again shows the diff against the file as it is now', !!pre() && added(/"policy": "always"/) && !sec().querySelector('.notice.error'), tx(pre()));
  ok('no page errors', page.errors.length === 0, page.errors.join(' | '));
  page.done();

  console.log('\nC9: a reload on the paths page lands on it');
  {
    const cold = await bootPage({ routes, hash: '#packs/review-gate/paths' });
    for (let i = 0; i < 100 && !cold.$('content').querySelector('.pk-paths-page textarea'); i++) await sleep(30);
    await settle(10);
    ok('a reload on #packs/review-gate/paths lands on the paths page', cold.eval('S.view') === 'pack' && cold.location.hash === '#packs/review-gate/paths'
      && cold.text(cold.$('content').querySelector('.pk-paths-page h1')) === 'Always needs you', cold.text(cold.$('content')).slice(0, 200));
    ok('no page errors', cold.errors.length === 0, cold.errors.join(' | '));
    cold.done();
  }

  console.log('\nC8: the gh line shows only when it applies');
  {
    const tg = home();
    put(tg.primary, '{"merge":{"policy":"standard"}}\n');
    let gh = false;
    const rg = routesFor({ ...Object.fromEntries(['GET /api/packs/status', 'GET /api/models/roles'].map((k) => [k, routes.table[k]])),
      'GET /api/packs': () => { const v = withGate(view(tg)); v.settings.merge.gh = gh; return v; } });
    const pg = await bootPage({ routes: rg, hash: '#packs/review-gate' });
    const m2 = () => pg.$('content').querySelector('[data-pack="review-gate"] .pk-merge');
    for (let i = 0; i < 100 && !m2(); i++) await sleep(30);
    await settle(10);
    const warn = () => m2().querySelectorAll('.pk-set-warn');
    ok('gh missing and an agent may merge: one amber line in the agent merge row', warn().length === 1 && /needs the gh CLI/.test(pg.text(warn()[0])), pg.text(m2()));
    m2().querySelectorAll('.pk-tabs button').find((b) => pg.text(b) === 'Off').click();
    await settle(5);
    ok('…picking Off: no gh line', warn().length === 0, pg.text(m2()));
    gh = true;
    await pg.eval('pkLoad()');
    await settle(5);
    m2().querySelectorAll('.pk-tabs button').find((b) => pg.text(b) === 'Low-risk PRs').click();
    await settle(5);
    ok('gh on the PATH: no gh line', warn().length === 0, pg.text(m2()));
    ok('no page errors', pg.errors.length === 0, pg.errors.join(' | '));
    pg.done();
  }

  console.log('\nR1: no code-review part installed, no settings');
  installed = false;
  const bare = await bootPage({ routes, hash: '#packs/review-gate' });
  const bc = () => bare.$('content').querySelector('[data-pack="review-gate"]');
  for (let i = 0; i < 100 && !bc()?.querySelector('.pk-flow'); i++) await sleep(30);
  await settle(10);
  ok('the page shows no settings, and one sentence on what installing lets you set', !bc().querySelector('.pk-settings') && !bc().querySelector('.pk-sec-levels')
    && /Install the Code review part to set the security pass, agent merge and cross-vendor checks here\./.test(bare.text(bc().querySelector('.pk-settings-none'))), bare.text(bc()));
  bare.navigate('#packs/review-gate/paths');
  await settle(5);
  ok('…and the paths page says the same, with no box', !bare.$('content').querySelector('textarea') && /Install the Code review part/.test(bare.text(bare.$('content').querySelector('.pk-paths-page'))), bare.text(bare.$('content')).slice(0, 200));
  ok('no page errors', bare.errors.length === 0, bare.errors.join(' | '));
  bare.done();

  console.log('\nQA 1 and 5: a first save, and the Grade note with the judge unset');
  {
    installed = true;
    const t3 = home();
    const r3 = routesFor({ 'GET /api/packs/status': routes.table['GET /api/packs/status'], 'GET /api/models/roles': () => ({ roles: [] }),
      'GET /api/packs': () => withGate(view(t3)),
      'POST /api/packs/review-settings/plan': (b) => settingsPlan(b.changes, t3.m),
      'POST /api/packs/review-settings/apply': (b) => settingsApply(b.changes, b.signature, t3.m) });
    const p3 = await bootPage({ routes: r3, hash: '#packs/review-gate' });
    const s3 = () => p3.$('content').querySelector('[data-pack="review-gate"] .pk-settings');
    for (let i = 0; i < 100 && !s3(); i++) await sleep(30);
    await settle(10);
    s3().querySelector('.pk-cross .pk-tabs').querySelectorAll('button').find((b) => p3.text(b) === 'Off').click();
    await settle(5);
    s3().querySelector('.pk-savebar').querySelectorAll('button').find((b) => p3.text(b) === 'Preview and save').click();
    for (let i = 0; i < 100 && !s3().querySelector('.pk-sec-preview'); i++) await sleep(20);
    s3().querySelector('.pk-sec-preview').querySelectorAll('button').find((b) => p3.text(b) === 'Save').click();
    for (let i = 0; i < 100 && !s3().querySelector('.pk-result'); i++) await sleep(20);
    await settle(5);
    ok('QA 5: a first save that creates the file says no backup was needed', /now says “Off”\. No existing file needed a backup\./.test(p3.text(s3().querySelector('.pk-result')))
      && JSON.parse(read(t3.primary)).crossFamily === 'off', p3.text(s3().querySelector('.pk-result')));
    p3.navigate('#packs/build');
    const grade = p3.text(p3.$('content').querySelector('[data-pack="build"] .step[data-step="grade"]'));
    ok('QA 1: with the judge unset, the Grade still says there is no swap', /not set/.test(grade) && /no swap: Cross-vendor checks is off/.test(grade), grade);
    ok('no page errors', p3.errors.length === 0, p3.errors.join(' | '));
    p3.done();
  }
  {
    // QA 7: light-theme chips from the stylesheet's own tokens, the role chip's tint worked out as color-mix does.
    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
    const light = css.slice(css.indexOf(':root[data-theme="light"]'), css.indexOf('}', css.indexOf(':root[data-theme="light"]')));
    const tok = (n) => light.match(new RegExp(`--${n}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
    const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const lum = (c) => c.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (f, b) => { const [x, y] = [lum(f), lum(b)].sort((a, c) => c - a); return (x + 0.05) / (y + 0.05); };
    const tint = rgb(tok('accent')).map((v, i) => v * 0.11 + rgb(tok('panel'))[i] * 0.89);
    const pairs = { 'role name on its chip': ratio(rgb(tok('accent-ink')), tint), '"not set" on a role chip': ratio(rgb(tok('muted')), tint) };
    ok('QA 7: light theme, the role chip\'s name and "not set" are at least 4.5:1', Object.values(pairs).every((r) => r >= 4.5), JSON.stringify(pairs));
  }

  console.log('\nR7: the older home config is in Files, so the footer opens it');
  {
    installed = true;
    const t2 = home();
    put(t2.older, '{"merge":{"policy":"off"}}\n');
    const reg = registry();
    reg.groups.push({ id: 'settings', title: 'Settings & config', createKind: null, entries: [
      { id: 'cfg:review', label: 'Review config', harness: 'claude', kindLabel: 'config', display: '~/.claude/review-config.json', scope: 'global',
        dir: '/h/.claude', primary: '/h/.claude/review-config.json', deletable: false, files: [{ name: 'review-config.json', path: '/h/.claude/review-config.json', display: '~/.claude/review-config.json' }] },
    ] });
    const r2 = routesFor({ ...Object.fromEntries(['GET /api/packs/status', 'GET /api/models/roles'].map((k) => [k, routes.table[k]])),
      'GET /api/packs': () => withGate(view(t2)), 'GET /api/registry': () => reg });
    r2.files.set('/h/.claude/review-config.json', '{"merge":{"policy":"off"}}\n');
    const op = await bootPage({ routes: r2, hash: '#packs/review-gate' });
    const foot = () => op.$('content').querySelector('[data-pack="review-gate"] .pk-set-foot');
    for (let i = 0; i < 100 && !foot(); i++) await sleep(30);
    await settle(10);
    const btn = foot()?.querySelector('button');
    ok('the footer names ~/.claude/review-config.json, with an Open in Files button (quiet)', /^Saved in ~\/\.claude\/review-config\.json/.test(op.text(foot()))
      && op.text(btn) === 'Open in Files' && /\bbtn ghost\b/.test(btn.className), op.text(foot()));
    btn.click();
    for (let i = 0; i < 100 && !op.eval('S.file && S.file.path'); i++) await sleep(20);
    ok('…which opens it in the editor', op.eval('S.view') === 'entry' && op.eval('S.file && S.file.path') === '/h/.claude/review-config.json', `${op.eval('S.view')} ${op.eval('S.file && S.file.path')}`);
    ok('no page errors', op.errors.length === 0, op.errors.join(' | '));
    op.done();
  }

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
    for (const route of ['/api/packs/review-settings/plan', '/api/packs/review-settings/apply']) {
      const r = await post(route, { changes: { crossFamily: 'off' }, signature: '0'.repeat(64) }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
      ok(`a foreign origin: POST ${route} → 403`, r.status === 403, `${r.status} ${r.text.slice(0, 120)}`);
    }
    ok('an unknown field: 400', (await post('/api/packs/review-settings/plan', { changes: { crossFamily: 'off' }, path: '/etc/x' })).status === 400);
    ok('a key outside the allow-list: 400', (await post('/api/packs/review-settings/plan', { changes: { verifyCmd: 'rm -rf ~' } })).status === 400 && !fs.existsSync(file));
    const plan = await post('/api/packs/review-settings/plan', { changes: { 'merge.policy': 'strict', 'merge.alwaysHuman': ['infra/**'] } });
    ok('a plan answers with the diff and writes nothing, with no absolute HOME path in it', plan.status === 200 && plan.body.changes && !fs.existsSync(file) && !plan.text.includes(sb.home), plan.text.slice(0, 300));
    const applied = await post('/api/packs/review-settings/apply', { changes: { 'merge.policy': 'strict', 'merge.alwaysHuman': ['infra/**'] }, signature: plan.body.signature });
    ok('apply with the plan\'s signature writes it', applied.status === 200 && JSON.parse(fs.readFileSync(file, 'utf8')).merge.policy === 'strict', applied.text.slice(0, 300));
    const again = await post('/api/packs/review-settings/apply', { changes: { 'merge.policy': 'strict', 'merge.alwaysHuman': ['infra/**'] }, signature: plan.body.signature });
    ok('the same signature again, now stale: 409', again.status === 409, `${again.status} ${again.text.slice(0, 120)}`);
    const pk = await fetch(`${base}/api/packs`, { headers: { 'sec-fetch-site': 'same-origin' } });
    const pkText = await pk.text();
    const pkBody = JSON.parse(pkText);
    ok('GET /api/packs carries the current values, with no absolute HOME path', pkBody.settings?.merge?.policy === 'strict' && pkBody.settings.merge.alwaysHuman.join() === 'infra/**'
      && pkBody.settings.crossFamily === 'prefer' && !pkText.includes(sb.home), JSON.stringify(pkBody.settings));
    child.kill('SIGKILL');
  } finally { sb.cleanup(); }
} catch (e) {
  ok(`no test block threw (${e?.message || e})`, false, e?.stack || String(e));
} finally {
  try { assertRealHomesUnchanged(realBefore, ok); } catch (e) { ok('the real homes are unchanged', false, e.message); }
  done();
}
