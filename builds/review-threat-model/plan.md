# Reviewer threat model and the protected rule

## Goal

Reviews keep raising HIGHs on crafted inputs (odd file names, git config, hostile contributors). Two causes:
reviewers assume an adversary this operator does not have, and "protected" forces HIGH however rare.

## Changes

1. Threat model in the rubric. Both reviewer prompts (the code review and the security pass) carry RUBRIC through
   promptNotes, so the threat model goes there, beside the likelihood anchors: one operator on his own repositories,
   honest but fallible AI builders that repository content can steer. Failures, timeouts, interruptions, size caps,
   cut-off diffs, a close crediting content no reviewer read, a weakened test, failure taken as success and ignored
   settings are in scope at normal likelihood; a hostile outside contributor, crafted file names or paths and unusual
   git config, attributes or drivers score likelihood 1, and the finding names the assumption it needs.
2. Protected bands by likelihood: >= 3 HIGH; 2 MEDIUM (never filed); 1 LOW, filed, marked protected in --summary
   ("[protected]" before the issue) and in the tier reasons ("filed protected: ids"). Unscored protected blocks as
   MEDIUM. A filed protected LOW keeps the tier at least MEDIUM; a deferred protected HIGH or MEDIUM still makes it HIGH.
   The Grade derives through the same scoreFinding, so it follows; grade.schema.json carries no rule text.
3. RUBRIC_VERSION bumps (calibration.md follows); calibration row 2 becomes LOW.
4. Skill text: code-review, security-check and build (claude and codex copies).

Out of scope: the MEDIUM floor (risk 11), the HIGH cutoff (40), coverage logic, pre-existing protected handling.

## One PR

One PR: the rubric text, the derivation and the tier rule are one rule change; the rubric would describe bands the
script does not derive if they landed apart.

## Tests

New tests first (fail before the code): the three likelihood bands, unscored protected as MEDIUM, a filed protected
LOW keeps the tier MEDIUM with "filed protected", the summary marks it, the threat model in both prompts.
Existing assertions the new rule changes go in their own test-only commit.
