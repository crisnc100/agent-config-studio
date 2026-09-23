#!/usr/bin/env python3
"""Phase D rewrite of the live skill files. Every replacement is an exact
substring with an expected count; any mismatch aborts before a single file is
written. Rules (plan.md): same model + same effort at every site, families in
prose, $(model-id x) in shell, modelId('x') in scripts, families in configs.

  python3 rewrite-skills.py [--dry-run]
"""
import os, sys

H = os.path.expanduser('~')
MID = lambda f: f'"$(model-id {f})"'
JQ = lambda f: f"jq -e --arg m \"$(model-id {f})\" '.modelUsage | has($m)'"

EDITS = {
# ─────────────────────────── Claude tree ───────────────────────────
'.claude/skills/advisor/SKILL.md': [
  ('Methods: fable (Fable 5.1, the wise-owl', 'Methods: fable (Fable, the wise-owl', 1),
  ('astra (GPT-6 Astra high — cross-vendor', 'astra (Astra high — cross-vendor', 1),
  ('- When the seat IS Fable 5.1: the fable method', '- When the seat IS Fable: the fable method', 1),
  ('**advice is owl work.** Fable 5.1 is the wise owl', '**advice is owl work.** Fable is the wise owl', 1),
  ('GPT-6 Astra high shares the judgment tier', 'Astra high shares the judgment tier', 1),
  ('| `fable` | Fable 5.1 | headless CLI', '| `fable` | Fable | headless CLI', 1),
  ('| `astra` | GPT-6 Astra at **high** (model from config)', '| `astra` | Astra at **high** (model from config)', 1),
  ('| `both` | Fable 5.1 + Astra high, blind', '| `both` | Fable + Astra high, blind', 1),
  ('| `sol` | GPT-5.6 Sol at **xhigh** (legacy) | `codex exec -m gpt-5.6-sol` read-only',
   f'| `sol` | Sol at **xhigh** (legacy) | `codex exec -m {MID("sol")}` read-only', 1),
  ('--sandbox read-only -m gpt-6-astra -c model_reasoning_effort=high \\',
   f'--sandbox read-only -m {MID("astra")} -c model_reasoning_effort=high \\', 1),
  ('(Substitute model/effort from the config file — never hardcode the model id in a repo script.)',
   '(Substitute model/effort from the config file — a family resolves with `-m "$(model-id <codexModel>)"`; never hardcode the model id in a repo script.)', 1),
  ('  --model claude-fable-5-1 --effort high --output-format json \\',
   f'  --model {MID("fable")} --effort high --output-format json \\', 1),
  ('and the `modelUsage` keys **must include `claude-fable-5-1`**. If they don\'t,',
   f'and the `modelUsage` keys **must include the resolved id** — check it, never eyeball it: `{JQ("fable")}` on the envelope. If it fails,', 1),
  ('{ "method": "fable", "codexModel": "gpt-6-astra", "codexEffort": "high" }',
   '{ "method": "fable", "codexModel": "astra", "codexEffort": "high" }', 1),
  ('Changing the codex model (at a new model\'s release) is one edit here; nothing in the skill hardcodes it.',
   '`codexModel` names a registry family (`model-id --table` shows the current ids); a new model\'s release is one edit to the registry (`~/.agent-config-studio/models.json`), and nothing in the skill hardcodes it.', 1),
  ('verifies the envelope\'s `modelUsage` contains `claude-fable-5-1`.',
   f'verifies the envelope\'s `modelUsage` contains the resolved id (`{JQ("fable")}`).', 1),
],
'.claude/skills/advisor/advisor-config.example.json': [
  ('"codexModel": "gpt-6-astra",', '"codexModel": "astra",', 1),
],
'.claude/skills/delegating-to-agents/SKILL.md': [
  ('GPT-6 Astra medium (default) and GPT-5.6 Sol medium (legacy backup) are the builders.',
   'Astra medium (default) and Sol medium (legacy backup) are the builders.', 1),
  ('- **Default build → Codex CLI, GPT-6 Astra medium.**', '- **Default build → Codex CLI, Astra medium.**', 1),
  ('  codex exec --skip-git-repo-check -m gpt-6-astra -c model_reasoning_effort=medium \\',
   f'  codex exec --skip-git-repo-check -m {MID("astra")} -c model_reasoning_effort=medium \\', 1),
  ('grinds → Codex CLI, GPT-5.6 Sol medium (legacy).** The relentless workhorse; watch its diff for overbuilding. Swap `-m gpt-5.6-sol` into',
   f'grinds → Codex CLI, Sol medium (legacy).** The relentless workhorse; watch its diff for overbuilding. Swap `-m {MID("sol")}` into', 1),
  ('- **Grok CLI, grok-4.6 high — only when Cris names it**', '- **Grok CLI, Grok high — only when Cris names it**', 1),
  ('  grok -p "<self-contained brief>" -m grok-4.6 --effort high --always-approve \\',
   f'  grok -p "<self-contained brief>" -m {MID("grok")} --effort high --always-approve \\', 1),
  ('- **Reviewing, grading, attacking a plan → Codex CLI, GPT-6 Astra high.**',
   '- **Reviewing, grading, attacking a plan → Codex CLI, Astra high.**', 1),
  ('expensive → Opus 5 subagent** (Agent tool, `model: opus`)', 'expensive → Opus subagent** (Agent tool, `model: opus`)', 1),
  ('single-file work → Sonnet 5 subagent** (Agent tool, `model: sonnet`)', 'single-file work → Sonnet subagent** (Agent tool, `model: sonnet`)', 1),
  ('premium review verdicts → Fable 5.1**, via headless CLI only (`claude -p --model claude-fable-5-1 --effort high`).',
   f'premium review verdicts → Fable**, via headless CLI only (`claude -p --model {MID("fable")} --effort high`).', 1),
  ('Claude implemented → GPT-6 Astra high grades.', 'Claude implemented → Astra high grades.', 1),
],
'.claude/skills/investigate/SKILL.md': [
  ('codex (GPT-6 Astra high, the default) | claude team', 'codex (Astra high, the default) | claude team', 1),
  ('**model comes from config**, so a new codex model is a one-line config change, never a skill edit)',
   '**model comes from config**, resolved with `-m "$(model-id <codexModel>)"`, so a new codex model is a one-line registry change, never a skill edit)', 1),
  ('| codex (GPT-6 Astra high) |', '| codex (Astra high) |', 2),
  ('`claude -p --model claude-fable-5-1 --effort high --output-format json` with the step\'s brief',
   f'`claude -p --model {MID("fable")} --effort high --output-format json` with the step\'s brief', 1),
  ('verify the envelope\'s `modelUsage` lists claude-fable-5-1.', f'verify the envelope with `{JQ("fable")}`.', 1),
  ('{ "method": "codex", "codexModel": "gpt-6-astra", "codexEffort": "high" }',
   '{ "method": "codex", "codexModel": "astra", "codexEffort": "high" }', 1),
  ('codex (recommended: GPT-6 Astra high, the cross-vendor', 'codex (recommended: Astra high, the cross-vendor', 1),
],
'.claude/skills/code-review/SKILL.md': [
  ('it — GPT-6 Astra high default (efficient), "fable" for the premium Fable 5.1 judgment pass,',
   'it — Astra high default (efficient), "fable" for the premium Fable judgment pass,', 1),
  ('"sol" for the legacy GPT-5.6 Sol pass,', '"sol" for the legacy Sol pass,', 1),
  ('**One review pass** with GPT-6 Astra high (the default reviewer)', '**One review pass** with Astra high (the default reviewer)', 1),
  ('- Default reviewer = **Codex GPT-6 Astra high**', '- Default reviewer = **Codex Astra high**', 1),
  ('| `/code-review` (or `codex`) | Codex GPT-6 Astra high — **one agent** |', '| `/code-review` (or `codex`) | Codex Astra high — **one agent** |', 1),
  ('| `/code-review sol` | GPT-5.6 Sol high (`REVIEW_MODEL=gpt-5.6-sol`) — one agent |',
   f'| `/code-review sol` | Sol high (`REVIEW_MODEL={MID("sol")}`) — one agent |', 1),
  ('| `/code-review fable` | **Fable 5.1 — ONE agent, one comprehensive pass, never a team** (`REVIEW_REVIEWER=claude REVIEW_CLAUDE_MODEL=claude-fable-5-1`)',
   f'| `/code-review fable` | **Fable — ONE agent, one comprehensive pass, never a team** (`REVIEW_REVIEWER=claude REVIEW_CLAUDE_MODEL={MID("fable")}`)', 1),
  ('| `/code-review both` | GPT-6 Astra high **and** Fable 5.1 |', '| `/code-review both` | Astra high **and** Fable |', 1),
  ('- Everything else → **gpt-6-astra** (the default).', '- Everything else → **astra** (the default).', 1),
  ('- **GPT-6 Astra high (default):** `{ "reviewer": "codex", "model": "gpt-6-astra", "effort": "high" }`',
   '- **Astra high (default):** `{ "reviewer": "codex", "model": "astra", "effort": "high" }`', 1),
  ('- **GPT-5.6 Sol high (legacy):** `{ "reviewer": "codex", "model": "gpt-5.6-sol", "effort": "high" }`',
   '- **Sol high (legacy):** `{ "reviewer": "codex", "model": "sol", "effort": "high" }`', 1),
  ('- **A newer model later:** just change `"model"` to the new id.',
   '- **A newer model later:** one edit to the model registry (`~/.agent-config-studio/models.json`; `model-id --table` shows the current ids) — the config keeps naming the family.', 1),
  ('an explicit different claudeModel (e.g. `claude-fable-5-1`) runs', 'an explicit different claudeModel (e.g. `fable`) runs', 1),
],
'.claude/skills/code-review/review-config.example.json': [
  ('"_presets": {', '"_models_help": "Model values are registry families or raw ids. The ids live in one place: see `model-id --table`; a new model is one edit to ~/.agent-config-studio/models.json, not here.",\n  "_presets": {', 1),
  ('"gpt-6-astra-high (default)": { "reviewer": "codex", "model": "gpt-6-astra", "effort": "high" },',
   '"astra-high (default)": { "reviewer": "codex", "model": "astra", "effort": "high" },', 1),
  ('"gpt-5.6-sol-high (legacy)": { "reviewer": "codex", "model": "gpt-5.6-sol", "effort": "high" },',
   '"sol-high (legacy)": { "reviewer": "codex", "model": "sol", "effort": "high" },', 1),
  ('"a-newer-model-later": { "reviewer": "codex", "model": "<new-model-id>", "effort": "high" },',
   '"a-newer-model-later": { "reviewer": "codex", "model": "<family, after its registry edit>", "effort": "high" },', 1),
  ('"fable-judgment (premium, extra usage)": { "reviewer": "claude", "claudeModel": "claude-fable-5-1" },',
   '"fable-judgment (premium, extra usage)": { "reviewer": "claude", "claudeModel": "fable" },', 1),
  ('  "model": "gpt-6-astra",', '  "model": "astra",', 1),
],
'.claude/skills/code-review/review.mjs': [
  (' * GPT-6 Astra high (default) or Claude reviews', ' * Astra high (default) or Claude reviews', 1),
  (' *   REVIEW_MODEL=gpt-5.6-sol REVIEW_BASE=origin/main node scripts/review.mjs',
   ' *   REVIEW_MODEL=sol REVIEW_BASE=origin/main node scripts/review.mjs', 1),
  ("const CONFIG = loadConfig()\nconst cfg = (envName, key, dflt) => process.env[envName] ?? CONFIG[key] ?? dflt\n",
   "const CONFIG = loadConfig()\nconst cfg = (envName, key, dflt) => process.env[envName] ?? CONFIG[key] ?? dflt\n"
   "// A family name resolves through the model registry (`model-id --table`);\n"
   "// a raw id passes through. On failure model-id prints MODEL-ID-UNRESOLVED-<name>, which the CLI\n"
   "// rejects loudly — never an empty string that would fall through to the CLI's own default.\n"
   "function modelId(name) {\n"
   "  const r = spawnSync('model-id', [String(name)], { encoding: 'utf8' })\n"
   "  const id = (r.stdout || '').trim()\n"
   "  if (r.error || r.status !== 0 || !id) {\n"
   "    console.warn(`⚠ model-id could not resolve \"${name}\": ${r.error?.message || (r.stderr || '').trim()}`)\n"
   "    return id || `MODEL-ID-UNRESOLVED-${name}`\n"
   "  }\n"
   "  return id\n"
   "}\n", 1),
  ("const MODEL = cfg('REVIEW_MODEL', 'model', 'gpt-6-astra')", "const MODEL = modelId(cfg('REVIEW_MODEL', 'model', 'astra'))", 1),
  ('// Effort doctrine: codex = gpt-6-astra at HIGH', '// Effort doctrine: codex = astra at HIGH', 1),
  ("    model: 'claude-opus-5',", "    model: modelId('opus'),", 1),
  # claudeModel 'sonnet' is the team-mode sentinel and is never resolved; any
  # other value (the solo tier) resolves so a family works like an id.
  ("            model: CLAUDE_MODEL,\n", "            model: modelId(CLAUDE_MODEL),\n", 1),
],
'.claude/skills/deep-review/SKILL.md': [
  ('`scripts/review-loop.mjs` (Codex GPT-6 Astra xhigh reviewer, default)', '`scripts/review-loop.mjs` (Codex Astra xhigh reviewer, default)', 1),
  ('(the cross-family finding-verifier on the Codex runner, default `claude-opus-5`)',
   '(the cross-family finding-verifier on the Codex runner, default `$(model-id opus)`)', 1),
],
'.claude/skills/deep-review/lib/reviewLoopCore.mjs': [
  ("export const cfg = (envName, key, dflt) => process.env[envName] ?? CONFIG[key] ?? dflt\n",
   "export const cfg = (envName, key, dflt) => process.env[envName] ?? CONFIG[key] ?? dflt\n"
   "// A family name resolves through the model registry (`model-id --table`);\n"
   "// a raw id passes through. On failure model-id prints MODEL-ID-UNRESOLVED-<name>, which the CLI\n"
   "// rejects loudly — never an empty string that would fall through to the CLI's own default.\n"
   "export function modelId(name) {\n"
   "  const r = spawnSync('model-id', [String(name)], { encoding: 'utf8' })\n"
   "  const id = (r.stdout || '').trim()\n"
   "  if (r.error || r.status !== 0 || !id) {\n"
   "    console.warn(`⚠ model-id could not resolve \"${name}\": ${r.error?.message || (r.stderr || '').trim()}`)\n"
   "    return id || `MODEL-ID-UNRESOLVED-${name}`\n"
   "  }\n"
   "  return id\n"
   "}\n", 1),
],
'.claude/skills/deep-review/review-loop.mjs': [
  (' * review-loop.mjs — code review loop with Codex GPT-6 Astra xhigh as the reviewer,',
   ' * review-loop.mjs — code review loop with Codex Astra xhigh as the reviewer,', 1),
  (' *   REVIEW_MODEL=gpt-5.6-sol REVIEW_EFFORT=high', ' *   REVIEW_MODEL=sol REVIEW_EFFORT=high', 1),
  ("import { cfg, runReviewLoop } from './lib/reviewLoopCore.mjs'", "import { cfg, modelId, runReviewLoop } from './lib/reviewLoopCore.mjs'", 1),
  ("const MODEL = cfg('REVIEW_MODEL', 'model', 'gpt-6-astra')", "const MODEL = modelId(cfg('REVIEW_MODEL', 'model', 'astra'))", 1),
  ("const VERIFIER_MODEL = cfg('REVIEW_VERIFIER_MODEL', 'verifierModel', 'claude-opus-5')",
   "const VERIFIER_MODEL = modelId(cfg('REVIEW_VERIFIER_MODEL', 'verifierModel', 'opus'))", 1),
],
'.claude/skills/deep-review/review-loop-claude.mjs': [
  ("import { cfg, runReviewLoop } from './lib/reviewLoopCore.mjs'", "import { cfg, modelId, runReviewLoop } from './lib/reviewLoopCore.mjs'", 1),
  ("const CODEX_MODEL = cfg('REVIEW_MODEL', 'model', 'gpt-6-astra')", "const CODEX_MODEL = modelId(cfg('REVIEW_MODEL', 'model', 'astra'))", 1),
  ('// non-default claudeModel (e.g. claude-fable-5-1) overrides the mix for ALL lenses.',
   '// non-default claudeModel (e.g. fable) overrides the mix for ALL lenses.', 1),
  ("    model: 'claude-opus-5',", "    model: modelId('opus'),", 1),
  # 'sonnet' stays the team-mode sentinel (and a Claude Code alias); only a solo model resolves.
  ("      ? [{ key: 'comprehensive', model: MODEL, focus:", "      ? [{ key: 'comprehensive', model: modelId(MODEL), focus:", 1),
  ("const fix = claudeFixer({ model: MODEL })", "const fix = claudeFixer({ model: MODEL !== 'sonnet' ? modelId(MODEL) : MODEL })", 1),
],
'.claude/skills/deep-review/lib/fixers.mjs': [
  (' * CROSS-MODEL fix: GPT-5.6 Sol reviews, Claude fixes, GPT-5.6 Sol re-reviews', ' * CROSS-MODEL fix: Sol reviews, Claude fixes, Sol re-reviews', 1),
],
'.claude/skills/fable-safe-prompt/SKILL.md': [
  ("trips Claude Fable 5's server-side safety classifiers (cyber/bio guardrails that force-route to Opus 5 or return",
   "trips Claude Fable's server-side safety classifiers (cyber/bio guardrails that force-route to Opus or return", 1),
  ('or to rewrite it so Fable 5 won\'t block it.', 'or to rewrite it so Fable won\'t block it.', 1),
  ("most likely to trip Fable 5's cyber/bio classifiers.", "most likely to trip Fable's cyber/bio classifiers.", 1),
  ('Fable 5 runs 3 input classifiers:', 'Fable runs 3 input classifiers:', 1),
  ('use an Opus 5 fallback or vetted Mythos, not Fable 5.', 'use an Opus fallback or vetted Mythos, not Fable.', 1),
  ("you can't reliably stop Fable 5 guardrails.", "you can't reliably stop Fable guardrails.", 1),
  ('as a route to an Opus 5 fallback', 'as a route to an Opus fallback', 1),
],
'.claude/skills/build/SKILL.md': [
  ('(guided phases, callbacks on demand), GPT-6 Astra high independently attacks', '(guided phases, callbacks on demand), Astra high independently attacks', 1),
  ('(Fable 5.1 when Cris set it, Opus 5 otherwise)', '(Fable when Cris set it, Opus otherwise)', 1),
  ('(GPT-6 Astra medium default, GPT-5.6 Sol medium legacy backup, Opus for', '(Astra medium default, Sol medium legacy backup, Opus for', 1),
  ('| Shape: **Bounce** (attack the plan) | GPT-6 Astra high |', '| Shape: **Bounce** (attack the plan) | Astra high |', 1),
  ('implementer — **GPT-6 Astra medium default, GPT-5.6 Sol medium legacy backup** (via codex CLI), Opus 5 for taste-heavy',
   'implementer — **Astra medium default, Sol medium legacy backup** (via codex CLI), Opus for taste-heavy', 1),
  ('| **Grade** (verify build vs bar) | GPT-6 Astra high (flips', '| **Grade** (verify build vs bar) | Astra high (flips', 1),
  ('default → **astra** (GPT-6 Astra medium);', 'default → **astra** (Astra medium);', 1),
  ('claude-lane implementers (sonnet/opus) → GPT-6 Astra high grades, the default.', 'claude-lane implementers (sonnet/opus) → Astra high grades, the default.', 1),
  ('(Fable 5.1 via headless CLI — `claude -p --model claude-fable-5-1 --effort high`, never an Agent-tool spawn, which silently downgrades to sonnet; verify `modelUsage` lists `claude-fable-5-1`)',
   f'(Fable via headless CLI — `claude -p --model {MID("fable")} --effort high`, never an Agent-tool spawn, which silently downgrades to sonnet; verify with `{JQ("fable")}`)', 1),
  ('**Grok implementer → GPT-6 Astra high grades**', '**Grok implementer → Astra high grades**', 1),
  ('codex exec --skip-git-repo-check --sandbox read-only -m gpt-6-astra -c model_reasoning_effort=high \\',
   f'codex exec --skip-git-repo-check --sandbox read-only -m {MID("astra")} -c model_reasoning_effort=high \\', 2),
  ('codex exec --skip-git-repo-check --sandbox workspace-write -m gpt-6-astra -c model_reasoning_effort=medium \\',
   f'codex exec --skip-git-repo-check --sandbox workspace-write -m {MID("astra")} -c model_reasoning_effort=medium \\', 1),
  ('codex exec resume <thread_id> --skip-git-repo-check -m gpt-6-astra -c model_reasoning_effort=medium \\',
   f'codex exec resume <thread_id> --skip-git-repo-check -m {MID("astra")} -c model_reasoning_effort=medium \\', 1),
  ('On the sol lane, swap `-m gpt-5.6-sol` into the build calls', f'On the sol lane, swap `-m {MID("sol")}` into the build calls', 1),
  ('2. **Shape** (orchestrator drafts, GPT-6 Astra attacks).', '2. **Shape** (orchestrator drafts, Astra attacks).', 1),
],
'.claude/skills/cmux/SKILL.md': [
  ('Codex CLI (gpt-5.6-sol) and Claude Code', 'Codex CLI (Sol) and Claude Code', 1),
],
# ─────────────────────────── Codex tree ───────────────────────────
'.codex/skills/advisor/SKILL.md': [
  ('Default method is fable (Fable 5.1, the wise owl,', 'Default method is fable (Fable, the wise owl,', 1),
  ('**advice is owl work.** GPT-5.6 Sol is the workhorse', '**advice is owl work.** Sol is the workhorse', 1),
  ('and Fable 5.1 is the wise owl, the smartest judgment seat.', 'and Fable is the wise owl, the smartest judgment seat.', 1),
  ('| `fable` | Fable 5.1 | `claude -p`, `--effort high`', '| `fable` | Fable | `claude -p`, `--effort high`', 1),
  ('| `opus` | Opus 5 | `claude -p --model claude-opus-5` |', f'| `opus` | Opus | `claude -p --model {MID("opus")}` |', 1),
  ('| `codex` | gpt-5.6-sol at **xhigh**, fresh session', '| `codex` | Sol at **xhigh**, fresh session', 1),
  ('| `both` | Fable 5.1 + GPT-6 Astra high, blind, in parallel | fable via `claude -p` + a fresh `codex exec -m gpt-6-astra -c model_reasoning_effort=high`',
   f'| `both` | Fable + Astra high, blind, in parallel | fable via `claude -p` + a fresh `codex exec -m {MID("astra")} -c model_reasoning_effort=high`', 1),
  ('claude -p "$PROMPT" --model claude-fable-5-1 --effort high \\', f'claude -p "$PROMPT" --model {MID("fable")} --effort high \\', 1),
  ("jq -r '.modelUsage | keys[]'   /tmp/advisor-out.json   # MUST include claude-fable-5-1",
   f"{JQ('fable')} /tmp/advisor-out.json   # MUST print true (exit 0)", 1),
  ('**Prove the model.** If `modelUsage` does not list `claude-fable-5-1`, the call ran on the wrong model',
   '**Prove the model.** If that `jq -e` check for `$(model-id fable)` fails, the call ran on the wrong model', 1),
  ('For `opus`, swap `--model claude-opus-5` (drop `--effort`)\nand expect `claude-opus-5` in `modelUsage`.',
   f'For `opus`, swap `--model {MID("opus")}` (drop `--effort`)\nand check `{JQ("opus")}` instead.', 1),
  ('codex exec --skip-git-repo-check --sandbox read-only -m gpt-5.6-sol \\', f'codex exec --skip-git-repo-check --sandbox read-only -m {MID("sol")} \\', 1),
  ('Model id and effort come from `~/.claude/advisor-config.json` when it\'s present — never hardcode a model id into a\nrepo script.',
   'Model and effort come from `~/.claude/advisor-config.json` when it\'s present (resolve its family with\n`-m "$(model-id <codexModel>)"`) — never hardcode a model id into a repo script.', 1),
  ('shared with the Claude seat, one source of truth for model ids:', 'shared with the Claude seat; model values are registry families (`model-id --table`):', 1),
  ('{ "method": "fable", "codexModel": "gpt-5.6-sol", "codexEffort": "xhigh" }', '{ "method": "fable", "codexModel": "sol", "codexEffort": "xhigh" }', 1),
  ('AND `modelUsage` contains\n  `claude-fable-5-1`.', f'AND `modelUsage` contains\n  the resolved id (`{JQ("fable")}`).', 1),
],
'.codex/skills/investigate/SKILL.md': [
  ('codex (GPT-6 Astra high, the default) | claude team', 'codex (Astra high, the default) | claude team', 1),
  ('**model comes from config**, so a new codex model is a one-line config change, never a skill edit)',
   '**model comes from config**, resolved with `-m "$(model-id <codexModel>)"`, so a new codex model is a one-line registry change, never a skill edit)', 1),
  ('| codex (GPT-6 Astra high) |', '| codex (Astra high) |', 2),
  ('`claude -p --model claude-fable-5-1 --effort high --output-format json` with the step\'s brief',
   f'`claude -p --model {MID("fable")} --effort high --output-format json` with the step\'s brief', 1),
  ('verify the envelope\'s `modelUsage` lists claude-fable-5-1.', f'verify the envelope with `{JQ("fable")}`.', 1),
  ('{ "method": "codex", "codexModel": "gpt-6-astra", "codexEffort": "high" }',
   '{ "method": "codex", "codexModel": "astra", "codexEffort": "high" }', 1),
  ('codex (recommended: GPT-6 Astra high, the cross-vendor', 'codex (recommended: Astra high, the cross-vendor', 1),
],
'.codex/skills/code-review/SKILL.md': [
  ('`REVIEW_REVIEWER=claude REVIEW_CLAUDE_MODEL=claude-fable-5-1 node "$SCRIPT" "..."`',
   f'`REVIEW_REVIEWER=claude REVIEW_CLAUDE_MODEL={MID("fable")} node "$SCRIPT" "..."`', 1),
  ('the default codex reviewer (gpt-6-astra high) is correct.', 'the default codex reviewer (Astra high) is correct.', 1),
],
'.codex/skills/deep-review/SKILL.md': [
  ('`scripts/review-loop.mjs` (Codex GPT-6 Astra xhigh reviewer, default)', '`scripts/review-loop.mjs` (Codex Astra xhigh reviewer, default)', 1),
  ('(the cross-family finding-verifier on the Codex runner, default `claude-opus-5`)',
   '(the cross-family finding-verifier on the Codex runner, default `$(model-id opus)`)', 1),
],
'.codex/skills/build/SKILL.md': [
  ('resolves from `~/.codex/config.toml` — GPT-6 Astra high; build phases run Astra medium, with GPT-5.6 Sol medium as the legacy builder swap.)',
   'resolves from `~/.codex/config.toml` — Astra high; build phases run Astra medium, with Sol medium as the legacy builder swap.)', 1),
  ('  --model claude-fable-5-1 --effort high --output-format json --dangerously-skip-permissions --tools Read,Grep,Glob',
   f'  --model {MID("fable")} --effort high --output-format json --dangerously-skip-permissions --tools Read,Grep,Glob', 2),
  ('Parse `.result` from the JSON envelope and verify `modelUsage` lists `claude-fable-5-1`. When Fable usage runs low, drop to the cheap fallback: swap in `--model claude-opus-5` (drop `--effort`) and expect `claude-opus-5` in `modelUsage`.',
   f'Parse `.result` from the JSON envelope and verify the model with `{JQ("fable")}`. When Fable usage runs low, drop to the cheap fallback: swap in `--model {MID("opus")}` (drop `--effort`) and check `{JQ("opus")}` instead.', 1),
  ('`codex exec --skip-git-repo-check --sandbox read-only -m gpt-5.6-sol -c model_reasoning_effort=xhigh "<same prompt>" </dev/null`',
   f'`codex exec --skip-git-repo-check --sandbox read-only -m {MID("sol")} -c model_reasoning_effort=xhigh "<same prompt>" </dev/null`', 1),
],
# ─────────────────────────── configs ───────────────────────────
'.claude/advisor-config.json': [
  ('astra (gpt-6-astra high — cross-vendor judgment)', 'astra (Astra high — cross-vendor judgment)', 1),
  ('sol (legacy, gpt-5.6-sol at XHIGH). Spoken choice overrides per run.',
   'sol (legacy, Sol at XHIGH). Spoken choice overrides per run. codexModel is a registry family, resolved with `model-id` (see `model-id --table`); a new model is one edit to ~/.agent-config-studio/models.json, not here.', 1),
  ('"codexModel": "gpt-6-astra",', '"codexModel": "astra",', 1),
],
'.claude/investigate-config.json': [
  ('codexModel is the codex CLI model id — change it here when a newer model ships; the skill never hardcodes it.',
   'codexModel is a registry family (or a raw id), resolved with `model-id` — a newer model ships as one edit to ~/.agent-config-studio/models.json (see `model-id --table`), not here; the skill never hardcodes it.', 1),
  ('"codexModel": "gpt-6-astra",', '"codexModel": "astra",', 1),
],
'.claude/review-config.json': [
  ('The _help/_presets keys are ignored.', 'The _help/_presets keys are ignored. Model values are registry families resolved with `model-id`; a new model is one edit to ~/.agent-config-studio/models.json (see `model-id --table`), not here.', 1),
  ('"gpt-6-astra-high (default)": { "reviewer": "codex", "model": "gpt-6-astra", "effort": "high" },',
   '"astra-high (default)": { "reviewer": "codex", "model": "astra", "effort": "high" },', 1),
  ('"gpt-5.6-sol-high (legacy)": { "reviewer": "codex", "model": "gpt-5.6-sol", "effort": "high" },',
   '"sol-high (legacy)": { "reviewer": "codex", "model": "sol", "effort": "high" },', 1),
  ('"raise-reasoning": { "reviewer": "codex", "model": "gpt-6-astra", "effort": "xhigh" },',
   '"raise-reasoning": { "reviewer": "codex", "model": "astra", "effort": "xhigh" },', 1),
  ('"terra-cheaper": { "reviewer": "codex", "model": "gpt-5.6-terra", "effort": "high" },',
   '"terra-cheaper": { "reviewer": "codex", "model": "terra", "effort": "high" },', 1),
  ('  "model": "gpt-6-astra",', '  "model": "astra",', 1),
],
}

def main():
    dry = '--dry-run' in sys.argv
    out = {}
    errors = []
    for rel, edits in EDITS.items():
        p = os.path.join(H, rel)
        s = open(p, encoding='utf-8').read()
        for old, new, n in edits:
            c = s.count(old)
            if c != n:
                errors.append(f'{rel}: expected {n}, found {c}: {old[:90]!r}')
                continue
            s = s.replace(old, new)
        out[p] = s
    if errors:
        print('\n'.join(errors)); sys.exit(1)
    for p, s in out.items():
        if not dry:
            open(p, 'w', encoding='utf-8').write(s)
    print(f'{"checked" if dry else "wrote"} {len(out)} files')

if __name__ == '__main__':
    main()
