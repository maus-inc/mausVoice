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

    it("returns a deterministic SHA-256 prefix in hash mode", async () => {
      expect(await redactString("secret-value", "hash")).toBe(
        "[hash:31160254]",
      );
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
    const secretPatternCases = [
      {
        key: "OpenAI sk-",
        message: "Failed with key sk-abcdefghijklmnopqrstuvwxyz123456",
        expected: "Failed with key [redacted-secret]",
      },
      {
        key: "OpenAI sk-proj-",
        message:
          "Failed with key sk-proj-abcdefghijklmnopqrstuvwxyz1234567890AB",
        expected: "Failed with key [redacted-secret]",
      },
      {
        key: "Anthropic sk-ant-",
        message: "Failed with key sk-ant-api03-abcdefghijklmnopqrstuvwxyz12",
        expected: "Failed with key [redacted-secret]",
      },
      {
        key: "Groq gsk_",
        message: "Token gsk_abcdefghijklmnopqrstuvwxyz123456 invalid",
        expected: "Token [redacted-secret] invalid",
      },
    ];

    it.each(secretPatternCases)(
      "redacts $key style keys from error messages",
      async ({ message, expected }) => {
        expect(await redactError(message)).toBe(expected);
      },
    );

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

    it("redacts secret values embedded in bare array strings", async () => {
      const input = {
        tokens: ["sk-abcdefghijklmnopqrstuvwxyz123456", "visible-token"],
      };
      const result = (await redactObject(input)) as typeof input;
      expect(result.tokens[0]).toBe("[redacted-secret]");
      expect(result.tokens[1]).toBe("visible-token");
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
