import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as history from './history.js';
import { assertWritable, openUserFile, tilde } from './paths.js';
import { expectWrite } from './watch.js';

/**
 * The propose → accept write path that the model guide (lib/model-guide.js)
 * and the audit (lib/audit.js) share, and only what both need.
 *
 * A proposal is the exact bytes a file will hold, reviewed as a full diff.
 * Accept writes those bytes in place — a symlinked file keeps its link and
 * inode — and only while the file is still the one proposed against: the same
 * real path, the same (dev, ino), the same raw bytes. Proposals live in
 * memory, expire, are single-use, and a target holds only a few at a time.
 */

/** A refusal; `payload` rides along in the error response (server.js). */
export const bad = (status, message, payload = {}) => Object.assign(new Error(message), { status, payload });
export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
export const baseOf = (buf) => (buf === null ? 'absent' : `sha256:${sha256(buf)}`);
const identOf = (st) => `${st.dev}:${st.ino}`;

/** Write all of `bytes` over what `fd` holds. A write that makes no progress is an error, never a loop. */
function putAll(io, fd, bytes) {
  io.ftruncateSync(fd, 0);
  for (let off = 0; off < bytes.length;) {
    const n = io.writeSync(fd, bytes, off, bytes.length - off, off);
    if (!(n > 0)) throw new Error(`short write (${off} of ${bytes.length} bytes)`);
    off += n;
  }
}

/**
 * The bytes, in place: the descriptor written is the file just checked.
 * Synchronous. `preimage` is what the file held at that check; on any failure
 * — a write error, a short write, or bytes that do not read back as written —
 * the preimage is written back through the same descriptor and the error says
 * so. `io` exists for the fault-injection tests; nothing in the app passes it.
 */
export function writeInPlace(p, preimage, { io = fs, stale = 'The file changed since this was proposed.' } = {}) {
  if (p.ident === 'absent') return createNew(p, io);
  const where = tilde(p.real);
  const fd = io.openSync(p.real, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const st = io.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || identOf(st) !== p.ident) throw bad(409, stale);
    let failure = null;
    try { putAll(io, fd, p.bytes); } catch (e) { failure = e; }
    if (!failure) {
      try {
        const back = openUserFile(p.real);
        if (identOf(back.stat) !== p.ident || sha256(back.buf) !== sha256(p.bytes)) failure = new Error('the file did not read back as written');
      } catch (e) { failure = e; }
    }
    if (failure) {
      try { putAll(io, fd, preimage); }
      catch (e) {
        throw bad(500, `Writing ${where} failed (${failure.message}), and putting its previous contents back failed too (${e.message}). Restore it from History.`, { restored: false });
      }
      throw bad(500, `Writing ${where} failed (${failure.message}); its previous contents were put back.`, { restored: true });
    }
  } finally { io.closeSync(fd); }
}

/**
 * A file that did not exist: created exclusively, written, read back. On any
 * failure the partial file — the one this call created, by identity — is
 * removed again, and the error says so.
 */
function createNew(p, io) {
  const where = tilde(p.real);
  const fd = io.openSync(p.real, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o644);
  let ident = null, failure = null;
  try {
    ident = identOf(io.fstatSync(fd));
    putAll(io, fd, p.bytes);
  } catch (e) { failure = e; }
  finally { io.closeSync(fd); }
  if (!failure) {
    try {
      const back = openUserFile(p.real);
      if (identOf(back.stat) !== ident || sha256(back.buf) !== sha256(p.bytes)) failure = new Error('the file did not read back as written');
    } catch (e) { failure = e; }
  }
  if (!failure) return;
  try {
    const st = fs.lstatSync(p.real);
    if (identOf(st) === ident) fs.unlinkSync(p.real);
    else throw new Error('another file is there now');
  } catch (e) {
    throw bad(500, `Creating ${where} failed (${failure.message}), and removing the partial file failed too (${e.message}).`, { restored: false });
  }
  throw bad(500, `Creating ${where} failed (${failure.message}); the partial file was removed.`, { restored: true });
}

/**
 * A proposal store and the accept around it. `perTarget` caps live
 * proposals per `group` (a target key, a file ref): the oldest is evicted.
 */
export function createProposals({ hist = history, now = Date.now, ttlMs, perTarget, maxBytes, io = fs } = {}) {
  const proposals = new Map();
  const queues = new Map();
  const prune = () => { for (const [id, p] of proposals) if (p.expires <= now()) proposals.delete(id); };

  /** One accept at a time per real file, so aliases of one file queue together. */
  function serialized(real, fn) {
    const run = (queues.get(real) || Promise.resolve()).then(fn, fn);
    const tail = run.then(() => {}, () => {});
    queues.set(real, tail);
    tail.then(() => { if (queues.get(real) === tail) queues.delete(real); });
    return run;
  }

  /** Store `rec` ({real, ident, base, bytes, …}) under a fresh id. */
  function add(group, rec) {
    prune();
    const mine = [...proposals].filter(([, p]) => p.group === group);
    while (mine.length >= perTarget) proposals.delete(mine.shift()[0]);
    const id = crypto.randomBytes(16).toString('hex');
    const expires = now() + ttlMs;
    proposals.set(id, { ...rec, group, expires });
    return { id, expires };
  }

  /** The live proposal under `id`, left in place — for a check that must not spend it. */
  function peek(id) {
    prune();
    const p = typeof id === 'string' && /^[0-9a-f]{32}$/.test(id) ? proposals.get(id) : null;
    if (!p) throw bad(410, 'This proposal expired or was already used. Propose it again.');
    return p;
  }

  function take(id) {
    const p = peek(id);
    proposals.delete(id);
    return p;
  }

  /**
   * The file is still the one proposed against: same real path, identity and
   * bytes. Synchronous. Returns the bytes it holds now — the preimage.
   */
  function stillSame(p, locate, stale) {
    if (locate() !== p.real || assertWritable(p.real) !== p.real) throw bad(409, stale);
    if (p.ident === 'absent') {
      let there = true;
      try { fs.lstatSync(p.real); } catch (e) { if (e.code === 'ENOENT') there = false; else throw e; }
      if (there) throw bad(409, stale);
      return null;
    }
    let opened;
    try { opened = openUserFile(p.real, { maxBytes }); }
    catch (e) { throw bad(409, `${stale} (${e.message})`); }
    if (identOf(opened.stat) !== p.ident || baseOf(opened.buf) !== p.base) throw bad(409, stale);
    return opened.buf;
  }

  /**
   * Accept a taken proposal: baseline into history, then — with no await
   * between them — the re-check, the caller's own `recheck`, and the write;
   * then history records the accepted bytes. `locate()` says where the
   * target resolves now. History failures are warnings: the write stands.
   */
  function commit(p, { locate, stale, hook = null, recheck = null, baselineMessage, recordMessage }) {
    const where = tilde(p.real);
    return serialized(p.real, async () => {
      if (locate() !== p.real) throw bad(409, stale);
      const warnings = [];
      if (p.ident !== 'absent') {
        try { await hist.recordBaseline(p.real, baselineMessage); }
        catch (e) { warnings.push(`The previous ${where} was not versioned first: ${e.message}`); }
      }
      if (hook) await hook(p);
      // No await from here to the write.
      const preimage = stillSame(p, locate, stale);
      if (recheck) recheck(p);
      writeInPlace(p, preimage, { io, stale });
      expectWrite(p.real, p.ident === 'absent' ? 'added' : 'changed', sha256(p.bytes));
      let sha = null;
      // The accepted bytes, not a re-read: an edit landing while history waits is not ours to commit.
      try { sha = await hist.record(p.real, recordMessage, { content: p.bytes }); }
      catch (e) { warnings.push(`${where} was written, but not versioned in history: ${e.message}`); }
      return { sha, warnings };
    });
  }

  return { add, peek, take, commit };
}

/**
 * A new file in folders that may not exist yet, every one of them owned
 * (builds/skill-wizard S2, S3): the skill wizard's write.
 *
 * `base` is a real directory that must already exist. Each of `dirs` is
 * created one component at a time with a non-recursive mkdir; an existing
 * one is used only if it is a real directory, never a link. The LAST of
 * `dirs` must not exist at all — its mkdir is the claim, and a folder already
 * there (even an empty one) refuses with 409. `file` is then created
 * O_EXCL | O_NOFOLLOW inside it, written, and read back.
 *
 * Every component on the way is lstat'd, its identity recorded, and the
 * whole chain re-proved — still a real directory, the same (dev, ino), its
 * realpath exactly its own path — immediately before and after each mkdir
 * and the open. `allowed(path)` runs before each of them too: the caller's
 * check that the location is still writable now (assertWritable). On any
 * failure, the file and the folders THIS call created are removed again, by
 * identity, newest first; anything else is left alone.
 *
 * `seam(step, path)` is a test hook between the checks and each syscall
 * (the swap tests); nothing in the app passes it.
 */
export function createInNewDirs({ base, dirs, file, bytes, allowed, io = fs, seam = null }) {
  const refuse = (status, message) => bad(status, message);
  const chain = [];
  const made = [];
  const realOf = (p) => (io === fs ? fs.realpathSync.native(p) : io.realpathSync(p));
  const prove = () => {
    for (const c of chain) {
      let st;
      try { st = io.lstatSync(c.path); } catch { throw refuse(409, `${tilde(c.path)} changed during the create.`); }
      if (st.isSymbolicLink() || !st.isDirectory() || identOf(st) !== c.ident) throw refuse(409, `${tilde(c.path)} changed during the create.`);
      let real;
      try { real = realOf(c.path); } catch { throw refuse(409, `${tilde(c.path)} changed during the create.`); }
      if (real !== c.path) throw refuse(409, `${tilde(c.path)} changed during the create.`);
    }
  };
  const claimDir = (p, st) => {
    if (st.isSymbolicLink()) throw refuse(403, `${tilde(p)} is a symbolic link; ACS creates skills only in real folders.`);
    if (!st.isDirectory()) throw refuse(409, `${tilde(p)} is not a folder.`);
    let real;
    try { real = realOf(p); } catch (e) { throw refuse(409, `${tilde(p)} changed during the create (${e.code || e.message}).`); }
    if (real !== p) throw refuse(403, `${tilde(p)} resolves somewhere else; ACS creates skills only in real folders.`);
    chain.push({ path: p, ident: identOf(st) });
  };
  const lstatOrNull = (p) => { try { return io.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

  let target = null;
  let failure = null;
  try {
    if (typeof base !== 'string' || !path.isAbsolute(base)) throw refuse(400, 'no base folder');
    const bst = lstatOrNull(base);
    if (!bst) throw refuse(404, `${tilde(base)} does not exist.`);
    claimDir(base, bst);
    let cur = base;
    dirs.forEach((seg, i) => {
      if (typeof seg !== 'string' || !seg || seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\0')) throw refuse(400, `refusing folder name ${JSON.stringify(seg)}`);
      const p = path.join(cur, seg);
      const last = i === dirs.length - 1;
      prove();
      const st = lstatOrNull(p);
      if (st && last) throw refuse(409, `${tilde(p)} already exists. Pick another name.`);
      if (st) { claimDir(p, st); cur = p; return; }
      allowed(p);
      seam?.('mkdir', p);
      try { io.mkdirSync(p, 0o755); }
      catch (e) {
        if (e.code === 'EEXIST' && last) throw refuse(409, `${tilde(p)} already exists. Pick another name.`);
        if (e.code === 'EEXIST') { claimDir(p, io.lstatSync(p)); cur = p; return; }
        throw e;
      }
      const now = io.lstatSync(p);
      made.push({ path: p, ident: identOf(now), dir: true });
      claimDir(p, now);
      prove();
      cur = p;
    });
    target = path.join(cur, file);
    prove();
    allowed(target);
    seam?.('open', target);
    const fd = io.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o644);
    try {
      made.push({ path: target, ident: identOf(io.fstatSync(fd)), dir: false });
      putAll(io, fd, bytes);
    } finally { io.closeSync(fd); }
    prove();
    const st = io.lstatSync(target);
    if (identOf(st) !== made[made.length - 1].ident || realOf(target) !== target) throw refuse(409, `${tilde(target)} changed during the create.`);
    const back = openUserFile(target);
    if (identOf(back.stat) !== made[made.length - 1].ident || sha256(back.buf) !== sha256(bytes)) throw new Error('the file did not read back as written');
    return { real: target };
  } catch (e) { failure = e; }

  const leftover = [];
  for (const m of made.reverse()) {
    try {
      const st = io.lstatSync(m.path);
      if (identOf(st) !== m.ident) { leftover.push(tilde(m.path)); continue; }
      if (m.dir) io.rmdirSync(m.path); else io.unlinkSync(m.path);
    } catch (e) { if (e.code !== 'ENOENT') leftover.push(tilde(m.path)); }
  }
  if (leftover.length) {
    throw bad(500, `${failure.message} Cleaning up failed too; left in place: ${leftover.join(', ')}.`, { restored: false });
  }
  if (failure.status) throw Object.assign(failure, { payload: { ...failure.payload, restored: true } });
  throw bad(500, `Creating ${tilde(target || base)} failed (${failure.message}); nothing was left behind.`, { restored: true });
}
