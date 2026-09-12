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
} = vi.hoisted(() => ({
  upsertToneMock: vi.fn(async (tone: unknown) => tone),
  deleteToneMock: vi.fn(async () => undefined),
  closeToneEditorDialogMock: vi.fn(),
  setAppTargetToneMock: vi.fn(async () => undefined),
  generateTextMock: vi.fn(async (..._args: unknown[]) => ({
    text: '{"result": "Styled sample!"}',
  })),
}));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
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
  getGenerateTextRepo: () => ({ repo: { generateText: generateTextMock } }),
}));

import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import { TonePreviewNoProviderError } from "../../actions/tone-preview.actions";
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
  generateTextMock.mockResolvedValue({ text: '{"result": "Styled sample!"}' });
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
    generateTextMock.mockRejectedValueOnce(new TonePreviewNoProviderError());
    await act(async () => {
      buttonByText("Next")!.click();
    });

    expect(generateTextMock).toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "No text-generation provider is configured",
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
