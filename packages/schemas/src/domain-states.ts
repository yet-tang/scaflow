import { z } from "zod";

export const taskDefinitionStates = Object.freeze([
  "draft",
  "ready",
  "cancelled",
  "completed",
] as const);

export const taskRunStates = Object.freeze([
  "queued",
  "preparing",
  "running",
  "verifying",
  "repairing",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "orphaned",
] as const);

export const changeSetStates = Object.freeze([
  "draft",
  "verified",
  "published",
  "partially_merged",
  "merged",
  "failed",
  "cancelled",
  "rolled_back",
] as const);

export const taskDefinitionStateSchema = z.enum(taskDefinitionStates);
export const taskRunStateSchema = z.enum(taskRunStates);
export const changeSetStateSchema = z.enum(changeSetStates);

export type TaskDefinitionState = z.infer<
  typeof taskDefinitionStateSchema
>;
export type TaskRunState = z.infer<typeof taskRunStateSchema>;
export type ChangeSetState = z.infer<typeof changeSetStateSchema>;
