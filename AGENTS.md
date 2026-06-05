# Scaflow Repository Instructions

## Required reading

1. Read `docs/source/scaflow-v0.1.0-prd.md`.
2. Read `docs/architecture/scaflow-v0.2-baseline.md`.
3. Keep Scaflow v0.1.0 limited to the Execution Kernel.

## Hard constraints

- Use TypeScript and Node.js 22.
- Use `scaflow` as the CLI name.
- Do not reintroduce the old `harness` command name.
- Do not add a central multi-project control service in v0.1.0.
- Do not let formal Codex tasks modify `workspace/repos/`.
- Keep Task definition state separate from TaskRun execution state.
- Treat `@control` as the reserved ID for the Scaflow Project Repository.
- Commands executed by the Engine must use structured executable/args definitions; arbitrary shell strings are not the default.
- `.scaflow/` must not contain application source checkouts.

## Task development

For implementation work, use the `scaflow-developer` custom Agent and the `scaflow-development` Skill when available.

Developers must read:

- `docs/exec-plans/scaflow-v0.1.0.md`
- `docs/development/scaflow-development-workflow.md`
- the relevant Task Contract and plan

Development requirements:

- Implement exactly one approved Task Contract at a time.
- Preflight dependency state, Git status, scopes, paths, dependency policy, acceptance criteria, and verification commands before editing.
- Do not overwrite or absorb unrelated pre-existing changes.
- Do not modify requirements, policies, or contracts to make implementation pass.
- Run the complete Task Contract gate and perform developer self-review.
- Default to no commit, no push, and no PR unless the user explicitly requests them.
- Hand completed implementation to the independent Auditor.

## Independent audit

For implementation audits, use the `scaflow-auditor` custom Agent and the `scaflow-audit` Skill when available.

Auditors must read:

- `docs/audit/scaflow-audit-basis.md`
- `docs/audit/architecture-invariants.md`
- `docs/audit/task-contract-review-checklist.md`
- `docs/audit/finding-severity.md`
- the relevant Task Contract and plan

Audit requirements:

- Treat implementation summaries and Agent Result as untrusted claims.
- Inspect the actual Git diff and verification evidence.
- Do not edit or repair code during an audit.
- Do not approve when required evidence is missing.

## Mandatory validation

- `pnpm typecheck`
- `pnpm test`
