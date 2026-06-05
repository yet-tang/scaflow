# SFL-029 State Recovery Plan

## Implementation Notes

- On startup, scan non-terminal TaskRuns in SQLite.
- Use runtime session metadata from SFL-019 to decide whether a run can continue.
- If process/session/workspace is missing or unsafe, mark the run `orphaned`.
- Preserve logs, evidence, and ChangeSet records.

## Acceptance Focus

- Recovery is idempotent.
- Orphaning is safe and auditable.
- `run inspect` shows TaskRun, session, verification, ChangeSet, and evidence state.
