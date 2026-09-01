import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertLocalTranscriptOutputViaTyping } from "./output-routing.utils";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: invokeMock };
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
