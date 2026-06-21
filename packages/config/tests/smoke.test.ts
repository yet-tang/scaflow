import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConfigFileError,
  listTaskContracts,
  loadTaskContract,
  loadProjectConfig,
  packageName,
  validateLocalProject,
} from "../src/index";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("@scaflow/config", () => {
  it("exposes package identity", () => {
    expect(packageName).toBe("@scaflow/config");
  });

  it("validates local project and repository configuration files", async () => {
    const directory = await temporaryDirectory("scaflow-config-");
    await writeFile(
      join(directory, "scaflow.yaml"),
      `${JSON.stringify({
        version: 1,
        project: { id: "beauty-ai", name: "Beauty AI" },
        engine: { version: "0.1.0" },
      })}\n`,
    );
    await writeFile(
      join(directory, "repositories.yaml"),
      `${JSON.stringify({
        version: 1,
        repositories: [
          {
            id: "app",
            name: "Application",
            git_url: "https://github.com/example/app.git",
            default_branch: "main",
            checkout_directory: "apps/app",
            type: "application",
          },
        ],
      })}\n`,
    );

    await expect(validateLocalProject(directory)).resolves.toMatchObject({
      projectConfig: {
        project: { id: "beauty-ai", name: "Beauty AI" },
      },
      repositoryManifest: {
        repositories: [{ id: "app" }],
      },
    });
  });

  it("returns structured schema errors for invalid config files", async () => {
    const directory = await temporaryDirectory("scaflow-config-invalid-");
    await writeFile(
      join(directory, "scaflow.yaml"),
      `${JSON.stringify({
        version: 1,
        project: { id: "beauty-ai" },
        engine: { version: "0.1.0" },
      })}\n`,
    );

    await expect(
      loadProjectConfig(directory, { correlationId: "config-test" }),
    ).rejects.toMatchObject({
      code: "SCHEMA_PARSE_FAILED",
      correlationId: "config-test",
      issues: [
        expect.objectContaining({
          code: "invalid_type",
          path: ["project", "name"],
        }),
      ],
    });
  });

  it("returns structured file errors for missing config files", async () => {
    const directory = await temporaryDirectory("scaflow-config-missing-");

    await expect(
      loadProjectConfig(directory, { correlationId: "missing-test" }),
    ).rejects.toBeInstanceOf(ConfigFileError);
    await expect(
      loadProjectConfig(directory, { correlationId: "missing-test" }),
    ).rejects.toMatchObject({
      code: "CONFIG_FILE_NOT_FOUND",
      correlationId: "missing-test",
    });
  });

  it("loads and validates Task Contracts from tasks/<task-id>/contract.yaml", async () => {
    const directory = await temporaryDirectory("scaflow-config-task-");
    await writeTaskContract(directory, "SFL-999", validTaskContractYaml());

    await expect(loadTaskContract(directory, "SFL-999")).resolves.toMatchObject({
      version: 1,
      task: {
        id: "SFL-999",
        title: "Task Contract",
        definition_state: "ready",
      },
      repositories: {
        primary: "@control",
        scopes: [
          {
            access: "read-write",
            allowed_paths: ["packages/schemas/**"],
          },
        ],
      },
      verification: {
        commands: [
          {
            args: ["--filter", "@scaflow/schemas", "test", "HEAD:main"],
          },
        ],
      },
    });
  });

  it("loads Task Contract verification commands with inline YAML args arrays", async () => {
    const directory = await temporaryDirectory("scaflow-config-task-inline-");
    await writeTaskContract(
      directory,
      "SFL-999",
      validTaskContractYaml().replace(
        `args:
        - --filter
        - "@scaflow/schemas"
        - test
        - HEAD:main`,
        `args: ["--filter", "@scaflow/schemas", "test", "HEAD:main"]`,
      ),
    );

    await expect(loadTaskContract(directory, "SFL-999")).resolves.toMatchObject({
      verification: {
        commands: [
          {
            args: ["--filter", "@scaflow/schemas", "test", "HEAD:main"],
          },
        ],
      },
    });
  });

  it("lists Task Contracts in deterministic task ID order", async () => {
    const directory = await temporaryDirectory("scaflow-config-task-list-");
    await writeTaskContract(
      directory,
      "SFL-100",
      validTaskContractYaml("SFL-100"),
    );
    await writeTaskContract(
      directory,
      "SFL-001",
      validTaskContractYaml("SFL-001"),
    );

    await expect(listTaskContracts(directory)).resolves.toMatchObject([
      { task: { id: "SFL-001" } },
      { task: { id: "SFL-100" } },
    ]);
  });

  it("returns structured errors for invalid or missing Task Contracts", async () => {
    const directory = await temporaryDirectory("scaflow-config-task-invalid-");
    await writeTaskContract(
      directory,
      "SFL-999",
      validTaskContractYaml().replace(
        "allowed_paths:\n        - packages/schemas/**",
        "allowed_paths: []",
      ),
    );

    await expect(
      loadTaskContract(directory, "SFL-999", { correlationId: "task-invalid" }),
    ).rejects.toMatchObject({
      code: "SCHEMA_PARSE_FAILED",
      correlationId: "task-invalid",
      issues: [
        expect.objectContaining({
          code: "custom",
          path: ["repositories", "scopes", 0, "allowed_paths"],
        }),
      ],
    });

    await expect(
      loadTaskContract(directory, "../SFL-999", { correlationId: "task-path" }),
    ).rejects.toMatchObject({
      code: "TASK_ID_INVALID",
      correlationId: "task-path",
    });

    await expect(
      loadTaskContract(directory, "SFL-404", { correlationId: "task-missing" }),
    ).rejects.toMatchObject({
      code: "TASK_CONTRACT_NOT_FOUND",
      correlationId: "task-missing",
    });
  });
});

async function writeTaskContract(
  directory: string,
  taskId: string,
  contents: string,
): Promise<void> {
  const taskDirectory = join(directory, "tasks", taskId);
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(join(taskDirectory, "contract.yaml"), contents);
}

function validTaskContractYaml(taskId = "SFL-999"): string {
  return `version: 1
task:
  id: ${taskId}
  title: Task Contract
  type: schema
  risk_level: R2
  definition_state: ready
objective:
  summary: Implement Task Contract schema.
source_requirements:
  - id: FR-005
    document: docs/source/scaflow-v0.1.0-prd.md
source_references:
  - document: docs/exec-plans/scaflow-v0.1.0.md
    section: Task Contract Schema v1
dependencies:
  - SFL-003
dependency_changes: forbidden
repositories:
  primary: "@control"
  scopes:
    - repository: "@control"
      access: read-write
      allowed_paths:
        - packages/schemas/**
      forbidden_paths:
        - workspace/**
        - .scaflow/**
acceptance_criteria:
  - id: ${taskId}-AC-01
    description: Task Contract schema validates contract fields.
verification:
  commands:
    - repository: "@control"
      executable: pnpm
      args:
        - --filter
        - "@scaflow/schemas"
        - test
        - HEAD:main
      timeout_seconds: 300
      required: true
retry_policy:
  max_attempts: 2
  max_repair_rounds_per_attempt: 3
  escalate_after_same_failure: 2
`;
}
