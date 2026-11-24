# Build decisions

The helper checkpoint is reviewed at 28ef382 through review 2026-11-24-02-50-55-9a9425 and fix check fix-1795489226399-f68d99. The test-only commit 28ef382 is independently confirmed not weakened by Sol-prev xhigh (the check's transcript explicitly states this). The code author is Sol medium; crossFamily is off.

f1 MEDIUM 15/100 (likelihood 3/10 x impact 5/10) and f2 MEDIUM 14/100 (2/10 x 7/10) were fixed in a2a045f, with their regressions in the separate test-only commit. The latest focused suite has 20 passes.

The single helper fix check left x1 MEDIUM 15/100 (3/10 x 5/10) deferred, as recorded in helper-status.json. A trailing slash made Git treat `output` as ignored under `output/*` and `!output/new.txt`. Production record 2026-11-24-03-39-08-ccd7ec identified the same issue as s1 MEDIUM 15/100 (3/10 x 5/10) and suggested retaining its deferral. The review engine recorded s1 as a new blocking finding. The final PR fix round removed the trailing slash and added a regression for publication of `output/new.txt`. The helper checkpoint retains its historical disposition.

Production f1 MEDIUM 14/100 (2/10 x 7/10) and the related s3 LOW 5/100 (1/10 x 5/10) cover interrupts during publication. The builder keeps its handlers through cleanup, refuses cancellation before publication and finishes an in-progress publication or rollback. A subprocess test delivers SIGTERM after the first replacement and verifies that both edits are installed, the broker and stage are cleaned up, and the process reports publication successfully.

No phase has been closed. Public wiring and the final PR review/security/context/fix-check/tip-close remain pending. No Neon inference, live roles, installed runtime changes, pushes or merges have occurred. The existing read-only paths remain unchanged.
