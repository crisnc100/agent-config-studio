/**
 * The file layer under the pack installer (lib/packs.js): hashes, snapshots,
 * atomic writes through links, verified backups, the state file and its lock,
 * and the three surgical text edits an uninstall falls back on (a marked
 * block, a TOML writable_roots entry, the worktree .zshrc stanza).
 *
 * Nothing here decides what to install. Every function either reads, or
 * writes exactly the path it is given.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const sha = (buf) => `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;

/**
 * Where a write to `p` lands: through every link, including a dangling one,
 * resolved via the nearest parent that exists. A dotfiles-managed file stays
 * a link; its target gets the bytes.
 */
export function realFile(p) {
  p = path.resolve(p);
  try { return fs.realpathSync(p); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) return realFile(path.resolve(path.dirname(p), fs.readlinkSync(p)));
  const parent = path.dirname(p);
  return parent === p ? p : path.join(realFile(parent), path.basename(p));
}

/** Where a link at `p` itself lives: its folder resolved, its own name kept. */
export const linkHome = (p) => path.join(realFile(path.dirname(path.resolve(p))), path.basename(p));

/**
 * What is at a path. `link: true` looks at the entry itself (a runtime hook
 * link); otherwise links are followed to the file that holds the bytes.
 */
export function snapshot(p, { link = false } = {}) {
  const at = link ? linkHome(p) : realFile(p);
  const st = fs.lstatSync(at, { throwIfNoEntry: false });
  if (!st) return null;
  if (st.isSymbolicLink()) return { type: 'link', target: fs.readlinkSync(at) };
  if (!st.isFile()) throw new Error(`${p} is not a plain file`);
  return { type: 'file', bytes: fs.readFileSync(at), mode: st.mode & 0o777 };
}

export const hashSnap = (s) => (!s ? 'absent' : s.type === 'link' ? `link:${s.target}` : sha(s.bytes));

/** The folders `p` needs that do not exist yet, outermost first. */
export function missingDirs(p) {
  const out = [];
  for (let d = path.dirname(path.resolve(p)); ; d = path.dirname(d)) {
    if (fs.existsSync(d)) break;
    out.unshift(d);
    if (path.dirname(d) === d) break;
  }
  return out;
}

export function writeAtomic(p, bytes, mode = 0o644) {
  const target = realFile(p);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.acs-pack-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, bytes, { mode, flag: 'wx' });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } finally { fs.rmSync(tmp, { force: true }); }
}

export function writeLink(p, target) {
  const at = linkHome(p);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  const tmp = `${at}.acs-pack-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  try { fs.symlinkSync(target, tmp); fs.renameSync(tmp, at); }
  finally { fs.rmSync(tmp, { force: true }); }
}

/** Put a snapshot back: bytes and mode, a link, or nothing at all. */
export function restoreSnap(p, snap, { link = false } = {}) {
  if (!snap) {
    // unlink, not rm: rmSync follows a dangling link to nothing and leaves the link behind.
    try { fs.unlinkSync(link ? linkHome(p) : realFile(p)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return;
  }
  if (snap.type === 'link') writeLink(p, snap.target);
  else writeAtomic(p, snap.bytes, snap.mode);
}

/**
 * Copy `snap` into the backup folder and read it back. Returns the backup
 * path (null for a link, whose target is kept in the state instead). Any
 * mismatch throws, so the caller aborts before writing.
 */
export function saveBackup(dir, index, realPath, snap) {
  if (!snap || snap.type === 'link') return null;
  const out = path.join(dir, String(index), realPath.replace(/^\/+/, ''));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, snap.bytes, { mode: 0o600, flag: 'wx' });
  if (!fs.readFileSync(out).equals(snap.bytes)) throw new Error(`backup of ${realPath} does not match`);
  return out;
}

/** A backup's bytes, refused unless they still hash to what was saved. */
export function readBackup(rec) {
  if (rec.type === 'link') return { type: 'link', target: rec.target };
  const bytes = fs.readFileSync(rec.backup);
  if (sha(bytes) !== rec.hash) throw new Error(`backup ${rec.backup} changed since it was taken`);
  return { type: 'file', bytes, mode: rec.mode };
}

/* ── state and its lock ──────────────────────────────────────────────── */

export const emptyState = () => ({ version: 1, packs: {}, runtime: null });

export function readState(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return emptyState(); throw e; }
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new Error(`${file} is not valid JSON (${e.message}) — fix or remove it; nothing was changed`); }
  if (!doc || typeof doc !== 'object' || doc.version !== 1 || !doc.packs || typeof doc.packs !== 'object') {
    throw new Error(`${file} is not a pack state file this version understands — nothing was changed`);
  }
  return { runtime: null, ...doc };
}

export function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

const LOCK_WAIT_MS = 120_000;
const LOCK_STALE_MS = 15 * 60_000;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
let inProcess = Promise.resolve();

/**
 * Run `fn` holding `<state>.lock` — the roots.json pattern (lib/roots.js
 * withLock: an exclusive create, a crashed writer's lock taken over), made
 * async so the studio's event loop keeps running while a CLI install holds
 * it, and queued in-process so two calls from one process never contend. A
 * lock is stale when its pid is gone or it is older than LOCK_STALE_MS.
 */
export function withStateLock(stateFile, fn, { waitMs = LOCK_WAIT_MS } = {}) {
  const run = inProcess.then(() => locked(stateFile, fn, waitMs));
  inProcess = run.then(() => {}, () => {});
  return run;
}

async function locked(stateFile, fn, waitMs) {
  const lock = `${stateFile}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = 0, age = 0;
      try { pid = Number.parseInt(fs.readFileSync(lock, 'utf8'), 10); age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
      if ((pid > 0 && !alive(pid)) || age > LOCK_STALE_MS) { try { fs.unlinkSync(lock); } catch {} continue; }
      if (Date.now() > deadline) throw new Error(`pack state is locked by another install (pid ${pid}, ${lock}) — try again`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try { return await fn(); }
  finally { try { fs.unlinkSync(lock); } catch {} }
}

/* ── the marked instruction block ────────────────────────────────────── */

const blockBegin = (id) => `<!-- acs-pack:${id} begin -->`;
const blockEnd = (id) => `<!-- acs-pack:${id} end -->`;

/** The block's span and body, null when absent; a half block or two of them throw. */
export function findBlock(text, id) {
  const lines = text.split(/(?<=\n)/);
  const starts = [], ends = [];
  let at = 0;
  const offsets = lines.map((l) => { const o = at; at += l.length; return o; });
  lines.forEach((l, i) => {
    if (l.replace(/\r?\n$/, '') === blockBegin(id)) starts.push(i);
    if (l.replace(/\r?\n$/, '') === blockEnd(id)) ends.push(i);
  });
  if (!starts.length && !ends.length) return null;
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    throw new Error(`the acs-pack:${id} block markers are broken (a begin or end line is missing or repeated) — fix them by hand first`);
  }
  const start = offsets[starts[0]], end = offsets[ends[0]] + lines[ends[0]].length;
  return { start, end, text: text.slice(start, end), body: lines.slice(starts[0] + 1, ends[0]).join('') };
}

export const renderBlock = (id, body) => `${blockBegin(id)}\n${body.endsWith('\n') ? body : `${body}\n`}${blockEnd(id)}\n`;

/** The block put in place, or appended after one blank line; nothing else moves. */
export function upsertBlock(text, id, body) {
  const block = renderBlock(id, body);
  const found = findBlock(text, id);
  if (found) return text.slice(0, found.start) + block + text.slice(found.end);
  if (!text) return block;
  return `${text}${text.endsWith('\n') ? '' : '\n'}\n${block}`;
}

/**
 * The block taken out, with the blank line upsertBlock set it off by: one
 * newline goes when a blank line before it would otherwise meet the end of
 * the file or another blank line after it.
 */
export function removeBlock(text, id) {
  const found = findBlock(text, id);
  if (!found) return text;
  const before = text.slice(0, found.start), after = text.slice(found.end);
  return before.endsWith('\n\n') && (!after || after.startsWith('\n')) ? before.slice(0, -1) + after : before + after;
}

/* ── a Codex config.toml writable_roots entry ────────────────────────── */

const TABLE = 'sandbox_workspace_write';

/** Each `[table]` header line's span. */
function headers(text) {
  return [...text.matchAll(/^[ \t]*\[\[?[^\n]*\]\]?[ \t]*(?:#[^\n]*)?(?:\r?\n|$)/gm)].map((m) => ({
    start: m.index, end: m.index + m[0].length,
    name: m[0].trim().replace(/\s+#.*$/, '').replace(/^\[+|\]+$/g, '').trim(),
  }));
}

/** The [sandbox_workspace_write] table's body span, and its writable_roots array if it has one. */
function locate(text) {
  const hs = headers(text);
  const i = hs.findIndex((h) => h.name === TABLE || h.name === `"${TABLE}"`);
  const outside = (i < 0 ? text : text.slice(0, hs[i].start) + text.slice(hs[i + 1]?.start ?? text.length));
  if (/^[ \t]*"?sandbox_workspace_write"?[ \t]*[.=]/m.test(outside) || hs.some((h) => h.name.startsWith(`${TABLE}.`))) {
    throw new Error(`config.toml sets ${TABLE} in a form this installer does not edit (a dotted key or an inline table) — add the entry by hand`);
  }
  if (i < 0) return null;
  const bodyStart = hs[i].end, bodyEnd = hs[i + 1]?.start ?? text.length;
  const body = text.slice(bodyStart, bodyEnd);
  const key = /^[ \t]*writable_roots[ \t]*=[ \t]*\[/m.exec(body);
  if (!key) return { bodyStart, bodyEnd, array: null };
  const open = bodyStart + key.index + key[0].length - 1;
  let j = open + 1, close = -1;
  for (; j < text.length; j++) {
    const c = text[j];
    if (c === '"' || c === "'") { const q = c; j++; while (j < text.length && text[j] !== q) { if (q === '"' && text[j] === '\\') j++; j++; } continue; }
    if (c === '#') { while (j < text.length && text[j] !== '\n') j++; continue; }
    if (c === '[') throw new Error('config.toml writable_roots holds a nested array — add the entry by hand');
    if (c === ']') { close = j; break; }
  }
  if (close < 0) throw new Error('config.toml writable_roots has no closing ] — fix it first');
  const items = [...text.slice(open + 1, close).matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'/g)].map((m) => (m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2]));
  return { bodyStart, bodyEnd, array: { open, close, items } };
}

export const hasRoot = (text, value) => locate(text)?.array?.items.includes(value) ?? false;

/** `value` added to writable_roots, creating the key or the table as needed; `how` says which. */
export function addRoot(text, value) {
  const at = locate(text);
  const lit = JSON.stringify(value);
  if (at?.array?.items.includes(value)) return { text, how: 'present' };
  if (at?.array) {
    const { open, close } = at.array;
    const inner = text.slice(open + 1, close);
    const trimmed = inner.replace(/\s+$/, '');
    const tail = inner.slice(trimmed.length);
    const glue = !trimmed.trim() ? '' : trimmed.trim().endsWith(',') ? ' ' : ', ';
    return { text: text.slice(0, open + 1) + trimmed + glue + lit + tail + text.slice(close), how: 'entry' };
  }
  const line = `writable_roots = [${lit}]\n`;
  if (at) return { text: text.slice(0, at.bodyStart) + line + text.slice(at.bodyStart), how: 'key' };
  const sep = !text ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return { text: `${text}${sep}[${TABLE}]\n${line}`, how: 'table' };
}

/**
 * `value` taken out of writable_roots. `how` is what the install did: a key or
 * a table it created goes too once nothing else is left in it.
 */
export function removeRoot(text, value, how = 'entry') {
  const at = locate(text);
  if (!at?.array?.items.includes(value)) return text;
  const { open, close } = at.array;
  const lit = JSON.stringify(value);
  const inner = text.slice(open + 1, close);
  let s = inner.indexOf(lit);
  if (s < 0) return text;   // written another way (a literal string): someone else's entry
  let e = s + lit.length;
  const after = /^\s*,[ \t]*/.exec(inner.slice(e));
  if (after) e += after[0].length;
  else { const before = /,\s*$/.exec(inner.slice(0, s)); if (before) s -= before[0].length; }
  const rest = inner.slice(0, s) + inner.slice(e);
  let out = text.slice(0, open + 1) + rest + text.slice(close);
  if (rest.trim() || how === 'entry') return out;
  out = out.replace(/^[ \t]*writable_roots[ \t]*=[ \t]*\[\s*\][ \t]*\r?\n?/m, '');
  if (how !== 'table') return out;
  const left = locate(out);
  if (left && !out.slice(left.bodyStart, left.bodyEnd).trim()) {
    const header = headers(out).find((h) => h.end === left.bodyStart);
    let s2 = header.start;
    if (left.bodyEnd === out.length && out.slice(0, s2).endsWith('\n\n')) s2 -= 1;
    out = out.slice(0, s2) + out.slice(left.bodyEnd);
  }
  return out;
}

/* ── the worktree .zshrc stanza (bin/install-worktree.mjs MARK_BEGIN/END) ─ */

export const ZSH_BEGIN = '# >>> agent-config-studio worktree tools >>>';
export const ZSH_END = '# <<< agent-config-studio worktree tools <<<';

export function hasStanza(text) {
  const lines = text.split('\n');
  const b = lines.findIndex((l) => l.trim() === ZSH_BEGIN);
  return b >= 0 && lines.slice(b).some((l) => l.trim() === ZSH_END);
}

export function removeStanza(text) {
  const lines = text.split(/(?<=\n)/);
  const b = lines.findIndex((l) => l.trim() === ZSH_BEGIN);
  if (b < 0) return text;
  const e = lines.findIndex((l, i) => i > b && l.trim() === ZSH_END);
  if (e < 0) throw new Error('the worktree tools block in .zshrc has no end marker — remove it by hand');
  return lines.slice(0, b).join('') + lines.slice(e + 1).join('');
}
