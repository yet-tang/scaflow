import { constants } from "node:fs";
import { open, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { renderEntriesNative, type NativeRenderEntry } from "./native.js";

export const packageName = "@scaflow/template";

const packageDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = resolve(packageDirectory, "../..");
export const defaultProjectTemplatePath = join(
  repositoryRoot,
  "templates/default-project-scaflow",
);

export interface RenderTemplateOptions {
  readonly sourceDirectory?: string;
  readonly project?: ProjectTemplateOptions;
}

export interface RenderTemplateResult {
  readonly created: readonly string[];
  readonly skipped: readonly string[];
}

export interface ProjectTemplateOptions {
  readonly name: string;
  readonly id?: string;
  readonly engineVersion?: string;
}

export async function renderProjectTemplate(
  destinationDirectory: string,
  options: RenderTemplateOptions = {},
): Promise<RenderTemplateResult> {
  const destination = await open(
    resolve(destinationDirectory),
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    const sourceDirectory = resolve(
      options.sourceDirectory ?? defaultProjectTemplatePath,
    );
    const entries = await collectTemplateEntries(sourceDirectory, options);
    return renderEntriesNative(destination.fd, entries);
  } finally {
    await destination.close();
  }
}

async function collectTemplateEntries(
  sourceDirectory: string,
  options: RenderTemplateOptions,
): Promise<readonly NativeRenderEntry[]> {
  const entries: NativeRenderEntry[] = [];

  async function visit(directory: string): Promise<void> {
    const directoryEntries = await readdir(directory, {
      withFileTypes: true,
    });

    for (const entry of directoryEntries.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      const absolutePath = join(directory, entry.name);
      const templatePath = toTemplatePath(
        relative(sourceDirectory, absolutePath),
      );

      if (entry.isSymbolicLink()) {
        throw new Error(
          `Template entries may not be symbolic links: ${templatePath}`,
        );
      }

      if (entry.isDirectory()) {
        entries.push({ path: templatePath, type: "directory" });
        await visit(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        throw new Error(
          `Unsupported template entry type: ${templatePath}`,
        );
      }

      entries.push({
        path: templatePath,
        type: "file",
        content: await renderTemplateFile(
          templatePath,
          await readFile(absolutePath),
          options,
        ),
        mode: basename(templatePath) === "scaflow" ? 0o755 : 0o644,
      });
    }
  }

  await visit(sourceDirectory);
  return entries;
}

function toTemplatePath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function renderTemplateFile(
  templatePath: string,
  content: Buffer,
  options: RenderTemplateOptions,
): Buffer {
  if (options.project === undefined) {
    return content;
  }

  if (templatePath === "scaflow.yaml") {
    return Buffer.from(
      `${JSON.stringify(
        {
          version: 1,
          project: {
            id: options.project.id ?? projectIdFromName(options.project.name),
            name: options.project.name,
          },
          engine: {
            version: options.project.engineVersion ?? "0.1.0",
          },
        },
        null,
        2,
      )}\n`,
    );
  }

  if (templatePath === "repositories.yaml") {
    return Buffer.from(
      `${JSON.stringify(
        {
          version: 1,
          repositories: [
            {
              id: "app",
              name: "Application",
              git_url: "https://github.com/example/app.git",
              default_branch: "main",
              checkout_directory: "apps/app",
              type: "application",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
  }

  return content;
}

function projectIdFromName(name: string): string {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return id === "" ? "project" : id;
}
