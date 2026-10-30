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
  EDIT_QUIESCENCE_MS,
  beginEditWatch,
  endEditWatch,
  getVisibleProposalId,
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

// `dismissToast` is passed straight into `runToast(work: Promise<unknown>)`
// and the real one is `async`, so the fake must hand back a promise.
const dismissToastMock = vi.hoisted(() =>
  vi.fn(() => Promise.resolve(undefined)),
);
vi.mock("../../actions/toast.actions", () => ({
  dismissToast: dismissToastMock,
  runToast: (work: Promise<unknown>) => {
    void work;
  },
  showToast: vi.fn(() => Promise.resolve(undefined)),
}));

// Keep the probe observation-only by default: decide no corrections so the poll
// exits before toasts/localStorage are touched. The mock must cover the whole
// module surface the watcher imports, or a second poll would call into undefined.
const corrections = vi.hoisted(() => ({
  value: [] as string[],
  calls: 0,
}));
vi.mock("../../utils/edit-watch.utils", () => ({
  countDictationOccurrences: () => 1,
  findEditCorrections: () => {
    corrections.calls += 1;
    return corrections.value;
  },
}));

// The only observable effect `acceptAutoLearnProposal` has, so a click that
// reached the accept path is visible here.
const createGlossaryTerms = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ created: [] })),
);
vi.mock("../../actions/dictionary.actions", () => ({
  createGlossaryTerms,
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

// Real, not a no-op: `acceptAutoLearnProposal` reads the proposal back out of
// the store, so a stubbed `produceAppState` would make every click look like it
// had nothing to accept and the test could not tell "ignored" from "accepted
// nothing".
vi.mock("../../store", () => ({
  useAppStore: (selector: (s: unknown) => unknown) => selector(storeState),
  getAppState: () => storeState,
  produceAppState: (recipe: (draft: typeof storeState) => void) =>
    recipe(storeState),
}));

type TestProposal = { term: string; proposedAt: number };

const storeState: {
  autoLearn: { proposal: TestProposal | null };
  userPrefs: { autoLearnFromEditsEnabled: boolean };
  // Read by the scan when it picks a term to propose, so the poll cannot fail
  // on a store slice this mock never declared.
  termById: Record<string, unknown>;
} = {
  autoLearn: { proposal: null },
  userPrefs: { autoLearnFromEditsEnabled: true },
  termById: {},
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  toastHandlers.length = 0;
  dismissToastMock.mockClear();
  createGlossaryTerms.mockClear();
  corrections.calls = 0;
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

/**
 * Drive the watcher far enough to raise a real proposal, and return the id the
 * prompt it showed carries.
 *
 * The poll only proposes once the focused field has stopped changing, which
 * takes two samples a full `EDIT_QUIESCENCE_MS` apart, so the field is fed
 * unchanged and the clock is advanced past that window.
 */
const raiseProposal = async (): Promise<string | null> => {
  corrections.value = ["Soniya"];
  beginEditWatch("Hello world");
  await act(async () => {
    await pollEditWatch();
    await new Promise((resolve) =>
      setTimeout(resolve, EDIT_QUIESCENCE_MS + 50),
    );
    await pollEditWatch();
  });
  expect(storeState.autoLearn.proposal?.term).toBe("Soniya");
  return getVisibleProposalId();
};

const handlerAt = (index: number) => toastHandlers.at(index);

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

    // Re-rendered on the SAME root, which is what turning the setting off actually does.
    //
    // This used to unmount and remount, because the store mock is a plain object rather than a
    // reactive store and nothing else re-rendered it. That simulation was unfaithful in a way
    // that mattered: the unmount runs this component's own cleanup, which calls
    // `endEditWatch()`, and `endEditWatch` clears BOTH `clearAutoLearnProposal()` and
    // `clearVisibleProposalId()`. So the proposal was gone before the disable effect ran, and
    // the only reason the dismiss still fired was that it was unconditional.
    //
    // In production the order is the other way round: the effect dismisses first and calls
    // `endEditWatch()` on the next line. Re-rendering one root keeps the component mounted, so
    // nothing clears the proposal and the effect sees the live proposal it is meant to dismiss.
    await act(() => {
      storeState.userPrefs.autoLearnFromEditsEnabled = false;
      root.render(createElement(EditWatchSideEffects));
    });

    expect(dismissToastMock).toHaveBeenCalled();
  });

  it("leaves an unrelated toast alone when no proposal is live", async () => {
    // `dismissToast()` takes no argument and the channel is a single slot shared with
    // pill-review, transcription progress, the composer and the startup update notice. With no
    // proposal on screen there is nothing of ours to clear, and dismissing unconditionally took
    // whatever else was up -- including at startup, since this effect also runs on mount when
    // the setting is off.
    storeState.userPrefs.autoLearnFromEditsEnabled = true;
    storeState.autoLearn.proposal = null;
    mount();

    await act(() => {
      storeState.userPrefs.autoLearnFromEditsEnabled = false;
      root.render(createElement(EditWatchSideEffects));
    });

    expect(dismissToastMock).not.toHaveBeenCalled();
  });

  it("ignores an auto-learn click that arrives after the setting is turned off", async () => {
    const proposalId = await raiseProposal();
    mount();

    await act(() => {
      storeState.userPrefs.autoLearnFromEditsEnabled = false;
      act(() => root.unmount());
      mount();
    });

    const handler = toastHandlers.at(-1);
    expect(handler).toBeTypeOf("function");
    // A click already on its way when the setting flipped must not reach the
    // accept path, where the grace window can still add the held term. It
    // carries the live prompt's id, so the id check alone would let it through:
    // this proves the disabled flag is what stops it.
    await act(async () => {
      await handler?.({
        action: "auto_learn_accept",
        proposalId: proposalId ?? "",
      });
    });
    expect(createGlossaryTerms).not.toHaveBeenCalled();
  });
});

describe("EditWatchSideEffects stale auto-learn click", () => {
  it("does not answer a superseded prompt with the proposal now showing", async () => {
    const staleId = await raiseProposal();

    // The first prompt is superseded: its proposal ages out on the TTL (the pill
    // keeps the toast on screen well past that) and the watcher raises a second
    // one for a different correction. The user is now looking at the second
    // prompt; the first one's buttons are still there.
    corrections.value = ["Ralf"];
    await act(async () => {
      const proposal = storeState.autoLearn.proposal;
      if (!proposal) throw new Error("a proposal must be showing");
      proposal.proposedAt = 0;
      await pollEditWatch();
    });
    expect(storeState.autoLearn.proposal?.term).toBe("Ralf");
    const liveId = getVisibleProposalId();
    expect(liveId).not.toBe(staleId);

    mount();
    const handler = toastHandlers.at(-1);
    expect(handler).toBeTypeOf("function");

    // A click that was already on its way when the second prompt replaced the
    // first. It names the prompt it was raised for, so the term it offered is
    // knowable and must not be confused with the one now showing.
    await act(async () => {
      await handler?.({
        action: "auto_learn_accept",
        proposalId: staleId ?? "",
      });
    });
    // Answering it anyway would add "Ralf": a term the user never agreed to.
    expect(createGlossaryTerms).not.toHaveBeenCalled();
    expect(storeState.autoLearn.proposal?.term).toBe("Ralf");

    // The prompt actually on screen still works, so the guard discriminates
    // rather than dropping every click.
    await act(async () => {
      await handler?.({
        action: "auto_learn_accept",
        proposalId: liveId ?? "",
      });
    });
    expect(createGlossaryTerms).toHaveBeenCalledExactlyOnceWith(["Ralf"]);
  });

  it("ignores a reject click that names a superseded prompt", async () => {
    const staleId = await raiseProposal();

    corrections.value = ["Ralf"];
    await act(async () => {
      const proposal = storeState.autoLearn.proposal;
      if (!proposal) throw new Error("a proposal must be showing");
      proposal.proposedAt = 0;
      await pollEditWatch();
    });
    expect(storeState.autoLearn.proposal?.term).toBe("Ralf");

    mount();
    const handler = toastHandlers.at(-1);

    await act(async () => {
      await handler?.({
        action: "auto_learn_reject",
        proposalId: staleId ?? "",
      });
    });
    // Denying the wrong prompt writes a lasting ignore for a term the user never
    // chose to deny, and clears the one they were actually looking at.
    expect(storeState.autoLearn.proposal?.term).toBe("Ralf");
  });

  it("ignores a click that names no prompt at all", async () => {
    await raiseProposal();
    mount();
    const handler = toastHandlers.at(-1);

    // A prompt raised before ids existed, or one whose id the pill could not
    // read back, is uncorrelatable and must not be answered against whatever is
    // current now.
    await act(async () => {
      await handler?.({ action: "auto_learn_accept" });
    });
    expect(createGlossaryTerms).not.toHaveBeenCalled();
  });

  it("stops answering once the watch ends, even for the prompt it raised", async () => {
    const proposalId = await raiseProposal();
    mount();

    await act(async () => {
      endEditWatch();
      await handlerAt(-1)?.({
        action: "auto_learn_accept",
        proposalId: proposalId ?? "",
      });
    });
    expect(createGlossaryTerms).not.toHaveBeenCalled();
  });
});
