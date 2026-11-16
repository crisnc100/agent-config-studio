# Slice review 2026-11-16-20-30-44-7c058b — fix f1, f2, f3, s1 (MEDIUM). s2 is LOW: filed, don't fix.

Test first: each test fails on the current tip, then passes. Same constraints and grouping; you can't commit. Don't run the rig. Reply DONE with one line per finding.

## f1 MEDIUM lib/agent.js:302
A launch turn can falsely confirm a follow-up. If `send` runs before the initial `task_started` arrives, that initial event satisfies this count check. In-memory reproduction returned success while the transcript contained only the original launch prompt and the correction remained unsubmitted in the composer.

trigger: Run `agent open sol "initial task"`, then immediately send a correction before the initial task_started event appears.

suggestion: Distinguish the initial launch turn from the submitted follow-up and require confirmation belonging to that message, or refuse sends until startup is established.

## f2 MEDIUM lib/agent.js:565
Retrying an unsent message silently concatenates instructions. A failed send leaves text in the composer, but the next send overwrites pendingSend and appends new text without reconciling that input. In-memory reproduction on a previously completed worker submitted `first correctionreplacement correction` and returned success.

trigger: After `agent send` fails with unsubmitted text still visible, retry it with replacement or repeated instructions.

suggestion: Detect unresolved pending input before another send. Reuse it for an explicit retry or refuse until it is cleared instead of appending another message.

## f3 MEDIUM lib/agent.js:338
Completed yes/no questions are mistaken for permission dialogs. A final answer containing `Do you want to proceed?`, `1. Yes`, `2. No`, and a final `QUESTION:` line matches screen detection despite transcript-confirmed completion and no permission hook. Reproduction made wait report stuck and send reject the reply with exit 3.

trigger: A worker finishes with a yes/no question near the bottom of its screen, and the orchestrator waits or sends its answer.

suggestion: Distinguish completed assistant choice text from active permission requests using turn and hook state, while preserving startup trust checks.

## s1 MEDIUM lib/agent.js:458
Tool permissions: the Codex launcher makes the whole shared Git common directory writable to the sandboxed worker, including `config` and `hooks/`, not just the data a commit needs. A Codex worker in a linked worktree (run with `-s workspace-write -a never`, so no human check) can then write `<trunk>/.git/hooks/*` or set `core.fsmonitor`, `core.sshCommand`, a local `core.hooksPath` or `reviewgate.enabled` in `<trunk>/.git/config`. Those run or apply outside the sandbox on the next git command by the orchestrator or operator, in the trunk and every worktree. A repo-local `core.hooksPath` overrides the global review-gate hooks, and `reviewgate.enabled` is the gate's opt-in (packs/review-gate/runtime/hooks/global/run-hook:23, project.mjs:28), so this also lets a worker switch the push gate off. Harmed principal: the operator. Attacker: whoever can steer the worker through content it reads (repo files, dependency docs, tool output), or a worker that simply misbehaves. Second problem at the same line: the directory comes from repo-controlled metadata with no check. tests/agent-cli.mjs:172-177 shows a hand-written `.git` file plus a `commondir` file is enough for git to report a path, so a crafted folder (for example an extracted archive) can point `--add-dir` at any other repository's `.git` on the machine. Not demonstrated end to end: exploitation needs a steered worker, which I did not reproduce.

trigger: `agent open sol --cwd <linked worktree> ...` (the standard builder path: every Codex worker opened in a worktree gets the grant). Harm needs the worker to write `config` or `hooks/`, by prompt injection from content it reads or by its own mistake (for example running `git config` to get past a failing hook).

suggestion: Grant only what a commit writes: `--add-dir` for `$common/objects`, `$common/refs`, `$common/logs` and the worktree's own gitdir (`git rev-parse --absolute-git-dir`), leaving `config`, `hooks/` and `info/` read-only. Before adding anything, check the link is real: the worktree's gitdir must sit under `$common/worktrees/` and its `gitdir` file must point back at `$PWD/.git`; otherwise add nothing. Update the README paragraph at README.md:643-645 to match.

## Notes from the orchestrator
- f1: confirm a send only by a turn that STARTED AFTER the send (compare to the turn count/ids recorded at send time, after the launch turn has been seen), never by the launch turn.
- f2: before typing, clear the composer of any leftover unsent text (or refuse with state `unsent` naming the leftover), so two messages never merge.
- f3: when the transcript shows the turn completed and no permission hook is pending, screen text is the answer, not a dialog.
- s1: stop granting the whole git common dir. Grant only what a commit from a linked worktree needs (objects/, refs/, logs/, and worktrees/<this worktree>/; check whether packed-refs or root lock files are needed and say so), never config or hooks/. The orchestrator will verify live that a Codex worker can still commit and cannot write <common>/hooks or <common>/config. If a working commit needs root-level writes, stop and report that instead of widening it.

