# SFL-028 ChangeSet Plan

## Implementation Notes

- Generate ChangeSet Manifest schema in `@scaflow/schemas`.
- Persist runtime state in SQLite and manifest evidence under `.scaflow/evidence/changesets/<id>.yaml`.
- Sync to `changesets/<id>.yaml` only when `@control` is read-write.
- Mark `pending_control_update` when the control repository cannot be updated.
- Do not implement push, PR, merge, or release behavior.

## Acceptance Focus

- ChangeSet records base and result commits for every changed repository.
- ChangeSet output clearly states it is not a cross-repository atomic transaction.
- `changeset show/list` read both runtime state and manifest evidence safely.
