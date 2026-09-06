// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// Without this React 19 refuses to flush effects inside act() and the test
// would pass vacuously (the unmount cleanup would never run).
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
import {
  beginEditWatch,
  endEditWatch,
  pollEditWatch,
} from "../../actions/edit-watch.actions";
import { EditWatchSideEffects } from "./EditWatchSideEffects";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: invokeMock };
});

// Both the component and edit-watch.actions read the feature flag through
// this module; enabling it makes beginEditWatch/pollEditWatch observable.
vi.mock("../../utils/user.utils", () => ({
  getMyUserPreferences: () => ({ autoLearnFromEditsEnabled: true }),
}));

vi.mock("../../hooks/toast.hooks", () => ({
  useToastAction: () => {},
}));

// Keep the probe observation-only: decide no corrections so the poll exits
// before toasts/localStorage are touched.
vi.mock("../../utils/edit-watch.utils", () => ({
  findEditCorrections: () => [],
}));

vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
    stopwatch: vi.fn(async (_label: string, fn: () => Promise<unknown>) =>
      fn(),
    ),
  }),
}));

vi.mock("../../store", () => ({
  useAppStore: (selector: (s: unknown) => unknown) => selector({}),
  getAppState: () => ({ autoLearn: { proposal: null } }),
  produceAppState: () => {},
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ textContent: "Hello world" });
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  root?.unmount();
  root = undefined as unknown as Root;
  container.remove();
  endEditWatch();
});

const mount = () => {
  root = createRoot(container);
  act(() => {
    root.render(createElement(EditWatchSideEffects));
  });
};

describe("EditWatchSideEffects unmount cleanup (thread 18)", () => {
  it("ends the edit watch when the component unmounts", async () => {
    beginEditWatch("Hello world");
    mount();
    // Sanity: the watch is live while mounted, so a poll reaches the native
    // invocation that reads the focused field.
    await act(async () => {
      await pollEditWatch();
    });
    expect(invokeMock).toHaveBeenCalledWith("get_text_field_info");

    invokeMock.mockClear();
    act(() => {
      root.unmount();
    });

    await act(async () => {
      await pollEditWatch();
    });
    // After unmount the watch must be cleared: the poll is a no-op and never
    // touches the focused field (or proposes a stale auto-learn term).
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
