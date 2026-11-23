## In Cursor

You are running in Cursor, and the agreement above is written in Claude Code's terms. Read them this way:
- "The Agent tool" and native subagents mean Cursor's Task tool, with its model slug. Cursor may not offer every model or effort the agreement asks for; when the slug or effort a role needs is missing, ask the operator rather than picking a nearby one.
- Cursor's slugs are not the ids `model-id` prints. A builder whose id Cursor does not offer runs through its own CLI in a background shell (`codex exec` for a gpt- id). Codex can't write git metadata, so the orchestrator commits that builder's work.
- Anthropic judgment calls (review, advice, investigation, Grade, Bounce) still run headless through `claude -p`, `ask-model` or the review scripts, never through the Task tool.
- "Run in the background" means a shell started with no blocking timeout, checked with AwaitShell; never `( … ) &`.
- Both the Claude and the Codex copies of a skill may be offered. Use the Claude copy unless the skill's writer or builder is a gpt- family.
