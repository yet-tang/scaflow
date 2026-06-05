# SFL-022 Scope Verifier Plan

## Implementation Notes

- Compare actual Git diff against Task Contract repository scopes and path rules.
- Fail immediately for unauthorized repositories, read-only repository changes, unauthorized paths, protected control files, and repository identity mismatch.
- Do not classify identity mismatch or protected control file mutation as auto-repairable.
- `workspace/repos/` is never a formal TaskRun write target.

## Acceptance Focus

- Diff reality is authoritative.
- Agent Result cannot override scope failures.
- Tests include positive and negative fixtures for repository and path boundaries.
