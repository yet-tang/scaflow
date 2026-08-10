import { createHash } from "node:crypto";
import {
  close,
  fstatSync,
  ftruncate,
  openSync,
  write,
} from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  verificationArtifactReferenceSchema,
  verificationResultSchema,
  verifierResultSchema,
  type VerificationArtifactReference,
  type VerificationFailure,
  type VerificationResult,
  type VerifierResult,
} from "@scaflow/schemas";

export const packageName = "@scaflow/verification";

export const verificationStopPolicies = Object.freeze([
  "continue",
  "stop_on_failure",
] as const);
export type VerificationStopPolicy = (typeof verificationStopPolicies)[number];

export interface VerificationEvidence {
  readonly verifierId: string;
  readonly authority: "engine_observed" | "agent_reported";
  readonly status: "passed" | "failed";
  readonly value: unknown;
}

export interface VerificationContext {
  readonly taskRunId: string;
  readonly evidence: readonly VerificationEvidence[];
}

export interface VerifierOutput {
  readonly status: "passed" | "failed";
  readonly summary: string;
  readonly failures: readonly VerificationFailure[];
  readonly artifacts: readonly VerificationArtifactReference[];
}

export interface Verifier {
  readonly id: string;
  verify(context: VerificationContext): Promise<VerifierOutput>;
}

export interface RunVerifiersOptions {
  readonly stopPolicy?: VerificationStopPolicy;
}

export async function runVerifiers(
  verifiers: readonly Verifier[],
  context: VerificationContext,
  options: RunVerifiersOptions = {},
): Promise<VerificationResult> {
  validateVerifierRegistry(verifiers);
  const stopPolicy = options.stopPolicy ?? "continue";
  if (!verificationStopPolicies.includes(stopPolicy)) {
    throw new TypeError(`Unsupported verification stop policy "${stopPolicy}"`);
  }

  const results: VerifierResult[] = [];
  let stopped = false;
  for (const verifier of verifiers) {
    if (stopped) {
      results.push(
        verifierResultSchema.parse({
          verifier_id: verifier.id,
          status: "skipped",
          summary: "Skipped because the configured stop policy halted verification",
          failures: [],
          artifacts: [],
        }),
      );
      continue;
    }

    const result = await executeVerifier(verifier, context);
    results.push(result);
    if (result.status === "failed" && stopPolicy === "stop_on_failure") {
      stopped = true;
    }
  }

  const failures = results.flatMap(({ failures: resultFailures }) => resultFailures);
  const artifacts = results.flatMap(({ artifacts: resultArtifacts }) => resultArtifacts);
  return verificationResultSchema.parse({
    status: results.some(({ status }) => status === "failed") ? "failed" : "passed",
    verifier_results: results,
    failures,
    artifacts,
  });
}

async function executeVerifier(
  verifier: Verifier,
  context: VerificationContext,
): Promise<VerifierResult> {
  try {
    const output = await verifier.verify(context);
    const contradicted = context.evidence.some(
      (evidence) =>
        evidence.verifierId === verifier.id &&
        evidence.authority === "engine_observed" &&
        evidence.status === "failed",
    );

    if (contradicted && output.status === "passed") {
      return verifierResultSchema.parse({
        verifier_id: verifier.id,
        status: "failed",
        summary: "Verifier pass contradicted Engine-observed failure evidence",
        failures: [
          {
            code: "EVIDENCE_CONTRADICTION",
            category: "evidence",
            repairability: "unknown",
            message: "Agent or verifier output cannot override Engine-observed failure evidence",
          },
        ],
        artifacts: output.artifacts,
      });
    }

    return verifierResultSchema.parse({
      verifier_id: verifier.id,
      ...output,
    });
  } catch (error) {
    return verifierResultSchema.parse({
      verifier_id: verifier.id,
      status: "failed",
      summary: "Verifier execution failed",
      failures: [
        {
          code: "VERIFIER_EXECUTION_ERROR",
          category: "verifier",
          repairability: "unknown",
          message: error instanceof Error ? error.message : "Verifier threw a non-Error value",
        },
      ],
      artifacts: [],
    });
  }
}

function validateVerifierRegistry(verifiers: readonly Verifier[]): void {
  if (verifiers.length === 0) {
    throw new TypeError("At least one verifier is required");
  }
  const ids = new Set<string>();
  for (const verifier of verifiers) {
    if (verifier.id.trim().length === 0) {
      throw new TypeError("Verifier IDs must not be empty");
    }
    if (ids.has(verifier.id)) {
      throw new TypeError(`Duplicate verifier ID "${verifier.id}"`);
    }
    ids.add(verifier.id);
  }
}

export interface WriteVerificationArtifactInput {
  readonly id: string;
  readonly path: string;
  readonly mediaType: string;
  readonly data: string | Uint8Array;
}

export interface OpenVerificationArtifactInput {
  readonly id: string;
  readonly path: string;
  readonly mediaType: string;
}

export interface VerificationArtifactWriter {
  write(chunk: Uint8Array): Promise<void>;
  complete(): Promise<VerificationArtifactReference>;
  abort(): Promise<void>;
}

class OpenVerificationArtifactWriter implements VerificationArtifactWriter {
  readonly #input: OpenVerificationArtifactInput;
  readonly #root: string;
  readonly #rootIdentity: DirectoryIdentity;
  readonly #artifactPath: string;
  readonly #destination: string;
  readonly #fileIdentity: FileIdentity;
  readonly #fileDescriptor: number;
  readonly #hash = createHash("sha256");
  #byteLength = 0;
  #state: "open" | "completed" | "aborted" = "open";

  constructor(input: OpenVerificationArtifactInput, root: string, rootIdentity: DirectoryIdentity,
    artifactPath: string, destination: string, fileIdentity: FileIdentity, fileDescriptor: number) {
    this.#input = input;
    this.#root = root;
    this.#rootIdentity = rootIdentity;
    this.#artifactPath = artifactPath;
    this.#destination = destination;
    this.#fileIdentity = fileIdentity;
    this.#fileDescriptor = fileDescriptor;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.#state !== "open") throw new TypeError("Artifact writer is already closed");
    await revalidateArtifactRoot(this.#root, this.#rootIdentity);
    const data = Buffer.from(chunk);
    let offset = 0;
    while (offset < data.byteLength) {
      const bytesWritten = await writeArtifactData(this.#fileDescriptor, data, offset);
      if (bytesWritten === 0) throw new Error("Artifact write made no progress");
      offset += bytesWritten;
    }
    this.#hash.update(data);
    this.#byteLength += data.byteLength;
  }

  async complete(): Promise<VerificationArtifactReference> {
    if (this.#state !== "open") throw new TypeError("Artifact writer is already closed");
    try {
      await revalidateArtifactRoot(this.#root, this.#rootIdentity);
      await assertArtifactIdentity(this.#destination, this.#fileIdentity);
      const artifact = verificationArtifactReferenceSchema.parse({
        id: this.#input.id,
        path: this.#artifactPath,
        media_type: this.#input.mediaType,
        byte_length: this.#byteLength,
        sha256: this.#hash.digest("hex"),
      });
      await closeArtifact(this.#fileDescriptor);
      this.#state = "completed";
      return artifact;
    } catch (error) {
      this.#state = "aborted";
      await cleanupIncompleteArtifact(this.#fileDescriptor, this.#root, this.#rootIdentity,
        this.#destination, this.#fileIdentity);
      throw error;
    }
  }

  async abort(): Promise<void> {
    if (this.#state === "completed" || this.#state === "aborted") return;
    this.#state = "aborted";
    await cleanupIncompleteArtifact(this.#fileDescriptor, this.#root, this.#rootIdentity,
      this.#destination, this.#fileIdentity);
  }
}

export interface VerificationArtifactStoreHooks {
  readonly afterArtifactParentValidation?: () => void;
}

export interface VerificationArtifactStoreOptions {
  readonly hooks?: VerificationArtifactStoreHooks;
}

export class VerificationArtifactStore {
  readonly #root: string;
  readonly #rootIdentity: DirectoryIdentity;
  readonly #options: VerificationArtifactStoreOptions;

  private constructor(root: string, rootIdentity: DirectoryIdentity,
    options: VerificationArtifactStoreOptions) {
    this.#root = root;
    this.#rootIdentity = rootIdentity;
    this.#options = options;
  }

  static async create(evidenceDirectory: string,
    options: VerificationArtifactStoreOptions = {}): Promise<VerificationArtifactStore> {
    if (evidenceDirectory.trim().length === 0) {
      throw new TypeError("Evidence directory must not be empty");
    }
    await mkdir(evidenceDirectory, { recursive: true });
    const root = await realpath(evidenceDirectory);
    const rootIdentity = await directoryIdentity(root);
    return new VerificationArtifactStore(root, rootIdentity, options);
  }

  async write(input: WriteVerificationArtifactInput): Promise<VerificationArtifactReference> {
    const data = typeof input.data === "string" ? Buffer.from(input.data) : Buffer.from(input.data);
    const writer = await this.open(input);
    try {
      await writer.write(data);
      return await writer.complete();
    } catch (error) {
      await writer.abort();
      throw error;
    }
  }

  async open(input: OpenVerificationArtifactInput): Promise<VerificationArtifactWriter> {
    validateRelativeArtifactPath(input.path);
    verificationArtifactReferenceSchema.pick({ id: true, path: true, media_type: true }).parse({
      id: input.id,
      path: input.path,
      media_type: input.mediaType,
    });
    await validateLogicalArtifactParent(this.#root, input.path.split("/").slice(0, -1));
    await revalidateArtifactRoot(this.#root, this.#rootIdentity);
    this.#options.hooks?.afterArtifactParentValidation?.();
    await revalidateArtifactRoot(this.#root, this.#rootIdentity);
    const artifactPath = flatArtifactPath(input.path);
    const destination = resolve(this.#root, artifactPath);
    const fileDescriptor = openSync(destination, "wx", 0o600);
    try {
      const fileIdentity = identityForOpenArtifact(fileDescriptor);
      await revalidateArtifactRoot(this.#root, this.#rootIdentity);
      await assertArtifactIdentity(destination, fileIdentity);
      return new OpenVerificationArtifactWriter(input, this.#root, this.#rootIdentity,
        artifactPath, destination, fileIdentity, fileDescriptor);
    } catch (error) {
      await truncateArtifact(fileDescriptor).catch(() => undefined);
      await closeArtifact(fileDescriptor).catch(() => undefined);
      throw error;
    }
  }
}

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

function identityForOpenArtifact(fileDescriptor: number): FileIdentity {
  const stats = fstatSync(fileDescriptor);
  if (!stats.isFile()) throw new TypeError("Artifact destination must be a regular file");
  return { device: stats.dev, inode: stats.ino };
}

function flatArtifactPath(requestedPath: string): string {
  return `artifact-${createHash("sha256").update(requestedPath).digest("hex")}.data`;
}

async function assertArtifactIdentity(path: string, identity: FileIdentity): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile() ||
      stats.dev !== identity.device || stats.ino !== identity.inode) {
    throw new TypeError("Artifact destination changed during validation");
  }
}

async function cleanupIncompleteArtifact(fileDescriptor: number, root: string,
  rootIdentity: DirectoryIdentity, path: string, identity: FileIdentity): Promise<void> {
  let handleError: unknown;
  try {
    await truncateArtifact(fileDescriptor);
  } catch (error) {
    handleError = error;
  }
  try {
    await closeArtifact(fileDescriptor);
  } catch (error) {
    handleError ??= error;
  }
  if (handleError !== undefined) throw handleError;

  await revalidateArtifactRoot(root, rootIdentity);
  await assertArtifactIdentity(path, identity);
}

function writeArtifactData(fileDescriptor: number, data: Buffer, offset: number): Promise<number> {
  return new Promise((resolveWrite, rejectWrite) => {
    write(fileDescriptor, data, offset, data.byteLength - offset, null, (error, bytesWritten) => {
      if (error !== null) rejectWrite(error);
      else resolveWrite(bytesWritten);
    });
  });
}

function truncateArtifact(fileDescriptor: number): Promise<void> {
  return new Promise((resolveTruncate, rejectTruncate) => {
    ftruncate(fileDescriptor, 0, (error) => {
      if (error !== null) rejectTruncate(error);
      else resolveTruncate();
    });
  });
}

function closeArtifact(fileDescriptor: number): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    close(fileDescriptor, (error) => {
      if (error !== null) rejectClose(error);
      else resolveClose();
    });
  });
}

function validateRelativeArtifactPath(path: string): void {
  if (
    path.trim().length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new TypeError("Artifact path must be a normalized relative POSIX path without traversal");
  }
}

interface DirectoryIdentity {
  readonly path: string;
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
}

async function validateLogicalArtifactParent(
  root: string,
  segments: readonly string[],
): Promise<void> {
  let current = root;

  for (const segment of segments) {
    current = resolve(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }

    if (stats.isSymbolicLink()) {
      throw new TypeError("Artifact path resolves outside the evidence directory through a symbolic link");
    }
    if (!stats.isDirectory()) {
      throw new TypeError("Artifact path parent components must be directories");
    }

    const canonicalPath = await realpath(current);
    assertWithinRoot(root, canonicalPath);
  }
}

async function directoryIdentity(path: string): Promise<DirectoryIdentity> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new TypeError("Evidence directory must be a canonical directory");
  }
  return { path, canonicalPath: await realpath(path), device: stats.dev, inode: stats.ino };
}

async function revalidateArtifactRoot(root: string, identity: DirectoryIdentity): Promise<void> {
  const current = await directoryIdentity(root);
  if (current.device !== identity.device || current.inode !== identity.inode ||
      current.canonicalPath !== identity.canonicalPath) {
    throw new TypeError("Evidence directory changed during artifact writing");
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertWithinRoot(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new TypeError("Artifact path resolves outside the evidence directory");
  }
}

export {
  CommandRunner,
  type CommandEnvironment,
  type CommandOutcome,
  type CommandResult,
  type CommandRunnerOptions,
  type PrevalidatedShellDecision,
  type RepositoryWorktree,
  type ShellCommand,
  type StructuredCommand,
} from "./command.js";

export {
  COMMAND_VERIFIER_ID,
  createCommandVerifier,
  verifyTaskContractCommands,
  type CommandExecutor,
  type CommandVerificationResult,
  type CommandVerifierOptions,
} from "./command-verifier.js";

export {
  SCOPE_VERIFIER_ID,
  createScopeVerifier,
  matchesPathPattern,
  protectedControlPathPatterns,
  type ScopePreparedWorkspace,
  type ScopeRepositoryObservation,
  type ScopeVerifierOptions,
} from "./scope.js";
