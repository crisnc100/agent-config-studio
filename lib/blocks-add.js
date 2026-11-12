import { addTargetReal, BLOCK_LIMITS, BLOCKS_DIR, loadBlocks, PACKS_DIR, scanText, sourceFiles, startMarker } from './blocks.js';
import { lineStarts } from './blocks-match.js';
import * as history from './history.js';
import { bad, baseOf, createProposals, sha256 } from './proposals.js';
import { assertNotHardLinked, HISTORY_REPO, openUserFile, resolveSafe, tilde } from './paths.js';

/**
 * Shared rules: add a rule to files that have no copy of it.
 *
 * A request names the rule and the files as the page shows them; the server
 * maps each name through its own list of targets (an instruction file or a
 * skill's SKILL.md that the scan reads, outside the packs by real path, with
 * no copy of that rule), so a path the client spells is never opened.
 * Placement is the skill wizard's layout (lib/skill-wizard.js pasteBlocks): a
 * "## Shared rules" section at the end, or the file's own one, each rule
 * under "### <name>" between block markers. Only bytes are inserted; every
 * existing byte stays, in order.
 *
 * Apply is all or nothing up to the first write: every file's signature
 * (its bytes, where the text goes and the text) is checked, then every old
 * file is saved to history, before any file is written. A write that still
 * fails midway is reported with the files written and not written.
 */

const STALE = 'changed since the preview. Nothing was written; preview it again.';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ADD_MAX_FILES = 200;
const HEADING = /^(#{1,2})\s+shared rules\s*#*$/i;
const FENCE = /^\s*(```|~~~)/;
const END_MARKER = /^<!-- \/block:[a-z0-9][a-z0-9-]{0,63} -->$/;
const oneLine = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

const fileName = (x) => typeof x === 'string' && x && x.length <= 1024 && !/[\u0000-\u001f]/.test(x);

function request(body, { apply = false } = {}) {
  const { rule, files, ...rest } = body || {};
  if (Object.keys(rest).length) throw bad(400, `unknown field "${Object.keys(rest)[0].slice(0, 64)}"`);
  if (typeof rule !== 'string' || !ID_RE.test(rule)) throw bad(400, 'rule must be a shared rule\'s id');
  if (!Array.isArray(files) || !files.length || files.length > ADD_MAX_FILES) throw bad(400, `files must list 1 to ${ADD_MAX_FILES} files`);
  const out = files.map((x) => {
    if (!apply) {
      if (!fileName(x)) throw bad(400, 'each file must be a file as the page shows it');
      return { file: x };
    }
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw bad(400, 'each file must be { file, signature }');
    const { file, signature, ...more } = x;
    if (Object.keys(more).length) throw bad(400, `unknown field "${Object.keys(more)[0].slice(0, 64)}"`);
    if (!fileName(file)) throw bad(400, 'each file must be a file as the page shows it');
    if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) throw bad(400, 'signature must be the preview\'s signature (preview first)');
    return { file, signature };
  });
  if (new Set(out.map((x) => x.file)).size !== out.length) throw bad(400, 'a file is named twice');
  return { rule, files: out };
}

/**
 * Where the rule goes in `buf` and the LF text to insert there. The file's
 * own "# Shared rules" or "## Shared rules" heading (the last one, outside
 * code fences) takes it
 * after the last block under it, else after the section's last line that
 * is not blank; without one, a new section goes at the end. `newline`: the
 * file has no final newline, so the insert starts with one.
 */
function placement(buf, block) {
  const lines = buf.toString('utf8').split('\n').map((l) => l.replace(/\r$/, ''));
  const starts = lineStarts(buf);
  const newline = buf.length > 0 && buf[buf.length - 1] !== 0x0a;
  const item = `\n### ${oneLine(block.name, 120)}\n\n${startMarker(block.id, block.body)}\n${block.body}<!-- /block:${block.id} -->\n`;
  let head = -1, level = 0, fence = false;
  const heads = [];
  // Lines inside a fenced code example: a heading or a marker shown there is an example, never the file's own.
  const fenced = new Set();
  lines.forEach((l, i) => {
    if (FENCE.test(l)) { fence = !fence; return; }
    if (fence) { fenced.add(i); return; }
    const h = /^(#{1,6})\s/.exec(l);
    if (h) heads.push({ i, level: h[1].length });
    const m = HEADING.exec(l.trim());
    if (m) { head = i; level = m[1].length; }
  });
  if (fence) throw bad(409, 'ends inside a code example that is never closed, so the rule would land inside it. Add it by hand.');
  if (head === -1) {
    const ends2 = buf.length >= 2 && buf[buf.length - 1] === 0x0a && (buf[buf.length - 2] === 0x0a || (buf[buf.length - 2] === 0x0d && buf[buf.length - 3] === 0x0a));
    const pre = !buf.length || ends2 ? '' : newline ? '\n\n' : '\n';
    return { offset: buf.length, pre, text: `## Shared rules\n${item}`, heading: 'new', newline };
  }
  const next = heads.find((h) => h.i > head && h.level <= level);
  const stop = next ? next.i : lines.length;
  let anchor = head;
  for (let i = head; i < stop; i++) if (lines[i].trim()) anchor = i;
  for (let i = head; i < stop; i++) if (!fenced.has(i) && END_MARKER.test(lines[i].trim())) anchor = i;
  const atEnd = anchor + 1 >= starts.length;
  return { offset: atEnd ? buf.length : starts[anchor + 1], pre: atEnd && newline ? '\n' : '', text: item, heading: 'existing', newline: atEnd && newline };
}

const eolOf = (buf) => {
  let crlf = 0, lf = 0;
  for (let i = buf.indexOf(0x0a); i !== -1; i = buf.indexOf(0x0a, i + 1)) { if (i > 0 && buf[i - 1] === 0x0d) crlf++; else lf++; }
  return crlf > lf ? '\r\n' : '\n';
};

export function createBlocksAdd({ hist = history, blocksDir = BLOCKS_DIR, where, io } = {}) {
  const store = createProposals({ hist, ttlMs: 0, perTarget: 1, maxBytes: BLOCK_LIMITS.fileBytes, io });
  const packsDir = where?.packsDir ?? PACKS_DIR;

  /** One named file, found in the server's own list, and the bytes it would hold with the rule added. */
  function locate(block, blocks, listed, name) {
    const f = listed.find((x) => x.display === name);
    if (!f) throw bad(403, `${name.slice(0, 200)} is not a file the Shared rules check reads.`);
    let real;
    try { real = addTargetReal(f, packsDir); } catch (e) { throw bad(e.status || 403, e.message); }
    assertNotHardLinked(real);
    const opened = openUserFile(real, { maxBytes: BLOCK_LIMITS.fileBytes });
    const buf = opened.buf;
    const old = scanText(buf.toString('utf8'), blocks);
    if (old.some((c) => c.id === block.id)) throw bad(409, `${name} already has a copy of this rule. Check again.`);

    let place;
    try { place = placement(buf, block); } catch (e) { e.message = `${name} ${e.message}`; throw e; }
    const eol = eolOf(buf);
    const insert = Buffer.from(`${place.pre}${place.text}`.replace(/\n/g, eol), 'utf8');
    const next = Buffer.concat([buf.subarray(0, place.offset), insert, buf.subarray(place.offset)]);

    // Line numbers, 1-based: the inserted text starts on line `at` of the new file (a missing final newline ends the old last line first).
    const before = buf.subarray(0, place.offset);
    let nlBefore = 0;
    for (let i = before.indexOf(0x0a); i !== -1; i = before.indexOf(0x0a, i + 1)) nlBefore++;
    const at = nlBefore + 1 + (place.newline ? 1 : 0);
    const shown = `${place.pre}${place.text}`.slice(place.newline ? 1 : 0).replace(/\n$/, '').split('\n');
    const markerLine = at + shown.findIndex((l) => l.startsWith('<!-- block:'));

    // The new bytes must scan as this rule, marked and matching, where it was put, with every copy that was there before still there.
    const oldLines = buf.toString('utf8').split('\n');
    const now = scanText(next.toString('utf8'), blocks);
    const shift = (n) => (n >= at && !place.newline ? n + shown.length : n);
    const kept = old.every((c) => now.some((x) => x.id === c.id && x.rating === c.rating && x.marked === c.marked && x.line === shift(c.line) && x.endLine === shift(c.endLine)));
    if (!kept || !now.some((x) => x.id === block.id && x.marked && x.rating === 'same' && x.line === markerLine)) {
      throw bad(409, `The studio could not add this rule to ${name} cleanly. Add it by hand.`);
    }

    const ctx = (n) => oldLines[n - 1]?.replace(/\r$/, '');
    const diff = [];
    const prevLine = at - 1;
    if (prevLine >= 1) diff.push({ op: ' ', line: ctx(prevLine) });
    for (const line of shown) diff.push({ op: '+', line });
    if (!place.newline && place.offset < buf.length) diff.push({ op: ' ', line: ctx(at) });
    const signature = sha256(`${block.id}\0${f.display}\0${baseOf(buf)}\0${place.offset}\0${sha256(insert)}`);
    return {
      f, real, opened, next, signature,
      out: { file: f.display, line: at, from: prevLine >= 1 ? prevLine : at, heading: place.heading, newline: place.newline, added: shown, diff, signature },
      markerLine,
    };
  }

  function prepare(req) {
    const blocks = loadBlocks(blocksDir);
    const block = blocks.find((b) => b.id === req.rule);
    if (!block) throw bad(404, 'The studio has no shared rule by that name.');
    return { block, blocks, listed: sourceFiles(where) };
  }

  function preview(body) {
    const req = request(body);
    const { block, blocks, listed } = prepare(req);
    return { rule: block.id, files: req.files.map((r) => locate(block, blocks, listed, r.file).out) };
  }

  async function apply(body) {
    const req = request(body, { apply: true });
    const { block, blocks, listed } = prepare(req);
    const located = [];
    const changed = [];
    for (const r of req.files) {
      let l = null;
      try { l = locate(block, blocks, listed, r.file); } catch (e) { if (e.status !== 409) throw e; }
      if (!l || l.signature !== r.signature) changed.push(r.file); else located.push(l);
    }
    if (changed.length) throw bad(409, `${changed.join(', ')} ${STALE}`, { changed });

    for (const l of located) {
      try { await hist.recordBaseline(l.real, `state of ${l.f.display} before the shared rule ${block.id} was added`); }
      catch (e) { throw bad(500, `Nothing was written: the old ${l.f.display} could not be saved to History first (${e.message}).`); }
    }

    /**
     * Every file still holds the bytes its signature was made from. Synchronous, and run inside the first
     * write's commit with no await before that write: a file changed during the History saves stops them all.
     */
    const allStill = () => {
      const moved = located.filter((l) => {
        try {
          if (resolveSafe(l.f.abs) !== l.real) return true;
          const now = openUserFile(l.real, { maxBytes: BLOCK_LIMITS.fileBytes });
          return `${now.stat.dev}:${now.stat.ino}` !== `${l.opened.stat.dev}:${l.opened.stat.ino}` || baseOf(now.buf) !== baseOf(l.opened.buf);
        } catch { return true; }
      });
      if (moved.length) throw bad(409, `${moved.map((l) => l.f.display).join(', ')} ${STALE}`, { changed: moved.map((l) => l.f.display) });
    };

    const written = [];
    const warnings = [];
    for (const [i, l] of located.entries()) {
      const display = l.f.display;
      const { stat, buf } = l.opened;
      const p = { real: l.real, ident: `${stat.dev}:${stat.ino}`, base: baseOf(buf), bytes: l.next };
      try {
        const r = await store.commit(p, {
          locate: () => resolveSafe(l.f.abs),
          stale: `${display} ${STALE}`,
          recheck: i === 0 ? allStill : null,
          baselineMessage: `state of ${display} before the shared rule ${block.id} was added`,
          recordMessage: `shared rule ${block.id} added to ${display}`,
        });
        warnings.push(...r.warnings);
        written.push({ file: display, line: l.markerLine, sha: r.sha, undo: `To put it back, open ${display} and choose History.` });
      } catch (e) {
        if (!written.length) throw e;
        const notWritten = located.slice(i).map((x) => x.f.display);
        throw bad(e.status || 500, `Added to ${written.map((w) => w.file).join(', ')}: each old version is in History. Not written: ${notWritten.join(', ')} (${e.message}).`,
          { written: written.map((w) => w.file), notWritten });
      }
    }
    return {
      saved: true, rule: block.id, files: written, warnings,
      undo: `The old versions are in History (${tilde(HISTORY_REPO)}): open a file and choose History to put it back.`,
    };
  }

  return { preview, apply };
}
