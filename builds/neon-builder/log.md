# Build decisions

The helper checkpoint is reviewed at 28ef382 through review 2026-11-24-02-50-55-9a9425 and fix check fix-1795489226399-f68d99. The test-only commit 28ef382 is independently confirmed not weakened by Sol-prev xhigh (the check's transcript explicitly states this). The code author is Sol medium; crossFamily is off.

f1 MEDIUM 15/100 (likelihood 3/10 x impact 5/10) and f2 MEDIUM 14/100 (2/10 x 7/10) were fixed in a2a045f, with their regressions in the separate test-only commit. The latest focused suite has 20 passes.

The single helper fix check left x1 MEDIUM 15/100 (3/10 x 5/10): an explicitly allowed new child under `output/*` plus `!output/new.txt` can still be refused because a trailing slash makes Git classify the parent as ignored. This is a known fail-closed eligibility limitation. It is deferred per the one-fix-check policy, with the reason and fix idea in helper-status.json. Do not start another helper fix round or silently change this behavior during wiring. Preserve the score and include the deferral in the final tip close and PR. The final independent review should distinguish this already identified phase limitation from a new defect.

No phase has been closed. Public wiring and the final PR review/security/context/fix-check/tip-close remain pending. No Neon inference, live roles, installed runtime changes, pushes or merges have occurred. The existing read-only paths remain unchanged.
