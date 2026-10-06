/**
 * The ZIP writer: format contract, name safety, path uniqueness, caps.
 *
 * The load-bearing test here is the round trip through REAL extractors. A zip
 * verified with the reader that wrote it only proves the writer agrees with
 * itself, and `unzip -t` only proves the CRCs match — neither notices a lost
 * executable bit, a mangled non-ASCII name, or two files that landed on top of
 * each other. So every archive below is extracted with system `unzip` AND with
 * macOS `ditto -x -k`, both trees are compared against the source bytes, and
 * against each other; python3's `zipfile` is used as a third, independent
 * parser for the header fields an extractor does not surface.
 *
 * HOME is redirected before any import for the same reason as tests/skills.mjs:
 * lib/paths.js binds HOME at module load, and nothing here may address a real
 * config directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const realHome = os.homedir();


const realBefore = snapshotRealHomes();

const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-zip-')));
process.env.HOME = fakeHome;
// ACS ran here before roots.json existed (builds/setup-screen S1), so the
// legacy folders below are what migration — and absent-file reads — use.
fs.mkdirSync(path.join(fakeHome, '.agent-config-studio'), { recursive: true });
fs.writeFileSync(path.join(fakeHome, '.agent-config-studio', 'seats.json'), '{"version":1,"seats":[]}\n');
process.env.ACS_SUITE = 'offline';
delete process.env.CODEX_HOME;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\nzip');
ok('HOME is redirected away from the real one', os.homedir() === fakeHome && fakeHome !== realHome);

const H = (...p) => path.join(fakeHome, ...p);
const mk = (dir) => fs.mkdirSync(dir, { recursive: true });
const put = (file, body, mode) => { mk(path.dirname(file)); fs.writeFileSync(file, body, mode ? { mode } : undefined); if (mode) fs.chmodSync(file, mode); };
const skillMd = (name, desc, extra = '') => `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\nbody ${extra}\n`;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-zip-work-')));
let caseNo = 0;
const caseDir = () => { const d = path.join(WORK, `case-${++caseNo}`); mk(d); return d; };

// --- extraction helpers ------------------------------------------------------

function extractUnzip(zipPath, dest) {
  mk(dest);
  const r = spawnSync('unzip', ['-qq', '-o', zipPath, '-d', dest], { encoding: 'utf8' });
  return { code: r.status, err: `${r.stderr || ''}${r.stdout || ''}` };
}
function extractDitto(zipPath, dest) {
  mk(dest);
  const r = spawnSync('ditto', ['-x', '-k', zipPath, dest], { encoding: 'utf8' });
  return { code: r.status, err: `${r.stderr || ''}${r.stdout || ''}` };
}

/**
 * The recovered tree, as `path -> sha256:mode` for files and `path/ -> dir` for
 * directories. Names are NFC-normalised before comparison: APFS preserves the
 * bytes it is handed but the two extractors need not agree on the form they
 * write, and a normalisation difference is not a packaging bug.
 */
function snapshot(root, base = root, out = new Map()) {
  for (const d of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(root, d.name);
    const rel = path.relative(base, abs).split(path.sep).join('/').normalize('NFC');
    if (d.isSymbolicLink()) { out.set(rel, 'symlink'); continue; }
    if (d.isDirectory()) { out.set(`${rel}/`, 'dir'); snapshot(abs, base, out); continue; }
    const st = fs.lstatSync(abs);
    out.set(rel, `${sha(fs.readFileSync(abs))}:${(st.mode & 0o777).toString(8)}`);
  }
  return out;
}
const asText = (m) => [...m.entries()].sort().map(([k, v]) => `${k}=${v}`).join('\n');

/** Python's zipfile as a third parser, for the header fields extractors hide. */
function pyRead(zipPath) {
  const code = `
import json, zipfile, sys
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
print(json.dumps({
  "bad": bad,
  "entries": [
    {"name": i.filename, "flag": i.flag_bits, "method": i.compress_type,
     "crc": i.CRC, "size": i.file_size, "mode": (i.external_attr >> 16) & 0o7777,
     "isdir": i.is_dir(), "created": i.create_system, "date": list(i.date_time)}
    for i in z.infolist()
  ],
}))`;
  const r = spawnSync('python3', ['-c', code, zipPath], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`python3 zipfile failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// --- fixtures ----------------------------------------------------------------

const BIN = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const UNI = 'notes-ünïcode-日本.md';

put(H('.claude', 'skills', 'alpha', 'SKILL.md'), skillMd('Alpha', 'does alpha things'));
put(H('.claude', 'skills', 'alpha', 'scripts', 'run.sh'), '#!/bin/sh\necho alpha\n', 0o755);
put(H('.claude', 'skills', 'alpha', UNI), 'unicode name, ascii body\n');
put(H('.claude', 'skills', 'alpha', 'data', 'bin.dat'), BIN);
put(H('.claude', 'skills', 'alpha', 'data', 'empty.txt'), '');

// Seven skills named `decision`, each with a different bundle so none collapse,
// plus a skill literally named `global__decision` to collide with the scheme
// that resolves the first collision.
const DECISIONS = [
  H('.claude', 'skills', 'decision'),
  H('Documents', 'Projects', 'p1', '.claude', 'skills', 'decision'),
  H('Documents', 'Projects', 'p2', '.claude', 'skills', 'decision'),
  H('Documents', 'Projects', 'p3', '.claude', 'skills', 'decision'),
  H('Documents', 'Garman-Homes', 'g1', 'wt-a', '.claude', 'skills', 'decision'),
  H('Documents', 'Garman-Homes', 'g1', 'wt-b', '.claude', 'skills', 'decision'),
  H('Documents', 'Garman-Homes', 'g2', 'wt-c', '.claude', 'skills', 'decision'),
];
DECISIONS.forEach((dir, i) => {
  put(path.join(dir, 'SKILL.md'), skillMd('Decision', 'how to decide', `copy-${i}`));
  put(path.join(dir, 'scripts', 'run.sh'), `#!/bin/sh\necho decide ${i}\n`, 0o755);
});
put(H('.claude', 'skills', 'global__decision', 'SKILL.md'), skillMd('Global Decision', 'the adversarial name'));

const { listSkills, readInSkill } = await import('../lib/skills.js');
const {
  buildZip, buildSkillsZip, crc32, sanitizeEntryName, planSkillPrefixes, resolveArchivePaths,
} = await import('../lib/zip.js');

// --- CRC-32 ------------------------------------------------------------------
{
  // Known-answer vectors: if the table is wrong every archive below still
  // "passes" its own checks and fails in every real extractor.
  ok('crc32("") === 0', crc32(Buffer.from('')) === 0);
  ok('crc32("123456789") === 0xCBF43926', crc32(Buffer.from('123456789')) === 0xcbf43926,
     crc32(Buffer.from('123456789')).toString(16));
  ok('crc32("The quick brown fox jumps over the lazy dog") === 0x414FA339',
     crc32(Buffer.from('The quick brown fox jumps over the lazy dog')) === 0x414fa339);
  ok('crc32 of 256 binary bytes === 0x29058C73',
     crc32(BIN) === 0x29058c73, crc32(BIN).toString(16));
  ok('zlib.crc32 is not used (it is absent before Node 20.15)',
     !fs.readFileSync(new URL('../lib/zip.js', import.meta.url), 'utf8').includes('zlib.crc32'));
}

// --- the round trip, both extractors ----------------------------------------
const rows = listSkills().filter((r) => !r.broken);
ok('the fixture home yields the 9 expected skills', rows.length === 9,
   JSON.stringify(rows.map((r) => `${r.source}:${r.name}`)));

const zipBuf = buildSkillsZip(rows, { read: readInSkill });
const RT = caseDir();
const zipPath = path.join(RT, 'skills.zip');
fs.writeFileSync(zipPath, zipBuf);

{
  const u = extractUnzip(zipPath, path.join(RT, 'unzip'));
  const d = extractDitto(zipPath, path.join(RT, 'ditto'));
  ok('system `unzip` extracts the archive cleanly', u.code === 0, u.err.slice(0, 300));
  ok('macOS `ditto -x -k` extracts the archive cleanly', d.code === 0, d.err.slice(0, 300));

  const su = snapshot(path.join(RT, 'unzip'));
  const sd = snapshot(path.join(RT, 'ditto'));
  ok('the two extractors recover byte-identical trees', asText(su) === asText(sd),
     asText(su).slice(0, 400));

  // The source side, read with plain fs — independent of the module under test.
  const expected = new Map();
  const prefixes = planSkillPrefixes(rows);
  for (const r of rows) {
    for (const f of r.files) {
      const st = fs.lstatSync(path.join(r.dir, f.rel));
      expected.set(`${prefixes.get(r.id)}/${f.rel}`.normalize('NFC'),
                   `${sha(fs.readFileSync(path.join(r.dir, f.rel)))}:${(st.mode & 0o777).toString(8)}`);
    }
  }
  const recoveredFiles = new Map([...su.entries()].filter(([k]) => !k.endsWith('/')));
  ok('every source file was recovered, and nothing extra',
     asText(recoveredFiles) === asText(expected),
     `recovered ${recoveredFiles.size}, expected ${expected.size}`);
  ok('…including the binary companion, byte for byte',
     [...recoveredFiles.values()].includes(`${sha(BIN)}:644`));
  ok('…the zero-byte file',
     [...recoveredFiles.keys()].some((k) => k.endsWith('data/empty.txt')));
  ok('…and the non-ASCII filename intact',
     [...recoveredFiles.keys()].some((k) => k.endsWith(UNI.normalize('NFC'))),
     JSON.stringify([...recoveredFiles.keys()].filter((k) => k.includes('notes'))));

  ok('the 0755 script is still executable after `unzip`',
     recoveredFiles.get('alpha/scripts/run.sh') === `${sha(fs.readFileSync(H('.claude', 'skills', 'alpha', 'scripts', 'run.sh')))}:755`,
     recoveredFiles.get('alpha/scripts/run.sh'));
  ok('…and after `ditto`',
     sd.get('alpha/scripts/run.sh')?.endsWith(':755'), sd.get('alpha/scripts/run.sh'));
  ok('…and it actually runs from the extracted tree',
     spawnSync(path.join(RT, 'unzip', 'alpha', 'scripts', 'run.sh'), [], { encoding: 'utf8' }).stdout.trim() === 'alpha');
  ok('a non-executable companion did NOT gain the bit',
     recoveredFiles.get('alpha/SKILL.md')?.endsWith(':644'), recoveredFiles.get('alpha/SKILL.md'));

  ok('no symlink was created by either extractor',
     ![...su.values(), ...sd.values()].includes('symlink'));
}

// --- the format contract, read by a third parser -----------------------------
{
  const info = pyRead(zipPath);
  ok('python3 zipfile finds no corrupt entry', info.bad === null, String(info.bad));
  const byName = new Map(info.entries.map((e) => [e.name.normalize('NFC'), e]));

  const uniEntry = [...byName.entries()].find(([n]) => n.includes('notes-'));
  ok('a non-ASCII name sets the UTF-8 flag (bit 11)', (uniEntry[1].flag & 0x800) !== 0,
     uniEntry[1].flag.toString(16));
  ok('…and its bytes decode to exactly the source name', uniEntry[0].endsWith(UNI.normalize('NFC')),
     uniEntry[0]);
  ok('a pure-ASCII name does NOT set bit 11',
     (byName.get('alpha/SKILL.md').flag & 0x800) === 0);
  ok('no entry sets the data-descriptor bit (3)',
     info.entries.every((e) => (e.flag & 0x8) === 0));
  ok('no entry sets the encryption bit (0)',
     info.entries.every((e) => (e.flag & 0x1) === 0));
  ok('the archive declares UNIX as the creating system, so the mode bits count',
     info.entries.every((e) => e.created === 3));
  ok('external attributes carry the 0755 script mode',
     byName.get('alpha/scripts/run.sh').mode === 0o755,
     byName.get('alpha/scripts/run.sh').mode.toString(8));
  ok('directory records are marked as directories',
     info.entries.filter((e) => e.isdir).length > 0
     && info.entries.every((e) => e.isdir === e.name.endsWith('/')));
  ok('every date is inside the DOS range (>= 1980)',
     info.entries.every((e) => e.date[0] >= 1980 && e.date[0] <= 2107),
     JSON.stringify(info.entries.map((e) => e.date[0]).filter((y) => y < 1980)));
  ok('the empty file is stored, not deflated', byName.get('alpha/data/empty.txt').method === 0);
  ok('a compressible text file is deflated', byName.get('alpha/SKILL.md').method === 8);

  // Local headers must repeat what the central directory says. python3 reads the
  // central directory; this re-reads each local header straight out of the
  // bytes and compares the fields an extractor trusts.
  let mismatch = null;
  {
    let off = 0;
    for (const e of info.entries) {
      if (zipBuf.readUInt32LE(off) !== 0x04034b50) { mismatch = `no local header at ${off}`; break; }
      const flag = zipBuf.readUInt16LE(off + 6);
      const method = zipBuf.readUInt16LE(off + 8);
      const crc = zipBuf.readUInt32LE(off + 14);
      const csize = zipBuf.readUInt32LE(off + 18);
      const usize = zipBuf.readUInt32LE(off + 22);
      const nlen = zipBuf.readUInt16LE(off + 26);
      const xlen = zipBuf.readUInt16LE(off + 28);
      const name = zipBuf.subarray(off + 30, off + 30 + nlen).toString('utf8');
      if (name !== e.name) { mismatch = `name ${JSON.stringify(name)} vs ${JSON.stringify(e.name)}`; break; }
      if (Buffer.byteLength(e.name, 'utf8') !== nlen) { mismatch = `name length is not byte length for ${name}`; break; }
      if (flag !== e.flag || method !== e.method || crc !== e.crc || usize !== e.size) {
        mismatch = `local/central disagree for ${name}`;
        break;
      }
      off += 30 + nlen + xlen + csize;
    }
    ok('every local header matches its central directory record', mismatch === null, String(mismatch));
    ok('the local headers end exactly where the central directory begins',
       mismatch !== null || zipBuf.readUInt32LE(off) === 0x02014b50);
  }
}

// --- uniqueness across an adversarial selection ------------------------------
{
  const prefixes = [...planSkillPrefixes(rows).values()];
  ok('the seven `decision` skills plus `global__decision` produce distinct prefixes',
     new Set(prefixes.map((p) => p.toLowerCase())).size === prefixes.length, JSON.stringify(prefixes));
  ok('…and the literal `global__decision` skill did not take the same prefix twice',
     prefixes.filter((p) => p.toLowerCase().startsWith('global__decision')).length === 2
     && prefixes.includes('global__decision') && prefixes.includes('global__decision-2'),
     JSON.stringify(prefixes.filter((p) => p.startsWith('global'))));
  ok('every selected skill got a prefix', planSkillPrefixes(rows).size === rows.length);

  const info = pyRead(zipPath);
  const names = info.entries.map((e) => e.name.normalize('NFC'));
  ok('every archive entry name is unique (case-insensitively)',
     new Set(names.map((n) => n.toLowerCase())).size === names.length);
  const fileNames = names.filter((n) => !n.endsWith('/'));
  const dirNames = new Set(names.filter((n) => n.endsWith('/')).map((n) => n.slice(0, -1).toLowerCase()));
  ok('no entry is both a file and a directory',
     !fileNames.some((n) => dirNames.has(n.toLowerCase())));
  ok('no file sits on a path another file uses as a parent directory',
     !fileNames.some((n) => fileNames.some((m) => m.toLowerCase().startsWith(`${n.toLowerCase()}/`))));

  // Nothing was overwritten: 9 skills' worth of files all survive as distinct
  // paths, which is the whole point of the suffixing.
  const sourceCount = rows.reduce((n, r) => n + r.files.length, 0);
  ok('every input file survives as its own entry', fileNames.length === sourceCount,
     `${fileNames.length} vs ${sourceCount}`);
  ok('…and the extracted tree has the same count',
     [...snapshot(path.join(RT, 'ditto')).keys()].filter((k) => !k.endsWith('/')).length === sourceCount);
}

// --- resolveArchivePaths, directly -------------------------------------------
{
  const out = resolveArchivePaths(['x/scripts', 'x/scripts/run.sh']);
  ok('a file occupying the directory path another entry needs is moved aside',
     out[0] !== 'x/scripts' && out[1] === 'x/scripts/run.sh', JSON.stringify(out));
  ok('…and both survive, distinctly', new Set(out).size === 2 && out.length === 2);

  const dup = resolveArchivePaths(['a/n.md', 'a/n.md', 'a/n.md']);
  ok('repeated paths get numeric suffixes rather than overwriting',
     JSON.stringify(dup) === JSON.stringify(['a/n.md', 'a/n-2.md', 'a/n-3.md']), JSON.stringify(dup));

  const ci = resolveArchivePaths(['a/N.md', 'a/n.md']);
  ok('a case-only difference is separated too, because the recipient FS may fold it',
     ci[0].toLowerCase() !== ci[1].toLowerCase(), JSON.stringify(ci));

  const clash = resolveArchivePaths(['a/n.md', 'a/n-2.md', 'a/n.md']);
  ok('a suffix that is itself already taken keeps counting',
     new Set(clash).size === 3, JSON.stringify(clash));

  const many = resolveArchivePaths(Array.from({ length: 200 }, () => 'p/same.md'));
  ok('200 identical inputs yield 200 distinct outputs', new Set(many).size === 200);
}

// --- name safety -------------------------------------------------------------
const DANGEROUS = [
  '../escape.md',
  '../../escape.md',
  'a/../../escape.md',
  '..',
  '.',
  'a/./b.md',
  'C:\\Windows\\system32\\evil.dll',
  'back\\slash.md',
  'colon:name.md',
  'nul\u0000byte.md',
  'bell\u0007.md',
  'newline\n.md',
  'del\u007f.md',
  'trailing.',
  'trailing ',
  'trailing...',
  'CON',
  'con.md',
  'PRN.txt',
  'AUX',
  'NUL.md',
  'COM1',
  'com9.log',
  'LPT1',
  'lpt9.txt',
  'star*.md',
  'question?.md',
  'quote".md',
  'lt<gt>.md',
  'pipe|.md',
  'percent%.md',
  'percent%3A.md',
];

{
  const mapped = new Map();
  let anyEscaped = false;
  for (const raw of DANGEROUS) {
    let out = null, threw = null;
    try { out = sanitizeEntryName(raw); } catch (e) { threw = e; }
    ok(`sanitises ${JSON.stringify(raw)}`, out !== null || threw !== null);
    if (out === null) continue;
    anyEscaped = true;
    const segs = out.split('/');
    ok(`…${JSON.stringify(raw)} has no traversal, absolute or control byte`,
       !out.startsWith('/') && !segs.includes('..') && !segs.includes('.')
       && !/[\\:*?"<>|\u0000-\u001f\u007f]/.test(out)
       && !segs.some((s) => /[. ]$/.test(s)),
       JSON.stringify(out));
    const stem = segs[segs.length - 1].split('.')[0].toUpperCase();
    ok(`…${JSON.stringify(raw)} is not a Windows device name`,
       !['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9'].includes(stem), JSON.stringify(out));
    mapped.set(raw, out);
  }
  ok('the encoding is exercised, not a blanket rejection', anyEscaped);

  // THE critical property: two distinct dangerous names must never come out as
  // one. Merging them is silent data loss — one skill's file overwrites
  // another's and the archive looks perfectly healthy.
  const outs = [...mapped.values()];
  ok('no two distinct names sanitise to the same string',
     new Set(outs).size === outs.length,
     JSON.stringify(outs.filter((o, i) => outs.indexOf(o) !== i)));
  ok('…including case-insensitively, for a folding filesystem',
     new Set(outs.map((o) => o.toLowerCase())).size === outs.length,
     JSON.stringify(outs));

  // Specific pairs that a naive "strip the bad character" implementation merges.
  const pairs = [['colon:name.md', 'colonname.md'], ['back\\slash.md', 'backslash.md'],
                 ['trailing.', 'trailing'], ['percent%3A.md', 'percent:.md'],
                 ['CON', 'CON_'], ['a\u0000b.md', 'ab.md']];
  for (const [a, b] of pairs) {
    let sa = null, sb = null;
    try { sa = sanitizeEntryName(a); } catch {}
    try { sb = sanitizeEntryName(b); } catch {}
    ok(`${JSON.stringify(a)} and ${JSON.stringify(b)} stay distinct`,
       sa === null || sb === null || sa !== sb, `${sa} === ${sb}`);
  }

  for (const bad of ['/abs/path.md', '', 'a//b.md', '/', null, 42]) {
    let threw = null;
    try { sanitizeEntryName(bad); } catch (e) { threw = e; }
    ok(`structurally invalid name ${JSON.stringify(bad)} is refused`,
       threw !== null && threw.status === 400, String(threw));
  }
  ok('a legitimate name passes through untouched',
     sanitizeEntryName('alpha/scripts/run.sh') === 'alpha/scripts/run.sh');
  ok('a legitimate non-ASCII name is not mangled', sanitizeEntryName(UNI) === UNI);
  ok('a directory name keeps its trailing slash', sanitizeEntryName('alpha/scripts/') === 'alpha/scripts/');
}

// --- dangerous names, through the real extractors ----------------------------
{
  const D = caseDir();
  const names = resolveArchivePaths(DANGEROUS.map((n) => `hostile/${n}`));
  const buf = buildZip(names.map((name, i) => ({ name, data: Buffer.from(`payload ${i}\n`) })));
  const zp = path.join(D, 'hostile.zip');
  fs.writeFileSync(zp, buf);

  const u = extractUnzip(zp, path.join(D, 'unzip'));
  const d = extractDitto(zp, path.join(D, 'ditto'));
  ok('an archive of sanitised hostile names extracts with `unzip`', u.code === 0, u.err.slice(0, 300));
  ok('…and with `ditto`', d.code === 0, d.err.slice(0, 300));

  const su = snapshot(path.join(D, 'unzip'));
  const sd = snapshot(path.join(D, 'ditto'));
  ok('…to identical trees', asText(su) === asText(sd));
  const files = [...su.keys()].filter((k) => !k.endsWith('/'));
  ok('every hostile name landed as its own file — none merged',
     files.length === DANGEROUS.length, `${files.length} vs ${DANGEROUS.length}`);
  ok('…all of them inside the hostile/ prefix, none escaped',
     files.every((f) => f.startsWith('hostile/')), JSON.stringify(files.slice(0, 5)));
  ok('nothing was written beside the extraction directories',
     fs.readdirSync(D).sort().join(',') === 'ditto,hostile.zip,unzip', fs.readdirSync(D).join(','));
  ok('…and each file kept its own distinct payload',
     new Set([...su.values()].filter((v) => v !== 'dir')).size === DANGEROUS.length);
}

// --- empty directories -------------------------------------------------------
{
  const D = caseDir();
  const buf = buildZip([
    { name: 'pkg/', mode: 0o755 },
    { name: 'pkg/empty/', mode: 0o755 },
    { name: 'pkg/deep/nested/', mode: 0o700 },
    { name: 'pkg/bin/', mode: 0o755 },
    { name: 'pkg/bin/run.sh', data: Buffer.from('#!/bin/sh\necho ran\n'), mode: 0o755 },
  ]);
  const zp = path.join(D, 'dirs.zip');
  fs.writeFileSync(zp, buf);
  const u = extractUnzip(zp, path.join(D, 'unzip'));
  const d = extractDitto(zp, path.join(D, 'ditto'));
  ok('an archive with empty directory records extracts with `unzip`', u.code === 0, u.err.slice(0, 200));
  ok('…and with `ditto`', d.code === 0, d.err.slice(0, 200));

  for (const [who, base] of [['unzip', path.join(D, 'unzip')], ['ditto', path.join(D, 'ditto')]]) {
    const s = snapshot(base);
    ok(`${who}: the empty directory survived`, s.get('pkg/empty/') === 'dir', JSON.stringify([...s.keys()]));
    ok(`${who}: the empty nested directory survived`, s.get('pkg/deep/nested/') === 'dir');
    ok(`${who}: it is genuinely empty`, fs.readdirSync(path.join(base, 'pkg', 'empty')).length === 0);
    ok(`${who}: the script beside it is still executable`, s.get('pkg/bin/run.sh')?.endsWith(':755'),
       s.get('pkg/bin/run.sh'));
  }
  ok('a directory mode other than 0755 also survives',
     (fs.lstatSync(path.join(D, 'unzip', 'pkg', 'deep', 'nested')).mode & 0o777) === 0o700,
     (fs.lstatSync(path.join(D, 'unzip', 'pkg', 'deep', 'nested')).mode & 0o777).toString(8));
}

// --- timestamps outside the DOS range ----------------------------------------
{
  const D = caseDir();
  const buf = buildZip([
    { name: 'old.txt', data: Buffer.from('1970\n'), mtime: new Date(0) },
    { name: 'ancient.txt', data: Buffer.from('1900\n'), mtime: new Date('1900-05-05T00:00:00Z') },
    { name: 'far.txt', data: Buffer.from('2200\n'), mtime: new Date('2200-01-01T00:00:00Z') },
    { name: 'nan.txt', data: Buffer.from('nan\n'), mtime: new Date(NaN) },
    { name: 'normal.txt', data: Buffer.from('now\n'), mtime: new Date('2024-06-01T12:34:56Z') },
  ]);
  const zp = path.join(D, 'dates.zip');
  fs.writeFileSync(zp, buf);
  const info = pyRead(zp);
  ok('a pre-1980 mtime clamps to the DOS epoch rather than wrapping',
     info.entries.every((e) => e.date[0] >= 1980 && e.date[0] <= 2107),
     JSON.stringify(info.entries.map((e) => [e.name, e.date])));
  ok('…and the archive still extracts with both readers',
     extractUnzip(zp, path.join(D, 'u')).code === 0 && extractDitto(zp, path.join(D, 'd')).code === 0);
  const normal = info.entries.find((e) => e.name === 'normal.txt');
  ok('an in-range mtime is preserved to the day', normal.date[0] === 2024 && normal.date[1] === 6,
     JSON.stringify(normal.date));
}

// --- caps --------------------------------------------------------------------
{
  // The cap must be decided from the sizes discovery already recorded, so an
  // over-cap selection never opens a file. The reader here throws if called,
  // which is a direct assertion that no bytes were buffered.
  let reads = 0;
  const spy = (dir, rel) => { reads++; return readInSkill(dir, rel); };
  let threw = null;
  try { buildSkillsZip(rows, { read: spy, maxBytes: 64 }); } catch (e) { threw = e; }
  ok('an over-cap selection is refused', threw !== null && threw.status === 413, String(threw));
  ok('…before a single file was read', reads === 0, `${reads} reads`);

  threw = null;
  try { buildSkillsZip(rows, { read: spy, maxEntries: 2 }); } catch (e) { threw = e; }
  ok('an over-count selection is refused', threw !== null && threw.status === 413, String(threw));
  ok('…also before reading anything', reads === 0, `${reads} reads`);

  // …and the same selection under the real cap still builds, so the refusals
  // above are the cap working rather than the function being broken.
  reads = 0;
  const okBuf = buildSkillsZip(rows, { read: spy });
  ok('the same selection under the default cap builds', Buffer.isBuffer(okBuf) && okBuf.length > 0);
  ok('…and it read every bundled file exactly once',
     reads === rows.reduce((n, r) => n + r.files.length, 0), `${reads} reads`);

  threw = null;
  try { buildZip([{ name: 'a.bin', data: Buffer.alloc(1024) }], { maxBytes: 64 }); }
  catch (e) { threw = e; }
  ok('buildZip refuses past its byte cap too', threw !== null && threw.status === 413, String(threw));

  threw = null;
  try {
    buildZip(Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from('x') })),
             { maxEntries: 5 });
  } catch (e) { threw = e; }
  ok('buildZip refuses past its entry cap', threw !== null && threw.status === 413, String(threw));

  // 64 bytes of data is far below the ~1MB a deflate stream would allocate, so
  // a refusal that came after compression would show up as a much larger heap.
  const before = process.memoryUsage().heapUsed;
  let refused = 0;
  for (let i = 0; i < 50; i++) {
    try { buildSkillsZip(rows, { read: spy, maxBytes: 8 }); } catch { refused++; }
  }
  const grew = process.memoryUsage().heapUsed - before;
  ok('50 refusals in a row are all refusals', refused === 50);
  ok('…and cost no meaningful allocation', grew < 32 * 1024 * 1024, `${Math.round(grew / 1024)}KB`);
}

// --- buildZip refuses to write a broken archive ------------------------------
{
  const bad = (entries) => { try { buildZip(entries); return null; } catch (e) { return e; } };
  ok('two entries at one path are refused, not silently merged',
     bad([{ name: 'a.md', data: Buffer.from('1') }, { name: 'a.md', data: Buffer.from('2') }])?.status === 409);
  ok('a file that is also a directory entry is refused',
     bad([{ name: 'a', data: Buffer.from('1') }, { name: 'a/', mode: 0o755 }])?.status === 409);
  ok('a file under a path another entry claims as a file is refused',
     bad([{ name: 'a', data: Buffer.from('1') }, { name: 'a/b.md', data: Buffer.from('2') }])?.status === 409);
  ok('an unsanitised name is refused rather than written raw',
     bad([{ name: '../evil.md', data: Buffer.from('1') }])?.status === 400);
  ok('an empty archive is still a valid archive',
     buildZip([]).length === 22 && buildZip([]).readUInt32LE(0) === 0x06054b50);
}

// --- C5: collisions on the extraction key (NFC + case fold) ------------------
{
  const NFC = 'café';
  const NFD = 'café';
  const bad = (entries) => { try { buildZip(entries); return null; } catch (e) { return e; } };
  ok('C5 buildZip refuses `café` spelled NFC and NFD as two entries',
     bad([{ name: `${NFC}.md`, data: Buffer.from('1') }, { name: `${NFD}.md`, data: Buffer.from('2') }])?.status === 409);
  ok('C5 …and a case-folded pair of directory records',
     bad([{ name: 'Dir/', mode: 0o755 }, { name: 'dir/', mode: 0o755 }])?.status === 409);
  ok('C5 buildZip refuses `a/b` THEN file `a` — the order the old check missed',
     bad([{ name: 'a/b.md', data: Buffer.from('1') }, { name: 'a', data: Buffer.from('2') }])?.status === 409);
  ok('C5 …and still refuses file `a` then `a/b`',
     bad([{ name: 'a', data: Buffer.from('1') }, { name: 'a/b.md', data: Buffer.from('2') }])?.status === 409);
  ok('C5 …while a directory record after its own child is fine',
     bad([{ name: 'a/b.md', data: Buffer.from('1') }, { name: 'a/', mode: 0o755 }]) === null);

  const out = resolveArchivePaths([`x/${NFC}.md`, `x/${NFD}.md`, 'x/STRASSE.md', 'x/straße.md']);
  const keys = out.map((p) => p.normalize('NFC').toLowerCase());
  ok('C5 resolveArchivePaths gives NFC/NFD and ß/SS spellings distinct extraction paths',
     new Set(keys).size === 4, JSON.stringify(out));

  // End to end: two skills whose directory names differ only in normalisation.
  put(H('.claude', 'skills', NFC, 'SKILL.md'), skillMd('Cafe NFC', 'composed', 'nfc-body'));
  put(H('Documents', 'Projects', 'pcafe', '.claude', 'skills', NFD, 'SKILL.md'), skillMd('Cafe NFD', 'decomposed', 'nfd-body'));
  const cafes = listSkills().filter((r) => r.name.normalize('NFC') === NFC);
  ok('C5 the two café skills are discovered as two rows', cafes.length === 2,
     JSON.stringify(cafes.map((r) => r.name)));
  const names = pyRead((() => {
    const zp = path.join(caseDir(), 'cafe.zip');
    fs.writeFileSync(zp, buildSkillsZip(cafes, { read: readInSkill }));
    return zp;
  })()).entries.map((e) => e.name);
  ok('C5 every entry in the café archive is unique after NFC + case fold',
     new Set(names.map((n) => n.normalize('NFC').toLowerCase())).size === names.length, JSON.stringify(names));

  const D = caseDir();
  const zp = path.join(D, 'cafe.zip');
  fs.writeFileSync(zp, buildSkillsZip(cafes, { read: readInSkill }));
  for (const [who, fn] of [['unzip', extractUnzip], ['ditto', extractDitto]]) {
    const dest = path.join(D, who);
    const r = fn(zp, dest);
    const bodies = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else bodies.push(fs.readFileSync(p, 'utf8'));
      }
    };
    walk(dest);
    ok(`C5 ${who}: both café skills survive extraction, neither overwrote the other`,
       r.code === 0 && bodies.length === 2 && bodies.some((b) => b.includes('nfc-body')) && bodies.some((b) => b.includes('nfd-body')),
       `${r.err.slice(0, 120)} ${bodies.length} files`);
  }
}

// --- C10: the preflight counts directory records; reads stop at the cap -------
{
  let reads = 0;
  const spy = (dir, rel, o) => { reads++; return readInSkill(dir, rel, o); };
  const alpha = rows.find((r) => r.name === 'alpha');
  const fileCount = alpha.files.length;
  let threw = null;
  try { buildSkillsZip([alpha], { read: spy, maxEntries: fileCount }); } catch (e) { threw = e; }
  ok('C10 a selection whose FILES fit the entry cap but whose directory records do not is refused',
     threw?.status === 413, String(threw));
  ok('C10 …before a single file was read', reads === 0, `${reads} reads`);

  // A file that grew after discovery: the recorded size is tiny, the real one
  // is 1MB. The reader must stop at the cap, not buffer the whole file first.
  const GROW = H('.claude', 'skills', 'grown');
  put(path.join(GROW, 'SKILL.md'), skillMd('Grown', 'grew after discovery'));
  put(path.join(GROW, 'blob.bin'), 'x');
  const grown = listSkills().find((r) => r.name === 'grown');
  fs.writeFileSync(path.join(GROW, 'blob.bin'), Buffer.alloc(1024 * 1024, 0x61));
  let bytes = 0;
  const io = new Proxy(fs, {
    get(t, k) {
      const v = t[k];
      if (k === 'readSync') return (...a) => { const n = v.apply(t, a); bytes += n; return n; };
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  threw = null;
  try { buildSkillsZip([grown], { read: (d, r, o) => readInSkill(d, r, { ...o, io }), maxBytes: 4096 }); }
  catch (e) { threw = e; }
  ok('C10 a file that grew past the cap after discovery is refused with 413', threw?.status === 413, String(threw));
  ok('C10 …having buffered no more than the cap + 1 byte', bytes <= 4097, `${bytes} bytes read`);

  // A reader that ignores the budget is still caught after each file.
  threw = null;
  try { buildSkillsZip([grown], { read: (d, r) => readInSkill(d, r), maxBytes: 4096 }); } catch (e) { threw = e; }
  ok('C10 …and caught after the file even by a reader that ignores the budget', threw?.status === 413, String(threw));
  fs.rmSync(GROW, { recursive: true, force: true });
}

// --- C4: complete recovery — empty dirs and a 20-deep file ------------------
{
  const COMPLETE = H('.claude', 'skills', 'complete');
  const deepRel = [...Array.from({ length: 20 }, (_, i) => `d${i}`), 'buried.md'];
  put(path.join(COMPLETE, 'SKILL.md'), skillMd('Complete', 'every shape'));
  put(path.join(COMPLETE, ...deepRel), 'buried twenty deep\n');
  put(path.join(COMPLETE, 'bin', 'run.sh'), '#!/bin/sh\necho ok\n', 0o755);
  fs.mkdirSync(path.join(COMPLETE, 'empty-dir'));
  fs.mkdirSync(path.join(COMPLETE, 'nest', 'inner-empty'), { recursive: true });
  fs.chmodSync(path.join(COMPLETE, 'nest', 'inner-empty'), 0o700);
  const complete = listSkills().find((r) => r.name === 'complete');
  ok('C4 the complete fixture is an ordinary exportable row', complete && !complete.broken, complete?.reason);

  const D = caseDir();
  const zp = path.join(D, 'complete.zip');
  const buf = buildSkillsZip([complete, rows.find((r) => r.name === 'alpha')], { read: readInSkill });
  fs.writeFileSync(zp, buf);
  ok('C4 nothing was excluded from the complete bundle', buf.excluded.length === 0, JSON.stringify(buf.excluded));

  // Source tree, in the same shape snapshot() produces, under the archive prefix.
  const source = new Map([...snapshot(COMPLETE)].map(([k, v]) => [`complete/${k}`, v]));
  source.set('complete/', 'dir');
  for (const [who, fn] of [['unzip', extractUnzip], ['ditto', extractDitto]]) {
    const dest = path.join(D, who);
    const r = fn(zp, dest);
    ok(`C4 ${who}: extracts`, r.code === 0, r.err.slice(0, 200));
    const got = new Map([...snapshot(dest)].filter(([k]) => k === 'complete/' || k.startsWith('complete/')));
    ok(`C4 ${who}: the recovered tree is identical to the source — paths, bytes, modes, empty dirs, the 20-deep file`,
       asText(got) === asText(source), `\n--- source\n${asText(source)}\n--- ${who}\n${asText(got)}`);
    ok(`C4 ${who}: the empty directories are really empty`,
       fs.readdirSync(path.join(dest, 'complete', 'empty-dir')).length === 0
       && fs.readdirSync(path.join(dest, 'complete', 'nest', 'inner-empty')).length === 0);
    ok(`C4 ${who}: an empty directory keeps its mode`,
       (fs.lstatSync(path.join(dest, 'complete', 'nest', 'inner-empty')).mode & 0o777) === 0o700,
       (fs.lstatSync(path.join(dest, 'complete', 'nest', 'inner-empty')).mode & 0o777).toString(8));
  }
  fs.rmSync(COMPLETE, { recursive: true, force: true });

  // 33 deep: refused whole, never packed partially.
  const TOO = H('.claude', 'skills', 'too-deep-zip');
  put(path.join(TOO, 'SKILL.md'), skillMd('Too Deep Zip', 'past the limit'));
  put(path.join(TOO, ...Array.from({ length: 33 }, (_, i) => `d${i}`), 'x.md'), 'x\n');
  const too = listSkills().find((r) => r.name === 'too-deep-zip');
  ok('C4 a 33-deep bundle is refused whole: broken, no files', too?.broken === true && too.files.length === 0, too?.reason);
  fs.rmSync(TOO, { recursive: true, force: true });
}

// --- P2: directory collisions are resolved, never merged or dropped ---------
{
  // Fabricated rows: APFS itself refuses to hold `Foo/` and `foo/` side by
  // side, but a bundle from a case-sensitive volume can, and buildSkillsZip
  // never touches the filesystem — `read` supplies the bytes.
  const f = (rel) => ({ rel, size: rel.length, mode: 0o644, mtime: new Date('2024-01-01T00:00:00Z') });
  const e = (rel) => ({ rel, mode: 0o755, mtime: new Date('2024-01-01T00:00:00Z') });
  const row = {
    id: 'dircollide01', name: 'dc', source: 'global-claude', dir: '/nonexistent', broken: false,
    files: [f('Foo/x.md'), f('foo/y.md'), f('bar/z.md'), f('Baz'), f('baz/w.md')],
    emptyDirs: [e('Bar/'), e('Qux/'), e('qux/')],
    excluded: [],
  };
  const read = (dir, rel) => Buffer.from(`content of ${rel}\n`);
  const direct = resolveArchivePaths(['p/Foo/', 'p/foo/', 'p/foo/a.md', 'p/Foo/b.md', 'p/FOO', `q/caf\u00e9/1`, `q/cafe\u0301/1`]);
  ok('P2 resolveArchivePaths separates Foo/ vs foo/, a dir vs a file, and NFC vs NFD directories',
     JSON.stringify(direct) === JSON.stringify(['p/Foo/', 'p/foo-2/', 'p/foo-2/a.md', 'p/Foo/b.md', 'p/FOO-3', `q/caf\u00e9/1`, `q/cafe\u0301-2/1`]),
     JSON.stringify(direct));

  const buf = buildSkillsZip([row], { read });
  const D = caseDir();
  const zp = path.join(D, 'dirs.zip');
  fs.writeFileSync(zp, buf);
  const names = pyRead(zp).entries.map((x) => x.name);
  ok('P2 every entry name in the archive is distinct under NFC + case fold',
     new Set(names.map((n) => n.normalize('NFC').toLowerCase())).size === names.length, JSON.stringify(names));
  for (const [who, fn] of [['unzip', extractUnzip], ['ditto', extractDitto]]) {
    const dest = path.join(D, who);
    const r = fn(zp, dest);
    const files = [], empties = [];
    const walk = (d) => {
      const kids = fs.readdirSync(d, { withFileTypes: true });
      if (!kids.length) empties.push(path.relative(dest, d));
      for (const k of kids) {
        const p = path.join(d, k.name);
        if (k.isDirectory()) walk(p); else files.push(fs.readFileSync(p, 'utf8'));
      }
    };
    walk(dest);
    ok(`P2 ${who}: all five files survive, each with its own bytes — Foo/ vs foo/, bar/ beside empty Bar/, file Baz beside baz/`,
       r.code === 0 && files.length === 5 && ['Foo/x.md', 'foo/y.md', 'bar/z.md', 'Baz', 'baz/w.md'].every((rel) => files.includes(`content of ${rel}\n`)),
       `${r.err.slice(0, 120)} ${JSON.stringify(files)}`);
    ok(`P2 ${who}: all three empty directories survive as three directories — Bar/ beside bar/, Qux/ beside qux/`,
       empties.length === 3, JSON.stringify(empties));
  }
}

// --- C10: the per-bundle cap holds while reading ------------------------------
{
  // Astra's stale-metadata probe: sizes recorded small, then one bundle grows
  // to 75MB across files each under the 8MB file cap. Sparse, so it is fast.
  const STALE = H('.claude', 'skills', 'stale');
  put(path.join(STALE, 'SKILL.md'), skillMd('Stale', 'grew after discovery'));
  for (let k = 0; k < 10; k++) put(path.join(STALE, `part${k}.bin`), 'x');
  const stale = listSkills().find((r) => r.name === 'stale');
  for (let k = 0; k < 10; k++) fs.truncateSync(path.join(STALE, `part${k}.bin`), 7.5 * 1024 * 1024);
  let bytes = 0;
  const io = new Proxy(fs, {
    get(t, k) {
      const v = t[k];
      if (k === 'readSync') return (...a) => { const n = v.apply(t, a); bytes += n; return n; };
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  let threw = null;
  try { buildSkillsZip([stale], { read: (d, r, o) => readInSkill(d, r, { ...o, io }) }); } catch (e) { threw = e; }
  ok('C10 a 75MB bundle whose metadata said a few bytes is refused with 413 at the 64MiB bundle cap',
     threw?.status === 413, String(threw));
  ok('C10 …having buffered no more than the bundle cap + 1 byte', bytes <= 64 * 1024 * 1024 + 1, `${bytes} bytes read`);
  threw = null;
  try { buildSkillsZip([stale], { read: (d, r) => readInSkill(d, r) }); } catch (e) { threw = e; }
  ok('C10 …and caught after the file even by a reader that ignores the budget', threw?.status === 413, String(threw));
  fs.rmSync(STALE, { recursive: true, force: true });
}

// --- the library never shells out --------------------------------------------
{
  const src = fs.readFileSync(new URL('../lib/zip.js', import.meta.url), 'utf8');
  ok('lib/zip.js imports no child_process', !/child_process/.test(src));
  ok('…and calls no spawn/exec', !/\b(spawn|exec|execFile)(Sync)?\s*\(/.test(src));
  ok('…and never touches fs itself — every byte comes through readInSkill',
     !/from 'node:fs'/.test(src) && !/\bfs\./.test(src));
}

// --- the real directories were never touched ---------------------------------
{
  assertRealHomesUnchanged(realBefore, ok);
}

fs.rmSync(fakeHome, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
