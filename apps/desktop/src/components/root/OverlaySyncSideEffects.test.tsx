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
  invoke: vi.fn(async (..._args: unknown[]) => undefined),
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
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const renderLocale = async (locale: Locale) => {
  await act(async () => {
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
  it("sends the active locale's Edit label without changing the transcript", async () => {
    await renderLocale("de");
    expect(lastPayload().review).toEqual({
      id: "review-1",
      text: "Keep this transcript",
      edit_label: getMessagesForLocale("de").edit,
    });
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
    await act(async () => {
      produceAppState((draft) => {
        draft.pendingPillReview = null;
      });
    });
    expect(lastPayload().review).toBeNull();
  });
});
