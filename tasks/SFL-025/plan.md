# SFL-025 Test Integrity and Agent Result Verifiers Plan

## Implementation Notes

- Test integrity checks cover deleted tests, added skip/only, modified verification commands, modified quality gates, protected test directories, and lowered coverage thresholds.
- Agent Result schema is imported from `@scaflow/schemas`.
- `@scaflow/verification` must not depend on the full runtime package only to read Agent Result types.
- Git diff and command results remain authoritative.

## Acceptance Focus

- Invalid Agent Result fails schema validation.
- Agent claims cannot hide a failing command or unauthorized diff.
- Integrity fixtures cover each MVP rule.
