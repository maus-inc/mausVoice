// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyWordActivity } from "../../repos/daily-activity.repo";
import { requestDailyActivityRefresh } from "../../utils/daily-activity.events";
import { getActivityDateRange } from "../../utils/activity-grid.utils";
import type { HomeActivityState } from "./home.types";

const {
  listActivityMock,
  listTranscriptionsMock,
  refreshUserMock,
  loggerMock,
} = vi.hoisted(() => ({
  listActivityMock: vi.fn(),
  listTranscriptionsMock: vi.fn(() => Promise.resolve([])),
  refreshUserMock: vi.fn(() => Promise.resolve()),
  loggerMock: { warning: vi.fn() },
}));

vi.mock("../../actions/user.actions", () => ({
  refreshCurrentUser: refreshUserMock,
}));

vi.mock("../../repos", () => ({
  getDailyActivityRepo: () => ({
    listDailyWordActivity: (...args: unknown[]) => listActivityMock(...args),
  }),
  getTranscriptionRepo: () => ({
    listTranscriptions: () => listTranscriptionsMock(),
  }),
}));

vi.mock("../../utils/log.utils", () => ({ getLogger: () => loggerMock }));

import { HomeSideEffects } from "./HomeSideEffects";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

ensureUiHarness();

const initialState = (): HomeActivityState => ({
  status: "loading",
  records: [],
  ...getActivityDateRange(),
  hasLoaded: false,
});

let container: HTMLDivElement;
let root: Root;

const ActivityStateProbe = () => {
  const [state, setState] = useState(initialState);
  return createElement(
    "div",
    null,
    createElement(HomeSideEffects, { onActivityChange: setState }),
    createElement(
      "output",
      { "data-testid": "activity-state" },
      `${state.status}:${state.records.map((record) => record.wordCount).join(",")}`,
    ),
  );
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

beforeEach(() => {
  vi.clearAllMocks();
  listTranscriptionsMock.mockResolvedValue([]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("HomeSideEffects activity freshness", () => {
  it("ignores an older response when a newer refresh completes first", async () => {
    const older = deferred<DailyWordActivity[]>();
    const newer = deferred<DailyWordActivity[]>();
    listActivityMock
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    await act(async () => {
      root.render(createElement(ActivityStateProbe));
      await Promise.resolve();
    });
    expect(listActivityMock).toHaveBeenCalledTimes(1);

    act(() => requestDailyActivityRefresh());
    expect(listActivityMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      newer.resolve([{ localDate: "2026-10-06", wordCount: 22 }]);
      await newer.promise;
    });
    expect(container.querySelector("output")?.textContent).toBe("ready:22");

    await act(async () => {
      older.resolve([{ localDate: "2026-10-05", wordCount: 7 }]);
      await older.promise;
    });
    expect(container.querySelector("output")?.textContent).toBe("ready:22");
  });
});
