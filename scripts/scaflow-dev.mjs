#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import {
  currentBranch,
  implementationFingerprint,
  implementationHasChanges,
  readWorkflowState,
  resolveGitRef,
  transitionWorkflowState,
} from "./lib/workflow-state.mjs";

function fail(message, code = 1) {
  console.error(`[scaflow-dev] ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    taskId: undefined,
    baseRef: "main",
    resume: false,
    dryRun: false,
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;
    if (arg === "--base") {
      options.baseRef = args.shift() ?? fail("--base requires a ref");
      continue;
    }
    if (arg === "--resume") {
      options.resume = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: scaflow-dev <TASK-ID> [--base <ref>] [--resume] [--dry-run]\n\nExamples:\n  scaflow-dev SFL-002\n  scaflow-dev SFL-002 --base main\n  scaflow-dev SFL-002 --resume\n`);
      process.exit(0);
    }
    if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
    if (options.taskId) fail(`unexpected argument: ${arg}`);
    options.taskId = arg;
  }

  if (!options.taskId) fail("TASK-ID is required. Example: scaflow-dev SFL-002");
  if (!/^SFL-\d{3}$/.test(options.taskId)) fail(`invalid Task ID: ${options.taskId}`);
  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: process.env,
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  return result;
}

function ensureRepositoryRoot() {
  const result = run("git", ["rev-parse", "--show-toplevel"], { capture: true });
  if (result.status !== 0) fail("current directory is not inside a Git repository");
  const root = result.stdout.trim();
  process.chdir(root);
  return root;
}

function ensureCodex() {
  const result = run("codex", ["--version"], { capture: true });
  if (result.status !== 0) fail("Codex CLI is not installed or not available in PATH");
}

function ensureTask(taskId) {
  const contractPath = join("tasks", taskId, "contract.yaml");
  if (!existsSync(contractPath)) fail(`Task Contract not found: ${contractPath}`);
  const contract = readFileSync(contractPath, "utf8");
  if (!contract.includes(`id: ${taskId}`)) fail(`Task Contract ID does not match ${taskId}`);
  if (!contract.includes("definition_state: ready")) fail(`${taskId} is not definition_state: ready`);
  return contractPath;
}

function ensureTaskBranch(root, taskId) {
  const branch = currentBranch(root);
  if (branch === "DETACHED_HEAD") fail("detached HEAD is not supported by this helper");
  if (branch === "main" || branch === "master") {
    fail(`refusing to develop ${taskId} directly on protected branch ${branch}. Create a task branch first.`);
  }
  return branch;
}

function buildPrompt({ taskId, baseRef, baseCommit, contractPath, reportPath, resume }) {
  return `Use the scaflow-developer custom agent and the scaflow-development Skill.\n\nImplement exactly ${taskId}.\n\nInputs:\n- Task Contract: ${contractPath}\n- Base ref: ${baseRef}\n- Resolved base commit: ${baseCommit}\n- Current branch and working tree are the implementation target.\n- Developer report path: ${reportPath}\n\nMandatory behavior:\n1. Perform the full preflight from docs/development/scaflow-development-workflow.md before editing.\n2. Verify dependency completion, current Git status, scopes, allowed_paths, forbidden_paths, dependency_changes, acceptance criteria, and verification commands.\n3. Preserve unrelated pre-existing changes and stop if they overlap this task.\n4. Implement only ${taskId}; do not implement future tasks.\n5. Run every verification command from the Task Contract, then git diff --check and git status --short.\n6. Perform developer self-review against the actual diff.\n7. Write the final developer report to ${reportPath}.\n8. Stop when ready for independent audit.\n9. Do not commit, push, create a pull request, or mark the shared Task completed.\n${resume ? "10. This is a repair/resume round. Inspect prior audit reports under the handoff directory and fix only current findings.\n" : ""}`;
}

const options = parseArgs(process.argv.slice(2));
const root = ensureRepositoryRoot();
ensureCodex();
const baseCommit = resolveGitRef(root, options.baseRef);
const contractPath = ensureTask(options.taskId);
const branch = ensureTaskBranch(root, options.taskId);
const defaults = {
  baseRef: options.baseRef,
  baseCommit,
  branch,
};
const loaded = readWorkflowState(root, options.taskId, defaults);

if (loaded.exists) {
  if (loaded.state.baseCommit !== baseCommit || loaded.state.baseRef !== options.baseRef) {
    fail(`workflow was created against ${loaded.state.baseRef}@${loaded.state.baseCommit.slice(0, 12)}; use the same base or start a new task workflow`);
  }
  if (loaded.state.branch !== branch) {
    fail(`workflow belongs to branch ${loaded.state.branch}, not ${branch}`);
  }
}

const initialStates = new Set(["ready"]);
const resumeStates = new Set([
  "development_failed",
  "changes_required",
  "blocked",
  "audit_failed",
  "audit_invalid",
  "ready_for_audit",
  "approved",
  "approved_with_follow_ups",
]);
const currentState = loaded.state.workflowState;
if (options.resume) {
  if (!resumeStates.has(currentState)) {
    fail(`--resume is not allowed from workflow state ${currentState}`);
  }
} else if (!initialStates.has(currentState)) {
  fail(`initial development is not allowed from workflow state ${currentState}; use --resume when appropriate`);
}

const reportPath = join(".scaflow", "handoffs", options.taskId, "developer-report.md");
const metadataPath = loaded.paths.handoff;
const prompt = buildPrompt({
  taskId: options.taskId,
  baseRef: options.baseRef,
  baseCommit,
  contractPath,
  reportPath,
  resume: options.resume,
});

console.log(`[scaflow-dev] task: ${options.taskId}`);
console.log(`[scaflow-dev] branch: ${branch}`);
console.log(`[scaflow-dev] base: ${options.baseRef} (${baseCommit.slice(0, 12)})`);
console.log(`[scaflow-dev] workflow state: ${currentState} -> developing`);
console.log(`[scaflow-dev] report: ${reportPath}`);

if (options.dryRun) {
  console.log("\n--- prompt ---\n");
  console.log(prompt);
  process.exit(0);
}

const startedAt = new Date().toISOString();
const started = transitionWorkflowState({
  root,
  taskId: options.taskId,
  defaults,
  to: "developing",
  event: options.resume ? "DEVELOPMENT_RESUMED" : "DEVELOPMENT_STARTED",
  patch: {
    implementationFingerprint: null,
    approvedFingerprint: null,
    development: {
      attempt: (loaded.state.development?.attempt ?? 0) + 1,
      startedAt,
      finishedAt: null,
      report: reportPath,
      imported: false,
      lastError: null,
    },
    audit: {
      verdict: null,
      report: null,
    },
  },
  metadata: { branch, baseRef: options.baseRef, baseCommit },
});

writeFileSync(
  metadataPath,
  `${JSON.stringify({
    taskId: options.taskId,
    baseRef: options.baseRef,
    baseCommit,
    branch,
    mode: options.resume ? "resume" : "initial",
    startedAt,
    developerReport: reportPath,
  }, null, 2)}\n`,
  "utf8",
);

const result = run("codex", ["-C", root, "-s", "workspace-write", prompt]);
if (result.status !== 0) {
  transitionWorkflowState({
    root,
    taskId: options.taskId,
    defaults,
    to: "development_failed",
    event: "DEVELOPMENT_FAILED",
    patch: {
      development: {
        finishedAt: new Date().toISOString(),
        lastError: `Codex developer session exited with code ${result.status}`,
      },
    },
    metadata: { exitCode: result.status },
  });
  fail(`Codex developer session exited with code ${result.status}`, result.status ?? 1);
}

if (!existsSync(started.paths.developerReport) || readFileSync(started.paths.developerReport, "utf8").trim().length === 0) {
  transitionWorkflowState({
    root,
    taskId: options.taskId,
    defaults,
    to: "development_failed",
    event: "DEVELOPMENT_REPORT_MISSING",
    patch: {
      development: {
        finishedAt: new Date().toISOString(),
        lastError: `developer report was not created at ${reportPath}`,
      },
    },
  });
  fail(`developer report was not created at ${reportPath}`);
}

if (!implementationHasChanges(root, baseCommit)) {
  transitionWorkflowState({
    root,
    taskId: options.taskId,
    defaults,
    to: "development_failed",
    event: "DEVELOPMENT_NO_CHANGES",
    patch: {
      development: {
        finishedAt: new Date().toISOString(),
        lastError: "implementation has no changes relative to the frozen base",
      },
    },
  });
  fail("implementation has no changes relative to the frozen base");
}

const fingerprint = implementationFingerprint(root, baseCommit);
transitionWorkflowState({
  root,
  taskId: options.taskId,
  defaults,
  to: "ready_for_audit",
  event: "DEVELOPMENT_FINISHED",
  patch: {
    implementationFingerprint: fingerprint,
    approvedFingerprint: null,
    development: {
      finishedAt: new Date().toISOString(),
      report: reportPath,
      lastError: null,
    },
  },
  metadata: { implementationFingerprint: fingerprint },
});

console.log(`\n[scaflow-dev] Development finished.`);
console.log("[scaflow-dev] Workflow state: ready_for_audit");
console.log(`[scaflow-dev] Freeze code changes and run: pnpm scaflow-audit ${options.taskId} --base ${options.baseRef}`);
