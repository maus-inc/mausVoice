// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsRowDemo } from "./settings";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/**
 * The demo mixes all four row shapes, so mounting it is the check that the real
 * chassis still renders inside the preview surface: the switch rows need the
 * label wrapper, the destructive rows need the tint, and every row must still
 * be anchored.
 */
describe("SettingsRowDemo", () => {
  it("mounts every row shape and keeps the glyph out of the name", () => {
    act(() => {
      root.render(
        <MemoryRouter>
          <SettingsRowDemo />
        </MemoryRouter>,
      );
    });

    // One anchor per row, so the demo exercises the same ids a page does.
    const anchors = [
      "preview_microphone",
      "preview_language",
      "preview_limit",
      "preview_spoken_commands",
      "preview_streaming",
      "preview_clear_data",
      "preview_delete_account",
      "preview_audio_route",
      "preview_usage",
    ];
    for (const key of anchors) {
      expect(container.querySelector(`#setting-${key}`)).not.toBeNull();
    }

    // The glyph lane is the only aria-hidden direct child of a label block, and
    // it is one element per row.
    const glyphs = container.querySelectorAll(
      ".setting-row-label > [aria-hidden='true']",
    );
    expect(glyphs.length).toBe(anchors.length);

    // Switch rows keep the glyph beside their name rather than inside it.
    const spoken = container.querySelector("#setting-preview_spoken_commands");
    const input = spoken?.querySelector("input");
    expect(input?.getAttribute("aria-labelledby")).toBe(
      "setting-preview_spoken_commands-label",
    );
  });
});
