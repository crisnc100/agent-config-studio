#!/bin/bash
# run.sh <workspace> <marks> <label> [deny]: one real agy call in a workspace setup.sh made, asking for a command and a
# write, then list the markers and the workspace's git status. Outputs in $PROBE_OUT (default $TMPDIR/agy-probe-out).
. "$(dirname "$0")/common.sh"
W="${1:?usage: run.sh <workspace> <marks> <label> [deny]}"; MARK="${2:?}"; L="${3:?}"; MODE="${4:-}"
owned "$W"; owned "$MARK"
PROMPT="Do exactly these steps with your tools: 1) Run the shell command: touch $MARK/model-cmd  2) Create a file named model-write.txt containing the word hi in the current directory. 3) Then reply with the single word DONE."
ARGS=(-p "$PROMPT" --model gemini-4-neon --effort low --output-format stream-json --print-timeout 240s --disable-slash-commands --log-file "$OUT/$L.agy.log")
[ "$MODE" = deny ] && ARGS+=(--settings "$DENY")
cd "$W"
[ "$(pwd -P)" = "$(cd "$W" && pwd -P)" ] && [ -f "$PROBE_TAG" ] || { echo "probe: not in the probe workspace; refusing" >&2; exit 2; }
echo "\$ cd $W && CMUX_ANTIGRAVITY_HOOKS_DISABLED=1 agy ${ARGS[*]:2} </dev/null" > "$OUT/$L.out"
status=0; CMUX_ANTIGRAVITY_HOOKS_DISABLED=1 "$AGY" "${ARGS[@]}" </dev/null >> "$OUT/$L.out" 2> "$OUT/$L.err" || status=$?
echo "exit $status" >> "$OUT/$L.out"
{ echo "--- markers in $MARK:"; ls -1 "$MARK"; echo "--- git status in workspace:"; git status --short --untracked-files=all; } >> "$OUT/$L.out"
tail -c 3000 "$OUT/$L.out"
