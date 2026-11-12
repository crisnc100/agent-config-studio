#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Snapshot the real config trees first, compare last: no test may write to them.
REAL_HOME_SNAPSHOT=$(mktemp "${TMPDIR:-/tmp}/acs-real-home.XXXXXX")
# The comparison runs on every exit, a failed suite included: a suite that
# writes to the real home and then fails is exactly the one to catch.
finish() {
  local st=$?
  node tests/real-home.mjs check "$REAL_HOME_SNAPSHOT" || st=1
  rm -f "$REAL_HOME_SNAPSHOT"
  exit "$st"
}
node tests/real-home.mjs save "$REAL_HOME_SNAPSHOT"
trap finish EXIT
# The test list, its order and the reason for each file's place are in tests/SUITE.
node tests/run.mjs --local
