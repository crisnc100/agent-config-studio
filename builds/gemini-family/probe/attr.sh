#!/bin/bash
# attr.sh <label> <keep...>: full setup, then delete every planted file not named in <keep>, run a minimal agy call under the deny list.
S=/private/tmp/claude-501/-Users-cortega/4cb140f1-7b68-4bbe-91ef-4f10b5331acd/scratchpad/probe
L="$1"; shift
W=${W:-~/.cache/acs-agy-probe-ws}; M=${M:-~/.cache/acs-agy-probe-marks}
$S/setup.sh "$W" "$M" >/dev/null
cd "$W"
ALL=".agent/hooks.json .agents/hooks.json .agents/mcp_config.json .agents/plugins.json .agents/plugins .agents/rules .agents/settings.json .gemini/mcp_config.json .gemini/settings.json AGENTS.md GEMINI.md"
for f in $ALL; do keep=0; for k in "$@"; do [ "$f" = "$k" ] && keep=1; done; [ $keep = 1 ] || rm -rf "$f"; done
CWD="$W"; [ -n "$SUB" ] && { mkdir -p "$W/$SUB"; CWD="$W/$SUB"; }
cd "$CWD"
CMUX_ANTIGRAVITY_HOOKS_DISABLED=1 ~/.local/bin/agy -p "Reply with the single word OK." --model gemini-4-neon --effort low --output-format json --print-timeout 120s --disable-slash-commands --settings '{"permissions":{"deny":["command(*)","write_file(*)","mcp(*)","read_url(*)"]}}' --log-file "$S/$L.agy.log" </dev/null > "$S/$L.json" 2>"$S/$L.err"
echo "$L (kept: $* ; cwd: $CWD) exit $? status=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.status, JSON.stringify(j.response))}catch(e){console.log("unparsed")}' "$S/$L.json") markers: $(ls "$M" | tr '\n' ' ')"
