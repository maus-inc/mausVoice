// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveDeepgram: vi.fn(),
  saveGroq: vi.fn(),
  showSnackbar: vi.fn(),
  showErrorSnackbar: vi.fn(),
}));

vi.mock("../../actions/app.actions", () => ({
  showSnackbar: (...args: unknown[]) => mocks.showSnackbar(...args),
  showErrorSnackbar: (...args: unknown[]) => mocks.showErrorSnackbar(...args),
}));

vi.mock("../../actions/personal-use.actions", () => ({
  savePersonalDeepgramApiKey: (...args: unknown[]) =>
    mocks.saveDeepgram(...args),
  savePersonalGroqApiKey: (...args: unknown[]) => mocks.saveGroq(...args),
}));

vi.mock("../../utils/open-url.utils", () => ({ openExternalUrl: vi.fn() }));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import { IntlProvider } from "react-intl";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import de from "../../i18n/locales/de.json";
import { PersonalApiKeyDialog } from "./PersonalApiKeyDialog";

ensureUiHarness();

/**
 * The dialog saves a provider key and then says so. The confirmation has to
 * come out of the person's own catalogue rather than a sentence compiled into
 * the table above `PROVIDER_COPY`, so these render in German and assert on the
 * German text: a hard-coded English snackbar is the regression they exist for.
 */
describe("PersonalApiKeyDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onClose: ReturnType<typeof vi.fn>;

  const render = (provider: "groq" | "deepgram") =>
    act(() => {
      root.render(
        createElement(
          IntlProvider,
          { locale: "de", messages: de },
          createElement(PersonalApiKeyDialog, {
            provider,
            open: true,
            onClose,
          }),
        ),
      );
    });

  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

  const keyInput = () =>
    dialog()?.querySelector<HTMLInputElement>('input[type="password"]') ?? null;

  /** The last button in the dialog is Save; Cancel sits before it. */
  const saveButton = () => {
    const buttons = [...(dialog()?.querySelectorAll("button") ?? [])];
    return buttons[buttons.length - 1];
  };

  /**
   * Types the way a person does. Setting `.value` directly leaves React's
   * tracker thinking nothing changed, so the native setter is the only way the
   * change reaches state.
   */
  const type = (value: string) => {
    const input = keyInput();
    if (!input) {
      throw new Error("no key field");
    }
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };

  const click = async (element: HTMLElement | undefined) => {
    if (!element) {
      throw new Error("no button");
    }
    await act(async () => {
      element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      // The save is awaited before the dialog closes, so the callback has to
      // give that microtask a turn before the assertions run.
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    onClose = vi.fn();
    mocks.saveDeepgram.mockReset().mockResolvedValue(undefined);
    mocks.saveGroq.mockReset().mockResolvedValue(undefined);
    mocks.showSnackbar.mockReset();
    mocks.showErrorSnackbar.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each(["groq", "deepgram"] as const)(
    "guards repeated %s saves and allows retry",
    async (provider) => {
      let reject!: (error: Error) => void;
      const save = provider === "groq" ? mocks.saveGroq : mocks.saveDeepgram;
      save.mockImplementationOnce(
        () =>
          new Promise((_, fail) => {
            reject = fail;
          }),
      );
      render(provider);
      type("test-key");
      const button = saveButton();
      act(() => {
        button?.click();
        button?.click();
        const cancel = [...(dialog()?.querySelectorAll("button") ?? [])].find(
          (element) => element.textContent?.trim() === "Abbrechen",
        );
        cancel?.click();
      });
      expect(save).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
      await act(async () => {
        reject(new Error("failed"));
      });
      await click(saveButton());
      expect(save).toHaveBeenCalledTimes(2);
      expect(onClose).toHaveBeenCalledTimes(1);
    },
  );

  it("says a saved Deepgram key in the person's locale", async () => {
    render("deepgram");
    type("  dg_key_123  ");
    await click(saveButton());

    expect(mocks.saveDeepgram).toHaveBeenCalledWith("dg_key_123");
    expect(mocks.showSnackbar).toHaveBeenCalledWith(
      "Deepgram API-Schlüssel gespeichert",
      { mode: "success" },
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says a saved Groq key in the person's locale", async () => {
    render("groq");
    type("gsk_abc");
    await click(saveButton());

    expect(mocks.saveGroq).toHaveBeenCalledWith("gsk_abc");
    expect(mocks.showSnackbar).toHaveBeenCalledWith(
      "Groq API-Schlüssel gespeichert",
      { mode: "success" },
    );
  });

  it("keeps the dialog open, and shows what went wrong", async () => {
    const failure = new Error("Groq refused the key");
    mocks.saveGroq.mockRejectedValue(failure);
    render("groq");
    type("gsk_bad");
    await click(saveButton());

    expect(mocks.showSnackbar).not.toHaveBeenCalled();
    expect(mocks.showErrorSnackbar).toHaveBeenCalledWith(failure);
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain("Groq refused the key");
  });

  it("reveals the focused field within a short dialog without scrolling the page", async () => {
    render("groq");
    const input = keyInput()!;
    const content = input.closest<HTMLElement>(".MuiDialogContent-root")!;
    const rectangle = (top: number, bottom: number) =>
      ({ top, bottom }) as DOMRect;
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue(
      rectangle(140, 205),
    );
    vi.spyOn(content, "getBoundingClientRect").mockReturnValue(
      rectangle(95, 190),
    );
    const scroll = window.scrollY;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(content.scrollTop).toBe(23);
    expect(window.scrollY).toBe(scroll);
  });

  it("puts the cursor in the key field once the dialog has entered", async () => {
    render("deepgram");

    // The dialog's content is not mounted when the open effect runs, so the
    // focus lands after the enter transition rather than at open.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    expect(document.activeElement).toBe(keyInput());
  });

  it("will not save an empty key", async () => {
    render("deepgram");
    expect(saveButton()?.disabled).toBe(true);

    type("   ");
    await click(saveButton());

    expect(saveButton()?.disabled).toBe(true);
    expect(mocks.saveDeepgram).not.toHaveBeenCalled();
  });
});
