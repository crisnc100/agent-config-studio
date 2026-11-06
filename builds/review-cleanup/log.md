# Builder log — review-gate PR C

## Part 1: shadow removal

- Removed: `shadow` / `REVIEW_SHADOW` (shadow reviewers, `--shadow-run`, `--shadow-report`) and `pickShadow` /
  `REVIEW_PICK_SHADOW` (shadow pickers, `--pick-shadow-run`, `--pick-report`), and their skill and example-config text.
- Kept `grokMcpAllow`: it is not shadow-only. Real grok reviews read it (`grokRefusal`) and so does
  `tools/ask-model.mjs`. An old config with it keeps working because it is still honored. Only the words "or shadow" left
  the skill's "Grok runs" paragraph.
- Old keys: `shadow` / `pickShadow` in any config, or `REVIEW_SHADOW` / `REVIEW_PICK_SHADOW` in the env, print one note on
  stderr (`ℹ <keys> ignored: shadow pickers were removed`), skipped under `--gate` like the other config notes. They are
  no longer own-file keys, so a tracked repo config with them gets this note instead of the "git tracks it" warning.
- The four removed commands are unknown flags: `✖ unknown flag <flag>`, exit 1, before anything else runs.
- `--shadow-report` went too (the plan lists the `--shadow-report` paths under Remove). The shadow log file is never
  read, rewritten or deleted; old lines stay in it.
- `runBounded` stays: the merge-tier classifier uses it. Its default timeout was `PICK_TIMEOUT_MS` (5 minutes, env
  `REVIEW_PICK_SHADOW_TIMEOUT_MS`); it is now `CLASSIFIER_TIMEOUT_MS`, the same 5 minutes, without the picker env knob.
- Pre-existing sandbox note: the close suite's waiver tests need a real PTY (`script: openpty: Operation not permitted`
  inside the agent sandbox); they fail the same way on main there and pass outside it.

## Part 2: code-review skill split

- claude SKILL.md 159 -> 60 lines (161 before part 1's shadow removal); codex 108 -> 58 (112 before part 1).
- Moved whole lines, byte for byte, by script; a check confirmed every line of the old skill is in SKILL.md or
  reference.md. New text: one pointer line in each SKILL.md, a two-line title and intro in each reference.md, and a
  `## Never (from the review policy)` header in the claude SKILL.md.
- The claude skill had no never-do list, so its SKILL.md repeats rules 6 and 9 verbatim under that header; the full
  policy (rules 1-11) stays whole in reference.md. The codex skill's own "Hard rules" stay in its SKILL.md.
- "Who reviews" stays in SKILL.md (it is how a reviewer is chosen, and the packs test pins `model-id --role reviewer`
  to SKILL.md).
- pack.json lists both reference.md files, so the installer copies them beside SKILL.md.
