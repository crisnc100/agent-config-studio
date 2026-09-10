#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Guards first: they are offline and instant, and a regressed security property
# should stop the run before spending 80s of live model calls proving the rest.
node tests/guards.mjs
# Offline too, and it exercises the reader that the whole tracker rests on.
node tests/usage-codex.mjs
node tests/usage-claude.mjs
node tests/usage-grok.mjs
node tests/usage-identity.mjs
node tests/usage-seats.mjs
node tests/usage-routes.mjs
node tests/usage-cli.mjs
node tests/phase1.mjs
node tests/phase2a.mjs
