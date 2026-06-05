# Scaflow Task Contract Review Checklist

Use this checklist before implementation starts and again when auditing the completed implementation.

## 1. Identity and scope

- [ ] Task ID matches its directory and file location.
- [ ] Task type is valid.
- [ ] Risk level matches the affected subsystem and operation.
- [ ] `definition_state` is correct.
- [ ] Objective has one primary deliverable.
- [ ] Out-of-scope work is explicit when ambiguity is likely.

## 2. Requirement traceability

- [ ] `source_requirements` contains only stable requirement IDs.
- [ ] Document-section references are under `source_references`, not `source_requirements`.
- [ ] Acceptance criteria cover the cited requirements.
- [ ] The task does not introduce v0.2.0+ scope.

## 3. Dependencies

- [ ] Every dependency exists.
- [ ] Dependencies represent real implementation prerequisites.
- [ ] No dependency cycle is introduced.
- [ ] `definition_state: ready` is not confused with runnable state.
- [ ] The task must not run until all dependencies are complete.

## 4. Repository scopes

- [ ] Primary repository is declared.
- [ ] Every participating repository has an explicit access mode.
- [ ] Every read-write scope has non-empty `allowed_paths`.
- [ ] Read-only scopes cannot authorize writes.
- [ ] `@control` behavior follows the v0.2 baseline.
- [ ] No scope includes `workspace/repos/**` for formal task writes.
- [ ] Protected control-plane paths are forbidden unless this is an approved `control-plane-change` task.

## 5. Dependency changes

- [ ] `dependency_changes` is present.
- [ ] If `forbidden`, package manifests and lockfiles cannot change.
- [ ] If `allowed`, required package manifests and `pnpm-lock.yaml` are explicitly allowed.
- [ ] Added dependencies are necessary for the current task only.
- [ ] Dependency versions and package scope remain consistent with the project baseline.

## 6. Acceptance criteria

- [ ] Each criterion is objectively testable.
- [ ] Criteria describe outcomes, not vague implementation intent.
- [ ] Criteria do not permit implementation-summary self-attestation as proof.
- [ ] Security and failure behavior are covered where relevant.
- [ ] The criteria prohibit premature implementation of future tasks when necessary.

## 7. Verification commands

- [ ] Commands are structured as repository, executable, args, timeout, and required flag.
- [ ] Commands use explicit repository working directories.
- [ ] Shell strings are not used unless policy explicitly permits them.
- [ ] Package-focused tests are included.
- [ ] `pnpm typecheck` is included.
- [ ] `pnpm test` is included.
- [ ] Regular tests do not require live Codex access or credentials.
- [ ] Timeouts are realistic and process termination is defined.

## 8. State and recovery

- [ ] Task Definition State, TaskRun State, and ChangeSet State are not conflated.
- [ ] Failure and cancellation transitions are defined when relevant.
- [ ] Non-repairable failures are identified.
- [ ] Idempotency, partial failure, and recovery behavior are covered for stateful operations.

## 9. Security

- [ ] Runtime restrictions are mechanically enforceable.
- [ ] The task does not expose user home, SSH keys, cloud credentials, Docker socket, `.scaflow/state.db`, Engine source, or other TaskRuns.
- [ ] Network access defaults to deny for Agent commands.
- [ ] Policy-loading failures fail closed.
- [ ] Security violations cannot be bypassed by Repair Loop behavior.

## 10. Implementation audit

- [ ] Actual changed repositories match declared scopes.
- [ ] Actual changed files match allowed and forbidden paths.
- [ ] No read-only repository has a diff.
- [ ] Dependency changes match the contract.
- [ ] Tests have meaningful assertions.
- [ ] No tests were deleted, skipped, narrowed, or weakened.
- [ ] Actual commands and exit codes are available as evidence.
- [ ] Every acceptance criterion has concrete evidence.
- [ ] No future-task behavior was implemented early.
- [ ] The final verdict follows the finding-severity policy.
