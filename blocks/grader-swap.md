---
name: Cross-vendor checks follow crossFamily
summary: Reviewers and graders prefer the other vendor per the review gate's crossFamily setting, never wait for one, and say which ran.
---
**Cross-vendor checks follow the review gate's crossFamily setting (default prefer: another vendor when available, never a blocker; the run names who checked and why).** With `prefer`, the reviewer or grader should not share the builder's vendor; prefer one from the other vendor when it is available. Never wait on a grader: if the preferred one is out of quota or unavailable, use the other right away. With `off`, any reviewer or grader may check. Either way, say which one ran and, when it was same-vendor, why.
