import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
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

function isTrustedHistoricalBatch(batchDirectory) {
  const statePath = join(batchDirectory, "state.json");
  if (!existsSync(statePath)) return false;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    return state.status === "completed" && state.pushEnabled === true;
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
    if (!isTrustedHistoricalBatch(batchDirectory)) continue;
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
