# Fix round — review 2026-11-16-23-36-54-2de516, f1 MEDIUM (fix). f2 and f3 are LOW: filed, don't fix.

f1 MEDIUM README.md:752 — The fault rig (builds/agent-command/rig/run.mjs) still spawns the worker CLI as `agent` from PATH, but this branch stops installing that name and the README says the rig needs `acs-agent`. On a fresh install every scenario fails with spawn ENOENT; on a Mac with Grok it runs Grok's `agent`. The rig's own error text (line 8) also says `agent`.
Fix: the rig spawns `acs-agent` everywhere and its messages say `acs-agent`; `node --check` it. Don't run the rig (the orchestrator will, live). Commit it (git add -f, builds/ is ignored). Reply DONE with the sha.
