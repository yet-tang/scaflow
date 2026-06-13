import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  openStateStore,
  packageName,
  type Migration,
  type RepositoryContext,
} from "../src/index";

const temporaryDirectories: string[] = [];
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "scaflow-state-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.db");
}

function valuesRepository(context: RepositoryContext) {
  return {
    create(): void {
      context.execute(`
        CREATE TABLE values_table (
          id INTEGER PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT
      `);
    },
    insert(value: string): void {
      context.run("INSERT INTO values_table (value) VALUES (?)", [value]);
    },
    list(): readonly string[] {
      return context
        .all<{ value: string }>(
          "SELECT value FROM values_table ORDER BY id",
        )
        .map(({ value }) => value);
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("@scaflow/state", () => {
  it("exposes package identity", () => {
    expect(packageName).toBe("@scaflow/state");
  });

  it("initializes migrations in deterministic order and only once", async () => {
    const databasePath = await temporaryDatabasePath();
    const applied: string[] = [];
    const migrations: Migration[] = [
      {
        version: "002-add-name",
        up(context) {
          applied.push("002-add-name");
          context.execute(
            "ALTER TABLE projects ADD COLUMN name TEXT NOT NULL DEFAULT ''",
          );
        },
      },
      {
        version: "001-create-projects",
        up(context) {
          applied.push("001-create-projects");
          context.execute(`
            CREATE TABLE projects (
              id INTEGER PRIMARY KEY
            ) STRICT
          `);
        },
      },
    ];

    const store = openStateStore(databasePath, { migrations });
    try {
      store.initialize();
      store.initialize();

      expect(applied).toEqual([
        "001-create-projects",
        "002-add-name",
      ]);
      expect(store.appliedMigrationVersions()).toEqual([
        "001-create-projects",
        "002-add-name",
        "007-event-log-and-audit-trail",
      ]);
      expect(
        store.repository((context) =>
          context.all<{ name: string }>(
            "SELECT name FROM projects",
          ),
        ),
      ).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("commits successful transactions and rolls back thrown errors", async () => {
    const databasePath = await temporaryDatabasePath();
    const store = openStateStore(databasePath);
    try {
      store.initialize();
      store.repository(valuesRepository).create();

      store.transaction(({ repository }) => {
        repository(valuesRepository).insert("committed");
      });

      expect(() =>
        store.transaction(({ repository }) => {
          repository(valuesRepository).insert("rolled-back");
          throw new Error("stop");
        }),
      ).toThrow("stop");

      expect(store.repository(valuesRepository).list()).toEqual([
        "committed",
      ]);
    } finally {
      store.close();
    }
  });

  it("expires transaction contexts before rejected async work can mutate state", async () => {
    const databasePath = await temporaryDatabasePath();
    const store = openStateStore(databasePath);
    let expiredContext: RepositoryContext | undefined;
    let expiredTransaction:
      | Parameters<Parameters<typeof store.transaction>[0]>[0]
      | undefined;
    let continueWork: (() => void) | undefined;
    let continuation: Promise<void> | undefined;
    try {
      store.initialize();
      store.repository(valuesRepository).create();
      const wait = new Promise<void>((resolve) => {
        continueWork = resolve;
      });

      expect(() =>
        store.transaction((transaction) => {
          expiredTransaction = transaction;
          continuation = (async () => {
            const repository = transaction.repository(valuesRepository);
            expiredContext = transaction.repository((context) => context);
            repository.insert("rolled-back");
            await wait;
            repository.insert("late-write");
          })();
          return continuation;
        }),
      ).toThrow("State store transaction callbacks must be synchronous");

      continueWork?.();
      await expect(continuation).rejects.toThrow(
        "State store callback context has expired",
      );
      expect(() => expiredTransaction?.repository(valuesRepository)).toThrow(
        "State store callback context has expired",
      );
      expect(() => expiredContext?.execute("SELECT 1")).toThrow(
        "State store callback context has expired",
      );
      expect(() => expiredContext?.run("SELECT 1")).toThrow(
        "State store callback context has expired",
      );
      expect(() => expiredContext?.get("SELECT 1")).toThrow(
        "State store callback context has expired",
      );
      expect(() => expiredContext?.all("SELECT 1")).toThrow(
        "State store callback context has expired",
      );
      expect(store.repository(valuesRepository).list()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rolls back schema and version metadata when a migration fails", async () => {
    const databasePath = await temporaryDatabasePath();
    const store = openStateStore(databasePath, {
      migrations: [
        {
          version: "001-create-first",
          up(context) {
            context.execute(
              "CREATE TABLE first_migration (id INTEGER PRIMARY KEY) STRICT",
            );
          },
        },
        {
          version: "002-failing",
          up(context) {
            context.execute(
              "CREATE TABLE must_rollback (id INTEGER PRIMARY KEY) STRICT",
            );
            throw new Error("migration failed");
          },
        },
      ],
    });

    try {
      expect(() => store.initialize()).toThrow("migration failed");
      expect(
        store.repository((context) =>
          context.get<{ count: number }>(
            `SELECT COUNT(*) AS count
             FROM sqlite_master
             WHERE type = 'table'
               AND name IN (
                 'first_migration',
                 'must_rollback',
                 '_scaflow_schema_migrations'
               )`,
          ),
        ),
      ).toEqual({ count: 0 });
    } finally {
      store.close();
    }
  });

  it("expires migration contexts before rejected async work can mutate state", async () => {
    const databasePath = await temporaryDatabasePath();
    let continueWork: (() => void) | undefined;
    let continuation: Promise<void> | undefined;
    const wait = new Promise<void>((resolve) => {
      continueWork = resolve;
    });
    const store = openStateStore(databasePath, {
      migrations: [
        {
          version: "001-async",
          up(context) {
            continuation = (async () => {
              context.execute(
                "CREATE TABLE must_rollback (id INTEGER PRIMARY KEY) STRICT",
              );
              await wait;
              context.execute(
                "CREATE TABLE late_write (id INTEGER PRIMARY KEY) STRICT",
              );
            })();
            return continuation;
          },
        },
      ],
    });

    try {
      expect(() => store.initialize()).toThrow(
        'Migration "001-async" callbacks must be synchronous',
      );
      continueWork?.();
      await expect(continuation).rejects.toThrow(
        "State store callback context has expired",
      );

      expect(
        store.repository((context) =>
          context.get<{ count: number }>(
            `SELECT COUNT(*) AS count
             FROM sqlite_master
             WHERE type = 'table'
               AND name IN (
                 'must_rollback',
                 'late_write',
                 '_scaflow_schema_migrations'
               )`,
          ),
        ),
      ).toEqual({ count: 0 });
    } finally {
      store.close();
    }
  });

  it("normalizes binary parameters and statement results", async () => {
    const databasePath = await temporaryDatabasePath();
    const store = openStateStore(databasePath);
    try {
      store.initialize();
      store.repository((context) =>
        context.execute(
          "CREATE TABLE blobs (id INTEGER PRIMARY KEY, value BLOB NOT NULL) STRICT",
        ),
      );

      const result = store.repository((context) =>
        context.run("INSERT INTO blobs (value) VALUES (?)", [
          new Uint8Array([1, 2, 3]),
        ]),
      );

      expect(result.changes).toBe(1);
      expect(result.lastInsertRowid).toBe(1);
      expect(
        store.repository((context) =>
          context.get<{ hex_value: string }>(
            "SELECT hex(value) AS hex_value FROM blobs",
          ),
        ),
      ).toEqual({ hex_value: "010203" });
      expect(
        store.repository((context) =>
          context.get("SELECT value FROM blobs WHERE id = ?", [999]),
        ),
      ).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("rejects duplicate versions, nested transactions, and use after close", async () => {
    const databasePath = await temporaryDatabasePath();
    expect(() =>
      openStateStore(databasePath, {
        migrations: [
          { version: "001", up() {} },
          { version: "001", up() {} },
        ],
      }),
    ).toThrow('Duplicate migration version "001"');

    const store = openStateStore(databasePath);
    store.initialize();
    expect(() =>
      store.transaction(() => store.transaction(() => undefined)),
    ).toThrow("Nested state store transactions are not supported");

    store.close();
    store.close();
    expect(() => store.initialize()).toThrow("State store is closed");
  });

  it("uses temporary databases without creating repository-local state", async () => {
    const repositoryStatePath = resolve(repositoryRoot, ".scaflow/state.db");
    expect(existsSync(repositoryStatePath)).toBe(false);

    const databasePath = await temporaryDatabasePath();
    const store = openStateStore(databasePath);
    store.initialize();
    store.close();

    expect(existsSync(databasePath)).toBe(true);
    expect((await readFile(databasePath)).byteLength).toBeGreaterThan(0);
    expect(existsSync(repositoryStatePath)).toBe(false);
  });
});
