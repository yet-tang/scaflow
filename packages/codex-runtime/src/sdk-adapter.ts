import { Codex, type Thread, type ThreadOptions } from "@openai/codex-sdk";

import type { AgentRuntime, ContinueAgentSessionRequest, RuntimeSecurityCapabilities, StartAgentSessionRequest } from "./index.js";
import { AdapterFailure, createAdapterExecution, parseAgentResult } from "./adapter-common.js";

export type CodexSdkThread = Pick<Thread, "id" | "runStreamed">;

export interface CodexSdkClient {
  startThread(options?: ThreadOptions): CodexSdkThread;
  resumeThread(id: string, options?: ThreadOptions): CodexSdkThread;
}

export type CodexSdkClientFactory = () => CodexSdkClient | Promise<CodexSdkClient>;

export interface CodexSdkAgentRuntimeOptions {
  readonly clientFactory?: CodexSdkClientFactory;
  readonly sensitiveValues?: readonly string[];
}

export class CodexSdkAgentRuntime implements AgentRuntime {
  readonly securityCapabilities: RuntimeSecurityCapabilities = unsupportedCapabilities;
  readonly #clientFactory: CodexSdkClientFactory;
  readonly #sensitiveValues: readonly string[];
  readonly #providerSessions = new Map<string, string>();

  constructor(options: CodexSdkAgentRuntimeOptions = {}) {
    this.#clientFactory = options.clientFactory ?? defaultClientFactory;
    this.#sensitiveValues = [...(options.sensitiveValues ?? [])];
  }

  start(request: StartAgentSessionRequest) {
    validateAdapterRequest(request);
    const execution = createAdapterExecution({
      lifecycleType: "session_started",
      timeoutMs: request.timeoutMs,
      sensitiveValues: [request.prompt, ...this.#sensitiveValues],
      onProviderSessionId: (providerId) => this.#providerSessions.set(execution.sessionId, providerId),
      cancelOperation: () => undefined,
      run: async (context) => {
        const client = await this.#clientFactory();
        throwIfAborted(context.signal);
        const thread = client.startThread({ workingDirectory: request.workingDirectory });
        return runSdkThread(thread, request.prompt, context);
      },
    });
    return execution;
  }

  continue(request: ContinueAgentSessionRequest) {
    validateAdapterRequest(request);
    const providerId = this.#providerSessions.get(request.sessionId);
    if (providerId === undefined) {
      throw new Error(`No Codex SDK session for runtime session ${request.sessionId}`);
    }
    return createAdapterExecution({
      lifecycleType: "session_continued",
      runtimeSessionId: request.sessionId,
      timeoutMs: request.timeoutMs,
      sensitiveValues: [request.prompt, ...this.#sensitiveValues],
      onProviderSessionId: (continuedProviderId) => {
        if (continuedProviderId !== providerId) {
          throw new AdapterFailure("CODEX_SESSION_MISMATCH", "Codex resumed a different session", false);
        }
      },
      cancelOperation: () => undefined,
      run: async (context) => {
        const client = await this.#clientFactory();
        throwIfAborted(context.signal);
        const thread = client.resumeThread(providerId, { workingDirectory: request.workingDirectory });
        return runSdkThread(thread, request.prompt, context);
      },
    });
  }
}

async function runSdkThread(
  thread: CodexSdkThread,
  prompt: string,
  context: { readonly signal: AbortSignal; emitMessage(message: string): void; setProviderSessionId(id: string): void },
) {
  const streamed = await thread.runStreamed(prompt, { signal: context.signal });
  let finalResponse: string | undefined;
  let sawCompletion = false;
  for await (const rawEvent of streamed.events) {
    const event = asRecord(rawEvent);
    if (event?.type === "thread.started" && typeof event.thread_id === "string") {
      context.setProviderSessionId(event.thread_id);
    } else if (event?.type === "item.completed") {
      const item = asRecord(event.item);
      if (item?.type === "agent_message" && typeof item.text === "string") {
        finalResponse = item.text;
        context.emitMessage(item.text);
      }
    } else if (event?.type === "turn.completed") {
      sawCompletion = true;
    } else if (event?.type === "turn.failed" || event?.type === "error") {
      const error = asRecord(event.error);
      const message = typeof error?.message === "string"
        ? error.message
        : typeof event.message === "string"
          ? event.message
          : "Codex SDK turn failed";
      throw new AdapterFailure("CODEX_SDK_TURN_FAILED", message, true);
    }
  }
  if (thread.id !== null) context.setProviderSessionId(thread.id);
  if (!sawCompletion || finalResponse === undefined) {
    throw new AdapterFailure("CODEX_RESULT_MISSING", "Codex SDK did not return a final Agent Result", true);
  }
  return parseAgentResult(finalResponse);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function defaultClientFactory(): CodexSdkClient {
  return new Codex();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AdapterFailure("CODEX_OPERATION_STOPPED", "Codex operation was stopped", true);
  }
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
