# Grok with no borrowed MCP servers: a temp HOME, the real GROK_HOME

Decided 2026-11-03 (Cris, via the orchestrator). Evidence from `grok inspect --json` (grok 1.0.70): with
HOME=<empty temp dir>, GROK_HOME=<real ~/.grok> and GROK_{CLAUDE,CURSOR}_{MCPS,HOOKS}_ENABLED=0, the only MCP server
is `jev` (configToml, ~/.grok/config.toml); plugins [] and hooks [] (the ~/.claude plugin-cache borrowing finds
nothing); folder trust still comes from GROK_HOME; nothing is written into the temp HOME. Auth stays in GROK_HOME,
so the OAuth login and its in-place refresh are exactly a normal session's.

## 1. grokRunEnv (tools/ask-model.mjs and review.mjs; review.mjs keeps its own copy, installed alone)
Per grok call: a fresh empty temp dir (mkdtemp) as HOME, removed afterwards; GROK_HOME = process.env.GROK_HOME if set,
else <the real home>/.grok, resolved before anything changes; the four GROK_*_ENABLED=0 switches. The same env for the
preflight check and the model call, in the same cwd: ask-model, and review.mjs real and shadow runs.

## 2. The preflight (ask-model grokMcpLeft, review.mjs grokRefusal) under that env
A server may start only when its name is in grokMcpAllow AND it is grok-native: source.type "configToml" and
source.path is <GROK_HOME>/config.toml (realpath). A same-named server from a project .grok/config.toml or any other
source still refuses, as do plugin MCP servers, project hooks, unreadable output and any unlisted server.
`--deny MCPTool` and `--disallowed-tools search_tool,use_tool` stay, so the model cannot call an allowed server.

## 3. grokMcpAllow: server names, empty by default, operator-only
- review.mjs: config key `grokMcpAllow` (env REVIEW_GROK_MCP_ALLOW, comma-separated), an own-file key: a tracked repo
  config cannot set it.
- ask-model: the same key from the review gate's home config files only:
  ~/.agent-config-studio/review-gate/config.json, else ~/.claude/review-config.json (the first that exists).
A malformed value refuses grok with the reason.

## 4. Leader-mode guard
In leader mode a session can run inside a shared leader started with the real HOME, bringing the borrowed servers
back unseen by inspect. Leader mode is the `cli.use_leader` key (a pin, so also managed_config.toml and
requirements.toml) or `--leader`, which we never pass. Grok refuses when `use_leader = true` appears in
<GROK_HOME>/{config,managed_config,requirements}.toml or /etc/grok/{managed_config,requirements}.toml.

## 5. Docs
Both code-review SKILL.md twins, the second-opinion/advisor notes on grok, review-config.example.json and the
ask-model header.

## 6. Tests (stub grok, temp HOME, no model)
For ask-model and review.mjs: the inspect call and the model call both get HOME = a temp dir that exists (and is
empty) only during the call, and GROK_HOME = the original home's .grok; jev from <GROK_HOME>/config.toml with
grokMcpAllow ["jev"] runs; jev from a project source refuses; jev without the allowlist refuses; a plugin, hooks or
another server refuse; a tracked repo config's grokMcpAllow is ignored (review.mjs); leader mode refuses. The stubs
learn to log HOME and GROK_HOME in a test-only commit first.
