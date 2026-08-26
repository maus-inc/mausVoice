import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  insertLocalTranscriptOutputViaTyping,
  routeTranscriptOutput,
} from "./output-routing.utils";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: invokeMock };
});

const { getAppStateMock, getPrefsMock } = vi.hoisted(() => ({
  getAppStateMock: vi.fn(),
  getPrefsMock: vi.fn(),
}));
vi.mock("../store", () => ({ getAppState: getAppStateMock }));
vi.mock("./user.utils", () => ({
  getMyUserPreferences: getPrefsMock,
}));

vi.mock("./log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  }),
}));

vi.mock("./overlay.utils", () => ({
  sendPillFlashMessage: vi.fn(),
}));

vi.mock("../i18n/intl", () => ({
  getIntl: () => ({
    formatMessage: (descriptor: { defaultMessage: string }) =>
      descriptor.defaultMessage,
  }),
}));

describe("routeTranscriptOutput hands-free delay", () => {
  const baseState = {
    appTargetById: {},
    supportsPasteKeybinds: "none",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue("pasted");
    getAppStateMock.mockReturnValue(baseState);
    getPrefsMock.mockReturnValue({
      insertionMethod: "paste",
      typingSpeedMs: 5,
      handsFreeDelayMs: 3000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("waits for the configured delay before pasting a final transcript", async () => {
    const routing = routeTranscriptOutput({
      text: "final words",
      mode: "dictation",
      currentAppId: null,
    });

    await vi.advanceTimersByTimeAsync(2999);
    expect(invokeMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await routing;
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][0]).toBe("paste");
    expect(invokeMock.mock.calls[0][1]).toMatchObject({
      text: expect.stringContaining("final words"),
      keybind: null,
    });
  });

  it("pastes realtime interim segments immediately, bypassing the delay", async () => {
    const routing = routeTranscriptOutput({
      text: "interim ",
      mode: "dictation",
      currentAppId: null,
      isInterim: true,
    });

    // Not a single timer tick is needed: interim delivery must not wait.
    await routing;
    expect(vi.getTimerCount()).toBe(0);
    expect(invokeMock).toHaveBeenCalledWith("paste", {
      text: "interim ",
      keybind: null,
    });
  });
});

type Listener = (event?: { key?: string }) => void;

function installWindowMock() {
  const listeners = new Map<string, Set<Listener>>();
  const windowMock = {
    addEventListener: (type: string, listener: Listener) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: Listener) => {
      listeners.get(type)?.delete(listener);
    },
    dispatch: (type: string, event?: { key?: string }) => {
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  return windowMock;
}

describe("insertLocalTranscriptOutputViaTyping", () => {
  let windowMock: ReturnType<typeof installWindowMock>;

  beforeEach(() => {
    invokeMock.mockReset();
    windowMock = installWindowMock();
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("cancels the live session on blur without a typing id", async () => {
    let resolveType: (() => void) | null = null;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "simulate_type") {
        return new Promise<void>((resolve) => {
          resolveType = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    const typing = insertLocalTranscriptOutputViaTyping("hello", 5);
    await Promise.resolve();

    windowMock.dispatch("blur");

    expect(invokeMock).toHaveBeenCalledWith("cancel_typing");
    const cancelCall = invokeMock.mock.calls.find(
      ([cmd]) => cmd === "cancel_typing",
    );
    expect(cancelCall).toEqual(["cancel_typing"]);

    resolveType!();
    await typing;
  });

  it("cancels on Escape and does not pass a session id", async () => {
    let resolveType: (() => void) | null = null;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "simulate_type") {
        return new Promise<void>((resolve) => {
          resolveType = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    const typing = insertLocalTranscriptOutputViaTyping("hello", 5);
    await Promise.resolve();

    windowMock.dispatch("keydown", { key: "Escape" });

    expect(invokeMock).toHaveBeenCalledWith("cancel_typing");
    resolveType!();
    await typing;
  });
});
