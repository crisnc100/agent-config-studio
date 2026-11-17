# Agent layout in cmux (plan, approved by Cris 2026-11-17)

Goal: protect the main agent's screen. Everything stays in the caller's cmux workspace.

## Outcome
1. Builders (`acs-agent open`): each worker opens as a new TAB in the caller's own pane (the main agent's pane), full size, without taking focus (`new-surface --pane <caller pane> --focus false`), never a new pane or workspace. Tab title: `builder · <family> · <branch or folder>`.
2. Reviewers (watch = pane): one narrow pane on the right per run, opened at the first model call without focus; one TAB per reviewer call inside it, each showing only that reviewer's live steps; tab title `<kind> · <family> · <branch>` (e.g. `review · fable · watch-tail`, `security · astra · watch-tail`). The pane closes 30s after the run ends (unchanged).
3. Sidebar lines also carry the branch: `review · fable · watch-tail · 4m · read lib/agent.js`.
4. Watch = off still shows nothing; sidebar still opens no pane.
5. Everything opens only in the workspace the caller/gate runs in (tested).

## Out of scope
An ACS panel showing review agents (parked); tmux/other terminals; changing models, prompts or review output.

## Checks
Fake-cmux tests: builder opens via new-surface in the caller's pane with --focus false and the titled tab; no new-pane, no other workspace. Pane mode: one new-pane per run, one new-surface per reviewer call in that pane, rename-tab titles, per-reviewer content, all closed at the end. Existing builder-placement assertions may change (own test-only commit, cross-vendor checked). Live check in Cris's cmux by the orchestrator: a builder tab next to main, a review with two reviewer tabs on the right.

One PR. Builder: opus, native subagent.
