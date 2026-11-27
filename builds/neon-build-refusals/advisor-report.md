## 1. SCOPE VERDICT

**Right-sized** for the guard and probes, but the probe fixture as planned cannot support the sandbox-default decision, and the saved exclusion belongs in a second small PR, not this one.

## 2. ADVISORY

I changed no files. I ran `tests/ask-model-build.mjs` (11/11 pass at baseline) and read agy 1.5.14's help and embedded prompt text. Claims about sandbox behaviour below come from that text, not from a measured run; the probes must confirm them.

**Probes**

1. **Make the sandboxed fixture a linked worktree.** Real builds run in worktrees whose git dir sits outside the workspace (this one's is `agent-config-studio/.git/worktrees/…`). agy's own text says sandboxed commands get "no access to other files outside the workspace". A plain `git init` fixture would show commit working, the default would flip on, and real worktree commits would then be refused.
2. **Have the fixed test write under `os.tmpdir()`.** agy's text lists `/tmp` as allowed, not `/var/folders/…`, and this repo's tests use `mkdtemp` there.
3. **Force both channels for each outside attempt.** `--sandbox` is described as "terminal restrictions", and 1.5.14's native `read_file` reads any absolute path (`builds/gemini-family/containment-probe.md:73`). Ask for the sibling write, canary read and example.com fetch once by shell and once by native tool. Otherwise the result depends on which tool the model happens to pick.
4. **Launch from an unsandboxed shell and capture proof the sandbox applied.** The binary contains "terminal sandbox unavailable… continuing in the default mode", so `--sandbox` can silently not apply, likely when the orchestrator's own Bash sandbox wraps the call. Do not default it on without a signal `ask-model` can check per call.
5. **Expect the sandbox to stay off.** By the plan's all-or-nothing rule, a shell-only block means normal permissions remain. Do not spend the third call trying to rescue it.

**Guard**

6. **Compute the denial flag from raw steps in `readAgy`, not from `actions`.** The `actions` array loses evidence in three ways:
   - `tools/ask-model.mjs:1651` deletes `refusal` when a later update for the same step is not an error. This is the stickiness bug.
   - `:1619` drops everything past 64 actions before classifying.
   - `:1618` skips any step whose tool name fails the regex, even if its state is `DENIED`.
7. **Widen what counts as denied.** `denied` at `:1675` only catches `ERROR` plus "deny rule"; state `DENIED`, approval and permission errors never reach it. Trigger on:
   - state `DENIED`
   - `ERROR` matching deny-rule, approval or permission text
   - `result.denied_actions`
   - subagent denials
8. **Do not trigger on `not-found`, `tool-error`, or `actionsComplete: false`.** A sandbox-blocked syscall inside a command that ends `DONE` is also invisible to the guard; document that limit instead of parsing command output.
9. **Nested evidence cannot be produced today.** Builds pass `includeTranscripts: !build` (`:1686`), so subagent denials are only "unknown" notes. Read transcripts for builds, emit label-only strings, and leave an unreadable transcript as a note.
10. **Keep the existing failure shape.** Omit `build`, exit 4, `answer: null`, a stable error phrase and the `denied` list. Add no new JSON fields or flags.
11. **Rewriting existing tests is unavoidable.** The default `fakeAgy()` stream carries deny-rule steps and `denied_actions`, so five tests assert exit 0 with denials (`tests/ask-model-build.mjs:194`, `:312`, `:318`, `:332`, `:444`). In the test-only commit, add a clean base kind and named denial kinds.
12. **Update the consumers.** `docs/neon-builder.md:29,37` and both build skills (`packs/build/skills/claude/build/SKILL.md:241`, `codex/…:167`) describe success. Each needs one sentence on a refusal failure, then `acs packs update build`.

**Saved exclusion**

13. **Ship it as a separate PR off main.** It shares no files with the guard and does not depend on the probes.
14. **The gap is wider than Random.** The live lineup is ordered opus, sol, neon with no `pick`, so the picker and the replacement chain can already reach Neon automatically as third. The setting must apply in every pick mode.
15. **Smallest honest shape is `pick.exclude`:**
    - Add the key to `PICK_KEYS` (`lib/roles.js:55`) and validate it against the lineup.
    - Merge it in `pickBuilder` (`:663`).
    - Refuse a `design` family that is excluded.
    - Mention it in `guideText` (`:792`), which today lists Neon in the lineup unqualified.
16. **Fix the panel in the same PR.** `public/app.js:5457` rebuilds `pick` from three fields, so any panel save would silently drop the exclusion.
17. **Naming Neon keeps working.** The named path checks `use`, not the picker. The stale-resolver refusal (`lib/roles-panel.js:82`) already protects an old installed `model-id`.

**Cut**

- Any opt-out or allow-command flags.
- Any sandbox reporting beyond what item 4 needs.
- Any reclassification in `agyBuildActions` beyond stickiness.

## 3. QUESTIONS

1. **May the saved exclusion ship as a second small PR?** The approval covers one PR. Recommended: yes, a separate PR now; the live config changes only after it merges and `acs install-model-id` runs.
2. **If probe 1 shows normal permissions refuse routine commands, how broad may the session allow list be?** Recommended: exact local git verbs only (`add`, `commit`, `status`, `diff`). Do not allow `node` or `npm` unsandboxed, since that is arbitrary code without approval. The cost is that a refused test run fails the build until evidence justifies more.
