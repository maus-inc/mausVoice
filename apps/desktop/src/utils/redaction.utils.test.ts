import { describe, expect, it } from "vitest";
import { redactError, redactObject, redactString } from "./redaction.utils";

describe("redaction.utils", () => {
  describe("redactString", () => {
    it("returns input unchanged when empty", () => {
      expect(redactString("")).toBe("");
    });

    it("returns [redacted] in full mode", () => {
      expect(redactString("secret-value", "full")).toBe("[redacted]");
    });

    it("returns a hash in hash mode", () => {
      const result = redactString("secret-value", "hash");
      expect(result).toMatch(/^\[hash:[0-9a-f]{1,8}\]$/);
    });

    it("returns truncated value in truncate mode for long strings", () => {
      expect(redactString("secret-value", "truncate")).toBe("se***ue");
    });

    it("returns *** in truncate mode for short strings", () => {
      expect(redactString("abc", "truncate")).toBe("***");
    });

    it("defaults to full mode", () => {
      expect(redactString("secret-value")).toBe("[redacted]");
    });
  });

  describe("redactError", () => {
    it("redacts secret patterns from error messages", () => {
      const message = "Failed with key sk-abcdefghijklmnopqrstuvwxyz123456";
      expect(redactError(message)).toBe("Failed with key [redacted-secret]");
    });

    it("handles Error objects", () => {
      const error = new Error(
        "Token gsk_abcdefghijklmnopqrstuvwxyz123456 invalid",
      );
      expect(redactError(error)).toBe("Token [redacted-secret] invalid");
    });

    it("returns message unchanged when no secrets present", () => {
      expect(redactError("Plain error message")).toBe("Plain error message");
    });
  });

  describe("redactObject", () => {
    it("redacts known sensitive keys", () => {
      const input = {
        name: "test",
        password: "test-password-value",
        apiKey: "test-api-key-value",
        nested: { token: "test-token-value", value: "visible" },
      };
      const result = redactObject(input);
      expect(result.name).toBe("test");
      expect(result.password).toBe("[redacted]");
      expect(result.apiKey).toBe("[redacted]");
      expect(result.nested).toEqual({ token: "[redacted]", value: "visible" });
    });

    it("redacts explicitly listed sensitive keys", () => {
      const input = { customField: "secret", other: "visible" };
      const result = redactObject(input, ["customField"]);
      expect(result.customField).toBe("[redacted]");
      expect(result.other).toBe("visible");
    });

    it("handles non-sensitive values", () => {
      const input = { count: 42, active: true, name: "test" };
      const result = redactObject(input);
      expect(result).toEqual(input);
    });

    it("redacts sensitive fields inside nested arrays", () => {
      const input = {
        items: [
          { name: "a", token: "secret1" },
          { name: "b", token: "secret2" },
        ],
      };
      const result = redactObject(input) as typeof input;
      expect(result.items[0].token).toBe("[redacted]");
      expect(result.items[1].token).toBe("[redacted]");
      expect(result.items[0].name).toBe("a");
    });
  });
});
