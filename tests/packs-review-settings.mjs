/**
 * The review gate's Settings section (Packs → Review gate): the security
 * pass, agent merge, the paths that always need you and cross-vendor checks,
 * through one writer over an allow-list of keys (security.run, merge.policy,
 * merge.alwaysHuman, crossFamily) into the home review config the review
 * script reads first, with one preview, one signature and one backup per
 * save. Also where those settings show elsewhere: the Merge step in the
 * review gate's diagram, the Grade's swap note and its pointer on the Build
 * card, and the Packs page's one-line promise.
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

  console.log('\nthe page: the Settings section on the review gate card');
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
  const page = await bootPage({ routes, hash: '#packs' });
  const c = () => page.$('content');
  const card = (id = 'review-gate') => c().querySelector(`[data-pack="${id}"]`);
  const sec = () => card()?.querySelector('.pk-settings');
  const mg = () => sec()?.querySelector('.pk-merge');
  const cf = () => sec()?.querySelector('.pk-cross');
  for (let i = 0; i < 100 && !mg(); i++) await sleep(30);
  await settle(10);
  const tx = (n) => (n ? page.text(n) : '');
  const choices = (box) => box.querySelectorAll('.pk-choice-row button');
  const pressed = (box) => choices(box).find((b) => b.getAttribute('aria-pressed') === 'true');
  const pre = () => sec().querySelector('.pk-sec-preview');
  const acts = () => pre().querySelectorAll('button');
  const waitFor = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await sleep(20); await settle(5); };

  ok('R8: the Packs page says its promise once', c().querySelectorAll('.pk-promise').length === 1
    && /The studio sets how its own packs behave here\. Everything else it shows and edits as files\./.test(tx(c().querySelector('.pk-promise'))), tx(c().querySelector('.pk-promise')));
  ok('one Settings section on the review gate card, holding the security switch, agent merge and cross-vendor checks', c().querySelectorAll('.pk-settings').length === 1
    && !!sec().querySelector('.pk-sec-levels') && !!mg() && !!cf(), tx(sec()));
  ok('R3: four merge choices in plain words, Off pressed', choices(mg()).map(tx).join('|') === 'Off|Docs and tests only|Low-risk PRs|Low and medium-risk PRs' && tx(pressed(mg())) === 'Off',
    choices(mg()).map(tx).join('|'));
  ok('…each with its one line', ['You merge every PR.', 'An agent may merge a low-risk PR that changes only docs or tests.', 'An agent may merge any low-risk PR.',
    'An agent may merge low- and medium-risk PRs: medium-risk code merges without you. High-risk always waits for you.'].every((s) => tx(mg()).includes(s)), tx(mg()));
  ok('…its Now line, with what it needs: the gh CLI, and CI checks', /Now: You merge every PR\. Agent merge needs the gh CLI, and a repo with no CI checks always waits for you\./.test(tx(mg())), tx(mg()));
  ok('…and the line that holds whatever you pick', /An agent merges only through merge\.mjs, and only when the review is closed at the tip, CI is green and nobody asked for changes\./.test(tx(mg())), tx(mg()));
  const paths = () => mg().querySelector('.pk-paths');
  ok('R4: Always needs you lists the built-ins and the risky paths read-only', /Always needs you/.test(tx(paths())) && /Built in: \.github\/workflows\/\*\*, package\.json/.test(tx(paths()))
    && new RegExp(`Risky paths \\(the review gate's defaults\\): ${DEFAULT_RISK_PATHS.map((p) => p.replace(/[*.]/g, '\\$&')).join(', ')}`).test(tx(paths())), tx(paths()));
  const box = () => paths().querySelector('textarea');
  ok('…and your own paths in one box, one per line, labelled, with a Preview button; no risky-paths editor', !!box() && !!box().getAttribute('aria-label') && box().value === ''
    && paths().querySelectorAll('textarea').length === 1 && tx(paths().querySelector('button')) === 'Preview' && /\bbtn\b/.test(paths().querySelector('button').className));
  ok('R5: Cross-vendor checks, Prefer another vendor pressed, each with its line', choices(cf()).map(tx).join('|') === 'Prefer another vendor|Off' && tx(pressed(cf())) === 'Prefer another vendor'
    && tx(cf()).includes('Reviews and grades use a model from another vendor when one is available; never a blocker.') && tx(cf()).includes('Any reviewer in your roles may check any work.'), tx(cf()));
  ok('R7: one line names where the other review settings live (the primary file has no Files entry, so no button)', /Other review settings live in ~\/\.agent-config-studio\/review-gate\/config\.json\./.test(tx(sec().querySelector('.pk-other')))
    && !sec().querySelector('.pk-other button'), tx(sec().querySelector('.pk-other')));
  ok('every button is a styled kind, and no fold on the card', sec().querySelectorAll('button').every((b) => /\bbtn\b/.test(b.className)) && !card().querySelector('details'));
  ok('no raw key name in a label or a choice', [...sec().querySelectorAll('.pk-choice-row button'), ...sec().querySelectorAll('.pk-label')].every((n) => !/merge\.policy|alwaysHuman|crossFamily|riskPaths|strict|standard/.test(tx(n))));

  console.log('\nR6 and R5: the diagram, the Grade and the Build card follow the settings');
  const step = (pack, id) => card(pack)?.querySelector(`.step[data-step="${id}"]`);
  ok('the Merge step is drawn last, greyed and marked off while merge is off', !!step('review-gate', 'merge') && step('review-gate', 'merge').classList.contains('off')
    && tx(step('review-gate', 'merge').querySelector('.step-off')) === 'off', tx(step('review-gate', 'merge')));
  ok('the Grade swaps vendors while cross-vendor checks prefer another vendor', /Astra instead when the builder is the same vendor as Fable/.test(tx(step('build', 'grade'))), tx(step('build', 'grade')));
  ok('the Build card points to the setting', /The Grade's vendor swap follows Cross-vendor checks in the review gate's settings \(now: Prefer another vendor\)\./.test(tx(card('build').querySelector('.pk-cross-note'))), tx(card('build')));

  console.log('\none pending preview for the section, one save');
  choices(mg()).find((b) => tx(b) === 'Low-risk PRs').click();
  await waitFor(() => pre());
  ok('choosing Low-risk PRs shows the file and its diff first, nothing written', /this changes ~\/\.agent-config-studio\/review-gate\/config\.json, and a copy of it goes to the backups folder first/.test(tx(pre()))
    && pre().querySelectorAll('.diff-line.add').some((l) => /"policy": "standard"/.test(tx(l))) && writes.length === 0 && read(t.primary) === '{\n  "pick": "rotate"\n}\n', tx(pre()));
  ok('…the choice shows as picked while it waits', tx(pressed(mg())) === 'Low-risk PRs');
  choices(cf()).find((b) => tx(b) === 'Off').click();
  await waitFor(() => pre() && pre().querySelectorAll('.diff-line.add').some((l) => /crossFamily/.test(tx(l))));
  ok('a second change joins the same preview: one diff with both', sec().querySelectorAll('.pk-sec-preview').length === 1
    && pre().querySelectorAll('.diff-line.add').some((l) => /"policy": "standard"/.test(tx(l))) && pre().querySelectorAll('.diff-line.add').some((l) => /"crossFamily": "off"/.test(tx(l))), tx(pre()));
  ok('the preview\'s buttons: Save (primary) and Cancel (quiet)', acts().map((b) => `${tx(b)}:${b.className}`).join('|') === 'Save:btn primary|Cancel:btn ghost');
  acts().find((b) => tx(b) === 'Save').click();
  await waitFor(() => sec().querySelector('.pk-result'));
  ok('Save writes both in one request and keeps the other keys', writes.length === 1 && /^[0-9a-f]{64}$/.test(writes[0].signature)
    && JSON.stringify(writes[0].changes) === '{"merge.policy":"standard","crossFamily":"off"}'
    && JSON.parse(read(t.primary)).merge.policy === 'standard' && JSON.parse(read(t.primary)).crossFamily === 'off' && JSON.parse(read(t.primary)).pick === 'rotate', read(t.primary));
  ok('…and says what it saved and where the old file went', /Saved: ~\/\.agent-config-studio\/review-gate\/config\.json now says “Low-risk PRs” \(agent merge\) and “Off” \(cross-vendor checks\)\. The old file is at ~\/\.agent-config-studio\/backups\//.test(tx(sec().querySelector('.pk-result'))), tx(sec().querySelector('.pk-result')));
  ok('…the pressed choices, the Merge step, the Grade note and the Build card follow', tx(pressed(mg())) === 'Low-risk PRs' && tx(pressed(cf())) === 'Off'
    && !step('review-gate', 'merge').classList.contains('off') && /no swap: Cross-vendor checks is off/.test(tx(step('build', 'grade')))
    && /\(now: Off\)/.test(tx(card('build').querySelector('.pk-cross-note'))), `${tx(step('build', 'grade'))} | ${tx(card('build').querySelector('.pk-cross-note'))}`);

  box().value = 'infra/**\n\n  db/** \ninfra/**';
  paths().querySelector('button').click();
  await waitFor(() => pre());
  ok('Preview of your paths: blank lines dropped, trimmed, repeats once', pre().querySelectorAll('.diff-line.add').some((l) => /"infra\/\*\*"/.test(tx(l)))
    && pre().querySelectorAll('.diff-line.add').some((l) => /"db\/\*\*"/.test(tx(l))), tx(pre()));
  acts().find((b) => tx(b) === 'Save').click();
  await waitFor(() => sec().querySelector('.pk-result'));
  ok('…Save writes them, and the result counts them', JSON.parse(read(t.primary)).merge.alwaysHuman.join() === 'infra/**,db/**'
    && /now says “2 paths of your own”\./.test(tx(sec().querySelector('.pk-result'))) && box().value === 'infra/**\ndb/**', tx(sec().querySelector('.pk-result')));

  choices(mg()).find((b) => tx(b) === 'Off').click();
  await waitFor(() => pre());
  acts().find((b) => tx(b) === 'Cancel').click();
  await settle(5);
  ok('Cancel drops the whole pending preview and writes nothing', !pre() && tx(pressed(mg())) === 'Low-risk PRs' && JSON.parse(read(t.primary)).merge.policy === 'standard');
  choices(mg()).find((b) => tx(b) === 'Low-risk PRs').click();
  await settle(5);
  ok('choosing what is already in force asks for nothing', !pre() && writes.length === 2);

  // f1: the box's text is part of every preview and every Save, whatever was clicked.
  box().value = 'infra/**\ndb/**\nvendor/**';
  choices(cf()).find((b) => tx(b) === 'Prefer another vendor').click();
  await waitFor(() => pre());
  ok('typed paths, then a choice: the one preview covers both', pre().querySelectorAll('.diff-line.add').some((l) => /"vendor\/\*\*"/.test(tx(l)))
    && pre().querySelectorAll('.diff-line.add').some((l) => /"crossFamily": "prefer"/.test(tx(l))), tx(pre()));
  acts().find((b) => tx(b) === 'Save').click();
  await waitFor(() => sec().querySelector('.pk-result'));
  ok('…and Save writes both, the box showing what was saved', JSON.parse(read(t.primary)).merge.alwaysHuman.join() === 'infra/**,db/**,vendor/**'
    && JSON.parse(read(t.primary)).crossFamily === 'prefer' && box().value === 'infra/**\ndb/**\nvendor/**', read(t.primary));

  box().value = 'infra/**\nlib/**';
  paths().querySelector('button').click();
  await waitFor(() => pre());
  box().value = 'infra/**\nlib/**\ncfg/**';
  const before = writes.length;
  acts().find((b) => tx(b) === 'Save').click();
  await waitFor(() => pre() && pre().querySelectorAll('.diff-line.add').some((l) => /"cfg\/\*\*"/.test(tx(l))));
  ok('paths edited after their preview: Save shows the new diff instead of writing the old list', writes.length === before
    && JSON.parse(read(t.primary)).merge.alwaysHuman.join() === 'infra/**,db/**,vendor/**' && pre().querySelectorAll('.diff-line.add').some((l) => /"cfg\/\*\*"/.test(tx(l))), tx(pre()));
  acts().find((b) => tx(b) === 'Save').click();
  await waitFor(() => sec().querySelector('.pk-result'));
  ok('…then Save writes what is on screen', JSON.parse(read(t.primary)).merge.alwaysHuman.join() === 'infra/**,lib/**,cfg/**' && box().value === 'infra/**\nlib/**\ncfg/**', read(t.primary));

  choices(mg()).find((b) => tx(b) === 'Low and medium-risk PRs').click();
  await waitFor(() => pre());
  put(t.primary, '{"merge":{"policy":"strict"}}\n');
  acts().find((b) => tx(b) === 'Save').click();
  await waitFor(() => sec().querySelector('.notice.error'));
  ok('a stale preview: the refusal is shown, and the file is not overwritten', /changed since the preview/.test(tx(sec().querySelector('.notice.error'))) && read(t.primary) === '{"merge":{"policy":"strict"}}\n', tx(sec()));
  ok('no page errors', page.errors.length === 0, page.errors.join(' | '));
  page.done();

  console.log('\nR1: no code-review part installed, no settings');
  installed = false;
  const bare = await bootPage({ routes, hash: '#packs' });
  const bc = () => bare.$('content').querySelector('[data-pack="review-gate"]');
  for (let i = 0; i < 100 && !bc()?.querySelector('.pk-flow'); i++) await sleep(30);
  await settle(10);
  ok('the card shows no settings, and one sentence on what installing lets you set', !bc().querySelector('.pk-settings') && !bc().querySelector('.pk-sec-levels')
    && /Install the Code review part to set the security pass, agent merge and cross-vendor checks here\./.test(bare.text(bc().querySelector('.pk-settings-none'))), bare.text(bc()));
  ok('no page errors', bare.errors.length === 0, bare.errors.join(' | '));
  bare.done();

  console.log('\nR7: the older home config is in Files, so the line opens it');
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
    const op = await bootPage({ routes: r2, hash: '#packs' });
    const other = () => op.$('content').querySelector('[data-pack="review-gate"] .pk-other');
    for (let i = 0; i < 100 && !other(); i++) await sleep(30);
    await settle(10);
    const btn = other()?.querySelector('button');
    ok('the line names ~/.claude/review-config.json, with an Open in Files button (quiet)', /Other review settings live in ~\/\.claude\/review-config\.json\./.test(op.text(other()))
      && op.text(btn) === 'Open in Files' && /\bbtn ghost\b/.test(btn.className), op.text(other()));
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
