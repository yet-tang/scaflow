---
name: scaflow-development
description: Implement exactly one approved Scaflow Task Contract through preflight, scoped coding, tests, task gate, self-review, and auditor handoff. Use for implementation work. Do not use for independent audit or product-scope redesign.
---

# Scaflow Task Development

Implement one Task Contract at a time. Follow `docs/development/scaflow-development-workflow.md` as the authoritative process.

## Required inputs

Identify:

- Task ID;
- base ref;
- implementation branch or TaskRun;
- `tasks/<task-id>/contract.yaml`;
- optional `tasks/<task-id>/plan.md`;
- current Git status;
- dependency completion state.

## Required reading

Read:

1. `AGENTS.md`;
2. `PRODUCT.md`;
3. `ARCHITECTURE.md`;
4. `docs/source/scaflow-v0.1.0-prd.md`;
5. `docs/architecture/scaflow-v0.2-baseline.md`;
6. `docs/exec-plans/scaflow-v0.1.0.md`;
7. `docs/development/scaflow-development-workflow.md`;
8. the relevant Task Contract and plan;
9. package-level instructions and relevant code.

## Phase 1: Preflight

Before editing:

1. Confirm the requested Task ID and contract path.
2. Confirm `definition_state: ready`.
3. Confirm all dependencies are complete.
4. Inspect `git status --short` and identify unrelated changes.
5. Confirm the branch or TaskRun belongs to this task.
6. Parse repository scopes, access modes, allowed paths, forbidden paths, and `dependency_changes`.
7. Map each acceptance criterion to planned code and test evidence.
8. List the exact verification commands.
9. State a short implementation plan.

Stop instead of coding when a contract conflicts with the PRD, baseline, security policy, dependency state, repository scope, or existing overlapping changes.

## Phase 2: Scoped implementation

- Implement only the current task.
- Prefer the smallest complete change.
- Do not modify read-only repositories.
- Do not write to `workspace/repos/` during a formal task.
- Do not implement future-task behavior.
- Do not modify the PRD, baseline, policies, contract, or acceptance criteria to make implementation pass unless the current task explicitly authorizes that control-plane change.
- Preserve Task, TaskRun, ChangeSet, Revision Set, and dual-layer Workspace invariants.

## Phase 3: Dependency discipline

When `dependency_changes: forbidden`:

- do not modify package manifests or `pnpm-lock.yaml`;
- do not add, remove, or upgrade dependencies.

When `dependency_changes: allowed`:

- modify only authorized manifests and lockfiles;
- add only dependencies required for this task;
- avoid unrelated upgrades and lockfile churn;
- report each dependency change.

## Phase 4: Testing while developing

Use focused checks first:

```text
focused test
-> affected package test
-> typecheck
```

Tests must contain meaningful assertions. Do not delete, skip, narrow, weaken, or bypass existing tests.

Regular tests must remain deterministic and must not require live Codex access, network access, or developer credentials. Use explicit live-test commands only when the contract requires them.

## Phase 5: Required task gate

Run every verification command from the Task Contract. The standard gate is:

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

When dependency changes are allowed and the contract or project policy requires reproducibility, run:

```bash
pnpm install --frozen-lockfile
```

Record the actual command, exit code, and result. Never claim an unexecuted command passed.

## Phase 6: Developer self-review

Inspect the actual diff and verify:

- all changed repositories and files are authorized;
- no forbidden or read-only location changed;
- dependency changes match policy;
- each acceptance criterion has concrete evidence;
- tests are meaningful and intact;
- no future-task scope was implemented;
- no temporary debug code, secrets, generated junk, or placeholder behavior remains;
- failure, cancellation, idempotency, recovery, and cleanup behavior are correct when applicable.

Fix self-review findings, then rerun the complete task gate.

## Phase 7: Auditor handoff

After the implementation and full task gate pass:

- request the `scaflow-auditor` custom Agent;
- request the `scaflow-audit` Skill;
- provide Task ID, base ref, implementation branch or diff, actual command results, and known limitations;
- do not modify files while the independent audit is active.

The developer's self-review is not the final approval.

## Commit and push rule

Default behavior:

- do not commit;
- do not push;
- do not create a pull request.

Only perform those actions after an explicit user instruction.

## Required final report

Use this format:

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
- <criterion ID>: <evidence>

## Verification
- `<command>`: PASS/FAIL, exit code

## Self-review
- Scope checked:
- Test integrity checked:
- Future-task scope checked:
- `git diff --check`:

## Limitations and risks
- None, or explicit items

## Handoff
- Ready for independent audit: yes/no
- Recommended next action:
```

Do not mark the shared Task `completed` merely because the local implementation or TaskRun succeeded.
