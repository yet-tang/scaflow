# Scaflow Task Commands

Scaflow provides three repository-level commands for the standard task loop:

```text
scaflow-dev    -> implement, verify, self-review, prepare handoff
scaflow-audit  -> independently audit the frozen implementation
scaflow-status -> inspect state and record verified delivery transitions
```

The commands coordinate through Git state and local workflow files under:

```text
.scaflow/handoffs/<task-id>/
```

This directory is Git-ignored local runtime data.

Key files:

```text
state.json          current workflow snapshot
events.jsonl        append-only transition log
developer-report.md developer handoff evidence
audit-round-N.md    independent audit result
audit-round-N.json  audit execution metadata
```

The complete state definition is documented in `docs/development/bootstrap-workflow-state-machine.md`.

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
pnpm scaflow-status SFL-001
```

Pass an explicit base ref when necessary:

```bash
pnpm scaflow-dev SFL-001 --base main
pnpm scaflow-audit SFL-001 --base main
pnpm scaflow-status SFL-001 --base origin/main --mark merged
```

Preview generated Codex prompts without starting Codex or changing workflow state:

```bash
pnpm scaflow-dev SFL-001 --dry-run
pnpm scaflow-audit SFL-001 --dry-run
```

## Optional direct command installation

The root package exposes `scaflow-dev`, `scaflow-audit`, and `scaflow-status` as package binaries. Link the repository package globally with your preferred Node package-manager workflow, then use:

```bash
scaflow-dev SFL-001
scaflow-audit SFL-001
scaflow-status SFL-001
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
4. resolves and freezes the base commit;
5. refuses to develop directly on `main` or `master`;
6. verifies the current workflow state allows development;
7. transitions the workflow to `developing`;
8. launches Codex in `workspace-write` mode;
9. instructs the `scaflow-developer` Agent to use the `scaflow-development` Skill;
10. requires preflight, implementation, the complete Task Gate, self-review, and a developer report;
11. verifies a developer report exists and the implementation has changes relative to the frozen base;
12. records the implementation fingerprint;
13. transitions to `ready_for_audit` on success or `development_failed` on failure;
14. prohibits commit, push, PR creation, and shared Task completion changes.

Expected developer report:

```text
.scaflow/handoffs/<task-id>/developer-report.md
```

When an audit requests changes, resume the developer workflow:

```bash
pnpm scaflow-dev SFL-001 --base main --resume
```

Resume mode is allowed from repair-oriented states such as:

```text
development_failed
changes_required
blocked
audit_failed
audit_invalid
ready_for_audit
approved
approved_with_follow_ups
```

It tells the developer to inspect previous audit reports and fix only current findings. A resumed implementation invalidates any previous approval.

## Audit command

```bash
pnpm scaflow-audit <TASK-ID> [--base <ref>] [--dry-run]
```

Example:

```bash
pnpm scaflow-audit SFL-001 --base main
```

The command:

1. verifies the Task Contract, branch, frozen base, and workflow state;
2. verifies the implementation still matches the developer handoff fingerprint;
3. imports pre-state-machine legacy work into `ready_for_audit` only on a real audit run;
4. transitions to `auditing`;
5. launches `codex exec` in `read-only` mode;
6. instructs the `scaflow-auditor` Agent to use the `scaflow-audit` Skill;
7. inspects committed, staged, unstaged, and untracked non-ignored changes;
8. writes the final audit response to a numbered report;
9. verifies the implementation fingerprint did not change during review;
10. parses the final verdict;
11. transitions automatically:

```text
APPROVED                  -> approved
APPROVED_WITH_FOLLOW_UPS  -> approved_with_follow_ups
CHANGES_REQUIRED          -> changes_required
BLOCKED                   -> blocked
```

Process, report, or verdict failures transition to `audit_failed`. A changed implementation transitions to `audit_invalid`.

Audit reports:

```text
.scaflow/handoffs/<task-id>/audit-round-1.md
.scaflow/handoffs/<task-id>/audit-round-1.json
.scaflow/handoffs/<task-id>/audit-round-2.md
.scaflow/handoffs/<task-id>/audit-round-2.json
```

The JSON sidecar records the base commit, branch, fingerprints, Codex exit code, and whether the implementation remained stable.

## Status command

Query the current workflow:

```bash
pnpm scaflow-status SFL-001
pnpm scaflow-status SFL-001 --json
```

Example output:

```text
Task:             SFL-001
Workflow state:   APPROVED
Branch:           SFL-001-engine-monorepo-foundation
Base:             main@abc123
Approval current: yes
Audit round:      1
Audit verdict:    APPROVED
Commit:           -
Pushed:           no
Merged:           no

Next action:
  Review the audit report, commit the implementation, then run:
  pnpm scaflow-status SFL-001 --mark committed
```

Record delivery transitions after performing the corresponding Git action:

```bash
# After committing the exact approved implementation
pnpm scaflow-status SFL-001 --mark committed

# After pushing and setting the branch upstream
pnpm scaflow-status SFL-001 --mark pushed

# After merge and after fetching/updating the target base ref
pnpm scaflow-status SFL-001 --base origin/main --mark merged
```

The command verifies before changing state:

### `--mark committed`

- current state is `approved` or `approved_with_follow_ups`;
- working tree is clean;
- current implementation fingerprint equals the approved fingerprint;
- HEAD is not the frozen base commit.

### `--mark pushed`

- current state is `committed`;
- working tree is clean;
- HEAD equals the recorded implementation commit;
- the commit is contained in the current upstream branch.

### `--mark merged`

- current state is `pushed`;
- the recorded implementation commit is contained in the selected base ref.

The bootstrap verifier currently supports merge or rebase strategies where the recorded implementation commit remains an ancestor of the base branch. A squash merge creates a different commit and therefore cannot be marked automatically by this ancestry check yet.

## Completion semantics

The commands deliberately distinguish four milestones:

```text
development finished  = ready_for_audit
audit passed          = approved / approved_with_follow_ups
local workflow done   = merged
shared Task complete  = Task Contract updated separately to definition_state: completed
```

The helper commands never automatically modify the shared Task Contract.

## Standard loop

```text
1. create or switch to the task branch
2. pnpm scaflow-dev SFL-XXX
3. pnpm scaflow-status SFL-XXX
4. freeze code changes
5. pnpm scaflow-audit SFL-XXX
6. pnpm scaflow-status SFL-XXX
7. if CHANGES_REQUIRED or BLOCKED:
     pnpm scaflow-dev SFL-XXX --resume
     freeze changes
     pnpm scaflow-audit SFL-XXX
8. after APPROVED:
     commit
     pnpm scaflow-status SFL-XXX --mark committed
     push
     pnpm scaflow-status SFL-XXX --mark pushed
9. after merge:
     fetch/update the base ref
     pnpm scaflow-status SFL-XXX --base origin/main --mark merged
10. update the shared Task Contract to completed in a separate controlled change
```

Example:

```bash
git switch -c SFL-002-error-and-logging
pnpm scaflow-dev SFL-002 --base main
pnpm scaflow-audit SFL-002 --base main

# When fixes are required
pnpm scaflow-dev SFL-002 --base main --resume
pnpm scaflow-audit SFL-002 --base main

# When approved
git add .
git commit -m "feat: implement SFL-002 error and logging foundation"
pnpm scaflow-status SFL-002 --mark committed

git push -u origin SFL-002-error-and-logging
pnpm scaflow-status SFL-002 --mark pushed

# After merge
git fetch origin
pnpm scaflow-status SFL-002 --base origin/main --mark merged
```

## Coordination rules

- Do not run the developer and auditor against the same working tree at the same time.
- Freeze all implementation changes while an audit is running.
- The auditor never repairs code.
- The developer never issues the independent approval verdict.
- Any material repair requires the complete Task Gate and a new audit round.
- An approval is tied to an exact implementation fingerprint.
- `APPROVED` does not automatically commit, push, create a PR, or mark the shared Task completed.
- `merged` completes only the local bootstrap workflow.

## Current bootstrap limitation

Before Scaflow v0.1.0 can create formal TaskRun Bundles itself, these commands operate on a dedicated Git task branch in the current repository checkout. After the Execution Kernel is implemented, the same workflow and state semantics can move behind Scaflow's native TaskRun Workspace, SQLite State Store, Event Log, and Orchestrator.
