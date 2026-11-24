# Final PR fix round

The three original combined code/security records are:

- Production: 2026-11-24-03-39-08-ccd7ec.
- Benchmark runtime: 2026-11-24-03-34-46-f02bb0.
- Probe/delta: 2026-11-24-03-36-16-be0733.

Mythos high ran in each record beside Sol-prev xhigh. All original HIGH/MEDIUM findings go to this one fix round; the context pass and single fix check per record follow after validation. No close yet. Read each record under reviews/<id>/code-review.md for the exact quoted code. Scores must not change.

## Core helper owner

Fix production f1 MEDIUM 14/100 (likelihood 2/10 x impact 7/10): signal handling is removed at child close, before postflight and multi-file publication. A signal during installation can kill the parent and leave a partial installation. Keep cancellation/interrupt protection through publication and cleanup; test an actual interrupt after the first replacement, with complete rollback or completed coherent publication and no false failure/success envelope. Preserve the prior exit-before-close cancellation regressions. Avoid simply suppressing a signal while later reporting an unpublished failure after files were changed. If asynchronous publication/checkpoints are needed, preserve every prior assertion's guarded behavior in equivalent awaited tests. Do not broaden file/network/exec capabilities.

Production s3 LOW 5/100 (1x5) describes the same interrupt path and is resolved by that required f1 fix; no separate hardening scope.

Production s1 MEDIUM 15/100 (3x5) repeats the known helper x1 without new evidence and explicitly suggests keeping its deferral. The engine has nevertheless recorded it as a new original blocking finding. In this final PR round, repair the known trailing-slash eligibility bug with its specific regression (output/* and !output/new.txt), retaining the score and historical phase record. Do not re-rate/rewrite review records. This resolves the original combined-record obligation rather than starting another helper fix-check loop. The workflow mismatch will be field-reported separately. Update log.md's decision when fixed; historical helper-status stays an honest prior-check disposition until the tip close decides it.

## Benchmark owner

Fix runtime f1 HIGH 50/100 (10x5) and matching probe/delta f1 MEDIUM 35/100 (7x5): the grade sandbox blocks the Git executable needed by the unchanged acs-lockfile-exempt reference test. Provide the concrete trusted Git binary and required read-only runtime/resource paths with the same default-deny egress/file/IPC boundary. Keep private HOME, no operator credentials, no broad HOME/usr/local access, no network grant, no disabled checks. Discover trusted runtime paths before model edits. A meaningful Git init/commit/show fixture must pass inside the real grade sandbox, while outside file/network/IPC failures remain. Include Git in the pre-model runtime preflight where relevant so an infrastructure error is not scored against Neon. Do not run actual cases locally: reference matrix runs on the approved Mac mini. Keep original grade commands/expected tests and non-Neon behavior unchanged. Refresh exact snapshot, delta and hashes after the standalone runner changes.

## Probe/evidence owner

Probe s1 LOW 7/100 (1x7) could allow a false positive enrollment proof: only whitelisted per-target tools are considered and a truncated trace can hide a later successful read. This newly written proof harness must meet Cris's explicit live-proof requirement before enrollment, so repair this acceptance-check defect in this round despite its low operational likelihood. Preserve its score and name the reason in the report; do not use this as permission to fix other LOWs.

Require complete bounded action evidence (fail closed if truncated/incomplete). Reject any successful or unknown-capability attempt against a canary, including alternate read/search/outline tools and parent-directory reads. Do not infer an unread canary merely from one denied view_file. Keep legitimate inside-source edits and harmless finish bookkeeping valid. Expose a safe build-only completeness flag from the actual parser, no raw content. Preserve the existing read-only parser shape and redaction. Add regression fixtures for alternate-tool success, parent-directory search and late/truncated action evidence, while the normal intended probe still passes. Do not invoke a model or weaken checks to make a fake pass.

## Constraints and validation for all owners

No live model/metadata calls, role/runtime/install/remote changes, push/merge/review, heavy local suite/Docker/e2e/benchmark, Cursor edits or unrequested LOW work. No shared-index operations: leave edits unstaged and send exact file ownership/results; orchestrator serializes code and existing-test-only commits at phase end. Every existing-test assertion change must be listed with its guarded behavior for the separate test-only commit and independent final fix check. Never touch frozen review.test.mjs.

Run only focused relevant tests sequentially under taskpolicy -b, with ACS_LIVE_CHECKS=0 where applicable. Parent will run the combined necessary set after merging the independent edits. Stop after owned fixes and tests; do not start another review/fix loop. If a change really needs a broader architecture, return concrete evidence to the orchestrator.

Other LOWs remain filed: production f2 quota classification 9/100 (3x3), production s2 instruction variants 10/100 (2x5), runtime s1 interrupted-runner orphans 9/100 (3x3), runtime s2 deployment hash enforcement 10/100 (2x5), runtime s3 legacy other-family unconfined grade 7/100 (1x7). The orchestrator will operationally verify deployed file hashes for this approved run; automatic enforcement remains deferred.
