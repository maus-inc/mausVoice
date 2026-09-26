import { describe, expect, it } from "vitest";
import {
  isKeyRejectedStatus,
  readProviderStatus,
} from "./provider-status.utils";

describe("readProviderStatus", () => {
  it("reads a numeric status from an SDK error", () => {
    expect(
      readProviderStatus(Object.assign(new Error("x"), { status: 429 })),
    ).toBe(429);
  });

  it.each([null, undefined, "401", new Error("x"), { status: "401" }])(
    "returns undefined without a numeric status (%s)",
    (error) => {
      expect(readProviderStatus(error)).toBeUndefined();
    },
  );
});

describe("isKeyRejectedStatus", () => {
  it.each([401, 402, 403])("treats %i as key-wide", (status) => {
    expect(isKeyRejectedStatus(status)).toBe(true);
  });

  it.each([undefined, 400, 404, 429, 500])(
    "treats %s as model-specific or transient",
    (status) => {
      expect(isKeyRejectedStatus(status)).toBe(false);
    },
  );
});
