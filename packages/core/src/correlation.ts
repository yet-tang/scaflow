import { randomUUID } from "node:crypto";

import { isSecretKey } from "./redaction.js";

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const AUTH_SCHEME_PATTERN =
  /(?:^|[-_.:/])(?:bearer|basic)(?:$|[-_.:/])/i;

export function createCorrelationId(): string {
  return randomUUID();
}

export function validateCorrelationId(correlationId: string): string {
  if (
    typeof correlationId !== "string" ||
    !CORRELATION_ID_PATTERN.test(correlationId) ||
    isSecretKey(correlationId) ||
    AUTH_SCHEME_PATTERN.test(correlationId)
  ) {
    throw new TypeError("Correlation ID must be a safe ASCII identifier");
  }

  return correlationId;
}

export function resolveCorrelationId(correlationId?: string): string {
  return correlationId === undefined
    ? createCorrelationId()
    : validateCorrelationId(correlationId);
}
