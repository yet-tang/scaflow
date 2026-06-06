---
name: scaflow-development
description: Implement exactly one approved Scaflow Task Contract through Architect-guided preflight, scoped coding, tests, task gate, self-review, and auditor handoff. Use for implementation work. Do not use for independent audit or product-scope redesign.
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
- Architect preparation brief;
- latest Architect repair brief when present;
- latest independent audit report when present;
- current Git status;
- dependency completion state.

## Required reading

Read:

1. `AGENTS.md`;
2. `PRODUCT.md`;
3. `ARCHITECTURE.md`;
4. `docs/source/scaflow-v0.1.0-prd.md`;
5. `docs/architecture/scaflow-v0.2-baseline.md`;
6. `docs/architecture/scaflow-architect-workflow.md`;
7. `docs/exec-plans/scaflow-v0.1.0.md`;
8. `docs/development/scaflow-development-workflow.md`;
9. the relevant Task Contract and plan;
10. Architect briefs supplied by the Controller;
11. package-level instructions and relevant code.

## Architect guidance boundary

- Use the Architect brief as bounded implementation guidance.
- The Task Contract, PRD, baseline, and security policy remain authoritative.
- Report conflicts instead of choosing one silently.
- Do not expand scope merely because the Architect mentions a future concern.
- On repair rounds, fix only the current Architect repair brief and Auditor findings that fit the Task Contract.

## Phase 1: Preflight

Before editing:

1. Confirm the requested Task ID and contract path.
2. Confirm `definition_state: ready`.
3. Confirm all dependencies are complete.
4. Inspect `git status --short` and identify unrelated changes.
5. Confirm the branch or TaskRun belongs to this task.
6. Parse repository scopes, access modes, allowed paths, forbidden paths, and `dependency_changes`.
7. Map each acceptance criterion to planned code and test evidence.
8. Map Architect guidance to the Task Contract and identify conflicts.
9. List the exact verification commands.
10. State a short implementation plan.

Stop instead of coding when the contract conflicts with the PRD, baseline, Architect brief, security policy, dependency state, repository scope, or existing overlapping changes.

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
- Architect must-preserve items remain intact;
- tests are meaningful and intact;
- no future-task scope was implemented;
- no temporary debug code, secrets, generated junk, or placeholder behavior remains;
- failure, cancellation, idempotency, recovery, and cleanup behavior are correct when applicable.

Fix self-review findings, then rerun the complete task gate.

## Phase 7: Handoff

After the implementation and full task gate pass, stop for Controller-managed post-development architecture review and independent audit.

The Developer must not invoke Architect or Auditor control commands directly. The Developer's self-review is not final approval.

## Control-plane prohibition

Never call:

- `scaflow-run`;
- `scaflow-batch`;
- delivery-marking commands;
- `git commit`, `git push`, `git merge`;
- `git worktree add/remove`.

These belong to the deterministic Controller.

## Required final report

Include:

- Task ID, branch or TaskRun, and base ref;
- Architect guidance followed and conflicts found;
- implementation summary and changed files;
- dependency changes;
- acceptance-criterion evidence;
- actual verification commands, exit codes, and results;
- self-review results;
- limitations and risks;
- readiness for architecture review and independent audit.

Do not mark the shared Task `completed` merely because local implementation succeeded.
