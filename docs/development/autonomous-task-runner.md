# Autonomous Single-Task Runner

`scaflow-run` drives one approved Task Contract through an Architect-led, Controller-enforced workflow without manual handoff between Codex sessions.

It is a bootstrap runner for the current repository workflow. It is not the final Scaflow Task Execution Orchestrator defined by SFL-034.

## Agent team

The deterministic Controller invokes:

```text
Architect preparation
-> Developer implementation and Task Gate
-> Architect post-development review
-> independent Auditor
-> Architect repair brief when needed
-> Developer repair and full Task Gate
-> independent re-audit
-> Architect completion summary
```

The Controller owns state, retries, implementation fingerprints, locks, and stop conditions. Agents do not invoke Controller commands or perform Git delivery actions.

## Default target

The runner stops successfully when the workflow reaches:

```text
approved
approved_with_follow_ups
```

and the Architect completion summary has been generated.

It does not automatically:

- commit;
- push;
- create or merge a pull request;
- update the shared Task Contract to `definition_state: completed`.

## Usage

```bash
pnpm scaflow-run SFL-001 --base origin/dev
```

Full form:

```bash
pnpm scaflow-run SFL-001 \
  --base origin/dev \
  --until approved \
  --max-development-attempts 3 \
  --max-audit-rounds 4 \
  --max-same-failure 2
```

Preview the current state without starting an Agent:

```bash
pnpm scaflow-run SFL-001 --base origin/dev --dry-run
```

## Automatic loop

```text
ready
  -> Architect preparation
  -> READY_FOR_DEVELOPMENT
  -> Developer
  -> complete Task Gate
  -> ready_for_audit
  -> Architect post-development review

Architect post-development review
  -> READY_FOR_AUDIT -> independent Auditor
  -> REPAIR_REQUIRED -> changes_required
  -> BLOCKED -> stop

Auditor
  -> APPROVED -> Architect completion summary -> success
  -> APPROVED_WITH_FOLLOW_UPS -> Architect completion summary -> success
  -> CHANGES_REQUIRED -> Architect repair brief -> Developer repair
  -> BLOCKED -> stop

Developer repair
  -> complete Task Gate again
  -> Architect post-development review again
  -> independent re-audit
```

For an existing implementation in a `ready` workflow:

```text
Architect preparation
-> import existing implementation fingerprint
-> Architect post-development review
-> independent Auditor
```

## Architect decisions

### Preparation

```text
READY_FOR_DEVELOPMENT
BLOCKED
```

### Post-development

```text
READY_FOR_AUDIT
REPAIR_REQUIRED
BLOCKED
```

### Repair

```text
READY_FOR_REPAIR
BLOCKED
```

### Completion

```text
COMPLETE
```

Every Architect response is validated as one strict JSON object before the Controller acts on it. Malformed output stops the run.

## Agent permissions

- Architect: `read-only`.
- Developer: `workspace-write`, limited by the Task Contract.
- Auditor: `read-only`.
- Controller: state, process, worktree, and delivery authority.

Architect does not implement code or issue audit verdicts. Auditor treats Architect briefs as untrusted guidance and independently verifies the implementation.

## Safety limits

### Development attempts

```text
--max-development-attempts 3
```

Counts all development attempts already recorded in workflow state.

### Audit rounds

```text
--max-audit-rounds 4
```

Counts all audit rounds already recorded for the task.

### Repeated failure

```text
--max-same-failure 2
```

Stops when the same failure repeats without material progress. Architect errors, Developer errors, Auditor findings, and report hashes participate in failure identification.

The runner stops immediately for an Architect or Auditor `BLOCKED` decision.

## Concurrency lock

Only one autonomous runner may control a task at a time:

```text
.scaflow/handoffs/<task-id>/run.lock
```

A stale lock is recovered only when its recorded process no longer exists.

## Evidence

```text
.scaflow/handoffs/<task-id>/
├── architect/
│   ├── preparation.json
│   ├── preparation.md
│   ├── post-development-attempt-N.json
│   ├── post-development-attempt-N.md
│   ├── repair-round-N.json
│   ├── repair-round-N.md
│   ├── completion.json
│   └── completion.md
├── developer-report.md
├── audit-round-N.md
├── audit-round-N.json
├── run-state.json
├── run-summary.md
├── state.json
└── events.jsonl
```

Architect JSON is the machine decision. Architect Markdown is rendered deterministically for human review.

## Exit behavior

Exit code `0`:

- independent audit approved the implementation;
- Architect completion summary exists;
- or the task was already in a later delivered state.

Non-zero exit:

- Architect or Auditor returned `BLOCKED`;
- an Architect response was malformed;
- retry limit was reached;
- the same failure repeated;
- an active Developer or Auditor process already owns the workflow;
- branch, base, contract, or environment is invalid;
- unexpected execution failure occurred.

Inspect:

```text
.scaflow/handoffs/<task-id>/run-summary.md
```

## After success

For manual single-task delivery:

```bash
git add .
git commit -m "feat: implement SFL-001"
pnpm scaflow-status SFL-001 --mark committed
```

For sequential task delivery to `dev`, use:

```bash
pnpm scaflow-batch 2-6
```

The batch Controller invokes this same three-Agent workflow for every task before committing and integrating it.

## Bootstrap limitations

- The runner operates in the current dedicated task branch.
- It does not automatically recover a workflow left in `developing` or `auditing`.
- It does not commit, push, merge, or resolve a true `BLOCKED` decision.
- The final SFL-034 Orchestrator will replace this bootstrap script while preserving the same role and state boundaries.
