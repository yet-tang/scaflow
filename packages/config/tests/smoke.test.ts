import { describe, expect, it } from "vitest";

import { packageName } from "../src/index";

describe("@scaflow/config", () => {
  it("exposes package identity", () => {
    expect(packageName).toBe("@scaflow/config");
  });
});
