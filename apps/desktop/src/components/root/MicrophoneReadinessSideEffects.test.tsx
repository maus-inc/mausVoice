// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

ensureUiHarness();

/**
 * The component is the only place that opens or closes the held device, so these
 * tests are about the device, not about the rendering: what it asks the backend
 * for, and what it refuses to ask for.
 *
 * A second component that opened the microphone would be a second place that
 * could leave it open, which is why there is no other caller.
 */
const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {};
  return {
    state,
    warmMicrophone: vi.fn<
      (preroll: number, linger: number) => Promise<unknown>
    >(async () => ({ status: "ok", data: null })),
    closeMicrophone: vi.fn(async () => undefined),
    microphoneReady: vi.fn(async () => false),
    prepareMicrophone: vi.fn(async () => ({ status: "ok", data: "mic" })),
    setMicrophoneLinger: vi.fn(async () => undefined),
    clearListeners: new Set<() => void>(),
  };
});

vi.mock("@maus-inc/desktop-native-apis", () => ({
  commands: {
    warmMicrophone: mocks.warmMicrophone,
    closeMicrophone: mocks.closeMicrophone,
    microphoneReady: mocks.microphoneReady,
    prepareMicrophone: mocks.prepareMicrophone,
    setMicrophoneLinger: mocks.setMicrophoneLinger,
  },
}));

vi.mock("../../store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store")>();
  return {
    ...actual,
    useAppStore: (selector: (state: unknown) => unknown) =>
      selector(mocks.state),
    getAppState: () => mocks.state,
    produceAppState: (recipe: (draft: unknown) => void) => recipe(mocks.state),
  };
});

vi.mock("../../utils/local-data-write-gate", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../utils/local-data-write-gate")
  >()),
  isLocalDataClearRequested: () => mocks.state.__clearing === true,
  subscribeToLocalDataClearRequested: (listener: () => void) => {
    mocks.clearListeners.add(listener);
    return () => {
      mocks.clearListeners.delete(listener);
    };
  },
}));

vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }),
}));

import { MicrophoneReadinessSideEffects } from "./MicrophoneReadinessSideEffects";

let container: HTMLDivElement;
let root: Root;

const setState = (overrides: Record<string, unknown>) => {
  for (const key of Object.keys(mocks.state)) delete mocks.state[key];
  Object.assign(mocks.state, {
    userPrefs: {
      keepMicrophoneReady: true,
      microphonePrerollSeconds: 0.5,
      microphoneLingerMs: 0,
    },
    activeRecordingMode: null,
    permissions: { microphone: { state: "authorized" } },
    settings: { microphoneHeld: null },
    ...overrides,
  });
};

/** Renders and lets the effect's promise continuations settle. */
const render = async () => {
  await act(async () => {
    root.render(<MicrophoneReadinessSideEffects />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const rerender = async () => {
  await act(async () => {
    root.render(<MicrophoneReadinessSideEffects />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.warmMicrophone.mockResolvedValue({ status: "ok", data: null });
  mocks.microphoneReady.mockResolvedValue(false);
  mocks.clearListeners.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

describe("MicrophoneReadinessSideEffects", () => {
  it("holds the device with the ready-forever window when the preference is on", async () => {
    setState({});
    await render();

    expect(mocks.warmMicrophone).toHaveBeenCalledTimes(1);
    const [, linger] = mocks.warmMicrophone.mock.calls[0];
    // A finite window here would make an always-ready microphone close itself
    // while the preference still says it is on.
    expect(linger).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("opens with the configured pre-roll", async () => {
    setState({
      userPrefs: {
        keepMicrophoneReady: true,
        microphonePrerollSeconds: 1.2,
        microphoneLingerMs: 0,
      },
    });
    await render();

    expect(mocks.warmMicrophone.mock.calls[0][0]).toBe(1.2);
  });

  it("does not open anything when the preference is off", async () => {
    setState({
      userPrefs: {
        keepMicrophoneReady: false,
        microphonePrerollSeconds: 0.5,
        microphoneLingerMs: 0,
      },
    });
    await render();

    expect(mocks.warmMicrophone).not.toHaveBeenCalled();
  });

  it("does not hold while a recording is in progress", async () => {
    // The recording owns the device. A second stream on the same hardware would
    // compete with it.
    setState({ activeRecordingMode: "dictation" });
    await render();

    expect(mocks.warmMicrophone).not.toHaveBeenCalled();
  });

  it("does not open a device the OS has not authorised", async () => {
    // A revoked permission must not leave a stream the OS no longer authorises
    // running, and the indicator would be a lie.
    setState({ permissions: { microphone: { state: "denied" } } });
    await render();

    expect(mocks.warmMicrophone).not.toHaveBeenCalled();
  });

  it("releases the device when a clear is requested mid-hold", async () => {
    setState({});
    await render();
    expect(mocks.warmMicrophone).toHaveBeenCalledTimes(1);

    // The clear is requested outside React state, so only the subscription can
    // see it. Reading the latch once at mount would miss this entirely.
    await act(async () => {
      mocks.state.__clearing = true;
      for (const listener of mocks.clearListeners) listener();
    });

    expect(mocks.closeMicrophone).toHaveBeenCalled();
  });

  it("resizes the ring instead of reopening on a slider change", async () => {
    setState({});
    await render();
    expect(mocks.warmMicrophone).toHaveBeenCalledTimes(1);

    // Reopening would drop the very pre-roll the user is adjusting, so the
    // second call has to be a resize against the same held stream.
    mocks.state.userPrefs = {
      keepMicrophoneReady: true,
      microphonePrerollSeconds: 1.5,
      microphoneLingerMs: 0,
    };
    await rerender();

    expect(mocks.warmMicrophone).toHaveBeenCalledTimes(2);
    expect(mocks.warmMicrophone.mock.calls[1][0]).toBe(1.5);
  });

  it("publishes what the backend reports, not what the preference asks", async () => {
    setState({});
    mocks.microphoneReady.mockResolvedValue(true);
    await render();

    // The switch reflects the preference; this reflects the device. They differ
    // whenever an open failed, which is the case the user notices.
    expect(mocks.state.settings).toMatchObject({ microphoneHeld: true });
  });

  it("never pushes the linger window while the device is held", async () => {
    setState({
      userPrefs: {
        keepMicrophoneReady: true,
        microphonePrerollSeconds: 0.5,
        microphoneLingerMs: 5_000,
      },
    });
    await render();

    // Mount is exactly the wrong moment to say "close at stop": the hold effect
    // in the same commit opens the stream, and zero would close it.
    expect(mocks.setMicrophoneLinger).not.toHaveBeenCalled();
  });

  it("pushes the linger window when nothing is held", async () => {
    setState({
      userPrefs: {
        keepMicrophoneReady: false,
        microphonePrerollSeconds: 0.5,
        microphoneLingerMs: 5_000,
      },
    });
    await render();
    // The stop path reads this when a recording ends, so it has to be in place
    // before that recording, not on the next launch.
    expect(mocks.setMicrophoneLinger).toHaveBeenCalledWith(5_000);

    // Turning the hold on stops pushing it: zero would close the stream the hold
    // is about to open, and the window has nothing to say about a held device.
    mocks.setMicrophoneLinger.mockClear();
    await act(async () => {
      setState({
        userPrefs: {
          keepMicrophoneReady: true,
          microphonePrerollSeconds: 0.5,
          microphoneLingerMs: 5_000,
        },
      });
      await Promise.resolve();
    });

    expect(mocks.setMicrophoneLinger).not.toHaveBeenCalled();
  });

  it("prepares the device when nothing is held", async () => {
    setState({
      userPrefs: {
        keepMicrophoneReady: false,
        microphonePrerollSeconds: 0.5,
        microphoneLingerMs: 0,
      },
    });
    await render();

    // Resolving the device ahead of the press costs nothing visible, so it runs
    // even when the user did not opt into holding the device open.
    expect(mocks.prepareMicrophone).toHaveBeenCalled();
  });
});
