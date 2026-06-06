#!/usr/bin/env node

import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  parseTaskContract,
  parseTaskSelection,
  slugifyTaskTitle,
  topologicalTaskOrder,
} from "./lib/task-graph.mjs";

class BatchError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "BatchError";
    this.exitCode = exitCode;
  }
}

function abort(message, exitCode = 1) {
  throw new BatchError(message, exitCode);
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    selector: undefined,
    remote: "origin",
    target: "dev",
    source: "main",
    push: true,
    keepWorktrees: false,
    maxDevelopmentAttempts: 3,
    maxAuditRounds: 4,
    maxSameFailure: 2,
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;
    if (arg === "--remote") options.remote = args.shift() ?? abort("--remote requires a name");
    else if (arg === "--target") options.target = args.shift() ?? abort("--target requires a branch");
    else if (arg === "--source") options.source = args.shift() ?? abort("--source requires a branch");
    else if (arg === "--no-push") options.push = false;
    else if (arg === "--keep-worktrees") options.keepWorktrees = true;
    else if (arg === "--max-development-attempts") options.maxDevelopmentAttempts = Number(args.shift());
    else if (arg === "--max-audit-rounds") options.maxAuditRounds = Number(args.shift());
    else if (arg === "--max-same-failure") options.maxSameFailure = Number(args.shift());
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: scaflow-batch <TASK-RANGE> [options]\n\nExamples:\n  scaflow-batch 2-6\n  scaflow-batch SFL-002..SFL-006 --target dev\n\nOptions:\n  --remote <name>                   Default: origin\n  --target <branch>                 Integration branch, default: dev\n  --source <branch>                 Create target from this branch when absent, default: main\n  --no-push                         Preserve the local integration worktree without pushing\n  --keep-worktrees                  Preserve successful task worktrees\n  --max-development-attempts <n>    Default: 3\n  --max-audit-rounds <n>            Default: 4\n  --max-same-failure <n>            Default: 2\n`);
      process.exit(0);
    } else if (arg.startsWith("-")) abort(`unknown option: ${arg}`);
    else if (options.selector) abort(`unexpected argument: ${arg}`);
    else options.selector = arg;
  }

  if (!options.selector) abort("TASK-RANGE is required. Example: scaflow-batch 2-6");
  for (const [name, value] of [
    ["--max-development-attempts", options.maxDevelopmentAttempts],
    ["--max-audit-rounds", options.maxAuditRounds],
    ["--max-same-failure", options.maxSameFailure],
  ]) {
    if (!Number.isInteger(value) || value < 1) abort(`${name} must be an integer >= 1`);
  }
  return options;
}

function run(command, args, { cwd = process.cwd(), capture = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    env: process.env,
  });
  if (result.error) abort(`${command} failed to start: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    abort(`${command} ${args.join(" ")} failed: ${detail}`, result.status ?? 1);
  }
  return result;
}

function git(cwd, args, options = {}) {
  return run("git", args, { cwd, ...options });
}

function repositoryRoot() {
  return git(process.cwd(), ["rev-parse", "--show-toplevel"], { capture: true }).stdout.trim();
}

function refExists(root, ref) {
  return git(root, ["show-ref", "--verify", "--quiet", ref], { allowFailure: true }).status === 0;
}

function acquireLock(path) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  try {
    const descriptor = openSync(path, "wx");
    writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    closeSync(descriptor);
    return;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  const existing = JSON.parse(readFileSync(path, "utf8"));
  let active = true;
  try {
    process.kill(existing.pid, 0);
  } catch {
    active = false;
  }
  if (active) abort(`another batch is active with pid ${existing.pid}`);
  unlinkSync(path);
  acquireLock(path);
}

function ensureTargetBranch(root, options) {
  git(root, ["fetch", options.remote, "--prune"]);
  const remoteTarget = `refs/remotes/${options.remote}/${options.target}`;
  if (!refExists(root, remoteTarget)) {
    const remoteSource = `refs/remotes/${options.remote}/${options.source}`;
    const sourceRef = refExists(root, remoteSource) ? `${options.remote}/${options.source}` : options.source;
    git(root, ["push", options.remote, `${sourceRef}:refs/heads/${options.target}`]);
    git(root, ["fetch", options.remote, options.target]);
  }
  return `${options.remote}/${options.target}`;
}

function loadContracts(worktree) {
  return readdirSync(join(worktree, "tasks"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^SFL-\d{3}$/.test(entry.name))
    .map((entry) => {
      const path = join(worktree, "tasks", entry.name, "contract.yaml");
      return parseTaskContract(readFileSync(path, "utf8"), path);
    });
}

function markCompleted(worktree, taskId) {
  const path = join(worktree, "tasks", taskId, "contract.yaml");
  const content = readFileSync(path, "utf8");
  const contract = parseTaskContract(content, path);
  if (contract.definitionState === "completed") return false;
  if (contract.definitionState !== "ready") {
    abort(`cannot complete ${taskId} from definition_state: ${contract.definitionState}`);
  }
  const updated = content.replace(
    /^  definition_state:\s*ready\s*$/m,
    "  definition_state: completed",
  );
  if (updated === content) abort(`failed to update definition_state for ${taskId}`);
  writeFileSync(path, updated, "utf8");
  return true;
}

function batchFiles(root, batchId, target) {
  const directory = join(root, ".scaflow", "batches", batchId);
  mkdirSync(directory, { recursive: true });
  return {
    directory,
    state: join(directory, "state.json"),
    summary: join(directory, "summary.md"),
    lock: join(root, ".scaflow", "batches", `${target}.lock`),
  };
}

function writeBatch(files, state) {
  writeFileSync(files.state, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const lines = [
    `# Scaflow Sequential Batch ${state.batchId}`,
    "",
    `- Selector: ${state.selector}`,
    `- Target: ${state.remote}/${state.target}`,
    `- Status: ${state.status}`,
    `- Started: ${state.startedAt}`,
    `- Finished: ${state.finishedAt ?? "-"}`,
    `- Current task: ${state.currentTask ?? "-"}`,
    `- Integration worktree: ${state.integrationPath ?? "-"}`,
    `- Stop reason: ${state.stopReason ?? "-"}`,
    "",
    "## Tasks",
    "",
    ...state.tasks.map((task) => `- ${task.id}: ${task.status}${task.commit ? ` (${task.commit.slice(0, 12)})` : ""}`),
    "",
  ];
  writeFileSync(files.summary, `${lines.join("\n")}\n`, "utf8");
}

function cleanupWorktree(root, path, branch) {
  git(root, ["worktree", "remove", "--force", path], { allowFailure: true });
  git(root, ["branch", "-D", branch], { allowFailure: true });
}

function executeBatch(options) {
  const selectedIds = parseTaskSelection(options.selector);
  const root = repositoryRoot();
  process.chdir(root);

  const batchId = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const files = batchFiles(root, batchId, options.target);
  acquireLock(files.lock);

  const batchRoot = join(root, "workspace", "runs", "batches", batchId);
  const integrationPath = join(batchRoot, "dev");
  const integrationBranch = `scaflow/batch-${batchId.toLowerCase()}-${options.target}`;
  const state = {
    version: 1,
    batchId,
    selector: options.selector,
    selectedTasks: selectedIds,
    orderedTasks: [],
    remote: options.remote,
    target: options.target,
    integrationBranch,
    integrationPath,
    status: "running",
    currentTask: null,
    tasks: selectedIds.map((id) => ({ id, status: "pending", commit: null, error: null })),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    stopReason: null,
  };
  writeBatch(files, state);

  let successful = false;
  let failedWorktree = null;
  let exitCode = 2;
  try {
    const targetRef = ensureTargetBranch(root, options);
    git(root, ["branch", integrationBranch, targetRef]);
    mkdirSync(batchRoot, { recursive: true });
    git(root, ["worktree", "add", integrationPath, integrationBranch]);

    const contracts = loadContracts(integrationPath);
    const byId = new Map(contracts.map((contract) => [contract.id, contract]));
    for (const taskId of selectedIds) {
      if (!byId.has(taskId)) abort(`Task Contract not found: ${taskId}`);
    }

    const pendingIds = selectedIds.filter((taskId) => byId.get(taskId).definitionState !== "completed");
    state.orderedTasks = topologicalTaskOrder(contracts, pendingIds);
    for (const taskId of selectedIds.filter((id) => !pendingIds.includes(id))) {
      state.tasks.find((task) => task.id === taskId).status = "already_completed";
    }
    writeBatch(files, state);

    for (const taskId of state.orderedTasks) {
      const contract = loadContracts(integrationPath).find((item) => item.id === taskId);
      const taskState = state.tasks.find((task) => task.id === taskId);
      state.currentTask = taskId;
      taskState.status = "running";
      writeBatch(files, state);

      const taskBranch = `scaflow/${batchId.toLowerCase()}/${taskId.toLowerCase()}-${slugifyTaskTitle(contract.title)}`;
      const taskPath = join(batchRoot, taskId, "control");
      git(root, ["branch", taskBranch, integrationBranch]);
      mkdirSync(resolve(taskPath, ".."), { recursive: true });
      git(root, ["worktree", "add", taskPath, taskBranch]);
      failedWorktree = { path: taskPath, branch: taskBranch };

      run("pnpm", ["install", "--frozen-lockfile"], { cwd: taskPath });
      const runResult = run(
        "node",
        [
          "scripts/scaflow-run.mjs",
          taskId,
          "--base",
          integrationBranch,
          "--max-development-attempts",
          String(options.maxDevelopmentAttempts),
          "--max-audit-rounds",
          String(options.maxAuditRounds),
          "--max-same-failure",
          String(options.maxSameFailure),
        ],
        { cwd: taskPath, allowFailure: true },
      );
      if (runResult.status !== 0) {
        taskState.status = "failed";
        taskState.error = `scaflow-run exited with code ${runResult.status}`;
        abort(`${taskId} did not reach approval; worktree preserved at ${taskPath}`, runResult.status ?? 1);
      }

      const workflowPath = join(taskPath, ".scaflow", "handoffs", taskId, "state.json");
      const workflow = JSON.parse(readFileSync(workflowPath, "utf8"));
      if (!["approved", "approved_with_follow_ups"].includes(workflow.workflowState)) {
        abort(`${taskId} ended in unexpected state ${workflow.workflowState}`);
      }

      git(taskPath, ["diff", "--check"]);
      git(taskPath, ["add", "-A"]);
      const staged = git(taskPath, ["diff", "--cached", "--quiet"], { allowFailure: true });
      if (staged.status === 0) abort(`${taskId} has no staged implementation changes`);
      if (staged.status !== 1) abort(`unable to inspect staged changes for ${taskId}`);
      git(taskPath, ["commit", "-m", `feat: implement ${taskId} ${contract.title}`]);
      run("node", ["scripts/scaflow-status.mjs", taskId, "--mark", "committed"], { cwd: taskPath });
      const implementationCommit = git(taskPath, ["rev-parse", "HEAD"], { capture: true }).stdout.trim();

      git(integrationPath, ["merge", "--ff-only", taskBranch]);
      if (markCompleted(integrationPath, taskId)) {
        git(integrationPath, ["add", `tasks/${taskId}/contract.yaml`]);
        git(integrationPath, ["commit", "-m", `chore(tasks): mark ${taskId} completed`]);
      }

      if (options.push) {
        git(integrationPath, ["push", options.remote, `HEAD:refs/heads/${options.target}`]);
      }

      const evidenceTarget = join(files.directory, taskId);
      rmSync(evidenceTarget, { recursive: true, force: true });
      cpSync(join(taskPath, ".scaflow", "handoffs", taskId), evidenceTarget, { recursive: true });

      taskState.status = "completed";
      taskState.commit = implementationCommit;
      failedWorktree = null;
      writeBatch(files, state);

      if (!options.keepWorktrees) cleanupWorktree(root, taskPath, taskBranch);
    }

    state.status = "completed";
    state.currentTask = null;
    successful = true;
    exitCode = 0;
  } catch (error) {
    state.status = "failed";
    state.stopReason = error instanceof Error ? error.message : String(error);
    exitCode = error instanceof BatchError ? error.exitCode : 2;
  } finally {
    state.finishedAt = new Date().toISOString();
    writeBatch(files, state);
    if (successful && options.push && !options.keepWorktrees) {
      cleanupWorktree(root, integrationPath, integrationBranch);
      rmSync(batchRoot, { recursive: true, force: true });
    }
    if (existsSync(files.lock)) unlinkSync(files.lock);
  }

  console.log(`[scaflow-batch] status: ${state.status}`);
  console.log(`[scaflow-batch] summary: ${files.summary}`);
  if (failedWorktree) console.log(`[scaflow-batch] failed worktree: ${failedWorktree.path}`);
  if (successful && !options.push) {
    console.log(`[scaflow-batch] local integration preserved: ${integrationPath}`);
    console.log(`[scaflow-batch] push when ready: git -C ${integrationPath} push ${options.remote} HEAD:${options.target}`);
  }
  if (state.stopReason) console.log(`[scaflow-batch] reason: ${state.stopReason}`);
  return exitCode;
}

try {
  const options = parseArgs(process.argv.slice(2));
  process.exit(executeBatch(options));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[scaflow-batch] ${message}`);
  process.exit(error instanceof BatchError ? error.exitCode : 1);
}
