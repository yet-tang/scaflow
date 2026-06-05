# SFL-018 Context Assembler Plan

## Implementation Notes

- Generate TaskRun `AGENTS.md`, `context-manifest.json`, and required knowledge snapshots.
- `@control` undeclared: include only necessary read-only knowledge snapshots.
- `@control` read-only: include read-only control knowledge.
- `@control` read-write: create or reference the isolated control worktree.
- Exclude secrets, unrelated source, other TaskRuns, `.scaflow/state.db`, and user home content.

## Acceptance Focus

- Context manifest is deterministic.
- Context includes verification commands and failure summary when present.
- Security exclusions are tested.
