# Bounce verdict (GPT-5.6 Sol high, read-only) — 30 findings

## ACCEPTED — folded into the plan (real gaps)

P0-1/2 + P1-28  THE CONTAINMENT TEST CAN PASS VACUOUSLY. An unchanged hash proves nothing if
  the model merely chose to obey, or auth failed, or it timed out, or it never called a tool.
  The documented Claude mutation was NONDETERMINISTIC, so a single obedient run is exactly
  the false pass to expect. => test must assert the turn COMPLETED SUCCESSFULLY and that a
  write was actually attempted-and-blocked or the tool was absent. This was the biggest hole.

P0-2  A single-file SHA is too narrow: misses sibling files, delete+recreate with identical
  bytes, transient write-then-restore, perms/xattr/symlink. => hash the WHOLE temp tree
  (path -> sha + mode), compare the manifest.

P0-3  "harness writes nothing to disk" is not achievable and not what we mean — CLIs
  legitimately write session state, caches, logs. => A6 scoped to: cannot mutate
  user/project content outside the Accept flow.

P0-4  Flag-based containment is blacklist-shaped and a CLI update can silently void it.
  => ALSO assert the EFFECTIVE tool set at runtime from the init event (grok reports
  permissionMode; claude's init reports tools), not just that we passed a flag.

P0-5  Ownership split: buildArgs() and containment can disagree; a descriptor could satisfy
  every field and still emit an unsafe argv. => ONE chokepoint composes final argv and
  refuses to spawn if containment args are absent from it.

P0-6/7  streams:false describes what a harness does NOT do and supplies nothing for decoding
  a buffered turn, extracting a session id, or mapping errors. Without an owned decoder the
  descriptors are argv presets, not adapters, and Codex WOULD force a reshape.
  => descriptor owns a `decode` strategy; the Claude/Grok one is the current parser.

P2-22  DETECTION AND SPAWN DISAGREE — the sharpest code finding. We resolve a real absolute
  binary, then spawn `zsh -lc 'claude "$@"'`, which re-resolves via PATH and can pick the
  very shim we rejected. => spawn the resolved absolute path directly.

P1-8   Session isolation is client convention only. => the SERVER binds each issued session
  id to its harness and refuses a mismatched pair.

P1-10  In-flight harness switch: late deltas/session id can land in the wrong slot.
  => bind callbacks to the harness+model captured at submit.

P1-14  Temp-file prompt path: exclusive create (O_EXCL), unlink only after child exit, and
  orphan sweep. Prompt content is user config text — it must not linger.

P1-19  Non-protocol lines on stdout (login-shell noise, update notices) break a strict JSONL
  parser. We OBSERVED `direnv: loading ...` in grok output this session. chat.js already
  does try/catch-continue per line — add a fixture that proves it.

P1-18  Treating mere presence of `is_error` as terminal is dangerous if grok emits
  is_error:false on a non-terminal record. => add a fixture.

P1-16  "rename the binary away" is destructive and violates the temp-only constraint.
  => simulate via injected PATH/env in the test instead.

P2-25  A3 covered UI exposure, not server enforcement. => server must REJECT an unknown or
  undetected harness, and a model that belongs to a different descriptor.

## REJECTED — correct in principle, scope creep for this increment
P1-9   session key including cwd/seed/effort. Harness+model is enough here. (Model added.)
P1-11/12 full failure-state session matrix and a formal "sticky" definition — take the two
       cheap parts (do not store a session id from a failed turn; persist the pick to
       localStorage) and leave the rest.
P2-24  hardening the whole zsh login-shell surface — mooted by spawning the absolute binary.
P2-30  a complete cancellation/timeout/process-leak bar. Cancellation already exists (kill
       handle); we keep temp-file cleanup + child kill and stop there.
P1-29  full Accept/Reject invariant suite — that is existing behavior, not this increment.
       One light regression assertion only.
P1-17  overstated: the bake-off DID drive grok's live stream end-to-end, not just parseEdits.
       The framing/fixture concerns (19, 18) are the real residue and are accepted above.
