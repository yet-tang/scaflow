import assert from "node:assert/strict";
import test from "node:test";
import {
  ARCHITECT_PHASES,
  parseArchitectDecision,
  renderArchitectMarkdown,
} from "./architect.mjs";

function decision(overrides = {}) {
  return {
    version: 1,
    taskId: "SFL-002",
    phase: "preparation",
    decision: "READY_FOR_DEVELOPMENT",
    summary: "Task is ready.",
    guidance: ["Implement only the error foundation."],
    mustPreserve: ["Do not implement configuration loading."],
    risks: [],
    auditFocus: ["Verify stable error serialization."],
    blockingIssues: [],
    ...overrides,
  };
}

test("validates a preparation decision", () => {
  const parsed = parseArchitectDecision(JSON.stringify(decision()), {
    taskId: "SFL-002",
    phase: ARCHITECT_PHASES.PREPARATION,
  });
  assert.equal(parsed.decision, "READY_FOR_DEVELOPMENT");
  assert.deepEqual(parsed.auditFocus, ["Verify stable error serialization."]);
});

test("rejects invalid JSON and mismatched metadata", () => {
  assert.throws(
    () => parseArchitectDecision("not-json", { taskId: "SFL-002", phase: "preparation" }),
    /not valid JSON/,
  );
  assert.throws(
    () => parseArchitectDecision(JSON.stringify(decision({ taskId: "SFL-003" })), {
      taskId: "SFL-002",
      phase: "preparation",
    }),
    /taskId mismatch/,
  );
});

test("enforces phase decision enums", () => {
  assert.throws(
    () => parseArchitectDecision(JSON.stringify(decision({ decision: "READY_FOR_AUDIT" })), {
      taskId: "SFL-002",
      phase: "preparation",
    }),
    /not allowed/,
  );

  const post = parseArchitectDecision(
    JSON.stringify(
      decision({
        phase: "post_development",
        decision: "REPAIR_REQUIRED",
      }),
    ),
    { taskId: "SFL-002", phase: "post_development" },
  );
  assert.equal(post.decision, "REPAIR_REQUIRED");
});

test("requires blocking issues for BLOCKED", () => {
  assert.throws(
    () => parseArchitectDecision(JSON.stringify(decision({ decision: "BLOCKED" })), {
      taskId: "SFL-002",
      phase: "preparation",
    }),
    /requires at least one blocking issue/,
  );
});

test("renders deterministic human-readable Markdown", () => {
  const markdown = renderArchitectMarkdown(decision());
  assert.match(markdown, /Architect preparation: SFL-002/);
  assert.match(markdown, /READY_FOR_DEVELOPMENT/);
  assert.match(markdown, /## Audit focus/);
});
