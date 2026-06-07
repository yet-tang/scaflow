export const packageName = "@scaflow/core";

export {
  createCorrelationId,
  resolveCorrelationId,
  validateCorrelationId,
} from "./correlation.js";
export {
  ScaflowError,
  serializeScaflowError,
  type ScaflowErrorOptions,
  type SerializedScaflowError,
} from "./error.js";
export {
  createLogRecord,
  type LogLevel,
  type LogRecord,
  type LogRecordInput,
} from "./logging.js";
export {
  CIRCULAR_VALUE,
  REDACTED_VALUE,
  UNSUPPORTED_VALUE,
  isSecretKey,
  redactSecrets,
  redactText,
  type RedactedValue,
} from "./redaction.js";
