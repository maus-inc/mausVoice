import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptAutoLearnProposal,
  beginEditWatch,
  endEditWatch,
  pollEditWatch,
  rejectAutoLearnProposal,
} from "./edit-watch.actions";

const invokeMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  autoLearn: {
    proposal: null as null | { term: string; proposedAt: number },
  },
  termById: {},
}));
const backingStore = vi.hoisted(() => new Map<string, string>());

const DENIED_KEY = "mausvoice:auto-learn-denied";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: invokeMock };
});

vi.mock("../utils/user.utils", () => ({
  getMyUserPreferences: () => ({ autoLearnFromEditsEnabled: true }),
}));

vi.mock("../utils/local-storage.utils", () => ({
  getLocalStorage: () => ({
    getItem: (key: string) => backingStore.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backingStore.set(key, value);
    },
    removeItem: (key: string) => {
      backingStore.delete(key);
    },
  }),
}));

vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  }),
}));

vi.mock("../i18n/intl", () => ({
  getIntl: () => ({
    formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  }),
}));

vi.mock("./dictionary.actions", () => ({
  createGlossaryTerms: vi.fn().mockResolvedValue({ created: [], failed: 0 }),
}));

vi.mock("./toast.actions", () => ({
  showToast: vi.fn(() => Promise.resolve()),
}));

vi.mock("../store", () => ({
  getAppState: () => state,
  produceAppState: (recipe: (draft: typeof state) => void) => recipe(state),
}));

const setField = (textContent: string) => {
  invokeMock.mockResolvedValue({ textContent });
};

/** Moves the clock the way the poll interval would, then polls once. */
const advanceAndPoll = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await pollEditWatch();
};

/** Lets the dictation land and become the baseline the watcher diffs against. */
const settleBaseline = async (fieldText: string) => {
  setField(fieldText);
  await pollEditWatch();
  await advanceAndPoll(1_500);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  invokeMock.mockReset();
  backingStore.clear();
  state.autoLearn.proposal = null;
});

afterEach(() => {
  endEditWatch();
  vi.useRealTimers();
});

describe("edit-watch edit quiescence", () => {
  it("proposes only once the field has stopped changing", async () => {
    beginEditWatch("my wife's name is Sonia");
    await settleBaseline("my wife's name is Sonia");
    expect(state.autoLearn.proposal).toBeNull();

    // Each keystroke resets the quiet window, so no half-typed fragment is
    // ever offered.
    setField("my wife's name is Son");
    await advanceAndPoll(300);
    expect(state.autoLearn.proposal).toBeNull();

    setField("my wife's name is Soni");
    await advanceAndPoll(300);
    expect(state.autoLearn.proposal).toBeNull();

    setField("my wife's name is Soniya");
    await advanceAndPoll(300);
    expect(state.autoLearn.proposal).toBeNull();

    // The user stopped typing. The finished word is proposed once.
    await advanceAndPoll(1_300);
    expect(state.autoLearn.proposal?.term).toBe("Soniya");
  });

  it("records a changed sample without proposing while inside the quiet window", async () => {
    beginEditWatch("call Ralph");
    await settleBaseline("call Ralph");

    setField("call Ralf");
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal).toBeNull();

    await advanceAndPoll(400);
    expect(state.autoLearn.proposal).toBeNull();

    await advanceAndPoll(900);
    expect(state.autoLearn.proposal?.term).toBe("Ralf");
  });
});

describe("edit-watch baseline", () => {
  it("proposes nothing when the focused field never received the dictation", async () => {
    beginEditWatch("my wife's name is Sonia");
    setField("Quarterly Review Board meeting tomorrow at ten");

    await pollEditWatch();
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);

    expect(state.autoLearn.proposal).toBeNull();
  });

  it("never proposes words that were on screen before the dictation", async () => {
    beginEditWatch("send the report to Ralf today");
    await settleBaseline(
      "Quarterly Report Mausvoice send the report to Ralf today",
    );

    setField("Quarterly Report Mausvoice send the report to Raul today");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);

    expect(state.autoLearn.proposal?.term).toBe("Raul");
  });

  it("learns a correction the user finishes before the first watcher sample", async () => {
    // The paste lands, then the user corrects the word immediately. The first
    // 1.5s poll only ever sees the already-corrected field, so the baseline has
    // to come from the capture that runs when the dictation lands.
    setField("my wife's name is Sonia");
    beginEditWatch("my wife's name is Sonia");
    setField("my wife's name is Soniya");

    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);

    expect(state.autoLearn.proposal?.term).toBe("Soniya");
  });

  it("retries the baseline capture until the paste lands", async () => {
    // The first read races the paste and returns the pre-paste field.
    invokeMock
      .mockResolvedValueOnce({ textContent: "earlier document text" })
      .mockResolvedValue({ textContent: "call Ralph" });

    beginEditWatch("call Ralph");
    await vi.advanceTimersByTimeAsync(400);

    setField("call Ralf");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);

    expect(state.autoLearn.proposal?.term).toBe("Ralf");
  });
});

describe("edit-watch proposal lifecycle", () => {
  it("remembers a term whose toast expired unanswered instead of looping", async () => {
    beginEditWatch("my wife's name is Sonia");
    await settleBaseline("my wife's name is Sonia");

    setField("my wife's name is Soniya");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal?.term).toBe("Soniya");

    // The pill hid the toast on its own timer: no accept and no reject ever
    // arrived, so the TTL is the only thing that can clear it.
    await advanceAndPoll(13_000);
    expect(state.autoLearn.proposal).toBeNull();
    expect(JSON.parse(backingStore.get(DENIED_KEY) as string)).toContain(
      "soniya",
    );

    // Polling continues, but the identical term is not offered again.
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal).toBeNull();
  });

  it("keeps blocking polls while the proposal toast is still live", async () => {
    beginEditWatch("call Ralph");
    await settleBaseline("call Ralph");

    setField("call Ralf");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal?.term).toBe("Ralf");

    invokeMock.mockClear();
    await advanceAndPoll(1_500);

    expect(invokeMock).not.toHaveBeenCalled();
    expect(state.autoLearn.proposal?.term).toBe("Ralf");
  });

  it("drops a poll that resolves after a newer dictation replaced the watch", async () => {
    beginEditWatch("call Ralph");
    await settleBaseline("call Ralph");

    setField("call Ralf");
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal).toBeNull();

    // The native read is in flight while the next dictation lands. The stale
    // sample must not produce a proposal against the superseded dictation.
    let release: (value: { textContent: string }) => void = () => undefined;
    invokeMock.mockReturnValue(
      new Promise<{ textContent: string }>((resolve) => {
        release = resolve;
      }),
    );

    const inFlight = pollEditWatch();
    vi.advanceTimersByTime(1_500);
    beginEditWatch("my wife's name is Sonia");
    release({ textContent: "call Ralf" });
    await inFlight;

    expect(state.autoLearn.proposal).toBeNull();
  });

  it("a new dictation supersedes a pending proposal", async () => {
    beginEditWatch("call Ralph");
    await settleBaseline("call Ralph");

    setField("call Ralf");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal?.term).toBe("Ralf");

    invokeMock.mockClear();
    beginEditWatch("my wife's name is Sonia");
    expect(state.autoLearn.proposal).toBeNull();

    // The superseded watch starts over: the first poll only records a sample.
    await pollEditWatch();
    expect(invokeMock).toHaveBeenCalledWith("get_text_field_info");
    expect(state.autoLearn.proposal).toBeNull();
  });

  it("ending the watch clears a pending proposal", async () => {
    beginEditWatch("call Ralph");
    await settleBaseline("call Ralph");

    setField("call Ralf");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal?.term).toBe("Ralf");

    endEditWatch();
    expect(state.autoLearn.proposal).toBeNull();
  });

  it("rejecting a proposal records the denial", async () => {
    beginEditWatch("call Ralph");
    await settleBaseline("call Ralph");

    setField("call Ralf");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);

    rejectAutoLearnProposal();
    expect(state.autoLearn.proposal).toBeNull();
    expect(JSON.parse(backingStore.get(DENIED_KEY) as string)).toContain(
      "ralf",
    );

    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal).toBeNull();
  });

  it("accepting a proposal creates a glossary term", async () => {
    const { createGlossaryTerms } = await import("./dictionary.actions");
    state.autoLearn.proposal = { term: "Ralf", proposedAt: Date.now() };

    await acceptAutoLearnProposal();

    expect(createGlossaryTerms).toHaveBeenCalledWith(["Ralf"]);
    expect(state.autoLearn.proposal).toBeNull();
  });
});
