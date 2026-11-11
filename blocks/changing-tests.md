---
name: Changing existing tests
summary: How an existing test may change: its own commit, a message naming each assertion, a cross-vendor check, and a line in the PR body.
---
**Changing existing tests.** Builders never loosen a test to make code pass. Any change to an existing test must:
- go in its own commit, touching test files only and never bundled with the code change that wanted it;
- have a message that names each changed assertion and the behavior it still guards;
- be reviewed by another vendor's model, which checks whether any assertion got weaker or would now pass on broken code; a weakening it finds goes to the fix round like any HIGH or MEDIUM;
- be listed in the PR body, so the operator sees it at merge.

Swap whole-object shape checks for checks on the fields that change behavior, plus explicit absence checks; never a blanket "extra fields are fine".
