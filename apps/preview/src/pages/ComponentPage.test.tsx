import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpecProvider } from "../lib/spec-store";
import { ComponentPage } from "./ComponentPage";

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

const renderEntry = (id: string) => {
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[`/c/${id}`]}>
        <SpecProvider>
          <Routes>
            <Route path="/c/:id" element={<ComponentPage />} />
          </Routes>
        </SpecProvider>
      </MemoryRouter>,
    );
  });
};

const chipByText = (text: string) =>
  Array.from(container.querySelectorAll(".MuiChip-root")).find(
    (el) => el.textContent === text,
  );

/**
 * The reused/recreated chip renders one fact (entry.status) two ways: a label
 * and a colour. Both must come from the same row of the badge table, so a
 * reused entry can never render the recreated colour, and vice versa.
 */
describe("ComponentPage status badge", () => {
  it("labels and colours a reused entry from the reused row", () => {
    renderEntry("button");
    const chip = chipByText("reused \u00b7 real component");
    expect(chip).toBeDefined();
    expect(chip?.className).toContain("MuiChip-colorSuccess");
    expect(chip?.className).not.toContain("MuiChip-colorWarning");
  });

  it("labels and colours a recreated entry from the recreated row", () => {
    renderEntry("hotkey-badge");
    const chip = chipByText("recreated \u00b7 pixel spec");
    expect(chip).toBeDefined();
    expect(chip?.className).toContain("MuiChip-colorWarning");
    expect(chip?.className).not.toContain("MuiChip-colorSuccess");
  });

  it("shows the unknown-component route instead of a badge", () => {
    renderEntry("not-a-real-component");
    expect(container.textContent).toContain("Unknown component");
    expect(chipByText("reused \u00b7 real component")).toBeUndefined();
    expect(chipByText("recreated \u00b7 pixel spec")).toBeUndefined();
  });
});
