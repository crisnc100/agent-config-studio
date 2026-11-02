# PR B: parallel slices

Source: `skills-work/plans/gate-speed-plan.md`, decision 6 (PR B): lock `appendLog`, run slices concurrently, one checkout.

## Concurrency safety
- **Log: an exclusive lock file, not bare O_APPEND.** Node's `appendFileSync` loops `write()` until done, and POSIX
  promises no atomicity for regular-file writes; records reach hundreds of KB (findings, coverage). So
  `appendLog` takes `<log>.lock` (`open(…, 'wx')`, holding `pid token`), appends, and removes it only if the token is
  still its own. A waiter polls every 20 ms for up to 10 s, then fails loudly. A lock whose pid is dead, or that is
  older than 30 s, is stale and is removed. Lock errors surface as "Could not append to <log>", as today.
- **Report dir and id:** the folder name stays `<UTC second>-<6 hex>`, now created with an exclusive `mkdir` and a new
  suffix on a clash, so two runs can never share a folder or a review id.
- **`reviews/latest`:** today `ln -sfn` (unlink, then symlink) can fail with EEXIST when two runs race, after the
  report is written but before the log line, so the run dies. It becomes a temp symlink renamed over `latest`
  (atomic); a failure there only warns. The last run to finish wins, which is all "latest" can mean.
- **HEAD checks:** unchanged; each run still checks a clean tree and an unmoved HEAD on its own. `git fetch` of the base
  runs once in the runner, not once per slice (concurrent fetches fight over ref locks).

## How to run them: `--slices`, not a shell recipe
`node review.mjs --slices "src/;lib/,docs/" [--jobs N] "<intent>"`: each `;`- or newline-separated group is one
REVIEW_PATHS value. The runner starts one child `review.mjs` per group with that REVIEW_PATHS, at most N at a time
(default 4), and passes through the other arguments (intent, `--plan`). As each finishes, its output is printed under a
`=== slice i/n: <paths> (exit c) ===` header. At the end it prints `===SLICES_JSON===` and an array of
`{ paths, exit, reviewId, result }`, where `result` is that slice's FINDINGS_JSON object. It exits non-zero if any
slice failed.
A recipe was the smaller option. It is not the one that works reliably for an agent: it needs `xargs -P` with
`sh -c` quoting of pathspecs and intent, one output file per slice, and exit codes collected by hand, all rebuilt
every time. The runner is about 60 lines and is tested.
Closes stay one per slice, at any head (content coverage from PR A).

## Tests (`review.parallel.test.mjs`)
- N processes appending at once leave N intact JSON lines; a stale lock (dead pid) is taken over; a live lock times out
  with a clear error.
- Concurrent reviews in one repo: distinct ids and folders, every log line intact, `reviews/latest` points at one of them.
- `--slices` runs groups at the same time (a stub reviewer sleeps; the call windows overlap) and honours `--jobs`
  (never more than N at once), prints a header and SLICES_JSON per slice, and exits non-zero when a slice fails.
