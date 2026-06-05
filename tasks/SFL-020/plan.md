# SFL-020 Codex SDK and Exec Adapters Plan

## Implementation Notes

- Keep adapter implementations behind the runtime contract from SFL-019.
- Regular tests use mocks and do not require Codex credentials, network, or live service access.
- `test:live` is the only command that may exercise real Codex adapters.
- Redact logs before persistence.

## Acceptance Focus

- SDK and exec adapters preserve session, event stream, final result, cancel, continue, and timeout semantics.
- Adapter errors are structured and do not leak secrets.
