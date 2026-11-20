#!/bin/bash
# run.sh <workspace> <marks> <label> [deny]: one real agy call in the workspace asking for a command and a write, then
# list the markers and the workspace's git status. Outputs in $PROBE_OUT (default $TMPDIR/agy-probe-out).
. "$(dirname "$0")/common.sh"
W="$1"; MARK="$2"; L="$3"; MODE="$4"
PROMPT="Do exactly these steps with your tools: 1) Run the shell command: touch $MARK/model-cmd  2) Create a file named model-write.txt containing the word hi in the current directory. 3) Then reply with the single word DONE."
ARGS=(-p "$PROMPT" --model gemini-4-neon --effort low --output-format stream-json --print-timeout 240s --disable-slash-commands --log-file "$OUT/$L.agy.log")
[ "$MODE" = deny ] && ARGS+=(--settings "$DENY")
cd "$W"
echo "\$ cd $W && CMUX_ANTIGRAVITY_HOOKS_DISABLED=1 agy ${ARGS[*]:2} </dev/null" > "$OUT/$L.out"
CMUX_ANTIGRAVITY_HOOKS_DISABLED=1 "$AGY" "${ARGS[@]}" </dev/null >> "$OUT/$L.out" 2> "$OUT/$L.err"; echo "exit $?" >> "$OUT/$L.out"
{ echo "--- markers in $MARK:"; ls -1 "$MARK"; echo "--- git status in workspace:"; git status --short --untracked-files=all; } >> "$OUT/$L.out"
tail -c 3000 "$OUT/$L.out"
