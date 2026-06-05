# SFL-033 Agent Runtime Sandbox Enforcement Plan

## Implementation Notes

- Apply the loaded security policy to both SDK and `codex exec` adapters.
- Fix the runtime working directory to the TaskRun Bundle.
- Configure writable roots from the Task Contract and security policy.
- Clean environment variables before invoking the Agent.
- Hide or deny user home, SSH keys, cloud credentials, `.scaflow/state.db`, Docker socket, Scaflow Engine source, and other TaskRuns.
- Keep Agent command network off by default.

## Acceptance Focus

- Sandbox policy is enforced by runtime code, not only by prompt text.
- Violations are non-repairable and auditable.
- Regular tests use mocks and do not require live Codex access.
