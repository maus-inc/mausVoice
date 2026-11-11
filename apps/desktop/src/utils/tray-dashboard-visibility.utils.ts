import type { IntlShape } from "react-intl";

export const getLocalizedDashboardMenuLabels = (
  intl: IntlShape,
): { openLabel: string; hideLabel: string } => ({
  openLabel: intl.formatMessage({ defaultMessage: "Open Dashboard" }),
  hideLabel: intl.formatMessage({ defaultMessage: "Hide Dashboard" }),
});
