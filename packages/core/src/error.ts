import {
  resolveCorrelationId,
  validateCorrelationId,
} from "./correlation.js";
import {
  redactSecrets,
  redactText,
  type RedactedValue,
} from "./redaction.js";

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const INVALID_ERROR_CODE_MESSAGE =
  "Scaflow error codes must use uppercase letters, numbers, and underscores";
const INVALID_RECOVERABLE_MESSAGE =
  "Scaflow error recoverable metadata must be a boolean";

export interface ScaflowErrorOptions {
  code: string;
  recoverable?: boolean;
  suggestion?: string;
  correlationId?: string;
  details?: unknown;
  cause?: unknown;
}

export interface SerializedScaflowError {
  name: "ScaflowError";
  message: string;
  code: string;
  recoverable: boolean;
  correlationId: string;
  suggestion?: string;
  details?: RedactedValue;
}

export class ScaflowError extends Error {
  declare readonly code: string;
  declare readonly recoverable: boolean;
  declare readonly correlationId: string;
  readonly suggestion?: string;
  readonly details?: unknown;

  constructor(message: string, options: ScaflowErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });

    this.name = "ScaflowError";
    Object.defineProperties(this, {
      code: stableMetadata(validateErrorCode(options.code)),
      recoverable: stableMetadata(
        validateRecoverable(options.recoverable ?? false),
      ),
      correlationId: stableMetadata(
        resolveCorrelationId(options.correlationId),
      ),
    });

    if (options.suggestion !== undefined) {
      this.suggestion = options.suggestion;
    }
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }

  toJSON(): SerializedScaflowError {
    return serializeScaflowError(this);
  }
}

export function serializeScaflowError(
  error: ScaflowError,
): SerializedScaflowError {
  const serialized: SerializedScaflowError = {
    name: "ScaflowError",
    message: redactText(error.message),
    code: validateErrorCode(error.code),
    recoverable: validateRecoverable(error.recoverable),
    correlationId: validateCorrelationId(error.correlationId),
  };

  if (error.suggestion !== undefined) {
    serialized.suggestion = redactText(error.suggestion);
  }
  if (error.details !== undefined) {
    serialized.details = redactSecrets(error.details);
  }

  return serialized;
}

function stableMetadata(value: unknown): PropertyDescriptor {
  return {
    value,
    enumerable: true,
    writable: false,
    configurable: false,
  };
}

function validateErrorCode(code: string): string {
  if (typeof code !== "string" || !ERROR_CODE_PATTERN.test(code)) {
    throw new TypeError(INVALID_ERROR_CODE_MESSAGE);
  }

  return code;
}

function validateRecoverable(recoverable: boolean): boolean {
  if (typeof recoverable !== "boolean") {
    throw new TypeError(INVALID_RECOVERABLE_MESSAGE);
  }

  return recoverable;
}
