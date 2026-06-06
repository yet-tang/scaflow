export function parseTaskContract(content, source = "contract.yaml") {
  const id = /^  id:\s*(SFL-\d{3})\s*$/m.exec(content)?.[1];
  const title = /^  title:\s*(.+?)\s*$/m.exec(content)?.[1];
  const definitionState = /^  definition_state:\s*([a-z_]+)\s*$/m.exec(content)?.[1];
  if (!id || !title || !definitionState) {
    throw new Error(`unable to parse task metadata from ${source}`);
  }

  const dependencies = [];
  const lines = content.split(/\r?\n/);
  const dependencyIndex = lines.findIndex((line) => /^dependencies:\s*/.test(line));
  if (dependencyIndex >= 0 && !/^dependencies:\s*\[\s*\]\s*$/.test(lines[dependencyIndex])) {
    for (let index = dependencyIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^[^\s]/.test(line) && line.trim().length > 0) break;
      const match = /^\s+-\s+(SFL-\d{3})\s*$/.exec(line);
      if (match) dependencies.push(match[1]);
    }
  }

  return { id, title, definitionState, dependencies, source };
}

function formatTaskId(number) {
  if (!Number.isInteger(number) || number < 1 || number > 999) {
    throw new Error(`task number must be between 1 and 999: ${number}`);
  }
  return `SFL-${String(number).padStart(3, "0")}`;
}

function parseTaskNumber(value) {
  const match = /^(?:SFL-)?(\d{1,3})$/i.exec(value.trim());
  if (!match) throw new Error(`invalid task selector item: ${value}`);
  return Number(match[1]);
}

export function parseTaskSelection(selector) {
  const value = selector.trim();
  if (!value) throw new Error("task selector is required");

  const rangeMatch = /^(?:SFL-)?(\d{1,3})\s*(?:-|\.\.)\s*(?:SFL-)?(\d{1,3})$/i.exec(value);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    if (start > end) throw new Error(`task range must be ascending: ${selector}`);
    return Array.from({ length: end - start + 1 }, (_, index) => formatTaskId(start + index));
  }

  return [...new Set(value.split(",").map(parseTaskNumber).map(formatTaskId))].sort();
}

export function topologicalTaskOrder(contracts, selectedIds) {
  const byId = new Map(contracts.map((contract) => [contract.id, contract]));
  const selected = new Set(selectedIds);
  const indegree = new Map();
  const outgoing = new Map();

  for (const taskId of selected) {
    if (!byId.has(taskId)) throw new Error(`Task Contract not found for ${taskId}`);
    indegree.set(taskId, 0);
    outgoing.set(taskId, []);
  }

  for (const taskId of selected) {
    const contract = byId.get(taskId);
    for (const dependencyId of contract.dependencies) {
      const dependency = byId.get(dependencyId);
      if (!dependency) throw new Error(`${taskId} depends on missing task ${dependencyId}`);
      if (selected.has(dependencyId)) {
        indegree.set(taskId, indegree.get(taskId) + 1);
        outgoing.get(dependencyId).push(taskId);
      } else if (dependency.definitionState !== "completed") {
        throw new Error(`${taskId} depends on ${dependencyId}, which is not completed`);
      }
    }
  }

  const ready = [...selected].filter((taskId) => indegree.get(taskId) === 0).sort();
  const ordered = [];
  while (ready.length > 0) {
    const taskId = ready.shift();
    ordered.push(taskId);
    for (const dependent of outgoing.get(taskId).sort()) {
      const next = indegree.get(dependent) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  if (ordered.length !== selected.size) throw new Error("Task dependency cycle detected");
  return ordered;
}

export function slugifyTaskTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task";
}
