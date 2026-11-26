// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsRowDemo } from "./settings";

let container: HTMLDivElement;
let root: Root;

/**
 * The accessible name of a control, assembled the way a screen reader does.
 *
 * jsdom implements no accessibility tree, so the name is resolved from the
 * attributes this chassis actually uses: `aria-labelledby` first, refs then
 * their text, then `aria-label`, then the element's own text. It is a small
 * resolver on purpose; the claim under test is that the name a person hears is
 * the title and not the mark beside it.
 */
const nameOf = (element: Element): string => {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .join(" ");
  }
  return (
    element.getAttribute("aria-label") ?? element.textContent?.trim() ?? ""
  );
};

const requireSwitch = (name: string): Element => {
  const match = Array.from(container.querySelectorAll("[role='switch']")).find(
    (element) => nameOf(element) === name,
  );
  if (!match) {
    throw new Error(
      `No switch named "${name}" among: ${Array.from(
        container.querySelectorAll("[role='switch']"),
      )
        .map((element) => JSON.stringify(nameOf(element)))
        .join(", ")}`,
    );
  }
  return match;
};

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

    // Switch rows keep the glyph beside their name rather than inside it. The
    // switch is found by its role and the name a person hears, not by the id
    // attribute alone: an `aria-labelledby` pointing at a missing or empty
    // element passes an id comparison and still announces nothing.
    const spoken = requireSwitch("Spoken commands");
    expect(spoken.getAttribute("aria-labelledby")).toBe(
      "setting-preview_spoken_commands-label",
    );

    // The name is real text, and the glyph beside it contributes nothing to it:
    // the description says nothing about a microphone, so a glyph that leaked
    // into the name would show up here.
    const name = nameOf(spoken);
    expect(name).toBe("Spoken commands");
    // The row's own description does not leak into the name either.
    expect(name).not.toContain("Turns phrases");
    expect(nameOf(requireSwitch("Real-time output"))).toBe("Real-time output");
  });
});
