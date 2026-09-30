import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EDIT_POLL_MS,
  EDIT_QUIESCENCE_MS,
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
// Stands in for a blocked or quota-limited origin, where local storage is
// present but cannot answer.
const storageBlocked = vi.hoisted(() => ({ value: false }));

const DENIED_KEY = "mausvoice:auto-learn-denied";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: invokeMock };
});

vi.mock("../utils/user.utils", () => ({
  getMyUserPreferences: () => ({ autoLearnFromEditsEnabled: true }),
}));

vi.mock("../utils/local-storage.utils", () => ({
  getLocalStorage: () =>
    storageBlocked.value
      ? null
      : {
          getItem: (key: string) => backingStore.get(key) ?? null,
          setItem: (key: string, value: string) => {
            backingStore.set(key, value);
          },
          removeItem: (key: string) => {
            backingStore.delete(key);
          },
        },
}));

// Stable instances so a test can assert on what was actually logged. The
// production helper mints fresh mocks per call, which is exactly why a
// diagnostic that never fires is invisible.
const getLoggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
}));

vi.mock("../utils/log.utils", () => ({
  getLogger: () => getLoggerMock,
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
  // A bare mockReset() leaves the implementation-less mock returning undefined,
  // and beginEditWatch starts the baseline capture synchronously up to its
  // first await. Without a safe default every read throws inside that capture,
  // it dies on attempt 0, and the whole suite passes while the mechanism this
  // change is about never runs.
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ textContent: null });
  backingStore.clear();
  storageBlocked.value = false;
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

    // Steps at the shipped poll cadence. Each keystroke resets the quiet
    // window, so no half-typed fragment is ever offered.
    setField("my wife's name is Son");
    await advanceAndPoll(EDIT_POLL_MS);
    expect(state.autoLearn.proposal).toBeNull();

    setField("my wife's name is Soni");
    await advanceAndPoll(EDIT_POLL_MS);
    expect(state.autoLearn.proposal).toBeNull();

    setField("my wife's name is Soniya");
    await advanceAndPoll(EDIT_POLL_MS);
    expect(state.autoLearn.proposal).toBeNull();

    // Two further polls are still inside the quiet window measured from the
    // last change, so the finished word keeps waiting.
    await advanceAndPoll(EDIT_POLL_MS);
    expect(state.autoLearn.proposal).toBeNull();
    await advanceAndPoll(EDIT_POLL_MS);
    expect(state.autoLearn.proposal).toBeNull();

    // The user stopped typing and the window elapsed. Proposed once.
    await advanceAndPoll(EDIT_POLL_MS);
    expect(state.autoLearn.proposal?.term).toBe("Soniya");
  });

  it("keeps the quiet window longer than a single poll gap", () => {
    // The window is only meaningful while the poll is faster than it. With the
    // poll at or above the window, every second sample would already satisfy
    // it and a user pausing mid-word would be offered a fragment.
    expect(EDIT_POLL_MS).toBeLessThan(EDIT_QUIESCENCE_MS);
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

  it("spends the remaining attempts when a baseline read rejects", async () => {
    // The native command rejects on a timeout, which is the expected failure
    // while the target app is busy. The settled-poll fallback cannot cover the
    // same gap, because its first admissible sample arrives at least a poll
    // after the field went quiet, by which time a fast correction has already
    // replaced the dictation.
    invokeMock
      .mockRejectedValueOnce(new Error("field read timed out"))
      .mockResolvedValue({ textContent: "call Ralph" });

    beginEditWatch("call Ralph");
    await vi.advanceTimersByTimeAsync(400);

    setField("call Ralf");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);

    expect(state.autoLearn.proposal?.term).toBe("Ralf");
  });

  it("replaces a pre-paste baseline once the dictation lands", async () => {
    // The field already holds the dictated text, so the first read latches a
    // pre-paste baseline. The paste then adds a second copy, and the capture
    // has to move the baseline onto it or the correction to the new copy is
    // read as an edit to unrelated text and lost.
    setField("call Ralph");
    invokeMock
      .mockResolvedValueOnce({ textContent: "call Ralph" })
      .mockResolvedValue({ textContent: "call Ralph call Ralph" });

    beginEditWatch("call Ralph");
    await vi.advanceTimersByTimeAsync(400);

    setField("call Ralph call Ralf");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);

    expect(state.autoLearn.proposal?.term).toBe("Ralf");
  });

  it("does not mistake a longer unrelated field for the dictation", async () => {
    // The pre-paste read is the ordinary case: the field does not hold the
    // dictation yet, so the capture must not latch it as the baseline.
    setField("Quarterly Review Board meeting");
    beginEditWatch("call Ralph");
    await vi.advanceTimersByTimeAsync(400);

    setField("Quarterly Review Board meeting call Ralph");
    await advanceAndPoll(1_500);
    setField("Quarterly Review Board meeting call Ralf");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);

    expect(state.autoLearn.proposal?.term).toBe("Ralf");
  });
});

describe("edit-watch proposal lifecycle", () => {
  it("stops offering an expired term for the rest of the watch without blacklisting it", async () => {
    beginEditWatch("my wife's name is Sonia");
    await settleBaseline("my wife's name is Sonia");

    setField("my wife's name is Soniya");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal?.term).toBe("Soniya");

    // The pill hid the toast on its own timer: no accept and no reject ever
    // arrived, so the TTL is the only thing that can clear it. That is not the
    // same as the user saying no, and the toast may never have been shown at
    // all, so nothing durable is written here.
    await advanceAndPoll(13_000);
    expect(state.autoLearn.proposal).toBeNull();
    expect(backingStore.has(DENIED_KEY)).toBe(false);

    // Polling continues, but the identical term is not offered again.
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal).toBeNull();

    // A later dictation is a fresh chance for the same word.
    beginEditWatch("my wife's name is Sonia");
    await settleBaseline("my wife's name is Sonia");
    setField("my wife's name is Soniya");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal?.term).toBe("Soniya");
  });

  it("still proposes a later correction after one has already been offered", async () => {
    // A poll that finds the field unchanged can skip the alignment, because the
    // inputs are identical and so is the answer. This pins the other half of
    // that: a memo keyed on anything other than the field text would let the
    // first correction suppress every one after it.
    //
    // The words here are unique to this test, because the rejection below is
    // remembered in the session denial set and would otherwise suppress the
    // same correction in the tests that follow.
    beginEditWatch("email Torvald and Zsofia");
    await settleBaseline("email Torvald and Zsofia");

    setField("email Torvaldd and Zsofia");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal?.term).toBe("Torvaldd");
    rejectAutoLearnProposal();
    expect(state.autoLearn.proposal).toBeNull();

    // Same watch, a different correction further along the field.
    setField("email Torvaldd and Zsofiaa");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal?.term).toBe("Zsofiaa");
  });

  it("keeps the denial in memory when local storage cannot answer", async () => {
    // A blocked or quota-limited origin leaves nowhere to persist, which would
    // otherwise reinstate the repeat the deny list exists to prevent. A word
    // unique to this test keeps the session copy from leaking into the others.
    storageBlocked.value = true;

    beginEditWatch("call Brendon");
    await settleBaseline("call Brendon");
    setField("call Bryn");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal?.term).toBe("Bryn");

    rejectAutoLearnProposal();
    expect(state.autoLearn.proposal).toBeNull();
    expect(backingStore.has(DENIED_KEY)).toBe(false);

    // Storage answers again, but it never saw the denial, so only the session
    // copy is standing between the user and the same prompt.
    storageBlocked.value = false;
    beginEditWatch("call Brendon");
    await settleBaseline("call Brendon");
    setField("call Bryn");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal).toBeNull();
  });

  it("reports a field too long to align once per dictation, not once per poll", async () => {
    // The bound can only stop offering, never fix, and the field's length does
    // not change while the watch runs. Repeating the line every 500ms would be
    // about 180 identical writes to the native log sink per dictation.
    const filler = "lorem ipsum dolor sit amet consectetur ".repeat(200);
    getLoggerMock.warning.mockClear();
    beginEditWatch("call Ralph");
    setField(`${filler} call Ralph`);
    await advanceAndPoll(1_500);
    setField(`${filler} call Ralf`);
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);

    expect(state.autoLearn.proposal).toBeNull();
    const warnings = getLoggerMock.warning.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("alignment bound"));
    expect(warnings).toHaveLength(1);
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
    // The baseline capture reads the field synchronously inside
    // beginEditWatch, so the mock is cleared again here to make the assertion
    // about the poll rather than about that capture.
    invokeMock.mockClear();
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
    // A word unique to this test: the session copy of the deny list outlives a
    // single case, so reusing a term another case proposes would make this one
    // pass or fail on test order rather than on the behaviour.
    beginEditWatch("call Marlon");
    await settleBaseline("call Marlon");

    setField("call Marlene");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);

    rejectAutoLearnProposal();
    expect(state.autoLearn.proposal).toBeNull();
    expect(JSON.parse(backingStore.get(DENIED_KEY) as string)).toContain(
      "marlene",
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

  it("honours an Add click that lands after the proposal expired", async () => {
    // `proposedAt` is stamped before the toast goes onto the serialised delivery
    // queue, so the TTL can fire while the pill is still on screen. The click
    // then arrived to find no proposal and nothing was added, so a user who saw
    // the prompt and answered it got silence -- and `proposedTerms` meant the
    // correction was never offered again either.
    const { createGlossaryTerms } = await import("./dictionary.actions");
    const unique = "Quillon";
    beginEditWatch("my wife's name is Sonia");
    await settleBaseline("my wife's name is Sonia");

    setField(`my wife's name is ${unique}`);
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal?.term).toBe(unique);

    // The pill's own timer runs out with no accept and no reject.
    await advanceAndPoll(13_000);
    expect(state.autoLearn.proposal).toBeNull();
    (createGlossaryTerms as ReturnType<typeof vi.fn>).mockClear();

    // The user clicks Add on a prompt they can still see.
    await acceptAutoLearnProposal();

    expect(createGlossaryTerms).toHaveBeenCalledWith([unique]);
  });

  it("does not honour a click long after the proposal lapsed", async () => {
    // The grace window exists so a stray click cannot accept a term from a
    // prompt that ended long ago.
    const { createGlossaryTerms } = await import("./dictionary.actions");
    const unique = "Quillory";
    beginEditWatch("my wife's name is Sonia");
    await settleBaseline("my wife's name is Sonia");

    setField(`my wife's name is ${unique}`);
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal?.term).toBe(unique);
    await advanceAndPoll(13_000);
    expect(state.autoLearn.proposal).toBeNull();
    (createGlossaryTerms as ReturnType<typeof vi.fn>).mockClear();

    // Well past the grace window.
    await advanceAndPoll(60_000);
    await acceptAutoLearnProposal();

    expect(createGlossaryTerms).not.toHaveBeenCalled();
  });
});
