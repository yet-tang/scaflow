import { describe, expect, it, vi } from "vitest";
import {
  verificationResultSchema,
  type AgentResult,
  type VerificationFailure,
  type VerificationResult,
} from "@scaflow/schemas";

import {
  MockAgentRuntime,
  classifyRepairEligibility,
  createFailureFingerprint,
  createFailureSummary,
  defaultRepairPolicy,
  runRepairLoop,
  validateRepairPolicy,
  type AgentExecution,
  type AgentRuntime,
  type ContinueAgentSessionRequest,
  type MockSessionScript,
  type StartAgentSessionRequest,
} from "../src/index";

const agentResult: AgentResult = {
  status: "succeeded",
  summary: "implementation ready",
  changed_files: [],
  commands_run: [],
  acceptance_mapping: [],
  known_limitations: [],
  decision_requests: [],
  risks_detected: [],
};

const passed = verificationResultSchema.parse({
  status: "passed",
  verifier_results: [{
    verifier_id: "commands",
    status: "passed",
    summary: "passed",
    failures: [],
    artifacts: [],
  }],
  failures: [],
  artifacts: [],
});

function failure(
  code: string,
  repairability: VerificationFailure["repairability"] = "repairable",
  message = "verification failed",
  category: VerificationFailure["category"] = "execution",
  details?: VerificationFailure["details"],
): VerificationResult {
  const item = { code, category, repairability, message, ...(
    details === undefined ? {} : { details }
  ) };
  return verificationResultSchema.parse({
    status: "failed",
    verifier_results: [{
      verifier_id: "commands",
      status: "failed",
      summary: "failed",
      failures: [item],
      artifacts: [],
    }],
    failures: [item],
    artifacts: [],
  });
}

class RecordingRuntime implements AgentRuntime {
  readonly securityCapabilities;
  readonly starts: StartAgentSessionRequest[] = [];
  readonly continuations: ContinueAgentSessionRequest[] = [];
  readonly #delegate: MockAgentRuntime;

  constructor(scripts: readonly MockSessionScript[]) {
    this.#delegate = new MockAgentRuntime(scripts);
    this.securityCapabilities = this.#delegate.securityCapabilities;
  }

  start(request: StartAgentSessionRequest): AgentExecution {
    this.starts.push(request);
    return this.#delegate.start(request);
  }

  continue(request: ContinueAgentSessionRequest): AgentExecution {
    this.continuations.push(request);
    return this.#delegate.continue(request);
  }
}

function script(sessionId: string, continuation?: MockSessionScript): MockSessionScript {
  return {
    sessionId,
    terminal: { type: "completed", result: agentResult },
    ...(continuation === undefined ? {} : { continuation }),
  };
}

const baseOptions = {
  workingDirectory: "/task/run/control",
  prompt: "implement task",
  timeoutMs: 100,
};

describe("repair policy", () => {
  it("exports the exact contract defaults and validates all counters", () => {
    expect(defaultRepairPolicy).toEqual({
      maxAttempts: 2,
      maxRepairRoundsPerAttempt: 3,
      escalateAfterSameFailure: 2,
    });
    expect(Object.isFrozen(defaultRepairPolicy)).toBe(true);
    expect(validateRepairPolicy(defaultRepairPolicy)).toEqual(defaultRepairPolicy);
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateRepairPolicy({
        ...defaultRepairPolicy,
        maxAttempts: value,
      })).toThrow("maxAttempts");
    }
    expect(() => validateRepairPolicy({
      ...defaultRepairPolicy,
      maxRepairRoundsPerAttempt: undefined as unknown as number,
    })).toThrow("maxRepairRoundsPerAttempt");
  });
});

describe("repair loop", () => {
  it("succeeds on first-pass Engine verification", async () => {
    const runtime = new RecordingRuntime([script("session-1")]);
    const verify = vi.fn().mockResolvedValue(passed);

    const result = await runRepairLoop({ ...baseOptions, runtime, verify });

    expect(result).toMatchObject({
      state: "succeeded",
      reason: "verification_passed",
      attempts: 1,
      repairRounds: 0,
      sessionIds: ["session-1"],
    });
    expect(verify).toHaveBeenCalledOnce();
    expect(runtime.continuations).toHaveLength(0);
  });

  it("continues the same session and re-verifies after the repair", async () => {
    const runtime = new RecordingRuntime([
      script("repair-session", script("repair-session")),
    ]);
    const verify = vi.fn()
      .mockResolvedValueOnce(failure("TEST_FAILED", "repairable", "token=super-secret at /Users/dev/project/test.ts"))
      .mockResolvedValueOnce(passed);

    const result = await runRepairLoop({ ...baseOptions, runtime, verify });

    expect(result).toMatchObject({ state: "succeeded", attempts: 1, repairRounds: 1 });
    expect(verify.mock.calls.map(([context]) => context)).toMatchObject([
      { attempt: 1, repairRound: 0, sessionId: "repair-session" },
      { attempt: 1, repairRound: 1, sessionId: "repair-session" },
    ]);
    expect(runtime.continuations).toHaveLength(1);
    expect(runtime.continuations[0]).toMatchObject({ sessionId: "repair-session" });
    expect(runtime.continuations[0]!.prompt).toContain("[REDACTED]");
    expect(runtime.continuations[0]!.prompt).toContain("[HOST_PATH]");
    expect(runtime.continuations[0]!.prompt).not.toContain("super-secret");
    expect(runtime.continuations[0]!.prompt).not.toContain("/Users/dev");
  });

  it("allows exactly three continuations per attempt then starts a new session", async () => {
    const runtime = new RecordingRuntime([
      script("attempt-1", script("attempt-1", script("attempt-1", script("attempt-1")))),
      script("attempt-2"),
    ]);
    const verify = vi.fn()
      .mockResolvedValueOnce(failure("FAILURE_1"))
      .mockResolvedValueOnce(failure("FAILURE_2"))
      .mockResolvedValueOnce(failure("FAILURE_3"))
      .mockResolvedValueOnce(failure("FAILURE_4"))
      .mockResolvedValueOnce(passed);

    const result = await runRepairLoop({
      ...baseOptions,
      runtime,
      verify,
      policy: { ...defaultRepairPolicy, escalateAfterSameFailure: 10 },
    });

    expect(result).toMatchObject({
      state: "succeeded",
      attempts: 2,
      repairRounds: 3,
      sessionIds: ["attempt-1", "attempt-2"],
    });
    expect(runtime.starts).toHaveLength(2);
    expect(runtime.continuations).toHaveLength(3);
    expect(verify).toHaveBeenCalledTimes(5);
  });

  it("exhausts at two attempts and three repair continuations per attempt", async () => {
    const runtime = new RecordingRuntime([
      script("limit-1", script("limit-1", script("limit-1", script("limit-1")))),
      script("limit-2", script("limit-2", script("limit-2", script("limit-2")))),
    ]);
    let verification = 0;
    const result = await runRepairLoop({
      ...baseOptions,
      runtime,
      verify: async () => failure(`CHANGING_FAILURE_${verification++}`),
      policy: { ...defaultRepairPolicy, escalateAfterSameFailure: 10 },
    });

    expect(result).toMatchObject({
      state: "failed",
      reason: "repair_limit_exhausted",
      attempts: 2,
      repairRounds: 6,
    });
    expect(runtime.starts).toHaveLength(2);
    expect(runtime.continuations).toHaveLength(6);
    expect(verification).toBe(8);
  });

  it("escalates an equivalent failure at the exact configured occurrence", async () => {
    const runtime = new RecordingRuntime([
      script("same", script("same")),
    ]);
    const first = failure("TEST_FAILED", "repairable", "first wording", "execution", {
      repository: "@control",
      command_id: "verification-command-0001",
      outcome: "failed",
      timestamp: "2026-08-30T10:00:00Z",
    });
    const second = failure("TEST_FAILED", "repairable", "changed prose and /tmp/result.log", "execution", {
      stderr: "token=do-not-copy",
      timestamp: "2026-08-30T10:01:00Z",
      command_id: "verification-command-0001",
      repository: "@control",
      outcome: "timed_out",
    });
    const verify = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const result = await runRepairLoop({ ...baseOptions, runtime, verify });

    expect(createFailureFingerprint(first)).toBe(createFailureFingerprint(second));
    expect(result).toMatchObject({
      state: "failed",
      reason: "same_failure_escalated",
      attempts: 1,
      repairRounds: 1,
    });
    expect(runtime.continuations).toHaveLength(1);
  });

  it("does not escalate distinct stable failure identities", async () => {
    const runtime = new RecordingRuntime([
      script("distinct", script("distinct", script("distinct"))),
    ]);
    const verify = vi.fn()
      .mockResolvedValueOnce(failure("TEST_FAILED", "repairable", "first", "execution", {
        command_id: "verification-command-0001",
        repository: "@control",
      }))
      .mockResolvedValueOnce(failure("TEST_FAILED", "repairable", "second", "execution", {
        command_id: "verification-command-0002",
        repository: "@control",
      }))
      .mockResolvedValueOnce(passed);

    const result = await runRepairLoop({ ...baseOptions, runtime, verify });

    expect(result).toMatchObject({ state: "succeeded", attempts: 1, repairRounds: 2 });
    expect(runtime.continuations).toHaveLength(2);
  });

  it.each([
    "REPOSITORY_IDENTITY_MISMATCH",
    "UNAUTHORIZED_REPOSITORY_CHANGE",
    "READ_ONLY_REPOSITORY_CHANGE",
    "PROTECTED_CONTROL_PATH",
    "SECRET_EXPOSURE",
    "TASK_CONTRACT_INVALID",
    "WORKSPACE_CORRUPTION",
    "OTHER_TASK_RUN_TARGET",
    "WORKSPACE_REPOS_TARGET",
    "INVALID_VERIFICATION_EVIDENCE",
  ])("blocks non-repairable %s without sending a repair prompt", async (code) => {
    const runtime = new RecordingRuntime([script("blocked")]);
    const result = await runRepairLoop({
      ...baseOptions,
      runtime,
      verify: async () => failure(code, "non_repairable", "unsafe condition", "policy"),
    });

    expect(result).toMatchObject({
      state: "blocked",
      reason: "non_repairable_verification_failure",
    });
    expect(runtime.continuations).toHaveLength(0);
  });

  it("fails closed for unknown and mixed classifications", async () => {
    expect(classifyRepairEligibility([
      failure("UNKNOWN", "unknown").failures[0]!,
    ])).toBe("unknown");
    expect(classifyRepairEligibility([
      failure("REPAIRABLE").failures[0]!,
      failure("BLOCKED", "non_repairable").failures[0]!,
    ])).toBe("non_repairable");
    const runtime = new RecordingRuntime([script("unknown")]);
    const result = await runRepairLoop({
      ...baseOptions,
      runtime,
      verify: async () => failure("VERIFIER_EXECUTION_ERROR", "unknown"),
    });
    expect(result).toMatchObject({ state: "blocked", reason: "unknown_verification_failure" });
    expect(runtime.continuations).toHaveLength(0);
  });

  it("retries recoverable runtime failures with a new attempt and fails unrecoverable outcomes", async () => {
    const recoverable = new RecordingRuntime([
      { sessionId: "runtime-failed", terminal: { type: "runtime_failed", error: {
        code: "ADAPTER_EXIT", message: "stopped", recoverable: true,
      } } },
      script("new-attempt"),
    ]);
    await expect(runRepairLoop({
      ...baseOptions,
      runtime: recoverable,
      verify: async () => passed,
    })).resolves.toMatchObject({ state: "succeeded", attempts: 2, sessionIds: ["runtime-failed", "new-attempt"] });

    const timedOut = new RecordingRuntime([
      { sessionId: "timeout-1", terminal: { type: "timed_out" } },
      { sessionId: "timeout-2", terminal: { type: "timed_out" } },
    ]);
    await expect(runRepairLoop({
      ...baseOptions,
      runtime: timedOut,
      verify: async () => passed,
    })).resolves.toMatchObject({ state: "failed", reason: "runtime_timeout", attempts: 2 });

    const unrecoverable = new RecordingRuntime([{
      sessionId: "fatal",
      terminal: { type: "runtime_failed", error: { code: "FATAL", message: "fatal", recoverable: false } },
    }]);
    await expect(runRepairLoop({
      ...baseOptions,
      runtime: unrecoverable,
      verify: async () => passed,
    })).resolves.toMatchObject({ state: "failed", reason: "runtime_failure", attempts: 1 });
  });

  it("produces bounded deterministic summaries without details or incidental ordering", () => {
    const left = failure("Z_FAILURE", "repairable", "password=hunter2 in /home/dev/output.log");
    const summary = createFailureSummary(left);
    expect(summary.length).toBeLessThanOrEqual(8_192);
    expect(summary).toContain("[REDACTED]");
    expect(summary).toContain("[HOST_PATH]");
    expect(summary).not.toContain("hunter2");
    expect(summary).not.toContain("/home/dev");
    expect(summary).toBe(createFailureSummary(left));
  });

  it.each([
    ["command_id", "verification-command-0001", "verification-command-0002"],
    ["repository", "@control", "api"],
    ["repository_id", "api", "web"],
    ["path", "src/one.test.ts", "src/two.test.ts"],
  ] as const)("distinguishes the stable %s failure identity", (key, left, right) => {
    const first = failure("TEST_FAILED", "repairable", "same", "execution", { [key]: left });
    const second = failure("TEST_FAILED", "repairable", "same", "execution", { [key]: right });
    expect(createFailureFingerprint(first)).not.toBe(createFailureFingerprint(second));
  });

  it("canonicalizes failure ordering, detail ordering, and stable path arrays", () => {
    const first = failure("FIRST", "repairable", "first wording", "execution", {
      repository_id: "api",
      changed_paths: ["src/z.test.ts", "src/a.test.ts", "src/a.test.ts"],
      stdout: "secret output",
    }).failures[0]!;
    const second = failure("SECOND", "repairable", "second wording", "policy", {
      path: "tests/example.test.ts",
      repository_id: "web",
    }).failures[0]!;
    const makeResult = (failures: readonly VerificationFailure[]) => verificationResultSchema.parse({
      status: "failed",
      verifier_results: [{
        verifier_id: "commands",
        status: "failed",
        summary: "failed",
        failures,
        artifacts: [],
      }],
      failures,
      artifacts: [],
    });
    const reorderedFirst = {
      ...first,
      message: "different prose",
      details: {
        error: "token=do-not-copy",
        changed_paths: ["src/a.test.ts", "src/z.test.ts", "src/a.test.ts"],
        repository_id: "api",
      },
    };

    const fingerprint = createFailureFingerprint(makeResult([first, second]));
    expect(fingerprint).toBe(createFailureFingerprint(makeResult([second, reorderedFirst])));
    expect(fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain("do-not-copy");
  });

  it("normalizes repository and repository_id conventions to the same identity", () => {
    const repository = failure("TEST_FAILED", "repairable", "first", "execution", {
      repository: "api",
    });
    const repositoryId = failure("TEST_FAILED", "repairable", "second", "execution", {
      repository_id: "api",
    });
    expect(createFailureFingerprint(repository)).toBe(createFailureFingerprint(repositoryId));
  });

  it("omits unsafe paths and unsupported volatile or sensitive details", () => {
    const baseline = failure("TEST_FAILED");
    for (const details of [
      { path: "/Users/dev/secret.txt" },
      { path: "../secret.txt" },
      { path: "src\\secret.txt" },
      { artifact_path: "evidence/output.json", token: "super-secret", stderr: "raw output" },
    ]) {
      const candidate = failure("TEST_FAILED", "repairable", "changed prose", "execution", details);
      expect(createFailureFingerprint(candidate)).toBe(createFailureFingerprint(baseline));
    }
  });

  it("blocks malformed verification evidence instead of sending it to the Agent", async () => {
    const runtime = new RecordingRuntime([script("invalid")]);
    const result = await runRepairLoop({
      ...baseOptions,
      runtime,
      verify: async () => ({ status: "failed", failures: [] }) as VerificationResult,
    });
    expect(result).toMatchObject({ state: "blocked", reason: "invalid_verification_evidence" });
    expect(runtime.continuations).toHaveLength(0);
  });
});
