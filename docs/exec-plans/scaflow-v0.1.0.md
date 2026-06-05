# Scaflow v0.1.0 Execution Kernel Development Plan

Status: APPROVED_WITH_REQUIRED_FIXES

This plan defines the executable development sequence for Scaflow v0.1.0. It does not change the product scope in `docs/source/scaflow-v0.1.0-prd.md`, does not introduce v0.2.0+ capabilities, and does not treat ChangeSet as a cross-repository atomic transaction.

## Fixed Scope

Scaflow v0.1.0 is the Execution Kernel:

```text
manual Task Contract
-> isolated TaskRun Workspace
-> Codex execution
-> Verification
-> Repair Loop
-> per-repository commits
-> ChangeSet
```

Out of scope:

- PRD compiler
- Task DAG generator
- independent reviewer agent
- GitHub PR automation
- merge queue
- release pipeline
- central scheduler
- distributed workers
- production deployment

## Task Contract Schema v1

All task contracts use `version: 1`.

```yaml
version: 1

task:
  id: SFL-001
  title: Engine Monorepo Foundation
  type: foundation
  risk_level: R1
  definition_state: ready

objective:
  summary: Build the TypeScript monorepo foundation.

source_requirements:
  - id: NFR-001
    document: docs/source/scaflow-v0.1.0-prd.md

dependencies: []

repositories:
  primary: "@control"
  scopes:
    - repository: "@control"
      access: read-write
      allowed_paths:
        - package.json
      forbidden_paths:
        - docs/source/scaflow-v0.1.0-prd.md
        - workspace/**
        - .scaflow/**

acceptance_criteria:
  - id: SFL-001-AC-01
    description: The task-specific requirement is satisfied.

verification:
  commands:
    - repository: "@control"
      executable: pnpm
      args:
        - typecheck
      timeout_seconds: 300
      required: true

retry_policy:
  max_attempts: 2
  max_repair_rounds_per_attempt: 3
  escalate_after_same_failure: 2
```

Rules:

- `read-write` scopes must include at least one `allowed_paths` entry. Empty `allowed_paths` is invalid for write scopes.
- `read-only` scopes have no write authorization. Empty write paths are only valid under read-only semantics.
- `source_requirements` use structured references with stable requirement IDs.
- Task type enum: `foundation`, `schema`, `cli`, `state`, `git`, `workspace`, `runtime`, `verification`, `changeset`, `integration`, `control-plane-change`.
- Public schemas are exported from `@scaflow/schemas`: Project Config, Repository Manifest, Task Contract, Revision Set, Agent Result, Verification Result, and ChangeSet Manifest.

## State Authority

- Task Definition State: `tasks/<task-id>/contract.yaml` in SPR Git.
- TaskRun State: `.scaflow/state.db`.
- ChangeSet Runtime State: `.scaflow/state.db`.
- ChangeSet Manifest: `.scaflow/evidence/changesets/<id>.yaml`.
- If `@control` is read-write, ChangeSet Manifest is also synchronized to `changesets/<id>.yaml`.
- If `@control` is not read-write, ChangeSet Manifest is marked `pending_control_update`.

## Internal Package Names

`@scaflow/*` is the private monorepo internal scope for v0.1.0 development. Public release requires confirming npm scope ownership or migrating to an owned organization scope.

```text
@scaflow/cli
@scaflow/core
@scaflow/schemas
@scaflow/config
@scaflow/state
@scaflow/git
@scaflow/workspace
@scaflow/codex-runtime
@scaflow/verification
@scaflow/changeset
@scaflow/template
@scaflow/testkit
```

## Milestones And Tasks

| ID | Milestone | Goal | Dependencies | Risk | Type |
| --- | --- | --- | --- | --- | --- |
| SFL-001 | Engine Monorepo Foundation | Establish package names, root scripts, TypeScript, Vitest, and smoke tests. | none | R1 | foundation |
| SFL-002 | Error and Logging Foundation | Add common errors, recoverable metadata, suggestions, redaction, and correlation IDs. | SFL-001 | R2 | foundation |
| SFL-003 | Schema Infrastructure | Add Zod schema foundation, shared parse errors, and public type exports. | SFL-001, SFL-002 | R1 | schema |
| SFL-004 | CLI Foundation | Register `scaflow` CLI, global options, JSON output, and stable errors. | SFL-002, SFL-003 | R1 | cli |
| SFL-005 | State Store Foundation | Add SQLite connection, migrations, transactions, and repository pattern. | SFL-002, SFL-003 | R2 | state |
| SFL-006 | Domain State Machines | Define Task, TaskRun, and ChangeSet states and legal transitions. | SFL-005 | R2 | state |
| SFL-007 | Event Log and Audit Trail | Record state transitions, command events, and audit entries transactionally. | SFL-005, SFL-006 | R2 | state |
| SFL-008 | Project Config Schema | Define `scaflow.yaml`, engine version, and project validation foundation. | SFL-003 | R2 | schema |
| SFL-009 | Repository Manifest Schema | Define `repositories.yaml`, ID/path/dependency validation. | SFL-003, SFL-008 | R2 | schema |
| SFL-010 | Template Engine | Render SPR templates without overwriting user files. | SFL-008, SFL-009 | R1 | foundation |
| SFL-011 | Scaflow Init and Validate | Implement `scaflow init` and `scaflow validate`. | SFL-004, SFL-010 | R2 | cli |
| SFL-012 | Git Adapter and Repository Identity | Wrap Git clone/fetch/status/head/remote/identity with explicit cwd. | SFL-002 | R2 | git |
| SFL-013 | Scaflow Doctor | Add Doctor framework, pre-bootstrap checks, and JSON/PASS/WARN/FAIL/SKIP output. | SFL-004, SFL-008, SFL-009, SFL-012 | R2 | cli |
| SFL-014 | Base Workspace Bootstrap | Implement `bootstrap`, workspace manifest, and post-bootstrap doctor checks. | SFL-009, SFL-012, SFL-013 | R2 | workspace |
| SFL-015 | Task Contract Implementation | Define Task Contract schema and `task list/show/validate`. | SFL-003, SFL-004, SFL-009 | R2 | schema |
| SFL-016 | Revision Set | Freeze SPR and application repository base commits and access modes. | SFL-012, SFL-014, SFL-015 | R2 | git |
| SFL-017 | TaskRun Workspace | Implement `task prepare`, bundle directories, and read-only/read-write worktrees. | SFL-006, SFL-014, SFL-016 | R3 | workspace |
| SFL-018 | Context Assembler | Generate TaskRun `AGENTS.md`, context manifest, knowledge snapshots, and `@control` behavior. | SFL-015, SFL-017 | R3 | workspace |
| SFL-019 | Agent Runtime Contract and Mock | Define Runtime contract, Mock Runtime, sessions, events, results, and timeouts. | SFL-003, SFL-018 | R2 | runtime |
| SFL-020 | Codex SDK and Exec Adapters | Add `@openai/codex-sdk` and `codex exec` adapters with explicit live tests. | SFL-019 | R3 | runtime |
| SFL-021 | Verification Framework | Add verification runs, results, failure classification, and artifact foundation. | SFL-007, SFL-018, SFL-019 | R2 | verification |
| SFL-022 | Scope Verifier | Detect unauthorized repository, path, read-only, protected control, and TaskRun changes. | SFL-016, SFL-021 | R3 | verification |
| SFL-023 | Structured Command Runner | Execute structured commands with cwd, timeout, env allowlist, truncation, artifacts, and shell policy. | SFL-002, SFL-021 | R3 | verification |
| SFL-024 | Command Verifier | Run Task Contract verification commands and record exit/stdout/stderr. | SFL-023 | R2 | verification |
| SFL-025 | Test Integrity and Agent Result Verifiers | Verify test integrity and Agent Result schema. | SFL-019, SFL-021, SFL-022 | R3 | verification |
| SFL-026 | Repair Loop | Add failure summaries, continue session, repair policy, blocked/failed decisions. | SFL-019, SFL-022, SFL-024, SFL-025 | R3 | runtime |
| SFL-027 | Commit Generation | Create independent per-repository commits after verification passes. | SFL-026 | R3 | git |
| SFL-028 | ChangeSet | Generate ChangeSet manifests, SQLite state, show/list, and pending control updates. | SFL-027 | R2 | changeset |
| SFL-029 | State Recovery | Recover or orphan non-terminal runs and support run inspect/status. | SFL-007, SFL-017, SFL-019, SFL-028 | R3 | state |
| SFL-030 | Workspace Cleanup | Implement `run clean`, completed/older-than cleanup, and evidence preservation. | SFL-029 | R2 | workspace |
| SFL-031 | MVP End-to-End Test | Use Mock Runtime to cover the PRD section 17 E2E scenario. | SFL-011, SFL-014, SFL-020, SFL-030 | R3 | integration |

## Dependency DAG

```text
Layer 0:
  SFL-001

Layer 1:
  SFL-002

Layer 2:
  SFL-003
  SFL-005
  SFL-012

Layer 3:
  SFL-004
  SFL-006
  SFL-008

Layer 4:
  SFL-007
  SFL-009

Layer 5:
  SFL-010
  SFL-013
  SFL-015

Layer 6:
  SFL-011
  SFL-014

Layer 7:
  SFL-016

Layer 8:
  SFL-017

Layer 9:
  SFL-018

Layer 10:
  SFL-019

Layer 11:
  SFL-020
  SFL-021

Layer 12:
  SFL-022
  SFL-023

Layer 13:
  SFL-024
  SFL-025

Layer 14:
  SFL-026

Layer 15:
  SFL-027

Layer 16:
  SFL-028

Layer 17:
  SFL-029

Layer 18:
  SFL-030

Layer 19:
  SFL-031
```

The dependency graph has no cycle.

## Doctor Semantics

Pre-bootstrap Doctor:

- Checks Node.js, pnpm, Git, configuration, Git access, and optional Docker.
- Missing `workspace/` is WARN, not FAIL.

Post-bootstrap Doctor:

- Adds Repository Identity, Workspace Manifest, and repository health checks.
- Bootstrap owns the post-bootstrap wiring.

## Verification Defaults

Global mandatory validation:

```bash
pnpm typecheck
pnpm test
```

Package validation:

```bash
pnpm --filter @scaflow/<package> test
```

Live Codex tests are explicit and never part of regular `pnpm test`:

```bash
pnpm --filter @scaflow/codex-runtime test:live
```

## MVP E2E Boundary

Required:

- Use Mock Runtime to complete the deterministic local end-to-end scenario from PRD section 17.

Optional/manual:

- Use the real Codex adapter for a live smoke test.
- Network, credentials, or Codex service unavailability must not block regular `pnpm test`.

## First Implementation Task

`SFL-001 Engine Monorepo Foundation` is the first task that can start.

Its contract must prohibit Git, SQLite, Workspace, Codex, Verification, ChangeSet, and CLI business behavior implementation.
