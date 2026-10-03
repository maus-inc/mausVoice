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
import { dismissToast, showToast } from "./toast.actions";

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

// `runToast` is kept real on purpose: it is what turns a rejected toast IPC into
// a logged error instead of an unhandled rejection, and stubbing it would let a
// fix that fires a bare `void dismissToast()` pass without ever noticing.
vi.mock("./toast.actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./toast.actions")>()),
  showToast: vi.fn(() => Promise.resolve()),
  dismissToast: vi.fn(() => Promise.resolve()),
}));

// Wrapped rather than stubbed, so the real alignment still runs and the tests
// can count how often a poll paid for it.
const { scanCount } = vi.hoisted(() => ({ scanCount: { value: 0 } }));
vi.mock("../utils/edit-watch.utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/edit-watch.utils")>();
  return {
    ...actual,
    findEditCorrections: (
      ...args: Parameters<typeof actual.findEditCorrections>
    ): ReturnType<typeof actual.findEditCorrections> => {
      scanCount.value += 1;
      return actual.findEditCorrections(...args);
    },
  };
});

vi.mock("../store", () => ({
  getAppState: () => state,
  produceAppState: (recipe: (draft: typeof state) => void) => recipe(state),
}));

const setField = (textContent: string) => {
  invokeMock.mockResolvedValue({ textContent });
};

/** How many times the baseline capture has read the target field. */
const fieldReads = () =>
  invokeMock.mock.calls.filter(([command]) => command === "get_text_field_info")
    .length;

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
  scanCount.value = 0;
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

  it("aligns a settled field once, not on every tick", async () => {
    // `hasSettled` reports true forever once the field stops changing, so
    // without a memo on the field text every 500ms tick paid for the alignment
    // -- up to 601 by 601 cells, 180 times over a three minute watch -- for an
    // idle user.
    beginEditWatch("call Wendell");
    await settleBaseline("call Wendell");

    setField("call Wendell");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);

    expect(state.autoLearn.proposal).toBeNull();
    expect(scanCount.value).toBe(1);
  });

  it("learns from the baseline the settled poll had to adopt", async () => {
    // Every capture read fails, so the watch has no baseline until the field
    // settles. Adopting that first sample finds nothing to correct -- it is the
    // text itself -- and the correction the user makes after it is what the
    // adopted baseline is there to catch.
    invokeMock.mockRejectedValue(new Error("field read timed out"));
    beginEditWatch("call Wendell");
    await vi.advanceTimersByTimeAsync(2_000);

    setField("call Wendell");
    await pollEditWatch();
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal).toBeNull();

    setField("call Wendal");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);

    expect(state.autoLearn.proposal?.term).toBe("Wendal");
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

describe("edit-watch toast supersession", () => {
  it("takes the previous prompt off the pill when a new dictation replaces it", async () => {
    // The proposal id and the native toast are separate objects with separate
    // lifetimes. Clearing the id leaves the toast on screen, so the user is
    // looking at a prompt whose buttons act on a proposal that no longer exists.
    beginEditWatch("my wife's name is Sonia");
    await settleBaseline("my wife's name is Sonia");
    setField("my wife's name is Soniya");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal?.term).toBe("Soniya");
    (dismissToast as ReturnType<typeof vi.fn>).mockClear();

    beginEditWatch("a different dictation entirely");

    expect(dismissToast).toHaveBeenCalledTimes(1);
  });

  it("leaves an expired prompt alone, because its click is still answerable", async () => {
    // The negative control, and the reason the dismiss is not inside
    // `clearVisibleProposalId`. A TTL expiry clears the store proposal while the
    // prompt is still on the pill, and the pill dismisses that toast on its own
    // timer — so the visible id is deliberately NOT cleared on that path, and the
    // click stays answerable.
    //
    // Stated precisely, because I first wrote this comment as "a fix that
    // dismissed on every clear would fail here" and then mutation-tested it: it
    // would not. Moving the dismiss into `clearVisibleProposalId` leaves all 30
    // tests green, because every other caller of it — `endEditWatch`, accept and
    // reject — wants the prompt gone anyway. So this pins the TTL path, not the
    // placement. What it does establish is the property the code relies on: the
    // expiry does not reach `visibleProposalId` at all.
    beginEditWatch("my wife's name is Sonia");
    await settleBaseline("my wife's name is Sonia");
    setField("my wife's name is Soniya");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal?.term).toBe("Soniya");
    (dismissToast as ReturnType<typeof vi.fn>).mockClear();
    (showToast as ReturnType<typeof vi.fn>).mockClear();

    await advanceAndPoll(13_000);

    expect(state.autoLearn.proposal).toBeNull();
    expect(dismissToast).not.toHaveBeenCalled();
  });
});

describe("edit-watch proposal lifecycle", () => {
  it("takes exactly one field read per attempt, then stops", async () => {
    // The capture is a fixed budget of reads spaced by the interval, not a read
    // per turn of a loop that could run long. Counting the reads pins both the
    // number of attempts and that the interval separates them.
    beginEditWatch("call Ralph");
    await vi.advanceTimersByTimeAsync(0);
    expect(fieldReads()).toBe(1);

    // One read is released per interval, so the budget is spent exactly when
    // the last interval elapses.
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      await vi.advanceTimersByTimeAsync(149);
      expect(fieldReads()).toBe(attempt);
      await vi.advanceTimersByTimeAsync(1);
      expect(fieldReads()).toBe(attempt + 1);
    }

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fieldReads()).toBe(8);
  });

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

  it("offers every correction in the same field, not only the first", async () => {
    // One field text can hold several corrections, and the proposal loop below
    // picks among them. The scan memo has to survive an offer for that to mean
    // anything: keyed on the field text before the loop ran, the first candidate
    // froze the field and the rest of the field was never asked about.
    //
    // The words here are unique to this test, because a rejection below is
    // remembered in the session denial set and would otherwise suppress the
    // same corrections in the tests that follow.
    const { createGlossaryTerms } = await import("./dictionary.actions");
    beginEditWatch("email Torvalden and Zsofiann and Marekkkk");
    await settleBaseline("email Torvalden and Zsofiann and Marekkkk");

    setField("email Torvaldenn and Zsofiannn and Marekkkkkk");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal?.term).toBe("Torvaldenn");

    // The user turns the first one down. The field has not moved, so this is
    // the only thing that can bring the next correction into view.
    rejectAutoLearnProposal();
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal?.term).toBe("Zsofiannn");

    // Accepting it is the same story, and must also let the last one through.
    (createGlossaryTerms as ReturnType<typeof vi.fn>).mockClear();
    await acceptAutoLearnProposal();
    expect(createGlossaryTerms).toHaveBeenCalledWith(["Zsofiannn"]);
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal?.term).toBe("Marekkkkkk");

    // Nothing left to offer: the last poll re-ran the scan and found no
    // candidate, so the field is memoized again and stops there.
    await acceptAutoLearnProposal();
    (createGlossaryTerms as ReturnType<typeof vi.fn>).mockClear();
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal).toBeNull();
    expect(createGlossaryTerms).not.toHaveBeenCalled();
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

  it("does not carry a lapsed term across into a later watch", async () => {
    // The held term belongs to the watch that proposed it. A click that arrives
    // after a new dictation has started belongs to that later prompt, and when
    // the later watch has nothing to propose the click falls through to the held
    // term -- which would otherwise add the earlier watch's correction to the
    // dictionary for a prompt the user never answered.
    const { createGlossaryTerms } = await import("./dictionary.actions");
    const earlier = "Quilander";
    beginEditWatch("my wife's name is Sonia");
    await settleBaseline("my wife's name is Sonia");
    setField(`my wife's name is ${earlier}`);
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal?.term).toBe(earlier);

    // The pill's timer runs out with no answer.
    await advanceAndPoll(13_000);
    expect(state.autoLearn.proposal).toBeNull();

    // A new dictation starts and has nothing to correct, so no proposal is
    // pending when the old toast's click lands. The term is dropped at the start
    // of the watch, not compared against it at accept time.
    beginEditWatch("my wife's name is Marisol");
    await settleBaseline("my wife's name is Marisol");
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal).toBeNull();
    (createGlossaryTerms as ReturnType<typeof vi.fn>).mockClear();

    await acceptAutoLearnProposal();

    expect(createGlossaryTerms).not.toHaveBeenCalled();
  });

  it("does not honour a lapsed click once a later dictation has started", async () => {
    // The click arrives to find no proposal, so it falls through to the held
    // term. `activeWatch` cannot be the test here: a later dictation that ended,
    // or that started no watch at all, leaves it null exactly like a watch that
    // merely ended, and only the dictation sequence tells the two apart.
    const { createGlossaryTerms } = await import("./dictionary.actions");
    const unique = "Quillonwood";
    beginEditWatch("my wife's name is Sonia");
    await settleBaseline("my wife's name is Sonia");
    setField(`my wife's name is ${unique}`);
    await advanceAndPoll(1_500);
    await advanceAndPoll(1_500);
    expect(state.autoLearn.proposal?.term).toBe(unique);

    // The pill's timer runs out with no answer, so the term is held for the
    // grace window.
    await advanceAndPoll(13_000);
    expect(state.autoLearn.proposal).toBeNull();

    // The dictation finished, and then a further one landed carrying nothing to
    // watch. Nothing the user is looking at now refers to the held term.
    endEditWatch();
    beginEditWatch("   ");
    (createGlossaryTerms as ReturnType<typeof vi.fn>).mockClear();

    await acceptAutoLearnProposal();

    expect(createGlossaryTerms).not.toHaveBeenCalled();
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
