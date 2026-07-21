import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
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

export class VerificationArtifactStore {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  static async create(evidenceDirectory: string): Promise<VerificationArtifactStore> {
    if (evidenceDirectory.trim().length === 0) {
      throw new TypeError("Evidence directory must not be empty");
    }
    await mkdir(evidenceDirectory, { recursive: true });
    return new VerificationArtifactStore(await realpath(evidenceDirectory));
  }

  async write(input: WriteVerificationArtifactInput): Promise<VerificationArtifactReference> {
    validateRelativeArtifactPath(input.path);
    const data = typeof input.data === "string" ? Buffer.from(input.data) : Buffer.from(input.data);
    const artifact = verificationArtifactReferenceSchema.parse({
      id: input.id,
      path: input.path,
      media_type: input.mediaType,
      byte_length: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
    const destination = resolve(this.#root, ...input.path.split("/"));
    const parentSegments = input.path.split("/").slice(0, -1);
    const directoryIdentities = await prepareArtifactParent(this.#root, parentSegments);
    await revalidateArtifactParent(this.#root, directoryIdentities);

    await writeFile(destination, data, { flag: "wx" });
    return artifact;
  }
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

async function prepareArtifactParent(
  root: string,
  segments: readonly string[],
): Promise<readonly DirectoryIdentity[]> {
  const identities: DirectoryIdentity[] = [];
  let current = root;

  for (const segment of segments) {
    await revalidateArtifactParent(root, identities);
    current = resolve(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      await revalidateArtifactParent(root, identities);
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if (!isExistingPathError(mkdirError)) {
          throw mkdirError;
        }
      }
      stats = await lstat(current);
    }

    if (stats.isSymbolicLink()) {
      throw new TypeError("Artifact path resolves outside the evidence directory through a symbolic link");
    }
    if (!stats.isDirectory()) {
      throw new TypeError("Artifact path parent components must be directories");
    }

    const canonicalPath = await realpath(current);
    assertWithinRoot(root, canonicalPath);
    identities.push({
      path: current,
      canonicalPath,
      device: stats.dev,
      inode: stats.ino,
    });
  }

  return identities;
}

async function revalidateArtifactParent(
  root: string,
  identities: readonly DirectoryIdentity[],
): Promise<void> {
  for (const identity of identities) {
    const stats = await lstat(identity.path);
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      stats.dev !== identity.device ||
      stats.ino !== identity.inode
    ) {
      throw new TypeError("Artifact path parent changed during validation");
    }

    const canonicalPath = await realpath(identity.path);
    assertWithinRoot(root, canonicalPath);
    if (canonicalPath !== identity.canonicalPath) {
      throw new TypeError("Artifact path parent changed during validation");
    }
  }

  const parent = identities.at(-1)?.path ?? root;
  const canonicalParent = await realpath(parent);
  assertWithinRoot(root, canonicalParent);
  if (identities.length > 0 && canonicalParent !== identities.at(-1)?.canonicalPath) {
    throw new TypeError("Artifact path parent changed during validation");
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isExistingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function assertWithinRoot(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new TypeError("Artifact path resolves outside the evidence directory");
  }
}
