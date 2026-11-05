/**
 * The pr pack through acs packs (builds/pr-description/plan.md C5): the twin helpers are one script, each SKILL.md
 * uses its own harness's path and pins the workflow (helper first, --check before gh, edit when a PR exists, deferred
 * HIGHs first, no invented facts, the three review states); install puts the skill, the helper and the example style
 * into both harness folders and no style file; the installed helper creates it on first run; uninstall removes the
 * skill folders and keeps the style file. Temp HOME, stub CLIs; no model CLI and no gh write is ever run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { ROOT, changed, sandbox, tests, tree } from './fixtures/packs-sandbox.mjs';

const realBefore = snapshotRealHomes();
const { ok, done } = tests();
const boxes = [];
const box = (...a) => { const b = sandbox(...a); boxes.push(b); return b; };
const src = (h, f) => path.join(ROOT, 'packs/pr/skills', h, 'pr', f);
const FILES = ['SKILL.md', 'pr-facts.mjs', 'style.example.json'];

console.log('\npr: the two helper copies are one script');
for (const f of ['pr-facts.mjs', 'style.example.json'])
  ok(`the Claude Code and Codex copies of ${f} are byte-identical`, fs.existsSync(src('claude', f)) && fs.readFileSync(src('claude', f)).equals(fs.readFileSync(src('codex', f))));

console.log('\npr: the skill text');
for (const h of ['claude', 'codex']) {
  const body = fs.existsSync(src(h, 'SKILL.md')) ? fs.readFileSync(src(h, 'SKILL.md'), 'utf8') : '';
  const own = h === 'claude' ? 'PR="$HOME/.claude/skills/pr/pr-facts.mjs"' : 'PR="${CODEX_HOME:-$HOME/.codex}/skills/pr/pr-facts.mjs"';
  const other = h === 'claude' ? '.codex/skills/pr' : '.claude/skills/pr';
  ok(`${h}: the helper path is its own harness's`, body.includes(own) && !body.includes(other));
  const at = (re) => body.search(re);
  const facts = at(/^node "\$PR" /m), checkAt = at(/^node "\$PR" --check /m), create = at(/^gh pr create /m), edit = at(/^gh pr edit /m);
  ok(`${h}: runs the helper first, then --check, before gh pr create and gh pr edit`, facts >= 0 && checkAt > facts && create > checkAt && edit > checkAt, [facts, checkAt, create, edit].join());
  ok(`${h}: create and edit both take --body-file`, /gh pr create [^\n]*--body-file/.test(body) && /gh pr edit [^\n]*--body-file/.test(body));
  ok(`${h}: an existing PR is edited, not created again`, /pr\.number[^\n]*gh pr edit|PR already exists[^\n]*edit/i.test(body));
  ok(`${h}: --check failing means fix and check again, never open the PR`, /exit 1[^\n]*fix[^\n]*(again|rerun)/i.test(body));
  ok(`${h}: deferred HIGHs and unmet criteria go first, above the summary`, /deferred HIGH[^\n]*criteria[^\n]*(first|top)[^\n]*above/i.test(body));
  ok(`${h}: deferred lines are copied verbatim, with their ids and scores`, /verbatim[^\n]*(ids?|scores)/i.test(body));
  ok(`${h}: never invent facts the helper did not give`, /never invent/i.test(body));
  ok(`${h}: the three review states, and "not reviewed" never for a review in progress`, body.includes('not reviewed (no review gate)') && body.includes('review in progress — not closed at this commit') && /never write "not reviewed" for a review in progress/i.test(body));
  ok(`${h}: gh missing → a plain message and nothing written`, /`?gh`? is (missing|not installed)[^\n]*nothing/i.test(body));
  ok(`${h}: the style file and its sections are named`, body.includes('~/.agent-config-studio/pr/style.json') && ['What this does', 'Did it match the goal?', 'What changed', 'How to try it', 'Review highlights', 'Deferred findings', 'Docs and context', 'What the agent did', "Agent's take", 'Review record'].every((t) => body.includes(t)));
}

console.log('\npr: install, use, uninstall');
{
  const sb = box('pr', { clis: ['claude', 'codex'], modelId: false });
  const before = tree(sb.home);
  const r = sb.packs(['install', 'pr', '--yes']);
  const claude = path.join(sb.home, '.claude/skills/pr'), codex = path.join(sb.env.CODEX_HOME, 'skills/pr');
  ok('pr installs without model-id or ask-model on PATH', r.code === 0, r.out);
  ok('…into both harness skill folders, as the pack ships them', ['claude', 'codex'].every((h) => FILES.every((f) => sb.read(path.join(h === 'claude' ? claude : codex, f)) === fs.readFileSync(src(h, f), 'utf8'))), r.out);
  ok('…and touches nothing outside those two folders and the pack state', changed(before, tree(sb.home)).every((p) => p.startsWith(claude) || p.startsWith(codex) || p.startsWith(path.join(sb.home, '.agent-config-studio/packs')) || [path.dirname(claude), path.dirname(codex), path.join(sb.home, '.agent-config-studio')].includes(p)), changed(before, tree(sb.home)).join(' '));
  const style = path.join(sb.home, '.agent-config-studio/pr/style.json');
  ok('…and no style file exists until the helper first runs', !fs.existsSync(style));
  const st = sb.json(['status']);
  const row = st.data?.packs?.find((x) => x.id === 'pr');
  ok('status calls it installed', row?.parts?.[0]?.statuses?.join() === 'installed', JSON.stringify(row));

  const repo = path.join(sb.root, 'repo');
  fs.mkdirSync(repo);
  sb.git(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.js'), 'a\n'); sb.git(repo, 'add', '.'); sb.git(repo, 'commit', '-qm', 'a');
  sb.git(repo, 'checkout', '-qb', 'feat'); fs.writeFileSync(path.join(repo, 'b.js'), 'b\n'); sb.git(repo, 'add', '.'); sb.git(repo, 'commit', '-qm', 'b');
  for (const dir of [claude, codex]) {
    const f = sb.run(process.execPath, [path.join(dir, 'pr-facts.mjs')], { cwd: repo });
    let data = null;
    try { data = JSON.parse(f.stdout); } catch {}
    ok(`the installed helper in ${path.basename(path.dirname(path.dirname(dir)))} reports the branch's facts`, f.code === 0 && data?.branch === 'feat' && data.files.code[0]?.path === 'b.js' && data.review.state === 'absent', f.out);
  }
  ok('…and the first run created the style file from the example', sb.read(style) === fs.readFileSync(src('claude', 'style.example.json'), 'utf8'));
  fs.writeFileSync(style, '{"tone":"technical"}\n');

  const u = sb.packs(['uninstall', 'pr', '--yes']);
  ok('uninstall removes both skill folders', u.code === 0 && !fs.existsSync(claude) && !fs.existsSync(codex), u.out);
  ok('…keeps the style file, which is the user\'s', sb.read(style) === '{"tone":"technical"}\n');
  ok('…and leaves no record of the pack', !sb.state().packs.pr);
}

console.log('\npr: one harness');
{
  const sb = box('pr-codex', { clis: ['codex'], modelId: false });
  const r = sb.packs(['install', 'pr', '--yes']);
  ok('a Codex-only machine gets only the Codex skill folder', r.code === 0 && fs.existsSync(path.join(sb.env.CODEX_HOME, 'skills/pr/pr-facts.mjs')) && !fs.existsSync(path.join(sb.home, '.claude/skills/pr')), r.out);
}

console.log('\npr: the instructions part (opt-in marked block in CLAUDE.md and AGENTS.md)');
{
  const shipped = path.join(ROOT, 'packs/pr/instructions/pr.md');
  const body = fs.existsSync(shipped) ? fs.readFileSync(shipped, 'utf8') : '';
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'packs/pr/pack.json'), 'utf8'));
  const part = manifest.parts.find((p) => p.id === 'instructions');
  ok('the pack lists an instructions part, off by default, for claude and codex, with the block file', part?.kind === 'instructions' && part.default === false && part.harnesses.join() === 'claude,codex' && part.files.join() === 'packs/pr/instructions/pr.md', JSON.stringify(part));
  ok('…and the pack\'s explain.changes names both instruction files', ['CLAUDE.md', 'AGENTS.md'].every((f) => manifest.explain.changes.some((c) => c.includes(f) && /marked block/.test(c))), manifest.explain.changes.join(' | '));
  const lines = body.trim().split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  ok('the block is short (about three rules): run /pr, no raw record unless the style turns it on, Deferred findings required with a review',
    lines.length <= 4 && /`\/pr`/.test(body) && /raw review record[^\n]*unless[^\n]*style/i.test(body) && /"?Deferred findings"?[^\n]*whenever a review exists/i.test(body), body);

  const sb = box('pr-instructions', { clis: ['claude', 'codex'], modelId: false });
  const claudeMd = path.join(sb.home, '.claude/CLAUDE.md'), agentsMd = path.join(sb.env.CODEX_HOME, 'AGENTS.md');
  fs.mkdirSync(path.dirname(claudeMd), { recursive: true }); fs.mkdirSync(path.dirname(agentsMd), { recursive: true });
  const mine = { [claudeMd]: '# My rules\n\n- keep it short\n', [agentsMd]: '# Codex rules\n- be plain' };
  for (const [f, t] of Object.entries(mine)) fs.writeFileSync(f, t);
  const plain = sb.packs(['install', 'pr', '--yes']);
  ok('a plain install leaves CLAUDE.md and AGENTS.md alone (the part is opt-in)', plain.code === 0 && Object.entries(mine).every(([f, t]) => sb.read(f) === t), plain.out);
  const begin = '<!-- acs-pack:pr/instructions begin -->', end = '<!-- acs-pack:pr/instructions end -->';
  const block = `${begin}\n${body.endsWith('\n') ? body : `${body}\n`}${end}\n`;
  const r = sb.packs(['install', 'pr', '--part', 'instructions', '--yes']);
  ok('--part instructions appends the marked block after one blank line; the rest of each file is byte-identical',
    r.code === 0 && sb.read(claudeMd) === `${mine[claudeMd]}\n${block}` && sb.read(agentsMd) === `${mine[agentsMd]}\n\n${block}`, `${r.out}\n${sb.read(claudeMd)}\n${sb.read(agentsMd)}`);
  const st = sb.json(['status', '--no-trust-check']).data?.packs?.find((p) => p.id === 'pr')?.parts?.find((p) => p.id === 'instructions');
  ok('status calls the part installed', st?.statuses?.join() === 'installed', JSON.stringify(st));
  const off = sb.packs(['uninstall', 'pr', '--part', 'instructions', '--yes']);
  ok('turning the part off gives back the exact earlier bytes, with no marker left', off.code === 0 && Object.entries(mine).every(([f, t]) => sb.read(f) === t), `${off.out}\n${sb.read(claudeMd)}`);
  ok('…and leaves the skill installed', fs.existsSync(path.join(sb.home, '.claude/skills/pr/SKILL.md')));
  sb.packs(['install', 'pr', '--part', 'instructions', '--yes']);
  fs.appendFileSync(claudeMd, '\n- a rule added after the block\n');
  const u = sb.packs(['uninstall', 'pr', '--yes']);
  ok('uninstalling the pack removes the whole block and keeps a rule added after it', u.code === 0 && sb.read(claudeMd) === `${mine[claudeMd]}\n- a rule added after the block\n` && sb.read(agentsMd) === mine[agentsMd], `${u.out}\n${JSON.stringify(sb.read(claudeMd))}`);
  ok('…no pr marker or "disabled" note is left in either file', [claudeMd, agentsMd].every((f) => !/acs-pack:pr|disabled/i.test(sb.read(f))));

  const sb2 = box('pr-instructions-new', { clis: ['claude'], modelId: false });
  const fresh = path.join(sb2.home, '.claude/CLAUDE.md');
  const r2 = sb2.packs(['install', 'pr', '--part', 'pr,instructions', '--yes']);
  ok('with no CLAUDE.md yet, the install creates it holding only the block', r2.code === 0 && sb2.read(fresh) === block, `${r2.out}\n${sb2.read(fresh)}`);
  const u2 = sb2.packs(['uninstall', 'pr', '--yes']);
  ok('…and uninstalling removes the file it created', u2.code === 0 && !fs.existsSync(fresh), `${u2.out}\n${sb2.read(fresh)}`);
}

for (const b of boxes) b.cleanup();
assertRealHomesUnchanged(realBefore, ok);
done();
