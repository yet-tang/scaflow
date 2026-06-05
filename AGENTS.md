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

## Mandatory validation

- `pnpm typecheck`
- `pnpm test`
