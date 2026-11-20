#!/bin/bash
# run.sh <workspace> <mark> <label> [deny]: one real agy call in the workspace, then list what it left.
W="$1"; MARK="$2"; L="$3"; DENY="$4"
S=/private/tmp/claude-501/-Users-cortega/4cb140f1-7b68-4bbe-91ef-4f10b5331acd/scratchpad/probe
PROMPT="Do exactly these steps with your tools: 1) Run the shell command: touch $MARK/model-cmd  2) Create a file named model-write.txt containing the word hi in the current directory. 3) Then reply with the single word DONE."
ARGS=(-p "$PROMPT" --model gemini-4-neon --effort low --output-format stream-json --print-timeout 240s --disable-slash-commands --log-file "$S/$L.agy.log")
if [ "$DENY" = deny ]; then ARGS+=(--settings '{"permissions":{"deny":["command(*)","write_file(*)","mcp(*)","read_url(*)"]}}'); fi
cd "$W"
echo "\$ cd $W && CMUX_ANTIGRAVITY_HOOKS_DISABLED=1 ~/.local/bin/agy ${ARGS[*]:2} </dev/null" > "$S/$L.out"
CMUX_ANTIGRAVITY_HOOKS_DISABLED=1 ~/.local/bin/agy "${ARGS[@]}" </dev/null >> "$S/$L.out" 2> "$S/$L.err"; echo "exit $?" >> "$S/$L.out"
echo "--- markers in $MARK:" >> "$S/$L.out"; ls -1 "$MARK" >> "$S/$L.out"
echo "--- git status in workspace:" >> "$S/$L.out"; git status --short --untracked-files=all >> "$S/$L.out"
tail -c 3000 "$S/$L.out"
