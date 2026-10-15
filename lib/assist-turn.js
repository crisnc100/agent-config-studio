import fs from 'node:fs';
import { ASSIST_LIMITS, entryPath, factsText, lookup, readAttached, readEntry, searchManifest, sizeOf } from './assist-files.js';
import { buildTurn, newNonce, parseEdits, parseRequests } from './chat.js';

/**
 * One user message in Assist chat, end to end, on the server
 * (builds/assist-auto-files F9–F11):
 *
 *   round 0      the user's message, with the manifest on a session's first
 *                turn, the facts, and the files in context;
 *   rounds 1–2   when a round's final text holds @@NEED / @@FIND lines, ACS
 *                loads and searches, says so (`status`, `loaded`, `searched`
 *                events), and continues the same CLI session with them.
 *
 * A reply with any request line is a request: its prose and edit blocks are
 * discarded (documented choice; tests/assist-turn.mjs). The third round can
 * no longer ask. A request that adds nothing new ends the loop: that reply,
 * request lines removed, is the answer. One child at a time; the request is
 * checked for a disconnect before every spawn, and a closed request kills the
 * child and stops the loop.
 *
 * A round that may still ask is never streamed: its text is held until it is
 * classified (a `progress` event counts characters meanwhile), and only a
 * final round's text reaches the client. A round that can no longer ask
 * streams as it arrives.
 *
 * Context per round is attached ∪ pulled in, re-read every round, planned by
 * stat before any byte is read: the oldest pulled-in files are dropped first
 * to fit the per-turn cap, and a dropped file is not read. A pulled-in file
 * is re-read only up to the bytes counted when it was loaded — one that grew
 * is refused, not re-counted. Only files in context may be edited, and only
 * those whose class ACS edits (lib/chat-proposals.js).
 *
 * The user's removals are one set of keys, compared by resolved path, and
 * `blocked` may be a live set the server adds to while this runs (POST
 * /api/chat/block): a file removed mid-turn is not read, searched or
 * proposed against from that moment.
 */

const ORIGIN_LABEL = { attached: 'attached', loaded: 'pulled in by Assist' };

/** The client's list of strings, bounded. */
const strings = (v, max = 200) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length < 1024).slice(0, max) : []);

const realOf = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };

/** Request lines out of a reply that is being used as the answer anyway. */
const withoutRequests = (text) => text.split('\n').filter((l) => !/^[ \t]*@@(NEED|FIND)[ \t]+/.test(l)).join('\n').trim();

export async function runChatTurn({
  message, mentions, sessionId: startSession, seed, harness, model, cwd,
  carried: carriedIn, blocked: blockedIn,
  streamTurnFn, assistFiles, proposals, send, isClosed, setActive, succeeded, remember,
  limits = ASSIST_LIMITS,
}) {
  if (isClosed()) return;
  const manifest = await assistFiles.manifest();
  if (isClosed()) return;

  // One key per removal: the resolved path, whichever way the client named it.
  const blockedRaw = blockedIn instanceof Set ? blockedIn : new Set(strings(blockedIn));
  const keyCache = new Map();
  const keyOf = (b) => {
    if (!keyCache.has(b)) keyCache.set(b, manifest.byDisplay.get(b)?.real ?? (b.startsWith('/') ? realOf(b) : b));
    return keyCache.get(b);
  };
  const isBlocked = (real) => { for (const b of blockedRaw) if (keyOf(b) === real) return true; return false; };

  const notes = [];
  const refused = [];
  const dropped = [];
  let readBytes = 0;   // every byte read for context, every round of this message

  // Files Assist pulled in on earlier turns, carried by the client: held to
  // the manifest again, never trusted as paths.
  const loaded = [];   // { entry, counted, buf? } in load order
  for (const p of strings(carriedIn, limits.filesPerMessage * 4)) {
    const hit = lookup(manifest, p);
    if (hit.error) { notes.push(`${p} is no longer available (${hit.error}) and was dropped.`); continue; }
    if (isBlocked(hit.entry.real)) continue;
    if (mentions.includes(hit.entry.real) || loaded.some((l) => l.entry.real === hit.entry.real)) continue;
    loaded.push({ entry: hit.entry, counted: null });
  }

  let msgFiles = 0, msgBytes = 0;
  let sessionId = startSession;
  let round = 0;
  let found = [];
  let searchedTotal = 0;
  const searchReasons = new Set();
  const seenFinds = new Set();
  const stats = { contextTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };
  let anyStats = false;
  let rateLimit = null;

  const live = () => loaded.filter((l) => !isBlocked(l.entry.real));
  const loadedView = () => live().map(({ entry }) => ({ display: entry.display, readOnly: entry.readOnly, cls: entry.cls, kind: entry.kind }));

  /** This round's files: planned by stat under the per-turn cap, then read — only what is kept. */
  const assemble = () => {
    const turnNotes = [];
    const att = mentions.filter((abs) => !isBlocked(abs)).map((abs) => ({ abs, size: sizeOf(abs) }));
    const pulled = live().map((l) => ({ l, size: sizeOf(entryPath(l.entry)) }));
    const sum = () => [...att, ...pulled].reduce((n, f) => n + (f.size ?? 0), 0);
    while (sum() > limits.turnBytes && pulled.length) {
      const drop = pulled.shift();
      loaded.splice(loaded.indexOf(drop.l), 1);
      turnNotes.push(`${drop.l.entry.display} was dropped from context: this turn's files would pass ${limits.turnBytes / 1024} KB.`);
    }
    while (sum() > limits.turnBytes && att.length) {
      const drop = att.pop();
      turnNotes.push(`${drop.abs.split('/').pop()} (attached) is too large to send with the rest this turn and was left out.`);
    }
    const files = [];
    for (const { abs, size } of att) {
      try {
        if (size === null) throw new Error('no such file');
        if (size > limits.fileBytes) throw new Error(`larger than ${limits.fileBytes / 1024} KB`);
        const f = readAttached(abs, size, manifest);
        readBytes += f.buf.length;
        files.push({ label: f.display, path: f.real, text: f.text, buf: f.buf, cls: f.cls, origin: 'attached', readOnly: f.readOnly, why: whyOf(f.cls) });
      } catch (e) {
        const why = e.status === 413 ? 'it changed size while it was read' : e.message;
        files.push({ label: abs, path: abs, text: '', origin: 'attached', readOnly: true, why: `unreadable: ${why}`, unreadable: why });
      }
    }
    for (const { l, size } of pulled) {
      const e = l.entry;
      const base = { label: e.display, path: e.real, text: '', cls: e.cls, origin: 'loaded' };
      try {
        let buf, text;
        if (l.buf) { ({ buf, text } = l); delete l.buf; delete l.text; }
        else {
          if (size === null) throw new Error('no such file');
          // A pulled-in file is re-read up to what was counted for it, never more.
          const cap = l.counted ?? Math.min(size, limits.fileBytes);
          if (size > cap) throw Object.assign(new Error('grew'), { status: 413 });
          ({ buf, text } = readEntry(e, cap));
          readBytes += buf.length;
          l.counted ??= buf.length;
        }
        files.push({ ...base, text, buf, readOnly: e.readOnly, why: whyOf(e.cls) });
      } catch (err) {
        const why = err.status === 413 ? 'it grew since it was loaded; ask for it again' : err.message;
        files.push({ ...base, readOnly: true, why: `unreadable: ${why}`, unreadable: why });
        turnNotes.push(`${e.display} was not sent: ${why}.`);
      }
    }
    return { files, notes: turnNotes };
  };

  /** Act on one round's requests. True when the round added something new. */
  const handleRequests = (req) => {
    let progress = false;
    const roundRefused = [];
    for (const asked of [...new Set(req.need)]) {
      const hit = lookup(manifest, asked);
      if (hit.error) { roundRefused.push({ path: asked, reason: hit.error }); continue; }
      const e = hit.entry;
      if (isBlocked(e.real)) {
        roundRefused.push({ path: asked, reason: 'the user removed this file from the session; only they can add it back' });
        continue;
      }
      if (loaded.some((l) => l.entry.real === e.real) || mentions.includes(e.real)) continue;   // already in context
      if (msgFiles >= limits.filesPerMessage) { roundRefused.push({ path: asked, reason: `the ${limits.filesPerMessage}-file limit for one message was reached` }); continue; }
      const left = limits.loadedBytesPerMessage - msgBytes;
      const size = sizeOf(entryPath(e));
      const over = `over the ${limits.loadedBytesPerMessage / 1024} KB loading limit for one message`;
      if (size === null) { roundRefused.push({ path: asked, reason: 'no such file' }); continue; }
      if (size > Math.min(limits.fileBytes, left)) { roundRefused.push({ path: asked, reason: size > limits.fileBytes ? `larger than ${limits.fileBytes / 1024} KB` : over }); continue; }
      let r;
      try { r = readEntry(e, size); }
      catch (err) {
        roundRefused.push({ path: asked, reason: err.status === 413 ? 'it changed size while it was read' : err.message });
        continue;
      }
      msgFiles++;
      msgBytes += r.buf.length;
      readBytes += r.buf.length;
      loaded.push({ entry: e, counted: r.buf.length, buf: r.buf, text: r.text });
      progress = true;
    }
    const roundFound = [];
    for (const q of [...new Set(req.find.map((x) => x.slice(0, limits.queryChars)))]) {
      if (q.trim().length < 2) { roundRefused.push({ path: `@@FIND ${q}`, reason: 'a search needs at least 2 characters' }); continue; }
      if (seenFinds.has(q.toLowerCase())) continue;
      seenFinds.add(q.toLowerCase());
      const res = searchManifest(manifest, q, { limits, skip: (e) => isBlocked(e.real) });
      searchedTotal = Math.max(searchedTotal, res.searched);
      for (const r of res.reasons) searchReasons.add(r);
      roundFound.push(res);
      send({ t: 'searched', query: q, searched: res.searched, matched: res.matched, partial: res.partial, reasons: res.reasons });
      progress = true;
    }
    found = roundFound;
    refused.push(...roundRefused);
    for (const r of roundRefused) notes.push(`Not loaded: ${r.path} — ${r.reason}.`);
    send({ t: 'loaded', files: loadedView(), refused: roundRefused });
    return progress;
  };

  const scopeOf = () => {
    const n = live().length;
    const parts = [];
    if (seenFinds.size) parts.push(`Searched ${searchedTotal} file${searchedTotal === 1 ? '' : 's'}`);
    if (n || seenFinds.size) parts.push(`loaded ${n}`);
    if (!parts.length) return null;
    let line = parts.join(' · ');
    line = line[0].toUpperCase() + line.slice(1);
    const reasons = [...searchReasons];
    if (reasons.length) line += ` · partial (${reasons.join('; ')})`;
    return { searched: seenFinds.size ? searchedTotal : null, loaded: n, partial: reasons.length > 0, reasons, line };
  };

  let noteFinal = null;
  for (;;) {
    if (isClosed()) return;
    const isFirst = !sessionId;
    const requests = round < limits.requestRounds;
    const { files, notes: turnNotes } = assemble();
    dropped.push(...turnNotes);
    const prompt = buildTurn({
      message, files, nonce: newNonce(),
      manifest: isFirst || round > 0 ? manifest.text : null,
      facts: factsText(), found, notes: [...notes, ...turnNotes],
      isFirst, seed: isFirst ? seed : null,
      continuation: round > 0, requests,
    });
    notes.length = 0;
    if (round > 0) send({ t: 'round', n: round });

    // A round that may ask is held whole until it is classified; one that cannot streams.
    let held = '';
    const onDelta = (piece) => {
      if (!requests) return send({ t: 'delta', text: piece });
      held += piece;
      send({ t: 'progress', chars: held.length });
    };
    if (isClosed()) return;
    const turn = streamTurnFn({ message, mentions, sessionId, seed: isFirst ? seed : null, model, cwd, harness, prompt }, onDelta);
    setActive(turn);
    let result;
    try { result = await turn.done; }
    catch (e) { send({ t: 'error', message: e.message, loaded: loadedView() }); return; }
    finally { setActive(null); }
    if (isClosed()) return;

    if (result.stats) {
      anyStats = true;
      stats.contextTokens = result.stats.contextTokens || stats.contextTokens;
      stats.outputTokens += result.stats.outputTokens || 0;
      stats.costUsd += result.stats.costUsd || 0;
      stats.durationMs += result.stats.durationMs || 0;
    }
    rateLimit = result.rateLimit ?? rateLimit;
    const ok = succeeded(result);
    let text = result.text || '';
    if (ok && result.sessionId) remember(result.sessionId);

    // Only a round that worked can ask; a failed round's @@ lines are ignored.
    const req = ok ? parseRequests(text) : { any: false };
    if (ok && req.any && requests) {
      if (!result.sessionId) {
        send({ t: 'error', message: 'Assist asked for files, but the CLI reported no session to continue in. Nothing more was run.', loaded: loadedView() });
        return;
      }
      sessionId = result.sessionId;
      send({ t: 'status', phase: 'finding' });
      if (handleRequests(req)) { round++; continue; }
      // Nothing new: the loop ends here, and this reply is the answer.
      text = withoutRequests(text);
      noteFinal = text ? 'Assist asked for nothing new, so this is its answer.' : 'Assist asked for nothing new and gave no answer. Try rephrasing the request.';
    } else if (ok && req.any) {
      text = withoutRequests(text);
      noteFinal = 'Assist asked for more files after its limit; nothing more was loaded.';
    }
    if (requests && text) send({ t: 'delta', text });

    const out = (ok ? parseEdits(text, files) : []).map((p) => {
      if (p.error || !p.file) return { path: p.path, display: p.display, error: p.error, refused: p.refused === true, origin: files.find((f) => f.label === p.display)?.origin };
      const f = p.file;
      if (isBlocked(f.path)) return { path: f.path, display: f.label, origin: f.origin, refused: true, error: 'You removed this file from the session, so nothing is proposed for it.' };
      return proposals.propose(p, { real: f.path, display: f.label, cls: f.cls, origin: f.origin, shown: f.buf });
    });
    send({
      t: 'done',
      ok,
      text: ok ? text : (result.text || ''),
      sessionId: ok ? result.sessionId ?? null : null,
      error: ok ? null : ((result.err || '').slice(0, 400) || `${harness} exited ${result.code ?? '?'} without a usable reply`),
      proposals: out.map((p) => ({ ...p, originLabel: ORIGIN_LABEL[p.origin] || null })),
      stats: anyStats ? stats : (result.stats ?? null), rateLimit,
      loaded: loadedView(), refused, dropped, scope: scopeOf(), readBytes,
      note: noteFinal,
    });
    return;
  }
}

const whyOf = (cls) => ({ plugin: 'belongs to a plugin', vendor: 'ships with the CLI', readonly: 'in a read-only folder' }[cls] || null);
