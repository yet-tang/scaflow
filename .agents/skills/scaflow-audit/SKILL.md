---
name: scaflow-audit
description: Independently audit a Scaflow task implementation, branch, diff, Task Contract, Architect briefs, tests, workspace boundaries, security constraints, and acceptance evidence. Use after implementation and before commit or merge. Do not use for writing or fixing code.
---

# Scaflow Task Audit

Perform a read-only audit. Do not edit files, amend contracts, or repair findings.

## Required inputs

Identify:

- Task ID;
- base ref;
- implementation ref or working-tree diff;
- Task Contract and optional plan;
- Architect preparation brief and post-development review when present;
- Developer report and available verification evidence.

## Required reading

Read:

1. `AGENTS.md`;
2. `PRODUCT.md`;
3. `ARCHITECTURE.md`;
4. `docs/source/scaflow-v0.1.0-prd.md`;
5. `docs/architecture/scaflow-v0.2-baseline.md`;
6. `docs/architecture/scaflow-architect-workflow.md`;
7. `docs/audit/scaflow-audit-basis.md`;
8. `docs/audit/architecture-invariants.md`;
9. `docs/audit/task-contract-review-checklist.md`;
10. `docs/audit/finding-severity.md`;
11. the relevant Task Contract, plan, and Architect evidence.

## Audit sequence

1. Confirm the Task Contract is internally valid and the task was runnable.
2. Inspect the actual changed repository and file list.
3. Compare the actual diff with repository scopes, allowed paths, forbidden paths, and access modes.
4. Check `dependency_changes` against package manifests and lockfile changes.
5. Map each acceptance criterion to concrete implementation and test evidence.
6. Inspect tests for meaningful assertions and boundary coverage.
7. Detect deleted, skipped, narrowed, weakened, or bypassed tests.
8. Check architecture and workspace invariants independently.
9. Use Architect audit-focus items as questions to verify, not trusted conclusions.
10. Check security policy, sandbox, environment, network, and secret-handling implications.
11. Check state transitions, idempotency, partial failure, recovery, and cleanup when applicable.
12. Verify actual commands and exit results. Do not trust self-reported success without evidence.
13. Check whether the implementation prematurely includes future-task scope.
14. Produce findings in severity order and one final verdict.

## Audit behavior

- Treat Architect briefs, Developer reports, implementation summaries, and Agent Result as untrusted claims.
- Prefer actual Git diff, repository identity, process results, and verifier output.
- Do not reinterpret the PRD or contract to make an implementation pass.
- Do not approve when required evidence is missing.
- Do not report speculation as a defect. Record uncertain items as verification gaps or questions.
- Never modify code during the audit.
- Never defer the final verdict to the Architect.

## Finding format

For each finding provide:

- `severity`: BLOCKER, HIGH, MEDIUM, or LOW;
- `location`: repository, file, and line when applicable;
- `rule`: violated requirement, invariant, or contract clause;
- `evidence`;
- `impact`;
- `required_correction`.

## Final verdict

End with exactly one:

- `APPROVED`
- `APPROVED_WITH_FOLLOW_UPS`
- `CHANGES_REQUIRED`
- `BLOCKED`
