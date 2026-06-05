# SFL-019 Agent Runtime Contract and Mock Plan

## Implementation Notes

- Define runtime interfaces in `@scaflow/codex-runtime`.
- Define Agent Result schema in `@scaflow/schemas`.
- Runtime must support working directory, session ID, stream events, final Agent Result, continue, cancel, and timeout.
- Mock Runtime must drive deterministic success, failure, timeout, and repair scenarios.
- Do not implement SDK or `codex exec` adapters in this task.

## Acceptance Focus

- Runtime contract is independent from CLI.
- Mock Runtime requires no network or credentials.
- Verification and Orchestrator tasks can consume the same Agent Result schema.
