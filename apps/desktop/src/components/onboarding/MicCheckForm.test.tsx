// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import {
  beginLocalDataClear,
  LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY,
} from "../../utils/local-data-write-gate";
import { resetNativeRecordingSession } from "../../utils/native-recording-session";
import { MicCheckForm } from "./MicCheckForm";

const { invoke, state } = vi.hoisted(() => ({
  invoke:
    vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  state: {
    onboarding: { preferredMicrophone: "first", didSignUpWithAccount: false },
    overlayPhase: "idle",
    audioLevels: [0.5],
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));
vi.mock("../../store", () => ({
  getAppState: () => state,
  produceAppState: vi.fn(),
  useAppStore: (select: (s: typeof state) => unknown) => select(state),
}));
vi.mock("../../actions/onboarding.actions", () => ({
  goToOnboardingPage: vi.fn(),
  setOnboardingPreferredMicrophone: vi.fn(),
}));
vi.mock("../../utils/analytics.utils", () => ({ trackButtonClick: vi.fn() }));
vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({ warning: vi.fn(), verbose: vi.fn() }),
}));
vi.mock("../common/AudioWaveform", () => ({ AudioWaveform: () => null }));
vi.mock("../microphone/MicrophoneSelector", () => ({
  MicrophoneSelector: () => null,
}));
vi.mock("./OnboardingCommon", () => ({
  BackButton: () => null,
  DualPaneLayout: ({ left }: { left: ReactNode }) => left,
  OnboardingFormLayout: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("react-intl", () => ({
  FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) =>
    defaultMessage,
}));

ensureUiHarness();
let root: Root;
const flush = (action: () => void) =>
  act(() => {
    action();
    return Promise.resolve();
  });
const render = () =>
  flush(() => {
    root.render(
      <StrictMode>
        <MicCheckForm />
      </StrictMode>,
    );
  });

beforeEach(() => {
  resetNativeRecordingSession();
  invoke.mockReset();
  state.overlayPhase = "idle";
  state.onboarding.preferredMicrophone = "first";
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await flush(() => root.unmount());
});

describe("Mic Check capture ownership", () => {
  it("discards only its late admission without opening after unmount", async () => {
    let admit!: (generation: number) => void;
    invoke.mockImplementation((cmd) =>
      cmd === "recording_generation"
        ? new Promise<number>((resolve) => {
            admit = resolve;
          })
        : Promise.resolve(),
    );
    await render();
    const owner = invoke.mock.calls[0]?.[1]?.ownerId;
    expect(typeof owner).toBe("string");
    await flush(() => root.render(null));
    await flush(() => admit(7));
    expect(invoke.mock.calls).toEqual([
      ["recording_generation", { ownerId: owner }],
      ["discard_recording", { ownerId: owner, generation: 7 }],
    ]);
    expect(state.audioLevels).toEqual([0.5]);
  });

  it("invalidates pending admission as soon as local-data clear is requested", async () => {
    let admit!: (generation: number) => void;
    invoke.mockImplementation((cmd) =>
      cmd === "recording_generation"
        ? new Promise<number>((resolve) => {
            admit = resolve;
          })
        : Promise.resolve(),
    );
    await render();
    const owner = invoke.mock.calls[0]?.[1]?.ownerId;
    await act(async () => {
      const clearing = beginLocalDataClear();
      admit(3);
      const release = await clearing;
      localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
      release();
    });
    expect(invoke.mock.calls).toEqual([
      ["recording_generation", { ownerId: owner }],
      ["discard_recording", { ownerId: owner, generation: 3 }],
    ]);
  });
});
