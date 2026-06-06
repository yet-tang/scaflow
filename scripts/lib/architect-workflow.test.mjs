import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readWorkflowState, transitionWorkflowState } from "./workflow-state.mjs";

function defaults() {
  return {
    baseRef: "main",
    baseCommit: "a".repeat(40),
    branch: "SFL-999-test",
  };
}

test("architect preparation may block a ready task", () => {
  const root = mkdtempSync(join(tmpdir(), "scaflow-architect-flow-"));
  const blocked = transitionWorkflowState({
    root,
    taskId: "SFL-999",
    defaults: defaults(),
    to: "blocked",
    event: "ARCHITECT_PREPARATION_BLOCKED",
  });
  assert.equal(blocked.state.workflowState, "blocked");
});

test("post-development architect review may require repair", () => {
  const root = mkdtempSync(join(tmpdir(), "scaflow-architect-flow-"));
  transitionWorkflowState({
    root,
    taskId: "SFL-999",
    defaults: defaults(),
    to: "developing",
    event: "DEVELOPMENT_STARTED",
  });
  transitionWorkflowState({
    root,
    taskId: "SFL-999",
    defaults: defaults(),
    to: "ready_for_audit",
    event: "DEVELOPMENT_FINISHED",
  });
  const repair = transitionWorkflowState({
    root,
    taskId: "SFL-999",
    defaults: defaults(),
    to: "changes_required",
    event: "ARCHITECT_POST_DEVELOPMENT_REPAIR_REQUIRED",
  });
  assert.equal(repair.state.workflowState, "changes_required");
});

test("architect repair may block after audit findings", () => {
  const root = mkdtempSync(join(tmpdir(), "scaflow-architect-flow-"));
  transitionWorkflowState({
    root,
    taskId: "SFL-999",
    defaults: defaults(),
    to: "developing",
    event: "DEVELOPMENT_STARTED",
  });
  transitionWorkflowState({
    root,
    taskId: "SFL-999",
    defaults: defaults(),
    to: "ready_for_audit",
    event: "DEVELOPMENT_FINISHED",
  });
  transitionWorkflowState({
    root,
    taskId: "SFL-999",
    defaults: defaults(),
    to: "auditing",
    event: "AUDIT_STARTED",
  });
  transitionWorkflowState({
    root,
    taskId: "SFL-999",
    defaults: defaults(),
    to: "changes_required",
    event: "AUDIT_CHANGES_REQUIRED",
  });
  const blocked = transitionWorkflowState({
    root,
    taskId: "SFL-999",
    defaults: defaults(),
    to: "blocked",
    event: "ARCHITECT_REPAIR_BLOCKED",
  });
  assert.equal(blocked.state.workflowState, "blocked");

  const state = readWorkflowState(root, "SFL-999", defaults()).state;
  assert.equal(state.workflowState, "blocked");
});
