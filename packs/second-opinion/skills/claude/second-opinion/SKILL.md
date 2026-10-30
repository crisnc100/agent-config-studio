---
name: second-opinion
description: "Get one or more specific models' take on a situation, answer, or recommendation outside the advisor, code-review and investigation lanes. Use when the user says 'what does <model> think', 'get a second opinion', 'run this by <family>', 'ask all of them', or pastes an AI response and wants another model's view of it."
---

# Second opinion

Ask another model what it thinks and pass the answer back to the calling agent. Opinion only. This never replaces /advisor, /code-review or an investigation; if the request is a scope/direction call, a diff review, or a root-cause hunt, use that instead.

## Models

The families come from ACS (Models → Roles), never from this file:

- the `advisor` role's family and its second opinion (`model-id --role advisor --json`: `family`, `alt`);
- the `reviewer` role's families (`model-id --role reviewer --json`: `use`).

Together, without repeats, those are **the offered families**. A family whose CLI is not installed is skipped and named. Resolve each id with `model-id <family>` and its effort from ACS as below; never hardcode an id or an effort. If `model-id` fails for a family, say so and skip that model; if `model-id` itself is missing, say so and point the user at `acs install-model-id`.

## Choosing the model

| User says | Action |
|---|---|
| Names a family ("what does <family> think") | Use it directly, even if it is not an offered family. Do not ask. |
| Says "all" / "all of them" | Run every offered family (see Running all). |
| Asks for a second opinion, names no model | Ask which one, listing the offered families, or all. Wait for the answer. |

## What to send

Build one prompt from all three:
1. The last AI response or recommendation (the main subject).
2. The relevant conversation leading up to it.
3. The user's specific question, if they asked one.

State the question for the model plainly at the end of the prompt. Do not trim the AI response being judged.

## Constraints on the chosen model

Read-only. The model gives an opinion only: no edits, no tool use. Say so in the prompt; the read-only flags below enforce the no-edits part.

The family's id and effort: a role member's effort comes from its role, any other family's from its flavor.
```bash
family=<family>
id=$(model-id "$family")
# role_effort <role> <family>: that family's effort in the role — its members[] entry, the alt's altEffort,
# or the role's effort — or nothing when the family is not in that role.
role_effort() {
  model-id --role "$1" --json | jq -r --arg f "$2" '
    [(.members // [])[] | select(.family == $f) | .effort][0]
    // (if .alt == $f then .altEffort
        elif .family == $f or ((.provenance.effort == "default" or .provenance.effort == "user") and any(.use[]; . == $f))
        then .effort else null end) // empty'
}
effort=$(role_effort advisor "$family"); [ -n "$effort" ] || effort=$(role_effort reviewer "$family")
# Any other family: its flavor effort. Still empty means none is set: the commands leave the flag out.
[ -n "$effort" ] || effort=$(model-id --flavor "$family" --json | jq -r '.flavor.effort // empty')
```
The CLI follows the id's prefix:
- `claude-…` (read `.result`; check `.is_error` is false and that `modelUsage` names the id):
  ```bash
  flag=(); [ -z "$effort" ] || flag=(--effort "$effort")
  claude -p "$PROMPT" --model "$id" "${flag[@]}" --tools Read,Grep,Glob --output-format json
  ```
- `gpt-…` (always pass `-m`; bare `codex exec` uses the CLI's own default model):
  ```bash
  flag=(); [ -z "$effort" ] || flag=(-c "model_reasoning_effort=$effort")
  codex exec --skip-git-repo-check --sandbox read-only -m "$id" "${flag[@]}" "$PROMPT" </dev/null
  ```
- `grok-…` (the read-only flags the review script uses):
  ```bash
  flag=(); [ -z "$effort" ] || flag=(--reasoning-effort "$effort")
  grok -p "$PROMPT" -m "$id" "${flag[@]}" --tools read_file,list_dir,grep \
    --disallowed-tools search_tool,use_tool --deny MCPTool --disable-web-search --no-subagents
  ```

## Output

Return the answer to the calling orchestrator agent, labeled with the model's family, as-is. Do not rewrite or soften it.

## Running all

Run the offered families in parallel, blind to each other: send each the same prompt, no cross-sharing of answers. Return each answer separately, labeled by family, then a short synthesis of where they agree and where they disagree. Do not pick a winner on points of disagreement.
