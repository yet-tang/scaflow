import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  WORKSPACE_MANIFEST_FILE,
  assembleTaskRunContext,
  bootstrapWorkspace,
  freezeWorkspaceRevisionSet,
  getWorkspaceStatus,
  packageName,
  prepareTaskRunWorkspace,
  readWorkspaceManifest,
  type RepositoryManifestLike,
  type TaskContractLike,
  type TaskRepositoryScopeLike,
} from "../src/index";

const execFileAsync = promisify(execFile);
const GIT_TEST_TIMEOUT_MS = 30_000;
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

  it("assembles deterministic TaskRun context with task, knowledge, repositories, commands, and failure summary", async () => {
    const fixture = await createProjectFixture();
    const control = await createRemoteFixture(fixture.rootDir, "control");
    await rm(fixture.projectDir, { force: true, recursive: true });
    await git(fixture.rootDir, "clone", control.remoteDir, fixture.projectDir);
    await writeProjectKnowledge(fixture.projectDir, {
      "AGENTS.md": "# Instructions\n",
      "PRODUCT.md": "# Product\n",
      "ARCHITECTURE.md": "# Architecture\n",
      "docs/source/scaflow-v0.1.0-prd.md": "# PRD\n",
    });
    await bootstrapWorkspace(fixture.projectDir, fixture.manifest);
    const contract = contextTaskContract([
      {
        repository: "@control",
        access: "read-write",
        allowed_paths: ["packages/workspace/**"],
        forbidden_paths: [".scaflow/**"],
      },
      {
        repository: "web",
        access: "read-only",
        forbidden_paths: ["secrets/**"],
      },
    ]);
    const workspace = await prepareTaskRunWorkspace(fixture.projectDir, {
      taskContract: contract,
      taskRunId: "run-context",
      manifest: fixture.manifest,
      control: {
        expectedUrl: control.remoteDir,
        defaultBranch: "main",
      },
    });

    const first = await assembleTaskRunContext(fixture.projectDir, {
      taskRunWorkspace: workspace,
      taskContract: contract,
      projectKnowledgeFiles: ["PRODUCT.md", "AGENTS.md"],
      previousFailureSummary: "OPENAI_API_KEY=abc123\nPrevious verification failed\n",
    });
    const firstManifest = await readFile(
      join(workspace.bundleRoot, "context-manifest.json"),
      "utf8",
    );
    const second = await assembleTaskRunContext(fixture.projectDir, {
      taskRunWorkspace: workspace,
      taskContract: contract,
      projectKnowledgeFiles: ["PRODUCT.md", "AGENTS.md"],
      previousFailureSummary: "OPENAI_API_KEY=abc123\nPrevious verification failed\n",
    });

    expect(second).toEqual(first);
    await expect(
      readFile(join(workspace.bundleRoot, "context-manifest.json"), "utf8"),
    ).resolves.toBe(firstManifest);
    expect(first.manifest).toMatchObject({
      version: 1,
      task: { id: "SFL-018", title: "Context Assembler" },
      control: {
        mode: "read-write",
        declared: true,
        worktreePath: "control",
      },
      files: {
        agents: "AGENTS.md",
        manifest: "context-manifest.json",
        taskContract: "context/task-contract.json",
        projectKnowledge: [
          {
            source: "AGENTS.md",
            snapshot: "context/project-knowledge/00-AGENTS.md",
          },
          {
            source: "PRODUCT.md",
            snapshot: "context/project-knowledge/01-PRODUCT.md",
          },
        ],
        failureSummary: "context/failure-summary.md",
      },
      repositories: [
        expect.objectContaining({
          id: "@control",
          access: "read-write",
          worktreePath: "control",
          mode: "branch",
          allowedPaths: ["packages/workspace/**"],
          forbiddenPaths: [".scaflow/**"],
        }),
        expect.objectContaining({
          id: "web",
          access: "read-only",
          worktreePath: "repositories/web",
          mode: "detached",
          allowedPaths: [],
          forbiddenPaths: ["secrets/**"],
        }),
      ],
      verificationCommands: [
        {
          repository: "@control",
          executable: "pnpm",
          args: ["--filter", "@scaflow/workspace", "test"],
          timeout_seconds: 300,
          required: true,
        },
      ],
    });
    await expect(
      readFile(join(workspace.bundleRoot, "context", "task-contract.json"), "utf8"),
    ).resolves.toContain('"id": "SFL-018"');
    await expect(
      readFile(join(workspace.bundleRoot, "context", "failure-summary.md"), "utf8"),
    ).resolves.toBe(
      "OPENAI_API_KEY=[REDACTED]\nPrevious verification failed\n",
    );
    const manifestJson = await readFile(
      join(workspace.bundleRoot, "context-manifest.json"),
      "utf8",
    );
    expect(manifestJson).not.toContain(fixture.projectDir);
    expect(manifestJson).not.toContain(fixture.rootDir);
    await expect(
      readFile(join(workspace.bundleRoot, "AGENTS.md"), "utf8"),
    ).resolves.toContain(
      "Commands must be executed as structured executable/args definitions",
    );
  }, GIT_TEST_TIMEOUT_MS);

  it("assembles @control undeclared context without a writable control worktree", async () => {
    const fixture = await createProjectFixture();
    const control = await createRemoteFixture(fixture.rootDir, "control");
    await rm(fixture.projectDir, { force: true, recursive: true });
    await git(fixture.rootDir, "clone", control.remoteDir, fixture.projectDir);
    await writeProjectKnowledge(fixture.projectDir, { "AGENTS.md": "# Instructions\n" });
    await bootstrapWorkspace(fixture.projectDir, fixture.manifest);

    const contract = contextTaskContract([{ repository: "web", access: "read-only" }]);
    const workspace = await prepareTaskRunWorkspace(fixture.projectDir, {
      taskContract: contract,
      taskRunId: "run-control-undeclared",
      manifest: fixture.manifest,
      control: {
        expectedUrl: control.remoteDir,
        defaultBranch: "main",
      },
    });
    const manifest = await assembleTaskRunContext(fixture.projectDir, {
      taskRunWorkspace: workspace,
      taskContract: contract,
      projectKnowledgeFiles: ["AGENTS.md"],
    });

    expect(manifest.manifest.control).toEqual({
      mode: "undeclared",
      declared: false,
    });
    expect(manifest.manifest.repositories.map((repository) => repository.id)).toEqual([
      "@control",
      "web",
    ]);
    await expect(stat(join(workspace.bundleRoot, "control"))).rejects.toThrow();
  }, GIT_TEST_TIMEOUT_MS);

  it("assembles @control read-only context without a writable control worktree", async () => {
    const fixture = await createProjectFixture();
    const control = await createRemoteFixture(fixture.rootDir, "control");
    await rm(fixture.projectDir, { force: true, recursive: true });
    await git(fixture.rootDir, "clone", control.remoteDir, fixture.projectDir);
    await writeProjectKnowledge(fixture.projectDir, { "AGENTS.md": "# Instructions\n" });
    await bootstrapWorkspace(fixture.projectDir, fixture.manifest);

    const contract = contextTaskContract([
      { repository: "@control", access: "read-only" },
      { repository: "web", access: "read-only" },
    ]);
    const workspace = await prepareTaskRunWorkspace(fixture.projectDir, {
      taskContract: contract,
      taskRunId: "run-control-readonly",
      manifest: fixture.manifest,
      control: {
        expectedUrl: control.remoteDir,
        defaultBranch: "main",
      },
    });
    const manifest = await assembleTaskRunContext(fixture.projectDir, {
      taskRunWorkspace: workspace,
      taskContract: contract,
      projectKnowledgeFiles: ["AGENTS.md"],
    });

    expect(manifest.manifest.control).toEqual({
      mode: "read-only",
      declared: true,
    });
    expect(manifest.manifest.repositories[0]).toMatchObject({
      id: "@control",
      access: "read-only",
    });
    expect(manifest.manifest.repositories[0]).not.toHaveProperty(
      "worktreePath",
    );
    await expect(stat(join(workspace.bundleRoot, "control"))).rejects.toThrow();
  }, GIT_TEST_TIMEOUT_MS);

  it("assembles @control read-write context by referencing the prepared control worktree", async () => {
    const fixture = await createProjectFixture();
    const control = await createRemoteFixture(fixture.rootDir, "control");
    await rm(fixture.projectDir, { force: true, recursive: true });
    await git(fixture.rootDir, "clone", control.remoteDir, fixture.projectDir);
    await writeProjectKnowledge(fixture.projectDir, { "AGENTS.md": "# Instructions\n" });
    await bootstrapWorkspace(fixture.projectDir, fixture.manifest);

    const contract = contextTaskContract([
      { repository: "@control", access: "read-write" },
      { repository: "web", access: "read-only" },
    ]);
    const workspace = await prepareTaskRunWorkspace(fixture.projectDir, {
      taskContract: contract,
      taskRunId: "run-control-readwrite",
      manifest: fixture.manifest,
      control: {
        expectedUrl: control.remoteDir,
        defaultBranch: "main",
      },
    });
    const manifest = await assembleTaskRunContext(fixture.projectDir, {
      taskRunWorkspace: workspace,
      taskContract: contract,
      projectKnowledgeFiles: ["AGENTS.md"],
    });

    expect(manifest.manifest.control).toEqual({
      mode: "read-write",
      declared: true,
      worktreePath: "control",
    });
    expect(manifest.manifest.repositories[0]).toMatchObject({
      id: "@control",
      access: "read-write",
      worktreePath: "control",
      mode: "branch",
    });
  }, GIT_TEST_TIMEOUT_MS);

  it("excludes secrets, other TaskRuns, .scaflow/state.db, unrelated source, and user-home-like paths", async () => {
    const fixture = await createProjectFixture();
    const control = await createRemoteFixture(fixture.rootDir, "control");
    await rm(fixture.projectDir, { force: true, recursive: true });
    await git(fixture.rootDir, "clone", control.remoteDir, fixture.projectDir);
    await writeProjectKnowledge(fixture.projectDir, {
      "AGENTS.md": "# Instructions\n",
      "docs/source/context.md": "# Context\n",
      "docs/source/secrets.md": "# Secret file path\n",
      "packages/workspace/src/unrelated.ts": "const unrelated = 'source';\n",
    });
    const outsideHome = join(fixture.rootDir, "home", ".ssh", "id_rsa");
    await mkdir(join(outsideHome, ".."), { recursive: true });
    await writeFile(outsideHome, "HOME_SECRET\n", "utf8");
    await bootstrapWorkspace(fixture.projectDir, fixture.manifest);
    const contract = contextTaskContract([{ repository: "web", access: "read-only" }]);
    const workspace = await prepareTaskRunWorkspace(fixture.projectDir, {
      taskContract: contract,
      taskRunId: "run-exclusions",
      manifest: fixture.manifest,
      control: {
        expectedUrl: control.remoteDir,
        defaultBranch: "main",
      },
    });
    await writeProjectKnowledge(fixture.projectDir, {
      ".scaflow/state.db": "STATE_SECRET\n",
      "workspace/repos/web/UNRELATED.md": "UNRELATED_SOURCE\n",
      "workspace/runs/OTHER/RUN/secret.txt": "OTHER_TASKRUN_SECRET\n",
    });

    const manifest = await assembleTaskRunContext(fixture.projectDir, {
      taskRunWorkspace: workspace,
      taskContract: contract,
      projectKnowledgeFiles: ["AGENTS.md", "docs/source/context.md"],
    });

    expect(
      manifest.manifest.files.projectKnowledge.map((entry) => entry.source),
    ).toEqual(["AGENTS.md", "docs/source/context.md"]);

    await expect(
      assembleTaskRunContext(fixture.projectDir, {
        taskRunWorkspace: workspace,
        taskContract: contract,
        projectKnowledgeFiles: [".scaflow/state.db"],
      }),
    ).rejects.toThrow("Project knowledge source is excluded");
    await expect(
      assembleTaskRunContext(fixture.projectDir, {
        taskRunWorkspace: workspace,
        taskContract: contract,
        projectKnowledgeFiles: ["workspace/repos/web/UNRELATED.md"],
      }),
    ).rejects.toThrow("Project knowledge source is excluded");
    await expect(
      assembleTaskRunContext(fixture.projectDir, {
        taskRunWorkspace: workspace,
        taskContract: contract,
        projectKnowledgeFiles: ["workspace/runs/OTHER/RUN/secret.txt"],
      }),
    ).rejects.toThrow("Project knowledge source is excluded");
    await expect(
      assembleTaskRunContext(fixture.projectDir, {
        taskRunWorkspace: workspace,
        taskContract: contract,
        projectKnowledgeFiles: ["packages/workspace/src/unrelated.ts"],
      }),
    ).rejects.toThrow("Project knowledge source is unrelated");
    await expect(
      assembleTaskRunContext(fixture.projectDir, {
        taskRunWorkspace: workspace,
        taskContract: contract,
        projectKnowledgeFiles: ["docs/source/secrets.md"],
      }),
    ).rejects.toThrow("Project knowledge source looks secret-bearing");
    await expect(
      assembleTaskRunContext(fixture.projectDir, {
        taskRunWorkspace: workspace,
        taskContract: contract,
        projectKnowledgeFiles: [outsideHome],
      }),
    ).rejects.toThrow("Project knowledge path must be relative and safe");
  }, GIT_TEST_TIMEOUT_MS);

  it("removes stale generated knowledge snapshots and failure summaries on reassembly", async () => {
    const fixture = await createProjectFixture();
    const control = await createRemoteFixture(fixture.rootDir, "control");
    await rm(fixture.projectDir, { force: true, recursive: true });
    await git(fixture.rootDir, "clone", control.remoteDir, fixture.projectDir);
    await writeProjectKnowledge(fixture.projectDir, {
      "AGENTS.md": "# Instructions\n",
      "PRODUCT.md": "# Product\n",
    });
    await bootstrapWorkspace(fixture.projectDir, fixture.manifest);
    const contract = contextTaskContract([{ repository: "web", access: "read-only" }]);
    const workspace = await prepareTaskRunWorkspace(fixture.projectDir, {
      taskContract: contract,
      taskRunId: "run-stale-context",
      manifest: fixture.manifest,
      control: {
        expectedUrl: control.remoteDir,
        defaultBranch: "main",
      },
    });

    const first = await assembleTaskRunContext(fixture.projectDir, {
      taskRunWorkspace: workspace,
      taskContract: contract,
      projectKnowledgeFiles: ["AGENTS.md", "PRODUCT.md"],
      previousFailureSummary: "Previous failure\n",
    });
    expect(first.manifest.files.projectKnowledge).toHaveLength(2);
    await expect(
      readFile(
        join(workspace.bundleRoot, "context", "project-knowledge", "01-PRODUCT.md"),
        "utf8",
      ),
    ).resolves.toBe("# Product\n");
    await expect(
      readFile(join(workspace.bundleRoot, "context", "failure-summary.md"), "utf8"),
    ).resolves.toBe("Previous failure\n");

    const second = await assembleTaskRunContext(fixture.projectDir, {
      taskRunWorkspace: workspace,
      taskContract: contract,
      projectKnowledgeFiles: ["AGENTS.md"],
    });

    expect(second.manifest.files.projectKnowledge).toEqual([
      {
        source: "AGENTS.md",
        snapshot: "context/project-knowledge/00-AGENTS.md",
      },
    ]);
    expect(second.manifest.files).not.toHaveProperty("failureSummary");
    await expect(
      readFile(
        join(workspace.bundleRoot, "context", "project-knowledge", "01-PRODUCT.md"),
        "utf8",
      ),
    ).rejects.toThrow();
    await expect(
      readFile(join(workspace.bundleRoot, "context", "failure-summary.md"), "utf8"),
    ).rejects.toThrow();
  }, GIT_TEST_TIMEOUT_MS);

  it("rejects allowed-looking project knowledge symlinks that escape canonical boundaries", async () => {
    const fixture = await createProjectFixture();
    const control = await createRemoteFixture(fixture.rootDir, "control");
    await rm(fixture.projectDir, { force: true, recursive: true });
    await git(fixture.rootDir, "clone", control.remoteDir, fixture.projectDir);
    await writeProjectKnowledge(fixture.projectDir, {
      "AGENTS.md": "# Instructions\n",
      ".scaflow/state.db": "STATE_SECRET\n",
      ".env": "OPENAI_API_KEY=SECRET\n",
      "packages/workspace/src/unrelated.ts": "const unrelated = 'source';\n",
    });
    const outsideHome = join(fixture.rootDir, "home", "notes.md");
    await mkdir(join(outsideHome, ".."), { recursive: true });
    await writeFile(outsideHome, "HOME_SECRET\n");
    await bootstrapWorkspace(fixture.projectDir, fixture.manifest);
    await writeProjectKnowledge(fixture.projectDir, {
      "workspace/runs/OTHER/RUN/README.md": "OTHER_TASKRUN\n",
    });
    await mkdir(join(fixture.projectDir, "docs"), { recursive: true });
    await symlink(outsideHome, join(fixture.projectDir, "docs", "home.md"));
    await symlink(
      join(fixture.projectDir, ".scaflow", "state.db"),
      join(fixture.projectDir, "docs", "state.md"),
    );
    await symlink(
      join(fixture.projectDir, "workspace", "repos", "web", "README.md"),
      join(fixture.projectDir, "docs", "repo.md"),
    );
    await symlink(
      join(fixture.projectDir, "workspace", "runs", "OTHER", "RUN", "README.md"),
      join(fixture.projectDir, "docs", "other-run.md"),
    );
    await symlink(
      join(fixture.projectDir, "packages", "workspace", "src", "unrelated.ts"),
      join(fixture.projectDir, "docs", "source.md"),
    );
    await mkdir(join(fixture.projectDir, "tasks", "SFL-018"), { recursive: true });
    await symlink(
      join(fixture.projectDir, ".env"),
      join(fixture.projectDir, "tasks", "SFL-018", "safe-name.md"),
    );
    const contract = contextTaskContract([{ repository: "web", access: "read-only" }]);
    const workspace = await prepareTaskRunWorkspace(fixture.projectDir, {
      taskContract: contract,
      taskRunId: "run-symlink-exclusions",
      manifest: fixture.manifest,
      control: {
        expectedUrl: control.remoteDir,
        defaultBranch: "main",
      },
    });

    for (const source of [
      "docs/home.md",
      "docs/state.md",
      "docs/repo.md",
      "docs/other-run.md",
    ]) {
      await expect(
        assembleTaskRunContext(fixture.projectDir, {
          taskRunWorkspace: workspace,
          taskContract: contract,
          projectKnowledgeFiles: [source],
        }),
      ).rejects.toThrow("Project knowledge source is excluded");
    }
    await expect(
      assembleTaskRunContext(fixture.projectDir, {
        taskRunWorkspace: workspace,
        taskContract: contract,
        projectKnowledgeFiles: ["docs/source.md"],
      }),
    ).rejects.toThrow("Project knowledge source is unrelated");
    await expect(
      assembleTaskRunContext(fixture.projectDir, {
        taskRunWorkspace: workspace,
        taskContract: contract,
        projectKnowledgeFiles: ["tasks/SFL-018/safe-name.md"],
      }),
    ).rejects.toThrow("Project knowledge source looks secret-bearing");
    await expect(
      readdir(join(workspace.bundleRoot, "context", "project-knowledge")),
    ).resolves.toEqual([]);
    await expect(
      readFile(join(workspace.bundleRoot, "context-manifest.json"), "utf8"),
    ).rejects.toThrow();
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

function contextTaskContract(
  scopes: readonly TaskRepositoryScopeLike[],
): TaskContractLike {
  const commandRepository = scopes.some((scope) => scope.repository === "@control")
    ? "@control"
    : scopes[0]?.repository ?? "web";
  return {
    task: {
      id: "SFL-018",
      title: "Context Assembler",
      definition_state: "ready",
    },
    objective: {
      summary: "Assemble TaskRun context.",
    },
    source_requirements: [
      {
        id: "FR-007",
        document: "docs/source/scaflow-v0.1.0-prd.md",
      },
    ],
    repositories: {
      primary: scopes[0]?.repository ?? "web",
      scopes,
    },
    verification: {
      commands: [
        {
          repository: commandRepository,
          executable: "pnpm",
          args: ["--filter", "@scaflow/workspace", "test"],
          timeout_seconds: 300,
          required: true,
        },
      ],
    },
  };
}

async function writeProjectKnowledge(
  projectDir: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(projectDir, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents);
  }
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
