# Plan: multi-select delete in Memory and Context

## Outcome
In the **Memory** view and the **Context** view, Cris can select several files (checkboxes, plus "select all visible") and delete them in one action. They go to the studio trash exactly as a single delete does today: history-committed first, restorable from Trash.

**Protected entries** (`protectedEntry`, the files a harness loads every session, which today need the name typed) **cannot be selected.** Their checkbox is disabled and a tooltip gives the reason. They are still deleted one at a time through the existing typed-name flow. (This is Cris's default, chosen by the orchestrator; he can override it.)

## Design
- **Server: `POST /api/delete/batch` `{ paths: string[] }`.**
  - strictSameOrigin; 1–200 paths, de-duplicated; a type-checked body (malformed means 400 and nothing done).
  - Each path goes through exactly the same checks as `POST /api/delete` (`mutate.remove`: resolveSafe, assertWritable, trashResolved). No new trust path.
  - The server re-derives "protected" for each path from the registry. A protected path in the batch refuses the WHOLE batch before anything moves (400, naming it), so a crafted request can't skip the typed confirm.
  - **Order:** validate every path first (resolve, writable, not protected, exists). If any fails, refuse the batch with nothing moved. Then trash them one by one.
  - **A mid-batch failure** (I/O) stops the batch and returns `{ trashed: [...], failed: {path, error}, notAttempted: [...] }` with status 207/500. Everything already trashed stays trashed and restorable. Never a silent partial.
  - **Overlap:** a selected folder plus a file inside it collapses to the folder.
  - One history commit per batch where the existing trash path allows it. Otherwise per item, matching today's behaviour (no new history semantics).
- **UI, in both views:**
  - a checkbox per deletable row and "Select all (visible)", respecting the current filter or search;
  - a sticky action bar: "N selected · Delete · Clear";
  - one confirm naming the count and listing up to 10 paths ("+N more"), saying they go to Trash and can be restored;
  - after: one notice "Deleted N files. Recover them under Trash." (or the partial-failure detail), then a registry refresh and selection cleared;
  - an editor open on a deleted file closes the same way single delete does;
  - selection is cleared on view change and on a registry refresh that removes selected items;
  - keyboard: checkboxes are focusable, Space toggles, and the action bar is reachable by Tab.
- Memory's existing batch **review** operations (`/api/memory/preview` and `accept`, trash-empty-slugs, fix-links) are untouched. This is plain file deletion, not a review op.

## Acceptance criteria
1. **Route:**
   - origin matrix: foreign, other port, null and same-site each give 403 with nothing moved;
   - malformed body or over 200 paths give 400 with nothing moved;
   - each `mutate.remove` rejection (outside roots, read root, credential, hard-linked, missing) refuses the whole batch with nothing moved;
   - a protected path refuses the whole batch;
   - a valid batch of 3 lands all 3 in Trash, each restorable, with history recording them;
   - folder plus child collapses;
   - a fault injected after item 2 of 4 gives 2 trashed and restorable, a reported failure, and 1 not attempted.
2. **UI** (VM suites):
   - protected rows have disabled checkboxes;
   - select all respects the filter;
   - the confirm lists the paths, and Cancel posts nothing;
   - OK posts exactly the selected paths;
   - the notice and the refresh follow;
   - an open editor on a deleted file closes;
   - selection clears on view change;
   - keyboard reachability.
3. **Regression:** existing suites unmodified, `./verify.sh` green uninterrupted, CI green.
4. **One short browser QA pass** on both views, in light and dark.

## Out of scope
Batch delete in other views (Skills, MCP), batch restore from Trash, and changing single delete.

## Bounce folds (Astra, `bounce.md`). These override anything above.
- **D1, Memory reuses its own batch op.** Fact rows get checkboxes. "Delete selected" runs the existing `trash-fact` operation for those ids through `/api/memory/preview` → `/api/memory/accept`. That op already batches (up to 500 ids), removes the fact's index links, and records them for Restore. So it is NOT a plain file delete, and nothing dangles. If a fact row lacks a stable id for that op, give it one, but don't build a second path. Index files (MEMORY.md) are not selectable, as today. Tests: indexed and unindexed facts; index links removed and restored; restore from the op brings every file and link back.
- **D2, what a Context row means.** A Context row is a variant that may stand for several copies. Selecting it selects exactly what single delete on that row deletes today, which is its representative editable path (`open.path`), and nothing else. A row with no editable path, or a read-only one, is not selectable, and its tooltip says why. Aliases and symlinked copies resolve to one canonical path and are de-duplicated server-side. Test with real Context payloads: collapsed copies, an alias, and mixed permissions.
- **D3, protection is derived server-side from the registry.** That covers the same `protected` the registry computes (settings entries, global instruction singletons, edit-root CLAUDE.md), matched by canonical path, and descendant protection: a selected folder containing a protected file refuses the batch. Also refuse an allowed root itself, and plugin-owned paths (`isProtected` in mutate) in PREFLIGHT, not mid-batch. Single delete's server behaviour is unchanged; don't claim a general anti-bypass guarantee.
- **D4, honest checks.** The preflight runs, per path: resolveSafe, assertWritable, not a root, not protected (including descendants), not plugin-owned, and assertNotHardLinked on files, since batch delete refuses hard-linked files. Note that this goes beyond single delete, and test it. The immediate pre-move authorization (beforeMove) stays per item. Test a root revoked between preflight and move: that item is refused and the rest are reported.
- **D5, the transport contract.** The route always answers 200 with `{ results: [{path, status: 'trashed'|'failed'|'not-attempted'|'moved-but-unfinished', display, error?, trashId?}], historyWarnings: [] }` once preflight has passed. A preflight refusal is 400 `{error, path}` and nothing moves. The UI renders per-item outcomes from that body. An end-to-end test asserts partial details reach the notice.
- **D6, real outcome per item.** After any trashResolved throw, check the filesystem and the trash records: if the source is gone and a trash entry exists, report `moved-but-unfinished` (restorable), never `failed`. Test faults before the move, after the move, and during metadata finalisation, checking the files and listTrash.
- **D7, history.** Make no claim of one commit per batch. Pre-delete bytes stay recoverable through history and the trash, and any `historyError` is surfaced as a warning. Test recoverable bytes and the surfaced warning.
- **D8, refresh the shown data.** After success or partial failure, re-fetch the active view's own data (MV.data / CX.data, plus the registry), and assert the rows, counts and findings actually change. If the re-fetch fails, show a notice and keep the stale-but-marked view.
- **D9, selection rules.**
  - The 200 limit applies AFTER de-duplication and canonicalisation. Folder collapse uses separator-aware prefixes, so `/a/b` doesn't swallow `/a/bc`, in either input order.
  - Selection holds only visible rows: rows hidden by a filter, or collapsed or lazy, are dropped from the selection when they're hidden, and the bar's count is always what will be sent.
  - Selection clears on view or tab change and after a batch.
  - The buttons are disabled while a batch runs.
  - Over 200 visible gives "select all" capped with a notice.
- **D10, the editor and the browser.** If a deleted file is open in the editor (reachable from the view), close it as single delete does, and keep an unrelated draft untouched. Navigation while a batch is pending must not corrupt the view (test it). Real Tab/Space, focus after repaint, the disabled-checkbox explanation, and the sticky-bar visibility are browser-QA criteria, named in the QA contract.
