#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

function inferContext(args) {
  const prompt = args.at(-1) ?? "";
  const taskId = /\bSFL-\d{3}\b/.exec(prompt)?.[0] ?? "SFL-UNKNOWN";
  let agent = "codex";
  let phase = "execution";

  if (/scaflow-architect/i.test(prompt)) {
    agent = "architect";
    phase = /Perform the ([a-z_]+) phase/i.exec(prompt)?.[1]?.replaceAll("_", "-") ?? "architecture";
  } else if (/scaflow-developer/i.test(prompt)) {
    agent = "developer";
    phase = /repair round/i.test(prompt) ? "repair" : "development";
  } else if (/scaflow-auditor/i.test(prompt)) {
    agent = "auditor";
    const round = /audit round (\d+)/i.exec(prompt)?.[1];
    phase = round ? `audit-round-${round}` : "audit";
  }

  const rootIndex = args.indexOf("-C");
  const root = rootIndex >= 0 && args[rootIndex + 1]
    ? resolve(args[rootIndex + 1])
    : process.cwd();

  return {
    taskId,
    agent,
    phase,
    root,
    eventsPath: join(root, ".scaflow", "handoffs", taskId, "agent-events.jsonl"),
  };
}

const realCodex = process.env.SCAFLOW_REAL_CODEX;
if (!realCodex) {
  console.error("[scaflow-console] SCAFLOW_REAL_CODEX is not set");
  process.exit(1);
}

const args = process.argv.slice(2);
if (args[0] !== "exec") {
  const result = spawnSync(realCodex, args, { stdio: "inherit", env: process.env });
  process.exit(result.status ?? 1);
}

const context = inferContext(args);
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const runner = join(moduleDirectory, "codex-live-console.mjs");
const result = spawnSync(
  process.execPath,
  [
    runner,
    "--task",
    context.taskId,
    "--agent",
    context.agent,
    "--phase",
    context.phase,
    "--events",
    context.eventsPath,
    "--",
    ...args,
  ],
  {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  },
);
process.exit(result.status ?? 1);
