# SFL-016 Revision Set Plan

## Implementation Notes

- Freeze the current `@control` commit and every scoped application repository commit before TaskRun worktree creation.
- Record repository ID, base commit, access mode, default branch, checkout directory, and repository identity evidence.
- Do not follow remote branch movement after the Revision Set is created.
- Fail if repository identity does not match the manifest.

## Acceptance Focus

- Revision Set output is deterministic and schema-validated.
- Read-only and read-write access modes are preserved for later worktree and Scope Verifier use.
- Tests cover remote branch movement after freeze.
