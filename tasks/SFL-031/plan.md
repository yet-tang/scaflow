# SFL-031 MVP End-to-End Test Plan

## Implementation Notes

- Required E2E uses Mock Runtime only.
- Cover init, repositories manifest, bootstrap, task prepare, mock run, scope violation, repair, verification, commits, ChangeSet, recovery, evidence, and cleanup.
- Include `@control`, web, and api repositories.
- Keep live Codex smoke testing optional and manual.

## Acceptance Focus

- The deterministic E2E runs under regular `pnpm test`.
- Developer changes in `workspace/repos/` remain untouched.
- ChangeSet is generated without being described as a cross-repository atomic transaction.
