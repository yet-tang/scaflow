import { z } from "zod";

const projectIdSchema = z.string().trim().min(1);

const projectNameSchema = z.string().trim().min(1);

const exactEngineVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[a-zA-Z-][0-9a-zA-Z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[a-zA-Z-][0-9a-zA-Z-]*)))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/,
    "Engine version must be an exact semantic version",
  );

export const projectConfigSchema = z.strictObject({
  version: z.literal(1),
  project: z.strictObject({
    id: projectIdSchema,
    name: projectNameSchema,
  }),
  engine: z.strictObject({
    version: exactEngineVersionSchema,
  }),
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
