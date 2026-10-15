import fs from 'node:fs';
import * as history from './history.js';
import { classOf, displayer, FIXABLE_CLASSES, policyCheck, stricterClass } from './audit.js';
import { rereadEditable } from './assist-files.js';
import { assertWritable, currentRoots, kindOf, resolveSafe } from './paths.js';
import { bad, baseOf, createProposals } from './proposals.js';
import { validate } from './validate.js';

/**
 * Assist's edits as proposals (lib/proposals.js), the same accept path the
 * audit uses. A proposal is bound to the exact bytes the model was shown:
 * if the file changed while the model worked, there is no proposal; if it
 * changes before Accept, Accept refuses. The class is checked when proposed
 * and again at the write — plugin, vendor and read-only files never; synced
 * only with the user's acknowledgement.
 */

export const CHAT_PROPOSAL_LIMITS = Object.freeze({ ttlMs: 30 * 60_000, perTarget: 3, fileBytes: 4 * 1024 * 1024, batch: 50 });

const STALE = 'The file changed since Assist proposed this. Nothing was written; ask again.';
const realOr = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };

/**
 * `classify(real, cls)` resolves to a file's class as the inventory knows it
 * now — the strictest of every alias (lib/assist-files.js classIn on a fresh
 * manifest). Without one, only where the file really is counts.
 */
export function createChatProposals({ hist = history, now = Date.now, limits = CHAT_PROPOSAL_LIMITS, classify = async (real, cls) => classOf(realOr(real), cls) } = {}) {
  const store = createProposals({ hist, now, ttlMs: limits.ttlMs, perTarget: limits.perTarget, maxBytes: limits.fileBytes });

  /**
   * One parsed edit (lib/chat.js parseEdits) → what the client shows: a
   * proposal with an id, or the reason there is none. `shown` is the buffer
   * the prompt carried.
   */
  function propose(edit, { real, display, cls, origin, shown }) {
    const base = { path: real, display, kind: edit.kind, edits: edit.edits, origin, cls };
    const now = classOf(realOr(real), cls);
    if (!FIXABLE_CLASSES.has(now)) return { ...base, refused: true, error: 'Refused: this file is read-only, so ACS will not edit it.' };
    let opened;
    try {
      assertWritable(real);
      opened = rereadEditable(real, limits.fileBytes);
    } catch (e) { return { ...base, error: `Nothing proposed: ${e.message}.` }; }
    if (opened.real !== real || baseOf(opened.buf) !== baseOf(shown)) {
      return { ...base, error: 'Nothing proposed: the file changed while Assist was working. Ask again.' };
    }
    const bytes = Buffer.from(edit.proposed, 'utf8');
    if (bytes.length > limits.fileBytes) return { ...base, error: 'Nothing proposed: the result would be too large to edit here.' };
    const { id, expires } = store.add(real, {
      real, ident: `${opened.stat.dev}:${opened.stat.ino}`, base: baseOf(shown), bytes, cls: now, display, origin,
    });
    return { ...base, cls: now, id, expiresAt: expires, synced: now === 'synced', current: edit.current, proposed: edit.proposed };
  }

  /**
   * The checks that must not spend the proposal: its class now (every alias,
   * from the inventory) and that the result is valid. Returns that class.
   */
  async function precheck(p, ackSync) {
    const cls = stricterClass(p.cls, await classify(p.real, p.cls));
    policyCheck(cls, ackSync === true);
    const check = validate(p.real, p.bytes.toString('utf8'), kindOf(p.real));
    if (!check.ok) throw bad(422, `Not applied — ${p.display} would be invalid.`, { reason: 'invalid', errors: check.errors });
    return cls;
  }

  async function accept({ id, ackSync } = {}) {
    const { redact } = displayer(currentRoots().active);
    const p = store.peek(id);
    const cls = await precheck(p, ackSync);
    store.take(id);
    try {
      const { sha, warnings } = await store.commit(p, {
        locate: () => resolveSafe(p.real),
        stale: STALE,
        // At the write, with no await before it: where the file is now, joined with the inventory's class.
        recheck: (q) => policyCheck(stricterClass(classOf(realOr(q.real), q.cls), cls), ackSync === true),
        baselineMessage: `state of ${p.display} before an Assist edit`,
        recordMessage: `assist: edit ${p.display}`,
      });
      let mtime = null;
      try { mtime = fs.statSync(p.real).mtimeMs; } catch {}
      return { saved: true, path: p.display, sha, mtime, warnings: warnings.map(redact) };
    } catch (e) {
      e.message = redact(e.message);
      throw e;
    }
  }

  /**
   * Several proposals, each applied on its own: one that fails does not stop
   * the rest. Each id is single-use, so a retry of the same list applies
   * nothing twice; two proposals for one file in a batch apply the first
   * only. Outcomes: applied / stale / refused / gone / failed.
   */
  async function acceptAll({ ids, ackSync } = {}) {
    if (!Array.isArray(ids) || !ids.length || ids.length > limits.batch || new Set(ids).size !== ids.length
        || !ids.every((x) => typeof x === 'string' && /^[0-9a-f]{32}$/.test(x))) {
      throw bad(400, `ids must be a list of 1–${limits.batch} distinct proposal ids`);
    }
    const seen = new Set();
    const results = [];
    for (const id of ids) {
      let display = null;
      try {
        const p = store.peek(id);
        display = p.display;
        if (seen.has(p.real)) { results.push({ id, display, outcome: 'refused', message: 'Another proposal in this batch already changes this file.' }); continue; }
        seen.add(p.real);
        const r = await accept({ id, ackSync });
        results.push({ id, display, outcome: 'applied', sha: r.sha, mtime: r.mtime, warnings: r.warnings });
      } catch (e) {
        const outcome = e.status === 410 ? 'gone' : e.status === 409 && e.payload?.reason !== 'synced' ? 'stale'
          : [403, 409, 422].includes(e.status) ? 'refused' : 'failed';
        results.push({ id, display, outcome, message: e.message, ...(e.payload?.errors ? { errors: e.payload.errors } : {}) });
      }
    }
    return { results, applied: results.filter((r) => r.outcome === 'applied').length };
  }

  /** Withdrawn proposals (Reject, or a removed chip): gone, whether or not they still existed. */
  function reject({ ids } = {}) {
    let n = 0;
    for (const id of Array.isArray(ids) ? ids.slice(0, limits.batch) : []) {
      try { store.take(id); n++; } catch {}
    }
    return { rejected: n };
  }

  return { propose, accept, acceptAll, reject };
}
