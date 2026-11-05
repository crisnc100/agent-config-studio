## PR descriptions

- When opening or updating a PR, run the pr skill (`/pr`): it writes the description from the user's style file (`~/.agent-config-studio/pr/style.json`) and checks it before `gh pr create` or `gh pr edit`.
- Never paste the raw review record into a PR body unless the style turns it on; then it goes folded in `<details>`.
- A section titled exactly "Deferred findings" stays required whenever a review exists.
