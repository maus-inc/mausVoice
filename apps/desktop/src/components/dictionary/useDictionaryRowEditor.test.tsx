// @vitest-environment jsdom
import { act, type ChangeEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Term } from "@maus-inc/types";
import { INITIAL_APP_STATE } from "../../state/app.state";
import {
  getAppState,
  produceAppState,
  setAppState,
  useAppStore,
} from "../../store";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  delete: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../repos", () => ({
  getTermRepo: () => ({ updateTerm: mocks.update, deleteTerm: mocks.delete }),
}));
vi.mock("../../actions/app.actions", () => ({
  showErrorSnackbar: mocks.error,
}));
import { useDictionaryRowEditor } from "./useDictionaryRowEditor";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const term = {
  id: "one",
  sourceValue: "original",
  destinationValue: "replacement",
  isReplacement: true,
} as Term;
let root: Root;
let container: HTMLDivElement;
let editor: ReturnType<typeof useDictionaryRowEditor>;
const Harness = () => {
  const current = useAppStore((state) => state.termById.one);
  editor = useDictionaryRowEditor("one", current);
  return null;
};
const change = (field: "source" | "destination", value: string) => {
  act(() =>
    editor.handleFieldChange(field)({
      target: { value },
    } as ChangeEvent<HTMLInputElement>),
  );
};

beforeEach(() => {
  vi.resetAllMocks();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  produceAppState((draft) => {
    draft.termById.one = term;
    draft.dictionary.termIds = ["one", "other"];
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
});

describe("useDictionaryRowEditor", () => {
  it("does not persist an unchanged draft and optimistically commits edits", async () => {
    await act(async () => editor.handleCommit());
    expect(mocks.update).not.toHaveBeenCalled();
    change("source", "updated");
    change("destination", "new value");
    let resolve!: () => void;
    mocks.update.mockReturnValue(
      new Promise<void>((r) => {
        resolve = r;
      }),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = editor.handleCommit();
    });
    expect(getAppState().termById.one).toMatchObject({
      sourceValue: "updated",
      destinationValue: "new value",
    });
    expect(mocks.update).toHaveBeenCalledOnce();
    await act(async () => {
      resolve();
      await pending;
    });
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("restores both fields and the term if a commit fails", async () => {
    const error = new Error("save failed");
    mocks.update.mockRejectedValue(error);
    change("source", "edited");
    change("destination", "edited too");
    await act(async () => editor.handleCommit());
    expect(getAppState().termById.one).toEqual(term);
    expect(editor.sourceValue).toBe("original");
    expect(editor.destinationValue).toBe("replacement");
    expect(mocks.error).toHaveBeenCalledWith(error);
  });

  it("restores the term and ordered ids if deletion fails", async () => {
    const error = new Error("delete failed");
    let reject!: (reason: unknown) => void;
    mocks.delete.mockReturnValue(
      new Promise<void>((_, r) => {
        reject = r;
      }),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = editor.handleDelete();
    });
    expect(getAppState().termById.one).toBeUndefined();
    expect(getAppState().dictionary.termIds).toEqual(["other"]);
    await act(async () => {
      reject(error);
      await pending;
    });
    expect(getAppState().termById.one).toEqual(term);
    expect(getAppState().dictionary.termIds).toEqual(["one", "other"]);
    expect(mocks.error).toHaveBeenCalledWith(error);
  });
});
