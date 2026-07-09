import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packageName = "@scaflow/workspace";

export const WORKSPACE_DIR = "workspace";
export const WORKSPACE_REPOS_DIR = "workspace/repos";
export const WORKSPACE_RUNS_DIR = "workspace/runs";
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
  readonly allowed_paths?: readonly string[];
  readonly forbidden_paths?: readonly string[];
}

export interface TaskContractLike {
  readonly task: {
    readonly id: string;
    readonly title?: string;
    readonly definition_state: string;
  };
  readonly objective?: {
    readonly summary: string;
  };
  readonly source_requirements?: readonly TaskDocumentReferenceLike[];
  readonly source_references?: readonly TaskSourceReferenceLike[];
  readonly repositories: {
    readonly primary?: string;
    readonly scopes: readonly TaskRepositoryScopeLike[];
  };
  readonly verification?: {
    readonly commands: readonly TaskVerificationCommandLike[];
  };
}

export interface TaskDocumentReferenceLike {
  readonly id?: string;
  readonly document: string;
}

export interface TaskSourceReferenceLike {
  readonly document: string;
  readonly section?: string;
}

export interface TaskVerificationCommandLike {
  readonly repository: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeout_seconds: number;
  readonly required: boolean;
}

export interface AssembleTaskRunContextOptions {
  readonly taskRunWorkspace: PrepareTaskRunWorkspaceResult;
  readonly taskContract: TaskContractContextLike;
  readonly projectKnowledgeFiles?: readonly string[];
  readonly previousFailureSummary?: string;
}

export interface TaskContractContextLike extends TaskContractLike {
  readonly objective?: {
    readonly summary: string;
  };
  readonly source_requirements?: readonly {
    readonly id: string;
    readonly document: string;
  }[];
  readonly source_references?: readonly {
    readonly document: string;
    readonly section?: string;
  }[];
  readonly acceptance_criteria?: readonly {
    readonly id: string;
    readonly description: string;
  }[];
  readonly verification?: {
    readonly commands: readonly TaskVerificationCommandLike[];
  };
}

export interface TaskRunContextManifest {
  readonly version: 1;
  readonly task: {
    readonly id: string;
    readonly title?: string;
  };
  readonly control: {
    readonly mode: "undeclared" | "read-only" | "read-write";
    readonly declared: boolean;
    readonly worktreePath?: string;
  };
  readonly files: {
    readonly agents: string;
    readonly manifest: string;
    readonly taskContract: string;
    readonly projectKnowledge: readonly TaskRunContextProjectKnowledgeEntry[];
    readonly failureSummary?: string;
  };
  readonly repositories: readonly TaskRunContextRepositorySummary[];
  readonly verificationCommands: readonly TaskVerificationCommandLike[];
  readonly exclusions: readonly string[];
}

export interface TaskRunContextProjectKnowledgeEntry {
  readonly source: string;
  readonly snapshot: string;
}

export interface TaskRunContextRepositorySummary {
  readonly id: string;
  readonly access: RepositoryAccessMode;
  readonly baseCommit: string;
  readonly checkoutDirectory: string;
  readonly worktreePath?: string;
  readonly mode?: "detached" | "branch";
  readonly branchName?: string;
  readonly writable: boolean;
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
}

export interface AssembleTaskRunContextResult {
  readonly agentsPath: string;
  readonly contextManifestPath: string;
  readonly contextDirectory: string;
  readonly taskContractSnapshotPath: string;
  readonly projectKnowledgeSnapshotPaths: readonly string[];
  readonly failureSummaryPath?: string;
  readonly manifest: TaskRunContextManifest;
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

export interface PrepareTaskRunWorkspaceOptions {
  readonly taskContract: TaskContractLike;
  readonly taskRunId: string;
  readonly manifest: RepositoryManifestLike;
  readonly control: {
    readonly cwd?: string;
    readonly expectedUrl: string;
    readonly defaultBranch: string;
    readonly checkoutDirectory?: string;
  };
}

export interface PreparedTaskRunRepository {
  readonly id: string;
  readonly access: RepositoryAccessMode;
  readonly sourcePath: string;
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly branchName?: string;
  readonly mode: "detached" | "branch";
  readonly reused: boolean;
}

export interface PrepareTaskRunWorkspaceResult {
  readonly taskId: string;
  readonly taskRunId: string;
  readonly bundleRoot: string;
  readonly runtimeDirectory: string;
  readonly repositoriesDirectory: string;
  readonly revisionSetPath: string;
  readonly metadataPath: string;
  readonly revisionSet: WorkspaceRevisionSet;
  readonly repositories: readonly PreparedTaskRunRepository[];
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
  readonly addBranchWorktree: (options: {
    readonly sourceCwd: string;
    readonly targetDir: string;
    readonly branchName: string;
    readonly commit: string;
  }) => Promise<void>;
  readonly addDetachedWorktree: (options: {
    readonly sourceCwd: string;
    readonly targetDir: string;
    readonly commit: string;
  }) => Promise<void>;
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
  readonly getRepositoryRoot: (options: {
    readonly cwd: string;
  }) => Promise<string>;
  readonly getCurrentBranch: (options: {
    readonly cwd: string;
  }) => Promise<string | null>;
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
      access: controlScope?.access ?? "read-only",
      expectedUrl: options.control.expectedUrl,
      defaultBranch: options.control.defaultBranch,
      checkoutDirectory: options.control.checkoutDirectory ?? ".",
    },
    repositories: applicationRepositories,
  });
}

export async function prepareTaskRunWorkspace(
  projectDirectory: string,
  options: PrepareTaskRunWorkspaceOptions,
): Promise<PrepareTaskRunWorkspaceResult> {
  const taskId = normalizeTaskRunSegment(options.taskContract.task.id, "Task ID");
  const taskRunId = normalizeTaskRunSegment(options.taskRunId, "TaskRun ID");
  if (options.taskContract.task.definition_state !== "ready") {
    throw new Error(`Task ${taskId} is not ready for preparation`);
  }

  const paths = taskRunWorkspacePaths(projectDirectory, taskId, taskRunId);
  await acquireTaskRunLock(projectDirectory, taskId, taskRunId, async () => {
    await mkdir(paths.bundleRoot, { recursive: true });
    await mkdir(paths.runtimeDirectory, { recursive: true });
    await mkdir(paths.repositoriesDirectory, { recursive: true });

    const revisionSet = await readOrFreezeTaskRunRevisionSet(
      projectDirectory,
      paths,
      {
        control: options.control,
        manifest: options.manifest,
        scopes: options.taskContract.repositories.scopes,
      },
    );
    await validateExistingTaskRunMetadata(paths, taskId, taskRunId, revisionSet);

    const repositories = await createTaskRunWorktrees(
      projectDirectory,
      paths,
      taskId,
      taskRunId,
      options.manifest,
      revisionSet,
    );

    await assertNotGitRepository(paths.bundleRoot);
    await writeJsonFile(paths.metadataPath, {
      version: 1,
      taskId,
      taskRunId,
      bundleRoot: paths.bundleRoot,
      runtimeDirectory: paths.runtimeDirectory,
      repositoriesDirectory: paths.repositoriesDirectory,
      revisionSetPath: paths.revisionSetPath,
      repositories,
    });
  });

  const revisionSet = JSON.parse(
    await readFile(paths.revisionSetPath, "utf8"),
  ) as WorkspaceRevisionSet;
  const metadata = JSON.parse(await readFile(paths.metadataPath, "utf8")) as {
    readonly repositories: readonly PreparedTaskRunRepository[];
  };

  return {
    taskId,
    taskRunId,
    bundleRoot: paths.bundleRoot,
    runtimeDirectory: paths.runtimeDirectory,
    repositoriesDirectory: paths.repositoriesDirectory,
    revisionSetPath: paths.revisionSetPath,
    metadataPath: paths.metadataPath,
    revisionSet,
    repositories: metadata.repositories,
  };
}

export async function assembleTaskRunContext(
  projectDirectory: string,
  options: AssembleTaskRunContextOptions,
): Promise<AssembleTaskRunContextResult> {
  const taskId = normalizeTaskRunSegment(
    options.taskRunWorkspace.taskId,
    "Task ID",
  );
  if (options.taskContract.task.id !== taskId) {
    throw new Error("TaskRun context task contract does not match workspace task ID");
  }

  const bundleRoot = options.taskRunWorkspace.bundleRoot;
  const contextDirectory = join(bundleRoot, "context");
  const knowledgeDirectory = join(contextDirectory, "project-knowledge");
  await reconcileGeneratedContextArtifacts(contextDirectory);

  const taskContractSnapshotPath = join(contextDirectory, "task-contract.json");
  await writeJsonFile(taskContractSnapshotPath, options.taskContract);

  const projectKnowledge = await writeProjectKnowledgeSnapshots(
    projectDirectory,
    knowledgeDirectory,
    options.projectKnowledgeFiles ?? defaultProjectKnowledgeFiles(),
  );

  const previousFailureSummary = options.previousFailureSummary;
  let failureSummaryPath: string | undefined;
  if (previousFailureSummary !== undefined) {
    failureSummaryPath = join(contextDirectory, "failure-summary.md");
    await writeFile(failureSummaryPath, redactedText(previousFailureSummary), "utf8");
  }

  const agentsPath = join(bundleRoot, "AGENTS.md");
  const contextManifestPath = join(bundleRoot, "context-manifest.json");
  const manifest: TaskRunContextManifest = {
    version: 1,
    task: {
      id: taskId,
      ...(options.taskContract.task.title === undefined
        ? {}
        : { title: options.taskContract.task.title }),
    },
    control: controlContextSummary(options.taskContract, options.taskRunWorkspace),
    files: {
      agents: bundleRelativePath(bundleRoot, agentsPath),
      manifest: bundleRelativePath(bundleRoot, contextManifestPath),
      taskContract: bundleRelativePath(bundleRoot, taskContractSnapshotPath),
      projectKnowledge: projectKnowledge.snapshots.map((entry) => ({
        source: entry.source,
        snapshot: bundleRelativePath(bundleRoot, entry.snapshotPath),
      })),
      ...(failureSummaryPath === undefined
        ? {}
        : { failureSummary: bundleRelativePath(bundleRoot, failureSummaryPath) }),
    },
    repositories: repositoryContextSummaries(
      bundleRoot,
      options.taskRunWorkspace,
      options.taskContract,
    ),
    verificationCommands: stableVerificationCommands(options.taskContract),
    exclusions: [
      ".scaflow/state.db",
      "workspace/repos/**",
      "workspace/runs/* except current TaskRun bundle",
      "user home paths",
      "secret-looking files and secret-looking content",
      "undeclared repository source",
      ...projectKnowledge.exclusions,
    ],
  };

  await writeFile(agentsPath, renderTaskRunAgents(options.taskContract, manifest), "utf8");
  await writeJsonFile(contextManifestPath, manifest);

  return {
    agentsPath,
    contextManifestPath,
    contextDirectory,
    taskContractSnapshotPath,
    projectKnowledgeSnapshotPaths: projectKnowledge.snapshots.map(
      (entry) => entry.snapshotPath,
    ),
    ...(failureSummaryPath === undefined ? {} : { failureSummaryPath }),
    manifest,
  };
}

function defaultProjectKnowledgeFiles(): readonly string[] {
  return [
    "AGENTS.md",
    "PRODUCT.md",
    "ARCHITECTURE.md",
    "docs/source/scaflow-v0.1.0-prd.md",
    "docs/architecture/scaflow-v0.2-baseline.md",
  ];
}

async function writeProjectKnowledgeSnapshots(
  projectDirectory: string,
  knowledgeDirectory: string,
  files: readonly string[],
): Promise<{
  readonly snapshots: readonly {
    readonly source: string;
    readonly snapshotPath: string;
  }[];
  readonly exclusions: readonly string[];
}> {
  const snapshots: {
    readonly source: string;
    readonly snapshotPath: string;
  }[] = [];
  const exclusions: string[] = [];

  for (const source of [...files].sort()) {
    const normalizedSource = normalizeProjectKnowledgePath(source);
    const sourcePath = resolve(projectDirectory, normalizedSource);
    const realSourcePath = await assertProjectKnowledgeSource(
      projectDirectory,
      normalizedSource,
      sourcePath,
    );

    let contents: string;
    try {
      contents = await readFile(realSourcePath, "utf8");
    } catch (error) {
      throw new Error(
        `Project knowledge source is not readable: ${normalizedSource}`,
        { cause: error },
      );
    }

    const containsSensitiveContent = containsSensitiveKnowledge(contents);
    const snapshotPath = join(
      knowledgeDirectory,
      `${snapshots.length.toString().padStart(2, "0")}-${snapshotName(normalizedSource)}`,
    );
    await writeFile(snapshotPath, redactedText(contents), "utf8");
    snapshots.push({
      source: normalizedSource,
      snapshotPath,
    });
    if (containsSensitiveContent) {
      exclusions.push(`${normalizedSource}: sensitive content redacted`);
    }
  }

  return { snapshots, exclusions };
}

async function reconcileGeneratedContextArtifacts(
  contextDirectory: string,
): Promise<void> {
  await rm(join(contextDirectory, "project-knowledge"), {
    force: true,
    recursive: true,
  });
  await rm(join(contextDirectory, "failure-summary.md"), { force: true });
  await mkdir(join(contextDirectory, "project-knowledge"), { recursive: true });
}

async function assertProjectKnowledgeSource(
  projectDirectory: string,
  normalizedSource: string,
  sourcePath: string,
): Promise<string> {
  const result = await projectKnowledgeExclusionReason(
    projectDirectory,
    normalizedSource,
    sourcePath,
  );
  if (result.reason === undefined) {
    return result.realSourcePath;
  }

  const displayPath = displayExcludedPath(normalizedSource);
  if (result.reason === "unrelated_source") {
    throw new Error(`Project knowledge source is unrelated: ${displayPath}`);
  }
  if (result.reason === "secret_path") {
    throw new Error(
      `Project knowledge source looks secret-bearing: ${displayPath}`,
    );
  }
  throw new Error(`Project knowledge source is excluded: ${displayPath}`);
}

function repositoryContextSummaries(
  bundleRoot: string,
  workspace: PrepareTaskRunWorkspaceResult,
  taskContract: TaskContractContextLike,
): readonly TaskRunContextRepositorySummary[] {
  const worktreeById = new Map(
    workspace.repositories.map((repository) => [repository.id, repository]),
  );
  const scopeById = new Map(
    taskContract.repositories.scopes.map((scope) => [scope.repository, scope]),
  );
  return [workspace.revisionSet.control, ...workspace.revisionSet.repositories].map(
    (repository) => {
      const prepared = worktreeById.get(repository.id);
      const scope = scopeById.get(repository.id);
      return {
        id: repository.id,
        access: repository.access,
        baseCommit: repository.base_commit,
        checkoutDirectory: repository.checkout_directory,
        ...(prepared === undefined
          ? {}
          : {
              worktreePath: bundleRelativePath(bundleRoot, prepared.worktreePath),
              mode: prepared.mode,
              ...(prepared.branchName === undefined
                ? {}
                : { branchName: prepared.branchName }),
            }),
        writable: repository.access === "read-write" && prepared !== undefined,
        allowedPaths: [...(scope?.allowed_paths ?? [])].sort(),
        forbiddenPaths: [...(scope?.forbidden_paths ?? [])].sort(),
      };
    },
  );
}

function controlContextSummary(
  taskContract: TaskContractContextLike,
  workspace: PrepareTaskRunWorkspaceResult,
): TaskRunContextManifest["control"] {
  const controlScope = taskContract.repositories.scopes.find(
    (scope) => scope.repository === "@control",
  );
  const controlWorktree = workspace.repositories.find(
    (repository) => repository.id === "@control",
  );
  if (controlScope === undefined) {
    return { mode: "undeclared", declared: false };
  }
  if (controlScope.access === "read-only") {
    return { mode: "read-only", declared: true };
  }
  return {
    mode: "read-write",
    declared: true,
    ...(controlWorktree === undefined
      ? {}
      : {
          worktreePath: bundleRelativePath(
            workspace.bundleRoot,
            controlWorktree.worktreePath,
          ),
        }),
  };
}

function stableVerificationCommands(
  taskContract: TaskContractContextLike,
): readonly TaskVerificationCommandLike[] {
  return [...(taskContract.verification?.commands ?? [])].map((command) => ({
    repository: command.repository,
    executable: command.executable,
    args: [...command.args],
    timeout_seconds: command.timeout_seconds,
    required: command.required,
  }));
}

function renderTaskRunAgents(
  taskContract: TaskContractContextLike,
  manifest: TaskRunContextManifest,
): string {
  const scopeLines = taskContract.repositories.scopes
    .map((scope) => `- ${scope.repository}: ${scope.access}`)
    .join("\n");
  const commandLines = manifest.verificationCommands
    .map((command) =>
      `- ${command.repository}: ${command.executable} ${JSON.stringify(command.args)}`,
    )
    .join("\n");

  return `# Scaflow TaskRun Instructions

Task ID: ${taskContract.task.id}

## Scope

Implement only the approved Task Contract represented in ${manifest.files.taskContract}.
Task definition state is separate from TaskRun execution state. Do not mark the shared Task completed.

## Repository Access

${scopeLines}

Use only the prepared TaskRun worktrees listed in context-manifest.json. Do not modify workspace/repos/ or other TaskRuns.

## Context

- Manifest: ${manifest.files.manifest}
- Project knowledge snapshots: context/project-knowledge/
- Repository summaries and verification commands are structured in context-manifest.json.

## Security

Do not read or expose secrets, user home content, .scaflow/state.db, unrelated source, workspace/repos/, or other TaskRuns.

## Verification Commands

${commandLines}

Commands must be executed as structured executable/args definitions, not arbitrary shell strings.
`;
}

function normalizeProjectKnowledgePath(path: string): string {
  const normalized = normalize(path).replaceAll("\\", "/");
  if (
    normalized === "" ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    isAbsolute(path)
  ) {
    throw new Error(`Project knowledge path must be relative and safe: ${path}`);
  }
  return normalized;
}

function projectKnowledgeExclusionReason(
  projectDirectory: string,
  normalizedSource: string,
  sourcePath: string,
): Promise<{ readonly reason?: string; readonly realSourcePath: string }> {
  return realpath(projectDirectory).then(async (projectRoot) => {
    const realSourcePath = await realpath(sourcePath);
    const canonicalProjectRelative = relative(projectRoot, realSourcePath).replaceAll(
      "\\",
      "/",
    );
    if (
      canonicalProjectRelative.startsWith("../") ||
      canonicalProjectRelative === ".."
    ) {
      return { reason: "outside_project", realSourcePath };
    }
    const runtimeExclusion = await canonicalRuntimeExclusionReason(
      projectRoot,
      realSourcePath,
    );
    if (runtimeExclusion !== undefined) {
      return { reason: runtimeExclusion, realSourcePath };
    }
    if (isForbiddenProjectKnowledgePath(normalizedSource)) {
      return { reason: "forbidden_runtime_path", realSourcePath };
    }
    if (isForbiddenProjectKnowledgePath(canonicalProjectRelative)) {
      return { reason: "forbidden_runtime_path", realSourcePath };
    }
    if (SECRET_FILE_PATTERN.test(basename(normalizedSource))) {
      return { reason: "secret_path", realSourcePath };
    }
    if (SECRET_FILE_PATTERN.test(basename(canonicalProjectRelative))) {
      return { reason: "secret_path", realSourcePath };
    }
    if (!isAllowedProjectKnowledgeSource(normalizedSource)) {
      return { reason: "unrelated_source", realSourcePath };
    }
    if (!isAllowedProjectKnowledgeSource(canonicalProjectRelative)) {
      return { reason: "unrelated_source", realSourcePath };
    }
    return { realSourcePath };
  });
}

function isForbiddenProjectKnowledgePath(normalizedSource: string): boolean {
  return (
    normalizedSource === ".scaflow/state.db" ||
    normalizedSource.startsWith(".scaflow/") ||
    normalizedSource === "workspace/repos" ||
    normalizedSource.startsWith("workspace/repos/") ||
    normalizedSource === "workspace/runs" ||
    normalizedSource.startsWith("workspace/runs/")
  );
}

async function canonicalRuntimeExclusionReason(
  projectRoot: string,
  realSourcePath: string,
): Promise<string | undefined> {
  for (const runtimePath of [
    ".scaflow",
    "workspace/repos",
    "workspace/runs",
  ]) {
    const realRuntimePath = await realpathIfExists(join(projectRoot, runtimePath));
    if (
      realRuntimePath !== undefined &&
      isSameOrChildPath(realRuntimePath, realSourcePath)
    ) {
      return "forbidden_runtime_path";
    }
  }
  return undefined;
}

async function realpathIfExists(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

function isSameOrChildPath(parent: string, child: string): boolean {
  const relativePath = relative(parent, child).replaceAll("\\", "/");
  return (
    relativePath === "" ||
    (!relativePath.startsWith("../") &&
      relativePath !== ".." &&
      !isAbsolute(relativePath))
  );
}

function isAllowedProjectKnowledgeSource(normalizedSource: string): boolean {
  return (
    normalizedSource === "AGENTS.md" ||
    normalizedSource === "PRODUCT.md" ||
    normalizedSource === "ARCHITECTURE.md" ||
    normalizedSource.startsWith("docs/") ||
    normalizedSource.startsWith("tasks/")
  );
}

function containsSensitiveKnowledge(text: string): boolean {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/.test(
      text,
    ) ||
    /\b(?:AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|OPENAI_API_KEY)\s*[:=]\s*\S+/i.test(
      text,
    ) ||
    /\b(?:password|passwd|api[_-]?key|access[_-]?token)\s*[:=]\s*\S+/i.test(text)
  );
}

function displayExcludedPath(path: string): string {
  return isAbsolute(path) ? basename(path) : path;
}

function snapshotName(source: string): string {
  return source.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function bundleRelativePath(bundleRoot: string, path: string): string {
  const relativePath = relative(bundleRoot, path).replaceAll("\\", "/");
  if (
    relativePath === "" ||
    relativePath.startsWith("../") ||
    relativePath === ".." ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Context path is outside the TaskRun bundle: ${path}`);
  }
  return relativePath;
}

const SECRET_FILE_PATTERN =
  /(^\.env($|\.)|secret|credential|token|private[_-]?key|id_rsa|id_ed25519)/i;

function redactedText(text: string): string {
  return text
    .replace(
      /(password|passwd|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s"']+/gi,
      "$1=[REDACTED]",
    )
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
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

interface TaskRunWorkspacePaths {
  readonly bundleRoot: string;
  readonly runtimeDirectory: string;
  readonly repositoriesDirectory: string;
  readonly revisionSetPath: string;
  readonly metadataPath: string;
}

function workspacePaths(projectDirectory: string): WorkspacePaths {
  return {
    workspaceDirectory: join(projectDirectory, WORKSPACE_DIR),
    repositoriesDirectory: join(projectDirectory, WORKSPACE_REPOS_DIR),
    manifestPath: join(projectDirectory, WORKSPACE_MANIFEST_FILE),
  };
}

function taskRunWorkspacePaths(
  projectDirectory: string,
  taskId: string,
  taskRunId: string,
): TaskRunWorkspacePaths {
  const bundleRoot = join(projectDirectory, WORKSPACE_RUNS_DIR, taskId, taskRunId);
  return {
    bundleRoot,
    runtimeDirectory: join(bundleRoot, "runtime"),
    repositoriesDirectory: join(bundleRoot, "repositories"),
    revisionSetPath: join(bundleRoot, "revision-set.json"),
    metadataPath: join(bundleRoot, "task-run-workspace.json"),
  };
}

function checkoutPathFor(
  paths: WorkspacePaths,
  repository: RepositoryManifestEntryLike,
): string {
  return join(paths.repositoriesDirectory, normalize(repository.checkout_directory));
}

async function createTaskRunWorktrees(
  projectDirectory: string,
  paths: TaskRunWorkspacePaths,
  taskId: string,
  taskRunId: string,
  manifest: RepositoryManifestLike,
  revisionSet: WorkspaceRevisionSet,
): Promise<PreparedTaskRunRepository[]> {
  const git = await loadGitModule();
  const workspace = workspacePaths(projectDirectory);
  const manifestById = new Map(
    manifest.repositories.map((repository) => [repository.id, repository]),
  );
  const repositories: PreparedTaskRunRepository[] = [];

  if (revisionSet.control.access === "read-write") {
    repositories.push(
      await prepareRepositoryWorktree(git, {
        id: "@control",
        access: revisionSet.control.access,
        sourcePath: projectDirectory,
        worktreePath: join(paths.bundleRoot, "control"),
        baseCommit: revisionSet.control.base_commit,
        expectedUrl: revisionSet.control.identity.expected_url,
        taskId,
        taskRunId,
      }),
    );
  }

  for (const repository of revisionSet.repositories) {
    const manifestEntry = manifestById.get(repository.id);
    if (manifestEntry === undefined) {
      throw new Error(`Revision Set repository "${repository.id}" missing from manifest`);
    }

    repositories.push(
      await prepareRepositoryWorktree(git, {
        id: repository.id,
        access: repository.access,
        sourcePath: checkoutPathFor(workspace, manifestEntry),
        worktreePath: join(paths.repositoriesDirectory, repository.id),
        baseCommit: repository.base_commit,
        expectedUrl: repository.identity.expected_url,
        taskId,
        taskRunId,
      }),
    );
  }

  return repositories;
}

async function readOrFreezeTaskRunRevisionSet(
  projectDirectory: string,
  paths: TaskRunWorkspacePaths,
  options: FreezeWorkspaceRevisionSetOptions,
): Promise<WorkspaceRevisionSet> {
  if (await pathExists(paths.revisionSetPath)) {
    return await readTaskRunRevisionSet(paths.revisionSetPath);
  }

  const revisionSet = await freezeWorkspaceRevisionSet(projectDirectory, options);
  await writeJsonFile(paths.revisionSetPath, revisionSet);
  return revisionSet;
}

async function readTaskRunRevisionSet(path: string): Promise<WorkspaceRevisionSet> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Existing TaskRun revision-set.json is invalid: ${path}`, {
      cause: error,
    });
  }

  if (!isWorkspaceRevisionSet(parsed)) {
    throw new Error(`Existing TaskRun revision-set.json has an invalid shape: ${path}`);
  }
  return parsed;
}

async function validateExistingTaskRunMetadata(
  paths: TaskRunWorkspacePaths,
  taskId: string,
  taskRunId: string,
  revisionSet: WorkspaceRevisionSet,
): Promise<void> {
  if (!(await pathExists(paths.metadataPath))) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(paths.metadataPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Existing TaskRun workspace metadata is invalid: ${paths.metadataPath}`, {
      cause: error,
    });
  }

  if (!isTaskRunWorkspaceMetadata(parsed)) {
    throw new Error(
      `Existing TaskRun workspace metadata has an invalid shape: ${paths.metadataPath}`,
    );
  }
  if (
    parsed.taskId !== taskId ||
    parsed.taskRunId !== taskRunId ||
    parsed.revisionSetPath !== paths.revisionSetPath
  ) {
    throw new Error("Existing TaskRun workspace metadata does not match this TaskRun");
  }

  const expectedRepositories = repositoryMetadataSignaturesFromRevisionSet(
    paths,
    taskId,
    taskRunId,
    revisionSet,
  );
  const actualRepositories = parsed.repositories.map((repository) =>
    repositoryMetadataSignature(repository),
  );
  if (JSON.stringify(actualRepositories) !== JSON.stringify(expectedRepositories)) {
    throw new Error(
      "Existing TaskRun workspace metadata is inconsistent with revision-set.json",
    );
  }
}

function repositoryMetadataSignaturesFromRevisionSet(
  paths: TaskRunWorkspacePaths,
  taskId: string,
  taskRunId: string,
  revisionSet: WorkspaceRevisionSet,
): RepositoryMetadataSignature[] {
  const repositories: RepositoryMetadataSignature[] = [];
  if (revisionSet.control.access === "read-write") {
    repositories.push(
      repositoryMetadataSignatureFromRevision(
        revisionSet.control,
        join(paths.bundleRoot, "control"),
        taskId,
        taskRunId,
      ),
    );
  }

  for (const repository of revisionSet.repositories) {
    repositories.push(
      repositoryMetadataSignatureFromRevision(
        repository,
        join(paths.repositoriesDirectory, repository.id),
        taskId,
        taskRunId,
      ),
    );
  }
  return repositories;
}

interface RepositoryMetadataSignature {
  readonly id: string;
  readonly access: RepositoryAccessMode;
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly branchName?: string;
  readonly mode: "detached" | "branch";
}

function repositoryMetadataSignatureFromRevision(
  repository: WorkspaceRevisionSetRepository,
  worktreePath: string,
  taskId: string,
  taskRunId: string,
): RepositoryMetadataSignature {
  const mode = repository.access === "read-only" ? "detached" : "branch";
  const branchName =
    mode === "branch"
      ? taskBranchName(repository.id, taskId, taskRunId)
      : undefined;

  return {
    id: repository.id,
    access: repository.access,
    worktreePath,
    baseCommit: repository.base_commit,
    ...(branchName === undefined ? {} : { branchName }),
    mode,
  };
}

function repositoryMetadataSignature(
  repository: PreparedTaskRunRepository,
): RepositoryMetadataSignature {
  return {
    id: repository.id,
    access: repository.access,
    worktreePath: repository.worktreePath,
    baseCommit: repository.baseCommit,
    ...(repository.branchName === undefined
      ? {}
      : { branchName: repository.branchName }),
    mode: repository.mode,
  };
}

async function prepareRepositoryWorktree(
  git: GitModule,
  options: {
    readonly id: string;
    readonly access: RepositoryAccessMode;
    readonly sourcePath: string;
    readonly worktreePath: string;
    readonly baseCommit: string;
    readonly expectedUrl: string;
    readonly taskId: string;
    readonly taskRunId: string;
  },
): Promise<PreparedTaskRunRepository> {
  const mode = options.access === "read-only" ? "detached" : "branch";
  const branchName =
    mode === "branch"
      ? taskBranchName(options.id, options.taskId, options.taskRunId)
      : undefined;

  if (await pathExists(options.worktreePath)) {
    await verifyExistingWorktree(git, options, mode, branchName);
    return {
      id: options.id,
      access: options.access,
      sourcePath: options.sourcePath,
      worktreePath: options.worktreePath,
      baseCommit: options.baseCommit,
      ...(branchName === undefined ? {} : { branchName }),
      mode,
      reused: true,
    };
  }

  await mkdir(dirname(options.worktreePath), { recursive: true });
  if (mode === "detached") {
    await git.addDetachedWorktree({
      sourceCwd: options.sourcePath,
      targetDir: options.worktreePath,
      commit: options.baseCommit,
    });
  } else {
    await git.addBranchWorktree({
      sourceCwd: options.sourcePath,
      targetDir: options.worktreePath,
      branchName: requireBranchName(branchName),
      commit: options.baseCommit,
    });
  }

  await verifyExistingWorktree(git, options, mode, branchName);
  return {
    id: options.id,
    access: options.access,
    sourcePath: options.sourcePath,
    worktreePath: options.worktreePath,
    baseCommit: options.baseCommit,
    ...(branchName === undefined ? {} : { branchName }),
    mode,
    reused: false,
  };
}

async function verifyExistingWorktree(
  git: GitModule,
  options: {
    readonly id: string;
    readonly worktreePath: string;
    readonly baseCommit: string;
    readonly expectedUrl: string;
  },
  mode: "detached" | "branch",
  branchName: string | undefined,
): Promise<void> {
  const repositoryRoot = await git.getRepositoryRoot({ cwd: options.worktreePath });
  if (
    (await realpath(repositoryRoot)) !== (await realpath(options.worktreePath))
  ) {
    throw new Error(
      `Existing TaskRun path for ${options.id} is not a Git worktree root`,
    );
  }

  const identity = await git.checkRepositoryIdentity({
    cwd: options.worktreePath,
    expectedUrl: options.expectedUrl,
  });
  if (identity.status !== "matching") {
    throw identity.error;
  }

  const [head, currentBranch] = await Promise.all([
    git.getHeadCommit({ cwd: options.worktreePath }),
    git.getCurrentBranch({ cwd: options.worktreePath }),
  ]);
  if (head !== options.baseCommit) {
    throw new Error(
      `Existing TaskRun worktree for ${options.id} is at ${head}, expected ${options.baseCommit}`,
    );
  }
  if (mode === "detached" && currentBranch !== null) {
    throw new Error(`Read-only TaskRun worktree for ${options.id} is not detached`);
  }
  if (mode === "branch" && currentBranch !== branchName) {
    throw new Error(
      `Read-write TaskRun worktree for ${options.id} is on ${currentBranch ?? "detached HEAD"}, expected ${branchName}`,
    );
  }
}

async function acquireTaskRunLock<Result>(
  projectDirectory: string,
  taskId: string,
  taskRunId: string,
  work: () => Promise<Result>,
): Promise<Result> {
  const lockRoot = join(projectDirectory, ".scaflow", "locks", "task-runs");
  const lockDirectory = join(lockRoot, `${taskId}-${taskRunId}.lock`);
  await mkdir(lockRoot, { recursive: true });
  try {
    await mkdir(lockDirectory);
  } catch (error) {
    throw new Error(
      `TaskRun workspace lock is already held for ${taskId}/${taskRunId}`,
      { cause: error },
    );
  }

  try {
    return await work();
  } finally {
    await rm(lockDirectory, { force: true, recursive: true });
  }
}

async function assertNotGitRepository(path: string): Promise<void> {
  if (await pathExists(join(path, ".git"))) {
    throw new Error(`TaskRun bundle root must not be a Git repository: ${path}`);
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function taskBranchName(
  repositoryId: string,
  taskId: string,
  taskRunId: string,
): string {
  return `scaflow/${normalizeBranchSegment(taskId)}/${normalizeBranchSegment(taskRunId)}/${normalizeBranchSegment(repositoryId)}`;
}

function normalizeTaskRunSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (
    normalized === "" ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized === "." ||
    normalized === ".."
  ) {
    throw new Error(`${label} must be a safe path segment`);
  }
  return normalized;
}

function normalizeBranchSegment(value: string): string {
  return value.replace(/^@/, "").replace(/[^A-Za-z0-9._-]+/g, "-");
}

function requireBranchName(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("Branch name is required for read-write worktrees");
  }
  return value;
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

function isWorkspaceRevisionSet(value: unknown): value is WorkspaceRevisionSet {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as {
    version?: unknown;
    control?: unknown;
    repositories?: unknown;
  };
  return (
    candidate.version === 1 &&
    isRevisionSetRepository(candidate.control, "@control") &&
    Array.isArray(candidate.repositories) &&
    candidate.repositories.every((repository) =>
      isRevisionSetRepository(repository),
    )
  );
}

function isRevisionSetRepository(
  value: unknown,
  expectedId?: string,
): value is WorkspaceRevisionSetRepository {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as {
    id?: unknown;
    base_commit?: unknown;
    access?: unknown;
    default_branch?: unknown;
    checkout_directory?: unknown;
    identity?: {
      remote?: unknown;
      expected_url?: unknown;
      actual_url?: unknown;
    };
  };
  return (
    typeof candidate.id === "string" &&
    (expectedId === undefined || candidate.id === expectedId) &&
    typeof candidate.base_commit === "string" &&
    (candidate.access === "read-only" || candidate.access === "read-write") &&
    typeof candidate.default_branch === "string" &&
    typeof candidate.checkout_directory === "string" &&
    typeof candidate.identity === "object" &&
    candidate.identity !== null &&
    typeof candidate.identity.remote === "string" &&
    typeof candidate.identity.expected_url === "string" &&
    typeof candidate.identity.actual_url === "string"
  );
}

function isTaskRunWorkspaceMetadata(value: unknown): value is {
  readonly taskId: string;
  readonly taskRunId: string;
  readonly revisionSetPath: string;
  readonly repositories: readonly PreparedTaskRunRepository[];
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as {
    taskId?: unknown;
    taskRunId?: unknown;
    revisionSetPath?: unknown;
    repositories?: unknown;
  };
  return (
    typeof candidate.taskId === "string" &&
    typeof candidate.taskRunId === "string" &&
    typeof candidate.revisionSetPath === "string" &&
    Array.isArray(candidate.repositories) &&
    candidate.repositories.every(isPreparedTaskRunRepository)
  );
}

function isPreparedTaskRunRepository(
  value: unknown,
): value is PreparedTaskRunRepository {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as {
    id?: unknown;
    access?: unknown;
    sourcePath?: unknown;
    worktreePath?: unknown;
    baseCommit?: unknown;
    branchName?: unknown;
    mode?: unknown;
    reused?: unknown;
  };
  return (
    typeof candidate.id === "string" &&
    (candidate.access === "read-only" || candidate.access === "read-write") &&
    typeof candidate.sourcePath === "string" &&
    typeof candidate.worktreePath === "string" &&
    typeof candidate.baseCommit === "string" &&
    (candidate.branchName === undefined ||
      typeof candidate.branchName === "string") &&
    (candidate.mode === "detached" || candidate.mode === "branch") &&
    typeof candidate.reused === "boolean"
  );
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
