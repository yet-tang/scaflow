import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const packageName = "@scaflow/config";

export const PROJECT_CONFIG_FILE = "scaflow.yaml";
export const REPOSITORY_MANIFEST_FILE = "repositories.yaml";
export const TASKS_DIRECTORY = "tasks";
export const TASK_CONTRACT_FILE = "contract.yaml";

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
  readonly taskContractSchema: unknown;
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

export async function loadTaskContract(
  directory: string,
  taskId: string,
  options: ConfigLoadOptions = {},
): Promise<unknown> {
  const normalizedTaskId = normalizeTaskId(taskId, options);
  const path = taskContractPath(directory, normalizedTaskId);
  const input = await readYamlConfig(path, options);
  const schemas = await loadSchemas();
  return schemas.parseSchema(
    schemas.taskContractSchema,
    input,
    schemaOptions(options),
  );
}

export async function listTaskContracts(
  directory: string,
  options: ConfigLoadOptions = {},
): Promise<unknown[]> {
  const { readdir } = await import("node:fs/promises");
  const tasksDirectory = join(directory, TASKS_DIRECTORY);
  let entries: Array<{ isDirectory: () => boolean; name: string }>;

  try {
    entries = await readdir(tasksDirectory, { withFileTypes: true });
  } catch (cause) {
    throw new ConfigFileError("Could not read tasks directory", {
      code: "TASKS_DIRECTORY_NOT_FOUND",
      ...correlationOption(options),
      details: { path: tasksDirectory },
      cause,
    });
  }

  const taskIds = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const contracts: unknown[] = [];
  for (const taskId of taskIds) {
    contracts.push(await loadTaskContract(directory, taskId, options));
  }
  return contracts;
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

function normalizeTaskId(
  taskId: string,
  options: ConfigLoadOptions,
): string {
  const normalizedTaskId = taskId.trim();
  if (
    normalizedTaskId === "" ||
    normalizedTaskId.includes("/") ||
    normalizedTaskId.includes("\\") ||
    normalizedTaskId === "." ||
    normalizedTaskId === ".."
  ) {
    throw new ConfigFileError("Task ID is not a safe task directory name", {
      code: "TASK_ID_INVALID",
      ...correlationOption(options),
      details: { taskId },
    });
  }
  return normalizedTaskId;
}

function taskContractPath(directory: string, taskId: string): string {
  return join(directory, TASKS_DIRECTORY, taskId, TASK_CONTRACT_FILE);
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

async function readYamlConfig(
  path: string,
  options: ConfigLoadOptions,
): Promise<unknown> {
  let contents: string;

  try {
    contents = await readFile(path, "utf8");
  } catch (cause) {
    throw new ConfigFileError("Could not read task contract", {
      code: "TASK_CONTRACT_NOT_FOUND",
      ...correlationOption(options),
      details: { path },
      cause,
    });
  }

  try {
    return parseYamlDocument(contents);
  } catch (cause) {
    throw new ConfigFileError("Task contract is not valid YAML", {
      code: "TASK_CONTRACT_PARSE_FAILED",
      ...correlationOption(options),
      details: { path },
      cause,
    });
  }
}

function parseYamlDocument(contents: string): unknown {
  const trimmed = contents.trim();
  if (trimmed === "") {
    return {};
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Contract YAML is parsed below.
  }

  const lines = contents
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((raw, index) => ({
      index,
      indent: raw.match(/^ */)?.[0].length ?? 0,
      text: stripYamlComment(raw).trimEnd(),
    }))
    .filter((line) => line.text.trim() !== "" && line.text.trim() !== "---");

  if (lines.length === 0) {
    return {};
  }

  const [value, nextIndex] = parseYamlBlock(lines, 0, lines[0]?.indent ?? 0);
  if (nextIndex !== lines.length) {
    const lineNumber = (lines[nextIndex]?.index ?? 0) + 1;
    throw new Error(`Unexpected YAML content on line ${lineNumber}`);
  }
  return value;
}

interface YamlLine {
  readonly index: number;
  readonly indent: number;
  readonly text: string;
}

function parseYamlBlock(
  lines: readonly YamlLine[],
  startIndex: number,
  indent: number,
): [unknown, number] {
  const line = lines[startIndex];
  if (line === undefined) {
    return [{}, startIndex];
  }

  if (line.indent < indent) {
    return [{}, startIndex];
  }

  if (line.indent !== indent) {
    throw new Error(`Unexpected indentation on line ${line.index + 1}`);
  }

  return line.text.trimStart().startsWith("- ")
    ? parseYamlSequence(lines, startIndex, indent)
    : parseYamlMapping(lines, startIndex, indent);
}

function parseYamlMapping(
  lines: readonly YamlLine[],
  startIndex: number,
  indent: number,
): [Record<string, unknown>, number] {
  const output: Record<string, unknown> = {};
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw new Error(`Unexpected indentation on line ${line.index + 1}`);
    }
    if (line.text.trimStart().startsWith("- ")) {
      break;
    }

    const [key, valueText] = splitYamlKeyValue(line);
    if (valueText.trim() === "") {
      const nextLine = lines[index + 1];
      if (nextLine === undefined || nextLine.indent <= indent) {
        output[key] = {};
        index += 1;
        continue;
      }
      const [value, nextIndex] = parseYamlBlock(
        lines,
        index + 1,
        nextLine.indent,
      );
      output[key] = value;
      index = nextIndex;
      continue;
    }

    output[key] = parseYamlScalar(valueText.trim());
    index += 1;
  }

  return [output, index];
}

function parseYamlSequence(
  lines: readonly YamlLine[],
  startIndex: number,
  indent: number,
): [unknown[], number] {
  const output: unknown[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw new Error(`Unexpected indentation on line ${line.index + 1}`);
    }
    const trimmed = line.text.trimStart();
    if (!trimmed.startsWith("- ")) {
      break;
    }

    const itemText = trimmed.slice(2).trim();
    if (itemText === "") {
      const nextLine = lines[index + 1];
      if (nextLine === undefined || nextLine.indent <= indent) {
        output.push({});
        index += 1;
        continue;
      }
      const [value, nextIndex] = parseYamlBlock(
        lines,
        index + 1,
        nextLine.indent,
      );
      output.push(value);
      index = nextIndex;
      continue;
    }

    if (looksLikeYamlKeyValue(itemText)) {
      const [key, valueText] = splitYamlKeyValue({
        ...line,
        text: itemText,
      });
      const item: Record<string, unknown> = {};
      if (valueText.trim() === "") {
        const nextLine = lines[index + 1];
        if (nextLine === undefined || nextLine.indent <= indent) {
          item[key] = {};
          index += 1;
        } else {
          const [value, nextIndex] = parseYamlBlock(
            lines,
            index + 1,
            nextLine.indent,
          );
          item[key] = value;
          index = nextIndex;
        }
      } else {
        item[key] = parseYamlScalar(valueText.trim());
        index += 1;
      }

      while (index < lines.length) {
        const continuation = lines[index];
        if (
          continuation === undefined ||
          continuation.indent <= indent ||
          continuation.text.trimStart().startsWith("- ")
        ) {
          break;
        }
        const [continuationKey, continuationValueText] =
          splitYamlKeyValue(continuation);
        if (continuationValueText.trim() === "") {
          const nextLine = lines[index + 1];
          if (
            nextLine === undefined ||
            nextLine.indent <= continuation.indent
          ) {
            item[continuationKey] = {};
            index += 1;
          } else {
            const [value, nextIndex] = parseYamlBlock(
              lines,
              index + 1,
              nextLine.indent,
            );
            item[continuationKey] = value;
            index = nextIndex;
          }
        } else {
          item[continuationKey] = parseYamlScalar(
            continuationValueText.trim(),
          );
          index += 1;
        }
      }
      output.push(item);
      continue;
    }

    output.push(parseYamlScalar(itemText));
    index += 1;
  }

  return [output, index];
}

function stripYamlComment(raw: string): string {
  let quoted: "'" | "\"" | undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === "'" || character === "\"") {
      quoted = quoted === character ? undefined : quoted ?? character;
      continue;
    }
    if (character === "#" && quoted === undefined) {
      return raw.slice(0, index);
    }
  }
  return raw;
}

function splitYamlKeyValue(line: YamlLine): [string, string] {
  const separatorIndex = line.text.indexOf(":");
  if (separatorIndex <= 0) {
    throw new Error(`Expected YAML key-value pair on line ${line.index + 1}`);
  }

  const key = line.text.slice(0, separatorIndex).trim();
  if (key === "") {
    throw new Error(`Expected YAML key on line ${line.index + 1}`);
  }
  return [unquoteYamlString(key), line.text.slice(separatorIndex + 1)];
}

function looksLikeYamlKeyValue(value: string): boolean {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0) {
    return false;
  }

  const nextCharacter = value[separatorIndex + 1];
  return nextCharacter === undefined || /\s/.test(nextCharacter);
}

function parseYamlScalar(value: string): unknown {
  if (value.startsWith("[") && value.endsWith("]")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Fall through to regular scalar handling for clearer schema errors.
    }
  }
  if (value === "{}") {
    return {};
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value === "null" || value === "~") {
    return null;
  }
  if (/^-?(0|[1-9]\d*)$/.test(value)) {
    return Number(value);
  }
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return unquoteYamlString(value);
  }
  return value;
}

function unquoteYamlString(value: string): string {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return JSON.parse(value) as string;
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
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
