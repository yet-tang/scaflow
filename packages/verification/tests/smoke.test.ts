import { createHash } from "node:crypto";
import { renameSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  VerificationArtifactStore,
  packageName,
  runVerifiers,
  type Verifier,
} from "../src/index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("@scaflow/verification", () => {
  it("exposes package identity", () => {
    expect(packageName).toBe("@scaflow/verification");
  });

  it("executes composed verifiers sequentially in declared order", async () => {
    const order: string[] = [];
    const verifiers = [passingVerifier("schema", order), passingVerifier("commands", order)];

    const result = await runVerifiers(verifiers, {
      taskRunId: "task-run-1",
      evidence: [],
    });

    expect(order).toEqual(["schema", "commands"]);
    expect(result.status).toBe("passed");
    expect(result.verifier_results.map(({ verifier_id }) => verifier_id)).toEqual([
      "schema",
      "commands",
    ]);
  });

  it("uses an explicit stop policy and records skipped verifiers", async () => {
    const neverCalled = vi.fn();
    const result = await runVerifiers(
      [failingVerifier("scope"), { id: "commands", verify: neverCalled }],
      { taskRunId: "task-run-1", evidence: [] },
      { stopPolicy: "stop_on_failure" },
    );

    expect(neverCalled).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.verifier_results.map(({ status }) => status)).toEqual([
      "failed",
      "skipped",
    ]);
  });

  it("does not let Agent-reported claims override Engine-observed failures", async () => {
    const result = await runVerifiers([passingVerifier("commands")], {
      taskRunId: "task-run-1",
      evidence: [
        { verifierId: "commands", authority: "agent_reported", status: "passed", value: "all good" },
        { verifierId: "commands", authority: "engine_observed", status: "failed", value: { exitCode: 1 } },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.failures).toEqual([
      expect.objectContaining({
        code: "EVIDENCE_CONTRADICTION",
        category: "evidence",
        repairability: "unknown",
      }),
    ]);
  });

  it("turns verifier exceptions into structured failures", async () => {
    const result = await runVerifiers(
      [{ id: "broken", async verify() { throw new Error("fixture failure"); } }],
      { taskRunId: "task-run-1", evidence: [] },
    );

    expect(result).toMatchObject({
      status: "failed",
      failures: [{ code: "VERIFIER_EXECUTION_ERROR", category: "verifier" }],
    });
  });

  it("writes portable artifact references only within an explicit evidence root", async () => {
    const root = await temporaryDirectory("scaflow-evidence-");
    const store = await VerificationArtifactStore.create(root);
    const requestedPath = "verification/run-1/stdout.txt";
    const artifact = await store.write({
      id: "command-output",
      path: requestedPath,
      mediaType: "text/plain",
      data: "hello\n",
    });

    expect(artifact).toMatchObject({
      id: "command-output",
      media_type: "text/plain",
      byte_length: 6,
    });
    expect(artifact.path).toBe(flatArtifactPath(requestedPath));
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(root, artifact.path), "utf8")).toBe("hello\n");
    await expect(
      store.write({ id: "bad", path: "../outside.txt", mediaType: "text/plain", data: "bad" }),
    ).rejects.toThrow("without traversal");
    await expect(
      store.write({ id: "absolute", path: join(root, "absolute.txt"), mediaType: "text/plain", data: "bad" }),
    ).rejects.toThrow("without traversal");
    await expect(
      store.write({ id: "backslash", path: "verification\\outside.txt", mediaType: "text/plain", data: "bad" }),
    ).rejects.toThrow("without traversal");
    await expect(
      store.write({ id: "drive", path: "C:/outside.txt", mediaType: "text/plain", data: "bad" }),
    ).rejects.toThrow("without traversal");
    await expect(
      store.write({ id: "", path: "verification/invalid.txt", mediaType: "text/plain", data: "bad" }),
    ).rejects.toThrow();
    await expect(readFile(join(root, "verification/invalid.txt"))).rejects.toThrow();
    await expect(
      store.write({ id: "duplicate", path: requestedPath, mediaType: "text/plain", data: "replacement" }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(root, artifact.path), "utf8")).toBe("hello\n");
  });

  it("rejects artifact paths that escape through a pre-existing symlink", async () => {
    const root = await temporaryDirectory("scaflow-evidence-");
    const outside = await temporaryDirectory("scaflow-outside-");
    await mkdir(join(root, "verification"), { recursive: true });
    await symlink(outside, join(root, "verification", "linked"));
    const store = await VerificationArtifactStore.create(root);

    await expect(
      store.write({
        id: "linked",
        path: "verification/linked/output.txt",
        mediaType: "text/plain",
        data: "bad",
      }),
    ).rejects.toThrow("outside the evidence directory");
  });

  it("zeroes incomplete incremental artifacts by identity when a streaming write is aborted", async () => {
    const root = await temporaryDirectory("scaflow-evidence-");
    const store = await VerificationArtifactStore.create(root);
    const writer = await store.open({
      id: "stream-abort",
      path: "verification/stream-abort.txt",
      mediaType: "text/plain",
    });
    await writer.write(Buffer.from("partial secret output"));
    await writer.abort();
    expect(await readFile(join(root, flatArtifactPath("verification/stream-abort.txt")), "utf8")).toBe("");

    const completed = await store.open({
      id: "stream-complete",
      path: "verification/stream-complete.txt",
      mediaType: "text/plain",
    });
    await completed.write(Buffer.from("complete output"));
    await completed.complete();
    await completed.abort();
    expect(await readFile(join(root, flatArtifactPath("verification/stream-complete.txt")), "utf8"))
      .toBe("complete output");
  });

  it("never writes through a logical artifact parent moved outside while its writer is open", async () => {
    const root = await temporaryDirectory("scaflow-evidence-");
    const outside = await temporaryDirectory("scaflow-outside-");
    const active = join(root, "verification", "active");
    await mkdir(active, { recursive: true });
    const outsideSentinel = join(outside, "sentinel.txt");
    await writeFile(outsideSentinel, "outside sentinel");
    const store = await VerificationArtifactStore.create(root);
    const writer = await store.open({ id: "abort-swap", path: "verification/active/output.txt",
      mediaType: "text/plain" });

    await rename(active, join(outside, "moved-parent"));
    await writer.write(Buffer.from("incomplete secret"));
    await writer.abort();

    expect(await readFile(outsideSentinel, "utf8")).toBe("outside sentinel");
    await expect(stat(join(outside, "moved-parent", "output.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, flatArtifactPath("verification/active/output.txt")), "utf8")).toBe("");
  });

  it("keeps completed artifacts contained when a logical parent moves outside during streaming", async () => {
    const root = await temporaryDirectory("scaflow-evidence-");
    const outside = await temporaryDirectory("scaflow-outside-");
    const active = join(root, "verification", "active");
    await mkdir(active, { recursive: true });
    const store = await VerificationArtifactStore.create(root);
    const writer = await store.open({ id: "complete-swap", path: "verification/active/output.txt",
      mediaType: "text/plain" });

    await rename(active, join(outside, "moved-parent"));
    await writer.write(Buffer.from("complete output"));
    const artifact = await writer.complete();

    await expect(stat(join(outside, "moved-parent", "output.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(artifact.path).toBe(flatArtifactPath("verification/active/output.txt"));
    expect(await readFile(join(root, artifact.path), "utf8")).toBe("complete output");
  });

  it("opens its safe flat sink even if the unused logical parent moves at the open seam", async () => {
    const root = await temporaryDirectory("scaflow-evidence-");
    const outside = await temporaryDirectory("scaflow-outside-");
    const active = join(root, "verification", "active");
    await mkdir(active, { recursive: true });
    const store = await VerificationArtifactStore.create(root, { hooks: {
      afterArtifactParentValidation() {
        renameSync(active, join(outside, "moved-parent"));
      },
    } });

    const writer = await store.open({ id: "open-swap", path: "verification/active/output.txt",
      mediaType: "text/plain" });
    await writer.write(Buffer.from("safe"));
    const artifact = await writer.complete();
    await expect(stat(join(outside, "moved-parent", "output.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, artifact.path), "utf8")).toBe("safe");
  });

  it("rejects a symlink before creating a missing descendant outside the evidence root", async () => {
    const root = await temporaryDirectory("scaflow-evidence-");
    const outside = await temporaryDirectory("scaflow-outside-");
    await mkdir(join(root, "verification"));
    await symlink(outside, join(root, "verification", "linked"));
    const store = await VerificationArtifactStore.create(root);
    const outsideDescendant = join(outside, "new-directory");
    const outsideArtifact = join(outsideDescendant, "output.txt");

    await expect(
      store.write({
        id: "linked-descendant",
        path: "verification/linked/new-directory/output.txt",
        mediaType: "text/plain",
        data: "bad",
      }),
    ).rejects.toThrow("outside the evidence directory");
    await expect(stat(outsideDescendant)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(outsideArtifact)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function passingVerifier(id: string, order?: string[]): Verifier {
  return {
    id,
    async verify() {
      order?.push(id);
      return { status: "passed", summary: `${id} passed`, failures: [], artifacts: [] };
    },
  };
}

function failingVerifier(id: string): Verifier {
  return {
    id,
    async verify() {
      return {
        status: "failed",
        summary: `${id} failed`,
        failures: [
          {
            code: "FIXTURE_FAILURE",
            category: "policy",
            repairability: "non_repairable",
            message: "Fixture failure",
          },
        ],
        artifacts: [],
      };
    },
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function flatArtifactPath(requestedPath: string): string {
  return `artifact-${createHash("sha256").update(requestedPath).digest("hex")}.data`;
}
