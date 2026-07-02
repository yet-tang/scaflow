import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  WORKSPACE_MANIFEST_FILE,
  bootstrapWorkspace,
  freezeWorkspaceRevisionSet,
  getWorkspaceStatus,
  packageName,
  prepareTaskRunWorkspace,
  readWorkspaceManifest,
  type RepositoryManifestLike,
  type TaskContractLike,
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

  it("freezes @control and scoped application repository revisions without following remote movement", async () => {
    const fixture = await createProjectFixture();
    const control = await createRemoteFixture(fixture.rootDir, "control");
    await rm(fixture.projectDir, { force: true, recursive: true });
    await git(fixture.rootDir, "clone", control.remoteDir, fixture.projectDir);
    await bootstrapWorkspace(fixture.projectDir, fixture.manifest);

    const revisionSet = await freezeWorkspaceRevisionSet(fixture.projectDir, {
      control: {
        expectedUrl: control.remoteDir,
        defaultBranch: "main",
      },
      manifest: fixture.manifest,
      scopes: [
        { repository: "@control", access: "read-write" },
        { repository: "web", access: "read-only" },
      ],
    });
    const frozenWebCommit = revisionSet.repositories[0]?.base_commit;

    await writeFile(join(fixture.webSourceDir, "after-freeze.txt"), "moved\n");
    await git(fixture.webSourceDir, "add", "after-freeze.txt");
    await git(fixture.webSourceDir, "commit", "-m", "Move remote branch");
    await git(fixture.webSourceDir, "push", "origin", "HEAD:main");
    await bootstrapWorkspace(fixture.projectDir, fixture.manifest);

    expect(revisionSet).toEqual({
      version: 1,
      control: expect.objectContaining({
        id: "@control",
        base_commit: expect.stringMatching(/^[0-9a-f]{40}$/),
        access: "read-write",
        checkout_directory: ".",
        default_branch: "main",
        identity: {
          remote: "origin",
          expected_url: control.remoteDir,
          actual_url: control.remoteDir,
        },
      }),
      repositories: [
        expect.objectContaining({
          id: "web",
          base_commit: expect.stringMatching(/^[0-9a-f]{40}$/),
          access: "read-only",
          checkout_directory: "web",
          default_branch: "main",
          identity: {
            remote: "origin",
            expected_url: fixture.remoteDir,
            actual_url: fixture.remoteDir,
          },
        }),
      ],
    });
    expect(frozenWebCommit).not.toBe(
      (
        await git(
          join(fixture.projectDir, "workspace", "repos", "web"),
          "rev-parse",
          "origin/main",
        )
      ).trim(),
    );
    expect(revisionSet.repositories[0]?.base_commit).toBe(frozenWebCommit);
  }, GIT_TEST_TIMEOUT_MS);

  it("fails when a task scope references a repository missing from the manifest", async () => {
    const fixture = await createProjectFixture();

    await expect(
      freezeWorkspaceRevisionSet(fixture.projectDir, {
        control: {
          expectedUrl: fixture.remoteDir,
          defaultBranch: "main",
        },
        manifest: fixture.manifest,
        scopes: [
          { repository: "@control", access: "read-write" },
          { repository: "api", access: "read-only" },
        ],
      }),
    ).rejects.toThrow(
      'Task scope references repository "api" missing from repository manifest',
    );
  }, GIT_TEST_TIMEOUT_MS);

  it("prepares a TaskRun bundle with detached read-only and branch read-write worktrees outside workspace/repos", async () => {
    const fixture = await createProjectFixture();
    const control = await createRemoteFixture(fixture.rootDir, "control");
    await rm(fixture.projectDir, { force: true, recursive: true });
    await git(fixture.rootDir, "clone", control.remoteDir, fixture.projectDir);
    await bootstrapWorkspace(fixture.projectDir, fixture.manifest);
    const workspaceCheckout = join(fixture.projectDir, "workspace", "repos", "web");
    await writeFile(join(workspaceCheckout, "developer-note.txt"), "local\n");

    const result = await prepareTaskRunWorkspace(fixture.projectDir, {
      taskContract: taskContract([
        { repository: "@control", access: "read-write" },
        { repository: "web", access: "read-only" },
      ]),
      taskRunId: "run-001",
      manifest: fixture.manifest,
      control: {
        expectedUrl: control.remoteDir,
        defaultBranch: "main",
      },
    });

    await expect(stat(join(result.bundleRoot, ".git"))).rejects.toThrow();
    expect(result.bundleRoot).toBe(
      join(fixture.projectDir, "workspace", "runs", "SFL-017", "run-001"),
    );
    expect(result.repositories).toEqual([
      expect.objectContaining({
        id: "@control",
        mode: "branch",
        branchName: "scaflow/SFL-017/run-001/control",
        reused: false,
      }),
      expect.objectContaining({
        id: "web",
        mode: "detached",
        reused: false,
      }),
    ]);
    expect(
      (await git(join(result.bundleRoot, "control"), "branch", "--show-current"))
        .trim(),
    ).toBe("scaflow/SFL-017/run-001/control");
    expect(
      (await git(join(result.bundleRoot, "repositories", "web"), "branch", "--show-current"))
        .trim(),
    ).toBe("");
    await expect(
      readFile(join(workspaceCheckout, "developer-note.txt"), "utf8"),
    ).resolves.toBe("local\n");
    await expect(
      readFile(join(result.bundleRoot, "revision-set.json"), "utf8"),
    ).resolves.toContain('"id": "web"');

    const repeated = await prepareTaskRunWorkspace(fixture.projectDir, {
      taskContract: taskContract([
        { repository: "@control", access: "read-write" },
        { repository: "web", access: "read-only" },
      ]),
      taskRunId: "run-001",
      manifest: fixture.manifest,
      control: {
        expectedUrl: control.remoteDir,
        defaultBranch: "main",
      },
    });
    expect(repeated.repositories.every((repository) => repository.reused)).toBe(true);
  }, GIT_TEST_TIMEOUT_MS);

  it("creates task branches for read-write application scopes", async () => {
    const fixture = await createProjectFixture();
    const control = await createRemoteFixture(fixture.rootDir, "control");
    await rm(fixture.projectDir, { force: true, recursive: true });
    await git(fixture.rootDir, "clone", control.remoteDir, fixture.projectDir);
    await bootstrapWorkspace(fixture.projectDir, fixture.manifest);

    const result = await prepareTaskRunWorkspace(fixture.projectDir, {
      taskContract: taskContract([
        { repository: "@control", access: "read-write" },
        { repository: "web", access: "read-write" },
      ]),
      taskRunId: "run-branch",
      manifest: fixture.manifest,
      control: {
        expectedUrl: control.remoteDir,
        defaultBranch: "main",
      },
    });

    expect(
      (await git(
        join(result.bundleRoot, "repositories", "web"),
        "branch",
        "--show-current",
      )).trim(),
    ).toBe("scaflow/SFL-017/run-branch/web");
  }, GIT_TEST_TIMEOUT_MS);

  it("does not create a writable control worktree unless @control is explicitly read-write", async () => {
    const fixture = await createProjectFixture();
    const control = await createRemoteFixture(fixture.rootDir, "control");
    await rm(fixture.projectDir, { force: true, recursive: true });
    await git(fixture.rootDir, "clone", control.remoteDir, fixture.projectDir);
    await bootstrapWorkspace(fixture.projectDir, fixture.manifest);

    const absentControl = await prepareTaskRunWorkspace(fixture.projectDir, {
      taskContract: taskContract([{ repository: "web", access: "read-only" }]),
      taskRunId: "run-without-control-scope",
      manifest: fixture.manifest,
      control: {
        expectedUrl: control.remoteDir,
        defaultBranch: "main",
      },
    });
    expect(absentControl.revisionSet.control.access).toBe("read-only");
    expect(absentControl.repositories.map((repository) => repository.id)).toEqual([
      "web",
    ]);
    await expect(
      stat(join(absentControl.bundleRoot, "control")),
    ).rejects.toThrow();

    const readOnlyControl = await prepareTaskRunWorkspace(fixture.projectDir, {
      taskContract: taskContract([
        { repository: "@control", access: "read-only" },
        { repository: "web", access: "read-only" },
      ]),
      taskRunId: "run-readonly-control-scope",
      manifest: fixture.manifest,
      control: {
        expectedUrl: control.remoteDir,
        defaultBranch: "main",
      },
    });
    expect(readOnlyControl.revisionSet.control.access).toBe("read-only");
    expect(readOnlyControl.repositories.map((repository) => repository.id)).toEqual([
      "web",
    ]);
    await expect(
      stat(join(readOnlyControl.bundleRoot, "control")),
    ).rejects.toThrow();

    const readWriteControl = await prepareTaskRunWorkspace(fixture.projectDir, {
      taskContract: taskContract([
        { repository: "@control", access: "read-write" },
        { repository: "web", access: "read-only" },
      ]),
      taskRunId: "run-readwrite-control-scope",
      manifest: fixture.manifest,
      control: {
        expectedUrl: control.remoteDir,
        defaultBranch: "main",
      },
    });
    expect(readWriteControl.repositories.map((repository) => repository.id)).toEqual([
      "@control",
      "web",
    ]);
    expect(
      (
        await git(
          join(readWriteControl.bundleRoot, "control"),
          "branch",
          "--show-current",
        )
      ).trim(),
    ).toBe("scaflow/SFL-017/run-readwrite-control-scope/control");
  }, GIT_TEST_TIMEOUT_MS);

  it("reuses the stored Revision Set when base checkouts move after prepare", async () => {
    const fixture = await createProjectFixture();
    const control = await createRemoteFixture(fixture.rootDir, "control");
    await rm(fixture.projectDir, { force: true, recursive: true });
    await git(fixture.rootDir, "clone", control.remoteDir, fixture.projectDir);
    await bootstrapWorkspace(fixture.projectDir, fixture.manifest);

    const first = await prepareTaskRunWorkspace(fixture.projectDir, {
      taskContract: taskContract([{ repository: "web", access: "read-only" }]),
      taskRunId: "run-stored-revision",
      manifest: fixture.manifest,
      control: {
        expectedUrl: control.remoteDir,
        defaultBranch: "main",
      },
    });
    const frozenRevisionSet = await readFile(first.revisionSetPath, "utf8");
    const frozenWebCommit = first.revisionSet.repositories[0]?.base_commit;

    await writeFile(join(fixture.webSourceDir, "after-prepare.txt"), "moved\n");
    await git(fixture.webSourceDir, "add", "after-prepare.txt");
    await git(fixture.webSourceDir, "commit", "-m", "Move web branch");
    await git(fixture.webSourceDir, "push", "origin", "HEAD:main");
    await bootstrapWorkspace(fixture.projectDir, fixture.manifest);

    const repeated = await prepareTaskRunWorkspace(fixture.projectDir, {
      taskContract: taskContract([{ repository: "web", access: "read-only" }]),
      taskRunId: "run-stored-revision",
      manifest: fixture.manifest,
      control: {
        expectedUrl: control.remoteDir,
        defaultBranch: "main",
      },
    });

    expect(await readFile(repeated.revisionSetPath, "utf8")).toBe(
      frozenRevisionSet,
    );
    expect(repeated.revisionSet.repositories[0]?.base_commit).toBe(
      frozenWebCommit,
    );
    expect(repeated.repositories).toEqual([
      expect.objectContaining({ id: "web", reused: true }),
    ]);
  }, GIT_TEST_TIMEOUT_MS);

  it("fails closed instead of overwriting invalid or inconsistent Revision Set evidence", async () => {
    const fixture = await createProjectFixture();
    const control = await createRemoteFixture(fixture.rootDir, "control");
    await rm(fixture.projectDir, { force: true, recursive: true });
    await git(fixture.rootDir, "clone", control.remoteDir, fixture.projectDir);
    await bootstrapWorkspace(fixture.projectDir, fixture.manifest);

    const invalid = await prepareTaskRunWorkspace(fixture.projectDir, {
      taskContract: taskContract([{ repository: "web", access: "read-only" }]),
      taskRunId: "run-invalid-revision",
      manifest: fixture.manifest,
      control: {
        expectedUrl: control.remoteDir,
        defaultBranch: "main",
      },
    });
    await writeFile(invalid.revisionSetPath, "{ invalid json\n");
    await expect(
      prepareTaskRunWorkspace(fixture.projectDir, {
        taskContract: taskContract([{ repository: "web", access: "read-only" }]),
        taskRunId: "run-invalid-revision",
        manifest: fixture.manifest,
        control: {
          expectedUrl: control.remoteDir,
          defaultBranch: "main",
        },
      }),
    ).rejects.toThrow("Existing TaskRun revision-set.json is invalid");
    await expect(readFile(invalid.revisionSetPath, "utf8")).resolves.toBe(
      "{ invalid json\n",
    );

    const inconsistent = await prepareTaskRunWorkspace(fixture.projectDir, {
      taskContract: taskContract([{ repository: "web", access: "read-only" }]),
      taskRunId: "run-inconsistent-revision",
      manifest: fixture.manifest,
      control: {
        expectedUrl: control.remoteDir,
        defaultBranch: "main",
      },
    });
    await writeFile(
      inconsistent.metadataPath,
      `${JSON.stringify(
        {
          version: 1,
          taskId: "SFL-017",
          taskRunId: "run-inconsistent-revision",
          bundleRoot: inconsistent.bundleRoot,
          runtimeDirectory: inconsistent.runtimeDirectory,
          repositoriesDirectory: inconsistent.repositoriesDirectory,
          revisionSetPath: inconsistent.revisionSetPath,
          repositories: [
            {
              ...inconsistent.repositories[0],
              baseCommit: "0".repeat(40),
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await expect(
      prepareTaskRunWorkspace(fixture.projectDir, {
        taskContract: taskContract([{ repository: "web", access: "read-only" }]),
        taskRunId: "run-inconsistent-revision",
        manifest: fixture.manifest,
        control: {
          expectedUrl: control.remoteDir,
          defaultBranch: "main",
        },
      }),
    ).rejects.toThrow(
      "Existing TaskRun workspace metadata is inconsistent with revision-set.json",
    );
  }, GIT_TEST_TIMEOUT_MS);

  it("fails closed for branch conflicts, repository identity mismatches, and interrupted bundle directories", async () => {
    const fixture = await createProjectFixture();
    const control = await createRemoteFixture(fixture.rootDir, "control");
    await rm(fixture.projectDir, { force: true, recursive: true });
    await git(fixture.rootDir, "clone", control.remoteDir, fixture.projectDir);
    await bootstrapWorkspace(fixture.projectDir, fixture.manifest);
    await git(fixture.projectDir, "branch", "scaflow/SFL-017/run-conflict/control");

    await expect(
      prepareTaskRunWorkspace(fixture.projectDir, {
        taskContract: taskContract([
          { repository: "@control", access: "read-write" },
        ]),
        taskRunId: "run-conflict",
        manifest: fixture.manifest,
        control: {
          expectedUrl: control.remoteDir,
          defaultBranch: "main",
        },
      }),
    ).rejects.toThrow();

    await git(
      join(fixture.projectDir, "workspace", "repos", "web"),
      "remote",
      "set-url",
      "origin",
      `${fixture.remoteDir}-wrong`,
    );
    await expect(
      prepareTaskRunWorkspace(fixture.projectDir, {
        taskContract: taskContract([
          { repository: "web", access: "read-only" },
        ]),
        taskRunId: "run-mismatch",
        manifest: fixture.manifest,
        control: {
          expectedUrl: control.remoteDir,
          defaultBranch: "main",
        },
      }),
    ).rejects.toMatchObject({ code: "GIT_REMOTE_MISMATCH" });

    const interruptedFixture = await createProjectFixture();
    const interruptedControl = await createRemoteFixture(
      interruptedFixture.rootDir,
      "control-interrupted",
    );
    await rm(interruptedFixture.projectDir, { force: true, recursive: true });
    await git(
      interruptedFixture.rootDir,
      "clone",
      interruptedControl.remoteDir,
      interruptedFixture.projectDir,
    );
    await bootstrapWorkspace(
      interruptedFixture.projectDir,
      interruptedFixture.manifest,
    );
    await mkdir(
      join(
        interruptedFixture.projectDir,
        "workspace",
        "runs",
        "SFL-017",
        "run-interrupted",
        "repositories",
        "web",
      ),
      { recursive: true },
    );
    await expect(
      prepareTaskRunWorkspace(interruptedFixture.projectDir, {
        taskContract: taskContract([
          { repository: "web", access: "read-only" },
        ]),
        taskRunId: "run-interrupted",
        manifest: interruptedFixture.manifest,
        control: {
          expectedUrl: interruptedControl.remoteDir,
          defaultBranch: "main",
        },
      }),
    ).rejects.toThrow("is not a Git worktree root");
    await expect(
      readFile(
        join(
          interruptedFixture.projectDir,
          "workspace",
          "runs",
          "SFL-017",
          "run-interrupted",
          "revision-set.json",
        ),
        "utf8",
      ),
    ).resolves.toContain('"version": 1');
  }, GIT_TEST_TIMEOUT_MS);
});

function taskContract(
  scopes: readonly TaskContractLike["repositories"]["scopes"][number][],
): TaskContractLike {
  return {
    task: {
      id: "SFL-017",
      definition_state: "ready",
    },
    repositories: {
      scopes,
    },
  };
}

async function createProjectFixture(): Promise<{
  rootDir: string;
  projectDir: string;
  remoteDir: string;
  webSourceDir: string;
  manifest: RepositoryManifestLike;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "scaflow-workspace-test-"));
  tempDirs.push(rootDir);
  const projectDir = join(rootDir, "project");
  await mkdir(projectDir);
  const { remoteDir, sourceDir } = await createRemoteFixture(rootDir, "web");

  return {
    rootDir,
    projectDir,
    remoteDir,
    webSourceDir: sourceDir,
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
): Promise<{ readonly remoteDir: string; readonly sourceDir: string }> {
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

  return { remoteDir, sourceDir };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });

  return stdout;
}
