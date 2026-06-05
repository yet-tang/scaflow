# Scaflow Audit Basis

This document is the stable audit memory for Scaflow. Auditors must treat it as a project-level source of truth together with the PRD, the v0.2 architecture baseline, the relevant Task Contract, and the actual Git diff.

## Product baseline

- Design baseline: v0.2.
- First implementation version: v0.1.0 Execution Kernel.
- v0.1.0 does not include the PRD Compiler, GitHub PR automation, release pipeline, central scheduler, distributed workers, or production deployment.
- Do not approve implementation that silently expands into later-version scope.

## Repository model

- The Scaflow Project Repository (SPR) is the project control and knowledge repository.
- Application source code remains in independent Git repositories.
- `@control` is the reserved repository ID for the SPR.
- Application repository IDs must not start with `@`.

## Workspace invariants

- `workspace/repos/` is developer-owned, long-lived, and used for daily development and base checkouts.
- Scaflow must not automatically reset, delete, or switch branches in `workspace/repos/`.
- Formal Codex tasks must never write to `workspace/repos/`.
- `workspace/runs/<task-id>/<task-run-id>/` is Scaflow-owned and TaskRun-scoped.
- A TaskRun Bundle contains isolated worktrees, a frozen Revision Set, the Task Contract, generated task-level instructions, and task context.
- `.scaflow/` stores local engine state, logs, evidence, artifacts, caches, locks, and temporary data. It must not contain application source checkouts.

## State invariants

- Task and TaskRun are different entities.
- Task Definition State is a shared Git fact.
- TaskRun Execution State is local runtime state.
- TaskRun `succeeded` does not mean Task `completed`.
- A Task is completed only after the required ChangeSet reaches the project-defined merged state.
- A ChangeSet is a logical cross-repository change unit, not an atomic cross-repository transaction.

## Execution invariants

- Every TaskRun freezes an immutable Revision Set before execution.
- A TaskRun must not silently follow remote branch updates after its Revision Set is frozen.
- Read-only repositories must be checked out at fixed commits and must not produce diffs.
- Agent claims are untrusted. Actual Git diffs and actual command results are authoritative.
- Commands use structured `executable` and `args` definitions.
- Arbitrary shell mode is exceptional, risk-elevated, and policy controlled.
- `definition_state: ready` means the contract is approved. A task is runnable only when all dependencies are complete.

## Security invariants

- Runtime sandboxing must be enforced mechanically, not only through prompt instructions.
- Agent command network access is disabled by default.
- Host secrets, SSH keys, cloud credentials, user home, Docker socket, `.scaflow/state.db`, Scaflow Engine source, and other TaskRuns must not be exposed.
- Security-policy failures must fail closed.
- Security violations are non-repairable unless the governing policy explicitly says otherwise.
- Ordinary business tasks must not modify protected control-plane files.

## Verification invariants

- Every task uses the declared task gate: package-focused tests, `pnpm typecheck`, then `pnpm test`.
- Live Codex tests are explicit and must not be part of deterministic regular tests.
- Tests must not be removed, skipped, weakened, or bypassed to make a task pass.
- Dependency changes must match the Task Contract's `dependency_changes` value and allowed paths.
- A task may modify only declared repositories and paths.

## Audit principle

Review against:

1. the PRD;
2. the v0.2 architecture baseline;
3. this audit basis;
4. the relevant Task Contract and plan;
5. the actual Git diff;
6. actual verification evidence.

Never approve based only on an implementer's summary. Missing evidence is not passing evidence.
