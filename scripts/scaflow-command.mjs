#!/usr/bin/env node

import { accessSync, chmodSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const targets = {
  run: "scaflow-run.mjs",
  batch: "scaflow-batch.mjs",
  audit: "scaflow-audit.mjs",
  dev: "scaflow-dev.mjs",
};

function findExecutable(name, excludedDirectory) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory || resolve(directory) === resolve(excludedDirectory)) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

const args = process.argv.slice(2);
const command = args.shift();
const target = targets[command];
if (!target) {
  console.error("Usage: scaflow-command <run|batch|audit|dev> [...args]");
  process.exit(1);
}

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const shimDirectory = join(scriptsDirectory, "bin");
const shimPath = join(shimDirectory, "codex");
const realCodex = process.env.SCAFLOW_REAL_CODEX || findExecutable("codex", shimDirectory);
if (!realCodex) {
  console.error("[scaflow-console] Codex CLI is not installed or not available in PATH");
  process.exit(1);
}

chmodSync(shimPath, 0o755);
const env = {
  ...process.env,
  SCAFLOW_REAL_CODEX: realCodex,
  PATH: `${shimDirectory}${delimiter}${process.env.PATH ?? ""}`,
};

console.log(`[scaflow-console] realtime Agent Team console: ${process.env.SCAFLOW_AGENT_CONSOLE ?? "normal"}`);
const result = spawnSync(
  process.execPath,
  [join(scriptsDirectory, target), ...args],
  {
    cwd: process.cwd(),
    stdio: "inherit",
    env,
  },
);
process.exit(result.status ?? 1);
