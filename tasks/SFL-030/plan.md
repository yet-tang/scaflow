# SFL-030 Workspace Cleanup Plan

## Implementation Notes

- Never clean running TaskRuns.
- Never delete `workspace/repos/`.
- Never delete `.scaflow/state.db`.
- If a TaskRun has uncommitted diffs, save diff evidence and require explicit safe handling.
- Preserve logs and evidence before deleting TaskRun workspace data.

## Acceptance Focus

- `run clean`, `run clean --completed`, and `run clean --older-than` obey safety rules.
- Cleanup is auditable.
- State remains queryable after cleanup.
