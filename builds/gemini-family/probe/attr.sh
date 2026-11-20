#!/bin/bash
# attr.sh <label> <keep...>: full setup, then delete every planted file not named in <keep>; one minimal agy call under
# the deny list. W, M (workspace and marks folders) and SUB (a subfolder to run from) may be set in the environment.
. "$(dirname "$0")/common.sh"
L="$1"; shift
W=${W:-$HOME/.cache/acs-agy-probe-ws}; M=${M:-$HOME/.cache/acs-agy-probe-marks}
"$HERE/setup.sh" "$W" "$M" >/dev/null
cd "$W"
ALL=".agent/hooks.json .agents/hooks.json .agents/mcp_config.json .agents/plugins.json .agents/plugins .agents/rules .agents/settings.json .gemini/mcp_config.json .gemini/settings.json AGENTS.md GEMINI.md"
for f in $ALL; do keep=0; for k in "$@"; do [ "$f" = "$k" ] && keep=1; done; [ $keep = 1 ] || rm -rf "$f"; done
CWD="$W"; [ -n "$SUB" ] && { mkdir -p "$W/$SUB"; CWD="$W/$SUB"; }
cd "$CWD"
CMUX_ANTIGRAVITY_HOOKS_DISABLED=1 "$AGY" -p "Reply with the single word OK." --model gemini-4-neon --effort low --output-format json --print-timeout 120s --disable-slash-commands --settings "$DENY" --log-file "$OUT/$L.agy.log" </dev/null > "$OUT/$L.json" 2>"$OUT/$L.err"
echo "$L (kept: $* ; cwd: $CWD) exit $? $(head -c 200 "$OUT/$L.json") markers: $(ls "$M" | tr '\n' ' ')"
