import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const packageName = "@scaflow/workspace";

export const WORKSPACE_DIR = "workspace";
export const WORKSPACE_REPOS_DIR = "workspace/repos";
export const WORKSPACE_MANIFEST_FILE = "workspace/manifest.json";

export type WorkspaceRepositoryState =
  | "cloned"
  | "fetched"
  | "missing"
  | "failed";

export interface RepositoryManifestEntryLike {
  readonly id: string;
  readonly name?: string;
  readonly git_url: string;
  readonly default_branch: string;
  readonly checkout_directory: string;
  readonly type?: string;
}

export interface RepositoryManifestLike {
  readonly repositories: readonly RepositoryManifestEntryLike[];
}

export type RepositoryAccessMode = "read-only" | "read-write";

export interface TaskRepositoryScopeLike {
  readonly repository: string;
  readonly access: RepositoryAccessMode;
}

export interface FreezeWorkspaceRevisionSetOptions {
  readonly control: {
    readonly cwd?: string;
    readonly expectedUrl: string;
    readonly defaultBranch: string;
    readonly checkoutDirectory?: string;
  };
  readonly manifest: RepositoryManifestLike;
  readonly scopes: readonly TaskRepositoryScopeLike[];
}

export interface WorkspaceRepositoryResult {
  readonly id: string;
  readonly checkoutDirectory: string;
  readonly checkoutPath: string;
  readonly expectedUrl: string;
  readonly state: WorkspaceRepositoryState;
  readonly action: "clone" | "fetch" | "inspect" | "none";
  readonly identity: "matching" | "mismatched" | "missing_remote" | "missing_repository" | "unknown";
  readonly clean?: boolean;
  readonly head?: string;
  readonly error?: SerializedWorkspaceError;
}

export interface BootstrapWorkspaceResult {
  readonly ok: boolean;
  readonly workspaceDirectory: string;
  readonly repositoriesDirectory: string;
  readonly manifestPath: string;
  readonly repositories: readonly WorkspaceRepositoryResult[];
}

export interface WorkspaceStatusResult {
  readonly ok: boolean;
  readonly workspaceDirectory: string;
  readonly repositoriesDirectory: string;
  readonly manifestPath: string;
  readonly manifestPresent: boolean;
  readonly repositories: readonly WorkspaceRepositoryResult[];
}

export interface WorkspaceManifest {
  readonly version: 1;
  readonly workspace: {
    readonly reposDirectory: string;
  };
  readonly repositories: readonly WorkspaceManifestRepository[];
}

export interface WorkspaceManifestRepository {
  readonly id: string;
  readonly checkoutDirectory: string;
  readonly checkoutPath: string;
  readonly expectedUrl: string;
  readonly defaultBranch: string;
  readonly observed: {
    readonly identity: WorkspaceRepositoryResult["identity"];
    readonly clean?: boolean;
    readonly head?: string;
  };
  readonly lastResult: {
    readonly state: WorkspaceRepositoryState;
    readonly action: WorkspaceRepositoryResult["action"];
    readonly error?: SerializedWorkspaceError;
  };
}

export interface WorkspaceRevisionSetRepository {
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

export interface WorkspaceRevisionSet {
  readonly version: 1;
  readonly control: WorkspaceRevisionSetRepository & { readonly id: "@control" };
  readonly repositories: readonly WorkspaceRevisionSetRepository[];
}

export interface SerializedWorkspaceError {
  readonly name: string;
  readonly message: string;
  readonly code?: unknown;
  readonly details?: unknown;
}

interface GitModule {
  readonly checkRepositoryIdentity: (options: {
    readonly cwd: string;
    readonly expectedUrl: string;
  }) => Promise<
    | { readonly status: "matching"; readonly actualUrl: string }
    | { readonly status: "mismatched"; readonly error: unknown }
    | { readonly status: "missing_remote"; readonly error: unknown }
    | { readonly status: "missing_repository"; readonly error: unknown }
  >;
  readonly cloneRepository: (options: {
    readonly cwd: string;
    readonly sourceUrl: string;
    readonly targetDir: string;
  }) => Promise<void>;
  readonly fetchRepository: (options: { readonly cwd: string }) => Promise<void>;
  readonly freezeRevisionSet: (options: {
    readonly control: {
      readonly id: "@control";
      readonly cwd: string;
      readonly access: RepositoryAccessMode;
      readonly expectedUrl: string;
      readonly defaultBranch: string;
      readonly checkoutDirectory: string;
    };
    readonly repositories: readonly {
      readonly id: string;
      readonly cwd: string;
      readonly access: RepositoryAccessMode;
      readonly expectedUrl: string;
      readonly defaultBranch: string;
      readonly checkoutDirectory: string;
    }[];
  }) => Promise<WorkspaceRevisionSet>;
  readonly getHeadCommit: (options: { readonly cwd: string }) => Promise<string>;
  readonly getRepositoryStatus: (options: {
    readonly cwd: string;
  }) => Promise<{ readonly clean: boolean; readonly porcelain: string }>;
}

export async function bootstrapWorkspace(
  projectDirectory: string,
  manifest: RepositoryManifestLike,
): Promise<BootstrapWorkspaceResult> {
  const paths = workspacePaths(projectDirectory);
  await mkdir(paths.repositoriesDirectory, { recursive: true });

  const repositories: WorkspaceRepositoryResult[] = [];
  for (const repository of manifest.repositories) {
    repositories.push(await bootstrapRepository(paths, repository));
  }

  const result = {
    ok: repositories.every((repository) => repository.state !== "failed"),
    workspaceDirectory: paths.workspaceDirectory,
    repositoriesDirectory: paths.repositoriesDirectory,
    manifestPath: paths.manifestPath,
    repositories,
  };
  await writeWorkspaceManifest(result, manifest);
  return result;
}

export async function getWorkspaceStatus(
  projectDirectory: string,
  manifest: RepositoryManifestLike,
): Promise<WorkspaceStatusResult> {
  const paths = workspacePaths(projectDirectory);
  const git = await loadGitModule();
  const repositories: WorkspaceRepositoryResult[] = [];

  for (const repository of manifest.repositories) {
    const checkoutPath = checkoutPathFor(paths, repository);
    try {
      await access(checkoutPath);
    } catch {
      repositories.push(repositoryResult(paths, repository, {
        action: "none",
        identity: "unknown",
        state: "missing",
      }));
      continue;
    }

    repositories.push(await inspectRepository(git, paths, repository, "inspect"));
  }

  const manifestPresent = await pathExists(paths.manifestPath);
  return {
    ok:
      manifestPresent &&
      repositories.every(
        (repository) =>
          repository.state !== "failed" && repository.state !== "missing",
      ),
    workspaceDirectory: paths.workspaceDirectory,
    repositoriesDirectory: paths.repositoriesDirectory,
    manifestPath: paths.manifestPath,
    manifestPresent,
    repositories,
  };
}

export async function readWorkspaceManifest(
  projectDirectory: string,
): Promise<WorkspaceManifest> {
  const contents = await readFile(workspacePaths(projectDirectory).manifestPath, "utf8");
  const parsed = JSON.parse(contents) as unknown;
  if (!isWorkspaceManifest(parsed)) {
    throw new Error("Workspace manifest has an invalid shape");
  }
  return parsed;
}

export async function freezeWorkspaceRevisionSet(
  projectDirectory: string,
  options: FreezeWorkspaceRevisionSetOptions,
): Promise<WorkspaceRevisionSet> {
  const paths = workspacePaths(projectDirectory);
  const git = await loadGitModule();
  const repositoriesById = new Map(
    options.manifest.repositories.map((repository) => [repository.id, repository]),
  );

  const applicationRepositories = options.scopes
    .filter((scope) => scope.repository !== "@control")
    .map((scope) => {
      const repository = repositoriesById.get(scope.repository);
      if (repository === undefined) {
        throw new Error(
          `Task scope references repository "${scope.repository}" missing from repository manifest`,
        );
      }

      return {
        id: repository.id,
        cwd: checkoutPathFor(paths, repository),
        access: scope.access,
        expectedUrl: repository.git_url,
        defaultBranch: repository.default_branch,
        checkoutDirectory: repository.checkout_directory,
      };
    });

  const controlScope = options.scopes.find(
    (scope) => scope.repository === "@control",
  );

  return git.freezeRevisionSet({
    control: {
      id: "@control",
      cwd: options.control.cwd ?? projectDirectory,
      access: controlScope?.access ?? "read-write",
      expectedUrl: options.control.expectedUrl,
      defaultBranch: options.control.defaultBranch,
      checkoutDirectory: options.control.checkoutDirectory ?? ".",
    },
    repositories: applicationRepositories,
  });
}

async function bootstrapRepository(
  paths: WorkspacePaths,
  repository: RepositoryManifestEntryLike,
): Promise<WorkspaceRepositoryResult> {
  const git = await loadGitModule();
  const checkoutPath = checkoutPathFor(paths, repository);

  try {
    await access(checkoutPath);
  } catch {
    try {
      await mkdir(dirname(checkoutPath), { recursive: true });
      await git.cloneRepository({
        cwd: paths.repositoriesDirectory,
        sourceUrl: repository.git_url,
        targetDir: checkoutPath,
      });
      return await inspectRepository(git, paths, repository, "clone", "cloned");
    } catch (error) {
      return repositoryResult(paths, repository, {
        action: "clone",
        identity: "unknown",
        state: "failed",
        error,
      });
    }
  }

  const identity = await git.checkRepositoryIdentity({
    cwd: checkoutPath,
    expectedUrl: repository.git_url,
  });
  if (identity.status !== "matching") {
    return repositoryResult(paths, repository, {
      action: "none",
      identity: identity.status,
      state: "failed",
      error: "error" in identity ? identity.error : undefined,
    });
  }

  try {
    await git.fetchRepository({ cwd: checkoutPath });
    return await inspectRepository(git, paths, repository, "fetch", "fetched");
  } catch (error) {
    return repositoryResult(paths, repository, {
      action: "fetch",
      identity: "matching",
      state: "failed",
      error,
    });
  }
}

async function inspectRepository(
  git: GitModule,
  paths: WorkspacePaths,
  repository: RepositoryManifestEntryLike,
  action: WorkspaceRepositoryResult["action"],
  state: WorkspaceRepositoryState = "fetched",
): Promise<WorkspaceRepositoryResult> {
  const checkoutPath = checkoutPathFor(paths, repository);
  const identity = await git.checkRepositoryIdentity({
    cwd: checkoutPath,
    expectedUrl: repository.git_url,
  });
  if (identity.status !== "matching") {
    return repositoryResult(paths, repository, {
      action,
      identity: identity.status,
      state: "failed",
      error: "error" in identity ? identity.error : undefined,
    });
  }

  try {
    const [status, head] = await Promise.all([
      git.getRepositoryStatus({ cwd: checkoutPath }),
      git.getHeadCommit({ cwd: checkoutPath }),
    ]);
    return repositoryResult(paths, repository, {
      action,
      clean: status.clean,
      head,
      identity: "matching",
      state,
    });
  } catch (error) {
    return repositoryResult(paths, repository, {
      action,
      identity: "matching",
      state: "failed",
      error,
    });
  }
}

async function writeWorkspaceManifest(
  result: BootstrapWorkspaceResult,
  manifest: RepositoryManifestLike,
): Promise<void> {
  const defaults = new Map(
    manifest.repositories.map((repository) => [
      repository.id,
      repository.default_branch,
    ]),
  );
  const workspaceManifest: WorkspaceManifest = {
    version: 1,
    workspace: {
      reposDirectory: WORKSPACE_REPOS_DIR,
    },
    repositories: result.repositories.map((repository) => ({
      id: repository.id,
      checkoutDirectory: repository.checkoutDirectory,
      checkoutPath: relative(result.workspaceDirectory, repository.checkoutPath),
      expectedUrl: repository.expectedUrl,
      defaultBranch: defaults.get(repository.id) ?? "",
      observed: manifestObserved(repository),
      lastResult: manifestLastResult(repository),
    })),
  };

  await writeFile(
    result.manifestPath,
    `${JSON.stringify(workspaceManifest, null, 2)}\n`,
    "utf8",
  );
}

function repositoryResult(
  paths: WorkspacePaths,
  repository: RepositoryManifestEntryLike,
  result: {
    readonly action: WorkspaceRepositoryResult["action"];
    readonly clean?: boolean;
    readonly error?: unknown;
    readonly head?: string;
    readonly identity: WorkspaceRepositoryResult["identity"];
    readonly state: WorkspaceRepositoryState;
  },
): WorkspaceRepositoryResult {
  const output: WorkspaceRepositoryResult = {
    id: repository.id,
    checkoutDirectory: repository.checkout_directory,
    checkoutPath: checkoutPathFor(paths, repository),
    expectedUrl: repository.git_url,
    state: result.state,
    action: result.action,
    identity: result.identity,
  };
  if (result.clean !== undefined) {
    return {
      ...output,
      clean: result.clean,
      ...(result.head === undefined ? {} : { head: result.head }),
      ...(result.error === undefined
        ? {}
        : { error: serializeWorkspaceError(result.error) }),
    };
  }
  return {
    ...output,
    ...(result.head === undefined ? {} : { head: result.head }),
    ...(result.error === undefined
      ? {}
      : { error: serializeWorkspaceError(result.error) }),
  };
}

function manifestObserved(
  repository: WorkspaceRepositoryResult,
): WorkspaceManifestRepository["observed"] {
  return {
    identity: repository.identity,
    ...(repository.clean === undefined ? {} : { clean: repository.clean }),
    ...(repository.head === undefined ? {} : { head: repository.head }),
  };
}

function manifestLastResult(
  repository: WorkspaceRepositoryResult,
): WorkspaceManifestRepository["lastResult"] {
  return {
    state: repository.state,
    action: repository.action,
    ...(repository.error === undefined ? {} : { error: repository.error }),
  };
}

interface WorkspacePaths {
  readonly workspaceDirectory: string;
  readonly repositoriesDirectory: string;
  readonly manifestPath: string;
}

function workspacePaths(projectDirectory: string): WorkspacePaths {
  return {
    workspaceDirectory: join(projectDirectory, WORKSPACE_DIR),
    repositoriesDirectory: join(projectDirectory, WORKSPACE_REPOS_DIR),
    manifestPath: join(projectDirectory, WORKSPACE_MANIFEST_FILE),
  };
}

function checkoutPathFor(
  paths: WorkspacePaths,
  repository: RepositoryManifestEntryLike,
): string {
  return join(paths.repositoriesDirectory, normalize(repository.checkout_directory));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function serializeWorkspaceError(error: unknown): SerializedWorkspaceError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...("code" in error ? { code: error.code } : {}),
      ...("details" in error ? { details: error.details } : {}),
    };
  }
  return {
    name: "Error",
    message: String(error),
  };
}

function isWorkspaceManifest(value: unknown): value is WorkspaceManifest {
  if (typeof value !== "object" || value === null || !("version" in value)) {
    return false;
  }
  const candidate = value as { version?: unknown; repositories?: unknown };
  return candidate.version === 1 && Array.isArray(candidate.repositories);
}

async function loadGitModule(): Promise<GitModule> {
  return (await import(packageModuleUrl("git"))) as GitModule;
}

function packageModuleUrl(packageName: "git"): string {
  const currentPath = fileURLToPath(import.meta.url);
  const modulePath = currentPath.includes("/src/")
    ? `../../${packageName}/src/index.ts`
    : `../../${packageName}/dist/index.js`;

  return new URL(modulePath, import.meta.url).href;
}
