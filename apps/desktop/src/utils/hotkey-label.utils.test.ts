import { describe, expect, it, vi } from "vitest";
import { formatHotkeyLabel } from "./hotkey-label.utils";

describe("formatHotkeyLabel", () => {
  it.each([
    ["MetaLeft", "⌘ L", "⊞ L"],
    ["ControlRight", "⌃ R", "Ctrl R"],
    ["ShiftLeft", "⇧ L", "Shift L"],
    ["AltRight", "⌥ R", "Alt R"],
    ["OptionLeft", "⌥ L", "Alt L"],
    ["Meta", "⌘", "⊞"],
  ])("formats %s for macOS and other platforms", (key, mac, other) => {
    expect(formatHotkeyLabel(key, () => true)).toBe(mac);
    expect(formatHotkeyLabel(key, () => false)).toBe(other);
  });

  it("supports compact preview labels without changing the key mapping", () => {
    expect(formatHotkeyLabel("ControlRight", () => false, false)).toBe("Ctrl");
    expect(formatHotkeyLabel("OptionLeft", () => true, false)).toBe("⌥");
  });

  it("does not query the platform for ordinary keys", () => {
    const isMac = vi.fn();
    expect(formatHotkeyLabel("KeyQ", isMac)).toBe("Q");
    expect(formatHotkeyLabel("LeftArrow", isMac)).toBe("←");
    expect(formatHotkeyLabel("Function", isMac)).toBe("Fn");
    expect(formatHotkeyLabel("Escape", isMac)).toBe("Escape");
    expect(isMac).not.toHaveBeenCalled();
  });
});
