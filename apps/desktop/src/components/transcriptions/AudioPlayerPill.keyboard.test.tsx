// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { expect, it, vi } from "vitest";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
import en from "../../i18n/locales/en.json";
import { AudioPlayerPill } from "./AudioPlayerPill";

ensureUiHarness();
setMatchMedia(true);

it("supports slider keyboard navigation and clamps its position", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(AudioPlayerPill, {
            transcriptionId: "one",
            durationMs: 10000,
          }),
        ),
      ),
    );
    const slider = host.querySelector<HTMLElement>('[role="slider"]')!;
    const press = (key: string) =>
      act(() =>
        slider.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
    expect(slider.getAttribute("aria-label")).toBe("Playback position");
    expect(slider.tabIndex).toBe(0);
    press("ArrowUp");
    expect(slider.getAttribute("aria-valuenow")).toBe("5");
    press("End");
    expect(slider.getAttribute("aria-valuenow")).toBe("100");
    press("ArrowRight");
    expect(slider.getAttribute("aria-valuenow")).toBe("100");
    press("ArrowDown");
    expect(slider.getAttribute("aria-valuenow")).toBe("95");
    press("Home");
    press("ArrowLeft");
    expect(slider.getAttribute("aria-valuenow")).toBe("0");
    act(() => {
      for (let i = 0; i < 3; i++) {
        slider.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowRight",
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    });
    expect(slider.getAttribute("aria-valuenow")).toBe("15");
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("does not allow a disabled waveform to be focused or changed", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(AudioPlayerPill, {
            transcriptionId: "one",
            durationMs: 10000,
            disabled: true,
          }),
        ),
      ),
    );
    const slider = host.querySelector<HTMLElement>('[role="slider"]')!;
    expect(slider.tabIndex).toBe(-1);
    expect(slider.getAttribute("aria-disabled")).toBe("true");
    act(() =>
      slider.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      ),
    );
    expect(slider.getAttribute("aria-valuenow")).toBe("0");
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
