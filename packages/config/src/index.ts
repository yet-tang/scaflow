import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const packageName = "@scaflow/config";

export const PROJECT_CONFIG_FILE = "scaflow.yaml";
export const REPOSITORY_MANIFEST_FILE = "repositories.yaml";

export interface ConfigLoadOptions {
  readonly correlationId?: string;
}

export interface LocalProjectConfig {
  readonly projectConfig: unknown;
  readonly repositoryManifest: unknown;
}

interface SchemaModule {
  readonly parseSchema: (
    schema: unknown,
    input: unknown,
    options?: { correlationId?: string },
  ) => unknown;
  readonly projectConfigSchema: unknown;
  readonly repositoryManifestSchema: unknown;
}

export class ConfigFileError extends Error {
  declare readonly name: "ConfigFileError";
  readonly code: string;
  readonly recoverable: boolean;
  readonly correlationId: string;
  readonly suggestion: string;
  readonly details: unknown;

  constructor(
    message: string,
    options: {
      readonly code: string;
      readonly correlationId?: string;
      readonly details: unknown;
      readonly cause?: unknown;
    },
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );

    this.name = "ConfigFileError";
    this.code = options.code;
    this.recoverable = false;
    this.correlationId = options.correlationId ?? "config-error";
    this.suggestion = "Correct the local Scaflow configuration and try again";
    this.details = options.details;
  }
}

export async function loadProjectConfig(
  directory: string,
  options: ConfigLoadOptions = {},
): Promise<unknown> {
  const input = await readJsonConfig(directory, PROJECT_CONFIG_FILE, options);
  const schemas = await loadSchemas();
  return schemas.parseSchema(
    schemas.projectConfigSchema,
    input,
    schemaOptions(options),
  );
}

export async function loadRepositoryManifest(
  directory: string,
  options: ConfigLoadOptions = {},
): Promise<unknown> {
  const input = await readJsonConfig(
    directory,
    REPOSITORY_MANIFEST_FILE,
    options,
  );
  const schemas = await loadSchemas();
  return schemas.parseSchema(
    schemas.repositoryManifestSchema,
    input,
    schemaOptions(options),
  );
}

export async function validateLocalProject(
  directory: string,
  options: ConfigLoadOptions = {},
): Promise<LocalProjectConfig> {
  const [projectConfig, repositoryManifest] = await Promise.all([
    loadProjectConfig(directory, options),
    loadRepositoryManifest(directory, options),
  ]);

  return { projectConfig, repositoryManifest };
}

async function readJsonConfig(
  directory: string,
  filename: string,
  options: ConfigLoadOptions,
): Promise<unknown> {
  const path = join(directory, filename);
  let contents: string;

  try {
    contents = await readFile(path, "utf8");
  } catch (cause) {
    throw new ConfigFileError(`Could not read ${filename}`, {
      code: "CONFIG_FILE_NOT_FOUND",
      ...correlationOption(options),
      details: { path },
      cause,
    });
  }

  try {
    return JSON.parse(contents) as unknown;
  } catch (cause) {
    throw new ConfigFileError(`${filename} is not valid JSON`, {
      code: "CONFIG_FILE_PARSE_FAILED",
      ...correlationOption(options),
      details: { path },
      cause,
    });
  }
}

function schemaOptions(
  options: ConfigLoadOptions,
): { readonly correlationId?: string } {
  return correlationOption(options);
}

function correlationOption(
  options: ConfigLoadOptions,
): { readonly correlationId?: string } {
  return options.correlationId === undefined
    ? {}
    : { correlationId: options.correlationId };
}

async function loadSchemas(): Promise<SchemaModule> {
  return (await import(schemaModuleUrl())) as SchemaModule;
}

function schemaModuleUrl(): string {
  const currentPath = fileURLToPath(import.meta.url);
  const modulePath = currentPath.includes("/src/")
    ? "../../schemas/src/index.ts"
    : "../../schemas/dist/index.js";

  return new URL(modulePath, import.meta.url).href;
}
