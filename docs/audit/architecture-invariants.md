# Scaflow Architecture Invariants

These invariants are mandatory review criteria. An implementation that violates one of them requires an explicit approved architecture decision before it can pass audit.

## A-001 Project-bound control repository

Each project owns one Scaflow Project Repository containing shared project knowledge, rules, task definitions, workflows, and environment definitions. Scaflow v0.1.0 is not a central multi-project control platform.

## A-002 Application repository isolation

Application source remains in independent Git repositories. The SPR coordinates them but does not absorb their source history into a monorepo.

## A-003 Dual-layer workspace

- `workspace/repos/` is the developer base workspace.
- `workspace/runs/` contains Scaflow-owned TaskRun bundles.
- Formal Agent execution never writes to `workspace/repos/`.

## A-004 Runtime-state separation

`.scaflow/` contains runtime data and never application source worktrees.

## A-005 Immutable Revision Set

A TaskRun records fixed commits for `@control` and each participating application repository before execution. Those revisions do not drift during the run.

## A-006 Explicit repository access

Every repository participating in a task has an explicit access mode:

- `read-only`: fixed revision and zero diff allowed;
- `read-write`: task branch and path-scoped writes.

Undeclared repositories are inaccessible.

## A-007 Conditional control worktree

- `@control` absent or read-only: provide a knowledge snapshot, not a writable SPR worktree.
- `@control` read-write: create an isolated SPR worktree.

## A-008 Task, TaskRun, and ChangeSet separation

- Task defines shared project intent.
- TaskRun records one execution attempt.
- ChangeSet groups cross-repository results.

No implementation may collapse these into one state object.

## A-009 Non-atomic ChangeSet

ChangeSet provides logical coordination, validation evidence, merge order, and partial-merge state. It does not provide atomic multi-repository commits or merges.

## A-010 Structured command execution

Commands are represented by repository, executable, args, timeout, and environment policy. Shell strings are not the default execution model.

## A-011 Evidence over self-report

Agent-reported changed files, commands, and acceptance mappings are declarations. Git diff, process results, and verifier output are authoritative.

## A-012 Layered safety policy

Priority order:

1. Scaflow Engine safety invariants;
2. project security and command policies;
3. approved architecture decisions and contracts;
4. Task Contract;
5. project and repository `AGENTS.md`;
6. ordinary documentation and code comments.

A lower layer cannot weaken a higher one.

## A-013 Fail-closed sandbox

A runtime adapter must report its security capabilities. If it cannot satisfy requested filesystem, environment, or network restrictions, execution fails rather than silently degrading.

## A-014 Deterministic regular tests

Regular `pnpm test` must not require network access, live Codex service access, or developer credentials. Live tests are explicit and separately invoked.

## A-015 No premature scope expansion

Scaflow v0.1.0 implements the Execution Kernel only. PRD compilation, distributed scheduling, PR automation, release orchestration, and production deployment remain out of scope.
