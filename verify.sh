#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Snapshot the real config trees first, compare last: no test may write to them.
REAL_HOME_SNAPSHOT=$(mktemp "${TMPDIR:-/tmp}/acs-real-home.XXXXXX")
# The comparison runs on every exit, a failed suite included: a suite that
# writes to the real home and then fails is exactly the one to catch.
finish() {
  local st=$?
  node tests/real-home.mjs check "$REAL_HOME_SNAPSHOT" || st=1
  rm -f "$REAL_HOME_SNAPSHOT"
  exit "$st"
}
node tests/real-home.mjs save "$REAL_HOME_SNAPSHOT"
trap finish EXIT
# Guards first: they are offline and instant, and a regressed security property
# should stop the run before spending 80s of live model calls proving the rest.
node tests/guards.mjs
# Before any worktree test: proves the tripwire sees each path the installer writes.
node tests/worktree-tripwire.mjs
# Offline too, and it exercises the reader that the whole tracker rests on.
node tests/usage-codex.mjs
node tests/usage-codex-limits.mjs
node tests/usage-claude.mjs
node tests/usage-grok.mjs
node tests/usage-identity.mjs
node tests/usage-processes.mjs
node tests/usage-accounts.mjs
node tests/usage-shell.mjs
node tests/usage-seats.mjs
node tests/usage-routes.mjs
node tests/usage-cli.mjs
node tests/acs-update.mjs
# The folder registry and `acs roots`: temp HOMEs only.
node tests/roots.mjs
node tests/skills.mjs
node tests/phase1.mjs
node tests/phase2a.mjs
node tests/zip.mjs
node tests/export.mjs
node tests/skill-usage.mjs
node tests/models.mjs
node tests/models-assist.mjs
node tests/models-scripts.mjs
node tests/models-backup.mjs
node tests/models-panel.mjs
# Check now refreshing every Codex home: a fake codex, temp HOMEs.
node tests/models-refresh.mjs
node tests/memory.mjs
node tests/context-map.mjs
# The worktree toolkit, its installer and the read-only panel: temp HOME, temp repos.
node tests/worktree-install.mjs
node tests/worktree-tools.mjs
node tests/worktree-panel.mjs
node tests/own-writes.mjs
# The front end, in a node VM against stubbed routes: no server, no HOME.
node tests/shell.mjs
node tests/home.mjs
# What the registry tells the Files page (temp HOME).
node tests/files-registry.mjs
# The MCP route's note on a machine with no ~/.claude.json (temp HOME).
node tests/mcp-route.mjs
# A stranger's machine: empty temp HOME, no agent CLI on PATH, every GET route.
node tests/fresh-home.mjs
