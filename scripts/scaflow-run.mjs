#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import {
  AUTONOMOUS_ACTIONS,
  decideAutonomousAction,
  isFailureState,
  updateFailureTracker,
  validatePositiveInteger,
} from "./lib/autonomous-run.mjs";
import {
  currentBranch,
  implementationFingerprint,
  implementationHasChanges,
  readWorkflowState,
  resolveGitRef,
  transitionWorkflowState,
} from "./lib/workflow-state.mjs";

function fail(message, code = 1) {
  console.error(`[scaflow-run] ${message}`);
  process.exitCode = code;
  throw new Error(message);
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    taskId: undefined,
    baseRef: "main",
    until: "approved",
    maxDevelopmentAttempts: 3,
    maxAuditRounds: 4,
    maxSameFailure: 2,
    dryRun: false,
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;
    if (arg === "--base") {
      options.baseRef = args.shift() ?? fail("--base requires a ref");
      continue;
    }
    if (arg === "--until") {
      options.until = args.shift() ?? fail("--until requires approved");
      continue;
    }
    if (arg === "--max-development-attempts") {
      options.maxDevelopmentAttempts = validatePositiveInteger(
        args.shift() ?? "",
        "--max-development-attempts",
      );
      continue;
    }
    if (arg === "--max-audit-rounds") {
      options.maxAuditRounds = validatePositiveInteger(
        args.shift() ?? "",
        "--max-audit-rounds",
      );
      continue;
    }
    if (arg === "--max-same-failure") {
      options.maxSameFailure = validatePositiveInteger(
        args.shift() ?? "",
        "--max-same-failure",
      );
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: scaflow-run <TASK-ID> [options]\n\nOptions:\n  --base <ref>                      Frozen base ref (default: main)\n  --until approved                  Stop after independent approval\n  --max-development-attempts <n>    Default: 3\n  --max-audit-rounds <n>            Default: 4\n  --max-same-failure <n>            Default: 2\n  --dry-run                         Show the next autonomous action\n\nExample:\n  scaflow-run SFL-001 --base origin/main\n`);
      process.exit(0);
    }
    if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
    if (options.taskId) fail(`unexpected argument: ${arg}`);
    options.taskId = arg;
  }

  if (!options.taskId) fail("TASK-ID is required. Example: scaflow-run SFL-001");
  if (!/^SFL-\d{3}$/.test(options.taskId)) fail(`invalid Task ID: ${options.taskId}`);
  if (options.until !== "approved") fail("only --until approved is supported");
  return options;
}

function run(command, args, { cwd = process.cwd(), capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    env: process.env,
  });
  if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`);
  return result;
}

function repositoryRoot() {
  const result = run("git", ["rev-parse", "--show-toplevel"], { capture: true });
  if (result.status !== 0) throw new Error("current directory is not inside a Git repository");
  return result.stdout.trim();
}

function ensureCodex() {
  const result = run("codex", ["--version"], { capture: true });
  if (result.status !== 0) throw new Error("Codex CLI is not installed or not available in PATH");
}

function ensureTask(taskId) {
  const path = join("tasks", taskId, "contract.yaml");
  if (!existsSync(path)) throw new Error(`Task Contract not found: ${path}`);
  const contract = readFileSync(path, "utf8");
  if (!contract.includes(`id: ${taskId}`)) throw new Error(`Task Contract ID does not match ${taskId}`);
  if (!contract.includes("definition_state: ready")) {
    throw new Error(`${taskId} is not definition_state: ready`);
  }
  return path;
}

function acquireLock(path) {
  mkdirSync(join(path, ".."), { recursive: true });
  try {
    const descriptor = openSync(path, "wx");
    writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    closeSync(descriptor);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = JSON.parse(readFileSync(path, "utf8"));
    let active = false;
    try {
      process.kill(existing.pid, 0);
      active = true;
    } catch {
      active = false;
    }
    if (active) throw new Error(`another autonomous run is active with pid ${existing.pid}`);
    unlinkSync(path);
    return acquireLock(path);
  }
}

function releaseLock(path) {
  if (existsSync(path)) unlinkSync(path);
}

function buildDeveloperPrompt({ taskId, baseRef, baseCommit, contractPath, reportPath, resume }) {
  return `Use the scaflow-developer custom agent and the scaflow-development Skill.\n\nImplement exactly ${taskId}.\n\nInputs:\n- Task Contract: ${contractPath}\n- Base ref: ${baseRef}\n- Resolved base commit: ${baseCommit}\n- Current branch and working tree are the implementation target.\n- The wrapper captures your final response as ${reportPath}.\n\nMandatory behavior:\n1. Perform the complete preflight from docs/development/scaflow-development-workflow.md.\n2. Preserve unrelated changes and stop if they overlap the task.\n3. Implement only ${taskId}; do not implement future tasks.\n4. Run every Task Contract verification command, git diff --check, and git status --short.\n5. Perform developer self-review against the actual diff.\n6. Return the complete developer report as the final response. Do not write the report file yourself.\n7. Do not commit, push, create a pull request, or mark the shared Task completed.\n${resume ? "8. This is a repair round. Read prior audit reports and fix only current findings.\n" : ""}`;
}

function executeDeveloper({ root, taskId, baseRef, baseCommit, contractPath, state, paths, resume }) {
  const reportPath = join(".scaflow", "handoffs", taskId, "developer-report.md");
  const startedAt = new Date().toISOString();
  transitionWorkflowState({
    root,
    taskId,
    defaults: { baseRef, baseCommit, branch: state.branch },
    to: "developing",
    event: resume ? "AUTONOMOUS_DEVELOPMENT_RESUMED" : "AUTONOMOUS_DEVELOPMENT_STARTED",
    patch: {
      implementationFingerprint: null,
      approvedFingerprint: null,
      development: {
        attempt: (state.development?.attempt ?? 0) + 1,
        startedAt,
        finishedAt: null,
        report: reportPath,
        imported: false,
        lastError: null,
      },
      audit: { verdict: null, report: null },
    },
    metadata: { autonomous: true },
  });

  const prompt = buildDeveloperPrompt({
    taskId,
    baseRef,
    baseCommit,
    contractPath,
    reportPath,
    resume,
  });
  const result = run("codex", [
    "exec",
    "-C",
    root,
    "-s",
    "workspace-write",
    "--output-last-message",
    paths.developerReport,
    prompt,
  ]);

  const defaults = { baseRef, baseCommit, branch: state.branch };
  if (result.status !== 0) {
    transitionWorkflowState({
      root,
      taskId,
      defaults,
      to: "development_failed",
      event: "AUTONOMOUS_DEVELOPMENT_FAILED",
      patch: {
        development: {
          finishedAt: new Date().toISOString(),
          lastError: `Codex developer exited with code ${result.status}`,
        },
      },
      metadata: { exitCode: result.status },
    });
    return result.status ?? 1;
  }

  if (!existsSync(paths.developerReport) || readFileSync(paths.developerReport, "utf8").trim().length === 0) {
    transitionWorkflowState({
      root,
      taskId,
      defaults,
      to: "development_failed",
      event: "AUTONOMOUS_DEVELOPMENT_REPORT_MISSING",
      patch: {
        development: {
          finishedAt: new Date().toISOString(),
          lastError: "developer report was not produced",
        },
      },
    });
    return 1;
  }

  if (!implementationHasChanges(root, baseCommit)) {
    transitionWorkflowState({
      root,
      taskId,
      defaults,
      to: "development_failed",
      event: "AUTONOMOUS_DEVELOPMENT_NO_CHANGES",
      patch: {
        development: {
          finishedAt: new Date().toISOString(),
          lastError: "implementation has no changes relative to the frozen base",
        },
      },
    });
    return 1;
  }

  const fingerprint = implementationFingerprint(root, baseCommit);
  transitionWorkflowState({
    root,
    taskId,
    defaults,
    to: "ready_for_audit",
    event: "AUTONOMOUS_DEVELOPMENT_FINISHED",
    patch: {
      implementationFingerprint: fingerprint,
      approvedFingerprint: null,
      development: {
        finishedAt: new Date().toISOString(),
        lastError: null,
      },
    },
    metadata: { implementationFingerprint: fingerprint },
  });
  return 0;
}

function failureSignature(state, paths) {
  let reportHash = null;
  if (state.audit?.report) {
    const reportPath = join(paths.directory, state.audit.report.split("/").at(-1));
    if (existsSync(reportPath)) {
      reportHash = createHash("sha256").update(readFileSync(reportPath)).digest("hex");
    }
  }
  return createHash("sha256")
    .update(JSON.stringify({
      state: state.workflowState,
      developerError: state.development?.lastError ?? null,
      auditError: state.audit?.lastError ?? null,
      verdict: state.audit?.verdict ?? null,
      reportHash,
    }))
    .digest("hex");
}

function writeRunFiles(paths, runState) {
  writeFileSync(join(paths.directory, "run-state.json"), `${JSON.stringify(runState, null, 2)}\n`, "utf8");
  const lines = [
    `# Autonomous Run Summary: ${runState.taskId}`,
    "",
    `- Status: ${runState.status}`,
    `- Workflow state: ${runState.workflowState}`,
    `- Base: ${runState.baseRef}@${runState.baseCommit}`,
    `- Branch: ${runState.branch}`,
    `- Development attempts: ${runState.developmentAttempts}`,
    `- Audit rounds: ${runState.auditRounds}`,
    `- Started: ${runState.startedAt}`,
    `- Finished: ${runState.finishedAt ?? "-"}`,
    `- Stop reason: ${runState.stopReason ?? "-"}`,
    "",
    "## Steps",
    "",
    ...runState.steps.map((step) => `- ${step.at}: ${step.action} -> ${step.resultState} (exit ${step.exitCode})`),
    "",
  ];
  writeFileSync(join(paths.directory, "run-summary.md"), `${lines.join("\n")}\n`, "utf8");
}

const options = parseArgs(process.argv.slice(2));
const root = repositoryRoot();
process.chdir(root);
ensureCodex();
const contractPath = ensureTask(options.taskId);
const baseCommit = resolveGitRef(root, options.baseRef);
const branch = currentBranch(root);
if (branch === "main" || branch === "master" || branch === "DETACHED_HEAD") {
  fail(`autonomous development requires a dedicated task branch, current branch: ${branch}`);
}

const defaults = { baseRef: options.baseRef, baseCommit, branch };
let loaded = readWorkflowState(root, options.taskId, defaults);
if (loaded.exists) {
  if (loaded.state.baseRef !== options.baseRef || loaded.state.baseCommit !== baseCommit) {
    fail(`workflow uses frozen base ${loaded.state.baseRef}@${loaded.state.baseCommit.slice(0, 12)}`);
  }
  if (loaded.state.branch !== branch) fail(`workflow belongs to branch ${loaded.state.branch}`);
}

const hasChanges = implementationHasChanges(root, baseCommit);
const firstAction = decideAutonomousAction(loaded.state, { hasImplementationChanges: hasChanges });
if (options.dryRun) {
  console.log(`[scaflow-run] task: ${options.taskId}`);
  console.log(`[scaflow-run] workflow state: ${loaded.state.workflowState}`);
  console.log(`[scaflow-run] next action: ${firstAction}`);
  process.exit(0);
}

mkdirSync(loaded.paths.directory, { recursive: true });
const lockPath = join(loaded.paths.directory, "run.lock");
acquireLock(lockPath);

const runState = {
  version: 1,
  taskId: options.taskId,
  status: "running",
  workflowState: loaded.state.workflowState,
  baseRef: options.baseRef,
  baseCommit,
  branch,
  limits: {
    maxDevelopmentAttempts: options.maxDevelopmentAttempts,
    maxAuditRounds: options.maxAuditRounds,
    maxSameFailure: options.maxSameFailure,
  },
  developmentAttempts: loaded.state.development?.attempt ?? 0,
  auditRounds: loaded.state.audit?.round ?? 0,
  failureTracker: { signature: null, count: 0 },
  steps: [],
  startedAt: new Date().toISOString(),
  finishedAt: null,
  stopReason: null,
};

let exitCode = 1;
try {
  for (let guard = 0; guard < 100; guard += 1) {
    loaded = readWorkflowState(root, options.taskId, defaults);
    const state = loaded.state;
    const action = decideAutonomousAction(state, {
      hasImplementationChanges: implementationHasChanges(root, baseCommit),
    });

    if (action === AUTONOMOUS_ACTIONS.SUCCEEDED || action === AUTONOMOUS_ACTIONS.STOP_DELIVERED) {
      runState.status = "succeeded";
      runState.stopReason = state.workflowState;
      exitCode = 0;
      break;
    }
    if (action === AUTONOMOUS_ACTIONS.STOP_BLOCKED) {
      runState.status = "blocked";
      runState.stopReason = "auditor returned BLOCKED";
      exitCode = 2;
      break;
    }
    if (action === AUTONOMOUS_ACTIONS.STOP_ACTIVE) {
      runState.status = "stopped";
      runState.stopReason = `workflow is already active: ${state.workflowState}`;
      exitCode = 2;
      break;
    }

    if (
      (action === AUTONOMOUS_ACTIONS.DEVELOP_INITIAL || action === AUTONOMOUS_ACTIONS.DEVELOP_RESUME) &&
      (state.development?.attempt ?? 0) >= options.maxDevelopmentAttempts
    ) {
      runState.status = "limit_reached";
      runState.stopReason = "maximum development attempts reached";
      exitCode = 2;
      break;
    }
    if (action === AUTONOMOUS_ACTIONS.AUDIT && (state.audit?.round ?? 0) >= options.maxAuditRounds) {
      runState.status = "limit_reached";
      runState.stopReason = "maximum audit rounds reached";
      exitCode = 2;
      break;
    }

    let child;
    if (action === AUTONOMOUS_ACTIONS.DEVELOP_INITIAL || action === AUTONOMOUS_ACTIONS.DEVELOP_RESUME) {
      child = executeDeveloper({
        root,
        taskId: options.taskId,
        baseRef: options.baseRef,
        baseCommit,
        contractPath,
        state,
        paths: loaded.paths,
        resume: action === AUTONOMOUS_ACTIONS.DEVELOP_RESUME,
      });
    } else {
      const result = run("node", [
        join(root, "scripts", "scaflow-audit.mjs"),
        options.taskId,
        "--base",
        options.baseRef,
      ]);
      child = result.status ?? 1;
    }

    loaded = readWorkflowState(root, options.taskId, defaults);
    runState.steps.push({
      at: new Date().toISOString(),
      action,
      exitCode: child,
      resultState: loaded.state.workflowState,
    });
    runState.workflowState = loaded.state.workflowState;
    runState.developmentAttempts = loaded.state.development?.attempt ?? 0;
    runState.auditRounds = loaded.state.audit?.round ?? 0;

    if (isFailureState(loaded.state.workflowState)) {
      const signature = failureSignature(loaded.state, loaded.paths);
      runState.failureTracker = updateFailureTracker(runState.failureTracker, signature);
      if (runState.failureTracker.count >= options.maxSameFailure) {
        runState.status = "repeated_failure";
        runState.stopReason = `same failure repeated ${runState.failureTracker.count} times`;
        exitCode = 2;
        break;
      }
    } else {
      runState.failureTracker = { signature: null, count: 0 };
    }

    writeRunFiles(loaded.paths, runState);
  }

  if (runState.status === "running") {
    runState.status = "guard_exhausted";
    runState.stopReason = "internal loop guard exhausted";
    exitCode = 2;
  }
} catch (error) {
  runState.status = "failed";
  runState.stopReason = error instanceof Error ? error.message : String(error);
  exitCode = 1;
} finally {
  loaded = readWorkflowState(root, options.taskId, defaults);
  runState.workflowState = loaded.state.workflowState;
  runState.developmentAttempts = loaded.state.development?.attempt ?? 0;
  runState.auditRounds = loaded.state.audit?.round ?? 0;
  runState.finishedAt = new Date().toISOString();
  writeRunFiles(loaded.paths, runState);
  releaseLock(lockPath);
}

console.log(`[scaflow-run] status: ${runState.status}`);
console.log(`[scaflow-run] workflow state: ${runState.workflowState}`);
console.log(`[scaflow-run] summary: .scaflow/handoffs/${options.taskId}/run-summary.md`);
if (runState.stopReason) console.log(`[scaflow-run] reason: ${runState.stopReason}`);
process.exit(exitCode);
