# usage-seats: "the UI does NOT report the previous account's number" flakes on Linux CI

## Cause: a real race in lib/usage, not only in the test
`renderSnapshot` (lib/usage/seats.js:411) decides whether a seat's credential moved after the CLI's snapshot with
`statSync(auth.json).mtimeMs > stored.takenAt`. That compares a file timestamp with `Date.now()`, two clocks: Linux
stamps mtime from the kernel's coarse clock, which lags the clock `Date.now()` reads. A re-auth that lands within that
lag after the snapshot gets an mtime no later than `takenAt`, counts as "not moved", carries the old sign-in moment,
and the previous account's reading is shown under the new one. The test re-auths microseconds after the snapshot
(takenAt is set at the end of snapshot()), so it trips half the time on Linux. On a disk with 1–2 s timestamps, or
NFS with a skewed server clock, the window is seconds.

## Evidence
- Linux (node:20-bookworm in Docker, --network none, repo mounted read-only): 15182 of 20000 writes got an mtime
  earlier than the Date.now() read just before the write, by up to 0.873 ms.
- macOS (APFS): 0 of 20000, which is why it never fails locally.
- `node tests/usage-seats.mjs` looped 200 times in that container: 100 runs failed, every one on this check.

## Fix
- snapshot() records each seat's `credentialStat` (auth.json's mtimeNs, ctimeNs, size and inode, read with
  bigint stat before the account is read; `none` when there is no auth.json). Not its content: the studio process
  still never reads account identity.
- renderSnapshot counts the credential as moved when its stat differs from the recorded one. One file compared with
  itself, no clock. A write after the CLI looked changes ctime at least (and the inode for an atomic rename).
- A snapshot from before `credentialStat` falls back to the mtime test with 2 s of slack, erring towards "moved",
  which withholds a reading until the next CLI run rather than show the wrong account's.

## Tests
A regression test that is deterministic on any OS: the re-auth's mtime is set back to exactly `takenAt`, as a coarse
clock stamps it; the UI must not show the previous account's number. The existing check then passes on Linux over
the same 200-run loop. No existing test is changed.
