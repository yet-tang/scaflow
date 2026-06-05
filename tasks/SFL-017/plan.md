# SFL-017 TaskRun Workspace Plan

## Implementation Notes

- Create TaskRun bundles under `workspace/runs/<task-id>/<task-run-id>/`.
- The bundle root must not be a Git repository.
- Use detached HEAD worktrees for read-only scopes.
- Use task branch worktrees for read-write scopes.
- Never write formal TaskRun results into `workspace/repos/`.
- Create bundle directories in a stable order: root, runtime, metadata files, repository worktrees, then final state transition.
- Use a deterministic task branch naming convention that includes Task ID and TaskRun ID.
- Use a TaskRun-scoped lock to avoid duplicate worktree creation.

## Acceptance Focus

- Worktree creation is idempotent for an existing TaskRun.
- Repository identity is checked before worktree use.
- TaskRun state transitions are recorded through the state package.
- Partial creation failure leaves enough state and evidence for retry or cleanup.
- Fault injection covers existing worktree, branch conflict, repository identity mismatch, and interrupted bundle creation.
