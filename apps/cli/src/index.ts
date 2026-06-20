#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
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
  pnpmExecutable?: string;
  dockerExecutable?: string;
  env?: NodeJS.ProcessEnv;
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
  const pnpmExecutable = options.pnpmExecutable ?? "pnpm";
  const dockerExecutable = options.dockerExecutable ?? "docker";
  const env = options.env ?? process.env;
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
      if (name === "doctor") {
        registerDoctor(program, {
          cwd,
          io,
          gitExecutable,
          pnpmExecutable,
          dockerExecutable,
          env,
        });
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

type DoctorStatus = "PASS" | "WARN" | "FAIL" | "SKIP";

interface DoctorCheck {
  readonly id: string;
  readonly label: string;
  readonly status: DoctorStatus;
  readonly message: string;
  readonly details?: unknown;
}

interface DoctorReport {
  readonly ok: boolean;
  readonly status: DoctorStatus;
  readonly checks: readonly DoctorCheck[];
}

interface DoctorOptions {
  readonly cwd: string;
  readonly io: CliIo;
  readonly gitExecutable: string;
  readonly pnpmExecutable: string;
  readonly dockerExecutable: string;
  readonly env: NodeJS.ProcessEnv;
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

function registerDoctor(parent: Command, options: DoctorOptions): void {
  parent
    .command("doctor")
    .description("check the local Scaflow development environment")
    .action(async () => {
      const report = await runDoctor(options);

      if (parent.opts().json === true) {
        options.io.stdout.write(`${JSON.stringify(report)}\n`);
        return;
      }

      options.io.stdout.write(renderDoctorHuman(report));
    });
}

async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const config = await validateDoctorConfig(options.cwd);
  const checks: DoctorCheck[] = [
    checkNodeVersion(),
    await checkCommand("pnpm", "pnpm", options.pnpmExecutable, ["--version"], options.cwd),
    await checkCommand("git", "Git", options.gitExecutable, ["--version"], options.cwd),
    config.schemaCheck,
    checkEngineVersion(config.projectConfig),
    await checkControlRepository(options.cwd),
    await checkWorkspace(options.cwd),
    checkCodexEnvironment(options.env),
    await checkDocker(options.cwd, options.dockerExecutable),
  ];

  const status = aggregateDoctorStatus(checks);
  return {
    ok: status !== "FAIL",
    status,
    checks,
  };
}

function checkNodeVersion(): DoctorCheck {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);

  if (Number.isInteger(major) && major >= 22) {
    return {
      id: "node",
      label: "Node.js",
      status: "PASS",
      message: `Node.js ${process.versions.node} satisfies >=22`,
    };
  }

  return {
    id: "node",
    label: "Node.js",
    status: "FAIL",
    message: `Node.js ${process.versions.node} does not satisfy >=22`,
  };
}

async function checkCommand(
  id: string,
  label: string,
  executable: string,
  args: readonly string[],
  cwd: string,
): Promise<DoctorCheck> {
  const result = await runStructuredCommand({ executable, args, cwd });
  if (result.exitCode === 0) {
    return {
      id,
      label,
      status: "PASS",
      message: `${label} is available`,
      details: { executable, args },
    };
  }

  return {
    id,
    label,
    status: "FAIL",
    message:
      result.spawnError === undefined
        ? `${label} command failed`
        : `${label} executable was not found`,
    details: {
      executable,
      args,
      exitCode: result.exitCode,
      signal: result.signal,
      stderr: result.stderr,
      spawnCode: result.spawnError?.code,
    },
  };
}

async function validateDoctorConfig(cwd: string): Promise<{
  readonly schemaCheck: DoctorCheck;
  readonly projectConfig?: unknown;
}> {
  const config = await loadConfigModule();
  try {
    const result = await config.validateLocalProject(cwd, {});
    return {
      schemaCheck: {
        id: "spr-schema",
        label: "SPR Schema",
        status: "PASS",
        message: "Scaflow project configuration is valid",
      },
      projectConfig: readProjectConfig(result),
    };
  } catch (error) {
    return {
      schemaCheck: {
        id: "spr-schema",
        label: "SPR Schema",
        status: "FAIL",
        message: error instanceof Error ? error.message : "Schema validation failed",
        details: serializeDoctorError(error),
      },
    };
  }
}

function checkEngineVersion(projectConfig: unknown): DoctorCheck {
  const engineVersion = readEngineVersion(projectConfig);
  if (engineVersion === "0.1.0") {
    return {
      id: "engine-version",
      label: "Scaflow Engine",
      status: "PASS",
      message: "Scaflow Engine version is pinned to 0.1.0",
      details: { expected: "0.1.0", actual: engineVersion },
    };
  }

  return {
    id: "engine-version",
    label: "Scaflow Engine",
    status: "FAIL",
    message:
      engineVersion === undefined
        ? "Scaflow Engine version could not be read"
        : `Scaflow Engine version ${engineVersion} does not match 0.1.0`,
    details: { expected: "0.1.0", actual: engineVersion },
  };
}

async function checkControlRepository(cwd: string): Promise<DoctorCheck> {
  const git = await loadGitModule();
  try {
    await git.getRepositoryStatus({ cwd });
    return {
      id: "git-access",
      label: "Git Access",
      status: "PASS",
      message: "SPR Git repository is accessible",
    };
  } catch (error) {
    return {
      id: "git-access",
      label: "Git Access",
      status: "FAIL",
      message: error instanceof Error ? error.message : "SPR Git repository is not accessible",
      details: serializeDoctorError(error),
    };
  }
}

async function checkWorkspace(cwd: string): Promise<DoctorCheck> {
  try {
    await access(join(cwd, "workspace"));
    return {
      id: "workspace",
      label: "Workspace",
      status: "PASS",
      message: "workspace/ is present",
    };
  } catch (error) {
    return {
      id: "workspace",
      label: "Workspace",
      status: "WARN",
      message: "workspace/ is not present before bootstrap",
      details: serializeDoctorError(error),
    };
  }
}

function checkCodexEnvironment(env: NodeJS.ProcessEnv): DoctorCheck {
  if (env.OPENAI_API_KEY !== undefined || env.CODEX_HOME !== undefined) {
    return {
      id: "codex-environment",
      label: "Codex Environment",
      status: "PASS",
      message: "Codex-related environment is present",
      details: {
        openaiApiKey: env.OPENAI_API_KEY === undefined ? "absent" : "present",
        codexHome: env.CODEX_HOME === undefined ? "absent" : "present",
      },
    };
  }

  return {
    id: "codex-environment",
    label: "Codex Environment",
    status: "SKIP",
    message: "No Codex environment variables are present for local Doctor checks",
  };
}

async function checkDocker(cwd: string, executable: string): Promise<DoctorCheck> {
  const result = await runStructuredCommand({
    executable,
    args: ["--version"],
    cwd,
  });
  if (result.exitCode === 0) {
    return {
      id: "docker",
      label: "Docker",
      status: "PASS",
      message: "Docker is available",
      details: { executable, args: ["--version"] },
    };
  }

  return {
    id: "docker",
    label: "Docker",
    status: "SKIP",
    message:
      result.spawnError === undefined
        ? "Optional Docker check was skipped because Docker is unavailable"
        : "Optional Docker check was skipped because Docker was not found",
    details: {
      executable,
      exitCode: result.exitCode,
      signal: result.signal,
      stderr: result.stderr,
      spawnCode: result.spawnError?.code,
    },
  };
}

function aggregateDoctorStatus(checks: readonly DoctorCheck[]): DoctorStatus {
  if (checks.some((check) => check.status === "FAIL")) {
    return "FAIL";
  }
  if (checks.some((check) => check.status === "WARN")) {
    return "WARN";
  }
  if (checks.some((check) => check.status === "PASS")) {
    return "PASS";
  }
  return "SKIP";
}

function renderDoctorHuman(report: DoctorReport): string {
  const lines = [
    `Scaflow Doctor: ${report.status}`,
    ...report.checks.map(
      (check) => `[${check.status}] ${check.label}: ${check.message}`,
    ),
    "",
  ];
  return lines.join("\n");
}

function readProjectConfig(result: unknown): unknown {
  if (
    typeof result === "object" &&
    result !== null &&
    "projectConfig" in result
  ) {
    return result.projectConfig;
  }
  return undefined;
}

function readEngineVersion(projectConfig: unknown): string | undefined {
  if (
    typeof projectConfig !== "object" ||
    projectConfig === null ||
    !("engine" in projectConfig)
  ) {
    return undefined;
  }
  const engine = projectConfig.engine;
  if (
    typeof engine !== "object" ||
    engine === null ||
    !("version" in engine) ||
    typeof engine.version !== "string"
  ) {
    return undefined;
  }
  return engine.version;
}

function serializeDoctorError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...("code" in error ? { code: error.code } : {}),
      ...("details" in error ? { details: error.details } : {}),
      ...("issues" in error ? { issues: error.issues } : {}),
    };
  }
  return { message: String(error) };
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

interface GitModule {
  readonly getRepositoryStatus: (options: {
    readonly cwd: string;
  }) => Promise<unknown>;
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

async function loadGitModule(): Promise<GitModule> {
  return (await import(workspaceModuleUrl("git"))) as GitModule;
}

function workspaceModuleUrl(packageName: "config" | "git" | "template"): string {
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
