---
name: Builders commit, never push
summary: Builders commit at every phase end; the orchestrator runs the checks, pushes and opens the PR.
---
Builders commit at every phase end, including the build folder before each review; they never push, open a PR, or run reviews, grades or other models themselves. The orchestrator runs those checks, pushes and opens the PR.
