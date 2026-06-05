# Scaflow Task Commands

Scaflow provides two repository-level commands for the standard task loop:

```text
scaflow-dev   -> implement, verify, self-review, prepare handoff
scaflow-audit -> independently audit the frozen implementation
```

The commands coordinate through Git state and files under:

```text
.scaflow/handoffs/<task-id>/
```

This directory is Git-ignored local runtime data.

## Prerequisites

- Node.js 22+
- pnpm 10.12.1
- Git
- Codex CLI installed and authenticated
- repository dependencies installed with `pnpm install`
- a dedicated task branch; development directly on `main` is rejected

## Run from the repository

No global installation is required:

```bash
pnpm scaflow-dev SFL-001
pnpm scaflow-audit SFL-001
```

Pass an explicit base ref when necessary:

```bash
pnpm scaflow-dev SFL-001 --base main
pnpm scaflow-audit SFL-001 --base main
```

Preview the generated prompt without starting Codex:

```bash
pnpm scaflow-dev SFL-001 --dry-run
pnpm scaflow-audit SFL-001 --dry-run
```

## Optional direct command installation

The root package exposes `scaflow-dev` and `scaflow-audit` as package binaries. Link the repository package globally with your preferred Node package-manager workflow, then use:

```bash
scaflow-dev SFL-001
scaflow-audit SFL-001
```

The `pnpm` script form remains the canonical repository-local invocation.

## Development command

```bash
pnpm scaflow-dev <TASK-ID> [--base <ref>] [--resume] [--dry-run]
```

Example:

```bash
git switch -c SFL-002-error-and-logging
pnpm scaflow-dev SFL-002 --base main
```

The command:

1. verifies the current directory is a Git repository;
2. verifies Codex CLI is available;
3. verifies `tasks/<task-id>/contract.yaml` exists and is `ready`;
4. refuses to develop directly on `main` or `master`;
5. creates `.scaflow/handoffs/<task-id>/handoff.json`;
6. launches Codex in `workspace-write` mode;
7. instructs the `scaflow-developer` Agent to use the `scaflow-development` Skill;
8. requires preflight, implementation, the complete Task Gate, self-review, and a developer report;
9. prohibits commit, push, PR creation, and Task completion changes.

Expected developer report:

```text
.scaflow/handoffs/<task-id>/developer-report.md
```

When an audit requests changes, resume the developer workflow:

```bash
pnpm scaflow-dev SFL-001 --base main --resume
```

Resume mode tells the developer to inspect previous audit reports and fix only current findings.

## Audit command

```bash
pnpm scaflow-audit <TASK-ID> [--base <ref>] [--dry-run]
```

Example:

```bash
pnpm scaflow-audit SFL-001 --base main
```

The command:

1. verifies the Task Contract and base ref;
2. records the current branch and resolved base commit;
3. computes a fingerprint of committed, staged, unstaged, and untracked non-ignored changes;
4. launches `codex exec` in `read-only` mode;
5. instructs the `scaflow-auditor` Agent to use the `scaflow-audit` Skill;
6. writes the final audit response to a numbered report;
7. recomputes the working-tree fingerprint;
8. invalidates the audit if the working tree changed during review.

Audit reports:

```text
.scaflow/handoffs/<task-id>/audit-round-1.md
.scaflow/handoffs/<task-id>/audit-round-1.json
.scaflow/handoffs/<task-id>/audit-round-2.md
.scaflow/handoffs/<task-id>/audit-round-2.json
```

The JSON sidecar records the base commit, branch, fingerprints, Codex exit code, and whether the working tree remained stable.

## Standard loop

```text
1. create or switch to the task branch
2. pnpm scaflow-dev SFL-XXX
3. freeze code changes
4. pnpm scaflow-audit SFL-XXX
5. if CHANGES_REQUIRED:
     pnpm scaflow-dev SFL-XXX --resume
     freeze changes
     pnpm scaflow-audit SFL-XXX
6. after APPROVED:
     human decides whether to commit and push
```

Example:

```bash
git switch -c SFL-002-error-and-logging
pnpm scaflow-dev SFL-002 --base main
pnpm scaflow-audit SFL-002 --base main

# When fixes are required
pnpm scaflow-dev SFL-002 --base main --resume
pnpm scaflow-audit SFL-002 --base main
```

## Coordination rules

- Do not run the developer and auditor against the same working tree at the same time.
- Freeze all implementation changes while an audit is running.
- The auditor never repairs code.
- The developer never issues the independent approval verdict.
- Any material repair requires the complete Task Gate and a new audit round.
- `APPROVED` does not automatically commit, push, create a PR, or mark the shared Task completed.

## Current bootstrap limitation

Before Scaflow v0.1.0 can create formal TaskRun Bundles itself, these commands operate on a dedicated Git task branch in the current repository checkout. After the Execution Kernel is implemented, the same workflow can be moved behind Scaflow's native TaskRun Workspace and Orchestrator without changing the developer/auditor role contract.
