import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

export const WORKFLOW_STATES = Object.freeze([
  "ready",
  "developing",
  "development_failed",
  "ready_for_audit",
  "auditing",
  "audit_failed",
  "audit_invalid",
  "changes_required",
  "blocked",
  "approved_with_follow_ups",
  "approved",
  "committed",
  "pushed",
  "merged",
]);

const TRANSITIONS = Object.freeze({
  ready: ["developing", "ready_for_audit"],
  developing: ["ready_for_audit", "development_failed"],
  development_failed: ["developing"],
  ready_for_audit: ["auditing", "developing", "audit_invalid"],
  auditing: [
    "approved",
    "approved_with_follow_ups",
    "changes_required",
    "blocked",
    "audit_failed",
    "audit_invalid",
  ],
  audit_failed: ["auditing", "developing", "audit_invalid"],
  audit_invalid: ["developing"],
  changes_required: ["developing"],
  blocked: ["developing"],
  approved_with_follow_ups: ["developing", "committed"],
  approved: ["developing", "committed"],
  committed: ["pushed"],
  pushed: ["merged"],
  merged: [],
});

function now() {
  return new Date().toISOString();
}

function runGit(root, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) {
    throw new Error(`git ${args.join(" ")} failed to start: ${result.error.message}`);
  }
  if (!allowFailure && result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}

function deepMerge(target, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const output = { ...(target ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function hashPath(hash, path, relativePath) {
  if (!existsSync(path)) {
    hash.update(`missing:${relativePath}\0`);
    return;
  }

  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    hash.update(`symlink:${relativePath}:${readlinkSync(path)}\0`);
    return;
  }

  if (stats.isDirectory()) {
    hash.update(`dir:${relativePath}\0`);
    for (const child of readdirSync(path).sort()) {
      hashPath(hash, join(path, child), join(relativePath, child));
    }
    return;
  }

  const mode = stats.mode & 0o111 ? "100755" : "100644";
  hash.update(`file:${relativePath}:${mode}:${stats.size}\0`);
  hash.update(readFileSync(path));
}

function listTrackedFiles(root) {
  return runGit(root, ["ls-files", "-z"])
    .stdout.split("\0")
    .filter(Boolean)
    .sort();
}

function listBaseFiles(root, baseCommit) {
  return runGit(root, ["ls-tree", "-r", "--name-only", "-z", baseCommit])
    .stdout.split("\0")
    .filter(Boolean)
    .sort();
}

export function handoffPaths(root, taskId) {
  const directory = resolve(root, ".scaflow", "handoffs", taskId);
  return {
    directory,
    state: join(directory, "state.json"),
    events: join(directory, "events.jsonl"),
    developerReport: join(directory, "developer-report.md"),
    handoff: join(directory, "handoff.json"),
  };
}

export function createInitialState({ taskId, baseRef, baseCommit, branch }) {
  const timestamp = now();
  return {
    version: 1,
    taskId,
    workflowState: "ready",
    baseRef,
    baseCommit,
    branch,
    implementationFingerprint: null,
    approvedFingerprint: null,
    development: {
      attempt: 0,
      startedAt: null,
      finishedAt: null,
      report: null,
      imported: false,
      lastError: null,
    },
    audit: {
      round: 0,
      startedAt: null,
      finishedAt: null,
      verdict: null,
      report: null,
      lastError: null,
    },
    delivery: {
      commit: null,
      pushed: false,
      upstream: null,
      pullRequest: null,
      merged: false,
      mergedAt: null,
      mergeBaseRef: null,
      mergeBaseCommit: null,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function readWorkflowState(root, taskId, defaults) {
  const paths = handoffPaths(root, taskId);
  if (!existsSync(paths.state)) {
    return {
      state: createInitialState({ taskId, ...defaults }),
      exists: false,
      paths,
    };
  }
  const state = JSON.parse(readFileSync(paths.state, "utf8"));
  if (state.version !== 1 || state.taskId !== taskId || !WORKFLOW_STATES.includes(state.workflowState)) {
    throw new Error(`invalid workflow state file: ${paths.state}`);
  }
  return { state, exists: true, paths };
}

export function writeWorkflowState(paths, state) {
  mkdirSync(paths.directory, { recursive: true });
  const next = { ...state, updatedAt: now() };
  writeFileSync(paths.state, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function appendWorkflowEvent(paths, event) {
  mkdirSync(paths.directory, { recursive: true });
  appendFileSync(paths.events, `${JSON.stringify({ at: now(), ...event })}\n`, "utf8");
}

export function transitionWorkflowState({
  root,
  taskId,
  defaults,
  to,
  event,
  patch = {},
  metadata = {},
}) {
  const loaded = readWorkflowState(root, taskId, defaults);
  const from = loaded.state.workflowState;
  const allowed = TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`illegal workflow transition for ${taskId}: ${from} -> ${to}`);
  }
  const next = deepMerge(loaded.state, patch);
  next.workflowState = to;
  const written = writeWorkflowState(loaded.paths, next);
  appendWorkflowEvent(loaded.paths, {
    event,
    from,
    to,
    metadata,
  });
  return { state: written, paths: loaded.paths };
}

export function patchWorkflowState({ root, taskId, defaults, event, patch = {}, metadata = {} }) {
  const loaded = readWorkflowState(root, taskId, defaults);
  const next = writeWorkflowState(loaded.paths, deepMerge(loaded.state, patch));
  appendWorkflowEvent(loaded.paths, {
    event,
    from: loaded.state.workflowState,
    to: loaded.state.workflowState,
    metadata,
  });
  return { state: next, paths: loaded.paths };
}

export function resolveGitRef(root, ref) {
  return runGit(root, ["rev-parse", "--verify", `${ref}^{commit}`]).stdout.trim();
}

export function currentBranch(root) {
  return runGit(root, ["branch", "--show-current"]).stdout.trim() || "DETACHED_HEAD";
}

export function headCommit(root) {
  return runGit(root, ["rev-parse", "HEAD"]).stdout.trim();
}

export function workingTreeIsClean(root) {
  return runGit(root, ["status", "--porcelain=v1"]).stdout.trim().length === 0;
}

export function implementationHasChanges(root, baseCommit) {
  const tracked = runGit(root, ["diff", "--quiet", baseCommit, "--"], { allowFailure: true });
  if (tracked.status === 1) return true;
  if (tracked.status !== 0) {
    const detail = tracked.stderr?.trim() || tracked.stdout?.trim() || `exit ${tracked.status}`;
    throw new Error(`unable to compare implementation with ${baseCommit}: ${detail}`);
  }
  return listUntrackedFiles(root).length > 0;
}

export function listUntrackedFiles(root) {
  return runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    .stdout.split("\0")
    .filter(Boolean)
    .sort();
}

export function implementationFingerprint(root, baseCommit) {
  const hash = createHash("sha256");
  hash.update(`base:${baseCommit}\0`);

  // Hash the resulting implementation snapshot rather than a patch encoding.
  // Include base paths so committed deletions remain represented as missing files.
  // This keeps the fingerprint stable across untracked, staged, and committed states.
  const files = [
    ...new Set([
      ...listBaseFiles(root, baseCommit),
      ...listTrackedFiles(root),
      ...listUntrackedFiles(root),
    ]),
  ].sort();
  for (const path of files) {
    hashPath(hash, resolve(root, path), path);
  }

  return `sha256:${hash.digest("hex")}`;
}

export function parseAuditVerdict(report) {
  const matches = [...report.matchAll(/^\s*(?:VERDICT\s*:\s*)?(APPROVED_WITH_FOLLOW_UPS|APPROVED|CHANGES_REQUIRED|BLOCKED)\s*$/gim)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1].toUpperCase();
}

export function workflowStateForVerdict(verdict) {
  return {
    APPROVED: "approved",
    APPROVED_WITH_FOLLOW_UPS: "approved_with_follow_ups",
    CHANGES_REQUIRED: "changes_required",
    BLOCKED: "blocked",
  }[verdict] ?? null;
}

export function nextActionForState(state, { approvalCurrent = true } = {}) {
  if ((state.workflowState === "approved" || state.workflowState === "approved_with_follow_ups") && !approvalCurrent) {
    return `Implementation changed after approval. Run: pnpm scaflow-dev ${state.taskId} --base ${state.baseRef} --resume`;
  }
  switch (state.workflowState) {
    case "ready":
      return `Run: pnpm scaflow-dev ${state.taskId} --base ${state.baseRef}`;
    case "developing":
      return "Developer session is active. Do not start an audit.";
    case "development_failed":
    case "changes_required":
    case "blocked":
    case "audit_invalid":
      return `Run: pnpm scaflow-dev ${state.taskId} --base ${state.baseRef} --resume`;
    case "ready_for_audit":
    case "audit_failed":
      return `Freeze changes, then run: pnpm scaflow-audit ${state.taskId} --base ${state.baseRef}`;
    case "auditing":
      return "Audit is active. Freeze all code changes.";
    case "approved":
    case "approved_with_follow_ups":
      return `Review the audit report, commit the implementation, then run: pnpm scaflow-status ${state.taskId} --mark committed`;
    case "committed":
      return `Push the branch, then run: pnpm scaflow-status ${state.taskId} --mark pushed`;
    case "pushed":
      return `After merge and updating the target base ref, run: pnpm scaflow-status ${state.taskId} --base origin/main --mark merged`;
    case "merged":
      return "Local workflow is complete. The shared Task may now be updated to definition_state: completed.";
    default:
      return "Inspect the workflow state and event log.";
  }
}

export function verifyCommitPushed(root, commit) {
  const upstreamResult = runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    allowFailure: true,
  });
  if (upstreamResult.status !== 0) {
    throw new Error("current branch has no upstream; push with -u before marking pushed");
  }
  const upstream = upstreamResult.stdout.trim();
  const ancestor = runGit(root, ["merge-base", "--is-ancestor", commit, upstream], { allowFailure: true });
  if (ancestor.status !== 0) {
    throw new Error(`commit ${commit.slice(0, 12)} is not present in upstream ${upstream}`);
  }
  return upstream;
}

export function verifyCommitMerged(root, commit, baseRef) {
  const result = runGit(root, ["merge-base", "--is-ancestor", commit, baseRef], { allowFailure: true });
  if (result.status !== 0) {
    throw new Error(`commit ${commit.slice(0, 12)} is not contained in ${baseRef}; fetch/update the base ref first`);
  }
}
