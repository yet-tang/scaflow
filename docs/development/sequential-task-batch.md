# Sequential Task Batch

`scaflow-batch` executes a selected range of Task Contracts one by one. It is intentionally sequential, not concurrent.

Example:

```bash
pnpm scaflow-batch 2-6
```

This means:

```text
SFL-002
-> develop
-> test
-> audit
-> repair until approved
-> commit implementation
-> fast-forward into dev
-> mark SFL-002 completed on dev
-> push dev

then SFL-003 starts from the new dev head
...
then SFL-006
```

## Supported selectors

```bash
pnpm scaflow-batch 2-6
pnpm scaflow-batch SFL-002..SFL-006
pnpm scaflow-batch SFL-002,SFL-004,SFL-006
```

Ranges must be ascending.

## Default behavior

```bash
pnpm scaflow-batch 2-6 \
  --remote origin \
  --target dev \
  --source main
```

The command:

1. fetches the remote;
2. ensures `origin/dev` exists, creating it from `main` when absent;
3. creates an isolated batch integration worktree under `workspace/runs/batches/`;
4. loads all Task Contracts;
5. verifies dependencies;
6. topologically orders the selected pending tasks;
7. executes each task through `scaflow-run`;
8. requires `approved` or `approved_with_follow_ups`;
9. commits the exact approved implementation on a temporary task branch;
10. fast-forwards the batch integration branch;
11. updates the Task Contract to `definition_state: completed` in a separate commit;
12. pushes the new integration head directly to `origin/dev`;
13. starts the next task from that new `dev` state.

## Dependency rules

A task in the selected range may depend on:

- another selected task, which will run first; or
- a task outside the selected range whose Task Contract is already `completed` on `dev`.

If an outside dependency is not completed, the batch stops before development begins.

For example, running:

```bash
pnpm scaflow-batch 2-6
```

requires `SFL-001` to already be completed on `dev`.

## Isolation

Each task receives its own branch and worktree:

```text
workspace/runs/batches/<batch-id>/
├── dev/
├── SFL-002/control/
├── SFL-003/control/
└── ...
```

Formal task execution never writes to `workspace/repos/`.

The task worktree is based on the current batch integration branch. Because tasks run sequentially, the next task automatically contains every previously approved and integrated task.

## Failure behavior

The batch stops at the first task that does not reach approval.

It does not continue to later tasks after:

- failed development;
- failed tests;
- audit retry exhaustion;
- `BLOCKED` verdict;
- approval fingerprint mismatch;
- commit failure;
- non-fast-forward integration;
- remote `dev` push rejection;
- incomplete dependency.

The failed task worktree is preserved for inspection and repair.

## Remote update safety

The command uses a normal Git push, never a forced push. If `origin/dev` changed concurrently and the update is no longer a fast-forward, the push fails and the batch stops.

## Evidence

Batch evidence is stored under:

```text
.scaflow/batches/<batch-id>/
├── state.json
├── summary.md
├── SFL-002/
├── SFL-003/
└── ...
```

Each task directory contains its copied development, audit, workflow, and autonomous-run evidence.

## Options

```bash
pnpm scaflow-batch 2-6 \
  --max-development-attempts 3 \
  --max-audit-rounds 4 \
  --max-same-failure 2
```

Preserve successful task worktrees:

```bash
pnpm scaflow-batch 2-6 --keep-worktrees
```

Run without pushing:

```bash
pnpm scaflow-batch 2-6 --no-push
```

With `--no-push`, the local integration worktree and branch are preserved. The command prints the exact push command instead of deleting the local result.

## Completion semantics

For every successful task:

```text
Developer completed
-> ready_for_audit
Auditor approved
-> approved
Implementation committed
-> task implementation commit
Integrated into dev
-> fast-forward
Task Contract completed
-> separate metadata commit
Remote dev updated
-> next task may start
```

The command updates Task Contract completion only after the approved implementation is committed and integrated.

## Current limitation

This is a bootstrap sequential batch runner. It does not yet provide parallel scheduling, automatic conflict rebasing, GitHub pull requests, CI waiting, or cross-repository ChangeSet merging. Those belong to the formal Project Orchestrator and ChangeSet workflow.
