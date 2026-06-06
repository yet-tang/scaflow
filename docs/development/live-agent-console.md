# Realtime Agent Team Console

`scaflow-run` and `scaflow-batch` are realtime Agent Team consoles by default, rather than commands that silently wait for the final report.

The default console shows the current Task, Agent, phase, command execution, file changes, tool calls, verification results, errors, and phase completion.

Raw Codex JSONL events are retained at:

```text
.scaflow/handoffs/<task-id>/agent-events.jsonl
```

Set `SCAFLOW_AGENT_CONSOLE` to `normal`, `verbose`, `trace`, or `quiet`. The default is `normal`.

This presentation layer does not change workflow state, retry limits, Agent permissions, approval rules, implementation fingerprints, Git delivery, or task ordering.
