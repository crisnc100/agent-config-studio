/**
 * The flag pack through acs packs (builds/flag-skill/plan.md): it installs the skill and its helper into both
 * harness skill folders, the installed helper files a report into the temp HOME, status calls it installed, and
 * an uninstall removes the skill folders while the reports stay. Temp HOME, stub CLIs; no model CLI is ever run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { ROOT, changed, sandbox, tests, tree } from './fixtures/packs-sandbox.mjs';
import { validatePack } from '../lib/packs.js';

const realBefore = snapshotRealHomes();
const { ok, done } = tests();
const boxes = [];
const box = (...a) => { const b = sandbox(...a); boxes.push(b); return b; };

console.log('\nflag: the two helper copies are one script');
{
  const a = fs.readFileSync(path.join(ROOT, 'packs/flag/skills/claude/flag/flag.mjs'));
  const b = fs.readFileSync(path.join(ROOT, 'packs/flag/skills/codex/flag/flag.mjs'));
  ok('the Claude Code and Codex copies of flag.mjs are byte-identical', a.equals(b));
}

console.log('\nflag: install, use, uninstall');
{
  const sb = box('flag', { clis: ['claude', 'codex'], modelId: false });
  const before = tree(sb.home);
  const r = sb.packs(['install', 'flag', '--yes']);
  const claude = path.join(sb.home, '.claude/skills/flag'), codex = path.join(sb.env.CODEX_HOME, 'skills/flag');
  ok('flag installs without model-id or ask-model on PATH', r.code === 0, r.out);
  ok('…into both harness skill folders, SKILL.md and flag.mjs each', ['SKILL.md', 'flag.mjs'].every((f) => fs.existsSync(path.join(claude, f)) && fs.existsSync(path.join(codex, f))), r.out);
  ok('…as the pack ships them', ['claude', 'codex'].every((h) => ['SKILL.md', 'flag.mjs'].every((f) => sb.read(path.join(h === 'claude' ? claude : codex, f)) === fs.readFileSync(path.join(ROOT, 'packs/flag/skills', h, 'flag', f), 'utf8'))));
  ok('…and touches nothing outside those two folders and the pack state', changed(before, tree(sb.home)).every((p) => p.startsWith(claude) || p.startsWith(codex) || p.startsWith(path.join(sb.home, '.agent-config-studio')) || [path.dirname(claude), path.dirname(codex)].includes(p)), changed(before, tree(sb.home)).join(' '));
  ok('…and no field-reports folder exists until the first report', !fs.existsSync(path.join(sb.home, '.agent-config-studio/field-reports')));

  const st = sb.json(['status']);
  const row = st.data?.packs?.find((x) => x.id === 'flag');
  ok('status calls it installed for claude and codex', row?.parts?.[0]?.statuses?.join() === 'installed', JSON.stringify(row));

  const planted = 'gh' + 'p_' + 'Z9y8X7w6V5u4T3s2R1q0'.repeat(2);
  for (const [h, dir] of [['claude', claude], ['codex', codex]]) {
    const w = sb.run(process.execPath, [path.join(dir, 'flag.mjs'), 'write'], { input: JSON.stringify({ what: `from ${h} with ${planted}`, severity: 'low', harness: h }) });
    ok(`the installed ${h} helper files a report in the temp HOME`, w.code === 0 && /^flagged \S+\n/.test(w.stdout), w.out);
  }
  const reports = path.join(sb.home, '.agent-config-studio/field-reports');
  const files = fs.existsSync(reports) ? fs.readdirSync(reports) : [];
  ok('…two reports, 0600 in a 0700 folder, the planted token redacted', files.length === 2 && (fs.statSync(reports).mode & 0o777) === 0o700
    && files.every((f) => (fs.statSync(path.join(reports, f)).mode & 0o777) === 0o600 && !sb.read(path.join(reports, f)).includes(planted)), files.join(' '));
  const list = sb.run(process.execPath, [path.join(claude, 'flag.mjs'), 'list']);
  ok('…and list shows both', list.code === 0 && list.stdout.trim().split('\n').length === 2, list.out);

  const u = sb.packs(['uninstall', 'flag', '--yes']);
  ok('uninstall removes both skill folders', u.code === 0 && !fs.existsSync(claude) && !fs.existsSync(codex), u.out);
  ok('…keeps the reports, which are the user\'s history', fs.readdirSync(reports).length === 2);
  ok('…and leaves no record of the pack', !sb.state().packs.flag);
}

console.log('\nflag: one harness');
{
  const sb = box('flag-codex', { clis: ['codex'], modelId: false });
  const r = sb.packs(['install', 'flag', '--yes']);
  ok('a Codex-only machine gets only the Codex skill folder', r.code === 0 && fs.existsSync(path.join(sb.env.CODEX_HOME, 'skills/flag/flag.mjs')) && !fs.existsSync(path.join(sb.home, '.claude/skills/flag')), r.out);
}

console.log('\nflag: Codex report access (opt-in writable_roots entry)');
{
  const partOf = (st, part) => st.data.packs.find((p) => p.id === 'flag').parts.find((p) => p.id === part);
  const sb = box('flag-reportaccess', { clis: ['codex'], dirs: ['codex'] });
  const extra = path.join(sb.root, 'seat');
  fs.mkdirSync(extra);
  fs.mkdirSync(path.join(sb.home, '.agent-config-studio/review-gate'), { recursive: true });
  fs.writeFileSync(path.join(sb.home, '.agent-config-studio/review-gate/config.json'), JSON.stringify({ codexHomes: [extra] }));
  const cfg = path.join(sb.env.CODEX_HOME, 'config.toml');
  const original = 'model = "x"\n\n[sandbox_workspace_write]\nnetwork_access = true\n';
  fs.writeFileSync(cfg, original);
  const reports = path.join(sb.home, '.agent-config-studio/field-reports'), logs = path.join(sb.home, '.agent-config-studio/review-log');
  const plain = sb.packs(['install', 'flag', '--yes']);
  ok('it is off by default: a plain install leaves config.toml alone', plain.code === 0 && sb.read(cfg) === original && !fs.existsSync(path.join(extra, 'config.toml')), plain.out);
  const dry = sb.json(['install', 'flag', '--part', 'codex-report-access', '--dry-run']);
  ok('the preview names writable_roots += the field-reports folder for each Codex home', dry.code === 0 && [cfg, path.join(extra, 'config.toml')].every((f) => dry.data.preview.some((r) => r.path === f && r.note === `writable_roots += ${reports}`)), JSON.stringify(dry.data?.preview));
  const r = sb.packs(['install', 'flag', '--part', 'codex-report-access', '--yes']);
  ok('--part codex-report-access adds the field-reports folder to writable_roots', r.code === 0 && sb.read(cfg) === original.replace('network_access = true\n', `writable_roots = [${JSON.stringify(reports)}]\nnetwork_access = true\n`), `${r.out}\n${sb.read(cfg)}`);
  ok('…and in each codexHomes entry from the review-gate config', sb.read(path.join(extra, 'config.toml')) === `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(reports)}]\n`, sb.read(path.join(extra, 'config.toml')));
  ok('…with a backup of the existing file', fs.readdirSync(path.join(sb.home, '.agent-config-studio/backups')).length === 1);
  ok('status: installed', partOf(sb.json(['status', '--no-trust-check']), 'codex-report-access').statuses.join() === 'installed');
  const withReports = sb.read(cfg), extraWithReports = sb.read(path.join(extra, 'config.toml'));
  const both = original.replace('network_access = true\n', `writable_roots = [${JSON.stringify(reports)}, ${JSON.stringify(logs)}]\nnetwork_access = true\n`);
  const rg = sb.packs(['install', 'review-gate', '--part', 'codex-log-access', '--yes']);
  ok('review-gate\'s log access still adds its own folder, beside the reports folder', rg.code === 0 && sb.read(cfg) === both, `${rg.out}\n${sb.read(cfg)}`);
  const u = sb.packs(['uninstall', 'review-gate', '--yes']);
  ok('uninstalling review-gate first gives back the exact bytes flag left', u.code === 0 && sb.read(cfg) === withReports && sb.read(path.join(extra, 'config.toml')) === extraWithReports, `${u.out}\n${sb.read(cfg)}`);
  const u2 = sb.packs(['uninstall', 'flag', '--yes']);
  ok('…and then flag\'s: the exact pre-install bytes are back, and the file that did not exist is gone', u2.code === 0 && sb.read(cfg) === original && !fs.existsSync(path.join(extra, 'config.toml')), `${u2.out}\n${sb.read(cfg)}`);
  sb.packs(['install', 'flag', '--part', 'codex-report-access', '--yes']);
  sb.packs(['install', 'review-gate', '--part', 'codex-log-access', '--yes']);
  const u3 = sb.packs(['uninstall', 'flag', '--yes']);
  ok('uninstalling flag first takes out only the reports entry; the review log entry stays', u3.code === 0 && sb.read(cfg) === original.replace('network_access = true\n', `writable_roots = [${JSON.stringify(logs)}]\nnetwork_access = true\n`), `${u3.out}\n${sb.read(cfg)}`);
  const u4 = sb.packs(['uninstall', 'review-gate', '--yes']);
  ok('…and then review-gate\'s takes out its own entry, the rest of the file intact', u4.code === 0 && [cfg, path.join(extra, 'config.toml')].every((f) => !(sb.read(f) || '').includes(reports) && !(sb.read(f) || '').includes(logs)) && sb.read(cfg).startsWith('model = "x"\n\n[sandbox_workspace_write]\n') && sb.read(cfg).endsWith('network_access = true\n'), `${u4.out}\n${sb.read(cfg)}`);
  fs.writeFileSync(cfg, original);
  fs.rmSync(path.join(extra, 'config.toml'), { force: true });
  sb.packs(['install', 'flag', '--part', 'codex-report-access', '--yes']);
  fs.appendFileSync(cfg, '\n[profile]\nname = "mine"\n');
  const u5 = sb.packs(['uninstall', 'flag', '--yes']);
  ok('edited since install: only the writable_roots entry goes, the rest stays', u5.code === 0 && sb.read(cfg) === `${original}\n[profile]\nname = "mine"\n`, sb.read(cfg));
  const sb2 = box('flag-reportaccess-claude', { clis: ['claude'], modelId: false });
  const r2 = sb2.json(['install', 'flag', '--part', 'codex-report-access', '--dry-run']);
  ok('with no Codex home the part is skipped and nothing would be written', r2.code === 0 && r2.data.notes.some((n) => /codex-report-access: .*skipped/.test(n)) && r2.data.preview.length === 0, r2.out);
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'packs/flag/pack.json'), 'utf8'));
  for (const [what, v] of [['no writableRoot', undefined], ['an absolute path', '/etc'], ['a path that climbs out with ..', '~/../etc'], ['a bare ~', '~']]) {
    const p = structuredClone(base);
    const part = p.parts.find((x) => x.id === 'codex-report-access');
    if (v === undefined) delete part.writableRoot; else part.writableRoot = v;
    let threw = false;
    try { validatePack(p); } catch { threw = true; }
    ok(`the manifest check fails on a codex-log-access part with ${what}`, threw);
  }
}

for (const b of boxes) b.cleanup();
assertRealHomesUnchanged(realBefore, ok);
done();
