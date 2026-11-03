---
name: flag
description: "File a field report when the agent workflow itself goes wrong: a skill or rule that says the wrong thing, two rules that contradict, a gate or skill asking the user to do something by hand, a tool refusing on purpose, an instruction misread, a model choice that went badly. Points at the real tool calls in the session transcript (by reference, never copied) and stores the report, redacted, in ~/.agent-config-studio/field-reports/. Use when the user says 'flag this' or '/flag', and on your own when you notice such a problem (file it, say so in one line, keep working). '/flag review' reads the reports back, groups them by cause and proposes rule or skill changes with the report ids as evidence."
---

# /flag — field reports on the workflow

A report is evidence for whoever later fixes the skills and the AGENTS.md / CLAUDE.md rules. It records what
happened, what should have, the rule you were following (quoted), the tool calls that show it (references to the
transcript lines, not paraphrases), and your own read of what went wrong.

This is about the **workflow**: the skills, rules, gates, hooks and model choices that shape how agents work. A bug
in the user's product is not a flag; it goes wherever the project tracks bugs.

```bash
FLAG="${CODEX_HOME:-$HOME/.codex}/skills/flag/flag.mjs"
```

## When

- The user says "flag this", "/flag", or "flag that".
- **On your own**, whenever you notice: a rule that contradicts another; a gate, hook or skill that asks the user to
  do something by hand (paste a command, run an override, click through); a tool or hook that refuses on purpose and
  blocks the work; an instruction you or another agent misread (and acted on); a reviewer, builder or advisor result
  that was clearly off (a finding's severity overstated, a model that could not do the job).
  File it, tell the user in **one line** (`Flagged: <id> — <what>`), and carry on. Never stop the work to flag, and
  never ask permission first.

Flag once per issue. If the same problem bites again in this session, say so in the first report's terms; don't
file a duplicate.

## Write a report

1. **Find the evidence in the transcript.** Your own session transcript is found with `--transcript auto`:
   `CODEX_THREAD_ID` names it when set, else it is the newest rollout under `$CODEX_HOME/sessions/` started in this
   folder. `find` prints the file it chose on its first line; if another session in the same folder could be the
   newer one, check that the rows are yours, or pass `--transcript <rollout file>`. Look up the lines that show the
   problem by a distinctive string from the command or its output:

   ```bash
   node "$FLAG" find --harness codex --transcript auto --text "pnpm install"
   ```

   Each row is `line  tool-ids  tool-name  preview`. Pick the tool ids (a tool id brings the call and its result) or
   the line ranges that show what happened. Keep it to the few entries that prove the point.

2. **Write it.** The report goes in as JSON on stdin, in a quoted heredoc, so nothing in it is expanded by the shell
   or shows up in a process list:

   ```bash
   node "$FLAG" write <<'REPORT'
   {
     "harness": "codex",
     "severity": "medium",
     "what": "The review gate refused the push and its message told the user to paste a shell command to unblock it.",
     "expected": "The gate names the fix for the agent to make; the user is never asked to run a command.",
     "rulesInForce": ["AGENTS.md: \"Never ask the operator to run --waive or the push override.\""],
     "toolCalls": ["$ git push\nPush blocked: … run: rm .review-lock"],
     "agentTake": "The gate's refusal text addresses the user, not the agent, so the agent relayed it.",
     "transcript": "auto",
     "excerpts": { "toolIds": ["call_…"], "lines": ["812-815"] }
   }
   REPORT
   ```

   - `what` and `severity` (`low` | `medium` | `high`, your guess at the cost if it keeps happening) are required.
   - `rulesInForce`: the exact words of the skill or rule, with where they come from. Quote; never paraphrase.
   - `toolCalls`: anything you quote yourself.
   - `excerpts` stores **references**, never transcript text: the transcript's path, the line numbers (a tool id
     brings the lines of its call and its result), the tool ids, and each line's sha256. `show` reads those lines
     from the transcript when it runs, redacted, and marks any line that changed since.
   - The harness can clean transcripts up, so a reference may stop resolving. Write `what` and `toolCalls` so the
     report makes sense without the transcript: quote the key command and its output yourself.
   - `model`: leave it out; it is read from the transcript. Give it only when there is no transcript.
   - Without a transcript (none found), leave out `transcript` and `excerpts` and quote the calls in `toolCalls`.

   **Sandbox:** `~/.agent-config-studio/field-reports/` is outside the workspace, so in a workspace-write sandbox the
   write fails with exit 3 ("the sandbox refused writing …"). Rerun the same command once with escalated permissions
   (`sandbox_permissions: "require_escalated"`, justification: "write a /flag field report"). If that is refused
   too, the helper has already printed the redacted report on stdout: say in one line that it could not be filed,
   and carry on.

3. **Say it in one line**: `Flagged: <id> — <what, short>`. The report is the output; don't restate it.

Every string you write is redacted before it is stored (API keys and tokens, JWTs, private keys, `Bearer` values, URL
passwords, values of names holding KEY, TOKEN, SECRET or PASSWORD), so quote freely. Still: never read or quote a
credential file (`.credentials.json`, `auth.json`, the keychain), and the helper refuses one as a transcript.

The helper exits 1 with the reason when the input is wrong (an unknown field, a tool id that is not in the
transcript): fix the input and run it again.

## /flag review

When the user asks to review the reports (`/flag review`, "what's been flagged"):

```bash
node "$FLAG" list --since 30d                 # one line each, newest first
node "$FLAG" list --since 30d --project <name> --json   # the full reports, to read
node "$FLAG" show <id>                        # the report, and its excerpts read from the transcript now
node "$FLAG" show <id> --refs-only            # the report alone, references unresolved
```

`--since` takes a date (`2026-11-01`), or `7d` / `24h`; `--project` a repo name or path. `list --json` gives the
stored reports, so excerpts there are references; `show` resolves them (redacted, nothing written), marks a line
whose sha256 no longer matches, and says when the transcript is gone. Older reports may carry copied transcript
entries in `toolCalls`; read them as they are. Then:

1. Read the reports in full, and group them by **cause**, not by symptom: the same rule misread three ways is one
   group.
2. For each group, propose one concrete change: the file (a skill's SKILL.md, an AGENTS.md or CLAUDE.md section, a
   hook), the current text quoted, and the replacement text. Cite the report ids that support it.
3. Say which reports do not support a change (a one-off, or the rule was right and the agent was wrong), and why.

**Never edit a rule or a skill from a review.** Present the proposals; the user decides what changes.
