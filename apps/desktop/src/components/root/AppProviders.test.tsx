// @vitest-environment jsdom
import { useTheme } from "@mui/material/styles";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useIntl } from "react-intl";
import { describe, expect, it } from "vitest";
import { AppProviders } from "./AppProviders";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ProviderConsumer = () => {
  const intl = useIntl();
  const theme = useTheme();
  return <div data-theme={Boolean(theme.vars)}>{intl.locale}</div>;
};

describe("AppProviders", () => {
  it("supplies localization and the shared CSS-variable theme to children", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <AppProviders>
            <ProviderConsumer />
          </AppProviders>,
        );
      });
      const child = container.querySelector("[data-theme]");
      expect(child?.getAttribute("data-theme")).toBe("true");
      expect(child?.textContent).toBeTruthy();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
