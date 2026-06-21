import { z } from "zod";

import { taskDefinitionStateSchema } from "./domain-states.js";

const nonEmptyStringSchema = z.string().trim().min(1);

const taskTypeSchema = z.enum([
  "foundation",
  "schema",
  "cli",
  "state",
  "git",
  "workspace",
  "runtime",
  "verification",
  "changeset",
  "integration",
  "control-plane-change",
]);

const riskLevelSchema = z.enum(["R1", "R2", "R3"]);

const dependencyChangesSchema = z.enum(["allowed", "forbidden"]);

const repositoryAccessSchema = z.enum(["read-only", "read-write"]);

const taskContractRepositoryIdSchema = nonEmptyStringSchema.refine(
  (repository) => !repository.startsWith("@") || repository === "@control",
  "Only @control may use a reserved @-prefixed repository ID",
);

const taskPathPatternSchema = nonEmptyStringSchema.refine(
  (path) => !path.replaceAll("\\", "/").split("/").includes(".."),
  "Path patterns may not contain traversal segments",
);

export const taskContractVerificationCommandSchema = z.strictObject({
  repository: taskContractRepositoryIdSchema,
  executable: nonEmptyStringSchema,
  args: z.array(z.string()),
  timeout_seconds: z.number().int().positive(),
  required: z.boolean(),
});

export const taskContractRepositoryScopeSchema = z
  .strictObject({
    repository: taskContractRepositoryIdSchema,
    access: repositoryAccessSchema,
    allowed_paths: z.array(taskPathPatternSchema).optional().default([]),
    forbidden_paths: z.array(taskPathPatternSchema).optional().default([]),
  })
  .superRefine((scope, context) => {
    if (scope.access === "read-write" && scope.allowed_paths.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["allowed_paths"],
        message: "Read-write scopes must include at least one allowed path",
      });
    }
  });

export const taskContractSchema = z
  .strictObject({
    version: z.literal(1),
    task: z.strictObject({
      id: nonEmptyStringSchema,
      title: nonEmptyStringSchema,
      type: taskTypeSchema,
      risk_level: riskLevelSchema,
      definition_state: taskDefinitionStateSchema,
    }),
    objective: z.strictObject({
      summary: nonEmptyStringSchema,
    }),
    source_requirements: z.array(
      z.strictObject({
        id: nonEmptyStringSchema,
        document: nonEmptyStringSchema,
      }),
    ),
    source_references: z
      .array(
        z.strictObject({
          document: nonEmptyStringSchema,
          section: nonEmptyStringSchema.optional(),
        }),
      )
      .optional(),
    dependencies: z.array(nonEmptyStringSchema),
    dependency_changes: dependencyChangesSchema,
    repositories: z.strictObject({
      primary: taskContractRepositoryIdSchema,
      scopes: z.array(taskContractRepositoryScopeSchema).min(1),
    }),
    acceptance_criteria: z
      .array(
        z.strictObject({
          id: nonEmptyStringSchema,
          description: nonEmptyStringSchema,
        }),
      )
      .min(1),
    verification: z.strictObject({
      commands: z.array(taskContractVerificationCommandSchema).min(1),
    }),
    retry_policy: z.strictObject({
      max_attempts: z.number().int().positive(),
      max_repair_rounds_per_attempt: z.number().int().nonnegative(),
      escalate_after_same_failure: z.number().int().positive(),
    }),
  })
  .superRefine((contract, context) => {
    const declaredRepositories = new Set(
      contract.repositories.scopes.map((scope) => scope.repository),
    );

    if (!declaredRepositories.has(contract.repositories.primary)) {
      context.addIssue({
        code: "custom",
        path: ["repositories", "primary"],
        message: "Primary repository must be declared in repository scopes",
      });
    }

    contract.verification.commands.forEach((command, index) => {
      if (!declaredRepositories.has(command.repository)) {
        context.addIssue({
          code: "custom",
          path: ["verification", "commands", index, "repository"],
          message:
            "Verification command repository must be declared in repository scopes",
        });
      }
    });
  });

export type TaskContractVerificationCommand = z.infer<
  typeof taskContractVerificationCommandSchema
>;
export type TaskContractRepositoryScope = z.infer<
  typeof taskContractRepositoryScopeSchema
>;
export type TaskContract = z.infer<typeof taskContractSchema>;
