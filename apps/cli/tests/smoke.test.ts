import { ScaflowError } from "@scaflow/core";
import { describe, expect, it } from "vitest";

import {
  CLI_NAME,
  NOT_IMPLEMENTED_ERROR_CODE,
  createCliProgram,
  packageName,
  renderError,
  runCli,
} from "../src/index";

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
