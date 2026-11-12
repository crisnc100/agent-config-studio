# CI runs every test: one list that verify.sh and ci.yml both read

## Problem
The test list is written by hand twice, in `verify.sh` and in `.github/workflows/ci.yml`, and nothing compares them.
At 20a655b there are 162 test files (`tests/*.mjs`, `packs/*/tests/*.mjs`):
- `verify.sh` runs 112. CI runs 74. CI's list last changed in #34.
- 40 that `verify.sh` runs are not in CI.
- 38 real tests are in neither: 8 in `tests/` (packs-flag, packs-pr, packs-review-settings, roles-security,
  skill-wizard-blocks, skill-wizard-blocks-ui, ui-clarity-f, ui-clarity-g) and all 30 pack tests
  (28 review-gate, 2 pr).
- 10 are not gate tests: 7 `*-qa-server.mjs`, `audit-real-run.mjs`, and the helpers `real-home.mjs` and
  `worktree-sandbox.mjs`.

Linux CI has caught what the Mac cannot (builds/usage-flake-fix: a clock race that never fails on APFS), so a test
that only runs locally is not covered.

Also: no job has a timeout (run 42070278683 hung in `offline (lts/*)` for 6 hours), and the `syntax` job skips
`packs/`, `tools/` and `blocks/`, which ship.

## Design
- `tests/SUITE`: a plain-text list, one test file per line in run order, each with a lane. Comments carry the "why"
  that `verify.sh` carries today.
  - `ci:<group>`: runs in the CI job of that name, and in `verify.sh` unless also marked `ci-only`.
  - `local`: `verify.sh` only. Needs a reason on the line.
  - `manual`, `helper`: never run by a gate. Needs a reason on the line.
- `tests/run.mjs <group>|--local`: runs the files of one group, or everything `verify.sh` owns, in list order, one
  process per file. Stops at the first failure with that file's exit code. Prints seconds per file.
- `verify.sh` keeps the real-home snapshot and its exit trap, and calls `node tests/run.mjs --local` between them.
- `ci.yml` jobs call `node tests/run.mjs <group>`. `package` and `bunx` keep their own steps (they take a tarball).
- `tests/suite-coverage.mjs`, a guard in the `guards` job and in `verify.sh`. It fails when:
  - a test file is not in `tests/SUITE`, or a line names a file that does not exist, or a file is listed twice;
  - a `ci:<group>` has no job in `ci.yml` that runs it;
  - a `local`, `manual` or `helper` line has no reason.
  It carries a negative control: a fixture tree with one unlisted file must fail.
- Every new CI job is a `needs:` of the existing `offline` job, so the required checks (`syntax`, `guards`,
  `offline`) cover it and branch protection does not change.

## Three PRs, one after another
Each leaves main working alone. PR 1 changes how the gates are wired and must change nothing they run; PRs 2 and 3
add coverage and may surface real failures, so they are reviewed apart from the rewiring.

### PR 1: one list, same tests
1. `tests/SUITE` lists all 162 files once. The 78 not yet in CI are `local` (the 40) or a `pending-ci` lane (the
   38), which `suite-coverage.mjs` accepts only while PRs 2 and 3 are open work, named in the file.
2. `verify.sh` runs the same 112 files in the same order as before, plus the guards `suite-coverage.mjs` and
   `ci-syntax-step.mjs`. The PR body shows the before and after lists and their diff (those two added lines).
3. CI runs the same 74 files under the same job names. The PR body shows the same comparison per job.
4. `suite-coverage.mjs` passes, and its negative control fails as designed.
5. `ci.yml`: `timeout-minutes` on every job (20; the `offline` aggregate 5). Superseded runs of the same PR are
   cancelled; runs on main never are. `syntax` also checks `packs/`, `tools/` and `blocks/`, one file per
   `node --check`, and fails when it finds no file (`ci-syntax-step.mjs` runs that step from `ci.yml`). The "live
   containment is a local gate" banner prints once, in the job summary. `setup-guards.mjs` runs once. The macOS
   comment no longer cites private-repo billing.
6. `RUNBOOK.md` Testing says what `verify.sh` and CI run now and where the list lives.

### PR 2: the tests/ files CI skips
1. The 40 `verify.sh`-only files and the 8 ungated files run on Linux at Node 20.0.0 and LTS, in groups sized from
   measured time so no job runs longer than about 8 minutes. On a Mac, serially: 366 s and 15 s
   (`liveness` 122 s, `worktree-tools` 81 s).
2. The 8 ungated files also join `verify.sh`.
3. A file that cannot run on a CI runner stays `local` with the specific reason on its line.
   `models-scripts.mjs` is one: it runs the review script installed in the real home.
4. A file that fails on Linux for a product reason is a finding: stop and report it with the failing check. It is
   never skipped, loosened or retried to green.
5. `pending-ci` holds only the 30 pack tests.

### PR 3: the pack tests
1. All 30 `packs/*/tests/*.test.mjs` run in CI, one process per file, in 3 groups by measured time (760 s serially
   on a Mac; `review.basemerge` 118 s), at Node 20.0.0 and LTS.
2. They are `ci-only`: `verify.sh` does not gain 13 minutes. `node tests/run.mjs packs-1` (2, 3) runs them locally.
3. `review.test.mjs` (frozen at 4a5807e) is run, never edited.
4. A file that fails intermittently, or only at Node 20.0.0, is reported with its failure rate and the failing
   check. No retry wrapper.
5. The `pending-ci` lane is gone from `tests/SUITE` and from `suite-coverage.mjs`.

## Out of scope
- Fixing `models-scripts.mjs`, which fails 6 of 9 on main on the developer machine.
- Branch protection: `package`, `bunx` and `stranger-macos` stay not required.
- Pinning actions to commit SHAs.
- The client folder name that `tests/real-home.mjs` prints in CI logs.
- No existing test file is changed in any of the three PRs.

## Validation
- PR 1: `node tests/suite-coverage.mjs`, `./verify.sh`, and `gh pr checks <n> --watch` green.
- PRs 2 and 3: the same, plus the new jobs' per-file timings from the run log in the PR body.
