Read /Users/cortega/Documents/Projects/personal/skills-work/builds/review-split/plan.md, then /Users/cortega/Documents/Projects/personal/skills-work/builds/review-split/advisor-brief.md and the two advisor answers in /Users/cortega/Documents/Projects/personal/skills-work/builds/review-split/advice/ (advisor.out, second.out) for context. The repo is /Users/cortega/Documents/Projects/personal/agent-config-studio-trunk. You are an adversarial reviewer with no attachment to this plan. Attack it:
- what is missing;
- what will break;
- which edge cases and failure modes the author missed;
- where the acceptance bar is too weak to catch a bad build.
Pay special attention to:
- whether "doc edits land before the one fix check" works with the review gate's close and fix-check rules;
- whether a report-only security record can leak into push-gate coverage;
- whether the /doc-update brief contract is enough for a model to write correct technical docs.
Be concrete, with file:line where it matters. Do not rewrite the plan; list the gaps and why each matters. Read-only: change no files.
