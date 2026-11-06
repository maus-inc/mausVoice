import { describe, expect, it } from "vitest";
import { getAllWindows, getCurrentWindow, Window } from "./window";

describe("preview window transport", () => {
  it("exposes the window constructor for the current and enumerated windows", async () => {
    const current = getCurrentWindow();
    expect(current).toBeInstanceOf(Window);
    expect(await getAllWindows()).toEqual([current]);
    expect(current.label).toBe("preview");
  });
});
