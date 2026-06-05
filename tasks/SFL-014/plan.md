# SFL-014 Base Workspace Bootstrap Plan

## Implementation Notes

- `workspace/repos/` is developer-owned and long-lived.
- Bootstrap may clone missing repositories and fetch existing matching repositories.
- Bootstrap must not reset, delete, checkout another branch, or overwrite developer changes.
- Post-bootstrap Doctor adds repository identity and workspace manifest checks.

## Acceptance Focus

- Single repository failure does not corrupt other repositories.
- Re-running bootstrap resumes failed or missing repositories.
- Formal TaskRun write behavior remains out of scope for this task.
