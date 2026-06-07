import { ScaflowError } from "@scaflow/core";
import type { ZodIssue, ZodType } from "zod";

export interface SchemaIssue {
  code: string;
  path: readonly (string | number)[];
  message: string;
}

export interface SchemaParseOptions {
  correlationId?: string;
}

export type SchemaParseResult<Output> =
  | {
      success: true;
      data: Output;
    }
  | {
      success: false;
      error: SchemaParseError;
    };

export class SchemaParseError extends ScaflowError {
  declare readonly name: "SchemaParseError";
  readonly issues: readonly SchemaIssue[];

  constructor(
    issues: readonly SchemaIssue[],
    options: SchemaParseOptions & { cause?: unknown } = {},
  ) {
    const stableIssues = freezeIssues(issues);
    super("Input does not match the expected schema", {
      code: "SCHEMA_PARSE_FAILED",
      suggestion: "Correct the reported schema issues and try again",
      details: { issues: stableIssues },
      ...(options.correlationId === undefined
        ? {}
        : { correlationId: options.correlationId }),
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });

    this.name = "SchemaParseError";
    this.issues = stableIssues;
  }
}

export function formatZodIssues(
  issues: readonly ZodIssue[],
): SchemaIssue[] {
  return issues.map((issue) => ({
    code: issue.code,
    path: issue.path.map(normalizePathSegment),
    message: issue.message,
  }));
}

export function safeParseSchema<Output, Input = unknown>(
  schema: ZodType<Output, Input>,
  input: unknown,
  options: SchemaParseOptions = {},
): SchemaParseResult<Output> {
  const result = schema.safeParse(input);

  if (result.success) {
    return {
      success: true,
      data: result.data,
    };
  }

  return {
    success: false,
    error: new SchemaParseError(formatZodIssues(result.error.issues), {
      ...options,
      cause: result.error,
    }),
  };
}

export function parseSchema<Output, Input = unknown>(
  schema: ZodType<Output, Input>,
  input: unknown,
  options: SchemaParseOptions = {},
): Output {
  const result = safeParseSchema(schema, input, options);

  if (!result.success) {
    throw result.error;
  }

  return result.data;
}

function normalizePathSegment(segment: PropertyKey): string | number {
  return typeof segment === "number" ? segment : String(segment);
}

function freezeIssues(
  issues: readonly SchemaIssue[],
): readonly SchemaIssue[] {
  return Object.freeze(
    issues.map((issue) =>
      Object.freeze({
        code: issue.code,
        path: Object.freeze([...issue.path]),
        message: issue.message,
      }),
    ),
  );
}
