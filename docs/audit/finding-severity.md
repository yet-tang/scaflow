# Scaflow Audit Finding Severity

Use the highest applicable severity. Findings must be evidence-based and tied to a requirement, invariant, Task Contract rule, or concrete defect.

## BLOCKER

Use when the implementation cannot safely proceed or merge.

Examples:

- data loss, repository corruption, or irreversible destructive behavior;
- unauthorized repository or protected control-plane modification;
- sandbox escape or exposure of host secrets, credentials, Docker socket, or other TaskRuns;
- Task Contract, Revision Set, or repository identity cannot be trusted;
- required verification is absent, fabricated, or structurally impossible;
- the implementation fundamentally contradicts the PRD or v0.2 architecture baseline.

Required verdict: `BLOCKED` or `CHANGES_REQUIRED`.

## HIGH

Use for defects likely to break a primary workflow, violate a major invariant, or create a serious security or recovery risk.

Examples:

- formal tasks can write to `workspace/repos/`;
- TaskRun success incorrectly completes the Task;
- read-only repositories can produce changes;
- security policy silently degrades instead of failing closed;
- state transitions, cancellation, or recovery can leave inconsistent durable state;
- tests are weakened or bypassed to pass the gate;
- required acceptance behavior is missing.

Required verdict: `CHANGES_REQUIRED`.

## MEDIUM

Use for real defects with bounded impact that should be corrected before or shortly after merge depending on task risk.

Examples:

- an important edge case is untested;
- diagnostics or evidence are incomplete but core correctness is independently verifiable;
- cleanup, idempotency, or error messages are incomplete without causing corruption;
- implementation creates avoidable coupling or violates a non-critical package boundary;
- documentation materially disagrees with behavior.

Possible verdict: `CHANGES_REQUIRED` or `APPROVED_WITH_FOLLOW_UPS`.

## LOW

Use for minor maintainability, clarity, naming, or non-critical test improvements.

Examples:

- confusing naming;
- small duplication;
- low-value documentation gap;
- an additional assertion would improve confidence without changing current correctness.

Possible verdict: `APPROVED_WITH_FOLLOW_UPS` or `APPROVED`.

## Evidence requirements

Every finding must include:

- severity;
- repository, file, and line when applicable;
- violated requirement, invariant, or contract clause;
- observed evidence;
- impact;
- required correction.

Do not report speculation as a finding. Label uncertain concerns as questions or verification gaps.

## Verdict rules

- `BLOCKED`: audit cannot be completed or the implementation is unsafe to continue.
- `CHANGES_REQUIRED`: at least one BLOCKER or HIGH finding, or acceptance evidence is incomplete.
- `APPROVED_WITH_FOLLOW_UPS`: no BLOCKER or HIGH finding; only bounded MEDIUM/LOW follow-ups remain.
- `APPROVED`: all required acceptance and verification evidence passes with no unresolved material finding.
