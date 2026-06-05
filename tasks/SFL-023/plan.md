# SFL-023 Structured Command Runner Plan

## Implementation Notes

- Execute commands with `{ repository, executable, args, timeout_seconds, required }`.
- Resolve cwd from repository ID, never from process current directory.
- Use an environment variable allowlist.
- Truncate stdout/stderr in result objects while saving full artifacts.
- Reject shell strings unless an explicit shell policy permits them.

## Acceptance Focus

- Timeout terminates child processes.
- Exit code, cwd, argv, stdout/stderr, and artifact paths are recorded.
- Command runner is testable without external network.
