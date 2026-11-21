#!/bin/bash
# all.sh: every probe run, one line each — the re-run before moving AGY_VERSION (agy must bind 127.0.0.1, and
# sandbox-exec cannot start inside another sandbox, so outside any sandbox). Compare the lines with
# containment-probe.md. Each run makes and names its own folder.
set -euo pipefail
. "$(dirname "$0")/common.sh" || exit 2
P="$PROBE_DIR"
# Like the runtimes, --version runs from an empty folder this run made, never the caller's.
new_run
mkdir "$RUN/version"
cd "$RUN/version"
echo "agy $(CMUX_ANTIGRAVITY_HOOKS_DISABLED=1 AGY_CLI_DISABLE_AUTO_UPDATE=true "$AGY" --version </dev/null)"
# A token file agy writes when it gives up on the keychain would be new under these folders.
: > "$RUN/start"

"$P/run.sh" control
"$P/run.sh" deny
"$P/attr.sh" a .agent/hooks.json
"$P/attr.sh" b .agents/mcp_config.json
"$P/attr.sh" c .gemini/mcp_config.json
"$P/attr.sh" d .agents/plugins .agents/plugins.json
"$P/attr.sh" e .agents/plugins
"$P/attr.sh" f
"$P/attr.sh" g --sub src/deep .agents/hooks.json
"$P/agents.sh"
"$P/extra.sh" subagent
"$P/extra.sh" emptycwd
"$P/extra.sh" adddir
"$P/extra.sh" denylist
"$P/wall.sh" tmpread
"$P/wall.sh" homeread
"$P/wall.sh" search
"$P/wall.sh" subagent
"$P/wall.sh" session
"$P/wall.sh" keychain
# Every file the runs left under ~/.gemini and Antigravity's app data, beside the per-conversation folders and logs.
echo "new files under ~/.gemini and Antigravity's app data: $(find "$HOME/.gemini" "$HOME/Library/Application Support/antigravity" -type f -newer "$RUN/start" 2>/dev/null \
  | grep -v -E '/(conversations|brain|log|presence|implicit|annotations)/' | sed "s|^$HOME/|~/|" | sort | tr '\n' ' ')(end)"
