#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import process from "node:process";

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

function ensureBaseRef(baseRef) {
  const result = run("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], { capture: true });
  if (result.status !== 0) fail(`base ref does not resolve to a commit: ${baseRef}`);
  return result.stdout.trim();
}

function currentBranch() {
  const result = run("git", ["branch", "--show-current"], { capture: true });
  if (result.status !== 0) fail("unable to determine current branch");
  return result.stdout.trim() || "DETACHED_HEAD";
}

function listUntrackedFiles() {
  const result = run("git", ["ls-files", "--others", "--exclude-standard", "-z"], { capture: true });
  if (result.status !== 0) fail("unable to list untracked files");
  return result.stdout.split("\0").filter(Boolean).sort();
}

function hashPath(hash, path) {
  if (!existsSync(path)) {
    hash.update(`missing:${path}\0`);
    return;
  }
  const stats = statSync(path);
  if (stats.isDirectory()) {
    hash.update(`dir:${path}\0`);
    for (const child of readdirSync(path).sort()) {
      hashPath(hash, join(path, child));
    }
    return;
  }
  hash.update(`file:${path}:${stats.mode}:${stats.size}\0`);
  hash.update(readFileSync(path));
}

function workingTreeFingerprint(root) {
  const hash = createHash("sha256");
  const commands = [
    ["status", "--porcelain=v1", "-z"],
    ["diff", "--binary", "--no-ext-diff"],
    ["diff", "--cached", "--binary", "--no-ext-diff"],
  ];

  for (const args of commands) {
    const result = run("git", args, { capture: true });
    if (result.status !== 0) fail(`unable to fingerprint working tree: git ${args.join(" ")}`);
    hash.update(args.join(" "));
    hash.update("\0");
    hash.update(result.stdout);
    hash.update("\0");
  }

  for (const path of listUntrackedFiles()) {
    hashPath(hash, resolve(root, path));
  }

  return hash.digest("hex");
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
const baseCommit = ensureBaseRef(options.baseRef);
const branch = currentBranch();

const handoffDir = resolve(root, ".scaflow", "handoffs", options.taskId);
mkdirSync(handoffDir, { recursive: true });
const round = nextAuditRound(handoffDir);
const relativeReportPath = join(".scaflow", "handoffs", options.taskId, `audit-round-${round}.md`);
const reportPath = resolve(root, relativeReportPath);
const developerReportPath = join(".scaflow", "handoffs", options.taskId, "developer-report.md");
const beforeFingerprint = workingTreeFingerprint(root);

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
console.log(`[scaflow-audit] round: ${round}`);
console.log(`[scaflow-audit] report: ${relativeReportPath}`);
console.log(`[scaflow-audit] working tree fingerprint: ${beforeFingerprint}`);
console.log("[scaflow-audit] Freeze all code changes until this audit finishes.");

if (options.dryRun) {
  console.log("\n--- prompt ---\n");
  console.log(prompt);
  process.exit(0);
}

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

const afterFingerprint = workingTreeFingerprint(root);
const metadataPath = join(handoffDir, `audit-round-${round}.json`);
const metadata = {
  taskId: options.taskId,
  baseRef: options.baseRef,
  baseCommit,
  branch,
  round,
  startedFingerprint: beforeFingerprint,
  finishedFingerprint: afterFingerprint,
  stableWorkingTree: beforeFingerprint === afterFingerprint,
  codexExitCode: result.status,
  report: relativeReportPath,
  finishedAt: new Date().toISOString(),
};
writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

if (result.status !== 0) {
  fail(`Codex auditor session exited with code ${result.status}. See ${relativeReportPath} if it exists.`, result.status ?? 1);
}

if (beforeFingerprint !== afterFingerprint) {
  const invalidNotice = `\n\n---\n\nAUDIT INVALIDATED: the working tree changed during audit.\nStart fingerprint: ${beforeFingerprint}\nEnd fingerprint: ${afterFingerprint}\n`;
  writeFileSync(reportPath, `${existsSync(reportPath) ? readFileSync(reportPath, "utf8") : ""}${invalidNotice}`, "utf8");
  fail(`working tree changed during audit; round ${round} is invalid and must be repeated`);
}

console.log(`\n[scaflow-audit] Audit round ${round} finished with a stable working tree.`);
console.log(`[scaflow-audit] Report: ${relativeReportPath}`);
console.log(`[scaflow-audit] If changes are required, run: scaflow-dev ${options.taskId} --base ${options.baseRef} --resume`);
