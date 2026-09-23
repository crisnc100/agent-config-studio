**Verdict: 9 of 9 PASS.** Two real risks outside the criteria, both about the shell path, plus a few minor bugs. Nothing here blocks the merge, but item 1 below deserves a decision before the bump diff.

## Criteria

**1. Call-site manifest — PASS.** The only writer of the live skill files is `rewrite-skills.py`, which aborts on any exact-substring count mismatch (line 303-310). I checked every one of its replacement pairs: each keeps the same resolved id and the same effort literal (e.g. `.codex/skills/advisor` degraded Sol stays `-c model_reasoning_effort=xhigh` on the untouched next line; build Bounce/Grade stay astra high, phase builds astra medium). Backup `sha256Before` values equal the before-capture hashes (spot-checked four files), and `sha256After` values equal the after-capture hashes. In `callsites.after.json` the only raw-id spans left are inside `~/.claude/CLAUDE.md` (the approved EXTERNAL file) and `seats.js` `grok-1`. The two allowed diffs are the fable-safe-prompt prose row and the Assist Fable id. Caveat: I could not execute `compare.mjs` in this session (no shell), it is not in `verify.sh`, and `log.md` does not record its output. The PASS rests on my manual check of the rewrite table, not on a recorded run.

**2. Scripts resolve the same — PASS.** `scripts.before.json` and `scripts.after.json` are identical across all 14 scenarios (live and no-config HOME), and each scenario records codex model+effort, verifier model+effort, every lens model+effort, and the labels from real stub argv.

**3. Resolver contract — PASS.** `tests/models.mjs:47-176` covers every family, raw passthrough, per-key merge, unknown family and unknown top-level key errors, malformed file → exit 1 + `MODEL-ID-UNRESOLVED-opus`, two HOMEs two answers, and `/bin/sh -c` with `PATH=/usr/bin:/bin:~/.local/bin` through the installed launcher, including the no-node and Homebrew fallbacks.

**4. One-edit proof — PASS.** `tests/models-assist.mjs:157-166` edits the user file under an already-running server and sees `claude-opus-5-5` on `/api/harnesses` and in spawn argv. `tests/models-scripts.mjs:42-50` shows the review.mjs opus lens, review-loop verifier (effort still xhigh), and review-loop-claude opus lens all move, nothing else. `tests/models.mjs:180-190` flags `modelSettings["claude-opus-5"]`.

**5. Assist safety — PASS.** `lib/harness.js:150-184` shape-checks every picker id and effort before it can enter the allowlist; `server.js:141-152` rejects any named model not on it (400) and validates the default too; `chat.js:216-219` and `assist.js:107-112` spawn only allowlisted ids. `tests/models-assist.mjs:168-216` plants all four ids as picker entries and as family values, asserts none reach argv, covers default-dropped and all-dropped. `tests/guards.mjs` is unmodified.

**6. Fresh machine + broken file — PASS.** Expected labels in the test match the pre-refactor capture (`callsites.before.json:4481-4515`); malformed file at start → server up, `registryError` names the file, defaults served, a turn runs.

**7. Lint — PASS** (with the approved CLAUDE.md deferral). `tests/models.mjs:196-250` plants each case and runs the real scope. My own grep of both skill trees for all six patterns hits only `*.bak-*`, `synced/`, and `.system/`, all excluded.

**8. Backup restorable — PASS.** Manifest holds exactly the 23 files the rewrite script writes, with both checksums; `tests/models-backup.mjs` restores the real backup into a temp target and verifies `sha256Before`.

**9. Suite — PASS.** `verify.sh:5-7,29` snapshots and re-checks the three real trees; 728/0 twice was reported to me, not re-run here.

**Hunted and clean:** no `$(model-id …)` inside single quotes or heredocs (the only adjacent single-quoted string is jq's own `'$m'`); the sonnet sentinel is compared raw at `review.mjs:330`, `review-loop-claude.mjs:79,180,183` with `modelId()` only inside the non-sonnet branch.

## Outside the criteria

- **Shell sites still fall through to `-m ""` when `model-id` is absent from PATH.** The UNRESOLVED guarantee only holds once the binary runs. `~/.local/bin` is on PATH via `.zshrc` only, not `.zshenv`, so a non-interactive shell (cron, a scrubbed-env sandbox) gets `command not found` and an empty substitution, exactly the case plan.md line 43 forbids. The `.mjs` scripts are safe (tested). Fix is small: `"$(model-id x || echo MODEL-ID-UNRESOLVED-x)"` in the skill lines, or put `.local/bin` in `.zshenv`.
- **Install step is undocumented.** `acs install-model-id` appears only under `builds/`. A fresh machine fails loudly everywhere until it runs, which is acceptable, but nothing tells the user to run it.
- **`assist` merge is per harness, not per key** (`lib/models.js:127`). A user file with only `assist.claude.picker` loses `default` and `retired`, yielding `default "undefined" is not in the picker` and dropping the Fable migration.
- **`--sidecars` false positives** on Claude Code aliases like `opusplan` or `default` in `settings.json` (`lib/models.js:278-281`). Also `~/.codex/config.toml` now says `gpt-6-sol`, so it is reported today; plan.md's "surfaced" bullet is stale.
- **Alias behavior change:** `REVIEW_CLAUDE_MODEL=opus` or `haiku` now resolve to concrete ids instead of passing the Claude Code alias through. Same model today, different argv. Labels at `review.mjs:414` and `review-loop-claude.mjs:183` print the unresolved name (`claude-solo-fable`).
- **Artifacts:** `grade-diff.patch` is stale (its `bin/model-id` lacks the Homebrew fallback the live file has), and `builds/model-registry/__pycache__/*.pyc` is staged for commit.