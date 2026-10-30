// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sectionAnchorId,
  sectionFromScrollTop,
  SettingsSectionNav,
} from "./SettingsSectionNav";
import { SETTING_SECTIONS } from "../../utils/settings-registry";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

// Supply build-time IDs while exercising real Intl formatting and catalogs.
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

ensureUiHarness();

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (child: ReactNode) =>
  act(() => {
    root.render(createElement(IntlProvider, { locale: "en" }, child));
  });

/** The rail entry with this visible label, or undefined when absent. */
const railButton = (label: string) =>
  Array.from(container.querySelectorAll("button")).find(
    (node) => node.textContent === label,
  );

const requireRailButton = (label: string) => {
  const button = railButton(label);
  if (!button) throw new Error(`No rail entry labelled "${label}"`);
  return button;
};

/** A spy, so an unused `onSelect` still records that it was never called. */
const noop = () => vi.fn();

describe("sectionFromScrollTop", () => {
  const tops = [
    ["general", 100],
    ["dictation", 400],
    ["updates", 900],
  ] as const;

  it("returns nothing above the first section", () => {
    expect(sectionFromScrollTop(tops, 0)).toBeNull();
  });

  it("returns the section the reader is inside", () => {
    expect(sectionFromScrollTop(tops, 100)).toBe("general");
    expect(sectionFromScrollTop(tops, 399)).toBe("general");
  });

  it("advances when the next section reaches the top", () => {
    expect(sectionFromScrollTop(tops, 400)).toBe("dictation");
    expect(sectionFromScrollTop(tops, 901)).toBe("updates");
  });

  it("keeps the last section selected past the end of the page", () => {
    expect(sectionFromScrollTop(tops, 99999)).toBe("updates");
  });

  it("returns nothing when no section has been laid out", () => {
    expect(
      sectionFromScrollTop(
        [
          ["general", Number.POSITIVE_INFINITY],
          ["dictation", Number.POSITIVE_INFINITY],
        ],
        0,
      ),
    ).toBeNull();
  });
});

describe("SettingsSectionNav", () => {
  it("lists every registry section, so one cannot exist in the registry and be missing from the rail", () => {
    render(
      createElement(SettingsSectionNav, { active: null, onSelect: noop() }),
    );
    const labels = Array.from(container.querySelectorAll("button")).map(
      (node) => node.textContent,
    );
    expect(labels).toHaveLength(SETTING_SECTIONS.length);
  });

  it("points each entry at the anchor the settings page already renders", () => {
    // The page wraps each section in Box#section-*. The rail must scroll to
    // those same nodes, not to a second set of targets.
    expect(sectionAnchorId("ai-processing")).toBe("section-ai-processing");
    expect(sectionAnchorId("advanced")).toBe("section-advanced");
  });

  it("reports the clicked section", () => {
    const onSelect = vi.fn();
    render(createElement(SettingsSectionNav, { active: null, onSelect }));
    act(() => {
      requireRailButton("Updates").click();
    });
    expect(onSelect).toHaveBeenCalledWith("updates");
  });

  it("marks only the active section as current", () => {
    render(
      createElement(SettingsSectionNav, {
        active: "privacy-data",
        onSelect: noop(),
      }),
    );
    const current = Array.from(container.querySelectorAll("button")).filter(
      (node) => node.getAttribute("aria-current") === "true",
    );
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe("Privacy and data");
  });

  it("exposes the rail as navigation with an accessible name", () => {
    render(
      createElement(SettingsSectionNav, { active: null, onSelect: noop() }),
    );
    const nav = container.querySelector("nav");
    expect(nav?.getAttribute("aria-label")).toBe("Settings sections");
  });
});
