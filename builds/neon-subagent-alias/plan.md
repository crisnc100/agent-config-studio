# Unify native subagent refusal evidence

## Outcome

Close #124 A2's deferred alias gap: native denial evidence under separate IDs is unified when an event links the IDs, so known denials cannot emit completed true.

## Scope

One PR: a small correction to the existing evidence identity logic plus regression fixtures and matching technical docs. Cris explicitly waived advisor/Bounce for this existing-rule correction; stop for advisor only if a new rule becomes necessary. No live Neon calls. No new permission policy, transcript reads, sandbox defaults, grants policy, model proof changes, or saved exclusions in this PR. The approval-filename LOW is outside the identity code and stays filed unless the same correction directly fixes it.

## Phase

One builder phase, test first. Commit a failing standalone replay fixture and its SUITE registration in a test-only commit; record baseline failure. Then make the bounded identity merge fix, run targeted tests, and commit source/docs/log. Existing assertions must not be weakened; any existing-test changes are test-only commits and must be checked for weakening by another model. Frozen review.test.mjs untouched. Then installed pr-review: combined code and required security, one fix round if needed, one context pass, one fix check, full registered suite, close at tip, push, PR, CI green, needs-human. Never merge.

## Acceptance criteria

A1 The judge's replay (ERROR under conversation_id, EPERM under log_uri, then both IDs, then SUCCESS) returns exit4 with no answer/build and cannot emit completed true. Test is red on merged124 and green after code.
A2 Aliases link regardless of update order; a later clean/DONE update or repeated linking cannot erase a denial; pre-existing aliases, transitive links and two already-refused records merge consistently with bounded, deduplicated diagnostic entries. Distinct unlinked subagents remain distinct.
A3 Clean streams and nonpermission failures remain clean under the existing classification rule; read-only results, mismatch-only2, denial+mismatch4, native bounds and no-private-transcript behavior remain unchanged. Existing offline suites pass; no live models/agy calls.
A4 Installed PR review plus required Mythos pass and any one fix check read all changed files; full registered suite and current CI green; needs-human, unmerged. Qualification stays0/5. Saved exclusions are separate PR B.

## Out of scope

Approval-filename classifier changes unless directly part of identity fix; other filed LOWs; actual Neon tasks/probes/benchmarks; automatic role/config changes; GUI/desktop control.
