# Rename the `agent` command to `acs-agent` (one small PR)

Objective: the watchable-workers CLI installs and runs as `acs-agent`, never as `agent`, and the installer never replaces a ~/.local/bin entry it didn't create.

Why (found live on the operator's Mac after #91 merged): Grok Build ships its own `agent` command. `~/.grok/bin/agent` is earlier on PATH than ~/.local/bin, and Grok's installer also made `~/.local/bin/agent -> ~/.grok/bin/agent`. So our `agent` can't be reached by name on any Mac with Grok, and bin/agent-install.mjs would silently replace Grok's symlink (it only refuses a non-symlink).

Read first: bin/agent-install.mjs, bin/agent.mjs (usage/help text), bin/acs (usage line `acs agent [...]`, the `agent)` subcommand, stale-copy and update hints), bin/model-id.mjs (install calls agent-install), README.md (`agent` section and install sections), tests/agent-install.mjs, tests/agent-cli.mjs and any test or guard naming `~/.local/bin/agent` or the `agent` launcher (grep -rn "local/bin/agent\|bin', 'agent'\|'agent'" tests bin lib).

Steps:
1. Installed launcher is `~/.agent-config-studio/bin/acs-agent`, linked as `~/.local/bin/acs-agent`. The source files may keep their names (bin/agent.mjs, lib/agent.js); only the command name on PATH changes.
2. The installer replaces `~/.local/bin/acs-agent` only if it is missing or is a symlink pointing at our own launcher; anything else (a file, or a link elsewhere) → refuse with a clear message, change nothing. It never touches `~/.local/bin/agent` at all.
3. Help/usage text, README, `acs` usage and hints say `acs-agent`; `acs agent …` keeps working as the short form.
4. Tests: install creates acs-agent, leaves an existing `~/.local/bin/agent -> elsewhere` symlink untouched, refuses a foreign acs-agent link and a non-link file. Test first: these fail on main, then pass.
Constraints: these files only; no new deps; no scope creep; existing-assertion changes go in their own test-only commit (say which assertion and what it still guards). Commit at the end (git works in this worktree); never push, open a PR, or run reviews or other models.
Validate: node tests/agent-install.mjs && node tests/agent-cli.mjs && node tests/readme.mjs && node tests/guards.mjs && node tests/setup-guards.mjs && node tests/suite-coverage.mjs — all pass.
How to wait: run every test in the foreground with a timeout long enough to finish; never end your turn waiting on a background job.
Stop when: all validation passes and the work is committed — reply DONE with the commit shas, one line each. Or, if a choice isn't settled by this brief, stop and ask with your recommended answer.
