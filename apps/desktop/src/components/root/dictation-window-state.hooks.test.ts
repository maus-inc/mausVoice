import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  state: {
    activeRecordingMode: null as string | null,
    pendingPillReview: null as object | null,
    unlocked: false,
    entries: [] as string[],
  },
}));
vi.mock("../../store", () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) =>
    selector(mocks.state),
}));
vi.mock("../../utils/user.utils", () => ({
  getIsDictationUnlocked: (state: typeof mocks.state) => state.unlocked,
}));
vi.mock("../../utils/keyboard.utils", () => ({
  getAdditionalLanguageEntries: (state: typeof mocks.state) => state.entries,
}));
import { useDictationWindowState } from "./dictation-window-state.hooks";
it("reads current session, review, unlock and language state", () => {
  expect(useDictationWindowState()).toEqual({
    isActiveSession: false,
    hasPendingReview: false,
    isDictationUnlocked: false,
    additionalLanguageEntries: [],
  });
  mocks.state.activeRecordingMode = "dictate";
  mocks.state.pendingPillReview = {};
  mocks.state.unlocked = true;
  mocks.state.entries = ["fr"];
  expect(useDictationWindowState()).toEqual({
    isActiveSession: true,
    hasPendingReview: true,
    isDictationUnlocked: true,
    additionalLanguageEntries: ["fr"],
  });
});
