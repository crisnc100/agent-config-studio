/**
 * The audit and linked git worktrees (builds/audit-tuning C6–C8), in-process
 * against real git fixtures: `git init` / `git worktree add` / a submodule,
 * all inside a temp HOME (git config isolated from the real one). Repo
 * identity comes from the metadata files alone (lib/gitmeta.js
 * linkedWorktree); worktrees are walked last, so a cap cuts them first and
 * says how many; their cards keep their own ids, fixes and dismissals.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';

const realBefore = snapshotRealHomes();
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-audit-wt-')));
process.env.HOME = home;

const A = await import('../lib/audit.js');
const { linkedWorktree } = await import('../lib/gitmeta.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const quiet = { recordBaseline: async () => null, record: async () => null };
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); return f; };
const studio = path.join(home, '.agent-config-studio');
const gitEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig-none'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'init.defaultBranch=main', '-c', 'protocol.file.allow=always', ...args], { cwd, env: gitEnv, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout;
};
const repo = (dir, files) => {
  for (const [rel, text] of Object.entries(files)) put(path.join(dir, rel), text);
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
};
const roots = (...rs) => put(path.join(studio, 'roots.json'), JSON.stringify({ version: 1, roots: rs.map(([label, p, access = 'edit']) => ({ id: label.toLowerCase(), label, access, path: p })) }));
put(path.join(studio, 'models.json'), JSON.stringify({ version: 1, models: { sol: 'gpt-6.1-sol' } }));

try {
  console.log('\naudit worktrees: C6 — which folders are linked worktrees (real git fixtures)');
  const P = path.join(home, 'Projects');
  const app = repo(path.join(P, 'app'), { 'CLAUDE.md': 'Use claude-opus-5-5 in app.\n' });
  git(app, 'worktree', 'add', '-q', path.join(P, 'app-wt', 'abs'));
  git(app, 'worktree', 'add', '-q', '--relative-paths', path.join(P, 'app-wt', 'rel'));
  put(path.join(P, 'app-wt', 'abs', 'CLAUDE.md'), 'Use claude-opus-5-5 in abs.\n');
  put(path.join(P, 'app-wt', 'rel', 'CLAUDE.md'), 'Use claude-opus-5-5 in rel.\n');
  const relGit = fs.readFileSync(path.join(P, 'app-wt', 'rel', '.git'), 'utf8');
  const absGit = fs.readFileSync(path.join(P, 'app-wt', 'abs', '.git'), 'utf8');
  ok('(fixtures) one worktree names its gitdir absolutely, the other relatively', /^gitdir: \//.test(absGit) && /^gitdir: \.\./.test(relGit), `${absGit} | ${relGit}`);
  // A bare repository and a worktree of it.
  git(P, 'clone', '-q', '--bare', app, path.join(P, 'bare.git'));
  git(path.join(P, 'bare.git'), 'worktree', 'add', '-q', path.join(P, 'bare-wt', 'one'));
  put(path.join(P, 'bare-wt', 'one', 'CLAUDE.md'), 'Use claude-opus-5-5 in bare.\n');
  // A submodule: its .git is a file into .git/modules, with no commondir.
  const lib = repo(path.join(home, 'src', 'lib'), { 'CLAUDE.md': 'Use claude-opus-5-5 in lib.\n' });
  git(app, 'submodule', '-q', 'add', lib, 'sub');
  // A nested independent repository, and a malformed .git file.
  repo(path.join(app, 'vendor', 'nested'), { 'CLAUDE.md': 'Use claude-opus-5-5 in nested.\n' });
  put(path.join(P, 'odd', '.git'), 'this is not git metadata\n');
  put(path.join(P, 'odd', 'CLAUDE.md'), 'Use claude-opus-5-5 in odd.\n');
  put(path.join(P, 'half', '.git'), 'gitdir: /nowhere/at/all\n');
  put(path.join(P, 'half', 'CLAUDE.md'), 'Use claude-opus-5-5 in half.\n');
  // A main checkout outside every root, with a worktree inside one.
  const outside = repo(path.join(home, 'outside', 'repo'), { 'CLAUDE.md': 'Use claude-opus-5-5 outside.\n' });
  git(outside, 'worktree', 'add', '-q', path.join(P, 'ext-wt'));
  put(path.join(P, 'ext-wt', 'CLAUDE.md'), 'Use claude-opus-5-5 in ext-wt.\n');
  const subGit = fs.readFileSync(path.join(app, 'sub', '.git'), 'utf8');
  ok('(fixtures) the submodule\'s .git is a file into .git/modules', /modules\/sub/.test(subGit), subGit);

  const realApp = fs.realpathSync(app);
  for (const [what, dir, want] of [
    ['a main checkout', app, null],
    ['a linked worktree, absolute gitdir', path.join(P, 'app-wt', 'abs'), realApp],
    ['a linked worktree, relative gitdir', path.join(P, 'app-wt', 'rel'), realApp],
    ['a bare repository', path.join(P, 'bare.git'), null],
    ['a worktree of a bare repository', path.join(P, 'bare-wt', 'one'), null],
    ['a submodule', path.join(app, 'sub'), null],
    ['a nested independent repository', path.join(app, 'vendor', 'nested'), null],
    ['a malformed .git file', path.join(P, 'odd'), null],
    ['a .git file pointing nowhere', path.join(P, 'half'), null],
    ['a worktree whose main checkout is outside every root', path.join(P, 'ext-wt'), fs.realpathSync(outside)],
    ['a plain folder', path.join(P, 'app-wt'), null],
  ]) {
    const got = linkedWorktree(dir);
    ok(`linkedWorktree: ${what} → ${want ? 'a worktree of its main checkout' : 'not a worktree'}`, (got?.main ?? null) === want, JSON.stringify(got));
  }
  fs.mkdirSync(path.join(P, 'dotlink'));
  fs.symlinkSync(path.join(P, 'app-wt', 'abs', '.git'), path.join(P, 'dotlink', '.git'));
  ok('linkedWorktree: a .git that is a symlink is not followed', linkedWorktree(path.join(P, 'dotlink')) === null);
  fs.rmSync(path.join(P, 'dotlink'), { recursive: true });

  roots(['Projects', P]);
  const audit = A.createAudit({ home, hist: quiet });
  const res = await audit.run();
  const by = (d) => res.files.find((f) => f.display === d);
  const wtOf = (d) => by(d)?.worktree ?? null;
  ok('C6 the main checkout\'s file is an ordinary card', by('~/Projects/app/CLAUDE.md') && !wtOf('~/Projects/app/CLAUDE.md'));
  ok('C6 both linked worktrees\' files are worktree cards of ~/Projects/app',
    wtOf('~/Projects/app-wt/abs/CLAUDE.md')?.label === '~/Projects/app' && wtOf('~/Projects/app-wt/rel/CLAUDE.md')?.label === '~/Projects/app'
      && wtOf('~/Projects/app-wt/abs/CLAUDE.md').repo === wtOf('~/Projects/app-wt/rel/CLAUDE.md').repo, JSON.stringify(res.files.map((f) => [f.display, f.worktree])));
  for (const d of ['~/Projects/bare-wt/one/CLAUDE.md', '~/Projects/app/sub/CLAUDE.md', '~/Projects/app/vendor/nested/CLAUDE.md', '~/Projects/odd/CLAUDE.md', '~/Projects/half/CLAUDE.md']) {
    ok(`C6 ${d} behaves as today: read, an ordinary card`, by(d) && !wtOf(d));
  }
  ok('C6 a worktree whose main checkout is outside the roots is a worktree card…', wtOf('~/Projects/ext-wt/CLAUDE.md')?.label === '~/outside/repo');
  ok('…and nothing of that main checkout is read', !res.files.some((f) => /outside\/repo/.test(f.display)) && !audit.scannedFiles().some((f) => f.includes(`${path.sep}outside${path.sep}`)));
  ok('C6 the result lists each repository\'s worktrees with its physical file count',
    JSON.stringify(res.worktrees.map((w) => [w.label, w.files])) === JSON.stringify([['~/Projects/app', 2], ['~/outside/repo', 1]]), JSON.stringify(res.worktrees));
  ok('C6 the repository key is opaque: no absolute path in the result', !JSON.stringify(res).includes(home));
  ok('C6 counts are unchanged: every file read is counted', res.counts.files === 9 && res.counts.findings === 9, JSON.stringify([res.counts.files, res.counts.findings]));

  console.log('\naudit worktrees: C8 — fix and dismiss per worktree file; ids for other files unchanged');
  {
    const absFile = path.join(P, 'app-wt', 'abs', 'CLAUDE.md');
    const siblings = [path.join(app, 'CLAUDE.md'), path.join(P, 'app-wt', 'rel', 'CLAUDE.md')];
    const sibBefore = siblings.map((f) => fs.readFileSync(f));
    const card = by('~/Projects/app-wt/abs/CLAUDE.md');
    const p = audit.propose({ fileRef: card.ref, findingIds: card.findings.filter((x) => x.fixable).map((x) => x.id) });
    ok('C8 Fix on a worktree card proposes that file only', p.path === '~/Projects/app-wt/abs/CLAUDE.md' && p.current === 'Use claude-opus-5-5 in abs.\n' && p.proposed === 'Use opus in abs.\n', JSON.stringify(p));
    await audit.accept({ id: p.id });
    ok('C8 …and accepting changes exactly that file\'s bytes; its siblings are unchanged',
      fs.readFileSync(absFile, 'utf8') === 'Use opus in abs.\n' && siblings.every((f, i) => fs.readFileSync(f).equals(sibBefore[i])));

    const mainCard = by('~/Projects/app/CLAUDE.md');
    const mainId = mainCard.findings[0].id;
    audit.dismiss({ id: mainId });
    const relCard = by('~/Projects/app-wt/rel/CLAUDE.md');
    audit.dismiss({ id: relCard.findings[0].id });
    // A new worktree appears, then a restart.
    git(app, 'worktree', 'add', '-q', path.join(P, 'app-wt', 'later'));
    put(path.join(P, 'app-wt', 'later', 'CLAUDE.md'), 'Use claude-opus-5-5 later.\n');
    const fresh = A.createAudit({ home, hist: quiet });
    const r2 = await fresh.run();
    const of = (d) => r2.files.find((f) => f.display === d);
    ok('C8 a dismissed worktree finding stays dismissed across a restart', of('~/Projects/app-wt/rel/CLAUDE.md')?.findings[0].dismissed === true);
    ok('C8 the main checkout\'s id is unchanged by adding a worktree, and its dismissal survives', of('~/Projects/app/CLAUDE.md')?.findings[0].id === mainId && of('~/Projects/app/CLAUDE.md').findings[0].dismissed === true);
    ok('C8 the new worktree is a card of its own, in the same repository', of('~/Projects/app-wt/later/CLAUDE.md')?.worktree?.repo === wtOf('~/Projects/app-wt/abs/CLAUDE.md').repo);
    fresh.dismiss({ id: relCard.findings[0].id, undo: true });
    ok('C8 undismiss brings it back', (await fresh.run({ refresh: true })).files.find((f) => f.display === '~/Projects/app-wt/rel/CLAUDE.md').findings[0].dismissed === false);
  }

  console.log('\naudit worktrees: C7 — under a cap, worktree files are cut first');
  {
    // Worktree files come first alphabetically; the real repository has 3 files, its worktree 5.
    const files = { 'a/CLAUDE.md': 'Use claude-opus-5-5 at a.\n', 'b/CLAUDE.md': 'Use claude-opus-5-5 at b.\n', 'c/CLAUDE.md': 'Use claude-opus-5-5 at c.\n' };
    const Cap = path.join(home, 'Cap');
    const main = repo(path.join(Cap, 'zzz-app'), files);
    const wt = path.join(Cap, 'aaa-wt', 'feature');
    git(main, 'worktree', 'add', '-q', wt);
    put(path.join(wt, 'd', 'CLAUDE.md'), 'Use claude-opus-5-5 at d.\n');
    put(path.join(wt, 'e', 'CLAUDE.md'), 'Use claude-opus-5-5 at e.\n');
    // The same tree with no git metadata: what today's order does to it.
    const Plain = path.join(home, 'Plain');
    for (const [rel, text] of Object.entries(files)) { put(path.join(Plain, 'zzz-app', rel), text); put(path.join(Plain, 'aaa-wt', 'feature', rel), text); }
    for (const x of ['d', 'e']) put(path.join(Plain, 'aaa-wt', 'feature', x, 'CLAUDE.md'), `Use claude-opus-5-5 at ${x}.\n`);

    const runWith = async (root, lim) => { roots(['R', root]); const a = A.createAudit({ home, hist: quiet, limits: { ...A.AUDIT_LIMITS, ...lim } }); const r = await a.run(); return { r, read: a.scannedFiles() }; };
    const realRead = (read, root) => read.filter((f) => f.startsWith(path.join(root, 'zzz-app') + path.sep)).length;
    const wtRead = (read, root) => read.filter((f) => f.startsWith(path.join(root, 'aaa-wt') + path.sep)).length;

    const before = await runWith(Plain, { files: 6 });
    ok('C7 before (no worktree metadata, today\'s order): the real repository is cut', realRead(before.read, Plain) === 1 && wtRead(before.read, Plain) === 5, JSON.stringify(before.r.partialReasons));
    const after = await runWith(Cap, { files: 6 });
    ok('C7 after: every real-repository file is read, the cap falls on the worktree', realRead(after.read, Cap) === 3 && wtRead(after.read, Cap) === 3, JSON.stringify(after.read));
    ok('C7 …and the cut notice names the worktree files left unread', after.r.partial && after.r.partialReasons.includes('2 files in linked worktrees were skipped: file cap'), JSON.stringify(after.r.partialReasons));
    const exact = await runWith(Cap, { files: 8 });
    ok('C7 exact cap: everything is read, nothing is cut', !exact.r.partial && exact.read.length === 8, JSON.stringify(exact.r.partialReasons));
    const plusOne = await runWith(Cap, { files: 7 });
    ok('C7 one file over the cap: one worktree file is skipped, every real-repository file read',
      realRead(plusOne.read, Cap) === 3 && plusOne.r.partialReasons.includes('1 file in linked worktrees was skipped: file cap'), JSON.stringify(plusOne.r.partialReasons));
    const tight = await runWith(Cap, { files: 2 });
    ok('C7 a cap inside the real repository still stops there, and every worktree file is counted as skipped',
      realRead(tight.read, Cap) === 2 && wtRead(tight.read, Cap) === 0 && tight.r.partialReasons.includes('5 files in linked worktrees were skipped: file cap'), JSON.stringify(tight.r.partialReasons));
    const size = fs.statSync(path.join(main, 'a', 'CLAUDE.md')).size;
    const budget = size * 4 + Math.floor(size / 2);
    const bytes = await runWith(Cap, { totalBytes: budget });
    ok('C7 the byte budget still bounds the walk: real files first, worktree files cut and counted',
      realRead(bytes.read, Cap) === 3 && wtRead(bytes.read, Cap) === 1 && bytes.read.reduce((n, f) => n + fs.statSync(f).size, 0) <= budget
        && bytes.r.partialReasons.includes('4 files in linked worktrees were skipped: byte budget'), JSON.stringify([bytes.read.length, bytes.r.partialReasons]));
    const full = await runWith(Cap, {});
    const card = full.r.files.find((f) => f.display === '~/Cap/zzz-app/a/CLAUDE.md');
    ok('C7 an identical worktree copy joins the real file\'s card, which stays the one outside the worktree',
      card && !card.worktree && card.copies.some((c) => c.display === '~/Cap/aaa-wt/feature/a/CLAUDE.md') && !full.r.files.some((f) => f.display === '~/Cap/aaa-wt/feature/a/CLAUDE.md'), JSON.stringify(full.r.files.map((f) => [f.display, f.copies.length])));
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
  assertRealHomesUnchanged(realBefore, ok);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
