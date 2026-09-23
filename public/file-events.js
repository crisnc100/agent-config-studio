/* Agent Config Studio — what a live-change event means for this tab */

/**
 * The decision the live-change handler acts on, kept pure so
 * tests/own-writes.mjs can run it in a VM exactly as the browser loads it.
 *
 * The server tags the studio's own writes `origin: "studio"` (lib/watch.js).
 * That changes only the WORDING, never the sync: another tab with the file
 * open still has to follow a studio save or trash. So:
 *   - the open file was removed          → close it (the wording says who)
 *   - the open file changed, and dirty   → keep the edits, warn of the conflict
 *   - the open file changed, and clean   → reload it if its content differs,
 *                                           announcing it only for an outside change
 *   - anything else                      → announce added/removed files, outside only
 */
function fileEventPlan(d, { openPath = null, dirty = false } = {}) {
  const studio = d.origin === 'studio';
  if (openPath && (d.removedPaths || []).includes(openPath)) return { open: 'closed', studio };
  if (openPath && (d.changedPaths || []).includes(openPath)) return { open: dirty ? 'conflict' : 'reload', studio };
  return { open: 'none', studio, announce: !studio };
}

/**
 * What to do once the open file has been fetched again. Decided AFTER the
 * fetch, from the state then: the user may have typed, or opened another
 * file, while it was in flight.
 *   'none'     — a different file is open now (or the fetch failed)
 *   'meta'     — disk holds exactly what this tab holds: take its mtime, so
 *                the next Save is not refused as a conflict, and nothing else
 *   'conflict' — disk differs and there are unsaved edits: keep them, warn
 *   'replace'  — disk differs and the editor is clean: show the new bytes
 */
function reloadDecision({ sameFile, dirty, fetched, original }) {
  if (!sameFile || fetched == null) return 'none';
  if (fetched === original) return 'meta';
  return dirty ? 'conflict' : 'replace';
}
