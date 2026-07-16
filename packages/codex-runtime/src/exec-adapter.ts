import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import type { AgentRuntime, ContinueAgentSessionRequest, RuntimeSecurityCapabilities, StartAgentSessionRequest } from "./index.js";
import { AdapterFailure, createAdapterExecution, parseAgentResult } from "./adapter-common.js";

export interface CodexExecSpawnRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly shell: false;
}

export interface CodexExecProcess {
  readonly stdout: AsyncIterable<string | Uint8Array>;
  readonly stderr: AsyncIterable<string | Uint8Array>;
  readonly outcome: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>;
  writeStdin(value: string): void;
  closeStdin(): void;
  kill(): void | Promise<void>;
}

export type CodexExecSpawner = (request: CodexExecSpawnRequest) => CodexExecProcess;

export interface CodexExecAgentRuntimeOptions {
  readonly executable?: string;
  readonly spawner?: CodexExecSpawner;
  readonly sensitiveValues?: readonly string[];
}

export class CodexExecAgentRuntime implements AgentRuntime {
  readonly securityCapabilities: RuntimeSecurityCapabilities = unsupportedCapabilities;
  readonly #executable: string;
  readonly #spawner: CodexExecSpawner;
  readonly #sensitiveValues: readonly string[];
  readonly #providerSessions = new Map<string, string>();

  constructor(options: CodexExecAgentRuntimeOptions = {}) {
    this.#executable = options.executable ?? "codex";
    this.#spawner = options.spawner ?? defaultSpawner;
    this.#sensitiveValues = [...(options.sensitiveValues ?? [])];
  }

  start(request: StartAgentSessionRequest) {
    validateAdapterRequest(request);
    return this.#create(request, undefined);
  }

  continue(request: ContinueAgentSessionRequest) {
    validateAdapterRequest(request);
    const providerId = this.#providerSessions.get(request.sessionId);
    if (providerId === undefined) {
      throw new Error(`No codex exec session for runtime session ${request.sessionId}`);
    }
    return this.#create(request, providerId);
  }

  #create(request: StartAgentSessionRequest & { readonly sessionId?: string }, providerId: string | undefined) {
    let child: CodexExecProcess | undefined;
    const args = providerId === undefined
      ? ["exec", "--json", "-"]
      : ["exec", "resume", "--json", providerId, "-"];
    const execution = createAdapterExecution({
      lifecycleType: providerId === undefined ? "session_started" : "session_continued",
      ...(request.sessionId === undefined ? {} : { runtimeSessionId: request.sessionId }),
      timeoutMs: request.timeoutMs,
      sensitiveValues: [request.prompt, ...this.#sensitiveValues],
      onProviderSessionId: (continuedProviderId) => {
        if (providerId !== undefined && continuedProviderId !== providerId) {
          throw new AdapterFailure("CODEX_SESSION_MISMATCH", "codex exec resumed a different session", false);
        }
        this.#providerSessions.set(execution.sessionId, continuedProviderId);
      },
      cancelOperation: async () => child?.kill(),
      run: async (context) => {
        child = this.#spawner({
          executable: this.#executable,
          args,
          cwd: request.workingDirectory,
          shell: false,
        });
        if (context.signal.aborted) {
          await child.kill();
          throw new AdapterFailure("CODEX_OPERATION_STOPPED", "Codex operation was stopped", true);
        }
        child.writeStdin(request.prompt);
        child.closeStdin();
        return runExecProcess(child, context);
      },
    });
    return execution;
  }
}

async function runExecProcess(
  child: CodexExecProcess,
  context: { emitMessage(message: string): void; setProviderSessionId(id: string): void },
) {
  let stderr = "";
  const stderrDecoder = new StreamingUtf8Decoder();
  const stderrTask = (async () => {
    for await (const chunk of child.stderr) {
      stderr = `${stderr}${stderrDecoder.decode(chunk)}`.slice(-4096);
    }
    stderr = `${stderr}${stderrDecoder.flush()}`.slice(-4096);
  })();

  let buffer = "";
  const stdoutDecoder = new StreamingUtf8Decoder();
  let finalResponse: string | undefined;
  let turnFailed: string | undefined;
  for await (const chunk of child.stdout) {
    buffer += stdoutDecoder.decode(chunk);
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== "") {
        const parsed = parseJsonLine(line);
        const update = inspectExecEvent(parsed, context);
        finalResponse = update.finalResponse ?? finalResponse;
        turnFailed = update.failure ?? turnFailed;
      }
      newline = buffer.indexOf("\n");
    }
  }
  buffer += stdoutDecoder.flush();
  if (buffer.trim() !== "") {
    const update = inspectExecEvent(parseJsonLine(buffer.trim()), context);
    finalResponse = update.finalResponse ?? finalResponse;
    turnFailed = update.failure ?? turnFailed;
  }

  const processOutcome = await child.outcome;
  await stderrTask;
  if (turnFailed !== undefined) {
    throw new AdapterFailure("CODEX_EXEC_TURN_FAILED", turnFailed, true);
  }
  if (processOutcome.exitCode !== 0) {
    const detail = stderr.trim() === "" ? "codex exec exited unsuccessfully" : stderr;
    throw new AdapterFailure("CODEX_EXEC_EXIT", detail, true);
  }
  if (finalResponse === undefined) {
    throw new AdapterFailure("CODEX_RESULT_MISSING", "codex exec did not return a final Agent Result", true);
  }
  return parseAgentResult(finalResponse);
}

function inspectExecEvent(
  event: Record<string, unknown>,
  context: { emitMessage(message: string): void; setProviderSessionId(id: string): void },
): { readonly finalResponse?: string; readonly failure?: string } {
  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    context.setProviderSessionId(event.thread_id);
  }
  if (event.type === "item.completed") {
    const item = asRecord(event.item);
    if (item?.type === "agent_message" && typeof item.text === "string") {
      context.emitMessage(item.text);
      return { finalResponse: item.text };
    }
  }
  if (event.type === "turn.failed" || event.type === "error") {
    const error = asRecord(event.error);
    return {
      failure: typeof error?.message === "string"
        ? error.message
        : typeof event.message === "string"
          ? event.message
          : "codex exec turn failed",
    };
  }
  return {};
}

function parseJsonLine(line: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(line);
    const record = asRecord(value);
    if (record !== undefined) return record;
  } catch {
    // Use one stable, non-secret-bearing parse error below.
  }
  throw new AdapterFailure("CODEX_EXEC_JSONL_INVALID", "codex exec returned invalid JSONL", true);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

class StreamingUtf8Decoder {
  #decoder = new TextDecoder();
  #hasPendingByteStream = false;

  decode(value: string | Uint8Array): string {
    if (typeof value === "string") {
      const prefix = this.flush();
      return prefix + value;
    }
    this.#hasPendingByteStream = true;
    return this.#decoder.decode(value, { stream: true });
  }

  flush(): string {
    if (!this.#hasPendingByteStream) return "";
    this.#hasPendingByteStream = false;
    const output = this.#decoder.decode();
    this.#decoder = new TextDecoder();
    return output;
  }
}

function defaultSpawner(request: CodexExecSpawnRequest): CodexExecProcess {
  const child = spawn(request.executable, [...request.args], {
    cwd: request.cwd,
    shell: request.shell,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    stdout: child.stdout as Readable,
    stderr: child.stderr as Readable,
    outcome: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    }),
    writeStdin(value) {
      (child.stdin as Writable).write(value);
    },
    closeStdin() {
      (child.stdin as Writable).end();
    },
    kill() {
      child.kill("SIGTERM");
    },
  };
}

function validateAdapterRequest(request: StartAgentSessionRequest): void {
  if (request.workingDirectory.trim() === "") throw new TypeError("workingDirectory must be explicit and non-empty");
  if (request.prompt.trim() === "") throw new TypeError("prompt must be non-empty");
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive integer");
}

const unsupportedCapabilities: RuntimeSecurityCapabilities = {
  filesystemIsolation: "unsupported",
  environmentIsolation: "unsupported",
  networkIsolation: "unsupported",
};
