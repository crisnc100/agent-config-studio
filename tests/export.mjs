/**
 * GET /api/skills/export — the download itself.
 *
 * HOME is redirected to a temp directory BEFORE anything is imported, because
 * lib/paths.js binds HOME at module load. Every fixture below — including the
 * "secrets" the injection tests try to steal — lives under that fake home; no
 * assertion here is ever pointed at a real credential file.
 *
 * The containment assertions in tests/skills.mjs cover discovery, hashing and
 * the shared reader. This file extends the same hostile fixture to the ONE
 * path that actually hands bytes to a browser, because a rule that holds
 * everywhere except the export is not a rule.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';

const realHome = os.homedir();

// The real-home tripwire (tests/real-home.mjs) says what it compares and how.
const realBefore = snapshotRealHomes();

// realpath'd: on macOS os.tmpdir() is /var/folders/… which is itself a symlink,
// and resolveSafe compares REAL paths against roots built from HOME.
const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-export-')));
process.env.HOME = fakeHome;
process.env.ACS_SUITE = 'offline';
delete process.env.CODEX_HOME;

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-export-work-'));

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\nskills/export');
ok('HOME is redirected away from the real one', os.homedir() === fakeHome && fakeHome !== realHome, os.homedir());

// --- fixtures ----------------------------------------------------------------
const H = (...p) => path.join(fakeHome, ...p);
const mk = (dir) => fs.mkdirSync(dir, { recursive: true });
const put = (file, body, mode) => { mk(path.dirname(file)); fs.writeFileSync(file, body, mode ? { mode } : undefined); };
const skillMd = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\nbody\n`;

const SSH_MARK = 'MARKER-SSH-PRIVATE-KEY-b3f1';
const CRED_MARK = 'MARKER-CLAUDE-CREDENTIALS-9a22';
const ENV_MARK = 'MARKER-SIBLING-PROJECT-ENV-71cd';
put(H('.ssh', 'id_rsa'), `${SSH_MARK}\n`);
put(H('.claude', '.credentials.json'), `{"t":"${CRED_MARK}"}\n`);
put(H('Documents', 'Projects', 'sibling-app', '.env'), `SECRET=${ENV_MARK}\n`);

// A plain skill with a companion file and an executable script.
put(H('.claude', 'skills', 'alpha', 'SKILL.md'), skillMd('Alpha Skill', 'does alpha things'));
put(H('.claude', 'skills', 'alpha', 'scripts', 'run.sh'), '#!/bin/sh\necho alpha\n', 0o755);

// A second ordinary skill, so a multi-selection has something to pair with.
put(H('.claude', 'skills', 'beta', 'SKILL.md'), skillMd('Beta', 'does beta things'));
put(H('.claude', 'skills', 'beta', 'notes.md'), 'beta notes\n');

// THE header-injection fixture, in two halves.
//
// NASTY_NAME is what contentDisposition is asserted against directly: a CR, an
// LF, a quote, a semicolon, a colon and non-ASCII — every character class that
// could end the quoted string, start another parameter, or split the header.
//
// ON_DISK_NAME is what a SKILL.md can actually carry: a frontmatter value is
// one line, so a raw CR/LF cannot reach the parser through it. That is
// asserted below with its own fixture rather than assumed, because "it cannot
// get here" is exactly the claim that stops being true later; the unit-level
// CR/LF case is defence in depth, and this one is the live path.
const NASTY_NAME = 'Sp"ooky\r\nSet-Cookie: pwned=1;semi;éè你好 Skill';
const ON_DISK_NAME = 'Sp"ooky;semi: colon éè你好 Skill';
put(H('.claude', 'skills', 'nasty', 'SKILL.md'),
    `---\nname: ${ON_DISK_NAME}\ndescription: hostile frontmatter\n---\n\nbody\n`);

// A SKILL.md that tries to smuggle a CR into the name it hands the header.
put(H('.claude', 'skills', 'crlf', 'SKILL.md'),
    '---\nname: Clean\rSet-Cookie: pwned=1\ndescription: tries a CR\n---\n\nbody\n');

// A name that reduces to a Windows device name once the unsafe characters go.
put(H('.claude', 'skills', 'device', 'SKILL.md'), skillMd('CON', 'a reserved name'));

// C3: 99 ASCII characters then an emoji. A code-unit slice to 100 cut the
// emoji between its surrogates and encodeURIComponent threw — a 500.
const EMOJI_NAME = `${'a'.repeat(99)}\u{1F600}`;
put(H('.claude', 'skills', 'emoji', 'SKILL.md'), skillMd(EMOJI_NAME, 'long name, astral tail'));

// One grapheme of unbounded size: `a` plus 10,000 combining accents. Counting
// graphemes let it through as a 60KB header.
const ZALGO_NAME = `a${'\u0301'.repeat(10000)}`;
put(H('.claude', 'skills', 'zalgo', 'SKILL.md'), skillMd(ZALGO_NAME, 'one enormous grapheme'));

// C4: a bundle 33 directories deep, refused whole.
put(H('.claude', 'skills', 'too-deep', ...Array.from({ length: 33 }, (_, i) => `d${i}`), 'x.md'), 'x\n');
put(H('.claude', 'skills', 'too-deep', 'SKILL.md'), skillMd('Too Deep', 'past the depth limit'));

// The injection fixture, identical to tests/skills.mjs: a real skill with
// links planted inside it, pointed at the three fake secrets above.
const EVIL = H('.claude', 'skills', 'evil');
put(path.join(EVIL, 'SKILL.md'), skillMd('Evil', 'looks ordinary'));
put(path.join(EVIL, 'honest.md'), 'nothing to see\n');
fs.symlinkSync(H('.ssh', 'id_rsa'), path.join(EVIL, 'stolen-key.md'));
fs.symlinkSync(H('.claude', '.credentials.json'), path.join(EVIL, 'creds.json'));
mk(path.join(EVIL, 'references'));
fs.symlinkSync(H('Documents', 'Projects', 'sibling-app', '.env'), path.join(EVIL, 'references', 'notes.md'));
fs.symlinkSync(H('Documents', 'Projects', 'sibling-app'), path.join(EVIL, 'sibling'));

// A dangling symlink: discovery makes this a broken row with no files.
fs.symlinkSync(H('.agents', 'skills', 'does-not-exist'), H('.claude', 'skills', 'dangling'));

const MARKS = [SSH_MARK, CRED_MARK, ENV_MARK];
const leaks = (s) => MARKS.filter((m) => String(s).includes(m));

// --- the unit under the header ----------------------------------------------
const { contentDisposition, cleanName, asciiName, assertSelectionFits } =
  await import('../lib/download.js');

{
  const cd = contentDisposition(NASTY_NAME, '.md');
  ok('a hostile frontmatter name produces a single-line header', !/[\r\n]/.test(cd), JSON.stringify(cd));
  ok('…with exactly two quotes, so the quoted-string cannot be closed early',
     (cd.match(/"/g) || []).length === 2, JSON.stringify(cd));
  // `Set-Cookie` surviving as LITERAL TEXT inside the quoted filename is
  // harmless — what would forge a header is a separator escaping the quotes.
  ok('…and the quoted filename contains no header separator',
     !/[;:\r\n]/.test(cd.split('"')[1] || ''), JSON.stringify(cd.split('"')[1]));
  ok('…and the ASCII filename carries no quote, semicolon or non-ASCII',
     /^attachment; filename="[A-Za-z0-9._-]+"/.test(cd), JSON.stringify(cd));
  ok('…and RFC 5987 filename* is present for the non-ASCII characters',
     /; filename\*=UTF-8''/.test(cd), JSON.stringify(cd));
  const star = cd.split("filename*=UTF-8''")[1];
  ok('…whose ext-value is percent-encoded, with no raw CR/LF, quote or semicolon',
     star && !/[\r\n";]/.test(star) && /%C3%A9/.test(star), String(star));
  ok('…and percent-decodes back to the cleaned name plus the extension',
     decodeURIComponent(star) === `${cleanName(NASTY_NAME)}.md`,
     `${decodeURIComponent(star || '')} vs ${cleanName(NASTY_NAME)}.md`);
  ok('cleanName strips CR and LF entirely rather than encoding them',
     !/[\r\n]/.test(cleanName(NASTY_NAME)), JSON.stringify(cleanName(NASTY_NAME)));
}
{
  ok('an already-safe name needs no filename*',
     contentDisposition('alpha-skill', '.md') === 'attachment; filename="alpha-skill.md"',
     contentDisposition('alpha-skill', '.md'));
  ok('a name that only lost its spaces still carries the exact one in filename*',
     contentDisposition('Alpha Skill', '.md')
       === 'attachment; filename="Alpha-Skill.md"; filename*=UTF-8\'\'Alpha%20Skill.md',
     contentDisposition('Alpha Skill', '.md'));
  ok('a name that reduces to a Windows device name falls back',
     asciiName(cleanName('CON')) === 'skill', asciiName(cleanName('CON')));
  ok('an empty name falls back rather than producing ".md"',
     contentDisposition('', '.md') === 'attachment; filename="skill.md"', contentDisposition('', '.md'));
  ok('P2 a reserved name gets NO filename* restoring it — the fallback is the whole header',
     contentDisposition('CON', '.md') === 'attachment; filename="skill.md"', contentDisposition('CON', '.md'));
  for (const n of ['con.notes', 'Nul', 'LPT1 ', 'aux.tar']) {
    const cd = contentDisposition(n, '.md');
    ok(`P2 …nor for ${JSON.stringify(n)}, in either parameter`,
       !/(^|["'])(con|nul|lpt1|aux)[.%"]/i.test(cd.replace(/^attachment; /, '')), cd);
  }
  {
    let cd = null, threw = null;
    try { cd = contentDisposition(EMOJI_NAME, '.md'); } catch (e) { threw = e; }
    ok('C3 a 99-ASCII-plus-emoji name produces a header instead of throwing', threw === null, String(threw));
    ok('C3 …whose filename* decodes to the whole name, emoji intact',
       cd && decodeURIComponent(cd.split("filename*=UTF-8''")[1]) === `${EMOJI_NAME}.md`, cd);
    const long = cleanName(`${'b'.repeat(99)}\u{1F468}\u200D\u{1F469}\u200D\u{1F467}tail`);
    ok('C3 truncation keeps a ZWJ sequence whole rather than splitting it',
       long === `${'b'.repeat(99)}\u{1F468}\u200D\u{1F469}\u200D\u{1F467}` && long.isWellFormed(), JSON.stringify(long.slice(95)));
  }
  {
    const { MAX_HEADER_BYTES } = await import('../lib/download.js');
    const worst = [ZALGO_NAME, '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'.repeat(100), '\u00e9'.repeat(5000), 'x'.repeat(5000), `${'b'.repeat(99)}${'\u0301'.repeat(5000)}`];
    const sizes = worst.map((n) => Buffer.byteLength(contentDisposition(n, '.md')));
    ok(`P2 Content-Disposition stays within ${MAX_HEADER_BYTES} bytes for every oversized name`,
       sizes.every((n) => n <= MAX_HEADER_BYTES), JSON.stringify(sizes));
    ok('P2 …a grapheme that alone exceeds the budget is dropped, not cut',
       !contentDisposition(ZALGO_NAME, '.md').includes('filename*'), contentDisposition(ZALGO_NAME, '.md').slice(0, 80));
    const fam = contentDisposition('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'.repeat(100), '.md');
    ok('P2 …and a long run of graphemes is cut on a grapheme boundary',
       decodeURIComponent(fam.split("filename*=UTF-8''")[1]).replace(/\.md$/, '').split('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}').every((p) => p === ''),
       fam.slice(-60));
  }
  ok('a traversal name cannot name another directory',
     !contentDisposition('../../etc/passwd', '.md').includes('/'),
     contentDisposition('../../etc/passwd', '.md'));
}
{
  // The cap check decides from row metadata alone. Fabricated rows prove that:
  // there is no directory behind them, so nothing could have been opened.
  const rows = [{ files: new Array(5).fill({}), totalBytes: 10 }];
  let threw = null;
  try { assertSelectionFits(rows, { maxEntries: 4, maxBytes: 1e9 }); } catch (e) { threw = e; }
  ok('an over-count selection is refused with 413 from metadata alone', threw?.status === 413, threw?.message);
  threw = null;
  try { assertSelectionFits(rows, { maxEntries: 1e9, maxBytes: 9 }); } catch (e) { threw = e; }
  ok('an over-byte selection is refused with 413 from metadata alone', threw?.status === 413, threw?.message);
  // 5 files plus the one directory record an archive gives them. This used to
  // assert 5: the preflight counted files only, and an archive whose files
  // fit could overflow the entry cap with its directory records (Grade C10).
  ok('a selection inside the caps passes, counting its directory record',
     assertSelectionFits(rows, { maxEntries: 1e9, maxBytes: 1e9 }).entries === 6);
  const nested = [{ files: [{ rel: 'SKILL.md' }, { rel: 'a/b/c.md' }, { rel: 'a/d.md' }], totalBytes: 3 }];
  let t2 = null;
  try { assertSelectionFits(nested, { maxEntries: 5, maxBytes: 1e9 }); } catch (e) { t2 = e; }
  ok('C10 3 files needing 3 directory records overflow a 5-entry cap', t2?.status === 413, t2?.message);
  t2 = null;
  try { assertSelectionFits([{ files: [{ rel: 'x', size: 9 }], totalBytes: 9 }], { maxEntries: 9, maxBytes: 1e9, maxFileBytes: 8 }); }
  catch (e) { t2 = e; }
  ok('C10 a file over the per-file cap is refused from metadata', t2?.status === 413, t2?.message);
}

// --- the HTTP surface --------------------------------------------------------
const { listSkills } = await import('../lib/skills.js');
const { ZIP_LIMITS } = await import('../lib/zip.js');
const { createApp } = await import('../server.js');
const { server } = createApp();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const B = `http://localhost:${server.address().port}`;

/** Raw: status, headers and BYTES. Nothing here may assume a JSON body. */
const raw = (p, init) => fetch(B + p, init).then(async (r) => ({
  status: r.status,
  type: r.headers.get('content-type') || '',
  disp: r.headers.get('content-disposition') || '',
  excluded: r.headers.get('x-skills-excluded'),
  buf: Buffer.from(await r.arrayBuffer()),
}));
const err = async (p, init) => {
  const r = await raw(p, init);
  let body = null;
  try { body = JSON.parse(r.buf.toString('utf8')); } catch {}
  return { ...r, body };
};

const rows = listSkills();
const id = (name) => rows.find((r) => r.name === name)?.id;
ok('every fixture skill was discovered',
   ['alpha', 'beta', 'nasty', 'crlf', 'device', 'emoji', 'zalgo', 'too-deep', 'evil', 'dangling'].every((n) => id(n)),
   JSON.stringify(rows.map((r) => r.name)));

// --- one id -> a readable .md ------------------------------------------------
{
  const r = await raw(`/api/skills/export?ids=${id('alpha')}`);
  const text = r.buf.toString('utf8');
  ok('one id returns 200', r.status === 200, String(r.status));
  ok('…as markdown, not JSON', /^text\/markdown/.test(r.type), r.type);
  ok('…named from the frontmatter, never SKILL.md',
     r.disp === 'attachment; filename="Alpha-Skill.md"; filename*=UTF-8\'\'Alpha%20Skill.md'
     && !r.disp.includes('SKILL.md'), r.disp);
  ok('…with the frontmatter block intact',
     text.startsWith('---\nname: Alpha Skill\ndescription: does alpha things\n---\n'), JSON.stringify(text.slice(0, 60)));
  ok('…byte-identical to the SKILL.md on disk',
     r.buf.equals(fs.readFileSync(H('.claude', 'skills', 'alpha', 'SKILL.md'))));
  ok('…and it is not a zip', r.buf.subarray(0, 2).toString('latin1') !== 'PK');
}
{
  const r = await raw(`/api/skills/export?ids=${id('nasty')}`);
  ok('a hostile frontmatter name still downloads', r.status === 200, String(r.status));
  ok('…with a valid single-line Content-Disposition', !/[\r\n]/.test(r.disp), JSON.stringify(r.disp));
  ok('…carrying both an ASCII filename and filename*',
     /^attachment; filename="[A-Za-z0-9._-]+\.md"; filename\*=UTF-8''/.test(r.disp), r.disp);
  ok('…and no injected header reached the response',
     (await fetch(`${B}/api/skills/export?ids=${id('nasty')}`)).headers.get('set-cookie') === null);
  ok('…and the quoted filename still holds no header separator',
     !/[;:\r\n]/.test(r.disp.split('"')[1] || ''), JSON.stringify(r.disp.split('"')[1]));
}
{
  const r = await raw(`/api/skills/export?ids=${id('crlf')}`);
  ok('a frontmatter name carrying a CR downloads without a forged header', r.status === 200, String(r.status));
  ok('…with a single-line Content-Disposition', !/[\r\n]/.test(r.disp), JSON.stringify(r.disp));
  ok('…and no Set-Cookie of any kind',
     (await fetch(`${B}/api/skills/export?ids=${id('crlf')}`)).headers.get('set-cookie') === null);
}

{
  const r = await raw(`/api/skills/export?ids=${id('emoji')}`);
  ok('C3 a 99-ASCII-plus-emoji frontmatter name downloads 200, not 500', r.status === 200,
     `${r.status} ${r.buf.toString('utf8').slice(0, 120)}`);
  ok('C3 …with filename* carrying the emoji',
     r.disp.includes('%F0%9F%98%80.md'), r.disp);
}
{
  // Parsed by node:http itself (default 16KB header limit) — the client that
  // failed with HPE_HEADER_OVERFLOW on the unbounded header.
  const http = await import('node:http');
  const got = await new Promise((resolve) => {
    http.get(`${B}/api/skills/export?ids=${id('zalgo')}`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, disp: res.headers['content-disposition'], body: Buffer.concat(chunks) }));
    }).on('error', (e) => resolve({ error: e.code || e.message }));
  });
  ok('P2 a name of a + 10,000 combining accents downloads 200 through a Node HTTP client',
     got.status === 200 && !got.error, JSON.stringify({ s: got.status, e: got.error }));
  ok('P2 …with a Content-Disposition under 1KB', got.disp && Buffer.byteLength(got.disp) <= 1024, String(got.disp?.length));
  ok('P2 …and the file itself intact', got.body?.equals(fs.readFileSync(H('.claude', 'skills', 'zalgo', 'SKILL.md'))));
}
{
  const r = await err(`/api/skills/export?ids=${id('too-deep')}`);
  ok('C4 a 33-deep skill is refused, not exported partially', r.status === 409, `${r.status}`);
  ok('C4 …with a message that says why',
     /deeper than the 32-level limit.*refusing to export it partially/.test(r.body?.error || ''), r.body?.error);
  const z = await err(`/api/skills/export?ids=${id('too-deep')},${id('alpha')}`);
  ok('C4 …and a selection containing it is refused too, with no archive bytes',
     z.status === 409 && z.buf.subarray(0, 2).toString('latin1') !== 'PK', String(z.status));
}
{
  const r = await raw(`/api/skills/export?ids=${id('device')}`);
  ok('P2 a skill named CON downloads as skill.md, with no filename* restoring CON.md',
     r.status === 200 && r.disp === 'attachment; filename="skill.md"', r.disp);
}

// --- several ids -> a zip ----------------------------------------------------
const zipOf = async (ids) => {
  const r = await raw(`/api/skills/export?ids=${ids.join(',')}`);
  return r;
};
{
  const ids = [id('alpha'), id('beta')];
  const r = await zipOf(ids);
  ok('several ids return 200', r.status === 200, String(r.status));
  ok('…as application/zip', r.type === 'application/zip', r.type);
  ok('…named skills-<n>.zip', r.disp === 'attachment; filename="skills-2.zip"', r.disp);
  ok('…with a local file header at byte 0', r.buf.subarray(0, 4).toString('latin1') === 'PK\x03\x04');

  const zp = path.join(WORK, 'two.zip');
  fs.writeFileSync(zp, r.buf);
  const dest = path.join(WORK, 'two');
  const u = spawnSync('unzip', ['-qq', '-o', zp, '-d', dest], { encoding: 'utf8' });
  ok('the response extracts with system `unzip`', u.status === 0, (u.stderr || '').slice(0, 300));
  ok('…recovering both skills with their companion files',
     fs.readFileSync(path.join(dest, 'alpha', 'SKILL.md'), 'utf8').includes('Alpha Skill')
     && fs.existsSync(path.join(dest, 'alpha', 'scripts', 'run.sh'))
     && fs.readFileSync(path.join(dest, 'beta', 'notes.md'), 'utf8') === 'beta notes\n',
     fs.readdirSync(dest).join(','));
  ok('…preserving the executable bit',
     (fs.lstatSync(path.join(dest, 'alpha', 'scripts', 'run.sh')).mode & 0o111) !== 0);
  ok('…and saying in a header that it shipped every name (none excluded)', r.excluded === '0', String(r.excluded));
}

// --- repeated ids ------------------------------------------------------------
{
  const a = id('alpha');
  const r = await zipOf([a, id('beta'), a, a]);
  ok('a repeated id is deduplicated, not duplicated', r.status === 200 && r.disp.includes('skills-2.zip'), r.disp);
  const zp = path.join(WORK, 'dup.zip');
  fs.writeFileSync(zp, r.buf);
  const dest = path.join(WORK, 'dup');
  spawnSync('unzip', ['-qq', '-o', zp, '-d', dest], { encoding: 'utf8' });
  ok('…and the archive holds exactly one copy of each skill',
     fs.readdirSync(dest).sort().join(',') === 'alpha,beta', fs.readdirSync(dest).join(','));
  ok('…with no -2 suffixed duplicate anywhere',
     !fs.readdirSync(dest).some((n) => /-2$/.test(n)), fs.readdirSync(dest).join(','));
}
{
  // One id repeated is still ONE skill, so it takes the markdown path.
  const a = id('alpha');
  const r = await raw(`/api/skills/export?ids=${a},${a},${a}`);
  ok('the same id three times is a single-skill markdown download',
     r.status === 200 && /^text\/markdown/.test(r.type), `${r.status} ${r.type}`);
}

// --- hostile input, all clean statuses ---------------------------------------
{
  const cases = [
    ['no ids at all', '/api/skills/export', 400],
    ['an empty ids value', '/api/skills/export?ids=', 400],
    ['ids of only commas', '/api/skills/export?ids=,,,', 400],
    ['an unknown id', '/api/skills/export?ids=deadbeefcafe', 404],
    ['a non-hex id', '/api/skills/export?ids=zzzzzzzzzzzz', 400],
    ['a wrong-length id', '/api/skills/export?ids=abc', 400],
    ['a path instead of an id', `/api/skills/export?ids=${encodeURIComponent('/etc/passwd')}`, 400],
    ['a traversal instead of an id', `/api/skills/export?ids=${encodeURIComponent('../../.ssh/id_rsa')}`, 400],
    ['a name instead of an id', '/api/skills/export?ids=alpha', 400],
    ['a NUL inside an id', `/api/skills/export?ids=${encodeURIComponent('abcdef123456 ')}`, 400],
    ['too many ids', `/api/skills/export?ids=${new Array(300).fill('abcdef123456').join(',')}`, 400],
    ['an oversized query string', `/api/skills/export?ids=${id('alpha')}&pad=${'x'.repeat(9000)}`, 413],
  ];
  for (const [label, p, want] of cases) {
    const r = await err(p);
    ok(`${label} -> ${want}`, r.status === want, `${r.status} ${r.buf.toString('utf8').slice(0, 120)}`);
    ok(`…${label}: a JSON error, never a stack trace or a partial body`,
       r.body !== null && typeof r.body.error === 'string' && !/\n\s+at /.test(r.body.error),
       r.buf.toString('utf8').slice(0, 200));
    ok(`…${label}: no archive bytes were sent`, r.buf.subarray(0, 2).toString('latin1') !== 'PK');
  }
}
{
  // Mixed valid/invalid must NOT silently shrink to the valid subset.
  const r = await err(`/api/skills/export?ids=${id('alpha')},deadbeefcafe,${id('beta')}`);
  ok('mixed valid and unknown ids -> 404, not a partial archive', r.status === 404, String(r.status));
  ok('…and nothing resembling a zip came back', r.buf.subarray(0, 2).toString('latin1') !== 'PK');
  const r2 = await err(`/api/skills/export?ids=${id('alpha')},NOTANID`);
  ok('mixed valid and malformed ids -> 400', r2.status === 400, String(r2.status));
}
{
  const r = await err(`/api/skills/export?ids=${id('dangling')}`);
  ok('a broken skill is refused with a clean status rather than an empty file',
     r.status === 409 && typeof r.body?.error === 'string', `${r.status} ${r.buf.toString('utf8').slice(0, 120)}`);
}
{
  // The POST/PUT verbs must not reach the handler at all.
  const r = await err('/api/skills/export?ids=' + id('alpha'), { method: 'POST' });
  ok('POST to the export path is not the download endpoint', r.status === 404, String(r.status));
}

// --- the entry-count cap, end to end -----------------------------------------
{
  // Built and torn down around this one request: every later listSkills() call
  // would otherwise walk and hash all of it.
  const BIG = H('.claude', 'skills', 'huge');
  mk(BIG);
  fs.writeFileSync(path.join(BIG, 'SKILL.md'), skillMd('Huge', 'too many files'));
  const over = ZIP_LIMITS.maxEntries + 1;
  for (let i = 1; i < over; i++) fs.writeFileSync(path.join(BIG, `f${i}.txt`), '');
  const hugeId = listSkills().find((r) => r.name === 'huge')?.id;
  ok('the over-cap fixture was discovered', Boolean(hugeId));

  const r = await err(`/api/skills/export?ids=${hugeId},${id('alpha')}`);
  ok('a selection over ZIP_LIMITS.maxEntries -> 413', r.status === 413, `${r.status} ${r.buf.toString('utf8').slice(0, 160)}`);
  ok('…with a JSON error and no archive bytes',
     typeof r.body?.error === 'string' && r.buf.subarray(0, 2).toString('latin1') !== 'PK',
     r.buf.toString('utf8').slice(0, 160));
  const r1 = await err(`/api/skills/export?ids=${hugeId}`);
  ok('…and the single-skill path refuses it too', r1.status === 413, String(r1.status));

  fs.rmSync(BIG, { recursive: true, force: true });
  ok('the over-cap fixture is gone again', !fs.existsSync(BIG));
}

// --- C10: an oversized bundle is a 413, decided before any read ---------------
{
  // Sparse: 65MB by size, no blocks on disk. listSkills() flags it as a broken
  // row (bundle over the 64MB cap), which is why routing the export through it
  // answered 409; the export now resolves the id itself and refuses on size.
  const FAT = H('.claude', 'skills', 'fat');
  mk(FAT);
  fs.writeFileSync(path.join(FAT, 'SKILL.md'), skillMd('Fat', 'a sparse 65MB companion'));
  fs.writeFileSync(path.join(FAT, 'blob.bin'), '');
  fs.truncateSync(path.join(FAT, 'blob.bin'), 65 * 1024 * 1024);
  const { skillId } = await import('../lib/skills.js');
  const fatId = skillId(fs.realpathSync(FAT));
  ok('the sparse fixture is 65MB by size', fs.statSync(path.join(FAT, 'blob.bin')).size === 65 * 1024 * 1024);
  ok('…and listSkills() marks it broken for size, the old 409 path',
     listSkills().find((r) => r.id === fatId)?.broken === true);
  const t0 = Date.now();
  const r = await err(`/api/skills/export?ids=${fatId},${id('alpha')}`);
  ok('C10 an oversized selection answers 413, not 409', r.status === 413, `${r.status} ${r.buf.toString('utf8').slice(0, 160)}`);
  const r1 = await err(`/api/skills/export?ids=${fatId}`);
  ok('C10 …on the single-skill path too', r1.status === 413, `${r1.status} ${r1.buf.toString('utf8').slice(0, 160)}`);
  ok('C10 …decided from metadata, fast', Date.now() - t0 < 5000, `${Date.now() - t0}ms`);
  fs.rmSync(FAT, { recursive: true, force: true });

  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const handler = src.slice(src.indexOf('async function handleSkillExport'), src.indexOf('\n}\n', src.indexOf('async function handleSkillExport')))
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n'); // code, not its comments
  ok('C10 the export handler resolves only the selected ids — it never calls listSkills()',
     handler.length > 200 && !/listSkills\(/.test(handler) && /resolveSkills\(/.test(handler));
}

// --- containment through the export path -------------------------------------
{
  const r = await raw(`/api/skills/export?ids=${id('evil')}`);
  ok('the injected skill downloads as an ordinary markdown file', r.status === 200, String(r.status));
  ok('…and no secret byte is in the .md response',
     leaks(r.buf.toString('latin1')).length === 0, leaks(r.buf.toString('latin1')).join(','));

  const z = await zipOf([id('evil'), id('alpha')]);
  ok('the injected skill zips without error', z.status === 200, String(z.status));
  ok('C4 …and the response counts the names it refused to ship',
     z.excluded === String(rows.find((r) => r.name === 'evil').excluded.length) && Number(z.excluded) >= 4, String(z.excluded));
  ok('…and no secret byte is in the zip response (compressed OR stored)',
     leaks(z.buf.toString('latin1')).length === 0, leaks(z.buf.toString('latin1')).join(','));

  const zp = path.join(WORK, 'evil.zip');
  fs.writeFileSync(zp, z.buf);
  const dest = path.join(WORK, 'evil');
  const u = spawnSync('unzip', ['-qq', '-o', zp, '-d', dest], { encoding: 'utf8' });
  ok('…and it extracts', u.status === 0, (u.stderr || '').slice(0, 200));

  const extracted = [];
  const walk = (d, rel = '') => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const s = fs.lstatSync(p);
      if (s.isDirectory()) { walk(p, rel ? `${rel}/${n}` : n); continue; }
      extracted.push([rel ? `${rel}/${n}` : n, fs.readFileSync(p)]);
    }
  };
  walk(dest);
  ok('the extracted tree holds only the skill\'s real files',
     extracted.map(([p]) => p).sort().join(',')
       === 'alpha/SKILL.md,alpha/scripts/run.sh,evil/SKILL.md,evil/honest.md',
     extracted.map(([p]) => p).join(','));
  ok('…no planted symlink name survived',
     !extracted.some(([p]) => /stolen-key|creds\.json|references|sibling/.test(p)),
     extracted.map(([p]) => p).join(','));
  ok('…and no extracted byte is a secret',
     extracted.every(([, b]) => leaks(b.toString('latin1')).length === 0));
  ok('…nor is any extracted entry a symlink',
     !fs.readdirSync(dest, { recursive: true, withFileTypes: true })
        .some((d) => d.isSymbolicLink()));

  ok('the real fixture secrets are still on disk — the absences above are ' +
     'containment, not a missing fixture',
     fs.readFileSync(H('.ssh', 'id_rsa'), 'utf8').includes(SSH_MARK));
}

// --- the endpoint accepts no filesystem path ---------------------------------
{
  const clean = await raw(`/api/skills/export?ids=${id('alpha')}`);
  const withJunk = await raw(`/api/skills/export?ids=${id('alpha')}`
    + `&path=${encodeURIComponent('/etc/passwd')}`
    + `&dir=${encodeURIComponent(H('.ssh'))}`
    + `&file=${encodeURIComponent(H('.claude', '.credentials.json'))}`
    + '&name=alpha');
  ok('a path handed alongside a valid id changes nothing',
     withJunk.status === 200 && withJunk.buf.equals(clean.buf) && withJunk.disp === clean.disp,
     `${withJunk.status} ${withJunk.disp}`);
  ok('…and leaks nothing', leaks(withJunk.buf.toString('latin1')).length === 0);

  for (const p of ['/etc/passwd', H('.ssh', 'id_rsa'), H('.claude', '.credentials.json'), 'alpha']) {
    const r = await err(`/api/skills/export?path=${encodeURIComponent(p)}&name=${encodeURIComponent(p)}`);
    ok(`a path with no ids is refused: ${p.slice(-24)}`, r.status === 400, String(r.status));
    ok('…and returns no bytes from it', leaks(r.buf.toString('latin1')).length === 0);
  }
}

// --- the GET origin posture, asserted rather than accidental -----------------
{
  const u = `/api/skills/export?ids=${id('alpha')}`;
  const withHeaders = (h) => err(u, { headers: h });

  const none = await withHeaders({});
  ok('an absent Origin is allowed — a same-origin download navigation sends none',
     none.status === 200, String(none.status));

  const same = await withHeaders({ origin: B.replace('http://', 'http://'), 'sec-fetch-site': 'same-origin' });
  ok('this page\'s own Origin is allowed', same.status === 200, String(same.status));

  const foreign = await withHeaders({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
  ok('a foreign Origin is refused with 403', foreign.status === 403, String(foreign.status));
  ok('…and gets no bytes of any skill', foreign.buf.subarray(0, 2).toString('latin1') !== 'PK'
     && !foreign.buf.toString('utf8').includes('Alpha Skill'), foreign.buf.toString('utf8').slice(0, 120));

  const otherPort = await withHeaders({ origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site' });
  ok('another localhost PORT is refused — same-site is not same-origin',
     otherPort.status === 403, String(otherPort.status));

  const crossSiteOnly = await withHeaders({ 'sec-fetch-site': 'cross-site' });
  ok('Sec-Fetch-Site: cross-site alone is refused, even with no Origin',
     crossSiteOnly.status === 403, String(crossSiteOnly.status));

  const sameSiteOnly = await withHeaders({ 'sec-fetch-site': 'same-site' });
  ok('P2 Sec-Fetch-Site: same-site with NO Origin is refused — another localhost port\'s <img>',
     sameSiteOnly.status === 403, String(sameSiteOnly.status));
  const sameOriginOnly = await withHeaders({ 'sec-fetch-site': 'same-origin' });
  ok('P2 …while this page\'s own download link (same-origin, no Origin) is allowed',
     sameOriginOnly.status === 200, String(sameOriginOnly.status));
  const typed = await withHeaders({ 'sec-fetch-site': 'none' });
  ok('P2 …and so is a URL the user typed (none)', typed.status === 200, String(typed.status));
  const typedForeign = await withHeaders({ 'sec-fetch-site': 'none', origin: 'https://evil.example' });
  ok('P2 …but not none with a foreign Origin', typedForeign.status === 403, String(typedForeign.status));

  // /api/skills walks every project tree and rescans the transcript corpus, so
  // it gets the same gate. This used to assert the OPPOSITE — that a cross-site
  // GET /api/skills was answered 200 — which is the bug the Grade found (P2),
  // not a property to preserve.
  const listing = (h) => fetch(`${B}/api/skills`, { headers: h }).then((r) => r.status);
  ok('P2 GET /api/skills refuses a cross-site request',
     await listing({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }) === 403);
  ok('P2 GET /api/skills refuses same-site with no Origin (another localhost port)',
     await listing({ 'sec-fetch-site': 'same-site' }) === 403);
  ok('P2 GET /api/skills refuses another localhost port\'s Origin',
     await listing({ origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site' }) === 403);
  ok('P2 GET /api/skills still answers this page (same-origin)',
     await listing({ 'sec-fetch-site': 'same-origin' }) === 200);
  // The global GET exemption for every OTHER JSON route is unchanged.
  const other = await fetch(`${B}/api/harnesses`, { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
  ok('the app\'s global GET policy is otherwise unchanged (GET /api/harnesses still answers cross-site)',
     other.status === 200, String(other.status));
}

// --- the real directories were never touched ---------------------------------
server.close();
{
  assertRealHomesUnchanged(realBefore, ok);
}

fs.rmSync(fakeHome, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
