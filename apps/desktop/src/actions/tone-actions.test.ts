import { describe, expect, it, vi } from "vitest";
import { applyWritingStyleSelection, switchWritingStyleForward, switchWritingStyleBackward, selectToneByHotkey } from "../actions/tone.actions";
import { use tone } from "../state/tone.state";

describe("Style switching shares one state transition", () => {
  it("pill forward, arrow forward, and cycle-hotkey forward all land on the next style", async () => {
    await applyWritingStyleSelection("email");
    expect(selectedToneId()).toBe("email");

    await applyWritingStyleSelection({ channel: "arrows", direction: 1 });
    expect(selectedToneId()).toBe("chat");

    await applyWritingStyleSelection({
      channel: "cycle-hotkey",
      direction: 1,
    });
    expect(selectedToneId()).toBe("default");
  });

  it("named cycle/select helpers are aliases of the shared transition", async () => {
    await switchWritingStyleForward();
    expect(selectedToneId()).toBe("email");

    await switchWritingStyleBackward();
    expect(selectedToneId()).toBe("default");

    await selectToneByHotkey("chat");
    expect(selectedToneId()).toBe("chat");
  });
});
