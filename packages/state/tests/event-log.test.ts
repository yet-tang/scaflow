import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CIRCULAR_VALUE,
  REDACTED_VALUE,
  UNSUPPORTED_VALUE,
} from "@scaflow/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  StateTransitionError,
  getRuntimeState,
  initializeRuntimeState,
  listAuditEvents,
  openStateStore,
  recordAuditEvent,
  transitionRuntimeState,
  type AuditEventInput,
  type InitializeRuntimeStateInput,
  type StateStore,
} from "../src/index";

const temporaryDirectories: string[] = [];

async function openTemporaryStore(): Promise<StateStore> {
  const directory = await mkdtemp(join(tmpdir(), "scaflow-events-"));
  temporaryDirectories.push(directory);
  const store = openStateStore(join(directory, "state.db"));
  store.initialize();
  return store;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("event log and audit trail", () => {
  it("records supported audit activity with deterministic ordering", async () => {
    const store = await openTemporaryStore();
    try {
      for (const [index, type] of ([
        "task_run.started",
        "command.completed",
        "verification.failed",
      ] as const).entries()) {
        recordAuditEvent(store, {
          correlationId: `run-${index}`,
          occurredAt: `2026-06-13T01:02:0${index}.123+08:00`,
          type,
          payload: { index },
        });
      }

      expect(listAuditEvents(store)).toEqual([
        {
          id: 1,
          correlationId: "run-0",
          occurredAt: "2026-06-12T17:02:00.123Z",
          type: "task_run.started",
          payload: { index: 0 },
        },
        {
          id: 2,
          correlationId: "run-1",
          occurredAt: "2026-06-12T17:02:01.123Z",
          type: "command.completed",
          payload: { index: 1 },
        },
        {
          id: 3,
          correlationId: "run-2",
          occurredAt: "2026-06-12T17:02:02.123Z",
          type: "verification.failed",
          payload: { index: 2 },
        },
      ]);
    } finally {
      store.close();
    }
  });

  it("redacts payloads before serialization without mutating input", async () => {
    const store = await openTemporaryStore();
    const circular: Record<string, unknown> = {
      password: "nested-secret",
      message: 'authorization="text-secret"',
      items: [{ apiKey: "array-secret" }, Symbol("unsupported")],
      custom: new Map([["token", "map-secret"]]),
    };
    circular.self = circular;

    try {
      recordAuditEvent(store, {
        correlationId: "redaction-test",
        occurredAt: new Date("2026-06-13T00:00:00.000Z"),
        type: "command.completed",
        payload: circular,
      });

      const [event] = listAuditEvents(store);
      expect(event?.payload).toEqual({
        password: REDACTED_VALUE,
        message: `authorization="${REDACTED_VALUE}"`,
        items: [{ apiKey: REDACTED_VALUE }, UNSUPPORTED_VALUE],
        custom: UNSUPPORTED_VALUE,
        self: CIRCULAR_VALUE,
      });
      expect(circular.password).toBe("nested-secret");

      const persisted = JSON.stringify(event);
      for (const secret of [
        "nested-secret",
        "text-secret",
        "array-secret",
        "map-secret",
      ]) {
        expect(persisted).not.toContain(secret);
      }
    } finally {
      store.close();
    }
  });

  it("initializes and transitions runtime state with its event atomically", async () => {
    const store = await openTemporaryStore();
    try {
      expect(
        initializeRuntimeState(store, {
          domain: "task_run",
          entityId: "run-123",
          state: "queued",
          correlationId: "workflow-123",
          occurredAt: "2026-06-13T00:00:00Z",
        }),
      ).toEqual({
        domain: "task_run",
        entityId: "run-123",
        state: "queued",
        updatedAt: "2026-06-13T00:00:00.000Z",
      });

      expect(
        transitionRuntimeState(store, {
          domain: "task_run",
          entityId: "run-123",
          to: "preparing",
          correlationId: "workflow-123",
          occurredAt: "2026-06-13T00:01:00Z",
          payload: { token: "transition-secret", reason: "start" },
        }),
      ).toEqual({
        domain: "task_run",
        entityId: "run-123",
        state: "preparing",
        updatedAt: "2026-06-13T00:01:00.000Z",
      });

      expect(listAuditEvents(store)).toEqual([
        expect.objectContaining({
          id: 1,
          type: "state_transition.initialized",
          correlationId: "workflow-123",
          payload: expect.objectContaining({
            action: "initialized",
            state: "queued",
          }),
        }),
        expect.objectContaining({
          id: 2,
          type: "state_transition.applied",
          correlationId: "workflow-123",
          payload: {
            domain: "task_run",
            entityId: "run-123",
            from: "queued",
            to: "preparing",
            details: {
              token: REDACTED_VALUE,
              reason: "start",
            },
          },
        }),
      ]);
    } finally {
      store.close();
    }
  });

  it.each([
    ["task_run", "preparing"],
    ["task_run", "succeeded"],
    ["change_set", "verified"],
    ["change_set", "merged"],
  ] as const)(
    "rejects %s initialization in non-initial state %s without persistence",
    async (domain, state) => {
      const store = await openTemporaryStore();
      try {
        expect(() =>
          initializeRuntimeState(store, {
            domain,
            entityId: `${domain}-${state}`,
            state,
            correlationId: "invalid-initial-state",
          } as InitializeRuntimeStateInput),
        ).toThrow(`Cannot initialize ${domain} in state "${state}"`);

        expect(
          getRuntimeState(store, domain, `${domain}-${state}`),
        ).toBeUndefined();
        expect(listAuditEvents(store)).toEqual([]);
      } finally {
        store.close();
      }
    },
  );

  it("prevents generic callers from forging authoritative state events", async () => {
    const store = await openTemporaryStore();
    try {
      initializeRuntimeState(store, {
        domain: "task_run",
        entityId: "existing-run",
        state: "queued",
        correlationId: "authoritative-state",
      });

      for (const type of [
        "state_transition.initialized",
        "state_transition.applied",
      ] as const) {
        for (const entityId of ["existing-run", "nonexistent-run"]) {
          expect(() =>
            recordAuditEvent(store, {
              correlationId: "forged-state",
              type,
              payload: {
                domain: "task_run",
                entityId,
              },
            } as AuditEventInput),
          ).toThrow(
            "State transition events must be recorded through runtime state APIs",
          );
        }
      }

      expect(getRuntimeState(store, "task_run", "existing-run")).toMatchObject({
        state: "queued",
      });
      expect(
        getRuntimeState(store, "task_run", "nonexistent-run"),
      ).toBeUndefined();
      expect(listAuditEvents(store)).toEqual([
        expect.objectContaining({
          id: 1,
          type: "state_transition.initialized",
        }),
      ]);
    } finally {
      store.close();
    }
  });

  it("uses the ChangeSet validator independently from TaskRun state", async () => {
    const store = await openTemporaryStore();
    try {
      initializeRuntimeState(store, {
        domain: "change_set",
        entityId: "change-123",
        state: "draft",
        correlationId: "change-workflow",
      });
      transitionRuntimeState(store, {
        domain: "change_set",
        entityId: "change-123",
        to: "verified",
        correlationId: "change-workflow",
      });

      expect(getRuntimeState(store, "change_set", "change-123")).toMatchObject({
        state: "verified",
      });
    } finally {
      store.close();
    }
  });

  it("persists neither state nor event for an illegal transition", async () => {
    const store = await openTemporaryStore();
    try {
      initializeRuntimeState(store, {
        domain: "task_run",
        entityId: "run-illegal",
        state: "queued",
        correlationId: "illegal-transition",
      });

      expect(() =>
        transitionRuntimeState(store, {
          domain: "task_run",
          entityId: "run-illegal",
          to: "succeeded",
          correlationId: "illegal-transition",
        }),
      ).toThrowError(StateTransitionError);

      expect(getRuntimeState(store, "task_run", "run-illegal")).toMatchObject({
        state: "queued",
      });
      expect(listAuditEvents(store)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("rolls back a state update when the corresponding event write fails", async () => {
    const store = await openTemporaryStore();
    try {
      initializeRuntimeState(store, {
        domain: "task_run",
        entityId: "run-rollback",
        state: "queued",
        correlationId: "rollback-test",
      });
      store.repository((context) =>
        context.execute(`
          CREATE TRIGGER reject_transition_event
          BEFORE INSERT ON audit_events
          WHEN NEW.type = 'state_transition.applied'
          BEGIN
            SELECT RAISE(ABORT, 'injected event failure');
          END
        `),
      );

      expect(() =>
        transitionRuntimeState(store, {
          domain: "task_run",
          entityId: "run-rollback",
          to: "preparing",
          correlationId: "rollback-test",
        }),
      ).toThrow("injected event failure");

      expect(getRuntimeState(store, "task_run", "run-rollback")).toMatchObject({
        state: "queued",
      });
      expect(listAuditEvents(store)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("rejects invalid metadata before persisting an event", async () => {
    const store = await openTemporaryStore();
    try {
      expect(() =>
        recordAuditEvent(store, {
          correlationId: "token=secret",
          type: "command.completed",
        }),
      ).toThrow("Correlation ID must be a safe ASCII identifier");
      expect(() =>
        recordAuditEvent(store, {
          correlationId: "valid-id",
          occurredAt: "not-a-date",
          type: "verification.completed",
        }),
      ).toThrow("Audit event timestamp must be a valid date");
      expect(() =>
        recordAuditEvent(store, {
          correlationId: "valid-id",
          type: "unknown" as "command.completed",
        }),
      ).toThrow('Unsupported audit event type "unknown"');
      expect(() =>
        initializeRuntimeState(store, {
          domain: "task_run",
          entityId: "invalid-state",
          state: "draft" as "queued",
          correlationId: "valid-id",
        }),
      ).toThrow('Invalid task_run state "draft"');
      expect(listAuditEvents(store)).toEqual([]);
    } finally {
      store.close();
    }
  });
});
