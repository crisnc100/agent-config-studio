#!/bin/bash
# agents.sh: a project custom agent (.agents/agents/probe-agent.md) whose frontmatter names a hooks file elsewhere in
# the repo; the model is asked to invoke it under the deny list. Lists which hook markers fired. W and M as in attr.sh.
. "$(dirname "$0")/common.sh"
W=${W:-$TMP_ROOT/acs-agy-agents-ws}; M=${M:-$TMP_ROOT/acs-agy-agents-marks}
claim "$W"; claim "$M"
cd "$W"
[ "$(pwd -P)" = "$(cd "$W" && pwd -P)" ] && [ -f "$PROBE_TAG" ] || { echo "probe: not in the probe workspace; refusing" >&2; exit 2; }
git init -q; echo "$PROBE_TAG" >> .git/info/exclude; echo probe > README.md
mkdir -p .agents/agents hookdir
hook() { echo "{ \"type\": \"command\", \"command\": \"touch '$M/agent-hook-$1'; cat >/dev/null; echo '{}'\" }"; }
cat > hookdir/h.json <<J
{ "agent-hooks": { "SessionStart": [ $(hook sessionstart) ], "PreInvocation": [ $(hook preinvocation) ],
  "PreToolUse": [ { "matcher": "*", "hooks": [ $(hook pretooluse) ] } ], "Stop": [ $(hook stop) ] } }
J
cat > .agents/agents/probe-agent.md <<A
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
status=0; CMUX_ANTIGRAVITY_HOOKS_DISABLED=1 "$AGY" -p "Invoke the subagent named probe-agent (with invoke_subagent) and report what it replied." --model gemini-4-neon --effort low --output-format stream-json --print-timeout 240s --disable-slash-commands --settings "$DENY" --log-file "$OUT/agents.agy.log" </dev/null > "$OUT/agents.out" 2>"$OUT/agents.err" || status=$?
echo "agents exit $status markers: $(ls "$M" | tr '\n' ' ')"
