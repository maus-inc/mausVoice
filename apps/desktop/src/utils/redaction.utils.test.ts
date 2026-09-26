import { describe, expect, expectTypeOf, it } from "vitest";
import {
  redactError,
  redactObject,
  redactObjectSync,
  redactString,
  redactStringSync,
  type SyncRedactionMode,
} from "./redaction.utils";

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
        message: `Failed with key ${"sk"}-${"abcdefghijklmnopqrstuvwxyz123456"}`,
        expected: "Failed with key [redacted-secret]",
      },
      {
        key: "OpenAI sk-proj-",
        message: `Failed with key ${"sk"}-${"proj"}-${"abcdefghijklmnopqrstuvwxyz1234567890AB"}`,
        expected: "Failed with key [redacted-secret]",
      },
      {
        key: "Anthropic sk-ant-",
        message: `Failed with key ${"sk"}-${"ant"}-api03-${"abcdefghijklmnopqrstuvwxyz12"}`,
        expected: "Failed with key [redacted-secret]",
      },
      {
        key: "Groq gsk_",
        message: "Token " + "gsk_" + "abcdefghijklmnopqrstuvwxyz123456 invalid",
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
        password: ["mock", "pass"].join("-"),
        apiKey: ["mock", "key"].join("-"),
        nested: { token: ["mock", "tok"].join("-"), value: "visible" },
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
        notes: [
          `${"sk"}-${"abcdefghijklmnopqrstuvwxyz123456"}`,
          "visible-note",
        ],
      };
      const result = (await redactObject(input)) as typeof input;
      expect(result.notes[0]).toBe("[redacted-secret]");
      expect(result.notes[1]).toBe("visible-note");
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

    it("redacts consecutive token-like keys without stateful misses", async () => {
      const result = await redactObject({
        accessToken: "aaa",
        refreshToken: "bbb",
        idToken: "ccc",
      });
      expect(result.accessToken).toBe("[redacted]");
      expect(result.refreshToken).toBe("[redacted]");
      expect(result.idToken).toBe("[redacted]");
    });

    it("redacts plural token keys and key-id credential names", async () => {
      const result = await redactObject({
        tokens: ["aaa", "bbb"],
        accessTokens: "Bearer xyz",
        accessKey: "AKIA" + "IOSFODNN7EXAMPLE",
        keyId: "key-id-value",
        session_key: "session-value",
      });
      expect(result.tokens).toEqual(["[redacted]", "[redacted]"]);
      expect(result.accessTokens).toBe("[redacted]");
      expect(result.accessKey).toBe("[redacted]");
      expect(result.keyId).toBe("[redacted]");
      expect(result.session_key).toBe("[redacted]");
    });

    it("leaves lookalike non-credential keys visible", async () => {
      const result = await redactObject({
        monkey: "banana",
        keyboard: "qwerty",
      });
      expect(result.monkey).toBe("banana");
      expect(result.keyboard).toBe("qwerty");
    });

    it("fully redacts nested arrays under sensitive keys", async () => {
      const result = (await redactObject({ passwords: [["foo"]] })) as {
        passwords: unknown;
      };
      expect(result.passwords).toEqual([["[redacted]"]]);
    });

    it("fully redacts objects nested under sensitive keys", async () => {
      const result = (await redactObject({
        auth: [{ note: "Bearer opaque" }],
      })) as { auth: Array<{ note: string }> };
      expect(result.auth[0].note).toBe("[redacted]");
    });

    it("replaces circular references instead of overflowing", async () => {
      const input: Record<string, unknown> = { name: "ok" };
      input.self = input;
      const result = await redactObject(input);
      expect(result.name).toBe("ok");
      expect(result.self).toBe("[circular]");
    });

    it("replaces circular arrays", async () => {
      const loop: unknown[] = [];
      loop.push(loop);
      const result = (await redactObject({ items: loop })) as {
        items: unknown[];
      };
      expect(result.items).toEqual(["[circular]"]);
    });

    it("redacts a shared array referenced by sibling branches", async () => {
      const shared = ["Bearer opaque"];
      const result = (await redactObject(
        { items: [shared, shared] },
        [],
        true,
      )) as {
        items: string[][];
      };
      expect(result.items).toEqual([["[redacted]"], ["[redacted]"]]);
    });
  });

  describe("redactObjectSync", () => {
    it("redacts a sensitive key nested in an object", () => {
      expect(
        redactObjectSync({ name: "ok", config: { apiKey: "opaque" } }),
      ).toEqual({
        name: "ok",
        config: { apiKey: "[redacted]" },
      });
    });

    it("redacts sensitive keys inside an array of objects", () => {
      expect(
        redactObjectSync({
          rows: [{ token: "a", keep: "x" }, { token: "b" }],
        }),
      ).toEqual({
        rows: [{ token: "[redacted]", keep: "x" }, { token: "[redacted]" }],
      });
    });

    it("terminates on a cycle", () => {
      const input: Record<string, unknown> = { name: "ok" };
      input.self = input;
      expect(redactObjectSync(input)).toEqual({
        name: "ok",
        self: "[circular]",
      });
    });

    it("redacts a sensitive key at depth", () => {
      expect(
        redactObjectSync({
          a: { b: { c: { d: { secret: "opaque", keep: "x" } } } },
        }),
      ).toEqual({
        a: { b: { c: { d: { secret: "[redacted]", keep: "x" } } } },
      });
    });

    it("offers only the modes a synchronous call can produce", () => {
      expectTypeOf<SyncRedactionMode>().toEqualTypeOf<"full" | "truncate">();
      expect(redactStringSync("secret-value")).toBe("[redacted]");
      expect(redactStringSync("secret-value", "truncate")).toBe("se***ue");
    });
  });

  it("keeps a parsed __proto__ property as data without changing the output prototype", async () => {
    const input = JSON.parse(
      '{"__proto__":{"secret":"hidden","visible":"kept"},"name":"ok"}',
    );
    const result = await redactObject(input);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      ["__proto__"]: { secret: "[redacted]", visible: "kept" },
      name: "ok",
    });
  });

  it("marks the first ancestor reference through an array as circular", async () => {
    let visits = 0;
    // Bound a regression's traversal instead of letting a broken guard exhaust the heap.
    const input = new Proxy<Record<string, unknown>>(
      { name: "ok" },
      {
        ownKeys(target) {
          if (++visits > 8) throw new Error("cycle traversal budget exceeded");
          return Reflect.ownKeys(target);
        },
      },
    );
    input.items = [input];
    input.self = input;
    expect(await redactObject(input)).toEqual({
      name: "ok",
      items: ["[circular]"],
      self: "[circular]",
    });
  });

  it("redacts shared objects in sibling arrays without treating them as cycles", async () => {
    const shared = { password: "hidden", name: "ok" };
    expect(await redactObject({ first: [shared], second: [shared] })).toEqual({
      first: [{ password: "[redacted]", name: "ok" }],
      second: [{ password: "[redacted]", name: "ok" }],
    });
  });
});
