/**
 * The catalog side of acs packs (plan.md C3, C10, C15): every pack and part
 * explains itself and `acs packs explain` prints it; nothing personal ships or
 * gets installed; the npm package carries packs/ without their tests, and an
 * install from the packed tarball (where npm leaves the hook links out) still
 * gates a push. Temp HOME, temp npm cache, stub CLIs, offline.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { ROOT, sandbox, tests } from './fixtures/packs-sandbox.mjs';
import { explainOf, loadCatalog, validatePack } from '../lib/packs.js';

const realBefore = snapshotRealHomes();
const { ok, done } = tests();
const boxes = [];
const box = (...a) => { const b = sandbox(...a); boxes.push(b); return b; };
const C3 = /cris|cristian|cortega|crisnc100|ortega|\/Users\/|Documents\/Projects|codex-seats|atlas|\bjev\b/i;

console.log('\nC10 every pack and part explains itself');
const catalog = loadCatalog();
ok('C10 the six packs load, worktree setup included', ['review-gate', 'build', 'advisor', 'second-opinion', 'handoff', 'worktree'].every((id) => catalog.some((p) => p.id === id)), catalog.map((p) => p.id).join());
for (const pack of catalog) {
  const full = ['what', 'does', 'undo'].every((k) => pack.explain[k]?.trim()) && pack.explain.changes.length && pack.summary.trim();
  ok(`C10 ${pack.id}: a summary and a full explain`, !!full);
  for (const part of pack.parts) {
    const e = explainOf(pack, part);
    ok(`C10 ${pack.id}/${part.id}: its own non-empty changes, and what/does/undo`, e.changes.length > 0 && e.changes.every((c) => c.trim()) && ['what', 'does', 'undo'].every((k) => e[k]?.trim()));
  }
}
{
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'packs/advisor/pack.json'), 'utf8'));
  const broken = [
    ['an empty summary', (p) => { p.summary = ' '; }],
    ['no explain.undo', (p) => { delete p.explain.undo; }],
    ['an empty explain.what', (p) => { p.explain.what = ''; }],
    ['empty pack changes', (p) => { p.explain.changes = []; }],
    ['a part with no changes of its own', (p) => { delete p.parts[0].explain.changes; }],
    ['a part with an empty change', (p) => { p.parts[0].explain.changes = ['']; }],
  ];
  for (const [what, edit] of broken) {
    const p = structuredClone(base); edit(p);
    let threw = false;
    try { validatePack(p); } catch { threw = true; }
    ok(`C10 the manifest check fails on ${what}`, threw);
  }
}
{
  const sb = box('explain', { clis: ['claude'] });
  for (const pack of catalog) {
    const r = sb.packs(['explain', pack.id]);
    const parts = pack.parts.every((part) => r.stdout.includes(`Part ${part.id}:`) && explainOf(pack, part).changes.every((c) => r.stdout.includes(c)));
    ok(`C10 acs packs explain ${pack.id} prints the summary, what/does/changes/undo and every part's changes`,
      r.code === 0 && r.stdout.includes(pack.summary) && ['what', 'does', 'undo'].every((k) => r.stdout.includes(pack.explain[k])) && pack.explain.changes.every((c) => r.stdout.includes(c)) && parts, r.out.slice(0, 400));
  }
  const l = sb.json(['list']);
  ok('acs packs list names every pack with its summary', l.code === 0 && l.data.length === catalog.length && l.data.every((x) => x.summary && Array.isArray(x.installed)));
  const bin = sb.run('/bin/sh', [path.join(ROOT, 'bin/acs'), 'packs', 'explain', 'handoff']);
  ok('acs packs is wired into bin/acs', bin.code === 0 && bin.stdout.includes('Handoff'), bin.out);
  const help = sb.run('/bin/sh', [path.join(ROOT, 'bin/acs'), 'help']);
  ok('…and listed in acs help', /acs packs list\|explain\|install\|status\|update\|uninstall/.test(help.stdout), help.out);
}

console.log('\nC3 nothing personal ships, or gets installed');
{
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/\/packs\/[^/]+\/tests$/.test(p)) walk(p); continue; }
      if (e.isSymbolicLink()) continue;
      fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => { if (C3.test(l)) hits.push(`${path.relative(ROOT, p)}:${i + 1}`); });
    }
  };
  walk(path.join(ROOT, 'packs'));
  ok('C3 the sweep finds nothing under packs/ (tests excepted)', hits.length === 0, hits.join(' '));
  const sb = box('c3', { clis: ['claude', 'codex'] });
  for (const pack of catalog) {
    const parts = pack.parts.filter((p) => p.kind !== 'worktree').map((p) => p.id);
    if (parts.length) sb.packs(['install', pack.id, '--part', parts.join(','), '--yes', '--with-deps']);
  }
  const st = sb.state();
  const installed = [...Object.values(st.packs).flatMap((p) => Object.values(p.parts).flatMap((x) => Object.keys(x.files))), ...Object.keys(st.runtime.files)];
  // hooks/node-path is generated on this machine: it names this machine's node by design.
  const swept = installed.filter((f) => !f.endsWith('/hooks/node-path') && fs.existsSync(f) && !fs.lstatSync(f).isSymbolicLink());
  const bad = swept.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').map((l, i) => (C3.test(l) ? `${f}:${i + 1}` : null)).filter(Boolean));
  ok(`C3 the sweep finds nothing in the ${swept.length} files every pack installed`, swept.length > 30 && bad.length === 0, bad.join(' '));
}

console.log('\nC15 the npm package');
{
  const sb = box('c15', { clis: ['claude'] });
  const npmEnv = { ...sb.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, npm_config_cache: path.join(sb.root, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_offline: 'true' };
  const NPM = fs.existsSync(path.join(path.dirname(process.execPath), 'npm')) ? path.join(path.dirname(process.execPath), 'npm') : 'npm';
  const dry = spawnSync(NPM, ['pack', '--dry-run', '--json'], { cwd: ROOT, env: npmEnv, encoding: 'utf8' });
  let files = [];
  try { files = JSON.parse(dry.stdout)[0].files.map((f) => f.path); } catch {}
  ok('C15 npm pack --dry-run includes packs/', files.includes('packs/review-gate/pack.json') && files.includes('packs/review-gate/runtime/review.mjs') && files.includes('packs/worktree/pack.json'), dry.stderr);
  ok('C15 …and leaves out builds/, reviews/ and every test inside packs', !files.some((f) => /^(builds|reviews)\//.test(f) || /^packs\/[^/]+\/tests\//.test(f)), files.filter((f) => /^(builds|reviews)\/|\/tests\//.test(f)).join(' '));
  const links = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isSymbolicLink()) links.push(p); } };
  walk(path.join(ROOT, 'packs'));
  ok('every link in packs/ is a hooks/global entry pointing at run-hook (what the installer recreates)', links.length > 20 && links.every((l) => path.basename(path.dirname(l)) === 'global' && fs.readlinkSync(l) === 'run-hook'), links.filter((l) => fs.readlinkSync(l) !== 'run-hook').join(' '));
  // Install from the packed tarball itself, where npm dropped those links.
  const pack = spawnSync(NPM, ['pack', '--pack-destination', sb.root], { cwd: ROOT, env: npmEnv, encoding: 'utf8' });
  const tgz = path.join(sb.root, pack.stdout.trim().split('\n').pop());
  const unpacked = path.join(sb.root, 'unpacked');
  fs.mkdirSync(unpacked);
  execFileSync('tar', ['-xzf', tgz, '-C', unpacked]);
  const pkg = path.join(unpacked, 'package');
  ok('the tarball unpacks, and its hooks/global holds no links', fs.existsSync(path.join(pkg, 'bin/packs.mjs')) && !fs.existsSync(path.join(pkg, 'packs/review-gate/runtime/hooks/global/pre-push')));
  const r = sb.run(process.execPath, [path.join(pkg, 'bin/packs.mjs'), 'install', 'review-gate', '--part', 'push-gate', '--yes']);
  const entry = path.join(sb.home, '.agent-config-studio/review-gate/hooks/global/pre-push');
  ok('an install from the package makes each hook entry as a link to run-hook', r.code === 0 && fs.lstatSync(entry, { throwIfNoEntry: false })?.isSymbolicLink() && fs.readlinkSync(entry) === 'run-hook', r.out.slice(-600));
  const repo = path.join(sb.root, 'gated'), remote = path.join(sb.root, 'gated.git');
  fs.mkdirSync(repo);
  sb.git(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a'), 'a\n'); sb.git(repo, 'add', '.'); sb.git(repo, 'commit', '-qm', 'a');
  sb.git(sb.root, 'init', '-q', '--bare', remote); sb.git(repo, 'remote', 'add', 'origin', remote); sb.git(repo, 'config', 'reviewgate.enabled', 'true');
  const push = sb.git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  ok('…and the push gate it installed refuses an unreviewed push in an opted-in repo', push.code !== 0 && /Push blocked/.test(push.out), push.out);
  const st = sb.run(process.execPath, [path.join(pkg, 'bin/packs.mjs'), 'status', '--no-trust-check']);
  ok('…and status from the package calls it installed, not an update', /push-gate: installed\n/.test(st.stdout), st.out);
}

for (const b of boxes) b.cleanup();
assertRealHomesUnchanged(realBefore, ok);
done();
