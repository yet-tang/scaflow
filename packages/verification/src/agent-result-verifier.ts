import type { GitChangedPath } from "@scaflow/git";
import { agentResultSchema, type AgentResult, type VerificationFailure } from "@scaflow/schemas";

import type { CommandResult } from "./command.js";
import type { VerificationContext, Verifier, VerifierOutput } from "./index.js";

export const AGENT_RESULT_VERIFIER_ID = "agent-result";

export interface ObservedChangedFile {
  readonly repositoryId: string;
  readonly change: GitChangedPath;
}

export interface EngineObservedChangedFiles {
  readonly authority: "engine_observed";
  readonly files: readonly ObservedChangedFile[];
}

export interface EngineObservedCommandResults {
  readonly authority: "engine_observed";
  readonly results: readonly CommandResult[];
}

export interface AgentResultVerifierOptions {
  readonly agentResult: unknown;
  readonly changedFiles: EngineObservedChangedFiles;
  readonly commandResults: EngineObservedCommandResults;
}

export function createAgentResultVerifier(options: AgentResultVerifierOptions): Verifier {
  return {
    id: AGENT_RESULT_VERIFIER_ID,
    async verify(context) {
      return verifyAgentResult(options, context);
    },
  };
}

export function verifyAgentResult(
  options: AgentResultVerifierOptions,
  _context: VerificationContext,
): VerifierOutput {
  if (options.changedFiles.authority !== "engine_observed" ||
      options.commandResults.authority !== "engine_observed") {
    throw new TypeError("Agent Result reconciliation requires Engine-observed Git and command evidence");
  }
  validateObservedFiles(options.changedFiles.files);
  const parsed = agentResultSchema.safeParse(options.agentResult);
  if (!parsed.success) {
    return failed([evidenceFailure(
      "AGENT_RESULT_SCHEMA_INVALID",
      "Agent Result does not match the strict schema",
      { issues: parsed.error.issues.map(issue => ({ path: issue.path.join("."), code: issue.code })) },
    )]);
  }

  const failures: VerificationFailure[] = [];
  reconcileChangedFiles(parsed.data, options.changedFiles.files, failures);
  reconcileCommands(parsed.data, options.commandResults.results, failures);
  const requiredCommandFailed = options.commandResults.results.some(result =>
    result.required && !commandSucceeded(result));
  if (parsed.data.status === "succeeded" && requiredCommandFailed) {
    failures.push(evidenceFailure(
      "AGENT_STATUS_CONTRADICTS_COMMANDS",
      "Agent claimed success while an Engine-observed required command failed",
    ));
  }

  return failures.length === 0 ? {
    status: "passed",
    summary: "Agent Result schema and claims match Engine-observed evidence",
    failures: [],
    artifacts: [],
  } : failed(failures);
}

function reconcileChangedFiles(
  result: AgentResult,
  observed: readonly ObservedChangedFile[],
  failures: VerificationFailure[],
): void {
  const observedPaths = observed.flatMap(canonicalObservedPathIdentities);
  const claimsByPath = new Map<string, Set<string>>();
  for (const entry of observedPaths) {
    const identities = claimsByPath.get(entry.claimedPath) ?? new Set<string>();
    identities.add(entry.identity);
    claimsByPath.set(entry.claimedPath, identities);
  }
  const collisions = [...claimsByPath]
    .filter(([, identities]) => identities.size > 1)
    .map(([claimedPath, identities]) => ({ claimedPath, identities: [...identities].sort() }))
    .sort((left, right) => left.claimedPath.localeCompare(right.claimedPath));
  if (collisions.length > 0) {
    failures.push(evidenceFailure(
      "AGENT_CHANGED_FILES_IDENTITY_COLLISION",
      "Distinct Engine-observed repository paths cannot be represented unambiguously by changed_files",
      { collisions },
    ));
  }
  const actual = normalizeSet(observedPaths.map(({ claimedPath }) => claimedPath));
  const claimed = normalizeSet(result.changed_files.map(normalizeClaimedPath));
  if (JSON.stringify(actual) !== JSON.stringify(claimed)) {
    failures.push(evidenceFailure(
      "AGENT_CHANGED_FILES_MISMATCH",
      "Agent changed_files does not exactly match the complete Engine-observed diff",
      { actual, claimed },
    ));
  }
}

function reconcileCommands(
  result: AgentResult,
  observed: readonly CommandResult[],
  failures: VerificationFailure[],
): void {
  const actual = normalizeMultiset(observed.map(commandResultKey));
  const claimed = normalizeMultiset(result.commands_run.map(commandClaimKey));
  if (JSON.stringify(actual) !== JSON.stringify(claimed)) {
    failures.push(evidenceFailure(
      "AGENT_COMMANDS_MISMATCH",
      "Agent commands_run does not exactly match Engine-observed command results",
      { actual, claimed },
    ));
  }
}

function validateObservedFiles(files: readonly ObservedChangedFile[]): void {
  for (const file of files) {
    const paths = file.change.originalPath === undefined
      ? [file.change.path]
      : [file.change.originalPath, file.change.path];
    if (file.repositoryId.trim().length === 0 || file.change.status.length === 0 ||
        !["committed", "staged", "unstaged", "untracked"].includes(file.change.source) ||
        paths.some(path => path.length === 0 || path.startsWith("/") || path.includes("\\") ||
          path.split("/").some(part => part === "" || part === "." || part === ".."))) {
      throw new TypeError("Engine-observed changed files must use normalized repository-relative paths");
    }
  }
}

function canonicalObservedPathIdentities(
  file: ObservedChangedFile,
): Array<{ claimedPath: string; identity: string }> {
  const prefix = file.repositoryId === "@control" ? "" : `${file.repositoryId}/`;
  const paths = file.change.originalPath === undefined
    ? [file.change.path]
    : [file.change.originalPath, file.change.path];
  return paths.map(path => ({
    claimedPath: `${prefix}${path}`,
    identity: JSON.stringify([file.repositoryId, path]),
  }));
}

function normalizeClaimedPath(path: string): string {
  const normalized = path.trim();
  if (normalized.startsWith("/") || normalized.includes("\\") ||
      normalized.split("/").some(part => part === "" || part === "." || part === "..")) {
    throw new TypeError("Agent changed_files must use normalized TaskRun-relative paths");
  }
  return normalized;
}

function commandResultKey(result: CommandResult): string {
  return JSON.stringify([result.executable, [...result.args], result.exitCode]);
}

function commandClaimKey(command: AgentResult["commands_run"][number]): string {
  return JSON.stringify([command.executable, command.args, command.exit_code]);
}

function normalizeMultiset(values: readonly string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function normalizeSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function commandSucceeded(result: CommandResult): boolean {
  return result.outcome === "succeeded" && result.exitCode === 0 && !result.timedOut;
}

function evidenceFailure(
  code: string,
  message: string,
  details?: NonNullable<VerificationFailure["details"]>,
): VerificationFailure {
  return {
    code,
    category: "evidence",
    repairability: "unknown",
    message,
    ...(details === undefined ? {} : { details }),
  };
}

function failed(failures: readonly VerificationFailure[]): VerifierOutput {
  return {
    status: "failed",
    summary: `Agent Result verification found ${failures.length} failure(s)`,
    failures,
    artifacts: [],
  };
}
