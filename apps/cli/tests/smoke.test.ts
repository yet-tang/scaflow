import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it.each([
    ["before", ["--json", "workspace", "sync"]],
    ["after", ["workspace", "sync", "--json"]],
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
          'Command "workspace sync" is not implemented in Scaflow v0.1.0 yet',
        code: NOT_IMPLEMENTED_ERROR_CODE,
        recoverable: false,
        correlationId: "test-json-error",
        suggestion: "Use --help to inspect the available command surface",
        details: { command: "workspace sync" },
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
