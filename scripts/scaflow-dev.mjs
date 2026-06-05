#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

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

function ensureBranch(taskId) {
  const result = run("git", ["branch", "--show-current"], { capture: true });
  if (result.status !== 0) fail("unable to determine current branch");
  const branch = result.stdout.trim();
  if (!branch) fail("detached HEAD is not supported by this helper");
  if (branch === "main" || branch === "master") {
    fail(`refusing to develop ${taskId} directly on protected branch ${branch}. Create a task branch first.`);
  }
  return branch;
}

function buildPrompt({ taskId, baseRef, contractPath, reportPath, resume }) {
  return `Use the scaflow-developer custom agent and the scaflow-development Skill.\n\nImplement exactly ${taskId}.\n\nInputs:\n- Task Contract: ${contractPath}\n- Base ref: ${baseRef}\n- Current branch and working tree are the implementation target.\n- Developer report path: ${reportPath}\n\nMandatory behavior:\n1. Perform the full preflight from docs/development/scaflow-development-workflow.md before editing.\n2. Verify dependency completion, current Git status, scopes, allowed_paths, forbidden_paths, dependency_changes, acceptance criteria, and verification commands.\n3. Preserve unrelated pre-existing changes and stop if they overlap this task.\n4. Implement only ${taskId}; do not implement future tasks.\n5. Run every verification command from the Task Contract, then git diff --check and git status --short.\n6. Perform developer self-review against the actual diff.\n7. Write the final developer report to ${reportPath}.\n8. Stop when ready for independent audit.\n9. Do not commit, push, create a pull request, or mark the shared Task completed.\n${resume ? "10. This is a repair/resume round. Inspect prior audit reports under the handoff directory and fix only current findings.\n" : ""}`;
}

const options = parseArgs(process.argv.slice(2));
const root = ensureRepositoryRoot();
ensureCodex();
const contractPath = ensureTask(options.taskId);
const branch = ensureBranch(options.taskId);

const handoffDir = resolve(root, ".scaflow", "handoffs", options.taskId);
mkdirSync(handoffDir, { recursive: true });
const reportPath = join(".scaflow", "handoffs", options.taskId, "developer-report.md");
const metadataPath = join(handoffDir, "handoff.json");
const metadata = {
  taskId: options.taskId,
  baseRef: options.baseRef,
  branch,
  mode: options.resume ? "resume" : "initial",
  startedAt: new Date().toISOString(),
  developerReport: reportPath,
};
writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

const prompt = buildPrompt({
  taskId: options.taskId,
  baseRef: options.baseRef,
  contractPath,
  reportPath,
  resume: options.resume,
});

console.log(`[scaflow-dev] task: ${options.taskId}`);
console.log(`[scaflow-dev] branch: ${branch}`);
console.log(`[scaflow-dev] base: ${options.baseRef}`);
console.log(`[scaflow-dev] report: ${reportPath}`);

if (options.dryRun) {
  console.log("\n--- prompt ---\n");
  console.log(prompt);
  process.exit(0);
}

const result = run("codex", ["-C", root, "-s", "workspace-write", prompt]);
if (result.status !== 0) fail(`Codex developer session exited with code ${result.status}`, result.status ?? 1);

console.log(`\n[scaflow-dev] Developer session finished.`);
console.log(`[scaflow-dev] Freeze code changes and run: scaflow-audit ${options.taskId} --base ${options.baseRef}`);
