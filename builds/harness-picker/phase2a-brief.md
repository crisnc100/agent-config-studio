# Phase 2a — server: harness routing, validation, session binding

Worktree (work here only):
/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-harness-picker

STATE: Phase 1 is done, ./verify.sh is 15/15 green. lib/harness.js holds the descriptors,
detection, the composeArgv chokepoint and spawnContained. lib/chat.js streamTurn takes a
`harness` option (default 'claude'). DO NOT disturb any passing check.

SCOPE: server.js ONLY. Do NOT touch public/app.js — the UI is a separate phase.

## Steps

### 1 — expose only DETECTED harnesses
server.js:93-94 currently sends `models: modelList()`. Replace with a payload listing each
DETECTED harness and ITS models, plus which is default. An undetected harness must not
appear. Nothing hardcoded to this machine.

### 2 — validate on the way in (bar A3)
/api/chat and /api/assist accept a `harness` field. REJECT with a 4xx:
  - an unknown harness id
  - a harness that is not currently detected
  - a model that does not belong to THAT harness's descriptor (crossed pairs)
  - non-own properties / prototype keys (e.g. '__proto__', 'constructor') as a harness id —
    use Object.hasOwn, never a bare property lookup
Keep the existing security property: a value from a request body must never reach a shell.
Absent `harness` defaults to claude, preserving current behavior.

### 3 — SERVER-SIDE session binding (bar A5)
The server must bind each issued session id to the harness that produced it, and refuse a
mismatched pair regardless of what the client sends. A Claude session id submitted with
harness=grok is rejected, not passed through.
- keep an in-memory map sessionId -> harnessId, recorded when a turn returns a session id
- do NOT store a session id from a FAILED turn (non-zero exit, is_error, or no reply)
- unknown session id + any harness = treat as a new session rather than resuming blind
Bound the map so it cannot grow without limit (simple cap or age-out is fine — do not add
a dependency).

### 4 — tests (extend tests/, keep verify.sh as the entry point)
Add server-level tests that start the app on an ephemeral port and make REAL HTTP calls:
  - unknown harness -> rejected
  - undetected harness -> rejected. Simulate "undetected" by injecting PATH/env for the test
    process. DO NOT rename or move any installed binary.
  - crossed harness/model pair -> rejected
  - '__proto__' as harness id -> rejected, no prototype pollution
  - a Claude session id sent with harness=grok -> rejected
  - a failed turn does not persist a session id
  - the payload from step 1 contains only detected harnesses
Do not make these tests depend on a live model call where a fake/mocked turn will do —
keep them fast and offline where possible. The Phase 1 live containment checks stay as they are.

## Constraints
- Do NOT touch public/app.js, lib/harness.js's containment values, or any passing check.
- Do NOT modify ~/.claude, ~/.codex, ~/.grok.
- Do NOT add dependencies.
- Do NOT weaken, skip, or narrow any existing check.

## Validate
./verify.sh  (all Phase 1 checks plus the new server checks)

## Stop when
verify.sh is green including the new server tests, or a choice is not determined by this
brief — then stop and state it with your recommended answer.
