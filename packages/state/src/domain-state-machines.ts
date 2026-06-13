import { ScaflowError } from "@scaflow/core";
import {
  type ChangeSetState,
  type TaskDefinitionState,
  type TaskRunState,
} from "@scaflow/schemas";

export type StateDomain = "task_definition" | "task_run" | "change_set";
export type StateAuthority =
  | "task_contract_in_spr_git"
  | "local_state_database";
export type StateTransitionRejectionReason =
  | "illegal_transition"
  | "merged_change_set_required";

export const stateAuthorities = Object.freeze({
  task_definition: "task_contract_in_spr_git",
  task_run: "local_state_database",
  change_set: "local_state_database",
} as const satisfies Readonly<Record<StateDomain, StateAuthority>>);

export interface StateTransitionErrorOptions {
  readonly correlationId?: string;
}

export interface TaskCompletionEvidence {
  readonly changeSetState: ChangeSetState;
}

export interface TaskDefinitionTransitionOptions
  extends StateTransitionErrorOptions {
  readonly completionEvidence?: TaskCompletionEvidence;
}

type TransitionTable<State extends string> = Readonly<
  Record<State, readonly State[]>
>;

export const taskDefinitionTransitions =
  freezeTransitionTable<TaskDefinitionState>({
    draft: ["ready", "cancelled"],
    ready: ["cancelled", "completed"],
    cancelled: [],
    completed: [],
  } satisfies Record<TaskDefinitionState, readonly TaskDefinitionState[]>);

export const taskRunTransitions = freezeTransitionTable<TaskRunState>({
  queued: ["preparing", "cancelled", "orphaned"],
  preparing: ["running", "failed", "blocked", "cancelled", "orphaned"],
  running: ["verifying", "failed", "blocked", "cancelled", "orphaned"],
  verifying: [
    "repairing",
    "succeeded",
    "failed",
    "blocked",
    "cancelled",
    "orphaned",
  ],
  repairing: ["verifying", "failed", "blocked", "cancelled", "orphaned"],
  succeeded: [],
  failed: [],
  blocked: [],
  cancelled: [],
  orphaned: [],
} satisfies Record<TaskRunState, readonly TaskRunState[]>);

export const changeSetTransitions = freezeTransitionTable<ChangeSetState>({
  draft: ["verified", "failed", "cancelled"],
  verified: ["published", "failed", "cancelled"],
  published: [
    "partially_merged",
    "merged",
    "failed",
    "cancelled",
  ],
  partially_merged: ["merged", "failed", "rolled_back"],
  merged: [],
  failed: [],
  cancelled: [],
  rolled_back: [],
} satisfies Record<ChangeSetState, readonly ChangeSetState[]>);

export class StateTransitionError extends ScaflowError {
  declare readonly name: "StateTransitionError";
  readonly domain: StateDomain;
  readonly from: string;
  readonly to: string;
  readonly reason: StateTransitionRejectionReason;

  constructor(
    domain: StateDomain,
    from: string,
    to: string,
    reason: StateTransitionRejectionReason,
    options: StateTransitionErrorOptions = {},
  ) {
    super(transitionErrorMessage(domain, from, to, reason), {
      code: "STATE_TRANSITION_REJECTED",
      suggestion:
        reason === "merged_change_set_required"
          ? "Provide evidence that the related ChangeSet is merged"
          : "Use a legal transition for the specified state domain",
      details: { domain, from, to, reason },
      ...(options.correlationId === undefined
        ? {}
        : { correlationId: options.correlationId }),
    });

    this.name = "StateTransitionError";
    this.domain = domain;
    this.from = from;
    this.to = to;
    this.reason = reason;
  }
}

export function validateTaskDefinitionTransition(
  from: TaskDefinitionState,
  to: TaskDefinitionState,
  options: TaskDefinitionTransitionOptions = {},
): void {
  validateTransition(
    "task_definition",
    taskDefinitionTransitions,
    from,
    to,
    options,
  );

  if (
    to === "completed" &&
    options.completionEvidence?.changeSetState !== "merged"
  ) {
    throw new StateTransitionError(
      "task_definition",
      from,
      to,
      "merged_change_set_required",
      options,
    );
  }
}

export function validateTaskRunTransition(
  from: TaskRunState,
  to: TaskRunState,
  options: StateTransitionErrorOptions = {},
): void {
  validateTransition("task_run", taskRunTransitions, from, to, options);
}

export function validateChangeSetTransition(
  from: ChangeSetState,
  to: ChangeSetState,
  options: StateTransitionErrorOptions = {},
): void {
  validateTransition("change_set", changeSetTransitions, from, to, options);
}

function validateTransition<State extends string>(
  domain: StateDomain,
  transitions: TransitionTable<State>,
  from: State,
  to: State,
  options: StateTransitionErrorOptions,
): void {
  if (!transitions[from]?.includes(to)) {
    throw new StateTransitionError(
      domain,
      from,
      to,
      "illegal_transition",
      options,
    );
  }
}

function freezeTransitionTable<State extends string>(
  transitions: Record<State, readonly State[]>,
): TransitionTable<State> {
  for (const state of Object.keys(transitions) as State[]) {
    transitions[state] = Object.freeze([...transitions[state]]);
  }

  return Object.freeze(transitions);
}

function transitionErrorMessage(
  domain: StateDomain,
  from: string,
  to: string,
  reason: StateTransitionRejectionReason,
): string {
  if (reason === "merged_change_set_required") {
    return `Cannot transition ${domain} from "${from}" to "${to}" without a merged ChangeSet`;
  }

  return `Cannot transition ${domain} from "${from}" to "${to}"`;
}
