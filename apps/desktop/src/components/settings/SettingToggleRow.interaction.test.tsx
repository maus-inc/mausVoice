// @vitest-environment jsdom
import { act, createElement, type ChangeEvent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../i18n/locales/en.json";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import { IntlProvider } from "react-intl";
import { SettingToggleRow, type SettingToggleRowProps } from "./SettingRow";

ensureUiHarness();

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// #299's "the setting changes exactly once per activation" matrix: every
// activation path — switch, label, native keyboard semantics — reaches the
// onChange exactly once. The row is a label wrapping the input, so the label
// forwards natively to the input instead of stacking a second handler.

describe("SettingToggleRow activation", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = (children: ReactNode) =>
    act(() => {
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          children as never,
        ),
      );
    });

  const renderRow = (
    onChange: (event: ChangeEvent<HTMLInputElement>) => void,
    disabled?: boolean,
  ) => {
    render(
      createElement(SettingToggleRow, {
        settingKey: "spoken_commands",
        title: "Spoken commands",
        description: "Turns phrases into formatting.",
        checked: false,
        onChange: onChange as SettingToggleRowProps["onChange"],
        disabled,
      }),
    );
    return container.querySelector<HTMLInputElement>(
      "#setting-spoken_commands input",
    )!;
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("changes the setting exactly once per switch activation", () => {
    const onChange = vi.fn();
    const input = renderRow(onChange);
    act(() => input.click());
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("changes the setting exactly once per label activation", () => {
    const onChange = vi.fn();
    renderRow(onChange);
    const label = container.querySelector<HTMLElement>(
      "#setting-spoken_commands",
    )!;
    act(() => label.click());
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("exposes the row as one native label around the switch, not stacked handlers", () => {
    renderRow(vi.fn());
    const label = container.querySelector<HTMLElement>(
      "#setting-spoken_commands",
    )!;
    expect(label.tagName).toBe("LABEL");
    // A native checkbox input: Space/Enter keyboard activation is the
    // browser's built-in label-and-input semantics (verified in the native
    // contract suite); jsdom cannot reproduce key-driven activation.
    const input = label.querySelector<HTMLInputElement>("input")!;
    expect(input.type).toBe("checkbox");
    expect(input.getAttribute("role")).toBe("switch");
  });

  it("does not toggle while disabled", () => {
    const onChange = vi.fn();
    const input = renderRow(onChange, true);
    expect(input.disabled).toBe(true);
    act(() => input.click());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the row transform-free markup: the press scale exists only on button rows", () => {
    renderRow(vi.fn());
    const label = container.querySelector<HTMLElement>(
      "#setting-spoken_commands",
    )!;
    // The toggle row is a label, never a button: no press-scale block is
    // attached, so a switch click cannot animate the row's container.
    expect(label.querySelector("button, [role='button']")).toBeNull();
  });
});
