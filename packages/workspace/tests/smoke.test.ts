import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  WORKSPACE_MANIFEST_FILE,
  bootstrapWorkspace,
  getWorkspaceStatus,
  packageName,
  readWorkspaceManifest,
  type RepositoryManifestLike,
} from "../src/index";

const execFileAsync = promisify(execFile);
const GIT_TEST_TIMEOUT_MS = 15_000;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("@scaflow/workspace", () => {
  it("exposes package identity", () => {
    expect(packageName).toBe("@scaflow/workspace");
  });

  it("bootstraps missing repositories, writes a deterministic manifest, and reports status", async () => {
    const fixture = await createProjectFixture();

    const result = await bootstrapWorkspace(fixture.projectDir, fixture.manifest);

    expect(result.ok).toBe(true);
    expect(result.repositories).toEqual([
      expect.objectContaining({
        id: "web",
        action: "clone",
        state: "cloned",
        identity: "matching",
        clean: true,
        head: expect.stringMatching(/^[0-9a-f]{40}$/),
      }),
    ]);
    await expect(
      readFile(join(fixture.projectDir, WORKSPACE_MANIFEST_FILE), "utf8"),
    ).resolves.toContain('"id": "web"');
    await expect(readWorkspaceManifest(fixture.projectDir)).resolves.toMatchObject({
      version: 1,
      repositories: [
        {
          id: "web",
          checkoutDirectory: "web",
          checkoutPath: "repos/web",
          observed: { identity: "matching", clean: true },
        },
      ],
    });

    const status = await getWorkspaceStatus(fixture.projectDir, fixture.manifest);
    expect(status).toMatchObject({
      ok: true,
      manifestPresent: true,
      repositories: [
        {
          id: "web",
          state: "fetched",
          action: "inspect",
          identity: "matching",
        },
      ],
    });

    await rm(join(fixture.projectDir, "workspace", "repos", "web"), {
      force: true,
      recursive: true,
    });
    await expect(
      getWorkspaceStatus(fixture.projectDir, fixture.manifest),
    ).resolves.toMatchObject({
      ok: false,
      manifestPresent: true,
      repositories: [{ id: "web", state: "missing" }],
    });
  }, GIT_TEST_TIMEOUT_MS);

  it("fetches existing matching repositories without changing branches or deleting local changes", async () => {
    const fixture = await createProjectFixture();
    await bootstrapWorkspace(fixture.projectDir, fixture.manifest);
    const checkout = join(fixture.projectDir, "workspace", "repos", "web");

    await git(checkout, "checkout", "-b", "developer-work");
    await writeFile(join(checkout, "local.txt"), "developer change\n");

    const result = await bootstrapWorkspace(fixture.projectDir, fixture.manifest);

    expect(result.ok).toBe(true);
    expect(result.repositories).toEqual([
      expect.objectContaining({
        id: "web",
        action: "fetch",
        state: "fetched",
        clean: false,
      }),
    ]);
    expect((await git(checkout, "branch", "--show-current")).trim()).toBe(
      "developer-work",
    );
    await expect(readFile(join(checkout, "local.txt"), "utf8")).resolves.toBe(
      "developer change\n",
    );
  }, GIT_TEST_TIMEOUT_MS);

  it("captures per-repository failures and continues bootstrapping other repositories", async () => {
    const fixture = await createProjectFixture();
    const other = await createRemoteFixture(fixture.rootDir, "api");
    const manifest: RepositoryManifestLike = {
      repositories: [
        {
          id: "web",
          name: "Web",
          git_url: `${fixture.remoteDir}-wrong`,
          default_branch: "main",
          checkout_directory: "web",
          type: "application",
        },
        {
          id: "api",
          name: "API",
          git_url: other.remoteDir,
          default_branch: "main",
          checkout_directory: "api",
          type: "application",
        },
      ],
    };

    await bootstrapWorkspace(fixture.projectDir, fixture.manifest);
    const result = await bootstrapWorkspace(fixture.projectDir, manifest);

    expect(result.ok).toBe(false);
    expect(result.repositories).toEqual([
      expect.objectContaining({
        id: "web",
        state: "failed",
        identity: "mismatched",
      }),
      expect.objectContaining({
        id: "api",
        state: "cloned",
        identity: "matching",
      }),
    ]);
  }, GIT_TEST_TIMEOUT_MS);
});

async function createProjectFixture(): Promise<{
  rootDir: string;
  projectDir: string;
  remoteDir: string;
  manifest: RepositoryManifestLike;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "scaflow-workspace-test-"));
  tempDirs.push(rootDir);
  const projectDir = join(rootDir, "project");
  await mkdir(projectDir);
  const { remoteDir } = await createRemoteFixture(rootDir, "web");

  return {
    rootDir,
    projectDir,
    remoteDir,
    manifest: {
      repositories: [
        {
          id: "web",
          name: "Web",
          git_url: remoteDir,
          default_branch: "main",
          checkout_directory: "web",
          type: "application",
        },
      ],
    },
  };
}

async function createRemoteFixture(
  rootDir: string,
  name: string,
): Promise<{ readonly remoteDir: string }> {
  const sourceDir = join(rootDir, `${name}-source`);
  const remoteDir = join(rootDir, `${name}.git`);

  await mkdir(sourceDir);
  await git(sourceDir, "init");
  await git(sourceDir, "config", "user.name", "Scaflow Test");
  await git(sourceDir, "config", "user.email", "scaflow@example.invalid");
  await writeFile(join(sourceDir, "README.md"), `# ${name}\n`);
  await git(sourceDir, "add", "README.md");
  await git(sourceDir, "commit", "-m", "Initial commit");
  await git(sourceDir, "init", "--bare", remoteDir);
  await git(sourceDir, "remote", "add", "origin", remoteDir);
  await git(sourceDir, "push", "origin", "HEAD:main");

  return { remoteDir };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });

  return stdout;
}
