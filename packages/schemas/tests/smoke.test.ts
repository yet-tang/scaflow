import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  SchemaParseError,
  agentResultSchema,
  changeSetStateSchema,
  packageName,
  parseSchema,
  projectConfigSchema,
  repositoryCommandSchema,
  repositoryManifestSchema,
  revisionSetSchema,
  safeParseSchema,
  taskContractSchema,
  taskDefinitionStateSchema,
  taskRunStateSchema,
  z,
  type Infer,
  type ProjectConfig,
  type RepositoryManifest,
  type RevisionSet,
} from "../src/index";

const projectFixtureUrl = new URL(
  "../../../fixtures/projects/",
  import.meta.url,
);

async function readProjectFixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(name, projectFixtureUrl), "utf8"),
  ) as unknown;
}

describe("@scaflow/schemas", () => {
  it("validates a strict Agent Result and rejects malformed nested claims", () => {
    const result = {
      status: "succeeded",
      summary: "Implemented the runtime contract.",
      changed_files: ["packages/codex-runtime/src/index.ts"],
      commands_run: [{ executable: "pnpm", args: ["test"], exit_code: 0 }],
      acceptance_mapping: [
        {
          acceptance_criterion_id: "SFL-019-AC-01",
          evidence: ["runtime tests"],
          satisfied: true,
        },
      ],
      known_limitations: [],
      decision_requests: [],
      risks_detected: [],
    } as const;

    expect(agentResultSchema.parse(result)).toEqual(result);
    expect(
      agentResultSchema.safeParse({
        ...result,
        commands_run: [{ executable: "pnpm", args: "test", exit_code: 0 }],
      }).success,
    ).toBe(false);
    expect(
      agentResultSchema.safeParse({ ...result, untrusted: true }).success,
    ).toBe(false);
    expect(
      agentResultSchema.safeParse({
        ...result,
        risks_detected: [
          { description: "secret value", severity: "unknown", extra: true },
        ],
      }).success,
    ).toBe(false);
  });

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

  it("validates project metadata and an exact pinned engine version", async () => {
    const input = await readProjectFixture("valid-project-config.json");
    const expected: ProjectConfig = {
      version: 1,
      project: {
        id: "beauty-ai",
        name: "Beauty AI",
      },
      engine: {
        version: "0.1.0",
      },
    };

    expect(parseSchema(projectConfigSchema, input)).toEqual(expected);
    expect(
      projectConfigSchema.safeParse({
        ...expected,
        engine: { version: "1.2.3-123abc.1+build.7" },
      }).success,
    ).toBe(true);
  });

  it.each([
    [
      "invalid-missing-project-name.json",
      ["project", "name"],
      "invalid_type",
    ],
    [
      "invalid-empty-project-id.json",
      ["project", "id"],
      "too_small",
    ],
    [
      "invalid-malformed-engine-version.json",
      ["engine", "version"],
      "invalid_format",
    ],
    [
      "invalid-engine-version-range.json",
      ["engine", "version"],
      "invalid_format",
    ],
    ["invalid-unknown-field.json", [], "unrecognized_keys"],
  ])(
    "returns structured errors for %s",
    async (fixtureName, expectedPath, expectedCode) => {
      const input = await readProjectFixture(fixtureName);
      const result = safeParseSchema(projectConfigSchema, input);

      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("Expected project config parsing to fail");
      }

      expect(result.error).toBeInstanceOf(SchemaParseError);
      expect(result.error).toMatchObject({
        code: "SCHEMA_PARSE_FAILED",
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: expectedCode,
            path: expectedPath,
          }),
        ]),
      });
    },
  );

  it("rejects unsupported nested fields", () => {
    const result = safeParseSchema(projectConfigSchema, {
      version: 1,
      project: {
        id: "beauty-ai",
        name: "Beauty AI",
        owner: "platform",
      },
      engine: {
        version: "0.1.0",
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected project config parsing to fail");
    }

    expect(result.error.issues).toEqual([
      expect.objectContaining({
        code: "unrecognized_keys",
        path: ["project"],
      }),
    ]);
  });

  it.each(["", "latest", "1.x", ">=1.0.0", "1.0.0 || 2.0.0"])(
    "rejects non-exact engine version %j",
    (version) => {
      const result = safeParseSchema(projectConfigSchema, {
        version: 1,
        project: {
          id: "beauty-ai",
          name: "Beauty AI",
        },
        engine: { version },
      });

      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("Expected project config parsing to fail");
      }

      expect(result.error.issues).toEqual([
        expect.objectContaining({
          code: "invalid_format",
          path: ["engine", "version"],
        }),
      ]);
    },
  );

  it("validates a strict repository manifest and its public type", async () => {
    const input = await readProjectFixture("valid-repositories.json");
    const manifest = parseSchema(repositoryManifestSchema, input);
    const typedManifest: RepositoryManifest = manifest;

    expect(typedManifest).toEqual(input);
    expect(typedManifest.repositories.map(({ id }) => id)).toEqual([
      "web",
      "api",
    ]);
  });

  it.each([
    [
      "invalid-repositories-duplicate-id.json",
      ["repositories", 1, "id"],
    ],
    [
      "invalid-repositories-traversal.json",
      ["repositories", 0, "checkout_directory"],
    ],
    [
      "invalid-repositories-missing-dependency.json",
      ["repositories", 0, "dependencies", 0],
    ],
  ])(
    "returns structured repository manifest errors for %s",
    async (fixtureName, expectedPath) => {
      const result = safeParseSchema(
        repositoryManifestSchema,
        await readProjectFixture(fixtureName),
      );

      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("Expected repository manifest parsing to fail");
      }

      expect(result.error).toBeInstanceOf(SchemaParseError);
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "custom",
            path: expectedPath,
          }),
        ]),
      );
    },
  );

  it.each([
    "@control",
    "@application",
  ])("rejects reserved repository ID %j", (id) => {
    const result = repositoryManifestSchema.safeParse({
      version: 1,
      repositories: [
        {
          ...validRepository(),
          id,
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          code: "custom",
          path: ["repositories", 0, "id"],
        }),
      ]);
    }
  });

  it.each([
    "/absolute/api",
    "C:\\work\\api",
    "C:api",
    "\\\\server\\share\\api",
    "..\\api",
    "apps/../../api",
    "",
  ])("rejects unsafe checkout directory %j", (checkoutDirectory) => {
    const result = repositoryManifestSchema.safeParse({
      version: 1,
      repositories: [
        {
          ...validRepository(),
          checkout_directory: checkoutDirectory,
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["repositories", 0, "checkout_directory"],
          }),
        ]),
      );
    }
  });

  it.each([
    ["apps/api", "apps/./api"],
    ["apps/api", "apps//api"],
    ["apps/api", "apps\\api"],
    ["apps/api", "apps/api/"],
    ["apps/api", "apps/api///"],
    ["apps/api", "apps\\api\\\\"],
  ])(
    "rejects normalized-equivalent checkout directories %j and %j",
    (firstCheckout, secondCheckout) => {
      const result = repositoryManifestSchema.safeParse({
        version: 1,
        repositories: [
          validRepository({ checkout_directory: firstCheckout }),
          validRepository({
            id: "worker",
            checkout_directory: secondCheckout,
          }),
        ],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual([
          expect.objectContaining({
            code: "custom",
            path: ["repositories", 1, "checkout_directory"],
          }),
        ]);
      }
    },
  );

  it("requires all repository fields and rejects unknown fields", () => {
    const missingName = validRepository() as Record<string, unknown>;
    delete missingName.name;

    const result = repositoryManifestSchema.safeParse({
      version: 1,
      repositories: [
        {
          ...missingName,
          owner: "platform",
        },
      ],
      metadata: {},
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "invalid_type",
            path: ["repositories", 0, "name"],
          }),
          expect.objectContaining({
            code: "unrecognized_keys",
            path: ["repositories", 0],
          }),
          expect.objectContaining({
            code: "unrecognized_keys",
            path: [],
          }),
        ]),
      );
    }
  });

  it("accepts only structured repository commands", () => {
    expect(
      repositoryCommandSchema.safeParse({
        executable: "pnpm",
        args: ["test"],
        timeout_seconds: 300,
        required: true,
      }).success,
    ).toBe(true);

    for (const command of [
      "pnpm test",
      {
        executable: "",
        args: ["test"],
        timeout_seconds: 300,
        required: true,
      },
      {
        executable: "pnpm",
        args: "test",
        timeout_seconds: 300,
        required: true,
      },
      {
        executable: "pnpm",
        args: ["test"],
        timeout_seconds: 0,
        required: true,
      },
      {
        executable: "pnpm",
        args: ["test"],
        timeout_seconds: 300,
        required: true,
        shell: true,
      },
    ]) {
      expect(repositoryCommandSchema.safeParse(command).success).toBe(false);
    }
  });

  it("validates a strict Revision Set with fixed commits and access modes", () => {
    const revisionSet: RevisionSet = {
      version: 1,
      control: {
        id: "@control",
        base_commit: "a".repeat(40),
        access: "read-write",
        default_branch: "main",
        checkout_directory: ".",
        identity: {
          remote: "origin",
          expected_url: "git@example.invalid:project/control.git",
          actual_url: "git@example.invalid:project/control.git",
        },
      },
      repositories: [
        {
          id: "web",
          base_commit: "b".repeat(40),
          access: "read-only",
          default_branch: "main",
          checkout_directory: "web",
          identity: {
            remote: "origin",
            expected_url: "git@example.invalid:project/web.git",
            actual_url: "git@example.invalid:project/web.git",
          },
        },
      ],
    };

    expect(parseSchema(revisionSetSchema, revisionSet)).toEqual(revisionSet);
  });

  it("rejects malformed Revision Set commits and reserved application repository IDs", () => {
    const result = safeParseSchema(revisionSetSchema, {
      version: 1,
      control: {
        id: "@control",
        base_commit: "main",
        access: "read-write",
        default_branch: "main",
        checkout_directory: ".",
        identity: {
          remote: "origin",
          expected_url: "git@example.invalid:project/control.git",
          actual_url: "git@example.invalid:project/control.git",
        },
      },
      repositories: [
        {
          id: "@control",
          base_commit: "b".repeat(40),
          access: "read-only",
          default_branch: "main",
          checkout_directory: "web",
          identity: {
            remote: "origin",
            expected_url: "git@example.invalid:project/web.git",
            actual_url: "git@example.invalid:project/web.git",
          },
        },
        {
          id: "@control",
          base_commit: "c".repeat(40),
          access: "read-write",
          default_branch: "main",
          checkout_directory: "api",
          identity: {
            remote: "origin",
            expected_url: "git@example.invalid:project/api.git",
            actual_url: "git@example.invalid:project/api.git",
          },
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["control", "base_commit"],
          }),
          expect.objectContaining({
            path: ["repositories", 0, "id"],
          }),
          expect.objectContaining({
            path: ["repositories", 1, "id"],
          }),
        ]),
      );
    }
  });

  it("rejects duplicate Revision Set application repositories", () => {
    const result = safeParseSchema(revisionSetSchema, {
      version: 1,
      control: {
        id: "@control",
        base_commit: "a".repeat(40),
        access: "read-write",
        default_branch: "main",
        checkout_directory: ".",
        identity: {
          remote: "origin",
          expected_url: "git@example.invalid:project/control.git",
          actual_url: "git@example.invalid:project/control.git",
        },
      },
      repositories: [
        {
          id: "web",
          base_commit: "b".repeat(40),
          access: "read-only",
          default_branch: "main",
          checkout_directory: "web",
          identity: {
            remote: "origin",
            expected_url: "git@example.invalid:project/web.git",
            actual_url: "git@example.invalid:project/web.git",
          },
        },
        {
          id: "web",
          base_commit: "c".repeat(40),
          access: "read-write",
          default_branch: "main",
          checkout_directory: "web-admin",
          identity: {
            remote: "origin",
            expected_url: "git@example.invalid:project/web-admin.git",
            actual_url: "git@example.invalid:project/web-admin.git",
          },
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          code: "custom",
          path: ["repositories", 1, "id"],
        }),
      ]);
    }
  });

  it("validates a strict Task Contract v1 and its public type", () => {
    const contract = validTaskContract();

    expect(parseSchema(taskContractSchema, contract)).toEqual(contract);
  });

  it("rejects read-write Task Contract scopes with empty allowed paths", () => {
    const result = safeParseSchema(taskContractSchema, {
      ...validTaskContract(),
      repositories: {
        primary: "@control",
        scopes: [
          {
            repository: "@control",
            access: "read-write",
            allowed_paths: [],
          },
        ],
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          code: "custom",
          path: ["repositories", "scopes", 0, "allowed_paths"],
        }),
      ]);
    }
  });

  it("allows read-only Task Contract scopes without write paths", () => {
    const result = safeParseSchema(taskContractSchema, {
      ...validTaskContract(),
      repositories: {
        primary: "api",
        scopes: [
          {
            repository: "api",
            access: "read-only",
            allowed_paths: [],
          },
        ],
      },
      verification: {
        commands: [
          {
            repository: "api",
            executable: "pnpm",
            args: ["test"],
            timeout_seconds: 300,
            required: true,
          },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects undeclared and reserved-looking Task Contract repository references", () => {
    const result = safeParseSchema(taskContractSchema, {
      ...validTaskContract(),
      repositories: {
        primary: "@control",
        scopes: [
          {
            repository: "@control",
            access: "read-write",
            allowed_paths: ["packages/schemas/**"],
          },
          {
            repository: "@shadow",
            access: "read-only",
          },
        ],
      },
      verification: {
        commands: [
          {
            repository: "api",
            executable: "pnpm",
            args: ["test"],
            timeout_seconds: 300,
            required: true,
          },
        ],
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "custom",
            path: ["repositories", "scopes", 1, "repository"],
          }),
          expect.objectContaining({
            code: "custom",
            path: ["verification", "commands", 0, "repository"],
          }),
        ]),
      );
    }
  });

  it("rejects Task Contract primary repositories not declared in scopes", () => {
    const result = safeParseSchema(taskContractSchema, {
      ...validTaskContract(),
      repositories: {
        primary: "api",
        scopes: [
          {
            repository: "@control",
            access: "read-write",
            allowed_paths: ["packages/schemas/**"],
          },
        ],
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          code: "custom",
          path: ["repositories", "primary"],
        }),
      ]);
    }
  });

  it("rejects unknown Task Contract fields and shell-string commands", () => {
    const result = safeParseSchema(taskContractSchema, {
      ...validTaskContract(),
      task: {
        id: "SFL-999",
        title: "Task Contract",
        type: "schema",
        risk_level: "R2",
        definition_state: "ready",
        owner: "platform",
      },
      verification: {
        commands: ["pnpm test"],
      },
      metadata: {},
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "unrecognized_keys",
            path: ["task"],
          }),
          expect.objectContaining({
            code: "invalid_type",
            path: ["verification", "commands", 0],
          }),
          expect.objectContaining({
            code: "unrecognized_keys",
            path: [],
          }),
        ]),
      );
    }
  });
});

function validRepository(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "api",
    name: "API",
    git_url: "https://github.com/example/api.git",
    default_branch: "main",
    checkout_directory: "apps/api",
    type: "service",
    ...overrides,
  };
}

function validTaskContract(): Record<string, unknown> {
  return {
    version: 1,
    task: {
      id: "SFL-999",
      title: "Task Contract",
      type: "schema",
      risk_level: "R2",
      definition_state: "ready",
    },
    objective: {
      summary: "Implement Task Contract schema.",
    },
    source_requirements: [
      {
        id: "FR-005",
        document: "docs/source/scaflow-v0.1.0-prd.md",
      },
    ],
    source_references: [
      {
        document: "docs/exec-plans/scaflow-v0.1.0.md",
        section: "Task Contract Schema v1",
      },
    ],
    dependencies: ["SFL-003"],
    dependency_changes: "forbidden",
    repositories: {
      primary: "@control",
      scopes: [
        {
          repository: "@control",
          access: "read-write",
          allowed_paths: ["packages/schemas/**"],
          forbidden_paths: ["workspace/**", ".scaflow/**"],
        },
      ],
    },
    acceptance_criteria: [
      {
        id: "SFL-999-AC-01",
        description: "Task Contract schema validates contract fields.",
      },
    ],
    verification: {
      commands: [
        {
          repository: "@control",
          executable: "pnpm",
          args: ["--filter", "@scaflow/schemas", "test"],
          timeout_seconds: 300,
          required: true,
        },
      ],
    },
    retry_policy: {
      max_attempts: 2,
      max_repair_rounds_per_attempt: 3,
      escalate_after_same_failure: 2,
    },
  };
}
