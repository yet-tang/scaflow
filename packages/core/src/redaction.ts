export const REDACTED_VALUE = "[REDACTED]";
export const CIRCULAR_VALUE = "[Circular]";
export const UNSUPPORTED_VALUE = "[Unsupported]";

export type RedactedValue =
  | null
  | boolean
  | number
  | string
  | RedactedValue[]
  | { [key: string]: RedactedValue };

const SECRET_NAME_PATTERN =
  "api[-_]?key|authorization|client[-_]?secret|cookie|credential|password|passwd|private[-_]?key|refresh[-_]?token|secret|set[-_]?cookie|token";
const SECRET_KEY_PATTERN = new RegExp(
  `(?:^|[-_])(?:${SECRET_NAME_PATTERN})(?:$|[-_])`,
  "i",
);

const AUTHORIZATION_VALUE_PATTERN =
  /\b(bearer|basic)\s+[a-z0-9._~+/=-]+/gi;
const ASSIGNMENT_LABEL_PATTERN = "[A-Za-z][A-Za-z0-9_-]*";
const QUOTED_NAMED_SECRET_VALUE_PATTERN = new RegExp(
  `(^|[^A-Za-z0-9_-])(["']?)(${ASSIGNMENT_LABEL_PATTERN})\\2(\\s*[:=]\\s*)(["'])((?:\\\\.|(?!\\5)[^\\\\])*)\\5`,
  "gi",
);
const UNQUOTED_NAMED_SECRET_VALUE_PATTERN = new RegExp(
  `(^|[^A-Za-z0-9_-])(${ASSIGNMENT_LABEL_PATTERN})(\\s*[:=]\\s*)(?!["'])([^\\s,;}"']+)`,
  "gi",
);

export function isSecretKey(key: string): boolean {
  const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return SECRET_KEY_PATTERN.test(normalizedKey);
}

export function redactText(value: string): string {
  return value
    .replace(
      AUTHORIZATION_VALUE_PATTERN,
      (_match, scheme: string) => `${scheme} ${REDACTED_VALUE}`,
    )
    .replace(
      QUOTED_NAMED_SECRET_VALUE_PATTERN,
      (
        match,
        prefix: string,
        keyQuote: string,
        name: string,
        separator: string,
        valueQuote: string,
      ) =>
        isSecretKey(name)
          ? `${prefix}${keyQuote}${name}${keyQuote}${separator}${valueQuote}${REDACTED_VALUE}${valueQuote}`
          : match,
    )
    .replace(
      UNQUOTED_NAMED_SECRET_VALUE_PATTERN,
      (
        match,
        prefix: string,
        name: string,
        separator: string,
      ) =>
        isSecretKey(name)
          ? `${prefix}${name}${separator}${REDACTED_VALUE}`
          : match,
    );
}

export function redactSecrets(value: unknown): RedactedValue {
  return redactValue(value, new WeakSet<object>());
}

function redactValue(value: unknown, ancestors: WeakSet<object>): RedactedValue {
  if (value === null || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return redactText(value);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value !== "object") {
    return UNSUPPORTED_VALUE;
  }

  if (ancestors.has(value)) {
    return CIRCULAR_VALUE;
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, ancestors));
    }

    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? UNSUPPORTED_VALUE : value.toISOString();
    }

    if (value instanceof Error) {
      return {
        name: redactText(value.name),
        message: redactText(value.message),
      };
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) {
      return UNSUPPORTED_VALUE;
    }

    const output: Record<string, RedactedValue> = {};
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (!descriptor.enumerable) {
        continue;
      }

      output[key] = isSecretKey(key)
        ? REDACTED_VALUE
        : "value" in descriptor
          ? redactValue(descriptor.value, ancestors)
          : UNSUPPORTED_VALUE;
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}
