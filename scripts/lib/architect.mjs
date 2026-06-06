import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ARCHITECT_PHASES = Object.freeze({
  PREPARATION: "preparation",
  POST_DEVELOPMENT: "post_development",
  REPAIR: "repair",
  COMPLETION: "completion",
});

const DECISIONS = Object.freeze({
  preparation: new Set(["READY_FOR_DEVELOPMENT", "BLOCKED"]),
  post_development: new Set(["READY_FOR_AUDIT", "REPAIR_REQUIRED", "BLOCKED"]),
  repair: new Set(["READY_FOR_REPAIR", "BLOCKED"]),
  completion: new Set(["COMPLETE"]),
});

const REQUIRED_ARRAYS = [
  "guidance",
  "mustPreserve",
  "risks",
  "auditFocus",
  "blockingIssues",
];

export function parseArchitectDecision(content, { taskId, phase }) {
  let value;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`architect output is not valid JSON: ${error.message}`);
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("architect output must be one JSON object");
  }
  if (value.version !== 1) throw new Error("architect output version must be 1");
  if (value.taskId !== taskId) {
    throw new Error(`architect taskId mismatch: expected ${taskId}, found ${value.taskId}`);
  }
  if (value.phase !== phase) {
    throw new Error(`architect phase mismatch: expected ${phase}, found ${value.phase}`);
  }
  if (!DECISIONS[phase]?.has(value.decision)) {
    throw new Error(`architect decision ${value.decision} is not allowed for phase ${phase}`);
  }
  if (typeof value.summary !== "string" || value.summary.trim().length === 0) {
    throw new Error("architect summary must be a non-empty string");
  }
  for (const field of REQUIRED_ARRAYS) {
    if (!Array.isArray(value[field]) || value[field].some((item) => typeof item !== "string")) {
      throw new Error(`architect field ${field} must be an array of strings`);
    }
  }
  if (value.decision === "BLOCKED" && value.blockingIssues.length === 0) {
    throw new Error("BLOCKED architect decision requires at least one blocking issue");
  }

  return {
    version: 1,
    taskId,
    phase,
    decision: value.decision,
    summary: value.summary.trim(),
    guidance: value.guidance,
    mustPreserve: value.mustPreserve,
    risks: value.risks,
    auditFocus: value.auditFocus,
    blockingIssues: value.blockingIssues,
  };
}

export function architectArtifactPaths(handoffDirectory, taskId, phase, sequence = 1) {
  const directory = join(handoffDirectory, "architect");
  const stem = phase === ARCHITECT_PHASES.PREPARATION
    ? "preparation"
    : phase === ARCHITECT_PHASES.POST_DEVELOPMENT
      ? `post-development-attempt-${sequence}`
      : phase === ARCHITECT_PHASES.REPAIR
        ? `repair-round-${sequence}`
        : "completion";
  return {
    directory,
    json: join(directory, `${stem}.json`),
    markdown: join(directory, `${stem}.md`),
    relativeJson: join(".scaflow", "handoffs", taskId, "architect", `${stem}.json`),
    relativeMarkdown: join(".scaflow", "handoffs", taskId, "architect", `${stem}.md`),
  };
}

function section(title, items) {
  const body = items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None";
  return `## ${title}\n\n${body}`;
}

export function renderArchitectMarkdown(decision) {
  return [
    `# Architect ${decision.phase}: ${decision.taskId}`,
    "",
    `**Decision:** ${decision.decision}`,
    "",
    decision.summary,
    "",
    section("Guidance", decision.guidance),
    "",
    section("Must preserve", decision.mustPreserve),
    "",
    section("Risks", decision.risks),
    "",
    section("Audit focus", decision.auditFocus),
    "",
    section("Blocking issues", decision.blockingIssues),
    "",
  ].join("\n");
}

export function writeArchitectArtifacts(paths, decision) {
  mkdirSync(paths.directory, { recursive: true });
  writeFileSync(paths.json, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
  writeFileSync(paths.markdown, renderArchitectMarkdown(decision), "utf8");
}

export function readArchitectDecision(path, expected) {
  if (!existsSync(path)) return null;
  return parseArchitectDecision(readFileSync(path, "utf8"), expected);
}

export function buildArchitectPrompt({
  taskId,
  phase,
  baseRef,
  baseCommit,
  branch,
  contractPath,
  planPath,
  workflowState,
  developerReportPath,
  latestAuditReportPath,
  preparationPath,
  postDevelopmentPath,
}) {
  const evidence = [
    `- Task Contract: ${contractPath}`,
    planPath ? `- Task plan: ${planPath}` : "- Task plan: not present",
    `- Frozen base: ${baseRef}@${baseCommit}`,
    `- Task branch: ${branch}`,
    `- Current workflow state: ${workflowState}`,
    "- Prior task completion summaries when available: .scaflow/context/completions/",
    developerReportPath ? `- Developer report: ${developerReportPath}` : "- Developer report: not present",
    latestAuditReportPath ? `- Latest audit report: ${latestAuditReportPath}` : "- Latest audit report: not present",
    preparationPath ? `- Preparation brief: ${preparationPath}` : "- Preparation brief: not present",
    postDevelopmentPath ? `- Latest post-development review: ${postDevelopmentPath}` : "- Latest post-development review: not present",
  ].join("\n");

  return `Use the scaflow-architect custom agent and the scaflow-architecture Skill.\n\nPerform the ${phase} phase for ${taskId}.\n\nEvidence:\n${evidence}\n\nInspect the actual repository state and all phase-relevant files. Follow docs/architecture/scaflow-architect-workflow.md. Return exactly one JSON object with no Markdown or commentary. The JSON must contain version, taskId, phase, decision, summary, guidance, mustPreserve, risks, auditFocus, and blockingIssues. Do not modify any file or invoke any control-plane, delivery, or source-write command.`;
}
