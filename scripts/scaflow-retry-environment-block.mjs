#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  appendWorkflowEvent,
  implementationFingerprint,
  readWorkflowState,
  writeWorkflowState,
} from "./lib/workflow-state.mjs";

function fail(message, code = 1) {
  console.error(`[scaflow-retry-audit] ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = [...argv];
  const options = { taskId: undefined, worktree: process.cwd() };
  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;
    if (arg === "--worktree") {
      options.worktree = args.shift() ?? fail("--worktree requires a path");
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: scaflow-retry-environment-block <TASK-ID> [--worktree <path>]");
      process.exit(0);
    } else if (arg.startsWith("-")) {
      fail(`unknown option: ${arg}`);
    } else if (options.taskId) {
      fail(`unexpected argument: ${arg}`);
    } else {
      options.taskId = arg;
    }
  }
  if (!options.taskId || !/^SFL-\d{3}$/.test(options.taskId)) {
    fail("valid TASK-ID is required, for example SFL-002");
  }
  return options;
}

function run(command, args, { cwd, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    env: process.env,
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  return result;
}

function repositoryRoot(path) {
  const result = run("git", ["rev-parse", "--show-toplevel"], {
    cwd: path,
    capture: true,
  });
  if (result.status !== 0) fail(`not a Git worktree: ${path}`);
  return result.stdout.trim();
}

function isEnvironmentBlock(report) {
  return [
    /\bEPERM\b/i,
    /read-only sandbox/i,
    /temporary-directory creation/i,
    /could not execute/i,
    /verification environment/i,
  ].some((pattern) => pattern.test(report));
}

const options = parseArgs(process.argv.slice(2));
const controllerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = repositoryRoot(resolve(options.worktree));
const loaded = readWorkflowState(root, options.taskId, {
  baseRef: "main",
  baseCommit: "",
  branch: "",
});

if (!loaded.exists) fail(`workflow state not found for ${options.taskId}`);
const state = loaded.state;
if (state.workflowState !== "blocked" || state.audit?.verdict !== "BLOCKED") {
  fail(`expected blocked audit workflow, found ${state.workflowState}/${state.audit?.verdict ?? "-"}`);
}
if (!state.audit?.report) fail("blocked workflow has no audit report");

const reportPath = join(root, state.audit.report);
if (!existsSync(reportPath)) fail(`audit report not found: ${state.audit.report}`);
const report = readFileSync(reportPath, "utf8");
if (!isEnvironmentBlock(report)) {
  fail("BLOCKED verdict is not recognized as a verification-environment failure; manual review is required");
}

const currentFingerprint = implementationFingerprint(root, state.baseCommit);
if (currentFingerprint !== state.implementationFingerprint) {
  fail("implementation changed after the blocked audit; run development and the full Task Gate again");
}

const recovered = writeWorkflowState(loaded.paths, {
  ...state,
  workflowState: "ready_for_audit",
  audit: {
    ...state.audit,
    verdict: null,
    startedAt: null,
    finishedAt: null,
    lastError: "retrying audit after verification-environment block",
  },
});
appendWorkflowEvent(loaded.paths, {
  event: "AUDIT_ENVIRONMENT_BLOCK_RECOVERED",
  from: "blocked",
  to: "ready_for_audit",
  metadata: {
    previousRound: state.audit.round,
    report: state.audit.report,
    implementationFingerprint: currentFingerprint,
  },
});

console.log(`[scaflow-retry-audit] recovered ${options.taskId}: blocked -> ready_for_audit`);
console.log(`[scaflow-retry-audit] worktree: ${root}`);

const auditResult = run(
  process.execPath,
  [
    join(controllerRoot, "scripts", "scaflow-audit.mjs"),
    options.taskId,
    "--base",
    recovered.baseRef,
  ],
  { cwd: root },
);
if (auditResult.status !== 0) {
  fail(`retry audit exited with code ${auditResult.status}`, auditResult.status ?? 1);
}

const afterAudit = readWorkflowState(root, options.taskId, {
  baseRef: recovered.baseRef,
  baseCommit: recovered.baseCommit,
  branch: recovered.branch,
}).state;
if (!["approved", "approved_with_follow_ups"].includes(afterAudit.workflowState)) {
  fail(`retry audit ended in ${afterAudit.workflowState}`);
}

const completionResult = run(
  process.execPath,
  [
    join(controllerRoot, "scripts", "scaflow-run.mjs"),
    options.taskId,
    "--base",
    recovered.baseRef,
  ],
  { cwd: root },
);
if (completionResult.status !== 0) {
  fail(`Architect completion step exited with code ${completionResult.status}`, completionResult.status ?? 1);
}

console.log(`[scaflow-retry-audit] ${options.taskId} is approved and has an Architect completion summary.`);
console.log("[scaflow-retry-audit] The preserved batch still needs delivery/integration before later tasks can continue.");
