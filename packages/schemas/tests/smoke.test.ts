import { describe, expect, it } from "vitest";

import { packageName } from "../src/index";

describe("@scaflow/schemas", () => {
  it("exposes package identity", () => {
    expect(packageName).toBe("@scaflow/schemas");
  });
});
