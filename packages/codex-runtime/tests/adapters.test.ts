import { describe, expect, it, vi } from "vitest";
import type { ThreadEvent } from "@openai/codex-sdk";
import { agentResultSchema, type AgentResult } from "@scaflow/schemas";

import {
  CodexExecAgentRuntime,
  CodexSdkAgentRuntime,
  type AgentRuntimeEvent,
  type CodexExecProcess,
  type CodexExecSpawnRequest,
  type CodexSdkClient,
  type CodexSdkThread,
} from "../src/index.js";

const result: AgentResult = {
  status: "succeeded",
  summary: "done",
  changed_files: ["src/index.ts"],
  commands_run: [],
  acceptance_mapping: [],
  known_limitations: [],
  decision_requests: [],
  risks_detected: [],
};
const resultText = JSON.stringify(result);
const request = { workingDirectory: "/task/run/control", prompt: "work", timeoutMs: 1000 };

function sensitiveResult(sensitiveValue: string): AgentResult {
  return {
    status: "blocked",
    summary: `summary ${request.prompt} ${sensitiveValue}`,
    changed_files: [`src/${sensitiveValue}.ts`],
    commands_run: [{
      executable: `tool-${sensitiveValue}`,
      args: [request.prompt, sensitiveValue],
      exit_code: 7,
    }],
    acceptance_mapping: [{
      acceptance_criterion_id: `AC-${sensitiveValue}`,
      evidence: [`evidence ${request.prompt} ${sensitiveValue}`],
      satisfied: false,
    }],
    known_limitations: [`limitation ${sensitiveValue}`],
    decision_requests: [{
      question: `question ${sensitiveValue}`,
      context: `context ${request.prompt}`,
      options: [`option ${sensitiveValue}`],
    }],
    risks_detected: [{ description: `risk ${sensitiveValue}`, severity: "high" }],
  };
}

function expectRedactedResult(
  outcome: Awaited<ReturnType<CodexSdkAgentRuntime["start"]>["outcome"]>,
  sensitiveValue: string,
): void {
  expect(outcome.type).toBe("completed");
  if (outcome.type !== "completed") return;
  expect(agentResultSchema.safeParse(outcome.result).success).toBe(true);
  expect(JSON.stringify(outcome.result)).not.toContain(request.prompt);
  expect(JSON.stringify(outcome.result)).not.toContain(sensitiveValue);
  expect(outcome.result).toMatchObject({
    status: "blocked",
    commands_run: [{ exit_code: 7 }],
    acceptance_mapping: [{ satisfied: false }],
    risks_detected: [{ severity: "high" }],
  });
}

async function collect(events: AsyncIterable<AgentRuntimeEvent>) {
  const output: AgentRuntimeEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}

function sdkThread(
  id: string,
  finalResponse = resultText,
  messages: readonly string[] = [],
): CodexSdkThread {
  return {
    id,
    async runStreamed(_prompt, options) {
      return {
        events: (async function* (): AsyncGenerator<ThreadEvent> {
          if (options?.signal?.aborted) return;
          yield { type: "thread.started", thread_id: id };
          for (const message of messages) {
            yield { type: "item.completed", item: { id: "message", type: "agent_message", text: message } };
          }
          yield { type: "item.completed", item: { id: "final", type: "agent_message", text: finalResponse } };
          yield {
            type: "turn.completed",
            usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
          };
        })(),
      };
    },
  };
}

describe("CodexSdkAgentRuntime", () => {
  it("starts and continues the same provider thread with ordered redacted events", async () => {
    const startThread = vi.fn(() => sdkThread("provider-1", `${resultText}\ntoken=sdk-secret`));
    const resumeThread = vi.fn((id: string) => sdkThread(id));
    const client: CodexSdkClient = { startThread, resumeThread };
    const runtime = new CodexSdkAgentRuntime({ clientFactory: () => client });
    const first = runtime.start(request);
    const firstEvents = await collect(first.events);

    expect(firstEvents.map(({ sequence, type }) => [sequence, type])).toEqual([
      [0, "session_started"], [1, "message"], [2, "runtime_failed"],
    ]);
    expect((firstEvents[1] as { message: string }).message).not.toContain("sdk-secret");

    const secondStart = vi.fn(() => sdkThread("provider-2"));
    const successRuntime = new CodexSdkAgentRuntime({
      clientFactory: () => ({ startThread: secondStart, resumeThread }),
    });
    const successful = successRuntime.start(request);
    await expect(successful.outcome).resolves.toEqual({ type: "completed", result });
    const continued = successRuntime.continue({ ...request, sessionId: successful.sessionId });
    await expect(continued.outcome).resolves.toEqual({ type: "completed", result });
    expect(resumeThread).toHaveBeenCalledWith("provider-2", { workingDirectory: request.workingDirectory });
    expect(continued.sessionId).toBe(successful.sessionId);
  });

  it("returns stable failures for malformed results and redacts provider errors", async () => {
    const malformed = new CodexSdkAgentRuntime({
      clientFactory: () => ({ startThread: () => sdkThread("bad", "not-json"), resumeThread: () => sdkThread("bad") }),
    }).start(request);
    await expect(malformed.outcome).resolves.toMatchObject({
      type: "runtime_failed",
      error: { code: "CODEX_RESULT_MALFORMED", recoverable: true },
    });

    const failingThread: CodexSdkThread = {
      id: "failure",
      async runStreamed(prompt) {
        return { events: (async function* () { throw new Error(`provider echoed ${prompt} sdk-sensitive`); })() };
      },
    };
    const failed = new CodexSdkAgentRuntime({
      sensitiveValues: ["sdk-sensitive"],
      clientFactory: () => ({ startThread: () => failingThread, resumeThread: () => failingThread }),
    }).start(request);
    const outcome = await failed.outcome;
    expect(outcome).toMatchObject({ type: "runtime_failed", error: { code: "CODEX_PROVIDER_FAILED" } });
    expect(JSON.stringify(outcome)).not.toContain(request.prompt);
    expect(JSON.stringify(outcome)).not.toContain("sdk-sensitive");
  });

  it("redacts exact execution-specific values from messages without changing result parsing", async () => {
    const runtime = new CodexSdkAgentRuntime({
      sensitiveValues: ["sdk-sensitive"],
      clientFactory: () => ({
        startThread: () => sdkThread("redacted", resultText, [request.prompt, "sdk-sensitive"]),
        resumeThread: () => sdkThread("redacted"),
      }),
    });
    const execution = runtime.start(request);

    await expect(execution.outcome).resolves.toEqual({ type: "completed", result });
    const events = await collect(execution.events);
    expect(JSON.stringify(events)).not.toContain(request.prompt);
    expect(JSON.stringify(events)).not.toContain("sdk-sensitive");
    expect(events.filter(({ type }) => type === "message")).toHaveLength(3);
  });

  it("redacts every free-form field in completed Agent Results", async () => {
    const sensitiveValue = "sdk-sensitive-result";
    const runtime = new CodexSdkAgentRuntime({
      sensitiveValues: [sensitiveValue],
      clientFactory: () => ({
        startThread: () => sdkThread("result-redaction", JSON.stringify(sensitiveResult(sensitiveValue))),
        resumeThread: () => sdkThread("result-redaction"),
      }),
    });
    const execution = runtime.start(request);

    const outcome = await execution.outcome;
    expectRedactedResult(outcome, sensitiveValue);
    const events = await collect(execution.events);
    const completed = events.find(({ type }) => type === "completed");
    expect(JSON.stringify(completed)).not.toContain(request.prompt);
    expect(JSON.stringify(completed)).not.toContain(sensitiveValue);
  });

  it("settles cancellation and timeout without consuming events", async () => {
    let observedSignal: AbortSignal | undefined;
    const pendingThread: CodexSdkThread = {
      id: "pending",
      async runStreamed(_prompt, options) {
        observedSignal = options?.signal;
        return {
          events: (async function* () {
            await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => {
              resolve();
            }, { once: true }));
          })(),
        };
      },
    };
    const runtime = new CodexSdkAgentRuntime({
      sensitiveValues: ["sdk-sensitive"],
      clientFactory: () => ({ startThread: () => pendingThread, resumeThread: () => pendingThread }),
    });
    const cancelled = runtime.start(request);
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    await cancelled.cancel(`${request.prompt} sdk-sensitive`);
    const cancelledOutcome = await cancelled.outcome;
    expect(cancelledOutcome).toMatchObject({ type: "cancelled" });
    expect(JSON.stringify(cancelledOutcome)).not.toContain(request.prompt);
    expect(JSON.stringify(cancelledOutcome)).not.toContain("sdk-sensitive");
    expect(observedSignal?.aborted).toBe(true);

    const timedOut = runtime.start({ ...request, timeoutMs: 5 });
    await expect(timedOut.outcome).resolves.toEqual({ type: "timed_out", timeoutMs: 5 });
  });

  it("does not start a thread when timeout wins during client creation", async () => {
    let resolveClient!: (client: CodexSdkClient) => void;
    const clientPromise = new Promise<CodexSdkClient>((resolve) => { resolveClient = resolve; });
    const startThread = vi.fn(() => sdkThread("too-late"));
    const runtime = new CodexSdkAgentRuntime({
      clientFactory: () => clientPromise,
    });
    const execution = runtime.start({ ...request, timeoutMs: 5 });

    await expect(execution.outcome).resolves.toEqual({ type: "timed_out", timeoutMs: 5 });
    resolveClient({ startThread, resumeThread: () => sdkThread("too-late") });
    await vi.waitFor(() => expect(startThread).not.toHaveBeenCalled());
  });

  it("rejects absent continuation identities", () => {
    const runtime = new CodexSdkAgentRuntime({ clientFactory: () => ({ startThread: () => sdkThread("x"), resumeThread: () => sdkThread("x") }) });
    expect(() => runtime.continue({ ...request, sessionId: "missing" })).toThrow("No Codex SDK session");
  });
});

function lines(...events: unknown[]): AsyncIterable<string> {
  return (async function* () {
    for (const event of events) yield `${JSON.stringify(event)}\n`;
  })();
}

function fakeProcess(options: {
  stdout?: AsyncIterable<string | Uint8Array>;
  stderr?: AsyncIterable<string | Uint8Array>;
  exitCode?: number;
  onKill?: () => void;
} = {}): CodexExecProcess {
  return {
    stdout: options.stdout ?? lines(
      { type: "thread.started", thread_id: "exec-provider" },
      { type: "item.completed", item: { type: "agent_message", text: resultText } },
      { type: "turn.completed" },
    ),
    stderr: options.stderr ?? lines(),
    outcome: Promise.resolve({ exitCode: options.exitCode ?? 0, signal: null }),
    writeStdin: vi.fn(),
    closeStdin: vi.fn(),
    kill: vi.fn(options.onKill),
  };
}

function splitUtf8(value: string, needle: string): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(value);
  const splitAt = encoder.encode(value.slice(0, value.indexOf(needle))).length + 1;
  return (async function* () {
    yield encoded.slice(0, splitAt);
    yield encoded.slice(splitAt);
  })();
}

describe("CodexExecAgentRuntime", () => {
  it("uses a structured direct spawn, stdin prompt, and exact provider continuation", async () => {
    const requests: CodexExecSpawnRequest[] = [];
    const children: CodexExecProcess[] = [];
    const runtime = new CodexExecAgentRuntime({
      spawner: (spawnRequest) => {
        requests.push(spawnRequest);
        const child = fakeProcess();
        children.push(child);
        return child;
      },
    });
    const first = runtime.start(request);
    await expect(first.outcome).resolves.toEqual({ type: "completed", result });
    const continued = runtime.continue({ ...request, sessionId: first.sessionId });
    await expect(continued.outcome).resolves.toEqual({ type: "completed", result });

    expect(requests).toEqual([
      { executable: "codex", args: ["exec", "--json", "-"], cwd: request.workingDirectory, shell: false },
      { executable: "codex", args: ["exec", "resume", "--json", "exec-provider", "-"], cwd: request.workingDirectory, shell: false },
    ]);
    expect(children[0]?.writeStdin).toHaveBeenCalledWith(request.prompt);
    expect(requests.flatMap(({ args }) => args)).not.toContain(request.prompt);
  });

  it("classifies invalid JSONL, unsuccessful exits, and redacts stderr", async () => {
    const invalid = new CodexExecAgentRuntime({
      spawner: () => fakeProcess({ stdout: (async function* () { yield "not-json\n"; })() }),
    }).start(request);
    await expect(invalid.outcome).resolves.toMatchObject({ type: "runtime_failed", error: { code: "CODEX_EXEC_JSONL_INVALID" } });

    const exited = new CodexExecAgentRuntime({
      sensitiveValues: ["exec-sensitive"],
      spawner: () => fakeProcess({
        stdout: lines({ type: "thread.started", thread_id: "failed" }),
        stderr: (async function* () { yield `${request.prompt} exec-sensitive`; })(),
        exitCode: 2,
      }),
    }).start(request);
    const outcome = await exited.outcome;
    expect(outcome).toMatchObject({ type: "runtime_failed", error: { code: "CODEX_EXEC_EXIT" } });
    expect(JSON.stringify(outcome)).not.toContain(request.prompt);
    expect(JSON.stringify(outcome)).not.toContain("exec-sensitive");
  });

  it("redacts exact execution-specific values from exec messages", async () => {
    const runtime = new CodexExecAgentRuntime({
      sensitiveValues: ["exec-sensitive"],
      spawner: () => fakeProcess({
        stdout: lines(
          { type: "thread.started", thread_id: "redacted" },
          { type: "item.completed", item: { type: "agent_message", text: request.prompt } },
          { type: "item.completed", item: { type: "agent_message", text: "exec-sensitive" } },
          { type: "item.completed", item: { type: "agent_message", text: resultText } },
          { type: "turn.completed" },
        ),
      }),
    });
    const execution = runtime.start(request);

    await expect(execution.outcome).resolves.toEqual({ type: "completed", result });
    const events = await collect(execution.events);
    expect(JSON.stringify(events)).not.toContain(request.prompt);
    expect(JSON.stringify(events)).not.toContain("exec-sensitive");
    expect(events.filter(({ type }) => type === "message")).toHaveLength(3);
  });

  it("redacts every free-form field in exec completed Agent Results", async () => {
    const sensitiveValue = "exec-sensitive-result";
    const runtime = new CodexExecAgentRuntime({
      sensitiveValues: [sensitiveValue],
      spawner: () => fakeProcess({
        stdout: lines(
          { type: "thread.started", thread_id: "result-redaction" },
          {
            type: "item.completed",
            item: { type: "agent_message", text: JSON.stringify(sensitiveResult(sensitiveValue)) },
          },
          { type: "turn.completed" },
        ),
      }),
    });
    const execution = runtime.start(request);

    const outcome = await execution.outcome;
    expectRedactedResult(outcome, sensitiveValue);
    const events = await collect(execution.events);
    const completed = events.find(({ type }) => type === "completed");
    expect(JSON.stringify(completed)).not.toContain(request.prompt);
    expect(JSON.stringify(completed)).not.toContain(sensitiveValue);
  });

  it("preserves UTF-8 split across stdout byte chunks", async () => {
    const unicodeResult: AgentResult = { ...result, summary: "完成🚀" };
    const output = [
      JSON.stringify({ type: "thread.started", thread_id: "unicode" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify(unicodeResult) },
      }),
    ].join("\n");
    const execution = new CodexExecAgentRuntime({
      spawner: () => fakeProcess({ stdout: splitUtf8(output, "🚀") }),
    }).start(request);

    await expect(execution.outcome).resolves.toEqual({
      type: "completed",
      result: unicodeResult,
    });
  });

  it("preserves and redacts UTF-8 split across stderr byte chunks", async () => {
    const sensitiveValue = "stderr-sensitive";
    const execution = new CodexExecAgentRuntime({
      sensitiveValues: [sensitiveValue],
      spawner: () => fakeProcess({
        stdout: lines({ type: "thread.started", thread_id: "unicode-error" }),
        stderr: splitUtf8(`失败🚀 ${sensitiveValue}`, "🚀"),
        exitCode: 2,
      }),
    }).start(request);

    const outcome = await execution.outcome;
    expect(outcome).toMatchObject({
      type: "runtime_failed",
      error: { code: "CODEX_EXEC_EXIT", message: expect.stringContaining("失败🚀") },
    });
    expect(JSON.stringify(outcome)).not.toContain("�");
    expect(JSON.stringify(outcome)).not.toContain(sensitiveValue);
  });

  it("kills once when cancellation wins a terminal race", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const child = fakeProcess({
      stdout: (async function* () { await blocked; })(),
      onKill: () => release(),
    });
    const execution = new CodexExecAgentRuntime({ spawner: () => child }).start(request);
    await Promise.resolve();
    await Promise.all([execution.cancel("stop"), execution.cancel("again")]);
    await expect(execution.outcome).resolves.toEqual({ type: "cancelled", reason: "stop" });
    expect(child.kill).toHaveBeenCalledTimes(1);
    const events = await collect(execution.events);
    expect(events.filter(({ type }) => ["completed", "cancelled", "timed_out", "runtime_failed"].includes(type))).toHaveLength(1);
  });
});
