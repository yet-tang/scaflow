import { describe, expect, it } from "vitest";

import { CodexExecAgentRuntime, CodexSdkAgentRuntime } from "../src/index.js";

describe("Codex SDK live smoke", () => {
  it("returns a schema-valid Agent Result from a real Codex session", async () => {
    const runtime = new CodexSdkAgentRuntime();
    const execution = runtime.start({
      workingDirectory: process.cwd(),
      prompt: "Return only a valid Scaflow Agent Result JSON object for a no-change successful task.",
      timeoutMs: 120_000,
    });
    await expect(execution.outcome).resolves.toMatchObject({ type: "completed" });
  }, 130_000);
});

describe("codex exec live smoke", () => {
  it("returns a schema-valid Agent Result from the real CLI", async () => {
    const runtime = new CodexExecAgentRuntime();
    const execution = runtime.start({
      workingDirectory: process.cwd(),
      prompt: "Return only a valid Scaflow Agent Result JSON object for a no-change successful task.",
      timeoutMs: 120_000,
    });
    await expect(execution.outcome).resolves.toMatchObject({ type: "completed" });
  }, 130_000);
});
