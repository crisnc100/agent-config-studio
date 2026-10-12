/**
 * How much of a project folder the discovery walks (registry, Context) may
 * read before they stop: entries listed and wall time, per root per walk. A
 * folder holding hundreds of thousands of files must cost the server a
 * bounded pause, never a frozen one. A walk cut short is recorded here, so
 * Folders and the startup banner can say "large folder — partially indexed"
 * instead of passing a partial list off as the whole.
 */

export const WALK_LIMITS = { maxEntries: 100_000, timeMs: 2000 };

/** A fresh allowance for one walk of one root. */
export function budget(limits = WALK_LIMITS) {
  return { left: limits.maxEntries, until: Date.now() + limits.timeMs, partial: false };
}

/** Spend one entry; false once the allowance is gone (and the walk is marked partial). */
export function spend(b) {
  if (!b) return true;
  if (b.partial) return false;
  if (--b.left < 0 || Date.now() > b.until) { b.partial = true; return false; }
  return true;
}

const partial = new Map();   // root realpath -> which walk was cut short

/** Record the outcome of a walk of `root`; a later complete walk clears it. */
export function markWalk(root, kind, b) {
  const kinds = partial.get(root) ?? new Set();
  if (b.partial) kinds.add(kind); else kinds.delete(kind);
  if (kinds.size) partial.set(root, kinds); else partial.delete(root);
}

/** Is this root's last walk known to be incomplete? */
export const isPartial = (root) => partial.has(root);
