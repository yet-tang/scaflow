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
  ARCHITECT_PHASES,
  architectArtifactPaths,
  buildArchitectPrompt,
  parseArchitectDecision,
  writeArchitectArtifacts,
} from "./lib/architect.mjs";
import {
  isFailureState,
  updateFailureTracker,
  validatePositiveInteger,
} from "./lib/autonomous-run.mjs";
import {
  currentBranch,
  implementationFingerprint,
  implementationHasChanges,
  patchWorkflowState,
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
      console.log(`Usage: scaflow-run <TASK-ID> [options]\n\nOptions:\n  --base <ref>                      Frozen base ref (default: main)\n  --until approved                  Stop after independent approval\n  --max-development-attempts <n>    Default: 3\n  --max-audit-rounds <n>            Default: 4\n  --max-same-failure <n>            Default: 2\n  --dry-run                         Show the next autonomous action\n\nExample:\n  scaflow-run SFL-001 --base origin/dev\n`);
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

function architectureStateKey(phase) {
  return {
    [ARCHITECT_PHASES.PREPARATION]: "preparation",
    [ARCHITECT_PHASES.POST_DEVELOPMENT]: "postDevelopment",
    [ARCHITECT_PHASES.REPAIR]: "repair",
    [ARCHITECT_PHASES.COMPLETION]: "completion",
  }[phase];
}

function latestAuditPath(state) {
  return state.audit?.report ?? null;
}

function invokeArchitect({
  root,
  taskId,
  phase,
  sequence,
  baseRef,
  baseCommit,
  branch,
  contractPath,
  planPath,
  state,
  paths,
}) {
  const artifacts = architectArtifactPaths(paths.directory, taskId, phase, sequence);
  mkdirSync(artifacts.directory, { recursive: true });
  const rawPath = join(artifacts.directory, `.raw-${phase}-${sequence}-${process.pid}.json`);
  const prompt = buildArchitectPrompt({
    taskId,
    phase,
    baseRef,
    baseCommit,
    branch,
    contractPath,
    planPath,
    workflowState: state.workflowState,
    developerReportPath: state.development?.report ?? null,
    latestAuditReportPath: latestAuditPath(state),
    preparationPath: state.architecture?.preparation?.report ?? null,
    postDevelopmentPath: state.architecture?.postDevelopment?.report ?? null,
  });

  const result = run("codex", [
    "exec",
    "-C",
    root,
    "-s",
    "read-only",
    "--output-last-message",
    rawPath,
    prompt,
  ]);
  if (result.status !== 0) {
    throw new Error(`Architect ${phase} phase exited with code ${result.status}`);
  }
  if (!existsSync(rawPath) || readFileSync(rawPath, "utf8").trim().length === 0) {
    throw new Error(`Architect ${phase} phase produced no output`);
  }

  const decision = parseArchitectDecision(readFileSync(rawPath, "utf8"), { taskId, phase });
  unlinkSync(rawPath);
  writeArchitectArtifacts(artifacts, decision);

  const key = architectureStateKey(phase);
  const fingerprint = state.implementationFingerprint ?? null;
  patchWorkflowState({
    root,
    taskId,
    defaults: { baseRef, baseCommit, branch },
    event: `ARCHITECT_${phase.toUpperCase()}_${decision.decision}`,
    patch: {
      architecture: {
        [key]: {
          decision: decision.decision,
          report: artifacts.relativeMarkdown,
          json: artifacts.relativeJson,
          sequence,
          fingerprint,
          at: new Date().toISOString(),
        },
        lastError: null,
      },
    },
    metadata: {
      phase,
      decision: decision.decision,
      report: artifacts.relativeMarkdown,
      fingerprint,
    },
  });

  return { decision, artifacts };
}

function transitionArchitectBlocked({ root, taskId, defaults, phase, decision }) {
  transitionWorkflowState({
    root,
    taskId,
    defaults,
    to: "blocked",
    event: `ARCHITECT_${phase.toUpperCase()}_BLOCKED`,
    patch: {
      architecture: {
        lastError: decision.blockingIssues.join("; "),
      },
    },
    metadata: {
      phase,
      blockingIssues: decision.blockingIssues,
    },
  });
}

function ensurePreparation(context, state, paths) {
  if (
    state.architecture?.preparation?.decision === "READY_FOR_DEVELOPMENT" &&
    state.architecture.preparation.baseCommit === context.baseCommit
  ) {
    return { reused: true, decision: "READY_FOR_DEVELOPMENT" };
  }

  const result = invokeArchitect({
    ...context,
    phase: ARCHITECT_PHASES.PREPARATION,
    sequence: 1,
    state,
    paths,
  });
  patchWorkflowState({
    root: context.root,
    taskId: context.taskId,
    defaults: context.defaults,
    event: "ARCHITECT_PREPARATION_BASE_RECORDED",
    patch: {
      architecture: {
        preparation: {
          baseCommit: context.baseCommit,
        },
      },
    },
  });

  if (result.decision.decision === "BLOCKED") {
    transitionArchitectBlocked({
      root: context.root,
      taskId: context.taskId,
      defaults: context.defaults,
      phase: ARCHITECT_PHASES.PREPARATION,
      decision: result.decision,
    });
  }
  return { reused: false, decision: result.decision.decision };
}

function ensureRepairBrief(context, state, paths) {
  const sequence = Math.max(1, (state.audit?.round ?? 0) + (state.workflowState === "development_failed" ? 1 : 0));
  const result = invokeArchitect({
    ...context,
    phase: ARCHITECT_PHASES.REPAIR,
    sequence,
    state,
    paths,
  });
  if (result.decision.decision === "BLOCKED") {
    transitionArchitectBlocked({
      root: context.root,
      taskId: context.taskId,
      defaults: context.defaults,
      phase: ARCHITECT_PHASES.REPAIR,
      decision: result.decision,
    });
  }
  return result.decision.decision;
}

function ensurePostDevelopmentReview(context, state, paths) {
  const current = state.architecture?.postDevelopment;
  if (
    current?.fingerprint &&
    current.fingerprint === state.implementationFingerprint &&
    current.decision === "READY_FOR_AUDIT"
  ) {
    return { reused: true, decision: "READY_FOR_AUDIT" };
  }

  const result = invokeArchitect({
    ...context,
    phase: ARCHITECT_PHASES.POST_DEVELOPMENT,
    sequence: Math.max(1, state.development?.attempt ?? 1),
    state,
    paths,
  });

  if (result.decision.decision === "REPAIR_REQUIRED") {
    transitionWorkflowState({
      root: context.root,
      taskId: context.taskId,
      defaults: context.defaults,
      to: "changes_required",
      event: "ARCHITECT_POST_DEVELOPMENT_REPAIR_REQUIRED",
      patch: {
        audit: {
          verdict: null,
          lastError: "Architect requires in-scope repair before independent audit",
        },
      },
      metadata: {
        report: result.artifacts.relativeMarkdown,
        implementationFingerprint: state.implementationFingerprint,
      },
    });
  } else if (result.decision.decision === "BLOCKED") {
    transitionArchitectBlocked({
      root: context.root,
      taskId: context.taskId,
      defaults: context.defaults,
      phase: ARCHITECT_PHASES.POST_DEVELOPMENT,
      decision: result.decision,
    });
  }

  return { reused: false, decision: result.decision.decision };
}

function ensureCompletionSummary(context, state, paths) {
  if (
    state.architecture?.completion?.decision === "COMPLETE" &&
    state.architecture.completion.fingerprint === state.approvedFingerprint
  ) {
    return { reused: true, decision: "COMPLETE" };
  }
  const result = invokeArchitect({
    ...context,
    phase: ARCHITECT_PHASES.COMPLETION,
    sequence: 1,
    state,
    paths,
  });
  patchWorkflowState({
    root: context.root,
    taskId: context.taskId,
    defaults: context.defaults,
    event: "ARCHITECT_COMPLETION_FINGERPRINT_RECORDED",
    patch: {
      architecture: {
        completion: {
          fingerprint: state.approvedFingerprint,
        },
      },
    },
  });
  return { reused: false, decision: result.decision.decision };
}

function buildDeveloperPrompt({
  taskId,
  baseRef,
  baseCommit,
  contractPath,
  reportPath,
  resume,
  preparationPath,
  repairPath,
  latestAuditReportPath,
}) {
  return `Use the scaflow-developer custom agent and the scaflow-development Skill.\n\nImplement exactly ${taskId}.\n\nInputs:\n- Task Contract: ${contractPath}\n- Base ref: ${baseRef}\n- Resolved base commit: ${baseCommit}\n- Current branch and working tree are the implementation target.\n- Architect preparation brief: ${preparationPath ?? "not present"}\n- Architect repair brief: ${repairPath ?? "not present"}\n- Latest independent audit report: ${latestAuditReportPath ?? "not present"}\n- The wrapper captures your final response as ${reportPath}.\n\nMandatory behavior:\n1. Perform the complete preflight from docs/development/scaflow-development-workflow.md.\n2. Follow Architect guidance only where it remains inside the Task Contract; the Task Contract and project baseline remain authoritative.\n3. Preserve unrelated changes and stop if they overlap the task.\n4. Implement only ${taskId}; do not implement future tasks.\n5. Run every Task Contract verification command, git diff --check, and git status --short.\n6. Perform developer self-review against the actual diff.\n7. Return the complete developer report as the final response. Do not write the report file yourself.\n8. Do not commit, push, create a pull request, or mark the shared Task completed.\n${resume ? "9. This is a repair round. Read the latest Architect repair brief and independent audit report, then fix only current in-scope findings.\n" : ""}`;
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
      architecture: {
        postDevelopment: null,
        completion: null,
        lastError: null,
      },
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
    preparationPath: state.architecture?.preparation?.report ?? null,
    repairPath: state.architecture?.repair?.report ?? null,
    latestAuditReportPath: state.audit?.report ?? null,
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

function importExistingImplementation({ root, taskId, defaults, state, baseCommit }) {
  const fingerprint = implementationFingerprint(root, baseCommit);
  transitionWorkflowState({
    root,
    taskId,
    defaults,
    to: "ready_for_audit",
    event: "AUTONOMOUS_EXISTING_IMPLEMENTATION_IMPORTED",
    patch: {
      implementationFingerprint: fingerprint,
      development: {
        attempt: Math.max(1, state.development?.attempt ?? 0),
        finishedAt: new Date().toISOString(),
        imported: true,
        lastError: null,
      },
    },
    metadata: { implementationFingerprint: fingerprint },
  });
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
      architectError: state.architecture?.lastError ?? null,
      architectDecision: state.architecture?.repair?.decision ?? state.architecture?.postDevelopment?.decision ?? null,
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

function recordStep(runState, action, exitCode, resultState) {
  runState.steps.push({
    at: new Date().toISOString(),
    action,
    exitCode,
    resultState,
  });
}

const options = parseArgs(process.argv.slice(2));
const root = repositoryRoot();
process.chdir(root);
ensureCodex();
const contractPath = ensureTask(options.taskId);
const planPath = join("tasks", options.taskId, "plan.md");
const resolvedPlanPath = existsSync(planPath) ? planPath : null;
const baseCommit = resolveGitRef(root, options.baseRef);
const branch = currentBranch(root);
if (branch === "main" || branch === "master" || branch === "dev" || branch === "DETACHED_HEAD") {
  fail(`autonomous development requires a dedicated task branch, current branch: ${branch}`);
}

const defaults = { baseRef: options.baseRef, baseCommit, branch };
const context = {
  root,
  taskId: options.taskId,
  baseRef: options.baseRef,
  baseCommit,
  branch,
  contractPath,
  planPath: resolvedPlanPath,
  defaults,
};
let loaded = readWorkflowState(root, options.taskId, defaults);
if (loaded.exists) {
  if (loaded.state.baseRef !== options.baseRef || loaded.state.baseCommit !== baseCommit) {
    fail(`workflow uses frozen base ${loaded.state.baseRef}@${loaded.state.baseCommit.slice(0, 12)}`);
  }
  if (loaded.state.branch !== branch) fail(`workflow belongs to branch ${loaded.state.branch}`);
}

if (options.dryRun) {
  console.log(`[scaflow-run] task: ${options.taskId}`);
  console.log(`[scaflow-run] workflow state: ${loaded.state.workflowState}`);
  console.log(`[scaflow-run] architect: ${loaded.state.architecture?.preparation ? "prepared" : "preparation required"}`);
  console.log(`[scaflow-run] implementation changes: ${implementationHasChanges(root, baseCommit) ? "yes" : "no"}`);
  process.exit(0);
}

mkdirSync(loaded.paths.directory, { recursive: true });
const lockPath = join(loaded.paths.directory, "run.lock");
acquireLock(lockPath);

const runState = {
  version: 2,
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
    let state = loaded.state;

    if (state.workflowState === "approved" || state.workflowState === "approved_with_follow_ups") {
      const completion = ensureCompletionSummary(context, state, loaded.paths);
      recordStep(runState, completion.reused ? "architect_completion_reused" : "architect_completion", 0, state.workflowState);
      runState.status = "succeeded";
      runState.stopReason = state.workflowState;
      exitCode = 0;
      break;
    }

    if (["committed", "pushed", "merged"].includes(state.workflowState)) {
      runState.status = "succeeded";
      runState.stopReason = state.workflowState;
      exitCode = 0;
      break;
    }

    if (state.workflowState === "blocked") {
      runState.status = "blocked";
      runState.stopReason = state.architecture?.lastError || "workflow is blocked";
      exitCode = 2;
      break;
    }

    if (state.workflowState === "developing" || state.workflowState === "auditing") {
      runState.status = "stopped";
      runState.stopReason = `workflow is already active: ${state.workflowState}`;
      exitCode = 2;
      break;
    }

    if (!state.architecture?.preparation || state.architecture.preparation.baseCommit !== baseCommit) {
      const preparation = ensurePreparation(context, state, loaded.paths);
      loaded = readWorkflowState(root, options.taskId, defaults);
      state = loaded.state;
      recordStep(runState, preparation.reused ? "architect_preparation_reused" : "architect_preparation", 0, state.workflowState);
      if (state.workflowState === "blocked") continue;
    }

    if (state.workflowState === "ready") {
      if (implementationHasChanges(root, baseCommit)) {
        importExistingImplementation({
          root,
          taskId: options.taskId,
          defaults,
          state,
          baseCommit,
        });
        loaded = readWorkflowState(root, options.taskId, defaults);
        recordStep(runState, "import_existing_implementation", 0, loaded.state.workflowState);
      } else {
        if ((state.development?.attempt ?? 0) >= options.maxDevelopmentAttempts) {
          runState.status = "limit_reached";
          runState.stopReason = "maximum development attempts reached";
          exitCode = 2;
          break;
        }
        const child = executeDeveloper({
          root,
          taskId: options.taskId,
          baseRef: options.baseRef,
          baseCommit,
          contractPath,
          state,
          paths: loaded.paths,
          resume: false,
        });
        loaded = readWorkflowState(root, options.taskId, defaults);
        recordStep(runState, "develop_initial", child, loaded.state.workflowState);
      }
    } else if (["development_failed", "changes_required", "audit_invalid"].includes(state.workflowState)) {
      if ((state.development?.attempt ?? 0) >= options.maxDevelopmentAttempts) {
        runState.status = "limit_reached";
        runState.stopReason = "maximum development attempts reached";
        exitCode = 2;
        break;
      }
      const repairDecision = ensureRepairBrief(context, state, loaded.paths);
      loaded = readWorkflowState(root, options.taskId, defaults);
      state = loaded.state;
      recordStep(runState, "architect_repair", 0, state.workflowState);
      if (repairDecision === "BLOCKED" || state.workflowState === "blocked") continue;

      const child = executeDeveloper({
        root,
        taskId: options.taskId,
        baseRef: options.baseRef,
        baseCommit,
        contractPath,
        state,
        paths: loaded.paths,
        resume: true,
      });
      loaded = readWorkflowState(root, options.taskId, defaults);
      recordStep(runState, "develop_resume", child, loaded.state.workflowState);
    } else if (state.workflowState === "ready_for_audit") {
      const review = ensurePostDevelopmentReview(context, state, loaded.paths);
      loaded = readWorkflowState(root, options.taskId, defaults);
      state = loaded.state;
      recordStep(runState, review.reused ? "architect_post_review_reused" : "architect_post_review", 0, state.workflowState);
      if (state.workflowState !== "ready_for_audit") continue;

      if ((state.audit?.round ?? 0) >= options.maxAuditRounds) {
        runState.status = "limit_reached";
        runState.stopReason = "maximum audit rounds reached";
        exitCode = 2;
        break;
      }
      const result = run("node", [
        join(root, "scripts", "scaflow-audit.mjs"),
        options.taskId,
        "--base",
        options.baseRef,
      ]);
      loaded = readWorkflowState(root, options.taskId, defaults);
      recordStep(runState, "audit", result.status ?? 1, loaded.state.workflowState);
    } else if (state.workflowState === "audit_failed") {
      if ((state.audit?.round ?? 0) >= options.maxAuditRounds) {
        runState.status = "limit_reached";
        runState.stopReason = "maximum audit rounds reached";
        exitCode = 2;
        break;
      }
      const result = run("node", [
        join(root, "scripts", "scaflow-audit.mjs"),
        options.taskId,
        "--base",
        options.baseRef,
      ]);
      loaded = readWorkflowState(root, options.taskId, defaults);
      recordStep(runState, "audit_retry", result.status ?? 1, loaded.state.workflowState);
    } else {
      throw new Error(`unsupported workflow state: ${state.workflowState}`);
    }

    loaded = readWorkflowState(root, options.taskId, defaults);
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
