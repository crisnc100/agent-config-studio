---
name: Callback contract
summary: When a builder comes back to the orchestrator, and that it always brings a recommended answer.
---
**Callback contract — the builder comes back ONLY when:**
- the spec does not determine a choice it must make;
- it needs to deviate from the plan;
- a check has failed twice on the same step;
- it hits a scope or architecture decision;
- the phase is complete (the normal checkpoint).

Every callback states the choice and the builder's recommended answer, and keeps going on the rest of the work when it can.
