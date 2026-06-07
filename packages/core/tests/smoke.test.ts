import { describe, expect, it } from "vitest";

import {
  CIRCULAR_VALUE,
  REDACTED_VALUE,
  ScaflowError,
  createLogRecord,
  packageName,
  redactSecrets,
  redactText,
  serializeScaflowError,
} from "../src/index";

describe("@scaflow/core", () => {
  it("exposes package identity", () => {
    expect(packageName).toBe("@scaflow/core");
  });

  it("creates normal errors with stable metadata and Error behavior", () => {
    const error = new ScaflowError("Configuration is invalid", {
      code: "CONFIG_INVALID",
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ScaflowError");
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.recoverable).toBe(false);
    expect(error.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("preserves recoverability, suggestions, and propagated correlation IDs", () => {
    const cause = new Error("temporary failure");
    const error = new ScaflowError("Retry later", {
      code: "SERVICE_UNAVAILABLE",
      recoverable: true,
      suggestion: "Retry the operation",
      correlationId: "run-123",
      cause,
    });

    expect(error.recoverable).toBe(true);
    expect(error.suggestion).toBe("Retry the operation");
    expect(error.correlationId).toBe("run-123");
    expect(error.cause).toBe(cause);
  });

  it("rejects error codes that are not stable machine-readable identifiers", () => {
    expect(
      () =>
        new ScaflowError("Invalid code", {
          code: "invalid-code",
        }),
    ).toThrow(TypeError);
  });

  it("redacts nested fields and arrays without mutating caller data", () => {
    const input = {
      user: "alice",
      password: "visible-before-redaction",
      nested: {
        apiKey: "key-value",
        dbPassword: "database-secret",
        headers: [
          { authorization: "Bearer abc123" },
          { "x-api-key": "prefixed-key" },
          { accept: "json" },
        ],
      },
    };

    const result = redactSecrets(input);

    expect(result).toEqual({
      user: "alice",
      password: REDACTED_VALUE,
      nested: {
        apiKey: REDACTED_VALUE,
        dbPassword: REDACTED_VALUE,
        headers: [
          { authorization: REDACTED_VALUE },
          { "x-api-key": REDACTED_VALUE },
          { accept: "json" },
        ],
      },
    });
    expect(input.password).toBe("visible-before-redaction");
    expect(input.nested.apiKey).toBe("key-value");
  });

  it("redacts secret-like text and bounds cycles and getters", () => {
    let getterCalled = false;
    const input: Record<string, unknown> = {
      message: "authorization=Bearer-secret token:plain-secret",
    };
    input.self = input;
    Object.defineProperty(input, "computed", {
      enumerable: true,
      get() {
        getterCalled = true;
        return "secret";
      },
    });

    expect(redactSecrets(input)).toEqual({
      message: `authorization=${REDACTED_VALUE} token:${REDACTED_VALUE}`,
      self: CIRCULAR_VALUE,
      computed: "[Unsupported]",
    });
    expect(getterCalled).toBe(false);
    expect(redactSecrets(new Map([["password", "secret"]]))).toBe(
      "[Unsupported]",
    );
  });

  it("redacts complete quoted secret assignments without crossing boundaries", () => {
    const cases = [
      {
        input: '{"token":"json-secret","status":"ok"}',
        expected: `{"token":"${REDACTED_VALUE}","status":"ok"}`,
        secretFragments: ["json-secret"],
      },
      {
        input: 'token="two word secret"; status=ok',
        expected: `token="${REDACTED_VALUE}"; status=ok`,
        secretFragments: ["two", "word secret"],
      },
      {
        input: "secret='single quoted value', count=2",
        expected: `secret='${REDACTED_VALUE}', count=2`,
        secretFragments: ["single", "quoted value"],
      },
      {
        input: String.raw`{"apiKey":"escaped \"secret\" value","safe":"visible"}`,
        expected: `{"apiKey":"${REDACTED_VALUE}","safe":"visible"}`,
        secretFragments: ["escaped", "secret", "value"],
      },
    ];

    for (const { input, expected, secretFragments } of cases) {
      const redacted = redactText(input);

      expect(redacted).toBe(expected);
      for (const fragment of secretFragments) {
        expect(redacted).not.toContain(fragment);
      }
    }
  });

  it("redacts structured secret labels in quoted and unquoted text", () => {
    const cases = [
      {
        input:
          'cookie=session-secret; status=ok; credential="two word credential"; count=2',
        expected: `cookie=${REDACTED_VALUE}; status=ok; credential="${REDACTED_VALUE}"; count=2`,
        secrets: ["session-secret", "two word credential"],
      },
      {
        input:
          '{"set-cookie":"quoted-cookie","safe":"visible"} set_cookie=plain-cookie next=visible',
        expected: `{"set-cookie":"${REDACTED_VALUE}","safe":"visible"} set_cookie=${REDACTED_VALUE} next=visible`,
        secrets: ["quoted-cookie", "plain-cookie"],
      },
      {
        input: "passwd='quoted password'; adjacent=preserved",
        expected: `passwd='${REDACTED_VALUE}'; adjacent=preserved`,
        secrets: ["quoted password"],
      },
    ];

    for (const { input, expected, secrets } of cases) {
      const redacted = redactText(input);

      expect(redacted).toBe(expected);
      for (const secret of secrets) {
        expect(redacted).not.toContain(secret);
      }
    }
  });

  it("redacts prefixed secret labels using the structured key policy", () => {
    const secrets = [
      "database-value",
      "access-value",
      "session-value",
      "snake-value",
      "kebab-value",
    ];
    const input =
      "dbPassword=database-value accessToken=access-value sessionCookie=session-value db_password=snake-value access-token=kebab-value status=ok";
    const redacted = redactText(input);

    expect(redacted).toBe(
      `dbPassword=${REDACTED_VALUE} accessToken=${REDACTED_VALUE} sessionCookie=${REDACTED_VALUE} db_password=${REDACTED_VALUE} access-token=${REDACTED_VALUE} status=ok`,
    );
    for (const secret of secrets) {
      expect(redacted).not.toContain(secret);
    }
  });

  it("creates redacted log records with generated or propagated IDs", () => {
    const generated = createLogRecord({
      level: "info",
      message: "Connected with Bearer abc123",
      fields: { token: "abc123", count: 2 },
    });
    const propagated = createLogRecord({
      level: "warn",
      message: "Retrying",
      correlationId: generated.correlationId,
    });

    expect(generated).toMatchObject({
      level: "info",
      message: `Connected with Bearer ${REDACTED_VALUE}`,
      fields: { token: REDACTED_VALUE, count: 2 },
    });
    expect(propagated.correlationId).toBe(generated.correlationId);
  });

  it("redacts JSON and whitespace-containing secrets in log messages", () => {
    const message =
      '{"token":"log-json-secret"} token="log two word secret" status=ok';
    const record = createLogRecord({
      level: "info",
      message,
      correlationId: "log-quoted-redaction",
    });

    expect(record.message).toBe(
      `{"token":"${REDACTED_VALUE}"} token="${REDACTED_VALUE}" status=ok`,
    );
    for (const secret of ["log-json-secret", "log", "two word secret"]) {
      expect(record.message).not.toContain(secret);
    }
  });

  it("redacts cookie and credential labels in log messages", () => {
    const secrets = [
      "session-cookie",
      "response-cookie",
      "alternate-cookie",
      "stored-credential",
      "legacy-password",
    ];
    const record = createLogRecord({
      level: "info",
      message:
        'cookie=session-cookie set-cookie="response-cookie" set_cookie=alternate-cookie credential=stored-credential passwd="legacy-password" status=ok',
      correlationId: "log-label-redaction",
    });

    expect(record.message).toBe(
      `cookie=${REDACTED_VALUE} set-cookie="${REDACTED_VALUE}" set_cookie=${REDACTED_VALUE} credential=${REDACTED_VALUE} passwd="${REDACTED_VALUE}" status=ok`,
    );
    for (const secret of secrets) {
      expect(record.message).not.toContain(secret);
    }
  });

  it("redacts camelCase secret labels in log messages", () => {
    const secrets = ["database-value", "access-value", "session-value"];
    const record = createLogRecord({
      level: "info",
      message:
        "dbPassword=database-value accessToken=access-value sessionCookie=session-value status=ok",
      correlationId: "log-camel-case-redaction",
    });

    expect(record.message).toBe(
      `dbPassword=${REDACTED_VALUE} accessToken=${REDACTED_VALUE} sessionCookie=${REDACTED_VALUE} status=ok`,
    );
    for (const secret of secrets) {
      expect(record.message).not.toContain(secret);
    }
  });

  it("rejects unsafe supplied correlation IDs from errors and log records", () => {
    const secretBearingCorrelationIds = [
      "token=correlation-secret",
      "authorization:Bearer-secret",
      "Bearer-abc123",
      "Basic:abc123",
      "accessToken-abc123",
      "access_token-abc123",
      "access-token-abc123",
      "dbPassword-abc123",
      "db_password-abc123",
      "db-password-abc123",
      "sessionCookie-abc123",
      "session_cookie-abc123",
      "session-cookie-abc123",
    ];
    const invalidCorrelationIds = [
      "",
      "   ",
      "contains whitespace",
      "contains\ncontrol",
      "malformed!",
      "x".repeat(129),
      ...secretBearingCorrelationIds,
    ];

    for (const correlationId of invalidCorrelationIds) {
      const operations = [
        () =>
          new ScaflowError("Invalid correlation ID", {
            code: "INVALID_CORRELATION_ID",
            correlationId,
          }),
        () =>
          createLogRecord({
            level: "error",
            message: "Invalid correlation ID",
            correlationId,
          }),
      ];

      for (const operation of operations) {
        expect(operation).toThrowError(
          "Correlation ID must be a safe ASCII identifier",
        );
        try {
          operation();
        } catch (caught) {
          if (secretBearingCorrelationIds.includes(correlationId)) {
            expect(String(caught)).not.toContain(correlationId);
          }
        }
      }
    }
  });

  it("keeps required error metadata immutable at runtime", () => {
    const error = new ScaflowError("Stable metadata", {
      code: "STABLE_METADATA",
      recoverable: true,
      correlationId: "request-456",
    });
    const forgedValues = {
      code: "token=forged-code-secret",
      recoverable: false,
      correlationId: "accessToken-forged-correlation-secret",
    } as const;

    for (const [key, forgedValue] of Object.entries(forgedValues)) {
      expect(Reflect.set(error, key, forgedValue)).toBe(false);
      expect(() =>
        Object.defineProperty(error, key, {
          value: forgedValue,
        }),
      ).toThrow(TypeError);

      expect(Object.getOwnPropertyDescriptor(error, key)).toMatchObject({
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }

    expect(serializeScaflowError(error)).toMatchObject({
      code: "STABLE_METADATA",
      recoverable: true,
      correlationId: "request-456",
    });
    const output = JSON.stringify(error);
    for (const forgedValue of Object.values(forgedValues)) {
      expect(output).not.toContain(String(forgedValue));
    }
  });

  it("fails closed when serializing malformed required metadata", () => {
    const forgedSecrets = [
      "token=forged-code-secret",
      "accessToken-forged-correlation-secret",
    ];
    const malformedErrors = [
      {
        message: "Malformed code",
        code: forgedSecrets[0],
        recoverable: false,
        correlationId: "request-456",
      },
      {
        message: "Malformed recoverability",
        code: "MALFORMED_RECOVERABILITY",
        recoverable: "false",
        correlationId: "request-456",
      },
      {
        message: "Malformed correlation",
        code: "MALFORMED_CORRELATION",
        recoverable: false,
        correlationId: forgedSecrets[1],
      },
    ];

    for (const malformedError of malformedErrors) {
      const operation = () =>
        serializeScaflowError(malformedError as unknown as ScaflowError);

      expect(operation).toThrow(TypeError);
      try {
        operation();
      } catch (caught) {
        const thrown = String(caught);
        for (const forgedSecret of forgedSecrets) {
          expect(thrown).not.toContain(forgedSecret);
        }
      }
    }
  });

  it("serializes errors without leaking details, suggestions, or causes", () => {
    const error = new ScaflowError("Request used token=message-secret", {
      code: "REQUEST_FAILED",
      recoverable: true,
      suggestion: "Replace apiKey=old-secret",
      correlationId: "request-456",
      details: {
        password: "detail-secret",
        endpoint: "/health",
      },
      cause: new Error("cause-secret"),
    });

    expect(serializeScaflowError(error)).toEqual({
      name: "ScaflowError",
      message: `Request used token=${REDACTED_VALUE}`,
      code: "REQUEST_FAILED",
      recoverable: true,
      correlationId: "request-456",
      suggestion: `Replace apiKey=${REDACTED_VALUE}`,
      details: {
        password: REDACTED_VALUE,
        endpoint: "/health",
      },
    });
    expect(JSON.stringify(error)).not.toContain("cause-secret");
    expect(JSON.stringify(error)).not.toContain("detail-secret");
  });

  it("redacts quoted secrets in serialized error messages and suggestions", () => {
    const error = new ScaflowError(
      '{"token":"topaz-json-credential","status":"failed"}',
      {
        code: "QUOTED_SECRET",
        suggestion:
          'Replace password="saffron multi word credential" then retry',
        correlationId: "trace-quoted-redaction",
      },
    );

    const serialized = serializeScaflowError(error);

    expect(serialized.message).toBe(
      `{"token":"${REDACTED_VALUE}","status":"failed"}`,
    );
    expect(serialized.suggestion).toBe(
      `Replace password="${REDACTED_VALUE}" then retry`,
    );
    const output = JSON.stringify(serialized);
    for (const secret of [
      "topaz",
      "json-credential",
      "saffron",
      "multi word credential",
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it("redacts camelCase secret labels in serialized errors", () => {
    const secrets = ["database-value", "access-value", "session-value"];
    const error = new ScaflowError(
      "Connection failed dbPassword=database-value status=failed",
      {
        code: "CAMEL_CASE_SECRET",
        suggestion:
          "Replace accessToken=access-value and sessionCookie=session-value then retry",
        correlationId: "trace-camel-case-redaction",
      },
    );

    const serialized = serializeScaflowError(error);

    expect(serialized.message).toBe(
      `Connection failed dbPassword=${REDACTED_VALUE} status=failed`,
    );
    expect(serialized.suggestion).toBe(
      `Replace accessToken=${REDACTED_VALUE} and sessionCookie=${REDACTED_VALUE} then retry`,
    );
    const output = JSON.stringify(serialized);
    for (const secret of secrets) {
      expect(output).not.toContain(secret);
    }
  });

});
