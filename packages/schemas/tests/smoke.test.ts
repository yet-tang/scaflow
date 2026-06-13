import { describe, expect, it } from "vitest";

import {
  SchemaParseError,
  changeSetStateSchema,
  packageName,
  parseSchema,
  safeParseSchema,
  taskDefinitionStateSchema,
  taskRunStateSchema,
  z,
  type Infer,
} from "../src/index";

describe("@scaflow/schemas", () => {
  it("exposes package identity", () => {
    expect(packageName).toBe("@scaflow/schemas");
  });

  it("centralizes public schemas, inferred types, and successful parsing", () => {
    const userSchema = z.object({
      id: z.string().uuid(),
      roles: z.array(z.enum(["admin", "viewer"])),
    });
    type User = Infer<typeof userSchema>;

    const input: unknown = {
      id: "21e2f0d2-bec8-4ce9-8428-2ba040502bbc",
      roles: ["admin"],
    };
    const expected: User = input as User;

    expect(parseSchema(userSchema, input)).toEqual(expected);
    expect(safeParseSchema(userSchema, input)).toEqual({
      success: true,
      data: expected,
    });
  });

  it("returns deterministic nested and multi-issue validation errors", () => {
    const schema = z.object({
      profile: z.object({
        email: z.string().email(),
        tags: z.array(z.string().min(3)),
      }),
    });

    const result = safeParseSchema(
      schema,
      {
        profile: {
          email: "invalid",
          tags: ["x", "valid", ""],
        },
      },
      { correlationId: "schema-test-123" },
    );

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected schema parsing to fail");
    }

    expect(result.error).toBeInstanceOf(SchemaParseError);
    expect(result.error).toMatchObject({
      name: "SchemaParseError",
      code: "SCHEMA_PARSE_FAILED",
      recoverable: false,
      correlationId: "schema-test-123",
      issues: [
        {
          code: "invalid_format",
          path: ["profile", "email"],
          message: "Invalid email address",
        },
        {
          code: "too_small",
          path: ["profile", "tags", 0],
          message: "Too small: expected string to have >=3 characters",
        },
        {
          code: "too_small",
          path: ["profile", "tags", 2],
          message: "Too small: expected string to have >=3 characters",
        },
      ],
    });
    expect(result.error.details).toEqual({ issues: result.error.issues });
    expect(Object.isFrozen(result.error.issues)).toBe(true);
    expect(Object.isFrozen(result.error.issues[0]?.path)).toBe(true);
    expect(result.error.toJSON()).toMatchObject({
      name: "ScaflowError",
      code: "SCHEMA_PARSE_FAILED",
      recoverable: false,
      correlationId: "schema-test-123",
      details: { issues: result.error.issues },
    });
  });

  it("throws the same typed structured error from parseSchema", () => {
    expect(() => parseSchema(z.number().int().positive(), -1)).toThrowError(
      SchemaParseError,
    );

    try {
      parseSchema(z.number().int().positive(), -1);
    } catch (caught) {
      expect(caught).toMatchObject({
        code: "SCHEMA_PARSE_FAILED",
        issues: [
          {
            code: "too_small",
            path: [],
            message: "Too small: expected number to be >0",
          },
        ],
      });
    }
  });

  it("defines separate state schemas with the exact PRD literals", () => {
    expect(taskDefinitionStateSchema.options).toEqual([
      "draft",
      "ready",
      "cancelled",
      "completed",
    ]);
    expect(taskRunStateSchema.options).toEqual([
      "queued",
      "preparing",
      "running",
      "verifying",
      "repairing",
      "succeeded",
      "failed",
      "blocked",
      "cancelled",
      "orphaned",
    ]);
    expect(changeSetStateSchema.options).toEqual([
      "draft",
      "verified",
      "published",
      "partially_merged",
      "merged",
      "failed",
      "cancelled",
      "rolled_back",
    ]);

    expect(taskDefinitionStateSchema.safeParse("running").success).toBe(false);
    expect(taskRunStateSchema.safeParse("verified").success).toBe(false);
    expect(changeSetStateSchema.safeParse("ready").success).toBe(false);
  });
});
