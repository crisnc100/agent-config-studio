/**
 * The one place a vendor's percentage is turned into a number.
 *
 * Every reader needs this and each had its own copy, which is how a blank
 * string still slipped through to 0%. `Number('')`, `Number('  ')`, `Number([])`
 * and `Number(null)` are all 0, and a 0 here paints a full green bar meaning
 * "nothing used" for a quota we could not actually read — the opposite of the
 * truth, and the worst possible input to a routing decision.
 *
 * Returns null for anything that is not unambiguously a number.
 */
export function numericPercent(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // Arrays and objects coerce (`Number([])` is 0, `Number([5])` is 5); neither
  // is a percentage anyone meant to send.
  if (typeof v === 'string') {
    if (v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
