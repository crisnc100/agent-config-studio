#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec node tests/phase1.mjs
