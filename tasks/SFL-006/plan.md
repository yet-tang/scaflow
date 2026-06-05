# SFL-006 Domain State Machines Plan

## Implementation Notes

- Define Task Definition State separately from TaskRun and ChangeSet runtime state.
- Treat `TaskRun.succeeded` as local execution success only.
- Treat `Task.completed` as valid only after the related ChangeSet lifecycle reaches merged.
- Keep transition validation pure and testable without SQLite where possible.

## Acceptance Focus

- Legal transition tables are explicit.
- Illegal transitions produce structured errors.
- State authority rules match the execution plan.
