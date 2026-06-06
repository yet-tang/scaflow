import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTONOMOUS_ACTIONS,
  decideAutonomousAction,
  isFailureState,
  updateFailureTracker,
  validatePositiveInteger,
} from "./autonomous-run.mjs";

function state(workflowState) {
  return { workflowState };
}

test("ready tasks develop when no implementation exists", () => {
  assert.equal(
    decideAutonomousAction(state("ready"), { hasImplementationChanges: false }),
    AUTONOMOUS_ACTIONS.DEVELOP_INITIAL,
  );
});

test("ready tasks with an existing implementation go directly to audit", () => {
  assert.equal(
    decideAutonomousAction(state("ready"), { hasImplementationChanges: true }),
    AUTONOMOUS_ACTIONS.AUDIT,
  );
});

test("repair-oriented states resume development", () => {
  for (const workflowState of ["development_failed", "changes_required", "audit_invalid"]) {
    assert.equal(
      decideAutonomousAction(state(workflowState)),
      AUTONOMOUS_ACTIONS.DEVELOP_RESUME,
    );
  }
});

test("audit-oriented states start or retry audit", () => {
  for (const workflowState of ["ready_for_audit", "audit_failed"]) {
    assert.equal(
      decideAutonomousAction(state(workflowState)),
      AUTONOMOUS_ACTIONS.AUDIT,
    );
  }
});

test("approval and delivered states terminate successfully", () => {
  for (const workflowState of ["approved", "approved_with_follow_ups"]) {
    assert.equal(
      decideAutonomousAction(state(workflowState)),
      AUTONOMOUS_ACTIONS.SUCCEEDED,
    );
  }
  for (const workflowState of ["committed", "pushed", "merged"]) {
    assert.equal(
      decideAutonomousAction(state(workflowState)),
      AUTONOMOUS_ACTIONS.STOP_DELIVERED,
    );
  }
});

test("blocked and active states stop without unsafe retries", () => {
  assert.equal(
    decideAutonomousAction(state("blocked")),
    AUTONOMOUS_ACTIONS.STOP_BLOCKED,
  );
  for (const workflowState of ["developing", "auditing"]) {
    assert.equal(
      decideAutonomousAction(state(workflowState)),
      AUTONOMOUS_ACTIONS.STOP_ACTIVE,
    );
  }
});

test("positive integer validation rejects invalid limits", () => {
  assert.equal(validatePositiveInteger("3", "limit"), 3);
  assert.throws(() => validatePositiveInteger("0", "limit"), /integer >= 1/);
  assert.throws(() => validatePositiveInteger("1.5", "limit"), /integer >= 1/);
  assert.throws(() => validatePositiveInteger("abc", "limit"), /integer >= 1/);
});

test("failure tracker counts only identical consecutive failures", () => {
  assert.deepEqual(updateFailureTracker(undefined, "a"), { signature: "a", count: 1 });
  assert.deepEqual(updateFailureTracker({ signature: "a", count: 1 }, "a"), {
    signature: "a",
    count: 2,
  });
  assert.deepEqual(updateFailureTracker({ signature: "a", count: 2 }, "b"), {
    signature: "b",
    count: 1,
  });
  assert.deepEqual(updateFailureTracker({ signature: "a", count: 2 }, null), {
    signature: null,
    count: 0,
  });
});

test("failure states are explicitly classified", () => {
  for (const workflowState of [
    "development_failed",
    "audit_failed",
    "audit_invalid",
    "changes_required",
    "blocked",
  ]) {
    assert.equal(isFailureState(workflowState), true);
  }
  assert.equal(isFailureState("approved"), false);
});
