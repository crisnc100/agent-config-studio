# Fix round — review 2026-11-17-00-41-49-727ac2 — fix f1, f2, s1 (all MEDIUM). Test first for each.

## f1 MEDIUM lib/agent.js:471
Excluding both temporary roots without supplying a writable replacement breaks worker test runs. The launcher leaves TMPDIR unchanged, while tests/fixtures/cleanup.mjs:26 creates directories under os.tmpdir(). A linked-worktree worker running the required agent-git-access test therefore encounters a sandbox denial before testing anything. The live commit probe does not exercise this path.

trigger: A Codex worker opened in a linked worktree runs node tests/agent-git-access.mjs with the ordinary inherited TMPDIR.

suggestion: Provide an isolated writable scratch directory and point the worker's temporary-directory environment variables there, while keeping the shared temp roots excluded.

## f2 MEDIUM lib/agent.js:476
The fixed file allowlist breaks git add when core.splitIndex=true and Git needs to create or refresh the shared index. Git stores sharedindex.<hash> files inside the worktree administration directory; none receives a grant. This supported Git configuration previously worked with the whole-directory grant, but now staging can fail before the intended commit.

trigger: A linked-worktree Codex worker stages changes with core.splitIndex=true that exceed splitIndex.maxPercentChange, requiring a new shared index.

suggestion: Handle split-index repositories safely, or force ordinary index mode for worker Git commands without changing persistent configuration. Cover staging and committing with core.splitIndex enabled.

## s1 MEDIUM lib/agent.js:471
The sandbox pins that keep temp directories and inherited writable roots out of a Codex worker's write set are emitted only inside the validated linked-worktree branch (after the backlink check passes). A Codex worker whose cwd is a normal checkout, a subdirectory of a linked worktree, or a worktree whose gitdir/backlink validation fails gets no pins, so Codex's default writable roots ($TMPDIR, /tmp, plus any writable_roots from the operator's Codex config) still apply. When the repository's git directory lives under one of those roots, the worker can write common `config`, `hooks/`, and the admin dir's `commondir`/`config.worktree`; the orchestrator's next git command there then runs worker-chosen config (core.fsmonitor, core.hooksPath, core.sshCommand) outside the sandbox. Harmed principal: the operator, via a prompt-injected or misbehaving Codex worker. The README's claim that 'placing a repository in a temp directory does not bypass the boundary' and that forged links 'get no grant' only holds for workers started at a validated linked-worktree root. Unverified against a live Codex (could not run it in this session): the evidence is the launcher code and the branch's own README rationale for the pins. The exposure exists at the base for all of these cases; the branch closes it for one case only.

trigger: `acs-agent open sol --cwd <dir>` where <dir> is a normal checkout, a subdirectory of a linked worktree, or a worktree failing the backlink check, and the repository's git directory is under $TMPDIR or /tmp (e.g. a scratch repo created in a temp directory, as the original probe design did). The operator's usual worktrees live in the project folder and are not affected.

suggestion: Emit the temp-directory exclusions (exclude_tmpdir_env_var, exclude_slash_tmp) for every Codex worker, or at least whenever `git rev-parse` finds a repository, outside the backlink check; keep only the --add-dir grants conditional on validation. Decide separately whether to clear writable_roots for all workers, since that also drops the pack-installed review-log and field-reports roots. Add a test asserting the pins are present for a normal checkout, a linked-worktree subdirectory and a forged-backlink worktree.

## Orchestrator notes
- f1: a Codex builder must be able to run the repo's tests, which write under os.tmpdir(). Give the worker a private writable temp dir (e.g. its run folder's tmp/, exported as TMPDIR in the launcher and granted) instead of removing temp access. Extend probe.sh so the worker also writes under os.tmpdir() and that step must be ok.
- f2: either grant what split-index needs (sharedindex.* files are created with new names, so the grant must allow that without granting commondir/gitdir/config.worktree), or detect core.splitIndex and say so plainly; say which and why.
- s1: apply the same temp/writable-root pins on every Codex launch, not just validated linked worktrees.
- Existing-assertion changes: own test-only commit naming each. Commit; reply DONE with shas. Don't run the live probe (the orchestrator will).

