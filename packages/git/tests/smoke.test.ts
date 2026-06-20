import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  GitError,
  checkRepositoryIdentity,
  cloneRepository,
  fetchRepository,
  getHeadCommit,
  getRemoteUrl,
  getRepositoryStatus,
  packageName,
  serializeGitError,
} from "../src/index";

const execFileAsync = promisify(execFile);

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

describe("@scaflow/git", () => {
  it("exposes package identity", () => {
    expect(packageName).toBe("@scaflow/git");
  });

  it("requires explicit cwd and target directory for clone", async () => {
    await expect(
      cloneRepository({
        cwd: "",
        sourceUrl: "file:///tmp/source.git",
        targetDir: "checkout",
      }),
    ).rejects.toMatchObject({
      code: "GIT_INVALID_WORKING_DIRECTORY",
      details: {
        operation: "clone",
      },
    });
  });

  it("clones, fetches, reads status, remote URL, and HEAD using explicit directories", async () => {
    const fixture = await createRepositoryFixture();

    await cloneRepository({
      cwd: fixture.parentDir,
      sourceUrl: fixture.remoteDir,
      targetDir: fixture.cloneDir,
    });

    expect(await getRemoteUrl({ cwd: fixture.cloneDir })).toBe(fixture.remoteDir);
    expect(await getHeadCommit({ cwd: fixture.cloneDir })).toMatch(/^[0-9a-f]{40}$/);
    await expect(fetchRepository({ cwd: fixture.cloneDir })).resolves.toBeUndefined();

    let status = await getRepositoryStatus({ cwd: fixture.cloneDir });
    expect(status.clean).toBe(true);
    expect(status.porcelain).toBe("");

    await writeFile(join(fixture.cloneDir, "untracked.txt"), "untracked\n");
    status = await getRepositoryStatus({ cwd: fixture.cloneDir });
    expect(status.clean).toBe(false);
    expect(status.porcelain).toContain("?? untracked.txt");
  });

  it("detects matching, mismatched, missing remote, and missing repository identity", async () => {
    const fixture = await createRepositoryFixture();

    await cloneRepository({
      cwd: fixture.parentDir,
      sourceUrl: fixture.remoteDir,
      targetDir: fixture.cloneDir,
    });

    await expect(
      checkRepositoryIdentity({
        cwd: fixture.cloneDir,
        expectedUrl: fixture.remoteDir,
      }),
    ).resolves.toMatchObject({
      status: "matching",
      actualUrl: fixture.remoteDir,
      expectedUrl: fixture.remoteDir,
    });

    const mismatch = await checkRepositoryIdentity({
      cwd: fixture.cloneDir,
      expectedUrl: `${fixture.remoteDir}-other`,
    });
    expect(mismatch).toMatchObject({
      status: "mismatched",
      actualUrl: fixture.remoteDir,
    });
    expect(mismatch.status === "mismatched" && mismatch.error).toBeInstanceOf(GitError);
    expect(mismatch.status === "mismatched" && mismatch.error.code).toBe(
      "GIT_REMOTE_MISMATCH",
    );

    await git(fixture.cloneDir, "remote", "remove", "origin");
    const missingRemote = await checkRepositoryIdentity({
      cwd: fixture.cloneDir,
      expectedUrl: fixture.remoteDir,
    });
    expect(missingRemote).toMatchObject({
      status: "missing_remote",
    });
    expect(
      missingRemote.status === "missing_remote" && missingRemote.error.code,
    ).toBe("GIT_REMOTE_MISSING");

    const nonRepoDir = join(fixture.parentDir, "not-a-repo");
    await mkdir(nonRepoDir);
    const missingRepository = await checkRepositoryIdentity({
      cwd: nonRepoDir,
      expectedUrl: fixture.remoteDir,
    });
    expect(missingRepository).toMatchObject({
      status: "missing_repository",
    });
    expect(
      missingRepository.status === "missing_repository" &&
        missingRepository.error.code,
    ).toBe("GIT_NOT_REPOSITORY");
  });

  it("normalizes Git command failures into structured redacted GitError values", async () => {
    const fixture = await createRepositoryFixture();

    await cloneRepository({
      cwd: fixture.parentDir,
      sourceUrl: fixture.remoteDir,
      targetDir: fixture.cloneDir,
    });

    await expect(getRemoteUrl({ cwd: fixture.cloneDir, remote: "missing" }))
      .rejects.toBeInstanceOf(GitError);

    try {
      await getRemoteUrl({ cwd: fixture.cloneDir, remote: "missing" });
      throw new Error("expected getRemoteUrl to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GitError);
      const gitError = error as GitError;
      expect(gitError.code).toBe("GIT_REMOTE_MISSING");
      expect(gitError.details).toMatchObject({
        operation: "remote-url",
        cwd: fixture.cloneDir,
        args: ["remote", "get-url", "missing"],
        exitStatus: 2,
      });

      const serialized = serializeGitError(gitError);
      expect(serialized).toMatchObject({
        name: "GitError",
        code: "GIT_REMOTE_MISSING",
      });
      expect(JSON.stringify(serialized)).not.toContain("bearer secret-token");
    }

    const redacted = serializeGitError(
      new GitError("failed token=super-secret", "GIT_COMMAND_FAILED", {
        operation: "fetch",
        cwd: fixture.cloneDir,
        args: ["fetch", "https://example.invalid/repo?token=super-secret"],
        stderr: "authorization: bearer secret-token",
      }),
    );
    expect(JSON.stringify(redacted)).not.toContain("super-secret");
    expect(JSON.stringify(redacted)).not.toContain("secret-token");
    expect(JSON.stringify(redacted)).toContain("[REDACTED]");
  });
});

async function createRepositoryFixture(): Promise<{
  parentDir: string;
  sourceDir: string;
  remoteDir: string;
  cloneDir: string;
}> {
  const parentDir = await mkdtemp(join(tmpdir(), "scaflow-git-test-"));
  tempDirs.push(parentDir);

  const sourceDir = join(parentDir, "source");
  const remoteDir = join(parentDir, "remote.git");
  const cloneDir = join(parentDir, "clone");

  await mkdir(sourceDir);
  await git(sourceDir, "init");
  await git(sourceDir, "config", "user.name", "Scaflow Test");
  await git(sourceDir, "config", "user.email", "scaflow@example.invalid");
  await writeFile(join(sourceDir, "README.md"), "# fixture\n");
  await git(sourceDir, "add", "README.md");
  await git(sourceDir, "commit", "-m", "Initial commit");
  await git(sourceDir, "init", "--bare", remoteDir);
  await git(sourceDir, "remote", "add", "origin", remoteDir);
  await git(sourceDir, "push", "origin", "HEAD:main");

  return {
    parentDir,
    sourceDir,
    remoteDir,
    cloneDir,
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });

  return stdout;
}
