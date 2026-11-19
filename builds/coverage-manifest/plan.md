# Coverage manifest, PR 2: the switch

Design: /Users/cortega/Documents/Projects/personal/skills-work/builds/coverage-manifest/design.md (sections 2, 3.1, 4, 5 and 6), with the ten binding decisions in pr2-decisions.md beside it.

## One PR

This is the second of two PRs, and it ships as one. The new rule and the old inference contradict each other, and half-deleted merge logic would leave main unsafe, so it cannot be split further. PR 1 (merged) records the manifests.

## Scope

- Coverage only from manifests. A changed file is covered at the tip only when its exact [path, base state, head state] is in the read list of a code manifest. That manifest must come from the chain (the review and its fix check) of a close the tip descends from, and partial closes count too. Nothing is inferred from diff text, a Grade covers nothing, and a record from before manifests covers nothing; the refusal says it predates prompt manifests.
- Unreadable files (binary, oversize, submodule, submodule-change, encoding) pass the push and are named in a HIGH tier. A capped file is unseen: a slice at the tip reads it.
- The tier. A close's stored tier keeps only its chain's failed or skipped passes. "Not read by any reviewer" and "security pass did not read" are computed once at the tip, over every manifest. A failed pass counts only in a chain that supplies coverage.
- The fix check reads the whole change from the base of two sets of files: those changed since the review that it did not read, within the review's close scope (builds/ and coverage-exempt files left out), and every cited file. Its security pass reads the owed ones.
- The fixed rule. A blocking or protected fixed finding needs the fix check to have been asked about it, and to have read every cited path that changed since its base. An owed path must be in the security manifest, any other path in the code manifest. A path at its base state needs only the asking. A path left unread (capped or oversize) means dispute or waive.
- Fix-check findings. A blocking or protected fix-check finding marked fixed is refused: it is deferred and its fix sliced at the tip, security findings outside the fix included (the never-deferred rule is lifted).
- Grade findings are carried to the tip review. A Grade close prints no slice hint and refuses fixed on any non-criterion finding.
- Open findings. --open-findings prints them, and the review collects them itself, on runs without --code-only only.
- fixCheck is retired with a one-time notice, --since-close is removed, and all the legacy inference is deleted (design 3.1).
- The skill text follows (design 5).

## Acceptance

The full repository test command passes at the tip. The frozen `review.test.mjs` is untouched. The grep in design 6.2 finds only `REVIEW_FIX_CHECK`, in the retirement notice, and `review.mjs` shows net deletions against main.
