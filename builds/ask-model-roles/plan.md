# C1: role and effort lookup in ask-model and model-id

Source: `skills-work/plans/reusable-pieces-sweep.md`, C1.

## The one rule (lib/roles.js)
`memberEffort` already is the rule for a role's models: the model's own effort in the role, else the role's effort,
else the family's flavor effort, else none. `resolveRole` gives `effort` and `altEffort` by it, so an empty
`altEffort` already means "no flavor effort either". The new `familyEffort(family, roles)` uses the same function:
- in the first listed role whose `members[]` or `alt` holds the family, that member's effort by `memberEffort`;
- in none of them, the family's flavor effort;
- else `''`, and the callers pass no effort flag.
The alt keeps inheriting the role's effort before its flavor's, as the model guide already shows it ("second
opinion: astra at high effort"). With that rule /advisor and /build's swapped Grade already end at the same effort;
the C1a drift is two hand-written ways of reaching it, and both go.

## Interfaces
- `ask-model --role <role> --second`: the role's `alt` at its `altEffort` (`--effort` still wins). Exit 64 when the
  role has no alt. `--second` without `--role` is a usage error (64).
- `ask-model --family <f> --effort-from <role>[,<role>…]`: `familyEffort`. `--effort` wins over it. An unknown role
  exits 64; `--effort-from` without `--family` is a usage error.
- `model-id --effort <family> [--role <role>[,<role>…]]`: prints the effort and a newline, or nothing. `--json` prints
  `{family, effort, source, role}`. Exit 2 on an unknown family or role, like the other role flags.

## Skills (both twins; call lines only, prose unchanged)
- second-opinion: `role_effort` and its two callers become `ask-model --family "$family" --effort-from advisor,reviewer`.
- build: the swapped Grade becomes `ask-model --second --role advisor …` (flags in that order, so the gate block's
  `^ask-model --role advisor` stays unique); claude's builder effort becomes `model-id --effort "$BUILDER" --role builder`.
- advisor: `second) who=(--role advisor --second)`.

## Lint
A new test in `review.packs.test.mjs`: no shipped SKILL.md line runs `jq` over role or flavor fields (`.alt`,
`.altEffort`, `.members`, `.effort`, `.flavor`), or pipes `model-id --role|--flavor … --json` into `jq`. It is checked
against planted lines first, so it can't pass vacuously.

## Needs an approved test amendment
`review.skills.test.mjs` finds the swapped-Grade block with `/^ask-model --family "\$alt"/m` (the swap test and the
advisor-vs-build test, both harnesses). That selector has to become `/^ask-model --second --role advisor/m`; every
assertion stays. I'll build, leave that test file alone, and report the four failing cases with the amendment.

## Tests
`tests/ask-model.mjs`: `--second` with and without an alt, an alt with its own, the role's and only a flavor effort,
`--effort` over `--second`, `--effort-from` order and fallbacks, unknown role, misuse (64). `tests/roles.mjs`:
`model-id --effort` with and without `--role`, nothing printed when no effort, `--json`, exit 2 cases.
