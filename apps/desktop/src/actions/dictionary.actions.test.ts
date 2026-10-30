import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Term } from "@maus-inc/types";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";

const termMocks = vi.hoisted(() => ({
  createTerm: vi.fn(),
  listTerms: vi.fn(),
  setLocalStorageValue: vi.fn(),
  warning: vi.fn(),
  nextId: 0,
}));

vi.mock("../repos", () => ({
  getTermRepo: () => ({
    createTerm: termMocks.createTerm,
    listTerms: termMocks.listTerms,
  }),
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

import { createGlossaryTerms, loadDictionary } from "./dictionary.actions";

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

describe("dictionary list reads during writes", () => {
  beforeEach(seed);
  it("keeps an optimistic new term while its creation is pending", async () => {
    let release!: (value: Term) => void;
    let created!: Term;
    termMocks.createTerm.mockImplementation((term: Term) => {
      created = term;
      return new Promise<Term>((resolve) => {
        release = resolve;
      });
    });
    termMocks.listTerms.mockImplementation(async () =>
      created ? [created] : [],
    );
    const creation = createGlossaryTerms(["new word"]);
    await vi.waitFor(() => expect(termMocks.createTerm).toHaveBeenCalled());
    const loading = loadDictionary();
    await Promise.resolve();
    await Promise.resolve();
    expect(sources()).toEqual(["new word"]);
    release(created);
    await creation;
    await loading;
    expect(sources()).toEqual(["new word"]);
  });

  it("retries an older in-flight list after a new term is saved", async () => {
    let resolveOld!: (terms: Term[]) => void;
    let saved!: Term;
    termMocks.listTerms
      .mockImplementationOnce(
        () =>
          new Promise<Term[]>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementation(async () => [saved]);
    termMocks.createTerm.mockImplementation(async (term: Term) => {
      saved = term;
      return term;
    });
    const loading = loadDictionary();
    await vi.waitFor(() =>
      expect(termMocks.listTerms).toHaveBeenCalledTimes(1),
    );
    await createGlossaryTerms(["new word"]);
    resolveOld([]);
    await loading;
    expect(termMocks.listTerms).toHaveBeenCalledTimes(2);
    expect(sources()).toEqual(["new word"]);
  });
});
