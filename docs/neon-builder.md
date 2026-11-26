# Native Neon builds (`ask-model --build`)

`--build` runs Neon (an agy, Antigravity, family) as an ordinary builder that edits a git worktree. It is opt-in: without `--build`, agy keeps its read-only deny list and macOS sandbox (see "Asking another model" in the README).

```sh
ask-model --family neon --prompt-file brief.md --cwd <worktree-root> --build --json
```

When a build skill picks Neon, it saves the family and effort in the task
plan or handoff. It uses that family with `--family` and passes the saved
effort on every build call. Both phases and fixes use the same choice.

## Requirements

- `--cwd` is required and must be the canonical Git worktree root. The filesystem root, your home folder and any folder holding it are refused, and so is a path that is not its own `git rev-parse --show-toplevel`. This is checked before agy is run, even to read its version.
- The family (or `--role builder`) must resolve to an agy model; any other vendor exits 64.
- `--build` cannot be combined with `--investigate`, `--no-tools`, `--min-tools`, `--x-search` or `--schema`.
- `agy --version` must equal the tested version (`AGY_VERSION`), or the build does not start.
- `~/.gemini/antigravity-cli/antigravity-oauth-token` must not exist. It is checked before the version probe and again after it. Delete the file if it appears; agy signs in from the keychain without it.

## What runs

agy runs with `--mode accept-edits`, your normal HOME, its normal Antigravity permissions and configuration, the resolved model and effort, `stream-json` output and a finite print timeout. The wrapper adds no private source copy, OS sandbox, broker or permission override, and never passes `--dangerously-skip-permissions`. Normal permission prompts still apply.

The worktree is where the build is pointed, not an enforced boundary: agy can reach whatever its own permissions allow. The wrapper prefixes the prompt with instructions not to call other models, run reviews or grades, push, open a PR or merge. Those are instructions, not a security boundary.

## Results

Success exits 0 and `--json` carries `build: { execution: "native", completed: true }` and `served: { verified: false }`. Agy reports only the model it was asked for, so the model's identity is never verified. There is no `published` claim. `changed` is `null`: `ask-model` does not audit what the build touched, so read `git status` and the diff yourself.

After the call a private per-call log must be a readable regular file you own, and must not say agy fell back to a plaintext token file. A failure there, or a token file left behind, fails the build even if the answer was fine. The log is deleted afterwards; read-only calls keep theirs under `~/.agent-config-studio/logs/agy/`.

## Failures and cancellation

A signal sent to `ask-model` (INT, TERM or HUP) is remembered and kills agy's process group. The call then fails with exit 4 even if agy exits 0, and no completion is claimed. Edits made before an error or cancellation stay in the worktree; there is no rollback. Inspect the worktree before retrying.

`--json` also carries bounded `actions`, `denied` and `notes` parsed from agy's stream. They are diagnostics, not proof of isolation.

## Limits

This route runs the family you give to `ask-model --family`. A direct `ask-model --role builder` call uses the first unpaused family in role order. The build skills use `model-id --pick builder --json` to apply the configured task selection strategy.

The benchmark adapter's native Neon builds are described in `builds/neon-builder/benchmark-adapter/README.md`.
