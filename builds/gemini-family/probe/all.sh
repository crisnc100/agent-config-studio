#!/bin/bash
# all.sh: every probe run, one line each — the re-run before moving AGY_VERSION (agy must bind 127.0.0.1, so outside
# any sandbox). Compare the lines with containment-probe.md. Each run makes and names its own folder.
set -euo pipefail
. "$(dirname "$0")/common.sh" || exit 2
P="$PROBE_DIR"
echo "agy $("$AGY" --version)"
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
