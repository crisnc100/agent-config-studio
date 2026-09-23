/**
 * Skill discovery, containment, and the /api/skills surface.
 *
 * HOME is redirected to a temp directory BEFORE anything is imported, because
 * lib/paths.js binds HOME at module load. Every fixture below — including the
 * "secrets" the injection tests try to steal — lives under that fake home; no
 * assertion here is ever pointed at a real credential file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';

const realHome = os.homedir();

// The real-home tripwire (tests/real-home.mjs) says what it compares and how.
const realBefore = snapshotRealHomes();

// realpath'd: on macOS os.tmpdir() is /var/folders/… which is itself a symlink
// to /private/var/folders/…. resolveSafe compares REAL paths against roots built
// from HOME, so an un-resolved fake home makes every path look outside every
// root — and the 403 assertions below would then pass for the wrong reason.
const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-skills-')));
process.env.HOME = fakeHome;
process.env.ACS_SUITE = 'offline';
// These tests control their own environment: an inherited CODEX_HOME would
// point the codex reader somewhere outside the fake home.
delete process.env.CODEX_HOME;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\nskills');
ok('HOME is redirected away from the real one', os.homedir() === fakeHome && fakeHome !== realHome, os.homedir());

// --- fixtures ----------------------------------------------------------------
const H = (...p) => path.join(fakeHome, ...p);
const mk = (dir) => fs.mkdirSync(dir, { recursive: true });
const put = (file, body, mode) => { mk(path.dirname(file)); fs.writeFileSync(file, body, mode ? { mode } : undefined); };
const skillMd = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\nbody\n`;

// The things an injected symlink would be after. Fake, under the fake home,
// and each carrying a unique marker so "did this ever get read" is a substring
// search over the output rather than a guess.
const SSH_MARK = 'MARKER-SSH-PRIVATE-KEY-b3f1';
const CRED_MARK = 'MARKER-CLAUDE-CREDENTIALS-9a22';
const ENV_MARK = 'MARKER-SIBLING-PROJECT-ENV-71cd';
put(H('.ssh', 'id_rsa'), `${SSH_MARK}\n`);
put(H('.claude', '.credentials.json'), `{"t":"${CRED_MARK}"}\n`);
put(H('Documents', 'Projects', 'sibling-app', '.env'), `SECRET=${ENV_MARK}\n`);

// A plain global skill with a companion file.
put(H('.claude', 'skills', 'alpha', 'SKILL.md'), skillMd('Alpha Skill', 'does alpha things'));
put(H('.claude', 'skills', 'alpha', 'scripts', 'run.sh'), '#!/bin/sh\necho alpha\n', 0o755);

// Depth 4: ~/.claude/skills/synced/<uuid>/<name>/SKILL.md.
const SYNCED_UUID = '0f8e1a22-1111-4444-8888-abcdefabcdef';
put(H('.claude', 'skills', 'synced', SYNCED_UUID, 'deep-one', 'SKILL.md'),
    skillMd('Deep One', 'four levels down'));

// A dangling symlink, exactly like the real find-skills used to be.
fs.symlinkSync(H('.agents', 'skills', 'does-not-exist'), H('.claude', 'skills', 'dangling'));

// A skill directory that is itself a symlink, resolved once at the root.
put(H('.agents', 'skills', 'find-skills', 'SKILL.md'), skillMd('Find Skills', 'lives in ~/.agents'));
fs.symlinkSync(H('.agents', 'skills', 'find-skills'), H('.claude', 'skills', 'find-skills'));

// The injection fixture: a real skill with links planted inside it.
const EVIL = H('.claude', 'skills', 'evil');
put(path.join(EVIL, 'SKILL.md'), skillMd('Evil', 'looks ordinary'));
put(path.join(EVIL, 'honest.md'), 'nothing to see\n');
fs.symlinkSync(H('.ssh', 'id_rsa'), path.join(EVIL, 'stolen-key.md'));
fs.symlinkSync(H('.claude', '.credentials.json'), path.join(EVIL, 'creds.json'));
mk(path.join(EVIL, 'references'));
fs.symlinkSync(H('Documents', 'Projects', 'sibling-app', '.env'), path.join(EVIL, 'references', 'notes.md'));
// …and a link to a whole directory, so a traversal cannot come in one level up.
fs.symlinkSync(H('Documents', 'Projects', 'sibling-app'), path.join(EVIL, 'sibling'));

// Duplicates: two byte-identical bundles plus one that differs only in a script.
const DUP_MD = skillMd('Decision', 'how to decide');
const DUP_SH = '#!/bin/sh\necho decide\n';
for (const base of [H('Documents', 'Projects', 'p1', '.claude', 'skills', 'decision'),
                    H('Documents', 'Garman-Homes', 'g1', 'wt-a', '.claude', 'skills', 'decision')]) {
  put(path.join(base, 'SKILL.md'), DUP_MD);
  put(path.join(base, 'scripts', 'run.sh'), DUP_SH, 0o755);
}
const VARIANT = H('Documents', 'Garman-Homes', 'g1', 'wt-b', '.claude', 'skills', 'decision');
put(path.join(VARIANT, 'SKILL.md'), DUP_MD);
put(path.join(VARIANT, 'scripts', 'run.sh'), '#!/bin/sh\necho decide DIFFERENTLY\n', 0o755);

// A Garman-Homes file for the "existing routes did not widen" assertion.
put(H('Documents', 'Garman-Homes', 'g1', 'notes.md'), 'client notes\n');

// --- Grade fixtures (C1, C2, C4, C6) -----------------------------------------
// C1: a dot-prefixed directory inside a skills root is a real skill container
// (~/.codex/skills/.system/*); VCS and cache directories are not.
put(H('.codex', 'skills', '.system', 'sys-skill', 'SKILL.md'), skillMd('Sys Skill', 'ships with codex'));
put(H('.claude', 'skills', '.git', 'not-a-skill', 'SKILL.md'), skillMd('Git Ghost', 'inside .git'));
put(H('.claude', 'skills', '.cache', 'cached', 'SKILL.md'), skillMd('Cache Ghost', 'inside .cache'));

// C2: bundles the old `rel \0 bytes \0` hash could not tell apart. File `a`
// holding `x\0b\0y` versus files a=x and b=y; and a script that differs only
// in its executable bit.
put(H('Documents', 'Projects', 'hash-a', '.claude', 'skills', 'collide', 'SKILL.md'), skillMd('Collide', 'same prose'));
put(H('Documents', 'Projects', 'hash-a', '.claude', 'skills', 'collide', 'a'), 'x\0b\0y');
put(H('Documents', 'Projects', 'hash-b', '.claude', 'skills', 'collide', 'SKILL.md'), skillMd('Collide', 'same prose'));
put(H('Documents', 'Projects', 'hash-b', '.claude', 'skills', 'collide', 'a'), 'x');
put(H('Documents', 'Projects', 'hash-b', '.claude', 'skills', 'collide', 'b'), 'y');
for (const [proj, mode] of [['mode-x', 0o755], ['mode-r', 0o644]]) {
  const f = H('Documents', 'Projects', proj, '.claude', 'skills', 'modal', 'run.sh');
  put(H('Documents', 'Projects', proj, '.claude', 'skills', 'modal', 'SKILL.md'), skillMd('Modal', 'same bytes'));
  put(f, '#!/bin/sh\necho same\n');
  fs.chmodSync(f, mode);
}

// C4: a file 20 directories down and an empty directory are part of the
// bundle; a bundle 33 directories deep is refused whole.
const dirs = (n) => Array.from({ length: n }, (_, i) => `d${i}`);
const DEEP_SKILL = H('.claude', 'skills', 'deep-tree');
put(path.join(DEEP_SKILL, 'SKILL.md'), skillMd('Deep Tree', 'has a very deep file'));
put(path.join(DEEP_SKILL, ...dirs(20), 'buried.md'), 'buried\n');
mk(path.join(DEEP_SKILL, 'empty-dir'));
const TOO_DEEP = H('.claude', 'skills', 'too-deep');
put(path.join(TOO_DEEP, 'SKILL.md'), skillMd('Too Deep', 'past the limit'));
put(path.join(TOO_DEEP, ...dirs(33), 'x.md'), 'x\n');
// C2: two bundles that differ ONLY in a companion ten directories down.
for (const [proj, body] of [['deep-a', 'one'], ['deep-b', 'two']]) {
  const d = H('Documents', 'Projects', proj, '.claude', 'skills', 'deepdiff');
  put(path.join(d, 'SKILL.md'), skillMd('Deep Diff', 'same prose'));
  put(path.join(d, ...dirs(10), 'buried.md'), `${body}\n`);
}

// C2/C4: two bundles that differ ONLY inside a directory nobody can list.
// Skipping it would hash both as SKILL.md alone and collapse them.
const LOCKED = [];
for (const [proj, body] of [['locked-a', 'one'], ['locked-b', 'two']]) {
  const d = H('Documents', 'Projects', proj, '.claude', 'skills', 'lockedpair');
  put(path.join(d, 'SKILL.md'), skillMd('Locked Pair', 'same prose'));
  put(path.join(d, 'locked', 'inside.md'), `${body}\n`);
  fs.chmodSync(path.join(d, 'locked'), 0o000);
  LOCKED.push(path.join(d, 'locked'));
}

// C6 / P1: a project whose `.claude/skills` ROOT is a link out of the skill
// roots, and one whose root links to a directory inside them.
const ROOT_LINK_MARK = 'MARKER-ROOT-LINK-OUTSIDE-5e0d';
put(H('outside-skills', 'leak', 'SKILL.md'), skillMd('Leak', ROOT_LINK_MARK));
put(H('outside-skills', 'leak', 'secret.md'), `${ROOT_LINK_MARK}\n`);
mk(H('Documents', 'Projects', 'p-link', '.claude'));
fs.symlinkSync(H('outside-skills'), H('Documents', 'Projects', 'p-link', '.claude', 'skills'));
put(H('Documents', 'Projects', 'shared-lib', 'skills', 'shared-one', 'SKILL.md'), skillMd('Shared One', 'via a linked root'));
mk(H('Documents', 'Projects', 'p-shared', '.claude'));
fs.symlinkSync(H('Documents', 'Projects', 'shared-lib', 'skills'), H('Documents', 'Projects', 'p-shared', '.claude', 'skills'));

// C6 / P1: the intermediate-directory swap. `sub` is a real directory until
// the fs double below replaces it with a link to OUTSIDE mid-read.
const SWAP_MARK = 'MARKER-OUTSIDE-SKILL-SENTINEL-c41a';
const SWAPPER = H('.claude', 'skills', 'swapper');
put(path.join(SWAPPER, 'SKILL.md'), skillMd('Swapper', 'target of the swap probe'));
put(path.join(SWAPPER, 'sub', 'doc.md'), 'INSIDE\n');
put(H('outside-dir', 'doc.md'), `${SWAP_MARK}\n`);

// C10: a file whose real size is past the budget handed to the reader.
put(H('.claude', 'skills', 'grower', 'SKILL.md'), skillMd('Grower', 'reads are capped'));
put(H('.claude', 'skills', 'grower', 'big.txt'), 'x'.repeat(24));

// --- discovery ---------------------------------------------------------------
const { listSkills, readInSkill, readTextInSkill, bundleHash, listSkillFiles, toPublic, resolveSkills } =
  await import('../lib/skills.js');
// Phase 5 hung a usage signal off the rows the route returns. The two
// route-equals-library assertions below still compare the FULL payload — what
// changed is that the expectation is now composed the same way the route
// composes it, so an extra field the route invented would still fail them.
const { readSkillUsage, attachUsage } = await import('../lib/skill-usage.js');
const routeRows = async () => attachUsage(listSkills().map(toPublic), await readSkillUsage());

const rows = listSkills();
const resolveSkillsFor = (id) => resolveSkills([id]).get(id);
const find = (name, source) => rows.find((r) => r.name === name && (!source || r.source === source));

{
  ok('discovery returns without throwing on a tree containing a dangling symlink', Array.isArray(rows));
  ok('a plain global skill is found', Boolean(find('alpha', 'global-claude')));
  ok('…labelled by source', find('alpha').source === 'global-claude', find('alpha')?.source);
  ok('…with its companion file in the bundle',
     find('alpha').files.map((f) => f.rel).join(',') === 'SKILL.md,scripts/run.sh',
     JSON.stringify(find('alpha').files.map((f) => f.rel)));
  ok('displayName comes from SKILL.md frontmatter', find('alpha').displayName === 'Alpha Skill',
     find('alpha').displayName);

  const deepOne = find('deep-one');
  ok('a skill four levels down (synced/<uuid>/…) is discovered', Boolean(deepOne));
  ok('…and is named from frontmatter, not the uuid folder',
     deepOne && deepOne.displayName === 'Deep One' && !deepOne.displayName.includes(SYNCED_UUID),
     deepOne?.displayName);

  const projectRow = find('decision', 'project');
  ok('a project-scoped skill under ~/Documents/Projects is found', Boolean(projectRow));
  ok('a Garman-Homes skill is found',
     rows.some((r) => r.source === 'garman-homes' && r.name === 'decision'));

  ok('ids are opaque 12-hex, not paths',
     rows.every((r) => /^[0-9a-f]{12}$/.test(r.id)), JSON.stringify(rows.map((r) => r.id).slice(0, 3)));
  ok('ids are unique per distinct bundle', new Set(rows.map((r) => r.id)).size === rows.length);
  ok('the same tree scanned twice yields the same ids',
     listSkills().map((r) => r.id).join(',') === rows.map((r) => r.id).join(','));
}

// --- broken entries ----------------------------------------------------------
{
  const dangling = find('dangling');
  ok('a dangling symlink becomes a row, not an exception', Boolean(dangling));
  ok('…flagged broken with a reason',
     dangling && dangling.broken === true && /missing/.test(dangling.reason || ''), dangling?.reason);
  ok('…and carries no files to export', dangling && dangling.files.length === 0);

  const linked = find('find-skills');
  ok('a skill directory that is ITSELF a symlink is allowed at the root',
     Boolean(linked) && linked.broken === false, JSON.stringify(linked && { b: linked.broken, r: linked.reason }));
  ok('…and resolves to its real directory as the containment boundary',
     linked && linked.dir === fs.realpathSync(H('.agents', 'skills', 'find-skills')), linked?.dir);
}

// --- containment: four injection tests, one per read path --------------------
const MARKS = [SSH_MARK, CRED_MARK, ENV_MARK];
const leaks = (s) => MARKS.filter((m) => String(s).includes(m));

{
  // 1. DISCOVERY. The planted links must not appear as bundle files at all.
  const evil = find('evil');
  ok('the injection fixture is discovered as an ordinary skill', Boolean(evil) && evil.broken === false);
  const rels = evil.files.map((f) => f.rel);
  ok('discovery lists only the real files',
     rels.join(',') === 'SKILL.md,honest.md', JSON.stringify(rels));
  ok('no planted symlink reached the bundle',
     !rels.some((r) => /stolen-key|creds|notes\.md|sibling/.test(r)), JSON.stringify(rels));
  ok('the refused names are reported rather than silently dropped',
     evil.excluded.length >= 3 && evil.excluded.every((x) => x.reason === 'symlink' || x.reason === 'protected'),
     JSON.stringify(evil.excluded));
  ok('no secret byte appears anywhere in the discovery output',
     leaks(JSON.stringify(rows)).length === 0, leaks(JSON.stringify(rows)).join(','));
  ok('the symlinked directory was not walked into either',
     !rels.some((r) => r.startsWith('sibling/')), JSON.stringify(rels));
}

{
  // 2. HASH. Proven by mutation: if the hash moves when a link TARGET changes,
  //    the target's bytes were being read into it.
  const evil = find('evil');
  const before = bundleHash(evil.dir, listSkillFiles(evil.dir).files);
  fs.writeFileSync(H('.ssh', 'id_rsa'), `${SSH_MARK}-MUTATED\n`);
  fs.writeFileSync(H('Documents', 'Projects', 'sibling-app', '.env'), `SECRET=${ENV_MARK}-MUTATED\n`);
  const after = bundleHash(evil.dir, listSkillFiles(evil.dir).files);
  ok('the bundle hash does not move when a linked-to secret changes', before === after,
     `${before.slice(0, 12)} -> ${after.slice(0, 12)}`);
  // Negative control: a real bundle file DOES move it, so the check above is
  // not passing merely because hashing is inert.
  fs.writeFileSync(path.join(evil.dir, 'honest.md'), 'changed\n');
  ok('…but a real bundle file does move it',
     bundleHash(evil.dir, listSkillFiles(evil.dir).files) !== after);
  fs.writeFileSync(path.join(evil.dir, 'honest.md'), 'nothing to see\n');
}

{
  // 3. FRONTMATTER. The parse path reads text; it must refuse the same names.
  const evil = find('evil');
  for (const rel of ['stolen-key.md', 'creds.json', 'references/notes.md', 'sibling/.env']) {
    let threw = null, got = null;
    try { got = readTextInSkill(evil.dir, rel); } catch (e) { threw = e; }
    ok(`frontmatter/text read refuses ${rel}`, threw !== null && got === null, got ? leaks(got).join(',') : '');
    ok(`…and returned no secret for ${rel}`, got === null || leaks(got).length === 0);
  }
  ok('the parsed description of the injected skill is its own',
     find('evil').description === 'looks ordinary', find('evil').description);
}

{
  // 4. THE SHARED READER, directly. Everything else funnels through this, so
  //    it is asserted on its own rather than only through its callers.
  const evil = find('evil');
  const attempts = [
    'stolen-key.md',
    'creds.json',
    'references/notes.md',
    'sibling/.env',
    '../.credentials.json',
    '../../../.ssh/id_rsa',
    H('.ssh', 'id_rsa'),
    '/etc/passwd',
    'SKILL.md/../../../.ssh/id_rsa',
  ];
  for (const rel of attempts) {
    let buf = null, threw = null;
    try { buf = readInSkill(evil.dir, rel); } catch (e) { threw = e; }
    ok(`readInSkill refuses ${JSON.stringify(rel).slice(0, 46)}`, threw !== null && buf === null,
       buf ? leaks(buf.toString('utf8')).join(',') : '');
  }
  ok('readInSkill still reads a legitimate file in the skill',
     readTextInSkill(evil.dir, 'SKILL.md').includes('Evil'));
  ok('the real secrets are still on disk and readable outside the module — the ' +
     'refusals above are containment, not a missing fixture',
     fs.readFileSync(H('.ssh', 'id_rsa'), 'utf8').includes(SSH_MARK));
}

// --- duplicate collapse ------------------------------------------------------
{
  const decisions = rows.filter((r) => r.name === 'decision');
  ok('three identically-named skills collapse to 2 rows', decisions.length === 2,
     JSON.stringify(decisions.map((d) => ({ s: d.source, a: d.aliases.length }))));
  const canonical = decisions.find((d) => d.aliases.length === 1);
  const variant = decisions.find((d) => d.aliases.length === 0);
  ok('the identical pair collapses into one row carrying one alias', Boolean(canonical));
  ok('…and the canonical copy is the project one, not a worktree copy',
     canonical && canonical.source === 'project', canonical?.source);
  ok('…with the alias naming the other directory',
     canonical && canonical.aliases[0].dir.includes('wt-a'), JSON.stringify(canonical?.aliases));
  ok('a bundle that differs only in scripts/run.sh stays a separate row', Boolean(variant));
  ok('…and it is the wt-b copy', variant && variant.dir.includes('wt-b'), variant?.dir);
  ok('collapsed rows are not the same id', canonical && variant && canonical.id !== variant.id);
}

// --- C1: dot-prefixed skill containers ---------------------------------------
{
  const sys = find('sys-skill', 'global-codex');
  ok('C1 a skill under ~/.codex/skills/.system is discovered', Boolean(sys) && sys.broken === false,
     JSON.stringify(rows.filter((r) => r.source === 'global-codex').map((r) => r.name)));
  ok('C1 …named from its frontmatter', sys?.displayName === 'Sys Skill', sys?.displayName);
  ok('C1 VCS and cache directories are still skipped',
     !find('not-a-skill') && !find('cached'), JSON.stringify(rows.map((r) => r.name)));
}

// --- C2: the bundle hash is injective ----------------------------------------
{
  const collide = rows.filter((r) => r.name === 'collide');
  ok('C2 file a=`x\\0b\\0y` and files a=x,b=y are two rows, not one',
     collide.length === 2 && collide.every((r) => r.aliases.length === 0),
     JSON.stringify(collide.map((r) => ({ f: r.files.map((f) => f.rel), a: r.aliases.length }))));
  ok('C2 …because their bundle hashes differ', collide.length === 2 && collide[0].hash !== collide[1].hash);
  const modal = rows.filter((r) => r.name === 'modal');
  ok('C2 a script differing only in its executable bit is a different bundle',
     modal.length === 2 && modal[0].hash !== modal[1].hash,
     JSON.stringify(modal.map((r) => r.files.map((f) => f.mode.toString(8)))));
}

// --- C4: bundles are complete, or refused whole ---------------------------------
{
  const deep = find('deep-tree');
  const buried = `${dirs(20).join('/')}/buried.md`;
  ok('C4 a file 20 directories down is part of the bundle',
     deep && !deep.broken && deep.files.some((f) => f.rel === buried), JSON.stringify(deep?.files.map((f) => f.rel)));
  ok('C4 an empty directory is part of the bundle, not an exclusion',
     deep?.emptyDirs.map((d) => d.rel).join(',') === 'empty-dir/' && deep.excluded.length === 0,
     JSON.stringify({ e: deep?.emptyDirs, x: deep?.excluded }));
  ok('C4 …and it survives the public mapping', toPublic(deep).emptyDirs.join(',') === 'empty-dir/');
  const tooDeep = find('too-deep');
  ok('C4 a bundle 33 directories deep is refused whole: broken, with the reason',
     tooDeep?.broken === true && /deeper than the 32-level limit.*refusing to export it partially/.test(tooDeep.reason),
     JSON.stringify(tooDeep && { b: tooDeep.broken, r: tooDeep.reason }));
  ok('C4 …and carries no files that could be exported partially', tooDeep?.files.length === 0);
  const locked = rows.filter((r) => r.name === 'lockedpair');
  ok('C2 two bundles differing only inside an unreadable directory are never collapsed',
     locked.length === 2 && locked.every((r) => r.aliases.length === 0),
     JSON.stringify(locked.map((r) => ({ b: r.broken, a: r.aliases.length }))));
  ok('C4 …each is a broken, unexportable row that says which directory could not be read',
     locked.every((r) => r.broken === true && r.files.length === 0
       && /part of the bundle could not be read \(at locked\/ \(EACCES\)\); refusing to hash or export it partially/.test(r.reason)),
     JSON.stringify(locked.map((r) => r.reason)));
  ok('C4 …and the export lookup refuses it the same way',
     locked.every((r) => (() => { const got = resolveSkillsFor(r.id); return got?.broken === true && /could not be read/.test(got.reason); })()));
  const deepdiff = rows.filter((r) => r.name === 'deepdiff');
  ok('C2 bundles differing only in a companion 10 directories down are two rows',
     deepdiff.length === 2 && deepdiff.every((r) => r.aliases.length === 0 && r.files.length === 2),
     JSON.stringify(deepdiff.map((r) => ({ a: r.aliases.length, f: r.files.length }))));
}

// --- C6 / P1: containment is anchored to the descriptor ------------------------
{
  // Root links: the one pointing outside the skill roots yields no exportable
  // row and none of its bytes; the one pointing inside them still works.
  ok('C6 a skills ROOT linked outside the skill roots yields no exportable row',
     !rows.some((r) => !r.broken && (r.name === 'leak' || fs.realpathSync(r.dir).startsWith(H('outside-skills')))),
     JSON.stringify(rows.filter((r) => r.name === 'leak').map((r) => r.dir)));
  ok('C6 …it is reported as a broken row with a reason',
     rows.some((r) => r.broken && /skills root is a link that points outside the skill roots/.test(r.reason)),
     JSON.stringify(rows.filter((r) => r.broken).map((r) => r.reason)));
  ok('C6 …and none of its bytes reached the listing', !JSON.stringify(rows).includes(ROOT_LINK_MARK));
  ok('C6 a skills root linked INSIDE the skill roots is still followed',
     Boolean(find('shared-one', 'project')) && !find('shared-one').broken,
     JSON.stringify(find('shared-one')));
}
{
  // The id the leaked skill WOULD have had, had discovery followed the link.
  const { resolveSkills, skillId } = await import('../lib/skills.js');
  const leakId = skillId(fs.realpathSync(H('outside-skills', 'leak')));
  ok('C6 the export lookup cannot resolve the outside-linked skill by id either',
     !resolveSkills([leakId]).has(leakId), leakId);
}
{
  const sub = path.join(SWAPPER, 'sub');
  const swapIn = () => { fs.renameSync(sub, `${sub}.bak`); fs.symlinkSync(H('outside-dir'), sub); };
  const swapBack = () => { fs.unlinkSync(sub); fs.renameSync(`${sub}.bak`, sub); };
  const isSwapped = () => fs.lstatSync(sub).isSymbolicLink();

  // An fs whose Nth call is preceded by the swap. 'stay' leaves the link in
  // place for the rest of the read; 'flip' restores the real directory right
  // after that one call — the window a check-then-open reader loses.
  const swapping = (trigger, mode) => {
    let n = 0;
    return new Proxy(fs, {
      get(t, k) {
        const v = t[k];
        if (typeof v !== 'function') return v;
        return (...args) => {
          const now = ++n;
          if (now === trigger) swapIn();
          try { return v.apply(t, args); }
          finally { if (now === trigger && mode === 'flip') swapBack(); }
        };
      },
    });
  };
  const counting = () => {
    const c = { n: 0 };
    c.io = new Proxy(fs, { get(t, k) { const v = t[k]; return typeof v === 'function' ? (...a) => { c.n++; return v.apply(t, a); } : v; } });
    return c;
  };

  // The pre-fix reader, reproduced verbatim in shape: no-follow walk, lstat,
  // open, compare fstat to that lstat. It is the negative control that proves
  // the double reproduces the attack rather than being inert.
  const oldReader = (io) => {
    let cur = SWAPPER;
    for (const seg of 'sub/doc.md'.split('/')) {
      cur = path.join(cur, seg);
      if (io.lstatSync(cur).isSymbolicLink()) throw new Error('symlink');
    }
    const before = io.lstatSync(cur);
    const fd = io.openSync(cur, 'r');
    try {
      const st = io.fstatSync(fd);
      if (st.ino !== before.ino || st.dev !== before.dev) throw new Error('changed');
      const buf = Buffer.alloc(st.size);
      io.readSync(fd, buf, 0, st.size, 0);
      return buf;
    } finally { io.closeSync(fd); }
  };

  const clean = counting();
  const plain = readInSkill(SWAPPER, 'sub/doc.md', { io: clean.io });
  ok('C6 swap probe: the undisturbed read returns the inside file', plain.toString() === 'INSIDE\n');

  let oldLeaked = 0;
  for (let k = 1; k <= 12; k++) {
    for (const mode of ['stay', 'flip']) {
      let buf = null;
      try { buf = oldReader(swapping(k, mode)); } catch {}
      if (isSwapped()) swapBack();
      if (buf && buf.toString().includes(SWAP_MARK)) oldLeaked++;
    }
  }
  ok('C6 negative control: the pre-fix check-then-open reader DOES leak under this swap',
     oldLeaked > 0, `${oldLeaked} leaks`);

  let leaked = 0, refused = 0, insides = 0, tried = 0;
  for (let k = 1; k <= clean.n + 1; k++) {
    for (const mode of ['stay', 'flip']) {
      tried++;
      let buf = null;
      try { buf = readInSkill(SWAPPER, 'sub/doc.md', { io: swapping(k, mode) }); }
      catch (e) { if (e.contained) refused++; else throw e; }
      if (isSwapped()) swapBack();
      if (buf && buf.toString().includes(SWAP_MARK)) leaked++;
      else if (buf && buf.toString() === 'INSIDE\n') insides++;
    }
  }
  ok(`C6 an intermediate-directory swap before ANY of the reader's ${clean.n} fs calls leaks no outside byte`,
     leaked === 0, `${leaked} of ${tried} attempts leaked`);
  ok('C6 …every attempt either refused or read the real inside file',
     refused + insides === tried && refused > 0, `${refused} refused, ${insides} inside, ${tried} tried`);

  const { buildSkillsZip } = await import('../lib/zip.js');
  const { spawnSync } = await import('node:child_process');
  const swapRow = rows.find((r) => r.name === 'swapper');
  let zipLeaks = 0, zipsBuilt = 0;
  const zdir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-swap-zip-'));
  for (let k = 1; k <= clean.n + 1; k++) {
    for (const mode of ['stay', 'flip']) {
      // Only the sub/doc.md read is attacked, at each of its fs calls in turn.
      const read = (d, r, o) => readInSkill(d, r, r === 'sub/doc.md' ? { ...o, io: swapping(k, mode) } : o);
      let buf = null;
      try { buf = buildSkillsZip([swapRow, find('alpha')], { read }); } catch {}
      if (isSwapped()) swapBack();
      if (!buf) continue;
      zipsBuilt++;
      const zp = path.join(zdir, 'swap.zip');
      fs.writeFileSync(zp, buf);
      const u = spawnSync('unzip', ['-p', zp], { encoding: 'latin1' });
      if ((u.stdout || '').includes(SWAP_MARK)) zipLeaks++;
    }
  }
  fs.rmSync(zdir, { recursive: true, force: true });
  ok('C6 …and through buildSkillsZip: no archive contains the outside sentinel',
     zipLeaks === 0 && zipsBuilt > 0, `${zipLeaks} leaking archives of ${zipsBuilt} built`);
  ok('C6 the swap fixture is back in its original shape', !isSwapped() && fs.existsSync(path.join(SWAPPER, 'sub', 'doc.md')));

  // The deny check sees the REAL path. An fs whose realpath reports the
  // credentials file stands in for any resolution that lands on one.
  const lying = new Proxy(fs, {
    get(t, k) {
      if (k === 'realpathSync') return () => H('.claude', '.credentials.json');
      const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  let threw = null;
  try { readInSkill(SWAPPER, 'sub/doc.md', { io: lying }); } catch (e) { threw = e; }
  ok('C6 a read whose REALPATH is protected is refused BY THE DENY CHECK (lexical path is not protected)',
     threw?.status === 403 && threw.reason === 'protected' && /protected path/.test(threw.message),
     String(threw?.message));
  // The contrast: the same lie pointing at an unprotected outside file is
  // refused by the containment comparison instead, so the line above is
  // the deny check and not the equality check under another name.
  const elsewhere = new Proxy(fs, {
    get(t, k) {
      if (k === 'realpathSync') return () => H('outside-dir', 'doc.md');
      const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  threw = null;
  try { readInSkill(SWAPPER, 'sub/doc.md', { io: elsewhere }); } catch (e) { threw = e; }
  ok('C6 …while an unprotected outside realpath is refused by containment, not deny',
     threw?.status === 403 && threw.reason === undefined && /resolves outside the skill/.test(threw.message),
     String(threw?.message));
}

// --- C10: the reader stops at its budget --------------------------------------
{
  const grower = find('grower');
  let bytes = 0;
  const io = new Proxy(fs, {
    get(t, k) {
      const v = t[k];
      if (k === 'readSync') return (...a) => { const n = v.apply(t, a); bytes += n; return n; };
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  let threw = null;
  try { readInSkill(grower.dir, 'big.txt', { io, budget: { remaining: 4 } }); } catch (e) { threw = e; }
  ok('C10 a 24-byte file read against a 4-byte budget is refused with 413', threw?.status === 413, String(threw?.message));
  ok('C10 …after buffering at most budget + 1 bytes', bytes <= 5, `${bytes} bytes read`);
  const budget = { remaining: 100 };
  ok('C10 under budget it reads, and the budget is spent by what was read',
     readInSkill(grower.dir, 'big.txt', { budget }).length === 24 && budget.remaining === 76,
     JSON.stringify(budget));
}

// --- the HTTP surface --------------------------------------------------------
const { createApp } = await import('../server.js');
const { server } = createApp();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const B = `http://localhost:${server.address().port}`;
const get = (p) => fetch(B + p).then(async (r) => [r.status, await r.json()]);

{
  const [status, body] = await get('/api/skills');
  ok('GET /api/skills is 200', status === 200, JSON.stringify(body).slice(0, 120));
  ok('…and returns the rows', Array.isArray(body.skills) && body.skills.length === rows.length,
     `${body.skills?.length} vs ${rows.length}`);
  ok('…each labelled by source',
     body.skills.every((s) => ['global-claude', 'global-codex', 'global-agents', 'project', 'garman-homes'].includes(s.source)),
     JSON.stringify([...new Set(body.skills.map((s) => s.source))]));

  const text = JSON.stringify(body);
  ok('no row carries a `dir`', body.skills.every((s) => !('dir' in s)));
  ok('no file carries an `abs`', body.skills.every((s) => s.files.every((f) => !('abs' in f))));
  ok('no filesystem path appears in the response at all',
     !text.includes(fakeHome) && !text.includes(realHome) && !/"\/[A-Za-z]/.test(text),
     text.slice(0, 200));
  ok('no secret appears in the response', leaks(text).length === 0, leaks(text).join(','));
  ok('the collapsed row reports its alias as a count, not a path',
     body.skills.some((s) => s.aliasCount === 1 && Array.isArray(s.aliasSources)),
     JSON.stringify(body.skills.filter((s) => s.aliasCount).map((s) => ({ n: s.name, c: s.aliasCount }))));
  ok('the broken row survives the public mapping',
     body.skills.some((s) => s.name === 'dangling' && s.broken === true && typeof s.reason === 'string'));
  ok('toPublic is what the route returns',
     JSON.stringify(body.skills) === JSON.stringify(await routeRows()));
}

// --- the skills roots did NOT widen any existing route -----------------------
{
  // The criterion that proves this feature stayed inside its own lane.
  // ~/Documents/Garman-Homes is readable by discovery and by nothing else.
  const enc = (p) => encodeURIComponent(p);
  const garman = H('Documents', 'Garman-Homes', 'g1', 'notes.md');
  ok('the Garman-Homes fixture really exists', fs.existsSync(garman));
  const [s1, j1] = await get(`/api/file?path=${enc(garman)}`);
  ok('GET /api/file still 403s on a Garman-Homes path', s1 === 403, `${s1} ${JSON.stringify(j1)}`);
  ok('…and returned no content', !('content' in j1));

  const [s2] = await get(`/api/file?path=${enc(H('Documents', 'Garman-Homes'))}`);
  ok('the Garman-Homes root itself is still 403', s2 === 403, String(s2));

  const [s3, j3] = await get(`/api/file?path=${enc(H('.claude', 'skills', 'alpha', 'SKILL.md'))}`);
  ok('a genuinely safe path still reads, so the 403s are not a blanket failure',
     s3 === 200 && j3.content.includes('Alpha Skill'), String(s3));

  const [s4] = await get(`/api/file?path=${enc(H('.claude', '.credentials.json'))}`);
  ok('credentials are still refused', s4 === 403, String(s4));
}

// --- the new endpoint accepts no path ----------------------------------------
{
  const [s, body] = await get(`/api/skills?path=${encodeURIComponent(H('.ssh', 'id_rsa'))}&dir=/etc`);
  ok('/api/skills ignores every query parameter', s === 200 && Array.isArray(body.skills));
  ok('…and a path handed to it changes nothing',
     JSON.stringify(body.skills) === JSON.stringify(await routeRows()));
  ok('…and leaks nothing', leaks(JSON.stringify(body)).length === 0);
}

// --- C14: the real-home tripwire bites on what it claims ----------------------
{
  // Run against a scratch HOME so the scenarios can mutate it. Each one is a
  // change the old name+size+mtime print could not see, or a churn it must
  // not cry wolf about.
  const { spawnSync } = await import('node:child_process');
  const TRIP = new URL('./real-home.mjs', import.meta.url).pathname;
  const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-trip-')));
  const tput = (rel, body) => { const f = path.join(T, rel); mk(path.dirname(f)); fs.writeFileSync(f, body); return f; };
  tput('.claude/skills/s1/deep/notes.md', 'AAAA');
  tput('.claude/history.jsonl', '{}\n');
  tput('.codex/config.toml', 'model = "x"\n');
  tput('.agent-config-studio/seats.json', '{}');
  tput('.zshenv', 'export A=1\n');
  tput('.config/worktree/repos/acs', 'trunk=/x\n');
  tput('.codex-seats/seat-a/config.toml', 'x');
  tput('Documents/Projects/app/.claude/skills/p1/ref/x.md', 'BBBB');
  tput('Documents/Garman-Homes/g/.claude/skills/g1/SKILL.md', 'CCCC');
  const snap = path.join(T, '..', `${path.basename(T)}.snap`);
  const run = (cmd) => spawnSync(process.execPath, [TRIP, cmd, snap], { env: { ...process.env, HOME: T }, encoding: 'utf8' });
  const scenario = (label, mutate, wantFail, undo) => {
    run('save');
    mutate();
    const r = run('check');
    ok(`C14 tripwire ${wantFail ? 'FAILS' : 'passes'} on ${label}`, (r.status !== 0) === wantFail, (r.stdout || '').trim().split('\n').slice(1, 4).join(' | '));
    undo?.();
    return r;
  };
  const sameShape = (f, body) => {
    const st = fs.statSync(f, { bigint: true });
    fs.writeFileSync(f, body);
    fs.utimesSync(f, Number(st.atimeNs) / 1e9, Number(st.mtimeNs) / 1e9);
  };
  const clean = scenario('an untouched tree', () => {}, false);
  ok('C14 …and its passing line says content is compared by sha256',
     /byte-identical \(sha256\)/.test(clean.stdout) && /entry names unchanged \(contents not compared\)/.test(clean.stdout), clean.stdout);
  const n1 = path.join(T, '.claude/skills/s1/deep/notes.md');
  scenario('a nested skill-file edit with the same size and mtime', () => sameShape(n1, 'ZZZZ'), true, () => sameShape(n1, 'AAAA'));
  const p1 = path.join(T, 'Documents/Projects/app/.claude/skills/p1/ref/x.md');
  scenario('a nested edit inside a project skill tree', () => sameShape(p1, 'ZZZZ'), true, () => sameShape(p1, 'BBBB'));
  const g1 = path.join(T, 'Documents/Garman-Homes/g/.claude/skills/g1/SKILL.md');
  scenario('a nested edit inside a Garman-Homes skill tree', () => sameShape(g1, 'ZZZZ'), true, () => sameShape(g1, 'CCCC'));
  const cfg = path.join(T, '.codex/config.toml');
  scenario('an in-place edit of a pinned file', () => sameShape(cfg, 'model = "y"\n'), true, () => sameShape(cfg, 'model = "x"\n'));
  scenario('a new entry name in a live home', () => tput('.codex/seat.json', '{}'), true, () => fs.rmSync(path.join(T, '.codex/seat.json')));
  scenario('SQLite -wal/-shm siblings and an atomic-write temp name appearing', () => {
    tput('.codex/logs_2.sqlite-wal', 'w'); tput('.codex/logs_2.sqlite-shm', 's'); tput('.claude/settings.json.tmp.123', 't');
  }, false, () => ['.codex/logs_2.sqlite-wal', '.codex/logs_2.sqlite-shm', '.claude/settings.json.tmp.123'].forEach((f) => fs.rmSync(path.join(T, f))));
  scenario('a live agent appending to an unpinned file in its home', () => fs.appendFileSync(path.join(T, '.claude/history.jsonl'), '{}\n'), false);
  // The ignore rule is two anchored suffix shapes, not a substring.
  scenario('a persistent name that merely CONTAINS .tmp (important.tmpbackup)',
    () => tput('.codex/important.tmpbackup', 'x'), true, () => fs.rmSync(path.join(T, '.codex/important.tmpbackup')));
  scenario('a persistent name that merely ENDS in -wal without being a database sibling (notes-wal)',
    () => tput('.grok/notes-wal', 'x'), true, () => fs.rmSync(path.join(T, '.grok/notes-wal')));
  scenario('an empty directory appearing under ~/.agent-config-studio',
    () => mk(path.join(T, '.agent-config-studio', 'empty')), true,
    () => fs.rmSync(path.join(T, '.agent-config-studio', 'empty'), { recursive: true }));
  tput('.grok/AGENTS.md', 'grok rules\n');
  const grokAgents = path.join(T, '.grok/AGENTS.md');
  scenario('an in-place edit of ~/.grok/AGENTS.md, which ACS lists and edits',
    () => sameShape(grokAgents, 'grok RULES\n'), true, () => sameShape(grokAgents, 'grok rules\n'));
  const zshenv = path.join(T, '.zshenv');
  scenario('an in-place edit of ~/.zshenv, which ACS appends to',
    () => sameShape(zshenv, 'export B=1\n'), true, () => sameShape(zshenv, 'export A=1\n'));
  const wtRepo = path.join(T, '.config/worktree/repos/acs');
  scenario('an in-place edit of a file under ~/.config/worktree',
    () => sameShape(wtRepo, 'trunk=/y\n'), true, () => sameShape(wtRepo, 'trunk=/x\n'));
  scenario('a new seat directory under ~/.codex-seats',
    () => mk(path.join(T, '.codex-seats', 'seat-b')), true, () => fs.rmSync(path.join(T, '.codex-seats', 'seat-b'), { recursive: true }));
  scenario('a new entry linked into an existing seat home',
    () => tput('.codex-seats/seat-a/AGENTS.md', 'x'), true, () => fs.rmSync(path.join(T, '.codex-seats/seat-a/AGENTS.md')));
  fs.rmSync(T, { recursive: true, force: true });
  fs.rmSync(snap, { force: true });
}

// --- the real directories were never touched ---------------------------------
server.close();
{
  assertRealHomesUnchanged(realBefore, ok);
}

for (const d of LOCKED) fs.chmodSync(d, 0o755);
fs.rmSync(fakeHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
