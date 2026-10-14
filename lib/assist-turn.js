import { ASSIST_LIMITS, factsText, lookup, readAttached, readEntry, searchManifest } from './assist-files.js';
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
 * no longer ask, and a round that adds nothing new makes the next the last.
 * One child at a time; a closed request kills it and stops the loop. Request
 * rounds do not stream their text: deltas are held until the reply is plainly
 * not a request, and a `round` event tells the client to drop what it had.
 *
 * Context per turn is attached ∪ loaded, re-read every round. Only files in
 * it may be edited, and only those whose class ACS edits (lib/chat-proposals.js).
 */

const ORIGIN_LABEL = { attached: 'attached', loaded: 'pulled in by Assist' };

/** The client's list of strings, bounded. */
const strings = (v, max = 200) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length < 1024).slice(0, max) : []);

export async function runChatTurn({
  message, mentions, sessionId: startSession, seed, harness, model, cwd,
  carried: carriedIn, blocked: blockedIn,
  streamTurnFn, assistFiles, proposals, send, isClosed, setActive, succeeded, remember,
  limits = ASSIST_LIMITS,
}) {
  const manifest = await assistFiles.manifest();
  const blocked = new Set(strings(blockedIn));
  const notes = [];
  const refused = [];
  const dropped = [];

  // What the user attached: read now, every round. A file that cannot be read
  // is shown as unreadable, so an edit to it proposes nothing.
  const readAttachedAll = () => mentions.map((abs) => {
    try { return { ...readAttached(abs, limits.fileBytes), origin: 'attached' }; }
    catch (e) { return { real: abs, display: abs, origin: 'attached', unreadable: e.message }; }
  });

  // Files Assist pulled in on earlier turns, carried by the client: held to
  // the manifest again, never trusted as paths.
  const loaded = [];   // { entry, bytes } in load order
  for (const p of strings(carriedIn, limits.filesPerMessage * 4)) {
    if (blocked.has(p)) continue;
    const hit = lookup(manifest, p);
    if (hit.error) { notes.push(`${p} is no longer available (${hit.error}) and was dropped.`); continue; }
    if (mentions.includes(hit.entry.real) || loaded.some((l) => l.entry.real === hit.entry.real)) continue;
    loaded.push({ entry: hit.entry });
  }

  let msgFiles = 0, msgBytes = 0;
  let sessionId = startSession;
  let round = 0;
  let lastProgress = true;
  let found = [];
  let searchedTotal = 0, searchPartial = false;
  const seenFinds = new Set();
  const stats = { contextTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };
  let anyStats = false;
  let rateLimit = null;

  const loadedView = () => loaded.map(({ entry }) => ({ display: entry.display, readOnly: entry.readOnly, cls: entry.cls, kind: entry.kind }));

  /** This round's files under the per-turn byte cap: oldest pulled-in files go first. */
  const assemble = () => {
    const att = readAttachedAll();
    const pulled = [];
    for (const l of loaded) {
      try { const r = readEntry(l.entry, limits.fileBytes); pulled.push({ ...l, buf: r.buf, text: r.text }); }
      catch (e) { pulled.push({ ...l, unreadable: e.message }); }
    }
    const size = (f) => (f.buf ? f.buf.length : 0);
    let total = att.reduce((n, f) => n + size(f), 0) + pulled.reduce((n, f) => n + size(f), 0);
    const turnNotes = [];
    while (total > limits.turnBytes && pulled.length) {
      const drop = pulled.shift();
      loaded.splice(loaded.findIndex((l) => l.entry.real === drop.entry.real), 1);
      total -= size(drop);
      turnNotes.push(`${drop.entry.display} was dropped from context: this turn's files would pass ${limits.turnBytes / 1024} KB.`);
    }
    while (total > limits.turnBytes && att.length) {
      const drop = att.pop();
      total -= size(drop);
      turnNotes.push(`${drop.display} (attached) is too large to send with the rest this turn and was left out.`);
    }
    const files = [
      ...att.map((f) => ({
        label: f.display, path: f.real, text: f.text ?? '', buf: f.buf, cls: f.cls, origin: 'attached',
        readOnly: f.unreadable ? true : f.readOnly, why: f.unreadable ? `unreadable: ${f.unreadable}` : whyOf(f.cls), unreadable: f.unreadable,
      })),
      ...pulled.map((f) => ({
        label: f.entry.display, path: f.entry.real, text: f.text ?? '', buf: f.buf, cls: f.entry.cls, origin: 'loaded',
        readOnly: f.unreadable ? true : f.entry.readOnly, why: f.unreadable ? `unreadable: ${f.unreadable}` : whyOf(f.entry.cls), unreadable: f.unreadable,
      })),
    ];
    // An unreadable file is still named, so the model knows it is missing — never as content.
    for (const f of files) if (f.unreadable) f.text = '';
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
      if (blocked.has(e.display) || blocked.has(e.real)) {
        roundRefused.push({ path: asked, reason: 'the user removed this file from the session; only they can add it back' });
        continue;
      }
      if (loaded.some((l) => l.entry.real === e.real) || mentions.includes(e.real)) continue;   // already in context
      if (msgFiles >= limits.filesPerMessage) { roundRefused.push({ path: asked, reason: `the ${limits.filesPerMessage}-file limit for one message was reached` }); continue; }
      const left = limits.loadedBytesPerMessage - msgBytes;
      let r;
      try { r = readEntry(e, Math.min(limits.fileBytes, left)); }
      catch (err) {
        roundRefused.push({ path: asked, reason: err.status === 413 ? `over the ${limits.loadedBytesPerMessage / 1024} KB loading limit for one message` : err.message });
        continue;
      }
      msgFiles++;
      msgBytes += r.buf.length;
      loaded.push({ entry: e });
      progress = true;
    }
    const roundFound = [];
    for (const q of [...new Set(req.find.map((x) => x.slice(0, limits.queryChars)))]) {
      if (q.trim().length < 2) { roundRefused.push({ path: `@@FIND ${q}`, reason: 'a search needs at least 2 characters' }); continue; }
      if (seenFinds.has(q.toLowerCase())) continue;
      seenFinds.add(q.toLowerCase());
      const res = searchManifest(manifest, q, { limits, skip: (e) => blocked.has(e.display) });
      searchedTotal = Math.max(searchedTotal, res.searched);
      searchPartial ||= res.partial;
      roundFound.push(res);
      send({ t: 'searched', query: q, searched: res.searched, matched: res.matched, partial: res.partial });
      progress = true;
    }
    found = roundFound;
    refused.push(...roundRefused);
    for (const r of roundRefused) notes.push(`Not loaded: ${r.path} — ${r.reason}.`);
    send({ t: 'loaded', files: loadedView(), refused: roundRefused });
    return progress;
  };

  const scopeOf = () => {
    const parts = [];
    if (seenFinds.size) parts.push(`Searched ${searchedTotal} file${searchedTotal === 1 ? '' : 's'}`);
    if (loaded.length || seenFinds.size) parts.push(`loaded ${loaded.length}`);
    if (!parts.length) return null;
    let line = parts.join(' · ');
    line = line[0].toUpperCase() + line.slice(1);
    if (searchPartial) line += ' · partial';
    return { searched: seenFinds.size ? searchedTotal : null, loaded: loaded.length, partial: searchPartial, line };
  };

  for (;;) {
    const isFirst = !sessionId;
    const requests = round < limits.requestRounds && lastProgress;
    const { files, notes: turnNotes } = assemble();
    const prompt = buildTurn({
      message, files, nonce: newNonce(),
      manifest: isFirst || round > 0 ? manifest.text : null,
      facts: factsText(), found, notes: [...notes, ...turnNotes],
      isFirst, seed: isFirst ? seed : null,
      continuation: round > 0, requests,
    });
    notes.length = 0;
    dropped.push(...turnNotes);
    if (round > 0) send({ t: 'round', n: round });

    // Held until the reply is plainly not a request: a request round is never streamed as prose.
    let held = '', passing = false;
    const onDelta = (piece) => {
      if (passing) return send({ t: 'delta', text: piece });
      held += piece;
      const head = held.trimStart();
      if (head.length >= 6 && !/^@@(NEED|FIND)/.test(head)) { passing = true; send({ t: 'delta', text: held }); held = ''; }
    };
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
    const text = result.text || '';
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
      lastProgress = handleRequests(req);
      if (!lastProgress) notes.push('Nothing new could be loaded from that request.');
      round++;
      continue;
    }

    if (ok && req.any) notes.push('Assist asked for more after its limit; that request was ignored.');
    if (!passing && held && ok && !req.any) send({ t: 'delta', text: held });
    const finalText = ok && req.any ? '' : text;
    const shown = new Map(files.filter((f) => f.buf).map((f) => [f.label, f]));
    const out = (ok ? parseEdits(finalText, files) : []).map((p) => {
      if (p.error || !p.file) return { path: p.path, display: p.display, error: p.error, refused: p.refused === true, origin: shown.get(p.display)?.origin };
      const f = p.file;
      return proposals.propose(p, { real: f.path, display: f.label, cls: f.cls, origin: f.origin, shown: f.buf });
    });
    send({
      t: 'done',
      ok,
      text: finalText,
      sessionId: ok ? result.sessionId ?? null : null,
      error: ok ? null : ((result.err || '').slice(0, 400) || `${harness} exited ${result.code ?? '?'} without a usable reply`),
      proposals: out.map((p) => ({ ...p, originLabel: ORIGIN_LABEL[p.origin] || null })),
      stats: anyStats ? stats : (result.stats ?? null), rateLimit,
      loaded: loadedView(), refused, dropped, scope: scopeOf(),
      note: ok && req.any ? 'Assist asked for more files after its limit; nothing more was loaded.' : null,
    });
    return;
  }
}

const whyOf = (cls) => ({ plugin: 'belongs to a plugin', vendor: 'ships with the CLI', readonly: 'in a read-only folder' }[cls] || null);
