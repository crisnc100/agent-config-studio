# Why delegated agents stall: summary (Nov 7–15, 2026)

Scope: 6 orchestrator sessions (MAIN = ACS/review gate, GARMAN = Docket/Firstcall/Ledgerline/Askwell, CI, AIRFLO ×2, PERSONAL), 318 MAIN subagent transcripts plus the subagent folders of the other sessions, 1,925 `claude -p` sessions, 717 Codex rollouts, 980 review-log lines, 16 field reports, the task outputs, and the macOS power log (`pmset -g log`). One row per incident, with file:line evidence, is in `incidents.md`.

**Headline:** about **20 hours** of visible stall time in 8 days, plus about 45 hours of wall-clock delay while the Mac slept. Of the 20 incidents with a cost, **the user had to prod in 15**. The orchestrator caught one on its own (E5), and three were never flagged (A2, E1, E4). The single biggest cause is one harness behaviour: **a native subagent's background job finishes, the completion notice goes to the orchestrator's queue instead of the subagent, and the subagent sleeps forever.**

## 1. Causes ranked

| Rank | Cause | Incidents | Time lost (user present) | Who noticed |
|---|---|---|---|---|
| 1 | **A. Subagent waits on its own background job or Monitor; the completion never wakes it** | 8 (+1 near miss) | **~14.0 h** (51 + 21 + 23 + 100 + 222 + 400 + 20 min; A2's 2 h 16 min idle not counted) | User prodded 6 of 8; never flagged 1 |
| 2 | **B. `codex exec` started in the background without `</dev/null`** hangs on stdin | 2 | **~3.5 h** (141 + ~70 min) | User prodded 2 of 2 |
| 3 | **C. Test command inside `review.mjs --close` hung** (Docket pytest at 0 % CPU) | 2 | **~1.75 h** (25 + 80 min) | User prodded 2 of 2 |
| 4 | **D. Detached `( … ) &` launch, so no completion notice** | 1 confirmed (C2 was also detached) | **~1 h** | User prodded |
| 5 | **F. Pane message pasted but not submitted** | 1 | 5 min | User prodded |
| 6 | **G. Pane worker on a permission prompt** | 1 | 1 min | User |
| 7 | **H. Fast crashes** (process dies at launch; `cmux: argument too large` for Claude reviewers) | 2 + ~20 | <2 min + unmeasured re-runs | Orchestrator |
| — | **E. Mac slept with work in flight** (Idle Sleep 3×, Clamshell 2×) | 5 windows, ~15 runs | **~45 h wall clock**, user away | User on return 2, orchestrator 1, nobody 2 |

By count, A leads (8) and E is next (5 windows). By time while the user was present, A alone accounts for about 70 %.

## 2. Earliest automatic signal for each cause, and the recovery that worked

**A. Subagent never woken** (A1–A8)
- **Signal 1, 0 s:** the subagent's `idle_notification` arrives in the orchestrator transcript, and its `result` says what it is waiting on, e.g. "Waiting on the full-suite run to finish." (MAIN L62288).
- **Signal 2, seconds later:** a `queue-operation` `enqueue` with a `<task-notification>` for a task id that appears in that subagent's transcript as "Command running in background with ID: X" (A1: enqueued at 18:03:52, 7 s after the idle notice). In A1, A3 and A7 the notice arrived within 2–6 min of the idle notice, and in A4–A6 and A8 within 5–12 min.
- **Rule that catches every case:** if a subagent is idle and a task it owns completes, wake it at once. A weaker backstop: an idle subagent with a "waiting" result and no new commit or transcript line for 10 minutes.
- **Recovery that worked:** a SendMessage telling the subagent to "read the output file now" (A1 L62392: PR done 4.5 min later; A8 L1440; A7 L20286). Prevention also worked: telling the builder to block on the run or poll its output itself (A9 L39639; GARMAN L21561, L22025). There were no stalls after those instructions.
- **Note:** the harness's own tool result tells the subagent "You will be notified when it completes — do not poll that file or sleep" (e.g. cleanup-builder L638). For a subagent that is false, and it is what makes the subagent end its turn.

**B. stdin hang** (B1, B2)
- **Signal, about 60 s:** no Codex rollout appears under `~/.codex/sessions/<date>/` for that cwd after launch, and the task output file stays at 0 bytes (`bgj2gjmkj.output` was still 0 bytes after 2 h 21 min). Codex prints "Reading additional input from stdin…" before it creates a session, so nothing else records it.
- **Recovery that worked:** kill, then relaunch with `</dev/null` (MAIN L71744; AIRFLO-B L3148).

**C. Close-test hang** (C1, C2)
- **Signal, about 8 min** (2× the normal 2.5–4 min run): pytest alive at 0.0 % CPU with the output file not growing (GARMAN L9436; `sample` shows `__psynch_cvwait`, L9466).
- **Recovery that worked:** kill, run `./verify.sh` directly with stdout to a file and stdin from `/dev/null`, then close (GARMAN L9613). **Cause unknown.** It happens only under `review.mjs --close`.

**D. Detached launch** (D1)
- **Signal, 0 s:** the job's completion line in RLOG (`review-log.jsonl` L1386–1389 at 18:41–18:44), or the `exit N` line the detached job appends to its own log.
- **Recovery:** launch with `run_in_background` or a Monitor on the exit marker, so completion becomes a notification. MAIN switched to this after H1: "restarting it as a tracked background job", GARMAN L1426.

**E. Machine sleep** (E1–E5)
- **Signal, before the stall:** in-flight jobs with no keep-awake assertion. During it: PMSET "Entering Sleep state due to 'Idle Sleep'" or "'Clamshell Sleep'", and "API Error: Your computer went to sleep mid-response" in Claude transcripts.
- E2 slept **38 s** after the orchestrator launched a review and ended its turn.
- **Recovery:** keep the Mac awake while any delegated job runs, e.g. `caffeinate -i` tied to the job. On battery with the lid closed that does not hold, which is what GARMAN reported at L21912. There, plug in or open the lid.

**F. Unsent pane message** (F1)
- **Signal, about 10 s:** after a send, the Codex rollout shows no new user turn or `task_started` (the rollout went silent from L332 at 01:21:53 to 01:27:56), and the pane screen shows "[Pasted Content N chars]" still in the input box (MAIN L84954).
- **Recovery that worked:** submit again, then confirm the turn started (MAIN L84957).

**G. Permission prompt** (G1)
- **Signal, about 30 s:** the worker transcript ends on a `tool_use` with no `tool_result` (ac8f3f98 L51), and the pane shows a prompt.
- **Recovery:** start pane workers in a mode that doesn't prompt (MAIN L84117).

**H. Crashes:** already caught by the "failed" task notification within seconds. The gap is H3: the security pass can be missing while the wrapper still exits 0.

## 3. Stall rate by launch method (Nov 7–14)

| Launch method | Volume | Stalls (non-sleep) | Rate | Notes |
|---|---|---|---|---|
| **Native Claude subagent** (Agent tool, in-process teammate) | 119 spawns across 6 orchestrators; ~96 background-job completions owned by subagents | 8 incidents in 7 distinct subagents (all cause A) | **~6 % of spawns; ~8 % of subagent background jobs** | The only stall source with hours-long losses. All were Opus builders. |
| **`codex exec`** (builders, Sol reviewers, test checks, QA) | ~697 rollouts | 2 stdin hangs (B) + 1 launch crash (H2) | **~0.4 %** | ~10 more rollouts stretched by sleep; 1 never completed (E3). |
| **Interactive Codex in a cmux pane** | 20 codex-tui rollouts, nearly all Nov 14 experiments; 1 real build | 1 (F1) | 1 of 1 real build | Too few runs for a rate. |
| **Interactive Claude in a pane** (experiment) | ~12 test sessions | 1 (G1) | n/a | Experiment only. |
| **`claude -p`** (review.mjs reviewers, ask-model, QA `--chrome`, graders) | 1,925 sessions | **0 hangs found** (largest non-sleep gap: 10 min of active work) | ~0 % | ~20 `cmux: argument too large` failures happen before the session starts, so they aren't in the 1,925. |
| **`review.mjs` wrapper** (both vendors) | 590 reviews + 383 closes | 2 close-test hangs (C) | ~0.5 % of closes | All 9 reviews over 25 min ran during machine sleep. |
| **Detached shell job** `( … ) &` | ~120 launches (35 MAIN, 80 GARMAN, 5 other; pattern match, approximate) | 1 confirmed (D1); C2 also detached | — | No completion signal by design. |

## 4. What the orchestrator did that caused or hid stalls

1. **It relayed "waiting" as "fine" without checking whether the thing awaited had already finished.**
   - Examples: MAIN L62291 "waiting on its full test run … Nothing needs you" (the suite had finished 4 s earlier); GARMAN L12577, L12681, L17926 ("Nothing needs you right now" while dk-live had been idle for 12 h); CI L1376.
   - In A1 it relayed the stale status twice before the user asked.
2. **It dismissed repeated idle notices as "the builder repeating its report"** about 215 times (MAIN 83, GARMAN 78, CI 21, AIRFLO 24, PERSONAL 9). Each idle notice is the one built-in signal that an agent has stopped. Treating it as noise hid A2, A4, A6 and A7.
3. **It told the user things were running when nobody had checked:**
   - MAIN L62338: "nothing stopped"
   - CI L1400: "being built now"
   - AIRFLO-B L3001: "the reviewer is partway through reading the diff" (it was hung on stdin)
   - MAIN L84933: "you can watch it work on them" (the message was never submitted)
4. **Unverified sends.** F1's paste was never confirmed as received. The pane waiter (`bg9nijlqi`) only watched for DONE, so "idle with unsent input" looked the same as "working".
5. **Untracked launches.** About 120 `( … ) & echo started` jobs, mostly in GARMAN, give no completion notice. D1 lost about an hour this way.
6. **The `codex exec` stdin mistake recurred after it was flagged.** It was flagged on Nov 11 (B1, field report bf01bc) and recurred in another session on Nov 13 (B2). About 18 `codex exec` calls in background shells had no `</dev/null` (pattern match).
7. **After a prod it woke only one of two idle builders.** On Nov 13 at 19:22 it woke dk-live-builder but not fc-pr3-builder, which stayed idle 4 h 49 min longer (A7).
8. **It used fixed `sleep` watchdogs** (MAIN `sleep 1800` / `sleep 2400`, Nov 9, after A1), which can only fire long after a stall. Later it moved to event waiters (task notifications, Monitors).
9. **Nothing keeps the Mac awake.** The orchestrator launched long jobs and ended its turn, and the Mac idle-slept 38 s later (E2). GARMAN noticed only on Nov 14 (L21912).
10. **The record of work only logs successes.** `review-log.jsonl` writes a line when a review finishes, not when it starts, so a hung or killed review (E3, C1, C2) leaves no trace there.

## 5. What I could not verify

- **Why pytest hangs only under `review.mjs --close`** (C1, C2). I have the symptom (0 % CPU, `__psynch_cvwait`) but not the cause.
- **The model behind the B1 QA lane.** It used the `codex` shell function's default; I didn't resolve which model that is.
- **D1's exact loss.** The Ledgerline fix checks and the Docket review finished by 18:44 (RLOG). I couldn't time when the detached Sol test check and the Codex QA re-test finished, because their logs aren't in the task folder.
- **A2's real cost**, given the orchestrator was also waiting on the user over the same span.
- **The harness mechanism.** I infer that a subagent's task notice goes to the parent queue and is never delivered, from the parent-queue enqueue/remove entries plus the subagent transcript showing nothing until the next team-lead message. I did not read harness code.
- **The cmux event log** (`~/.cmuxterm/events.jsonl`). I didn't check it for F1 or G1. It exists and records agent hook events, so it may give an earlier signal than the ones above.
- **Whether the user was present during the sleep windows.** Idle Sleep implies no input, but I can't say whether he was waiting.
- **Before Nov 8 01:43 UTC** the power log has no entries, so the 15-min gaps in cleanup-builder on Nov 7 00:07–01:22 UTC (also outside the 7-day window) are unexplained.
- **Other sessions** (FairDivide, ortegasolutions, 2eef288d, mercor) were checked by keyword for prods only. None turned up a delegated-agent stall in the window.
- **Approximate counts.** The "repeat report" dismissals, detached launches and missing `</dev/null` are regex counts.
