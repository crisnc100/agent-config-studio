# Two follow-ups from the orchestrator's live probe run

1. Real bug (lib/agent.js trust detection): the live probe's worker sat on Codex's trust dialog and `wait` returned `no_start` instead of `stuck` kind trust. This variant appears when the cwd is a linked worktree / subdirectory of a repo. Exact screen (80-col pane):
```
  nZS2/linked ' worktree
  Note: You’re in a subdirectory of a Git project. Trusting will apply to the
  repository root:
  /private/var/folders/8k/8pc_bcd90kv7g5n5jj5gl3v80000gn/T/acs-codex-git-admin-hC
  nZS2/repo
  Trust this folder? Codex can read, edit, and run files here, subject to your
  permission settings. Folder settings can run code automatically, even without a
  model request. Continue only if you trust these files. Your trust decision will
  be saved.
› 1. Trust and continue
  2. Quit
  enter continue · esc quit
```
Add it as a fixture (tests/fixtures/agent-screens/codex-trust-subdir.txt), a test that fails on main, then fix detection. Check the installed Codex bundle for any other trust-dialog variants and cover them too.
2. The probe can't run as written: its brand-new repo always triggers Codex's trust dialog, and answering it writes Codex config (the operator's call). Change probe.sh to create its linked worktree from THIS repository (`git worktree add --detach <temp>/probe-wt HEAD`, like builds/agent-command/rig/run.mjs) so trust is inherited; keep every attempt harmless (identical bytes for commondir/gitdir/common config; config.worktree and common/hooks/<unique name> must be removed afterwards if they ever got written); remove the worktree at the end. It must not depend on the builder role: take the family as an argument, default sol.
Same constraints; separate test-only commit for any existing-assertion change; commit; reply DONE with shas.
