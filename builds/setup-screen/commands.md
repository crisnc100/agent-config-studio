# Setup screen — every command it shows

The setup screen and Home show these commands and no others. `lib/setup-commands.js`
reads the table below at runtime, and `tests/setup-commands.mjs` checks that every
command the page can show comes from this table, carries a source and a date, and
(for the `next.*` rows) actually runs.

Each command was checked against the installed CLI's own `--help` or the vendor's
official install page on the date given. None was written from memory. A CLI with
no verified command for a step gets its `docs.*` link instead.

| key | command | source | checked |
|---|---|---|---|
| install.claude | `curl -fsSL https://claude.ai/install.sh \| bash` | https://code.claude.com/docs/en/setup ("Native Install (Recommended)", macOS, Linux, WSL) | 2026-10-04 |
| signin.claude | `claude auth login` | `claude auth login --help` on Claude Code 2.1.289: "Sign in to your Anthropic account" | 2026-10-04 |
| docs.claude | https://code.claude.com/docs/en/setup | official setup page | 2026-10-04 |
| install.codex | `npm install -g @openai/codex` | https://github.com/openai/codex README ("npm install -g @openai/codex") | 2026-10-04 |
| signin.codex | `codex login` | `codex login --help` on codex-cli 0.160.0: "Manage login"; with no subcommand it signs in | 2026-10-04 |
| docs.codex | https://github.com/openai/codex | official README | 2026-10-04 |
| install.grok | `curl -fsSL https://x.ai/cli/install.sh \| bash` | https://docs.x.ai/build/overview.md ("Install") | 2026-10-04 |
| signin.grok | `grok login` | `grok login --help` on grok 1.0.41: "Sign in to Grok"; also https://docs.x.ai/build/cli/reference.md | 2026-10-04 |
| docs.grok | https://docs.x.ai/build/overview | official Grok Build page | 2026-10-04 |
| next.model-id | `acs install-model-id` | this repo's `bin/acs` (`install-model-id` case); run by `tests/setup-commands.mjs` under a temp HOME | 2026-10-04 |
| next.worktree | `acs install-worktree` | this repo's `bin/acs` (`install-worktree` case); zsh/macOS only; `--dry-run` run by `tests/setup-commands.mjs` | 2026-10-04 |
| next.path | `acs install` | this repo's `bin/acs` (`install` case, `bin/acs-link.mjs`); run through the README by `tests/stranger.mjs` under a temp HOME | 2026-10-06 |

`|` inside a command is written `\|` so the table stays a table; the reader unescapes it.

When `acs` is not on the login shell's PATH, the `next.*` commands are shown with the
absolute path of this checkout's `bin/acs` in place of `acs`.
