# SFL-021 Verification Framework Plan

## Implementation Notes

- Build a verifier registry/composition model without implementing all verifier types in this task.
- Define Verification Run and Verification Result schema in `@scaflow/schemas`.
- Persist verification events through the state/event-log package.
- Store artifacts under `.scaflow/evidence` through test fixtures, not in application repositories.
- Keep real Git diff and command results authoritative over Agent claims.

## Acceptance Focus

- Individual verifiers can be composed in deterministic order.
- Failure classification supports repairability decisions.
- Framework can run with Mock Runtime outputs.
