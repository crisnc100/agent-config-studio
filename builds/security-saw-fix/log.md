# Build log — security saw fix and fable-prev

## 1. What the security pass saw, under --since-close (#58's deferred x2)

A --since-close slice sends the security pass the whole slice diff, bigger than the code reviewer's delta, but `saw` was
filtered by what the cap cut from the delta. Now the cut is worked out from the diff the security pass was sent, so a
file past the cap is never listed as seen, and the close names it ("security pass did not see …"). Test:
review.context.test.mjs 9 (two files over the cap together, each covered by its own slice close; the second is cut).

## 2. fable-prev

`fable-prev` → claude-fable-5-1, `track: false`, in models.default.json and the resolver's golden copy (kept identical),
like grok-prev. Not added to the assist picker: the request named the model list only.

**Decision the request left open:** fable-prev shares its id with fable today, and the audit's id → family lookup made
any shared exact id ambiguous, which dropped every fix for claude-fable-5-1 (tests/audit.mjs crashed). lib/audit.js now
names the tracked family when one tracked family shares an exact id with pinned (track: false) ones. Two tracked
families sharing an id stay ambiguous; once fable moves to a new id, claude-fable-5-1 names fable-prev. No pinned
assertion changed. Test: tests/models-fable-prev.mjs (wired into verify.sh).
