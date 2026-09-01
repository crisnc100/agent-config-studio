# Plan — harness adapter contract + picker (Claude + Grok)

## Outcome
Assist can be driven by more than one CLI harness, chosen by the user, and no harness can
write to disk behind the Accept/Reject review flow.

## Design
New `lib/harness.js` holding a descriptor per harness. `streamTurn` stops hardcoding
Claude's argv and asks the descriptor for it. Everything else (buildTurn, parseEdits, the
stream parser) is shared and unchanged.

Descriptor fields (the contract):
  id, label
  detect()            -> {installed, binary, version} — resolves the REAL binary
  models              -> {id: {label, effort?}}  (per-harness allowlist; keeps the
                         existing "not in the map => refused, never reaches the shell" rule)
  defaultModel
  streams             -> boolean capability flag (Codex will be false)
  buildArgs({model, sessionId, effort, systemPrompt}) -> string[]
  promptDelivery      -> 'stdin' | 'file'
  containment         -> the arg(s) that remove write tools; MUST be non-empty
  resumeFlag          -> how a session id is passed

## Steps

1. `lib/harness.js` — descriptors for claude + grok, plus `detectHarnesses()`.
   Binary resolution walks known install paths BEFORE bare PATH, and rejects any candidate
   whose realpath contains `cmux-cli-shims` or resolves to a wrapper script.
   CHECK: `node -e "import('./lib/harness.js').then(m=>m.detectHarnesses().then(h=>console.log(h)))"`
   prints claude + grok with absolute real binaries; no shim paths.

2. Containment, proven not assumed. Determine the flag that actually strips Claude's write
   tools (try --disallowedTools / --allowedTools; whichever demonstrably works), and set
   grok's to `--permission-mode plan`. A descriptor with an empty `containment` must throw
   at module load — a harness with no containment is not shippable.
   CHECK: the containment test in step 6.

3. `streamTurn` takes `harness` (default 'claude'), asks the descriptor for argv and prompt
   delivery. Keeps positional-arg spawning — no request value ever reaches the shell.
   If promptDelivery==='file', write the prompt to a 0600 temp file and unlink it in a
   finally block.
   CHECK: existing Claude behavior unchanged (step 7 regression check).

4. Same containment applied to `lib/assist.js`'s spawn path. Do not leave a second,
   unrestrained door beside a fixed one.
   CHECK: grep shows no spawn of a harness binary anywhere without a containment arg.

5. Server + UI. `/api/chat` and `/api/assist` accept a `harness` field; server.js:93-94
   exposes only DETECTED harnesses with their models. app.js gets a harness picker beside
   the model select (:1627); choosing one repopulates the model list.
   Sessions are per-harness: session ids are stored keyed by harness, switching harness
   starts a fresh slot, switching back restores the previous one. Never send a Claude
   session id to grok.
   The picker is explicit and sticky — it does NOT auto-switch based on the open file.
   Because grok's first token can take ~37s, the UI must show a running indicator from
   submit, not from first delta.
   CHECK: with grok selected, a turn streams and the Claude session id is not reused.

6. `verify.sh` — executable, and the containment test is the one that matters:
   a. detection resolves past a wrapper shim (assert no 'cmux-cli-shims' in any binary path)
   b. FOR EACH DETECTED HARNESS: create a throwaway SKILL.md in a temp dir, record its
      SHA-256, run a real Assist turn whose prompt explicitly instructs the model to edit
      the file on disk, then assert the SHA-256 is UNCHANGED. This must fail loudly if a
      harness writes.
   c. parseEdits() accepts each harness's reply and SEARCH matched
   d. a streams:false descriptor is handled without live text (unit-level assertion on the
      flag; no Codex invocation)
   Reuse the approach in investigations/codex-assist-backend/bakeoff/run.mjs from the
   ORIGINAL checkout (it already imports the real buildTurn/parseEdits).

7. Regression: Claude Assist behaves as before apart from containment + the picker.
   CHECK: a Claude turn still streams deltas and still produces accepted proposals.

## Acceptance criteria (the bar) — revised after the Bounce

A1  lib/harness.js exports a descriptor per harness with: id, label, detect(), models,
    defaultModel, streams, buildArgs(), promptDelivery, containment, resumeFlag, AND an
    owned `decode` strategy. A Codex descriptor (streams:false, buffered decode, resume as
    a SUBCOMMAND not a flag) must be addable without changing the interface.
    [check: write a throwaway codex-shaped descriptor in the test and assert it type-checks
     against the contract and routes — no Codex invocation]

A2  Detection returns real binaries, never a shim/wrapper — AND THE SPAWNED CHILD USES THAT
    EXACT PATH. No `zsh -lc 'claude "$@"'` PATH re-resolution.
    [check: capture the child's argv[0] at runtime and assert it equals the detected
     absolute path; assert no 'cmux-cli-shims' segment]

A3  Server-side enforcement, not just UI hiding: /api/chat and /api/assist REJECT an unknown
    harness, an undetected harness, and a model that belongs to a different descriptor.
    [check: direct HTTP calls with a bogus harness, an undetected one, and a crossed
     harness/model pair — all rejected. Simulate "undetected" via injected PATH/env, never
     by renaming an installed binary]

A4  The harness choice is explicit, sticky across reload (localStorage), and never
    auto-switches on file selection. If the stored harness is no longer detected, fall back
    visibly rather than silently.  [manual + unit]

A5  Sessions are per-harness AND THE SERVER BINDS each issued session id to its harness,
    refusing a mismatched pair regardless of what the client sends. A session id from a
    FAILED turn is not stored. In-flight harness switches cannot land deltas or a session id
    in the wrong slot (callbacks bound to harness+model captured at submit).
    [check: switch-away/switch-back argv capture + a direct HTTP call sending a Claude
     session id with harness=grok]

A6  *** THE CRITICAL ONE — must not be able to pass vacuously ***
    No harness can mutate user/project content outside the Accept flow. Proven by, FOR EACH
    DETECTED HARNESS:
      (i)   a manifest (path -> sha256 + mode) of an entire throwaway temp tree, taken
            before and after, compared whole — not a single file's hash;
      (ii)  a prompt that explicitly and unambiguously demands a direct on-disk edit;
      (iii) an assertion THE TURN ACTUALLY SUCCEEDED (exit 0, a non-empty assistant reply,
            no auth/timeout failure) — a turn that never ran must FAIL the test, not pass it;
      (iv)  an assertion the write was actually PREVENTED rather than merely declined:
            either the harness's init/telemetry shows the write tools absent or the
            permission mode restricted, or a blocked-write signal appears in the stream.
            Model obedience alone does not count as containment.
    Scope note: harness-owned session/cache/log writes are OUT of scope; this is about user
    and project content.

A7  Claude Assist otherwise unchanged: still streams deltas, still yields accepted proposals.
    [regression check]

A8  ONE chokepoint composes the final argv and REFUSES TO SPAWN if the descriptor's
    containment args are not present in it. Applies to lib/assist.js's spawn path too.
    Proven by runtime argv capture on every public route, not by grep.

A9  Stream-parsing robustness fixtures (no network): non-JSON noise lines on stdout (we
    observed `direnv: loading ...` from a login shell this session) are skipped, not fatal;
    a record carrying `is_error:false` is NOT treated as terminal; split/partial UTF-8
    chunk boundaries reassemble correctly.

A10 Temp-file prompt path (if used): exclusive create (O_EXCL, 0600), unlinked only after
    the child exits, swept on startup, and removed on the spawn-failure and cancellation
    paths. Prompt bodies are user config text and must not linger.


## Constraints
- Do NOT modify ~/.claude, ~/.codex, ~/.grok. Tests use temp dirs only.
- Do NOT build the Codex adapter.
- Keep the positional-argv spawn property; never interpolate request values into a shell.
- No new dependencies (the repo has zero and that is a feature).
- Lean. Do not over-engineer.
