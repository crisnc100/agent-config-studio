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

agy runs with `--mode accept-edits`, your normal HOME, its normal Antigravity permissions and configuration, the resolved model and effort, `stream-json` output and a finite print timeout. The wrapper adds no private source copy, OS sandbox or broker, and no permission rule except the allow rules `--allow-command` asks for (below). It never passes `--dangerously-skip-permissions`, `--sandbox` or another `--mode`. Normal permission prompts still apply.

The worktree is where the build is pointed, not an enforced boundary: agy can reach whatever its own permissions allow. The wrapper prefixes the prompt with instructions not to call other models, run reviews or grades, push, open a PR or merge. Those are instructions, not a security boundary.

## Granting the task's commands

Normal permissions can refuse a test or git command, and a refused action fails the build. `--allow-command <command>`, given up to 16 times, passes agy one session allow rule per string:

```sh
ask-model --family neon --prompt-file brief.md --cwd <worktree-root> --build --json \
  --allow-command 'node --test tests/phase.test.mjs' --allow-command 'git add -A' \
  --allow-command 'git commit -m "Phase 1: parse the config file"'
```

- The strings become `--settings '{"permissions":{"allow":["command(<string>)",…]}}'`, in the order given, for that call only. Nothing is saved, and no deny rule or other key is added. Without the flag there is no `--settings` argument.
- Each string is one line of 1 to 512 characters, using only letters, digits, spaces and `_ - . / : = @ , + " '`, with no leading or trailing space and no repeats. That leaves out globs, chaining, pipes, redirection, expansion, escapes and parentheses. Any other string, more than 16, the flag without `--build`, or a family agy does not run exits 64 before agy is started. Strings come only from the command line; no file is read for them.
- The prompt lists the strings verbatim after the preamble and tells the builder to run each exactly as written. Other commands stay under normal Antigravity permissions: the wrapper neither grants nor refuses them.
- A rule names one string. In live probes a rule let through the command written in it; whether agy matches a rule exactly or as a prefix is unverified. A grant is not isolation: a granted test runs as you, with your access.
- A refused action still fails the build. `--json` does not list the grants or the commands agy ran.

## Results

Success exits 0 and `--json` carries `build: { execution: "native", completed: true }` and `served: { verified: false }`. A build in which agy refused any action never succeeds (see below). Agy reports only the model it was asked for, so the model's identity is never verified. There is no `published` claim. `changed` is `null`: `ask-model` does not audit what the build touched, so read `git status` and the diff yourself.

After the call a private per-call log must be a readable regular file you own, and must not say agy fell back to a plaintext token file. A failure there, or a token file left behind, fails the build even if the answer was fine. The log is deleted afterwards; read-only calls keep theirs under `~/.agent-config-studio/logs/agy/`.

## Failures and cancellation

A signal sent to `ask-model` (INT, TERM or HUP) is remembered and kills agy's process group. The call then fails with exit 4 even if agy exits 0, and no completion is claimed. Edits made before an error or cancellation stay in the worktree; there is no rollback. Inspect the worktree before retrying.

A refused action fails the build with exit 4, `answer: null` and no `build`, even when agy's turn ends SUCCESS with an answer. A refusal is a tool step that ends `DENIED`, or `ERROR` on a deny rule, a missing approval or consent, a user who denied permission, or a permission error (EACCES, EPERM, permission denied, operation not permitted); or an entry in agy's `denied_actions` on any result event. A step's failed state and its error message count together when agy sends them in separate updates, and a later update or result never clears an earlier refusal. An inline subagent's state and error count together the same way under either of its ids (`conversation_id` or `log_uri`), including evidence sent under each id before an update names both; a subagent refused under both ids is listed once. Other tool errors, such as a file not found or a failed command, do not fail the build. If agy also reports being asked for a different model, the build still exits 4 and the error names both; a different model with no refusal exits 2.

`--json` also carries bounded `actions`, `denied` and `notes` parsed from agy's stream. Each `denied` entry names the tool and the kind of refusal, never agy's message. `denied` and `notes` each stop at 64 entries; when there are more, the last entry counts the ones left out. They are diagnostics, not proof of isolation.

## Limits

Refusals are read from agy's stream only. A subagent's own steps are in a transcript a build does not read, so its refusals are unknown unless the stream carries them, and a `notes` entry says the subagent ran. A shell command that fails inside a step agy reports as `DONE` is not a refusal, whatever its output says. Read the diff and the test output yourself.

Builds do not use agy's `--sandbox`. In a probe with it, shell commands still wrote and read temporary files beside the worktree. The example.com fetch failed with `ENOTFOUND`; this observation does not establish a general network boundary.

A native file-tool read of the outside canary was refused in both scoped probes, ending those turns. Native outside writes and native URL fetches were not attempted. All three live sessions used inert fixture files and recorded permission observations.

This route runs the family you give to `ask-model --family`. A direct `ask-model --role builder` call uses the first unpaused family in role order. The build skills use `model-id --pick builder --json` to apply the configured task selection strategy.

The benchmark adapter's native Neon builds are described in `builds/neon-builder/benchmark-adapter/README.md`.
