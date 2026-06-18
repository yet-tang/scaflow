import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { projectConfigSchema } from "../../schemas/src/index";
import {
  defaultProjectTemplatePath,
  packageName,
  renderProjectTemplate,
} from "../src/index";
import { renderEntriesNative } from "../src/native";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("@scaflow/template", () => {
  it("exposes package identity and the bundled default template", async () => {
    expect(packageName).toBe("@scaflow/template");
    await expect(access(defaultProjectTemplatePath)).resolves.toBeUndefined();
  });

  it("renders the complete default SPR skeleton and executable launcher", async () => {
    const destination = await temporaryDirectory("scaflow-template-");
    const result = await renderProjectTemplate(destination);

    for (const file of [
      "scaflow.yaml",
      "repositories.yaml",
      "AGENTS.md",
      "PRODUCT.md",
      "ARCHITECTURE.md",
      ".gitignore",
      "scaflow",
    ]) {
      await expect(access(join(destination, file))).resolves.toBeUndefined();
    }
    for (const directory of [
      "docs",
      "tasks",
      "changesets",
      "policies",
      "workflows",
      "environments",
      "skills",
      "plugins",
    ]) {
      expect((await lstat(join(destination, directory))).isDirectory()).toBe(
        true,
      );
    }
    expect((await lstat(join(destination, "scaflow"))).mode & 0o111).toBe(
      0o111,
    );
    expect(result.created).toContain("scaflow.yaml");
    expect(await readFile(join(destination, ".gitignore"), "utf8")).toContain(
      "/workspace/",
    );
    expect(await readFile(join(destination, ".gitignore"), "utf8")).toContain(
      "/.scaflow/",
    );
    const projectConfig = JSON.parse(
      await readFile(join(destination, "scaflow.yaml"), "utf8"),
    );
    expect(projectConfigSchema.parse(projectConfig)).toEqual({
      version: 1,
      project: { id: "project-id", name: "Project Name" },
      engine: { version: "0.1.0" },
    });
  });

  it("never overwrites modified or concurrently published files", async () => {
    const destination = await temporaryDirectory("scaflow-template-");
    await writeFile(join(destination, "PRODUCT.md"), "user content\n");

    const first = await renderProjectTemplate(destination);
    const second = await renderProjectTemplate(destination);

    expect(await readFile(join(destination, "PRODUCT.md"), "utf8")).toBe(
      "user content\n",
    );
    expect(first.skipped).toContain("PRODUCT.md");
    expect(second.created).toEqual([]);
    expect(second.skipped).toContain("PRODUCT.md");

    const raceDestination = await temporaryDirectory(
      "scaflow-template-race-",
    );
    const entries = [
      {
        path: "race.txt",
        type: "file" as const,
        content: Buffer.from("template"),
        mode: 0o644,
      },
    ];
    renderEntriesNative(raceDestination, entries, {
      afterDestinationOpen: () => {
        writeFileSync(join(raceDestination, "race.txt"), "publisher", {
          flag: "wx",
        });
      },
    });
    expect(await readFile(join(raceDestination, "race.txt"), "utf8")).toBe(
      "publisher",
    );
  });

  it("atomically resolves concurrent renderer publication", async () => {
    const destination = await temporaryDirectory(
      "scaflow-template-workers-",
    );
    const nativePath = fileURLToPath(
      new URL(
        "../build/Release/scaflow_template_native.node",
        import.meta.url,
      ),
    );
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const renderers = [
      runConcurrentRenderer(nativePath, destination, "first", barrier),
      runConcurrentRenderer(nativePath, destination, "second", barrier),
    ];
    await Promise.all(renderers.map(({ ready }) => ready));

    Atomics.store(new Int32Array(barrier), 0, 1);
    Atomics.notify(new Int32Array(barrier), 0, 2);

    const completed = await Promise.all(
      renderers.map(({ completion }) => completion),
    );
    expect(completed.map(({ created }) => created.length).sort()).toEqual([
      0, 1,
    ]);
    expect(["first", "second"]).toContain(
      await readFile(join(destination, "concurrent.txt"), "utf8"),
    );
    expect(await findTemporaryArtifacts(destination)).toEqual([]);
  });

  it("supports symlink ancestry but rejects symlinks below the anchor", async () => {
    const root = await temporaryDirectory("scaflow-template-symlink-");
    const realParent = join(root, "real");
    const linkedParent = join(root, "linked");
    const destination = join(realParent, "project");
    await mkdir(destination, { recursive: true });
    await symlink(realParent, linkedParent);

    await renderProjectTemplate(join(linkedParent, "project"));
    await expect(
      access(join(destination, "scaflow.yaml")),
    ).resolves.toBeUndefined();

    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(destination, "docs-link"));
    expect(() =>
      renderEntriesNative(destination, [
        {
          path: "docs-link/escape.txt",
          type: "file",
          content: Buffer.from("escape"),
          mode: 0o644,
        },
      ]),
    ).toThrow(/Could not open template directory/);
    await expect(access(join(outside, "escape.txt"))).rejects.toThrow();
  });

  it("stays anchored when a destination ancestor is replaced", async () => {
    const root = await temporaryDirectory("scaflow-template-anchor-");
    const parent = join(root, "parent");
    const movedParent = join(root, "moved-parent");
    const replacementParent = join(root, "replacement-parent");
    const destination = join(parent, "project");
    await mkdir(destination, { recursive: true });
    await mkdir(join(replacementParent, "project"), { recursive: true });

    renderEntriesNative(
      destination,
      [
        {
          path: "anchored.txt",
          type: "file",
          content: Buffer.from("anchored"),
          mode: 0o644,
        },
      ],
      {
        afterDestinationOpen: () => {
          renameSync(parent, movedParent);
          renameSync(replacementParent, parent);
        },
      },
    );

    expect(
      await readFile(join(movedParent, "project", "anchored.txt"), "utf8"),
    ).toBe("anchored");
    await expect(
      access(join(parent, "project", "anchored.txt")),
    ).rejects.toThrow();
  });

  it("cleans partial temporary writes and can recover", async () => {
    const destination = await temporaryDirectory("scaflow-template-fail-");
    const entries = [
      {
        path: "nested/retry.txt",
        type: "file" as const,
        content: Buffer.from("complete"),
        mode: 0o644,
      },
    ];

    expect(() =>
      renderEntriesNative(destination, entries, {
        failDuringWritePath: "nested/retry.txt",
      }),
    ).toThrow(/Injected write failure/);
    await expect(
      access(join(destination, "nested", "retry.txt")),
    ).rejects.toThrow();
    expect(await findTemporaryArtifacts(destination)).toEqual([]);

    expect(() =>
      renderEntriesNative(destination, entries, {
        failBeforePublishPath: "nested/retry.txt",
      }),
    ).toThrow(/Injected publication failure/);
    await expect(
      access(join(destination, "nested", "retry.txt")),
    ).rejects.toThrow();
    expect(await findTemporaryArtifacts(destination)).toEqual([]);

    expect(renderEntriesNative(destination, entries).created).toEqual([
      "nested/retry.txt",
    ]);
    expect(
      await readFile(join(destination, "nested", "retry.txt"), "utf8"),
    ).toBe("complete");
    expect(await findTemporaryArtifacts(destination)).toEqual([]);
  });

  it("reports real cleanup failure and recovers the retained inode", async () => {
    const destination = await temporaryDirectory(
      "scaflow-template-cleanup-",
    );
    const entries = [
      {
        path: "retry.txt",
        type: "file" as const,
        content: Buffer.from("complete"),
        mode: 0o644,
      },
    ];

    try {
      expect(() =>
        renderEntriesNative(destination, entries, {
          afterTemporaryFileCreated: () => {
            chmodSync(destination, 0o555);
          },
          failBeforePublishPath: "retry.txt",
        }),
      ).toThrow(/cleanup failed and was retained for recovery/);
    } finally {
      await chmod(destination, 0o755);
    }

    await expect(access(join(destination, "retry.txt"))).rejects.toThrow();
    expect((await findTemporaryArtifacts(destination)).length).toBe(1);

    expect(renderEntriesNative(destination, entries).created).toEqual([
      "retry.txt",
    ]);
    expect(await readFile(join(destination, "retry.txt"), "utf8")).toBe(
      "complete",
    );
    expect(await findTemporaryArtifacts(destination)).toEqual([]);
  });

  it("recovers when identity inspection and cleanup both fail", async () => {
    const destination = await temporaryDirectory(
      "scaflow-template-identity-cleanup-",
    );
    const entries = [
      {
        path: "retry.txt",
        type: "file" as const,
        content: Buffer.from("complete"),
        mode: 0o644,
      },
    ];

    try {
      expect(() =>
        renderEntriesNative(destination, entries, {
          afterTemporaryFileCreated: () => {
            chmodSync(destination, 0o555);
          },
          failIdentityInspectionPath: "retry.txt",
        }),
      ).toThrow(
        /Could not identify temporary template file.*Input\/output error.*cleanup failed and was retained for recovery/,
      );
    } finally {
      await chmod(destination, 0o755);
    }

    await expect(access(join(destination, "retry.txt"))).rejects.toThrow();
    expect((await findTemporaryArtifacts(destination)).length).toBe(1);

    expect(renderEntriesNative(destination, entries).created).toEqual([
      "retry.txt",
    ]);
    expect(await readFile(join(destination, "retry.txt"), "utf8")).toBe(
      "complete",
    );
    expect(await findTemporaryArtifacts(destination)).toEqual([]);
  });

  it("does not remove a substituted temporary-file name", async () => {
    const destination = await temporaryDirectory(
      "scaflow-template-substitute-",
    );
    const entries = [
      {
        path: "retry.txt",
        type: "file" as const,
        content: Buffer.from("complete"),
        mode: 0o644,
      },
    ];

    try {
      expect(() =>
        renderEntriesNative(destination, entries, {
          afterTemporaryFileCreated: () => {
            chmodSync(destination, 0o555);
          },
          failBeforePublishPath: "retry.txt",
        }),
      ).toThrow(/retained for recovery/);
    } finally {
      await chmod(destination, 0o755);
    }

    const [temporaryArtifact] = await findTemporaryArtifacts(destination);
    expect(temporaryArtifact).toBeDefined();
    const retainedOriginal = join(destination, "retained-original");
    await rename(temporaryArtifact!, retainedOriginal);
    await writeFile(temporaryArtifact!, "replacement");

    expect(renderEntriesNative(destination, entries).created).toEqual([
      "retry.txt",
    ]);
    expect(await readFile(temporaryArtifact!, "utf8")).toBe("replacement");
    expect(await readFile(retainedOriginal, "utf8")).toBe("complete");
  });

  it("rejects invalid paths without writing outside the destination", async () => {
    const root = await temporaryDirectory("scaflow-template-path-");
    const destination = join(root, "project");
    await mkdir(destination);

    for (const path of ["../escape", "/absolute", "a//b", "a/./b"]) {
      expect(() =>
        renderEntriesNative(destination, [
          {
            path,
            type: "file",
            content: Buffer.from("invalid"),
            mode: 0o644,
          },
        ]),
      ).toThrow(/Invalid template path/);
    }
    await expect(access(join(root, "escape"))).rejects.toThrow();
  });
});

async function findTemporaryArtifacts(directory: string): Promise<string[]> {
  const artifacts: string[] = [];

  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.name.startsWith(".scaflow-template-")) {
        artifacts.push(path);
      }
    }
  }

  await visit(directory);
  return artifacts;
}

function runConcurrentRenderer(
  nativePath: string,
  destination: string,
  content: string,
  barrier: SharedArrayBuffer,
): {
  ready: Promise<void>;
  completion: Promise<{ created: string[]; skipped: string[] }>;
} {
  const worker = new Worker(
    `
      const { parentPort, workerData } = require("node:worker_threads");
      const binding = require(workerData.nativePath);
      const barrier = new Int32Array(workerData.barrier);
      parentPort.postMessage({ ready: true });
      Atomics.wait(barrier, 0, 0);
      parentPort.postMessage(binding.renderEntries(
        workerData.destination,
        [{
          path: "concurrent.txt",
          type: "file",
          content: Buffer.from(workerData.content),
          mode: 0o644,
        }],
      ));
    `,
    {
      eval: true,
      workerData: { nativePath, destination, content, barrier },
    },
  );

  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveCompletion!: (result: {
    created: string[];
    skipped: string[];
  }) => void;
  let rejectCompletion!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const completion = new Promise<{
    created: string[];
    skipped: string[];
  }>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const rejectWorker = (error: Error) => {
    rejectReady(error);
    rejectCompletion(error);
  };
  worker.on("message", (message) => {
    if (message?.ready === true) {
      resolveReady();
    } else {
      resolveCompletion(message);
    }
  });
  worker.once("error", rejectWorker);
  worker.once("exit", (code) => {
    if (code !== 0) {
      rejectWorker(
        new Error(`Concurrent renderer exited with code ${code}`),
      );
    }
  });
  return { ready, completion };
}
