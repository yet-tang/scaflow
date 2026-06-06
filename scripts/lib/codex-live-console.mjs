#!/usr/bin/env node

import { appendFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import process from "node:process";
import { consolePrefix, formatCodexEvent } from "./agent-console.mjs";

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    taskId: "",
    agent: "",
    phase: "",
    eventsPath: "",
    level: process.env.SCAFLOW_AGENT_CONSOLE ?? "normal",
    codexArgs: [],
  };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--") {
      options.codexArgs = args.splice(0);
      break;
    }
    if (arg === "--task") options.taskId = args.shift() ?? "";
    else if (arg === "--agent") options.agent = args.shift() ?? "";
    else if (arg === "--phase") options.phase = args.shift() ?? "";
    else if (arg === "--events") options.eventsPath = args.shift() ?? "";
    else if (arg === "--level") options.level = args.shift() ?? "normal";
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!options.taskId || !options.agent || !options.phase) {
    throw new Error("--task, --agent, and --phase are required");
  }
  if (options.codexArgs[0] !== "exec") {
    throw new Error("Codex arguments must follow -- and begin with exec");
  }
  if (!["normal", "verbose", "trace", "quiet"].includes(options.level)) {
    throw new Error(`unsupported console level: ${options.level}`);
  }
  return options;
}

function addJsonFlag(args) {
  return args.includes("--json") ? args : ["exec", "--json", ...args.slice(1)];
}

function duration(startedAt) {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

const options = parseArgs(process.argv.slice(2));
const prefix = consolePrefix(options);
const startedAt = Date.now();
if (options.eventsPath) mkdirSync(dirname(options.eventsPath), { recursive: true });

function persist(payload) {
  if (!options.eventsPath) return;
  appendFileSync(options.eventsPath, `${JSON.stringify({
    at: new Date().toISOString(),
    taskId: options.taskId,
    agent: options.agent,
    phase: options.phase,
    ...payload,
  })}\n`, "utf8");
}

function print(message) {
  if (options.level !== "quiet") console.log(`${prefix} ${message}`);
}

print("╭─ Started");
persist({ kind: "console.started", level: options.level });

const child = spawn("codex", addJsonFlag(options.codexArgs), {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});

createInterface({ input: child.stdout }).on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const event = JSON.parse(trimmed);
    persist({ kind: "codex.event", event });
    for (const message of formatCodexEvent(event, { level: options.level })) print(message);
  } catch {
    persist({ kind: "codex.stdout", line: trimmed });
    print(`• ${trimmed}`);
  }
});

createInterface({ input: child.stderr }).on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  persist({ kind: "codex.stderr", line: trimmed });
  if (options.level !== "quiet") console.error(`${prefix} ! ${trimmed}`);
});

child.on("error", (error) => {
  persist({ kind: "console.error", message: error.message });
  console.error(`${prefix} ✗ ${error.message}`);
});

child.on("close", (code) => {
  const exitCode = code ?? 1;
  persist({ kind: "console.finished", exitCode, elapsedMs: Date.now() - startedAt });
  print(`${exitCode === 0 ? "╰─ ✓ Completed" : "╰─ ✗ Failed"} in ${duration(startedAt)}`);
  process.exit(exitCode);
});
