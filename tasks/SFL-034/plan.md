# SFL-034 Task Execution Orchestrator Plan

## Implementation Notes

- `task run` composes existing modules instead of reimplementing them.
- Flow: read Task Contract, create TaskRun, prepare workspace, assemble context, start runtime, persist session/events, verify, repair if recoverable, commit, generate ChangeSet, update TaskRun.
- `task status` reads state without side effects.
- `task cancel` cancels runtime work, records events, and transitions state safely.
- Orchestrator must use Mock Runtime in regular tests.

## Acceptance Focus

- The execution path is deterministic under Mock Runtime.
- Security and Scope failures are not bypassed by repair logic.
- TaskRun success remains separate from Task completion.
