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
- The required checks are `syntax`, `guards` and `offline`. Tests added to CI join the `offline` group, so the
  required check covers them and branch protection does not change.

## Three PRs, one after another
Each leaves main working alone. PR 1 changes how the gates are wired and must change nothing they run. PR 2 cuts
the checks a PR shows from ten to five and makes the one test job faster, on the same tests, so its speed is
measured on a like-for-like set. PR 3 adds the tests CI skips and may surface real failures, so it is reviewed
apart from both.

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

### PR 2: five checks, one offline job that runs files side by side
A PR shows five checks instead of ten, and the wait is measured, not assumed.
1. The checks on a PR are exactly `syntax`, `guards`, `offline`, `package` and `stranger-macos`. `syntax`, `guards`
   and `offline` keep their names, so branch protection does not change.
2. `offline` is one job on the declared minimum Node (`package.json` engines, pinned exactly: 20.0.0). The matrix,
   the LTS leg and the aggregate job are gone. It runs the same files as the `offline` group on main.
3. `tests/run.mjs --jobs N` runs up to N files of a group at once, one process per file. Output is printed whole per
   file, in list order. A failure stops new files from starting, the run exits with the first failing file's code
   (first in list order), and the files not run are named. Without `--jobs`, behaviour is unchanged, so `verify.sh`
   runs as before.
4. A file that cannot run beside others carries `serial` on its `tests/SUITE` line with the reason, and runs alone
   before the rest, while the machine is quiet. A test is never edited to make it run beside others. Four files are
   serial: `assist-containment` and `roots-live` (wall-clock windows), `phase2a` and `usage-seats` (each writes into
   an absent real-home folder that the real-home checks beside it see).
5. `package` is one job (Linux, the minimum Node) and runs the `bunx` test as a step; the separate `bunx` job and
   the other two `package` variants are gone. `stranger-macos` (current Node) also runs the package test, so the
   package is still installed on a Mac and on current Node.
6. Evidence in the PR body: the `offline` wall time and per-file seconds from this PR's own run, against main's
   (70 files in 314 s on LTS, 325 s on 20.0.0), and the chosen N with the runs that justify it.
7. `suite-coverage.mjs` passes. New runner behaviour is proven in a new test file; an existing assertion changes
   only under the test-change rule (own commit, each changed assertion named, checked by another model).

### PR 3: the tests CI skips
1. The `local` files that can run on a CI runner, and the 5 `pending-ci` files in `tests/` (`packs-review-settings`
   was already `local`), join the `offline` group: 36 files. Each either passes on Linux at the minimum Node, or stays
   `local` with the specific reason on its line. Eight stay: `models-scripts` (runs the review script installed in the
   real home), `skill-usage` (reads the real `~/.claude/projects`), `models-backup` (restores this machine's real
   backup), `zip` (cross-checks with macOS `ditto`), `packs-security` (its helper needs `fs.readdirSync`'s
   `recursive`, Node 20.1+), `liveness` (about 2 minutes on every pull request), `worktree-tools` (its gh-missing
   checks delete a shim but keep `/usr/bin`, where a runner has gh) and `home` (a 20 ms wall-clock window in its
   Refresh check that misses under load).
   Joining `ci:offline` also puts the 5 former `pending-ci` files in `verify.sh`.
   Before files join `offline`, each runs alone with `HOME=<fresh empty temp dir> ACS_SUITE=offline` and no agent
   CLI on PATH, and the temp home is listed afterwards: a file that writes there is a writer the runner's empty home
   exposes and the Mac's full one hides. The scan is repeated whenever files join the group.
2. 28 of the 30 pack tests are `ci:packs ci-only` (`verify.sh` does not gain about 15 minutes). `pr.test` and
   `review.merge.test` are `manual`: they assert gh is absent with a PATH that keeps `/usr/bin`, where a runner has gh.
   The `offline` job runs the 28 in a step after the offline suite when the PR changes anything under `packs/` (`git diff HEAD^1 HEAD -- packs/` on
   the merge commit, checked out with depth 2), and always on main; an answer short of "unchanged" runs them. That
   step runs on LTS Node, not 20.0.0: two of them cannot test what they mean to there (`fs.readdirSync`'s
   `recursive` arrived in 20.1, and `review.global`'s `fs.statSync` patch trips 20.0.0's module loader), and the
   offline suite covers the minimum Node. `packs/flag/tests/flag.test.mjs` stays `ci:offline ci-only`.
3. `review.test.mjs` (frozen at 4a5807e) is run, never edited.
4. A file that fails on Linux for a product reason, or intermittently, is a finding: stop and report it with the
   failing check and its failure rate. It is never skipped, loosened or retried to green.
5. The `pending-ci` lane is gone from `tests/SUITE` and from `suite-coverage.mjs`.
6. The PR body shows the `offline` wall time before and after.

## Out of scope
- Fixing `models-scripts.mjs`, which fails 6 of 9 on main on the developer machine.
- Branch protection: `package` and `stranger-macos` stay not required.
- Raising the minimum Node above 20: its own PR, since the launcher, the README and two tests pin the number.
- Running `verify.sh` with `--jobs`.
- Pinning actions to commit SHAs.
- The client folder name that `tests/real-home.mjs` prints in CI logs.
- No test that existed before this work is changed in any of the three PRs.

## Validation
- PR 1: `node tests/suite-coverage.mjs`, `./verify.sh`, and `gh pr checks <n> --watch` green.
- PRs 2 and 3: the same, plus the `offline` job's per-file timings from the run log in the PR body.
