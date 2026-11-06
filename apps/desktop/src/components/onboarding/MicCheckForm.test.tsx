// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

const invoke = vi.hoisted(() =>
  vi
    .fn()
    .mockImplementation((command: string) =>
      Promise.resolve(
        command === "start_recording" ? { sampleRate: 48_000 } : undefined,
      ),
    ),
);
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: (command: string, args?: Record<string, unknown>) =>
    command === "recording_generation"
      ? Promise.resolve(0)
      : invoke(command, args),
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});
vi.mock("../common/AudioWaveform", () => ({ AudioWaveform: () => null }));
vi.mock("../microphone/MicrophoneSelector", () => ({
  MicrophoneSelector: () => null,
}));
import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, produceAppState, setAppState } from "../../store";
import { MicCheckForm } from "./MicCheckForm";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { NativeRecordingLease } from "../../utils/native-recording-lease";

// A real start reply carries the negotiated rate; resolving `undefined` would
// be rejected by the lease before any capture could be observed.
const okCommand = (command: string): Promise<unknown> =>
  Promise.resolve(
    command === "start_recording" ? { sampleRate: 48_000 } : undefined,
  );

const resetInvoke = () => invoke.mockReset().mockImplementation(okCommand);

async function drainFailedRelease() {
  resetInvoke();
  const lease = new NativeRecordingLease(tauriInvoke, crypto.randomUUID());
  await lease.start(null);
  await lease.cancel();
}

ensureUiHarness();

it.each(["paused", "loading", "recording"] as const)(
  "does not start an onboarding microphone check during %s dictation",
  async (phase) => {
    invoke.mockClear();
    const state = structuredClone(INITIAL_APP_STATE);
    state.overlayPhase = phase;
    setAppState(state, true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <MemoryRouter>
            <MicCheckForm />
          </MemoryRouter>,
        ),
      );
      expect(invoke).not.toHaveBeenCalledWith(
        "start_recording",
        expect.anything(),
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);

it("does not erase a newer dictation's waveform after a pending test stop", async () => {
  resetInvoke();
  let finishStop!: () => void;
  invoke.mockImplementation((command: string) =>
    command === "discard_recording"
      ? new Promise<void>((resolve) => {
          finishStop = resolve;
        })
      : okCommand(command),
  );
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <MicCheckForm />
        </MemoryRouter>,
      ),
    );
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Try another mic",
    );
    if (!button) throw new Error("Missing microphone button");
    act(() => button.click());
    await vi.waitFor(() => expect(finishStop).toBeTypeOf("function"));
    act(() =>
      produceAppState((draft) => {
        draft.overlayPhase = "recording";
        draft.audioLevels = [0.75];
      }),
    );
    await act(async () => finishStop());
    expect(getAppState().audioLevels).toEqual([0.75]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    resetInvoke();
  }
});

it("starts the onboarding check once dictation releases the recorder", async () => {
  resetInvoke();
  const state = structuredClone(INITIAL_APP_STATE);
  state.overlayPhase = "paused";
  setAppState(state, true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <MicCheckForm />
        </MemoryRouter>,
      ),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "start_recording",
      expect.anything(),
    );
    await act(async () =>
      produceAppState((draft) => {
        draft.overlayPhase = "idle";
      }),
    );
    expect(
      invoke.mock.calls.filter(([command]) => command === "start_recording"),
    ).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("waits for microphone selection before resuming a blocked check", async () => {
  resetInvoke();
  const state = structuredClone(INITIAL_APP_STATE);
  state.overlayPhase = "paused";
  setAppState(state, true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === label,
    );
    if (!found) throw new Error(`Missing ${label} button`);
    return found;
  };
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <MicCheckForm />
        </MemoryRouter>,
      ),
    );
    await act(async () => button("Try another mic").click());
    await act(async () =>
      produceAppState((draft) => {
        draft.overlayPhase = "idle";
      }),
    );
    expect(
      invoke.mock.calls.filter(([command]) => command === "start_recording"),
    ).toHaveLength(0);
    await act(async () => button("Use this mic").click());
    expect(
      invoke.mock.calls.filter(([command]) => command === "start_recording"),
    ).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("does not retry a failed deferred start on unrelated renders", async () => {
  invoke
    .mockReset()
    .mockImplementation((command: string) =>
      command === "start_recording"
        ? Promise.reject(new Error("microphone unavailable"))
        : okCommand(command),
    );
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const state = structuredClone(INITIAL_APP_STATE);
  state.overlayPhase = "paused";
  setAppState(state, true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <MicCheckForm />
        </MemoryRouter>,
      ),
    );
    await act(async () =>
      produceAppState((draft) => {
        draft.overlayPhase = "idle";
      }),
    );
    await act(async () =>
      produceAppState((draft) => {
        draft.audioLevels = [0.4];
      }),
    );
    expect(
      invoke.mock.calls.filter(([command]) => command === "start_recording"),
    ).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    error.mockRestore();
    resetInvoke();
  }
});

it("resumes an interrupted microphone check only after its stop finishes", async () => {
  resetInvoke();
  let finishStop!: () => void;
  invoke.mockImplementation((command: string) =>
    command === "discard_recording"
      ? new Promise<void>((resolve) => {
          finishStop = resolve;
        })
      : okCommand(command),
  );
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const starts = () =>
    invoke.mock.calls.filter(([command]) => command === "start_recording")
      .length;
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <MicCheckForm />
        </MemoryRouter>,
      ),
    );
    expect(starts()).toBe(1);
    await act(async () =>
      produceAppState((draft) => {
        draft.overlayPhase = "recording";
      }),
    );
    expect(invoke).toHaveBeenCalledWith("discard_recording", {
      ownerId: expect.any(String),
      generation: expect.any(Number),
    });
    await act(async () =>
      produceAppState((draft) => {
        draft.overlayPhase = "idle";
      }),
    );
    expect(starts()).toBe(1);
    await act(async () => finishStop());
    expect(starts()).toBe(2);
  } finally {
    resetInvoke();
    await act(async () => root.unmount());
    container.remove();
    resetInvoke();
  }
});

it("does not restart an interrupted check after the user opens microphone selection", async () => {
  resetInvoke();
  let finishStop!: () => void;
  invoke.mockImplementation((command: string) =>
    command === "discard_recording"
      ? new Promise<void>((resolve) => {
          finishStop = resolve;
        })
      : okCommand(command),
  );
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <MicCheckForm />
        </MemoryRouter>,
      ),
    );
    await act(async () =>
      produceAppState((draft) => {
        draft.overlayPhase = "recording";
      }),
    );
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Try another mic",
    );
    if (!button) throw new Error("Missing microphone button");
    await act(async () => button.click());
    await act(async () =>
      produceAppState((draft) => {
        draft.overlayPhase = "idle";
      }),
    );
    await act(async () => finishStop());
    expect(
      invoke.mock.calls.filter(([command]) => command === "start_recording"),
    ).toHaveLength(1);
    expect(container.textContent).toContain("Use this mic");
  } finally {
    resetInvoke();
    await act(async () => root.unmount());
    container.remove();
    resetInvoke();
  }
});

it("does not restart a microphone check after its interrupted stop fails", async () => {
  resetInvoke();
  let failStop!: (error: Error) => void;
  invoke.mockImplementation((command: string) =>
    command === "discard_recording"
      ? new Promise<void>((_resolve, reject) => {
          failStop = reject;
        })
      : okCommand(command),
  );
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <MicCheckForm />
        </MemoryRouter>,
      ),
    );
    await act(async () =>
      produceAppState((draft) => {
        draft.overlayPhase = "recording";
      }),
    );
    await act(async () =>
      produceAppState((draft) => {
        draft.overlayPhase = "idle";
      }),
    );
    await act(async () => failStop(new Error("stop failed")));
    expect(
      invoke.mock.calls.filter(([command]) => command === "start_recording"),
    ).toHaveLength(1);
  } finally {
    resetInvoke();
    await act(async () => root.unmount());
    container.remove();
    error.mockRestore();
    await drainFailedRelease();
  }
});

it("shares a single pending stop across rapid microphone-selection clicks", async () => {
  resetInvoke();
  let finishStop!: () => void;
  invoke.mockImplementation((command: string) =>
    command === "discard_recording"
      ? new Promise<void>((resolve) => {
          finishStop = resolve;
        })
      : okCommand(command),
  );
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <MicCheckForm />
        </MemoryRouter>,
      ),
    );
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Try another mic",
    );
    if (!button) throw new Error("Missing microphone button");
    await act(async () => {
      button.click();
      button.click();
    });
    expect(
      invoke.mock.calls.filter(([command]) => command === "discard_recording"),
    ).toHaveLength(1);
    await act(async () => finishStop());
    expect(container.textContent).toContain("Use this mic");
  } finally {
    resetInvoke();
    await act(async () => root.unmount());
    container.remove();
    resetInvoke();
  }
});

it("handles synchronous stop bridge failures without leaving the selector blocked", async () => {
  resetInvoke();
  invoke.mockImplementation((command: string) => {
    if (command === "discard_recording") throw new Error("bridge failure");
    return okCommand(command);
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <MicCheckForm />
        </MemoryRouter>,
      ),
    );
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Try another mic",
    );
    if (!button) throw new Error("Missing microphone button");
    await act(async () => button.click());
    expect(error).toHaveBeenCalledWith(
      "Failed to stop recording",
      expect.any(Error),
    );
    expect(container.textContent).toContain("Use this mic");
  } finally {
    resetInvoke();
    await act(async () => root.unmount());
    container.remove();
    error.mockRestore();
    await drainFailedRelease();
  }
});

it("stops the exact pending check before restarting after dictation", async () => {
  resetInvoke();
  let finishStart!: () => void;
  const firstStart = new Promise<void>((resolve) => {
    finishStart = resolve;
  });
  let startCount = 0;
  invoke.mockImplementation((command: string) => {
    if (command === "start_recording" && ++startCount === 1) return firstStart;
    return Promise.resolve();
  });
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <MicCheckForm />
        </MemoryRouter>,
      ),
    );
    const firstOwner = invoke.mock.calls[0][1].ownerId;
    await act(async () =>
      produceAppState((draft) => {
        draft.overlayPhase = "recording";
      }),
    );
    expect(
      invoke.mock.calls.filter(([command]) => command === "discard_recording"),
    ).toHaveLength(1);
    await act(async () => finishStart());
    expect(invoke).toHaveBeenCalledWith("discard_recording", {
      ownerId: firstOwner,
      generation: expect.any(Number),
    });
    await act(async () =>
      produceAppState((draft) => {
        draft.overlayPhase = "idle";
      }),
    );
    expect(startCount).toBe(2);
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === "start_recording",
      )[1][1].ownerId,
    ).not.toBe(firstOwner);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    resetInvoke();
  }
});
