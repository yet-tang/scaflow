import { resolveCorrelationId } from "./correlation.js";
import {
  redactSecrets,
  redactText,
  type RedactedValue,
} from "./redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecordInput {
  level: LogLevel;
  message: string;
  correlationId?: string;
  fields?: unknown;
}

export interface LogRecord {
  level: LogLevel;
  message: string;
  correlationId: string;
  fields?: RedactedValue;
}

export function createLogRecord(input: LogRecordInput): LogRecord {
  const record: LogRecord = {
    level: input.level,
    message: redactText(input.message),
    correlationId: resolveCorrelationId(input.correlationId),
  };

  if (input.fields !== undefined) {
    record.fields = redactSecrets(input.fields);
  }

  return record;
}
