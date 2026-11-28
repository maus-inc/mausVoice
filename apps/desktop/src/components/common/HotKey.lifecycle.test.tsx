// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
import { IntlProvider } from "react-intl";
import en from "../../i18n/locales/en.json";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, setAppState } from "../../store";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { HotKey } from "./HotKey";

ensureUiHarness();
it("releases the global recording guard if a focused recorder is unmounted", () => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      createElement(
        IntlProvider,
        { locale: "en", messages: en },
        createElement(HotKey, { value: [] }),
      ),
    ),
  );
  const field = container.querySelector<HTMLElement>('[tabindex="0"]')!;
  act(() => field.focus());
  expect(getAppState().isRecordingHotkey).toBe(true);
  act(() => root.unmount());
  expect(getAppState().isRecordingHotkey).toBe(false);
  container.remove();
});

it("does not let mounting or removing an inactive recorder cancel the focused one", () => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (first: boolean, third: boolean) =>
    act(() =>
      root.render(
        createElement(IntlProvider, { locale: "en", messages: en }, [
          first && createElement(HotKey, { key: "first", value: [] }),
          createElement(HotKey, { key: "second", value: [] }),
          third && createElement(HotKey, { key: "third", value: [] }),
        ]),
      ),
    );
  try {
    render(true, false);
    const second = container.querySelectorAll<HTMLElement>('[tabindex="0"]')[1];
    act(() => second.focus());
    expect(getAppState().isRecordingHotkey).toBe(true);
    render(false, true);
    expect(getAppState().isRecordingHotkey).toBe(true);
    act(() => second.blur());
    expect(getAppState().isRecordingHotkey).toBe(false);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it("uses Escape to leave the recorder without dismissing its parent dialog", () => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const parentKey = vi.fn();
  try {
    act(() =>
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(
            "div",
            { onKeyDown: parentKey },
            createElement(HotKey, { value: [] }),
          ),
        ),
      ),
    );
    const field = container.querySelector<HTMLElement>('[tabindex="0"]')!;
    act(() => field.focus());
    act(() =>
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(parentKey).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(field);
    expect(getAppState().isRecordingHotkey).toBe(false);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
