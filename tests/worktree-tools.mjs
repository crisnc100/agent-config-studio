/**
 * The worktree toolkit (tools/worktree/wt.zsh), run for real: temp HOME, temp
 * repos with a local bare origin, real squash merges, and a `gh` stub that
 * answers with gh's own JSON shapes. Criteria 2–10 of
 * builds/worktree-tools/plan.md; each check names its criterion.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, project, pr, tests, requireZsh, DIRENV, TOOLKIT } from './worktree-sandbox.mjs';

requireZsh('worktree/tools');
const { ok, done } = tests();
const all = [];   // every sandbox, for the secret sweep and cleanup
const make = (name) => { const sb = sandbox(name); all.push(sb); return sb; };
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

console.log('\nworktree/tools');

/* ── 2. Links ─────────────────────────────────────────────────────────── */
{
  const sb = make('links');
  const p = project(sb, { envFiles: '".env sub/.env .env.local"' });
  fs.mkdirSync(path.join(p.trunk, 'sub'));
  fs.writeFileSync(path.join(p.trunk, 'sub', '.env'), 'SUB=1\n');
  const r = sb.zsh(p.trunk, 'wnew feat');
  const wt = p.wt('feat');
  ok('2 wnew creates the worktree', r.code === 0 && fs.existsSync(wt), r.out);
  ok('2 wnew links .env to the trunk (absolute target)', isLink(path.join(wt, '.env')) &&
     fs.readlinkSync(path.join(wt, '.env')) === path.join(p.trunk, '.env'), fs.readlinkSync(path.join(wt, '.env')));
  ok('2 wnew links a nested entry (sub/.env), creating its parent', isLink(path.join(wt, 'sub', '.env')) &&
     fs.lstatSync(path.join(wt, 'sub')).isDirectory() && read(path.join(wt, 'sub', '.env')) === 'SUB=1\n');
  ok('2 an entry the trunk lacks is not created (.env.local)', !exists(path.join(wt, '.env.local')));
  ok('2 no temp link is left behind', !fs.readdirSync(wt).some((n) => n.includes('.wt-link')) &&
     !fs.readdirSync(path.join(wt, 'sub')).some((n) => n.includes('.wt-link')));
  ok('2 the worktree stays clean: links are ignored, not untracked', sb.git(wt, 'status', '--porcelain') === '');

  fs.appendFileSync(path.join(p.trunk, '.env'), 'EDITED=1\n');
  ok('2 an in-place trunk edit shows in the worktree', read(path.join(wt, '.env')).includes('EDITED=1'));
  const tmp = path.join(p.trunk, '.env.tmp-write');
  fs.writeFileSync(tmp, 'REPLACED=1\n');
  fs.renameSync(tmp, path.join(p.trunk, '.env'));
  ok('2 an atomic replace of the trunk file (temp + rename) shows in the worktree', read(path.join(wt, '.env')) === 'REPLACED=1\n');

  // Atomic relink: a reader never sees the entry missing while it is swapped.
  const sentinel = path.join(sb.root, 'swap-done');
  const live = sb.zshLive(p.trunk,
    `_wt_conf || exit 1; for i in {1..150}; do _wt_link_one .env ${JSON.stringify(wt)} || exit 1; done; : > ${JSON.stringify(sentinel)}`);
  // Only ENOENT counts as missing. macOS can fail an open() that races a
  // symlink being renamed over another with a transient EINVAL — a kernel
  // artifact of swapping links, reported below rather than hidden.
  let reads = 0, misses = 0, einval = 0;
  const t0 = Date.now();
  while (!fs.existsSync(sentinel) && Date.now() - t0 < 20000) {
    reads++;
    try { fs.readFileSync(path.join(wt, '.env')); } catch (e) { if (e.code === 'EINVAL') einval++; else misses++; }
  }
  const code = await live.exited;
  ok(`2 relinking swaps by rename: a concurrent reader never finds it missing (${reads} reads; ${einval} transient EINVAL from the OS)`,
     code === 0 && reads > 50 && misses === 0, `code ${code}, ${reads} reads, ${misses} misses`);
}

/* ── 3. Validation ────────────────────────────────────────────────────── */
{
  const sb = make('validate');
  const outside = path.join(sb.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, '.env'), 'OUT=1\n');
  const abs = path.join(sb.root, 'abs.env');
  fs.writeFileSync(abs, 'ABS=1\n');
  const p = project(sb, {
    envFiles: `(".env" "${abs}" "../up.env" "my env" "linked/.env" ".env.tracked" "notignored.env")`,
  });
  // The branch tracks a symlinked directory pointing outside, and a file named in ENV_FILES.
  fs.symlinkSync(outside, path.join(p.scratch, 'linked'));
  fs.writeFileSync(path.join(p.scratch, '.env.tracked'), 'TRACKED=1\n');
  sb.git(p.scratch, 'add', '-f', 'linked', '.env.tracked');
  sb.git(p.scratch, 'commit', '-q', '-m', 'tracked things');
  sb.git(p.scratch, 'push', '-q', 'origin', 'HEAD:main');
  sb.git(p.trunk, 'pull', '-q', '--ff-only', 'origin', 'main');
  for (const f of ['../up.env', 'my env', 'notignored.env']) fs.writeFileSync(path.join(p.trunk, f), 'X=1\n');
  const r = sb.zsh(p.trunk, 'wnew val');
  const wt = p.wt('val');
  ok('3 wnew still creates the worktree and links the valid entry', r.code === 0 && isLink(path.join(wt, '.env')), r.out);
  const refused = (name, why) => r.out.includes(`refused: ${name} — ${why}`);
  ok('3 an absolute entry is refused by name', refused(abs, 'absolute path'), r.out);
  ok('3 a .. entry is refused by name', refused('../up.env', 'has an empty, . or .. path component'), r.out);
  ok('3 an entry with whitespace is refused by name', refused('my env', 'contains whitespace'), r.out);
  ok('3 an entry under a symlinked parent pointing outside is refused by name',
     refused('linked/.env', 'parent linked resolves outside the checkout'), r.out);
  ok('3 an entry git tracks is refused by name', refused('.env.tracked', 'tracked by git'), r.out);
  ok('3 an entry git does not ignore is refused by name', refused('notignored.env', 'not gitignored'), r.out);
  ok('3 nothing is created for a refused entry',
     !isLink(path.join(p.root, 'up.env')) && read(path.join(p.root, 'up.env')) === 'X=1\n' && !exists(path.join(wt, 'my env')) &&
     read(path.join(outside, '.env')) === 'OUT=1\n' && fs.readdirSync(outside).length === 1 &&
     !exists(path.join(wt, 'notignored.env')) && !isLink(path.join(wt, '.env.tracked')) &&
     read(path.join(wt, '.env.tracked')) === 'TRACKED=1\n' && !exists(path.join(wt, abs.slice(1))),
     fs.readdirSync(wt).join(' '));
  ok('3 the tracked file is untouched, so the worktree is clean', sb.git(wt, 'status', '--porcelain') === '');
}

/* ── 4. Detach / relink, 7. --to-trunk ────────────────────────────────── */
{
  const sb = make('detach');
  const p = project(sb, { envFiles: '".env .env.local"' });
  fs.writeFileSync(path.join(p.trunk, '.env.local'), 'LOCAL=1\n');
  sb.zsh(p.trunk, 'wnew d');
  const wt = p.wt('d');
  const env = path.join(wt, '.env');
  let r = sb.zsh(wt, 'wenv --detach .env');
  ok('4 --detach turns the link into a real copy with the same bytes', r.code === 0 && !isLink(env) &&
     read(env) === read(path.join(p.trunk, '.env')), r.out);
  ok('4 --detach records the intent in .worktree-detached', read(path.join(wt, '.worktree-detached')) === '.env\n');
  ok('4 .worktree-detached is excluded from git, so the tree stays clean', sb.git(wt, 'status', '--porcelain') === '');
  r = sb.zsh(wt, 'wenv');
  ok('4 detach → wenv: the identical copy is kept', !isLink(env) && r.out.includes('detached .env — kept'), r.out);
  r = sb.zsh(p.trunk, 'wenv --link-all');
  ok('4 detach → wenv → --link-all: still a real copy, though byte-identical', !isLink(env) &&
     r.out.includes('detached: app-d .env (kept)'), r.out);
  ok('4 --detach refuses a name that is not in ENV_FILES', sb.zsh(wt, 'wenv --detach README.md').code !== 0);

  fs.writeFileSync(env, 'API_KEY=override\n');
  r = sb.zsh(wt, 'wenv --link .env');
  ok('4 --link refuses a differing copy without --force', r.code !== 0 && !isLink(env) && read(env) === 'API_KEY=override\n' &&
     r.out.includes('refused: .env differs from trunk'), r.out);
  ok('4 …and the detach record survives the refusal', read(path.join(wt, '.worktree-detached')) === '.env\n');

  // 7. --to-trunk from a detached source updates the trunk and says so.
  const trunkEnv = path.join(p.trunk, '.env');
  r = sb.zsh(p.trunk, `wenv --to-trunk ${JSON.stringify(wt)}`);
  ok('7 --to-trunk: a detached source updates the trunk and is named', r.code === 0 && read(trunkEnv) === 'API_KEY=override\n' &&
     r.out.includes('seeded .env'), r.out);
  ok('7 --to-trunk: a linked source (.env.local) is a no-op', r.out.includes("already the trunk's: .env.local") &&
     read(path.join(p.trunk, '.env.local')) === 'LOCAL=1\n', r.out);
  const before = read(trunkEnv);
  r = sb.zsh(p.trunk, `wenv --to-trunk ${JSON.stringify(wt)}`);
  ok('7 --to-trunk again: an identical detached source changes nothing', r.code === 0 && read(trunkEnv) === before && r.out.includes('unchanged .env'), r.out);
  fs.writeFileSync(env, 'API_KEY=newer\n');
  fs.chmodSync(p.trunk, 0o555);
  r = sb.zsh(p.trunk, `wenv --to-trunk ${JSON.stringify(wt)}`);
  fs.chmodSync(p.trunk, 0o755);
  ok('7 --to-trunk into an unwritable trunk exits non-zero and names the file', r.code !== 0 && r.out.includes('FAILED to seed .env') &&
     read(trunkEnv) === before, r.out);

  fs.writeFileSync(env, 'API_KEY=override2\n');
  r = sb.zsh(wt, 'wenv --link --force .env');
  ok('4 --link --force discards the copy and links', r.code === 0 && isLink(env), r.out);
  ok('4 …and clears the detach record', !exists(path.join(wt, '.worktree-detached')));

  // Plain wenv never converts a real file, identical or not.
  fs.rmSync(env);
  fs.copyFileSync(trunkEnv, env);
  fs.rmSync(path.join(wt, '.env.local'));
  fs.writeFileSync(path.join(wt, '.env.local'), 'LOCAL=stale\n');
  r = sb.zsh(wt, 'wenv');
  ok('4 plain wenv leaves an identical real copy as a real file', !isLink(env) && r.out.includes('copy .env'), r.out);
  ok('4 plain wenv leaves a differing real file as it is', !isLink(path.join(wt, '.env.local')) &&
     read(path.join(wt, '.env.local')) === 'LOCAL=stale\n' && r.out.includes('stale-or-override .env.local'), r.out);
  fs.rmSync(path.join(wt, '.env.local'));
  fs.symlinkSync(path.join(sb.root, 'nowhere'), path.join(wt, '.env.local'));
  r = sb.zsh(wt, 'wenv');
  ok('4 plain wenv relinks a broken link', isLink(path.join(wt, '.env.local')) && read(path.join(wt, '.env.local')) === 'LOCAL=1\n', r.out);
  fs.rmSync(path.join(wt, '.env.local'));
  r = sb.zsh(wt, 'wenv');
  ok('4 plain wenv links a missing entry', isLink(path.join(wt, '.env.local')), r.out);
}

/* ── 5. Migration ─────────────────────────────────────────────────────── */
{
  const sb = make('migrate');
  const files = ['.env', '.env.stale', '.env.detached', '.env.missing', 'sub/.env', '.env.foreign', '.env.copy'];
  const p = project(sb, { envFiles: `(${files.map((f) => JSON.stringify(f)).join(' ')})` });
  fs.mkdirSync(path.join(p.trunk, 'sub'));
  for (const f of files.slice(1)) fs.writeFileSync(path.join(p.trunk, f), `${f}=trunk\n`);
  sb.zsh(p.trunk, 'wnew m');
  sb.zsh(p.trunk, 'wnew m2');
  const wt = p.wt('m'), wt2 = p.wt('m2');
  // Shape m into every state at once.
  const set = (f, how) => { fs.rmSync(path.join(wt, f), { force: true }); how(path.join(wt, f)); };
  set('.env.stale', (d) => fs.writeFileSync(d, 'STALE=old-value\n'));
  sb.zsh(wt, 'wenv --detach .env.detached');
  set('.env.missing', () => {});
  set('sub/.env', (d) => fs.symlinkSync(path.join(sb.root, 'gone', 'sub.env'), d));
  const foreignTarget = path.join(sb.root, 'elsewhere.env');
  fs.writeFileSync(foreignTarget, 'FOREIGN=1\n');
  set('.env.foreign', (d) => fs.symlinkSync(foreignTarget, d));
  set('.env.copy', (d) => fs.copyFileSync(path.join(p.trunk, '.env.copy'), d));
  // m2 holds old-style copies of everything, as every worktree does today.
  for (const f of files) { fs.rmSync(path.join(wt2, f), { force: true }); fs.copyFileSync(path.join(p.trunk, f), path.join(wt2, f)); }
  const snapTrunk = () => files.map((f) => `${f}:${isLink(path.join(p.trunk, f))}:${read(path.join(p.trunk, f))}`).join('|');
  const trunkBefore = snapTrunk();

  let r = sb.zsh(p.trunk, 'wls');
  ok('5 wls shows the mixed worktree\'s env summary', /app-m\s.*copy:1,detached:1,stale:1,missing:1,broken:1,foreign:1/.test(r.out), r.out);
  ok('5 wls shows an all-copies worktree as copy:7', /app-m2\s.*copy:7/.test(r.out), r.out);

  const dry = sb.zsh(p.trunk, 'wenv --link-all --dry-run');
  ok('5 --link-all --dry-run names what it would convert, and changes nothing',
     dry.out.includes('would convert: app-m .env.copy') && !isLink(path.join(wt, '.env.copy')) && !isLink(path.join(wt2, '.env')), dry.out);

  r = sb.zsh(p.trunk, 'wenv --link-all');
  const line = (s) => r.out.includes(s);
  ok('5 identical copy → converted', line('converted: app-m .env.copy') && isLink(path.join(wt, '.env.copy')), r.out);
  ok('5 stale → listed as stale-or-override with both resolutions',
     line(`stale-or-override: app-m .env.stale  -> cd ${wt} && wenv --link --force .env.stale   (or keep it: wenv --detach .env.stale)`) &&
     read(path.join(wt, '.env.stale')) === 'STALE=old-value\n' && !isLink(path.join(wt, '.env.stale')), r.out);
  ok('5 detached → kept', line('detached: app-m .env.detached (kept)') && !isLink(path.join(wt, '.env.detached')));
  ok('5 missing → listed, not created', line(`missing: app-m .env.missing  -> cd ${wt} && wenv`) && !exists(path.join(wt, '.env.missing')));
  ok('5 broken → listed, not touched', line(`broken: app-m sub/.env  -> cd ${wt} && wenv`) &&
     fs.readlinkSync(path.join(wt, 'sub/.env')) === path.join(sb.root, 'gone', 'sub.env'));
  ok('5 foreign → listed, not touched', line(`foreign: app-m .env.foreign  -> cd ${wt} && wenv --link --force .env.foreign`) &&
     fs.readlinkSync(path.join(wt, '.env.foreign')) === foreignTarget);
  ok('5 linked → left as it is', isLink(path.join(wt, '.env')) && !r.out.includes('app-m .env\n'));
  ok('5 the summary line for the mixed worktree', line('app-m: detached:1,stale:1,missing:1,broken:1,foreign:1'), r.out);
  ok('5 every worktree is covered: all of m2\'s identical copies became links',
     files.every((f) => isLink(path.join(wt2, f))) && line('app-m2: linked'), r.out);
  ok('5 the trunk is excluded: its files are unchanged, none is a link', snapTrunk() === trunkBefore);
  ok('5 the primary checkout is covered too, without inventing files', !fs.readdirSync(p.primary).some((n) => n.startsWith('.env')));
}

/* ── 8. Done detection ────────────────────────────────────────────────── */
const verdicts = (sb, cwd, args = '--json') => {
  const r = sb.zsh(cwd, `wclean ${args}`);
  try { return { ...JSON.parse(r.stdout), raw: r.out }; } catch { return { worktrees: [], notes: [], raw: r.out }; }
};
const verdict = (v, name) => v.worktrees.find((w) => w.name === name) || { status: 'missing', reason: v.raw };
{
  const sb = make('done');
  const p = project(sb);
  const branch = (name, commits = 1) => {
    const r = sb.zsh(p.trunk, `wnew ${name}`);
    if (r.code !== 0) throw new Error(r.out);
    const wt = p.wt(name);
    for (let i = 0; i < commits; i++) {
      fs.writeFileSync(path.join(wt, `${name}.txt`), `${name} ${i} ${process.hrtime.bigint()}\n`);
      sb.git(wt, 'add', '.');
      sb.git(wt, 'commit', '-q', '-m', `${name} ${i}`);
    }
    sb.git(wt, 'push', '-q', '-f', 'origin', `${name}:${name}`);
    return { wt, head: sb.git(wt, 'rev-parse', 'HEAD') };
  };

  const sq = branch('sq', 2); p.squash('sq');
  const after = branch('after'); p.squash('after'); fs.writeFileSync(path.join(after.wt, 'more.txt'), 'x\n');
  sb.git(after.wt, 'add', '.'); sb.git(after.wt, 'commit', '-q', '-m', 'after merge');
  // A reused name: `reuse` was merged at an older commit, then deleted and cut again.
  const old = branch('reuse'); p.squash('reuse');
  sb.zsh(p.trunk, `wrm reuse --force`);
  sb.git(p.trunk, 'branch', '-D', 'reuse');
  p.fetch();
  const reuse = branch('reuse');
  const fork = branch('fork');
  // `behind`: the PR got another commit pushed from elsewhere, then merged.
  const behind = branch('behind');
  sb.git(p.scratch, 'fetch', '-q', 'origin');
  sb.git(p.scratch, 'checkout', '-q', '-B', 'behind', 'origin/behind');
  fs.writeFileSync(path.join(p.scratch, 'fixup.txt'), 'review fix\n');
  sb.git(p.scratch, 'add', '.');
  sb.git(p.scratch, 'commit', '-q', '-m', 'review fix');
  sb.git(p.scratch, 'push', '-q', 'origin', 'behind');
  const behindHead = sb.git(p.scratch, 'rev-parse', 'HEAD');
  p.squash('behind');
  const unseen = branch('unseen');
  const wrongb = branch('wrongb');
  // Ancestor of BASE: merged with a real merge commit, no gh needed.
  const anc = branch('anc');
  sb.git(p.scratch, 'fetch', '-q', 'origin');
  sb.git(p.scratch, 'checkout', '-q', '-B', 'main', 'origin/main');
  sb.git(p.scratch, 'merge', '-q', '--no-ff', '-m', 'merge anc', 'origin/anc');
  sb.git(p.scratch, 'push', '-q', 'origin', 'main');
  p.fetch();
  sb.gh({
    sq: [pr(11, sq.head)],
    after: [pr(12, sb.git(p.scratch, 'rev-parse', 'origin/after'))],
    reuse: [pr(13, old.head)],
    fork: [pr(14, fork.head, { owner: 'someone-else' })],
    wrongb: [pr(15, wrongb.head, { base: 'develop' })],
    behind: [pr(16, behindHead)],
    unseen: [pr(17, 'f'.repeat(40))],
    __pretty: true,
  });
  let v = verdicts(sb, p.trunk);
  ok('8 squash-merged at exactly HEAD → done, via the PR', verdict(v, 'sq').status === 'done' && verdict(v, 'sq').via === 'merged PR #11', JSON.stringify(verdict(v, 'sq')));
  ok('8 a commit after the merged PR → not done, and says so', verdict(v, 'after').status === 'not-done' &&
     verdict(v, 'after').reason === '1 commit after merged PR #12', JSON.stringify(verdict(v, 'after')));
  ok('8 a reused branch name with an older merged PR → not done', verdict(v, 'reuse').status === 'not-done' &&
     verdict(v, 'reuse').reason === 'merged PR #13 was for a different commit of reuse', JSON.stringify(verdict(v, 'reuse')));
  ok('8 a checkout behind its merged PR\'s head (more was pushed elsewhere) → not done, and says so', verdict(v, 'behind').status === 'not-done' &&
     verdict(v, 'behind').reason === 'behind merged PR #16 — its head has commits this checkout lacks (pull, then re-check)', JSON.stringify(verdict(v, 'behind')));
  ok('8 a merged PR head this checkout does not have → not done, and says so', verdict(v, 'unseen').status === 'not-done' &&
     verdict(v, 'unseen').reason === "merged PR #17's head is not in this checkout (fetch, then re-check)", JSON.stringify(verdict(v, 'unseen')));
  ok('8 a fork PR with the same head name (and even the same sha) → not done', verdict(v, 'fork').status === 'not-done' &&
     verdict(v, 'fork').reason === 'merged PR #14 came from another fork', JSON.stringify(verdict(v, 'fork')));
  ok('8 a PR into the wrong base → not done', verdict(v, 'wrongb').status === 'not-done' &&
     verdict(v, 'wrongb').reason === 'merged PR #15 went into develop, not main', JSON.stringify(verdict(v, 'wrongb')));
  ok('8 an ancestor of BASE → done, with no PR needed', verdict(v, 'anc').status === 'done' && verdict(v, 'anc').via === 'in origin/main', JSON.stringify(verdict(v, 'anc')));
  ok('8 the trunk and the primary checkout are never done', verdict(v, 'trunk').reason === 'trunk' &&
     v.worktrees.find((w) => w.path === p.primary)?.reason === 'primary checkout', v.raw);
  const calls = sb.ghCalls();
  ok('8 gh is asked about origin\'s repo explicitly, merged PRs only, GH_REPO unset', calls.length > 0 &&
     calls.every((c) => c.argv.includes('--repo') && c.argv[c.argv.indexOf('--repo') + 1] === 'acme/app' && c.GH_REPO === null),
     JSON.stringify(calls.slice(0, 2)));
  const hostile = verdicts(sb, p.trunk, '--json');   // same answer with GH_REPO poisoned in the caller
  const poisoned = sb.zsh(p.trunk, 'GH_REPO=evil/repo wclean --json');
  ok('8 a GH_REPO in the caller\'s environment cannot redirect the query', poisoned.code === 0 &&
     sb.ghCalls().slice(-1)[0].GH_REPO === null && JSON.parse(poisoned.stdout).worktrees.find((w) => w.name === 'sq').status === 'done' &&
     hostile.worktrees.length > 0);

  sb.gh({ sq: 'fail' });
  v = verdicts(sb, p.trunk);
  ok('8 gh failing → the squash-merged one is not done, and the note says why', verdict(v, 'sq').status === 'not-done' &&
     /ancestor check only: gh failed: HTTP 401/.test(verdict(v, 'sq').reason) && v.notes.some((n) => /gh failed/.test(n)), JSON.stringify(v.notes));
  sb.gh({ sq: [pr(11, sq.head)] });
  fs.writeFileSync(sb.env.WT_TEST_GH, '{"sq": "not json at all');
  v = verdicts(sb, p.trunk);
  ok('8 unparseable gh output → not done, never "no PRs"', verdict(v, 'sq').status === 'not-done' && /ancestor check only/.test(verdict(v, 'sq').reason), JSON.stringify(verdict(v, 'sq')));
  sb.noGh();
  v = verdicts(sb, p.trunk);
  ok('8 gh missing → ancestor check only: the squash-merged one is not done', verdict(v, 'sq').status === 'not-done' &&
     verdict(v, 'sq').reason === 'not in origin/main (ancestor check only: gh not installed)', JSON.stringify(verdict(v, 'sq')));
  ok('8 gh missing → the ancestor one is still done', verdict(v, 'anc').status === 'done');
  ok('8 gh missing → a note says squash merges are not detected', v.notes.some((n) => n.startsWith('gh not installed — squash merges are not detected')), JSON.stringify(v.notes));
  const text = sb.zsh(p.trunk, 'wclean --no-fetch');
  ok('8 the text form prints every worktree, done or its reason, and the note', /anc\s+\[anc\]\s+done \(in origin\/main \(not fetched — stale\)\)/.test(text.out) &&
     /sq\s+\[sq\]\s+not in origin\/main/.test(text.out) && text.out.includes('wclean: gh not installed'), text.out);
  sb.restoreGh();
  sb.gh({ sq: [pr(11, sq.head)] });

  // Each local blocker on an otherwise-done worktree gives its own reason.
  const blocker = (name, setup, reason, status = 'not-done') => {
    const b = branch(name); p.squash(name); p.fetch();
    const table = JSON.parse(fs.readFileSync(sb.env.WT_TEST_GH, 'utf8'));
    table[name] = [pr(20, b.head)];
    sb.gh(table);
    ok(`8 control: ${name} is done before the blocker`, verdict(verdicts(sb, p.trunk), name).status === 'done');
    setup(b.wt);
    const got = verdict(verdicts(sb, p.trunk), name);
    const match = reason instanceof RegExp ? reason.test(got.reason) : got.reason === reason;
    ok(`8 ${name}: ${reason} → ${status}`, got.status === status && match, JSON.stringify(got));
    return b;
  };
  blocker('dirty', (wt) => fs.appendFileSync(path.join(wt, 'README.md'), 'edit\n'), 'uncommitted changes (1)');
  blocker('untracked', (wt) => {
    sb.git(wt, 'config', 'status.showUntrackedFiles', 'no');
    fs.writeFileSync(path.join(wt, 'notes.txt'), 'x\n');
  }, '1 untracked file');
  blocker('rebasing', (wt) => {
    fs.writeFileSync(path.join(wt, 'app.txt'), 'mine\n');
    sb.git(wt, 'commit', '-q', '-am', 'mine');
    fs.writeFileSync(path.join(p.scratch, 'app.txt'), 'theirs\n');
    sb.git(p.scratch, 'commit', '-q', '-am', 'theirs');
    sb.git(p.scratch, 'push', '-q', 'origin', 'main');
    p.fetch();
    try { sb.git(wt, 'rebase', 'origin/main'); } catch { /* the conflict is the point */ }
  }, 'rebase in progress');
  blocker('locked', (wt) => sb.git(p.trunk, 'worktree', 'lock', wt), 'locked');
  blocker('headless', (wt) => sb.git(wt, 'checkout', '-q', '--detach'), 'detached HEAD');
  blocker('submod', (wt) => {
    sb.git(wt, 'update-index', '--add', '--cacheinfo', `160000,${sb.git(wt, 'rev-parse', 'HEAD')},vendor/lib`);
    sb.git(wt, 'commit', '-q', '-m', 'add a submodule');
  }, 'contains submodules');
  blocker('corrupt', (wt) => fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /nonexistent/nowhere\n'), /^unknown — not removable: /, 'unknown');
  blocker('envdet', (wt) => sb.zsh(wt, 'wenv --detach .env'), 'detached .env — wenv --to-trunk or delete it first');
  blocker('envdiff', (wt) => { fs.rmSync(path.join(wt, '.env')); fs.writeFileSync(path.join(wt, '.env'), 'API_KEY=local-only\n'); },
    '.env differs from trunk — wenv --to-trunk or delete it first');
  blocker('envonly', (wt) => fs.writeFileSync(path.join(wt, '.env.local'), 'ONLY_HERE=1\n'),
    '.env.local differs from trunk — wenv --to-trunk or delete it first');
  blocker('envfine', (wt) => { fs.rmSync(path.join(wt, '.env')); fs.copyFileSync(path.join(p.trunk, '.env'), path.join(wt, '.env')); },
    'done', 'done');
}

/* ── 9. Removal safety ────────────────────────────────────────────────── */
{
  const sb = make('remove');
  const p = project(sb);
  const mk = (name) => {
    sb.zsh(p.trunk, `wnew ${name}`);
    const wt = p.wt(name);
    fs.writeFileSync(path.join(wt, `${name}.txt`), `${name}\n`);
    sb.git(wt, 'add', '.');
    sb.git(wt, 'commit', '-q', '-m', name);
    sb.git(wt, 'push', '-q', 'origin', `${name}:${name}`);
    p.squash(name);
    const head = sb.git(wt, 'rev-parse', 'HEAD');
    const table = JSON.parse(fs.readFileSync(sb.env.WT_TEST_GH, 'utf8'));
    table[name] = [pr(30, head)];
    sb.gh(table);
    return { wt, head };
  };
  const a = mk('ra'), b = mk('rb');
  p.fetch();
  const hasBranch = (name) => { try { sb.git(p.trunk, 'rev-parse', '--verify', '-q', `refs/heads/${name}`); return true; } catch { return false; } };

  for (const answer of ['n\n', '\n', 'yes\n', '']) {
    const r = sb.zsh(p.trunk, 'wclean --remove', { input: answer });
    ok(`9 answering ${JSON.stringify(answer)} removes nothing`, r.out.includes('nothing removed') && fs.existsSync(a.wt) && fs.existsSync(b.wt) &&
       hasBranch('ra') && hasBranch('rb'), r.out);
  }
  ok('9 the prompt lists only done worktrees (never trunk, primary)', (() => {
    const r = sb.zsh(p.trunk, 'wclean --remove', { input: 'n\n' });
    return r.out.includes('Remove 2 done worktrees') && /trunk\s+\[main\]\s+trunk/.test(r.out) && /app\s+\[main\]\s+primary checkout/.test(r.out);
  })());
  const inside = sb.zsh(a.wt, 'wclean --remove', { input: 'y\n' });
  ok('9 run from inside a done worktree: that one is "you are inside it" and survives', fs.existsSync(a.wt) &&
     /ra\s+\[ra\]\s+you are inside it/.test(inside.out), inside.out);
  ok('9 …while the other done one was removed with its branch', !fs.existsSync(b.wt) && !hasBranch('rb') &&
     inside.out.includes('removed rb and branch rb'), inside.out);
  const sub = path.join(a.wt, 'deep', 'er');
  fs.mkdirSync(sub, { recursive: true });
  const deeper = sb.zsh(sub, 'wclean --remove', { input: 'y\n' });
  ok('9 run from a directory INSIDE a worktree: still protected', fs.existsSync(a.wt) && deeper.out.includes('you are inside it'), deeper.out);
  fs.rmSync(path.join(a.wt, 'deep'), { recursive: true });

  // A commit made while the prompt waits: that worktree is skipped.
  const c = mk('rc'); p.fetch();
  let live = sb.zshLive(p.trunk, 'wclean --remove');
  await live.until('[y/N]');
  fs.writeFileSync(path.join(c.wt, 'late.txt'), 'late\n');
  sb.git(c.wt, 'add', '.');
  sb.git(c.wt, 'commit', '-q', '-m', 'late commit');
  live.child.stdin.end('y\n');
  await live.exited;
  ok('9 a commit made during the prompt skips that worktree', fs.existsSync(c.wt) && hasBranch('rc') &&
     live.out.includes('skipped rc — no longer the same worktree (path, branch and HEAD approved)'), live.out);
  ok('9 …and the others still go', !fs.existsSync(a.wt) && live.out.includes('removed ra and branch ra'), live.out);

  // Two removers at once: the second refuses while the first waits at its prompt.
  const d = mk('rd'); p.fetch();
  live = sb.zshLive(p.trunk, 'wclean --remove');
  await live.until('[y/N]');
  const second = sb.zsh(p.trunk, 'wclean --remove', { input: 'y\n' });
  ok('9 a second concurrent wclean --remove refuses (lock) and removes nothing',
     second.code !== 0 && second.out.includes('another wclean --remove is running') && fs.existsSync(d.wt), second.out);
  live.child.stdin.end('y\n');
  await live.exited;
  ok('9 …the first one then removes it, once', !fs.existsSync(d.wt) && (live.out.match(/removed rd/g) || []).length === 1, live.out);
  const common = sb.git(p.trunk, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  ok('9 the lock is released when it finishes', !fs.existsSync(path.join(common, 'wt-clean.lock')));
  fs.mkdirSync(path.join(common, 'wt-clean.lock'));
  fs.writeFileSync(path.join(common, 'wt-clean.lock', 'pid'), '999999\n');
  ok('9 a lock left by a dead process is taken over', sb.zsh(p.trunk, 'wclean --remove', { input: 'n\n' }).out.includes('nothing'));

  // The branch's tip moves between the removal and the branch delete: kept.
  const e = mk('re'); p.fetch();
  let r = sb.zsh(p.trunk, 'wclean --remove', { input: 'y\n', extraEnv: { WT_TEST_MOVE_BRANCH: 're', WT_TEST_MOVE_TO: 'rc', WT_TEST_TRUNK: p.trunk } });
  ok('9 a branch whose tip moved is kept', !fs.existsSync(e.wt) && hasBranch('re') && r.out.includes('kept branch re — its tip moved'), r.out);

  // A failed removal keeps the branch and fails the command.
  const f = mk('rf'); p.fetch();
  r = sb.zsh(p.trunk, 'wclean --remove', { input: 'y\n', extraEnv: { WT_TEST_FAIL_REMOVE: '1' } });
  ok('9 a failed removal keeps the worktree and its branch, and exits non-zero', r.code !== 0 && fs.existsSync(f.wt) && hasBranch('rf') &&
     r.out.includes('FAILED to remove rf') && r.out.includes('branch rf kept'), r.out);

  const removes = sb.gitLog().split('\n').filter((l) => / worktree remove /.test(` ${l} `));
  ok('9 every removal ran `git worktree remove` without --force', removes.length >= 5 && removes.every((l) => !/(^|\s)(--force|-f)(\s|$)/.test(l)),
     removes.join('\n'));
  ok('9 no removal ever named the trunk or the primary checkout', removes.every((l) => !l.endsWith(p.trunk) && !l.endsWith(p.primary)));
  const src = fs.readFileSync(path.join(TOOLKIT, 'wt.zsh'), 'utf8');
  const wcleanSrc = src.slice(src.indexOf('\nwclean() {'), src.indexOf('\n# wrm <name>'));
  ok('9 wclean\'s source has no forced removal', wcleanSrc.length > 1000 && !/worktree remove[^\n]*(--force|-f\b)/.test(wcleanSrc));
}

/* ── 10. Existing flows ───────────────────────────────────────────────── */
{
  const sb = make('flows');
  const p = project(sb, { cmd: 'zz' });
  let conf = fs.readFileSync(p.conf, 'utf8').replace(/^PORTS=.*$/m, 'PORTS="4611 4612"').replace(/^POST_CREATE=.*$/m, 'POST_CREATE="mkdir -p node_modules && touch node_modules/.post-created"');
  fs.writeFileSync(p.conf, conf + 'WT_DEV_CMD=\'echo "dev on $PORT"\'\n');
  let r = sb.zsh(p.trunk, 'wnew one && print -r -- "PWD=$PWD"');
  const one = p.wt('one');
  ok('10 wnew: creates, links env, claims a port, runs post-create, cds in, prints the banner', r.code === 0 &&
     r.out.includes(`PWD=${one}`) && r.out.includes('url       http://localhost:4611') && fs.existsSync(path.join(one, 'node_modules', '.post-created')) &&
     isLink(path.join(one, '.env')) && /branch\s+one\s+\(off origin\/main @ [0-9a-f]+\)/.test(r.out), r.out);
  r = sb.zsh(p.trunk, 'wnew one');
  ok('10 wnew on an existing name: says exists, no second worktree', r.out.includes(`exists -> ${one}`));
  r = sb.zsh(sb.home, 'wgo one && print -r -- "PWD=$PWD"');
  ok('10 wgo from the trunk\'s repo only (outside a repo, no config)', r.code !== 0, r.out);
  r = sb.zsh(p.trunk, 'wgo one && print -r -- "PWD=$PWD"');
  ok('10 wgo cds into the worktree', r.out.includes(`PWD=${one}`), r.out);
  r = sb.zsh(one, 'wtrunk && print -r -- "PWD=$PWD"');
  ok('10 wtrunk cds to the trunk', r.out.includes(`PWD=${p.trunk}`), r.out);
  r = sb.zsh(p.trunk, 'wls');
  ok('10 wls lists trunk (*), worktree with branch, port, dirty and env', /^\* app-trunk\s+main\s+-\s+0\s+trunk/m.test(r.out) &&
     /^  app-one\s+one\s+4611\s+0\s+linked/m.test(r.out), r.out);
  r = sb.zsh(one, 'wdev');
  ok('10 wdev runs WT_DEV_CMD on the claimed port', r.out.includes('wdev: -> http://localhost:4611') && r.out.includes('dev on 4611'), r.out);
  r = sb.zsh(sb.home, 'zznew two && print -r -- "PWD=$PWD"');
  const two = p.wt('two');
  ok('10 prefixed zznew works from any directory', r.code === 0 && r.out.includes(`PWD=${two}`) && r.out.includes('http://localhost:4612'), r.out);
  r = sb.zsh(sb.home, 'zzls');
  ok('10 prefixed zzls', r.out.includes('app-two'), r.out);
  r = sb.zsh(sb.home, 'zzgo two && print -r -- "PWD=$PWD"');
  ok('10 prefixed zzgo', r.out.includes(`PWD=${two}`), r.out);
  r = sb.zsh(sb.home, 'zztrunk && print -r -- "PWD=$PWD"');
  ok('10 prefixed zztrunk', r.out.includes(`PWD=${p.trunk}`), r.out);
  r = sb.zsh(sb.home, 'zz && print -r -- "PWD=$PWD"');
  ok('10 the bare prefix drops into the trunk', r.out.includes(`PWD=${p.trunk}`), r.out);
  r = sb.zsh(sb.home, 'zzenv --status');
  ok('10 prefixed zzenv (outside a worktree: says so)', r.out.includes('not in a git worktree'), r.out);
  r = sb.zsh(sb.home, 'zzclean --no-fetch');
  ok('10 prefixed zzclean lists the project', r.code === 0 && r.out.includes('Worktrees of app-trunk against origin/main'), r.out);
  r = sb.zsh(two, 'zzrm two && print -r -- "PWD=$PWD"');
  ok('10 prefixed zzrm removes the worktree it is run from, and leaves you in the trunk', r.code === 0 && !fs.existsSync(two) &&
     r.out.includes(`PWD=${p.trunk}`), r.out);
  r = sb.zsh(p.trunk, 'wrm one');
  ok('10 wrm removes a worktree', r.code === 0 && !fs.existsSync(one), r.out);
  r = sb.zsh(sb.home, 'wtreg');
  ok('10 wtreg lists the registered prefix', /app\s+zz\s+/.test(r.out), r.out);
  r = sb.zsh(p.primary, 'wtinit');
  ok('10 wtinit on a configured repo: already configured, changes nothing', r.out.includes('wtinit: already configured'), r.out);

  // A project configured without a prefix is registered too, and can gain one later.
  const sb2 = make('flows2');
  const q = project(sb2);
  const regFile = path.join(sb2.env.WT_HOME, 'repos', 'app.conf');
  ok('10 wtinit without --cmd registers the project with an empty CMD', read(regFile) === `CMD=\nTRUNK="${q.trunk}"\n`, read(regFile));
  r = sb2.zsh(sb2.home, 'wtreg');
  ok('10 wtreg shows it with no prefix', /app\s+—\s+/.test(r.out), r.out);
  r = sb2.zsh(q.primary, 'wtinit --register --cmd qq');
  ok('10 wtinit --register --cmd on an existing config adds the prefix', r.code === 0 && read(regFile) === `CMD=qq\nTRUNK="${q.trunk}"\n` &&
     r.out.includes('registered qqnew'), r.out);
  r = sb2.zsh(q.trunk, 'wtinit --register');
  ok('10 wtinit --register again keeps the prefix it is not given', r.code === 0 && read(regFile) === `CMD=qq\nTRUNK="${q.trunk}"\n`, r.out);
  fs.writeFileSync(regFile, 'CMD=qq\nTRUNK="/somewhere/else"\n');
  r = sb2.zsh(q.primary, 'wtinit --register');
  ok('10 wtinit --register refuses a key that names another trunk', r.code !== 0 && r.out.includes('already registers /somewhere/else'), r.out);
}

/* ── wls / direnv ─────────────────────────────────────────────────────── */
if (DIRENV) {
  const sb = make('direnv');
  const p = project(sb, { envFiles: '".env .envrc"' });
  fs.appendFileSync(path.join(p.scratch, '.gitignore'), '.envrc\n');
  sb.git(p.scratch, 'commit', '-q', '-am', 'ignore envrc');
  sb.git(p.scratch, 'push', '-q', 'origin', 'HEAD:main');
  p.fetch();
  fs.writeFileSync(path.join(p.trunk, '.envrc'), 'export FROM_ENVRC=1\n');
  // The trunk's own .envrc is allowed by hand, once, as on a real machine:
  // wnew fetches through it.
  sb.zsh(p.trunk, 'direnv allow');
  let r = sb.zsh(p.trunk, 'wnew dv');
  const wt = p.wt('dv');
  ok('B wnew links .envrc and allows it once (direnv reports allowed)', isLink(path.join(wt, '.envrc')) &&
     !r.out.includes('direnv allow failed'), r.out);
  r = sb.zsh(p.trunk, 'wls --json');
  const row = JSON.parse(r.stdout).worktrees.find((w) => w.name === 'app-dv');
  ok('B wls --json: envrc allowed after wnew', row?.envrc === 'allowed', JSON.stringify(row));
  fs.appendFileSync(path.join(p.trunk, '.envrc'), 'export MORE=1\n');
  r = sb.zsh(p.trunk, 'wenv --link-all; wls');
  ok('B editing the shared .envrc: relinking never re-allows, wls shows envrc:blocked', /app-dv\s.*envrc:blocked/.test(r.out), r.out);
  const allowDir = path.join(sb.env.XDG_DATA_HOME, 'direnv', 'allow');
  ok('B direnv\'s allow list lives in the sandbox', fs.existsSync(allowDir) && fs.readdirSync(allowDir).length >= 1);
} else {
  console.log('  SKIP B direnv checks — direnv is not installed (the rest of the suite does not need it)');
}

/* ── Grade fixes (builds/worktree-tools/grade.md, bugs 1–6) ───────────── */
{
  const sb = make('grade');
  const p = project(sb);
  const drop = (wt, b) => {   // cleanup between cases; tolerant, the case itself has been asserted
    try { sb.git(p.trunk, 'worktree', 'remove', '--force', wt); } catch {}
    try { sb.git(p.trunk, 'branch', '-D', b); } catch {}
  };
  const hasBranch = (name) => { try { sb.git(p.trunk, 'rev-parse', '--verify', '-q', `refs/heads/${name}`); return true; } catch { return false; } };

  // G1: A, B, C done at the same sha, D locked; D is unlocked while the prompt waits.
  for (const n of ['ga', 'gb', 'gc', 'gd']) sb.zsh(p.trunk, `wnew ${n}`);
  sb.git(p.trunk, 'worktree', 'lock', p.wt('gd'));
  let live = sb.zshLive(p.trunk, 'wclean --remove');
  await live.until('[y/N]');
  ok('G1 the prompt offers exactly A, B and C', live.out.includes('Remove 3 done worktrees') && /gd\s+\[gd\]\s+locked/.test(live.out), live.out);
  sb.git(p.trunk, 'worktree', 'unlock', p.wt('gd'));
  live.child.stdin.end('y\n');
  await live.exited;
  ok('G1 approving A, B, C removes A, B, C — never D, which was not approved',
     ['ga', 'gb', 'gc'].every((n) => !fs.existsSync(p.wt(n)) && !hasBranch(n)) && fs.existsSync(p.wt('gd')) && hasBranch('gd') &&
     !live.out.includes('removed gd'), live.out);

  // G1b: an approved worktree removed and re-created under the same path and branch
  // at another commit is not the tuple that was approved.
  for (const n of ['ge', 'gf']) sb.zsh(p.trunk, `wnew ${n}`);
  live = sb.zshLive(p.trunk, 'wclean --remove');
  await live.until('[y/N]');
  sb.git(p.trunk, 'worktree', 'remove', p.wt('ge'));
  sb.git(p.trunk, 'branch', '-D', 'ge');
  p.advance('g1b.txt'); p.fetch();
  sb.git(p.trunk, 'worktree', 'add', '-q', p.wt('ge'), '-b', 'ge', 'origin/main');
  live.child.stdin.end('y\n');
  await live.exited;
  ok('G1 a worktree re-created at the same path during the prompt is skipped, not removed',
     fs.existsSync(p.wt('ge')) && hasBranch('ge') && live.out.includes('skipped ge') && !fs.existsSync(p.wt('gf')), live.out);
  drop(p.wt('ge'), 'ge');

  // G2: an invalid entry naming a real file with unique data blocks removal.
  const conf = fs.readFileSync(p.conf, 'utf8');
  fs.writeFileSync(p.conf, conf.replace(/^ENV_FILES=.*$/m, 'ENV_FILES=(".env" "private env")'));
  sb.zsh(p.trunk, 'wnew gpriv');
  fs.writeFileSync(path.join(p.wt('gpriv'), 'private env'), 'ONLY_HERE=1\n');
  const common = sb.git(p.trunk, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  fs.appendFileSync(path.join(common, 'info', 'exclude'), 'private env\n');
  let v = verdicts(sb, p.trunk);
  ok('G2 an invalid ENV_FILES entry blocks removal, with its reason', verdict(v, 'gpriv').status !== 'done' &&
     verdict(v, 'gpriv').reason === 'ENV_FILES entry "private env" cannot be checked (contains whitespace) — not removable', JSON.stringify(verdict(v, 'gpriv')));
  let r = sb.zsh(p.trunk, 'wclean --remove', { input: 'y\n' });
  ok('G2 …and wclean --remove leaves it and its data', fs.existsSync(path.join(p.wt('gpriv'), 'private env')), r.out);
  fs.writeFileSync(p.conf, conf);
  drop(p.wt('gpriv'), 'gpriv');

  // G3: the .worktree-detached ledger.
  sb.zsh(p.trunk, 'wnew gled');
  const wt = p.wt('gled');
  const ledger = path.join(wt, '.worktree-detached');
  const sentinel = path.join(sb.root, 'outside-sentinel');
  fs.writeFileSync(sentinel, 'untouched\n');
  fs.symlinkSync(sentinel, ledger);
  r = sb.zsh(wt, 'wenv --detach .env');
  ok('G3 a symlinked ledger is refused: non-zero, nothing written through it, .env still linked', r.code !== 0 &&
     fs.readFileSync(sentinel, 'utf8') === 'untouched\n' && isLink(path.join(wt, '.env')) && r.out.includes('.worktree-detached is a symlink'), r.out);
  fs.rmSync(ledger);
  fs.mkdirSync(ledger);
  r = sb.zsh(wt, 'wenv --detach .env');
  ok('G3 a ledger that is not a regular file is refused', r.code !== 0 && isLink(path.join(wt, '.env')) && r.out.includes('.worktree-detached is not a regular file'), r.out);
  fs.rmSync(ledger, { recursive: true });
  fs.writeFileSync(ledger, '');
  sb.git(wt, 'add', '-f', '.worktree-detached');
  sb.git(wt, 'commit', '-q', '-m', 'track the ledger');
  r = sb.zsh(wt, 'wenv --detach .env');
  ok('G3 a tracked ledger is refused', r.code !== 0 && isLink(path.join(wt, '.env')) && r.out.includes('.worktree-detached is tracked by git'), r.out);
  v = verdicts(sb, p.trunk);
  ok('G3 an unsafe ledger blocks removal', verdict(v, 'gled').status !== 'done', JSON.stringify(verdict(v, 'gled')));
  r = sb.zsh(p.trunk, 'wenv --link-all');
  ok('G3 --link-all skips a worktree whose ledger is unsafe', r.out.includes('refused: app-gled — .worktree-detached is tracked by git'), r.out);
  drop(wt, 'gled');

  // G3: a ledger write that fails fails the command and leaves nothing half-done.
  const conf2 = conf.replace(/^ENV_FILES=.*$/m, 'ENV_FILES=".env sub/.env"');
  fs.writeFileSync(p.conf, conf2);
  fs.mkdirSync(path.join(p.trunk, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(p.trunk, 'sub', '.env'), 'SUB=1\n');
  fs.appendFileSync(path.join(common, 'info', 'exclude'), 'sub/.env\n');
  sb.zsh(p.trunk, 'wnew gro');
  const ro = p.wt('gro');
  ok('G3 control: sub/.env is linked', isLink(path.join(ro, 'sub', '.env')));
  fs.chmodSync(ro, 0o555);
  r = sb.zsh(ro, 'wenv --detach sub/.env');
  fs.chmodSync(ro, 0o755);
  ok('G3 a failed ledger write exits non-zero, and sub/.env is still the link', r.code !== 0 && isLink(path.join(ro, 'sub', '.env')) &&
     !fs.existsSync(path.join(ro, '.worktree-detached')) && !r.out.includes('detached sub/.env —'), r.out);
  r = sb.zsh(ro, 'wenv --detach sub/.env');
  ok('G3 control: with a writable worktree the same detach works', r.code === 0 && !isLink(path.join(ro, 'sub', '.env')) &&
     fs.readFileSync(path.join(ro, '.worktree-detached'), 'utf8') === 'sub/.env\n', r.out);
  fs.chmodSync(ro, 0o555);
  r = sb.zsh(ro, 'wenv --link --force sub/.env');
  fs.chmodSync(ro, 0o755);
  ok('G3 a ledger rewrite that fails during --link exits non-zero', r.code !== 0, r.out);
  fs.writeFileSync(p.conf, conf);
  drop(ro, 'gro');

  // G4: the branch advances between the tip check and the delete.
  sb.zsh(p.trunk, 'wnew gtip');
  sb.zsh(p.trunk, 'wnew gother');
  const other = p.wt('gother');
  fs.writeFileSync(path.join(other, 'x.txt'), 'x\n');
  sb.git(other, 'add', '.');
  sb.git(other, 'commit', '-q', '-m', 'not in base');
  sb.git(p.trunk, 'config', 'branch.gtip.description', 'metadata git branch -D would drop');
  r = sb.zsh(p.trunk, 'wclean --remove', { input: 'y\n', extraEnv: { WT_TEST_ADVANCE_ON_DELETE: 'gtip', WT_TEST_MOVE_TO: 'gother', WT_TEST_TRUNK: p.trunk } });
  ok('G4 a branch advanced at the moment of deletion is kept, and it says so', !fs.existsSync(p.wt('gtip')) && hasBranch('gtip') &&
     sb.git(p.trunk, 'rev-parse', 'gtip') === sb.git(p.trunk, 'rev-parse', 'gother') && r.out.includes('kept branch gtip — its tip moved'), r.out);
  drop(p.wt('gtip'), 'gtip');
  sb.zsh(p.trunk, 'wnew gcfg');
  sb.git(p.trunk, 'config', 'branch.gcfg.description', 'x');
  sb.git(p.trunk, 'config', 'branch.gcfg.remote', 'origin');
  r = sb.zsh(p.trunk, 'wclean --remove', { input: 'y\n' });
  const cfg = spawnSync('git', ['-C', p.trunk, 'config', '--get-regexp', '^branch\\.gcfg\\.'], { env: sb.env, encoding: 'utf8' });
  ok('G4 a deleted branch loses its branch.<b>.* config, as git branch -D would', !hasBranch('gcfg') && cfg.stdout === '' &&
     r.out.includes('removed gcfg and branch gcfg'), r.out + cfg.stdout);
  ok('G4 the delete is conditional on the inspected oid', / update-ref -d refs\/heads\/gcfg [0-9a-f]{40}/.test(sb.gitLog()));

  // G5: freshness. A failed or skipped fetch never authorises an ancestor-based removal.
  sb.zsh(p.trunk, 'wnew gstale');
  const url = sb.git(p.trunk, 'config', '--get', 'remote.origin.url');
  sb.git(p.trunk, 'config', 'remote.origin.url', path.join(sb.root, 'no-such-origin.git'));
  v = verdicts(sb, p.trunk);
  ok('G5 report mode, fetch failed: still reported done, labelled stale', verdict(v, 'gstale').status === 'done' &&
     /stale/.test(verdict(v, 'gstale').via) && v.notes.some((n) => n.startsWith('fetch failed')), JSON.stringify(verdict(v, 'gstale')));
  r = sb.zsh(p.trunk, 'wclean --remove', { input: 'y\n' });
  ok('G5 --remove with a failed fetch: the ancestor-only worktree is unknown, not removable', fs.existsSync(p.wt('gstale')) &&
     r.out.includes('unknown — fetch failed, not removable'), r.out);
  sb.git(p.trunk, 'config', 'remote.origin.url', url);
  r = sb.zsh(p.trunk, 'wclean --remove --no-fetch', { input: 'y\n' });
  ok('G5 --remove --no-fetch: same — skipping the fetch is not freshness', fs.existsSync(p.wt('gstale')) &&
     r.out.includes('unknown — not fetched, not removable'), r.out);
  v = verdicts(sb, p.trunk, '--json --no-fetch');
  ok('G5 --json --no-fetch (the panel) still reports done, labelled stale', verdict(v, 'gstale').status === 'done' && /stale/.test(verdict(v, 'gstale').via),
     JSON.stringify(verdict(v, 'gstale')));
  r = sb.zsh(p.trunk, 'wclean --remove', { input: 'y\n' });
  ok('G5 control: with a fetch that works, it is removed', !fs.existsSync(p.wt('gstale')), r.out);

  // G6: a tracked-file check that fails refuses the entry.
  sb.zsh(p.trunk, 'wnew gidx');
  const gi = p.wt('gidx');
  fs.rmSync(path.join(gi, '.env'));
  const gitdir = sb.git(gi, 'rev-parse', '--absolute-git-dir');
  fs.writeFileSync(path.join(gitdir, 'index'), 'this is not an index\n');
  r = sb.zsh(gi, 'wenv');
  ok('G6 a corrupt index refuses the entry instead of linking it', !exists(path.join(gi, '.env')) &&
     r.out.includes('refused: .env — git ls-files failed'), r.out);
}

/* ── 6. Secrets never printed ─────────────────────────────────────────── */
{
  const sb = make('secrets');
  const p = project(sb, { envFiles: '".env .env.local .env.development"' });
  fs.writeFileSync(path.join(p.trunk, '.env.local'), `LOCAL=${p.secret}\n`);
  const cmds = [];
  const run = (cwd, s, opts) => { const r = sb.zsh(cwd, s, opts); cmds.push(s); return r; };
  run(p.trunk, 'wnew s1');
  const wt = p.wt('s1');
  run(wt, 'wenv --detach .env');
  fs.writeFileSync(path.join(wt, '.env'), `API_KEY=${p.secret}-override\n`);
  fs.writeFileSync(path.join(wt, '.env.development'), `DEV=${p.secret}\n`);
  for (const s of ['wenv', 'wenv --status', 'wenv --link .env', 'wenv --link .env.development', `wenv --to-trunk ${wt}`]) run(wt, s);
  for (const s of ['wls', 'wls --json', 'wenv --link-all --dry-run', 'wenv --link-all', 'wclean', 'wclean --json', 'wclean --no-fetch']) run(p.trunk, s);
  run(p.trunk, 'wclean --remove', { input: 'n\n' });
  run(p.trunk, 'wnew s2');
  run(p.trunk, 'wclean --remove', { input: 'y\n' });
  const outs = all.flatMap((s) => s.outputs);
  const leaks = outs.filter((o) => o.includes(p.secret) || o.includes('API_KEY=') || o.includes('LOCAL='));
  ok(`6 a planted secret never appears in any output (${outs.length} command runs across every section, incl. ${cmds.length} aimed at it)`,
     outs.length > 100 && leaks.length === 0, leaks[0]);
}

for (const sb of all) sb.cleanup();
done();
