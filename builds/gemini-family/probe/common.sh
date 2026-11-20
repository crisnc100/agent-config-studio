# Shared by the probe scripts: where outputs go, the deny list the runtimes pass, the agy binary.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${PROBE_OUT:-${TMPDIR:-/tmp}/agy-probe-out}"
mkdir -p "$OUT"
AGY="${AGY:-$(command -v agy)}"
DENY='{"permissions":{"deny":["command(*)","write_file(*)","mcp(*)","read_url(*)","download_url(*)","execute_url(*)","unsandboxed(*)"]}}'
