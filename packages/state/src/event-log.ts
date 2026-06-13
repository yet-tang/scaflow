import {
  ScaflowError,
  redactSecrets,
  resolveCorrelationId,
  type RedactedValue,
} from "@scaflow/core";
import {
  type ChangeSetState,
  type TaskRunState,
} from "@scaflow/schemas";

import {
  changeSetTransitions,
  taskRunTransitions,
  validateChangeSetTransition,
  validateTaskRunTransition,
} from "./domain-state-machines.js";
import type {
  Migration,
  RepositoryContext,
  StateStore,
} from "./index.js";

export const auditEventCategories = Object.freeze([
  "task_run",
  "command",
  "verification",
  "state_transition",
] as const);

export type AuditEventCategory = (typeof auditEventCategories)[number];
export type AuditEventType = `${AuditEventCategory}.${string}`;
export type RecordableAuditEventCategory = Exclude<
  AuditEventCategory,
  "state_transition"
>;
export type RecordableAuditEventType =
  `${RecordableAuditEventCategory}.${string}`;
export type RuntimeStateDomain = "task_run" | "change_set";

export interface AuditEventInput {
  readonly correlationId?: string;
  readonly occurredAt?: Date | string;
  readonly type: RecordableAuditEventType;
  readonly payload?: unknown;
}

export interface AuditEventRecord {
  readonly id: number;
  readonly correlationId: string;
  readonly occurredAt: string;
  readonly type: AuditEventType;
  readonly payload: RedactedValue;
}

export type InitializeRuntimeStateInput =
  | {
      readonly domain: "task_run";
      readonly entityId: string;
      readonly state: "queued";
      readonly correlationId?: string;
      readonly occurredAt?: Date | string;
      readonly payload?: unknown;
    }
  | {
      readonly domain: "change_set";
      readonly entityId: string;
      readonly state: "draft";
      readonly correlationId?: string;
      readonly occurredAt?: Date | string;
      readonly payload?: unknown;
    };

export type TransitionRuntimeStateInput =
  | {
      readonly domain: "task_run";
      readonly entityId: string;
      readonly to: TaskRunState;
      readonly correlationId?: string;
      readonly occurredAt?: Date | string;
      readonly payload?: unknown;
    }
  | {
      readonly domain: "change_set";
      readonly entityId: string;
      readonly to: ChangeSetState;
      readonly correlationId?: string;
      readonly occurredAt?: Date | string;
      readonly payload?: unknown;
    };

export interface RuntimeStateRecord {
  readonly domain: RuntimeStateDomain;
  readonly entityId: string;
  readonly state: TaskRunState | ChangeSetState;
  readonly updatedAt: string;
}

type AuditEventRow = Record<string, unknown> & {
  readonly id: number;
  readonly correlation_id: string;
  readonly occurred_at: string;
  readonly type: string;
  readonly payload_json: string;
};

type RuntimeStateRow = Record<string, unknown> & {
  readonly domain: RuntimeStateDomain;
  readonly entity_id: string;
  readonly state: string;
  readonly updated_at: string;
};

const auditEventTypePattern =
  /^(task_run|command|verification|state_transition)\.[a-z][a-z0-9_]*$/;
const stateTransitionEventPrefix = "state_transition.";

export const eventLogMigration: Migration = Object.freeze({
  version: "007-event-log-and-audit-trail",
  up(context: RepositoryContext) {
    context.execute(`
      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        correlation_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        type TEXT NOT NULL CHECK (
          type LIKE 'task_run.%'
          OR type LIKE 'command.%'
          OR type LIKE 'verification.%'
          OR type LIKE 'state_transition.%'
        ),
        payload_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE runtime_states (
        domain TEXT NOT NULL CHECK (domain IN ('task_run', 'change_set')),
        entity_id TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (domain, entity_id)
      ) STRICT;
    `);
  },
});

export function recordAuditEvent(
  store: StateStore,
  input: AuditEventInput,
): AuditEventRecord {
  if (input.type.startsWith(stateTransitionEventPrefix)) {
    throw new TypeError(
      "State transition events must be recorded through runtime state APIs",
    );
  }
  const event = prepareAuditEvent(input);
  return store.transaction(({ repository }) =>
    repository(auditEventRepository).append(event),
  );
}

export function listAuditEvents(
  store: StateStore,
): readonly AuditEventRecord[] {
  return store.repository(auditEventRepository).list();
}

export function initializeRuntimeState(
  store: StateStore,
  input: InitializeRuntimeStateInput,
): RuntimeStateRecord {
  const entityId = validateEntityId(input.entityId);
  validateRuntimeState(input.domain, input.state);
  validateInitialRuntimeState(input.domain, input.state);
  const occurredAt = normalizeTimestamp(input.occurredAt);
  const correlationId = resolveCorrelationId(input.correlationId);
  const event = prepareAuditEvent({
    correlationId,
    occurredAt,
    type: "state_transition.initialized",
    payload: {
      domain: input.domain,
      entityId,
      action: "initialized",
      state: input.state,
      details: input.payload,
    },
  });

  return store.transaction(({ repository }) => {
    const states = repository(runtimeStateRepository);
    states.insert(input.domain, entityId, input.state, occurredAt);
    repository(auditEventRepository).append(event);
    return requireRuntimeState(states.get(input.domain, entityId));
  });
}

export function transitionRuntimeState(
  store: StateStore,
  input: TransitionRuntimeStateInput,
): RuntimeStateRecord {
  const entityId = validateEntityId(input.entityId);
  const occurredAt = normalizeTimestamp(input.occurredAt);
  const correlationId = resolveCorrelationId(input.correlationId);

  return store.transaction(({ repository }) => {
    const states = repository(runtimeStateRepository);
    const current = requireRuntimeState(states.get(input.domain, entityId));

    if (input.domain === "task_run") {
      validateTaskRunTransition(
        current.state as TaskRunState,
        input.to,
        { correlationId },
      );
    } else {
      validateChangeSetTransition(
        current.state as ChangeSetState,
        input.to,
        { correlationId },
      );
    }

    states.update(input.domain, entityId, input.to, occurredAt);
    repository(auditEventRepository).append(
      prepareAuditEvent({
        correlationId,
        occurredAt,
        type: "state_transition.applied",
        payload: {
          domain: input.domain,
          entityId,
          from: current.state,
          to: input.to,
          details: input.payload,
        },
      }),
    );

    return requireRuntimeState(states.get(input.domain, entityId));
  });
}

export function getRuntimeState(
  store: StateStore,
  domain: RuntimeStateDomain,
  entityId: string,
): RuntimeStateRecord | undefined {
  return store
    .repository(runtimeStateRepository)
    .get(domain, validateEntityId(entityId));
}

function auditEventRepository(context: RepositoryContext) {
  return Object.freeze({
    append(event: Omit<AuditEventRecord, "id">): AuditEventRecord {
      const result = context.run(
        `INSERT INTO audit_events (
           correlation_id,
           occurred_at,
           type,
           payload_json
         ) VALUES (?, ?, ?, ?)`,
        [
          event.correlationId,
          event.occurredAt,
          event.type,
          JSON.stringify(event.payload),
        ],
      );

      return {
        id: Number(result.lastInsertRowid),
        ...event,
      };
    },
    list(): readonly AuditEventRecord[] {
      return context
        .all<AuditEventRow>(
          `SELECT id, correlation_id, occurred_at, type, payload_json
           FROM audit_events
           ORDER BY id`,
        )
        .map(toAuditEventRecord);
    },
  });
}

function runtimeStateRepository(context: RepositoryContext) {
  return Object.freeze({
    insert(
      domain: RuntimeStateDomain,
      entityId: string,
      state: string,
      updatedAt: string,
    ): void {
      context.run(
        `INSERT INTO runtime_states (domain, entity_id, state, updated_at)
         VALUES (?, ?, ?, ?)`,
        [domain, entityId, state, updatedAt],
      );
    },
    update(
      domain: RuntimeStateDomain,
      entityId: string,
      state: string,
      updatedAt: string,
    ): void {
      const result = context.run(
        `UPDATE runtime_states
         SET state = ?, updated_at = ?
         WHERE domain = ? AND entity_id = ?`,
        [state, updatedAt, domain, entityId],
      );
      if (Number(result.changes) !== 1) {
        throw new Error("Runtime state changed concurrently");
      }
    },
    get(
      domain: RuntimeStateDomain,
      entityId: string,
    ): RuntimeStateRecord | undefined {
      const row = context.get<RuntimeStateRow>(
        `SELECT domain, entity_id, state, updated_at
         FROM runtime_states
         WHERE domain = ? AND entity_id = ?`,
        [domain, entityId],
      );
      return row === undefined
        ? undefined
        : {
            domain: row.domain,
            entityId: row.entity_id,
            state: row.state as TaskRunState | ChangeSetState,
            updatedAt: row.updated_at,
          };
    },
  });
}

function prepareAuditEvent(
  input: {
    readonly correlationId?: string;
    readonly occurredAt?: Date | string;
    readonly type: AuditEventType;
    readonly payload?: unknown;
  },
): Omit<AuditEventRecord, "id"> {
  if (!auditEventTypePattern.test(input.type)) {
    throw new TypeError(`Unsupported audit event type "${input.type}"`);
  }

  return {
    correlationId: resolveCorrelationId(input.correlationId),
    occurredAt: normalizeTimestamp(input.occurredAt),
    type: input.type,
    payload: redactSecrets(input.payload ?? null),
  };
}

function normalizeTimestamp(value: Date | string | undefined): string {
  const timestamp =
    value === undefined
      ? new Date()
      : value instanceof Date
        ? value
        : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new TypeError("Audit event timestamp must be a valid date");
  }
  return timestamp.toISOString();
}

function validateEntityId(entityId: string): string {
  if (entityId.trim().length === 0) {
    throw new TypeError("Runtime state entity ID must not be empty");
  }
  return entityId;
}

function validateRuntimeState(
  domain: RuntimeStateDomain,
  state: TaskRunState | ChangeSetState,
): void {
  const states =
    domain === "task_run" ? taskRunTransitions : changeSetTransitions;
  if (!(state in states)) {
    throw new TypeError(`Invalid ${domain} state "${state}"`);
  }
}

function validateInitialRuntimeState(
  domain: RuntimeStateDomain,
  state: TaskRunState | ChangeSetState,
): void {
  const initialState = domain === "task_run" ? "queued" : "draft";
  if (state !== initialState) {
    throw new TypeError(
      `Cannot initialize ${domain} in state "${state}"; expected "${initialState}"`,
    );
  }
}

function requireRuntimeState(
  state: RuntimeStateRecord | undefined,
): RuntimeStateRecord {
  if (state === undefined) {
    throw new ScaflowError("Runtime state was not found", {
      code: "RUNTIME_STATE_NOT_FOUND",
      suggestion: "Initialize the runtime state before transitioning it",
    });
  }
  return state;
}

function toAuditEventRecord(row: AuditEventRow): AuditEventRecord {
  if (!auditEventTypePattern.test(row.type)) {
    throw new Error(`Stored audit event type "${row.type}" is invalid`);
  }
  return {
    id: row.id,
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at,
    type: row.type as AuditEventType,
    payload: JSON.parse(row.payload_json) as RedactedValue,
  };
}
