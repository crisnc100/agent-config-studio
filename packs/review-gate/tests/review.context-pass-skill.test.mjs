import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const body = (harness) => readFileSync(new URL(`../skills/${harness}/context-pass/SKILL.md`, import.meta.url), 'utf8')
  .replace(/^---\n[\s\S]*?\n---\n/, '')

test('both context-pass copies ship the same body', () => {
  assert.equal(body('codex'), body('claude'))
})

test('Step 2 resolves the role in order and routes by the tools at hand', () => {
  const step = body('claude').match(/^## Step 2[^\n]*\n([\s\S]*?)(?=^## )/m)?.[1] ?? ''
  assert.match(step, /model-id --role writer --json/)
  assert.match(step, /Pair `use` and `ids` in order/)
  assert.match(step, /Identify the harness by its available tools\. Claude Code has the Agent tool, Cursor has the Task tool, and Codex has neither/)
  assert.match(step, /use the first one the harness can launch/)
  assert.match(step, /^\| Claude Code \| Agent tool with `model` set to the family \| `codex exec --sandbox workspace-write` \| Unavailable \|$/m)
  assert.match(step, /^\| Cursor \| Task tool with a listed slug for the id \| Task tool with a listed slug for the id, or `codex exec` if Cursor lists no slug for that id \| Unavailable \|$/m)
  assert.match(step, /^\| Codex \| `claude -p` with file tools only \| `codex exec --sandbox workspace-write` \| Unavailable \|$/m)
  assert.match(step, /use `<id>-<effort>` if listed\. Otherwise use another listed slug for the same id and name the effort that ran in the report/)
  assert.match(step, /If no family can be launched, stop, name the role's families, and point to ACS → Models → Roles/)
})

test('Step 2 shares the prompt across routes and hands uncommitted edits to the orchestrator', () => {
  const step = body('claude').match(/^## Step 2[^\n]*\n([\s\S]*?)(?=^## )/m)?.[1] ?? ''
  assert.match(step, /Give every route the same prompt\. Include the brief, the writer's rules below word for word/)
  assert.match(step, /Edit only comments and docs\. Make one commit named `Context pass: <one line>`\. Never push\. Write the docs table and report needed changes to untouchable files/)
  assert.match(step, /If the writer lacks a shell or cannot write git metadata, have it leave its edits uncommitted\. The orchestrator commits the writer's edits as `Context pass: <one line>` before Step 3/)
})
