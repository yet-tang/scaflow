import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);
const identifierSchema = nonEmptyStringSchema.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const relativeArtifactPathSchema = nonEmptyStringSchema.superRefine((value, context) => {
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    context.addIssue({
      code: "custom",
      message: "Artifact path must be a normalized relative POSIX path without traversal",
    });
  }
});

export const verificationFailureCategories = Object.freeze([
  "policy",
  "execution",
  "evidence",
  "schema",
  "infrastructure",
  "verifier",
] as const);
export const verificationRepairabilities = Object.freeze([
  "repairable",
  "non_repairable",
  "unknown",
] as const);
export const verifierResultStatuses = Object.freeze([
  "passed",
  "failed",
  "skipped",
] as const);
export const verificationResultStatuses = Object.freeze([
  "passed",
  "failed",
] as const);
export const verificationRunStatuses = Object.freeze([
  "running",
  "passed",
  "failed",
] as const);

export const verificationArtifactReferenceSchema = z.strictObject({
  id: identifierSchema,
  path: relativeArtifactPathSchema,
  media_type: nonEmptyStringSchema,
  byte_length: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const verificationFailureSchema = z.strictObject({
  code: identifierSchema,
  category: z.enum(verificationFailureCategories),
  repairability: z.enum(verificationRepairabilities),
  message: nonEmptyStringSchema,
  details: z.record(z.string(), z.json()).optional(),
});

export const verifierResultSchema = z
  .strictObject({
    verifier_id: identifierSchema,
    status: z.enum(verifierResultStatuses),
    summary: nonEmptyStringSchema,
    failures: z.array(verificationFailureSchema),
    artifacts: z.array(verificationArtifactReferenceSchema),
  })
  .superRefine((result, context) => {
    if (result.status === "failed" && result.failures.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["failures"],
        message: "A failed verifier result must include at least one failure",
      });
    }
    if (result.status !== "failed" && result.failures.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["failures"],
        message: "Only a failed verifier result may include failures",
      });
    }
  });

export const verificationResultSchema = z
  .strictObject({
    status: z.enum(verificationResultStatuses),
    verifier_results: z.array(verifierResultSchema).min(1),
    artifacts: z.array(verificationArtifactReferenceSchema),
    failures: z.array(verificationFailureSchema),
  })
  .superRefine((result, context) => {
    const verifierIds = new Set<string>();
    for (const [index, verifierResult] of result.verifier_results.entries()) {
      if (verifierIds.has(verifierResult.verifier_id)) {
        context.addIssue({
          code: "custom",
          path: ["verifier_results", index, "verifier_id"],
          message: "Verifier result IDs must be unique",
        });
      }
      verifierIds.add(verifierResult.verifier_id);
    }

    const expectedStatus = result.verifier_results.some(({ status }) => status === "failed")
      ? "failed"
      : "passed";
    if (result.status !== expectedStatus) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: `Aggregate status must be ${expectedStatus} for the verifier results`,
      });
    }

    const expectedFailures = result.verifier_results.flatMap(({ failures }) => failures);
    const expectedArtifacts = result.verifier_results.flatMap(({ artifacts }) => artifacts);
    if (JSON.stringify(result.failures) !== JSON.stringify(expectedFailures)) {
      context.addIssue({
        code: "custom",
        path: ["failures"],
        message: "Aggregate failures must equal the ordered verifier failures",
      });
    }
    if (JSON.stringify(result.artifacts) !== JSON.stringify(expectedArtifacts)) {
      context.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "Aggregate artifacts must equal the ordered verifier artifacts",
      });
    }
  });

export const verificationRunSchema = z
  .strictObject({
    version: z.literal(1),
    id: identifierSchema,
    task_run_id: identifierSchema,
    status: z.enum(verificationRunStatuses),
    started_at: z.iso.datetime({ offset: true }),
    completed_at: z.iso.datetime({ offset: true }).nullable(),
    result: verificationResultSchema.nullable(),
    artifacts: z.array(verificationArtifactReferenceSchema),
    failures: z.array(verificationFailureSchema),
  })
  .superRefine((run, context) => {
    if (run.status === "running") {
      if (run.completed_at !== null || run.result !== null || run.artifacts.length > 0 || run.failures.length > 0) {
        context.addIssue({
          code: "custom",
          message: "A running verification run cannot contain terminal result data",
        });
      }
      return;
    }

    if (run.completed_at === null || run.result === null) {
      context.addIssue({
        code: "custom",
        message: "A terminal verification run requires a completion timestamp and result",
      });
      return;
    }
    if (run.result.status !== run.status) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Verification run status must match its result status",
      });
    }
    if (Date.parse(run.completed_at) < Date.parse(run.started_at)) {
      context.addIssue({
        code: "custom",
        path: ["completed_at"],
        message: "Completion timestamp cannot precede start timestamp",
      });
    }
    if (JSON.stringify(run.artifacts) !== JSON.stringify(run.result.artifacts)) {
      context.addIssue({ code: "custom", path: ["artifacts"], message: "Run artifacts must match result artifacts" });
    }
    if (JSON.stringify(run.failures) !== JSON.stringify(run.result.failures)) {
      context.addIssue({ code: "custom", path: ["failures"], message: "Run failures must match result failures" });
    }
  });

export type VerificationFailureCategory = (typeof verificationFailureCategories)[number];
export type VerificationRepairability = (typeof verificationRepairabilities)[number];
export type VerifierResultStatus = (typeof verifierResultStatuses)[number];
export type VerificationResultStatus = (typeof verificationResultStatuses)[number];
export type VerificationRunStatus = (typeof verificationRunStatuses)[number];
export type VerificationArtifactReference = z.infer<typeof verificationArtifactReferenceSchema>;
export type VerificationFailure = z.infer<typeof verificationFailureSchema>;
export type VerifierResult = z.infer<typeof verifierResultSchema>;
export type VerificationResult = z.infer<typeof verificationResultSchema>;
export type VerificationRun = z.infer<typeof verificationRunSchema>;
