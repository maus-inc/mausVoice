import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Term } from "@maus-inc/types";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";

const termMocks = vi.hoisted(() => ({
  createTerm: vi.fn(),
  setLocalStorageValue: vi.fn(),
  warning: vi.fn(),
  nextId: 0,
}));

vi.mock("../repos", () => ({
  getTermRepo: () => ({ createTerm: termMocks.createTerm }),
}));

vi.mock("./local-storage.actions", () => ({
  setLocalStorageValue: termMocks.setLocalStorageValue,
}));

vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warning: termMocks.warning,
    error: vi.fn(),
    verbose: vi.fn(),
  }),
}));

// Deterministic ids: the dictionary's list order is built from them, so a
// random id would make the ordering assertions meaningless.
vi.mock("../utils/id.utils", () => ({
  createId: () => `id-${(termMocks.nextId += 1)}`,
}));

import { createGlossaryTerms } from "./dictionary.actions";

const persistAs = (term: Term): Promise<Term> => Promise.resolve(term);

const seed = () => {
  termMocks.nextId = 0;
  vi.clearAllMocks();
  termMocks.setLocalStorageValue.mockImplementation(() => undefined);
  setAppState(structuredClone(INITIAL_APP_STATE), true);
};

const sources = () =>
  getAppState().dictionary.termIds.map(
    (id) => getAppState().termById[id]?.sourceValue,
  );

describe("createGlossaryTerms", () => {
  beforeEach(seed);

  it("adds each value as its own glossary term", async () => {
    termMocks.createTerm.mockImplementation(persistAs);

    await expect(createGlossaryTerms(["Ralf", "Kubernetes"])).resolves.toEqual({
      created: [
        expect.objectContaining({ id: "id-1", sourceValue: "Ralf" }),
        expect.objectContaining({ id: "id-2", sourceValue: "Kubernetes" }),
      ],
      failed: 0,
    });

    expect(termMocks.createTerm).toHaveBeenCalledTimes(2);
    expect(sources()).toEqual(["Kubernetes", "Ralf"]);
    expect(
      termMocks.setLocalStorageValue.mock.calls.map(([key]) => key),
    ).toEqual([
      "mausvoice:checklist-dictionary",
      "mausvoice:checklist-dictionary",
    ]);
  });

  it("keeps persisted terms when the onboarding checklist update fails", async () => {
    termMocks.createTerm.mockImplementation(persistAs);
    termMocks.setLocalStorageValue.mockImplementationOnce(() => {
      throw new Error("checklist unavailable");
    });
    const result = await createGlossaryTerms(["Ada", "Lagos"]);
    expect(result.created.map((term) => term.sourceValue)).toEqual([
      "Ada",
      "Lagos",
    ]);
    expect(result.failed).toBe(0);
    expect(sources()).toEqual(["Lagos", "Ada"]);
    expect(termMocks.warning).toHaveBeenCalledOnce();
  });

  it("skips a value that is only whitespace", async () => {
    termMocks.createTerm.mockImplementation(persistAs);

    await expect(createGlossaryTerms(["  ", "Ralf", ""])).resolves.toEqual({
      created: [expect.objectContaining({ id: "id-1", sourceValue: "Ralf" })],
      failed: 0,
    });

    expect(termMocks.createTerm).toHaveBeenCalledTimes(1);
    expect(sources()).toEqual(["Ralf"]);
  });

  it("rolls one term back and keeps the rest", async () => {
    termMocks.createTerm.mockImplementation((term: Term) =>
      term.sourceValue === "Kubernetes"
        ? Promise.reject(new Error("write refused"))
        : Promise.resolve(term),
    );

    const result = await createGlossaryTerms([
      "Ralf",
      "Kubernetes",
      "BigQuery",
    ]);

    expect(result.failed).toBe(1);
    expect(result.created.map((t) => t.sourceValue)).toEqual([
      "Ralf",
      "BigQuery",
    ]);
    // The failed term left nothing behind, and the surviving two keep the
    // reverse-of-input order the list is built by.
    expect(sources()).toEqual(["BigQuery", "Ralf"]);
    expect(termMocks.warning).toHaveBeenCalledTimes(1);
    expect(termMocks.setLocalStorageValue).toHaveBeenCalledTimes(2);
  });

  it.each(["resolve", "reject"] as const)(
    "retires an in-flight guarded term when the write %ss",
    async (outcome) => {
      let finish!: (value: Term) => void;
      let fail!: (error: Error) => void;
      termMocks.createTerm.mockReturnValueOnce(
        new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
      );
      let active = true;
      const pending = createGlossaryTerms(["Ada", "Lagos"], () => active);
      await vi.waitFor(() =>
        expect(termMocks.createTerm).toHaveBeenCalledOnce(),
      );
      const term = termMocks.createTerm.mock.calls[0][0] as Term;
      active = false;
      if (outcome === "resolve") finish(term);
      else fail(new Error("retired"));
      await expect(pending).resolves.toEqual({ created: [], failed: 0 });
      expect(termMocks.createTerm).toHaveBeenCalledOnce();
      expect(sources()).toEqual([]);
      expect(termMocks.setLocalStorageValue).not.toHaveBeenCalled();
      expect(termMocks.warning).not.toHaveBeenCalled();
    },
  );

  it("adds one value at a time, in the order given", async () => {
    const inFlight: string[] = [];
    const peak: string[] = [];
    termMocks.createTerm.mockImplementation(async (term: Term) => {
      inFlight.push(term.sourceValue);
      peak.push([...inFlight].join(","));
      await Promise.resolve();
      inFlight.pop();
      return term;
    });

    await createGlossaryTerms(["a", "b", "c"]);

    expect(peak).toEqual(["a", "b", "c"]);
  });
});
