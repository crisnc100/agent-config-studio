# Generated lockfiles exempt from coverage by default

A push was refused because package-lock.json's diff alone was over the 120k cap; the only way through was Cris
writing coverageExempt by hand. A lockfile change is routine and must not need him.

## Design
- `DEFAULT_EXEMPT`, a fixed list of generated dependency lockfiles, matched by exact basename in any folder, never a
  glob: package-lock.json, npm-shrinkwrap.json, yarn.lock, pnpm-lock.yaml, bun.lockb, bun.lock, Cargo.lock,
  poetry.lock, uv.lock, Pipfile.lock, composer.lock, Gemfile.lock, go.sum, mix.lock, pubspec.lock, Podfile.lock,
  flake.lock. Case-sensitive, as the names are.
- They are skipped by the coverage check like any coverageExempt file, and named the same way: "exempt (not
  reviewed)" in a refusal, "Coverage exempt (not reviewed): …" in the summary, so the PR shows them.
- User `coverageExempt` adds to the defaults, as today. `"coverageExemptDefaults": false` turns the defaults off (a
  separate boolean key rather than `coverageExempt: false`, so the list keeps one type). Anything but true or false
  fails loudly, like a malformed coverageExempt.
- `coverageExemptDefaults` joins the own-file keys, so a tracked repo config can neither add to the list nor turn the
  defaults off.

## Skills (both twins)
Lockfiles are exempt by default and named in the PR; agents still don't add to the list; a refusal for any other
over-cap file goes in the PR as a blocker for the operator, never as a shell command for them to paste.

## Tests (review.coverage.test.mjs)
An over-cap package-lock.json pushes with the exempt line; yarn.lock in a subfolder too; lookalikes
(package-lock.json.bak, my-yarn.lock) are not exempt; `coverageExemptDefaults: false` in the home config turns them
off; a tracked repo config can't; a non-boolean value fails loudly. No existing assertion expects an empty default.
