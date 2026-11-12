# Changelog

## Unreleased

### Removed

- The **Shared rules** page (Workflows), its Compare copies view and
  `GET /api/blocks`, added in 1.2.0, along with the Make this copy match and
  Add to files writers built on it after 1.2.0. The studio no longer ships
  reference rule texts in `blocks/`, and nothing in it rewrites a rule in your
  files.
- The skill wizard's **Blocks** step, also from 1.2.0. The wizard goes
  Describe → Interview → Where → Review again, and Review drafts the skill as
  before.

Lines such as `<!-- block:<id> sha256:… -->` and `<!-- /block:<id> -->` that
1.2.0's wizard put in your skills, or the later writers put in your
instruction files, are plain HTML comments: the studio no longer reads or
writes them. Delete them by hand if you like.
