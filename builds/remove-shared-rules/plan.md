# Remove the Shared rules feature (one PR)
Outcome: the Shared rules page, its five /api/blocks routes, lib/blocks*.js, public/blocks-view.js, the blocks/ references, the skill wizard's blocks step, their tests and docs are gone; the wizard creates skills as it did before the blocks step; every other suite passes; CHANGELOG notes the removal and that leftover block markers are harmless comments.
Out of scope: any replacement feature; other refactors. One PR: the parts only make sense removed together.
