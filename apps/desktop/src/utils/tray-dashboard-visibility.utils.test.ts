import type { IntlShape } from "react-intl";
import { describe, expect, it, vi } from "vitest";
import { getLocalizedDashboardMenuLabels } from "./tray-dashboard-visibility.utils";

describe("getLocalizedDashboardMenuLabels", () => {
  it("resolves both dashboard actions through i18n", () => {
    const formatMessage = vi.fn(
      ({ defaultMessage }) => `localized:${defaultMessage}`,
    );
    const intl = { formatMessage } as unknown as IntlShape;

    expect(getLocalizedDashboardMenuLabels(intl)).toEqual({
      openLabel: "localized:Open Dashboard",
      hideLabel: "localized:Hide Dashboard",
    });
    expect(formatMessage).toHaveBeenCalledTimes(2);
  });
});
