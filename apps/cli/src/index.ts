#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ScaflowError,
  serializeScaflowError,
  type SerializedScaflowError,
} from "@scaflow/core";
import { Command, CommanderError } from "commander";

export const packageName = "@scaflow/cli";
export const CLI_NAME = "scaflow";
export const NOT_IMPLEMENTED_ERROR_CODE = "COMMAND_NOT_IMPLEMENTED";
export const USAGE_ERROR_CODE = "CLI_USAGE_ERROR";
export const GIT_INIT_ERROR_CODE = "GIT_INIT_FAILED";

export interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface CliProgramOptions {
  io?: CliIo;
  createCorrelationId?: () => string;
  cwd?: string;
  gitExecutable?: string;
}

export interface CliRunOptions extends CliProgramOptions {
  argv?: readonly string[];
}

interface JsonErrorOutput {
  error: SerializedScaflowError;
}

const COMMAND_TREE = {
  init: null,
  validate: null,
  bootstrap: null,
  doctor: null,
  repo: ["status"],
  workspace: ["status", "sync"],
  task: ["list", "show", "validate", "prepare", "run", "status", "cancel"],
  run: ["inspect", "clean"],
  changeset: ["show", "list"],
} as const;

const DEFAULT_IO: CliIo = {
  stdout: process.stdout,
  stderr: process.stderr,
};

export function createCliProgram(options: CliProgramOptions = {}): Command {
  const io = options.io ?? DEFAULT_IO;
  const cwd = options.cwd ?? process.cwd();
  const gitExecutable = options.gitExecutable ?? "git";
  const program = new Command()
    .name(CLI_NAME)
    .description("Scaflow Execution Kernel")
    .option("--json", "render machine-readable output")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (value) => {
        io.stdout.write(value);
      },
      // Parse errors are rendered through the same stable ScaflowError path.
      writeErr: () => undefined,
    });

  for (const [name, children] of Object.entries(COMMAND_TREE)) {
    if (children === null) {
      if (name === "init") {
        registerInit(
          program,
          cwd,
          io,
          gitExecutable,
          options.createCorrelationId,
        );
        continue;
      }
      if (name === "validate") {
        registerValidate(program, cwd, io, options.createCorrelationId);
        continue;
      }
      registerStub(program, name, options.createCorrelationId);
      continue;
    }

    const group = program.command(name).description(`${name} commands`);
    for (const child of children) {
      registerStub(group, child, options.createCorrelationId);
    }
  }

  return program;
}

export async function runCli(options: CliRunOptions = {}): Promise<number> {
  const io = options.io ?? DEFAULT_IO;
  const program = createCliProgram({ ...options, io });
  const argv = [...(options.argv ?? process.argv.slice(2))];

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (caught) {
    if (caught instanceof CommanderError && caught.exitCode === 0) {
      return 0;
    }

    const error =
      isScaflowErrorLike(caught)
        ? caught
        : commanderError(caught, options.createCorrelationId);
    renderError(error, program.opts().json === true, io.stderr);
    return caught instanceof CommanderError ? caught.exitCode : 1;
  }
}

export function renderError(
  error: ScaflowError,
  json: boolean,
  stderr: Pick<NodeJS.WriteStream, "write">,
): void {
  const serialized = serializeScaflowError(error);

  if (json) {
    const output: JsonErrorOutput = { error: serialized };
    stderr.write(`${JSON.stringify(output)}\n`);
    return;
  }

  const lines = [
    `Error [${serialized.code}]: ${serialized.message}`,
    `Correlation ID: ${serialized.correlationId}`,
  ];
  if (serialized.suggestion !== undefined) {
    lines.push(`Suggestion: ${serialized.suggestion}`);
  }
  stderr.write(`${lines.join("\n")}\n`);
}

function registerStub(
  parent: Command,
  name: string,
  createCorrelationId?: () => string,
): void {
  parent
    .command(name)
    .description(`${name} is not implemented yet`)
    .allowUnknownOption()
    .allowExcessArguments()
    .action((...actionArguments: unknown[]) => {
      const command = actionArguments.at(-1);
      if (!(command instanceof Command)) {
        throw new TypeError("Commander did not provide the active command");
      }

      const commandPath = getCommandPath(command);
      throw new ScaflowError(
        `Command "${commandPath}" is not implemented in Scaflow v0.1.0 yet`,
        {
          code: NOT_IMPLEMENTED_ERROR_CODE,
          recoverable: false,
          suggestion: "Use --help to inspect the available command surface",
          ...(createCorrelationId === undefined
            ? {}
            : { correlationId: createCorrelationId() }),
          details: { command: commandPath },
        },
      );
    });
}

function registerInit(
  parent: Command,
  cwd: string,
  io: CliIo,
  gitExecutable: string,
  createCorrelationId?: () => string,
): void {
  parent
    .command("init")
    .description("initialize a Scaflow Project Repository")
    .argument("<project-name>", "project display name")
    .action(async (projectName: string) => {
      const normalizedProjectName = projectName.trim();
      if (normalizedProjectName === "") {
        throw new ScaflowError("Project name must not be empty", {
          code: USAGE_ERROR_CODE,
          recoverable: false,
          suggestion: "Provide a non-empty project name",
          ...(createCorrelationId === undefined
            ? {}
            : { correlationId: createCorrelationId() }),
        });
      }

      const template = await loadTemplateModule();
      const result = await template.renderProjectTemplate(cwd, {
        project: {
          name: normalizedProjectName,
          engineVersion: "0.1.0",
        },
      });
      await initializeGitRepository(cwd, gitExecutable, createCorrelationId);

      if (parent.opts().json === true) {
        io.stdout.write(
          `${JSON.stringify({
            project: { name: normalizedProjectName },
            created: result.created,
            skipped: result.skipped,
          })}\n`,
        );
        return;
      }

      io.stdout.write(
        [
          `Initialized Scaflow project "${normalizedProjectName}"`,
          `Created: ${result.created.length}`,
          `Skipped: ${result.skipped.length}`,
          "",
        ].join("\n"),
      );
    });
}

async function initializeGitRepository(
  cwd: string,
  gitExecutable: string,
  createCorrelationId?: () => string,
): Promise<void> {
  const result = await runStructuredCommand({
    executable: gitExecutable,
    args: ["init"],
    cwd,
  });

  if (result.exitCode === 0) {
    return;
  }

  throw gitInitError(cwd, gitExecutable, result, createCorrelationId);
}

interface StructuredCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

interface StructuredCommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly spawnError?: NodeJS.ErrnoException;
}

async function runStructuredCommand(
  command: StructuredCommand,
): Promise<StructuredCommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];

    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });

    child.on("error", (spawnError: NodeJS.ErrnoException) => {
      resolve({
        exitCode: null,
        signal: null,
        stderr: Buffer.concat(stderr).toString("utf8"),
        spawnError,
      });
    });

    child.on("close", (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function gitInitError(
  cwd: string,
  executable: string,
  result: StructuredCommandResult,
  createCorrelationId?: () => string,
): ScaflowError {
  return new ScaflowError("Could not initialize Git repository", {
    code: GIT_INIT_ERROR_CODE,
    recoverable: false,
    suggestion: "Install Git or initialize the project in a writable directory",
    ...(createCorrelationId === undefined
      ? {}
      : { correlationId: createCorrelationId() }),
    details: {
      command: {
        executable,
        args: ["init"],
        cwd,
      },
      exitCode: result.exitCode,
      signal: result.signal,
      stderr: result.stderr,
      spawnCode: result.spawnError?.code,
    },
  });
}

function registerValidate(
  parent: Command,
  cwd: string,
  io: CliIo,
  createCorrelationId?: () => string,
): void {
  parent
    .command("validate")
    .description("validate local Scaflow Project Repository configuration")
    .action(async () => {
      const correlationId = createCorrelationId?.();
      const config = await loadConfigModule();
      await config.validateLocalProject(
        cwd,
        correlationId === undefined ? {} : { correlationId },
      );

      if (parent.opts().json === true) {
        io.stdout.write(`${JSON.stringify({ valid: true })}\n`);
        return;
      }

      io.stdout.write("Scaflow project configuration is valid\n");
    });
}

function getCommandPath(command: Command): string {
  const names: string[] = [];
  for (
    let current: Command | null = command;
    current !== null && current.parent !== null;
    current = current.parent
  ) {
    names.unshift(current.name());
  }
  return names.join(" ");
}

function commanderError(
  caught: unknown,
  createCorrelationId?: () => string,
): ScaflowError {
  const message =
    caught instanceof CommanderError
      ? caught.message
      : "The CLI could not process the command";

  return new ScaflowError(message, {
    code: USAGE_ERROR_CODE,
    recoverable: false,
    suggestion: "Use --help to inspect valid commands and options",
    ...(createCorrelationId === undefined
      ? {}
      : { correlationId: createCorrelationId() }),
  });
}

interface TemplateModule {
  readonly renderProjectTemplate: (
    destinationDirectory: string,
    options: {
      readonly project: {
        readonly name: string;
        readonly engineVersion: string;
      };
    },
  ) => Promise<{
    readonly created: readonly string[];
    readonly skipped: readonly string[];
  }>;
}

interface ConfigModule {
  readonly validateLocalProject: (
    directory: string,
    options: { readonly correlationId?: string },
  ) => Promise<unknown>;
}

function isScaflowErrorLike(caught: unknown): caught is ScaflowError {
  return (
    caught instanceof ScaflowError ||
    (typeof caught === "object" &&
      caught !== null &&
      "message" in caught &&
      "code" in caught &&
      "recoverable" in caught &&
      "correlationId" in caught)
  );
}

async function loadTemplateModule(): Promise<TemplateModule> {
  return (await import(workspaceModuleUrl("template"))) as TemplateModule;
}

async function loadConfigModule(): Promise<ConfigModule> {
  return (await import(workspaceModuleUrl("config"))) as ConfigModule;
}

function workspaceModuleUrl(packageName: "config" | "template"): string {
  const currentPath = fileURLToPath(import.meta.url);
  const modulePath = currentPath.includes("/src/")
    ? `../../../packages/${packageName}/src/index.ts`
    : `../../../packages/${packageName}/dist/index.js`;

  return new URL(modulePath, import.meta.url).href;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  process.exitCode = await runCli();
}
