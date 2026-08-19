import { describe, expect, it } from "vitest";
import { getDashboardMenuLabel } from "./tray-dashboard-visibility.utils";

describe("getDashboardMenuLabel", () => {
  it("offers to hide when the dashboard is visible", () => {
    expect(getDashboardMenuLabel(true)).toBe("Hide Dashboard");
  });

  it("offers to open when the dashboard is hidden or minimized", () => {
    expect(getDashboardMenuLabel(false)).toBe("Open Dashboard");
  });
});
