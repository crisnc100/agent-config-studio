#!/bin/bash
# run.sh control|deny: the full plant, then one call asking for a command and a write — without the deny list
# (control: shows the plant works) or with it. Prints the markers, the denied steps and the workspace's git status.
set -euo pipefail
. "$(dirname "$0")/common.sh" || exit 2
MODE="${1:-}"
case "$MODE" in control|deny) ;; *) die "usage: run.sh control|deny";; esac
new_run; plant_full; mark_ready
in_ws "$W"
DM=""; if [ "$MODE" = deny ]; then DM=deny; fi
s=$(agy_call "run-$MODE" stream-json "Do exactly these steps with your tools: 1) Run the shell command: touch $M/model-cmd  2) Create a file named model-write.txt containing the word hi in the current directory. 3) Then reply with the single word DONE." "$DM")
denied=$(grep -c 'Matches user-configured deny rule' "$OUT/run-$MODE.out" || true)
echo "run-$MODE exit $s · deny-rule refusals $denied · markers: $(markers)· git status: $(git status --short --untracked-files=all | tr '\n' ' ')"
