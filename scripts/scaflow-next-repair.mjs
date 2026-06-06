#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

function fail(message, code = 1) {
  console.error(`[scaflow-next-repair] ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    taskId: "",
    worktree: process.cwd(),
    maxSameFailure: 2,
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;
    if (arg === "--worktree") {
      options.worktree = args.shift() ?? fail("--worktree requires a path");
    } else if (arg === "--max-same-failure") {
      options.maxSameFailure = Number(args.shift());
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: scaflow-next-repair <TASK-ID> [options]\n\nOptions:\n  --worktree <path>          Task worktree; default: current directory\n  --max-same-failure <n>     Default: 2\n\nThe command performs one repair and audit cycle. If the new audit still returns CHANGES_REQUIRED, run the same command again; limits are recalculated from workflow state.`);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      fail(`unknown option: ${arg}`);
    } else if (options.taskId) {
      fail(`unexpected argument: ${arg}`);
    } else {
      options.taskId = arg;
    }
  }

  if (!/^SFL-\d{3}$/.test(options.taskId)) {
    fail("valid TASK-ID is required, for example SFL-002");
  }
  if (!Number.isInteger(options.maxSameFailure) || options.maxSameFailure < 1) {
    fail("--max-same-failure must be an integer >= 1");
  }
  return options;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  return result.status ?? 1;
}

function repositoryRoot(path) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: path,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error || result.status !== 0) fail(`not a Git worktree: ${path}`);
  return result.stdout.trim();
}

function readState(root, taskId) {
  const path = join(root, ".scaflow", "handoffs", taskId, "state.json");
  if (!existsSync(path)) fail(`workflow state not found: ${path}`);
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (state.taskId !== taskId) fail(`workflow task mismatch: expected ${taskId}, found ${state.taskId}`);
  return { state, path };
}

function count(value, label) {
  if (!Number.isInteger(value) || value < 0) fail(`invalid ${label} in workflow state: ${value}`);
  return value;
}

const options = parseArgs(process.argv.slice(2));
const controllerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commandWrapper = join(controllerRoot, "scripts", "scaflow-command.mjs");
const worktree = repositoryRoot(resolve(options.worktree));

let { state } = readState(worktree, options.taskId);
const baseRef = state.baseRef;
if (!baseRef) fail("workflow state has no baseRef");

console.log(`[scaflow-next-repair] task: ${options.taskId}`);
console.log(`[scaflow-next-repair] worktree: ${worktree}`);
console.log(`[scaflow-next-repair] state: ${state.workflowState}`);
console.log(`[scaflow-next-repair] development attempts: ${state.development?.attempt ?? 0}`);
console.log(`[scaflow-next-repair] audit rounds: ${state.audit?.round ?? 0}`);

if (["changes_required", "development_failed", "audit_invalid"].includes(state.workflowState)) {
  const currentDevelopmentAttempts = count(state.development?.attempt ?? 0, "development attempt");
  const currentAuditRounds = count(state.audit?.round ?? 0, "audit round");
  const maxDevelopmentAttempts = currentDevelopmentAttempts + 1;
  const maxAuditRounds = currentAuditRounds;

  console.log(`[scaflow-next-repair] computed --max-development-attempts ${maxDevelopmentAttempts}`);
  console.log(`[scaflow-next-repair] computed --max-audit-rounds ${maxAuditRounds}`);
  console.log("[scaflow-next-repair] starting Architect repair and Developer verification...");

  const runExit = run(
    process.execPath,
    [
      commandWrapper,
      "run",
      options.taskId,
      "--base",
      baseRef,
      "--max-development-attempts",
      String(maxDevelopmentAttempts),
      "--max-audit-rounds",
      String(maxAuditRounds),
      "--max-same-failure",
      String(options.maxSameFailure),
    ],
    worktree,
  );

  ({ state } = readState(worktree, options.taskId));
  if (state.workflowState !== "ready_for_audit") {
    fail(`repair command exited ${runExit} and workflow ended in ${state.workflowState}`,
      runExit === 0 ? 2 : runExit);
  }

  console.log("[scaflow-next-repair] repair completed; workflow is ready_for_audit");
}

({ state } = readState(worktree, options.taskId));
if (["ready_for_audit", "audit_failed"].includes(state.workflowState)) {
  console.log("[scaflow-next-repair] starting the next independent audit round...");
  const auditExit = run(
    process.execPath,
    [commandWrapper, "audit", options.taskId, "--base", baseRef],
    worktree,
  );
  ({ state } = readState(worktree, options.taskId));
  if (auditExit !== 0 && !["changes_required", "blocked"].includes(state.workflowState)) {
    fail(`audit exited ${auditExit} and workflow ended in ${state.workflowState}`, auditExit);
  }
}

({ state } = readState(worktree, options.taskId));
if (["approved", "approved_with_follow_ups"].includes(state.workflowState)) {
  console.log(`[scaflow-next-repair] audit verdict: ${state.audit?.verdict ?? state.workflowState}`);
  console.log("[scaflow-next-repair] generating Architect completion summary...");
  const completionExit = run(
    process.execPath,
    [commandWrapper, "run", options.taskId, "--base", baseRef],
    worktree,
  );
  if (completionExit !== 0) fail(`completion step exited with code ${completionExit}`, completionExit);
  console.log(`[scaflow-next-repair] ${options.taskId} is approved and ready for commit/integration.`);
  process.exit(0);
}

if (state.workflowState === "changes_required") {
  console.log(`[scaflow-next-repair] audit round ${state.audit?.round ?? "-"} returned CHANGES_REQUIRED.`);
  console.log(`[scaflow-next-repair] report: ${state.audit?.report ?? "-"}`);
  console.log("[scaflow-next-repair] Run the same command again; limits will be recalculated automatically.");
  process.exit(2);
}

if (state.workflowState === "blocked") {
  fail(`workflow is BLOCKED; inspect ${state.audit?.report ?? "the latest evidence"}`, 2);
}

fail(`unexpected final workflow state: ${state.workflowState}`, 2);
