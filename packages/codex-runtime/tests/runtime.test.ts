import { describe, expect, it } from "vitest";
import type { AgentResult } from "@scaflow/schemas";

import { MockAgentRuntime, packageName, type AgentRuntimeEvent } from "../src/index";

const successfulResult: AgentResult = {
  status: "succeeded",
  summary: "done",
  changed_files: ["src/index.ts"],
  commands_run: [],
  acceptance_mapping: [],
  known_limitations: [],
  decision_requests: [],
  risks_detected: [],
};

async function collect(events: AsyncIterable<AgentRuntimeEvent>) {
  const collected: AgentRuntimeEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

const request = { workingDirectory: "/task/run/control", prompt: "work", timeoutMs: 50 };

describe("@scaflow/codex-runtime", () => {
  it("exposes package identity and reports unsupported mock security capabilities", () => {
    const runtime = new MockAgentRuntime([]);
    expect(packageName).toBe("@scaflow/codex-runtime");
    expect(runtime.securityCapabilities).toEqual({
      filesystemIsolation: "unsupported",
      environmentIsolation: "unsupported",
      networkIsolation: "unsupported",
    });
  });

  it("streams ordered events and one final Agent Result", async () => {
    const runtime = new MockAgentRuntime([
      { sessionId: "s-1", messages: ["first", "second"], terminal: { type: "completed", result: successfulResult } },
    ]);
    const execution = runtime.start(request);
    const events = await collect(execution.events);

    expect(execution.sessionId).toBe("s-1");
    expect(events.map(({ sequence, type }) => [sequence, type])).toEqual([
      [0, "session_started"], [1, "message"], [2, "message"], [3, "completed"],
    ]);
    await expect(execution.outcome).resolves.toEqual({ type: "completed", result: successfulResult });
  });

  it("continues the same session with an independent terminal result", async () => {
    const failedResult: AgentResult = { ...successfulResult, status: "failed", summary: "tests failed" };
    const runtime = new MockAgentRuntime([
      {
        sessionId: "repair-1",
        terminal: { type: "completed", result: failedResult },
        continuation: { sessionId: "repair-1", messages: ["repairing"], terminal: { type: "completed", result: successfulResult } },
      },
    ]);
    const first = runtime.start(request);
    await collect(first.events);
    const continued = runtime.continue({ ...request, sessionId: "repair-1" });
    const events = await collect(continued.events);

    expect(events[0]).toMatchObject({ type: "session_continued", sessionId: "repair-1" });
    await expect(continued.outcome).resolves.toEqual({ type: "completed", result: successfulResult });
  });

  it("has deterministic and unambiguous timeout and runtime failure outcomes", async () => {
    const runtime = new MockAgentRuntime([
      { sessionId: "timeout", terminal: { type: "timed_out" } },
      { sessionId: "failure", terminal: { type: "runtime_failed", error: { code: "ADAPTER_EXIT", message: "adapter stopped", recoverable: true } } },
    ]);
    const timedOut = runtime.start({ ...request, timeoutMs: 123 });
    expect((await collect(timedOut.events)).at(-1)).toEqual({ sequence: 1, type: "timed_out", timeoutMs: 123 });
    await expect(timedOut.outcome).resolves.toEqual({ type: "timed_out", timeoutMs: 123 });
    const failed = runtime.start(request);
    await collect(failed.events);
    await expect(failed.outcome).resolves.toMatchObject({ type: "runtime_failed", error: { code: "ADAPTER_EXIT" } });
  });

  it("cancels before completion with one cancellation terminal", async () => {
    const runtime = new MockAgentRuntime([
      { sessionId: "cancel", messages: ["ignored"], terminal: { type: "completed", result: successfulResult } },
    ]);
    const execution = runtime.start(request);
    await execution.cancel("operator request");
    const events = await collect(execution.events);
    expect(events.at(-1)).toEqual({ sequence: 1, type: "cancelled", reason: "operator request" });
    expect(events.some(({ type }) => type === "completed")).toBe(false);
    await expect(execution.outcome).resolves.toEqual({ type: "cancelled", reason: "operator request" });
  });

  it("resolves the terminal outcome without requiring event consumption", async () => {
    const runtime = new MockAgentRuntime([
      { sessionId: "outcome-only", terminal: { type: "completed", result: successfulResult } },
    ]);
    const execution = runtime.start(request);
    await expect(execution.outcome).resolves.toEqual({
      type: "completed",
      result: successfulResult,
    });
    await execution.cancel("too late");
    expect((await collect(execution.events)).at(-1)).toMatchObject({
      type: "completed",
    });
  });

  it("requires explicit working directory, timeout, and valid continuation identity", () => {
    const runtime = new MockAgentRuntime([{ sessionId: "s", terminal: { type: "completed", result: successfulResult } }]);
    expect(() => runtime.start({ ...request, workingDirectory: "" })).toThrow("workingDirectory");
    expect(() => runtime.start({ ...request, timeoutMs: 0 })).toThrow("timeoutMs");
    expect(() => runtime.continue({ ...request, sessionId: "missing" })).toThrow("No continuation script");
  });
});
