# Helper fix check and existing-test check

Outcome: verify the committed fixes for helper review 2026-11-24-02-50-55-9a9425 without a second full review. The original scope and unchanged requirements are in helper-phase.md.

Check f1: publishing valid new source beneath an unchanged existing empty directory or an eligible directory containing only omitted files succeeds, without copying protected contents or accepting a changed ancestor.

Check f2: operator signals and timeout cancellation remain failures even after a successful child exit and before its stream-close event. No cancelled run may publish, and normal completion still works. All hooks/timers/process cleanup must be removed appropriately.

Also perform the required independent existing-test weakening check on the separate test-only commit in this fix round. Inspect every added/changed assertion. Check whether any earlier assertion was weakened, deleted, skipped, narrowed, or can now pass on broken code. The new regressions must exercise the actual failure conditions, not merely mirror helper branches. Name any weakening as a finding with the normal scores; otherwise state in the review summary that the test-only changes are not weakened and explain what they guard. The reviewer is Sol-prev at xhigh and the author is Sol medium, so this is a different-family check under crossFamily off.

This is a phase checkpoint. No public CLI wiring, live inference, roles, benchmark, close, push or merge is part of it. Existing default read-only Neon paths remain unchanged. Do not run a model through the code being checked.
