export const AUTONOMOUS_ACTIONS = Object.freeze({
  DEVELOP_INITIAL: "develop_initial",
  DEVELOP_RESUME: "develop_resume",
  AUDIT: "audit",
  SUCCEEDED: "succeeded",
  STOP_BLOCKED: "stop_blocked",
  STOP_DELIVERED: "stop_delivered",
  STOP_ACTIVE: "stop_active",
});

export function decideAutonomousAction(state, { hasImplementationChanges = false } = {}) {
  switch (state.workflowState) {
    case "ready":
      return hasImplementationChanges
        ? AUTONOMOUS_ACTIONS.AUDIT
        : AUTONOMOUS_ACTIONS.DEVELOP_INITIAL;
    case "development_failed":
    case "changes_required":
    case "audit_invalid":
      return AUTONOMOUS_ACTIONS.DEVELOP_RESUME;
    case "ready_for_audit":
    case "audit_failed":
      return AUTONOMOUS_ACTIONS.AUDIT;
    case "approved":
    case "approved_with_follow_ups":
      return AUTONOMOUS_ACTIONS.SUCCEEDED;
    case "blocked":
      return AUTONOMOUS_ACTIONS.STOP_BLOCKED;
    case "developing":
    case "auditing":
      return AUTONOMOUS_ACTIONS.STOP_ACTIVE;
    case "committed":
    case "pushed":
    case "merged":
      return AUTONOMOUS_ACTIONS.STOP_DELIVERED;
    default:
      throw new Error(`unsupported workflow state: ${state.workflowState}`);
  }
}

export function validatePositiveInteger(value, name, { minimum = 1 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

export function updateFailureTracker(previous, signature) {
  if (!signature) {
    return { signature: null, count: 0 };
  }
  if (previous?.signature === signature) {
    return { signature, count: (previous.count ?? 0) + 1 };
  }
  return { signature, count: 1 };
}

export function isFailureState(workflowState) {
  return [
    "development_failed",
    "audit_failed",
    "audit_invalid",
    "changes_required",
    "blocked",
  ].includes(workflowState);
}
