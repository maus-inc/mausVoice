// @vitest-environment jsdom
import { ThemeProvider } from "@mui/material";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { theme } from "../../theme";
import { LingerSection } from "./LingerSection";

// Descriptors carry only `defaultMessage` until the formatjs babel plugin injects
// ids at build time, so real react-intl throws in jsdom. This variant keeps the
// real formatter and adds the ids the build would have added -- the message under
// test interpolates `{duration}`, and a mock that dropped `values` would let the
// assertion pass on a message the user never sees.
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

let root: Root | null = null;
let container: HTMLDivElement;

const text = () => container.textContent ?? "";

const secondsFormat = (milliseconds: number) => `${milliseconds / 1000}s`;

const render = async (lingerMs: number) => {
  await act(() => {
    root!.render(
      createElement(
        IntlProvider,
        { locale: "en", messages: {} },
        createElement(
          ThemeProvider,
          { theme },
          createElement(LingerSection, {
            keepReady: false,
            lingerOn: true,
            lingerMs,
            lingerLabel: "How long to stay open",
            secondsFormat,
            onLingerChange: vi.fn(),
            onDurationChange: vi.fn(),
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

describe("the linger window control", () => {
  it("names the stored window when it is not one of the offered ones", async () => {
    // The finding: a stored 30 s window showed "15s" selected while the
    // microphone stayed open for 30 s. The control cannot offer 30 s, but it must
    // not report 15 s as if that were the setting -- the user would have no way
    // to know why the indicator stayed lit twice as long.
    await render(30_000);

    expect(text()).toContain("30s");
    expect(text()).toContain("not one of these");
  });

  it("says nothing extra when the stored window is offered", async () => {
    // Otherwise every ordinary profile carries a note about a non-problem, and
    // the note stops meaning "something here is not what it looks like".
    await render(5_000);

    expect(text()).not.toContain("not one of these");
  });

  it("still selects the closest offered window", async () => {
    // The note explains the selection; it must not replace it.
    await render(30_000);

    expect(text()).toContain("15s");
  });
});
