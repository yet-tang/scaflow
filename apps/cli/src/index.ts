#!/usr/bin/env node

import { pathToFileURL } from "node:url";

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

export interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface CliProgramOptions {
  io?: CliIo;
  createCorrelationId?: () => string;
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
      caught instanceof ScaflowError
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

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  process.exitCode = await runCli();
}
