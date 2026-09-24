// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  upsertToneMock,
  deleteToneMock,
  closeToneEditorDialogMock,
  setAppTargetToneMock,
  generateTextMock,
  getGenerateTextRepoMock,
} = vi.hoisted(() => ({
  getGenerateTextRepoMock: vi.fn(),
  upsertToneMock: vi.fn(async (tone: unknown) => tone),
  deleteToneMock: vi.fn(async (): Promise<void> => undefined),
  closeToneEditorDialogMock: vi.fn(),
  setAppTargetToneMock: vi.fn(async () => true),
  generateTextMock: vi.fn(async (..._args: unknown[]) => ({
    text: '{"result": "Styled sample!"}',
  })),
}));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  const mock = await reactIntlMockModule(importOriginal);
  return {
    ...mock,
    useIntl: () => {
      const intl = mock.useIntl();
      return {
        ...intl,
        formatMessage: (descriptor: import("react-intl").MessageDescriptor) =>
          descriptor.id ===
          "i_just_got_back_from_the_store_and_uh_we_need_milk_eggs_and"
            ? "exemple de dictée"
            : intl.formatMessage(descriptor),
      };
    },
  };
});

vi.mock("../../actions/tone.actions", () => ({
  upsertTone: upsertToneMock,
  deleteTone: deleteToneMock,
  closeToneEditorDialog: closeToneEditorDialogMock,
}));

vi.mock("../../actions/app-target.actions", () => ({
  setAppTargetTone: setAppTargetToneMock,
}));

vi.mock("../../repos", () => ({
  getGenerateTextRepo: () => getGenerateTextRepoMock(),
}));

import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, setAppState } from "../../store";
import { ToneEditorDialog } from "./ToneEditorDialog";

import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";

ensureUiHarness();

let container: HTMLDivElement;
let root: Root;

const seedCreate = () => {
  const state = structuredClone(INITIAL_APP_STATE);
  state.toneEditor = {
    open: true,
    mode: "create",
    toneId: null,
    targetId: null,
  };
  state.toneById = {};
  setAppState(state, true);
};

const seedEdit = () => {
  const state = structuredClone(INITIAL_APP_STATE);
  state.toneEditor = {
    open: true,
    mode: "edit",
    toneId: "tone1",
    targetId: null,
  };
  state.toneById = {
    tone1: {
      id: "tone1",
      name: "My Style",
      promptTemplate: "Write plainly.",
      isSystem: false,
      createdAt: 0,
      sortOrder: 0,
      category: "notes",
    },
  };
  setAppState(state, true);
};

beforeEach(() => {
  vi.clearAllMocks();
  generateTextMock
    .mockReset()
    .mockResolvedValue({ text: '{"result": "Styled sample!"}' });
  getGenerateTextRepoMock
    .mockReset()
    .mockReturnValue({ repo: { generateText: generateTextMock } });
  setMatchMedia(false);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const renderDialog = () => {
  act(() => {
    root.render(createElement(ToneEditorDialog));
  });
};

const typeInto = (el: HTMLInputElement | HTMLTextAreaElement, text: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const fieldByPlaceholder = (placeholder: string) =>
  document.querySelector(
    `input[placeholder="${placeholder}"], textarea[placeholder="${placeholder}"]`,
  ) as HTMLInputElement | HTMLTextAreaElement | null;

const buttonByText = (text: string, small = false) =>
  Array.from(document.querySelectorAll("button")).find(
    (el) =>
      el.textContent?.trim() === text &&
      (small ? el.classList.contains("MuiButton-sizeSmall") : true),
  ) as HTMLElement | undefined;

describe("ToneEditorDialog create wizard", () => {
  it.each(["create", "edit"])(
    "initializes and submits a localized sample in %s mode",
    async (mode) => {
      if (mode === "create") seedCreate();
      else seedEdit();
      renderDialog();
      if (mode === "create") {
        typeInto(fieldByPlaceholder("Casual, Formal, Business...")!, "Casual");
        act(() => buttonByText("Next")!.click());
        typeInto(document.querySelector("textarea")!, "Sound casual.");
        await act(async () => buttonByText("Next")!.click());
      } else {
        await act(async () => buttonByText("Run preview", true)!.click());
      }
      const sample = fieldByPlaceholder("Sample dictation to restyle...")!;
      expect(sample.value).toBe("exemple de dictée");
      expect(sample.getAttribute("maxlength")).toBe("8000");
      expect(
        Array.from(sample.labels ?? [], (label) => label.textContent),
      ).toContain("Sample dictation to restyle...");
      expect(generateTextMock.mock.calls.at(-1)?.[0]).toMatchObject({
        prompt: expect.stringContaining("exemple de dictée"),
      });
      typeInto(sample, "Mon propre texte");
      renderDialog();
      expect(sample.value).toBe("Mon propre texte");
      typeInto(sample, "");
      await act(async () => buttonByText("Run preview", true)!.click());
      expect(generateTextMock.mock.calls.at(-1)?.[0]).toMatchObject({
        prompt: expect.stringContaining("exemple de dictée"),
      });
    },
  );
  it.each(["done", "running"] as const)(
    "invalidates a %s preview when the sample changes",
    async (status) => {
      seedCreate();
      renderDialog();
      typeInto(fieldByPlaceholder("Casual, Formal, Business...")!, "Casual");
      act(() => buttonByText("Next")!.click());
      typeInto(document.querySelector("textarea")!, "Sound casual.");
      let finishOld!: (value: { text: string }) => void;
      if (status === "running")
        generateTextMock.mockReturnValueOnce(
          new Promise((resolve) => {
            finishOld = resolve;
          }),
        );
      await act(async () => buttonByText("Next")!.click());
      if (status === "done")
        expect(document.body.textContent).toContain("Styled sample!");
      typeInto(document.querySelector("textarea")!, "A different sample.");
      expect(document.body.textContent).not.toContain("Styled sample!");
      expect(document.body.textContent).not.toContain("Styling the sample...");
      if (status === "running")
        await act(async () => finishOld({ text: "obsolete result" }));
      expect(document.body.textContent).not.toContain("obsolete result");
      generateTextMock.mockResolvedValueOnce({ text: "Fresh preview" });
      await act(async () => buttonByText("Run preview", true)!.click());
      expect(document.body.textContent).toContain("Fresh preview");
      expect(generateTextMock).toHaveBeenCalledTimes(2);
    },
  );

  it("starts on Define with Next blocked until a name is typed", () => {
    seedCreate();
    renderDialog();

    expect(document.body.textContent).toContain("Define");
    const next = buttonByText("Next");
    expect(next?.getAttribute("disabled")).not.toBeNull();

    const name = fieldByPlaceholder("Casual, Formal, Business...");
    expect(name).toBeTruthy();
    expect(document.activeElement).toBe(name);
    typeInto(name!, "Casual");
    expect(buttonByText("Next")?.getAttribute("disabled")).toBeNull();
  });

  it("moves Define to Tune to Test and back with the stepper", async () => {
    seedCreate();
    renderDialog();

    typeInto(fieldByPlaceholder("Casual, Formal, Business...")!, "Casual");
    act(() => {
      buttonByText("Next")!.click();
    });
    expect(document.body.textContent).toContain("Tune");
    expect(document.activeElement?.getAttribute("placeholder")).toContain(
      "professional but friendly",
    );

    typeInto(
      document.querySelector("textarea") as HTMLTextAreaElement,
      "Sound casual.",
    );
    await act(async () => {
      buttonByText("Next")!.click();
    });
    expect(document.body.textContent).toContain("Test and review");
    expect(document.body.textContent).toContain("Styled sample!");

    // Back returns to Tune with fields intact, and completed steps stay
    // clickable buttons for keyboard and pointer users alike.
    act(() => {
      buttonByText("Back")!.click();
    });
    expect(document.body.textContent).toContain("Tune");

    const defineStep = Array.from(document.querySelectorAll("button")).find(
      (el) => el.textContent?.trim() === "Define",
    ) as HTMLElement;
    expect(defineStep).toBeTruthy();
    act(() => {
      defineStep.click();
    });
    expect(
      (fieldByPlaceholder("Casual, Formal, Business...") as HTMLInputElement)
        ?.value,
    ).toBe("Casual");
  });

  it("creates the style from the review step and closes", async () => {
    seedCreate();
    renderDialog();

    typeInto(fieldByPlaceholder("Casual, Formal, Business...")!, "Casual");
    act(() => {
      buttonByText("Next")!.click();
    });
    typeInto(
      document.querySelector("textarea") as HTMLTextAreaElement,
      "Sound casual.",
    );
    await act(async () => {
      buttonByText("Next")!.click();
    });

    await act(async () => {
      buttonByText("Create")!.click();
    });
    expect(upsertToneMock).toHaveBeenCalledTimes(1);
    expect(upsertToneMock.mock.calls[0][0]).toMatchObject({
      name: "Casual",
      promptTemplate: "Sound casual.",
    });
    expect(closeToneEditorDialogMock).toHaveBeenCalled();
  });

  it("retains the draft after a failed create and retries the same style", async () => {
    seedCreate();
    renderDialog();
    const name = fieldByPlaceholder("Casual, Formal, Business...");
    if (!name) throw new Error("Expected the style name field");
    typeInto(name, "Keep this style");
    act(() => buttonByText("Next")?.click());
    const prompt = document.querySelector("textarea");
    if (!prompt) throw new Error("Expected the style prompt field");
    typeInto(prompt, "Keep this prompt");
    await act(async () => buttonByText("Next")?.click());

    upsertToneMock.mockRejectedValueOnce(new Error("Storage unavailable"));
    await act(async () => buttonByText("Create")?.click());
    expect(closeToneEditorDialogMock).not.toHaveBeenCalled();
    expect(buttonByText("Create")?.getAttribute("disabled")).toBeNull();

    await act(async () => buttonByText("Create")?.click());
    expect(upsertToneMock).toHaveBeenCalledTimes(2);
    const first = upsertToneMock.mock.calls[0][0];
    const retried = upsertToneMock.mock.calls[1][0];
    expect(retried).toEqual(first);
    expect(retried).toMatchObject({
      name: "Keep this style",
      promptTemplate: "Keep this prompt",
    });
    expect(closeToneEditorDialogMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the created style when app activation fails and retries the same identity", async () => {
    seedCreate();
    const state = structuredClone(getAppState());
    state.toneEditor.targetId = "app";
    setAppState(state, true);
    renderDialog();
    typeInto(fieldByPlaceholder("Casual, Formal, Business...")!, "Casual");
    act(() => buttonByText("Next")!.click());
    typeInto(document.querySelector("textarea")!, "Sound casual.");
    await act(async () => buttonByText("Next")!.click());
    setAppTargetToneMock.mockResolvedValueOnce(false);
    await act(async () => buttonByText("Create")!.click());
    expect(upsertToneMock).toHaveBeenCalledTimes(1);
    expect(upsertToneMock).toHaveBeenCalledWith(expect.any(Object), {
      activate: false,
    });
    expect(closeToneEditorDialogMock).not.toHaveBeenCalled();
    await act(async () => buttonByText("Create")!.click());
    expect(upsertToneMock.mock.calls[1][0]).toEqual(
      upsertToneMock.mock.calls[0][0],
    );
    expect(closeToneEditorDialogMock).toHaveBeenCalledTimes(1);
  });

  it("explains a missing provider instead of blocking creation", async () => {
    seedCreate();
    renderDialog();

    typeInto(fieldByPlaceholder("Casual, Formal, Business...")!, "Casual");
    act(() => {
      buttonByText("Next")!.click();
    });
    typeInto(
      document.querySelector("textarea") as HTMLTextAreaElement,
      "Sound casual.",
    );
    getGenerateTextRepoMock.mockReturnValueOnce({ repo: null });
    await act(async () => {
      buttonByText("Next")!.click();
    });

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "No text-generation provider is configured",
    );
    expect(document.body.textContent).toContain(
      "You can create this style without a preview.",
    );
    // Creation stays available without a preview.
    expect(buttonByText("Create")?.getAttribute("disabled")).toBeNull();
  });

  it("surfaces provider failures inline with a retry", async () => {
    seedCreate();
    renderDialog();

    typeInto(fieldByPlaceholder("Casual, Formal, Business...")!, "Casual");
    act(() => {
      buttonByText("Next")!.click();
    });
    typeInto(
      document.querySelector("textarea") as HTMLTextAreaElement,
      "Sound casual.",
    );
    generateTextMock.mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      buttonByText("Next")!.click();
    });

    expect(document.body.textContent).toContain("boom");
    generateTextMock.mockResolvedValueOnce({ text: "second try" });
    await act(async () => {
      buttonByText("Run preview", true)!.click();
    });
    expect(document.body.textContent).toContain("second try");
  });

  it("cancels an in-flight preview without an error", async () => {
    seedCreate();
    renderDialog();

    typeInto(fieldByPlaceholder("Casual, Formal, Business...")!, "Casual");
    act(() => {
      buttonByText("Next")!.click();
    });
    typeInto(
      document.querySelector("textarea") as HTMLTextAreaElement,
      "Sound casual.",
    );
    generateTextMock.mockImplementationOnce(
      (input: unknown) =>
        new Promise((_resolve, reject) => {
          (input as { signal?: AbortSignal }).signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("aborted", "AbortError"));
            },
          );
        }),
    );
    await act(async () => {
      buttonByText("Next")!.click();
    });

    const cancel = buttonByText("Cancel", true);
    expect(cancel).toBeTruthy();
    await act(async () => {
      cancel!.click();
    });
    expect(document.body.textContent).not.toContain("Styling the sample...");
    expect(document.body.textContent).not.toContain("boom");
  });

  it("renders fullscreen on narrow windows", () => {
    setMatchMedia(true);
    seedCreate();
    renderDialog();
    expect(document.querySelector(".MuiDialog-paperFullScreen")).toBeTruthy();
  });
});

describe("ToneEditorDialog edit mode", () => {
  it("does not confirm a queued discard after Save takes write ownership", async () => {
    seedEdit();
    renderDialog();
    typeInto(
      fieldByPlaceholder("Casual, Formal, Business...")!,
      "Changed style",
    );
    act(() => buttonByText("Cancel")!.click());
    const discard = buttonByText("Discard")!;
    const save = buttonByText("Save changes")!;
    let finish!: () => void;
    upsertToneMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    act(() => {
      save.click();
      discard.click();
    });
    const closedWhileSaving = closeToneEditorDialogMock.mock.calls.length;
    await act(async () => finish());
    expect(closedWhileSaving).toBe(0);
    expect(closeToneEditorDialogMock).toHaveBeenCalledOnce();
  });
  it("refreshes an untouched edit draft when its source changes", () => {
    seedEdit();
    renderDialog();
    const updated = {
      ...getAppState().toneById.tone1,
      name: "Refreshed style",
      promptTemplate: "Refreshed prompt",
    };
    act(() => setAppState({ toneById: { tone1: updated } }));
    expect(fieldByPlaceholder("Casual, Formal, Business...")!.value).toBe(
      "Refreshed style",
    );
    expect(
      Array.from(document.querySelectorAll("textarea")).some(
        (field) => field.value === "Refreshed prompt",
      ),
    ).toBe(true);
    expect(buttonByText("Save changes")?.hasAttribute("disabled")).toBe(true);
  });

  it.each([false, true])(
    "preserves a dirty draft and blocks overwriting refreshed source (same batch: %s)",
    async (sameBatch) => {
      seedEdit();
      renderDialog();
      typeInto(
        fieldByPlaceholder("Casual, Formal, Business...")!,
        "My unsaved edit",
      );
      const save = buttonByText("Save changes")!;
      const refresh = () =>
        setAppState({
          toneById: {
            tone1: {
              ...getAppState().toneById.tone1,
              promptTemplate: "Remote revision",
            },
          },
        });
      if (sameBatch) {
        await act(async () => {
          refresh();
          save.click();
        });
      } else {
        act(refresh);
        await act(async () => save.click());
      }
      expect(upsertToneMock).not.toHaveBeenCalled();
      expect(fieldByPlaceholder("Casual, Formal, Business...")!.value).toBe(
        "My unsaved edit",
      );
      expect(document.body.textContent).toContain(
        "This style changed elsewhere.",
      );
      expect(buttonByText("Save changes")?.hasAttribute("disabled")).toBe(true);
    },
  );

  it("pairs provider diagnostics with a localized failure heading", async () => {
    seedEdit();
    renderDialog();
    generateTextMock.mockRejectedValueOnce(new Error("Provider diagnostic"));
    await act(async () => buttonByText("Run preview", true)!.click());
    expect(document.body.textContent).toContain("Preview failed.");
    expect(document.body.textContent).toContain("Provider diagnostic");
  });
  it.each(["save", "delete"] as const)(
    "takes exclusive ownership synchronously when %s starts first",
    async (first) => {
      seedEdit();
      renderDialog();
      typeInto(
        fieldByPlaceholder("Casual, Formal, Business...")!,
        "Changed style",
      );
      act(() => buttonByText("Delete")!.click());
      const dialogs = document.querySelectorAll('[role="dialog"]');
      const confirm = Array.from(
        dialogs[dialogs.length - 1].querySelectorAll("button"),
      ).find((button) => button.textContent?.trim() === "Delete")!;
      const save = buttonByText("Save changes")!;
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      if (first === "save") upsertToneMock.mockReturnValueOnce(pending);
      else deleteToneMock.mockReturnValueOnce(pending);
      act(() => {
        if (first === "save") {
          save.click();
          confirm.click();
        } else {
          confirm.click();
          save.click();
        }
      });
      const calls = [
        upsertToneMock.mock.calls.length,
        deleteToneMock.mock.calls.length,
      ];
      await act(async () => finish());
      expect(calls).toEqual(first === "save" ? [1, 0] : [0, 1]);
    },
  );

  it("keeps a failed deletion confirmation open for retry", async () => {
    vi.useFakeTimers();
    try {
      seedEdit();
      renderDialog();
      deleteToneMock.mockRejectedValueOnce(new Error("storage unavailable"));
      act(() => buttonByText("Delete")!.click());
      const confirmDelete = () => {
        const dialogs = document.querySelectorAll('[role="dialog"]');
        return Array.from(
          dialogs[dialogs.length - 1].querySelectorAll("button"),
        ).find((button) => button.textContent?.trim() === "Delete")!;
      };
      await act(async () => confirmDelete().click());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(document.body.textContent).toContain(
        "Are you sure you want to delete this style?",
      );
      expect(closeToneEditorDialogMock).not.toHaveBeenCalled();
      await act(async () => confirmDelete().click());
      expect(deleteToneMock).toHaveBeenCalledTimes(2);
      expect(closeToneEditorDialogMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never routes a vanished edit tone to a new-style wizard", () => {
    seedEdit();
    renderDialog();
    act(() => setAppState({ toneById: {} }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(buttonByText("Next")).toBeUndefined();
  });

  it("does not close a replacement editor when deletion finishes late", async () => {
    seedEdit();
    renderDialog();
    let finishDelete!: () => void;
    deleteToneMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishDelete = resolve;
      }),
    );
    act(() => buttonByText("Delete")!.click());
    act(() => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      const confirm = Array.from(
        dialogs[dialogs.length - 1].querySelectorAll("button"),
      ).find((button) => button.textContent?.trim() === "Delete")!;
      confirm.click();
    });
    act(() => seedCreate());
    await act(async () => finishDelete());
    expect(closeToneEditorDialogMock).not.toHaveBeenCalled();
    expect(buttonByText("Next")).toBeTruthy();
  });

  it("invalidates an edit preview when its prompt changes", async () => {
    seedEdit();
    renderDialog();
    act(() => buttonByText("Test style")!.click());
    await act(async () => buttonByText("Run preview", true)!.click());
    expect(document.body.textContent).toContain("Styled sample!");
    const prompt = Array.from(document.querySelectorAll("textarea")).find(
      (field) => field.value === "Write plainly.",
    )!;
    typeInto(prompt, "Write formally.");
    expect(document.body.textContent).not.toContain("Styled sample!");
  });

  it("shows grouped sections with counts and the saved values", () => {
    seedEdit();
    renderDialog();

    for (const heading of ["Basics", "Behavior", "Examples"]) {
      expect(document.body.textContent).toContain(heading);
    }
    const name = fieldByPlaceholder("Casual, Formal, Business...");
    expect(name).toBeTruthy();
    expect((name as HTMLInputElement).value).toBe("My Style");
  });

  it("confirms before discarding unsaved changes", async () => {
    seedEdit();
    renderDialog();

    const nameInput = Array.from(
      document.querySelectorAll('input[type="text"]'),
    ).find((el) => (el as HTMLInputElement).value === "My Style") as
      HTMLInputElement | undefined;
    expect(nameInput).toBeTruthy();
    typeInto(nameInput!, "My Style v2");

    const save = buttonByText("Save changes");
    expect(save?.getAttribute("disabled")).toBeNull();

    // Dialog Cancel asks first when dirty.
    act(() => {
      buttonByText("Cancel")!.click();
    });
    expect(document.body.textContent).toContain("Discard changes?");
    await act(async () => {
      buttonByText("Discard")!.click();
    });
    expect(closeToneEditorDialogMock).toHaveBeenCalled();
    expect(upsertToneMock).not.toHaveBeenCalled();
  });

  it("closes directly when nothing changed", () => {
    seedEdit();
    renderDialog();

    act(() => {
      buttonByText("Cancel")!.click();
    });
    expect(document.body.textContent).not.toContain("Discard changes?");
    expect(closeToneEditorDialogMock).toHaveBeenCalled();
  });

  it("saves the merged tone", async () => {
    seedEdit();
    renderDialog();

    const nameInput = Array.from(
      document.querySelectorAll('input[type="text"]'),
    ).find((el) => (el as HTMLInputElement).value === "My Style") as
      HTMLInputElement | undefined;
    typeInto(nameInput!, "My Style v2");

    await act(async () => {
      buttonByText("Save changes")!.click();
    });
    expect(upsertToneMock).toHaveBeenCalledTimes(1);
    expect(upsertToneMock.mock.calls[0][0]).toMatchObject({
      id: "tone1",
      name: "My Style v2",
      promptTemplate: "Write plainly.",
      category: "notes",
    });
  });

  it("confirms before deleting", async () => {
    seedEdit();
    renderDialog();

    act(() => {
      buttonByText("Delete")!.click();
    });
    expect(document.body.textContent).toContain(
      "Are you sure you want to delete this style?",
    );
    expect(deleteToneMock).not.toHaveBeenCalled();

    await act(async () => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      const confirmDialog = dialogs[dialogs.length - 1];
      const confirm = Array.from(confirmDialog.querySelectorAll("button")).find(
        (el) => el.textContent?.trim() === "Delete",
      ) as HTMLElement;
      confirm.click();
    });
    expect(deleteToneMock).toHaveBeenCalledWith("tone1");
    expect(closeToneEditorDialogMock).toHaveBeenCalled();
  });

  it("resets state when switching between create and edit", () => {
    seedCreate();
    renderDialog();
    typeInto(fieldByPlaceholder("Casual, Formal, Business...")!, "Draft");

    act(() => {
      seedEdit();
    });
    expect(document.body.textContent).toContain("Edit style");
    expect(document.body.textContent).not.toContain("Draft");

    act(() => {
      seedCreate();
    });
    expect(document.body.textContent).toContain("Create style");
    const name = fieldByPlaceholder("Casual, Formal, Business...");
    expect((name as HTMLInputElement)?.value ?? "").toBe("");
  });
});
