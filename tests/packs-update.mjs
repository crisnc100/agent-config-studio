/**
 * acs packs update and uninstall (plan.md C7, C8, C9, C11 for the worktree
 * part): a newer pack is simulated by running a COPY of this package whose
 * packs/ the test edits, so the real packs/ is never touched. Temp HOME, stub
 * CLIs; no model CLI is ever run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { ROOT, changed, sandbox, tests, tree } from './fixtures/packs-sandbox.mjs';

const realBefore = snapshotRealHomes();
const { ok, done } = tests();
const boxes = [];
const box = (...a) => { const b = sandbox(...a); boxes.push(b); return b; };

/** A copy of the package (what npm ships, packs' tests left out) whose packs/ a test may edit. */
function copyPackage(sb) {
  const dest = path.join(sb.root, 'pkg');
  for (const p of ['lib', 'bin', 'tools', 'packs', 'models.default.json', 'package.json']) {
    fs.cpSync(path.join(ROOT, p), path.join(dest, p), { recursive: true, verbatimSymlinks: true, filter: (src) => !/\/packs\/[^/]+\/tests(\/|$)/.test(src) });
  }
  const run = (args, extra = {}) => sb.run(process.execPath, [path.join(dest, 'bin', 'packs.mjs'), ...args], { extra });
  const json = (args, extra) => { const r = run([...args, '--json'], extra); try { return { ...r, data: JSON.parse(r.stdout) }; } catch { return { ...r, data: null }; } };
  const bump = (id, version) => {
    const f = path.join(dest, 'packs', id, 'pack.json');
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), version }, null, 2));
  };
  return { dest, run, json, bump };
}

const STATUS = (st, pack, part) => st.data.packs.find((p) => p.id === pack).parts.find((p) => p.id === part);

console.log('\nC7 update: untouched files are updated, edited ones kept, --replace backs up then replaces');
{
  const sb = box('c7', { clis: ['claude'] });
  const pkg = copyPackage(sb);
  const skill = path.join(sb.home, '.claude/skills/advisor/SKILL.md');
  const contract = path.join(sb.home, '.claude/skills/advisor/advisor-contract.md');
  ok('C7 the copy installs advisor', pkg.run(['install', 'advisor', '--yes']).code === 0 && fs.existsSync(skill));
  const fresh = pkg.json(['status', '--no-trust-check']);
  ok('C7 status right after install: installed', STATUS(fresh, 'advisor', 'advisor').statuses.join() === 'installed', JSON.stringify(STATUS(fresh, 'advisor', 'advisor')));
  fs.appendFileSync(path.join(pkg.dest, 'packs/advisor/skills/claude/advisor/SKILL.md'), '\nA new line in 1.1.0.\n');
  fs.appendFileSync(path.join(pkg.dest, 'packs/advisor/skills/claude/advisor/advisor-contract.md'), '\nContract change in 1.1.0.\n');
  pkg.bump('advisor', '1.1.0');
  fs.appendFileSync(contract, '\nMy own note.\n');
  const mine = sb.read(contract);
  const st = STATUS(pkg.json(['status', '--no-trust-check']), 'advisor', 'advisor');
  ok('C7 status: update available, and edited by you (naming the file)', st.statuses.includes('update available') && st.statuses.includes('edited by you') && st.details.some((d) => d.includes('advisor-contract.md')), JSON.stringify(st));
  const p = pkg.json(['update', 'advisor', '--dry-run']);
  ok('C7 the update preview replaces the untouched file and reports the edited one as kept', p.data.preview.some((r) => r.path === skill && r.action === 'replace') && p.data.kept.some((k) => k.path === contract && /you edited it/.test(k.why)) && !p.data.preview.some((r) => r.path === contract), p.out);
  const u = pkg.run(['update', 'advisor', '--yes']);
  ok('C7 update: the untouched file is updated', u.code === 0 && /A new line in 1\.1\.0/.test(sb.read(skill)), u.out);
  ok('C7 …the edited one is kept, byte for byte, and reported', sb.read(contract) === mine && /kept: .*advisor-contract\.md — you edited it/.test(u.out), u.out);
  ok('C7 …and the pack is recorded at the new version', sb.state().packs.advisor.version === '1.1.0');
  const r = pkg.run(['update', 'advisor', '--replace', '--yes']);
  ok('C7 --replace takes the new file', r.code === 0 && /Contract change in 1\.1\.0/.test(sb.read(contract)) && !/My own note/.test(sb.read(contract)), r.out);
  const backups = path.join(sb.home, '.agent-config-studio/backups');
  const saved = fs.readdirSync(backups).filter((d) => /packs-update/.test(d)).flatMap((d) => {
    const out = []; const walk = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const q = path.join(x, e.name); if (e.isDirectory()) walk(q); else out.push(q); } }; walk(path.join(backups, d)); return out;
  });
  ok('C7 …after backing up your edited copy', saved.some((f) => f.endsWith('advisor-contract.md') && fs.readFileSync(f, 'utf8') === mine), saved.join(' '));
  const st2 = STATUS(pkg.json(['status', '--no-trust-check']), 'advisor', 'advisor');
  ok('C7 status after the update: installed', st2.statuses.join() === 'installed', JSON.stringify(st2));
  // C8 skill, after an update: the edited branch keeps your file; the unchanged one goes.
  fs.appendFileSync(skill, 'edited after the update\n');
  const un = pkg.run(['uninstall', 'advisor', '--yes']);
  ok('C8 skill, edited: the file you edited is kept and reported; the rest goes', un.code === 0 && fs.existsSync(skill) && !fs.existsSync(contract) && /kept: .*SKILL\.md/.test(un.out), un.out);
  ok('C8 …and the pack is no longer recorded', !sb.state().packs.advisor);
}

console.log('\nC7 with the pack unchanged: a removed or edited file is reported, and --replace puts the pack\'s copy back');
{
  const sb = box('c7same', { clis: ['claude'] });
  const skill = path.join(sb.home, '.claude/skills/advisor/SKILL.md');
  const contract = path.join(sb.home, '.claude/skills/advisor/advisor-contract.md');
  sb.packs(['install', 'advisor', '--yes']);
  const shippedContract = sb.read(contract), shippedSkill = sb.read(skill);
  fs.rmSync(contract);
  const st = STATUS(sb.json(['status', '--no-trust-check']), 'advisor', 'advisor');
  ok('C7 status: a removed file is missing, and the fix named is acs packs update --replace', st.statuses.includes('installed but not working') && st.details.some((d) => /missing: .*advisor-contract\.md — put it back with: acs packs update advisor --replace/.test(d)), JSON.stringify(st));
  const p = sb.json(['update', 'advisor', '--dry-run']);
  ok('C7 update reports the removed file as kept ("you removed it"), writing nothing', p.code === 0 && p.data.kept.some((k) => k.path === contract && /you removed it \(--replace puts it back\)/.test(k.why)) && p.data.preview.length === 0, p.out);
  const r = sb.packs(['update', 'advisor', '--replace', '--yes']);
  ok('C7 update --replace puts the removed file back, byte for byte', r.code === 0 && sb.read(contract) === shippedContract, r.out);
  ok('C7 …and status is installed again', STATUS(sb.json(['status', '--no-trust-check']), 'advisor', 'advisor').statuses.join() === 'installed');
  fs.appendFileSync(skill, 'my edit\n');
  const mine = sb.read(skill);
  const k = sb.packs(['update', 'advisor', '--yes']);
  ok('C7 update keeps an edited file, byte for byte, and reports it', k.code === 0 && sb.read(skill) === mine && /kept: .*SKILL\.md — you edited it/.test(k.out), k.out);
  const x = sb.packs(['update', 'advisor', '--replace', '--yes']);
  const backups = path.join(sb.home, '.agent-config-studio/backups');
  const saved = [];
  const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch {} for (const e of es) { const q = path.join(d, e.name); if (e.isDirectory()) walk(q); else saved.push(q); } };
  walk(backups);
  ok('C7 update --replace takes the pack\'s copy after backing up the edit', x.code === 0 && sb.read(skill) === shippedSkill && saved.some((f) => f.endsWith('SKILL.md') && fs.readFileSync(f, 'utf8') === mine), `${x.out}\n${saved.join(' ')}`);
  const un = sb.packs(['uninstall', 'advisor', '--yes']);
  ok('C7 …and uninstall still treats both as files it installed: both go, with their folder', un.code === 0 && !fs.existsSync(path.join(sb.home, '.claude/skills/advisor')), un.out);
}

console.log('\nC8 skill, unchanged since install: exact pre-install bytes back');
{
  const sb = box('c8skill', { clis: ['claude', 'codex'] });
  const theirs = path.join(sb.home, '.claude/skills/handoff/SKILL.md');
  fs.mkdirSync(path.dirname(theirs), { recursive: true });
  fs.writeFileSync(theirs, 'my own handoff skill\n', { mode: 0o600 });
  const before = tree(sb.home, (p) => p.includes('/.agent-config-studio/'));
  sb.packs(['install', 'handoff', '--yes']);
  ok('C8 the install replaced my skill (backed up first)', /resume-here|handoff/i.test(sb.read(theirs)) && sb.read(theirs) !== 'my own handoff skill\n');
  const r = sb.packs(['uninstall', 'handoff', '--yes']);
  const after = tree(sb.home, (p) => p.includes('/.agent-config-studio/'));
  ok('C8 uninstall puts my exact bytes and mode back, and removes the Codex copy and the folders it made', r.code === 0 && changed(before, after).length === 0 && (fs.statSync(theirs).mode & 0o777) === 0o600, changed(before, after).join(' '));
}

console.log('\nC8 the shared runtime survives while any part uses it');
{
  const sb = box('c8rt', { clis: ['claude'] });
  sb.packs(['install', 'review-gate', '--part', 'code-review,agent-guard', '--yes']);
  const rt = path.join(sb.home, '.agent-config-studio/review-gate/review.mjs');
  ok('C8 two parts reference the runtime', sb.state().runtime.refs.sort().join() === 'review-gate/agent-guard,review-gate/code-review');
  const p = sb.json(['uninstall', 'review-gate', '--part', 'code-review', '--dry-run']);
  ok('C8 uninstalling one says the runtime stays and why', p.data.notes.some((n) => /runtime stays: review-gate\/agent-guard still uses it/.test(n)) && !p.data.preview.some((r) => r.path === rt), p.out);
  sb.packs(['uninstall', 'review-gate', '--part', 'code-review', '--yes']);
  ok('C8 …and it does', fs.existsSync(rt) && !fs.existsSync(path.join(sb.home, '.claude/skills/code-review')) && sb.state().runtime.refs.join() === 'review-gate/agent-guard');
  fs.appendFileSync(path.join(sb.home, '.agent-config-studio/review-gate/calibration.md'), '\nmy calibration note\n');
  sb.packs(['uninstall', 'review-gate', '--yes']);
  ok('C8 the last part takes the runtime, except a runtime file you edited', !fs.existsSync(rt) && /my calibration note/.test(sb.read(path.join(sb.home, '.agent-config-studio/review-gate/calibration.md'))) && sb.state().runtime === null);
}

console.log('\nC9 the instruction block');
{
  const sb = box('c9', { clis: ['claude', 'codex'] });
  const pkg = copyPackage(sb);
  const claudeMd = path.join(sb.home, '.claude/CLAUDE.md');
  const guide = '<!-- acs:model-guide v1 sep=1 sha256:0000000000000000000000000000000000000000000000000000000000000000 -->\n## Model guide\n\n- a\n<!-- /acs:model-guide -->\n';
  const original = `# My rules\n\nBe kind.\n\n${guide}`;
  fs.writeFileSync(claudeMd, original);
  const r = pkg.run(['install', 'review-gate', '--part', 'instructions', '--yes']);
  const text = sb.read(claudeMd);
  const count = (t) => (t.match(/<!-- acs-pack:review-gate\/instructions begin -->/g) || []).length;
  ok('C9 the marked block is added once to CLAUDE.md and AGENTS.md', r.code === 0 && count(text) === 1 && count(sb.read(path.join(sb.env.CODEX_HOME, 'AGENTS.md'))) === 1, r.out);
  ok('C9 …after the file\'s own text, which is untouched, model guide included', text.startsWith(original) && text.includes(guide));
  pkg.run(['install', 'review-gate', '--part', 'instructions', '--yes']);
  ok('C9 installing again does not add a second block', count(sb.read(claudeMd)) === 1);
  // The user adds text after the block; then the pack's block changes.
  fs.appendFileSync(claudeMd, '\n## Later rules\n\nMine.\n');
  const withMine = sb.read(claudeMd);
  const body = path.join(pkg.dest, 'packs/review-gate/instructions/review-gate.md');
  fs.appendFileSync(body, '- A rule added in 1.1.0.\n');
  pkg.bump('review-gate', '1.1.0');
  const st = STATUS(pkg.json(['status', '--no-trust-check']), 'review-gate', 'instructions');
  ok('C9 status: update available (the block itself was not edited)', st.statuses.join() === 'update available', JSON.stringify(st));
  const u = pkg.run(['update', 'review-gate', '--yes']);
  const updated = sb.read(claudeMd);
  const begin = updated.indexOf('<!-- acs-pack:'), end = updated.indexOf('<!-- acs-pack:review-gate/instructions end -->\n') + '<!-- acs-pack:review-gate/instructions end -->\n'.length;
  const oldBegin = withMine.indexOf('<!-- acs-pack:'), oldEnd = withMine.indexOf('<!-- acs-pack:review-gate/instructions end -->\n') + '<!-- acs-pack:review-gate/instructions end -->\n'.length;
  ok('C9 update replaces the block in place', u.code === 0 && count(updated) === 1 && updated.slice(begin, end).includes('A rule added in 1.1.0.'), u.out);
  ok('C9 …and every byte outside it is unchanged (model guide and later text included)', updated.slice(0, begin) === withMine.slice(0, oldBegin) && updated.slice(end) === withMine.slice(oldEnd));
  // An edited block is kept on update unless --replace.
  fs.writeFileSync(claudeMd, sb.read(claudeMd).replace('A rule added in 1.1.0.', 'A rule I reworded.'));
  fs.appendFileSync(body, '- Another rule in 1.2.0.\n');
  pkg.bump('review-gate', '1.2.0');
  const k = pkg.run(['update', 'review-gate', '--yes']);
  ok('C9 an edited block is kept on update and reported', k.code === 0 && sb.read(claudeMd).includes('A rule I reworded.') && /kept: .*CLAUDE\.md — you edited the block/.test(k.out), k.out);
  ok('C9 …while the unedited copy in AGENTS.md is updated', sb.read(path.join(sb.env.CODEX_HOME, 'AGENTS.md')).includes('Another rule in 1.2.0.'));
  const x = pkg.run(['update', 'review-gate', '--replace', '--yes']);
  ok('C9 --replace takes the new block', x.code === 0 && sb.read(claudeMd).includes('Another rule in 1.2.0.') && !sb.read(claudeMd).includes('A rule I reworded.'), x.out);
  // Uninstall: CLAUDE.md was edited since install (the later rules) → only the block goes; AGENTS.md did not exist → it goes.
  const un = pkg.run(['uninstall', 'review-gate', '--yes']);
  ok('C9 uninstall removes only the block; everything else, model guide included, is unchanged', un.code === 0 && sb.read(claudeMd) === `${original}\n## Later rules\n\nMine.\n`, JSON.stringify(sb.read(claudeMd)));
  ok('C9 …and AGENTS.md, which the install created and nobody edited, is gone', !fs.existsSync(path.join(sb.env.CODEX_HOME, 'AGENTS.md')));
  // The unchanged branch: exact pre-install bytes.
  fs.writeFileSync(claudeMd, original);
  pkg.run(['install', 'review-gate', '--part', 'instructions', '--harness', 'claude', '--yes']);
  pkg.run(['uninstall', 'review-gate', '--yes']);
  ok('C8 instructions, unchanged since install: exact pre-install bytes', sb.read(claudeMd) === original);
}

console.log('\nthe worktree part: C8 both branches, C11, and "not zsh"');
{
  const sb = box('wt', { clis: [], dirs: [] });
  const zshrc = path.join(sb.home, '.zshrc');
  const rc = 'export EDITOR=vi\n';
  fs.writeFileSync(zshrc, rc);
  const p = sb.json(['install', 'worktree', '--dry-run']);
  const before = tree(sb.home);
  const r = sb.packs(['install', 'worktree', '--yes']);
  const after = tree(sb.home);
  const written = changed(before, after).filter((f) => after.get(f) !== 'dir' && before.get(f) !== 'dir');
  const listed = p.data.preview.filter((x) => !x.dir).map((x) => x.path);
  const dirs = p.data.preview.filter((x) => x.dir).map((x) => x.dir + path.sep);
  ok('worktree installs through install-worktree', r.code === 0 && fs.existsSync(path.join(sb.home, '.config/worktree/wt.zsh')) && /agent-config-studio worktree tools/.test(sb.read(zshrc)), r.out);
  ok('C11 every file it wrote is in the preview', written.length >= 4 && written.every((f) => listed.includes(f) || dirs.some((d) => f.startsWith(d))), written.filter((f) => !listed.includes(f)).join(' '));
  const st = STATUS(sb.json(['status', '--no-trust-check']), 'worktree', 'worktree');
  ok('status with SHELL=zsh: installed', st.statuses.join() === 'installed', JSON.stringify(st));
  const bash = STATUS(sb.json(['status', '--no-trust-check'], { SHELL: '/bin/bash' }), 'worktree', 'worktree');
  ok('status with SHELL=bash says your shell is not zsh, not "installed"', bash.statuses.join() === 'installed but not working' && bash.details.some((d) => /your shell is not zsh/.test(d)), JSON.stringify(bash));
  const un = sb.packs(['uninstall', 'worktree', '--yes']);
  ok('C8 worktree, unchanged: .zshrc gets its exact earlier bytes, and the toolkit files and folders go', un.code === 0 && sb.read(zshrc) === rc && !fs.existsSync(path.join(sb.home, '.config/worktree')) && !fs.existsSync(path.join(sb.home, '.agent-config-studio/worktree-source')), un.out);
  sb.packs(['install', 'worktree', '--yes']);
  fs.appendFileSync(zshrc, 'alias ll="ls -l"\n');
  fs.appendFileSync(path.join(sb.home, '.config/worktree/wt.zsh'), '# my tweak\n');
  const un2 = sb.packs(['uninstall', 'worktree', '--yes']);
  ok('C8 worktree, edited: only the marked stanza leaves .zshrc; my alias stays', un2.code === 0 && sb.read(zshrc) === `${rc}alias ll="ls -l"\n`, JSON.stringify(sb.read(zshrc)));
  ok('C8 …and the wt.zsh I edited is kept and reported', /# my tweak/.test(sb.read(path.join(sb.home, '.config/worktree/wt.zsh'))) && /kept: .*wt\.zsh/.test(un2.out), un2.out);
  const nz = sb.json(['install', 'worktree', '--dry-run'], { SHELL: '/bin/bash' });
  ok('installing with a non-zsh shell warns that it loads only in zsh', nz.data.warnings.some((w) => /not zsh/.test(w)), nz.out);
}

console.log('\nworktree update: an untouched defaults.conf takes the new one; only a customised one is kept');
{
  const sb = box('wtup', { clis: [], dirs: [] });
  const pkg = copyPackage(sb);
  const dflt = path.join(sb.home, '.config/worktree/defaults.conf');
  const wtz = path.join(sb.home, '.config/worktree/wt.zsh');
  const src = path.join(pkg.dest, 'tools/worktree/defaults.conf');
  const release = (version, line) => { fs.appendFileSync(src, `${line}\n`); pkg.bump('worktree', version); return fs.readFileSync(src, 'utf8'); };
  const status = () => STATUS(pkg.json(['status', '--no-trust-check']), 'worktree', 'worktree');
  ok('the copy installs worktree', pkg.run(['install', 'worktree', '--yes']).code === 0 && fs.existsSync(dflt));
  const v11 = release('1.1.0', '# a default added in 1.1.0');
  const u = pkg.run(['update', 'worktree', '--yes']);
  ok('update: the untouched defaults.conf is replaced with the new one', u.code === 0 && sb.read(dflt) === v11, `${u.out}\n${sb.read(dflt)}`);
  ok('…and status is installed, with no update left', status().statuses.join() === 'installed', JSON.stringify(status()));
  fs.appendFileSync(dflt, 'MY_SETTING=1\n');
  const mine = sb.read(dflt);
  const v12 = release('1.2.0', '# a default added in 1.2.0');
  const k = pkg.run(['update', 'worktree', '--yes']);
  ok('update: a customised defaults.conf is kept, byte for byte, and reported', k.code === 0 && sb.read(dflt) === mine && /kept: .*defaults\.conf — you customised it/.test(k.out), k.out);
  ok('…and status still shows the update, since the new defaults.conf was not written', status().statuses.includes('update available'), JSON.stringify(status()));
  const x = pkg.run(['update', 'worktree', '--replace', '--yes']);
  ok('update --replace takes the new defaults.conf', x.code === 0 && sb.read(dflt) === v12, x.out);
  ok('…and then status is installed', status().statuses.join() === 'installed', JSON.stringify(status()));
  // wt.zsh edited, defaults.conf untouched: wt.zsh is kept and defaults.conf still updates.
  fs.appendFileSync(wtz, '# my tweak\n');
  const myWt = sb.read(wtz);
  const v13 = release('1.3.0', '# a default added in 1.3.0');
  const w = pkg.run(['update', 'worktree', '--yes']);
  ok('with wt.zsh edited, update keeps it and still replaces the untouched defaults.conf', w.code === 0 && sb.read(wtz) === myWt && sb.read(dflt) === v13 && /kept: .*wt\.zsh — you edited it/.test(w.out), `${w.out}\n${sb.read(dflt)}`);
  ok('…and status shows only your wt.zsh edit, no update', status().statuses.join() === 'edited by you', JSON.stringify(status()));
  const un = pkg.run(['uninstall', 'worktree', '--yes']);
  ok('…and uninstall removes the defaults.conf it wrote', un.code === 0 && !fs.existsSync(dflt) && /# my tweak/.test(sb.read(wtz) || ''), un.out);
}

for (const b of boxes) b.cleanup();
assertRealHomesUnchanged(realBefore, ok);
done();
