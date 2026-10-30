// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { getMessagesForLocale } from "../../i18n/intl";
import type { Locale } from "../../i18n/config";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, useAppStore } from "../../store";
import { OverlaySyncSideEffects } from "./OverlaySyncSideEffects";

const mocks = vi.hoisted(() => ({
  // `invoke` is promise-returning in the real module and is consumed with
  // `.catch()`, so the fake has to hand back a promise too.
  invoke: vi.fn((..._args: unknown[]) => Promise.resolve(undefined)),
  windowLabel: "main",
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: mocks.invoke,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: mocks.windowLabel }),
}));
vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({ error: vi.fn() }),
}));
// Keep real locale formatting and supply the IDs the Vite build injects, so
// `formatMessage({ defaultMessage })` resolves against the real catalog the
// same way it does in the running app.
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

ensureUiHarness();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.windowLabel = "main";
  useAppStore.setState(INITIAL_APP_STATE, true);
  produceAppState((draft) => {
    draft.pendingPillReview = { id: "review-1", text: "Keep this transcript" };
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
// Both scopes are sync on purpose: the component's effect is fully
// synchronous (it only calls `invoke` and attaches `.catch`), so there is no
// promise continuation whose React state update an async scope would need to
// capture. `flushActQueue` runs in both act branches.
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

const renderLocale = async (locale: Locale) => {
  await act(() => {
    root.render(
      <IntlProvider locale={locale} messages={getMessagesForLocale(locale)}>
        <OverlaySyncSideEffects />
      </IntlProvider>,
    );
  });
};
const lastPayload = () => {
  const call = mocks.invoke.mock.calls.at(-1);
  if (!call) throw new Error("No native pill payload was emitted");
  expect(call[0]).toBe("sync_native_pill_assistant");
  return JSON.parse((call[1] as { payload: string }).payload);
};

describe("native pill review localization", () => {
  it("sends every caption the pill draws, in the active locale", async () => {
    await renderLocale("de");
    const de = getMessagesForLocale("de");
    expect(lastPayload().review).toEqual({
      id: "review-1",
      text: "Keep this transcript",
      edit_label: de.edit,
      insert_label: de.insert,
      copy_label: de.copy,
      cancel_label: de.cancel,
      hint: de.edit_below_then_press_enter_to_insert,
    });
  });

  it("sends no English literals for a locale that translated every caption", async () => {
    await renderLocale("de");
    const review = lastPayload().review;
    const de = getMessagesForLocale("de");
    const en = getMessagesForLocale("en");
    // The pill draws these itself and has no catalog of its own. If one is left
    // as an English literal, the only place to catch it is this payload, so
    // assert each matches its translated catalog entry and differs from English.
    const captions = {
      edit_label: "edit",
      insert_label: "insert",
      copy_label: "copy",
      cancel_label: "cancel",
      hint: "edit_below_then_press_enter_to_insert",
    } as const;
    for (const [field, catalogKey] of Object.entries(captions)) {
      const value = review[field];
      expect(value, field).toBeTruthy();
      expect(value, field).toBe(de[catalogKey]);
      expect(value, field).not.toBe(en[catalogKey]);
    }
  });

  it("republishes translated labels when only the locale changes", async () => {
    await renderLocale("de");
    mocks.invoke.mockClear();
    await renderLocale("fr");
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(lastPayload().review.edit_label).toBe(
      getMessagesForLocale("fr").edit,
    );
  });

  it("does not let the composer webview overwrite the main window's pill", async () => {
    mocks.windowLabel = "composer";
    await renderLocale("de");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("clears the native review when the queue is cleared", async () => {
    await renderLocale("de");
    await act(() => {
      produceAppState((draft) => {
        draft.pendingPillReview = null;
      });
    });
    expect(lastPayload().review).toBeNull();
  });
});
