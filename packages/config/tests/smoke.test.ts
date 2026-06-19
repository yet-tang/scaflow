import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConfigFileError,
  loadProjectConfig,
  packageName,
  validateLocalProject,
} from "../src/index";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("@scaflow/config", () => {
  it("exposes package identity", () => {
    expect(packageName).toBe("@scaflow/config");
  });

  it("validates local project and repository configuration files", async () => {
    const directory = await temporaryDirectory("scaflow-config-");
    await writeFile(
      join(directory, "scaflow.yaml"),
      `${JSON.stringify({
        version: 1,
        project: { id: "beauty-ai", name: "Beauty AI" },
        engine: { version: "0.1.0" },
      })}\n`,
    );
    await writeFile(
      join(directory, "repositories.yaml"),
      `${JSON.stringify({
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
      })}\n`,
    );

    await expect(validateLocalProject(directory)).resolves.toMatchObject({
      projectConfig: {
        project: { id: "beauty-ai", name: "Beauty AI" },
      },
      repositoryManifest: {
        repositories: [{ id: "app" }],
      },
    });
  });

  it("returns structured schema errors for invalid config files", async () => {
    const directory = await temporaryDirectory("scaflow-config-invalid-");
    await writeFile(
      join(directory, "scaflow.yaml"),
      `${JSON.stringify({
        version: 1,
        project: { id: "beauty-ai" },
        engine: { version: "0.1.0" },
      })}\n`,
    );

    await expect(
      loadProjectConfig(directory, { correlationId: "config-test" }),
    ).rejects.toMatchObject({
      code: "SCHEMA_PARSE_FAILED",
      correlationId: "config-test",
      issues: [
        expect.objectContaining({
          code: "invalid_type",
          path: ["project", "name"],
        }),
      ],
    });
  });

  it("returns structured file errors for missing config files", async () => {
    const directory = await temporaryDirectory("scaflow-config-missing-");

    await expect(
      loadProjectConfig(directory, { correlationId: "missing-test" }),
    ).rejects.toBeInstanceOf(ConfigFileError);
    await expect(
      loadProjectConfig(directory, { correlationId: "missing-test" }),
    ).rejects.toMatchObject({
      code: "CONFIG_FILE_NOT_FOUND",
      correlationId: "missing-test",
    });
  });
});
