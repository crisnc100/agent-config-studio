# Production builder helper checkpoint

`tools/agy-builder.mjs` owns the pinned agy process, Seatbelt profile, Google broker and call lifecycle. `tools/agy-builder-source.mjs` resolves and captures the explicitly selected Git worktree and publishes validated edits. The current build uses the verified SHA-256 of Google’s arm64 agy 1.5.14 and checks the version inside the wall. An exact private executable clone prevents a workspace edit from changing what the wall can execute.

Source capture takes current file contents from tracked and unignored untracked Git paths. Git discovery runs with a scrubbed environment, and source listing runs with a synthetic config that defines no hooks, filters or fsmonitor. The helper omits protected paths, Git repositories, dependency trees and safe internal links, and rejects unsafe links and shared inodes. It revalidates changed paths and their ancestors before publication, preserves concurrent edits to untouched paths and installs each changed file atomically. It prepares replacement and rollback copies on the worktree filesystem. A stopped publication rolls back earlier replacements when their targets still match. A second process that races the last check or changes an installed path during rollback can interrupt this procedure. File guards are optimistic and a multi-file publication is not a single filesystem transaction.

The broker authenticates CONNECT and verifies Google authority, exact method and route, upstream TLS and redirect refusal. The launch uses private source, runtime, home and trust material. It exposes the existing login keychain via an immutable private-home alias and restricts the actual keychain files to the DB, lock and atomic save paths. Launcher-controlled settings are immutable, with a narrow exception for the private generated project record and its temporary write. File tools get a source-scoped grant, with runtime, keychain and trust material denied. Command, MCP and URL actions are denied. agy's first-party Google-side web-search feature has no permission selector and remains available. The broker denies direct non-Google traffic.

The final zero-turn `models` probe returned 27 models, authenticated through the keychain and passed real and private plaintext-token postflight. Nine metadata launches were used to diagnose private-home bootstrap and the required keychain alias. There was one additional failed version preflight before any metadata request. There were zero inference calls. The successful run still logged that updating isolated CLI settings was denied and startup proceeded with defaults. A real expired-token refresh, live inference requests, live listener scope and observed tool-permission behavior remain to be verified. The broker permits only selected Google bootstrap, quota/experiments, OAuth and inference RPCs.

| Command | Result |
| --- | --- |
| `taskpolicy -b node tests/agy-builder-source.mjs` | 7 passed |
| `taskpolicy -b node tests/agy-builder.mjs` | 3 passed |
| `taskpolicy -b node tests/agy-builder-wall.mjs` | 2 passed |
| `taskpolicy -b node builds/neon-builder/probe/builder-metadata.mjs` | 0 inference turns, successful keychain authentication and clean postflight |
| `node --check tools/agy-builder.mjs` and `node --check tools/agy-builder-source.mjs` | Passed |

## Wiring

Call `runAgyBuilder({ root, bin, id, effort, prompt, checkWorkspace, checkConfig, checkToken, checkSignIn, readResult })` after public arguments and vendor are validated. Use the existing `agyWorkspaceFiles`, `agyConfigProblem`, `agyTokenLeft` and `agyAfterCall` functions for the four checks. Use `(id, reply) => readAnswer('agy', id, reply, null, { family })` for the result callback. The helper owns the private log lifetime, child process and output publication. Do not pass a run or prepare override from the CLI.

Successful returns include the answer, `mode: 'build'`, `served: { requested: id, id, verified: false }`, `build: { published: true }` and a sorted top-level `changed` list. A refusal throws and must produce the CLI failure envelope without a publication success flag.

Install the two helper modules beside the installed `ask-model.mjs`. Keep the existing read-only flags, settings and profile byte-identical.
