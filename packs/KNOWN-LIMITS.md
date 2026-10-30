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
| A Codex `writable_roots` entry written as a TOML multi-line string (`"""…"""` or `'''…'''`) is read as an ordinary string. | Hand-editing `~/.codex/config.toml` to use multi-line strings inside `writable_roots`. Paths never need them. | unscored | Parse multi-line strings in the `writable_roots` reader, or refuse that file with a clear message. |
| An update says you edited `wt.zsh` when you didn't. | The `worktree` pack was installed on a machine whose `wt.zsh` was already identical to the shipped one. The pack never records it as written, so later updates always report it as "you edited it" and keep it. | unscored | Record a file that was already identical at install as the pack's own. |

## The Packs card in the studio

| Limit | How it could happen | Likelihood × impact | Fix idea |
|---|---|---|---|
| **Refresh status** updates the status lines but not the pack headings or the Update and Uninstall buttons (`public/packs-view.js:79`). | Install or uninstall a pack from a terminal while the card is open, then press Refresh status. The controls catch up when the view is reopened. | 3 × 3 = 9 | Repaint the headings and buttons from the refreshed status. |
| The review-gate preview is long. It lists about 70 hook-link rows one by one. | Opening the review-gate install preview. | unscored | Group the hook links into one row with a count. |
| The agent guard's preview says its settings "may change" instead of naming exactly what changes. | Opening the review-gate preview with the agent guard part selected. | unscored | Ask the guard installer for an exact list before the preview is shown. |
| The card has no button to add a harness that was installed after a pack. | You install Codex after a pack was installed for Claude only. | unscored | Show "Add for Codex" (or the newly found harness) on the installed pack's card. |

## The review gate

| Limit | How it could happen | Likelihood × impact | Fix idea |
|---|---|---|---|
| Authorization is per file. A fixed finding authorizes any edit in that file, not just the lines it was about. | A fix check passes for one finding, and a later commit changes other lines in the same file before the close. | unscored (accepted as a known limit) | Check lines or hunks, not only file names. |
| Renames are refused at close. A rename counts as a delete plus an add, and the new path was never recorded. | Renaming a file that a finding was about after its fix check. | unscored | Track renames explicitly and record the new path. |
| A merge can make a close partial. Diffing a merge against its second parent lists that side's changes too, so files changed before the review can show up. | Merging another branch into yours after the review, then closing. The close comes out partial or refused rather than silently covering those files. | unscored | Leave merged-in changes out when the merge base is older than the review. |
| Reviews logged before paths were recorded close partial until they're reviewed again. Their findings authorize no file. | Closing a review that was logged by an earlier version of the review gate. | unscored | Re-review the branch. A one-time migration could add paths to old log entries. |
| There is no line or hunk check at all. Coverage is decided by exact file names only. | Any close: see the first row. | unscored | Same as the first row. |

## Platforms

| Limit | How it could happen | Likelihood × impact | Fix idea |
|---|---|---|---|
| Windows is not supported. | Running `acs packs` or the review gate on Windows. The shell scripts, hooks and paths assume a Unix system. | unscored | Out of scope for now. |
| Linux is best effort. macOS is the platform that is tested in full. | Running on Linux. It shouldn't break, but not every path has been run there. | unscored | Run the full test suite on Linux in CI. |
