// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, setAppState } from "../../store";
import { DAILY_ACTIVITY_CHANGED_EVENT } from "../../utils/daily-activity.events";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn<() => Promise<void>>(),
  listActivity: vi.fn(),
  listTranscriptions: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("../../actions/user.actions", () => ({
  refreshCurrentUser: mocks.refresh,
}));
vi.mock("../../repos", () => ({
  getDailyActivityRepo: () => ({ listDailyActivity: mocks.listActivity }),
  getTranscriptionRepo: () => ({
    listTranscriptions: mocks.listTranscriptions,
  }),
}));
vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({ warning: mocks.warning }),
}));

import { HomeSideEffects } from "./HomeSideEffects";
import { getActivityDateRange } from "../../utils/activity-grid.utils";

ensureUiHarness();

describe("HomeSideEffects daily activity refresh", () => {
  let container: HTMLDivElement;
  let root: Root;

  const today = new Date(2026, 9, 8, 12);

  const mount = async (activityDate = today) => {
    act(() => {
      root.render(<HomeSideEffects today={activityDate} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refresh.mockResolvedValue();
    mocks.listTranscriptions.mockResolvedValue([]);
    mocks.listActivity.mockResolvedValue([
      { localDate: "2026-10-08", wordCount: 42 },
    ]);
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("loads the visible local-date range and stores the returned totals", async () => {
    await mount();

    const range = getActivityDateRange(today);
    expect(mocks.listActivity).toHaveBeenCalledWith(
      range.startDate,
      range.endDate,
    );
    expect(getAppState().home.dailyActivity).toEqual([
      { localDate: "2026-10-08", wordCount: 42 },
    ]);
    expect(getAppState().home.dailyActivityStatus).toBe("success");
  });

  it("refreshes activity when the dashboard is focused or a usage event commits", async () => {
    await mount();
    mocks.listActivity.mockClear();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.listActivity).toHaveBeenCalledTimes(1);

    mocks.listActivity.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event(DAILY_ACTIVITY_CHANGED_EVENT));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.listActivity).toHaveBeenCalledTimes(1);
  });

  it("loads the new local date range when midnight advances the date", async () => {
    await mount();
    mocks.listActivity.mockClear();
    const nextDay = new Date(2026, 9, 9, 12);

    await act(async () => {
      root.render(<HomeSideEffects today={nextDay} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const range = getActivityDateRange(nextDay);
    expect(mocks.listActivity).toHaveBeenCalledTimes(1);
    expect(mocks.listActivity).toHaveBeenCalledWith(
      range.startDate,
      range.endDate,
    );
  });

  it("keeps a failed activity load visible without discarding the page", async () => {
    mocks.listActivity.mockRejectedValueOnce(new Error("database unavailable"));

    await mount();

    expect(getAppState().home.dailyActivityStatus).toBe("error");
    expect(mocks.warning).toHaveBeenCalledWith(
      expect.stringContaining("Failed to load daily activity"),
    );
  });
});
