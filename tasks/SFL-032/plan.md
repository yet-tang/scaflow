# SFL-032 Security Policy Schema and Loader Plan

## Implementation Notes

- Define `policies/security.yaml` and `policies/command-policy.yaml` schemas in `@scaflow/schemas`.
- Load policies through `@scaflow/config` and fail closed for missing or invalid initialized-project policies.
- Represent protected control files, writable roots, network defaults, shell policy, Docker socket visibility, and forbidden host resources.
- Preserve PRD control-plane rules: protected policy/workflow/schema/engine/release/approval changes require `control-plane-change` and at least R2.

## Acceptance Focus

- Policy validation is deterministic.
- Security policy defaults deny broad host access.
- Policy loading does not inspect user home or secrets.
