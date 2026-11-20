#!/bin/bash
# attr.sh <label> [--sub <dir>] [<keep>...]: the full plant, then every planted file not named in <keep> removed; one
# minimal call under the deny list from the workspace (or <dir>, a plain subfolder path inside it). Prints the markers.
set -euo pipefail
. "$(dirname "$0")/common.sh" || exit 2
L="${1:-}"; shift || true
case "$L" in ''|*[!a-z0-9-]*) die "usage: attr.sh <label: a-z0-9-> [--sub <dir>] [<keep>...]";; esac
SUB=""
if [ "${1:-}" = --sub ]; then
  SUB="${2:-}"; shift 2 || die "--sub needs a folder"
  [[ "$SUB" =~ ^[a-z0-9_]+(/[a-z0-9_]+)*$ ]] || die "--sub must be a plain path of lower-case folders inside the workspace"
fi
for k in "$@"; do case " $PLANTED " in *" $k "*) ;; *) die "unknown planted file \"$k\" (one of: $PLANTED)";; esac; done
new_run; plant_full
in_ws "$W"
for f in $PLANTED; do keep=0; for k in "$@"; do [ "$f" = "$k" ] && keep=1; done; [ $keep = 1 ] || rm -rf -- "./$f"; done
mark_ready
if [ -n "$SUB" ]; then mkdir -p -- "$W/$SUB"; in_ws "$W/$SUB"; fi
s=$(agy_call "$L" json "Reply with the single word OK." deny)
echo "$L (kept: ${*:-nothing}; cwd: ${SUB:-.}) exit $s · markers: $(markers)"
