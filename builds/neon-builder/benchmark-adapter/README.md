# Benchmark runner (context, decision, clarity, builder)

`run.mjs` runs the 43 non-review cases in `../cases` against model families and appends one JSON line per result to `<out>/results.jsonl`. `summarize.mjs` reads that file, prints a table per kind and writes `<out>/results.json` for the artifact. `RUBRIC.md` is what the judge grades by. Node only, no npm dependencies. The review cases run through `review.mjs --eval`, not this.

## Run it

```sh
node run.mjs --dry-run                       # the plan: calls per family, efforts, what is already done
node run.mjs                                 # neon, opus, sol, sol-prev × all four kinds, judge fable
node run.mjs --families opus,sol --kinds builder --repeat 3 --jobs 2 --pace sol=60
node summarize.mjs                           # table + out/results.json
```

| flag | default | |
|---|---|---|
| `--families` | `neon,opus,sol,sol-prev` | families under test, resolved with `model-id` |
| `--kinds` | all four | `context,decision,clarity,builder` |
| `--repeat N` | 1 | runs per case |
| `--judge` | `fable` | grades context and decision answers and rates jargon on all three answer kinds; never a family under test |
| `--case id,…` | all | only these cases |
| `--jobs N` | 1 | families run at once (the Mac mini has 8 GB; builders install dependencies) |
| `--pace fam=s,…` | none | a paced family's calls run one at a time, each `s` seconds after the last ended; the judge can be paced too |
| `--effort fam=e,…` | see Efforts | medium, high or xhigh for that family's answers and builds alike |
| `--timeout min` | 60 | per answer or build call |
| `--cases`, `--out` | `../cases`, `./out` | |
| `--fresh` | off | moves `results.jsonl` aside and starts over |
| `--dry-run` | off | prints the plan, calls nothing |
| `--reference-check` | off | checks builder reference commits through the Neon grade sandbox without model calls; requires a separate explicit `--out` |

Run it outside Claude Code's sandbox: it blocks `taskpolicy`'s priority change, nested CLI sandboxes and model hosts.

## Efforts

Each family's effort comes from the first of these that gives one, and `--dry-run` shows the value and where it came from:

1. `--effort fam=e` (answers and builds alike);
2. the roles in ACS: answers from `model-id --effort <f> --role reviewer` (the judge: `judge,advisor,reviewer`), builds from `--role builder`;
3. the runner's defaults (`RUNNER_EFFORTS` in run.mjs), for families no role lists, set like their peers: sol-prev answers at xhigh and builds at high, as sol does; neon answers and builds at high;
4. otherwise the CLI's own default.

With today's roles: opus answers at xhigh and builds at medium, sol answers at xhigh and builds at high, sol-prev xhigh and high, neon high for both, and the judge fable at high (advisor role).

## What each kind does

Every case gets a new repository in the temp folder holding only the case's commit and its ancestors, fetched from the case's local `repo` if it has that commit, else from the project's GitHub remote (only builder cases name one; every case of a project shares it). A model's shell finds no later commit: those hold the fix, the shipped code or the outcome. The repository is removed when the case ends.

- **context, decision, clarity:** `ask-model --family <f> --effort <e> --investigate` in that repository, with the effort from Efforts above: a sandboxed, read-only shell for claude and codex. agy gets no shell (ask-model refuses `--investigate` for it) and answers with its read-only file tools. Then the judge (`ask-model --min-tools --schema`) grades the answer blind against the case's known answer: verdict, must-mention facts, evidence cited and jargon for context; the pick, verdict, evidence and jargon for decision; jargon only for clarity, whose answers are rated by Cris in the artifact.
- **builder:** checkout at `baseSha`, the case's `setup` commands, then the brief plus `interface` as one prompt. claude runs `claude -p --permission-mode acceptEdits` with no MCP, no settings files and Bash inside Claude Code's sandbox (writes to the work tree and temp folder, no network); codex runs `codex exec --sandbox workspace-write` with its MCP servers off. Effort comes from `model-id --effort <f> --role builder`. After the build: the files changed (a content snapshot, so no git runs in a tree the model wrote to), the grade tests copied in from `refSha`, `testCommand` run, and its pass and fail counts recorded. A setup line that asks for Postgres starts a throwaway cluster on a unix socket when `initdb` and `pg_ctl` are installed. Neon builds only when the installed ask-model advertises `--build` on macOS. Its answering model is unverified. The final grade runs under `sandbox-exec` with a private home, copy-installed dependencies, no inherited credentials, and network limited to the case’s disposable Postgres socket when needed. The database role can create databases. For uv cases, the grade uses the dependencies installed by trusted case setup. The worker disables uv sync, so a new dependency added after setup must already be available to pass. Grok does not build.

Every child runs under `taskpolicy -b` in its own process group, stdin closed. Each call's stdout and stderr are kept in `<out>/logs/<family>/`, and every prompt sent in `<out>/prompts/`.

## Stops and resume

- A result is saved the moment it finishes. A re-run skips a (family, case, repeat) whose last result finished for the same case text, model and effort; errored results run again, and an answer with no judgment, or one judged by another judge or rubric text, is judged again. `--fresh` starts over.
- A quota or usage-limit message (agy, codex or claude wording, as `review.mjs --eval` reads it) stops that family with its reset time; the other families keep going. ask-model refusing to run a family (a missing CLI, a containment check) stops it the same way. If the judge runs out, answers keep going and are judged on a later run.
- Ctrl-C or SIGTERM kills every child, removes the temp folder and keeps every saved result.
- One runner per `--out` folder: a second one refuses while the first is alive.

## Neon builder on the Mac mini

Before spending Neon quota, run the ten reference fixes through the confined grader. This uses each case's `refSha`, the usual setup, the original grade command, and the same restricted database role for the Postgres case. It works without the Neon builder route installed.

```sh
node run.mjs --reference-check --dry-run --out ~/benchmark/runner-out-neon-reference-check
node run.mjs --reference-check --out ~/benchmark/runner-out-neon-reference-check
```

Expect ten grade checks and zero builder or judge calls. The runner writes `reference-check.jsonl` with each case's reference SHA and a null model, and exits with status 3 if any check fails. A rerun executes every selected check again. Use `--case <id>` to retry one and `--fresh` to archive the previous reference results before a full rerun.

Use a fresh results directory. The dry run should show 10 builder cases at high effort before a first run. A stopped case can be retried with the same output path.

```sh
node --test neon-adapter.test.mjs
node run.mjs --dry-run --families neon --kinds builder --effort neon=high --out ~/benchmark/runner-out-neon-builder
node run.mjs --families neon --kinds builder --jobs 1 --effort neon=high --out ~/benchmark/runner-out-neon-builder
```

The fixture suite uses fake model CLIs and exercises the real macOS grade sandbox. It requires Node, Apple Git from the active Xcode or Command Line Tools installation, Bun, uv with a managed Python 3.12, and PostgreSQL 17.

Confined Bun grades can read metadata and data for the exact system ICU file `/usr/share/icu/icudt76l.dat`. Bun preflight creates and uses an `Intl.Collator` before a model call. A host that uses a different ICU data path can fail this preflight. The confined FirstCall grade connects to the disposable database using its canonical socket directory.

The confined `acs-lockfile-exempt` grade stages copies of Node, Apple Git and its repository templates in the disposable case before the build. Its preflight checks that the private Node can resolve and run Git with the same PATH reset the reference test uses. `/usr/bin/xcrun --find git` must resolve the underlying Git executable.

## Mac mini setup

What the mini needs before `node run.mjs` (checked against this Mac on 2026-11-21; versions are the ones the cases were checked with):

1. **This folder and the cases**: copy `skills-work/builds/benchmark/` whole, so `runner/` sits beside `cases/`.
2. **Node 20 or later** (the mini's Node 23 is fine).
3. **git with GitHub access**: `crisnc100/air-flo` is private; agent-config-studio, askwell, docket and firstcall are public. `gh auth login`, then `gh auth setup-git`. Check: `git ls-remote https://github.com/crisnc100/air-flo HEAD` prints a sha with no prompt (the runner sets `GIT_TERMINAL_PROMPT=0`, so a prompt is a failure).
4. **model-id and ask-model**: `model-id --install` from an Agent Config Studio checkout, and the same `~/.agent-config-studio/models.json` and `roles.json` as this Mac, so these print the same:
   - `model-id opus` → claude-opus-5-5, `sol` → gpt-6.2-sol, `sol-prev` → gpt-6.1-sol, `neon` → gemini-4-neon, `fable` → claude-fable-5-2;
   - `model-id --effort opus --role builder` → medium; `model-id --effort sol --role reviewer` → xhigh; `model-id --effort fable --role judge,advisor,reviewer` → high.
5. **claude** (Claude Code 2.1.330 here), signed in with access to Opus 5.5 and Fable 5.2. It runs the opus answers and builds and the fable judge.
6. **codex** (codex-cli 0.169.0 here), signed in, with gpt-6.2-sol and gpt-6.1-sol available. It reads `CODEX_HOME`, else `~/.codex`.
7. **agy** for neon, signed in. Its version must equal `AGY_VERSION` in the installed `~/.agent-config-studio/resolver/bin/ask-model.mjs`, and `~/.gemini/config` may hold no MCP server, plugin or hook other than cmux's, or ask-model refuses every neon call. `--dry-run` says so when the version differs.
8. **bun** (1.3.8) for the two AirFlo builder cases (`bun install --frozen-lockfile`, `bun test`).
9. **uv** (0.9.11) and **Python 3.12** for the AskWell, Docket and FirstCall builder cases (`uv sync`, `uv run pytest`): `uv python install 3.12`.
10. **PostgreSQL 17**, `brew install postgresql@17`, for firstcall-forward-br-bare-cr. The runner starts its own throwaway cluster with `initdb` and `pg_ctl` from `/opt/homebrew/opt/postgresql@17/bin`; the Homebrew service need not run. Without it that case's database test fails for every family.
11. **Network** to github.com (repositories, and uv's Python downloads), registry.npmjs.org (bun), pypi.org and files.pythonhosted.org (uv), and each CLI's model API.
12. **Disk**: room for bun's and uv's caches plus one clone at a time with its installed packages (an AirFlo builder case installs about 1,000 packages into its clone; each clone is removed when its case ends). 10 GB free is an estimate with margin, not a measurement.
13. **No sandbox around the runner**: it must be able to run `taskpolicy -b`, and the CLIs start their own sandboxes inside it.

Then, on the mini: `node run.mjs --dry-run` should show four families, no skipped case and no agy note; the first real run can be one cheap case, e.g. `node run.mjs --families sol --kinds context --case askwell-top-n-limit-plus-one --out /tmp/bench-preflight`.
