#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Snapshot the real config trees first, compare last: no test may write to them.
REAL_HOME_SNAPSHOT=$(mktemp "${TMPDIR:-/tmp}/acs-real-home.XXXXXX")
trap 'rm -f "$REAL_HOME_SNAPSHOT"' EXIT
node tests/real-home.mjs save "$REAL_HOME_SNAPSHOT"
# Guards first: they are offline and instant, and a regressed security property
# should stop the run before spending 80s of live model calls proving the rest.
node tests/guards.mjs
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
node tests/real-home.mjs check "$REAL_HOME_SNAPSHOT"
