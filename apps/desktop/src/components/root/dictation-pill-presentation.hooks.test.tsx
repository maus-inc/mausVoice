// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  state: {
    userPrefs: { dictationPillVisibility: "hidden" },
    activeRecordingMode: "agent" as string | null,
    assistantInputMode: "voice",
    pendingPillReview: null as object | null,
    pillConversationId: "conversation",
    chatMessageIdsByConversationId: { conversation: [] as string[] },
    toolPermissionById: {} as Record<
      string,
      { conversationId: string; status: string }
    >,
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../../store", () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) =>
    selector(mocks.state),
}));
vi.mock("../../utils/user.utils", () => ({
  getEffectivePillVisibility: (value: string) => value,
}));
vi.mock("../../utils/feature.utils", () => ({
  getEffectiveStylingMode: () => "manual",
}));
vi.mock("../../utils/tone.utils", () => ({
  getActiveManualToneIds: () => ["one", "two"],
  getManuallySelectedToneId: () => "one",
  getToneById: () => ({ name: "Formal" }),
}));
import { usePillPresentationSync } from "./dictation-pill-presentation.hooks";

beforeEach(() => {
  mocks.invoke.mockClear();
  mocks.state.pendingPillReview = null;
  mocks.state.toolPermissionById = {};
});

it("syncs visibility, compact sizing and style from the main window", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  const Probe = () => {
    usePillPresentationSync(true);
    return null;
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    expect(mocks.invoke).toHaveBeenCalledWith("set_pill_visibility", {
      visibility: "hidden",
    });
    expect(mocks.invoke).toHaveBeenCalledWith("set_pill_window_size", {
      size: "assistant_compact",
    });
    expect(mocks.invoke).toHaveBeenCalledWith("notify_pill_style_info", {
      count: 2,
      name: "Formal",
    });
    mocks.state.toolPermissionById = {
      permission: { conversationId: "conversation", status: "pending" },
    };
    await act(async () => root.render(createElement(Probe)));
    expect(mocks.invoke).toHaveBeenCalledWith("set_pill_window_size", {
      size: "assistant_expanded",
    });
    mocks.state.pendingPillReview = {};
    await act(async () => root.render(createElement(Probe)));
    expect(mocks.invoke).toHaveBeenCalledWith("set_pill_window_size", {
      size: "assistant_typing",
    });
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("does not send pill presentation updates from other windows", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  const Probe = () => {
    usePillPresentationSync(false);
    return null;
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    expect(mocks.invoke).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
