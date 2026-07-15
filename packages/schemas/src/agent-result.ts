import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);

export const agentResultStatuses = Object.freeze([
  "succeeded",
  "failed",
  "blocked",
] as const);

export const agentResultCommandSchema = z.strictObject({
  executable: nonEmptyStringSchema,
  args: z.array(z.string()),
  exit_code: z.number().int().nullable(),
});

export const agentResultAcceptanceMappingSchema = z.strictObject({
  acceptance_criterion_id: nonEmptyStringSchema,
  evidence: z.array(nonEmptyStringSchema),
  satisfied: z.boolean(),
});

export const agentResultDecisionRequestSchema = z.strictObject({
  question: nonEmptyStringSchema,
  context: nonEmptyStringSchema,
  options: z.array(nonEmptyStringSchema).min(1),
});

export const agentResultRiskSchema = z.strictObject({
  description: nonEmptyStringSchema,
  severity: z.enum(["low", "medium", "high", "critical"]),
});

export const agentResultSchema = z.strictObject({
  status: z.enum(agentResultStatuses),
  summary: nonEmptyStringSchema,
  changed_files: z.array(nonEmptyStringSchema),
  commands_run: z.array(agentResultCommandSchema),
  acceptance_mapping: z.array(agentResultAcceptanceMappingSchema),
  known_limitations: z.array(nonEmptyStringSchema),
  decision_requests: z.array(agentResultDecisionRequestSchema),
  risks_detected: z.array(agentResultRiskSchema),
});

export type AgentResultStatus = z.infer<typeof agentResultSchema>["status"];
export type AgentResultCommand = z.infer<typeof agentResultCommandSchema>;
export type AgentResultAcceptanceMapping = z.infer<
  typeof agentResultAcceptanceMappingSchema
>;
export type AgentResultDecisionRequest = z.infer<
  typeof agentResultDecisionRequestSchema
>;
export type AgentResultRisk = z.infer<typeof agentResultRiskSchema>;
export type AgentResult = z.infer<typeof agentResultSchema>;
