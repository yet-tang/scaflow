import { randomUUID } from "node:crypto";

import { REDACTED_VALUE, redactText } from "@scaflow/core";
import { agentResultSchema, type AgentResult } from "@scaflow/schemas";

import type {
  AgentExecution,
  AgentRuntimeError,
  AgentRuntimeEvent,
  AgentRuntimeTerminalOutcome,
} from "./index.js";

export interface AdapterRunContext {
  readonly signal: AbortSignal;
  emitMessage(message: string): void;
  setProviderSessionId(sessionId: string): void;
}

export interface AdapterExecutionOptions {
  readonly lifecycleType: "session_started" | "session_continued";
  readonly runtimeSessionId?: string;
  readonly timeoutMs: number;
  readonly sensitiveValues?: readonly string[];
  readonly run: (context: AdapterRunContext) => Promise<AgentResult>;
  readonly cancelOperation: () => void | Promise<void>;
  readonly onProviderSessionId: (sessionId: string) => void;
}

export class AdapterFailure extends Error {
  readonly runtimeError: AgentRuntimeError;

  constructor(code: string, message: string, recoverable: boolean) {
    const safeMessage = redactText(message);
    super(safeMessage);
    this.name = "AdapterFailure";
    this.runtimeError = { code, message: safeMessage, recoverable };
  }
}

export function redactSensitiveText(
  value: string,
  sensitiveValues: readonly string[] = [],
): string {
  let redacted = value;
  const nonEmptyValues = [...new Set(sensitiveValues.filter((sensitiveValue) => sensitiveValue !== ""))]
    .sort((left, right) => right.length - left.length);
  for (const sensitiveValue of nonEmptyValues) {
    redacted = redacted.split(sensitiveValue).join(REDACTED_VALUE);
  }
  return redactText(redacted);
}

export function parseAgentResult(value: string): AgentResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new AdapterFailure(
      "CODEX_RESULT_MALFORMED",
      "Codex returned a malformed Agent Result",
      true,
    );
  }

  const parsed = agentResultSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new AdapterFailure(
      "CODEX_RESULT_INVALID",
      "Codex returned an Agent Result that does not match the required schema",
      true,
    );
  }
  return parsed.data;
}

function redactAgentResult(
  result: AgentResult,
  sensitiveValues: readonly string[] = [],
): AgentResult {
  const redact = (value: string): string => redactSensitiveText(value, sensitiveValues);
  return {
    status: result.status,
    summary: redact(result.summary),
    changed_files: result.changed_files.map(redact),
    commands_run: result.commands_run.map((command) => ({
      executable: redact(command.executable),
      args: command.args.map(redact),
      exit_code: command.exit_code,
    })),
    acceptance_mapping: result.acceptance_mapping.map((mapping) => ({
      acceptance_criterion_id: redact(mapping.acceptance_criterion_id),
      evidence: mapping.evidence.map(redact),
      satisfied: mapping.satisfied,
    })),
    known_limitations: result.known_limitations.map(redact),
    decision_requests: result.decision_requests.map((decisionRequest) => ({
      question: redact(decisionRequest.question),
      context: redact(decisionRequest.context),
      options: decisionRequest.options.map(redact),
    })),
    risks_detected: result.risks_detected.map((risk) => ({
      description: redact(risk.description),
      severity: risk.severity,
    })),
  };
}

export function providerFailure(
  error: unknown,
  fallbackCode: string,
  sensitiveValues: readonly string[] = [],
): AdapterFailure {
  const message = redactSensitiveText(
    error instanceof Error ? error.message : String(error),
    sensitiveValues,
  );
  if (error instanceof AdapterFailure) {
    return new AdapterFailure(error.runtimeError.code, message, error.runtimeError.recoverable);
  }
  return new AdapterFailure(fallbackCode, message || "Codex provider failed", true);
}

export function createAdapterExecution(options: AdapterExecutionOptions): AgentExecution {
  const sessionId = options.runtimeSessionId ?? randomUUID();
  const events = new AsyncEventQueue<AgentRuntimeEvent>();
  const abortController = new AbortController();
  let sequence = 0;
  let state: "running" | "settling" | "settled" = "running";
  let cancelCalled = false;
  let resolveOutcome!: (outcome: AgentRuntimeTerminalOutcome) => void;
  const outcome = new Promise<AgentRuntimeTerminalOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  type UnsequencedEvent = AgentRuntimeEvent extends infer Event
    ? Event extends { readonly sequence: number }
      ? Omit<Event, "sequence">
      : never
    : never;
  const emit = (event: UnsequencedEvent): void => {
    events.push({ sequence: sequence++, ...event } as AgentRuntimeEvent);
  };

  emit({ type: options.lifecycleType, sessionId });

  const stopOperation = async (): Promise<void> => {
    if (cancelCalled) return;
    cancelCalled = true;
    abortController.abort();
    try {
      await options.cancelOperation();
    } catch {
      // A losing cleanup error must not replace the selected terminal outcome.
    }
  };

  const settle = async (
    terminal: AgentRuntimeTerminalOutcome,
    stop: boolean,
  ): Promise<void> => {
    if (state !== "running") return;
    state = "settling";
    clearTimeout(timer);
    if (stop) await stopOperation();
    emit(terminal);
    state = "settled";
    events.close();
    resolveOutcome(terminal);
  };

  const timer = setTimeout(() => {
    void settle({ type: "timed_out", timeoutMs: options.timeoutMs }, true);
  }, options.timeoutMs);

  void Promise.resolve()
    .then(() => {
      if (state !== "running") {
        throw new AdapterFailure("CODEX_OPERATION_STOPPED", "Codex operation was stopped", true);
      }
      return options.run({
        signal: abortController.signal,
        emitMessage(message) {
          if (state === "running") {
            emit({ type: "message", message: redactSensitiveText(message, options.sensitiveValues) });
          }
        },
        setProviderSessionId(providerSessionId) {
          if (state !== "running" || providerSessionId.trim() === "") return;
          options.onProviderSessionId(providerSessionId);
        },
      });
    })
    .then((result) => settle({
      type: "completed",
      result: redactAgentResult(result, options.sensitiveValues),
    }, false))
    .catch((error: unknown) => {
      const failure = providerFailure(error, "CODEX_PROVIDER_FAILED", options.sensitiveValues);
      return settle({ type: "runtime_failed", error: failure.runtimeError }, true);
    });

  return {
    sessionId,
    events,
    outcome,
    async cancel(reason = "Cancelled by caller") {
      await settle({
        type: "cancelled",
        reason: redactSensitiveText(reason, options.sensitiveValues),
      }, true);
    },
  };
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<() => void> = [];
  #closed = false;
  #consumed = false;

  push(value: T): void {
    if (this.#closed) return;
    this.#values.push(value);
    this.#waiters.shift()?.();
  }

  close(): void {
    this.#closed = true;
    while (this.#waiters.length > 0) this.#waiters.shift()?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.#consumed) throw new Error("Execution events can only be consumed once");
    this.#consumed = true;
    while (!this.#closed || this.#values.length > 0) {
      if (this.#values.length === 0) {
        await new Promise<void>((resolve) => this.#waiters.push(resolve));
        continue;
      }
      yield this.#values.shift() as T;
    }
  }
}
