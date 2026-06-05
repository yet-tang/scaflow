import { describe, expect, it } from "vitest";

import { packageName } from "../src/index";

describe("@scaflow/codex-runtime", () => {
  it("exposes package identity", () => {
    expect(packageName).toBe("@scaflow/codex-runtime");
  });
});
