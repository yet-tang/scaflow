# SFL-017 TaskRun Workspace Plan

## Implementation Notes

- Create TaskRun bundles under `workspace/runs/<task-id>/<task-run-id>/`.
- The bundle root must not be a Git repository.
- Use detached HEAD worktrees for read-only scopes.
- Use task branch worktrees for read-write scopes.
- Never write formal TaskRun results into `workspace/repos/`.

## Acceptance Focus

- Worktree creation is idempotent for an existing TaskRun.
- Repository identity is checked before worktree use.
- TaskRun state transitions are recorded through the state package.
