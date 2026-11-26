// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

import { ThemeProvider } from "@mui/material/styles";
import { requireElement } from "../../../test/helpers/dom";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { theme } from "../../theme";
import {
  SETTING_ENTRIES,
  type SettingHit,
} from "../../utils/settings-registry";
import { SettingGroup, SettingRow } from "./SettingRow";
import { SettingsSearchResults } from "./SettingsSearchResults";

ensureUiHarness();

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** A real registry entry, so the hit is the one search would return. */
const hitFor = (key: string): SettingHit => {
  const entry = SETTING_ENTRIES.find((candidate) => candidate.key === key);
  if (!entry) {
    throw new Error(`No registry entry for ${key}`);
  }
  return {
    entry,
    title: key.replace(/_/g, " "),
    pageTitle: "Dictation",
    groupTitle: "Microphone and feedback",
  };
};

describe("SettingsSearchResults", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = (children: ReactNode) =>
    act(() => {
      root.render(createElement(ThemeProvider, { theme }, children as never));
    });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const renderHits = (hits: SettingHit[]) =>
    render(
      createElement(SettingsSearchResults, {
        hits,
        onSelect: () => undefined,
      }),
    );

  it("draws a result panel as the card a settings group draws", () => {
    render(
      <>
        <SettingsSearchResults
          hits={[hitFor("microphone")]}
          onSelect={() => undefined}
        />
        <SettingGroup title="Reference">
          <SettingRow settingKey="reference" title="Reference" />
        </SettingGroup>
      </>,
    );

    const resultRow = requireElement(
      container.querySelector("button"),
      "the result row",
    );
    const resultCard = requireElement(
      resultRow.parentElement,
      "the result card",
    );
    const groupCard = requireElement(
      container.querySelector("#setting-reference")?.parentElement,
      "the settings card",
    );

    // One card, not two dialects of one. This panel used to be styled by hand
    // with a radius from the large-dialog step, so the same surface changed its
    // shape depending on whether you scrolled to it or searched for it.
    const card = getComputedStyle(resultCard);
    const reference = getComputedStyle(groupCard);
    expect(card.borderRadius).toBe(reference.borderRadius);
    expect(card.borderTopWidth).toBe(reference.borderTopWidth);
    expect(card.boxShadow.replace(/\s+/g, "")).toBe(
      reference.boxShadow.replace(/\s+/g, ""),
    );
  });

  it("starts each page's results on the card's own text column", () => {
    renderHits([hitFor("microphone"), hitFor("audio")]);

    const row = requireElement(
      container.querySelector("button"),
      "the result row",
    );
    const heading = requireElement(
      container.querySelector("h2"),
      "the page heading over the results",
    );
    const headingInset = getComputedStyle(heading).paddingLeft;
    const rowInset = getComputedStyle(row).paddingLeft;

    // The heading sits above the card rather than in it, so it carries the
    // card's inset plus the border the rows sit inside. Without that it
    // started a pixel left of every result under it.
    expect(headingInset).toContain(rowInset);
    expect(headingInset).not.toBe(rowInset);
  });

  it("names each group of results with a heading", () => {
    renderHits([hitFor("microphone")]);

    const heading = requireElement(
      container.querySelector("h2"),
      "the page heading over the results",
    );

    // The search page's own heading is visually hidden, so the page names are
    // what a screen reader moves between: headings, not styled paragraphs.
    expect(heading.tagName).toBe("H2");
    expect(heading.textContent).toBe("Dictation");
  });

  it("says so when nothing matches", () => {
    renderHits([]);

    expect(container.textContent).toContain("Nothing matches that search");
    expect(container.querySelector("h2")).toBeNull();
  });
});
