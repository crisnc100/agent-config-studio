**Verdict: (c), repeatable exact strings compiled into `permissions.allow`.** It is the only option where the caller cannot express anything except `command(<string>)`. No option keeps my earlier "no new flags" cut, and that cut no longer holds: with the refusal guard in place, a Neon build that runs any test exits 4 without a grant.

- **(a) is out.** A default prefix is a standing grant nobody chose per task. It also relies on prefix matching, which the probes never measured; they only show exact rule → exact command.
- **(b) is out.** It has the same expressive power as (c), but `ask-model` would have to validate a JSON document by rejecting everything else in it (`deny`, other keys, other rule kinds). It also puts agy's rule syntax into both build skills and invites "just one more key".
- **Correction to my earlier Q2:** no default git verbs either. The caller passes `git add -A` and the fixed commit line like any other command.

**Implementation direction**

1. **Parser (`tools/ask-model.mjs:1084`).** Handle the flag before the `VALUE_FLAGS` lookup, because line 1098 rejects any repeated flag. Collect values into an array and exit 64 without `--build`. I would name it `--allow-command`, since `ask-model` never runs it.
2. **String check, one regex, no parsing.** Accept one line with no leading or trailing space, from a closed character set: letters, digits, space and `_ - . / : = @ , + " '`. That refuses `*`, `(`, `)`, `;`, `&`, `|`, `<`, `>`, `$`, backtick, backslash and control characters. Cap count (about 16) and length (about 512), and refuse duplicates.
3. **argv (`:603`).** Build mode keeps `--mode accept-edits` and adds `--settings {"permissions":{"allow":[…]}}` only when the list is non-empty. No `deny`, no other key, no `--sandbox`. With no flag the argv is byte-identical to today, and `AGY_SETTINGS` and the read-only path are untouched.
4. **Preamble (`:1971`).** Append the granted commands verbatim with "run these exactly; anything else is refused and fails the build". This is flag → prompt, not prompt → grant. Without it the brief and the flags drift and the model runs variants.
5. **Receipt.** Add one top-level `--json` field listing the granted commands, absent when the flag is unused and present on failures too. `served.verified` stays false.
6. **Consumers.** Update `docs/neon-builder.md` and the Neon launch line in both build skills (`packs/build/skills/claude/build/SKILL.md:238`, `codex/…:164`), then run `acs packs update build`. The brief must dictate one fixed one-line commit message that matches the flag.

**Validation (offline only, new test file, no existing assertion changed)**

- **argv:** without the flag it equals today's; with two commands the settings object deep-equals the allow list alone, in order; it never contains `auto`, `--sandbox` or a skip-permissions flag.
- **Read-only:** `tests/ask-model-agy.mjs` and `tests/vendor-prefixes.mjs` pass unmodified.
- **Refusals:** each rejected shape exits 64 and the fake agy is never started. Cover the flag without `--build`, a non-agy family, an empty value, each refused character class, and the count, length and duplicate limits.
- **Guard:** a stream with a `DENIED` step while grants are present still exits 4 with no `build` field.
- **Preamble and receipt:** assert both the presence and the absence cases.

**Documented as unverified (no calls left)**

- unverified — whether agy treats `command(X)` as exact or as a prefix. Call it "one rule per exact string", never an exact-match guarantee.
- unverified — that agy accepts the wrapper's compiled argv. `probe-observations.json` records only `"mode": "allowed"`, so the builder must match the settings shape you used by hand in call 2.
- unverified — whether git commands are refused under plain accept-edits. Call 1 shows no commit but not whether one was attempted.
- The sandbox stays off, the qualification ledger stays 0/5, and the first real named task is the live confirmation. A wrong rule fails loudly through the guard.

**Cut**

- Wildcards and prefixes, non-`command` rule kinds, and any `deny` additions.
- Settings passthrough or a commands file.
- Saved per-project command lists, and derivation from `package.json` or the brief.
- A `--sandbox` flag, scanning agy's log for ignored rules, and any isolation wording.

**One thing to check before briefing a builder:** `tools/ask-model.mjs` changed between two of my reads minutes apart. Line 1763 went from `buildDenials.count && false` to `buildDenials.count`, and line 1696 from `if (!AGY_DENIALS[previous?.refusal])` to `if (true)`. As last read, `if (true)` drops the sticky refusal that `tests/ask-model-build-denials.mjs:98` asserts. Something is mutating the file; confirm it is restored first.
