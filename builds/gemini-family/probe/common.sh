# Shared by the probe scripts: where outputs go, the deny list, the agy binary, and the only folders they may touch.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_ROOT="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
OUT="${PROBE_OUT:-$TMP_ROOT/agy-probe-out}"
mkdir -p "$OUT"
AGY="${AGY:-$(command -v agy)}"
DENY='{"permissions":{"deny":["command(*)","write_file(*)","mcp(*)","read_url(*)","download_url(*)","execute_url(*)","unsandboxed(*)"]}}'
PROBE_TAG=.acs-agy-probe-owned

# The probe deletes and plants files, so it works only in folders it made: under the temp folder, and tagged by it.
under_tmp() {
  local parent; parent="$(cd "$(dirname "$1")" 2>/dev/null && pwd -P)" || { echo "probe: $(dirname "$1") does not exist" >&2; exit 2; }
  case "$parent/" in "$TMP_ROOT"/*|/private/tmp/*|/tmp/*) ;; *) echo "probe: $1 is not under $TMP_ROOT or /tmp; refusing" >&2; exit 2;; esac
}
owned() {
  under_tmp "$1"
  [ -d "$1" ] && [ ! -L "$1" ] && [ -f "$1/$PROBE_TAG" ] || { echo "probe: $1 was not made by this probe; refusing to touch it" >&2; exit 2; }
}
# claim <dir>: a fresh, empty, tagged folder at <dir>. One that exists is cleared only when this probe made it.
claim() {
  under_tmp "$1"
  if [ -e "$1" ] || [ -L "$1" ]; then owned "$1"; rm -rf "$1"; fi
  mkdir "$1"; : > "$1/$PROBE_TAG"
}
