# Build log — pr pack

Choices the plan left open, and why.

- **Pinned lists first, test-only.** One commit (6890feb) adds `pr` to IDS, the SKILL.md counts (12 → 14), the
  catalog order and the card count, before any code, so the suites fail until the pack exists.
- **Catalog order:** `pr` goes in `lib/packs.js` ORDER after `flag`, before `worktree` — the skill packs stay
  together and worktree (shell tools) stays last.
- **GIF lives in the sections list:** `{ id: "gif", on, urls }`. Cris's final format makes the GIF a section like the
  others (on/off, order), so its URL list sits on that entry instead of a second top-level `gif` key.
- **Missing sections:** a style whose list leaves a section out gets it appended at the end, off (with a warning),
  except `deferred`, which is appended on. Duplicate titles fall back to the default title.
- **Base:** `--base`, else the open PR's base from `gh pr view` (origin/<base>, else the local branch), else
  `origin/HEAD`, else local `main`/`master`. A closed or merged PR does not count as open. The tracking branch is
  not used: for a feature branch it is the branch's own remote copy, not its base.
- **--check is computed from fresh facts** (same base flags), so the skill passes only the file. Rules, all
  invariants: every `on` section as `## <title>` in the configured order (Deferred findings only when the review is
  closed); an `off` section's heading is a problem; no section heading inside `<details>`; the record, when on and
  closed, folded as `<details><summary><title></summary>`; the summary's `Review: <id>` line never outside a fold;
  every deferred line verbatim under Deferred findings; unmet criteria and deferred HIGH lines verbatim above the
  first section; shas, review ids, finding ids (`f1`, `x1`, `s1`, `c1`, `r1`) and repo-relative file paths must come
  from the facts (a path tracked at HEAD counts). Unknown `##` headings and a missing GIF are warnings.
- **Word limits** are never checked; length guidance lives in the skill text only (Bounce revision).
- **Build log:** `log.md` beside the plan, cut at 6000 characters, feeds "What the agent did".
- **Review script lookup** follows the review-gate skill: the repo's `scripts/review.mjs` first, else
  `~/.agent-config-studio/review-gate/review.mjs`.
- **requires.git is true** (the helper reads git); `gh` cannot be expressed as a requirement, so the explain says the
  skill needs it to open the PR and the skill stops with a plain message when it is missing.
- **Codex twin** differs only in the helper path and two sandbox notes: the style-file write and `gh` (network) may
  need one escalated rerun; when `gh pr view` is refused, `gh pr create` answering "already exists" means edit.
- **Suites:** packs-server and packs-ui bind local ports, so they ran outside the sandbox. tests/package.mjs failed
  once (1 of 68, not captured) and passed on two reruns; likely another session's concurrent activity, not this pack.
- **Instructions part** (added on request): `packs/pr/instructions/pr.md`, kind `instructions`, default off, claude +
  codex, installed and removed by the existing marked-block machinery (no lib change). Turning it off
  (`uninstall pr --part instructions`) or uninstalling the pack removes the whole block, markers included; a CLAUDE.md
  the install created is removed again.
