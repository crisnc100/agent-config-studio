# Human timed run: a stranger's first 10 minutes

**Who:** Cris, on a **fresh macOS user account**, against the PR branch (`ready-for-strangers`), **before merge**. Per Cris's decision (2026-10-06), what this run finds is fixed in this PR, so this file is a merge gate.

**Pass bar:** under **10 minutes** from opening Terminal to Home showing your CLIs, a seat and a project folder, with **zero outside help**. Outside help means no other docs, no asking anyone, no reading the code. Only the README on GitHub (the PR branch's), and what the screen says.

## Before you start (not timed)

1. Create a new macOS user (System Settings → Users & Groups → Add User), log in as them, and open Terminal.
2. Make sure that account has nothing of yours:
   - no `~/.claude`, `~/.codex`, `~/.grok` or `~/.agent-config-studio`;
   - no `acs` alias;
   - `command -v acs` prints nothing.
3. Node and git: if the account lacks them, installing them is part of the run. Start the timer first and follow the README's "What you need".
4. Have one project on disk to point it at. For example, clone any repo into `~/code/`, or create `~/code/demo` holding a `CLAUDE.md`.
5. Since the branch is not merged, the clone step is: `git clone -b ready-for-strangers https://github.com/crisnc100/agent-config-studio.git`. Write down that this differs from the README's line. It is the only allowed deviation.

## The run (timed)

Start a timer. Follow **only** the README's **Get started**, top to bottom. Each time you stop to think, re-read, guess or get stuck, write a line in the log below: the time, where you were, and what you expected versus what happened.

| ✓ | Step | What should happen |
|---|---|---|
| ☐ | Read "What you need" | You know whether you have Node 20+, git and a CLI. Any CLI you lack, you install with the README's command. |
| ☐ | Install and sign in to one CLI (Claude Code, Codex or Grok) | The CLI's own sign-in completes. |
| ☐ | `git clone …` and `cd agent-config-studio` | The checkout exists. |
| ☐ | `./bin/acs` | The terminal prints `starting Agent Config Studio…`. The browser opens on http://localhost:8787 at the **setup screen**. |
| ☐ | macOS Documents prompt (if it appears during the folder scan) | You understand why it appears. The README's Troubleshooting covers it. |
| ☐ | Setup: **CLIs** | Your CLI is listed with its version and sign-in state. |
| ☐ | Setup: **Accounts** | You add the suggested seat, or knowingly skip it. |
| ☐ | Setup: **Project folders** | **Scan for projects** finds your folder, or you type it. You choose read or edit, and it is added. |
| ☐ | Setup: **Done** → **Finish** | You land on **Home**. |
| ☐ | Home | It shows your CLI, the seat, and `Project folders: 1`. |
| ☐ | `./bin/acs install` (in a second terminal, from the checkout) | It prints `linked ~/.local/bin/acs → …`. If `~/.local/bin` is not on PATH, it prints the one line to add, and you add it yourself. |
| ☐ | New terminal: `acs` | It prints `already running → http://localhost:8787`. |
| ☐ | `acs stop` | It prints `stopped.`, and the first terminal's studio exits. |
| ☐ | `acs help` | It lists the commands and ends with `checkout:` and this checkout's path. |

Stop the timer when Home shows your CLI, seat and folder. Write down that time, and keep going through the last four rows.

**Time to Home:** ______ min ______ s   **Total, through `acs help`:** ______ min ______ s

## Spot-checks after the run (not timed)

- ☐ Open **Skills**, **MCP**, **Models**, **Context** and **Worktrees**. Each opens without an error. Context lists your folder's `CLAUDE.md`.
- ☐ Assist works with whichever CLI you have:
  - **Claude:** a question about the folder's `CLAUDE.md` gets an answer.
  - **Grok, with an MCP server configured:** Assist refuses, names the server, and tells you how to fix it.
- ☐ `acs uninstall` removes the link, and `command -v acs` prints nothing in a new terminal.
- ☐ Nothing appeared in `~/.zshrc`, `~/.bash_profile` or `~/.profile` that you did not add yourself.

## Hesitation log

| Time | Where | Expected | What happened |
|---|---|---|---|
| | | | |

## Verdict

- ☐ **Pass:** under 10 minutes, zero outside help.
- ☐ **Fail:** each log row becomes a fix in this PR before merge.
