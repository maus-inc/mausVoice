import { describe, expect, it } from "vitest";
import { format } from "./formatjs-formatter.mjs";

const descriptors = (messages) =>
  Object.fromEntries(
    messages.map((defaultMessage, i) => [String(i), { defaultMessage }]),
  );

describe("catalog message IDs", () => {
  it("keeps repeated identical messages", () => {
    expect(format(descriptors(["Run preview", "Run preview"]))).toEqual({
      run_preview: "Run preview",
    });
  });

  it.each([
    [
      "No text-generation provider is configured, so the preview cannot run.",
      "No text-generation provider is configured, so the preview cannot run. You can still create this style now; the preview unlocks after provider setup.",
    ],
    [
      "Choose different writing styles to change how you sound. While dictating, press {hotkey} to cycle between them.",
      "Choose different writing styles to change how you sound. While dictating, press {backwardHotkey} or {forwardHotkey} to cycle between them.",
    ],
  ])(
    "rejects truncated IDs that would overwrite distinct messages",
    (first, second) => {
      expect(() => format(descriptors([first, second]))).toThrow(
        /Message ID collision/,
      );
    },
  );

  it("does not confuse object prototype keys with prior messages", () => {
    expect(format(descriptors(["Constructor"]))).toEqual({
      constructor: "Constructor",
    });
  });
});
