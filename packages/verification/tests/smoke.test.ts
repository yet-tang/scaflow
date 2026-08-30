import { createHash } from "node:crypto";
import { renameSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAgentResultVerifier,
  createTestIntegrityVerifier,
  VerificationArtifactStore,
  packageName,
  runVerifiers,
  type CommandResult,
  type TestIntegrityEvidence,
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

  it("detects every MVP test-integrity violation from Engine-observed evidence", async () => {
    const result = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
      configurationSources: [
        taskContractSource("tasks/SFL-025/contract.yaml", [verificationCommand("pnpm", ["test"])],
          [verificationCommand("echo", [])]),
        typeScriptConfigurationSource("vitest.config.ts",
          { qualityGates: { pass: true }, coverageThresholds: { lines: 90 } },
          { qualityGates: { pass: false }, coverageThresholds: { lines: 89 } }),
      ],
      changes: [
        { source: "committed", status: "D", path: "tests/deleted.test.ts" },
        { source: "staged", status: "M", path: "tests/protected/fixture.test.ts" },
        { source: "unstaged", status: "M", path: "tests/new.test.ts" },
        { source: "committed", status: "M", path: "tasks/SFL-025/contract.yaml" },
        { source: "committed", status: "M", path: "vitest.config.ts" },
      ],
      sources: sourceEvidence({
        "tests/new.test.ts": ["test('normal', () => {})", "test.only('focused', () => {})"],
      }),
      verificationCommands: [{ path: "tasks/SFL-025/contract.yaml",
        baseline: [verificationCommand("pnpm", ["test"])],
        current: [verificationCommand("echo", [])] }],
      qualityGates: [{ path: "vitest.config.ts", baseline: { pass: true }, current: { pass: false } }],
      coverageThresholds: [{ path: "vitest.config.ts", name: "lines", baseline: 90, current: 89 }],
    }) })], context());

    expect(result.status).toBe("failed");
    expect(result.failures.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "TEST_DELETED",
      "TEST_SKIP_OR_ONLY_ADDED",
      "VERIFICATION_COMMANDS_MODIFIED",
      "QUALITY_GATE_MODIFIED",
      "PROTECTED_TEST_PATH_CHANGED",
      "COVERAGE_THRESHOLD_LOWERED",
    ]));
  });

  it("handles test renames, clean controls, directional thresholds, and skip/only false positives", async () => {
    const renamedAway = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
      changes: [{ source: "committed", status: "R100", originalPath: "tests/old.test.ts",
        path: "src/old.ts" }],
    }) })], context());
    expect(renamedAway.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TEST_DELETED" }),
    ]));

    const renameAndCopyControls = await runVerifiers([createTestIntegrityVerifier({
      evidence: integrityEvidence({
        changes: [
          { source: "committed", status: "R100", originalPath: "tests/old.test.ts",
            path: "tests/new.test.ts" },
          { source: "staged", status: "R100", originalPath: "src/old.ts",
            path: "tests/new-from-source.test.ts" },
          { source: "unstaged", status: "C100", originalPath: "tests/copied.test.ts",
            path: "src/copied.ts" },
        ],
      }),
    })], context());
    expect(renameAndCopyControls.status).toBe("passed");

    const protectedEndpoints = await runVerifiers([createTestIntegrityVerifier({
      evidence: integrityEvidence({
        changes: [
          { source: "committed", status: "R100", originalPath: "tests/protected/old.test.ts",
            path: "tests/moved.test.ts" },
          { source: "staged", status: "C100", originalPath: "tests/source.test.ts",
            path: "tests/protected/copied.test.ts" },
        ],
      }),
    })], context());
    expect(protectedEndpoints.failures.filter(({ code }) =>
      code === "PROTECTED_TEST_PATH_CHANGED")).toHaveLength(2);

    const clean = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
      sources: sourceEvidence({
        "tests/value.test.ts": ["", ["// test.only('documented')", "const text = 'test.skip(';",
          "test('runs', () => {})"].join("\n")],
      }),
      configurationSources: [
        taskContractSource("tasks/SFL-025/contract.yaml", [verificationCommand("pnpm", ["test"])],
          [verificationCommand("pnpm", ["test"])]),
        typeScriptConfigurationSource("vitest.config.ts",
          { qualityGates: { branches: 80, lines: 90 }, coverageThresholds: { lines: 90 } },
          { qualityGates: { lines: 90, branches: 80 }, coverageThresholds: { lines: 91 } }),
      ],
      changes: [
        { source: "unstaged", status: "M", path: "src/value.ts" },
        { source: "staged", status: "M", path: "tests/value.test.ts" },
        { source: "committed", status: "M", path: "tasks/SFL-025/contract.yaml" },
        { source: "committed", status: "M", path: "vitest.config.ts" },
      ],
      verificationCommands: [{ path: "tasks/SFL-025/contract.yaml",
        baseline: [verificationCommand("pnpm", ["test"])],
        current: [verificationCommand("pnpm", ["test"])] }],
      qualityGates: [{ path: "vitest.config.ts", baseline: { branches: 80, lines: 90 },
        current: { lines: 90, branches: 80 } }],
      coverageThresholds: [{ path: "vitest.config.ts", name: "lines", baseline: 90, current: 91 }],
    }) })], context());
    expect(clean.status).toBe("passed");
  });

  it("detects executable skip/only modifier chains without matching literals or unrelated APIs", async () => {
    const path = "tests/chains.test.ts";
    for (const line of [
      "test.skip.each(cases)('skipped', () => {})",
      "test.only.each(cases)('focused', () => {})",
      "test.concurrent.only('focused', () => {})",
      "test.concurrent.skip('skipped', () => {})",
      "describe.each(cases).only('focused', () => {})",
      "it.concurrent.skip('skipped', () => {})",
      "suite.only.each(cases)('focused', () => {})",
    ]) {
      const result = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
        changes: [{ source: "unstaged", status: "M", path }],
        sources: sourceEvidence({ [path]: ["", line] }),
      }) })], context());
      expect(result.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "TEST_SKIP_OR_ONLY_ADDED" }),
      ]));
    }

    for (const line of [
      "// test.skip.each(cases)('documented')",
      "const example = `test.concurrent.only('text')`;",
      "logger.test.skip.each(cases)",
      "test.concurrent('runs', () => {})",
    ]) {
      const result = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
        changes: [{ source: "unstaged", status: "M", path }],
        sources: sourceEvidence({ [path]: ["", line] }),
      }) })], context());
      expect(result.status).toBe("passed");
    }
  });

  it("detects multiline modifier chains while ignoring multiline comments and literals", async () => {
    const path = "tests/multiline-chains.test.ts";
    for (const content of [
      ["test", "  .only('focused', () => {})"].join("\n"),
      ["describe", "  .skip('skipped', () => {})"].join("\n"),
      ["test", "  .concurrent", "  .only('focused', () => {})"].join("\n"),
      ["suite", "  .each(cases)", "  .skip('skipped', () => {})"].join("\n"),
      ["const label = '🧪';", "it", "  .only(label, () => {})"].join("\n"),
    ]) {
      const result = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
        changes: [{ source: "unstaged", status: "M", path }],
        sources: sourceEvidence({ [path]: ["", content] }),
      }) })], context());
      expect(result.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "TEST_SKIP_OR_ONLY_ADDED" }),
      ]));
    }

    for (const content of [
      ["/*", "test", "  .only('commented', () => {})", "*/"].join("\n"),
      ["const example = `", "describe", "  .skip('template text', () => {})", "`;"].join("\n"),
      ["const example = 'test\\", "  .only(\\'string text\\', () => {})';"].join("\n"),
    ]) {
      const result = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
        changes: [{ source: "unstaged", status: "M", path }],
        sources: sourceEvidence({ [path]: ["", content] }),
      }) })], context());
      expect(result.status).toBe("passed");
    }

    const unchanged = ["test", "  .only('pre-existing', () => {})"].join("\n");
    const result = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
      changes: [{ source: "unstaged", status: "M", path }],
      sources: sourceEvidence({ [path]: [unchanged, `${unchanged}\ntest('new', () => {})`] }),
    }) })], context());
    expect(result.status).toBe("passed");
  });

  it("scans executable template interpolations while retaining template-literal controls", async () => {
    const path = "tests/template-interpolation.test.ts";
    for (const content of [
      "const value = `result ${test.only('focused', () => {})}`;",
      ["const value = `raw ${", "  test.skip('multiline', () => {})", "}`;"].join("\n"),
      "const value = `outer ${`inner ${test.only('nested', () => {})}`}`;",
      "const value = `outer ${({ run: () => test.skip('braced', () => {}) }).run()}`;",
      "const value = `outer ${(() => { const text = 'test.only('; " +
        "return test.skip('escaped', () => {}); })()}`;",
    ]) {
      const result = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
        changes: [{ source: "unstaged", status: "M", path }],
        sources: sourceEvidence({ [path]: ["", content] }),
      }) })], context());
      expect(result.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "TEST_SKIP_OR_ONLY_ADDED" }),
      ]));
    }

    for (const content of [
      "const value = `test.only('raw text', () => {})`;",
      "const value = `raw \\${test.skip('escaped interpolation', () => {})}`;",
      "const value = `outer ${'test.only(inside a string)'}`;",
      "const value = `outer ${/* test.skip('commented') */ 'safe'}`;",
    ]) {
      const result = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
        changes: [{ source: "unstaged", status: "M", path }],
        sources: sourceEvidence({ [path]: ["", content] }),
      }) })], context());
      expect(result.status).toBe("passed");
    }
  });

  it("masks regular-expression literals without treating division as a regex", async () => {
    const path = "tests/regex-and-division.test.ts";
    for (const content of [
      "const pattern = /test.only(foo)/;",
      "const escaped = /test\\.skip\\(foo\\)\\/bar/gi;",
      "const characterClass = /test.only([a/]+)[)]/u;",
      ["const before = true;", "const pattern = /test.skip(foo)/m;", "const after = true;"].join("\n"),
    ]) {
      const result = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
        changes: [{ source: "unstaged", status: "M", path }],
        sources: sourceEvidence({ [path]: ["", content] }),
      }) })], context());
      expect(result.status).toBe("passed");
    }

    for (const content of [
      "const quotient = total / count; test.only('after division', () => {});",
      ["const quotient = (total + offset) / divisor;", "/safe/.test(label);",
        "test.skip('after both', () => {});"].join("\n"),
    ]) {
      const result = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
        changes: [{ source: "unstaged", status: "M", path }],
        sources: sourceEvidence({ [path]: ["", content] }),
      }) })], context());
      expect(result.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "TEST_SKIP_OR_ONLY_ADDED" }),
      ]));
    }
  });

  it("masks regex expression statements after control-flow headers and blocks", async () => {
    const path = "tests/control-flow-regex.test.ts";
    for (const content of [
      "if (flag) /test.only(foo)/;",
      "while /* retained comment */ (flag) /describe.skip(foo)/;",
      "for (;;) /it.only(foo)/;",
      ["if (", "  enabled && (ready || waiting)", ") /test.only(foo)/;"].join("\n"),
      "if (flag) { work(); } /describe.skip(foo)/;",
      "while (flag) { if (nested) { work(); } } /it.only(foo)/;",
    ]) {
      const result = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
        changes: [{ source: "unstaged", status: "M", path }],
        sources: sourceEvidence({ [path]: ["", content] }),
      }) })], context());
      expect(result.status).toBe("passed");
    }
  });

  it("retains division and executable skip/only detection around control-flow boundaries", async () => {
    const path = "tests/control-flow-executable.test.ts";
    for (const content of [
      "if (flag) test.only('focused', () => {});",
      "while (flag) /safe/.test(label); test.skip('focused', () => {});",
      "for (;;) { /safe/.test(label); break; } test.only('focused', () => {});",
      "const grouped = (total + offset) / divisor; test.skip('after grouped division', () => {});",
      "const called = valueOf() / divisor; test.only('after call division', () => {});",
      "const member = object.value / divisor; test.skip('after member division', () => {});",
      "const numeric = 10 / divisor; test.only('after numeric division', () => {});",
    ]) {
      const result = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
        changes: [{ source: "unstaged", status: "M", path }],
        sources: sourceEvidence({ [path]: ["", content] }),
      }) })], context());
      expect(result.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "TEST_SKIP_OR_ONLY_ADDED" }),
      ]));
    }
  });

  it("ties skip/only findings to newly introduced source spans instead of occurrence counts", async () => {
    const path = "tests/relocated-chain.test.ts";
    for (const [baseline, current] of [
      ["test.only('old location', () => {})", "test.only('replacement', () => {})"],
      [
        ["test.only('moved', () => {})", "test('stable anchor', () => {})"].join("\n"),
        ["test('stable anchor', () => {})", "test.only('moved', () => {})"].join("\n"),
      ],
      [
        ["test('stable anchor', () => {})", "test.only('moved', () => {})"].join("\n"),
        ["test.only('moved', () => {})", "test('stable anchor', () => {})"].join("\n"),
      ],
    ]) {
      const result = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
        changes: [{ source: "unstaged", status: "M", path }],
        sources: sourceEvidence({ [path]: [baseline, current] }),
      }) })], context());
      expect(result.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "TEST_SKIP_OR_ONLY_ADDED" }),
      ]));
    }

    const unchanged = "test.only('unchanged', () => {})";
    const result = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
      changes: [{ source: "unstaged", status: "M", path }],
      sources: sourceEvidence({ [path]: [unchanged, `${unchanged}\ntest('added', () => {})`] }),
    }) })], context());
    expect(result.status).toBe("passed");
  });

  it("derives additions from the complete source inventory and fails closed on omissions", async () => {
    const path = "tests/changed.test.ts";
    const detected = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
      changes: [{ source: "unstaged", status: "M", path }],
      sources: sourceEvidence({ [path]: ["test('runs', () => {})",
        "test('runs', () => {})\ntest.only('hidden', () => {})"] }),
    }) })], context());
    expect(detected.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TEST_SKIP_OR_ONLY_ADDED" }),
    ]));

    const base = integrityEvidence({ changes: [{ source: "unstaged", status: "M", path }] });
    for (const sources of [
      [],
      [...base.sources, base.sources[0]!],
      [{ path, baseline: { kind: "text" as const, content: "test('old', () => {})" },
        current: { kind: "non_text" as const } }],
    ]) {
      const result = await runVerifiers([createTestIntegrityVerifier({ evidence: {
        ...base, sources,
      } })], context());
      expect(result).toMatchObject({ status: "failed",
        failures: [{ code: "VERIFIER_EXECUTION_ERROR" }] });
    }
  });

  it("derives exact configuration inventories from complete changed-path sources", async () => {
    const zeroItems = await runVerifiers([createTestIntegrityVerifier({
      evidence: integrityEvidence({
        changes: [{ source: "unstaged", status: "M", path: "src/value.ts" }],
      }),
    })], context());
    expect(zeroItems.status).toBe("passed");

    const cases: TestIntegrityEvidence[] = [
      integrityEvidence({
        changes: [{ source: "committed", status: "M", path: "tasks/SFL-025/contract.yaml" }],
        configurationSources: [taskContractSource("tasks/SFL-025/contract.yaml",
          [verificationCommand("pnpm", ["test"])], [verificationCommand("pnpm", ["test"])])],
      }),
      integrityEvidence({
        changes: [{ source: "committed", status: "M", path: "vitest.config.ts" }],
        configurationSources: [typeScriptConfigurationSource("vitest.config.ts",
          { qualityGates: { enabled: true } }, { qualityGates: { enabled: true } })],
      }),
      integrityEvidence({
        changes: [{ source: "committed", status: "M", path: "vitest.config.ts" }],
        configurationSources: [typeScriptConfigurationSource("vitest.config.ts",
          { coverageThresholds: { lines: 90 } }, { coverageThresholds: { lines: 90 } })],
      }),
      integrityEvidence({
        changes: [{ source: "committed", status: "M", path: "tasks/SFL-025/contract.yaml" }],
        configurationSources: [taskContractSource("tasks/SFL-025/contract.yaml",
          [verificationCommand("pnpm", ["test"])], [verificationCommand("pnpm", ["test"])])],
        verificationCommands: [
          { path: "tasks/SFL-025/contract.yaml", baseline: [verificationCommand("pnpm", ["test"])],
            current: [verificationCommand("pnpm", ["test"])] },
          { path: "tasks/SFL-025/contract.yaml", baseline: [verificationCommand("pnpm", ["test"])],
            current: [verificationCommand("pnpm", ["test"])] },
        ],
      }),
      integrityEvidence({
        changes: [{ source: "committed", status: "M", path: "task.yaml" }],
        verificationCommands: [
          { path: "unexpected.yaml", baseline: ["pnpm", "test"], current: ["pnpm", "test"] },
        ],
      }),
      integrityEvidence({
        changes: [{ source: "committed", status: "M", path: "vitest.config.ts" }],
        configurationSources: [
          typeScriptConfigurationSource("vitest.config.ts", { coverageThresholds: { lines: 90 } },
            { coverageThresholds: { lines: 90 } }),
          typeScriptConfigurationSource("vitest.config.ts", { coverageThresholds: { lines: 90 } },
            { coverageThresholds: { lines: 90 } }),
        ],
      }),
      integrityEvidence({
        changes: [{ source: "committed", status: "M", path: "tasks/SFL-025/contract.yaml" }],
        configurationSources: [configurationSource("tasks/SFL-025/contract.yaml",
          { verificationCommands: ["pnpm", "test"] },
          { verificationCommands: ["pnpm", "test"] })],
      }),
    ];
    for (const evidence of cases) {
      const result = await runVerifiers([createTestIntegrityVerifier({ evidence })], context());
      expect(result).toMatchObject({ status: "failed", failures: [{ code: "VERIFIER_EXECUTION_ERROR" }] });
    }
  });

  it("rejects selectively omitted commands, gates, and thresholds from authoritative content", async () => {
    const cases = [
      ["task.json", { verificationCommands: ["pnpm", "test"] }],
      ["quality-gates.json", { qualityGates: { enabled: true } }],
      ["vitest.json", { coverageThresholds: { lines: 90 } }],
    ] as const;
    for (const [path, content] of cases) {
      const result = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
        changes: [{ source: "committed", status: "M", path }],
        configurationSources: [configurationSource(path, content, content)],
      }) })], context());
      expect(result).toMatchObject({
        status: "failed",
        failures: [{ code: "VERIFIER_EXECUTION_ERROR" }],
      });
    }
  });

  it("discovers whole omitted configuration paths from complete changed-source evidence", async () => {
    const cases = [
      ["task.json", { verificationCommands: ["pnpm", "test"] }],
      ["quality-gates.json", { qualityGates: { enabled: true } }],
      ["vitest.json", { coverageThresholds: { lines: 90 } }],
    ] as const;
    for (const [path, content] of cases) {
      const result = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
        changes: [{ source: "committed", status: "M", path }],
        sources: [sourceEvidenceForConfiguration(path, content, content)],
      }) })], context());
      expect(result).toMatchObject({
        status: "failed",
        failures: [{ code: "VERIFIER_EXECUTION_ERROR" }],
      });
    }

    const path = "verification.json";
    const content = {
      verificationCommands: ["pnpm", "test"],
      qualityGates: { enabled: true },
      coverageThresholds: { lines: 90 },
    };
    const complete = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
      changes: [{ source: "committed", status: "M", path }],
      sources: [sourceEvidenceForConfiguration(path, content, content)],
      verificationCommands: [{ path, baseline: content.verificationCommands,
        current: content.verificationCommands }],
      qualityGates: [{ path, baseline: content.qualityGates, current: content.qualityGates }],
      coverageThresholds: [{ path, name: "lines", baseline: 90, current: 90 }],
    }) })], context());
    expect(complete.status).toBe("passed");
  });

  it("extracts canonical YAML and static TypeScript configuration from genuine source text", async () => {
    const taskPath = "tasks/SFL-025/contract.yaml";
    const configPath = "vitest.config.ts";
    const beforeCommand = verificationCommand("pnpm", ["test"]);
    const afterCommand = verificationCommand("echo", []);
    const task = taskContractSource(taskPath, [beforeCommand], [afterCommand]);
    const config = typeScriptConfigurationSource(configPath,
      { qualityGates: { enabled: true }, coverageThresholds: { lines: 90 } },
      { qualityGates: { enabled: false }, coverageThresholds: { lines: 89 } });
    const changed = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
      changes: [
        { source: "committed", status: "M", path: taskPath },
        { source: "committed", status: "M", path: configPath },
      ],
      sources: [configurationFixtureSource(task), configurationFixtureSource(config)],
      verificationCommands: [{ path: taskPath, baseline: [beforeCommand], current: [afterCommand] }],
      qualityGates: [{ path: configPath, baseline: { enabled: true }, current: { enabled: false } }],
      coverageThresholds: [{ path: configPath, name: "lines", baseline: 90, current: 89 }],
    }) })], context());
    expect(changed.failures.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "VERIFICATION_COMMANDS_MODIFIED",
      "QUALITY_GATE_MODIFIED",
      "COVERAGE_THRESHOLD_LOWERED",
    ]));

    const stronger = typeScriptConfigurationSource(configPath,
      { qualityGates: { enabled: true }, coverageThresholds: { lines: 90 } },
      { qualityGates: { enabled: true }, coverageThresholds: { lines: 91 } });
    const clean = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
      changes: [
        { source: "committed", status: "M", path: taskPath },
        { source: "committed", status: "M", path: configPath },
      ],
      sources: [configurationFixtureSource(taskContractSource(taskPath, [beforeCommand], [beforeCommand])),
        configurationFixtureSource(stronger)],
      verificationCommands: [{ path: taskPath, baseline: [beforeCommand], current: [beforeCommand] }],
      qualityGates: [{ path: configPath, baseline: { enabled: true }, current: { enabled: true } }],
      coverageThresholds: [{ path: configPath, name: "lines", baseline: 90, current: 91 }],
    }) })], context());
    expect(clean.status).toBe("passed");
  });

  it("fails native configuration extraction closed on omissions, malformed input, and ambiguity", async () => {
    const taskPath = "tasks/SFL-025/contract.yaml";
    const configPath = "vitest.config.ts";
    const command = verificationCommand("pnpm", ["test"]);
    const task = taskContractSource(taskPath, [command], [command]);
    const omitted = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
      changes: [{ source: "committed", status: "M", path: taskPath }],
      sources: [configurationFixtureSource(task)],
    }) })], context());
    expect(omitted).toMatchObject({ status: "failed", failures: [{ code: "VERIFIER_EXECUTION_ERROR" }] });

    for (const [path, baseline, current] of [
      [taskPath, task.baselineContent, "verification:\n  commands:\n    - executable:"],
      [configPath, "export default defineConfig({ test: { coverage: { thresholds: { lines: 90 } } } });",
        "export default defineConfig({ test: { coverage: { thresholds: { lines: baseLines } } } });"],
      [configPath, "export default defineConfig({ coverageThresholds: { lines: 90 } });",
        "export default defineConfig({ coverageThresholds: { lines: 90 }, test: { coverage: { thresholds: { lines: 90 } } } });"],
    ] as const) {
      const result = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
        changes: [{ source: "committed", status: "M", path }],
        sources: [{ path, baseline: { kind: "text", content: baseline },
          current: { kind: "text", content: current } }],
      }) })], context());
      expect(result).toMatchObject({ status: "failed", failures: [{ code: "VERIFIER_EXECUTION_ERROR" }] });
    }
  });

  it("ignores ordinary changed sources and JSON objects without protected configuration", async () => {
    for (const [path, baseline, current] of [
      ["src/value.ts", "export const value = 1;", "export const value = 2;"],
      ["metadata.json", JSON.stringify({ name: "before" }), JSON.stringify({ name: "after" })],
    ] as const) {
      const result = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
        changes: [{ source: "unstaged", status: "M", path }],
        sources: sourceEvidence({ [path]: [baseline, current] }),
      }) })], context());
      expect(result.status).toBe("passed");
    }
  });

  it("canonicalizes coherent committed-plus-staged and committed-plus-unstaged paths", async () => {
    for (const changes of [
      [
        { source: "committed" as const, status: "M", path: "tests/layered.test.ts" },
        { source: "staged" as const, status: "M", path: "tests/layered.test.ts" },
      ],
      [
        { source: "committed" as const, status: "M", path: "tests/layered.test.ts" },
        { source: "unstaged" as const, status: "M", path: "tests/layered.test.ts" },
      ],
    ]) {
      const result = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
        changes,
        sources: sourceEvidence({
          "tests/layered.test.ts": ["test('runs', () => {})",
            "test('runs', () => {})\ntest.only('hidden', () => {})"],
        }),
      }) })], context());
      expect(result.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "TEST_SKIP_OR_ONLY_ADDED" }),
      ]));
      expect(result.failures).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "VERIFIER_EXECUTION_ERROR" }),
      ]));
    }
  });

  it("fails test-integrity closed without authoritative or complete frozen evidence", async () => {
    const evidence = integrityEvidence({});
    const result = await runVerifiers([createTestIntegrityVerifier({ evidence: {
      ...evidence,
      authority: "agent_reported" as "engine_observed",
    } })], context());
    expect(result).toMatchObject({ status: "failed", failures: [{ code: "VERIFIER_EXECUTION_ERROR" }] });

    const missingPair = await runVerifiers([createTestIntegrityVerifier({ evidence: integrityEvidence({
      verificationCommands: [{ path: "task.yaml", baseline: ["pnpm", "test"], current: undefined }],
    }) })], context());
    expect(missingPair).toMatchObject({ status: "failed", failures: [{ code: "VERIFIER_EXECUTION_ERROR" }] });
  });

  it("strictly validates and reconciles Agent Result claims with observed Git and command evidence", async () => {
    const actual = commandResult({ executable: "pnpm", args: ["test"], exitCode: 0 });
    const verifier = createAgentResultVerifier({
      agentResult: agentResult({
        changed_files: ["web/src/a.ts", "packages/verification/src/index.ts", "web/src/old.ts",
          "web/src/a.ts"],
        commands_run: [{ executable: "pnpm", args: ["test"], exit_code: 0 }],
      }),
      changedFiles: { authority: "engine_observed", files: [
        { repositoryId: "@control", change: { source: "unstaged", status: "M",
          path: "packages/verification/src/index.ts" } },
        { repositoryId: "web", change: { source: "staged", status: "R100",
          originalPath: "src/old.ts", path: "src/a.ts" } },
      ] },
      commandResults: { authority: "engine_observed", results: [actual] },
    });
    const result = await runVerifiers([verifier], context());
    expect(result.status).toBe("passed");
  });

  it("rejects malformed Agent Results, hidden diffs, fabricated commands, and false success", async () => {
    const failedCommand = commandResult({ executable: "pnpm", args: ["test"], exitCode: 1 });
    const malformed = await runVerifiers([createAgentResultVerifier({
      agentResult: { status: "succeeded", summary: "missing required fields", unknown: true },
      changedFiles: { authority: "engine_observed", files: [] },
      commandResults: { authority: "engine_observed", results: [] },
    })], context());
    expect(malformed.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "AGENT_RESULT_SCHEMA_INVALID" }),
    ]));

    const contradictory = await runVerifiers([createAgentResultVerifier({
      agentResult: agentResult({
        status: "succeeded",
        changed_files: [],
        commands_run: [{ executable: "pnpm", args: ["lint"], exit_code: 0 }],
      }),
      changedFiles: { authority: "engine_observed", files: [
        { repositoryId: "api", change: { source: "untracked", status: "?",
          path: "unauthorized/hidden.ts" } },
      ] },
      commandResults: { authority: "engine_observed", results: [failedCommand] },
    })], context());
    expect(contradictory.failures.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "AGENT_CHANGED_FILES_MISMATCH",
      "AGENT_COMMANDS_MISMATCH",
      "AGENT_STATUS_CONTRADICTS_COMMANDS",
    ]));
  });

  it("rejects changed-file claims that collide across control and application repositories", async () => {
    const result = await runVerifiers([createAgentResultVerifier({
      agentResult: agentResult({ changed_files: ["web/src/a.ts"] }),
      changedFiles: { authority: "engine_observed", files: [
        { repositoryId: "@control", change: { source: "unstaged", status: "M",
          path: "web/src/a.ts" } },
        { repositoryId: "web", change: { source: "unstaged", status: "M", path: "src/a.ts" } },
      ] },
      commandResults: { authority: "engine_observed", results: [] },
    })], context());

    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "AGENT_CHANGED_FILES_IDENTITY_COLLISION" }),
    ]));
  });

  it("does not accept agent-reported evidence as the authoritative reconciliation source", async () => {
    const result = await runVerifiers([createAgentResultVerifier({
      agentResult: agentResult({}),
      changedFiles: { authority: "agent_reported" as "engine_observed", files: [] },
      commandResults: { authority: "engine_observed", results: [] },
    })], context());
    expect(result).toMatchObject({ status: "failed", failures: [{ code: "VERIFIER_EXECUTION_ERROR" }] });
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

function context() {
  return { taskRunId: "task-run-1", evidence: [] };
}

function integrityEvidence(overrides: Partial<TestIntegrityEvidence>): TestIntegrityEvidence {
  const changes = overrides.changes ?? [];
  const configurationSources = overrides.configurationSources ?? [];
  const configured = new Map(configurationSources.map(source => {
    const fixture = source as ConfigurationFixture;
    return [source.path, {
      path: source.path,
      baseline: { kind: "text" as const, content: fixture.baselineContent },
      current: { kind: "text" as const, content: fixture.currentContent },
    }];
  }));
  const defaultSources = changes.flatMap(change => {
    const destination = sourceForStatus(change.path, change.status, false);
    return change.originalPath === undefined
      ? [destination]
      : [sourceForStatus(change.originalPath, change.status, true), destination];
  });
  const sourceOverrides = new Map((overrides.sources ?? []).map(source => [source.path, source]));
  const sources = [...new Map(defaultSources.map(source => {
    const selected = sourceOverrides.get(source.path) ?? configured.get(source.path) ?? source;
    return [selected.path, selected] as const;
  })).values()];
  return {
    authority: "engine_observed",
    configurationSources,
    repositoryId: "@control",
    baseCommit: "a".repeat(40),
    changes,
    testPathPatterns: ["tests/**", "**/*.test.ts"],
    protectedTestPathPatterns: ["tests/protected/**"],
    verificationCommands: [],
    qualityGates: [],
    coverageThresholds: [],
    ...overrides,
    sources,
  };
}

function sourceForStatus(
  path: string,
  status: string,
  original: boolean,
): TestIntegrityEvidence["sources"][number] {
  const text = { kind: "text" as const, content: "test('unchanged', () => {})" };
  const absent = { kind: "absent" as const };
  if (original) return { path, baseline: text, current: status.startsWith("C") ? text : absent };
  if (status === "?" || status.startsWith("A") || status.startsWith("R") || status.startsWith("C")) {
    return { path, baseline: absent, current: text };
  }
  if (status.startsWith("D")) return { path, baseline: text, current: absent };
  return { path, baseline: text, current: text };
}

function sourceEvidence(
  sources: Readonly<Record<string, readonly [string, string]>>,
): TestIntegrityEvidence["sources"] {
  return Object.entries(sources).map(([path, [baseline, current]]) => ({
    path,
    baseline: { kind: "text", content: baseline },
    current: { kind: "text", content: current },
  }));
}

function configurationSource(
  path: string,
  baseline: Readonly<Record<string, unknown>> = {},
  current: Readonly<Record<string, unknown>> = {},
): ConfigurationFixture {
  return {
    path,
    format: "json",
    baselineContent: JSON.stringify(baseline),
    currentContent: JSON.stringify(current),
  };
}

interface ConfigurationFixture extends TestIntegrityEvidence["configurationSources"][number] {
  readonly baselineContent: string;
  readonly currentContent: string;
}

function configurationFixtureSource(
  fixture: ConfigurationFixture,
): TestIntegrityEvidence["sources"][number] {
  return {
    path: fixture.path,
    baseline: { kind: "text", content: fixture.baselineContent },
    current: { kind: "text", content: fixture.currentContent },
  };
}

type VerificationCommandFixture = Readonly<Record<string, unknown>>;

function verificationCommand(executable: string, args: readonly string[]): VerificationCommandFixture {
  return { repository: "@control", executable, args, timeout_seconds: 300, required: true };
}

function taskContractSource(
  path: string,
  baseline: readonly VerificationCommandFixture[],
  current: readonly VerificationCommandFixture[],
): ConfigurationFixture {
  return {
    path,
    format: "task_contract_yaml",
    baselineContent: taskContractYaml(baseline),
    currentContent: taskContractYaml(current),
  };
}

function taskContractYaml(commands: readonly VerificationCommandFixture[]): string {
  return [
    "version: 1",
    "task:",
    "  id: SFL-025",
    "verification:",
    "  commands:",
    ...commands.flatMap(command => [
      `    - repository: ${JSON.stringify(command.repository)}`,
      `      executable: ${String(command.executable)}`,
      `      args: ${JSON.stringify(command.args)}`,
      `      timeout_seconds: ${String(command.timeout_seconds)}`,
      `      required: ${String(command.required)}`,
    ]),
  ].join("\n");
}

function typeScriptConfigurationSource(
  path: string,
  baseline: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
): ConfigurationFixture {
  return {
    path,
    format: "typescript",
    baselineContent: typeScriptConfiguration(baseline),
    currentContent: typeScriptConfiguration(current),
  };
}

function typeScriptConfiguration(configuration: Readonly<Record<string, unknown>>): string {
  const quality = configuration.qualityGates;
  const coverage = configuration.coverageThresholds;
  const fields = [
    ...(quality === undefined ? [] : [`qualityGates: ${JSON.stringify(quality)}`]),
    ...(coverage === undefined ? [] : [`coverage: { thresholds: ${JSON.stringify(coverage)} }`]),
  ];
  return `export default defineConfig({ test: { ${fields.join(", ")} } });`;
}

function sourceEvidenceForConfiguration(
  path: string,
  baseline: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
): TestIntegrityEvidence["sources"][number] {
  return {
    path,
    baseline: { kind: "text", content: JSON.stringify(baseline) },
    current: { kind: "text", content: JSON.stringify(current) },
  };
}

function agentResult(overrides: Record<string, unknown>) {
  return {
    status: "succeeded",
    summary: "Implemented the requested task",
    changed_files: [],
    commands_run: [],
    acceptance_mapping: [{ acceptance_criterion_id: "AC-1", evidence: ["tests"], satisfied: true }],
    known_limitations: [],
    decision_requests: [],
    risks_detected: [],
    ...overrides,
  };
}

function commandResult(input: {
  executable: string;
  args: string[];
  exitCode: number;
}): CommandResult {
  return {
    commandId: "verification-command-0001",
    repository: "@control",
    cwd: "/task-run/control",
    executable: input.executable,
    args: input.args,
    required: true,
    outcome: input.exitCode === 0 ? "succeeded" : "failed",
    exitCode: input.exitCode,
    signal: null,
    timedOut: false,
    timeoutSeconds: 300,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    artifacts: [],
    error: null,
    shellDecisionId: null,
  };
}
