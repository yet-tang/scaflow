import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  captureCompletionContext,
  hydrateHistoricalCompletionContext,
  installCompletionContext,
} from "./batch-context.mjs";

function writeBatchState(batchDirectory, overrides = {}) {
  mkdirSync(batchDirectory, { recursive: true });
  writeFileSync(
    join(batchDirectory, "state.json"),
    `${JSON.stringify({ status: "completed", pushEnabled: true, ...overrides })}\n`,
    "utf8",
  );
}

test("captures and installs validated completion summaries", () => {
  const root = mkdtempSync(join(tmpdir(), "scaflow-context-"));
  const handoff = join(root, "handoff");
  const architect = join(handoff, "architect");
  const store = join(root, "store");
  const worktree = join(root, "worktree");
  mkdirSync(architect, { recursive: true });
  writeFileSync(join(architect, "completion.md"), "# Complete\n", "utf8");
  writeFileSync(join(architect, "completion.json"), "{\"decision\":\"COMPLETE\"}\n", "utf8");

  captureCompletionContext({
    sourceHandoffDirectory: handoff,
    targetDirectory: store,
    taskId: "SFL-002",
  });
  installCompletionContext(store, worktree);

  const installed = join(worktree, ".scaflow", "context", "completions", "SFL-002.md");
  assert.equal(existsSync(installed), true);
  assert.equal(readFileSync(installed, "utf8"), "# Complete\n");
});

test("hydrates the latest pushed historical completion context", () => {
  const root = mkdtempSync(join(tmpdir(), "scaflow-context-"));
  const olderBatch = join(root, ".scaflow", "batches", "20260101T000000Z");
  const newerBatch = join(root, ".scaflow", "batches", "20260201T000000Z");
  const older = join(olderBatch, "context", "completions");
  const newer = join(newerBatch, "context", "completions");
  const target = join(root, ".scaflow", "batches", "20260301T000000Z", "context", "completions");
  mkdirSync(older, { recursive: true });
  mkdirSync(newer, { recursive: true });
  writeBatchState(olderBatch);
  writeBatchState(newerBatch);
  writeFileSync(join(older, "SFL-002.md"), "old\n", "utf8");
  writeFileSync(join(newer, "SFL-002.md"), "new\n", "utf8");
  writeFileSync(join(newer, "SFL-003.md"), "three\n", "utf8");

  const imported = hydrateHistoricalCompletionContext({
    root,
    currentBatchId: "20260301T000000Z",
    targetDirectory: target,
  });

  assert.deepEqual(imported, ["SFL-002", "SFL-003"]);
  assert.equal(readFileSync(join(target, "SFL-002.md"), "utf8"), "new\n");
  assert.equal(readFileSync(join(target, "SFL-003.md"), "utf8"), "three\n");
});

test("ignores failed and unpushed historical batches", () => {
  const root = mkdtempSync(join(tmpdir(), "scaflow-context-"));
  const failedBatch = join(root, ".scaflow", "batches", "20260101T000000Z");
  const localBatch = join(root, ".scaflow", "batches", "20260201T000000Z");
  for (const [batch, state] of [
    [failedBatch, { status: "failed", pushEnabled: true }],
    [localBatch, { status: "completed", pushEnabled: false }],
  ]) {
    const context = join(batch, "context", "completions");
    mkdirSync(context, { recursive: true });
    writeBatchState(batch, state);
    writeFileSync(join(context, "SFL-002.md"), "untrusted\n", "utf8");
  }

  const target = join(root, ".scaflow", "batches", "20260301T000000Z", "context", "completions");
  const imported = hydrateHistoricalCompletionContext({
    root,
    currentBatchId: "20260301T000000Z",
    targetDirectory: target,
  });

  assert.deepEqual(imported, []);
  assert.equal(existsSync(join(target, "SFL-002.md")), false);
});

test("rejects missing completion evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "scaflow-context-"));
  assert.throws(
    () =>
      captureCompletionContext({
        sourceHandoffDirectory: root,
        targetDirectory: join(root, "store"),
        taskId: "SFL-002",
      }),
    /no validated Architect completion summary/,
  );
});
