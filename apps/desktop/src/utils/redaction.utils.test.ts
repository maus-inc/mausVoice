import { describe, expect, it } from "vitest";
import { redactError, redactObject, redactString } from "./redaction.utils";

describe("redaction.utils", () => {
  describe("redactString", () => {
    it("returns input unchanged when empty", async () => {
      expect(await redactString("")).toBe("");
    });

    it("returns [redacted] in full mode", async () => {
      expect(await redactString("secret-value", "full")).toBe("[redacted]");
    });

    it("returns a hash in hash mode", async () => {
      const result = await redactString("secret-value", "hash");
      expect(result).toMatch(/^\[hash:[0-9a-f]{8}\]$/);
    });

    it("returns truncated value in truncate mode for long strings", async () => {
      expect(await redactString("secret-value", "truncate")).toBe("se***ue");
    });

    it("returns *** in truncate mode for short strings", async () => {
      expect(await redactString("abc", "truncate")).toBe("***");
    });

    it("defaults to full mode", async () => {
      expect(await redactString("secret-value")).toBe("[redacted]");
    });
  });

  describe("redactError", () => {
    it("redacts secret patterns from error messages", async () => {
      const message = "Failed with key sk-abcdefghijklmnopqrstuvwxyz123456";
      expect(await redactError(message)).toBe(
        "Failed with key [redacted-secret]",
      );
    });

    it("redacts production OpenAI-style keys", async () => {
      const message =
        "Failed with key sk-proj-abcdefghijklmnopqrstuvwxyz1234567890AB";
      expect(await redactError(message)).toBe(
        "Failed with key [redacted-secret]",
      );
    });

    it("redacts production Anthropic-style keys", async () => {
      const message =
        "Failed with key sk-ant-api03-abcdefghijklmnopqrstuvwxyz12";
      expect(await redactError(message)).toBe(
        "Failed with key [redacted-secret]",
      );
    });

    it("handles Error objects", async () => {
      const error = new Error(
        "Token gsk_abcdefghijklmnopqrstuvwxyz123456 invalid",
      );
      expect(await redactError(error)).toBe("Token [redacted-secret] invalid");
    });

    it("returns message unchanged when no secrets present", async () => {
      expect(await redactError("Plain error message")).toBe(
        "Plain error message",
      );
    });
  });

  describe("redactObject", () => {
    it("redacts known sensitive keys", async () => {
      const input = {
        name: "test",
        password: "test-fixture-password",
        apiKey: "test-fixture-api-key",
        nested: { token: "abc123", value: "visible" },
      };
      const result = await redactObject(input);
      expect(result.name).toBe("test");
      expect(result.password).toBe("[redacted]");
      expect(result.apiKey).toBe("[redacted]");
      expect(result.nested).toEqual({ token: "[redacted]", value: "visible" });
    });

    it("redacts explicitly listed sensitive keys", async () => {
      const input = { customField: "secret", other: "visible" };
      const result = await redactObject(input, ["customField"]);
      expect(result.customField).toBe("[redacted]");
      expect(result.other).toBe("visible");
    });

    it("handles non-sensitive values", async () => {
      const input = { count: 42, active: true, name: "test" };
      const result = await redactObject(input);
      expect(result).toEqual(input);
    });

    it("redacts sensitive fields inside nested arrays", async () => {
      const input = {
        items: [
          { name: "a", token: "secret1" },
          { name: "b", token: "secret2" },
        ],
      };
      const result = (await redactObject(input)) as typeof input;
      expect(result.items[0].token).toBe("[redacted]");
      expect(result.items[1].token).toBe("[redacted]");
      expect(result.items[0].name).toBe("a");
    });

    it("preserves non-sensitive string values inside arrays", async () => {
      const input = {
        labels: ["alpha", "beta", "gamma"],
        counts: [1, 2, 3],
      };
      const result = await redactObject(input);
      expect(result.labels).toEqual(["alpha", "beta", "gamma"]);
      expect(result.counts).toEqual([1, 2, 3]);
    });

    it("preserves non-sensitive objects inside arrays", async () => {
      const input = {
        users: [
          { name: "Alice", role: "admin" },
          { name: "Bob", role: "user" },
        ],
      };
      const result = await redactObject(input);
      expect(result.users).toEqual([
        { name: "Alice", role: "admin" },
        { name: "Bob", role: "user" },
      ]);
    });
  });
});
