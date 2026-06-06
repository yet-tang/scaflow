# Autonomous Single-Task Runner

`scaflow-run` drives one approved Task Contract through development, verification, independent audit, repair, and re-audit without manual handoff between Codex sessions.

It is a bootstrap runner for the current repository workflow. It is not the final Scaflow Task Execution Orchestrator defined by SFL-034.

## Default target

The runner stops successfully when the workflow reaches either:

```text
approved
approved_with_follow_ups
```

It does not automatically:

- commit;
- push;
- create or merge a pull request;
- update the shared Task Contract to `definition_state: completed`.

These boundaries preserve the distinction between implementation approval, delivery, merge, and shared Task completion.

## Usage

```bash
pnpm scaflow-run SFL-001 --base origin/main
```

Full form:

```bash
pnpm scaflow-run SFL-001 \
  --base origin/main \
  --until approved \
  --max-development-attempts 3 \
  --max-audit-rounds 4 \
  --max-same-failure 2
```

Preview the next action without changing state or starting Codex:

```bash
pnpm scaflow-run SFL-001 --base origin/main --dry-run
```

## Automatic loop

```text
ready without implementation
  -> Developer
  -> ready_for_audit
  -> Auditor

ready with an existing implementation
  -> import existing implementation
  -> Auditor

changes_required
  -> Developer repair
  -> complete Task Gate
  -> Auditor again

audit_failed
  -> Auditor retry

audit_invalid
  -> Developer repair / Gate refresh
  -> Auditor again

approved / approved_with_follow_ups
  -> success

blocked
  -> stop safely
```

The Developer runs through non-interactive `codex exec` in `workspace-write` mode. The Auditor continues to run through non-interactive `codex exec` in `read-only` mode.

## Safety limits

The runner applies three independent limits:

### Development attempts

```text
--max-development-attempts 3
```

Counts all development attempts already recorded in local workflow state, including attempts performed before the current autonomous run.

### Audit rounds

```text
--max-audit-rounds 4
```

Counts all audit rounds already recorded for the task.

### Repeated failure

```text
--max-same-failure 2
```

Stops when the same recorded failure repeats without material progress. Development-attempt and audit-round limits remain the final protection against non-identical failure loops.

The runner always stops immediately when the Auditor returns `BLOCKED`.

## Concurrency lock

Only one autonomous runner may control a task at a time.

```text
.scaflow/handoffs/<task-id>/run.lock
```

The lock records the process ID. A live lock prevents another runner from starting. A stale lock whose process no longer exists is recovered automatically.

## Run evidence

The runner writes:

```text
.scaflow/handoffs/<task-id>/run-state.json
.scaflow/handoffs/<task-id>/run-summary.md
```

The state file records:

- frozen base ref and commit;
- task branch;
- configured limits;
- development-attempt and audit-round counts;
- each executed action and result state;
- final status and stop reason.

Developer and Auditor evidence remains in the normal handoff files:

```text
developer-report.md
audit-round-N.md
audit-round-N.json
state.json
events.jsonl
```

## Exit behavior

Exit code `0`:

- `approved`;
- `approved_with_follow_ups`;
- task was already in a later delivered state.

Non-zero exit:

- `BLOCKED`;
- retry limit reached;
- repeated failure;
- active developer or auditor process already owns the workflow;
- invalid branch, base, contract, or environment;
- unexpected execution failure.

Always inspect `run-summary.md` after a non-zero exit.

## Current-task migration

For an implementation created before `scaflow-run` existed, start it on the same dedicated task branch:

```bash
pnpm scaflow-run SFL-001 --base origin/main
```

When the workflow is still `ready` but changes already exist relative to the frozen base, the runner sends the implementation directly to `scaflow-audit`. The audit command records the legacy import as `LEGACY_DEVELOPMENT_IMPORTED` before starting the read-only review.

## After success

Inspect status:

```bash
pnpm scaflow-status SFL-001
```

Then perform delivery explicitly:

```bash
git add .
git commit -m "build: implement SFL-001 engine monorepo foundation"
pnpm scaflow-status SFL-001 --mark committed

git push -u origin SFL-001-engine-monorepo-foundation
pnpm scaflow-status SFL-001 --mark pushed
```

After merge:

```bash
git fetch origin
pnpm scaflow-status SFL-001 --base origin/main --mark merged
```

Only after merge should a separate controlled change update the shared Task Contract to `definition_state: completed`.

## Bootstrap limitations

- The runner operates in the current dedicated task branch, not yet in a formal `workspace/runs/` TaskRun Bundle.
- It does not automatically recover a workflow left in `developing` or `auditing`; an active-state workflow stops for inspection.
- It does not automatically commit, push, merge, or resolve `BLOCKED` findings.
- The final SFL-034 Orchestrator will replace this bootstrap script while preserving the same state and safety semantics.
