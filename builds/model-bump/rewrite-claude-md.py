#!/usr/bin/env python3
"""Rewrite ~/.claude/CLAUDE.md's model names to families. Refuses unless the file's
sha256 is the one read right before this edit. Policy sentences are kept; only the
versioned names and raw ids change, plus one pointer line at the top of Model lanes.

  python3 rewrite-claude-md.py <expected-sha256> [--dry-run]
"""
import hashlib, os, sys

P = os.path.expanduser('~/.claude/CLAUDE.md')
M = lambda f: f'"$(model-id {f} || echo MODEL-ID-UNRESOLVED-{f})"'

EDITS = [
  ('subagents or GPT-6 Sol medium / Opus 5.5 medium for the implementation pass.',
   'subagents or Sol medium / Opus medium for the implementation pass.'),
  ('Codex (gpt-5.6-sol high) reviews,',
   'Codex (Sol high — the VPS pins its own model id; the local registry does not set it) reviews,'),
  ('# Model lanes (canonical — skills reference this table, never copy it)\n',
   '# Model lanes (canonical — skills reference this table, never copy it)\n\n'
   'Names here are families; `model-id --table` prints the current id for each.\n'),
  ('— Fable 5.1 (`claude -p --model claude-fable-5-1 --effort high`) and GPT-6 Astra high (`codex exec -m gpt-6-astra -c model_reasoning_effort=high` — always name `-m` for judgment work: bare `codex exec` resolves to GPT-6 Sol high via `~/.codex/config.toml`, not Astra).',
   f'— Fable (`claude -p --model {M("fable")} --effort high`) and Astra high (`codex exec -m {M("astra")} -c model_reasoning_effort=high` — always name `-m` for judgment work: bare `codex exec` resolves to Sol high via `~/.codex/config.toml`, not Astra).'),
  ('1. **GPT-6 Sol medium** (`codex exec -m gpt-6-sol -c model_reasoning_effort=medium`) and **Opus 5.5 medium** (`claude-opus-5-5`) — co-default implementers,',
   f'1. **Sol medium** (`codex exec -m {M("sol")} -c model_reasoning_effort=medium`) and **Opus medium** (`{M("opus")}`) — co-default implementers,'),
  ("Opus 5.5 fixes Opus 5's verbosity and slop — real taste, efficient, Sol-level, close enough to the judgment tier to challenge it (Fable is still smarter). GPT-5.6 Sol is retired.",
   "The current Opus fixes the previous Opus generation's verbosity and slop — real taste, efficient, Sol-level, close enough to the judgment tier to challenge it (Fable is still smarter). The previous Sol generation is retired."),
  ('2. **Grok 4.7** — a different flavor (logic-RL), below Opus 5.5 and Sol in intelligence;',
   '2. **Grok** — a different flavor (logic-RL), below Opus and Sol in intelligence;'),
  ('**Reviewer pool** — Fable 5.1, Astra high, GPT-6 Sol high, Opus 5.5 (via agent teams). Opus 5.5 and GPT-6 Sol review code but never advise — advice stays with Fable and Astra. Sol vs Opus 5.5 as reviewers: unranked; record outcomes.',
   '**Reviewer pool** — Fable, Astra high, Sol high, Opus (via agent teams). Opus and Sol review code but never advise — advice stays with Fable and Astra. Sol vs Opus as reviewers: unranked; record outcomes.'),
  ('**Skill defaults:** /advisor → Fable 5.1.', '**Skill defaults:** /advisor → Fable.'),
  ('Sol- or Astra-built work → Fable or Opus 5.5 reviews; Opus-, Fable-, or Claude-built work → Astra or GPT-6 Sol reviews.',
   'Sol- or Astra-built work → Fable or Opus reviews; Opus-, Fable-, or Claude-built work → Astra or Sol reviews.'),
]

def main():
    want = sys.argv[1]
    raw = open(P, 'rb').read()
    got = hashlib.sha256(raw).hexdigest()
    if got != want:
        sys.exit(f'CLAUDE.md changed since it was read ({got} != {want}) — not editing')
    s = raw.decode('utf-8')
    for a, b in EDITS:
        if s.count(a) != 1:
            sys.exit(f'expected exactly one of: {a[:90]!r} (found {s.count(a)})')
        s = s.replace(a, b)
    if '--dry-run' not in sys.argv:
        # Re-check immediately before the write: stop if it moved while we worked.
        if hashlib.sha256(open(P, 'rb').read()).hexdigest() != want:
            sys.exit('CLAUDE.md changed during the rewrite — not editing')
        open(P, 'w', encoding='utf-8').write(s)
    print(('checked' if '--dry-run' in sys.argv else 'wrote') + f' {len(EDITS)} edits')

main()
