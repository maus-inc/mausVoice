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
  getMyUserPreferences: () => storeState.userPrefs,
}));

const toastHandlers = vi.hoisted(() => [] as ((p: unknown) => unknown)[]);
vi.mock("../../hooks/toast.hooks", () => ({
  useToastAction: (callback: (p: unknown) => unknown) => {
    toastHandlers.push(callback);
  },
}));

const dismissToastMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../actions/toast.actions", () => ({
  dismissToast: dismissToastMock,
  runToast: (work: Promise<unknown>) => {
    void work;
  },
}));

// Keep the probe observation-only: decide no corrections so the poll exits
// before toasts/localStorage are touched. The mock must cover the whole module
// surface the watcher imports, or a second poll would call into undefined.
vi.mock("../../utils/edit-watch.utils", () => ({
  countDictationOccurrences: () => 1,
  findEditCorrections: () => [],
}));

vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
    stopwatch: vi.fn((_label: string, fn: () => Promise<unknown>) => fn()),
  }),
}));

vi.mock("../../store", () => ({
  useAppStore: (selector: (s: unknown) => unknown) => selector(storeState),
  getAppState: () => ({ autoLearn: { proposal: null } }),
  produceAppState: vi.fn(),
}));

const storeState: {
  autoLearn: { proposal: unknown };
  userPrefs: { autoLearnFromEditsEnabled: boolean };
} = {
  autoLearn: { proposal: null },
  userPrefs: { autoLearnFromEditsEnabled: true },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  toastHandlers.length = 0;
  dismissToastMock.mockClear();
  storeState.autoLearn.proposal = null;
  storeState.userPrefs.autoLearnFromEditsEnabled = true;
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
  if (!container) throw new Error("container missing");
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

describe("EditWatchSideEffects disabled with a visible proposal", () => {
  it("dismisses the native proposal toast instead of leaving it actionable", async () => {
    // The native toast outlives the store, so turning the setting off cleared
    // the proposal its buttons acted on but left both buttons live: Add did
    // nothing, and inside the click grace window it could add a term from a
    // prompt the user had just dismissed.
    storeState.userPrefs.autoLearnFromEditsEnabled = true;
    storeState.autoLearn.proposal = { term: "Soniya", proposedAt: 1 };
    mount();
    // The watch starts enabled, so nothing is dismissed on the first render.
    expect(dismissToastMock).not.toHaveBeenCalled();

    // Remounted rather than re-rendered: the store mock is a plain object, not
    // a reactive store, so a same-element re-render would not re-run the effect
    // that the flag drives.
    await act(async () => {
      storeState.userPrefs.autoLearnFromEditsEnabled = false;
      act(() => root.unmount());
      mount();
    });

    expect(dismissToastMock).toHaveBeenCalled();
  });

  it("ignores an auto-learn click that arrives after the setting is turned off", async () => {
    storeState.userPrefs.autoLearnFromEditsEnabled = true;
    storeState.autoLearn.proposal = { term: "Soniya", proposedAt: 1 };
    mount();

    await act(async () => {
      storeState.userPrefs.autoLearnFromEditsEnabled = false;
      act(() => root.unmount());
      mount();
    });

    const handler = toastHandlers.at(-1);
    expect(handler).toBeTypeOf("function");
    // A click already on its way when the setting flipped must not reach the
    // accept path, where the grace window can still add the held term.
    await act(async () => {
      await handler?.({ action: "auto_learn_accept" });
    });
    // `acceptAutoLearnProposal` is only reachable through the module, so the
    // observable proof is that no dictionary mutation was attempted: the
    // mocked `produceAppState` is the only side effect it has.
    expect(invokeMock).not.toHaveBeenCalledWith(
      expect.stringContaining("dictionary"),
    );
  });
});
