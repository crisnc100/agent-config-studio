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
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-homes.mjs';

const realHome = os.homedir();

/**
 * Tripwire on the real directories this feature can see.
 *
 * Content-hashing ~/Documents/Projects or ~/.claude/projects (1.1GB) on every
 * run is not affordable, so each root is fingerprinted by its entries' names,
 * sizes and mtimes — a directory's own mtime moves when a child is added or
 * removed, and a file's size and mtime move when it is written. The trees this
 * feature actually walks are fingerprinted recursively; the large ones at their
 * top level. Combined with the HOME assertion below (the code cannot address
 * the real home at all), this catches a write that escaped the redirection.
 */
/**
 * Two kinds of real root, checked two different ways — because fingerprinting a
 * LIVE agent home by mtime does not test this suite, it tests whether anything
 * else on the machine happened to tick a file while the suite ran.
 *
 * Measured, with nothing of ours running: ~/.codex/logs_2.sqlite-wal moved in 3
 * of 5 idle 3-second windows; then its checkpoint moved logs_2.sqlite; and a
 * running Claude Code session appends to ~/.claude/history.jsonl throughout.
 * Each fix by exemption produced the next false alarm, which is the signal that
 * the rule itself is wrong. A tripwire that cries wolf trains you to ignore it,
 * and this is the one tripwire that must never be ignored.
 *
 * So: the trees this feature actually WALKS are still fingerprinted exactly,
 * recursively, by name + size + mtime — those are skill directories, nothing
 * else writes them, and a stray write shows instantly. The two live harness
 * homes are checked on the invariant that is both stable and the one that
 * matters: the SET OF ENTRY NAMES. Anything this suite could do wrong to them —
 * creating a seat, writing a registry, dropping a file — adds or removes a
 * name. Their internal churn is someone else's process and is not evidence
 * about us. The HOME assertion above already proves this code cannot address
 * the real home at all; this is the second line, not the only one.
 */
/**
 * The names-only rule above cannot see an in-place write to a file that already
 * exists, so the handful of files inside those live homes that this app CAN
 * legitimately edit are additionally pinned byte-exactly. None of them is
 * touched by a background agent process — unlike the sqlite logs and
 * history.jsonl next to them — so they are stable enough to compare precisely,
 * and they are the ones where a silent edit would actually matter.
 */




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

// --- discovery ---------------------------------------------------------------
const { listSkills, readInSkill, readTextInSkill, bundleHash, listSkillFiles, toPublic } =
  await import('../lib/skills.js');
// Phase 5 hung a usage signal off the rows the route returns. The two
// route-equals-library assertions below still compare the FULL payload — what
// changed is that the expectation is now composed the same way the route
// composes it, so an extra field the route invented would still fail them.
const { readSkillUsage, attachUsage } = await import('../lib/skill-usage.js');
const routeRows = async () => attachUsage(listSkills().map(toPublic), await readSkillUsage());

const rows = listSkills();
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

// --- the real directories were never touched ---------------------------------
server.close();
{
  assertRealHomesUnchanged(realBefore, ok);
}

fs.rmSync(fakeHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
