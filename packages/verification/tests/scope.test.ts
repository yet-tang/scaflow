import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createScopeVerifier, matchesPathPattern, runVerifiers } from "../src/index";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

vi.setConfig({ testTimeout: 15_000 });

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Scope Verifier", () => {
  it("matches exact files and segment-aware globs without traversal or separator aliases", () => {
    expect(matchesPathPattern("package.json", "package.json")).toBe(true);
    expect(matchesPathPattern("packages/api/src/.hidden", "packages/**")).toBe(true);
    expect(matchesPathPattern("apps/web/package.json", "apps/*/package.json")).toBe(true);
    expect(matchesPathPattern("apps/web/deep/package.json", "apps/*/package.json")).toBe(false);
    expect(matchesPathPattern("root.ts", "**/*.ts")).toBe(true);
    expect(matchesPathPattern("src/nested.ts", "**/*.ts")).toBe(true);
    expect(matchesPathPattern("src/nested.ts", "src/**/nested.ts")).toBe(true);
    expect(matchesPathPattern("packages-other/file.ts", "packages/**")).toBe(false);
    expect(matchesPathPattern("../packages/file.ts", "packages/**")).toBe(false);
    expect(matchesPathPattern("packages\\file.ts", "packages/**")).toBe(false);
    expect(matchesPathPattern("/packages/file.ts", "packages/**")).toBe(false);
  });

  it("passes only Engine-observed changes within allowed paths", async () => {
    const fixture = await scopeFixture();
    await mkdir(join(fixture.control, "packages", "verification"), { recursive: true });
    await writeFile(join(fixture.control, "packages", "verification", ".hidden.ts"), "export {};\n");

    const result = await verify(fixture, { allowed_paths: ["packages/verification/**"] });
    expect(result.status).toBe("passed");
  });

  it("fails immediately for unauthorized and forbidden paths", async () => {
    const fixture = await scopeFixture();
    await writeFile(join(fixture.control, "outside.ts"), "bad\n");
    expect(await failureCode(fixture, { allowed_paths: ["src/**"] })).toBe("UNAUTHORIZED_PATH");

    await rm(join(fixture.control, "outside.ts"));
    await mkdir(join(fixture.control, "src"));
    await writeFile(join(fixture.control, "src", "blocked.ts"), "bad\n");
    expect(await failureCode(fixture, {
      allowed_paths: ["src/**"],
      forbidden_paths: ["src/blocked.ts"],
    })).toBe("FORBIDDEN_PATH");
  });

  it("checks both the source and destination of a rename", async () => {
    const fixture = await scopeFixture();
    await mkdir(join(fixture.control, "packages", "verification"), { recursive: true });
    await git(fixture.control, "mv", "README.md", "packages/verification/README.md");
    const result = await verify(fixture, { allowed_paths: ["packages/verification/**"] });
    expect(result.failures[0]).toMatchObject({
      code: "UNAUTHORIZED_PATH",
      details: { path: "README.md" },
    });
  });

  it("protects control-plane files independently of allowed paths", async () => {
    const fixture = await scopeFixture();
    await writeFile(join(fixture.control, "scaflow.yaml"), "engine: changed\n");
    const result = await verify(fixture, { allowed_paths: ["**"] });
    expect(result.failures[0]).toMatchObject({
      code: "PROTECTED_CONTROL_PATH",
      repairability: "non_repairable",
    });
  });

  it("rejects undeclared repository changes", async () => {
    const undeclared = await scopeFixture();
    await writeFile(join(undeclared.control, "README.md"), "changed\n");
    expect(await failureCode(undeclared, { omitScope: true })).toBe(
      "UNAUTHORIZED_REPOSITORY_CHANGE",
    );
  });

  it("does not require a control observation when @control is absent or read-only", async () => {
    const absent = await scopeFixture("read-only");
    expect((await verify(absent, { omitScope: true, repositories: [] })).status).toBe("passed");
    expect((await verify(absent, {
      access: "read-only",
      allowed_paths: [],
      repositories: [],
    })).status).toBe("passed");
  });

  it("requires a control observation only when @control is read-write", async () => {
    const fixture = await scopeFixture();
    expect((await verify(fixture, { repositories: [] })).failures[0]?.code).toBe(
      "SCOPE_EVIDENCE_INVALID",
    );
  });

  it("uses repository IDs for application worktrees and enforces read-only application scope", async () => {
    const fixture = await scopeFixture("read-only");
    const application = await addApplication(fixture, "api", "developer-api-checkout");
    fixture.revisionSet.repositories.push(application.revision);

    const passed = await verify(fixture, {
      omitScope: true,
      repositories: [application.observation],
      scopes: [{ repository: "api", access: "read-only", allowed_paths: [], forbidden_paths: [] }],
    });
    expect(passed.status).toBe("passed");

    await writeFile(join(application.cwd, "README.md"), "changed\n");
    const failed = await verify(fixture, {
      omitScope: true,
      repositories: [application.observation],
      scopes: [{ repository: "api", access: "read-only", allowed_paths: [], forbidden_paths: [] }],
    });
    expect(failed.failures[0]).toMatchObject({
      code: "READ_ONLY_REPOSITORY_CHANGE",
      repairability: "non_repairable",
    });
  });

  it("fails closed for obsolete, sibling, workspace/repos, and other-TaskRun application paths", async () => {
    const fixture = await scopeFixture("read-only");
    const application = await addApplication(fixture, "api", "developer-api-checkout");
    fixture.revisionSet.repositories.push(application.revision);
    const scopes = [{
      repository: "api",
      access: "read-only" as const,
      allowed_paths: [],
      forbidden_paths: [],
    }];

    const otherTaskRunRoot = `${fixture.taskRunRoot}-other-run`;
    temporaryDirectories.push(otherTaskRunRoot);
    const invalidTargets = [
      {
        cwd: join(fixture.taskRunRoot, "repos", "api"),
        code: "OTHER_TASK_RUN_TARGET",
      },
      {
        cwd: join(fixture.taskRunRoot, "repositories", "api-sibling"),
        code: "OTHER_TASK_RUN_TARGET",
      },
      {
        cwd: join(fixture.developerWorkspaceReposRoot, "api"),
        code: "WORKSPACE_REPOS_TARGET",
      },
      {
        cwd: join(otherTaskRunRoot, "repositories", "api"),
        code: "OTHER_TASK_RUN_TARGET",
      },
    ];

    for (const target of invalidTargets) {
      await mkdir(dirname(target.cwd), { recursive: true });
      await git(fixture.taskRunRoot, "clone", fixture.remote, target.cwd);
      const result = await verify(fixture, {
        omitScope: true,
        repositories: [{ ...application.observation, cwd: target.cwd }],
        scopes,
      });
      expect(result.failures[0]).toMatchObject({
        code: target.code,
        repairability: "non_repairable",
      });
    }
  });

  it("rejects extra observations when read-only @control has no prepared worktree", async () => {
    const fixture = await scopeFixture("read-only");
    expect((await verify(fixture, {
      access: "read-only",
      allowed_paths: [],
      repositories: [fixture.observation],
    })).failures[0]?.code).toBe("SCOPE_EVIDENCE_INVALID");
  });

  it("rejects identity mismatch as non-repairable", async () => {
    const fixture = await scopeFixture();
    fixture.revisionSet.control.identity.expected_url += "-wrong";
    const result = await verify(fixture, { allowed_paths: ["**"] });
    expect(result.failures[0]).toMatchObject({
      code: "REPOSITORY_IDENTITY_MISMATCH",
      repairability: "non_repairable",
    });
  });

  it("fails closed for incomplete, duplicate, and other-TaskRun observations", async () => {
    const fixture = await scopeFixture();
    expect((await verify(fixture, { repositories: [] })).failures[0]?.code).toBe("SCOPE_EVIDENCE_INVALID");
    expect((await verify(fixture, { repositories: [fixture.observation, fixture.observation] })).failures[0]?.code).toBe("SCOPE_EVIDENCE_INVALID");
    expect((await verify(fixture, {
      repositories: [{ ...fixture.observation, taskRunId: "another-run" }],
    })).failures[0]).toMatchObject({ code: "OTHER_TASK_RUN_TARGET", repairability: "non_repairable" });
    expect((await verify(fixture, {
      repositories: [{ ...fixture.observation, repositoryId: "undeclared" }],
    })).failures[0]).toMatchObject({ code: "UNAUTHORIZED_REPOSITORY_CHANGE", repairability: "non_repairable" });
    expect((await verify(fixture, {
      preparedTaskRunId: "another-run",
    })).failures[0]).toMatchObject({ code: "OTHER_TASK_RUN_TARGET", repairability: "non_repairable" });
  });

  it("never accepts workspace/repos as a formal TaskRun target", async () => {
    const fixture = await scopeFixture();
    const workspaceRepo = join(fixture.developerWorkspaceReposRoot, "control");
    await git(fixture.taskRunRoot, "clone", fixture.remote, workspaceRepo);
    const result = await verify(fixture, {
      repositories: [{ ...fixture.observation, cwd: workspaceRepo }],
    });
    expect(result.failures[0]).toMatchObject({
      code: "WORKSPACE_REPOS_TARGET",
      repairability: "non_repairable",
    });
  });

  it.each(["direct", "symlink"] as const)(
    "rejects a prepared control TaskRun root beneath workspace/repos through a %s path",
    async (rootKind) => {
      const fixture = await scopeFixture("read-write", rootKind === "direct"
        ? "developer-workspace"
        : "developer-workspace-symlink");
      await writeFile(join(fixture.control, "README.md"), "changed\n");

      const result = await verify(fixture, { allowed_paths: ["**"] });

      expect(result.failures[0]).toMatchObject({
        code: "WORKSPACE_REPOS_TARGET",
        repairability: "non_repairable",
      });
    },
  );

  it("rejects a prepared application TaskRun root beneath workspace/repos", async () => {
    const fixture = await scopeFixture("read-only", "developer-workspace");
    const application = await addApplication(fixture, "api", "developer-api-checkout");
    fixture.revisionSet.repositories.push(application.revision);

    const result = await verify(fixture, {
      omitScope: true,
      repositories: [application.observation],
      scopes: [{
        repository: "api",
        access: "read-only",
        allowed_paths: [],
        forbidden_paths: [],
      }],
    });

    expect(result.failures[0]).toMatchObject({
      code: "WORKSPACE_REPOS_TARGET",
      repairability: "non_repairable",
    });
  });

  it("does not confuse workspace/repos with a similarly named sibling", async () => {
    const fixture = await scopeFixture("read-write", "similarly-named-sibling");
    await writeFile(join(fixture.control, "README.md"), "changed\n");
    expect((await verify(fixture, { allowed_paths: ["**"] })).status).toBe("passed");
  });
});

interface ScopeFixture {
  taskRunRoot: string;
  developerWorkspaceReposRoot: string;
  control: string;
  remote: string;
  observation: { repositoryId: string; cwd: string; taskRunId: string };
  revisionSet: any;
}

async function scopeFixture(
  access: "read-only" | "read-write" = "read-write",
  placement: "isolated" | "developer-workspace" | "developer-workspace-symlink" |
    "similarly-named-sibling" = "isolated",
): Promise<ScopeFixture> {
  const projectRoot = await mkdtemp(join(tmpdir(), "scaflow-scope-project-"));
  temporaryDirectories.push(projectRoot);
  const developerWorkspaceReposRoot = join(projectRoot, "workspace", "repos");
  await mkdir(developerWorkspaceReposRoot, { recursive: true });
  const canonicalTaskRunRoot = placement === "developer-workspace" ||
      placement === "developer-workspace-symlink"
    ? join(developerWorkspaceReposRoot, "fake-run")
    : placement === "similarly-named-sibling"
    ? join(projectRoot, "workspace", "repos-other", "fake-run")
    : join(projectRoot, "workspace", "runs", "SFL-022", "run-1");
  await mkdir(canonicalTaskRunRoot, { recursive: true });
  const taskRunRoot = placement === "developer-workspace-symlink"
    ? join(projectRoot, "task-run-alias")
    : canonicalTaskRunRoot;
  if (placement === "developer-workspace-symlink") {
    await symlink(canonicalTaskRunRoot, taskRunRoot, "dir");
  }
  await mkdir(taskRunRoot, { recursive: true });
  const source = join(taskRunRoot, "source");
  const remote = join(taskRunRoot, "remote.git");
  const control = join(taskRunRoot, "control");
  await mkdir(source);
  await git(source, "init");
  await git(source, "config", "user.name", "Scaflow Test");
  await git(source, "config", "user.email", "scaflow@example.invalid");
  await writeFile(join(source, "README.md"), "initial\n");
  await git(source, "add", "README.md");
  await git(source, "commit", "-m", "Initial");
  await git(source, "init", "--bare", remote);
  await git(source, "remote", "add", "origin", remote);
  await git(source, "push", "origin", "HEAD:main");
  await git(taskRunRoot, "clone", remote, control);
  const baseCommit = (await git(control, "rev-parse", "HEAD")).trim();
  return {
    taskRunRoot,
    developerWorkspaceReposRoot,
    control,
    remote,
    observation: { repositoryId: "@control", cwd: control, taskRunId: "run-1" },
    revisionSet: {
      version: 1,
      control: {
        id: "@control",
        base_commit: baseCommit,
        access,
        default_branch: "main",
        checkout_directory: ".",
        identity: { remote: "origin", expected_url: remote, actual_url: remote },
      },
      repositories: [],
    },
  };
}

async function verify(
  fixture: ScopeFixture,
  overrides: {
    access?: "read-only" | "read-write";
    allowed_paths?: string[];
    forbidden_paths?: string[];
    omitScope?: boolean;
    preparedTaskRunId?: string;
    repositories?: ScopeFixture["observation"][];
    scopes?: Array<{
      repository: string;
      access: "read-only" | "read-write";
      allowed_paths: string[];
      forbidden_paths: string[];
    }>;
  },
) {
  const scopes = overrides.scopes ?? (overrides.omitScope ? [] : [{
    repository: "@control",
    access: overrides.access ?? "read-write",
    allowed_paths: overrides.allowed_paths ?? ["**"],
    forbidden_paths: overrides.forbidden_paths ?? [],
  }]);
  return runVerifiers([createScopeVerifier({
    preparedWorkspace: {
      taskRunId: overrides.preparedTaskRunId ?? "run-1",
      taskRunRoot: fixture.taskRunRoot,
      developerWorkspaceReposRoot: fixture.developerWorkspaceReposRoot,
    },
    revisionSet: fixture.revisionSet,
    scopes,
    repositories: overrides.repositories ?? [fixture.observation],
  })], { taskRunId: "run-1", evidence: [] }, { stopPolicy: "stop_on_failure" });
}

async function addApplication(fixture: ScopeFixture, id: string, checkoutDirectory: string) {
  const cwd = join(fixture.taskRunRoot, "repositories", id);
  await mkdir(join(fixture.taskRunRoot, "repositories"), { recursive: true });
  await git(fixture.taskRunRoot, "clone", fixture.remote, cwd);
  const baseCommit = (await git(cwd, "rev-parse", "HEAD")).trim();
  return {
    cwd,
    observation: { repositoryId: id, cwd, taskRunId: "run-1" },
    revision: {
      id,
      base_commit: baseCommit,
      access: "read-only",
      default_branch: "main",
      checkout_directory: checkoutDirectory,
      identity: { remote: "origin", expected_url: fixture.remote, actual_url: fixture.remote },
    },
  };
}

async function failureCode(fixture: ScopeFixture, overrides: Parameters<typeof verify>[1]) {
  return (await verify(fixture, overrides)).failures[0]?.code;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return result.stdout;
}
