/**
 * A hand-rolled ZIP writer.
 *
 * Zero dependencies is the constraint, so the archive format is implemented
 * here rather than pulled in. The cost of that is that every detail a real
 * extractor cares about has to be right, and `unzip -t` passing does not prove
 * it: a CRC-valid archive can still hand back mangled names, lose the
 * executable bit, or drop a file whose path collided with another. The rules
 * below each exist because one of those failures is otherwise silent.
 *
 *  - Names are measured in BYTES. `Buffer.byteLength`, never String#length: a
 *    skill named `résumé` is 8 bytes and 6 characters, and a header claiming 6
 *    truncates the name and desynchronises every following record.
 *  - General purpose bit 11 is set whenever a name is not pure ASCII, which is
 *    what tells an extractor the bytes are UTF-8 rather than CP437. Without it
 *    macOS and Windows each guess, and they guess differently.
 *  - Local header and central directory carry the same method, flags, CRC,
 *    sizes and name. `ditto` reads the central directory and `unzip` cross-checks
 *    both, so a disagreement extracts on one and fails on the other.
 *  - Sizes are known before a record is written, so the data-descriptor bit (3)
 *    is never set and no descriptor is emitted. Setting the bit without the
 *    trailing record is the classic way to produce an archive that only some
 *    extractors accept.
 *  - `version made by` declares UNIX (3), because that is what makes the high 16
 *    bits of the external attributes a st_mode. Declare 0 (FAT) and the mode is
 *    ignored — scripts/run.sh extracts 0644 and the skill stops working.
 *  - Anything past the classic limits (0xFFFFFFFF sizes/offsets, 0xFFFF entries
 *    or name bytes) is REFUSED. ZIP64 is out of scope for this build, and
 *    truncating a field to fit is how you get an archive that looks fine and
 *    extracts garbage.
 *
 * CRC-32 is computed from a table built here rather than with the crc32 helper
 * zlib exposes: that function only landed in Node 20.15, package.json declares
 * `>=20`, and a stock Node 20 would throw on a machine we never tested.
 */
import zlib from 'node:zlib';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const VERSION_STORE = 10;   // 1.0 — stored entries and directories
const VERSION_DEFLATE = 20; // 2.0 — deflate
const MADE_BY_UNIX = (3 << 8) | VERSION_DEFLATE;

const FLAG_UTF8 = 0x0800; // general purpose bit 11

const MAX_ENTRIES = 0xffff;
const MAX_U32 = 0xffffffff;
const MAX_NAME_BYTES = 0xffff;

/** Defaults sized for a skill selection, not for a disk image. */
export const ZIP_LIMITS = {
  maxEntries: 20000,
  maxBytes: 256 * 1024 * 1024,
};

const tooBig = (msg) => Object.assign(new Error(msg), { status: 413, expected: true });
const badName = (msg) => Object.assign(new Error(msg), { status: 400, expected: true });
const conflict = (msg) => Object.assign(new Error(msg), { status: 409, expected: true });

// --- CRC-32 ------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// --- names -------------------------------------------------------------------

/**
 * Windows refuses to create these no matter what follows the first dot, so an
 * archive containing `CON.md` extracts everywhere except the one place the
 * recipient is most likely to be.
 */
const DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/**
 * Bytes that must not appear raw in a segment. `%` leads the list because it is
 * the escape character: escaping it first is what makes the encoding injective,
 * so `a:b` and `a%3Ab` cannot both come out as `a%3Ab` and silently become one
 * file. Everything else is either illegal on a common filesystem (`\ : * ? " < > |`
 * on Windows, `/` as the separator) or a path-parsing hazard (NUL, control
 * characters, DEL).
 */
const ESCAPE = new Set(['%', '\\', ':', '*', '?', '"', '<', '>', '|']);
const escByte = (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;

function encodeSegment(seg) {
  let out = '';
  for (const ch of seg) {
    const code = ch.codePointAt(0);
    if (ESCAPE.has(ch) || code < 0x20 || code === 0x7f) out += escByte(ch);
    else out += ch;
  }

  // Trailing dots and spaces are silently stripped by Windows, which turns
  // `notes.` and `notes` into the same file. Encode the run rather than trim it,
  // so the two stay distinct and the original name is still legible.
  const m = out.match(/[. ]+$/);
  if (m) out = out.slice(0, -m[0].length) + [...m[0]].map(escByte).join('');

  // `.` and `..` fall out of the rule above: both are pure trailing dots, so
  // they are already encoded and can no longer be read as traversal.

  const stem = out.split('.')[0].toUpperCase();
  if (DEVICE_NAMES.has(stem)) out = escByte(out[0]) + out.slice(1);

  return out;
}

/**
 * Is `name` already safe to write into an archive?
 *
 * Deliberately a separate predicate rather than `name === sanitizeEntryName(name)`.
 * The encoding cannot be idempotent — `%` has to be escaped for the mapping to
 * be injective, so re-running it on its own output escapes the escapes — and a
 * writer that demanded a fixed point would refuse every name it had just
 * produced.
 */
export function isSafeEntryName(name) {
  if (typeof name !== 'string' || name === '') return false;
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) return false;
  const body = name.endsWith('/') ? name.slice(0, -1) : name;
  if (body.startsWith('/')) return false;
  const segs = body.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return false;
  if (segs.some((s) => /[\\:*?"<>|]/.test(s) || /[\u0000-\u001f\u007f]/.test(s))) return false;
  if (segs.some((s) => /[. ]$/.test(s))) return false;
  if (segs.some((s) => DEVICE_NAMES.has(s.split('.')[0].toUpperCase()))) return false;
  return true;
}

/**
 * Make `name` safe to hand an extractor, without ever merging two distinct
 * inputs into one output.
 *
 * Structurally impossible names throw; hostile-but-real ones are encoded.
 * The split matters: a macOS filename may legally contain a backslash or a
 * colon, so refusing those would refuse real skills, while an absolute path or
 * an empty segment cannot come from a bundle walk and means something upstream
 * is wrong.
 */
export function sanitizeEntryName(name) {
  if (typeof name !== 'string' || name === '') throw badName('an entry name is required');
  const isDir = name.endsWith('/');
  const body = isDir ? name.slice(0, -1) : name;
  if (body.startsWith('/')) throw badName(`absolute entry name: ${JSON.stringify(name)}`);

  const segs = body.split('/');
  if (segs.some((s) => s === '')) throw badName(`empty path segment: ${JSON.stringify(name)}`);

  const out = segs.map(encodeSegment).join('/') + (isDir ? '/' : '');
  if (Buffer.byteLength(out, 'utf8') > MAX_NAME_BYTES) {
    throw tooBig(`entry name is longer than ${MAX_NAME_BYTES} bytes`);
  }
  // Self-check: the encoder and the predicate must not drift apart, or the
  // writer starts refusing names the sanitiser just blessed.
  if (!isSafeEntryName(out)) throw badName(`could not make ${JSON.stringify(name)} safe`);
  return out;
}

/**
 * The key two names collide on at extraction time. NFC because macOS writes
 * `café` whichever normalisation form the archive used, so NFC and NFD
 * spellings are one file there; case-folded because a default macOS or
 * Windows volume is case-insensitive. toUpperCase first folds the expanding
 * cases (`ß` -> `SS` -> `ss`) that toLowerCase alone leaves distinct —
 * over-matching only costs a `-2` suffix, under-matching costs a file.
 */
export const pathKey = (s) => s.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');

/**
 * The prefix each selected skill's files live under.
 *
 * Plain `<name>/` while it is unambiguous; `<source>__<name>/` once two
 * selected skills share a name; a numeric suffix if THAT still collides — which
 * it does the moment two copies of `decision` come from the same source, or
 * someone has a skill literally named `global__decision`. Every prefix handed
 * out is recorded as taken, so the output is distinct by construction rather
 * than by the naming scheme being clever enough.
 */
const SOURCE_TOKEN = {
  'global-claude': 'global',
  'global-codex': 'codex',
  'global-agents': 'agents',
  'project': 'project',
  'garman-homes': 'garman',
};

export function planSkillPrefixes(skills) {
  const counts = new Map();
  for (const s of skills) counts.set(pathKey(s.name), (counts.get(pathKey(s.name)) || 0) + 1);

  const taken = new Set();
  const out = new Map();
  for (const s of skills) {
    const token = SOURCE_TOKEN[s.source] || s.source;
    const base = counts.get(pathKey(s.name)) > 1 ? `${token}__${s.name}` : s.name;
    let candidate = sanitizeEntryName(base);
    let n = 1;
    while (taken.has(pathKey(candidate))) candidate = `${sanitizeEntryName(base)}-${++n}`;
    taken.add(pathKey(candidate));
    out.set(s.id, candidate);
  }
  return out;
}

/**
 * Final extraction paths for a whole selection.
 *
 * Two separate hazards, and a numeric suffix settles both: a path already used
 * by another entry, and a path whose parent directory another entry claims as a
 * FILE (`x/scripts` beside `x/scripts/run.sh` — the second extractor to arrive
 * either fails or wins, depending on which one you use).
 *
 * Comparison is on pathKey() because the recipient's filesystem is probably
 * case- and normalisation-insensitive: `Notes.md` and `notes.md`, or `café`
 * spelled NFC and NFD, are two files here and one file on a default macOS
 * volume, and the second would overwrite the first.
 */
export function resolveArchivePaths(paths) {
  const sanitized = paths.map(sanitizeEntryName);

  // Directories are reserved up front, from the whole selection, because a file
  // sitting where another entry needs a directory CANNOT be fixed by renaming
  // it later — `x/scripts/run.sh` would keep colliding with the file `x/scripts`
  // however many times its basename is suffixed. Fixing the file instead, once,
  // against a set that no longer moves, terminates.
  const usedDirs = new Set();
  for (const p of sanitized) {
    const lc = pathKey(p);
    let at = -1;
    while ((at = lc.indexOf('/', at + 1)) !== -1) usedDirs.add(lc.slice(0, at));
  }

  const usedFiles = new Set(); // pathKey()s of full paths
  const out = [];

  for (const safe of sanitized) {
    const slash = safe.lastIndexOf('/');
    const dir = slash === -1 ? '' : safe.slice(0, slash + 1);
    const base = safe.slice(slash + 1);
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';

    let candidate = safe;
    let n = 1;
    const clashes = (c) => usedFiles.has(pathKey(c)) || usedDirs.has(pathKey(c));
    while (clashes(candidate)) candidate = `${dir}${stem}-${++n}${ext}`;

    usedFiles.add(pathKey(candidate));
    out.push(candidate);
  }
  return out;
}

// --- the archive -------------------------------------------------------------

/**
 * DOS date/time, which is what the format stores: local time, two-second
 * resolution, and an epoch of 1980. Anything outside the representable window
 * is clamped rather than wrapped — a 1970 mtime encoded literally yields a
 * negative year field and extractors report a file from 2038 or refuse it.
 */
function dosDateTime(mtime) {
  const d = mtime instanceof Date ? mtime : new Date(mtime ?? Date.now());
  const t = Number.isFinite(d.getTime()) ? new Date(d.getTime()) : new Date();
  const floor = new Date(1980, 0, 1, 0, 0, 0);
  const ceil = new Date(2107, 11, 31, 23, 59, 58);
  const clamped = t < floor ? floor : t > ceil ? ceil : t;
  const date = ((clamped.getFullYear() - 1980) << 9) | ((clamped.getMonth() + 1) << 5) | clamped.getDate();
  const time = (clamped.getHours() << 11) | (clamped.getMinutes() << 5) | (clamped.getSeconds() >> 1);
  return { date, time };
}

const isAscii = (s) => !/[^\x00-\x7f]/.test(s);

/**
 * Build the archive.
 *
 * `entries` are `{ name, data, mode, mtime }`; a name ending in `/` (or an entry
 * with no data) is a directory record, which is how an empty directory survives
 * the round trip at all — extractors create parents implicitly, so a directory
 * with nothing in it exists only if it has its own record.
 *
 * Names arrive already sanitised and de-conflicted (see `resolveArchivePaths`).
 * This function re-checks uniqueness and file/directory conflicts on pathKey()
 * and throws rather than writing them, because an archive with two entries at
 * one path is a silent data-loss bug at extraction time, not at build time.
 * The file-versus-parent check runs in both directions — `a/b` then `a` is
 * the same conflict as `a` then `a/b` — so the verdict never depends on order.
 */
export function buildZip(entries, opts = {}) {
  const maxEntries = opts.maxEntries ?? ZIP_LIMITS.maxEntries;
  const maxBytes = opts.maxBytes ?? ZIP_LIMITS.maxBytes;

  if (!Array.isArray(entries)) throw badName('entries must be an array');
  if (entries.length > maxEntries || entries.length > MAX_ENTRIES) {
    throw tooBig(`too many entries: ${entries.length}`);
  }

  // The cap is checked against the declared input sizes BEFORE anything is
  // compressed or copied, so an over-cap request costs a loop, not a buffer.
  let declared = 0;
  for (const e of entries) {
    declared += e?.data ? e.data.length : 0;
    if (declared > maxBytes) throw tooBig(`selection is larger than the ${maxBytes}-byte cap`);
  }

  const files = new Set();
  const dirs = new Set();
  const parents = new Set(); // every ancestor any entry so far implies
  const parts = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const name = e.name;
    if (!isSafeEntryName(name)) throw badName(`unsafe entry name: ${JSON.stringify(name)}`);
    const isDir = name.endsWith('/');
    const lc = pathKey(name);
    const key = isDir ? lc.slice(0, -1) : lc;
    if (files.has(key)) throw conflict(`two entries resolve to the same path: ${name}`);
    if (isDir && dirs.has(key)) throw conflict(`duplicate directory entry: ${name}`);
    if (!isDir && dirs.has(key)) throw conflict(`${name} is also a directory entry`);
    if (!isDir && parents.has(key)) throw conflict(`${name} is also a parent directory of another entry`);
    if (isDir) dirs.add(key); else files.add(key);
    let at = -1;
    while ((at = key.indexOf('/', at + 1)) !== -1) {
      if (files.has(key.slice(0, at))) throw conflict(`a parent directory of ${name} is also a file`);
      parents.add(key.slice(0, at));
    }

    const nameBuf = Buffer.from(name, 'utf8');
    const flags = isAscii(name) ? 0 : FLAG_UTF8;
    const { date, time } = dosDateTime(e.mtime);

    const raw = isDir ? Buffer.alloc(0) : Buffer.from(e.data ?? Buffer.alloc(0));
    if (raw.length > MAX_U32) throw tooBig(`entry is larger than 4GB: ${name}`);

    let method = 0;
    let body = raw;
    if (!isDir && raw.length > 0) {
      const deflated = zlib.deflateRawSync(raw, { level: 9 });
      // Deflate can grow incompressible bytes. Storing is then both smaller and
      // faster to extract, and `version needed` drops to 1.0 with it.
      if (deflated.length < raw.length) { method = 8; body = deflated; }
    }
    if (body.length > MAX_U32) throw tooBig(`compressed entry is larger than 4GB: ${name}`);

    const crc = isDir ? 0 : crc32(raw);
    const mode = e.mode != null ? (e.mode & 0o7777) : (isDir ? 0o755 : 0o644);
    const modeBits = mode | (isDir ? 0o040000 : 0o100000); // S_IFDIR / S_IFREG
    const versionNeeded = method === 8 ? VERSION_DEFLATE : VERSION_STORE;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(versionNeeded, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    parts.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(CENTRAL_SIG, 0);
    cen.writeUInt16LE(MADE_BY_UNIX, 4);
    cen.writeUInt16LE(versionNeeded, 6);
    cen.writeUInt16LE(flags, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30); // extra
    cen.writeUInt16LE(0, 32); // comment
    cen.writeUInt16LE(0, 34); // disk number start
    cen.writeUInt16LE(0, 36); // internal attributes
    cen.writeUInt32LE(((modeBits & 0xffff) >>> 0) * 0x10000 + (isDir ? 0x10 : 0), 38);
    if (offset > MAX_U32) throw tooBig('archive is larger than 4GB');
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + body.length;
    if (offset > maxBytes + (1 << 20)) throw tooBig(`archive exceeds the ${maxBytes}-byte cap`);
  }

  const centralBuf = Buffer.concat(central);
  if (centralBuf.length > MAX_U32 || offset > MAX_U32) throw tooBig('archive is larger than 4GB');

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);  // this disk
  eocd.writeUInt16LE(0, 6);  // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...parts, centralBuf, eocd]);
}

// --- the skills glue ---------------------------------------------------------

/**
 * How many directory records a skill's files will need: its prefix plus every
 * ancestor of every file. Counted by the preflights, because they are entries
 * too — a selection whose files fit the entry cap can still overflow it.
 */
export function dirRecordCount(files) {
  const dirs = new Set(['']);
  for (const f of files) {
    const segs = String(f.rel ?? '').split('/');
    for (let k = 1; k < segs.length; k++) dirs.add(segs.slice(0, k).join('/'));
  }
  return dirs.size;
}

/**
 * Pack selected skill rows.
 *
 * Every byte comes through `readInSkill`, never `fs`: that reader is where the
 * containment rule lives, and an export path that opened files itself would be
 * a second door into the same bundles with none of the checks on it.
 *
 * The cap is enforced twice. First from the sizes discovery recorded, counting
 * directory records as entries, so an over-cap selection is refused without a
 * single file being opened. Then WHILE reading: `read` is handed a shared
 * budget and stops at it, and the running total is checked after every file
 * as well, because the recorded sizes can be stale — a file that grew since
 * discovery must not be buffered past the cap before anyone notices.
 *
 * The returned Buffer carries `.excluded`: every name a selected bundle did
 * not ship (links, protected names, empty or too-deep directories), prefixed
 * by skill, so the caller can say what the archive is missing.
 */
export function buildSkillsZip(rows, opts = {}) {
  const maxBytes = opts.maxBytes ?? ZIP_LIMITS.maxBytes;
  const maxEntries = opts.maxEntries ?? ZIP_LIMITS.maxEntries;
  const read = opts.read;
  if (typeof read !== 'function') throw new Error('buildSkillsZip requires a read(dir, rel) function');

  const usable = rows.filter((r) => !r.broken && r.files && r.files.length);
  const prefixes = planSkillPrefixes(usable);

  let planned = 0;
  let count = 0;
  for (const r of usable) {
    count += dirRecordCount(r.files);
    if (count > maxEntries) throw tooBig(`selection has more than ${maxEntries} entries`);
    for (const f of r.files) {
      count++;
      planned += f.size;
      if (planned > maxBytes) throw tooBig(`selection is larger than the ${maxBytes}-byte cap`);
      if (count > maxEntries) throw tooBig(`selection has more than ${maxEntries} files`);
    }
  }

  const wanted = [];
  for (const r of usable) for (const f of r.files) wanted.push(`${prefixes.get(r.id)}/${f.rel}`);
  const finalPaths = resolveArchivePaths(wanted);

  // Directory records for every ancestor, in order: extractors create parents
  // implicitly, but a recorded directory is what carries its mode, and it is
  // also what makes `ditto` and `unzip` agree on an otherwise-empty tree.
  const budget = { remaining: maxBytes };
  let readBytes = 0;
  const entries = [];
  const seenDirs = new Set();
  let i = 0;
  for (const r of usable) {
    for (const f of r.files) {
      const full = finalPaths[i++];
      const segs = full.split('/');
      for (let k = 1; k < segs.length; k++) {
        const dir = segs.slice(0, k).join('/') + '/';
        if (seenDirs.has(pathKey(dir))) continue;
        seenDirs.add(pathKey(dir));
        entries.push({ name: dir, mode: 0o755, mtime: f.mtime });
      }
      const data = read(r.dir, f.rel, { budget });
      readBytes += data.length;
      if (readBytes > maxBytes) throw tooBig(`selection is larger than the ${maxBytes}-byte cap`);
      entries.push({
        name: full,
        data,
        mode: f.mode != null ? f.mode : 0o644,
        mtime: f.mtime,
      });
    }
  }

  const excluded = [];
  for (const r of usable) {
    for (const x of r.excluded || []) excluded.push({ rel: `${prefixes.get(r.id)}/${x.rel}`, reason: x.reason });
  }
  return Object.assign(buildZip(entries, { maxBytes, maxEntries }), { excluded });
}
