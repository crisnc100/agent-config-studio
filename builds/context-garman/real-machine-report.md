# Real-machine report — Context view over ~/Documents/Garman-Homes

**2026-09-24.** Read-only run against the real HOME, at the code as of
976701d plus the tripwire label fix. The script called `contextMap()` twice
in one process: once cold, once warm. It never called a route, never
opened a file for editing, and wrote nothing.

Before the script, `tests/real-home.mjs save` ran; after it, `check` ran and
reported **2 passed, 0 failed**. The check now fingerprints every Garman-Homes
context file by sha256.

## Counts

| Root | Files | Entries | Drifted | Notes |
|---|---|---|---|---|
| Garman Homes (read-only) | **2,263** | **113** | **41** | Almost all of them are worktree copies. |
| Projects | 32 | 16 | 1 | The Projects count was 109 on 2026-09-23. A separate session has since force-removed 11 AirFlo worktrees. |
| Total | 2,295 | 129 | 42 | 2,056 identical copies were collapsed. None was unreadable. |

**The two big Garman repos**, grouped per repository with drift measured
against trunk:

- `stella`: 1,328 files from 23 checkouts, as 59 entries, 14 drifted. The
  trunk is `05-Development/stella/stella-trunk`.
- `kylie-main`: 924 files from 21 checkouts, as 43 entries, 27 drifted.

The other 10 Garman groups are single non-repo folders with 1–2 files each,
for example `05-Development/google-workspace` and
`03-Documentation/Departments`.

**No repository spans both roots on this machine.** The per-copy root
attribution (976701d) is exercised by the fixture test, not by real data.

## Timings and responsiveness

| Measure | Value |
|---|---|
| Context scan, first call in the process | 927 ms |
| Context scan, second call | 933 ms |
| Worst event-loop stall during the first call | 9 ms |
| Worst event-loop stall during the second call | 15 ms |

- **There is no result cache,** so the second call walks both roots again.
  What it gains comes only from the OS file cache. On 2026-09-23, before
  descriptor-bound reads, the same measurement gave 916 ms and 863 ms.
- **The walk and reads are asynchronous.** Sampled every 20 ms, the event
  loop never stalled more than 15 ms, so the server keeps answering other
  requests while the Context view builds.
- A synchronous walk of Garman-Homes alone took about 2 s, all of it a stall.
