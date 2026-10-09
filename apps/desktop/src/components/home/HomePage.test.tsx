// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@maus-inc/types";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import en from "../../i18n/locales/en.json";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, setAppState } from "../../store";
import { LOCAL_USER_ID } from "../../utils/user.utils";
import { toLocalMonthKey } from "../../utils/date.utils";

vi.mock("./HomeSideEffects", () => ({ HomeSideEffects: () => null }));
vi.mock("./GettingStartedList", () => ({ GettingStartedList: () => null }));
vi.mock("../common/DictationInstruction", () => ({
  DictationInstruction: () => null,
}));
vi.mock("../transcriptions/TranscriptRow", () => ({
  TranscriptionRow: () => null,
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import HomePage from "./HomePage";

ensureUiHarness();

const previewUser: User = {
  id: LOCAL_USER_ID,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
  name: "Morgan Lee",
  bio: null,
  onboarded: true,
  playInteractionChime: true,
  hasFinishedTutorial: true,
  wordsThisMonth: 12_340,
  wordsThisMonthMonth: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`,
  wordsTotal: 84_120,
  streak: 7,
  streakRecordedAt: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}`,
};

describe("HomePage analytics", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    const state = structuredClone(INITIAL_APP_STATE);
    state.initialized = true;
    state.auth = {
      uid: LOCAL_USER_ID,
      email: "preview@mausvoice.local",
      displayName: previewUser.name,
      providers: ["preview"],
    };
    state.userById[LOCAL_USER_ID] = previewUser;
    state.home.dailyActivity = [{ localDate: "2026-10-08", wordCount: 324 }];
    state.home.dailyActivityStatus = "success";
    state.transcriptions.transcriptionIds = ["recent-one", "recent-two"];
    setAppState(state, true);

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("renders a wide dashboard with current word metrics and the activity heatmap", async () => {
    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={en}>
          <MemoryRouter initialEntries={["/dashboard"]}>
            <HomePage />
          </MemoryRouter>
        </IntlProvider>,
      );
    });

    expect(container.textContent).toContain("Welcome back, Morgan");
    expect(container.textContent).toContain("Words this month");
    expect(container.textContent).toContain("12,340");
    expect(container.textContent).toContain("Words total");
    expect(container.textContent).toContain("84,120");
    expect(container.textContent).toContain("Daily activity");
    expect(container.textContent).toContain(
      "Words dictated over the past year",
    );
    expect(
      container.querySelector('[data-testid="home-activity-heatmap"]'),
    ).toBeTruthy();
    expect(
      container.querySelector(
        '[role="img"][aria-label*="Daily word activity"]',
      ),
    ).toBeTruthy();
    expect(
      container.querySelectorAll('[aria-label="Daily word counts"] li').length,
    ).toBeGreaterThan(300);
    expect(container.querySelector(".MuiContainer-maxWidthXl")).toBeTruthy();
    expect(container.textContent).not.toMatch(/on-screen key/i);
    expect(getAppState().home.dailyActivity).toEqual([
      { localDate: "2026-10-08", wordCount: 324 },
    ]);
  });

  it("does not show a previous month's cached total as current usage", async () => {
    const previousMonth = new Date();
    previousMonth.setDate(1);
    previousMonth.setMonth(previousMonth.getMonth() - 1);
    const state = structuredClone(getAppState());
    state.userById[LOCAL_USER_ID] = {
      ...previewUser,
      wordsThisMonth: 12_340,
      wordsThisMonthMonth: toLocalMonthKey(previousMonth),
    };
    setAppState(state, true);

    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={en}>
          <MemoryRouter initialEntries={["/dashboard"]}>
            <HomePage />
          </MemoryRouter>
        </IntlProvider>,
      );
    });

    const cards = container.querySelectorAll(".MuiCard-root");
    expect(cards[1]?.textContent).toContain("0");
    expect(cards[1]?.textContent).not.toContain("12,340");
  });
});
