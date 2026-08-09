import { createHash } from "node:crypto";
import { renameSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CommandRunner,
  VerificationArtifactStore,
  type VerificationArtifactStoreHooks,
} from "../src/index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Structured Command Runner", () => {
  it("binds cwd to the repository mapping and preserves every argument boundary", async () => {
    const fixture = await commandFixture();
    const result = await fixture.runner.run({
      id: "argv", repository: "@control", executable: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1)}))",
        "", "two words", "$(not-a-shell)", "semi;colon"],
      timeoutSeconds: 5, required: true,
    });

    const canonicalControl = await realpath(fixture.control);
    expect(result).toMatchObject({ outcome: "succeeded", cwd: canonicalControl, exitCode: 0, signal: null });
    expect(JSON.parse(result.stdout)).toEqual({
      cwd: canonicalControl, args: ["", "two words", "$(not-a-shell)", "semi;colon"],
    });
  });

  it("constructs the child environment only from explicitly allowlisted host or caller values", async () => {
    const fixture = await commandFixture({ SAFE_HOST: "host-value", UNLISTED_SECRET: "must-not-appear" });
    const result = await fixture.runner.run({
      id: "environment", repository: "@control", executable: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify(process.env))"], timeoutSeconds: 5, required: true,
      environment: { allowlist: ["SAFE_HOST", "CALLER_VALUE"], values: { CALLER_VALUE: "caller-value" } },
    });

    expect(JSON.parse(result.stdout)).toMatchObject({ SAFE_HOST: "host-value", CALLER_VALUE: "caller-value" });
    expect(JSON.parse(result.stdout)).not.toHaveProperty("UNLISTED_SECRET");
    expect(await fixture.artifact("commands/environment/stdout.txt")).not.toContain("must-not-appear");
  });

  it("records nonzero exit, separate streams, UTF-8-safe truncation, redaction, and complete artifacts", async () => {
    const fixture = await commandFixture({}, 7);
    const result = await fixture.runner.run({
      id: "outputs", repository: "@control", executable: process.execPath,
      args: ["-e", "process.stdout.write('你你你password=hunter2');process.stderr.write('stderr-long');process.exit(7)"],
      timeoutSeconds: 5, required: true,
    });

    expect(result).toMatchObject({ outcome: "failed", exitCode: 7, stdout: "你你", stderr: "stderr-",
      stdoutTruncated: true, stderrTruncated: true });
    expect(await fixture.artifact("commands/outputs/stdout.txt")).toBe("你你你password=[REDACTED]");
    expect(await fixture.artifact("commands/outputs/stderr.txt")).toBe("stderr-long");
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts[0]).toMatchObject({ byte_length: 28 });
  });

  it("returns a structured spawn failure", async () => {
    const fixture = await commandFixture();
    const result = await fixture.runner.run({
      id: "missing", repository: "@control", executable: join(fixture.root, "does-not-exist"),
      args: [], timeoutSeconds: 5, required: true,
    });
    expect(result).toMatchObject({ outcome: "spawn_error", exitCode: null, signal: null, timedOut: false });
    expect(result.error).toContain("ENOENT");
    expect(result.artifacts).toHaveLength(2);
  });

  it("aborts both prepared sinks when spawning throws synchronously", async () => {
    const fixture = await commandFixture();
    await expect(fixture.runner.run({
      id: "sync-spawn-error", repository: "@control", executable: "/invalid\0executable",
      args: [], timeoutSeconds: 5, required: true,
    })).rejects.toThrow();
    expect(await fixture.artifact("commands/sync-spawn-error/stdout.txt")).toBe("");
    expect(await fixture.artifact("commands/sync-spawn-error/stderr.txt")).toBe("");
  });

  it("keeps both output sinks contained when their logical parent moves outside before spawn", async () => {
    let validations = 0;
    let active = "";
    let outside = "";
    const hooks: VerificationArtifactStoreHooks = {
      afterArtifactParentValidation() {
        validations += 1;
        if (validations !== 2) return;
        renameSync(active, join(outside, "moved-parent"));
      },
    };
    const fixture = await commandFixture({}, 16_384, 25, hooks);
    active = join(fixture.evidenceRoot, "commands", "preparation-failure");
    outside = await mkdtemp(join(tmpdir(), "scaflow-command-outside-"));
    temporaryDirectories.push(outside);
    await mkdir(active, { recursive: true });
    const outsideSentinel = join(outside, "sentinel.txt");
    await writeFile(outsideSentinel, "outside sentinel");

    const result = await fixture.runner.run({
      id: "preparation-failure", repository: "@control", executable: process.execPath,
      args: ["-e", "process.stdout.write('stdout-safe');process.stderr.write('stderr-safe')"],
      timeoutSeconds: 5, required: true,
    });

    expect(result).toMatchObject({ outcome: "succeeded", stdout: "stdout-safe", stderr: "stderr-safe" });
    expect(await readFile(outsideSentinel, "utf8")).toBe("outside sentinel");
    await expect(stat(join(outside, "moved-parent", "stdout.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(outside, "moved-parent", "stderr.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fixture.artifact("commands/preparation-failure/stdout.txt")).toBe("stdout-safe");
    expect(await fixture.artifact("commands/preparation-failure/stderr.txt")).toBe("stderr-safe");
  });

  it("aborts the first output sink and does not spawn when the second sink cannot be prepared", async () => {
    const fixture = await commandFixture();
    const stderrPath = join(fixture.evidenceRoot,
      flatArtifactPath("commands/second-writer-failure/stderr.txt"));
    const stdoutPath = join(fixture.evidenceRoot,
      flatArtifactPath("commands/second-writer-failure/stdout.txt"));
    const spawnMarker = join(fixture.control, "spawned.txt");
    await writeFile(stderrPath, "outside preparation sentinel");

    await expect(fixture.runner.run({
      id: "second-writer-failure", repository: "@control", executable: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(spawnMarker)},'spawned')`],
      timeoutSeconds: 5, required: true,
    })).rejects.toMatchObject({ code: "EEXIST" });

    await expect(stat(spawnMarker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(stderrPath, "utf8")).toBe("outside preparation sentinel");
    expect(await readFile(stdoutPath, "utf8")).toBe("");
  });

  it("records signal termination separately from exit codes", async () => {
    const fixture = await commandFixture();
    const result = await fixture.runner.run({
      id: "signal", repository: "@control", executable: process.execPath,
      args: ["-e", "process.kill(process.pid, 'SIGTERM')"], timeoutSeconds: 5, required: true,
    });
    expect(result).toMatchObject({ outcome: "failed", exitCode: null, signal: "SIGTERM", timedOut: false });
  });

  it("terminates a timed-out process group and records an unambiguous terminal result", async () => {
    const fixture = await commandFixture();
    const result = await fixture.runner.run({
      id: "timeout", repository: "@control", executable: process.execPath,
      args: ["-e", [
        "const {spawn}=require('node:child_process')",
        "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'})",
        "process.stdout.write(String(child.pid))",
        "process.on('SIGTERM',()=>{})",
        "setInterval(()=>{},1000)",
      ].join(";")],
      timeoutSeconds: 0.25, required: true,
    });
    expect(result).toMatchObject({ outcome: "timed_out", timedOut: true, exitCode: null, signal: "SIGKILL" });
    const descendantPid = Number(result.stdout);
    expect(descendantPid).toBeGreaterThan(0);
    expect(() => process.kill(descendantPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });

  it("retains escalation when the leader exits on SIGTERM and kills its resistant descendant before resolving", async () => {
    const fixture = await commandFixture({}, 16_384, 100);
    const startedAt = Date.now();
    const result = await fixture.runner.run({
      id: "leader-exits", repository: "@control", executable: process.execPath,
      args: ["-e", [
        "const {spawn}=require('node:child_process')",
        "process.on('SIGTERM',()=>process.exit(0))",
        "const descendant=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'})",
        "process.stdout.write(String(descendant.pid))",
        "setInterval(()=>{},1000)",
      ].join(";")],
      timeoutSeconds: 0.75, required: true,
    });

    expect(result).toMatchObject({ outcome: "timed_out", timedOut: true, exitCode: 0, signal: null });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(825);
    await expectProcessGone(Number(result.stdout));
  });

  it("still escalates and settles once when graceful process-group termination fails", async () => {
    const fixture = await commandFixture({}, 16_384, 25);
    const originalKill = process.kill.bind(process);
    let rejectedSigterm = false;
    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid < 0 && signal === "SIGTERM" && !rejectedSigterm) {
        rejectedSigterm = true;
        const error = Object.assign(new Error("fixture termination denied"), { code: "EPERM" });
        throw error;
      }
      return originalKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill);
    try {
      const result = await fixture.runner.run({
        id: "termination-error", repository: "@control", executable: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"], timeoutSeconds: 0.5, required: true,
      });
      expect(result).toMatchObject({ outcome: "timed_out", timedOut: true, signal: "SIGKILL",
        error: expect.stringContaining("fixture termination denied") });
      expect(rejectedSigterm).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });

  it("redacts secrets and split UTF-8 across stream chunks while preserving complete artifact hashes", async () => {
    const fixture = await commandFixture({}, 8);
    const script = [
      "const writes=[Buffer.from('pass'),Buffer.from(\"word='hun\"),Buffer.from('ter2'),Buffer.from(\"';ok=\"),Buffer.from([0xe4]),Buffer.from([0xbd,0xa0]),Buffer.from(';token=abc'),Buffer.from('def;done')]",
      "let index=0",
      "const write=()=>index===writes.length?process.exit(0):(process.stdout.write(writes[index++]),setTimeout(write,5))",
      "write()",
    ].join(";");
    const result = await fixture.runner.run({
      id: "split-redaction", repository: "@control", executable: process.execPath,
      args: ["-e", script], timeoutSeconds: 5, required: true,
    });
    const artifact = await fixture.artifact("commands/split-redaction/stdout.txt");
    expect(artifact).toBe("password='[REDACTED]';ok=你;token=[REDACTED];done");
    expect(result.stdout).toBe("password");
    expect(result.stdoutTruncated).toBe(true);
    expect(`${result.stdout}${result.stderr}${artifact}`).not.toContain("hunter2");
    expect(`${result.stdout}${result.stderr}${artifact}`).not.toContain("abcdef");
    expect(result.artifacts[0]).toMatchObject({
      byte_length: Buffer.byteLength(artifact),
      sha256: createHash("sha256").update(artifact).digest("hex"),
    });
  });

  it.each([
    ["space in one chunk", " ", false],
    ["space across chunks", " ", true],
    ["tab in one chunk", "\t", false],
    ["tab across chunks", "\t", true],
    ["newline in one chunk", "\n", false],
    ["newline across chunks", "\n", true],
  ])("preserves safe output after whitespace-delimited unquoted secrets: %s",
    async (_name, delimiter, chunked) => {
      const fixture = await commandFixture();
      const secret = "token=secret-value";
      const suffix = `${delimiter}status=visible\nnext=preserved`;
      const expected = `token=[REDACTED]${suffix}`;
      const writes = chunked ? [secret, delimiter, "status=visible\n", "next=preserved"] : [secret + suffix];
      const script = [
        `const writes=${JSON.stringify(writes)}`,
        "let index=0",
        "const write=()=>index===writes.length?process.exit(0):(process.stdout.write(writes[index++]),setTimeout(write,5))",
        "write()",
      ].join(";");
      const result = await fixture.runner.run({ id: `whitespace-${delimiter.charCodeAt(0)}`,
        repository: "@control", executable: process.execPath, args: ["-e", script],
        timeoutSeconds: 5, required: true });
      const artifact = await fixture.artifact(`commands/whitespace-${delimiter.charCodeAt(0)}/stdout.txt`);

      expect(result).toMatchObject({ outcome: "succeeded", stdout: expected, stdoutTruncated: false });
      expect(artifact).toBe(expected);
      expect(`${result.stdout}${artifact}`).not.toContain("secret-value");
      expect(result.artifacts[0]).toMatchObject({
        byte_length: Buffer.byteLength(expected),
        sha256: createHash("sha256").update(expected).digest("hex"),
      });
    });

  it("rejects unknown, other-TaskRun, developer-workspace, and noncanonical worktree targets", async () => {
    const fixture = await commandFixture();
    const base = { id: "target", executable: process.execPath, args: ["-e", ""], timeoutSeconds: 5, required: true } as const;
    expect(await fixture.runner.run({ ...base, repository: "missing" })).toMatchObject({ outcome: "rejected", cwd: null });

    const developerRunner = await fixture.withMapping("@control", fixture.developerRoot, "run-1");
    expect(await developerRunner.run({ ...base, repository: "@control" })).toMatchObject({
      outcome: "rejected", error: expect.stringContaining("workspace/repos"),
    });
    const otherRunner = await fixture.withMapping("@control", fixture.control, "other-run");
    expect(await otherRunner.run({ ...base, repository: "@control" })).toMatchObject({
      outcome: "rejected", error: expect.stringContaining("another TaskRun"),
    });
  });

  it("rejects shell strings by default or on denial and accepts only a prevalidated allow decision", async () => {
    const fixture = await commandFixture();
    const base = { id: "shell-rejected", repository: "@control", shell: "printf shell-ok; /bin/sleep 0.05",
      timeoutSeconds: 20, required: true } as const;
    expect(await fixture.runner.run(base)).toMatchObject({ outcome: "rejected", shellDecisionId: null });
    expect(await fixture.runner.run({ ...base, id: "shell-denied", shellDecision: { decisionId: "deny-1", allowed: false } }))
      .toMatchObject({ outcome: "rejected" });
    const allowed = await fixture.runner.run({ ...base, id: "shell-allowed",
      shellDecision: { decisionId: "allow-1", allowed: true } });
    expect(allowed).toMatchObject({ outcome: "succeeded", stdout: "shell-ok", executable: "/bin/sh",
      args: ["-c", "printf shell-ok; /bin/sleep 0.05"], shellDecisionId: "allow-1" });
  });

  it("requires explicitly allowlisted PATH for a bare executable", async () => {
    const fixture = await commandFixture({ PATH: process.env.PATH });
    const rejected = await fixture.runner.run({ id: "bare-rejected", repository: "@control",
      executable: "node", args: ["--version"], timeoutSeconds: 5, required: true });
    expect(rejected).toMatchObject({ outcome: "rejected", error: expect.stringContaining("PATH") });
    const allowed = await fixture.runner.run({ id: "bare-allowed", repository: "@control",
      executable: "node", args: ["--version"], timeoutSeconds: 5, required: true,
      environment: { allowlist: ["PATH"] } });
    expect(allowed.outcome).toBe("succeeded");
  });
});

async function commandFixture(hostEnvironment: NodeJS.ProcessEnv = {}, outputLimitBytes = 16_384,
  terminationGraceMilliseconds = 25, artifactHooks?: VerificationArtifactStoreHooks) {
  const root = await mkdtemp(join(tmpdir(), "scaflow-command-"));
  temporaryDirectories.push(root);
  const taskRunRoot = join(root, "workspace", "runs", "SFL-023", "run-1");
  const control = join(taskRunRoot, "control");
  const developerRoot = join(root, "workspace", "repos");
  const evidenceRoot = join(root, "evidence");
  await Promise.all([mkdir(control, { recursive: true }), mkdir(developerRoot, { recursive: true })]);
  const artifactStore = await VerificationArtifactStore.create(evidenceRoot, { hooks: artifactHooks });
  const options = {
    taskRunId: "run-1", taskRunRoot, developerWorkspaceReposRoot: developerRoot,
    artifactStore, hostEnvironment, outputLimitBytes, terminationGraceMilliseconds,
  };
  const createRunner = (repositoryId: string, cwd: string, taskRunId: string) =>
    new CommandRunner({ ...options, repositories: [{ repositoryId, cwd, taskRunId }] });
  return {
    root, control, developerRoot, evidenceRoot, runner: createRunner("@control", control, "run-1"),
    artifact: (path: string) => readFile(join(evidenceRoot, flatArtifactPath(path)), "utf8"),
    withMapping: async (repositoryId: string, cwd: string, taskRunId: string) => createRunner(repositoryId, cwd, taskRunId),
  };
}

function flatArtifactPath(requestedPath: string): string {
  return `artifact-${createHash("sha256").update(requestedPath).digest("hex")}.data`;
}

async function expectProcessGone(pid: number): Promise<void> {
  expect(pid).toBeGreaterThan(0);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      expect(error).toMatchObject({ code: "ESRCH" });
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`Process ${pid} remained alive after timeout escalation`);
}
