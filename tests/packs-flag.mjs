/**
 * The flag pack through acs packs (builds/flag-skill/plan.md): it installs the skill and its helper into both
 * harness skill folders, the installed helper files a report into the temp HOME, status calls it installed, and
 * an uninstall removes the skill folders while the reports stay. Temp HOME, stub CLIs; no model CLI is ever run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { ROOT, changed, sandbox, tests, tree } from './fixtures/packs-sandbox.mjs';

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

for (const b of boxes) b.cleanup();
assertRealHomesUnchanged(realBefore, ok);
done();
