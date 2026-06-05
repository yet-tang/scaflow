# SFL-027 Commit Generation Plan

## Implementation Notes

- Create local commits only after all required verification passes.
- Commit each changed read-write repository independently.
- Include Task ID, TaskRun ID, Requirement IDs, and Acceptance Criterion IDs in commit messages.
- Do not push, create PRs, merge, or release.

## Acceptance Focus

- Read-only repositories are never committed.
- No commit is created when verification fails.
- Result commit IDs are recorded for ChangeSet generation.
