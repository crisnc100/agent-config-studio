# Log

- 2026-11-18: plan written; baseline: review.close.test.mjs has 5 failures inside the sandbox before any change.
- 2026-11-18: new tests (bands, unscored, rubric text, both prompts, filed protected tier and summary mark) failed before the code and pass after.
- The summary mark is limited to filed protected LOWs: marking every protected line broke exact deferred-line tests for HIGHs that already read HIGH.
- Suites green: review-gate and pr tests (PTY ones outside the sandbox), and the listed tests/*.mjs.
