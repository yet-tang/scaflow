import { describe, expect, it } from "vitest";

import {
  StateTransitionError,
  changeSetTransitions,
  stateAuthorities,
  taskDefinitionTransitions,
  taskRunTransitions,
  validateChangeSetTransition,
  validateTaskDefinitionTransition,
  validateTaskRunTransition,
  type ChangeSetState,
  type TaskDefinitionState,
  type TaskRunState,
} from "../src/index";

describe("domain state machines", () => {
  it("defines separate state authorities without creating persistence", () => {
    expect(stateAuthorities).toEqual({
      task_definition: "task_contract_in_spr_git",
      task_run: "local_state_database",
      change_set: "local_state_database",
    });
    expect(Object.isFrozen(stateAuthorities)).toBe(true);
  });

  it.each([
    ["draft", "ready"],
    ["draft", "cancelled"],
    ["ready", "cancelled"],
  ] satisfies [TaskDefinitionState, TaskDefinitionState][])(
    "accepts Task definition transition %s -> %s",
    (from, to) => {
      expect(() =>
        validateTaskDefinitionTransition(from, to),
      ).not.toThrow();
    },
  );

  it.each([
    ["queued", "preparing"],
    ["preparing", "running"],
    ["running", "verifying"],
    ["verifying", "repairing"],
    ["repairing", "verifying"],
    ["verifying", "succeeded"],
    ["running", "failed"],
    ["running", "blocked"],
    ["running", "cancelled"],
    ["running", "orphaned"],
  ] satisfies [TaskRunState, TaskRunState][])(
    "accepts TaskRun transition %s -> %s",
    (from, to) => {
      expect(() => validateTaskRunTransition(from, to)).not.toThrow();
    },
  );

  it.each([
    "queued",
    "preparing",
    "running",
    "verifying",
    "repairing",
  ] satisfies TaskRunState[])(
    "allows non-terminal TaskRun state %s to become orphaned",
    (from) => {
      expect(() => validateTaskRunTransition(from, "orphaned")).not.toThrow();
    },
  );

  it.each([
    ["draft", "verified"],
    ["verified", "published"],
    ["published", "partially_merged"],
    ["published", "merged"],
    ["partially_merged", "merged"],
    ["partially_merged", "rolled_back"],
  ] satisfies [ChangeSetState, ChangeSetState][])(
    "accepts ChangeSet transition %s -> %s",
    (from, to) => {
      expect(() => validateChangeSetTransition(from, to)).not.toThrow();
    },
  );

  it("requires merged ChangeSet evidence before completing a Task", () => {
    expect(() =>
      validateTaskDefinitionTransition("ready", "completed", {
        completionEvidence: { changeSetState: "merged" },
      }),
    ).not.toThrow();

    for (const completionEvidence of [
      undefined,
      { changeSetState: "verified" as const },
      { taskRunState: "succeeded" as const },
    ]) {
      expect(() =>
        validateTaskDefinitionTransition("ready", "completed", {
          completionEvidence:
            completionEvidence as
              | { changeSetState: ChangeSetState }
              | undefined,
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "STATE_TRANSITION_REJECTED",
          reason: "merged_change_set_required",
        }),
      );
    }
  });

  it.each([
    [
      "task_definition",
      "draft",
      "completed",
      () => validateTaskDefinitionTransition("draft", "completed"),
    ],
    [
      "task_run",
      "queued",
      "succeeded",
      () => validateTaskRunTransition("queued", "succeeded"),
    ],
    [
      "change_set",
      "draft",
      "merged",
      () => validateChangeSetTransition("draft", "merged"),
    ],
  ])("returns a structured error for illegal %s transitions", (
    domain,
    from,
    to,
    run,
  ) => {
    expect(run).toThrowError(StateTransitionError);

    try {
      run();
    } catch (error) {
      expect(error).toMatchObject({
        name: "StateTransitionError",
        code: "STATE_TRANSITION_REJECTED",
        recoverable: false,
        domain,
        from,
        to,
        reason: "illegal_transition",
      });
      expect((error as StateTransitionError).toJSON()).toMatchObject({
        code: "STATE_TRANSITION_REJECTED",
        details: {
          domain,
          from,
          to,
          reason: "illegal_transition",
        },
      });
    }
  });

  it("keeps domain validators separate", () => {
    expect(() =>
      validateTaskDefinitionTransition(
        "draft",
        "running" as TaskDefinitionState,
      ),
    ).toThrowError(
      expect.objectContaining({
        domain: "task_definition",
        from: "draft",
        to: "running",
      }),
    );
    expect(() =>
      validateTaskRunTransition("queued", "verified" as TaskRunState),
    ).toThrowError(
      expect.objectContaining({
        domain: "task_run",
        from: "queued",
        to: "verified",
      }),
    );
    expect(() =>
      validateChangeSetTransition("draft", "running" as ChangeSetState),
    ).toThrowError(
      expect.objectContaining({
        domain: "change_set",
        from: "draft",
        to: "running",
      }),
    );
    expect(() =>
      validateTaskRunTransition(
        "draft" as TaskRunState,
        "running",
      ),
    ).toThrowError(
      expect.objectContaining({
        domain: "task_run",
        from: "draft",
        to: "running",
      }),
    );
  });

  it.each([
    ["task_definition", taskDefinitionTransitions, ["cancelled", "completed"]],
    [
      "task_run",
      taskRunTransitions,
      ["succeeded", "failed", "blocked", "cancelled", "orphaned"],
    ],
    [
      "change_set",
      changeSetTransitions,
      ["merged", "failed", "cancelled", "rolled_back"],
    ],
  ] as const)("keeps %s terminal states terminal", (_domain, table, states) => {
    for (const state of states) {
      expect(table[state]).toEqual([]);
    }
  });

  it("publishes immutable explicit transition tables", () => {
    expect(Object.isFrozen(taskDefinitionTransitions)).toBe(true);
    expect(Object.isFrozen(taskRunTransitions.verifying)).toBe(true);
    expect(Object.isFrozen(changeSetTransitions.partially_merged)).toBe(true);
    expect(() =>
      (taskRunTransitions.verifying as TaskRunState[]).push("running"),
    ).toThrow(TypeError);
  });

  it("rejects no-op transitions", () => {
    expect(() => validateTaskDefinitionTransition("ready", "ready")).toThrow();
    expect(() => validateTaskRunTransition("running", "running")).toThrow();
    expect(() => validateChangeSetTransition("verified", "verified")).toThrow();
  });
});
