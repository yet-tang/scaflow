#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import {
  currentBranch,
  headCommit,
  implementationFingerprint,
  nextActionForState,
  readWorkflowState,
  resolveGitRef,
  transitionWorkflowState,
  verifyCommitMerged,
  verifyCommitPushed,
  workingTreeIsClean,
} from "./lib/workflow-state.mjs";

function fail(message, code = 1) {
  console.error(`[scaflow-status] ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    taskId: undefined,
    baseRef: undefined,
    mark: undefined,
    json: false,
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;
    if (arg === "--base") {
      options.baseRef = args.shift() ?? fail("--base requires a ref");
      continue;
    }
    if (arg === "--mark") {
      options.mark = args.shift() ?? fail("--mark requires committed, pushed, or merged");
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: scaflow-status <TASK-ID> [--base <ref>] [--mark committed|pushed|merged] [--json]\n\nExamples:\n  scaflow-status SFL-001\n  scaflow-status SFL-001 --json\n  scaflow-status SFL-001 --mark committed\n  scaflow-status SFL-001 --mark pushed\n  scaflow-status SFL-001 --base origin/main --mark merged\n`);
      process.exit(0);
    }
    if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
    if (options.taskId) fail(`unexpected argument: ${arg}`);
    options.taskId = arg;
  }

  if (!options.taskId) fail("TASK-ID is required. Example: scaflow-status SFL-001");
  if (!/^SFL-\d{3}$/.test(options.taskId)) fail(`invalid Task ID: ${options.taskId}`);
  if (options.mark && !["committed", "pushed", "merged"].includes(options.mark)) {
    fail(`invalid --mark value: ${options.mark}`);
  }
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

function repositoryRoot() {
  const result = run("git", ["rev-parse", "--show-toplevel"], { capture: true });
  if (result.status !== 0) fail("current directory is not inside a Git repository");
  return result.stdout.trim();
}

function ensureTask(taskId) {
  const path = join("tasks", taskId, "contract.yaml");
  if (!existsSync(path)) fail(`Task Contract not found: ${path}`);
  const contract = readFileSync(path, "utf8");
  if (!contract.includes(`id: ${taskId}`)) fail(`Task Contract ID does not match ${taskId}`);
  return path;
}

function verifyBranch(root, expected) {
  const branch = currentBranch(root);
  if (branch !== expected) {
    fail(`workflow belongs to branch ${expected}, not ${branch}`);
  }
  return branch;
}

function verifyCommitReady(root, state) {
  if (!["approved", "approved_with_follow_ups"].includes(state.workflowState)) {
    fail(`cannot mark committed from workflow state ${state.workflowState}`);
  }
  if (!workingTreeIsClean(root)) {
    fail("working tree must be clean before marking committed");
  }
  const fingerprint = implementationFingerprint(root, state.baseCommit);
  if (!state.approvedFingerprint || fingerprint !== state.approvedFingerprint) {
    fail("current implementation does not match the approved fingerprint; run development and audit again");
  }
  const commit = headCommit(root);
  if (commit === state.baseCommit) {
    fail("HEAD is still the frozen base commit; commit the implementation first");
  }
  return { commit, fingerprint };
}

function markState(root, taskId, loaded, mark) {
  const state = loaded.state;
  const defaults = {
    baseRef: state.baseRef,
    baseCommit: state.baseCommit,
    branch: state.branch,
  };
  verifyBranch(root, state.branch);

  if (mark === "committed") {
    const { commit, fingerprint } = verifyCommitReady(root, state);
    return transitionWorkflowState({
      root,
      taskId,
      defaults,
      to: "committed",
      event: "IMPLEMENTATION_COMMITTED",
      patch: {
        implementationFingerprint: fingerprint,
        delivery: {
          commit,
          pushed: false,
          upstream: null,
        },
      },
      metadata: { commit, implementationFingerprint: fingerprint },
    }).state;
  }

  if (mark === "pushed") {
    if (state.workflowState !== "committed") {
      fail(`cannot mark pushed from workflow state ${state.workflowState}`);
    }
    if (!state.delivery?.commit) fail("committed state has no recorded commit");
    if (!workingTreeIsClean(root)) fail("working tree must be clean before marking pushed");
    if (headCommit(root) !== state.delivery.commit) {
      fail("HEAD does not match the recorded implementation commit");
    }
    const upstream = verifyCommitPushed(root, state.delivery.commit);
    return transitionWorkflowState({
      root,
      taskId,
      defaults,
      to: "pushed",
      event: "IMPLEMENTATION_PUSHED",
      patch: {
        delivery: {
          pushed: true,
          upstream,
        },
      },
      metadata: { commit: state.delivery.commit, upstream },
    }).state;
  }

  if (mark === "merged") {
    if (state.workflowState !== "pushed") {
      fail(`cannot mark merged from workflow state ${state.workflowState}`);
    }
    if (!state.delivery?.commit) fail("pushed state has no recorded commit");
    const baseRef = options.baseRef ?? state.baseRef;
    resolveGitRef(root, baseRef);
    verifyCommitMerged(root, state.delivery.commit, baseRef);
    return transitionWorkflowState({
      root,
      taskId,
      defaults,
      to: "merged",
      event: "IMPLEMENTATION_MERGED",
      patch: {
        baseRef,
        delivery: {
          merged: true,
          mergedAt: new Date().toISOString(),
        },
      },
      metadata: { commit: state.delivery.commit, baseRef },
    }).state;
  }

  return state;
}

function statusSnapshot(root, state, paths) {
  let currentFingerprint = null;
  let approvalCurrent = null;
  try {
    currentFingerprint = implementationFingerprint(root, state.baseCommit);
    approvalCurrent = state.approvedFingerprint
      ? currentFingerprint === state.approvedFingerprint
      : null;
  } catch {
    // Status must remain readable even when the local Git repository is temporarily inconsistent.
  }

  return {
    taskId: state.taskId,
    workflowState: state.workflowState,
    branch: state.branch,
    baseRef: state.baseRef,
    baseCommit: state.baseCommit,
    implementationFingerprint: state.implementationFingerprint,
    currentFingerprint,
    approvedFingerprint: state.approvedFingerprint,
    approvalCurrent,
    development: state.development,
    audit: state.audit,
    delivery: state.delivery,
    stateFile: paths.state,
    eventsFile: paths.events,
    nextAction: nextActionForState(state, { approvalCurrent: approvalCurrent !== false }),
  };
}

function printStatus(snapshot) {
  const short = (value) => (value ? value.slice(0, 12) : "-");
  console.log(`Task:             ${snapshot.taskId}`);
  console.log(`Workflow state:   ${snapshot.workflowState.toUpperCase()}`);
  console.log(`Branch:           ${snapshot.branch}`);
  console.log(`Base:             ${snapshot.baseRef}@${short(snapshot.baseCommit)}`);
  console.log(`Implementation:   ${short(snapshot.implementationFingerprint)}`);
  console.log(`Approval current: ${snapshot.approvalCurrent === null ? "n/a" : snapshot.approvalCurrent ? "yes" : "NO - STALE"}`);
  console.log(`Developer attempt:${String(snapshot.development?.attempt ?? 0).padStart(4, " ")}`);
  console.log(`Developer report: ${snapshot.development?.report ?? "-"}`);
  console.log(`Audit round:      ${snapshot.audit?.round ?? 0}`);
  console.log(`Audit verdict:    ${snapshot.audit?.verdict ?? "-"}`);
  console.log(`Audit report:     ${snapshot.audit?.report ?? "-"}`);
  console.log(`Commit:           ${snapshot.delivery?.commit ?? "-"}`);
  console.log(`Pushed:           ${snapshot.delivery?.pushed ? "yes" : "no"}`);
  console.log(`Upstream:         ${snapshot.delivery?.upstream ?? "-"}`);
  console.log(`Merged:           ${snapshot.delivery?.merged ? "yes" : "no"}`);
  console.log(`\nNext action:\n  ${snapshot.nextAction}`);
}

const options = parseArgs(process.argv.slice(2));
const root = repositoryRoot();
process.chdir(root);
ensureTask(options.taskId);

const branch = currentBranch(root);
const guessedBaseRef = options.baseRef ?? "main";
const guessedBaseCommit = resolveGitRef(root, guessedBaseRef);
let loaded = readWorkflowState(root, options.taskId, {
  baseRef: guessedBaseRef,
  baseCommit: guessedBaseCommit,
  branch,
});

if (!loaded.exists && options.mark) {
  fail("no local workflow state exists; run scaflow-dev or scaflow-audit first");
}

if (loaded.exists && options.baseRef && options.mark !== "merged" && options.baseRef !== loaded.state.baseRef) {
  fail(`workflow uses base ${loaded.state.baseRef}; --base may only differ when marking merged`);
}

if (options.mark) {
  const state = markState(root, options.taskId, loaded, options.mark);
  loaded = { state, exists: true, paths: loaded.paths };
}

const snapshot = statusSnapshot(root, loaded.state, loaded.paths);
if (options.json) {
  console.log(JSON.stringify(snapshot, null, 2));
} else {
  printStatus(snapshot);
}
