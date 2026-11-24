# Neon builder

Outcome: Neon can edit one explicitly selected worktree through agy 1.5.14 while every existing read-only route retains its current containment.

One PR. The entry point and its security boundary only work together. Benchmark execution and the live role update are rollout evidence, not a second feature PR. Cursor-seat remains paused and untouched. No general round-robin scheduler is in scope: add Neon as a high-effort builder candidate only after containment passes.

## Phase 1: transport and OS-wall checkpoint

The first implementation phase ends at a tested Google-origin broker and deny-default OS profile, before entry-point wiring uses them. Pass: non-inference agy metadata works through this route, actual Mac tests prove forbidden file/network/IPC operations fail, and an independent checkpoint review reads the committed helper. No live inference or role enrollment. A fresh builder takes phase 2 from that checkpoint.

## Phase 2: explicit builder mode and file containment

- Add an opt-in agy builder route to ask-model, requiring an explicit worktree root. Refuse other vendors, mixed modes, missing/unsafe roots, redirected git roots and unwalled execution before starting the model.
- Keep the existing AGY_WALL and read-only CLI settings unchanged, including the review runtime. Retain the version pin, customization checks, disabled auto-update, plaintext-token preflight and after-call refusal, and unverified model label.
- Use a separate builder wall. Reads of other projects and secrets stay denied. Project writes are limited to the canonical selected root; protect git metadata and any runtime policy files. Symlinks must not escape. Only narrowly named runtime temp/log/keychain state may be written outside the tree when essential to run agy; no project writes elsewhere. Prefer keeping command, MCP and URL tools denied while allowing file edits, if this meets the builder cases. Never provide push or merge capability.
- Enforce Google-only network access at the OS/transport boundary, not just by prompt or tool names. The advisor must settle the smallest sound mechanism; shared-IP/hostname confusion, loopback brokers, environment credentials and subprocess escape are part of the threat model. Do not permit arbitrary proxy/IPC access. Refuse rather than fall back to an unwalled route.
- Add meaningful deterministic tests of parsing, default read-only behavior, actual macOS containment, canonical roots, link escapes, forbidden writes/reads/network, token handling and model labels. Existing tests remain strong; any existing test edit is isolated in a test-only commit and independently checked. Never edit frozen review.test.mjs.

## Phase 3: rollout proof and benchmark

- First use deterministic commands and fake CLI tests, which spend no Neon quota. Then one combined live Neon probe, with a second only for a diagnosed fix. Record attempts, successful model calls and refusal evidence separately. Use harmless canaries, never real secret contents.
- Prove a real file edit inside the selected tree; attempts to write outside, read another project and a secret-shaped canary, and contact a non-Google host fail. Prove keychain login works and no plaintext token appears. Preserve stdout/log evidence without credentials.
- Only after the probe passes, add Neon at high effort through the ACS roles API as a builder candidate, preserving existing members. Do not implement a scheduler or change unrelated roles.
- Coordinate with the existing Mac mini compute-pool agent at cmux surface:1000080000. Run the existing 10 builder cases at high effort through this exact builder boundary. Avoid competing with the review eval; ask the runner for current quota/status and keep reviews paused while builder cases run. Keep the benchmark's checks and judging rules unchanged; model identity remains unverified. Capture per-case results and total model calls.
- Finish with the installed /pr-review flow: code review plus Mythos security in one record, one fix round, context pass, one fix check, close at tip, push, PR, CI green, needs-human. Never merge.

## Acceptance criteria

- A1: `--build` requires an explicit canonical worktree and rejects unsafe roots and conflicting modes before agy starts; deterministic CLI tests pass.
- A2: read-only ask-model and review behavior remains exactly as walled today; existing agy tests and wall-equality checks pass without weaker assertions.
- A3: actual macOS builder-wall tests allow an in-tree edit and deny out-of-tree writes (including symlinks/hard links), protected metadata changes, other-project/secret reads and non-Google network; no fallback exists.
- A4: a live high-effort Neon probe proves an edit, the requested refusals, working keychain sign-in and no plaintext token, with an explicit probe count.
- A5: every builder answer/record still labels the answering model unverified; existing model checks are preserved.
- A6: the builder role gains Neon at high effort only after A4 passes, via ACS API; other role settings are preserved.
- A7: the 10 existing builder cases run on the Mac mini via the approved compute-pool runner at high effort; record scores, errors, quota delays and model-call counts honestly. Benchmark quality is measured, not promised to be 10/10.
- A8: the branch has the required review/security evidence, closed tip, green CI and an open needs-human PR; no push to main and no merge.

Validation: focused ask-model/agy tests and newly added wall/probe tests, then the existing benchmark commands as supplied by the compute-pool runner. No local full suite, Docker, e2e or local benchmark is authorized; use focused checks locally and CI for the full suite.

## Advisor decisions before implementation

Astra high advised in a fresh read-only ask-model call (exit 0); same vendor as this seat, different family. Its six advice scores were 80, 72, 72, 90, 70 and 72 out of 100. Full output is retained in advisor-result.md.

- Adopt a per-call origin-enforcing Google broker, direct network denial, scrubbed child environment, exact TLS authority and upstream certificate checks. Prove pinned agy transport compatibility with a non-model metadata operation first; no silent network fallback.
- Adopt private source inodes, protected policy/git paths, and validate changes before publishing them to the selected worktree. Preserve intended uncommitted source. Do not copy env files or operator secrets. Confine the benchmark's execution of model-edited code as well as the model process.
- Preserve the operator's existing keychain sign-in. A separate macOS identity is not required by Cris and would add OS account setup and a new login; do not create accounts or change global trust/keychain policy. Use isolated per-call state and tool/OS restrictions to prevent model access to sign-in storage; prove normal keychain load and refresh/save where observable. If safe reuse cannot be established, stop with evidence before enrollment.
- The minimal route may keep arbitrary command/MCP/URL tools denied. The benchmark's requested test execution must be represented honestly; the existing external grader remains authoritative, with its case commands unchanged. A narrow test action can be added only if needed to meet the brief, never a general unwalled shell.
- A1–A5 need deterministic proof before a live model call. If pinned agy cannot use the bounded transport or sign-in, report the concrete failure and do not enroll Neon.
- Scope of the benchmark adapter is explicitly included. Fresh output directory; containment/sign-in failures stop grading and discard unpublished edits. All agy outcomes carry modelVerified:false.

Quota: compute-pool reports Gemini 5-hour and weekly 100% remaining after a metadata usage read. No jobs running on the mini; agy 1.5.14. No Neon model calls so far. The 10-case benchmark is authorized on the Mac mini only.

## Listener experiment decision

The first builder committed only experimental evidence at 6cca2e4. A wildcard-listener canary showed that Seatbelt's localhost inbound rule is not an interface restriction. Two blind opinions (Astra and Sol-prev) agreed this does not establish a reachable escape through the exact pinned, edit-only route; both requested observation of actual agy before redesign. Their full outputs are listener-astra.md and listener-sol-prev.md.

The deciding zero-turn observation is `probe/actual-listener.mjs` and its redacted output. Across 26 observations of the agy process tree, agy opened two loopback-only listeners. Independent connections through both available non-loopback IPv4 interfaces were refused for both ports. Metadata succeeded with zero turns, clean token postflight and no plaintext token.

Continue the exact pinned route with the native binary and builder-immutable launch configuration explicitly part of containment. Do not claim Seatbelt's inbound rule alone limits interfaces. The production execution allowlist must not include the canary/test executable, arbitrary commands stay denied, private source inputs cannot alter agy's own configuration, and the live print/inference probe must also observe its listener scopes. Stop if actual agy opens a non-loopback listener or if a builder-reachable operation can repurpose one. The existing read-only paths remain unchanged. No inference, live roles or installed runtimes changed during these experiments.
