import { redactText } from "@scaflow/core";
import type {
  TaskContractVerificationCommand,
  VerificationArtifactReference,
  VerificationFailure,
} from "@scaflow/schemas";

import type {
  VerificationArtifactStore,
  VerificationContext,
  Verifier,
  VerifierOutput,
} from "./index.js";
import type {
  CommandEnvironment,
  CommandResult,
  StructuredCommand,
} from "./command.js";

export const COMMAND_VERIFIER_ID = "commands";
const COMMAND_RESULTS_ARTIFACT_ID = "commands-results";
const COMMAND_RESULTS_ARTIFACT_PATH = "commands/results.json";

export interface CommandExecutor {
  run(command: StructuredCommand): Promise<CommandResult>;
}

export interface CommandVerifierOptions {
  readonly commands: readonly TaskContractVerificationCommand[];
  readonly executor: CommandExecutor;
  readonly artifactStore: VerificationArtifactStore;
  readonly environment?: CommandEnvironment;
}

export interface CommandVerificationResult extends VerifierOutput {
  readonly commandResults: readonly CommandResult[];
}

interface CommandExecutionError {
  readonly commandId: string;
  readonly repository: string;
  readonly message: string;
}

export function createCommandVerifier(options: CommandVerifierOptions): Verifier {
  return {
    id: COMMAND_VERIFIER_ID,
    async verify(context) {
      const { commandResults: _commandResults, ...output } =
        await verifyTaskContractCommands(options, context);
      return output;
    },
  };
}

export async function verifyTaskContractCommands(
  options: CommandVerifierOptions,
  context: VerificationContext,
): Promise<CommandVerificationResult> {
  if (options.commands.length === 0) {
    throw new TypeError("Command verifier requires at least one Task Contract command");
  }

  const commandResults: CommandResult[] = [];
  let executionError: CommandExecutionError | null = null;

  for (const [index, contractCommand] of options.commands.entries()) {
    const command = toStructuredCommand(contractCommand, index, options.environment);
    try {
      const result = await options.executor.run(command);
      validateCommandResult(command, result);
      commandResults.push(safeCommandResult(result));
    } catch (error) {
      executionError = {
        commandId: command.id,
        repository: redactText(command.repository),
        message: redactText(error instanceof Error
          ? error.message
          : "Command executor threw a non-Error value"),
      };
      break;
    }
  }

  const requiredFailures = commandResults
    .filter((result) => result.required && !commandSucceeded(result))
    .map(requiredCommandFailure);
  const failures = executionError === null
    ? requiredFailures
    : [...requiredFailures, executorFailure(executionError)];
  const status = failures.length === 0 ? "passed" : "failed";
  const resultArtifacts = commandResults.flatMap(({ artifacts }) => artifacts);
  const manifest = await writeCommandResultsArtifact(
    options.artifactStore,
    context.taskRunId,
    status,
    commandResults,
    executionError,
  );
  const optionalFailureCount = commandResults.filter(
    (result) => !result.required && !commandSucceeded(result),
  ).length;

  return {
    status,
    summary: summarize(commandResults.length, requiredFailures.length,
      optionalFailureCount, executionError !== null),
    failures,
    artifacts: [...resultArtifacts, manifest],
    commandResults,
  };
}

function validateCommandResult(command: StructuredCommand, result: CommandResult): void {
  if (result.commandId !== command.id || result.repository !== command.repository ||
      result.required !== command.required || result.timeoutSeconds !== command.timeoutSeconds) {
    throw new TypeError(`Command executor returned mismatched metadata for ${command.id}`);
  }
  if (result.outcome !== "rejected" &&
      (result.executable !== command.executable ||
       JSON.stringify(result.args) !== JSON.stringify(command.args.map(redactText)))) {
    throw new TypeError(`Command executor returned mismatched argv for ${command.id}`);
  }
}

function commandSucceeded(result: CommandResult): boolean {
  return result.outcome === "succeeded" && result.exitCode === 0 && !result.timedOut;
}

function toStructuredCommand(
  command: TaskContractVerificationCommand,
  index: number,
  environment: CommandEnvironment | undefined,
): StructuredCommand {
  return {
    id: `verification-command-${String(index + 1).padStart(4, "0")}`,
    repository: command.repository,
    executable: command.executable,
    args: [...command.args],
    timeoutSeconds: command.timeout_seconds,
    required: command.required,
    environment: environment ?? { allowlist: ["PATH"] },
  };
}

function requiredCommandFailure(result: CommandResult): VerificationFailure {
  return {
    code: "REQUIRED_COMMAND_FAILED",
    category: "execution",
    repairability: "repairable",
    message: `Required command ${result.commandId} finished with outcome ${result.outcome}`,
    details: {
      command_id: result.commandId,
      repository: redactText(result.repository),
      outcome: result.outcome,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
    },
  };
}

function executorFailure(error: CommandExecutionError): VerificationFailure {
  return {
    code: "COMMAND_EXECUTOR_ERROR",
    category: "infrastructure",
    repairability: "unknown",
    message: `Command executor failed while running ${error.commandId}`,
    details: {
      command_id: error.commandId,
      repository: error.repository,
      error: error.message,
    },
  };
}

async function writeCommandResultsArtifact(
  artifactStore: VerificationArtifactStore,
  taskRunId: string,
  status: "passed" | "failed",
  results: readonly CommandResult[],
  executionError: CommandExecutionError | null,
): Promise<VerificationArtifactReference> {
  return artifactStore.write({
    id: COMMAND_RESULTS_ARTIFACT_ID,
    path: COMMAND_RESULTS_ARTIFACT_PATH,
    mediaType: "application/json",
    data: `${JSON.stringify({
      version: 1,
      task_run_id: redactText(taskRunId),
      verifier_id: COMMAND_VERIFIER_ID,
      status,
      command_results: results.map(safeCommandResult),
      execution_error: executionError,
    }, null, 2)}\n`,
  });
}

function safeCommandResult(result: CommandResult): CommandResult {
  return {
    ...result,
    repository: redactText(result.repository),
    cwd: result.cwd === null ? null : redactText(result.cwd),
    executable: result.executable === null ? null : redactText(result.executable),
    args: result.args.map(redactText),
    stdout: redactText(result.stdout),
    stderr: redactText(result.stderr),
    error: result.error === null ? null : redactText(result.error),
    shellDecisionId: result.shellDecisionId === null
      ? null
      : redactText(result.shellDecisionId),
  };
}

function summarize(
  executedCount: number,
  requiredFailureCount: number,
  optionalFailureCount: number,
  executorFailed: boolean,
): string {
  if (executorFailed) {
    return `Command verification failed closed after ${executedCount} recorded command result(s)`;
  }
  if (requiredFailureCount > 0) {
    return `${requiredFailureCount} required command(s) failed; ${executedCount} command(s) recorded`;
  }
  if (optionalFailureCount > 0) {
    return `Required commands passed; ${optionalFailureCount} optional command failure(s) recorded`;
  }
  return `All ${executedCount} verification command(s) passed`;
}
