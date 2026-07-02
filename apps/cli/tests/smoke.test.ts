import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ScaflowError } from "@scaflow/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  CLI_NAME,
  GIT_INIT_ERROR_CODE,
  NOT_IMPLEMENTED_ERROR_CODE,
  createCliProgram,
  packageName,
  renderError,
  runCli,
} from "../src/index";

const execFileAsync = promisify(execFile);
const CLI_GIT_TEST_TIMEOUT_MS = 15_000;
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

describe("@scaflow/cli", () => {
  it("exposes package identity", () => {
    expect(packageName).toBe("@scaflow/cli");
  });

  it("registers the complete v0.1.0 command tree", () => {
    const program = createCliProgram();
    const registered = new Map(
      program.commands.map((command) => [
        command.name(),
        command.commands.map((child) => child.name()),
      ]),
    );

    expect(program.name()).toBe(CLI_NAME);
    expect([...registered]).toEqual([
      ["init", []],
      ["validate", []],
      ["bootstrap", []],
      ["doctor", []],
      ["repo", ["status"]],
      ["workspace", ["status", "sync"]],
      [
        "task",
        ["list", "show", "validate", "prepare", "run", "status", "cancel"],
      ],
      ["run", ["inspect", "clean"]],
      ["changeset", ["show", "list"]],
    ]);
  });

  it("renders root help without terminating the process", async () => {
    const output = createOutput();

    const exitCode = await runCli({
      argv: ["--help"],
      io: output.io,
    });

    expect(exitCode).toBe(0);
    expect(output.stdout()).toContain("Usage: scaflow [options] [command]");
    expect(output.stdout()).toContain("--json");
    expect(output.stdout()).toContain("task");
    expect(output.stderr()).toBe("");
  });

  it("returns a stable human-readable error for nested stubs", async () => {
    const output = createOutput();

    const exitCode = await runCli({
      argv: ["task", "run", "TASK-123"],
      io: output.io,
      createCorrelationId: () => "test-human-error",
    });

    expect(exitCode).toBe(1);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toBe(
      [
        `Error [${NOT_IMPLEMENTED_ERROR_CODE}]: Command "task run" is not implemented in Scaflow v0.1.0 yet`,
        "Correlation ID: test-human-error",
        "Suggestion: Use --help to inspect the available command surface",
        "",
      ].join("\n"),
    );
  });

  it("prepares a TaskRun workspace and records runtime state", async () => {
    const fixture = await createCliProjectWithRemote("scaflow-cli-prepare-");
    await writeTaskContract(
      fixture.projectDir,
      "SFL-017",
      taskPrepareContractYaml(),
    );
    await git(fixture.projectDir, "add", "tasks/SFL-017/contract.yaml");
    await git(fixture.projectDir, "commit", "-m", "Add SFL-017 contract");
    expect(
      await runCli({
        argv: ["bootstrap"],
        cwd: fixture.projectDir,
        io: createOutput().io,
      }),
    ).toBe(0);
    const output = createOutput();

    const exitCode = await runCli({
      argv: ["--json", "task", "prepare", "SFL-017", "--run-id", "run-cli"],
      cwd: fixture.projectDir,
      io: output.io,
      createCorrelationId: () => "task-prepare",
    });

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    const result = JSON.parse(output.stdout()) as {
      taskRun: {
        taskId: string;
        taskRunId: string;
        bundleRoot: string;
        revisionSetPath: string;
        repositories: Array<{ id: string; mode: string }>;
      };
      state: { state: string };
    };
    expect(result).toMatchObject({
      taskRun: {
        taskId: "SFL-017",
        taskRunId: "run-cli",
        repositories: [
          { id: "@control", mode: "branch" },
          { id: "app", mode: "detached" },
        ],
      },
      state: { state: "running" },
    });
    await expect(stat(join(result.taskRun.bundleRoot, ".git"))).rejects.toThrow();
    await expect(readFile(result.taskRun.revisionSetPath, "utf8")).resolves.toContain(
      '"id": "app"',
    );
  }, CLI_GIT_TEST_TIMEOUT_MS);

  it.each([
    ["before", ["--json", "changeset", "show"]],
    ["after", ["changeset", "show", "--json"]],
  ])("renders valid JSON errors when --json appears %s the command", async (
    _position,
    argv,
  ) => {
    const output = createOutput();

    const exitCode = await runCli({
      argv,
      io: output.io,
      createCorrelationId: () => "test-json-error",
    });

    expect(exitCode).toBe(1);
    expect(output.stdout()).toBe("");
    expect(JSON.parse(output.stderr())).toEqual({
      error: {
        name: "ScaflowError",
        message:
          'Command "changeset show" is not implemented in Scaflow v0.1.0 yet',
        code: NOT_IMPLEMENTED_ERROR_CODE,
        recoverable: false,
        correlationId: "test-json-error",
        suggestion: "Use --help to inspect the available command surface",
        details: { command: "changeset show" },
      },
    });
  });

  it("redacts secret-like values from JSON error output", () => {
    const output = createOutput();
    const error = new ScaflowError(
      "Failed with token=visible-message-secret",
      {
        code: "TEST_ERROR",
        recoverable: true,
        suggestion: "Replace apiKey=visible-suggestion-secret",
        correlationId: "test-redaction",
        details: { password: "visible-detail-secret" },
      },
    );

    renderError(error, true, output.io.stderr);

    const rendered = output.stderr();
    expect(rendered).not.toContain("visible-message-secret");
    expect(rendered).not.toContain("visible-suggestion-secret");
    expect(rendered).not.toContain("visible-detail-secret");
    expect(JSON.parse(rendered)).toMatchObject({
      error: {
        code: "TEST_ERROR",
        recoverable: true,
        correlationId: "test-redaction",
        details: { password: "[REDACTED]" },
      },
    });
  });

  it("initializes a valid Scaflow project in an empty directory", async () => {
    const directory = await temporaryDirectory("scaflow-cli-init-");
    const output = createOutput();

    const exitCode = await runCli({
      argv: ["init", "Beauty AI"],
      cwd: directory,
      io: output.io,
    });

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    expect(output.stdout()).toContain('Initialized Scaflow project "Beauty AI"');
    expect((await stat(join(directory, ".git"))).isDirectory()).toBe(true);
    expect(
      JSON.parse(await readFile(join(directory, "scaflow.yaml"), "utf8")),
    ).toMatchObject({
      project: { id: "beauty-ai", name: "Beauty AI" },
      engine: { version: "0.1.0" },
    });
    expect(
      JSON.parse(await readFile(join(directory, "repositories.yaml"), "utf8")),
    ).toMatchObject({
      repositories: [{ id: "app", checkout_directory: "apps/app" }],
    });
    expect(await runCli({ argv: ["validate"], cwd: directory, io: output.io }))
      .toBe(0);
  });

  it("preserves user-modified files when init is repeated", async () => {
    const directory = await temporaryDirectory("scaflow-cli-init-repeat-");
    const output = createOutput();

    expect(
      await runCli({
        argv: ["init", "Beauty AI"],
        cwd: directory,
        io: output.io,
      }),
    ).toBe(0);
    await writeFile(join(directory, "PRODUCT.md"), "user content\n");

    const repeatOutput = createOutput();
    expect(
      await runCli({
        argv: ["--json", "init", "Beauty AI"],
        cwd: directory,
        io: repeatOutput.io,
      }),
    ).toBe(0);

    expect(await readFile(join(directory, "PRODUCT.md"), "utf8")).toBe(
      "user content\n",
    );
    expect(JSON.parse(repeatOutput.stdout())).toMatchObject({
      created: [],
      skipped: expect.arrayContaining(["PRODUCT.md"]),
    });
    expect((await stat(join(directory, ".git"))).isDirectory()).toBe(true);
  });

  it("returns structured JSON errors when Git initialization fails", async () => {
    const directory = await temporaryDirectory("scaflow-cli-init-git-fail-");
    const output = createOutput();

    const exitCode = await runCli({
      argv: ["--json", "init", "Beauty AI"],
      cwd: directory,
      io: output.io,
      gitExecutable: "scaflow-missing-git-for-test",
      createCorrelationId: () => "git-init-failed",
    });

    expect(exitCode).toBe(1);
    expect(output.stdout()).toBe("");
    expect(JSON.parse(output.stderr())).toMatchObject({
      error: {
        code: GIT_INIT_ERROR_CODE,
        correlationId: "git-init-failed",
        suggestion:
          "Install Git or initialize the project in a writable directory",
        details: {
          command: {
            executable: "scaflow-missing-git-for-test",
            args: ["init"],
            cwd: directory,
          },
          exitCode: null,
          spawnCode: "ENOENT",
        },
      },
    });
  });

  it("validates a generated project with JSON output", async () => {
    const directory = await temporaryDirectory("scaflow-cli-validate-");
    expect(
      await runCli({
        argv: ["init", "Beauty AI"],
        cwd: directory,
        io: createOutput().io,
      }),
    ).toBe(0);
    const output = createOutput();

    const exitCode = await runCli({
      argv: ["--json", "validate"],
      cwd: directory,
      io: output.io,
    });

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    expect(JSON.parse(output.stdout())).toEqual({ valid: true });
  });

  it("returns structured JSON errors for invalid project config", async () => {
    const directory = await temporaryDirectory("scaflow-cli-invalid-project-");
    await writeFile(
      join(directory, "scaflow.yaml"),
      `${JSON.stringify({
        version: 1,
        project: { id: "beauty-ai" },
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
    const output = createOutput();

    const exitCode = await runCli({
      argv: ["--json", "validate"],
      cwd: directory,
      io: output.io,
      createCorrelationId: () => "invalid-project",
    });

    expect(exitCode).toBe(1);
    expect(output.stdout()).toBe("");
    expect(JSON.parse(output.stderr())).toMatchObject({
      error: {
        code: "SCHEMA_PARSE_FAILED",
        correlationId: "invalid-project",
        details: {
          issues: [
            expect.objectContaining({
              path: ["project", "name"],
              code: "invalid_type",
            }),
          ],
        },
      },
    });
  });

  it("lists Task Contracts from tasks/<task-id>/contract.yaml", async () => {
    const directory = await temporaryDirectory("scaflow-cli-task-list-");
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
    const output = createOutput();

    const exitCode = await runCli({
      argv: ["--json", "task", "list"],
      cwd: directory,
      io: output.io,
    });

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    expect(JSON.parse(output.stdout())).toMatchObject({
      tasks: [
        {
          id: "SFL-001",
          title: "Task Contract",
          type: "schema",
          definition_state: "ready",
        },
        {
          id: "SFL-100",
          title: "Task Contract",
          type: "schema",
          definition_state: "ready",
        },
      ],
    });
  });

  it("shows and validates a Task Contract", async () => {
    const directory = await temporaryDirectory("scaflow-cli-task-show-");
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

    const showOutput = createOutput();
    const showExitCode = await runCli({
      argv: ["task", "show", "SFL-999"],
      cwd: directory,
      io: showOutput.io,
    });

    expect(showExitCode).toBe(0);
    expect(showOutput.stderr()).toBe("");
    expect(showOutput.stdout()).toContain("Task SFL-999");
    expect(showOutput.stdout()).toContain("Definition State: ready");

    const validateOutput = createOutput();
    const validateExitCode = await runCli({
      argv: ["--json", "task", "validate", "SFL-999"],
      cwd: directory,
      io: validateOutput.io,
    });

    expect(validateExitCode).toBe(0);
    expect(validateOutput.stderr()).toBe("");
    expect(JSON.parse(validateOutput.stdout())).toEqual({
      valid: true,
      task: { id: "SFL-999" },
    });
  });

  it("returns structured task errors for missing and invalid contracts", async () => {
    const directory = await temporaryDirectory("scaflow-cli-task-invalid-");
    await writeTaskContract(
      directory,
      "SFL-999",
      validTaskContractYaml().replace(
        "allowed_paths:\n        - packages/schemas/**",
        "allowed_paths: []",
      ),
    );

    const invalidOutput = createOutput();
    const invalidExitCode = await runCli({
      argv: ["--json", "task", "validate", "SFL-999"],
      cwd: directory,
      io: invalidOutput.io,
      createCorrelationId: () => "task-invalid",
    });

    expect(invalidExitCode).toBe(1);
    expect(invalidOutput.stdout()).toBe("");
    expect(JSON.parse(invalidOutput.stderr())).toMatchObject({
      error: {
        code: "SCHEMA_PARSE_FAILED",
        correlationId: "task-invalid",
        details: {
          issues: [
            expect.objectContaining({
              path: ["repositories", "scopes", 0, "allowed_paths"],
            }),
          ],
        },
      },
    });

    const missingOutput = createOutput();
    const missingExitCode = await runCli({
      argv: ["--json", "task", "show", "SFL-404"],
      cwd: directory,
      io: missingOutput.io,
      createCorrelationId: () => "task-missing",
    });

    expect(missingExitCode).toBe(1);
    expect(JSON.parse(missingOutput.stderr())).toMatchObject({
      error: {
        code: "TASK_CONTRACT_NOT_FOUND",
        correlationId: "task-missing",
      },
    });
  });

  it("returns structured JSON errors for invalid repository manifests", async () => {
    const directory = await temporaryDirectory("scaflow-cli-invalid-repos-");
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
      `${JSON.stringify({ version: 1, repositories: [] })}\n`,
    );
    const output = createOutput();

    const exitCode = await runCli({
      argv: ["--json", "validate"],
      cwd: directory,
      io: output.io,
      createCorrelationId: () => "invalid-repos",
    });

    expect(exitCode).toBe(1);
    expect(output.stdout()).toBe("");
    expect(JSON.parse(output.stderr())).toMatchObject({
      error: {
        code: "SCHEMA_PARSE_FAILED",
        correlationId: "invalid-repos",
        details: {
          issues: [
            expect.objectContaining({
              path: ["repositories"],
              code: "too_small",
            }),
          ],
        },
      },
    });
  });

  it("renders human doctor output with missing pre-bootstrap workspace as WARN", async () => {
    const directory = await temporaryDirectory("scaflow-cli-doctor-human-");
    expect(
      await runCli({
        argv: ["init", "Beauty AI"],
        cwd: directory,
        io: createOutput().io,
      }),
    ).toBe(0);
    const output = createOutput();

    const exitCode = await runCli({
      argv: ["doctor"],
      cwd: directory,
      io: output.io,
      dockerExecutable: "scaflow-missing-docker-for-test",
      env: {},
    });

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    expect(output.stdout()).toContain("Scaflow Doctor: WARN");
    expect(output.stdout()).toContain("[PASS] Node.js:");
    expect(output.stdout()).toContain("[PASS] pnpm:");
    expect(output.stdout()).toContain("[PASS] Git:");
    expect(output.stdout()).toContain("[PASS] Scaflow Engine:");
    expect(output.stdout()).toContain("[PASS] SPR Schema:");
    expect(output.stdout()).toContain("[PASS] Git Access:");
    expect(output.stdout()).toContain(
      "[WARN] Workspace: workspace/ is not present before bootstrap",
    );
    expect(output.stdout()).toContain("[SKIP] Docker:");
  });

  it("renders parseable JSON doctor output with PASS, WARN, FAIL, and SKIP statuses", async () => {
    const directory = await temporaryDirectory("scaflow-cli-doctor-json-");
    await writeFile(
      join(directory, "scaflow.yaml"),
      `${JSON.stringify({
        version: 1,
        project: { id: "beauty-ai", name: "Beauty AI" },
        engine: { version: "0.2.0" },
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
    const output = createOutput();

    const exitCode = await runCli({
      argv: ["--json", "doctor"],
      cwd: directory,
      io: output.io,
      dockerExecutable: "scaflow-missing-docker-for-test",
      env: {},
    });

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    const report = JSON.parse(output.stdout()) as {
      ok: boolean;
      status: string;
      checks: Array<{ id: string; status: string; message: string }>;
    };
    expect(report.ok).toBe(false);
    expect(report.status).toBe("FAIL");
    expect(new Set(report.checks.map((check) => check.status))).toEqual(
      new Set(["PASS", "WARN", "FAIL", "SKIP"]),
    );
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "spr-schema", status: "PASS" }),
        expect.objectContaining({ id: "engine-version", status: "FAIL" }),
        expect.objectContaining({ id: "git-access", status: "FAIL" }),
        expect.objectContaining({ id: "workspace", status: "WARN" }),
        expect.objectContaining({ id: "codex-environment", status: "SKIP" }),
        expect.objectContaining({ id: "docker", status: "SKIP" }),
      ]),
    );
  });

  it("reports schema failures through doctor without weakening config validation", async () => {
    const directory = await temporaryDirectory("scaflow-cli-doctor-schema-");
    await writeFile(
      join(directory, "scaflow.yaml"),
      `${JSON.stringify({
        version: 1,
        project: { id: "beauty-ai" },
        engine: { version: "0.1.0" },
      })}\n`,
    );
    await writeFile(
      join(directory, "repositories.yaml"),
      `${JSON.stringify({ version: 1, repositories: [] })}\n`,
    );
    const output = createOutput();

    const exitCode = await runCli({
      argv: ["--json", "doctor"],
      cwd: directory,
      io: output.io,
      dockerExecutable: "scaflow-missing-docker-for-test",
      env: {},
    });

    expect(exitCode).toBe(0);
    const report = JSON.parse(output.stdout()) as {
      status: string;
      checks: Array<{ id: string; status: string; details?: unknown }>;
    };
    expect(report.status).toBe("FAIL");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "spr-schema",
          status: "FAIL",
          details: expect.objectContaining({
            code: "SCHEMA_PARSE_FAILED",
          }),
        }),
      ]),
    );
  });

  it("bootstraps workspace repositories and reports post-bootstrap doctor checks", async () => {
    const fixture = await createCliProjectWithRemote("scaflow-cli-bootstrap-");
    const bootstrapOutput = createOutput();

    const bootstrapExitCode = await runCli({
      argv: ["--json", "bootstrap"],
      cwd: fixture.projectDir,
      io: bootstrapOutput.io,
    });

    expect(bootstrapExitCode).toBe(0);
    expect(bootstrapOutput.stderr()).toBe("");
    const bootstrap = JSON.parse(bootstrapOutput.stdout()) as {
      ok: boolean;
      repositories: Array<{ id: string; action: string; state: string }>;
    };
    expect(bootstrap).toMatchObject({
      ok: true,
      repositories: [{ id: "app", action: "clone", state: "cloned" }],
    });
    await expect(
      readFile(join(fixture.projectDir, "workspace", "manifest.json"), "utf8"),
    ).resolves.toContain('"id": "app"');

    const doctorOutput = createOutput();
    const doctorExitCode = await runCli({
      argv: ["--json", "doctor"],
      cwd: fixture.projectDir,
      io: doctorOutput.io,
      dockerExecutable: "scaflow-missing-docker-for-test",
      env: { CODEX_HOME: fixture.projectDir },
    });

    expect(doctorExitCode).toBe(0);
    const doctor = JSON.parse(doctorOutput.stdout()) as {
      status: string;
      checks: Array<{ id: string; status: string }>;
    };
    expect(doctor.status).toBe("PASS");
    expect(doctor.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "workspace-manifest",
          status: "PASS",
        }),
        expect.objectContaining({
          id: "repository-identity:app",
          status: "PASS",
        }),
        expect.objectContaining({
          id: "repository-health:app",
          status: "PASS",
        }),
      ]),
    );
  }, CLI_GIT_TEST_TIMEOUT_MS);

  it("renders repository and workspace status for bootstrapped projects", async () => {
    const fixture = await createCliProjectWithRemote("scaflow-cli-status-");
    expect(
      await runCli({
        argv: ["bootstrap"],
        cwd: fixture.projectDir,
        io: createOutput().io,
      }),
    ).toBe(0);

    const repoOutput = createOutput();
    expect(
      await runCli({
        argv: ["repo", "status"],
        cwd: fixture.projectDir,
        io: repoOutput.io,
      }),
    ).toBe(0);
    expect(repoOutput.stdout()).toContain("Scaflow Repository Status");
    expect(repoOutput.stdout()).toContain("[FETCHED] app:");

    const workspaceOutput = createOutput();
    expect(
      await runCli({
        argv: ["--json", "workspace", "status"],
        cwd: fixture.projectDir,
        io: workspaceOutput.io,
      }),
    ).toBe(0);
    expect(JSON.parse(workspaceOutput.stdout())).toMatchObject({
      ok: true,
      manifestPresent: true,
      repositories: [{ id: "app", identity: "matching" }],
    });
  }, CLI_GIT_TEST_TIMEOUT_MS);
});

function createOutput(): {
  io: {
    stdout: { write: (value: string | Uint8Array) => boolean };
    stderr: { write: (value: string | Uint8Array) => boolean };
  };
  stdout: () => string;
  stderr: () => string;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    io: {
      stdout: {
        write(value) {
          stdout.push(value.toString());
          return true;
        },
      },
      stderr: {
        write(value) {
          stderr.push(value.toString());
          return true;
        },
      },
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

async function createCliProjectWithRemote(prefix: string): Promise<{
  readonly rootDir: string;
  readonly projectDir: string;
  readonly remoteDir: string;
}> {
  const rootDir = await temporaryDirectory(prefix);
  const projectDir = join(rootDir, "project");
  const controlRemoteDir = join(rootDir, "control.git");
  const sourceDir = join(rootDir, "source");
  const remoteDir = join(rootDir, "remote.git");

  await mkdir(projectDir);
  await mkdir(sourceDir);
  await git(sourceDir, "init");
  await git(sourceDir, "config", "user.name", "Scaflow Test");
  await git(sourceDir, "config", "user.email", "scaflow@example.invalid");
  await writeFile(join(sourceDir, "README.md"), "# app\n");
  await git(sourceDir, "add", "README.md");
  await git(sourceDir, "commit", "-m", "Initial commit");
  await git(sourceDir, "init", "--bare", remoteDir);
  await git(sourceDir, "remote", "add", "origin", remoteDir);
  await git(sourceDir, "push", "origin", "HEAD:main");

  await writeFile(
    join(projectDir, "scaflow.yaml"),
    `${JSON.stringify({
      version: 1,
      project: { id: "beauty-ai", name: "Beauty AI" },
      engine: { version: "0.1.0" },
    })}\n`,
  );
  await writeFile(
    join(projectDir, "repositories.yaml"),
    `${JSON.stringify({
      version: 1,
      repositories: [
        {
          id: "app",
          name: "Application",
          git_url: remoteDir,
          default_branch: "main",
          checkout_directory: "app",
          type: "application",
        },
      ],
    })}\n`,
  );
  await git(projectDir, "init");
  await git(projectDir, "config", "user.name", "Scaflow Test");
  await git(projectDir, "config", "user.email", "scaflow@example.invalid");
  await git(projectDir, "add", "scaflow.yaml", "repositories.yaml");
  await git(projectDir, "commit", "-m", "Initial control commit");
  await git(projectDir, "init", "--bare", controlRemoteDir);
  await git(projectDir, "remote", "add", "origin", controlRemoteDir);
  await git(projectDir, "push", "origin", "HEAD:main");

  return { rootDir, projectDir, remoteDir };
}

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

function taskPrepareContractYaml(): string {
  return `version: 1
task:
  id: SFL-017
  title: TaskRun Workspace
  type: workspace
  risk_level: R3
  definition_state: ready
objective:
  summary: Prepare TaskRun workspaces.
source_requirements:
  - id: FR-006
    document: docs/source/scaflow-v0.1.0-prd.md
dependencies:
  - SFL-006
dependency_changes: forbidden
repositories:
  primary: "@control"
  scopes:
    - repository: "@control"
      access: read-write
      allowed_paths:
        - packages/workspace/**
    - repository: app
      access: read-only
acceptance_criteria:
  - id: SFL-017-AC-01
    description: task prepare creates a TaskRun bundle.
verification:
  commands:
    - repository: "@control"
      executable: pnpm
      args: ["--filter", "@scaflow/workspace", "test"]
      timeout_seconds: 300
      required: true
retry_policy:
  max_attempts: 2
  max_repair_rounds_per_attempt: 3
  escalate_after_same_failure: 2
`;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });

  return stdout;
}
