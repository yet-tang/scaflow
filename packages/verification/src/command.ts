import { spawn, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

import { REDACTED_VALUE, isSecretKey, redactText } from "@scaflow/core";
import type { VerificationArtifactReference } from "@scaflow/schemas";

import type {
  OpenVerificationArtifactInput,
  VerificationArtifactStore,
  VerificationArtifactWriter,
} from "./index.js";

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ARTIFACT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface RepositoryWorktree {
  readonly repositoryId: string;
  readonly cwd: string;
  readonly taskRunId: string;
}

export interface CommandEnvironment {
  readonly allowlist: readonly string[];
  readonly values?: Readonly<Record<string, string | undefined>>;
}

interface CommandBase {
  readonly id: string;
  readonly repository: string;
  readonly timeoutSeconds: number;
  readonly required: boolean;
  readonly environment?: CommandEnvironment;
}

export interface StructuredCommand extends CommandBase {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface PrevalidatedShellDecision {
  readonly decisionId: string;
  readonly allowed: boolean;
}

export interface ShellCommand extends CommandBase {
  readonly shell: string;
  readonly shellDecision?: PrevalidatedShellDecision;
}

export type CommandOutcome = "succeeded" | "failed" | "timed_out" | "spawn_error" | "rejected";

export interface CommandResult {
  readonly commandId: string;
  readonly repository: string;
  readonly cwd: string | null;
  readonly executable: string | null;
  readonly args: readonly string[];
  readonly required: boolean;
  readonly outcome: CommandOutcome;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly timeoutSeconds: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly artifacts: readonly VerificationArtifactReference[];
  readonly error: string | null;
  readonly shellDecisionId: string | null;
}

export interface CommandRunnerOptions {
  readonly taskRunId: string;
  readonly taskRunRoot: string;
  readonly developerWorkspaceReposRoot: string;
  readonly repositories: readonly RepositoryWorktree[];
  readonly artifactStore: VerificationArtifactStore;
  readonly hostEnvironment?: NodeJS.ProcessEnv;
  readonly outputLimitBytes?: number;
  readonly terminationGraceMilliseconds?: number;
}

interface ResolvedInvocation {
  readonly cwd: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly shellDecisionId: string | null;
}

export class CommandRunner {
  readonly #options: CommandRunnerOptions;

  constructor(options: CommandRunnerOptions) {
    if (!options.taskRunId || !isAbsolute(options.taskRunRoot) || !isAbsolute(options.developerWorkspaceReposRoot)) {
      throw new TypeError("Command runner requires a TaskRun ID and absolute workspace roots");
    }
    if (!Number.isInteger(options.outputLimitBytes ?? 16_384) || (options.outputLimitBytes ?? 16_384) < 0) {
      throw new TypeError("Output limit must be a non-negative integer byte count");
    }
    if (!Number.isInteger(options.terminationGraceMilliseconds ?? 250) || (options.terminationGraceMilliseconds ?? 250) < 0) {
      throw new TypeError("Termination grace must be a non-negative integer millisecond count");
    }
    this.#options = options;
  }

  async run(command: StructuredCommand | ShellCommand): Promise<CommandResult> {
    validateCommand(command);
    let invocation: ResolvedInvocation;
    try {
      invocation = await this.#resolveInvocation(command);
    } catch (error) {
      return rejected(command, error);
    }

    const artifactInputs = [{
      id: `${command.id}-stdout`, path: `commands/${command.id}/stdout.txt`,
      mediaType: "text/plain; charset=utf-8",
    }, {
      id: `${command.id}-stderr`, path: `commands/${command.id}/stderr.txt`,
      mediaType: "text/plain; charset=utf-8",
    }] as const;
    const writers = await prepareArtifactWriters(this.#options.artifactStore, artifactInputs);
    let running: RunningProcess;
    try {
      running = executeProcess(invocation, command.timeoutSeconds,
        this.#options.terminationGraceMilliseconds ?? 250);
    } catch (error) {
      await Promise.allSettled(writers.map((writer) => writer.abort()));
      throw error;
    }
    const outputLimit = this.#options.outputLimitBytes ?? 16_384;
    const outputPromise = Promise.all([
      captureOutput(running.child.stdout, writers[0], outputLimit),
      captureOutput(running.child.stderr, writers[1], outputLimit),
    ]).then(
      (outputs) => ({ outputs, error: null }),
      (error: unknown) => ({ outputs: null, error }),
    );
    const execution = await running.completion;
    const captured = await outputPromise;
    if (captured.outputs === null) throw captured.error;
    const [stdout, stderr] = captured.outputs;
    const artifacts = [stdout.artifact, stderr.artifact];
    const outcome: CommandOutcome = execution.timedOut ? "timed_out"
      : execution.spawnFailed ? "spawn_error"
      : execution.exitCode === 0 ? "succeeded" : "failed";

    return {
      commandId: command.id, repository: command.repository, cwd: invocation.cwd,
      executable: invocation.executable, args: invocation.args.map(redactText), required: command.required,
      outcome, exitCode: execution.spawnFailed ? null : execution.exitCode,
      signal: execution.spawnFailed ? null : execution.signal, timedOut: execution.timedOut,
      timeoutSeconds: command.timeoutSeconds, stdout: stdout.value, stderr: stderr.value,
      stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated, artifacts,
      error: execution.error === null ? null : redactText(execution.error.message),
      shellDecisionId: invocation.shellDecisionId,
    };
  }

  async #resolveInvocation(command: StructuredCommand | ShellCommand): Promise<ResolvedInvocation> {
    const ids = this.#options.repositories.map(({ repositoryId }) => repositoryId);
    if (new Set(ids).size !== ids.length) throw new TypeError("Worktree mappings must have unique repository IDs");
    const worktree = this.#options.repositories.find(({ repositoryId }) => repositoryId === command.repository);
    if (worktree === undefined) throw new TypeError(`Repository ${command.repository} has no current TaskRun worktree`);
    if (worktree.taskRunId !== this.#options.taskRunId) throw new TypeError(`Repository ${command.repository} belongs to another TaskRun`);

    const taskRunRoot = await realpath(this.#options.taskRunRoot);
    const developerRoot = await realpath(this.#options.developerWorkspaceReposRoot);
    const cwd = await realpath(worktree.cwd);
    if (isAtOrWithin(taskRunRoot, developerRoot) || isAtOrWithin(cwd, developerRoot)) {
      throw new TypeError("Commands must not target workspace/repos");
    }
    const expected = command.repository === "@control" ? resolve(taskRunRoot, "control")
      : resolve(taskRunRoot, "repositories", command.repository);
    if (cwd !== expected || !isAtOrWithin(cwd, taskRunRoot)) {
      throw new TypeError(`Repository ${command.repository} is outside its current TaskRun location`);
    }

    const environment = resolveEnvironment(command.environment, this.#options.hostEnvironment ?? process.env);
    if ("shell" in command) {
      if (command.shellDecision?.allowed !== true || command.shellDecision.decisionId.trim().length === 0) {
        throw new TypeError("Shell command requires an explicit prevalidated allow decision");
      }
      return { cwd, executable: "/bin/sh", args: ["-c", command.shell], environment,
        shellDecisionId: command.shellDecision.decisionId };
    }
    if (!isAbsolute(command.executable) && environment.PATH === undefined) {
      throw new TypeError("Bare executables require PATH in the explicit environment allowlist");
    }
    return { cwd, executable: command.executable, args: [...command.args], environment, shellDecisionId: null };
  }
}

function validateCommand(command: StructuredCommand | ShellCommand): void {
  if (!ARTIFACT_SEGMENT.test(command.id)) throw new TypeError("Command ID must be a safe artifact path segment");
  if (command.repository.trim().length === 0 || !Number.isFinite(command.timeoutSeconds) ||
      command.timeoutSeconds <= 0 || typeof command.required !== "boolean") {
    throw new TypeError("Command repository, positive timeout, and required flag are mandatory");
  }
  if ("shell" in command) {
    if (command.shell.length === 0) throw new TypeError("Shell command must not be empty");
  } else if (command.executable.length === 0 || command.args.some((argument) => typeof argument !== "string")) {
    throw new TypeError("Structured commands require an executable and string argument array");
  }
}

function resolveEnvironment(requested: CommandEnvironment | undefined, host: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const names = requested?.allowlist ?? [];
  if (new Set(names).size !== names.length) throw new TypeError("Environment allowlist must not contain duplicates");
  for (const name of names) {
    if (!ENVIRONMENT_NAME.test(name)) throw new TypeError(`Invalid environment variable name ${JSON.stringify(name)}`);
    const supplied = requested?.values !== undefined && Object.prototype.hasOwnProperty.call(requested.values, name)
      ? requested.values[name] : host[name];
    if (supplied !== undefined) result[name] = supplied;
  }
  return result;
}

interface ProcessExecution {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly spawnFailed: boolean;
  readonly error: Error | null;
}

interface RunningProcess {
  readonly child: ChildProcess & { stdout: Readable; stderr: Readable };
  readonly completion: Promise<ProcessExecution>;
}

function executeProcess(invocation: ResolvedInvocation, timeoutSeconds: number,
  terminationGraceMilliseconds: number): RunningProcess {
  const child = spawn(invocation.executable, invocation.args, {
    cwd: invocation.cwd, env: invocation.environment, shell: false,
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  const completion = new Promise<ProcessExecution>((resolveResult) => {
    let spawnError: Error | null = null;
    let terminationError: Error | null = null;
    let timedOut = false;
    let escalation: NodeJS.Timeout | undefined;
    let escalationDone = false;
    let terminal: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;
    let settled = false;
    const settle = () => {
      if (settled || terminal === undefined) return;
      if (timedOut && !escalationDone) return;
      settled = true;
      resolveResult({ ...terminal, timedOut, spawnFailed: spawnError !== null,
        error: spawnError ?? terminationError });
    };
    child.once("error", (error) => { spawnError = error; });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminationError ??= terminate(child, "SIGTERM", true);
      const processGroupId = child.pid;
      escalation = setTimeout(() => {
        const escalationError = terminate(child, "SIGKILL", true, processGroupId);
        terminationError ??= escalationError;
        escalationDone = true;
        settle();
      }, terminationGraceMilliseconds);
    }, timeoutSeconds * 1_000);
    timeout.unref();
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      terminal = { exitCode, signal };
      if (!timedOut) {
        if (escalation !== undefined) clearTimeout(escalation);
        settle();
      } else {
        settle();
      }
    });
  });
  return { child, completion };
}

function terminate(child: ChildProcess, signal: NodeJS.Signals, processGroup: boolean,
  processGroupId = child.pid): Error | null {
  if (processGroupId === undefined) return null;
  try {
    if (processGroup && process.platform !== "win32") process.kill(-processGroupId, signal);
    else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    return null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return null;
    return error instanceof Error ? error : new Error("Process termination failed");
  }
}

interface CapturedOutput {
  readonly value: string;
  readonly truncated: boolean;
  readonly artifact: VerificationArtifactReference;
}

async function prepareArtifactWriters(
  artifactStore: VerificationArtifactStore,
  inputs: readonly [OpenVerificationArtifactInput, OpenVerificationArtifactInput],
): Promise<readonly [VerificationArtifactWriter, VerificationArtifactWriter]> {
  const first = await artifactStore.open(inputs[0]);
  try {
    const second = await artifactStore.open(inputs[1]);
    return [first, second];
  } catch (error) {
    await first.abort().catch(() => undefined);
    throw error;
  }
}

async function captureOutput(stream: Readable, writer: VerificationArtifactWriter,
  limit: number): Promise<CapturedOutput> {
  const decoder = new StringDecoder("utf8");
  const redactor = new StreamingRedactor();
  let summary = "";
  let summaryBytes = 0;
  let totalBytes = 0;
  let writeError: unknown;

  const persist = async (text: string): Promise<void> => {
    if (text.length === 0) return;
    const data = Buffer.from(text);
    totalBytes += data.byteLength;
    if (summaryBytes < limit) {
      for (const character of text) {
        const bytes = Buffer.byteLength(character);
        if (summaryBytes + bytes > limit) break;
        summary += character;
        summaryBytes += bytes;
      }
    }
    if (writeError === undefined) {
      try {
        await writer.write(data);
      } catch (error) {
        writeError = error;
        await writer.abort().catch(() => undefined);
      }
    }
  };

  try {
    for await (const chunk of stream) {
      await persist(redactor.push(decoder.write(Buffer.from(chunk))));
    }
    await persist(redactor.push(decoder.end(), true));
    if (writeError !== undefined) throw writeError;
    return { value: summary, truncated: totalBytes > summaryBytes, artifact: await writer.complete() };
  } catch (error) {
    await writer.abort().catch(() => undefined);
    throw error;
  }
}

type SecretMode =
  | { readonly kind: "authorization" }
  | { readonly kind: "unquoted" }
  | { readonly kind: "quoted"; readonly quote: string; escaped: boolean };

interface SecretStart {
  readonly index: number;
  readonly end: number;
  readonly replacement: string;
  readonly mode: SecretMode;
}

const REDACTION_LOOKBEHIND = 256;
const AUTHORIZATION_START = /\b(bearer|basic)(\s+)(?=[a-z0-9._~+/=-])/gi;
const QUOTED_ASSIGNMENT_START = /(^|[^A-Za-z0-9_-])(["']?)([A-Za-z][A-Za-z0-9_-]*)\2(\s*[:=]\s*)(["'])/gi;
const UNQUOTED_ASSIGNMENT_START = /(^|[^A-Za-z0-9_-])(["']?)([A-Za-z][A-Za-z0-9_-]*)\2(\s*[:=]\s*)(?!["'])(?=[^\s,;}"'])/gi;

class StreamingRedactor {
  #pending = "";
  #mode: SecretMode | null = null;

  push(value: string, final = false): string {
    this.#pending += value;
    let output = "";

    while (this.#pending.length > 0) {
      if (this.#mode !== null) {
        const consumed = this.#consumeSecret(final);
        output += consumed.output;
        if (!consumed.finished) break;
        continue;
      }

      const start = findSecretStart(this.#pending);
      if (start !== null) {
        output += redactText(this.#pending.slice(0, start.index));
        output += start.replacement;
        this.#pending = this.#pending.slice(start.end);
        this.#mode = start.mode;
        continue;
      }

      const flushLength = final ? this.#pending.length
        : Math.max(0, this.#pending.length - REDACTION_LOOKBEHIND);
      if (flushLength === 0) break;
      output += redactText(this.#pending.slice(0, flushLength));
      this.#pending = this.#pending.slice(flushLength);
    }

    if (final && this.#mode !== null) {
      this.#pending = "";
      this.#mode = null;
    }
    return output;
  }

  #consumeSecret(final: boolean): { output: string; finished: boolean } {
    const mode = this.#mode;
    if (mode === null) return { output: "", finished: true };
    if (mode.kind === "authorization") {
      const match = /^[a-z0-9._~+/=-]+/i.exec(this.#pending)?.[0] ?? "";
      this.#pending = this.#pending.slice(match.length);
      if (this.#pending.length === 0 && !final) return { output: "", finished: false };
      this.#mode = null;
      return { output: "", finished: true };
    }
    if (mode.kind === "unquoted") {
      const match = /^[^\s,;}"']+/.exec(this.#pending)?.[0] ?? "";
      this.#pending = this.#pending.slice(match.length);
      if (this.#pending.length === 0 && !final) return { output: "", finished: false };
      this.#mode = null;
      return { output: "", finished: true };
    }

    for (let index = 0; index < this.#pending.length; index += 1) {
      const character = this.#pending[index];
      if (mode.escaped) {
        mode.escaped = false;
      } else if (character === "\\") {
        mode.escaped = true;
      } else if (character === mode.quote) {
        this.#pending = this.#pending.slice(index + 1);
        this.#mode = null;
        return { output: mode.quote, finished: true };
      }
    }
    this.#pending = "";
    if (final) this.#mode = null;
    return { output: "", finished: final };
  }
}

function findSecretStart(value: string): SecretStart | null {
  const candidates: SecretStart[] = [];
  AUTHORIZATION_START.lastIndex = 0;
  const authorization = AUTHORIZATION_START.exec(value);
  if (authorization !== null) {
    candidates.push({ index: authorization.index, end: authorization.index + authorization[0].length,
      replacement: `${authorization[1]}${authorization[2]}${REDACTED_VALUE}`,
      mode: { kind: "authorization" } });
  }
  for (const match of matches(QUOTED_ASSIGNMENT_START, value)) {
    if (isSecretKey(match[3] ?? "")) {
      candidates.push({ index: match.index, end: match.index + match[0].length,
        replacement: `${match[1]}${match[2]}${match[3]}${match[2]}${match[4]}${match[5]}${REDACTED_VALUE}`,
        mode: { kind: "quoted", quote: match[5] ?? "", escaped: false } });
      break;
    }
  }
  for (const match of matches(UNQUOTED_ASSIGNMENT_START, value)) {
    if (isSecretKey(match[3] ?? "")) {
      candidates.push({ index: match.index, end: match.index + match[0].length,
        replacement: `${match[1]}${match[2]}${match[3]}${match[2]}${match[4]}${REDACTED_VALUE}`,
        mode: { kind: "unquoted" } });
      break;
    }
  }
  return candidates.sort((left, right) => left.index - right.index)[0] ?? null;
}

function* matches(pattern: RegExp, value: string): Generator<RegExpExecArray> {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) yield match;
}

function isAtOrWithin(path: string, boundary: string): boolean {
  const relation = relative(boundary, path);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function rejected(command: StructuredCommand | ShellCommand, error: unknown): CommandResult {
  return {
    commandId: command.id, repository: command.repository, cwd: null, executable: null, args: [],
    required: command.required, outcome: "rejected", exitCode: null, signal: null, timedOut: false,
    timeoutSeconds: command.timeoutSeconds, stdout: "", stderr: "", stdoutTruncated: false,
    stderrTruncated: false, artifacts: [],
    error: redactText(error instanceof Error ? error.message : "Command was rejected"), shellDecisionId: null,
  };
}
