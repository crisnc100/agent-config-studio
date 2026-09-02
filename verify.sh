#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node tests/phase1.mjs
node tests/phase2a.mjs
