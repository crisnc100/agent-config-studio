# Changelog

## Unreleased

### Removed

- The **Shared rules** page (Workflows), its Compare copies and Add to files
  views, and the `/api/blocks` routes, all added in 1.2.0. The studio no longer
  ships reference rule texts in `blocks/`, and nothing in it rewrites a rule in
  your files.
- The skill wizard's **Blocks** step, also from 1.2.0. The wizard goes
  Describe → Interview → Where → Review again, and Review drafts the skill as
  before.

Lines such as `<!-- block:<id> sha256:… -->` and `<!-- /block:<id> -->` left
in your instruction files or skills by 1.2.0 are plain HTML comments: no agent
acts on them, and the studio no longer reads them. Delete them by hand if you
like.
