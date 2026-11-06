// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  discard: vi.fn(),
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: (command: string, args?: Record<string, unknown>) =>
    command === "recording_generation"
      ? Promise.resolve(0)
      : command === "discard_recording"
        ? mocks.discard(command, args)
        : command === "stop_recording"
          ? mocks.stop(command, args)
          : mocks.start(command, args),
}));
vi.mock("../common/AudioWaveform", () => ({ AudioWaveform: () => null }));
import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, produceAppState, setAppState } from "../../store";
import { MicrophoneTester } from "./MicrophoneTester";

ensureUiHarness();
let root: Root;
let container: HTMLDivElement;
let unmounted: boolean;
const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  if (!found) throw new Error(`Missing ${label} button`);
  return found;
};
const render = async () =>
  act(async () => root.render(<MicrophoneTester preferredMicrophone="usb" />));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.start.mockResolvedValue({ sampleRate: 16000 });
  mocks.stop.mockResolvedValue({
    samples: new Float32Array(0),
    sampleRate: 16000,
  });
  mocks.discard.mockResolvedValue(undefined);
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  unmounted = false;
});
afterEach(() => {
  if (!unmounted) act(() => root.unmount());
  container.remove();
});

it("starts the chosen microphone and reports an empty recording", async () => {
  await render();
  await act(async () => button("Record").click());
  expect(mocks.start).toHaveBeenCalledWith("start_recording", {
    args: { preferredMicrophone: "usb" },
    ownerId: expect.any(String),
    generation: 0,
  });
  await act(async () => button("Finish").click());
  expect(mocks.stop).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("We didn't detect any audio.");
  expect(button("Play").disabled).toBe(true);
});

it("does not start a microphone test while dictation is paused", async () => {
  act(() =>
    produceAppState((draft) => {
      draft.overlayPhase = "paused";
    }),
  );
  await render();
  expect(button("Record").disabled).toBe(true);
  expect(container.textContent).toContain(
    "You cannot start a microphone test while a transcription is in progress.",
  );
  expect(mocks.start).not.toHaveBeenCalled();
});

it("does not submit two starts before React commits the loading state", async () => {
  let finish!: (result: { sampleRate: number }) => void;
  mocks.start.mockReturnValue(
    new Promise<{ sampleRate: number }>((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  act(() => {
    button("Record").click();
    button("Record").click();
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(mocks.start).toHaveBeenCalledOnce();
  await act(async () => {
    finish({ sampleRate: 16000 });
  });
});

it("does not submit two stops before React commits the stopping state", async () => {
  let finish!: (response: {
    samples: Float32Array;
    sampleRate: number;
  }) => void;
  mocks.stop.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  await act(async () => button("Record").click());
  act(() => {
    button("Finish").click();
    button("Finish").click();
  });
  expect(mocks.stop).toHaveBeenCalledOnce();
  await act(async () => {
    finish({ samples: new Float32Array(0), sampleRate: 16000 });
  });
});

it("stops only its own capture when unmounted during a pending start", async () => {
  let finishStart!: (result: { sampleRate: number }) => void;
  mocks.start.mockReturnValue(
    new Promise<{ sampleRate: number }>((resolve) => {
      finishStart = resolve;
    }),
  );
  await render();
  await act(async () => {
    button("Record").click();
    await Promise.resolve();
  });
  const ownerId = mocks.start.mock.calls[0][1].ownerId;
  act(() => {
    root.unmount();
    unmounted = true;
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(mocks.discard).toHaveBeenCalledWith("discard_recording", {
    ownerId,
    generation: expect.any(Number),
  });
  expect(mocks.stop).not.toHaveBeenCalled();
  await act(async () => finishStart({ sampleRate: 16000 }));
});

it("does not create a preview after a pending stop outlives the component", async () => {
  let finish!: (response: {
    samples: Float32Array;
    sampleRate: number;
  }) => void;
  mocks.stop.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const originalCreate = URL.createObjectURL;
  const create = vi.fn(() => "blob:orphan");
  URL.createObjectURL = create;
  try {
    await render();
    await act(async () => button("Record").click());
    act(() => button("Finish").click());
    act(() => {
      root.unmount();
      unmounted = true;
    });
    await act(async () =>
      finish({ samples: new Float32Array([0.25]), sampleRate: 16000 }),
    );
    expect(create).not.toHaveBeenCalled();
  } finally {
    URL.createObjectURL = originalCreate;
  }
});

it("does not clear a newer dictation's audio levels when a test stop settles", async () => {
  let finish!: (response: {
    samples: Float32Array;
    sampleRate: number;
  }) => void;
  mocks.stop.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  await act(async () => button("Record").click());
  act(() => button("Finish").click());
  act(() =>
    produceAppState((draft) => {
      draft.overlayPhase = "recording";
      draft.audioLevels = [0.75];
    }),
  );
  await act(async () =>
    finish({ samples: new Float32Array(0), sampleRate: 16000 }),
  );
  expect(getAppState().audioLevels).toEqual([0.75]);
});

it("allows retrying after starting fails", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    mocks.start.mockRejectedValueOnce(new Error("unavailable"));
    await render();
    await act(async () => button("Record").click());
    expect(container.textContent).toContain("Unable to start microphone test.");
    await act(async () => button("Record").click());
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(button("Finish")).toBeTruthy();
  } finally {
    error.mockRestore();
  }
});

it("creates a preview for captured audio and revokes it on unmount", async () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const create = vi.fn(() => "blob:microphone-test");
  const revoke = vi.fn();
  URL.createObjectURL = create;
  URL.revokeObjectURL = revoke;
  const pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(() => {});
  const play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockResolvedValue(undefined);
  try {
    mocks.stop.mockResolvedValue({
      samples: new Float32Array([0.25, -0.25]),
      sampleRate: 16000,
    });
    await render();
    await act(async () => button("Record").click());
    await act(async () => button("Finish").click());
    expect(create).toHaveBeenCalledOnce();
    expect(button("Play").disabled).toBe(false);
    await act(async () => button("Play").click());
    expect(play).toHaveBeenCalledOnce();
    expect(button("Pause")).toBeTruthy();
    act(() => {
      root.unmount();
      unmounted = true;
    });
    expect(revoke).toHaveBeenCalledWith("blob:microphone-test");
    expect(pause).toHaveBeenCalled();
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    play.mockRestore();
    pause.mockRestore();
  }
});

it("warns that a failed capture preview is incomplete", async () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn(() => "blob:partial");
  URL.revokeObjectURL = vi.fn();
  const pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(() => {});
  try {
    mocks.stop.mockResolvedValue({
      samples: new Float32Array([0.25]),
      sampleRate: 16000,
      captureFailed: true,
    });
    await render();
    await act(async () => button("Record").click());
    await act(async () => button("Finish").click());
    expect(container.textContent).toContain("The preview may be incomplete.");
    expect(button("Play").disabled).toBe(false);
    act(() => {
      root.unmount();
      unmounted = true;
    });
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    pause.mockRestore();
  }
});

it("ignores a preview playback failure after its recording was replaced", async () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn(() => "blob:stale-preview");
  URL.revokeObjectURL = vi.fn();
  const pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(() => {});
  let reject!: (reason: Error) => void;
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockReturnValue(
    new Promise<void>((_, rejectPromise) => {
      reject = rejectPromise;
    }),
  );
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    mocks.stop.mockResolvedValue({
      samples: new Float32Array([0.25]),
      sampleRate: 16000,
    });
    await render();
    await act(async () => button("Record").click());
    await act(async () => button("Finish").click());
    act(() => button("Play").click());
    await act(async () => button("Record").click());
    await act(async () => {
      reject(new Error("stale playback failure"));
    });
    expect(container.textContent).not.toContain(
      "Unable to play the recorded preview.",
    );
    expect(error).not.toHaveBeenCalled();
  } finally {
    act(() => {
      root.unmount();
      unmounted = true;
    });
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    play.mockRestore();
    pause.mockRestore();
    error.mockRestore();
  }
});
