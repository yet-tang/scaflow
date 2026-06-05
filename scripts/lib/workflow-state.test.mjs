import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  implementationFingerprint,
  implementationHasChanges,
  nextActionForState,
  parseAuditVerdict,
  readWorkflowState,
  transitionWorkflowState,
  workflowStateForVerdict,
} from "./workflow-state.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function defaults() {
  return {
    baseRef: "main",
    baseCommit: "a".repeat(40),
    branch: "SFL-999-test",
  };
}

test("initial state is ready and legal transitions append events", () => {
  const root = mkdtempSync(join(tmpdir(), "scaflow-workflow-"));
  const initial = readWorkflowState(root, "SFL-999", defaults());
  assert.equal(initial.exists, false);
  assert.equal(initial.state.workflowState, "ready");

  const developing = transitionWorkflowState({
    root,
    taskId: "SFL-999",
    defaults: defaults(),
    to: "developing",
    event: "DEVELOPMENT_STARTED",
  });
  assert.equal(developing.state.workflowState, "developing");

  const readyForAudit = transitionWorkflowState({
    root,
    taskId: "SFL-999",
    defaults: defaults(),
    to: "ready_for_audit",
    event: "DEVELOPMENT_FINISHED",
  });
  assert.equal(readyForAudit.state.workflowState, "ready_for_audit");

  const events = readFileSync(readyForAudit.paths.events, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => [event.from, event.to, event.event]),
    [
      ["ready", "developing", "DEVELOPMENT_STARTED"],
      ["developing", "ready_for_audit", "DEVELOPMENT_FINISHED"],
    ],
  );
});

test("illegal transitions are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "scaflow-workflow-"));
  assert.throws(
    () =>
      transitionWorkflowState({
        root,
        taskId: "SFL-999",
        defaults: defaults(),
        to: "approved",
        event: "INVALID",
      }),
    /illegal workflow transition/,
  );
});

test("audit verdict parser uses the final standalone verdict", () => {
  const report = `Finding text\nAPPROVED_WITH_FOLLOW_UPS\nMore discussion\nVERDICT: CHANGES_REQUIRED\n`;
  assert.equal(parseAuditVerdict(report), "CHANGES_REQUIRED");
  assert.equal(workflowStateForVerdict("APPROVED"), "approved");
  assert.equal(workflowStateForVerdict("APPROVED_WITH_FOLLOW_UPS"), "approved_with_follow_ups");
  assert.equal(workflowStateForVerdict("CHANGES_REQUIRED"), "changes_required");
  assert.equal(workflowStateForVerdict("BLOCKED"), "blocked");
});

test("approved state reports stale approval when implementation changes", () => {
  const action = nextActionForState(
    {
      taskId: "SFL-999",
      baseRef: "main",
      workflowState: "approved",
    },
    { approvalCurrent: false },
  );
  assert.match(action, /Implementation changed after approval/);
  assert.match(action, /--resume/);
});

test("implementation fingerprint covers tracked and untracked changes", () => {
  const root = mkdtempSync(join(tmpdir(), "scaflow-git-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Scaflow Test"]);
  writeFileSync(join(root, "tracked.txt"), "base\n", "utf8");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-m", "base"]);
  const baseCommit = git(root, ["rev-parse", "HEAD"]);

  assert.equal(implementationHasChanges(root, baseCommit), false);
  const cleanFingerprint = implementationFingerprint(root, baseCommit);

  writeFileSync(join(root, "tracked.txt"), "changed\n", "utf8");
  assert.equal(implementationHasChanges(root, baseCommit), true);
  const trackedFingerprint = implementationFingerprint(root, baseCommit);
  assert.notEqual(trackedFingerprint, cleanFingerprint);

  writeFileSync(join(root, "untracked.txt"), "new\n", "utf8");
  const untrackedFingerprint = implementationFingerprint(root, baseCommit);
  assert.notEqual(untrackedFingerprint, trackedFingerprint);
});
