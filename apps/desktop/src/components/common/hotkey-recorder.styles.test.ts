import { describe, expect, it } from "vitest";
import { hotkeyRecorderStyles } from "./hotkey-recorder.styles";

describe("shared hotkey recorder styles", () => {
  it("keeps idle borders transparent and preserves the requested width", () => {
    expect(hotkeyRecorderStyles(false, 260)).toMatchObject({
      width: 260,
      border: "2px solid transparent",
      animation: "none",
    });
    expect(hotkeyRecorderStyles(false)).toMatchObject({ width: 200 });
  });

  it("keeps a static focused border under reduced motion", () => {
    expect(hotkeyRecorderStyles(true)).toMatchObject({
      border: "2px solid",
      animation: expect.stringContaining("2s ease-in-out infinite"),
      "@media (prefers-reduced-motion: reduce)": {
        animation: "none",
        borderColor: "var(--app-palette-chrome)",
      },
    });
  });
});
