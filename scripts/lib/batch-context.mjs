import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function copyDirectoryEntries(source, target) {
  if (!existsSync(source)) return;
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    cpSync(join(source, entry.name), join(target, entry.name), {
      recursive: entry.isDirectory(),
      force: true,
    });
  }
}

function commitIsOnTarget(root, commit, remote, target) {
  if (typeof commit !== "string" || !commit) return false;
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", commit, `${remote}/${target}`],
    { cwd: root, encoding: "utf8", stdio: "pipe" },
  );
  return result.status === 0;
}

function isTrustedHistoricalBatch(root, batchDirectory) {
  const statePath = join(batchDirectory, "state.json");
  if (!existsSync(statePath)) return false;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (state.status !== "completed") return false;
    if (state.pushEnabled === false) return false;
    if (state.pushEnabled === true) return true;

    if (typeof state.remote !== "string" || typeof state.target !== "string") return false;
    const completedTasks = Array.isArray(state.tasks)
      ? state.tasks.filter((task) => task.status === "completed")
      : [];
    if (completedTasks.length === 0) return false;
    return completedTasks.every((task) =>
      commitIsOnTarget(root, task.commit, state.remote, state.target),
    );
  } catch {
    return false;
  }
}

export function hydrateHistoricalCompletionContext({ root, currentBatchId, targetDirectory }) {
  const batchesDirectory = join(root, ".scaflow", "batches");
  if (!existsSync(batchesDirectory)) return [];

  const imported = new Set();
  const batches = readdirSync(batchesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== currentBatchId)
    .map((entry) => entry.name)
    .sort();

  for (const batchId of batches) {
    const batchDirectory = join(batchesDirectory, batchId);
    if (!isTrustedHistoricalBatch(root, batchDirectory)) continue;
    const source = join(batchDirectory, "context", "completions");
    if (!existsSync(source)) continue;
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (!entry.isFile() || !/^SFL-\d{3}\.(?:md|json)$/.test(entry.name)) continue;
      mkdirSync(targetDirectory, { recursive: true });
      cpSync(join(source, entry.name), join(targetDirectory, entry.name), { force: true });
      imported.add(entry.name.replace(/\.(?:md|json)$/, ""));
    }
  }

  return [...imported].sort();
}

export function installCompletionContext(sourceDirectory, taskWorktree) {
  if (!existsSync(sourceDirectory) || readdirSync(sourceDirectory).length === 0) return;
  const target = join(taskWorktree, ".scaflow", "context", "completions");
  copyDirectoryEntries(sourceDirectory, target);
}

export function captureCompletionContext({ sourceHandoffDirectory, targetDirectory, taskId }) {
  const sourceDirectory = join(sourceHandoffDirectory, "architect");
  const markdown = join(sourceDirectory, "completion.md");
  const json = join(sourceDirectory, "completion.json");
  if (!existsSync(markdown) || !existsSync(json)) {
    throw new Error(`${taskId} has no validated Architect completion summary`);
  }

  mkdirSync(targetDirectory, { recursive: true });
  cpSync(markdown, join(targetDirectory, `${taskId}.md`), { force: true });
  cpSync(json, join(targetDirectory, `${taskId}.json`), { force: true });
}
