# Scaflow Repository Instructions

## Required reading

1. Read `docs/source/scaflow-v0.1.0-prd.md`.
2. Read `docs/architecture/scaflow-v0.2-baseline.md`.
3. Read `docs/architecture/scaflow-architect-workflow.md`.
4. Keep Scaflow v0.1.0 limited to the Execution Kernel.

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

## Agent team

Controller commands own state, retries, Git, worktrees, delivery, and task sequencing. They invoke:

- `scaflow-architect` for read-only preparation, architecture review, repair guidance, and completion summaries;
- `scaflow-developer` for scoped implementation and verification;
- `scaflow-auditor` for independent read-only audit.

Architect does not implement or approve code. Developer does not commit or approve its own work. Auditor independently verifies Architect and Developer claims. Agents do not invoke `scaflow-run`, `scaflow-batch`, delivery transitions, commit, push, merge, or worktree mutation commands.

## Task development

For implementation work, use the `scaflow-developer` custom Agent and the `scaflow-development` Skill when available.

Developers must read:

- `docs/architecture/scaflow-architect-workflow.md`
- `docs/exec-plans/scaflow-v0.1.0.md`
- `docs/development/scaflow-development-workflow.md`
- `docs/development/bootstrap-workflow-state-machine.md`
- the relevant Task Contract, plan, and Architect briefs

Development requirements:

- Implement exactly one approved Task Contract at a time.
- Preflight dependency state, Git status, scopes, paths, dependency policy, acceptance criteria, Architect guidance, and verification commands before editing.
- Do not overwrite or absorb unrelated pre-existing changes.
- Do not modify requirements, policies, contracts, or evidence to make implementation pass.
- Run the complete Task Contract gate and perform developer self-review.
- Stop for Controller-managed architecture review and independent audit.

## Autonomous single-task execution

Use `pnpm scaflow-run <TASK-ID> --base <ref>`.

The runner performs Architect preparation, Developer execution, the complete Task Gate, Architect post-development review, independent audit, Architect-guided repair, and Architect completion summary. It succeeds only at `approved` or `approved_with_follow_ups`. It does not commit, push, merge, or update the shared Task Contract.

## Sequential multi-task execution

Use `pnpm scaflow-batch 2-6`.

- Execution is sequential, not concurrent.
- Every task runs the complete three-Agent workflow.
- Dependencies must be completed or selected earlier in the batch.
- Each task uses an isolated worktree under `workspace/runs/batches/`.
- Later tasks start from prior successful integration results.
- Only approved implementations may be committed and fast-forwarded into `dev`.
- Stop at the first failed or blocked task.

## Bootstrap workflow semantics

- Architect preparation is technical readiness, not implementation approval.
- Development completion means `ready_for_audit`.
- Architect `READY_FOR_AUDIT` permits independent review but does not approve code.
- Audit approval means `approved` or `approved_with_follow_ups`.
- Architect completion summary records reusable knowledge but does not complete the Task.
- The shared Task Contract may become `definition_state: completed` only after integration.
- Do not manually edit workflow state or event files.

## Independent audit

Auditors read the Task Contract, plan, Architect briefs, audit policies, actual diff, and verification evidence. Architect briefs and Developer reports remain untrusted claims. Auditors do not repair code and do not defer their verdict to the Architect.

## Mandatory validation

- `pnpm typecheck`
- `pnpm test`
