import type { AgentResult } from "@scaflow/schemas";

export const packageName = "@scaflow/codex-runtime";

export {
  CodexSdkAgentRuntime,
  type CodexSdkAgentRuntimeOptions,
  type CodexSdkClient,
  type CodexSdkClientFactory,
  type CodexSdkThread,
} from "./sdk-adapter.js";
export {
  CodexExecAgentRuntime,
  type CodexExecAgentRuntimeOptions,
  type CodexExecProcess,
  type CodexExecSpawner,
  type CodexExecSpawnRequest,
} from "./exec-adapter.js";

export type AgentRuntimeEvent =
  | { readonly sequence: number; readonly type: "session_started"; readonly sessionId: string }
  | { readonly sequence: number; readonly type: "message"; readonly message: string }
  | { readonly sequence: number; readonly type: "session_continued"; readonly sessionId: string }
  | { readonly sequence: number; readonly type: "completed"; readonly result: AgentResult }
  | { readonly sequence: number; readonly type: "cancelled"; readonly reason?: string }
  | { readonly sequence: number; readonly type: "timed_out"; readonly timeoutMs: number }
  | { readonly sequence: number; readonly type: "runtime_failed"; readonly error: AgentRuntimeError };

export interface AgentRuntimeError {
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
}

export interface RuntimeSecurityCapabilities {
  readonly filesystemIsolation: "supported" | "unsupported";
  readonly environmentIsolation: "supported" | "unsupported";
  readonly networkIsolation: "supported" | "unsupported";
}

export interface StartAgentSessionRequest {
  readonly workingDirectory: string;
  readonly prompt: string;
  readonly timeoutMs: number;
}

export interface ContinueAgentSessionRequest extends StartAgentSessionRequest {
  readonly sessionId: string;
}

export type AgentRuntimeTerminalOutcome =
  | { readonly type: "completed"; readonly result: AgentResult }
  | { readonly type: "cancelled"; readonly reason?: string }
  | { readonly type: "timed_out"; readonly timeoutMs: number }
  | { readonly type: "runtime_failed"; readonly error: AgentRuntimeError };

export interface AgentExecution {
  readonly sessionId: string;
  readonly events: AsyncIterable<AgentRuntimeEvent>;
  readonly outcome: Promise<AgentRuntimeTerminalOutcome>;
  cancel(reason?: string): Promise<void>;
}

export interface AgentRuntime {
  readonly securityCapabilities: RuntimeSecurityCapabilities;
  start(request: StartAgentSessionRequest): AgentExecution;
  continue(request: ContinueAgentSessionRequest): AgentExecution;
}

export type MockTerminalScript =
  | { readonly type: "completed"; readonly result: AgentResult }
  | { readonly type: "timed_out" }
  | { readonly type: "runtime_failed"; readonly error: AgentRuntimeError };

export interface MockSessionScript {
  readonly sessionId: string;
  readonly messages?: readonly string[];
  readonly terminal: MockTerminalScript;
  readonly continuation?: MockSessionScript;
}

export class MockAgentRuntime implements AgentRuntime {
  readonly securityCapabilities: RuntimeSecurityCapabilities = {
    filesystemIsolation: "unsupported",
    environmentIsolation: "unsupported",
    networkIsolation: "unsupported",
  };

  readonly #scripts: MockSessionScript[];
  readonly #continuations = new Map<string, MockSessionScript>();

  constructor(scripts: readonly MockSessionScript[]) {
    this.#scripts = [...scripts];
  }

  start(request: StartAgentSessionRequest): AgentExecution {
    validateRequest(request);
    const script = this.#scripts.shift();
    if (script === undefined) {
      throw new Error("No Mock Runtime script remains");
    }
    if (script.continuation !== undefined) {
      this.#continuations.set(script.sessionId, script.continuation);
    }
    return createMockExecution(script, request.timeoutMs, "session_started");
  }

  continue(request: ContinueAgentSessionRequest): AgentExecution {
    validateRequest(request);
    const script = this.#continuations.get(request.sessionId);
    if (script === undefined || script.sessionId !== request.sessionId) {
      throw new Error(`No continuation script for session ${request.sessionId}`);
    }
    this.#continuations.delete(request.sessionId);
    if (script.continuation !== undefined) {
      this.#continuations.set(script.sessionId, script.continuation);
    }
    return createMockExecution(script, request.timeoutMs, "session_continued");
  }
}

function validateRequest(request: StartAgentSessionRequest): void {
  if (request.workingDirectory.trim() === "") {
    throw new TypeError("workingDirectory must be explicit and non-empty");
  }
  if (request.prompt.trim() === "") {
    throw new TypeError("prompt must be non-empty");
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive integer");
  }
}

function createMockExecution(
  script: MockSessionScript,
  timeoutMs: number,
  lifecycleType: "session_started" | "session_continued",
): AgentExecution {
  let cancelledReason: string | undefined;
  let consumed = false;
  let settledOutcome: AgentRuntimeTerminalOutcome | undefined;

  const terminalOutcome = (): AgentRuntimeTerminalOutcome => {
    if (settledOutcome !== undefined) {
      return settledOutcome;
    }
    if (cancelledReason !== undefined) {
      settledOutcome = { type: "cancelled", reason: cancelledReason };
      return settledOutcome;
    }
    if (script.terminal.type === "timed_out") {
      settledOutcome = { type: "timed_out", timeoutMs };
      return settledOutcome;
    }
    settledOutcome = script.terminal;
    return settledOutcome;
  };

  const events: AsyncIterable<AgentRuntimeEvent> = {
    async *[Symbol.asyncIterator]() {
      if (consumed) {
        throw new Error("Mock execution events can only be consumed once");
      }
      consumed = true;
      let sequence = 0;
      yield { sequence: sequence++, type: lifecycleType, sessionId: script.sessionId };
      for (const message of script.messages ?? []) {
        if (cancelledReason !== undefined) break;
        yield { sequence: sequence++, type: "message", message };
      }

      const terminal = terminalOutcome();
      yield { sequence, ...terminal } as AgentRuntimeEvent;
    },
  };

  return {
    sessionId: script.sessionId,
    events,
    get outcome() {
      return Promise.resolve(terminalOutcome());
    },
    async cancel(reason = "Cancelled by caller") {
      if (settledOutcome === undefined) {
        cancelledReason ??= reason;
      }
    },
  };
}
