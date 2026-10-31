/**
 * acs packs uninstall when a pre-install backup is gone or changed: the
 * uninstall still succeeds and the preview says what happens to the file.
 * A surgical kind (the instructions block) loses only the pack's part; a
 * plain copied file that existed before install is kept and reported. Temp
 * HOME with stub CLIs (tests/fixtures/packs-sandbox.mjs); no model CLI runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { sandbox, tests } from './fixtures/packs-sandbox.mjs';

const realBefore = snapshotRealHomes();
const { ok, done } = tests();
const backupOf = (sb, pack, dest) => Object.values(sb.state().packs[pack]?.parts || {}).map((p) => p.files[dest]?.before?.backup).find(Boolean);
const rowOf = (preview, dest) => (preview || []).find((r) => r.path === dest);

for (const how of ['missing', 'changed']) {
  console.log(`\nuninstall with a pre-install backup ${how}: a copied skill that existed before install`);
  const sb = sandbox(`unbak-put-${how}`, { clis: ['claude'] });
  const skill = path.join(sb.home, '.claude/skills/handoff/SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, 'my own handoff skill\n');
  const i = sb.packs(['install', 'handoff', '--yes']);
  const installed = sb.read(skill);
  const backup = backupOf(sb, 'handoff', skill);
  ok(`${how}: the install replaced my skill and recorded a backup of it`, i.code === 0 && installed !== 'my own handoff skill\n' && !!backup && fs.existsSync(backup), `${i.out}\n${backup}`);
  if (how === 'missing') fs.rmSync(backup); else fs.writeFileSync(backup, 'tampered\n');
  const p = sb.json(['uninstall', 'handoff', '--dry-run']);
  const row = rowOf(p.data?.preview, skill);
  ok(`${how}: the preview keeps the file and says its backup is ${how}`, p.code === 0 && row?.action === 'keep' && (how === 'missing' ? /pre-install backup .* is missing: kept/ : /pre-install backup .* changed since it was taken: kept/).test(row.note), JSON.stringify(row) + p.out);
  ok(`${how}: …and lists it under kept`, (p.data?.kept || []).some((k) => k.path === skill), JSON.stringify(p.data?.kept));
  const u = sb.packs(['uninstall', 'handoff', '--yes']);
  ok(`${how}: the uninstall succeeds, nothing rolled back`, u.code === 0 && !/put back/.test(u.out), u.out);
  ok(`${how}: …and does what the preview said: the file is kept as installed, and the pack is no longer recorded`, sb.read(skill) === installed && !sb.state().packs.handoff, `${sb.read(skill)}\n${JSON.stringify(sb.state())}`);
  ok(`${how}: …and reports the kept file`, /kept .*handoff\/SKILL\.md/.test(u.out), u.out);
}

for (const how of ['missing', 'changed']) {
  console.log(`\nuninstall with a pre-install backup ${how}: the instructions block in an existing CLAUDE.md`);
  const sb = sandbox(`unbak-block-${how}`, { clis: ['claude'] });
  const claudeMd = path.join(sb.home, '.claude/CLAUDE.md');
  const original = '# My rules\n\nBe brief.\n';
  fs.writeFileSync(claudeMd, original);
  const i = sb.packs(['install', 'review-gate', '--part', 'code-review,instructions', '--harness', 'claude', '--set-role', 'reviewer=opus', '--yes']);
  const backup = backupOf(sb, 'review-gate', claudeMd);
  ok(`${how}: the install added the block and recorded a backup`, i.code === 0 && sb.read(claudeMd) !== original && !!backup && fs.existsSync(backup), `${i.out}\n${backup}`);
  if (how === 'missing') fs.rmSync(backup); else fs.writeFileSync(backup, 'tampered\n');
  const p = sb.json(['uninstall', 'review-gate', '--dry-run']);
  const row = rowOf(p.data?.preview, claudeMd);
  ok(`${how}: the preview strips only the pack's part and says the backup is ${how}`, p.code === 0 && row?.action === 'strip' && /unchanged since install, but its pre-install backup .*: only the pack's own part is removed/.test(row.note), JSON.stringify(row) + p.out);
  const u = sb.packs(['uninstall', 'review-gate', '--yes']);
  ok(`${how}: the uninstall succeeds, nothing rolled back`, u.code === 0 && !/put back/.test(u.out), u.out);
  ok(`${how}: …and does what the preview said: the block is gone and my rules are as they were`, sb.read(claudeMd) === original && !sb.state().packs['review-gate'], JSON.stringify(sb.read(claudeMd)));
}

assertRealHomesUnchanged(realBefore, ok);
done();
