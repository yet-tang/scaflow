import {
  verificationResultSchema,
  verificationRunSchema,
  type VerificationResult,
  type VerificationRun,
} from "@scaflow/schemas";

import { appendAuditEvent } from "./event-log.js";
import type {
  Migration,
  RepositoryContext,
  StateStore,
} from "./index.js";

export const verificationRunsMigration: Migration = Object.freeze({
  version: "021-verification-runs",
  up(context: RepositoryContext) {
    context.execute(`
      CREATE TABLE verification_runs (
        id TEXT PRIMARY KEY NOT NULL,
        task_run_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        result_json TEXT,
        artifacts_json TEXT NOT NULL,
        failures_json TEXT NOT NULL,
        CHECK (
          (status = 'running' AND completed_at IS NULL AND result_json IS NULL)
          OR
          (status IN ('passed', 'failed') AND completed_at IS NOT NULL AND result_json IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX verification_runs_task_run_id_idx
      ON verification_runs (task_run_id, started_at, id);
    `);
  },
});

export interface CreateVerificationRunInput {
  readonly id: string;
  readonly taskRunId: string;
  readonly startedAt?: Date | string;
  readonly correlationId?: string;
  readonly auditPayload?: unknown;
}

export interface CompleteVerificationRunInput {
  readonly id: string;
  readonly result: VerificationResult;
  readonly completedAt?: Date | string;
  readonly correlationId?: string;
  readonly auditPayload?: unknown;
}

type VerificationRunRow = Record<string, unknown> & {
  readonly id: string;
  readonly task_run_id: string;
  readonly status: "running" | "passed" | "failed";
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly result_json: string | null;
  readonly artifacts_json: string;
  readonly failures_json: string;
};

export function createVerificationRun(
  store: StateStore,
  input: CreateVerificationRunInput,
): VerificationRun {
  const run = verificationRunSchema.parse({
    version: 1,
    id: input.id,
    task_run_id: input.taskRunId,
    status: "running",
    started_at: normalizeTimestamp(input.startedAt),
    completed_at: null,
    result: null,
    artifacts: [],
    failures: [],
  });

  return store.transaction(({ repository }) => {
    const context = repository((value) => value);
    verificationRunRepository(context).insert(run);
    appendAuditEvent(context, {
      ...(input.correlationId === undefined
        ? {}
        : { correlationId: input.correlationId }),
      occurredAt: run.started_at,
      type: "verification.started",
      payload: { run, details: input.auditPayload },
    });
    return run;
  });
}

export function completeVerificationRun(
  store: StateStore,
  input: CompleteVerificationRunInput,
): VerificationRun {
  const result = verificationResultSchema.parse(input.result);
  const completedAt = normalizeTimestamp(input.completedAt);

  return store.transaction(({ repository }) => {
    const context = repository((value) => value);
    const runs = verificationRunRepository(context);
    const current = runs.get(input.id);
    if (current === undefined) {
      throw new Error(`Verification run "${input.id}" was not found`);
    }
    if (current.status !== "running") {
      throw new Error(`Verification run "${input.id}" is already terminal`);
    }

    const completed = verificationRunSchema.parse({
      ...current,
      status: result.status,
      completed_at: completedAt,
      result,
      artifacts: result.artifacts,
      failures: result.failures,
    });
    runs.complete(completed);
    appendAuditEvent(context, {
      ...(input.correlationId === undefined
        ? {}
        : { correlationId: input.correlationId }),
      occurredAt: completedAt,
      type: "verification.completed",
      payload: { run: completed, details: input.auditPayload },
    });
    return completed;
  });
}

export function getVerificationRun(
  store: StateStore,
  id: string,
): VerificationRun | undefined {
  return store.repository(verificationRunRepository).get(id);
}

export function listVerificationRuns(
  store: StateStore,
  taskRunId?: string,
): readonly VerificationRun[] {
  return store.repository(verificationRunRepository).list(taskRunId);
}

function verificationRunRepository(context: RepositoryContext) {
  return Object.freeze({
    insert(run: VerificationRun): void {
      context.run(
        `INSERT INTO verification_runs (
           id, task_run_id, status, started_at, completed_at,
           result_json, artifacts_json, failures_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          run.id,
          run.task_run_id,
          run.status,
          run.started_at,
          run.completed_at,
          run.result === null ? null : JSON.stringify(run.result),
          JSON.stringify(run.artifacts),
          JSON.stringify(run.failures),
        ],
      );
    },
    complete(run: VerificationRun): void {
      const result = context.run(
        `UPDATE verification_runs
         SET status = ?, completed_at = ?, result_json = ?, artifacts_json = ?, failures_json = ?
         WHERE id = ? AND status = 'running'`,
        [
          run.status,
          run.completed_at,
          JSON.stringify(run.result),
          JSON.stringify(run.artifacts),
          JSON.stringify(run.failures),
          run.id,
        ],
      );
      if (Number(result.changes) !== 1) {
        throw new Error("Verification run changed concurrently");
      }
    },
    get(id: string): VerificationRun | undefined {
      const row = context.get<VerificationRunRow>(
        `SELECT id, task_run_id, status, started_at, completed_at,
                result_json, artifacts_json, failures_json
         FROM verification_runs
         WHERE id = ?`,
        [id],
      );
      return row === undefined ? undefined : toVerificationRun(row);
    },
    list(taskRunId?: string): readonly VerificationRun[] {
      const rows = taskRunId === undefined
        ? context.all<VerificationRunRow>(
            `SELECT id, task_run_id, status, started_at, completed_at,
                    result_json, artifacts_json, failures_json
             FROM verification_runs
             ORDER BY started_at, id`,
          )
        : context.all<VerificationRunRow>(
            `SELECT id, task_run_id, status, started_at, completed_at,
                    result_json, artifacts_json, failures_json
             FROM verification_runs
             WHERE task_run_id = ?
             ORDER BY started_at, id`,
            [taskRunId],
          );
      return rows.map(toVerificationRun);
    },
  });
}

function toVerificationRun(row: VerificationRunRow): VerificationRun {
  return verificationRunSchema.parse({
    version: 1,
    id: row.id,
    task_run_id: row.task_run_id,
    status: row.status,
    started_at: row.started_at,
    completed_at: row.completed_at,
    result: row.result_json === null ? null : JSON.parse(row.result_json),
    artifacts: JSON.parse(row.artifacts_json),
    failures: JSON.parse(row.failures_json),
  });
}

function normalizeTimestamp(value: Date | string | undefined): string {
  const timestamp = value === undefined ? new Date() : value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new TypeError("Verification timestamp must be a valid date");
  }
  return timestamp.toISOString();
}
