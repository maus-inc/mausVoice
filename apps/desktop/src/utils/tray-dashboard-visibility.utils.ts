import type { IntlShape } from "react-intl";

export type TrayDashboardMenuLabel = "Open Dashboard" | "Hide Dashboard";

export const getDashboardMenuLabel = (
  isVisible: boolean,
): TrayDashboardMenuLabel => (isVisible ? "Hide Dashboard" : "Open Dashboard");

export const getLocalizedDashboardMenuLabels = (
  intl: IntlShape,
): { openLabel: string; hideLabel: string } => ({
  openLabel: intl.formatMessage({ defaultMessage: "Open Dashboard" }),
  hideLabel: intl.formatMessage({ defaultMessage: "Hide Dashboard" }),
});
