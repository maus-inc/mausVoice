// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setDictationLimitMinutes: vi.fn(),
}));

// jsdom has no Tauri platform, and the page asks which rows this one may show.
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

vi.mock("../../../actions/user.actions", () => ({
  setDictationLimitMinutes: (...args: unknown[]) =>
    mocks.setDictationLimitMinutes(...args),
  setHandsFreeDelayMs: vi.fn(async () => {}),
  setHallucinationFilterEnabled: vi.fn(async () => {}),
  setInDictationStyleSwitchingEnabled: vi.fn(async () => {}),
  setPreferredLanguage: vi.fn(async () => {}),
  setRealtimeOutputEnabled: vi.fn(async () => {}),
  setReviewBeforeInsert: vi.fn(async () => {}),
  setSpokenCommandsEnabled: vi.fn(async () => {}),
}));

vi.mock("../../../actions/tone.actions", () => ({
  loadTones: vi.fn(async () => {}),
}));

import { INITIAL_APP_STATE } from "../../../state/app.state";
import { setAppState } from "../../../store";
import { ensureUiHarness } from "../../../../test/helpers/jsdom-ui-harness";
import { requireElement } from "../../../../test/helpers/dom";
import en from "../../../i18n/locales/en.json";
import DictationSettingsPage from "./DictationSettingsPage";

ensureUiHarness();

const LOCAL_UID = "local-user";
const SAVED_MINUTES = 7;

/**
 * The dictation limit and the hands-free delay are the two fields someone
 * types a number into, and both commit on blur while the write is still in
 * flight. That gap is the whole risk: a value landing late must not overwrite
 * the next draft, because the field is the only place that draft exists.
 */
describe("DictationSettingsPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = () => {
    act(() => {
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(
            MemoryRouter,
            { initialEntries: ["/dashboard/settings/dictation"] },
            createElement(DictationSettingsPage),
          ),
        ),
      );
    });
  };

  /**
   * The dictation limit field, found through the anchor the row already
   * carries for deep links, so the finder keeps working after the value in it
   * has changed.
   */
  const limitField = (): HTMLInputElement | null =>
    document
      .getElementById("setting-dictation_limit")
      ?.querySelector<HTMLInputElement>("input[type='number']") ?? null;

  /** Types into a field the way a person does, then blurs to commit. */
  const typeAndCommit = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    act(() => {
      // React's `onBlur` is the native `focusout`, which bubbles; a plain
      // `blur` event never reaches the handler.
      input.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
    });
  };

  /**
   * A write that hangs until the test lets it land, the way a save on a slow
   * disk does. The real action updates the store only after the repository
   * call returns, which is what makes the late arrival possible at all.
   */
  const deferredWrite = () => {
    let settle!: () => void;
    mocks.setDictationLimitMinutes.mockImplementation(
      (minutes: number) =>
        new Promise<void>((resolve) => {
          settle = () => {
            setAppState((state) => ({
              ...state,
              userPrefs: {
                ...state.userPrefs,
                dictationLimitMinutes: minutes,
              } as typeof state.userPrefs,
            }));
            resolve();
          };
        }),
    );
    // The mock's implementation only runs when the action is called, so the
    // resolver has to be read then, not captured by value here.
    return { settle: () => settle() };
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.setDictationLimitMinutes.mockReset();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    setAppState((state) => ({
      ...state,
      auth: {
        uid: LOCAL_UID,
        email: "morgan@example.com",
      } as typeof state.auth,
      // The dictation limit row waits for the key list to load, because the
      // limit only means something for the local engine. "success" is what the
      // page reads to know it.
      settings: { ...state.settings, apiKeysStatus: "success" },
      // `state.userPrefs` is the signed-in person's own record, not a map.
      userPrefs: {
        userId: LOCAL_UID,
        dictationLimitMinutes: SAVED_MINUTES,
        handsFreeDelayMs: 0,
      } as unknown as typeof state.userPrefs,
      userById: {
        [LOCAL_UID]: { id: LOCAL_UID, name: "Morgan Lee" },
      } as unknown as typeof state.userById,
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps a draft typed while the previous value is still saving", async () => {
    const { settle } = deferredWrite();
    render();

    const field = requireElement(limitField(), "the dictation limit field");
    expect(field.value).toBe(String(SAVED_MINUTES));
    typeAndCommit(field, "10");
    expect(mocks.setDictationLimitMinutes).toHaveBeenCalledWith(10);

    // The write has not landed and the person is already on the next value.
    const next = requireElement(limitField(), "the dictation limit field");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(next, "20");
      next.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    expect(next.value).toBe("20");

    // The saved value arriving is the previous commit landing, not news.
    await act(async () => {
      settle();
    });

    expect(limitField()?.value).toBe("20");
  });
});
