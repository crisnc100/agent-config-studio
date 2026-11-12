import { BLOCK_LIMITS, BLOCKS_DIR, copySpan, inPacks, loadBlocks, PACK_FILE_WHY, PACKS_DIR, scanText, sourceFiles, startMarker } from './blocks.js';
import { lineDiff } from './describe.js';
import * as history from './history.js';
import { bad, baseOf, createProposals, sha256 } from './proposals.js';
import { assertNotHardLinked, HISTORY_REPO, openUserFile, resolveSafe, tilde } from './paths.js';

/**
 * Shared rules: make one copy of a rule match the studio's text.
 *
 * A request names a copy as the scan reports it — rule id, the file as the
 * page shows it, its first and last line — and the server finds it again by
 * scanning, so only a copy the scan lists, outside the studio's packs, can be
 * written; a path the client spells is never opened. Preview returns the
 * lines that change and a signature over the file's bytes and the new text;
 * apply refuses (409) unless a fresh look gives that signature, saves the old file to
 * history (a failure there stops the write), then writes through the
 * proposals writer, which re-checks identity and bytes with no await before
 * the write.
 */

const STALE = 'The file changed since the preview. Nothing was written; preview it again.';
const MOVED = 'This copy is not where it was: the file changed. Preview it again.';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function request(body, { apply = false } = {}) {
  const { rule, file, line, endLine, signature, ...rest } = body || {};
  if (Object.keys(rest).length) throw bad(400, `unknown field "${Object.keys(rest)[0].slice(0, 64)}"`);
  if (typeof rule !== 'string' || !ID_RE.test(rule)) throw bad(400, 'rule must be a shared rule\'s id');
  if (typeof file !== 'string' || !file || file.length > 1024 || /[\u0000-\u001f]/.test(file)) throw bad(400, 'file must be the copy\'s file as the page shows it');
  for (const [k, v] of [['line', line], ['endLine', endLine]]) if (!Number.isInteger(v) || v < 1) throw bad(400, `${k} must be a line number`);
  if (endLine < line) throw bad(400, 'endLine must not come before line');
  if (apply && (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature))) throw bad(400, 'signature must be the preview\'s signature (preview first)');
  return { rule, file, line, endLine, signature };
}

/**
 * Where each line of `buf` starts, by byte. Lines split at the 0x0A byte,
 * which UTF-8 decoding never moves or merges, so line i here is line i of
 * the decoded text scanText reads, even in a file that is not valid UTF-8.
 */
function lineStarts(buf) {
  const out = [0];
  for (let i = buf.indexOf(0x0a); i !== -1; i = buf.indexOf(0x0a, i + 1)) out.push(i + 1);
  return out;
}

export function createBlocksMatch({ hist = history, blocksDir = BLOCKS_DIR, where, io } = {}) {
  const store = createProposals({ hist, ttlMs: 0, perTarget: 1, maxBytes: BLOCK_LIMITS.fileBytes, io });

  /** The copy the request names, found again by a fresh scan, and the file it would leave behind. */
  function locate(req) {
    const blocks = loadBlocks(blocksDir);
    const block = blocks.find((b) => b.id === req.rule);
    if (!block) throw bad(404, 'The studio has no shared rule by that name.');
    const f = sourceFiles(where).find((x) => x.display === req.file);
    if (!f) throw bad(403, 'That file is not one the Shared rules check reads.');
    if (f.source === 'pack') throw bad(403, PACK_FILE_WHY);
    const real = resolveSafe(f.abs);
    // A link in a skill folder can reach a pack file, which the scan then lists under the skill: judge where it really is.
    if (inPacks(real, where?.packsDir ?? PACKS_DIR)) throw bad(403, PACK_FILE_WHY);
    assertNotHardLinked(real);
    const opened = openUserFile(real, { maxBytes: BLOCK_LIMITS.fileBytes });
    const copies = scanText(opened.buf.toString('utf8'), blocks);
    if (!copies.some((c) => c.id === req.rule)) throw bad(403, 'That file holds no copy of this rule.');
    const c = copies.find((x) => x.id === req.rule && x.line === req.line && x.endLine === req.endLine);
    if (!c) throw bad(409, MOVED);
    if (c.rating === 'same') throw bad(409, 'This copy already matches the studio\'s text. Nothing to change.');
    const span = copySpan(c, copies);
    if (span.why) throw bad(409, span.why);

    // Spliced as bytes: everything outside the copy's lines is copied over untouched, whatever its encoding.
    const buf = opened.buf;
    const starts = lineStarts(buf);
    const from = starts[span.start];
    const after = span.end + 1 < starts.length ? starts[span.end + 1] : buf.length;
    const crlf = (at) => at >= 2 && buf[at - 1] === 0x0a && buf[at - 2] === 0x0d;
    const firstEnd = span.start + 1 < starts.length ? starts[span.start + 1] : buf.length;
    const eol = crlf(firstEnd) ? '\r\n' : '\n';
    const tail = crlf(after) ? 2 : after > 0 && buf[after - 1] === 0x0a ? 1 : 0;
    const added = [startMarker(block.id, block.body), ...block.body.replace(/\n$/, '').split('\n'), `<!-- /block:${block.id} -->`];
    const next = Buffer.concat([buf.subarray(0, from), Buffer.from(added.join(eol), 'utf8'), buf.subarray(after - tail)]);
    // The new text must scan as this rule, matching, where the copy was: anything else is not a safe replacement.
    if (!scanText(next.toString('utf8'), blocks).some((x) => x.id === block.id && x.marked && x.rating === 'same' && x.line === span.start + 1)) {
      throw bad(409, 'The studio could not replace this copy cleanly. Change it by hand.');
    }
    const removed = buf.subarray(from, after - tail).toString('utf8').replace(/\r\n/g, '\n').split('\n');
    // The text written is in the signature too: a rule changed after the preview (an update) is not written unseen.
    const signature = sha256(`${block.id}\0${f.display}\0${c.line}\0${c.endLine}\0${baseOf(buf)}\0${sha256(added.join('\n'))}`);
    return { f, real, opened, span, removed, added, next, signature };
  }

  function preview(body) {
    const req = request(body);
    const l = locate(req);
    return {
      file: l.f.display, line: l.span.start + 1, endLine: l.span.end + 1,
      removed: l.removed, added: l.added, diff: lineDiff(l.removed.join('\n'), l.added.join('\n')), signature: l.signature,
    };
  }

  async function apply(body) {
    const req = request(body, { apply: true });
    let l;
    try { l = locate(req); } catch (e) { if (e.message === MOVED) e.message = STALE; throw e; }
    if (l.signature !== req.signature) throw bad(409, STALE);
    const display = l.f.display;
    try { await hist.recordBaseline(l.real, `state of ${display} before a shared rule was made to match`); }
    catch (e) { throw bad(500, `Nothing was written: the old ${display} could not be saved to History first (${e.message}).`); }
    const { stat, buf } = l.opened;
    const p = { real: l.real, ident: `${stat.dev}:${stat.ino}`, base: baseOf(buf), bytes: l.next };
    const { sha, warnings } = await store.commit(p, {
      locate: () => resolveSafe(l.f.abs),
      stale: STALE,
      baselineMessage: `state of ${display} before a shared rule was made to match`,
      recordMessage: `shared rule ${req.rule} now matches in ${display}`,
    });
    return {
      saved: true, file: display, line: l.span.start + 1, sha, warnings,
      undo: `The old version is in History (${tilde(HISTORY_REPO)}): open ${display} and choose History to put it back.`,
    };
  }

  return { preview, apply };
}
