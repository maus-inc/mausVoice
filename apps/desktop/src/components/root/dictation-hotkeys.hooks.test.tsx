// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import type { ActivationController } from "../../utils/activation.utils";

const mocks = vi.hoisted(() => ({
  state: {
    activeRecordingMode: "dictate" as string | null,
    keysHeld: ["Fn"],
    userPrefs: { inDictationStyleSwitchingEnabled: true },
  },
  holds: [] as Array<{
    actionName: string;
    isDisabled: boolean;
    allowedAdditionalKeys?: string[];
  }>,
  fires: [] as Array<{ actionName: string; isDisabled: boolean }>,
  tone: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../store", () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) =>
    selector(mocks.state),
}));
vi.mock("../../hooks/hotkey.hooks", () => ({
  useHotkeyFire: (args: (typeof mocks.fires)[number]) => mocks.fires.push(args),
  useHotkeyFireMany: () => undefined,
  useHotkeyHold: (args: (typeof mocks.holds)[number]) => mocks.holds.push(args),
  useHotkeyHoldMany: () => undefined,
}));
vi.mock("../../actions/tone.actions", () => ({
  applyInDictationStyleSwitch: mocks.tone,
}));
vi.mock("../../utils/feature.utils", () => ({
  getEffectiveStylingMode: () => "manual",
}));
vi.mock("../../utils/assistant-mode.utils", () => ({
  getIsAssistantModeEnabled: () => true,
}));
vi.mock("../../utils/keyboard.utils", () => ({
  DICTATE_HOTKEY: "dictate",
  AGENT_DICTATE_HOTKEY: "agent",
  CANCEL_TRANSCRIPTION_HOTKEY: "cancel",
  SWITCH_WRITING_STYLE_FORWARD_HOTKEY: "forward",
  SWITCH_WRITING_STYLE_BACKWARD_HOTKEY: "backward",
  getHotkeyCombosForAction: () => [["Fn"]],
  getSwitchToStyleEntries: () => [],
}));
import { useDictationHotkeys } from "./dictation-hotkeys.hooks";

beforeEach(() => {
  mocks.state.activeRecordingMode = "dictate";
  mocks.state.keysHeld = ["Fn"];
  mocks.holds = [];
  mocks.fires = [];
  mocks.tone.mockClear();
});
const props = {
  isMainWindow: true,
  isDictationInteractable: true,
  isDictationUnlocked: true,
  dictationController: {} as ActivationController,
  agentController: {} as ActivationController,
  additionalLanguageControllers: [],
  promptCancelTranscription: vi.fn(),
};

it("allows style arrows only during active manual dictation and switches once per new press", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  const Probe = () => {
    useDictationHotkeys(props);
    return null;
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    expect(mocks.holds.find((h) => h.actionName === "dictate")).toMatchObject({
      isDisabled: false,
      allowedAdditionalKeys: ["LeftArrow", "RightArrow"],
    });
    expect(mocks.holds.find((h) => h.actionName === "agent")?.isDisabled).toBe(
      true,
    );
    mocks.state.keysHeld = ["Fn", "RightArrow"];
    await act(async () => root.render(createElement(Probe)));
    expect(mocks.tone).toHaveBeenCalledExactlyOnceWith({
      channel: "arrows",
      direction: 1,
    });
    await act(async () => root.render(createElement(Probe)));
    expect(mocks.tone).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("disables both activation paths outside the main window", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  const Probe = () => {
    useDictationHotkeys({ ...props, isMainWindow: false });
    return null;
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    expect(mocks.holds.every((hold) => hold.isDisabled)).toBe(true);
    expect(mocks.fires.every((fire) => fire.isDisabled)).toBe(true);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
