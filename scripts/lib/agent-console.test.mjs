import assert from "node:assert/strict";
import test from "node:test";
import { consolePrefix, formatCodexEvent } from "./agent-console.mjs";

test("formats task, agent, and phase prefix", () => {
  assert.equal(
    consolePrefix({ taskId: "SFL-002", agent: "developer", phase: "attempt-1" }),
    "[SFL-002][DEVELOPER][ATTEMPT-1]",
  );
});

test("formats command lifecycle", () => {
  assert.deepEqual(
    formatCodexEvent({
      type: "item.started",
      item: { type: "command_execution", command: "pnpm test" },
    }),
    ["→ Running: pnpm test"],
  );
  assert.deepEqual(
    formatCodexEvent({
      type: "item.completed",
      item: { type: "command_execution", command: "pnpm test", exit_code: 0 },
    }),
    ["✓ Command finished: pnpm test (exit 0)"],
  );
});

test("formats file changes and tool calls", () => {
  assert.deepEqual(
    formatCodexEvent({
      type: "item.started",
      item: { type: "file_change", changes: [{ path: "packages/core/src/errors.ts" }] },
    }),
    ["→ Updating: packages/core/src/errors.ts"],
  );
  assert.deepEqual(
    formatCodexEvent({
      type: "item.completed",
      item: { type: "mcp_tool_call", server: "github", tool: "fetch_file" },
    }),
    ["✓ Tool finished: github/fetch_file"],
  );
});

test("never exposes reasoning content", () => {
  assert.deepEqual(
    formatCodexEvent({
      type: "item.started",
      item: { type: "reasoning", text: "private reasoning text" },
    }),
    ["→ Analyzing task and evidence"],
  );
  assert.deepEqual(
    formatCodexEvent({
      type: "item.completed",
      item: { type: "reasoning", text: "private reasoning text" },
    }),
    [],
  );
});

test("trace mode emits raw JSON", () => {
  const event = { type: "thread.started", thread_id: "abc" };
  assert.deepEqual(formatCodexEvent(event, { level: "trace" }), [JSON.stringify(event)]);
});
