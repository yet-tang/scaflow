# SFL-005 State Store Foundation Plan

## Implementation Notes

- Keep SQLite access inside `@scaflow/state`; callers must use repository-style APIs.
- Migrations must run in deterministic order and record applied versions.
- Tests must use temporary database paths and clean up after themselves.
- Do not create `.scaflow/state.db` in the repository during tests.

## Acceptance Focus

- Idempotent initialization.
- Transaction rollback on failure.
- No TaskRun recovery behavior yet; this task only creates the persistence foundation.
