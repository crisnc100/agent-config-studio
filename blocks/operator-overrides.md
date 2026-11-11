---
name: Operator-only overrides
summary: Only the operator waives a finding or overrides the push gate; agents never do, and never ask.
---
Only the operator accepts a confirmed finding (`--waive`, from a real terminal) or overrides the push gate. Agents never set `REVIEW_GATE_OVERRIDE`, never pass `--no-verify`, and never change `core.hooksPath` or any `reviewgate.*` setting. Never ask the operator to run `--waive` or `REVIEW_GATE_OVERRIDE`; defer what the one fix check or recheck leaves, per the review policy.
