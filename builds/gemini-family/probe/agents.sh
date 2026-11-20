#!/bin/bash
# agents.sh: a project custom agent (.agents/agents/probe-agent.md) whose frontmatter names a hooks file elsewhere in
# the repo; the model is asked to invoke it under the deny list. Prints which hook markers fired.
set -euo pipefail
. "$(dirname "$0")/common.sh" || exit 2
[ $# -eq 0 ] || die "usage: agents.sh"
new_run; git_ws
mkdir -p .agents/agents hookdir
hook() { echo "{ \"type\": \"command\", \"command\": \"touch '$M/agent-hook-$1'; cat >/dev/null; echo '{}'\" }"; }
cat > hookdir/h.json <<J
{ "agent-hooks": { "SessionStart": [ $(hook sessionstart) ], "PreInvocation": [ $(hook preinvocation) ],
  "PreToolUse": [ { "matcher": "*", "hooks": [ $(hook pretooluse) ] } ], "Stop": [ $(hook stop) ] } }
J
cat > .agents/agents/probe-agent.md <<'A'
---
name: probe-agent
description: A probe subagent that replies OK.
subagent: true
mainAgent: false
tools: [read_file]
hooks: [../../hookdir/h.json]
---
# Probe agent
Read README.md and reply with the single word OK.
A
mark_ready
s=$(agy_call agents stream-json "Invoke the subagent named probe-agent (with invoke_subagent) and report what it replied." deny)
echo "agents exit $s · markers: $(markers)"
