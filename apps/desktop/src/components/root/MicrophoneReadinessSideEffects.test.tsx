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
    setMicrophonePreroll: vi.fn(async () => undefined),
    showSnackbar: vi.fn(),
    emit: vi.fn(async () => undefined),
    listen: vi.fn(async () => () => undefined),
    refreshCurrentUser: vi.fn(async () => undefined),
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
    setMicrophonePreroll: mocks.setMicrophonePreroll,
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
  // Every test runs as the main window unless it says otherwise, because that is
  // the window that owns the hold.
  isMainLocalDataWindow: () => mocks.state.__mainWindow !== false,
  subscribeToLocalDataClearRequested: (listener: () => void) => {
    mocks.clearListeners.add(listener);
    return () => {
      mocks.clearListeners.delete(listener);
    };
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
  listen: mocks.listen,
}));
vi.mock("@maus-inc/desktop-utils", () => ({
  MICROPHONE_READINESS_EVENT: "microphone_readiness_changed",
}));
vi.mock("../../actions/user-activity.actions", () => ({
  refreshCurrentUser: mocks.refreshCurrentUser,
}));
vi.mock("../../actions/app.actions", () => ({
  showSnackbar: mocks.showSnackbar,
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

  it("closes nothing while the preferences are still loading", async () => {
    // `userPrefs` is null for the first frames in every window. Treating that as
    // "the preference is off" released the shared device before any preference
    // had been read -- so a window opening while another held the microphone
    // closed it, and a window that arrived first closed a stream it had just
    // opened itself.
    setState({ userPrefs: null });
    await render();

    expect(mocks.warmMicrophone).not.toHaveBeenCalled();
    expect(mocks.closeMicrophone).not.toHaveBeenCalled();
    expect(mocks.setMicrophoneLinger).not.toHaveBeenCalled();
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

  it("leaves the held device alone when a recording starts", async () => {
    // The press adopts the held stream, so releasing it here would close the
    // stream the recording is about to use. `closeMicrophone` also zeroes the
    // linger policy the stop path reads, so the stream would be closed at stop
    // and reopened: the device open that keep-ready exists to avoid, paid on
    // every dictation, plus a microphone indicator blinking for the cycle.
    setState({});
    await render();
    expect(mocks.warmMicrophone).toHaveBeenCalledTimes(1);

    setState({ activeRecordingMode: "dictation" });
    await rerender();

    expect(mocks.closeMicrophone).not.toHaveBeenCalled();
    expect(mocks.setMicrophoneLinger).not.toHaveBeenCalledWith(0);
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

  it("broadcasts a state change so other windows do not keep a stale copy", async () => {
    mocks.microphoneReady.mockResolvedValue(true);
    setState({});
    await render();

    expect(mocks.emit).toHaveBeenCalledWith("microphone_readiness_changed", {
      held: true,
    });
  });

  it("does not broadcast from a window that is not the main one", async () => {
    mocks.microphoneReady.mockResolvedValue(true);
    setState({ __mainWindow: false });
    await render();

    // N windows each emitting would multiply the traffic and make every
    // listener re-read N times, for one shared device.
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("does not broadcast when the state has not changed", async () => {
    mocks.microphoneReady.mockResolvedValue(false);
    setState({ settings: { microphoneHeld: false } });
    await render();

    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("retries a failed hold on focus only from the main window", async () => {
    mocks.warmMicrophone.mockResolvedValue({
      status: "error",
      error: "device busy",
    });
    setState({ __mainWindow: false });
    await render();

    const attempts = mocks.warmMicrophone.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    // Every window enumerating the same device on focus is N times the work for
    // one answer, and the retry opens a real stream.
    expect(mocks.warmMicrophone.mock.calls.length).toBe(attempts);
  });

  it("tells the user once when the hold cannot open, and does not repeat it", async () => {
    mocks.warmMicrophone.mockResolvedValue({
      status: "error",
      error: "device busy",
    });
    setState({
      userPrefs: {
        keepMicrophoneReady: true,
        microphonePrerollSeconds: 0.5,
        microphoneLingerMs: 0,
      },
    });
    await render();

    // The switch says on and nothing is held. Without this the press the setting
    // promised to make instant is slow again for a reason the user cannot see.
    expect(mocks.showSnackbar).toHaveBeenCalledTimes(1);

    // A second attempt fails the same way; the user has already been told.
    await act(async () => {
      setState({
        userPrefs: {
          keepMicrophoneReady: true,
          microphonePrerollSeconds: 1,
          microphoneLingerMs: 0,
        },
      });
      await Promise.resolve();
    });

    expect(mocks.showSnackbar).toHaveBeenCalledTimes(1);
  });

  it("names the other application when the device is busy", async () => {
    // The generic "could not open in advance" leaves the user with no next step.
    // A busy device has one, and it is the only failure whose fix is outside
    // this app but entirely within the user's reach.
    mocks.warmMicrophone.mockResolvedValue({
      status: "error",
      error:
        "ALSA function 'snd_pcm_open' failed with 'Device or resource busy'",
    });
    setState({
      userPrefs: {
        keepMicrophoneReady: true,
        microphonePrerollSeconds: 0.5,
        microphoneLingerMs: 0,
      },
    });
    await render();

    expect(mocks.showSnackbar).toHaveBeenCalledTimes(1);
    const message = mocks.showSnackbar.mock.calls[0]?.[0] as string;
    expect(message).toContain("Another application is using the microphone");
    // The generic fallback must not also be shown, or the user gets two
    // explanations of one failure.
    expect(message).not.toContain("Could not open the microphone in advance");
  });

  it("points at system settings when access is denied at open time", async () => {
    // Distinct from the permission-state path above: here the app believed it
    // had permission and the open was refused anyway. Telling the user to close
    // an application would be wrong.
    mocks.warmMicrophone.mockResolvedValue({
      status: "error",
      error: "A backend-specific error has occurred: 0x80070005",
    });
    setState({
      userPrefs: {
        keepMicrophoneReady: true,
        microphonePrerollSeconds: 0.5,
        microphoneLingerMs: 0,
      },
    });
    await render();

    const message = mocks.showSnackbar.mock.calls[0]?.[0] as string;
    expect(message).toContain("Microphone access is blocked");
    expect(message).not.toContain("Another application");
  });

  it("falls back to the generic message for a failure it cannot identify", async () => {
    mocks.warmMicrophone.mockResolvedValue({
      status: "error",
      error: "stream build: something unexpected",
    });
    setState({
      userPrefs: {
        keepMicrophoneReady: true,
        microphonePrerollSeconds: 0.5,
        microphoneLingerMs: 0,
      },
    });
    await render();

    const message = mocks.showSnackbar.mock.calls[0]?.[0] as string;
    expect(message).toContain("Could not open the microphone in advance");
    // No guess: neither named cause is claimed for an unclassified failure.
    expect(message).not.toContain("Another application");
    expect(message).not.toContain("access is blocked");
  });

  it("points at the system settings when permission blocks the hold entirely", async () => {
    setState({ permissions: { microphone: { state: "denied" } } });
    await render();

    // Nothing is attempted, so nothing else could tell the user: the switch is
    // on, no device is opened, and the reason is a permission the user controls.
    expect(mocks.warmMicrophone).not.toHaveBeenCalled();
    expect(mocks.showSnackbar).toHaveBeenCalledTimes(1);
    const message = mocks.showSnackbar.mock.calls[0]?.[0] as string;
    expect(message).toContain("system settings");

    // Granting it starts the hold, and the refusal is not repeated.
    mocks.showSnackbar.mockClear();
    setState({ permissions: { microphone: { state: "authorized" } } });
    await rerender();

    expect(mocks.warmMicrophone).toHaveBeenCalledTimes(1);
    expect(mocks.showSnackbar).not.toHaveBeenCalled();
  });

  it("says nothing when the hold succeeds", async () => {
    setState({
      userPrefs: {
        keepMicrophoneReady: true,
        microphonePrerollSeconds: 0.5,
        microphoneLingerMs: 0,
      },
    });
    await render();

    expect(mocks.showSnackbar).not.toHaveBeenCalled();
  });

  it("re-announces a failure that follows a successful hold", async () => {
    setState({
      userPrefs: {
        keepMicrophoneReady: true,
        microphonePrerollSeconds: 0.5,
        microphoneLingerMs: 0,
      },
    });
    await render();
    expect(mocks.showSnackbar).not.toHaveBeenCalled();

    // Turn it off and back on: that is a new attempt at a new hold, so its
    // failure is a new fact rather than a repeat of one already reported.
    setState({
      userPrefs: {
        keepMicrophoneReady: false,
        microphonePrerollSeconds: 0.5,
        microphoneLingerMs: 0,
      },
    });
    await rerender();
    mocks.warmMicrophone.mockResolvedValue({
      status: "error",
      error: "device busy",
    });
    setState({
      userPrefs: {
        keepMicrophoneReady: true,
        microphonePrerollSeconds: 0.5,
        microphoneLingerMs: 0,
      },
    });
    await rerender();

    expect(mocks.showSnackbar).toHaveBeenCalledTimes(1);
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

  it("pushes the pre-roll even when nothing is held", async () => {
    // The open path takes the pre-roll as an argument, which only happens with
    // keep-ready on. With it off nothing opens until the press, so without this
    // push the recorder used its own 500 ms default and the slider had no
    // effect -- on the cold start, which is exactly when the first word is most
    // likely to be clipped.
    setState({
      userPrefs: {
        keepMicrophoneReady: false,
        microphonePrerollSeconds: 1.5,
        microphoneLingerMs: 0,
      },
    });
    await render();

    expect(mocks.setMicrophonePreroll).toHaveBeenCalledWith(1.5);
    // Nothing is opened to apply it to: this is a policy push, not a hold.
    expect(mocks.warmMicrophone).not.toHaveBeenCalled();
  });

  it("follows the slider without waiting for a relaunch", async () => {
    setState({
      userPrefs: {
        keepMicrophoneReady: false,
        microphonePrerollSeconds: 0.5,
        microphoneLingerMs: 0,
      },
    });
    await render();
    expect(mocks.setMicrophonePreroll).toHaveBeenLastCalledWith(0.5);

    mocks.setMicrophonePreroll.mockClear();
    // `rerender`, not a bare `act` over a state write: the component reads the
    // store through `useAppStore`, so nothing re-renders until something asks
    // React to render again, and the effect never re-runs.
    setState({
      userPrefs: {
        keepMicrophoneReady: false,
        microphonePrerollSeconds: 2,
        microphoneLingerMs: 0,
      },
    });
    await rerender();

    expect(mocks.setMicrophonePreroll).toHaveBeenCalledWith(2);
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
    setState({
      userPrefs: {
        keepMicrophoneReady: true,
        microphonePrerollSeconds: 0.5,
        microphoneLingerMs: 5_000,
      },
    });
    // `rerender` is required for this assertion to mean anything: without a
    // render the effect never re-runs, so "not called" would be true whether or
    // not the guard exists.
    await rerender();

    expect(mocks.warmMicrophone).toHaveBeenCalled();
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
