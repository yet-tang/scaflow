import { posix } from "node:path";

import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);

const repositoryIdSchema = nonEmptyStringSchema.refine(
  (id) => !id.startsWith("@"),
  "Repository ID may not start with @",
);

const checkoutDirectorySchema = nonEmptyStringSchema.superRefine(
  (directory, context) => {
    const portablePath = directory.replaceAll("\\", "/");

    if (
      portablePath.startsWith("/") ||
      /^[a-zA-Z]:/.test(portablePath)
    ) {
      context.addIssue({
        code: "custom",
        message: "Checkout directory must be relative",
      });
    }

    if (portablePath.split("/").includes("..")) {
      context.addIssue({
        code: "custom",
        message: "Checkout directory may not contain path traversal",
      });
    }
  },
);

export const repositoryCommandSchema = z.strictObject({
  executable: nonEmptyStringSchema,
  args: z.array(z.string()),
  timeout_seconds: z.number().int().positive(),
  required: z.boolean(),
});

export const repositoryManifestEntrySchema = z.strictObject({
  id: repositoryIdSchema,
  name: nonEmptyStringSchema,
  git_url: nonEmptyStringSchema,
  default_branch: nonEmptyStringSchema,
  checkout_directory: checkoutDirectorySchema,
  type: nonEmptyStringSchema,
  dependencies: z.array(nonEmptyStringSchema).optional(),
  commands: z.array(repositoryCommandSchema).optional(),
});

export const repositoryManifestSchema = z
  .strictObject({
    version: z.literal(1),
    repositories: z.array(repositoryManifestEntrySchema).min(1),
  })
  .superRefine((manifest, context) => {
    const repositoryIndexes = new Map<string, number>();
    const checkoutIndexes = new Map<string, number>();

    manifest.repositories.forEach((repository, repositoryIndex) => {
      const duplicateRepositoryIndex = repositoryIndexes.get(repository.id);
      if (duplicateRepositoryIndex !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["repositories", repositoryIndex, "id"],
          message: `Repository ID duplicates repositories.${duplicateRepositoryIndex}.id`,
        });
      } else {
        repositoryIndexes.set(repository.id, repositoryIndex);
      }

      const normalizedCheckout = normalizeCheckoutDirectory(
        repository.checkout_directory,
      );
      const duplicateCheckoutIndex = checkoutIndexes.get(normalizedCheckout);
      if (duplicateCheckoutIndex !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["repositories", repositoryIndex, "checkout_directory"],
          message:
            `Checkout directory duplicates repositories.${duplicateCheckoutIndex}` +
            ".checkout_directory",
        });
      } else {
        checkoutIndexes.set(normalizedCheckout, repositoryIndex);
      }
    });

    const repositoryIds = new Set(repositoryIndexes.keys());
    manifest.repositories.forEach((repository, repositoryIndex) => {
      repository.dependencies?.forEach((dependency, dependencyIndex) => {
        if (!repositoryIds.has(dependency)) {
          context.addIssue({
            code: "custom",
            path: [
              "repositories",
              repositoryIndex,
              "dependencies",
              dependencyIndex,
            ],
            message: `Dependency references undeclared repository "${dependency}"`,
          });
        }
      });
    });
  });

export type RepositoryCommand = z.infer<typeof repositoryCommandSchema>;
export type RepositoryManifestEntry = z.infer<
  typeof repositoryManifestEntrySchema
>;
export type RepositoryManifest = z.infer<typeof repositoryManifestSchema>;

function normalizeCheckoutDirectory(directory: string): string {
  return posix.normalize(directory.replaceAll("\\", "/")).replace(/\/+$/, "");
}
