# Phase 1 — harness contract, containment, and the containment test

You are implementing in this worktree ONLY:
/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-harness-picker

## Objective
Create the harness descriptor contract, make every harness spawn CONTAINED so it cannot
mutate user/project files, and prove it with an executable test that cannot pass vacuously.

## Read first (in this worktree)
- builds/harness-picker/context.md   <- the code seams, with line numbers. READ THIS FIRST.
- builds/harness-picker/plan.md      <- the design and the approved acceptance bar
- lib/chat.js                        <- the backend you are refactoring
- lib/assist.js                      <- a SECOND spawn path that also needs containment
- lib/paths.js                       <- resolveSafe/tilde helpers

## Steps

### Step 1 — lib/harness.js (new file)
Export a descriptor per harness (`claude`, `grok`) and `detectHarnesses()`.

Descriptor fields, ALL required:
  id, label
  detect()        -> {installed:boolean, binary:string|null, version:string|null}
  models          -> { '<id>': {label, effort?} }   per-harness allowlist
  defaultModel
  streams         -> boolean
  buildArgs({model, sessionId, effort, systemPrompt}) -> string[]
  promptDelivery  -> 'stdin' | 'file'
  containment     -> string[]  (MUST be non-empty; module load throws if any descriptor
                     has an empty containment array)
  resumeFlag      -> describes how a session id is passed. Must be expressive enough that a
                     future harness could resume via a SUBCOMMAND (e.g. `exec resume <id>`)
                     rather than a flag, WITHOUT changing the interface.
  decode          -> the output-decoding strategy this harness uses. Claude and Grok both
                     use the existing streaming parser; the field must exist so a future
                     buffered/non-streaming harness supplies its own decoder instead of
                     forcing a reshape.

Binary resolution: check known install locations BEFORE bare PATH.
  claude: typical install paths, then PATH
  grok:   ~/.grok/bin/grok, then ~/.local/bin/grok, then PATH
REJECT any candidate whose realpath contains 'cmux-cli-shims', or that is a wrapper shim.
Return the resolved ABSOLUTE real path.

Grok specifics (all verified working — do not re-derive):
  --output-format streaming-messages-json  --include-partial-messages
  -m <model>   models: grok-4.6 (default), grok-4.5
  --system-prompt-override <text>   (alias --system-prompt)
  -r <session_id>
  --reasoning-effort <effort>   (alias --effort)
  containment: ['--permission-mode','plan']
  NOTE: --sandbox and --permission-mode are ORTHOGONAL in grok. --sandbox does NOT contain
  it. Only --permission-mode does.

Claude specifics: current argv is
  -p --model <id> --output-format stream-json --verbose --include-partial-messages
  [--effort X] [--resume <id>]
  containment: you must DETERMINE the flag that actually strips write tools
  (investigate --disallowedTools / --allowedTools via `claude --help`) and PROVE it with the
  Step 4 test. Do not guess and move on. If the first flag you try does not demonstrably
  block a write, try the other and report what you found.

### Step 2 — the argv chokepoint
ONE function composes the final argv for a spawn. It MUST refuse to spawn (throw) if the
descriptor's containment args are not present in the composed argv. buildArgs() must not be
able to override or drop them. This is the single enforcement point.

### Step 3 — wire streamTurn (lib/chat.js) and lib/assist.js
- streamTurn gains a `harness` option, default 'claude'. Behavior for Claude must be
  unchanged apart from containment.
- SPAWN THE RESOLVED ABSOLUTE BINARY DIRECTLY. Do NOT keep `spawn('zsh',['-lc','claude
  "$@"',...])` — that re-resolves via PATH and can pick the very shim detection rejected.
  Keep arguments positional so no request value ever reaches a shell.
- promptDelivery: try 'stdin' for grok first (chat.js:282 already writes the prompt to the
  child's stdin, so both harnesses stay on one path). If grok does not accept the prompt on
  stdin, fall back to promptDelivery:'file' using --prompt-file with a temp file created
  O_EXCL 0600, unlinked ONLY after the child exits, and also removed on the spawn-failure
  and cancellation paths. Report which one you used and why.
- lib/assist.js's spawn path gets the same containment through the same chokepoint. Do not
  leave a second unrestrained door beside a fixed one.
- The MODELS map in chat.js is a SECURITY allowlist (a model id from an HTTP body must never
  reach a shell). Preserve that property per-harness.

### Step 4 — verify.sh (the part that matters)
Executable. Must include:
(a) DETECTION: every detected binary is an absolute real path with no 'cmux-cli-shims'
    segment; AND the child process actually spawned uses that exact path (capture the
    child's argv[0] at runtime — do not just check the detection function's return).
(b) CONTAINMENT, per detected harness — THIS MUST NOT BE ABLE TO PASS VACUOUSLY:
      - build a throwaway temp tree with a SKILL.md and a couple of sibling files
      - take a manifest: every path -> sha256 + mode
      - run a REAL Assist turn whose prompt explicitly and unambiguously demands the model
        edit the file directly on disk right now
      - re-take the manifest and compare the WHOLE TREE (not one file's hash)
      - ASSERT THE TURN ACTUALLY SUCCEEDED: exit 0, a non-empty assistant reply, no auth or
        timeout failure. A turn that never ran MUST FAIL THIS TEST, NOT PASS IT.
      - ASSERT THE WRITE WAS PREVENTED, not merely declined: the harness's init/telemetry
        shows write tools absent or permission mode restricted, or a blocked-write signal
        appears in the stream. MODEL OBEDIENCE ALONE DOES NOT COUNT AS CONTAINMENT.
    Out of scope: harness-owned session/cache/log writes. This is about user/project content.
(c) parseEdits() accepts each harness's reply and SEARCH matched exactly once.
(d) A throwaway codex-shaped descriptor (streams:false, buffered decode, resume as a
    SUBCOMMAND) satisfies the contract and routes — WITHOUT invoking codex and WITHOUT
    changing the interface. If it cannot, the contract is wrong: fix the contract.
(e) Parser fixtures, offline, no network:
      - a non-JSON noise line on stdout (e.g. "direnv: loading ~/.envrc") is SKIPPED, not fatal
      - a record carrying is_error:false is NOT treated as terminal
      - a delta split across chunk boundaries, including partial UTF-8, reassembles correctly

## Constraints
- Do NOT modify ~/.claude, ~/.codex, or ~/.grok. Tests use temp dirs only.
- Do NOT build a Codex adapter. Only the throwaway descriptor in test (d).
- Do NOT add dependencies. This repo has zero and that is deliberate.
- Do NOT touch server.js or public/app.js in this phase (that is Phase 2).
- Never weaken, skip, or narrow a check to make something pass.
- Keep it lean. Do not over-engineer.

## Validate
./verify.sh — run it after each step, read the failures, fix, re-run.

## Stop when
Every check in this phase passes, OR a choice is not determined by this brief — then STOP and
state the choice with your recommended answer. Report which containment flag actually worked
for Claude and whether grok accepted the prompt on stdin.
