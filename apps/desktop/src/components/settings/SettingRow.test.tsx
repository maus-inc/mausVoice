// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../i18n/locales/en.json";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { requireElement } from "../../../test/helpers/dom";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import { IntlProvider } from "react-intl";
import { SettingGroup, SettingRow, SettingToggleRow } from "./SettingRow";

ensureUiHarness();

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const click = (element: Element) =>
  act(() => {
    (element as HTMLElement).click();
  });

describe("SettingRow", () => {
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

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("anchors the row and names its label and description", () => {
    render(
      createElement(SettingRow, {
        settingKey: "hands_free_output_delay",
        title: "Hands-free output delay",
        description: "How long mausVoice waits.",
      }),
    );

    const row = container.querySelector("#setting-hands_free_output_delay");
    expect(row).not.toBeNull();
    expect(
      container.querySelector("#setting-hands_free_output_delay-label")
        ?.textContent,
    ).toBe("Hands-free output delay");
    expect(
      container.querySelector("#setting-hands_free_output_delay-description")
        ?.textContent,
    ).toBe("How long mausVoice waits.");
  });

  it("makes a row with an action one button, and a statement row not a button", () => {
    render(
      createElement(
        "div",
        null,
        createElement(SettingRow, {
          settingKey: "plan",
          title: "Plan",
          value: "Pro",
        }),
        createElement(SettingRow, {
          settingKey: "name",
          title: "Name",
          onClick: () => undefined,
        }),
      ),
    );

    expect(container.querySelector('[id="setting-plan"]')?.tagName).not.toBe(
      "BUTTON",
    );
    expect(container.querySelector('[id="setting-name"]')?.tagName).toBe(
      "BUTTON",
    );
  });

  it("fires the action once per press", () => {
    const onClick = vi.fn();
    render(
      createElement(SettingRow, {
        settingKey: "name",
        title: "Name",
        onClick,
      }),
    );

    click(
      requireElement(
        container.querySelector('[id="setting-name"]'),
        "the name row",
      ),
    );
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire the action while the row is disabled", () => {
    const onClick = vi.fn();
    render(
      createElement(SettingRow, {
        settingKey: "name",
        title: "Name",
        onClick,
        disabled: true,
      }),
    );

    click(
      requireElement(
        container.querySelector('[id="setting-name"]'),
        "the name row",
      ),
    );
    expect(onClick).not.toHaveBeenCalled();
  });

  it("names a row's action instead of leaving it to a chevron", () => {
    render(
      createElement(SettingRow, {
        settingKey: "name",
        title: "Name",
        action: { label: "Edit" },
        onClick: () => undefined,
      }),
    );

    const row = container.querySelector('[id="setting-name"]');
    expect(row?.textContent).toContain("Edit");
    // The affordance is not a button: the row is the button, and nesting one
    // inside the other is neither valid markup nor keyboard reachable.
    expect(row?.querySelector("button button")).toBeNull();
    expect(row?.querySelector(".setting-row-action")?.tagName).toBe("SPAN");
  });

  it("prints a destructive group's heading as a label, not a section heading", () => {
    render(
      <SettingGroup title="Danger zone" danger>
        <SettingRow settingKey="clear_local_data" title="Clear local data" />
      </SettingGroup>,
    );

    const heading = container.querySelector("h2");
    expect(heading?.textContent).toBe("Danger zone");
    expect(heading?.tagName).toBe("H2");
  });

  it("labels a toggle row's switch from the row title", () => {
    render(
      createElement(SettingToggleRow, {
        settingKey: "spoken_commands",
        title: "Spoken commands",
        description: "Turns phrases into formatting.",
        checked: false,
        onChange: () => undefined,
      }),
    );

    const input = container.querySelector<HTMLInputElement>(
      "#setting-spoken_commands input",
    );
    expect(input).not.toBeNull();
    expect(input?.getAttribute("aria-labelledby")).toBe(
      "setting-spoken_commands-label",
    );
    expect(input?.getAttribute("aria-describedby")).toBe(
      "setting-spoken_commands-description",
    );
  });

  it("toggles from the switch", () => {
    const onChange = vi.fn();
    render(
      createElement(SettingToggleRow, {
        settingKey: "spoken_commands",
        title: "Spoken commands",
        checked: false,
        onChange,
      }),
    );

    click(container.querySelector("#setting-spoken_commands input") as Element);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("renders a group heading that a search result can name", () => {
    render(
      <SettingGroup title="Microphone and feedback">
        <SettingRow settingKey="microphone" title="Microphone" />
      </SettingGroup>,
    );

    expect(container.textContent).toContain("Microphone and feedback");
    expect(container.querySelector('[id="setting-microphone"]')).not.toBeNull();
  });
});
