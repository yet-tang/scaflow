# Sequential Task Batch

`scaflow-batch` executes selected Task Contracts one by one. It is sequential, not concurrent.

```bash
pnpm scaflow-batch 2-6
```

## Per-task workflow

Each task runs the same three-Agent flow:

```text
Architect preparation
-> Developer implementation and Task Gate
-> Architect post-development review
-> independent Auditor
-> Architect repair brief when needed
-> Developer repair and re-verification
-> independent re-audit
-> Architect completion summary
-> commit approved implementation
-> fast-forward into dev
-> mark Task Contract completed
-> push dev
```

Only after the current task is integrated does the next task begin.

```text
SFL-002 completes and enters dev
-> SFL-003 starts from the new dev head
-> ...
-> SFL-006
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
2. ensures `origin/dev` exists;
3. creates an isolated batch integration worktree;
4. loads Task Contracts and verifies dependencies;
5. topologically orders selected pending tasks;
6. runs each task through Architect-led `scaflow-run`;
7. requires `approved` or `approved_with_follow_ups` plus Architect completion summary;
8. commits the exact approved implementation;
9. fast-forwards the integration branch;
10. updates the Task Contract to `definition_state: completed` in a separate commit;
11. pushes the new head to `origin/dev` without force;
12. starts the next task from that new integration state.

## Dependency rules

A selected task may depend on:

- another selected task, which runs first; or
- a task outside the selection that is already `completed` on `dev`.

An incomplete outside dependency stops the batch before development begins.

For example, `pnpm scaflow-batch 2-6` requires `SFL-001` to be completed on `dev`.

## Cross-task knowledge

Every successful task produces:

```text
.scaflow/handoffs/<task-id>/architect/completion.md
```

The next task starts from the integrated code and can read prior completion summaries for reusable capabilities, preserved invariants, residual risks, and downstream implications.

## Isolation

```text
workspace/runs/batches/<batch-id>/
├── dev/
├── SFL-002/control/
├── SFL-003/control/
└── ...
```

Task execution never writes to `workspace/repos/`.

## Failure behavior

The batch stops at the first task that does not complete the three-Agent workflow.

Stop conditions include:

- Architect `BLOCKED`;
- Developer or Task Gate failure;
- Architect `REPAIR_REQUIRED` without successful repair;
- Auditor `BLOCKED`;
- retry exhaustion;
- malformed Architect output;
- approval fingerprint mismatch;
- commit or fast-forward failure;
- remote `dev` push rejection;
- incomplete dependency.

The failed task worktree and all evidence are preserved.

## Remote update safety

The command uses a normal push. Concurrent non-fast-forward changes to `origin/dev` cause the batch to stop rather than overwrite remote work.

## Evidence

```text
.scaflow/batches/<batch-id>/
├── state.json
├── summary.md
├── SFL-002/
│   ├── architect/
│   ├── developer-report.md
│   ├── audit-round-N.md
│   ├── run-state.json
│   └── events.jsonl
└── ...
```

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

With `--no-push`, the local integration worktree is retained and the exact push command is printed.

## Completion semantics

```text
Architect preparation ready
-> Developer and Task Gate complete
-> Architect READY_FOR_AUDIT
-> Auditor approved
-> Architect COMPLETE summary
-> implementation committed
-> fast-forwarded into dev
-> Task Contract completed in a separate metadata commit
-> remote dev updated
-> next task starts
```

This remains a bootstrap sequential runner. Parallel scheduling, automatic rebasing, GitHub PR orchestration, CI waiting, and cross-repository ChangeSets belong to the formal Project Orchestrator.
