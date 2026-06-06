function compact(value, limit = 180) {
  if (value === null || value === undefined) return "";
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function commandText(item) {
  if (typeof item?.command === "string") return item.command;
  if (Array.isArray(item?.command)) return item.command.join(" ");
  if (typeof item?.cmd === "string") return item.cmd;
  return "command";
}

function fileSummary(item) {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  const paths = changes
    .map((change) => change?.path ?? change?.file ?? change?.filename)
    .filter(Boolean);
  if (paths.length > 0) return paths.join(", ");
  return item?.path ?? item?.file ?? "working tree";
}

function toolSummary(item) {
  const server = item?.server ?? item?.server_name ?? item?.mcp_server;
  const tool = item?.tool ?? item?.tool_name ?? item?.name;
  return [server, tool].filter(Boolean).join("/") || "tool";
}

function messageText(item) {
  return item?.text ?? item?.message ?? item?.content ?? "";
}

export function consolePrefix({ taskId, agent, phase }) {
  return `[${taskId}][${String(agent).toUpperCase()}][${String(phase).toUpperCase()}]`;
}

export function formatCodexEvent(event, { level = "normal" } = {}) {
  if (!event || typeof event !== "object") return [];
  if (level === "trace") return [JSON.stringify(event)];

  const type = event.type ?? "unknown";
  const item = event.item ?? event.data ?? {};
  const itemType = item.type ?? event.item_type ?? "";

  if (type === "thread.started") return ["• Codex session started"];
  if (type === "turn.started") return ["→ Agent is working"];
  if (type === "turn.completed") {
    const usage = event.usage ?? {};
    const tokens = usage.output_tokens ?? usage.total_tokens;
    return [tokens ? `✓ Agent turn completed (${tokens} tokens)` : "✓ Agent turn completed"];
  }
  if (type === "turn.failed" || type === "error") {
    return [`✗ ${compact(event.error?.message ?? event.message ?? "Agent execution failed")}`];
  }

  if (type === "item.started") {
    if (itemType === "reasoning") return ["→ Analyzing task and evidence"];
    if (itemType === "command_execution") return [`→ Running: ${compact(commandText(item))}`];
    if (itemType === "file_change") return [`→ Updating: ${compact(fileSummary(item))}`];
    if (itemType === "mcp_tool_call" || itemType === "tool_call") {
      return [`→ Calling tool: ${compact(toolSummary(item))}`];
    }
    if (itemType === "web_search") return [`→ Searching: ${compact(item.query ?? "web")}`];
    if (itemType === "todo_list") return ["→ Updating execution plan"];
    if (level === "verbose") return [`→ Started ${compact(itemType || type)}`];
    return [];
  }

  if (type === "item.completed") {
    if (itemType === "reasoning") return [];
    if (itemType === "command_execution") {
      const exitCode = item.exit_code ?? item.exitCode;
      const status = item.status;
      const ok = exitCode === undefined ? status !== "failed" : exitCode === 0;
      return [`${ok ? "✓" : "✗"} Command ${ok ? "finished" : "failed"}: ${compact(commandText(item))}${exitCode === undefined ? "" : ` (exit ${exitCode})`}`];
    }
    if (itemType === "file_change") return [`✓ Updated: ${compact(fileSummary(item))}`];
    if (itemType === "mcp_tool_call" || itemType === "tool_call") {
      const failed = item.status === "failed" || Boolean(item.error);
      return [`${failed ? "✗" : "✓"} Tool ${failed ? "failed" : "finished"}: ${compact(toolSummary(item))}`];
    }
    if (itemType === "agent_message") {
      const text = compact(messageText(item));
      return [text ? `• ${text}` : "✓ Agent response prepared"];
    }
    if (itemType === "web_search") return ["✓ Search completed"];
    if (itemType === "todo_list") return ["✓ Execution plan updated"];
    if (level === "verbose") return [`✓ Completed ${compact(itemType || type)}`];
    return [];
  }

  if (level === "verbose") return [`• ${compact(type)}`];
  return [];
}
