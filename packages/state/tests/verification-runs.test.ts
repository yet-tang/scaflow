import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  completeVerificationRun,
  createVerificationRun,
  getVerificationRun,
  listAuditEvents,
  listVerificationRuns,
  openStateStore,
  type StateStore,
} from "../src/index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("verification run persistence", () => {
  it("persists creation and terminal completion across store reopening", async () => {
    const databasePath = await temporaryDatabasePath();
    let store = openStore(databasePath);
    createVerificationRun(store, {
      id: "verification-1",
      taskRunId: "task-run-1",
      startedAt: "2026-07-17T00:00:00.000Z",
      correlationId: "verification-test",
    });
    const completed = completeVerificationRun(store, {
      id: "verification-1",
      result: passingResult(),
      completedAt: "2026-07-17T00:00:01.000Z",
      correlationId: "verification-test",
    });
    expect(completed.status).toBe("passed");
    store.close();

    store = openStore(databasePath);
    try {
      expect(getVerificationRun(store, "verification-1")).toEqual(completed);
      expect(listVerificationRuns(store, "task-run-1")).toEqual([completed]);
      expect(listAuditEvents(store).map(({ type }) => type)).toEqual([
        "verification.started",
        "verification.completed",
      ]);
    } finally {
      store.close();
    }
  });

  it("rejects duplicate IDs and mutation after terminal completion", async () => {
    const store = openStore(await temporaryDatabasePath());
    try {
      const input = { id: "verification-1", taskRunId: "task-run-1" };
      createVerificationRun(store, input);
      expect(() => createVerificationRun(store, input)).toThrow();
      completeVerificationRun(store, { id: input.id, result: passingResult() });
      expect(() =>
        completeVerificationRun(store, { id: input.id, result: passingResult() }),
      ).toThrow("already terminal");
      expect(listAuditEvents(store)).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("reloads ordered failures and artifact references for a failed run", async () => {
    const store = openStore(await temporaryDatabasePath());
    try {
      createVerificationRun(store, {
        id: "verification-failed",
        taskRunId: "task-run-1",
        startedAt: "2026-07-17T00:00:00.000Z",
      });
      const failure = {
        code: "COMMAND_FAILED",
        category: "execution",
        repairability: "repairable",
        message: "Command exited with code 1",
      } as const;
      const artifact = {
        id: "command-stderr",
        path: "verification/failed/stderr.txt",
        media_type: "text/plain",
        byte_length: 5,
        sha256: "a".repeat(64),
      } as const;
      const result = {
        status: "failed",
        verifier_results: [
          {
            verifier_id: "commands",
            status: "failed",
            summary: "Command failed",
            failures: [failure],
            artifacts: [artifact],
          },
        ],
        failures: [failure],
        artifacts: [artifact],
      } as const;
      const completed = completeVerificationRun(store, {
        id: "verification-failed",
        result,
        completedAt: "2026-07-17T00:00:01.000Z",
      });

      expect(getVerificationRun(store, completed.id)).toEqual(completed);
      expect(completed).toMatchObject({
        status: "failed",
        failures: [{ repairability: "repairable" }],
        artifacts: [{ path: "verification/failed/stderr.txt" }],
      });
    } finally {
      store.close();
    }
  });

  it("atomically rolls back a run when its lifecycle event fails", async () => {
    const store = openStore(await temporaryDatabasePath());
    try {
      store.repository((context) =>
        context.execute(`
          CREATE TRIGGER reject_verification_event
          BEFORE INSERT ON audit_events
          WHEN NEW.type = 'verification.started'
          BEGIN
            SELECT RAISE(ABORT, 'injected verification event failure');
          END
        `),
      );
      expect(() =>
        createVerificationRun(store, { id: "verification-rollback", taskRunId: "task-run-1" }),
      ).toThrow("injected verification event failure");
      expect(getVerificationRun(store, "verification-rollback")).toBeUndefined();
      expect(listAuditEvents(store)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("redacts secret-bearing lifecycle audit details", async () => {
    const store = openStore(await temporaryDatabasePath());
    try {
      createVerificationRun(store, {
        id: "verification-redaction",
        taskRunId: "task-run-1",
        correlationId: "redaction-test",
        auditPayload: { token: "super-secret" },
      });
      expect(listAuditEvents(store)[0]).toMatchObject({
        correlationId: "redaction-test",
        payload: { details: { token: "[REDACTED]" } },
      });
    } finally {
      store.close();
    }
  });
});

function passingResult() {
  return {
    status: "passed",
    verifier_results: [
      { verifier_id: "fixture", status: "passed", summary: "Passed", failures: [], artifacts: [] },
    ],
    failures: [],
    artifacts: [],
  } as const;
}

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "scaflow-verification-state-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.db");
}

function openStore(databasePath: string): StateStore {
  const store = openStateStore(databasePath);
  store.initialize();
  return store;
}
