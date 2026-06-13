import sqlite3 from "node-sqlite3-wasm";

const { Database } = sqlite3;

export const packageName = "@scaflow/state";

export {
  StateTransitionError,
  changeSetTransitions,
  stateAuthorities,
  taskDefinitionTransitions,
  taskRunTransitions,
  validateChangeSetTransition,
  validateTaskDefinitionTransition,
  validateTaskRunTransition,
  type StateAuthority,
  type StateDomain,
  type StateTransitionErrorOptions,
  type StateTransitionRejectionReason,
  type TaskCompletionEvidence,
  type TaskDefinitionTransitionOptions,
} from "./domain-state-machines.js";
export type {
  ChangeSetState,
  TaskDefinitionState,
  TaskRunState,
} from "@scaflow/schemas";

const migrationTableName = "_scaflow_schema_migrations";

export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlParameters = readonly SqlValue[];
export type SqlRow = Record<string, unknown>;

export interface StatementResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

export interface RepositoryContext {
  execute(sql: string): void;
  run(sql: string, parameters?: SqlParameters): StatementResult;
  get<Row extends SqlRow>(
    sql: string,
    parameters?: SqlParameters,
  ): Row | undefined;
  all<Row extends SqlRow>(
    sql: string,
    parameters?: SqlParameters,
  ): readonly Row[];
}

export type RepositoryFactory<Repository> = (
  context: RepositoryContext,
) => Repository;

export interface TransactionContext {
  repository<Repository>(
    factory: RepositoryFactory<Repository>,
  ): Repository;
}

export interface Migration {
  readonly version: string;
  up(context: RepositoryContext): void;
}

export interface OpenStateStoreOptions {
  readonly migrations?: readonly Migration[];
}

export class StateStore {
  readonly #database: InstanceType<typeof Database>;
  readonly #migrations: readonly Migration[];
  readonly #repositoryContext: RepositoryContext;
  #closed = false;
  #transactionActive = false;

  private constructor(
    databasePath: string,
    options: OpenStateStoreOptions = {},
  ) {
    this.#migrations = validateMigrations(options.migrations ?? []);
    this.#database = new Database(databasePath);
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA busy_timeout = 5000");

    this.#repositoryContext = this.#createRepositoryContext();
  }

  #createRepositoryContext(
    isActive: () => boolean = () => true,
  ): RepositoryContext {
    const assertAvailable = () => {
      this.#assertOpen();
      if (!isActive()) {
        throw new Error("State store callback context has expired");
      }
    };

    return Object.freeze({
      execute: (sql: string) => {
        assertAvailable();
        this.#database.exec(sql);
      },
      run: (sql: string, parameters: SqlParameters = []) => {
        assertAvailable();
        const result = this.#database.run(sql, [...parameters]);
        return {
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid,
        };
      },
      get: <Row extends SqlRow>(
        sql: string,
        parameters: SqlParameters = [],
      ) => {
        assertAvailable();
        return (this.#database.get(sql, [...parameters]) as Row | null) ??
          undefined;
      },
      all: <Row extends SqlRow>(
        sql: string,
        parameters: SqlParameters = [],
      ) => {
        assertAvailable();
        return this.#database.all(sql, [...parameters]) as Row[];
      },
    });
  }

  static open(
    databasePath: string,
    options: OpenStateStoreOptions = {},
  ): StateStore {
    return new StateStore(databasePath, options);
  }

  initialize(): void {
    this.#assertOpen();
    this.transaction(() => {
      this.#repositoryContext.execute(`
        CREATE TABLE IF NOT EXISTS ${migrationTableName} (
          version TEXT PRIMARY KEY NOT NULL,
          applied_at TEXT NOT NULL
        ) STRICT
      `);

      const appliedVersions = new Set(
        this.#repositoryContext
          .all<{ version: string }>(
            `SELECT version FROM ${migrationTableName}`,
          )
          .map(({ version }) => version),
      );

      for (const migration of this.#migrations) {
        if (appliedVersions.has(migration.version)) {
          continue;
        }

        let active = true;
        const migrationContext = this.#createRepositoryContext(() => active);
        let result: unknown;
        try {
          result = migration.up(migrationContext);
        } finally {
          active = false;
        }
        assertSynchronous(result, `Migration "${migration.version}"`);
        this.#repositoryContext.run(
          `INSERT INTO ${migrationTableName} (version, applied_at)
           VALUES (?, ?)`,
          [migration.version, new Date().toISOString()],
        );
      }
    });
  }

  appliedMigrationVersions(): readonly string[] {
    this.#assertOpen();
    return this.#repositoryContext
      .all<{ version: string }>(
        `SELECT version
         FROM ${migrationTableName}
         ORDER BY version`,
      )
      .map(({ version }) => version);
  }

  repository<Repository>(
    factory: RepositoryFactory<Repository>,
  ): Repository {
    this.#assertOpen();
    return factory(this.#repositoryContext);
  }

  transaction<Result>(
    work: (context: TransactionContext) => Result,
  ): Result {
    this.#assertOpen();
    if (this.#transactionActive) {
      throw new Error("Nested state store transactions are not supported");
    }

    this.#database.exec("BEGIN IMMEDIATE");
    this.#transactionActive = true;
    let active = true;
    const repositoryContext = this.#createRepositoryContext(() => active);
    const transactionContext: TransactionContext = Object.freeze({
      repository: <Repository>(
        factory: RepositoryFactory<Repository>,
      ): Repository => {
        if (!active) {
          throw new Error("State store callback context has expired");
        }
        return factory(repositoryContext);
      },
    });
    try {
      let result: Result;
      try {
        result = work(transactionContext);
      } finally {
        active = false;
      }
      assertSynchronous(result, "State store transaction");
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "State store transaction and rollback both failed",
        );
      }
      throw error;
    } finally {
      this.#transactionActive = false;
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    if (this.#transactionActive) {
      throw new Error("Cannot close the state store during a transaction");
    }
    this.#database.close();
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("State store is closed");
    }
  }
}

export function openStateStore(
  databasePath: string,
  options: OpenStateStoreOptions = {},
): StateStore {
  return StateStore.open(databasePath, options);
}

function validateMigrations(
  migrations: readonly Migration[],
): readonly Migration[] {
  const sorted = migrations
    .map(({ version, up }) => Object.freeze({ version, up }))
    .sort((left, right) =>
      left.version < right.version
        ? -1
        : left.version > right.version
          ? 1
          : 0,
    );
  const versions = new Set<string>();

  for (const migration of sorted) {
    if (migration.version.trim().length === 0) {
      throw new Error("Migration versions must not be empty");
    }
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate migration version "${migration.version}"`);
    }
    versions.add(migration.version);
  }

  return Object.freeze(sorted);
}

function assertSynchronous(
  value: unknown,
  operation: string,
): asserts value is Exclude<unknown, PromiseLike<unknown>> {
  if (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  ) {
    throw new TypeError(`${operation} callbacks must be synchronous`);
  }
}
