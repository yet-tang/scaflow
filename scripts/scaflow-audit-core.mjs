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
  const options = { taskId: undefined, baseRef: "main", dryRun: false };
  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;
    if (arg === "--base") {
      options.baseRef = args.shift() ?? fail("--base requires a ref");
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: scaflow-audit <TASK-ID> [--base <ref>] [--dry-run]\n`);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      fail(`unknown option: ${arg}`);
    } else if (options.taskId) {
      fail(`unexpected argument: ${arg}`);
    } else {
      options.taskId = arg;
    }
  }
  if (!options.taskId) fail("TASK-ID is required. Example: scaflow-audit SFL-001");
  if (!/^SFL-\d{3}$/.test(options.taskId)) fail(`invalid Task ID: ${options.taskId}`);
  return options;
}

function run(command, args, { cwd = process.cwd(), capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    env: process.env,
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  return result;
}

function repositoryRoot() {
  const result = run("git", ["rev-parse", "--show-toplevel"], { capture: true });
  if (result.status !== 0) fail("current directory is not inside a Git repository");
  return result.stdout.trim();
}

function ensureCodex() {
  const result = run("codex", ["--version"], { capture: true });
  if (result.status !== 0) fail("Codex CLI is not installed or not available in PATH");
}

function ensureTask(taskId) {
  const path = join("tasks", taskId, "contract.yaml");
  if (!existsSync(path)) fail(`Task Contract not found: ${path}`);
  const content = readFileSync(path, "utf8");
  if (!content.includes(`id: ${taskId}`)) fail(`Task Contract ID does not match ${taskId}`);
  return path;
}

function nextAuditRound(directory) {
  if (!existsSync(directory)) return 1;
  const rounds = readdirSync(directory)
    .map((name) => /^audit-round-(\d+)\.md$/.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  return rounds.length === 0 ? 1 : Math.max(...rounds) + 1;
}

function buildPrompt({ taskId, baseRef, baseCommit, branch, contractPath, reportPath, round, developerReportPath }) {
  const developerEvidence = existsSync(developerReportPath)
    ? `- Developer report: ${developerReportPath} (untrusted; independently verify it).`
    : "- Developer report: missing supporting evidence.";

  return `Use the scaflow-auditor custom agent and the scaflow-audit Skill.\n\nPerform independent audit round ${round} for ${taskId}.\n\nInputs:\n- Task Contract: ${contractPath}\n- Base ref: ${baseRef}\n- Resolved base commit: ${baseCommit}\n- Implementation branch: ${branch}\n- Implementation source: current committed, staged, unstaged, and untracked working-tree changes.\n${developerEvidence}\n- Architect evidence when present: .scaflow/handoffs/${taskId}/architect/\n- The CLI wrapper captures your final response at ${reportPath}.\n\nExecution boundary:\n- The process sandbox is workspace-write only so test tools may create temporary directories and caches.\n- You remain a read-only reviewer: do not edit source, tests, contracts, plans, policies, or Git state.\n- The Controller fingerprints the complete implementation before and after audit. Any source or non-ignored implementation change invalidates the audit.\n\nMandatory behavior:\n1. Inspect the actual Git status and complete diff, including untracked files.\n2. Independently execute every required Task Contract verification command.\n3. Check scopes, allowed_paths, forbidden_paths, access modes, dependency_changes, architecture and security invariants, tests, and every acceptance criterion.\n4. Treat Developer and Architect reports as untrusted claims.\n5. Do not repair, stage, commit, push, merge, or invoke Controller commands.\n6. Output findings in severity order.\n7. End with exactly one verdict: APPROVED, APPROVED_WITH_FOLLOW_UPS, CHANGES_REQUIRED, or BLOCKED.\n`;
}

const options = parseArgs(process.argv.slice(2));
const root = repositoryRoot();
process.chdir(root);
ensureCodex();
const contractPath = ensureTask(options.taskId);
const baseCommit = resolveGitRef(root, options.baseRef);
const branch = currentBranch(root);
const defaults = { baseRef: options.baseRef, baseCommit, branch };
let loaded = readWorkflowState(root, options.taskId, defaults);

if (loaded.exists) {
  if (loaded.state.baseCommit !== baseCommit || loaded.state.baseRef !== options.baseRef) {
    fail(`workflow was created against ${loaded.state.baseRef}@${loaded.state.baseCommit.slice(0, 12)}; use the same base`);
  }
  if (loaded.state.branch !== branch) fail(`workflow belongs to branch ${loaded.state.branch}, not ${branch}`);
}

if (!implementationHasChanges(root, baseCommit)) {
  fail("implementation has no changes relative to the frozen base");
}

const currentFingerprint = implementationFingerprint(root, baseCommit);
const legacyImportNeeded = !loaded.exists || loaded.state.workflowState === "ready";
const effectiveState = legacyImportNeeded ? "ready_for_audit" : loaded.state.workflowState;
if (!["ready_for_audit", "audit_failed"].includes(effectiveState)) {
  fail(`audit is not allowed from workflow state ${loaded.state.workflowState}`);
}

if (
  !legacyImportNeeded &&
  loaded.state.implementationFingerprint &&
  loaded.state.implementationFingerprint !== currentFingerprint
) {
  if (!options.dryRun) {
    transitionWorkflowState({
      root,
      taskId: options.taskId,
      defaults,
      to: "audit_invalid",
      event: "IMPLEMENTATION_CHANGED_BEFORE_AUDIT",
      patch: {
        implementationFingerprint: currentFingerprint,
        approvedFingerprint: null,
        development: { lastError: "implementation changed after developer handoff" },
        audit: {
          verdict: null,
          lastError: "developer handoff fingerprint no longer matches the implementation",
        },
      },
      metadata: {
        expected: loaded.state.implementationFingerprint,
        actual: currentFingerprint,
      },
    });
  }
  fail("implementation changed after developer handoff; resume development and rerun the complete Task Gate");
}

const round = nextAuditRound(loaded.paths.directory);
const relativeReportPath = join(".scaflow", "handoffs", options.taskId, `audit-round-${round}.md`);
const reportPath = resolve(root, relativeReportPath);
const developerReportPath = join(".scaflow", "handoffs", options.taskId, "developer-report.md");
const prompt = buildPrompt({
  taskId: options.taskId,
  baseRef: options.baseRef,
  baseCommit,
  branch,
  contractPath,
  reportPath: relativeReportPath,
  round,
  developerReportPath,
});

console.log(`[scaflow-audit] task: ${options.taskId}`);
console.log(`[scaflow-audit] branch: ${branch}`);
console.log(`[scaflow-audit] base: ${options.baseRef} (${baseCommit.slice(0, 12)})`);
console.log(`[scaflow-audit] round: ${round}`);
console.log("[scaflow-audit] sandbox: workspace-write (source changes invalidate audit)");
console.log(`[scaflow-audit] implementation fingerprint: ${currentFingerprint}`);

if (options.dryRun) {
  console.log("\n--- prompt ---\n");
  console.log(prompt);
  process.exit(0);
}

if (legacyImportNeeded) {
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
        report: existsSync(loaded.paths.developerReport) ? developerReportPath : null,
        imported: true,
        lastError: null,
      },
    },
    metadata: { implementationFingerprint: currentFingerprint },
  });
  loaded = { state: imported.state, exists: true, paths: imported.paths };
}

const startedAt = new Date().toISOString();
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
  metadata: {
    round,
    implementationFingerprint: currentFingerprint,
    sandbox: "workspace-write",
    sourceMutationGuard: true,
  },
});

const result = run("codex", [
  "exec",
  "-C",
  root,
  "-s",
  "workspace-write",
  "--output-last-message",
  reportPath,
  prompt,
]);

const afterFingerprint = implementationFingerprint(root, baseCommit);
const stableImplementation = currentFingerprint === afterFingerprint;
const metadataPath = join(loaded.paths.directory, `audit-round-${round}.json`);
writeFileSync(
  metadataPath,
  `${JSON.stringify({
    taskId: options.taskId,
    baseRef: options.baseRef,
    baseCommit,
    branch,
    round,
    sandbox: "workspace-write",
    sourceMutationGuard: true,
    startedFingerprint: currentFingerprint,
    finishedFingerprint: afterFingerprint,
    stableImplementation,
    codexExitCode: result.status,
    report: relativeReportPath,
    finishedAt: new Date().toISOString(),
  }, null, 2)}\n`,
  "utf8",
);

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
  fail(`Codex auditor session exited with code ${result.status}`, result.status ?? 1);
}

if (!stableImplementation) {
  const notice = `\n\n---\n\nAUDIT INVALIDATED: implementation changed during audit.\nStart fingerprint: ${currentFingerprint}\nEnd fingerprint: ${afterFingerprint}\n`;
  writeFileSync(reportPath, `${existsSync(reportPath) ? readFileSync(reportPath, "utf8") : ""}${notice}`, "utf8");
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
    metadata: {
      round,
      startedFingerprint: currentFingerprint,
      finishedFingerprint: afterFingerprint,
    },
  });
  fail("implementation changed during audit; resume development and rerun the complete Task Gate");
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
