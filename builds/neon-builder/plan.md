# Native Neon builder

Cris approved a normal local Antigravity builder with native file and network permissions on2026-11-24 (his answer: "yes test please"). Existing read-only Neon protections remain unchanged. This supersedes the custom builder isolation bar in the earlier plan (preserved in git680805b). The native local test passed: one high-effort call read, edited and re-read its owned file, matched the expected SHA256, and passed plaintext-token postflight. The served model remains unverified.

One PR. The public build route, tests and documentation ship together. No scheduler or new harness. The orchestrator rotates eligible Sol/Opus/Neon, skips quota/startup failures, and prefers Opus for frontend design taste. The Mini is not a local-release blocker; its Neon benchmark is deferred unless separately unblocked. No heavy laptop benchmark is authorized.

## Phase: use the native session path

Reuse ask-model's existing process runner, normal HOME and AGY_ENV with `agy --mode accept-edits --model <resolved> --effort <resolved> --output-format stream-json -p <prompt>`. Keep explicit canonical Git-top --cwd and existing build argument conflict checks. No private source copy, Google broker, OS sandbox, custom permission overrides or atomic-publication claim in build mode. Keep token preflight/postflight and the tested CLI-version guard. Logs may use an owned temporary directory and be removed after parsing. A failed/cancelled native build can leave edits for the orchestrator to inspect; never report successful completion then. No parent-side push/merge/commit/PR action. The implementer remains subject to the task's no-push/no-merge instructions.

Prefer integrating this in the existing runner over a new launch subsystem. Archive the unshipped isolated helpers under builds/neon-builder/probe/isolated-runtime, preserve their tests against those archived modules, and stop installing them. Do not delete or skip tests to hide a regression. Existing test changes go in their own commit, with every changed assertion and retained behavior named and independently checked. Frozen review.test.mjs stays untouched.

The build success envelope should identify native execution and completed:true, with served.verified:false. It must not claim a confined publication or enforced worktree-only access. The external benchmark adapter must accept the native completion envelope before future use; keep its independent grader and exact case commands. No second benchmark feature is required for this local milestone.

## Acceptance bar

- N1: opt-in --build invokes native agy at the explicit canonical Git top, using normal HOME and accept-edits mode; unsafe/missing roots and conflicting flags still refuse before a provider call.
- N2: default read-only ask-model and review runtime retain byte-identical AGY_WALL/AGY_SETTINGS and unchanged refusal behavior. Existing read-only tests pass without weaker assertions.
- N3: builder token preflight/postflight and tested version behavior remain; errors/cancellation do not become successful completion. No claim of outside-read/write or Google-only enforcement for native builders.
- N4: served-model identity remains unverified. Native live edit proof exists; one public-CLI proof follows implementation. Counts include all failed and successful live attempts.
- N5: Neon becomes a high-effort builder candidate only after the public native route passes; preserve Sol/Opus, medium defaults, unrelated roles and Opus frontend preference through the API. The role resolver itself still chooses first available.
- N6: final code plus Mythos security review, one fix round, context pass, one fix check per applicable record, close at tip, push, PR, CI green and needs-human. Never merge. Preserve old review findings/scores/history and name retired paths honestly.

Focused local validation only; full suite location needs the working-agreement placement decision. Mini reference infrastructure already passed10/10 cases and324assertions with zero model calls. No Neon quality benchmark score is claimed.
