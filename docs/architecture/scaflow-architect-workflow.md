# Scaflow Architect Workflow

The Scaflow Architect is a read-only technical lead invoked by deterministic Controller commands. It coordinates technical understanding across Developer and Auditor activity without owning execution state, Git delivery, or audit approval.

## Control hierarchy

```text
User
-> scaflow-run / scaflow-batch Controller
   -> Architect Agent
   -> Developer Agent
   -> mechanical Task Gate
   -> Architect Agent
   -> Auditor Agent
   -> Architect Agent when repair is needed
   -> Controller commit and integration
```

The Controller always remains authoritative for:

- legal workflow transitions;
- retry and failure limits;
- task sequencing and dependency checks;
- worktree and branch lifecycle;
- implementation fingerprints;
- commit, push, and `dev` integration;
- final stop conditions.

The Architect cannot invoke or bypass the Controller.

## Phase 1: preparation

The Controller invokes the Architect before the first Developer attempt.

Inputs include:

- PRD, architecture baseline, and execution plan;
- Task Contract and task plan;
- frozen base ref and commit;
- current repository state and existing implementation when present;
- prior dependent-task completion summaries when available.

Allowed decisions:

```text
READY_FOR_DEVELOPMENT
BLOCKED
```

`BLOCKED` stops the autonomous task. It must include concrete blocking issues such as requirement conflict, incomplete dependency, insufficient authorized scope, or an unresolved security boundary.

## Phase 2: post-development architecture review

After Developer completion and the Task Gate, but before independent audit, the Controller invokes the Architect again.

Inputs include:

- preparation brief;
- actual implementation diff;
- Developer report;
- Task Contract and architecture invariants.

Allowed decisions:

```text
READY_FOR_AUDIT
REPAIR_REQUIRED
BLOCKED
```

`REPAIR_REQUIRED` transitions the workflow to a repair cycle. It is used only for architecture-level defects repairable inside the current Task Contract. The Developer then receives the architecture repair brief and reruns the full Task Gate.

`READY_FOR_AUDIT` does not approve the implementation. It only confirms that no architecture repair should precede independent audit.

## Phase 3: audit-finding analysis

When the Auditor returns `CHANGES_REQUIRED`, or when execution evidence requires a repair cycle, the Controller invokes the Architect before the next Developer attempt.

Allowed decisions:

```text
READY_FOR_REPAIR
BLOCKED
```

The Architect translates findings into a bounded repair brief. It must not reject or override valid Auditor findings, weaken tests, expand scope, or implement later tasks.

## Phase 4: completion summary

After the Auditor returns `APPROVED` or `APPROVED_WITH_FOLLOW_UPS`, the Controller invokes the Architect to produce the cross-task completion summary.

Allowed decision:

```text
COMPLETE
```

The completion summary records:

- exact approved capability;
- architecture decisions embodied by the implementation;
- reusable package APIs and boundaries;
- preserved invariants;
- residual risks and follow-ups;
- downstream task implications.

This phase does not commit code, integrate to `dev`, or mark the shared Task completed.

## Evidence layout

```text
.scaflow/handoffs/<task-id>/architect/
├── preparation.json
├── preparation.md
├── post-development-attempt-1.json
├── post-development-attempt-1.md
├── repair-round-1.json
├── repair-round-1.md
├── completion.json
└── completion.md
```

The JSON file is the machine decision consumed by the Controller. Markdown is rendered deterministically from the validated JSON for human review.

## Output validation

Architect responses must be exactly one JSON object. The Controller validates:

- `version` is `1`;
- Task ID and requested phase match;
- decision is allowed for that phase;
- all required string and array fields exist;
- output contains no unsupported decision or malformed data.

Malformed or contradictory architecture output stops the autonomous loop. The Controller never guesses an intended decision.

## Independence boundaries

Architect and Auditor remain distinct:

- Architect checks task readiness, architecture direction, and cross-task consistency.
- Auditor independently checks correctness, scope, security, tests, and evidence.
- Architect cannot issue `APPROVED`, `CHANGES_REQUIRED`, or other audit verdicts.
- Auditor treats Architect briefs as guidance, not trusted proof.

Developer remains the only Agent with scoped source-write access. Architect and Auditor remain read-only.
