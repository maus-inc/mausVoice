// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  show: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../actions/auto-learn.actions", () => ({
  saveCorrectedTranscript: mocks.save,
  CorrectionRetiredError: class CorrectionRetiredError extends Error {},
}));
vi.mock("../../actions/app.actions", () => ({
  showSnackbar: mocks.show,
  showErrorSnackbar: mocks.error,
}));
vi.mock("react-intl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-intl")>()),
  useIntl: () => ({}),
}));
vi.mock("./correction-feedback.utils", () => ({
  correctionFeedback: () => ({ message: "saved", mode: "success" }),
}));
import { useFinalTranscriptEditor } from "./useFinalTranscriptEditor";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let current: ReturnType<typeof useFinalTranscriptEditor>;
const Harness = ({
  open = true,
  id = "one",
  text = "original",
}: {
  open?: boolean;
  id?: string;
  text?: string;
}) => {
  current = useFinalTranscriptEditor(open, id, text);
  return current.isEditingFinal ? (
    <textarea
      ref={current.finalDraftRef}
      value={current.finalDraft}
      onChange={() => undefined}
    />
  ) : null;
};

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
});
const render = async (props = {}) => {
  await act(async () => root.render(<Harness {...props} />));
};

describe("useFinalTranscriptEditor", () => {
  it("focuses the draft and avoids writes for unchanged trimmed text", async () => {
    await render();
    act(() => current.startEditingFinal());
    expect(document.activeElement).toBe(container.querySelector("textarea"));
    act(() => current.setFinalDraft(" original "));
    await act(async () => {
      await current.handleSaveFinal();
    });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(current.isEditingFinal).toBe(false);
    expect(current.finalDraft).toBe("");
  });

  it("locks duplicate same-render saves and reports success", async () => {
    let release: (value: unknown) => void = () => {};
    mocks.save.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await render();
    act(() => current.startEditingFinal());
    act(() => current.setFinalDraft("corrected"));
    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    act(() => {
      first = current.handleSaveFinal();
      second = current.handleSaveFinal();
    });
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
      transcriptionId: "one",
      correctedText: "corrected",
    });
    expect(current.isSavingFinal).toBe(true);
    await act(async () => {
      release({});
      await Promise.all([first, second]);
    });
    expect(current.isSavingFinal).toBe(false);
    expect(current.isEditingFinal).toBe(false);
    expect(mocks.show).toHaveBeenCalledExactlyOnceWith("saved", {
      mode: "success",
    });
  });

  it("does not clear a new transcription's draft when an old save completes", async () => {
    let release: (value: unknown) => void = () => {};
    mocks.save.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await render();
    act(() => current.startEditingFinal());
    act(() => current.setFinalDraft("first correction"));
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = current.handleSaveFinal();
    });
    await render({ id: "two", text: "second" });
    act(() => current.startEditingFinal());
    act(() => current.setFinalDraft("second correction"));
    await act(async () => {
      release({});
      await pending;
    });
    expect(current.isEditingFinal).toBe(true);
    expect(current.finalDraft).toBe("second correction");
    expect(current.isSavingFinal).toBe(false);
  });

  it.each(["resolve", "reject"] as const)(
    "does not publish a save that %ss after the editor unmounts",
    async (outcome) => {
      let finish!: (value: unknown) => void;
      let fail!: (error: Error) => void;
      mocks.save.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finish = resolve;
            fail = reject;
          }),
      );
      await render();
      act(() => current.startEditingFinal());
      act(() => current.setFinalDraft("corrected"));
      let pending!: Promise<void>;
      act(() => {
        pending = current.handleSaveFinal();
      });
      act(() => root.unmount());
      await act(async () => {
        if (outcome === "resolve") finish({});
        else fail(new Error("old failure"));
        await pending;
      });
      expect(mocks.show).not.toHaveBeenCalled();
      expect(mocks.error).not.toHaveBeenCalled();
    },
  );

  it("clears a draft when the auth session changes", async () => {
    await render();
    act(() => current.startEditingFinal());
    act(() => current.setFinalDraft("private draft"));
    await act(async () => setAppState({ authSessionNonce: 1 }));
    expect(current.isEditingFinal).toBe(false);
    expect(current.finalDraft).toBe("");
  });

  it.each(["resolve", "reject"] as const)(
    "does not report a previous account's save when it %ss",
    async (outcome) => {
      let finish!: (value: unknown) => void;
      let fail!: (error: Error) => void;
      mocks.save.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finish = resolve;
            fail = reject;
          }),
      );
      await render();
      act(() => current.startEditingFinal());
      act(() => current.setFinalDraft("corrected"));
      let pending!: Promise<void>;
      act(() => {
        pending = current.handleSaveFinal();
      });
      await act(async () => {
        setAppState({ authSessionNonce: 1 });
        if (outcome === "resolve") finish({});
        else fail(new Error("old failure"));
        await pending;
      });
      expect(mocks.show).not.toHaveBeenCalled();
      expect(mocks.error).not.toHaveBeenCalled();
    },
  );

  it("keeps the draft after a failure and resets it when the transcription changes", async () => {
    const error = new Error("offline");
    mocks.save.mockRejectedValueOnce(error);
    await render();
    act(() => current.startEditingFinal());
    act(() => current.setFinalDraft("corrected"));
    await act(async () => {
      await current.handleSaveFinal();
    });
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith(error);
    expect(current.isEditingFinal).toBe(true);
    expect(current.finalDraft).toBe("corrected");
    expect(current.isSavingFinal).toBe(false);
    await render({ id: "two" });
    expect(current.isEditingFinal).toBe(false);
    expect(current.finalDraft).toBe("");
  });
});
