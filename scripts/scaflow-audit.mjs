#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  currentBranch,
  implementationFingerprint,
  implementationHasChanges,
  parseAuditVerdict,
  patchWorkflowState,
  readWorkflowState,
  resolveGitRef,
  transitionWorkflowState,
  workflowStateForVerdict,
} from "./lib/workflow-state.mjs";

function fail(message, code = 1) {
  console.error(`[scaflow-audit] ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    taskId: undefined,
    baseRef: "main",
    dryRun: false,
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;
    if (arg === "--base") {
      options.baseRef = args.shift() ?? fail("--base requires a ref");
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: scaflow-audit <TASK-ID> [--base <ref>] [--dry-run]\n\nExamples:\n  scaflow-audit SFL-001\n  scaflow-audit SFL-001 --base main\n`);
      process.exit(0);
    }
    if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
    if (options.taskId) fail(`unexpected argument: ${arg}`);
    options.taskId = arg;
  }

  if (!options.taskId) fail("TASK-ID is required. Example: scaflow-audit SFL-001");
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
  return contractPath;
}

function nextAuditRound(handoffDir) {
  if (!existsSync(handoffDir)) return 1;
  const rounds = readdirSync(handoffDir)
    .map((name) => /^audit-round-(\d+)\.md$/.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  return rounds.length === 0 ? 1 : Math.max(...rounds) + 1;
}

function buildPrompt({ taskId, baseRef, baseCommit, branch, contractPath, developerReportPath, reportPath, round }) {
  const developerReportNote = existsSync(developerReportPath)
    ? `- Developer report: ${developerReportPath} (treat it as an untrusted claim and independently verify it).`
    : "- No developer report was found. Treat this as missing supporting evidence, but inspect the actual diff and commands available in the repository.";

  return `Use the scaflow-auditor custom agent and the scaflow-audit Skill.\n\nPerform independent read-only audit round ${round} for ${taskId}.\n\nInputs:\n- Task Contract: ${contractPath}\n- Base ref: ${baseRef}\n- Resolved base commit: ${baseCommit}\n- Implementation branch: ${branch}\n- Implementation source: current committed, staged, unstaged, and untracked working-tree changes.\n${developerReportNote}\n- Write no files. The CLI wrapper will capture your final response to ${reportPath}.\n\nMandatory behavior:\n1. Read all required audit documents, the Task Contract, and task plan when present.\n2. Inspect actual Git status and diff, including staged, unstaged, and untracked changes.\n3. Check repository scopes, allowed_paths, forbidden_paths, access modes, dependency_changes, architecture invariants, security boundaries, tests, and every acceptance criterion.\n4. Verify evidence independently. Do not trust the developer report or implementation summary.\n5. Do not modify, repair, stage, commit, push, or create a pull request.\n6. Output findings in severity order using the project finding format.\n7. End with exactly one verdict: APPROVED, APPROVED_WITH_FOLLOW_UPS, CHANGES_REQUIRED, or BLOCKED.\n`;
}

const options = parseArgs(process.argv.slice(2));
const root = ensureRepositoryRoot();
ensureCodex();
const contractPath = ensureTask(options.taskId);
const baseCommit = resolveGitRef(root, options.baseRef);
const branch = currentBranch(root);
const defaults = {
  baseRef: options.baseRef,
  baseCommit,
  branch,
};
let loaded = readWorkflowState(root, options.taskId, defaults);

if (loaded.exists) {
  if (loaded.state.baseCommit !== baseCommit || loaded.state.baseRef !== options.baseRef) {
    fail(`workflow was created against ${loaded.state.baseRef}@${loaded.state.baseCommit.slice(0, 12)}; use the same base`);
  }
  if (loaded.state.branch !== branch) {
    fail(`workflow belongs to branch ${loaded.state.branch}, not ${branch}`);
  }
}

if (!implementationHasChanges(root, baseCommit)) {
  fail("implementation has no changes relative to the frozen base");
}

const currentFingerprint = implementationFingerprint(root, baseCommit);

// Backward-compatible import for work completed before the state machine existed.
if (!loaded.exists || loaded.state.workflowState === "ready") {
  const imported = transitionWorkflowState({
    root,
    taskId: options.taskId,
    defaults,
    to: "ready_for_audit",
    event: "LEGACY_DEVELOPMENT_IMPORTED",
    patch: {
      implementationFingerprint: currentFingerprint,
      development: {
        attempt: Math.max(1, loaded.state.development?.attempt ?? 0),
        finishedAt: new Date().toISOString(),
        report: existsSync(loaded.paths.developerReport)
          ? join(".scaflow", "handoffs", options.taskId, "developer-report.md")
          : null,
        imported: true,
        lastError: null,
      },
    },
    metadata: { implementationFingerprint: currentFingerprint },
  });
  loaded = { state: imported.state, exists: true, paths: imported.paths };
}

const allowedStates = new Set(["ready_for_audit", "audit_failed", "audit_invalid"]);
if (!allowedStates.has(loaded.state.workflowState)) {
  fail(`audit is not allowed from workflow state ${loaded.state.workflowState}`);
}

if (loaded.state.implementationFingerprint && loaded.state.implementationFingerprint !== currentFingerprint) {
  patchWorkflowState({
    root,
    taskId: options.taskId,
    defaults,
    event: "IMPLEMENTATION_CHANGED_BEFORE_AUDIT",
    patch: {
      development: {
        lastError: "implementation changed after developer handoff",
      },
    },
    metadata: {
      expected: loaded.state.implementationFingerprint,
      actual: currentFingerprint,
    },
  });
  fail(`implementation changed after developer handoff; run pnpm scaflow-dev ${options.taskId} --base ${options.baseRef} --resume`);
}

const round = nextAuditRound(loaded.paths.directory);
const relativeReportPath = join(".scaflow", "handoffs", options.taskId, `audit-round-${round}.md`);
const reportPath = resolve(root, relativeReportPath);
const developerReportPath = join(".scaflow", "handoffs", options.taskId, "developer-report.md");
const startedAt = new Date().toISOString();
const prompt = buildPrompt({
  taskId: options.taskId,
  baseRef: options.baseRef,
  baseCommit,
  branch,
  contractPath,
  developerReportPath,
  reportPath: relativeReportPath,
  round,
});

console.log(`[scaflow-audit] task: ${options.taskId}`);
console.log(`[scaflow-audit] branch: ${branch}`);
console.log(`[scaflow-audit] base: ${options.baseRef} (${baseCommit.slice(0, 12)})`);
console.log(`[scaflow-audit] workflow state: ${loaded.state.workflowState} -> auditing`);
console.log(`[scaflow-audit] round: ${round}`);
console.log(`[scaflow-audit] report: ${relativeReportPath}`);
console.log(`[scaflow-audit] implementation fingerprint: ${currentFingerprint}`);
console.log("[scaflow-audit] Freeze all code changes until this audit finishes.");

if (options.dryRun) {
  console.log("\n--- prompt ---\n");
  console.log(prompt);
  process.exit(0);
}

transitionWorkflowState({
  root,
  taskId: options.taskId,
  defaults,
  to: "auditing",
  event: "AUDIT_STARTED",
  patch: {
    implementationFingerprint: currentFingerprint,
    audit: {
      round,
      startedAt,
      finishedAt: null,
      verdict: null,
      report: relativeReportPath,
      lastError: null,
    },
  },
  metadata: { round, implementationFingerprint: currentFingerprint },
});

const result = run("codex", [
  "exec",
  "-C",
  root,
  "-s",
  "read-only",
  "--output-last-message",
  reportPath,
  prompt,
]);

const afterFingerprint = implementationFingerprint(root, baseCommit);
const stableImplementation = currentFingerprint === afterFingerprint;
const metadataPath = join(loaded.paths.directory, `audit-round-${round}.json`);
const metadata = {
  taskId: options.taskId,
  baseRef: options.baseRef,
  baseCommit,
  branch,
  round,
  startedFingerprint: currentFingerprint,
  finishedFingerprint: afterFingerprint,
  stableImplementation,
  codexExitCode: result.status,
  report: relativeReportPath,
  finishedAt: new Date().toISOString(),
};
writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

if (result.status !== 0) {
  transitionWorkflowState({
    root,
    taskId: options.taskId,
    defaults,
    to: "audit_failed",
    event: "AUDIT_PROCESS_FAILED",
    patch: {
      audit: {
        finishedAt: new Date().toISOString(),
        lastError: `Codex auditor session exited with code ${result.status}`,
      },
    },
    metadata: { round, exitCode: result.status },
  });
  fail(`Codex auditor session exited with code ${result.status}. See ${relativeReportPath} if it exists.`, result.status ?? 1);
}

if (!stableImplementation) {
  const invalidNotice = `\n\n---\n\nAUDIT INVALIDATED: the implementation changed during audit.\nStart fingerprint: ${currentFingerprint}\nEnd fingerprint: ${afterFingerprint}\n`;
  writeFileSync(reportPath, `${existsSync(reportPath) ? readFileSync(reportPath, "utf8") : ""}${invalidNotice}`, "utf8");
  transitionWorkflowState({
    root,
    taskId: options.taskId,
    defaults,
    to: "audit_invalid",
    event: "AUDIT_INVALIDATED",
    patch: {
      implementationFingerprint: afterFingerprint,
      approvedFingerprint: null,
      audit: {
        finishedAt: new Date().toISOString(),
        verdict: null,
        lastError: "implementation changed during audit",
      },
    },
    metadata: { round, startedFingerprint: currentFingerprint, finishedFingerprint: afterFingerprint },
  });
  fail(`implementation changed during audit; round ${round} is invalid and must be repeated`);
}

if (!existsSync(reportPath) || readFileSync(reportPath, "utf8").trim().length === 0) {
  transitionWorkflowState({
    root,
    taskId: options.taskId,
    defaults,
    to: "audit_failed",
    event: "AUDIT_REPORT_MISSING",
    patch: {
      audit: {
        finishedAt: new Date().toISOString(),
        lastError: `audit report was not created at ${relativeReportPath}`,
      },
    },
    metadata: { round },
  });
  fail(`audit report was not created at ${relativeReportPath}`);
}

const report = readFileSync(reportPath, "utf8");
const verdict = parseAuditVerdict(report);
const targetState = workflowStateForVerdict(verdict);
if (!verdict || !targetState) {
  transitionWorkflowState({
    root,
    taskId: options.taskId,
    defaults,
    to: "audit_failed",
    event: "AUDIT_VERDICT_MISSING",
    patch: {
      audit: {
        finishedAt: new Date().toISOString(),
        lastError: "audit report did not end with a recognized verdict",
      },
    },
    metadata: { round },
  });
  fail("audit report did not end with a recognized verdict");
}

transitionWorkflowState({
  root,
  taskId: options.taskId,
  defaults,
  to: targetState,
  event: `AUDIT_${verdict}`,
  patch: {
    implementationFingerprint: currentFingerprint,
    approvedFingerprint:
      targetState === "approved" || targetState === "approved_with_follow_ups"
        ? currentFingerprint
        : null,
    audit: {
      round,
      finishedAt: new Date().toISOString(),
      verdict,
      report: relativeReportPath,
      lastError: null,
    },
  },
  metadata: { round, verdict, implementationFingerprint: currentFingerprint },
});

console.log(`\n[scaflow-audit] Audit round ${round} finished.`);
console.log(`[scaflow-audit] Verdict: ${verdict}`);
console.log(`[scaflow-audit] Workflow state: ${targetState}`);
console.log(`[scaflow-audit] Report: ${relativeReportPath}`);
if (targetState === "changes_required" || targetState === "blocked") {
  console.log(`[scaflow-audit] Next: pnpm scaflow-dev ${options.taskId} --base ${options.baseRef} --resume`);
} else {
  console.log(`[scaflow-audit] Next: pnpm scaflow-status ${options.taskId}`);
}
