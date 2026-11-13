// @vitest-environment jsdom
import { ThemeProvider } from "@mui/material";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { theme } from "../../theme";
import { KeepReadySection } from "./KeepReadySection";

// The real formatter, with the ids the build injects: the assertions below are
// about locale-specific *output*, so a mock that returns `defaultMessage` would
// test nothing.
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

let root: Root | null = null;
let container: HTMLDivElement;

const render = async (locale: string) => {
  await act(() => {
    root!.render(
      createElement(
        IntlProvider,
        { locale, messages: {} },
        createElement(
          ThemeProvider,
          { theme },
          createElement(KeepReadySection, {
            keepReady: false,
            heldState: "idle" as never,
            bluetoothWarning: false,
            prerollSeconds: 1.5,
            prerollOn: true,
            prerollLabel: "How much speech to keep",
            onKeepReadyChange: vi.fn(),
            onPrerollCommit: vi.fn(),
          }),
        ),
      ),
    );
  });
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root?.unmount());
  container.remove();
  root = null;
});

describe("the pre-roll value label", () => {
  it("writes the decimal separator German uses", async () => {
    // `toFixed(1)` writes "1.5" in every locale. German writes "1,5", so a
    // translated unit around an unlocalized number read as an English sentence
    // with German words -- the unit was fixed and the number was not, which is
    // exactly the half-fix CodeRabbit caught.
    await render("de");

    expect(container.textContent).toContain("1,5");
    expect(container.textContent).not.toContain("1.5");
  });

  it("keeps the point for English", async () => {
    // The other direction: localizing must not force a comma everywhere.
    await render("en");

    expect(container.textContent).toContain("1.5");
  });
});
