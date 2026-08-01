import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  checkRepositoryIdentity,
  getRepositoryChanges,
  getRepositoryRoot,
  type GitChangedPath,
} from "@scaflow/git";
import type {
  RevisionSet,
  RevisionSetApplicationRepository,
  RevisionSetControlRepository,
  TaskContractRepositoryScope,
  VerificationFailure,
} from "@scaflow/schemas";

import type { VerificationContext, Verifier, VerifierOutput } from "./index.js";

export const SCOPE_VERIFIER_ID = "scope";

export const protectedControlPathPatterns = Object.freeze([
  "policies/security.yaml",
  "policies/command-policy.yaml",
  "scaflow.yaml",
  "packages/schemas/**",
  "workflows/**",
  ".github/workflows/**",
  ".github/CODEOWNERS",
  "approvals/**",
] as const);

type FrozenRepository = RevisionSetControlRepository | RevisionSetApplicationRepository;

export interface ScopeRepositoryObservation {
  readonly repositoryId: string;
  readonly cwd: string;
  readonly taskRunId: string;
}

export interface ScopePreparedWorkspace {
  readonly taskRunId: string;
  readonly taskRunRoot: string;
  readonly developerWorkspaceReposRoot: string;
}

export interface ScopeVerifierOptions {
  readonly preparedWorkspace: ScopePreparedWorkspace;
  readonly revisionSet: RevisionSet;
  readonly scopes: readonly TaskContractRepositoryScope[];
  readonly repositories: readonly ScopeRepositoryObservation[];
}

export function createScopeVerifier(options: ScopeVerifierOptions): Verifier {
  return {
    id: SCOPE_VERIFIER_ID,
    async verify(context) {
      try {
        return await verifyScope(options, context);
      } catch {
        return failed(evidenceFailure("Scope evidence could not be observed or validated"));
      }
    },
  };
}

async function verifyScope(
  options: ScopeVerifierOptions,
  context: VerificationContext,
): Promise<VerifierOutput> {
  const invalid = validateObservationSet(options, context);
  if (invalid !== undefined) {
    return failed(invalid);
  }

  const frozenRepositories = expectedObservedRepositories(options.revisionSet);
  const scopes = new Map(options.scopes.map((scope) => [scope.repository, scope]));
  const observations = new Map(
    options.repositories.map((repository) => [repository.repositoryId, repository]),
  );

  for (const frozen of frozenRepositories) {
    const observation = observations.get(frozen.id)!;
    const targetFailure = await validateTaskRunTarget(
      options.preparedWorkspace,
      observation,
      frozen,
      context.taskRunId,
    );
    if (targetFailure !== undefined) {
      return failed(targetFailure);
    }

    const identity = await checkRepositoryIdentity({
      cwd: observation.cwd,
      remote: frozen.identity.remote,
      expectedUrl: frozen.identity.expected_url,
    });
    if (
      identity.status !== "matching" ||
      identity.actualUrl !== frozen.identity.actual_url
    ) {
      return failed(policyFailure(
        "REPOSITORY_IDENTITY_MISMATCH",
        `Repository ${frozen.id} does not match its frozen identity`,
        { repository_id: frozen.id, identity_status: identity.status },
      ));
    }

    const changes = await getRepositoryChanges({
      cwd: observation.cwd,
      baseCommit: frozen.base_commit,
    });
    if (changes.length === 0) {
      continue;
    }

    const scope = scopes.get(frozen.id);
    if (scope === undefined) {
      return failed(policyFailure(
        "UNAUTHORIZED_REPOSITORY_CHANGE",
        `Repository ${frozen.id} has changes but is not authorized by the Task Contract`,
        { repository_id: frozen.id },
      ));
    }
    if (frozen.access === "read-only" || scope.access === "read-only") {
      return failed(policyFailure(
        "READ_ONLY_REPOSITORY_CHANGE",
        `Read-only repository ${frozen.id} has changes`,
        { repository_id: frozen.id, changed_paths: changedPathNames(changes) },
      ));
    }

    for (const path of changedPathNames(changes)) {
      const pathFailure = validateChangedPath(frozen.id, path, scope);
      if (pathFailure !== undefined) {
        return failed(pathFailure);
      }
    }
  }

  return {
    status: "passed",
    summary: "All Engine-observed repository changes are within the Task Contract scope",
    failures: [],
    artifacts: [],
  };
}

function validateObservationSet(
  options: ScopeVerifierOptions,
  context: VerificationContext,
): VerificationFailure | undefined {
  if (
    !isAbsolute(options.preparedWorkspace.taskRunRoot) ||
    !isAbsolute(options.preparedWorkspace.developerWorkspaceReposRoot)
  ) {
    return evidenceFailure("Prepared workspace roots must be absolute paths");
  }
  if (options.preparedWorkspace.taskRunId !== context.taskRunId) {
    return policyFailure(
      "OTHER_TASK_RUN_TARGET",
      "Prepared workspace belongs to another TaskRun",
    );
  }

  const frozen = [options.revisionSet.control, ...options.revisionSet.repositories];
  const expected = expectedObservedRepositories(options.revisionSet);
  const frozenIds = new Set(frozen.map(({ id }) => id));
  const expectedIds = new Set(expected.map(({ id }) => id));
  const scopeIds = new Set<string>();
  for (const scope of options.scopes) {
    if (scopeIds.has(scope.repository)) {
      return evidenceFailure(`Duplicate Task Contract scope for ${scope.repository}`);
    }
    scopeIds.add(scope.repository);
    const revision = frozen.find(({ id }) => id === scope.repository);
    if (revision === undefined) {
      return evidenceFailure(`Task Contract scope ${scope.repository} is absent from the Revision Set`);
    }
    if (scope.access !== revision.access) {
      return evidenceFailure(`Task Contract and Revision Set access disagree for ${scope.repository}`);
    }
  }

  const observedIds = new Set<string>();
  for (const observation of options.repositories) {
    if (observation.repositoryId.trim().length === 0 || !isAbsolute(observation.cwd)) {
      return evidenceFailure("Repository observations require an ID and absolute cwd");
    }
    if (observedIds.has(observation.repositoryId)) {
      return evidenceFailure(`Duplicate repository observation for ${observation.repositoryId}`);
    }
    if (!frozenIds.has(observation.repositoryId)) {
      return policyFailure(
        "UNAUTHORIZED_REPOSITORY_CHANGE",
        `Repository observation ${observation.repositoryId} is not authorized by the frozen TaskRun`,
        { repository_id: observation.repositoryId },
      );
    }
    if (!expectedIds.has(observation.repositoryId)) {
      return evidenceFailure(
        `Repository observation ${observation.repositoryId} has no prepared TaskRun worktree`,
      );
    }
    if (observation.taskRunId !== context.taskRunId) {
      return policyFailure(
        "OTHER_TASK_RUN_TARGET",
        `Repository ${observation.repositoryId} belongs to another TaskRun`,
        { repository_id: observation.repositoryId },
      );
    }
    observedIds.add(observation.repositoryId);
  }
  if (observedIds.size !== expectedIds.size) {
    return evidenceFailure("Repository observation set is incomplete");
  }
  return undefined;
}

async function validateTaskRunTarget(
  preparedWorkspace: ScopePreparedWorkspace,
  observation: ScopeRepositoryObservation,
  frozen: FrozenRepository,
  taskRunId: string,
): Promise<VerificationFailure | undefined> {
  if (observation.taskRunId !== taskRunId) {
    return policyFailure("OTHER_TASK_RUN_TARGET", "Repository belongs to another TaskRun");
  }
  const canonicalRoot = await realpath(preparedWorkspace.taskRunRoot);
  const canonicalWorkspaceReposRoot = await realpath(
    preparedWorkspace.developerWorkspaceReposRoot,
  );
  const canonicalCwd = await realpath(observation.cwd);
  if (
    isPathAtOrWithin(canonicalRoot, canonicalWorkspaceReposRoot) ||
    isPathAtOrWithin(canonicalCwd, canonicalWorkspaceReposRoot)
  ) {
    return policyFailure(
      "WORKSPACE_REPOS_TARGET",
      "workspace/repos is never a formal TaskRun write target",
      { repository_id: frozen.id },
    );
  }
  const expected = frozen.id === "@control"
    ? resolve(canonicalRoot, "control")
    : resolve(canonicalRoot, "repositories", frozen.id);
  if (canonicalCwd !== expected) {
    return policyFailure(
      "OTHER_TASK_RUN_TARGET",
      `Repository ${frozen.id} is outside its current TaskRun location`,
      { repository_id: frozen.id },
    );
  }
  const repositoryRoot = await realpath(await getRepositoryRoot({ cwd: canonicalCwd }));
  if (repositoryRoot !== canonicalCwd) {
    return policyFailure(
      "OTHER_TASK_RUN_TARGET",
      `Repository ${frozen.id} cwd is not its worktree root`,
      { repository_id: frozen.id },
    );
  }
  return undefined;
}

function isPathAtOrWithin(path: string, boundary: string): boolean {
  const relation = relative(boundary, path);
  return relation === "" || (
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

function validateChangedPath(
  repositoryId: string,
  path: string,
  scope: TaskContractRepositoryScope,
): VerificationFailure | undefined {
  if (!isNormalizedRepositoryPath(path)) {
    return policyFailure(
      "INVALID_CHANGED_PATH",
      `Repository ${repositoryId} produced a non-normalized changed path`,
      { repository_id: repositoryId, path },
    );
  }
  if (
    repositoryId === "@control" &&
    protectedControlPathPatterns.some((pattern) => matchesPathPattern(path, pattern))
  ) {
    return policyFailure(
      "PROTECTED_CONTROL_PATH",
      `Protected control-plane path ${path} was modified`,
      { repository_id: repositoryId, path },
    );
  }
  if (scope.forbidden_paths.some((pattern) => matchesPathPattern(path, pattern))) {
    return policyFailure(
      "FORBIDDEN_PATH",
      `Forbidden path ${path} was modified in repository ${repositoryId}`,
      { repository_id: repositoryId, path },
      "repairable",
    );
  }
  if (!scope.allowed_paths.some((pattern) => matchesPathPattern(path, pattern))) {
    return policyFailure(
      "UNAUTHORIZED_PATH",
      `Path ${path} is outside the allowed scope for repository ${repositoryId}`,
      { repository_id: repositoryId, path },
      "repairable",
    );
  }
  return undefined;
}

export function matchesPathPattern(path: string, pattern: string): boolean {
  if (!isNormalizedRepositoryPath(path) || !isNormalizedPattern(pattern)) {
    return false;
  }
  const pathSegments = path.split("/");
  const patternSegments = pattern.split("/");
  const memo = new Map<string, boolean>();

  const matches = (pathIndex: number, patternIndex: number): boolean => {
    const key = `${pathIndex}:${patternIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }

    let result: boolean;
    if (patternIndex === patternSegments.length) {
      result = pathIndex === pathSegments.length;
    } else if (patternSegments[patternIndex] === "**") {
      result = matches(pathIndex, patternIndex + 1) ||
        (pathIndex < pathSegments.length && matches(pathIndex + 1, patternIndex));
    } else {
      result = pathIndex < pathSegments.length &&
        matchesPathSegment(pathSegments[pathIndex]!, patternSegments[patternIndex]!) &&
        matches(pathIndex + 1, patternIndex + 1);
    }
    memo.set(key, result);
    return result;
  };

  return matches(0, 0);
}

function expectedObservedRepositories(revisionSet: RevisionSet): readonly FrozenRepository[] {
  return revisionSet.control.access === "read-write"
    ? [revisionSet.control, ...revisionSet.repositories]
    : revisionSet.repositories;
}

function matchesPathSegment(pathSegment: string, patternSegment: string): boolean {
  const expression = patternSegment
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${expression}$`).test(pathSegment);
}

function isNormalizedPattern(pattern: string): boolean {
  return pattern.trim().length > 0 &&
    !isAbsolute(pattern) &&
    !/^[A-Za-z]:/.test(pattern) &&
    !pattern.includes("\\") &&
    pattern.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isNormalizedRepositoryPath(path: string): boolean {
  return isNormalizedPattern(path) && !path.includes("*");
}

function changedPathNames(changes: readonly GitChangedPath[]): string[] {
  return changes.flatMap((change) =>
    change.originalPath === undefined ? [change.path] : [change.originalPath, change.path],
  );
}

function failed(failure: VerificationFailure): VerifierOutput {
  return { status: "failed", summary: failure.message, failures: [failure], artifacts: [] };
}

function evidenceFailure(message: string): VerificationFailure {
  return {
    code: "SCOPE_EVIDENCE_INVALID",
    category: "evidence",
    repairability: "non_repairable",
    message,
  };
}

function policyFailure(
  code: string,
  message: string,
  details?: Record<string, string | string[]>,
  repairability: "repairable" | "non_repairable" = "non_repairable",
): VerificationFailure {
  return {
    code,
    category: "policy",
    repairability,
    message,
    ...(details === undefined ? {} : { details }),
  };
}
