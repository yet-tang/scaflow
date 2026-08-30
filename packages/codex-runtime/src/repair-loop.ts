import { createHash } from "node:crypto";

import { redactText } from "@scaflow/core";
import {
  verificationResultSchema,
  type AgentResult,
  type VerificationArtifactReference,
  type VerificationFailure,
  type VerificationResult,
} from "@scaflow/schemas";

import type {
  AgentExecution,
  AgentRuntime,
  AgentRuntimeTerminalOutcome,
} from "./index.js";

export interface RepairPolicy {
  readonly maxAttempts: number;
  readonly maxRepairRoundsPerAttempt: number;
  readonly escalateAfterSameFailure: number;
}

export const defaultRepairPolicy = Object.freeze({
  maxAttempts: 2,
  maxRepairRoundsPerAttempt: 3,
  escalateAfterSameFailure: 2,
} satisfies RepairPolicy);

export interface RepairVerificationContext {
  readonly attempt: number;
  readonly repairRound: number;
  readonly sessionId: string;
  readonly agentResult: AgentResult;
}

export interface RepairLoopOptions {
  readonly runtime: AgentRuntime;
  readonly workingDirectory: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly policy?: RepairPolicy;
  readonly verify: (context: RepairVerificationContext) => Promise<VerificationResult>;
  readonly onExecution?: (execution: AgentExecution) => void;
}

export type RepairLoopReason =
  | "verification_passed"
  | "non_repairable_verification_failure"
  | "unknown_verification_failure"
  | "invalid_verification_evidence"
  | "same_failure_escalated"
  | "repair_limit_exhausted"
  | "runtime_timeout"
  | "runtime_failure"
  | "runtime_cancelled"
  | "runtime_session_mismatch"
  | "verification_execution_failed";

export interface RepairLoopResult {
  readonly state: "succeeded" | "blocked" | "failed";
  readonly reason: RepairLoopReason;
  readonly attempts: number;
  readonly repairRounds: number;
  readonly sessionIds: readonly string[];
  readonly verificationResults: readonly VerificationResult[];
  readonly agentResult?: AgentResult;
  readonly failureSummary?: string;
}

const MAX_SUMMARY_FAILURES = 20;
const MAX_SUMMARY_ARTIFACTS = 10;
const MAX_FAILURE_MESSAGE_LENGTH = 240;
const MAX_SUMMARY_LENGTH = 8_192;
const HOST_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\/(?:Users|home|private|tmp|var|etc|opt|root)\/)[^\s"']+/g;

export async function runRepairLoop(options: RepairLoopOptions): Promise<RepairLoopResult> {
  const policy = validateRepairPolicy(options.policy ?? defaultRepairPolicy);
  const sessionIds: string[] = [];
  const verificationResults: VerificationResult[] = [];
  const failureOccurrences = new Map<string, number>();
  let totalRepairRounds = 0;
  let lastAgentResult: AgentResult | undefined;
  let lastFailureSummary: string | undefined;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    let execution: AgentExecution;
    try {
      execution = options.runtime.start({
        workingDirectory: options.workingDirectory,
        prompt: options.prompt,
        timeoutMs: options.timeoutMs,
      });
    } catch {
      return terminal("failed", "runtime_failure", attempt, totalRepairRounds);
    }
    options.onExecution?.(execution);
    const sessionId = execution.sessionId;
    sessionIds.push(sessionId);
    let repairRound = 0;

    while (true) {
      const outcome = await execution.outcome;
      if (outcome.type !== "completed") {
        const decision = runtimeDecision(outcome, attempt, policy.maxAttempts);
        if (decision.retry) break;
        return terminal(decision.state, decision.reason, attempt, totalRepairRounds);
      }
      lastAgentResult = outcome.result;

      let untrustedVerification: VerificationResult;
      try {
        untrustedVerification = await options.verify({
          attempt,
          repairRound,
          sessionId,
          agentResult: outcome.result,
        });
      } catch {
        return terminal("failed", "verification_execution_failed", attempt, totalRepairRounds);
      }
      const parsedVerification = verificationResultSchema.safeParse(untrustedVerification);
      if (!parsedVerification.success) {
        return terminal("blocked", "invalid_verification_evidence", attempt, totalRepairRounds);
      }
      const verification = parsedVerification.data;
      verificationResults.push(verification);
      if (verification.status === "passed") {
        return terminal("succeeded", "verification_passed", attempt, totalRepairRounds);
      }

      lastFailureSummary = createFailureSummary(verification);
      const eligibility = classifyRepairEligibility(verification.failures);
      if (eligibility !== "repairable") {
        return terminal(
          "blocked",
          eligibility === "non_repairable"
            ? "non_repairable_verification_failure"
            : "unknown_verification_failure",
          attempt,
          totalRepairRounds,
        );
      }

      const fingerprint = createFailureFingerprint(verification);
      const occurrence = (failureOccurrences.get(fingerprint) ?? 0) + 1;
      failureOccurrences.set(fingerprint, occurrence);
      if (occurrence >= policy.escalateAfterSameFailure) {
        return terminal("failed", "same_failure_escalated", attempt, totalRepairRounds);
      }
      if (repairRound >= policy.maxRepairRoundsPerAttempt) break;

      repairRound += 1;
      totalRepairRounds += 1;
      try {
        execution = options.runtime.continue({
          workingDirectory: options.workingDirectory,
          prompt: createRepairPrompt(lastFailureSummary),
          timeoutMs: options.timeoutMs,
          sessionId,
        });
      } catch {
        return terminal("failed", "runtime_failure", attempt, totalRepairRounds);
      }
      options.onExecution?.(execution);
      if (execution.sessionId !== sessionId) {
        return terminal("blocked", "runtime_session_mismatch", attempt, totalRepairRounds);
      }
    }
  }

  return terminal("failed", "repair_limit_exhausted", policy.maxAttempts, totalRepairRounds);

  function terminal(
    state: RepairLoopResult["state"],
    reason: RepairLoopReason,
    attempts: number,
    repairRounds: number,
  ): RepairLoopResult {
    return {
      state,
      reason,
      attempts,
      repairRounds,
      sessionIds: Object.freeze([...sessionIds]),
      verificationResults: Object.freeze([...verificationResults]),
      ...(lastAgentResult === undefined ? {} : { agentResult: lastAgentResult }),
      ...(lastFailureSummary === undefined ? {} : { failureSummary: lastFailureSummary }),
    };
  }
}

export function validateRepairPolicy(policy: RepairPolicy): Readonly<RepairPolicy> {
  const values = {
    maxAttempts: policy.maxAttempts,
    maxRepairRoundsPerAttempt: policy.maxRepairRoundsPerAttempt,
    escalateAfterSameFailure: policy.escalateAfterSameFailure,
  };
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  return Object.freeze(values);
}

export function classifyRepairEligibility(
  failures: readonly VerificationFailure[],
): "repairable" | "non_repairable" | "unknown" {
  if (failures.length === 0) return "unknown";
  if (failures.some(({ repairability }) => repairability === "non_repairable")) {
    return "non_repairable";
  }
  if (failures.some(({ repairability }) => repairability === "unknown")) {
    return "unknown";
  }
  return "repairable";
}

export function createFailureFingerprint(result: VerificationResult): string {
  const records = failureRecords(result)
    .map(({ verifierId, failure }) => JSON.stringify({
      verifier_id: verifierId,
      code: failure.code,
      category: failure.category,
      repairability: failure.repairability,
      identity: stableFailureIdentity(failure.details),
    }))
    .sort();
  return `sha256:${createHash("sha256").update(JSON.stringify(records)).digest("hex")}`;
}

export function createFailureSummary(result: VerificationResult): string {
  const failures = failureRecords(result)
    .map(({ verifierId, failure }) => ({
      verifier: verifierId,
      code: failure.code,
      category: failure.category,
      repairability: failure.repairability,
      message: sanitizeMessage(failure.message),
    }))
    .sort((left, right) => compareCanonical(
      [left.verifier, left.code, left.category, left.repairability, left.message],
      [right.verifier, right.code, right.category, right.repairability, right.message],
    ));
  const artifacts = result.artifacts
    .map(safeArtifact)
    .sort((left, right) => compareCanonical(
      [left.id, left.path, left.sha256],
      [right.id, right.path, right.sha256],
    ));
  const summary = JSON.stringify({
    failures: failures.slice(0, MAX_SUMMARY_FAILURES),
    omitted_failures: Math.max(0, failures.length - MAX_SUMMARY_FAILURES),
    artifacts: artifacts.slice(0, MAX_SUMMARY_ARTIFACTS),
    omitted_artifacts: Math.max(0, artifacts.length - MAX_SUMMARY_ARTIFACTS),
  });
  return summary.slice(0, MAX_SUMMARY_LENGTH);
}

function createRepairPrompt(summary: string): string {
  return [
    "Repair only the Engine-observed verification failures below, then return an updated Agent Result.",
    "Do not change Task scope, policies, contracts, verification commands, or unrelated files.",
    summary,
  ].join("\n");
}

function runtimeDecision(
  outcome: Exclude<AgentRuntimeTerminalOutcome, { type: "completed" }>,
  attempt: number,
  maxAttempts: number,
): { readonly retry: boolean; readonly state: "blocked" | "failed"; readonly reason: RepairLoopReason } {
  if (outcome.type === "cancelled") {
    return { retry: false, state: "failed", reason: "runtime_cancelled" };
  }
  if (outcome.type === "runtime_failed" && !outcome.error.recoverable) {
    return { retry: false, state: "failed", reason: "runtime_failure" };
  }
  return {
    retry: attempt < maxAttempts,
    state: "failed",
    reason: outcome.type === "timed_out" ? "runtime_timeout" : "runtime_failure",
  };
}

function failureRecords(result: VerificationResult): Array<{
  readonly verifierId: string;
  readonly failure: VerificationFailure;
}> {
  return result.verifier_results.flatMap(({ verifier_id: verifierId, failures }) =>
    failures.map((failure) => ({ verifierId, failure })),
  );
}

function sanitizeMessage(message: string): string {
  return redactText(message)
    .replace(HOST_PATH_PATTERN, "[HOST_PATH]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FAILURE_MESSAGE_LENGTH);
}

function safeArtifact(artifact: VerificationArtifactReference) {
  return {
    id: artifact.id,
    path: artifact.path,
    media_type: artifact.media_type,
    byte_length: artifact.byte_length,
    sha256: artifact.sha256,
  };
}

function stableFailureIdentity(
  details: VerificationFailure["details"],
): Readonly<Record<string, string | readonly string[]>> {
  if (details === undefined) return {};

  const identity: Record<string, string | readonly string[]> = {};
  if (isSafeIdentity(details.command_id)) identity.command_id = details.command_id;
  const repositories = [...new Set(
    [details.repository, details.repository_id].filter(isSafeIdentity),
  )].sort();
  if (repositories.length === 1) identity.repository = repositories[0]!;
  if (repositories.length > 1) identity.repository = Object.freeze(repositories);
  if (isNormalizedRepositoryPath(details.path)) identity.path = details.path;
  if (
    Array.isArray(details.changed_paths) &&
    details.changed_paths.every(isNormalizedRepositoryPath)
  ) {
    identity.changed_paths = Object.freeze([...details.changed_paths].sort());
  }
  return identity;
}

function isSafeIdentity(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9@][A-Za-z0-9._:@/-]*$/.test(value) &&
    !value.includes("//") &&
    !value.includes("..") &&
    !value.includes("/");
}

function isNormalizedRepositoryPath(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1_024 &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/.test(value) &&
    !value.includes("\\") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function compareCanonical(left: readonly string[], right: readonly string[]): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
