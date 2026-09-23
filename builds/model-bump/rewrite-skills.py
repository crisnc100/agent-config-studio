#!/usr/bin/env python3
"""The model bump's skill edits: bring every skill in line with the Model lanes in
~/.claude/CLAUDE.md. Exact substrings with expected counts; any mismatch aborts
before a file is written. Refuses to write a file whose sha256 differs from the
backup's sha256Before (someone else edited it after the backup).

  python3 rewrite-skills.py <backup-dir> [--dry-run]

What the lanes say, and so what changes here:
  - Advice and gates (Bounce/Grade) are Fable and Astra only. Sol and Opus review, never advise or gate.
  - Gate order: Fable → Astra high → NOT RUN; the report names which ran, and says when it was same-family.
  - Cross-family review is preferred, not a hard rule; same-family is fine if the report says which grader ran.
  - Builders: Sol medium and Opus medium, co-default, unranked. Astra and Fable never build. Grok benched.
  - Sonnet is not a lane (the review-team `sonnet` lenses are a mode and stay).
"""
import hashlib, json, os, sys

H = os.path.expanduser('~')
M = lambda f: f'"$(model-id {f} || echo MODEL-ID-UNRESOLVED-{f})"'
JQ = lambda f: f"jq -e --arg m {M(f)} '.modelUsage | has($m)'"

EDITS = {
# ─────────────────────────── Claude /advisor ───────────────────────────
'.claude/skills/advisor/SKILL.md': [
  (' Astra high shares the judgment tier — same tier as Fable until evidence separates them. Legacy Sol, when named, advises at **XHIGH** (advice deserves its top reasoning; the execution lanes are the ones that run high).',
   ' Astra high shares the judgment tier — same tier as Fable until evidence separates them. They are the only advisors: Sol and Opus review code but never advise (model lanes, `~/.claude/CLAUDE.md`).', 1),
  (f'| `sol` | Sol at **xhigh** (legacy) | `codex exec -m {M("sol")}` read-only | Only when Cris names it. |\n', '', 1),
  ('ask once via AskUserQuestion (codex — needs `npm i -g @openai/codex` + auth | fable | claude opus), then save',
   'ask once via AskUserQuestion (fable | astra — needs `npm i -g @openai/codex` + auth | both), then save', 1),
],
'.claude/advisor-config.json': [
  (' | both (dual blind advisory, Fable + Astra in parallel) | sol (legacy, Sol at XHIGH). Spoken choice overrides per run.',
   ' | both (dual blind advisory, Fable + Astra in parallel). Only Fable and Astra advise. Spoken choice overrides per run.', 1),
],
# ─────────────────────────── Claude /build ───────────────────────────
'.claude/skills/build/SKILL.md': [
  ('Pick the implementer with "/build astra|sol|grok|opus|sonnet" (or plain English)',
   'Pick the implementer with "/build sol|opus|grok" (or plain English)', 1),
  ('**A second brain on the result.** The full Grade is what gets skipped, not the grader-never-the-author rule.',
   '**A second brain on the result.** The full Grade is what gets skipped, not the rule that the builder never grades its own work.', 1),
  ('that satisfies the rule for free, since the orchestrator didn\'t type it. On the codex lane this is a Claude brain reading codex\'s work, which is exactly the family split the full loop buys with a Grade call.',
   'that satisfies the rule for free, since the orchestrator didn\'t type it. On the Sol lane that is also a cross-family read — the split the full loop buys with a Grade call.', 1),
  ('(Astra medium default, Sol medium legacy backup, Opus for taste-heavy work, Sonnet only as an Opus orchestrator\'s subagent). Whoever implements never grades their own work.',
   '(Sol medium and Opus medium are the co-default builders, unranked; Astra and Fable never build; Grok only when Cris names it). Whoever implements never grades their own work.', 1),
  ('| Build (guided steps) | implementer — **Astra medium default, Sol medium legacy backup** (via codex CLI), Opus for taste-heavy work (frontend, design, copy); user\'s spoken lane wins (below) |',
   '| Build (guided steps) | implementer — **Sol medium** (codex CLI) or **Opus medium**, co-default and unranked; user\'s spoken lane wins (below) |', 1),
  ('| **Grade** (verify build vs bar) | Astra high (flips to a Claude grader — fable — when a GPT lane implemented; see below) |',
   '| **Grade** (verify build vs bar) | Astra high, or Fable when Sol implemented — cross-family preferred (see below) |', 1),
  ('### Choosing the implementer — `/build astra | sol | grok | opus | sonnet`',
   '### Choosing the implementer — `/build sol | opus | grok`', 1),
  ('Name the lane and it wins for this run: `/build astra`, `/build sol`, or plain English ("build this with opus").',
   'Name the lane and it wins for this run: `/build sol`, `/build opus`, or plain English ("build this with opus").', 1),
  ('**Unnamed routing** (lanes update, Cris, 2026-09-04): default → **astra** (Astra medium); sustained "keep going until it\'s done" grinds → **sol** (the legacy workhorse; watch for overbuilding); frontend, UI, design, copy → **opus**; mechanical single-file work → **sonnet**; **grok** only when Cris names it (benched until there\'s data). Record which lane won or lost — the ranking earns itself.',
   '**Unnamed routing** (model lanes, `~/.claude/CLAUDE.md`): **Sol or Opus (co-default); the orchestrator picks and states why.** No ranking between them yet — Sol overbuilds, so give it boundaries; Opus has the taste for frontend, design and copy. **grok** only when Cris names it (benched until there\'s data). Astra and Fable are judgment tier and never build. Record which lane won or lost — the ranking earns itself.', 1),
  (f'- **Grader swap (grader is never the author, at the model-family level):** claude-lane implementers (sonnet/opus) → Astra high grades, the default. **GPT implementer (astra/sol) → the Grade flips to a Claude brain** (Fable via headless CLI — `claude -p --model {M("fable")} --effort high`, never an Agent-tool spawn, which silently downgrades to sonnet; verify with `{JQ("fable")}`) so no family grades its own work. **Grok implementer → Astra high grades** (a third family; either non-grok judgment model is valid).',
   f'- **Grader swap (cross-family preferred, not a hard rule):** Opus implementer → Astra high grades, the default. **Sol implementer → the Grade prefers Fable** (headless CLI — `claude -p --model {M("fable")} --effort high`, never an Agent-tool spawn, which silently downgrades to sonnet; verify with `{JQ("fable")}`); when Fable is unavailable, Astra high grades same-family. **Grok implementer → Astra high grades.** Gates are Fable or Astra only — never Sol or Opus — and the Judge handoff always says which grader ran, and when it was same-family.', 1),
  ('redo the step on the other default builder (astra ↔ sol);', 'redo the step on the other co-default builder (sol ↔ opus);', 1),
  (f'**Build — phase 1 (the only call that starts a session).**', f'**Build — phase 1 (the only call that starts a session; Sol lane).**', 1),
  (f'codex exec --skip-git-repo-check --sandbox workspace-write -m {M("astra")} -c model_reasoning_effort=medium \\',
   f'codex exec --skip-git-repo-check --sandbox workspace-write -m {M("sol")} -c model_reasoning_effort=medium \\', 1),
  (f'codex exec resume <thread_id> --skip-git-repo-check -m {M("astra")} -c model_reasoning_effort=medium \\',
   f'codex exec resume <thread_id> --skip-git-repo-check -m {M("sol")} -c model_reasoning_effort=medium \\', 1),
  (f'On the sol lane, swap `-m {M("sol")}` into the build calls (same efforts); the gates stay on the judgment tier regardless of lane.',
   'On the opus lane the phases go to an Opus subagent at medium effort instead of these codex calls; the gates stay on the judgment tier regardless of lane.', 1),
  ('3. **Build** (implementer lane — Astra medium default, Sol/Opus per the doctrine or the user\'s `/build <lane>` choice).',
   '3. **Build** (implementer lane — Sol or Opus, co-default, per the doctrine or the user\'s `/build <lane>` choice).', 1),
  ('- **The grader is never the author.** The implementer subagent builds; the cross-family judgment model grades; the orchestrator that guided the build is not the sole grader either. Never let the builder grade its own work; that is the weak self-critique the whole design avoids.',
   '- **The builder never grades its own work.** The implementer subagent builds; a judgment model grades — cross-family preferred, same-family (Astra on a Sol build) allowed when the other family is unavailable, and the Judge handoff says which grader ran. The orchestrator that guided the build is not the sole grader either; self-critique is the weak version the whole design avoids.', 1),
],
# ─────────────────────────── Claude /code-review: sol stays a tier, it is just not "legacy" ───────────────────────────
'.claude/skills/code-review/SKILL.md': [
  ('"sol" for the legacy Sol pass,', '"sol" for a Sol pass,', 1),
  ('— one agent | The legacy reviewer. A second GPT flavor without spending Fable. |', '— one agent | Reviewer pool. A second GPT flavor without spending Fable. |', 1),
  ('- **Sol high (legacy):** `{', '- **Sol high:** `{', 1),
],
# ─────────────────────────── Claude delegating-to-agents ───────────────────────────
'.claude/skills/delegating-to-agents/SKILL.md': [
  ('**Two lanes type; the rest talk.** Astra medium (default) and Sol medium (legacy backup) are the builders. Opus and Sonnet narrate and critique instead of shipping, so a diff is not their deliverable — except frontend, which is Opus\'s. Grok is benched until there\'s data. Fable never builds. (Lanes update, Cris, 2026-09-04.)',
   '**Two lanes type.** Sol medium and Opus medium are the co-default builders, unranked — record wins and losses so the ranking earns itself. Astra and Fable are judgment tier and never build. Grok is benched until there\'s data. Sonnet is not used.', 1),
  (f'- **Default build → Codex CLI, Astra medium.** Different strengths (subagents, end-to-end autonomy), still unproven as a builder — record wins and losses so the ranking earns itself. On a ChatGPT Pro plan — effectively unlimited, **don\'t ration it**; bulk grind spends there instead of the shared Claude Max pool.\n  ```bash\n  codex exec --skip-git-repo-check -m {M("astra")} -c model_reasoning_effort=medium \\',
   f'- **Build → Codex CLI, Sol medium (co-default).** The relentless workhorse; watch its diff for overbuilding. On a ChatGPT Pro plan — effectively unlimited, **don\'t ration it**; bulk grind spends there instead of the shared Claude Max pool.\n  ```bash\n  codex exec --skip-git-repo-check -m {M("sol")} -c model_reasoning_effort=medium \\', 1),
  (f'- **Sustained "keep going until it\'s done" grinds → Codex CLI, Sol medium (legacy).** The relentless workhorse; watch its diff for overbuilding. Swap `-m {M("sol")}` into the command above. `terra` is the cheaper everyday tier if Cris asks for it.',
   f'- **Build → Opus medium (co-default).** Real taste, efficient; the natural pick for frontend, design and copy, and a full builder elsewhere. Agent tool `model: opus`, or headless `claude -p --model {M("opus")} --effort medium` when the exact id matters. `terra` is the cheaper codex tier if Cris asks for it.', 1),
  ('(benched until there\'s data; capable, ranks above Opus as a builder).', '(benched until there\'s data; a different flavor — logic-RL — below Opus and Sol).', 1),
  ('- **Reviewing, grading, attacking a plan → Codex CLI, Astra high.** The **default** reviewer across the board: `/build`\'s Bounce and Grade gates and `/code-review`\'s default tier.',
   '- **Reviewing, grading, attacking a plan → Codex CLI, Astra high.** The **default** reviewer across the board: `/build`\'s Bounce and Grade gates and `/code-review`\'s default tier. Sol and Opus may review code, but only Fable and Astra advise or gate.', 1),
  ('- **Frontend / design / copy taste, and anything where a cheap-model miss is expensive → Opus subagent** (Agent tool, `model: opus`). The one build domain Opus keeps, and it is better than Grok there.\n', '', 1),
  ('- **Mechanical, spec-fully-determined single-file work → Sonnet subagent** (Agent tool, `model: sonnet`). Bottom of the stack; not a lane for anything with a design call in it.\n', '', 1),
  ('**The grader is never the author, at the model-family level.** Claude implemented → Astra high grades. GPT implemented (Astra/Sol) → a Claude brain (Fable) grades. Grok implemented → either non-grok judgment model grades. Never route both sides of a build to the same vendor.',
   '**The builder never grades its own work; cross-family grading is preferred, not a hard rule.** Opus implemented → Astra high grades. Sol implemented → Fable grades, or Astra high same-family when Fable is unavailable. Grok implemented → either judgment model grades. Always say which grader ran.', 1),
],
# ─────────────────────────── /investigate (both trees, same text) ───────────────────────────
**{f'.{tree}/skills/investigate/SKILL.md': [
  ('fresh cross-family context. No same-family fallback — if codex is unavailable, report Disprove as NOT RUN rather than substituting a Claude subagent, which re-runs the seat\'s own priors and tends to rubber-stamp them |',
   'fresh context, cross-family preferred. If codex is unavailable, a fresh-context Claude subagent may run it same-family (weaker — it shares the seat\'s priors); the report says which adversary ran |', 1),
  ('Whatever method investigates, the cross-family rule holds: the disprove adversary is never the same model family that produced the conclusion.',
   'Whatever method investigates, cross-family is preferred: the disprove adversary should be a different model family from the one that produced the conclusion. Same-family is allowed when the other family is unavailable — the report says which adversary ran.', 1),
  ('a fresh-context Claude subagent is the fallback when codex isn\'t available.',
   'a fresh-context Claude subagent is the fallback when codex isn\'t available (same-family when the seat is Claude — say so in the report).', 1),
] for tree in ('claude', 'codex')},
# ─────────────────────────── Codex /advisor ───────────────────────────
'.codex/skills/advisor/SKILL.md': [
  ('Default method is fable (Fable, the wise owl, headless claude CLI) because the seat is already GPT — same-family advice is the seat advising itself.',
   'Default method is fable (Fable, the wise owl, headless claude CLI) because the seat is already GPT; Astra high is the same-family fallback. Only Fable and Astra advise.', 1),
  (f'| `opus` | Opus | `claude -p --model {M("opus")}` | Cross-family advice when the call is real but doesn\'t warrant Fable\'s usage — or when Fable plan access is unavailable. |\n'
   '| `codex` | Sol at **xhigh**, fresh session, no seat context | `codex exec --sandbox read-only` | **Degraded only.** The Claude pool is exhausted. Flag it to Cris — same-family advice is the seat advising itself. |\n',
   f'| `astra` | Astra at **high**, fresh session, no seat context | `codex exec -m {M("astra")} --sandbox read-only` | **Fallback** when Fable is unreachable (Claude pool exhausted, ENOTFOUND), or when Cris names it. Same-family as this seat — say so with the verdict. If neither Fable nor Astra can run, advice is **NOT RUN**; Sol and Opus never advise. |\n', 1),
  (f'Cris, and never present another model\'s output as fable. For `opus`, swap `--model {M("opus")}` (drop `--effort`)\nand check `{JQ("opus")}` instead.',
   'Cris, and never present another model\'s output as fable.', 1),
  ('2. Use the `codex` degraded method below and tell Cris the cross-family advisor was unreachable.',
   '2. Use the `astra` fallback below and tell Cris the cross-family advisor was unreachable.', 1),
  (f'**codex** (degraded fallback only) — fresh session, no seat context, effort bumped:\n```bash\ncodex exec --skip-git-repo-check --sandbox read-only -m {M("sol")} \\\n  -c model_reasoning_effort=xhigh "$PROMPT" </dev/null 2>/dev/null\n```',
   f'**astra** (fallback) — fresh session, no seat context:\n```bash\ncodex exec --skip-git-repo-check --sandbox read-only -m {M("astra")} \\\n  -c model_reasoning_effort=high "$PROMPT" </dev/null 2>/dev/null\n```', 1),
  ('never hardcode a model id into a repo script. Tell Cris the advice ran same-family and is therefore weaker.',
   'never hardcode a model id into a repo script. Tell Cris the advice ran same-family and is therefore weaker. If Astra cannot run either, report the advice as NOT RUN — never substitute Sol or Opus.', 1),
  ('{ "method": "fable", "codexModel": "sol", "codexEffort": "xhigh" }', '{ "method": "fable", "codexModel": "astra", "codexEffort": "high" }', 1),
],
# ─────────────────────────── Codex /build ───────────────────────────
'.codex/skills/build/SKILL.md': [
  ('| Shape: **Bounce** (attack the plan) | **cross-family: Claude** | `claude -p` read-only (see below) |',
   '| Shape: **Bounce** (attack the plan) | **Fable** (cross-family) → Astra high → NOT RUN | `claude -p` read-only (see below) |', 1),
  ('| **Grade** (verify vs bar) | **cross-family: Claude** | `claude -p` read-only |',
   '| **Grade** (verify vs bar) | **Fable** (cross-family) → Astra high → NOT RUN | `claude -p` read-only |', 1),
  ('**Cross-family rule:** codex is the seat and usually the implementer, so the Bounce and the Grade go to a Claude brain — no family grades its own work.',
   '**Cross-family preferred:** codex is the seat and usually the implementer, so the Bounce and the Grade go to Fable first — a different family grades best. Only Fable and Astra gate; Sol and Opus never do.', 1),
  ('(The seat model resolves from `~/.codex/config.toml` — Astra high; build phases run Astra medium, with Sol medium as the legacy builder swap.)',
   '(The seat model resolves from `~/.codex/config.toml` — Sol high; build phases run Sol medium. Astra is judgment tier and never builds.)', 1),
  (f' When Fable usage runs low, drop to the cheap fallback: swap in `--model {M("opus")}` (drop `--effort`) and check `{JQ("opus")}` instead.',
   ' When Fable is unavailable, fall back to Astra high (below) — never to Opus.', 1),
  ('## Degraded mode — when Claude usage is exhausted (the backup reason)', '## Fallback — when Fable is unavailable', 1),
  (f'If `claude -p` is unavailable (out of Max pool), the cross-family gate can\'t run. Do NOT skip the gate — run it same-family but honestly:\n- Bounce and Grade run in a **fresh codex session with no build context**, effort bumped to **xhigh**:\n  `codex exec --skip-git-repo-check --sandbox read-only -m {M("sol")} -c model_reasoning_effort=xhigh "<same prompt>" </dev/null`\n- **Flag it to Cris in the handoff:** "Gate ran same-family (codex), degraded — no cross-vendor check available." A fresh-context adversarial pass is weaker than a different family, and he should know when a build shipped without the cross-vendor check.',
   f'If `claude -p` is unavailable (out of Max pool, ENOTFOUND), the cross-family gate can\'t run. Do NOT skip the gate — the order is **Fable → Astra high → NOT RUN**:\n- Bounce and Grade run on **Astra high** in a **fresh codex session with no build context**:\n  `codex exec --skip-git-repo-check --sandbox read-only -m {M("astra")} -c model_reasoning_effort=high "<same prompt>" </dev/null`\n- **Say it in the handoff:** "Gate ran on Astra, same-family — no cross-vendor check." He should know when a build shipped without one.\n- If Astra cannot run either, the gate is **NOT RUN** — report it as NOT RUN, never as a pass. Sol and Opus never gate.', 1),
  ('- The grader is never the author\'s context; cross-family when possible, fresh-context same-family only as a flagged fallback.',
   '- The grader is never the author\'s context. Cross-family (Fable) preferred; Astra high same-family is allowed and named in the handoff; otherwise the gate is NOT RUN.', 1),
],
}

def main():
    bdir, dry = sys.argv[1], '--dry-run' in sys.argv
    manifest = {e['path']: e['sha256Before'] for e in json.load(open(os.path.join(bdir, 'manifest.json')))['files']}
    out, errors = {}, []
    for rel, edits in EDITS.items():
        p = os.path.join(H, rel)
        raw = open(p, 'rb').read()
        if rel not in manifest:
            errors.append(f'{rel}: not in the backup'); continue
        if hashlib.sha256(raw).hexdigest() != manifest[rel]:
            errors.append(f'{rel}: changed since the backup — not editing'); continue
        s = raw.decode('utf-8')
        for old, new, n in edits:
            c = s.count(old)
            if c != n:
                errors.append(f'{rel}: expected {n}, found {c}: {old[:100]!r}'); continue
            s = s.replace(old, new)
        out[p] = s
    if errors:
        print('\n'.join(errors)); sys.exit(1)
    if not dry:
        for p, s in out.items():
            open(p, 'w', encoding='utf-8').write(s)
    print(f'{"checked" if dry else "wrote"} {len(out)} files, {sum(len(e) for e in EDITS.values())} edits')

if __name__ == '__main__':
    main()
