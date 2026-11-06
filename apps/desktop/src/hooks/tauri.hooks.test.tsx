// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EPHEMERAL_SESSION_STARTED_EVENT } from "@maus-inc/desktop-utils";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  showErrorSnackbar: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../actions/app.actions", () => ({
  showErrorSnackbar: mocks.showErrorSnackbar,
}));

import { useExpansionEventListener } from "./tauri.hooks";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;

const Listener = ({ receive }: { receive: (value: string) => void }) => {
  useExpansionEventListener(EPHEMERAL_SESSION_STARTED_EVENT, (payload) => {
    const startedAt: string = payload.startedAt;
    receive(startedAt);
  });
  return null;
};

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("typed expansion listener", () => {
  it("receives the typed payload, uses the latest callback, and unsubscribes", async () => {
    const unlisten = vi.fn();
    mocks.listen.mockResolvedValueOnce(unlisten);
    const first = vi.fn();
    const second = vi.fn();
    await act(async () =>
      root.render(createElement(Listener, { receive: first })),
    );
    expect(mocks.listen).toHaveBeenCalledOnce();
    expect(mocks.listen.mock.calls[0][0]).toBe(EPHEMERAL_SESSION_STARTED_EVENT);
    const handler = mocks.listen.mock.calls[0][1] as (event: {
      payload: { startedAt: string };
    }) => Promise<void>;
    await act(async () => handler({ payload: { startedAt: "first" } }));
    await act(async () =>
      root.render(createElement(Listener, { receive: second })),
    );
    await act(async () => handler({ payload: { startedAt: "second" } }));
    expect(first).toHaveBeenCalledWith("first");
    expect(second).toHaveBeenCalledWith("second");
    expect(mocks.listen).toHaveBeenCalledOnce();
    act(() => root.unmount());
    expect(unlisten).toHaveBeenCalledOnce();
    root = createRoot(container);
  });

  it("surfaces callback errors through the app snackbar", async () => {
    mocks.listen.mockResolvedValueOnce(vi.fn());
    const error = new Error("handler failed");
    await act(async () =>
      root.render(
        createElement(Listener, {
          receive: () => {
            throw error;
          },
        }),
      ),
    );
    const handler = mocks.listen.mock.calls[0][1] as (event: {
      payload: { startedAt: string };
    }) => Promise<void>;
    await act(async () => handler({ payload: { startedAt: "now" } }));
    expect(mocks.showErrorSnackbar).toHaveBeenCalledWith(error);
  });

  it("surfaces subscription failures through the app snackbar", async () => {
    const error = new Error("listen failed");
    mocks.listen.mockRejectedValueOnce(error);
    await act(async () =>
      root.render(createElement(Listener, { receive: vi.fn() })),
    );
    expect(mocks.showErrorSnackbar).toHaveBeenCalledWith(error);
  });
});
