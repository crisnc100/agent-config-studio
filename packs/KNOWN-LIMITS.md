# Known limits

These are the limits we know about in the skill packs and the review gate. Each row says how it could happen,
so you can decide whether it matters on your machine.

Scores are **likelihood × impact**, each on a 1–10 scale, as recorded when the issue was reviewed.
"Unscored" means the issue was noted but never given a number.

## Installing packs (`acs packs`)

| Limit | How it could happen | Likelihood × impact | Fix idea |
|---|---|---|---|
| A pack command can spin at full CPU instead of saying "pack state is locked". The lock wait loop retries a failed read of the lock file at once, with no pause and no deadline (`lib/packs-files.js:164`). | The lock file `~/.agent-config-studio/packs/state.json.lock` exists but can't be read (another user made it, or its permissions changed) while an install, update or uninstall runs. | 1 × 3 = 3 | Treat a failed lock read like a held lock: wait, check the deadline, then fail with the usual message. |
| `acs packs status` stops with an error instead of marking the push gate as not working. The push-gate check runs git without first checking that git is there (`lib/packs.js:1065`). | The push gate was installed, and git later left your PATH. | 1 × 2 = 2 | Check for git first and report the push gate as "installed but not working" when it's missing. |
| Two pack commands can both remove the same stale lock (`lib/packs-files.js:165`). | Two commands start at the same moment and both find a lock left by a process that died. Each removes it, so the second may remove the first's fresh lock. | about 4 (reviewer's estimate) | Take a stale lock over by renaming it atomically, not by unlinking it and retrying. |
| The review-gate installers run `git` and `node` by bare name. `install-global.sh` and `install-hook.sh` start with `exec node`, and both call `git` by name, so a `.` or empty PATH entry picks those files from the folder the installer runs in. | Running an installer from a folder that holds an executable `git` or `node`, with `.` or an empty entry on PATH. The studio runs `install-global.sh` from its own working folder with its own `node` first on PATH (`lib/packs.js:968-975`), and nothing in the studio runs `install-hook.sh`, so this needs an installer run by hand from a hostile checkout. | 1 × 7 = 7 | Resolve `node` and `git` from absolute PATH entries only, as `review.mjs` and the hooks now do, or drop relative PATH entries at the top of each installer. |
| A Codex `writable_roots` entry written as a TOML multi-line string (`"""…"""` or `'''…'''`) is read as an ordinary string. | Hand-editing `~/.codex/config.toml` to use multi-line strings inside `writable_roots`. Paths never need them. | unscored | Parse multi-line strings in the `writable_roots` reader, or refuse that file with a clear message. |
| An update says you edited `wt.zsh` when you didn't. | The `worktree` pack was installed on a machine whose `wt.zsh` was already identical to the shipped one. The pack never records it as written, so later updates always report it as "you edited it" and keep it. | unscored | Record a file that was already identical at install as the pack's own. |

## The pack skills

| Limit | How it could happen | Likelihood × impact | Fix idea |
|---|---|---|---|
| When `model-id` is missing or fails, a role lookup stops with "model-id failed: run acs install-model-id". A single model lookup instead passes `MODEL-ID-UNRESOLVED-<family>`, so the step only stops when the agent CLI rejects that name. An effort lookup (`model-id --flavor … \| jq`) comes back empty, and the command then leaves the effort flag out, so the CLI uses its own default effort. | Running a pack skill in a shell where `model-id` isn't on PATH (for example, one that never read your shell profile). | unscored | Stop on a failed single-model or effort lookup too, before any CLI runs. |

## The Packs card in the studio

| Limit | How it could happen | Likelihood × impact | Fix idea |
|---|---|---|---|
| **Refresh status** updates the status lines but not the pack headings or the Update and Uninstall buttons (`public/packs-view.js:79`). | Install or uninstall a pack from a terminal while the card is open, then press Refresh status. The controls catch up when the view is reopened. | 3 × 3 = 9 | Repaint the headings and buttons from the refreshed status. |
| The review-gate preview is long. It lists about 70 hook-link rows one by one. | Opening the review-gate install preview. | unscored | Group the hook links into one row with a count. |
| The agent guard's preview says its settings "may change" instead of naming exactly what changes. | Opening the review-gate preview with the agent guard part selected. | unscored | Ask the guard installer for an exact list before the preview is shown. |
| The card has no button to add a harness that was installed after a pack. | You install Codex after a pack was installed for Claude only. | unscored | Show "Add for Codex" (or the newly found harness) on the installed pack's card. |
| The packs routes have no per-run token, so any local process can use them. `POST /api/packs/plan` answers a request that sends no Origin header, and apply needs only that plan's signature, which is a staleness hash, not a secret (`server.js:1181-1185`). Web pages are still stopped by the Host allowlist and the same-origin check. This is the studio's general localhost model, not something packs added. | Another process, or another OS user on the machine, sends those two requests to the studio's port while it runs. It can install packs and set your global `core.hooksPath`. | 1 × 6 = 6 | Put a random per-run token in the page and require it in a header on the mutating routes. |

## The review gate

| Limit | How it could happen | Likelihood × impact | Fix idea |
|---|---|---|---|
| Authorization is per file. A fixed finding authorizes any edit in that file, not just the lines it was about. | A fix check passes for one finding, and a later commit changes other lines in the same file before the close. | unscored (accepted as a known limit) | Check lines or hunks, not only file names. |
| Renames are refused at close. A rename counts as a delete plus an add, and the new path was never recorded. | Renaming a file that a finding was about after its fix check. | unscored | Track renames explicitly and record the new path. |
| A merge can make a close partial. Diffing a merge against its second parent lists that side's changes too, so files changed before the review can show up. | Merging another branch into yours after the review, then closing. The close comes out partial or refused rather than silently covering those files. | unscored | Leave merged-in changes out when the merge base is older than the review. |
| Reviews logged before paths were recorded close partial until they're reviewed again. Their findings authorize no file. | Closing a review that was logged by an earlier version of the review gate. | unscored | Re-review the branch. A one-time migration could add paths to old log entries. |
| There is no line or hunk check at all. Coverage is decided by exact file names only. | Any close: see the first row. | unscored | Same as the first row. |
| The push override and the waiver can be faked by an agent. They are allowed when the command runs in a terminal and no agent marker variable is set, and an agent can arrange both. The agent guard is an accident barrier, not a security boundary. | From an agent's shell: `env -u CLAUDECODE script -q /dev/null sh -c 'REVIEW_GATE_OVERRIDE=… git push'`. `script` gives the push a terminal, `env -u` drops the marker, and the agent guard doesn't look inside the command `script` runs. The same recipe makes `--waive` succeed. | 3 × 6 = 18 | Have the agent guard read the `-c` command of a shell found anywhere in a command line and block `REVIEW_GATE_OVERRIDE` the way it blocks `GIT_CONFIG*`, or read the override reason from `/dev/tty` instead of an environment variable. |
| The review log isn't signed, and agents can write to it. A made-up review line and close line for HEAD pass the push gate. | Appending two lines to `~/.agent-config-studio/review-log/review-log.jsonl`. The Codex log access part adds that folder to Codex's writable folders, so a sandboxed Codex agent can do it with a shell redirect; a Claude Code agent can anyway. The review gate assumes agents are not adversaries. | 2 × 6 = 12 | Sign each close with a key kept in a 0600 file that only the push gate and an operator-run close read, or write closes through a small helper that refuses when an agent marker is set. |
| The per-repo push hook finds node through PATH, so a `.` or empty PATH entry can run a repository's own `./node`. The global hooks and the agent guard drop relative PATH entries, but the per-repo `hooks/pre-push` copy was left as it is: `push.mjs` recognises old copies of it byte for byte, and changing it would make those copies run the gate twice. | A repo that has the older per-repo hook (`install-hook.sh`), no pinned `hooks/node-path` that works, a PATH holding `.` or an empty entry, and a branch that commits an executable `node`. Pushing runs that file. | 1 × 8 = 8 | Drop relative PATH entries in the per-repo hook too, and teach `push.mjs` the previous hook's bytes so both versions count as the per-repo hook. |
| The agent guard doesn't see a Git alias defined through environment variables. It checks `-c alias.*` and config writes, and it refuses `GIT_CONFIG_*` variables on push or commit, but an alias named some other way passes. | From an agent's shell: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0='push --no-verify' git p`. The guard lets it through (checked: exit 0), and the push skips the gate. | 1 × 6 = 6 | Read `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` pairs set on the command and expand any `alias.*` among them as the guard does for `-c`, or refuse `GIT_CONFIG_*` variables on any git command. |
| A repo can't opt out of the worktree-projects rule, and a malformed repo config blocks pushes. | With the worktree-projects push-gate part on, every push from a clone of a repo that tracks a `.worktrees.conf` is gated, and `reviewgate.enabled=false` in that repo doesn't turn it off. If the repo also ships a malformed `.claude/review-config.json`, pushes are blocked even when a close exists. | 2 × 3 = 6 | Treat `reviewgate.enabled=false` as an opt-out before the worktree-projects check, and have the push gate fall back to the home config when the repo config is malformed. |

## Platforms

| Limit | How it could happen | Likelihood × impact | Fix idea |
|---|---|---|---|
| Windows is not supported. | Running `acs packs` or the review gate on Windows. The shell scripts, hooks and paths assume a Unix system. | unscored | Out of scope for now. |
| Linux is best effort. macOS is the platform that is tested in full. | Running on Linux. It shouldn't break, but not every path has been run there. | unscored | Run the full test suite on Linux in CI. |
<!-- proof run: the pack tests on the Linux runner; this branch is never merged -->
