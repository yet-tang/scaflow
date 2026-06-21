import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);
const commitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const repositoryAccessSchema = z.enum(["read-only", "read-write"]);

const controlRepositoryIdSchema = z.literal("@control");
const applicationRepositoryIdSchema = nonEmptyStringSchema.refine(
  (id) => !id.startsWith("@"),
  "Application repository ID may not start with @",
);

const checkoutDirectorySchema = nonEmptyStringSchema.refine(
  (directory) => !directory.replaceAll("\\", "/").split("/").includes(".."),
  "Checkout directory may not contain path traversal",
);

const revisionSetIdentitySchema = z.strictObject({
  remote: nonEmptyStringSchema,
  expected_url: nonEmptyStringSchema,
  actual_url: nonEmptyStringSchema,
});

export const revisionSetApplicationRepositorySchema = z.strictObject({
  id: applicationRepositoryIdSchema,
  base_commit: commitShaSchema,
  access: repositoryAccessSchema,
  default_branch: nonEmptyStringSchema,
  checkout_directory: checkoutDirectorySchema,
  identity: revisionSetIdentitySchema,
});

export const revisionSetControlRepositorySchema =
  revisionSetApplicationRepositorySchema.extend({
    id: controlRepositoryIdSchema,
  });

export const revisionSetSchema = z
  .strictObject({
    version: z.literal(1),
    control: revisionSetControlRepositorySchema,
    repositories: z.array(revisionSetApplicationRepositorySchema),
  })
  .superRefine((revisionSet, context) => {
    const repositoryIds = new Set<string>();
    revisionSet.repositories.forEach((repository, index) => {
      if (repositoryIds.has(repository.id)) {
        context.addIssue({
          code: "custom",
          path: ["repositories", index, "id"],
          message: `Repository ID duplicates an earlier Revision Set entry`,
        });
      }
      repositoryIds.add(repository.id);
    });
  });

export type RevisionSetIdentity = z.infer<typeof revisionSetIdentitySchema>;
export type RevisionSetApplicationRepository = z.infer<
  typeof revisionSetApplicationRepositorySchema
>;
export type RevisionSetControlRepository = z.infer<
  typeof revisionSetControlRepositorySchema
>;
export type RevisionSet = z.infer<typeof revisionSetSchema>;
