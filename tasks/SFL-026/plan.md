# SFL-026 Repair Loop Plan

## Implementation Notes

- Use default policy: `max_attempts: 2`, `max_repair_rounds_per_attempt: 3`, `escalate_after_same_failure: 2`.
- Send repair prompts only for recoverable verification failures.
- Continue the same runtime session for repair rounds.
- Transition non-repairable failures to `blocked` or `failed`.

## Acceptance Focus

- Re-verification occurs after each repair.
- Same failure escalation is deterministic.
- Repair loop does not bypass Scope Verifier failures.
