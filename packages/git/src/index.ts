import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const packageName = "@scaflow/git";

export type GitOperation =
  | "branch"
  | "clone"
  | "diff"
  | "fetch"
  | "freeze-revision"
  | "head"
  | "identity"
  | "remote-url"
  | "status"
  | "worktree";

export type GitErrorCode =
  | "GIT_COMMAND_FAILED"
  | "GIT_INVALID_WORKING_DIRECTORY"
  | "GIT_NOT_REPOSITORY"
  | "GIT_REMOTE_MISMATCH"
  | "GIT_REMOTE_MISSING"
  | "GIT_SPAWN_FAILED";

export interface GitErrorDetails {
  operation: GitOperation;
  cwd?: string;
  targetDir?: string;
  args?: string[];
  exitStatus?: number;
  stdout?: string;
  stderr?: string;
  cause?: string;
}

export class GitError extends Error {
  declare readonly code: GitErrorCode;
  declare readonly details: GitErrorDetails;

  constructor(message: string, code: GitErrorCode, details: GitErrorDetails) {
    super(redactText(message));
    this.name = "GitError";
    Object.defineProperties(this, {
      code: stableMetadata(code),
      details: stableMetadata(redactGitDetails(details)),
    });
  }

  toJSON(): SerializedGitError {
    return serializeGitError(this);
  }
}

export interface SerializedGitError {
  name: "GitError";
  message: string;
  code: GitErrorCode;
  details: GitErrorDetails;
}

export interface CloneRepositoryOptions {
  cwd: string;
  sourceUrl: string;
  targetDir: string;
}

export interface FetchRepositoryOptions {
  cwd: string;
  remote?: string;
}

export interface RepositoryStatusOptions {
  cwd: string;
}

export interface HeadCommitOptions {
  cwd: string;
}

export interface RemoteUrlOptions {
  cwd: string;
  remote?: string;
}

export interface RepositoryIdentityOptions {
  cwd: string;
  remote?: string;
  expectedUrl: string;
}

export interface AddDetachedWorktreeOptions {
  sourceCwd: string;
  targetDir: string;
  commit: string;
}

export interface AddBranchWorktreeOptions {
  sourceCwd: string;
  targetDir: string;
  branchName: string;
  commit: string;
}

export type RepositoryAccessMode = "read-only" | "read-write";

export interface FreezeRepositoryRevisionOptions {
  id: string;
  cwd: string;
  access: RepositoryAccessMode;
  expectedUrl: string;
  defaultBranch: string;
  checkoutDirectory: string;
  remote?: string;
}

export interface FreezeRevisionSetOptions {
  control: FreezeRepositoryRevisionOptions & { id: "@control" };
  repositories: readonly FreezeRepositoryRevisionOptions[];
}

export interface RepositoryStatus {
  clean: boolean;
  porcelain: string;
}

export type GitChangeSource = "committed" | "staged" | "unstaged" | "untracked";

export interface GitChangedPath {
  readonly source: GitChangeSource;
  readonly status: string;
  readonly path: string;
  readonly originalPath?: string;
}

export interface RepositoryChangesOptions {
  readonly cwd: string;
  readonly baseCommit: string;
}

export type RepositoryIdentityResult =
  | {
      status: "matching";
      cwd: string;
      remote: string;
      expectedUrl: string;
      actualUrl: string;
    }
  | {
      status: "mismatched";
      cwd: string;
      remote: string;
      expectedUrl: string;
      actualUrl: string;
      error: GitError;
    }
  | {
      status: "missing_remote";
      cwd: string;
      remote: string;
      expectedUrl: string;
      error: GitError;
    }
  | {
      status: "missing_repository";
      cwd: string;
      remote: string;
      expectedUrl: string;
      error: GitError;
    };

export interface FrozenRepositoryRevision {
  readonly id: string;
  readonly base_commit: string;
  readonly access: RepositoryAccessMode;
  readonly default_branch: string;
  readonly checkout_directory: string;
  readonly identity: {
    readonly remote: string;
    readonly expected_url: string;
    readonly actual_url: string;
  };
}

export interface FrozenRevisionSet {
  readonly version: 1;
  readonly control: FrozenRepositoryRevision & { readonly id: "@control" };
  readonly repositories: readonly FrozenRepositoryRevision[];
}

interface RunGitOptions {
  operation: GitOperation;
  cwd: string;
  args: string[];
}

interface ExecFileFailure extends Error {
  code?: unknown;
  signal?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

const DEFAULT_REMOTE = "origin";

export async function cloneRepository(
  options: CloneRepositoryOptions,
): Promise<void> {
  assertExplicitDirectory(options.cwd, "cwd", "clone");
  assertExplicitDirectory(options.targetDir, "targetDir", "clone");

  await runGit({
    operation: "clone",
    cwd: options.cwd,
    args: ["clone", options.sourceUrl, options.targetDir],
  });
}

export async function fetchRepository(
  options: FetchRepositoryOptions,
): Promise<void> {
  const remote = options.remote ?? DEFAULT_REMOTE;
  await runGit({
    operation: "fetch",
    cwd: options.cwd,
    args: ["fetch", remote],
  });
}

export async function getRepositoryStatus(
  options: RepositoryStatusOptions,
): Promise<RepositoryStatus> {
  const result = await runGit({
    operation: "status",
    cwd: options.cwd,
    args: ["status", "--porcelain=v1"],
  });
  const porcelain = result.stdout.trimEnd();

  return {
    clean: porcelain.length === 0,
    porcelain,
  };
}

/**
 * Observes every path changed since a frozen base, including committed, index,
 * worktree, rename/copy endpoints, and untracked changes. This function is
 * deliberately read-only and always binds Git to the supplied repository cwd.
 */
export async function getRepositoryChanges(
  options: RepositoryChangesOptions,
): Promise<readonly GitChangedPath[]> {
  assertExplicitDirectory(options.cwd, "cwd", "diff");
  if (!/^[0-9a-f]{40}$/.test(options.baseCommit)) {
    throw new GitError("Git base commit must be a full lowercase SHA-1", "GIT_COMMAND_FAILED", {
      operation: "diff",
      cwd: options.cwd,
      args: ["diff", options.baseCommit, "HEAD"],
    });
  }

  const [committed, staged, unstaged, untracked] = await Promise.all([
    runGit({
      operation: "diff",
      cwd: options.cwd,
      args: ["diff", "--name-status", "-z", "--find-renames", "--find-copies-harder", options.baseCommit, "HEAD"],
    }),
    runGit({
      operation: "diff",
      cwd: options.cwd,
      args: ["diff", "--cached", "--name-status", "-z", "--find-renames", "--find-copies-harder"],
    }),
    runGit({
      operation: "diff",
      cwd: options.cwd,
      args: ["diff", "--name-status", "-z", "--find-renames", "--find-copies-harder"],
    }),
    runGit({
      operation: "diff",
      cwd: options.cwd,
      args: ["ls-files", "--others", "--exclude-standard", "-z"],
    }),
  ]);

  return [
    ...parseNameStatus(committed.stdout, "committed"),
    ...parseNameStatus(staged.stdout, "staged"),
    ...parseNameStatus(unstaged.stdout, "unstaged"),
    ...parseUntracked(untracked.stdout),
  ];
}

export async function getHeadCommit(
  options: HeadCommitOptions,
): Promise<string> {
  const result = await runGit({
    operation: "head",
    cwd: options.cwd,
    args: ["rev-parse", "HEAD"],
  });

  return result.stdout.trim();
}

export async function getRepositoryRoot(
  options: HeadCommitOptions,
): Promise<string> {
  const result = await runGit({
    operation: "identity",
    cwd: options.cwd,
    args: ["rev-parse", "--show-toplevel"],
  });

  return result.stdout.trim();
}

export async function getCurrentBranch(
  options: HeadCommitOptions,
): Promise<string | null> {
  try {
    const result = await runGit({
      operation: "branch",
      cwd: options.cwd,
      args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
    });

    return result.stdout.trim();
  } catch (error) {
    if (isGitErrorWithExitStatus(error, 1)) {
      return null;
    }
    throw error;
  }
}

export async function addDetachedWorktree(
  options: AddDetachedWorktreeOptions,
): Promise<void> {
  assertExplicitDirectory(options.sourceCwd, "cwd", "worktree");
  assertExplicitDirectory(options.targetDir, "targetDir", "worktree");

  await runGit({
    operation: "worktree",
    cwd: options.sourceCwd,
    args: ["worktree", "add", "--detach", options.targetDir, options.commit],
  });
}

export async function addBranchWorktree(
  options: AddBranchWorktreeOptions,
): Promise<void> {
  assertExplicitDirectory(options.sourceCwd, "cwd", "worktree");
  assertExplicitDirectory(options.targetDir, "targetDir", "worktree");

  await runGit({
    operation: "worktree",
    cwd: options.sourceCwd,
    args: [
      "worktree",
      "add",
      "-b",
      options.branchName,
      options.targetDir,
      options.commit,
    ],
  });
}

export async function getRemoteUrl(options: RemoteUrlOptions): Promise<string> {
  const remote = options.remote ?? DEFAULT_REMOTE;
  try {
    const result = await runGit({
      operation: "remote-url",
      cwd: options.cwd,
      args: ["remote", "get-url", remote],
    });

    return result.stdout.trim();
  } catch (error) {
    if (isMissingRemoteError(error)) {
      throw createRemoteMissingError(options.cwd, remote, error);
    }
    throw error;
  }
}

export async function checkRepositoryIdentity(
  options: RepositoryIdentityOptions,
): Promise<RepositoryIdentityResult> {
  const remote = options.remote ?? DEFAULT_REMOTE;

  try {
    await runGit({
      operation: "identity",
      cwd: options.cwd,
      args: ["rev-parse", "--is-inside-work-tree"],
    });
  } catch (error) {
    if (!isGitErrorWithCode(error, "GIT_COMMAND_FAILED")) {
      throw error;
    }

    return {
      status: "missing_repository",
      cwd: options.cwd,
      remote,
      expectedUrl: options.expectedUrl,
      error: createNotRepositoryError(options.cwd, error),
    };
  }

  try {
    const actualUrl = await getRemoteUrl({ cwd: options.cwd, remote });
    if (normalizeRemoteUrl(actualUrl) === normalizeRemoteUrl(options.expectedUrl)) {
      return {
        status: "matching",
        cwd: options.cwd,
        remote,
        expectedUrl: options.expectedUrl,
        actualUrl,
      };
    }

    return {
      status: "mismatched",
      cwd: options.cwd,
      remote,
      expectedUrl: options.expectedUrl,
      actualUrl,
      error: new GitError("Git remote URL does not match expected identity", "GIT_REMOTE_MISMATCH", {
        operation: "identity",
        cwd: options.cwd,
        args: ["remote", "get-url", remote],
        stderr: `expected=${options.expectedUrl} actual=${actualUrl}`,
      }),
    };
  } catch (error) {
    if (isGitErrorWithCode(error, "GIT_REMOTE_MISSING")) {
      return {
        status: "missing_remote",
        cwd: options.cwd,
        remote,
        expectedUrl: options.expectedUrl,
        error,
      };
    }
    throw error;
  }
}

export async function freezeRepositoryRevision(
  options: FreezeRepositoryRevisionOptions,
): Promise<FrozenRepositoryRevision> {
  assertExplicitDirectory(options.cwd, "cwd", "freeze-revision");

  const remote = options.remote ?? DEFAULT_REMOTE;
  const identity = await checkRepositoryIdentity({
    cwd: options.cwd,
    remote,
    expectedUrl: options.expectedUrl,
  });
  if (identity.status !== "matching") {
    throw identity.error;
  }

  const baseCommit = await getHeadCommit({ cwd: options.cwd });

  return {
    id: options.id,
    base_commit: baseCommit,
    access: options.access,
    default_branch: options.defaultBranch,
    checkout_directory: options.checkoutDirectory,
    identity: {
      remote,
      expected_url: options.expectedUrl,
      actual_url: identity.actualUrl,
    },
  };
}

export async function freezeRevisionSet(
  options: FreezeRevisionSetOptions,
): Promise<FrozenRevisionSet> {
  const control = await freezeRepositoryRevision(options.control);
  return {
    version: 1,
    control: {
      ...control,
      id: "@control",
    },
    repositories: await Promise.all(
      options.repositories.map((repository) =>
        freezeRepositoryRevision(repository),
      ),
    ),
  };
}

export function serializeGitError(error: GitError): SerializedGitError {
  return {
    name: "GitError",
    message: redactText(error.message),
    code: error.code,
    details: redactGitDetails(error.details),
  };
}

async function runGit(options: RunGitOptions): Promise<{ stdout: string; stderr: string }> {
  assertExplicitDirectory(options.cwd, "cwd", options.operation);

  try {
    const result = await execFileAsync("git", options.args, {
      cwd: options.cwd,
      encoding: "utf8",
      windowsHide: true,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    throw normalizeGitProcessError(error, options);
  }
}

function normalizeGitProcessError(error: unknown, options: RunGitOptions): GitError {
  const failure = error as Partial<ExecFileFailure>;
  const stdout = asString(failure.stdout);
  const stderr = asString(failure.stderr);
  const exitStatus = typeof failure.code === "number" ? failure.code : undefined;
  const code = exitStatus === undefined ? "GIT_SPAWN_FAILED" : "GIT_COMMAND_FAILED";

  return new GitError(
    code === "GIT_SPAWN_FAILED"
      ? "Git process could not be started"
      : "Git command failed",
    code,
    compactGitDetails({
      operation: options.operation,
      cwd: options.cwd,
      args: options.args,
      exitStatus,
      stdout,
      stderr,
      cause: error instanceof Error ? error.message : String(error),
    }),
  );
}

function createNotRepositoryError(cwd: string, cause: unknown): GitError {
  return new GitError("Directory is not a Git repository", "GIT_NOT_REPOSITORY", {
    operation: "identity",
    cwd,
    args: ["rev-parse", "--is-inside-work-tree"],
    cause: cause instanceof Error ? cause.message : String(cause),
  });
}

function createRemoteMissingError(
  cwd: string,
  remote: string,
  cause: unknown,
): GitError {
  const causeDetails = cause instanceof GitError ? cause.details : undefined;

  return new GitError("Git remote is missing", "GIT_REMOTE_MISSING", compactGitDetails({
    operation: "remote-url",
    cwd,
    args: ["remote", "get-url", remote],
    exitStatus: causeDetails?.exitStatus,
    stdout: causeDetails?.stdout,
    stderr: causeDetails?.stderr,
    cause: cause instanceof Error ? cause.message : String(cause),
  }));
}

function assertExplicitDirectory(
  path: string,
  fieldName: "cwd" | "targetDir",
  operation: GitOperation,
): void {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new GitError(
      `Git ${fieldName} must be an explicit non-empty path`,
      "GIT_INVALID_WORKING_DIRECTORY",
      {
        operation,
        [fieldName]: path,
      },
    );
  }
}

function isMissingRemoteError(error: unknown): boolean {
  if (!(error instanceof GitError)) {
    return false;
  }

  const stderr = error.details.stderr ?? "";
  return /No such remote|No such remote '.*'/.test(stderr);
}

function isGitErrorWithCode<TCode extends GitErrorCode>(
  error: unknown,
  code: TCode,
): error is GitError & { code: TCode } {
  return error instanceof GitError && error.code === code;
}

function isGitErrorWithExitStatus(
  error: unknown,
  exitStatus: number,
): error is GitError {
  return error instanceof GitError && error.details.exitStatus === exitStatus;
}

function normalizeRemoteUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function stableMetadata(value: unknown): PropertyDescriptor {
  return {
    value,
    enumerable: true,
    writable: false,
    configurable: false,
  };
}

function redactGitDetails(details: GitErrorDetails): GitErrorDetails {
  return compactGitDetails({
    ...details,
    args: details.args?.map(redactText),
    stdout: details.stdout === undefined ? undefined : redactText(details.stdout),
    stderr: details.stderr === undefined ? undefined : redactText(details.stderr),
    cause: details.cause === undefined ? undefined : redactText(details.cause),
  });
}

function compactGitDetails(
  details: {
    operation: GitOperation;
    args?: string[] | undefined;
    cause?: string | undefined;
    cwd?: string | undefined;
    exitStatus?: number | undefined;
    stderr?: string | undefined;
    stdout?: string | undefined;
    targetDir?: string | undefined;
  },
): GitErrorDetails {
  const output: GitErrorDetails = {
    operation: details.operation,
  };

  if (details.cwd !== undefined) {
    output.cwd = details.cwd;
  }
  if (details.targetDir !== undefined) {
    output.targetDir = details.targetDir;
  }
  if (details.args !== undefined) {
    output.args = details.args;
  }
  if (details.exitStatus !== undefined) {
    output.exitStatus = details.exitStatus;
  }
  if (details.stdout !== undefined) {
    output.stdout = details.stdout;
  }
  if (details.stderr !== undefined) {
    output.stderr = details.stderr;
  }
  if (details.cause !== undefined) {
    output.cause = details.cause;
  }

  return output;
}

function redactText(value: string): string {
  return value
    .replace(
      /([?&](?:api[-_]?key|client[-_]?secret|password|passwd|private[-_]?key|refresh[-_]?token|secret|token)=)([^&#\s]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(bearer|basic)\s+[a-z0-9._~+/=-]+/gi, (_match, scheme: string) => {
      return `${scheme} [REDACTED]`;
    })
    .replace(
      /(^|[^A-Za-z0-9_-])([A-Za-z][A-Za-z0-9_-]*)(\s*[:=]\s*)([^\s,;}"']+)/gi,
      (match, prefix: string, name: string, separator: string) => {
        return isSecretKey(name) ? `${prefix}${name}${separator}[REDACTED]` : match;
      },
    );
}

function isSecretKey(key: string): boolean {
  const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return /(?:^|[-_])(?:api[-_]?key|authorization|client[-_]?secret|cookie|credential|password|passwd|private[-_]?key|refresh[-_]?token|secret|set[-_]?cookie|token)(?:$|[-_])/i.test(
    normalizedKey,
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseNameStatus(output: string, source: Exclude<GitChangeSource, "untracked">): GitChangedPath[] {
  if (output.length === 0) {
    return [];
  }
  const fields = output.split("\0");
  if (fields.at(-1) === "") {
    fields.pop();
  }
  const changes: GitChangedPath[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const path = fields[index++];
    if (status === undefined || path === undefined || status.length === 0 || path.length === 0) {
      throw new GitError("Git returned malformed changed-path evidence", "GIT_COMMAND_FAILED", {
        operation: "diff",
        cause: `source=${source}`,
      });
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      const destination = fields[index++];
      if (destination === undefined || destination.length === 0) {
        throw new GitError("Git returned malformed rename/copy evidence", "GIT_COMMAND_FAILED", {
          operation: "diff",
          cause: `source=${source}`,
        });
      }
      changes.push({ source, status, originalPath: path, path: destination });
    } else {
      changes.push({ source, status, path });
    }
  }
  return changes;
}

function parseUntracked(output: string): GitChangedPath[] {
  return output
    .split("\0")
    .filter((path) => path.length > 0)
    .map((path) => ({ source: "untracked", status: "?", path }));
}
