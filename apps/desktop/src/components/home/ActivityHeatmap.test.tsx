// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider, createTheme } from "@mui/material";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntlProvider } from "react-intl";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
import en from "../../i18n/locales/en.json";
import { ActivityHeatmap } from "./ActivityHeatmap";

ensureUiHarness();

describe("ActivityHeatmap", () => {
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

  const renderHeatmap = async (
    wordCount: number,
    status: "success" | "loading" = "success",
  ) => {
    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={en}>
          <ThemeProvider theme={createTheme()}>
            <ActivityHeatmap
              activity={
                wordCount > 0 ? [{ localDate: "2026-10-08", wordCount }] : []
              }
              status={status}
              today={new Date(2026, 9, 8, 12)}
            />
          </ThemeProvider>
        </IntlProvider>,
      );
    });
  };

  it("uses the singular label and accessible summary for one active day", async () => {
    await renderHeatmap(5);

    expect(container.textContent).toContain("1 active day");
    expect(
      container.querySelector('[role="img"]')?.getAttribute("aria-label"),
    ).toBe("Daily word activity: 1 active day and 5 words in the past year.");
  });

  it("does not report zero activity before the initial load completes", async () => {
    await renderHeatmap(0, "loading");

    expect(container.textContent).not.toContain("0 active days");
    expect(
      container.querySelector('[aria-label="Loading daily activity"]'),
    ).not.toBeNull();
  });

  it("uses the plural label and accessible summary when there is no activity", async () => {
    await renderHeatmap(0);

    expect(container.textContent).toContain("0 active days");
    expect(
      container.querySelector('[role="img"]')?.getAttribute("aria-label"),
    ).toBe("Daily word activity: 0 active days and 0 words in the past year.");
    const accessibleList = container.querySelector(
      '[aria-label="Daily word counts"]',
    );
    expect(accessibleList).not.toBeNull();
    expect(window.getComputedStyle(accessibleList!).width).toBe("1px");
    expect(window.getComputedStyle(accessibleList!).height).toBe("1px");
  });
});
