# Scaflow Development Workflow

This document defines the standard implementation workflow for one Scaflow Task. It is the stable development-process memory shared by human developers and the `scaflow-developer` Agent.

## Core rule

One development session implements one approved Task Contract.

```text
approved Task Contract
-> preflight
-> scoped implementation
-> task verification gate
-> developer self-review
-> independent auditor handoff
-> human commit / push decision
```

The developer does not change the product baseline or redefine completion criteria to make an implementation pass.

## Roles

### Developer

The developer:

- implements exactly one task;
- stays inside repository and path scopes;
- writes meaningful tests;
- runs the declared verification gate;
- reports evidence and limitations;
- does not issue the final independent approval.

### Auditor

The `scaflow-auditor` independently checks the actual diff and evidence. The developer must not use self-review as a replacement for this audit.

## 1. Required inputs

Before implementation, identify:

- Task ID;
- Task Contract path;
- optional Task plan path;
- base ref;
- current implementation branch or TaskRun;
- current repository state;
- dependency completion state.

## 2. Required reading

Read in this order:

1. `AGENTS.md`;
2. `PRODUCT.md`;
3. `ARCHITECTURE.md`;
4. `docs/source/scaflow-v0.1.0-prd.md`;
5. `docs/architecture/scaflow-v0.2-baseline.md`;
6. `docs/exec-plans/scaflow-v0.1.0.md`;
7. `tasks/<task-id>/contract.yaml`;
8. `tasks/<task-id>/plan.md` when present;
9. relevant package-level instructions and source files.

Audit-only documents may be read for invariant awareness, but implementation must not weaken them.

## 3. Preflight

Before modifying files:

1. Verify the Task ID matches the requested task.
2. Verify `definition_state: ready`.
3. Verify all dependencies are complete.
4. Inspect `git status --short`.
5. Identify unrelated pre-existing changes.
6. Confirm the current branch or TaskRun is intended for this task.
7. Parse repository scopes, access modes, allowed paths, forbidden paths, and `dependency_changes`.
8. Map every acceptance criterion to expected implementation and test evidence.
9. List the exact verification commands.
10. State the implementation plan in a few concrete steps.

### Pre-existing changes

Never reset, discard, overwrite, or silently absorb unrelated work.

- If unrelated changes do not intersect the task, leave them untouched and exclude them from the task report.
- If they overlap the task or make scope attribution unclear, stop and report the conflict.

### Bootstrap exception

Until Scaflow can execute its own formal TaskRun workflow, development may occur on a dedicated Git branch. After the Execution Kernel is available, formal tasks should run in `workspace/runs/<task-id>/<task-run-id>/`, never in `workspace/repos/`.

## 4. Stop conditions before coding

Stop and report instead of guessing when:

- the Task Contract conflicts with the PRD or v0.2 baseline;
- a dependency is incomplete;
- required design for an R3 or cross-package task is missing;
- implementation requires an unauthorized repository or path;
- `dependency_changes: forbidden` but a dependency change is required;
- a security boundary cannot be enforced;
- existing unrelated changes overlap the task;
- acceptance criteria are not mechanically testable;
- the task would require v0.2.0+ product scope.

Do not edit the Task Contract, PRD, baseline, or policy to remove the conflict unless the current task explicitly authorizes that control-plane change.

## 5. Implementation rules

### Scope discipline

- Implement only the current task.
- Prefer the smallest complete change that satisfies the acceptance criteria.
- Do not add abstractions only needed by future tasks.
- Do not implement later milestones opportunistically.
- Do not modify read-only repositories.
- Do not modify `workspace/repos/` during a formal task.

### Dependency discipline

When `dependency_changes: forbidden`:

- do not change package manifests;
- do not change `pnpm-lock.yaml`;
- do not add or upgrade dependencies.

When `dependency_changes: allowed`:

- change only authorized manifests and the lockfile;
- add only dependencies necessary for the current task;
- avoid unrelated upgrades or lockfile churn;
- explain every added dependency in the final report.

### Testing discipline

- Add or update tests with meaningful behavioral assertions.
- Test success, failure, and boundary behavior required by the contract.
- Do not delete, skip, narrow, weaken, or bypass existing tests.
- Deterministic regular tests must not require network, credentials, or live Codex access.
- Live tests must use their explicit command and remain separate from the regular task gate.

### State and security discipline

- Preserve Task, TaskRun, and ChangeSet separation.
- Preserve the dual-layer Workspace model.
- Treat Agent claims as untrusted; use actual process and Git evidence.
- Fail closed for security-policy or sandbox capability failures.
- Do not expose secrets, user home, SSH keys, cloud credentials, Docker socket, `.scaflow/state.db`, Engine source, or other TaskRuns.

## 6. Iterative verification during implementation

Use the smallest relevant checks while developing, for example:

```text
focused test
-> affected package test
-> typecheck
```

Do not claim completion based on partial checks.

When a check fails:

1. capture the exact command and failure;
2. classify whether it is caused by the current change, environment, contract, or pre-existing state;
3. fix only failures within the task scope;
4. rerun the failed check;
5. stop if the fix would require unauthorized scope or requirement changes.

## 7. Required task gate

Before handoff, run every verification command in the Task Contract. The standard gate is:

```text
package-focused tests
-> pnpm typecheck
-> pnpm test
```

Also run:

```bash
git diff --check
git status --short
```

For tasks that allow dependency changes, use the lockfile reproducibility check required by the contract or project policy, such as:

```bash
pnpm install --frozen-lockfile
```

Never claim a command passed if it was not actually executed.

## 8. Developer self-review

After the task gate passes, review the actual diff against the Task Contract.

Check:

- changed repositories and files are authorized;
- no forbidden path changed;
- dependency changes match policy;
- all acceptance criteria have concrete evidence;
- tests are meaningful and not weakened;
- no future-task behavior was implemented;
- no temporary debug code, placeholder, generated junk, or secrets remain;
- public APIs, errors, logs, and types are consistent;
- failure, cancellation, idempotency, and cleanup behavior are covered when relevant;
- documentation was updated only when required by the task.

Self-review may find and fix issues, but it is not the independent audit verdict.

## 9. Handoff to the Auditor

After self-review, request an independent read-only audit using:

- custom Agent: `scaflow-auditor`;
- Skill: `scaflow-audit`.

Provide:

- Task ID;
- base ref;
- implementation branch or working-tree diff;
- actual commands and exit results;
- known limitations or unresolved questions.

Do not modify code while the auditor is reviewing unless the audit is explicitly ended and a repair cycle begins.

## 10. Repair after audit

For audit findings:

- BLOCKER or HIGH: fix before approval;
- MEDIUM: fix or obtain an explicit follow-up decision;
- LOW: fix when cheap or record a bounded follow-up.

After any code change:

1. rerun affected focused tests;
2. rerun the full Task Contract gate;
3. update the evidence report;
4. request re-audit for material changes.

Do not weaken tests, contracts, policies, or acceptance criteria to resolve a finding.

## 11. Commit and push policy

Default behavior:

- do not commit;
- do not push;
- do not create a PR.

Commit, push, or PR creation requires an explicit user instruction after the implementation and audit evidence are available.

Recommended commit message:

```text
<type>: implement <task-id> <short description>
```

The final commit must contain only task-related changes.

## 12. Required developer report

End implementation with:

```markdown
## Task
- ID:
- Branch / TaskRun:
- Base ref:

## Implementation
- Summary:
- Changed files:
- Dependency changes:

## Acceptance evidence
- <criterion ID>: <code/test/evidence>

## Verification
- `<command>`: PASS/FAIL, exit code

## Self-review
- Scope checked:
- Test integrity checked:
- Future-task scope checked:
- Diff check:

## Limitations and risks
- None, or explicit items

## Handoff
- Ready for independent audit: yes/no
- Recommended next action:
```

Do not use `completed` for the Task merely because the local implementation and TaskRun succeeded.
