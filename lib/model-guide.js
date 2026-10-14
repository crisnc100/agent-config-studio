import fs from 'node:fs';
import path from 'node:path';
import * as history from './history.js';
import { CLAUDE_HOME, CODEX_HOME, GROK_HOME, openUserFile, resolveSafe, tilde } from './paths.js';
import { bad, baseOf, createProposals, sha256 } from './proposals.js';
import { guideText, loadRoles } from './roles.js';

/**
 * The model guide block: one generated, marked block in each harness's
 * global instruction file, rendered from the roles (lib/roles.js guideText).
 *
 *   <!-- acs:model-guide v1 sep=<0-2> sha256:<hex of body> -->
 *   …body…
 *   <!-- /acs:model-guide -->
 *
 * `sep` is how many newlines ACS added before the block, so removing it gives
 * back the original bytes. Every change is a proposal first — the full file
 * before and after — and Accept writes exactly the reviewed bytes, in place
 * (a symlinked file keeps its link and inode), only while the file is still
 * the one proposed against: the same real path, the same (dev, ino), the
 * same raw bytes (lib/proposals.js). Bytes outside the block are copied
 * from the file's buffer.
 */

export const GUIDE_LIMITS = Object.freeze({ fileBytes: 1024 * 1024, proposalTtlMs: 10 * 60_000, proposalsPerTarget: 3 });

/** The three targets, by key; a client names a key, never a path. */
export const TARGETS = Object.freeze({
  claude: { home: CLAUDE_HOME, file: 'CLAUDE.md', label: 'Claude' },
  codex: { home: CODEX_HOME, file: 'AGENTS.md', label: 'Codex' },
  grok: { home: GROK_HOME, file: 'AGENTS.md', label: 'Grok' },
});

const START_RE = /^<!-- acs:model-guide v1 sep=([0-2]) sha256:([0-9a-f]{64}) -->$/;
const END_LINE = '<!-- /acs:model-guide -->';
const MARK = 'acs:model-guide';

/* ── the text: markers, status, edits ──────────────────────────────────── */

/** Each line's content (no terminator) and where it starts and ends in `text`. */
function linesOf(text) {
  const out = [];
  let at = 0;
  while (at <= text.length) {
    const nl = text.indexOf('\n', at);
    const stop = nl === -1 ? text.length : nl;
    const end = stop > at && text[stop - 1] === '\r' ? stop - 1 : stop;
    if (nl === -1 && at === text.length) break;
    out.push({ n: out.length + 1, start: at, end, content: text.slice(at, end) });
    if (nl === -1) break;
    at = nl + 1;
  }
  return out;
}

/** The file's line ending: CRLF if its first line ends that way, else LF. */
export const eolOf = (text) => { const nl = text.indexOf('\n'); return nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n'; };

/** The block for `body` (LF text ending in a newline), in the file's line ending, with no trailing newline. */
export function renderBlock(body, sep, eol = '\n') {
  const lines = body.replace(/\n$/, '').split('\n');
  return [`<!-- ${MARK} v1 sep=${sep} sha256:${sha256(body)} -->`, ...lines, END_LINE].join(eol);
}

/**
 * The file's block and its status against `body`, what guideText renders now
 * (null when the roles are invalid):
 *   absent | current | stale | edited | malformed, or `roles-invalid` for an
 *   intact block that cannot be compared. Any line naming acs:model-guide is
 *   a marker and must match the grammar exactly.
 */
export function inspect(text, body) {
  const marks = linesOf(text).filter((l) => l.content.includes(MARK));
  if (!marks.length) return { status: 'absent' };
  const malformed = (reason, lines) => ({ status: 'malformed', reason, lines });
  const broken = marks.filter((l) => !START_RE.test(l.content) && l.content !== END_LINE);
  if (broken.length) {
    const unknownVersion = broken.some((l) => /acs:model-guide v(?!1 )\S*/.test(l.content));
    return malformed(unknownVersion ? 'a marker names a version this studio does not know' : 'a marker line is damaged', broken.map((l) => l.n));
  }
  const starts = marks.filter((l) => START_RE.test(l.content));
  const ends = marks.filter((l) => l.content === END_LINE);
  if (starts.length > 1) return malformed('there is more than one start marker', starts.map((l) => l.n));
  if (ends.length > 1) return malformed('there is more than one end marker', ends.map((l) => l.n));
  if (!starts.length) return malformed('there is an end marker without a start', ends.map((l) => l.n));
  if (!ends.length) return malformed('there is a start marker without an end', starts.map((l) => l.n));
  const [s] = starts, [e] = ends;
  if (e.n < s.n) return malformed('the end marker comes before the start', [s.n, e.n]);
  const [, sep, hash] = START_RE.exec(s.content);
  const inner = linesOf(text).slice(s.n, e.n - 1).map((l) => l.content);
  const found = inner.length ? `${inner.join('\n')}\n` : '';
  const block = { start: s.start, end: e.end, sep: Number(sep), body: found, lines: [s.n, e.n] };
  if (sha256(found) !== hash) return { status: 'edited', block };
  if (body === null) return { status: 'roles-invalid', block };
  return { status: found === body ? 'current' : 'stale', block };
}

/** Which statuses each action accepts. */
export const ACTIONS = Object.freeze({
  install: ['absent'],
  update: ['stale', 'edited'],
  remove: ['current', 'stale', 'edited', 'roles-invalid'],
});

const BLOCK_PRESENT = new Set(ACTIONS.remove);

const ACTION_REFUSAL = {
  current: 'The model guide is already up to date.',
  absent: 'This file has no model guide block.',
  stale: 'This file already has a model guide block.',
  edited: 'This file already has a model guide block.',
  'roles-invalid': 'The roles are invalid, so the model guide cannot be rendered — fix them in Models → Roles.',
};

/** Trailing `eol`s at the end of `text`, counted up to `max`. */
function trailing(text, eol, max = Infinity) {
  let n = 0;
  for (let at = text.length; n < max && at >= eol.length && text.slice(at - eol.length, at) === eol; at -= eol.length) n++;
  return n;
}

/**
 * The file's bytes after `action`, from the original buffer: everything
 * outside the block is copied byte for byte. `body` is guideText now (null
 * when it cannot be rendered). Throws a status error when the action does
 * not apply.
 */
export function planEdit(buf, action, body, bodyError = null) {
  if (!Object.hasOwn(ACTIONS, action)) throw bad(400, `unknown action ${JSON.stringify(action)} (install, update or remove)`);
  const text = buf ? decode(buf) : '';
  const seen = inspect(text, body);
  if (seen.status === 'malformed') {
    throw bad(409, `The model guide markers are broken (${seen.reason}, line${seen.lines.length > 1 ? 's' : ''} ${seen.lines.join(', ')}). Fix or delete those lines by hand; ACS won't edit this file until then.`, { lines: seen.lines, guideStatus: 'malformed' });
  }
  if (action !== 'remove' && body === null) throw bad(409, `The model guide cannot be rendered: ${bodyError}. Fix it in Models → Roles.`, { guideStatus: seen.status });
  if (!ACTIONS[action].includes(seen.status)) throw bad(409, ACTION_REFUSAL[seen.status] || `Cannot ${action} here (${seen.status}).`, { guideStatus: seen.status });
  const src = buf || Buffer.alloc(0);
  const eol = eolOf(text);
  const at = (i) => Buffer.byteLength(text.slice(0, i));
  let bytes;
  if (action === 'install') {
    const sep = text === '' ? 0 : Math.max(0, 2 - trailing(text, eol, 2));
    bytes = Buffer.concat([src, Buffer.from(eol.repeat(sep) + renderBlock(body, sep, eol) + eol)]);
  } else if (action === 'update') {
    const { block } = seen;
    bytes = Buffer.concat([src.subarray(0, at(block.start)), Buffer.from(renderBlock(body, block.sep, eol)), src.subarray(at(block.end))]);
  } else {
    const { block } = seen;
    const before = text.slice(0, block.start);
    const cut = block.start - trailing(before, eol, block.sep) * eol.length;
    // The end marker's own line ending goes with it; what follows stays.
    let after = block.end;
    if (text.startsWith('\r\n', after)) after += 2; else if (text[after] === '\n') after += 1;
    bytes = Buffer.concat([src.subarray(0, at(cut)), src.subarray(at(after))]);
  }
  return { bytes, status: seen.status, overwritesEdits: seen.status === 'edited' };
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function decode(buf) {
  try { return UTF8.decode(buf); }
  catch { throw bad(409, "This file is not valid UTF-8, so ACS won't edit it.", { guideStatus: 'not-utf8' }); }
}

/* ── the files ─────────────────────────────────────────────────────────── */

const targetPath = (key) => path.join(TARGETS[key].home, TARGETS[key].file);
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** Why a target cannot be used, as a short reason code from a read or resolve failure. */
function reasonOf(e, file) {
  if (e.status === 413) return 'too-large';
  if (/hard links/.test(e.message)) return 'hard-link';
  if (e.message === 'path is protected' || /outside allowed roots/.test(e.message)) return 'unsafe-path';
  if (e.message === 'not a file') return isDir(file) ? 'directory' : 'not-a-file';
  if (e.code === 'EACCES' || e.code === 'EPERM') return 'permission';
  return 'unreadable';
}

const REASON_TEXT = {
  'too-large': `the file is over ${GUIDE_LIMITS.fileBytes / 1024 / 1024} MB`,
  'hard-link': "the file has hard links; ACS won't edit it",
  'unsafe-path': 'the file resolves outside the folders ACS may edit',
  directory: 'a folder is where the file should be',
  'not-a-file': 'that path is not a regular file',
  permission: 'permission denied',
  unreadable: 'the file could not be read',
};

/**
 * One target as it is now: its real path and identity, its bytes, and why
 * it cannot be used when it cannot. Never throws.
 */
function readTarget(key) {
  const t = TARGETS[key];
  const file = targetPath(key);
  const out = { key, label: t.label, file, display: tilde(file), harnessInstalled: isDir(t.home) };
  if (!out.harnessInstalled) return { ...out, state: 'not-installed' };
  let real;
  try { real = resolveSafe(file); } catch (e) { return { ...out, state: 'error', reason: reasonOf(e, file), message: e.message }; }
  out.real = real;
  try {
    const { buf, stat } = openUserFile(real, { maxBytes: GUIDE_LIMITS.fileBytes });
    return { ...out, state: 'file', buf, id: `${stat.dev}:${stat.ino}` };
  } catch (e) {
    if (e.status === 404) return { ...out, state: 'missing', buf: null, id: 'absent' };
    return { ...out, state: 'error', reason: reasonOf(e, real), message: e.message };
  }
}

/** The guide as it renders now, or why it cannot. */
function currentGuide(home) {
  try { return { body: guideText(loadRoles({ home })), error: null }; }
  catch (e) { return { body: null, error: e.message }; }
}

function statusOf(t, guide) {
  if (t.state === 'not-installed') return { status: 'not-installed' };
  if (t.state === 'error') return { status: 'error', reason: t.reason, message: REASON_TEXT[t.reason] || t.message };
  if (t.state === 'missing') return { status: 'absent', newFile: true };
  let text;
  try { text = decode(t.buf); } catch (e) { return { status: 'not-utf8', message: e.message }; }
  const seen = inspect(text, guide.body);
  return seen.status === 'malformed' ? { status: 'malformed', reason: seen.reason, lines: seen.lines } : { status: seen.status };
}

/** Targets that resolve to the same file, by real path: key -> [other keys]. */
function sharing(all) {
  const out = {};
  for (const t of all) {
    if (!t.real) continue;
    const others = all.filter((o) => o !== t && o.real === t.real).map((o) => o.key);
    if (others.length) out[t.key] = others;
  }
  return out;
}

/* ── the service: status, propose, accept ─────────────────────────────── */

let acceptHook = null;
/** A test seam: runs after the baseline and before the last checks. Nothing in the app sets it. */
export function _setAcceptHook(fn) { acceptHook = fn; }

export function createModelGuide({ home, hist = history, now = Date.now, limits = GUIDE_LIMITS } = {}) {
  const store = createProposals({ hist, now, ttlMs: limits.proposalTtlMs, perTarget: limits.proposalsPerTarget, maxBytes: limits.fileBytes });

  const knownKey = (key) => {
    if (typeof key !== 'string' || !Object.hasOwn(TARGETS, key)) throw bad(400, `unknown target ${JSON.stringify(key)} (claude, codex or grok)`);
    return key;
  };

  function status() {
    const guide = currentGuide(home);
    const all = Object.keys(TARGETS).map(readTarget);
    const shared = sharing(all);
    const targets = all.map((t) => ({
      key: t.key,
      label: t.label,
      path: t.display,
      ...(t.real && tilde(t.real) !== t.display ? { linkedTo: tilde(t.real) } : {}),
      harnessInstalled: t.harnessInstalled,
      exists: t.state === 'file',
      ...statusOf(t, guide),
      ...(shared[t.key] ? { sharedWith: shared[t.key] } : {}),
    }));
    for (const t of targets) t.installed = BLOCK_PRESENT.has(t.status);
    return { targets, rolesError: guide.error };
  }

  function propose({ target, action }) {
    const key = knownKey(target);
    const t = readTarget(key);
    if (t.state === 'not-installed') throw bad(409, `${TARGETS[key].label} is not installed here (${tilde(TARGETS[key].home)} does not exist); ACS never creates it.`);
    if (t.state === 'error') throw bad(409, `${t.display}: ${REASON_TEXT[t.reason] || t.message}.`, { reason: t.reason });
    const guide = currentGuide(home);
    const plan = planEdit(t.buf, action, guide.body, guide.error);
    // The result must stay editable: over the cap, a later update or remove could not read it.
    if (plan.bytes.length > limits.fileBytes) {
      throw bad(413, `${t.display} would be ${plan.bytes.length} bytes with the model guide; ACS edits files of at most ${limits.fileBytes / 1024 / 1024} MB.`, { reason: 'too-large' });
    }
    const current = t.buf ? t.buf.toString('utf8') : '';
    const base = baseOf(t.buf);
    const { id, expires } = store.add(key, { key, action, real: t.real, ident: t.id, base, bytes: plan.bytes });
    const shared = sharing(Object.keys(TARGETS).map(readTarget))[key];
    return {
      id, target: key, action, path: t.display, status: plan.status, base,
      current, proposed: plan.bytes.toString('utf8'), newFile: t.state === 'missing',
      overwritesEdits: plan.overwritesEdits, expiresAt: expires, ...(shared ? { sharedWith: shared } : {}),
    };
  }

  const STALE = 'The file changed since this was proposed (an editor, another tab, or another target sharing it). Nothing was written; propose again.';

  async function accept({ id }) {
    const p = store.take(id);
    const where = tilde(p.real);
    const { sha, warnings } = await store.commit(p, {
      locate: () => resolveSafe(targetPath(p.key)),
      stale: STALE,
      hook: async (q) => { if (acceptHook) await acceptHook(q); },
      baselineMessage: `state of ${where} before model guide ${p.action}`,
      recordMessage: `model guide: ${p.action} in ${where}`,
    });
    return { saved: true, target: p.key, action: p.action, sha, warnings, historyError: warnings.length ? warnings.join(' ') : null };
  }

  return { status, propose, accept, reject({ id }) { store.take(id); return { rejected: true }; } };
}
