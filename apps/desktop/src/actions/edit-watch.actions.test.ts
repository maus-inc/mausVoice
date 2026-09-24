import { describe, expect, it, vi } from "vitest";
import {
  acceptAutoLearnProposal,
  beginEditWatch,
  endEditWatch,
  pollEditWatch,
} from "./edit-watch.actions";

const invokeMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  autoLearn: {
    proposal: null as null | { term: string; proposedAt: number },
  },
  termById: {},
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: invokeMock };
});

vi.mock("../utils/user.utils", () => ({
  getMyUserPreferences: () => ({ autoLearnFromEditsEnabled: true }),
}));

vi.mock("../utils/edit-watch.utils", () => ({
  findEditCorrections: vi.fn(() => ["Ralf"]),
}));

vi.mock("../utils/local-storage.utils", () => ({
  getLocalStorage: () => null,
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

const setProposal = (term: string, proposedAt: number) => {
  state.autoLearn.proposal = { term, proposedAt };
};

describe("edit-watch proposal lifecycle", () => {
  it("clears a stale proposal and keeps polling after an ignored toast", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ textContent: "call Ralf tomorrow" });
    beginEditWatch("call ralf tomorrow");
    // The watch is live and the proposal toast has long expired, with no
    // accept or reject ever arriving: only the TTL check in pollEditWatch
    // can clear it now.
    setProposal("Soniya", Date.now() - 60_000);

    await pollEditWatch();

    // The stale proposal no longer blocks the poll: the focused field is
    // read and a fresh proposal (with a new timestamp) replaces it.
    expect(invokeMock).toHaveBeenCalledWith("get_text_field_info");
    expect(state.autoLearn.proposal).toEqual({
      term: "Ralf",
      proposedAt: expect.any(Number),
    });

    endEditWatch();
  });

  it("keeps blocking polls while the proposal toast is still live", async () => {
    invokeMock.mockReset();
    beginEditWatch("call ralf tomorrow");
    // A first poll proposed a term; its toast is now on screen.
    setProposal("Soniya", Date.now());

    await pollEditWatch();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(state.autoLearn.proposal?.term).toBe("Soniya");

    endEditWatch();
  });

  it("a new dictation supersedes a pending proposal", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ textContent: "call Ralf tomorrow" });
    setProposal("Soniya", Date.now());

    beginEditWatch("call ralf tomorrow");
    expect(state.autoLearn.proposal).toBeNull();

    await pollEditWatch();
    expect(invokeMock).toHaveBeenCalledWith("get_text_field_info");

    endEditWatch();
  });

  it("ending the watch clears a pending proposal", () => {
    setProposal("Soniya", Date.now());
    beginEditWatch("hello");
    endEditWatch();
    expect(state.autoLearn.proposal).toBeNull();
  });

  it("accepting a proposal creates a glossary term", async () => {
    const { createGlossaryTerms } = await import("./dictionary.actions");
    invokeMock.mockReset();
    setProposal("Ralf", Date.now());

    await acceptAutoLearnProposal();

    expect(createGlossaryTerms).toHaveBeenCalledWith(["Ralf"]);
    expect(state.autoLearn.proposal).toBeNull();
  });
});
