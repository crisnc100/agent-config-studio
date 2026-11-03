# Review routing by tier, shadow reviewers, and grok's MCP servers

Cris's decisions of 2026-11-02. review.mjs only; ask-model changes only if grok gets a per-run MCP switch.

## 1. Routing (replaces the default pick)
Order, first that applies wins:
1. `REVIEW_REVIEWER` / config `reviewer` (unchanged).
2. A `force` rule (unchanged; Cris's has riskPaths → fable).
3. An explicit pick: `REVIEW_PICK`, or a config `pick` (see open choice A): jev or another classifier, first, rotate, a family.
4. `routing`, default `[{"maxLines":150,"family":"opus"},{"family":"sol"}]`: the first entry whose `maxLines` the diff's
   changed lines (added + removed) are under; an entry without `maxLines` takes the rest. A diff touching riskPaths
   skips any `maxLines` entry (a risky diff is never "small"), so with no force rule it lands on the catch-all.
Routing ignores crossFamily: opus may review an Anthropic-built branch, as Cris decided. Each family runs at its own
effort in the reviewer role (opus xhigh, sol xhigh today) and must be a reviewer-pool family with its CLI installed,
else the run stops and names the fix, as a named pick does. Grok is in no default and is picked only when named.
Fix checks route on the fix diff's stats the same way. `--show-config` shows the route taken.

## 2. Shadow reviewers
Config `shadow: ["grok"]` or `REVIEW_SHADOW=grok[,…]` (own-file key: a tracked repo config can't set it). After the
real review is logged and its report written, review.mjs writes the exact prompt to a temp file and starts
`review.mjs --shadow-run <reviewId> <family> <prompt-file>` per family, detached (`detached`, stdio to /dev/null, `unref`),
and exits as before. The shadow runs that family on the same prompt with the same schema and quote check, and appends
one record to `review-log/shadow-log.jsonl` (same lock as the main log): `{reviewId, family, model, ok, findings,
durationMs, error}`. It never writes the main log, reports or statuses, so closes, the push gate and `--summary` can't
see it; a failure or refusal is a record with `ok: false` and `error`. Reviews only, not fix checks (open choice C).

`--shadow-report [--since <YYYY-MM-DD>]`: per shadow family, over shadow records joined to their real review:
- matched: a shadow finding with the same file as a real finding and a line within 5 of it, or a quote that, with
  whitespace collapsed, contains or is contained in the real finding's quote;
- unique: shadow findings that match none;
- missed: real findings no shadow finding of that run matched;
- runs, failures, and the average durationMs of successful runs.

## 3. Grok's MCP servers
review.mjs (real and shadow) refuses grok the way ask-model does: `grok inspect --json` under the GROK_*_ENABLED
switches; any MCP server or plugin MCP left on, or project hooks, means grok is not run. The check moves into one
shared module both use if the runtime's standalone copy allows it; otherwise review.mjs carries the same function
(it is installed alone today).

**Investigation: no clean per-run switch found (evidence, grok 1.0.70).** With GROK_CLAUDE_MCPS_ENABLED=0 and
GROK_CURSOR_MCPS_ENABLED=0 set, `grok inspect --json` still lists `jev` (source configToml, ~/.grok/config.toml) and
`supabase` (source plugin), and the plugins vercel, vercel-plugin and supabase each provide one MCP server. Neon and
postgres (Claude and Cursor files) are disabled. Tried, without touching ~/.grok:
- The binary's env names (strings): GROK_{CLAUDE,CURSOR,CODEX}_{SKILLS,RULES,AGENTS,MCPS,HOOKS,SESSIONS}_ENABLED,
  GROK_CONFIG / GROK_CONFIG_PATH, GROK_HOME, GROK_MANAGED_CONFIG(_URL, _FAIL_CLOSED), GROK_MANAGED_MCPS_ENABLED. No
  plugin or "no MCP" switch; no flag in `grok --help`.
- GROK_CONFIG_PATH adds an `env_overlay` config layer (inspect lists it). With `[mcp_servers.jev] enabled = false`, or
  the documented lockdown `allow_managed_mcp_servers_only = true` + `allowed_mcp_servers = []` (docs 09-plugins.md,
  "Restrict which MCP servers can run"), inspect still lists jev and supabase and shows no policy; the docs say native
  policy is managed_config.toml / requirements.toml and user-writable copies are self-imposed only. Unverifiable
  without a real run.
- GROK_MANAGED_CONFIG=<file>: not taken as a layer (inspect lists only the user layer).
- GROK_HOME=<temp>: drops jev (a server with `enabled = false` there disappears from inspect), but the Claude
  plugin-cache servers stay, and the run would need Cris's grok login copied into the temp home.
See the open choice B for the options.

## 4. Docs
Both code-review SKILL.md twins and review-config.example.json: routing, shadow, `--shadow-report`.

## Open choices (need a decision before building)
- **A. Does a config `pick` still override routing?** Cris's live config (~/.claude/review-config.json) has
  `"pick": "jev"`. If a config pick overrides (as "explicit overrides" reads), routing never runs for him until that
  line is removed, by him. Recommendation: yes, config and env pick both override (one rule), and the run prints a
  note when a configured pick is overriding routing; Cris deletes `"pick": "jev"` to switch.
- **B. Grok and MCP:** (1) keep refusing (grok unusable for shadow and /second-opinion on this machine until its MCP
  servers are off); (2) Cris turns them off persistently for grok himself (`grok mcp disable jev`; disable the
  supabase/vercel plugins for grok), after which the refusal passes; (3) a per-run GROK_CONFIG_PATH lockdown overlay,
  only after one supervised real grok run proves servers don't start. Recommendation: (1) now, (2) if he wants grok
  shadows; (3) only with that proof.
- **C. Shadow on fix checks too?** Recommendation: no; reviews only.
