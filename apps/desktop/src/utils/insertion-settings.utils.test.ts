import { describe, expect, it } from "vitest";
import { resolveLocalInsertionSettings } from "./insertion-settings.utils";

describe("resolveLocalInsertionSettings", () => {
  it("defaults to paste and accepts unknown insertion methods as paste", () => {
    expect(resolveLocalInsertionSettings(null, null, false)).toEqual({
      method: "paste",
      keybind: null,
    });
    expect(
      resolveLocalInsertionSettings({ insertionMethod: "legacy" }, null, false),
    ).toEqual({ method: "paste", keybind: null });
  });
  it("lets app settings override global insertion and speed, including zero", () => {
    expect(
      resolveLocalInsertionSettings(
        { insertionMethod: "type", typingSpeedMs: 0 },
        { insertionMethod: "paste", typingSpeedMs: 7 },
        false,
      ),
    ).toEqual({ method: "type", delayMs: 0 });
    expect(
      resolveLocalInsertionSettings(null, { insertionMethod: "type" }, false),
    ).toEqual({ method: "type", delayMs: 5 });
  });
  it("uses global paste keybinds on global-only platforms and app overrides elsewhere", () => {
    const app = { pasteKeybind: "app" };
    const prefs = { pasteKeybind: "global" };
    expect(resolveLocalInsertionSettings(app, prefs, true)).toEqual({
      method: "paste",
      keybind: "global",
    });
    expect(resolveLocalInsertionSettings(app, prefs, false)).toEqual({
      method: "paste",
      keybind: "app",
    });
    expect(
      resolveLocalInsertionSettings({ pasteKeybind: null }, prefs, false),
    ).toEqual({ method: "paste", keybind: "global" });
    expect(
      resolveLocalInsertionSettings({ pasteKeybind: "" }, prefs, false),
    ).toEqual({ method: "paste", keybind: "" });
  });
});
