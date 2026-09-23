/* Agent Config Studio — which live-change events are the page's own writes */

/**
 * The watcher cannot tell the studio's own writes from anyone else's, so the
 * page registers what it changed and the live-change handler stays quiet
 * about exactly those paths — and nothing else.
 *
 * Two rules keep this from hiding a real outside change:
 *  - EXACT paths only. A registered folder does not cover what is inside it;
 *    a file someone else drops under a trashed slug is still announced.
 *  - Registered from what an operation DID, not from what its preview
 *    proposed: only steps that applied (Accept) or were undone (Restore).
 *    A skipped or refused step registers nothing. While the request is in
 *    flight, events are held rather than judged, then replayed once the
 *    response says which paths were ours.
 *
 * A classic script, so tests/own-writes.mjs can run it in a VM context.
 */
function createOwnWrites(now = () => Date.now()) {
  const paths = new Map();     // display path -> expiry
  const trim = (p) => p.replace(/\/$/, '');

  return {
    expect(displays, ms = 15_000) {
      const until = now() + ms;
      for (const d of displays || []) if (d) paths.set(trim(d), until);
    },
    has(display) {
      const until = paths.get(trim(display));
      if (until === undefined) return false;
      if (until < now()) { paths.delete(trim(display)); return false; }
      return true;
    },
  };
}

/** The paths an Accept response says were changed: steps that ran to done. */
function appliedPaths(op) {
  return (op?.steps || []).filter((s) => s.done).map((s) => s.path);
}

/** The paths a Restore response says were put back: steps actually undone. */
function undonePaths(op) {
  return (op?.steps || []).filter((s) => s.undone).map((s) => s.path);
}
