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
   * Writes that hang until the test lets them land, the way a save on a slow
   * disk does. The real action updates the store only after the repository
   * call returns, which is what makes a late arrival possible at all.
   */
  const deferredWrite = () => {
    const landings: Array<() => void> = [];
    mocks.setDictationLimitMinutes.mockImplementation(
      (minutes: number) =>
        new Promise<void>((resolve) => {
          landings.push(() => {
            setAppState((state) => ({
              ...state,
              userPrefs: {
                ...state.userPrefs,
                dictationLimitMinutes: minutes,
              } as typeof state.userPrefs,
            }));
            resolve();
          });
        }),
    );
    // The mock's implementation only runs when the action is called, so the
    // landings have to be read then, not captured by value here.
    return { settleNext: () => landings.shift()?.() };
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
    const { settleNext } = deferredWrite();
    render();

    const field = requireElement(limitField(), "the dictation limit field");
    expect(field.value).toBe(String(SAVED_MINUTES));
    typeAndCommit(field, "10");
    expect(mocks.setDictationLimitMinutes).toHaveBeenCalledTimes(1);
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
      settleNext();
    });

    expect(limitField()?.value).toBe("20");
  });

  it("commits a value changed back while the first save is still in flight", async () => {
    // 7 is what is saved, 10 is what was asked for, and 7 is asked for again
    // before the 10 lands. The store still says 7 the whole time, so a skip
    // test that reads the stored value refuses the reversion and leaves the
    // field showing a number the preference does not have.
    const { settleNext } = deferredWrite();
    render();

    const first = requireElement(limitField(), "the dictation limit field");
    typeAndCommit(first, "10");

    const second = requireElement(limitField(), "the dictation limit field");
    typeAndCommit(second, String(SAVED_MINUTES));

    expect(mocks.setDictationLimitMinutes).toHaveBeenCalledTimes(2);
    expect(mocks.setDictationLimitMinutes).toHaveBeenLastCalledWith(
      SAVED_MINUTES,
    );

    // The reversion landing last is what makes the stored preference the
    // number on screen.
    await act(async () => {
      settleNext();
    });
    await act(async () => {
      settleNext();
    });

    expect(limitField()?.value).toBe(String(SAVED_MINUTES));
  });

  it("does not let a late write overwrite the newest draft", async () => {
    // The set of writes this page is waiting on must not grow a cap: a value
    // dropped from it would arrive as a "change from elsewhere" and be written
    // over the field. Nine commits, each landing after the next, keep the
    // newest value on screen.
    //
    // Nine is more than the cap this test exists to keep out, and every one of
    // them starts a write because the page skips a commit only when it equals
    // the value it last asked for. The precondition is asserted rather than
    // assumed: if a commit were ever skipped, the eight landings below would
    // leave one arrival outstanding and the test would be measuring something
    // else.
    const { settleNext } = deferredWrite();
    render();

    const values: string[] = [];
    for (let minutes = 10; minutes <= 18; minutes += 1) {
      values.push(String(minutes));
    }

    for (const value of values) {
      const field = requireElement(limitField(), "the dictation limit field");
      typeAndCommit(field, value);
    }
    expect(mocks.setDictationLimitMinutes).toHaveBeenCalledTimes(values.length);

    // The count and the values have to agree, or the landings below are not
    // the ones this test thinks it is landing.
    expect(mocks.setDictationLimitMinutes.mock.calls).toEqual(
      values.map((value) => [Number(value)]),
    );

    // Every write but the last lands, oldest first, while the newest value is
    // on screen: one arrival fewer than the commits, by construction.
    await act(async () => {
      for (let landed = 0; landed < values.length - 1; landed += 1) {
        settleNext();
        await Promise.resolve();
      }
    });

    expect(limitField()?.value).toBe(values[values.length - 1]);
  });

  it("allows the same number again after a save failed", async () => {
    mocks.setDictationLimitMinutes.mockRejectedValue(new Error("offline"));
    render();

    const field = requireElement(limitField(), "the dictation limit field");
    typeAndCommit(field, "10");
    await act(async () => {
      await Promise.resolve();
    });
    typeAndCommit(field, "10");

    expect(mocks.setDictationLimitMinutes).toHaveBeenCalledTimes(2);
  });

  it("keeps the newest value when two writes land oldest first", async () => {
    const { settleNext } = deferredWrite();
    render();

    const first = requireElement(limitField(), "the dictation limit field");
    typeAndCommit(first, "10");

    // Committed again before the first write came back, which is what puts
    // two writes in flight at once.
    const second = requireElement(limitField(), "the dictation limit field");
    typeAndCommit(second, "20");
    expect(mocks.setDictationLimitMinutes).toHaveBeenCalledTimes(2);

    // The earlier write landing is older than what is on screen.
    await act(async () => {
      settleNext();
    });
    expect(limitField()?.value).toBe("20");

    await act(async () => {
      settleNext();
    });
    expect(limitField()?.value).toBe("20");
  });
});
